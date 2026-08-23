import { randomUUID } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentController as AgentControllerType,
  AgentSupervisorFactory,
} from "./agent-controller.ts";
import { AgentController } from "./agent-controller.ts";
import {
  createAgentSupervisorFactory,
  type AgentSupervisorFactoryOptions,
} from "./agent-supervisor-factory.ts";
import {
  AGENT_TOOL_NAMES,
  CHILD_REPLY_GUIDELINE,
  CHILD_REPLY_TOO_LARGE_GUIDELINE,
  CHILD_FINAL_REPORT_TOOL_NAME,
  CHILD_REPLY_TOOL_NAME,
  PARENT_COORDINATION_GUIDELINES,
  registerAgentTools,
  registerReplyToParentTool,
  type AgentToolRegistrationApi,
} from "./agent-tools.ts";
import { ChildReplyCoordinator } from "./child-reply-coordinator.ts";
import { AutoCompactCoordinationParticipant } from "./auto-compact-coordination.ts";
import { ParentWaitBatchCoordinator } from "./parent-wait-batch-coordinator.ts";
import type {
  AvailableHostCapabilities,
  ExtensionApiSurface,
} from "./host-gate.ts";
import {
  RUNTIME_EPHEMERAL_ENV_KEYS,
  RUNTIME_INTERNAL_ENV_KEYS,
  captureRootRuntimeContext,
  type EnvironmentInput,
  type RuntimeConfig,
  type RootRuntimeContext,
} from "./root-runtime-context.ts";
import {
  SUPERVISOR_PROTOCOL_VERSION,
  SupervisorRequestIdRegistry,
  type SupervisorCapabilityManifest,
} from "./supervisor-channel.ts";
import {
  RemoteTreeAuthorityPort,
  SupervisorControlClient,
  SupervisorControlServer,
  createForwardControlHandler,
  createRootAuthorityControlHandler,
} from "./authority-control-router.ts";
import {
  nativeLocalSupervisorTransportAdapter,
  type LocalSupervisorTransportAdapter,
} from "./local-supervisor-transport.ts";
import { StreamSupervisorChannel } from "./stream-supervisor-channel.ts";
import { SubtreePublisher } from "./subtree-publisher.ts";
import {
  ParentReplyInbox,
  WJ_PI_SUBAGENTS_FINAL_TYPE,
  WJ_PI_SUBAGENTS_MESSAGE_TYPE,
  registerParentReplyMessageRenderers,
  type ParentReplyMessageRenderer,
} from "./parent-reply-inbox.ts";
import {
  RuntimeReloadCoordinator,
  readRuntimeReloadEventBus,
  validateRuntimeReloadLeaseTimeout,
  type RuntimeReloadIdentity,
} from "./runtime-reload-coordinator.ts";
import {
  RootTreeAuthority,
  type TreeAuthorityPort,
} from "./tree-authority.ts";
import {
  TemplateSnapshotController,
  type AgentTemplateListItem,
  type TemplateDefinition,
  type TemplateDiscoveryFileSystem,
} from "./template-discovery-snapshot.ts";
import {
  controlFailure,
  ROOT_TREE_ACTOR,
  TreeController,
  isCanonicalUuid,
  type AgentSnapshot,
  type ControlResult,
  type TreeActor,
} from "./tree-controller.ts";
import {
  bindAgentTreeUi,
  type AgentTreeUiBinding,
  type AgentTreeUiContext,
} from "./agent-tree-ui.ts";

export { WJ_PI_SUBAGENTS_FINAL_TYPE, WJ_PI_SUBAGENTS_MESSAGE_TYPE };

interface RuntimeExtensionApi extends AgentToolRegistrationApi {
  on(event: string, handler: (event: unknown, context: unknown) => unknown): void;
  registerCommand(name: string, options: {
    readonly description: string;
    readonly handler: (args: string, context: unknown) => unknown;
  }): void;
  registerMessageRenderer(customType: string, renderer: ParentReplyMessageRenderer): void;
  getActiveTools(): string[];
  getAllTools(): unknown[];
  setActiveTools?(tools: readonly string[]): void;
  sendMessage(message: unknown, options?: unknown): void;
  events?: unknown;
}

interface RuntimeModel {
  readonly provider: string;
  readonly id: string;
  readonly reasoning?: boolean;
  readonly thinkingLevelMap?: Readonly<Record<string, unknown>>;
}

interface RuntimeContextView extends AgentTreeUiContext {
  readonly cwd?: unknown;
  readonly model?: unknown;
  readonly thinkingLevel?: unknown;
  readonly modelRegistry?: unknown;
  readonly scopedModels?: unknown;
  readonly isProjectTrusted?: unknown;
  readonly getContextUsage?: unknown;
}

interface RuntimeContextUsageSnapshot {
  readonly context_window_tokens: number;
  readonly context_usage_percent?: number;
}

interface RuntimeSessionStartEvent {
  readonly type?: unknown;
  readonly reason?: unknown;
}

/** 仅由受管父节点写入的子运行时身份和冻结配置。 */
export interface ChildRuntimeBootstrap {
  readonly rootId: string;
  readonly parentAgentId: string | null;
  readonly agentId: string;
  readonly depth: number;
  readonly config: RuntimeConfig;
  readonly managementEnabled: boolean;
  readonly protocolVersion: string;
  readonly supervisorEndpoint: string;
  readonly localSupervisorCredential: string;
  readonly supervisorCredential: string;
  readonly templateId?: string;
  readonly name?: string;
}

type BootstrapParseResult =
  | { readonly kind: "root" }
  | { readonly kind: "child"; readonly bootstrap: ChildRuntimeBootstrap }
  | { readonly kind: "invalid" };

interface RuntimeAuthority {
  readonly tree: TreeController;
  readonly rootRuntime: RootRuntimeContext;
  readonly templates: TemplateSnapshotController;
  readonly authority: RootTreeAuthority;
  readonly rootId: string;
}

/** 同一进程内的递归 fake/宿主旅程共享唯一根树顺序域。 */
const runtimeAuthorities = new Map<string, RuntimeAuthority>();

export interface WjPiSubagentsRuntimeOptions {
  readonly rootIdFactory?: () => string;
  readonly agentIdFactory?: () => string;
  readonly environment?: EnvironmentInput;
  readonly rootArguments?: unknown;
  readonly templateFileSystem?: TemplateDiscoveryFileSystem;
  readonly bridgeScriptPath?: string;
  readonly childPiCliPath?: string;
  readonly childPiModulePath?: string;
  /** 当前 Pi 实际加载的本扩展入口；child 必须复用该路径。 */
  readonly selfExtensionPath?: string;
  readonly nodeFactory?: AgentSupervisorFactoryOptions["nodeFactory"];
  /** 测试可替换本地 IPC；生产固定使用命名管道或 Unix socket。 */
  readonly localSupervisorTransportAdapter?: LocalSupervisorTransportAdapter;
  /** 旧实例等待新扩展 factory 开始接管的 watchdog 期限；不影响已认领交接或代理终止期限。 */
  readonly reloadLeaseTimeoutMs?: number;
  /** 测试/宿主观察接缝；异常不会改变激活结果。 */
  readonly onController?: (controller: AgentControllerType) => void;
}

export type WjPiSubagentsRuntimeActivator = (
  extensionApi: ExtensionApiSurface,
  capabilities: AvailableHostCapabilities,
) => void | Promise<void>;

interface ActiveRuntime {
  controller: AgentController;
  templates: TemplateSnapshotController;
  readonly tree: TreeController;
  readonly rootRuntime: RootRuntimeContext;
  readonly rootId: string;
  readonly isChild: boolean;
  readonly managementEnabled: boolean;
  readonly authority: TreeAuthorityPort;
  readonly rootAuthority?: RootTreeAuthority;
  readonly upstream?: ChildUpstreamControl;
  readonly replyCoordinator?: ChildReplyCoordinator;
  readonly replyInbox: ParentReplyInbox;
  readonly bindings: RuntimeBindings;
  createSupervisor: AgentSupervisorFactory;
  handoffPending?: boolean;
}

interface ChildUpstreamControl {
  readonly channel: StreamSupervisorChannel;
  readonly client: SupervisorControlClient;
  readonly publisher: SubtreePublisher<AgentSnapshot>;
}

interface RuntimeBindings {
  api: RuntimeExtensionApi;
  context: RuntimeContextView;
}

interface RuntimeTransfer {
  readonly protocolVersion: typeof SUPERVISOR_PROTOCOL_VERSION;
  readonly controller: AgentController;
  readonly templates: TemplateSnapshotController;
  readonly tree: TreeController;
  readonly rootRuntime: RootRuntimeContext;
  readonly rootId: string;
  readonly isChild: boolean;
  readonly managementEnabled: boolean;
  readonly authority: TreeAuthorityPort;
  readonly rootAuthority?: RootTreeAuthority;
  readonly upstream?: ChildUpstreamControl;
  readonly replyCoordinator?: ChildReplyCoordinator;
  readonly replyInbox: ParentReplyInbox;
  readonly bindings: RuntimeBindings;
  readonly createSupervisor: AgentSupervisorFactory;
}

const SYSTEM_TOOL_NAMES = new Set<string>([
  ...AGENT_TOOL_NAMES,
  CHILD_REPLY_TOOL_NAME,
  CHILD_FINAL_REPORT_TOOL_NAME,
]);

const PARENT_COORDINATION_GUIDANCE = [
  "父子任务协作要求（必须遵守）：",
  `- ${PARENT_COORDINATION_GUIDELINES.sessionOwnership}`,
  `- ${PARENT_COORDINATION_GUIDELINES.sendMessage}`,
  `- ${PARENT_COORDINATION_GUIDELINES.sendMessageReply}`,
  `- ${PARENT_COORDINATION_GUIDELINES.slowProgress}`,
  `- ${PARENT_COORDINATION_GUIDELINES.sessionRecovery}`,
  `- ${PARENT_COORDINATION_GUIDELINES.retryPolicy}`,
  `- ${PARENT_COORDINATION_GUIDELINES.agentCleanup}`,
  `- ${PARENT_COORDINATION_GUIDELINES.capacityCleanup}`,
  `- ${PARENT_COORDINATION_GUIDELINES.replyTooLarge}`,
].join("\n");

function formatAgentTemplateCatalog(templates: readonly AgentTemplateListItem[]): string {
  return [
    "可用子代理模板：",
    "模板 ID 区分大小写，创建子代理时必须原样使用。",
    ...templates.map(({ template_id, description }) => `- ${template_id}：${description}`),
  ].join("\n");
}

const CHILD_FINAL_REPLY_GUIDANCE = [
  "子代理任务与回复/显式报告要求：",
  `- ${CHILD_REPLY_GUIDELINE}`,
  "- 需要父代理看到阶段性成果、明确交付物或单独记录的报告时，显式调用 final_report。final_report 可以在同一活动回合中多次调用，也可以与 reply_to_parent 交错；成功发送不结束当前 Pi 回合或会话。",
  "- 不要依赖普通 assistant 文本、message_end、agent_end、自然停止或压缩完成自动生成 reply 或 final_report。没有显式调用时，父端不会收到自动报告。",
  `- ${CHILD_REPLY_TOO_LARGE_GUIDELINE}`,
  "- 压缩或控制屏障期间遵守工具返回的拒绝结果；屏障前已接纳的消息不会回滚，失败调用不会被暗存、自动重试或重放。",
  "- 当前工作结束时仍应输出非空且可用的正常 assistant 答复，说明完成内容、关键结果和产物路径。这个 assistant 答复只属于当前 Pi 会话，不会自动变成 final_report；如果直接父代理需要看到报告，必须显式调用 final_report。",
].join("\n");

function asRuntimeApi(api: ExtensionApiSurface): RuntimeExtensionApi {
  return api as RuntimeExtensionApi;
}

function isRuntimeTransfer(value: unknown): value is RuntimeTransfer {
  if (!isRecord(value) || !isRecord(value.bindings)) return false;
  return value.protocolVersion === SUPERVISOR_PROTOCOL_VERSION
    && isRecord(value.controller)
    && typeof value.controller.shutdown === "function"
    && typeof value.controller.getAgentTemplates === "function"
    && typeof value.controller.updateTemplateSnapshot === "function"
    && isRecord(value.templates)
    && typeof value.templates.reload === "function"
    && isRecord(value.tree)
    && isRecord(value.rootRuntime)
    && typeof value.rootId === "string"
    && value.rootId.length > 0
    && typeof value.isChild === "boolean"
    && typeof value.managementEnabled === "boolean"
    && isRecord(value.authority)
    && typeof value.authority.listTemplates === "function"
    && typeof value.authority.resolveTemplate === "function"
    && (value.rootAuthority === undefined || isRecord(value.rootAuthority))
    && (value.upstream === undefined || (
      isRecord(value.upstream)
      && isRecord(value.upstream.channel)
      && isRecord(value.upstream.client)
      && isRecord(value.upstream.publisher)
    ))
    && isRecord(value.replyInbox)
    && typeof value.replyInbox.accept === "function"
    && (!value.isChild || (
      isRecord(value.replyCoordinator)
      && typeof value.replyCoordinator.replyToParent === "function"
      && typeof value.replyCoordinator.settle === "function"
    ))
    && typeof value.createSupervisor === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reloadIdentity(bootstrap: ChildRuntimeBootstrap | undefined): RuntimeReloadIdentity {
  if (bootstrap === undefined) {
    return Object.freeze({ isChild: false, protocolVersion: SUPERVISOR_PROTOCOL_VERSION });
  }
  return Object.freeze({
    isChild: true,
    protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
    rootId: bootstrap.rootId,
    agentId: bootstrap.agentId,
  });
}

function reloadIdentityOfRuntime(runtime: ActiveRuntime): RuntimeReloadIdentity {
  if (!runtime.isChild) {
    return Object.freeze({ isChild: false, protocolVersion: SUPERVISOR_PROTOCOL_VERSION });
  }
  if (runtime.controller.actor.kind !== "agent") throw new Error("child reload 身份不可用");
  return Object.freeze({
    isChild: true,
    protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
    rootId: runtime.rootId,
    agentId: runtime.controller.actor.agent_id,
  });
}

function reloadIdentityOfTransfer(transfer: RuntimeTransfer): RuntimeReloadIdentity {
  if (!transfer.isChild) {
    return Object.freeze({ isChild: false, protocolVersion: transfer.protocolVersion });
  }
  if (transfer.controller.actor.kind !== "agent") throw new Error("child reload 交接身份不可用");
  return Object.freeze({
    isChild: true,
    protocolVersion: transfer.protocolVersion,
    rootId: transfer.rootId,
    agentId: transfer.controller.actor.agent_id,
  });
}

function readContext(value: unknown): RuntimeContextView {
  return isRecord(value) ? value as RuntimeContextView : {};
}

/** 从 Pi ExtensionContext 读取可安全跨进程传播的上下文窗口事实。 */
function readContextUsage(context: RuntimeContextView): RuntimeContextUsageSnapshot | undefined {
  if (typeof context.getContextUsage !== "function") return undefined;
  let value: unknown;
  try {
    value = (context.getContextUsage as () => unknown).call(context);
  } catch {
    return undefined;
  }
  if (!isRecord(value)
    || !Number.isSafeInteger(value.contextWindow)
    || (value.contextWindow as number) <= 0
  ) return undefined;
  const tokens = value.tokens;
  const percent = value.percent;
  if (
    (
      tokens !== null
      && (!Number.isSafeInteger(tokens) || (tokens as number) < 0)
    )
    || (
      percent !== null
      && (
        typeof percent !== "number"
        || !Number.isFinite(percent)
        || percent < 0
        || percent > 1_000
      )
    )
    || (tokens === null) !== (percent === null)
  ) return undefined;
  const roundedPercent = percent === null
    ? undefined
    : Math.max(0, Math.round(percent * 10) / 10);
  return Object.freeze({
    context_window_tokens: value.contextWindow as number,
    ...(roundedPercent === undefined ? {} : { context_usage_percent: roundedPercent }),
  });
}

function environmentValue(
  environment: EnvironmentInput,
  key: string,
): string | undefined {
  const source = environment ?? process.env;
  try {
    const exact = source[key];
    if (exact !== undefined) return String(exact);
    if (process.platform !== "win32") return undefined;
    const matched = Object.keys(source).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
    return matched === undefined || source[matched] === undefined ? undefined : String(source[matched]);
  } catch {
    return undefined;
  }
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^[0-9]+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** 严格解析完整子 bootstrap；任一内部字段存在但不完整时拒绝启动。 */
export function readChildRuntimeBootstrap(environment?: EnvironmentInput): BootstrapParseResult {
  const values = Object.fromEntries(Object.entries(RUNTIME_INTERNAL_ENV_KEYS).map(([field, key]) => [
    field,
    environmentValue(environment, key),
  ])) as Record<keyof typeof RUNTIME_INTERNAL_ENV_KEYS, string | undefined>;
  const ephemeral = Object.fromEntries(Object.entries(RUNTIME_EPHEMERAL_ENV_KEYS).map(([field, key]) => [
    field,
    environmentValue(environment, key),
  ])) as Record<keyof typeof RUNTIME_EPHEMERAL_ENV_KEYS, string | undefined>;
  const hasAny = [...Object.values(values), ...Object.values(ephemeral)].some((value) => value !== undefined);
  if (!hasAny) return Object.freeze({ kind: "root" });
  const rootId = values.rootId;
  const parentAgentId = values.parentAgentId === "" ? null : values.parentAgentId;
  const agentId = values.agentId;
  const depth = parsePositiveInteger(values.depth);
  const maxDepth = parsePositiveInteger(values.maxDepth);
  const maxChildrenPerAgent = parsePositiveInteger(values.maxChildrenPerAgent);
  const maxAgentsPerTree = parsePositiveInteger(values.maxAgentsPerTree);
  const waitTimeoutMs = parsePositiveInteger(values.waitTimeoutMs);
  const managementEnabled = values.managementEnabled === "true"
    ? true
    : values.managementEnabled === "false"
      ? false
      : undefined;
  if (
    rootId === undefined
    || !/^[A-Za-z0-9_-]{1,128}$/.test(rootId)
    || (parentAgentId !== null && !isCanonicalUuid(parentAgentId))
    || !isCanonicalUuid(agentId)
    || depth === undefined
    || maxDepth === undefined
    || maxChildrenPerAgent === undefined
    || maxAgentsPerTree === undefined
    || waitTimeoutMs === undefined
    || managementEnabled === undefined
    || values.protocolVersion !== SUPERVISOR_PROTOCOL_VERSION
    || ephemeral.supervisorEndpoint === undefined
    || ephemeral.supervisorEndpoint.length === 0
    || new TextEncoder().encode(ephemeral.supervisorEndpoint).byteLength > 4_096
    || !isSupervisorCredential(ephemeral.localSupervisorCredential)
    || !isSupervisorCredential(ephemeral.supervisorCredential)
    || (depth === 1 ? parentAgentId !== null : parentAgentId === null)
    || depth > maxDepth
  ) return Object.freeze({ kind: "invalid" });
  return Object.freeze({
    kind: "child",
    bootstrap: Object.freeze({
      rootId,
      parentAgentId,
      agentId,
      depth,
      config: Object.freeze({ maxDepth, maxChildrenPerAgent, maxAgentsPerTree, waitTimeoutMs }),
      managementEnabled,
      protocolVersion: values.protocolVersion,
      supervisorEndpoint: ephemeral.supervisorEndpoint,
      localSupervisorCredential: ephemeral.localSupervisorCredential,
      supervisorCredential: ephemeral.supervisorCredential,
      ...(values.templateId === undefined ? {} : { templateId: values.templateId }),
      ...(values.name === undefined ? {} : { name: values.name }),
    }),
  });
}

function isSupervisorCredential(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(value);
}

function readRootId(factory: (() => string) | undefined): string {
  let rootId: unknown;
  try {
    rootId = factory?.() ?? randomUUID();
  } catch {
    throw new Error("根监督身份不可用");
  }
  if (typeof rootId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(rootId)) {
    throw new Error("根监督身份无效");
  }
  return rootId;
}

function contextCwd(context: RuntimeContextView): string {
  return typeof context.cwd === "string" && context.cwd.length > 0 ? context.cwd : process.cwd();
}

function contextProjectTrust(context: RuntimeContextView): boolean {
  if (typeof context.isProjectTrusted !== "function") return false;
  try {
    return (context.isProjectTrusted as () => unknown)() === true;
  } catch {
    return false;
  }
}

function currentModelReference(context: RuntimeContextView): string | undefined {
  const model = readRuntimeModel(context.model);
  return model === undefined ? undefined : `${model.provider}/${model.id}`;
}

function currentThinking(context: RuntimeContextView): string | undefined {
  return typeof context.thinkingLevel === "string" ? context.thinkingLevel : undefined;
}

function readRuntimeModel(value: unknown): RuntimeModel | undefined {
  if (!isRecord(value) || typeof value.provider !== "string" || typeof value.id !== "string") return undefined;
  if (value.provider.length === 0 || value.id.length === 0) return undefined;
  return value as unknown as RuntimeModel;
}

function knownBusinessTools(api: RuntimeExtensionApi): ReadonlySet<string> {
  const names = new Set<string>();
  let tools: unknown[];
  try {
    tools = api.getAllTools();
  } catch {
    return names;
  }
  for (const tool of tools) {
    if (!isRecord(tool) || typeof tool.name !== "string" || SYSTEM_TOOL_NAMES.has(tool.name)) continue;
    names.add(tool.name);
  }
  return names;
}

function activeBusinessTools(api: RuntimeExtensionApi): readonly string[] {
  let tools: unknown;
  try {
    tools = api.getActiveTools();
  } catch {
    return Object.freeze([]);
  }
  if (!Array.isArray(tools)) return Object.freeze([]);
  return Object.freeze(tools.filter(
    (name): name is string => typeof name === "string" && !SYSTEM_TOOL_NAMES.has(name),
  ));
}

function applyAgentToolVisibility(
  api: RuntimeExtensionApi,
  managementEnabled: boolean,
  replyEnabled: boolean,
): void {
  if (typeof api.setActiveTools !== "function") return;
  try {
    const business = activeBusinessTools(api);
    const system = [
      ...(replyEnabled ? [CHILD_REPLY_TOOL_NAME, CHILD_FINAL_REPORT_TOOL_NAME] : []),
      ...(managementEnabled ? AGENT_TOOL_NAMES : []),
    ];
    api.setActiveTools(system.length === 0
      ? business
      : Object.freeze([...new Set([...business, ...system])]));
  } catch {
    // 工具可见性失败不能提升服务端授权；控制器仍会重复裁决。
  }
}

function activeSystemTools(api: RuntimeExtensionApi): readonly string[] {
  let tools: unknown;
  try {
    tools = api.getActiveTools();
  } catch {
    return Object.freeze([]);
  }
  if (!Array.isArray(tools)) return Object.freeze([]);
  return Object.freeze([...new Set(tools.filter(
    (name): name is string => typeof name === "string" && SYSTEM_TOOL_NAMES.has(name),
  ))].sort());
}

function systemToolSources(
  api: RuntimeExtensionApi,
  systemTools: readonly string[],
): Readonly<Record<string, string>> {
  const wanted = new Set(systemTools);
  const sources: Record<string, string> = {};
  let tools: unknown[];
  try {
    tools = api.getAllTools();
  } catch {
    tools = [];
  }
  for (const tool of tools) {
    if (!isRecord(tool) || typeof tool.name !== "string" || !wanted.has(tool.name)) continue;
    const sourceInfo = isRecord(tool.sourceInfo) ? tool.sourceInfo : undefined;
    sources[tool.name] = typeof sourceInfo?.path === "string" ? sourceInfo.path : "<missing>";
  }
  for (const name of wanted) sources[name] ??= "<missing>";
  return Object.freeze(sources);
}

function defaultSelfExtensionPath(): string {
  try {
    return fileURLToPath(new URL("../index.ts", import.meta.url));
  } catch {
    throw new Error("子代理扩展入口不可用");
  }
}

function childCapabilityManifest(
  api: RuntimeExtensionApi,
  context: RuntimeContextView,
  selfExtensionPath: string,
): SupervisorCapabilityManifest {
  const systemTools = activeSystemTools(api);
  const model = readRuntimeModel(context.model);
  const thinking = typeof context.thinkingLevel === "string" ? context.thinkingLevel : undefined;
  return Object.freeze({
    protocol_version: SUPERVISOR_PROTOCOL_VERSION,
    business_active_tools: Object.freeze([...activeBusinessTools(api)].sort()),
    system_active_tools: systemTools,
    system_tool_sources: systemToolSources(api, systemTools),
    ...(model === undefined ? {} : { provider: model.provider, model: model.id }),
    ...(thinking === undefined ? {} : { thinking }),
    self_extension_path: resolvePath(selfExtensionPath),
  });
}

function splitModelReference(value: string | undefined): readonly [string, string] | undefined {
  if (value === undefined) return undefined;
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  return [value.slice(0, separator), value.slice(separator + 1)];
}

function findRuntimeModel(
  context: RuntimeContextView,
  provider: string,
  modelId: string,
): RuntimeModel | undefined {
  if (!isRecord(context.modelRegistry) || typeof context.modelRegistry.find !== "function") return undefined;
  try {
    return readRuntimeModel(
      (context.modelRegistry.find as (provider: string, modelId: string) => unknown)(provider, modelId),
    );
  } catch {
    return undefined;
  }
}

function modelIsInScope(context: RuntimeContextView, model: RuntimeModel): boolean {
  if (!Array.isArray(context.scopedModels) || context.scopedModels.length === 0) return true;
  return context.scopedModels.some((entry) => {
    if (!isRecord(entry)) return false;
    const candidate = readRuntimeModel(entry.model);
    return candidate?.provider === model.provider && candidate.id === model.id;
  });
}

function supportsThinking(model: RuntimeModel, level: string): boolean {
  if (model.reasoning !== true) return level === "off";
  const mapped = model.thinkingLevelMap?.[level];
  if (mapped === null) return false;
  if (level === "xhigh" || level === "max") return mapped !== undefined;
  return ["minimal", "low", "medium", "high"].includes(level);
}

function validateTemplateAgainstContext(
  template: TemplateDefinition,
  context: RuntimeContextView,
): ControlResult<unknown> {
  const reference = splitModelReference(template.model ?? currentModelReference(context));
  if (reference === undefined) return controlFailure("template_capability_unavailable");
  const model = findRuntimeModel(context, reference[0], reference[1]);
  if (model === undefined || !modelIsInScope(context, model)) {
    return controlFailure("template_capability_unavailable");
  }
  const thinking = template.thinking ?? currentThinking(context);
  if (thinking === undefined || !supportsThinking(model, thinking)) {
    return controlFailure("template_capability_unavailable");
  }
  return Object.freeze({ ok: true, data: Object.freeze({}) });
}

function readDirectChildDisplayName(
  runtime: ActiveRuntime | undefined,
  agentId: string,
  includeTerminated: boolean,
): string | undefined {
  if (runtime === undefined || runtime.handoffPending === true || !isCanonicalUuid(agentId)) return undefined;
  try {
    const status = runtime.controller.getAgentStatus(agentId);
    if (!status.ok || status.data.agent_id !== agentId) return undefined;
    if (!includeTerminated && (status.data.state === "terminating" || status.data.state === "terminated")) {
      return undefined;
    }
    return status.data.name.length > 0 ? status.data.name : undefined;
  } catch {
    return undefined;
  }
}

export function createWjPiSubagentsRuntimeActivator(
  options: WjPiSubagentsRuntimeOptions = {},
): WjPiSubagentsRuntimeActivator {
  const reloadLeaseTimeoutMs = validateRuntimeReloadLeaseTimeout(options.reloadLeaseTimeoutMs);
  return async (extensionApi, capabilities) => {
    const api = asRuntimeApi(extensionApi);
    let active: ActiveRuntime | undefined;
    let lifecycle: Promise<void> = Promise.resolve();
    let coordinationParticipant: AutoCompactCoordinationParticipant | undefined;
    let uncoordinatedManualCompactionActive = false;
    let runtimeUi: { readonly runtime: ActiveRuntime; readonly binding: AgentTreeUiBinding } | undefined;
    const bootstrapAtActivation = readChildRuntimeBootstrap(options.environment);

    const disposeRuntimeUi = (current?: ActiveRuntime): void => {
      const registered = runtimeUi;
      if (registered === undefined || (current !== undefined && registered.runtime !== current)) return;
      runtimeUi = undefined;
      registered.binding.dispose();
    };

    const bindRuntimeUi = (current: ActiveRuntime, context: RuntimeContextView): void => {
      disposeRuntimeUi();
      runtimeUi = Object.freeze({
        runtime: current,
        binding: bindAgentTreeUi({
          read: () => current.controller.getAgentTree(),
          onChange: (listener) => current.tree.onChange(listener),
        }, context),
      });
    };

    const refreshContextUsage = (current: ActiveRuntime | undefined, rawContext?: unknown): void => {
      if (current === undefined || !current.isChild || current.handoffPending === true) return;
      const context = rawContext === undefined ? current.bindings.context : readContext(rawContext);
      current.bindings.context = context;
      const usage = readContextUsage(context);
      if (usage === undefined || current.controller.actor.kind !== "agent") return;
      current.tree.updateContextUsage(current.controller.actor.agent_id, usage);
    };

    const relinquishAuthority = (current: ActiveRuntime): boolean => {
      disposeRuntimeUi(current);
      if (current.isChild) return false;
      const authority = runtimeAuthorities.get(current.rootId);
      if (authority?.tree === current.tree) {
        runtimeAuthorities.delete(current.rootId);
        return true;
      }
      return false;
    };

    const releaseAuthority = (current: ActiveRuntime): void => {
      disposeRuntimeUi(current);
      if (current.isChild) return;
      relinquishAuthority(current);
      current.tree.clearTerminatedRecords();
    };

    registerParentReplyMessageRenderers(api, {
      resolveSenderName: (agentId) => readDirectChildDisplayName(active, agentId, false),
    });
    const waitBatchCoordinator = new ParentWaitBatchCoordinator();
    registerAgentTools(api, async (toolContext) => {
      if (active !== undefined) active.bindings.context = readContext(toolContext);
      return active?.handoffPending === true
        ? undefined as unknown as AgentController
        : active?.controller as AgentController;
    }, {
      resolveAgentName: (agentId) => readDirectChildDisplayName(active, agentId, true),
      readWaitTimeoutMs: () => active?.handoffPending === true
        ? undefined
        : active?.rootRuntime.config.waitTimeoutMs,
      waitBatchCoordinator,
    });

    if (bootstrapAtActivation.kind === "child") {
      registerReplyToParentTool(api, async (toolContext) => {
        if (active !== undefined) active.bindings.context = readContext(toolContext);
        if (active?.handoffPending === true) return undefined;
        return active?.replyCoordinator;
      });
    }

    api.registerCommand("agents", {
      description: "View the read-only agent tree for the current session scope",
      handler: async (_args, rawContext) => {
        const current = active;
        if (current === undefined || current.handoffPending === true) return;
        const context = readContext(rawContext);
        current.bindings.context = context;
        const registered = runtimeUi;
        if (registered === undefined || registered.runtime !== current) {
          bindRuntimeUi(current, context);
        }
        await runtimeUi?.binding.openPanel(context);
      },
    });

    api.on("before_agent_start", async (event) => {
      const current = active;
      if (current === undefined || current.handoffPending === true) return;
      if (!isRecord(event) || typeof event.systemPrompt !== "string") return;
      const guidance: string[] = [];
      if (current.managementEnabled) {
        guidance.push(PARENT_COORDINATION_GUIDANCE);
        let templates: ControlResult<readonly AgentTemplateListItem[]> | undefined;
        try {
          templates = await current.controller.getAgentTemplates();
        } catch {
          // 模板目录查询失败不能阻断本轮；模型仍可通过公开工具重试。
        }
        if (active !== current || Boolean(current.handoffPending)) return;
        if (templates?.ok === true && templates.data.length > 0) {
          guidance.push(formatAgentTemplateCatalog(templates.data));
        }
      }
      if (current.isChild) guidance.push(CHILD_FINAL_REPLY_GUIDANCE);
      if (guidance.length === 0) return;
      return {
        systemPrompt: `${event.systemPrompt}\n\n${guidance.join("\n\n")}`,
      };
    });

    api.on("context", (event, rawContext) => {
      const current = active;
      if (current === undefined || current.handoffPending === true) return;
      current.replyInbox.observeContext(event);
      refreshContextUsage(current, rawContext);
    });

    api.on("agent_start", (_event, rawContext) => {
      const current = active;
      if (current === undefined || !current.isChild || current.handoffPending === true) return;
      coordinationParticipant?.observeAgentStart();
      try {
        current.replyCoordinator?.observeAgentStart();
      } catch (error) {
        current.replyInbox.failTurnTriggers();
        throw error;
      }
      refreshContextUsage(current, rawContext);
      if (current.replyInbox.releaseTurnTriggers()) {
        // 屏障释放只恢复后续控制触发；已接纳消息不由运行时重放。
      }
    });

    api.on("turn_end", (_event, rawContext) => {
      waitBatchCoordinator.clear();
      refreshContextUsage(active, rawContext);
    });

    api.on("message_end", (event, rawContext) => {
      const current = active;
      if (current === undefined || !current.isChild || current.handoffPending === true) return;
      current.replyCoordinator?.observeAssistantMessageEnd(event);
      refreshContextUsage(current, rawContext);
    });

    api.on("agent_end", (_event, rawContext) => {
      const current = active;
      if (current === undefined || !current.isChild || current.handoffPending === true) return;
      current.replyCoordinator?.observeAgentEnd();
      current.replyInbox.blockTurnTriggers();
      refreshContextUsage(current, rawContext);
    });

    api.on("agent_settled", (_event, rawContext) => {
      const current = active;
      if (current === undefined || !current.isChild || current.handoffPending === true) return;
      // raw settled 只建立 child coordinator 的 provisional candidate；发布和父端
      // ACK 均由独立 outbox 完成，不阻塞同一 lifecycle 事件上的其他 handler。
      current.replyInbox.blockTurnTriggers();
      current.replyCoordinator?.settle();
      refreshContextUsage(current, rawContext);
    });

    const failChildCompactionInvariant = (current: ActiveRuntime): void => {
      current.replyInbox.failTurnTriggers();
      current.upstream?.channel.failProtocol();
      void current.upstream?.channel.release().catch(() => {});
    };

    api.on("session_before_compact", (event) => {
      const current = active;
      if (current === undefined || !current.isChild || current.handoffPending === true) return;
      const reason = isRecord(event) ? event.reason : undefined;
      const willRetry = isRecord(event) ? event.willRetry : undefined;
      if (reason === "manual") {
        const coordinated = coordinationParticipant?.beginManualCompaction() === true;
        if (!coordinated) {
          const adopted = coordinationParticipant === undefined
            ? !uncoordinatedManualCompactionActive
            : coordinationParticipant.beginUncoordinatedManualCompaction();
          if (!adopted) {
            failChildCompactionInvariant(current);
            return;
          }
          if (coordinationParticipant === undefined) uncoordinatedManualCompactionActive = true;
        }
        current.replyCoordinator?.observeCompactionStart("manual", false);
        return;
      }
      if (reason !== "threshold" && reason !== "overflow") return;
      coordinationParticipant?.revokePendingManualCompactionAuthorization();
      if (typeof willRetry !== "boolean") return;
      current.replyCoordinator?.observeCompactionStart(reason, willRetry);
    });

    api.on("session_compact", (event, rawContext) => {
      const current = active;
      if (current === undefined || !current.isChild || current.handoffPending === true) return;
      refreshContextUsage(current, rawContext);
      const reason = isRecord(event) ? event.reason : undefined;
      if (reason === "manual") {
        const coordinated = coordinationParticipant?.completeManualCompaction() === true;
        if (!coordinated) {
          const adopted = coordinationParticipant === undefined
            ? uncoordinatedManualCompactionActive
            : coordinationParticipant.completeUncoordinatedManualCompaction();
          if (!adopted) {
            failChildCompactionInvariant(current);
            return;
          }
          if (coordinationParticipant === undefined) uncoordinatedManualCompactionActive = false;
        }
        current.replyCoordinator?.observeCompactionEnd("manual");
        return;
      }
      if (reason !== "threshold" && reason !== "overflow") return;
      coordinationParticipant?.revokePendingManualCompactionAuthorization();
      current.replyCoordinator?.observeCompactionEnd(reason);
    });

    const makeState = (transfer: RuntimeTransfer, context: RuntimeContextView): ActiveRuntime => {
      transfer.bindings.api = api;
      transfer.bindings.context = context;
      return {
        controller: transfer.controller,
        templates: transfer.templates,
        tree: transfer.tree,
        rootRuntime: transfer.rootRuntime,
        rootId: transfer.rootId,
        isChild: transfer.isChild,
        managementEnabled: transfer.managementEnabled,
        authority: transfer.authority,
        ...(transfer.rootAuthority === undefined ? {} : { rootAuthority: transfer.rootAuthority }),
        ...(transfer.upstream === undefined ? {} : { upstream: transfer.upstream }),
        ...(transfer.replyCoordinator === undefined ? {} : { replyCoordinator: transfer.replyCoordinator }),
        replyInbox: transfer.replyInbox,
        bindings: transfer.bindings,
        createSupervisor: transfer.createSupervisor,
      };
    };

    const publishReloadSnapshot = (
      current: ActiveRuntime,
      context: RuntimeContextView,
    ): void => {
      if (current.isChild) return;
      const templates = new TemplateSnapshotController({
        root: current.rootRuntime,
        ...(options.templateFileSystem === undefined ? {} : { fileSystem: options.templateFileSystem }),
      });
      const snapshot = templates.initialize(context);
      current.templates = templates;
      current.controller.updateTemplateSnapshot(snapshot);
      current.rootAuthority?.updateTemplateSnapshot(snapshot);
      const authority = runtimeAuthorities.get(current.rootId);
      if (authority?.tree === current.tree) {
        runtimeAuthorities.set(current.rootId, Object.freeze({
          tree: current.tree,
          rootRuntime: current.rootRuntime,
          templates,
          authority: current.rootAuthority ?? authority.authority,
          rootId: current.rootId,
        }));
      }
    };

    const closeChildControl = async (
      current: ActiveRuntime,
      releaseChannel: boolean,
    ): Promise<void> => {
      const upstream = current.upstream;
      if (upstream === undefined) return;
      try {
        await upstream.publisher.flush();
      } catch {
        // 父端仍以根权威资源确认为准；发布失败不能遗失本地资源所有权。
      }
      try {
        await upstream.publisher.close();
      } catch {
        // 关闭继续推进到请求相关器和字节流，避免留下本地 IPC 句柄。
      }
      upstream.client.close();
      if (releaseChannel) await upstream.channel.release();
    };

    const shutdownRuntime = async (
      current: ActiveRuntime,
      releaseUpstream = true,
      parentBarrierEstablished = false,
    ): Promise<boolean> => {
      disposeRuntimeUi(current);
      let complete: boolean;
      try {
        complete = parentBarrierEstablished
          ? await current.controller.shutdownFromParentBarrier()
          : await current.controller.shutdown();
      } catch {
        complete = false;
      }
      if (!complete) return false;
      await closeChildControl(current, releaseUpstream);
      return true;
    };
    const activationIdentity = reloadIdentity(
      bootstrapAtActivation.kind === "child" ? bootstrapAtActivation.bootstrap : undefined,
    );
    // 内部身份不完整的扩展实例不能认领既有运行时；session_start 会稳定拒绝它。
    const reloadEventBus = bootstrapAtActivation.kind === "invalid"
      ? undefined
      : readRuntimeReloadEventBus(api.events);
    const ensureCoordinationParticipant = (): void => {
      if (coordinationParticipant !== undefined || reloadEventBus === undefined) return;
      coordinationParticipant = new AutoCompactCoordinationParticipant({
        eventBus: reloadEventBus,
        readRuntime: () => {
          const current = active;
          if (current === undefined) return undefined;
          return {
            ...(current.handoffPending === undefined ? {} : { handoffPending: current.handoffPending }),
            replyInbox: current.replyInbox,
            ...(current.replyCoordinator === undefined ? {} : { replyCoordinator: current.replyCoordinator }),
            ...(current.upstream === undefined ? {} : { upstream: { channel: current.upstream.channel } }),
          };
        },
      });
    };
    const closeCoordinationParticipant = async (): Promise<void> => {
      const participant = coordinationParticipant;
      coordinationParticipant = undefined;
      uncoordinatedManualCompactionActive = false;
      if (participant !== undefined) await participant.close();
    };
    ensureCoordinationParticipant();
    let reloadCoordinator: RuntimeReloadCoordinator<ActiveRuntime, RuntimeTransfer>;

    const startSession = async (event: unknown, rawContext: unknown): Promise<void> => {
      ensureCoordinationParticipant();
      const context = readContext(rawContext);
      const sessionEvent = isRecord(event) ? event as RuntimeSessionStartEvent : {};
      const bootstrapResult = readChildRuntimeBootstrap(options.environment);
      if (bootstrapResult.kind === "invalid") throw new Error("子运行时身份元数据无效");
      const bootstrap = bootstrapResult.kind === "child" ? bootstrapResult.bootstrap : undefined;
      if (active !== undefined && sessionEvent.reason === "reload") {
        reloadCoordinator.resumeLocal(active);
        active.bindings.api = api;
        active.bindings.context = context;
        publishReloadSnapshot(active, context);
        applyAgentToolVisibility(api, active.managementEnabled, active.isChild);
        refreshContextUsage(active, context);
        bindRuntimeUi(active, context);
        return;
      }
      if (sessionEvent.reason === "reload") {
        const incoming = reloadCoordinator.prepareIncoming();
        const current = incoming.runtime;
        try {
          current.bindings.api = api;
          current.bindings.context = context;
          if (!current.isChild) {
            publishReloadSnapshot(current, context);
            const authority = runtimeAuthorities.get(current.rootId);
            if (authority !== undefined && authority.tree !== current.tree) {
              throw new Error("根监督权威仍在使用");
            }
            runtimeAuthorities.set(current.rootId, Object.freeze({
              tree: current.tree,
              rootRuntime: current.rootRuntime,
              templates: current.templates,
              authority: current.rootAuthority!,
              rootId: current.rootId,
            }));
          }
          reloadCoordinator.commitIncoming(incoming);
          active = current;
          applyAgentToolVisibility(api, current.managementEnabled, current.isChild);
          refreshContextUsage(current, context);
          bindRuntimeUi(current, context);
          try {
            options.onController?.(current.controller);
          } catch {
            // 测试/宿主观察者不属于控制面。
          }
          return;
        } catch (error) {
          await reloadCoordinator.cleanupIncoming(incoming);
          throw error instanceof Error ? error : new Error("reload 交接失败");
        }
      }
      if (reloadCoordinator.hasIncoming()) {
        const complete = await reloadCoordinator.cleanupIncoming();
        if (!complete) throw new Error("代理树清理尚未确认");
      }
      if (active !== undefined) {
        const current = active;
        const complete = await shutdownRuntime(current);
        if (!complete) throw new Error("代理树清理尚未确认");
        active = undefined;
        reloadCoordinator.releaseRuntime(current);
      }

      const rootId = bootstrap?.rootId ?? readRootId(options.rootIdFactory);
      if (bootstrap === undefined && runtimeAuthorities.has(rootId)) {
        throw new Error("根监督权威仍在使用");
      }
      const rootRuntime = captureRootRuntimeContext({
        cwd: contextCwd(context),
        projectTrust: contextProjectTrust(context),
        ...(options.environment === undefined ? {} : { environment: options.environment }),
        ...(bootstrap === undefined
          ? (options.rootArguments === undefined ? {} : { rootArguments: options.rootArguments })
          : { rootArguments: bootstrap.config }),
        controllerMetadata: {
          rootId,
          protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
        },
        ...(bootstrap === undefined ? { uiContext: context } : {}),
      });
      const templates = new TemplateSnapshotController({
        root: rootRuntime,
        ...(options.templateFileSystem === undefined ? {} : { fileSystem: options.templateFileSystem }),
      });
      const templateSnapshot = templates.initialize(context);
      const tree = new TreeController({
        config: rootRuntime.config,
        ...(options.agentIdFactory === undefined ? {} : { idFactory: options.agentIdFactory }),
        ...(bootstrap === undefined ? {} : {
          initialActor: {
            agentId: bootstrap.agentId,
            parentAgentId: bootstrap.parentAgentId,
            depth: bootstrap.depth,
            managementEnabled: bootstrap.managementEnabled,
            ...(bootstrap.templateId === undefined ? {} : { templateId: bootstrap.templateId }),
            ...(bootstrap.name === undefined ? {} : { name: bootstrap.name }),
          },
        }),
      });
      const actor: TreeActor = bootstrap === undefined
        ? ROOT_TREE_ACTOR
        : Object.freeze({ kind: "agent" as const, agent_id: bootstrap.agentId });
      const requestIdRegistry = new SupervisorRequestIdRegistry();
      let upstream: ChildUpstreamControl | undefined;
      let stateReference: ActiveRuntime | undefined;
      let authority: TreeAuthorityPort;
      let rootAuthority: RootTreeAuthority | undefined;
      if (bootstrap === undefined) {
        rootAuthority = new RootTreeAuthority({ tree, templateSnapshot });
        authority = rootAuthority;
      } else {
        const initial = tree.getSupervisionSubtreeSnapshot(actor);
        if (!initial.ok) throw new Error("子运行时初始子树不可用");
        const transportAdapter = options.localSupervisorTransportAdapter
          ?? nativeLocalSupervisorTransportAdapter;
        const connectionAbort = new AbortController();
        const connectionTimer = setTimeout(() => connectionAbort.abort(), 30_000);
        connectionTimer.unref?.();
        let channel: StreamSupervisorChannel | undefined;
        try {
          const transport = await transportAdapter.connect({
            endpoint: bootstrap.supervisorEndpoint,
            agentId: bootstrap.agentId,
            credential: bootstrap.localSupervisorCredential,
            signal: connectionAbort.signal,
          });
          channel = new StreamSupervisorChannel({
            role: "child",
            rootId,
            localAgentId: bootstrap.agentId,
            peerAgentId: bootstrap.parentAgentId ?? "",
            parentAgentId: bootstrap.parentAgentId,
            depth: bootstrap.depth,
            credential: bootstrap.supervisorCredential,
            requestIdRegistry,
            transport,
            initialSnapshot: initial.data.nodes,
            // 子树修订是本地监督流序号，不等同于公开 tree_revision；保留 0
            // 作为协议端点的空缓存初值，首个非空完整快照从 1 开始。
            initialSubtreeRevision: initial.data.tree_revision + 1,
            onCloseRequested: () => stateReference === undefined
              ? false
              : shutdownRuntime(stateReference, false, true),
          });
          await channel.bind(connectionAbort.signal);
          await channel.waitForReady(connectionAbort.signal);
        } catch (error) {
          if (channel !== undefined) await channel.release();
          throw error instanceof Error ? error : new Error("子监督通道建立失败");
        } finally {
          clearTimeout(connectionTimer);
        }
        const client = new SupervisorControlClient(channel);
        authority = new RemoteTreeAuthorityPort(bootstrap.agentId, client);
        const publisher = new SubtreePublisher<AgentSnapshot>({
          read: () => {
            const current = tree.getSupervisionSubtreeSnapshot(actor);
            if (!current.ok) throw new Error("子树投影不可用");
            return Object.freeze({
              nodes: current.data.nodes,
              subtreeRevision: current.data.tree_revision + 1,
            });
          },
          onChange: (listener) => tree.onChange(listener),
        }, channel);
        upstream = Object.freeze({ channel, client, publisher });
      }
      const replyInbox = new ParentReplyInbox({
        readApi: () => {
          const current = stateReference;
          if (current === undefined) throw new Error("父会话尚未就绪");
          return current.bindings.api;
        },
        onSessionEvent: (agentId, event) => {
          if (event === "reply" || event === "final_report") {
            stateReference?.controller.recordAcceptedSessionEvent(agentId, event);
          } else {
            stateReference?.controller.notifySessionEvent(agentId, event);
          }
        },
        readSenderName: (agentId) => readDirectChildDisplayName(stateReference, agentId, false),
      });
      const replyCoordinator = upstream === undefined
        ? undefined
        : new ChildReplyCoordinator({
          agentId: bootstrap!.agentId,
          port: upstream.channel,
        });
      const state: ActiveRuntime = {
        controller: undefined as unknown as AgentController,
        templates,
        tree,
        rootRuntime,
        rootId,
        isChild: bootstrap !== undefined,
        managementEnabled: bootstrap?.managementEnabled ?? true,
        authority,
        ...(rootAuthority === undefined ? {} : { rootAuthority }),
        ...(upstream === undefined ? {} : { upstream }),
        ...(replyCoordinator === undefined ? {} : { replyCoordinator }),
        replyInbox,
        bindings: { api, context },
        createSupervisor: undefined as unknown as AgentSupervisorFactory,
      };
      stateReference = state;
      const controlHandler = rootAuthority === undefined
        ? createForwardControlHandler(bootstrap!.agentId, upstream!.client)
        : createRootAuthorityControlHandler(rootAuthority);
      const createSupervisor = createAgentSupervisorFactory({
        tree,
        actor,
        processTreeAdapter: capabilities.processTreeAdapter,
        rootRuntime,
        templateSnapshot,
        rootId,
        currentModel: () => currentModelReference(state.bindings.context),
        currentThinking: () => currentThinking(state.bindings.context),
        deliverReply: (agentId, reply) => state.replyInbox.accept(agentId, reply),
        onCompactionPrepare: (agentId, transactionId) =>
          state.replyInbox.beginChildCompactionBarrier(agentId, transactionId),
        onCompactionComplete: (agentId, transactionId) => {
          const completed = state.replyInbox.completeChildCompactionBarrier(agentId, transactionId);
          return completed;
        },
        requestIdRegistry,
        bindControlServer: (_agentId, channel) => {
          const server = new SupervisorControlServer(channel, controlHandler);
          return () => server.close();
        },
        ...(options.bridgeScriptPath === undefined ? {} : { bridgeScriptPath: options.bridgeScriptPath }),
        ...(options.childPiCliPath === undefined ? {} : { childPiCliPath: options.childPiCliPath }),
        ...(options.childPiModulePath === undefined ? {} : { childPiModulePath: options.childPiModulePath }),
        ...(options.selfExtensionPath === undefined ? {} : { childExtensionPath: options.selfExtensionPath }),
        ...(options.nodeFactory === undefined ? {} : { nodeFactory: options.nodeFactory }),
      });
      const controller = new AgentController({
        tree,
        actor,
        createSupervisor,
        templateSnapshot,
        waitTimeoutMs: rootRuntime.config.waitTimeoutMs,
        onTerminal: (agentId) => state.replyInbox.acceptTerminal(agentId),
        replyNotificationsHandledByInbox: true,
        authority,
      });
      state.controller = controller;
      state.createSupervisor = createSupervisor;
      try {
        if (upstream !== undefined) {
          const initial = tree.getSupervisionSubtreeSnapshot(actor);
          if (!initial.ok) throw new Error("子运行时初始子树不可用");
          await upstream.publisher.start(Object.freeze({
            nodes: initial.data.nodes,
            subtreeRevision: initial.data.tree_revision + 1,
          }));
        }
      } catch (error) {
        await shutdownRuntime(state);
        throw error instanceof Error ? error : new Error("子树发布器启动失败");
      }
      active = state;
      if (bootstrap === undefined) {
        runtimeAuthorities.set(rootId, Object.freeze({
          tree,
          rootRuntime,
          templates,
          authority: rootAuthority!,
          rootId,
        }));
      }
      applyAgentToolVisibility(api, state.managementEnabled, state.isChild);
      refreshContextUsage(state, context);
      if (state.upstream !== undefined) {
        await state.upstream.channel.publishCapability(childCapabilityManifest(
          api,
          context,
          options.selfExtensionPath ?? defaultSelfExtensionPath(),
        ));
      }
      bindRuntimeUi(state, context);
      try {
        options.onController?.(controller);
      } catch {
        // 测试/宿主观察者不属于控制面。
      }
    };

    const shutdownSession = async (event: unknown): Promise<void> => {
      waitBatchCoordinator.clear();
      const current = active;
      const reason = isRecord(event) ? event.reason : undefined;
      if (current !== undefined && reason === "reload" && reloadCoordinator.beginHandoff(current)) {
        await closeCoordinationParticipant();
        disposeRuntimeUi(current);
        applyAgentToolVisibility(api, false, false);
        return;
      }
      await closeCoordinationParticipant();
      if (current === undefined) {
        await reloadCoordinator.cleanupIncoming();
        return;
      }
      reloadCoordinator.cancelHandoff(current);
      const complete = await shutdownRuntime(current);
      if (complete) {
        if (active === current) active = undefined;
        reloadCoordinator.releaseRuntime(current);
      }
    };

    api.on("session_start", (event, context) => {
      lifecycle = lifecycle.then(
        () => startSession(event, context),
        () => startSession(event, context),
      );
      return lifecycle;
    });
    api.on("session_shutdown", (event) => {
      lifecycle = lifecycle.then(
        () => shutdownSession(event),
        () => shutdownSession(event),
      );
      return lifecycle;
    });

    // 所有可能抛错的公开面和生命周期注册完成后才认领旧树。此后 Pi 会等待
    // 全部扩展 factory，再向这个已完整装配的新实例发送 session_start。
    reloadCoordinator = new RuntimeReloadCoordinator<ActiveRuntime, RuntimeTransfer>({
      ...(reloadEventBus === undefined ? {} : { eventBus: reloadEventBus }),
      timeoutMs: reloadLeaseTimeoutMs,
      activationIdentity,
      isTransfer: isRuntimeTransfer,
      identityOfRuntime: (runtime) => reloadIdentityOfRuntime(runtime),
      identityOfTransfer: (transfer) => reloadIdentityOfTransfer(transfer),
      createTransfer: (current) => Object.freeze({
        protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
        controller: current.controller,
        templates: current.templates,
        tree: current.tree,
        rootRuntime: current.rootRuntime,
        rootId: current.rootId,
        isChild: current.isChild,
        managementEnabled: current.managementEnabled,
        authority: current.authority,
        ...(current.rootAuthority === undefined ? {} : { rootAuthority: current.rootAuthority }),
        ...(current.upstream === undefined ? {} : { upstream: current.upstream }),
        ...(current.replyCoordinator === undefined ? {} : { replyCoordinator: current.replyCoordinator }),
        replyInbox: current.replyInbox,
        bindings: current.bindings,
        createSupervisor: current.createSupervisor,
      }),
      restoreTransfer: (transfer) => makeState(transfer, transfer.bindings.context),
      getActive: () => active,
      setActive: (runtime) => {
        active = runtime;
      },
      setHandoffPending: (runtime, pending) => {
        runtime.handoffPending = pending;
      },
      cleanup: (runtime) => shutdownRuntime(runtime),
      relinquish: (runtime) => {
        relinquishAuthority(runtime);
      },
      release: (runtime) => releaseAuthority(runtime),
    });
  };
}

export const activateWjPiSubagentsRuntime = createWjPiSubagentsRuntimeActivator();
