import { randomBytes, randomUUID } from "node:crypto";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_TOOL_NAMES, CHILD_REPLY_TOOL_NAME } from "./agent-tools.ts";
import type {
  AgentSupervisorFactory,
  AgentSupervisorFactoryInput,
} from "./agent-controller.ts";
import {
  createManagedRpcNode,
  type ManagedRpcNodeLike,
  type ManagedRpcReply,
  type ManagedRpcSupervisorInit,
} from "./managed-rpc-node.ts";
import { ManagedRpcSupervisorChannel } from "./managed-rpc-supervisor-channel.ts";
import type { ProcessTreeAdapter } from "./process-tree-capability.ts";
import {
  RpcSupervisor,
  type RpcSupervisorChannelBinding,
} from "./rpc-supervisor.ts";
import type {
  SupervisorCapabilityManifest,
  SupervisorCompactionComplete,
} from "./supervisor-channel.ts";
import type { RootRuntimeContext } from "./root-runtime-context.ts";
import type {
  TemplateDefinition,
  TemplateDiscoverySnapshot,
} from "./template-discovery-snapshot.ts";
import { SupervisorRequestIdRegistry } from "./supervisor-channel.ts";
import type { TreeActor, TreeController } from "./tree-controller.ts";

export interface AgentSupervisorFactoryOptions {
  readonly tree: TreeController;
  readonly actor: TreeActor;
  readonly processTreeAdapter: ProcessTreeAdapter;
  readonly rootRuntime: RootRuntimeContext;
  readonly templateSnapshot: TemplateDiscoverySnapshot;
  readonly rootId?: string;
  readonly bridgeScriptPath?: string;
  /** 子 Pi CLI 入口；未提供时从宿主正在运行的 cli.js 推导。 */
  readonly childPiCliPath?: string;
  /** 子 Pi 模块入口；未提供时从 childPiCliPath 的同目录 index.js 推导。 */
  readonly childPiModulePath?: string;
  /** 子 Pi 必须显式加载本扩展；未填写时使用包内标准入口。 */
  readonly childExtensionPath?: string;
  readonly startupTimeoutMs?: number;
  readonly gracefulShutdownMs?: number;
  readonly nodeFactory?: (template: TemplateDefinition) => ManagedRpcNodeLike;
  readonly activeTools?: () => readonly string[];
  readonly currentModel?: string | (() => string | undefined);
  readonly currentThinking?: string | (() => string | undefined);
  readonly managementToolNames?: readonly string[];
  readonly childReplyToolNames?: readonly string[];
  /** 只有宿主消息已同步进入父会话上下文时才返回 true，随后协议才会 ACK。 */
  readonly deliverReply?: (agentId: string, reply: ManagedRpcReply) => boolean;
  /** 为当前父会话内的直接子同步建立/释放协调压缩 reply 屏障。 */
  readonly onCompactionPrepare?: (agentId: string, transactionId: string) => boolean;
  readonly onCompactionComplete?: (
    agentId: string,
    transactionId: string,
    outcome: SupervisorCompactionComplete["outcome"],
  ) => boolean;
  /** 为每条直接子监督通道绑定根裁决或逐跳转发服务。 */
  readonly bindControlServer?: (
    agentId: string,
    channel: ManagedRpcSupervisorChannel,
  ) => (() => void) | void;
  /** 本控制器的上游与全部直接子通道共享同一请求 ID 顺序域。 */
  readonly requestIdRegistry?: SupervisorRequestIdRegistry;
}

/** 生产节点装配所需的稳定桥接超时；不受 wait_agent 参数影响。 */
export const DEFAULT_RPC_STARTUP_TIMEOUT_MS = 30_000;
export const DEFAULT_RPC_GRACEFUL_SHUTDOWN_MS = 2_000;

/**
 * 创建 AgentController 使用的生产监督器工厂。工厂本身不启动进程；每次
 * `createSupervisor` 只构造一个节点，实际 launch 仍由 RpcSupervisor.start 线性化。
 */
export function createAgentSupervisorFactory(
  options: AgentSupervisorFactoryOptions,
): AgentSupervisorFactory {
  if (options.templateSnapshot === undefined) throw new TypeError("生产工厂需要模板快照");
  let templateSnapshot = options.templateSnapshot;
  const rootId = options.rootId ?? randomUUID();
  const localAgentId = options.actor.kind === "agent" ? options.actor.agent_id : null;
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_RPC_STARTUP_TIMEOUT_MS;
  const gracefulShutdownMs = options.gracefulShutdownMs ?? DEFAULT_RPC_GRACEFUL_SHUTDOWN_MS;
  const requestIdRegistry = options.requestIdRegistry ?? new SupervisorRequestIdRegistry();
  const childPiPaths = resolveChildPiPaths(options);

  const factory = ((input: AgentSupervisorFactoryInput): RpcSupervisor => {
    const template = input.template ?? resolveTemplate(templateSnapshot, input.reservation.templateId);
    if (template === undefined) throw new Error("模板快照未提供有效模板");
    const extensionPath = options.childExtensionPath ?? defaultChildExtensionPath();
    const childReplyTools = options.childReplyToolNames ?? [CHILD_REPLY_TOOL_NAME];
    const managementTools = childManagementEnabled(options, input, template)
      ? (options.managementToolNames ?? AGENT_TOOL_NAMES)
      : [];
    // 在创建瞬间冻结继承配置，避免 parent 会话后续切换模型后改变该 child 的契约。
    const expectedModel = template.model ?? resolveCurrent(options.currentModel);
    const expectedThinking = template.thinking ?? resolveCurrent(options.currentThinking);
    const rpcOptions = buildManagedRpcOptions(template, {
      currentModel: expectedModel,
      currentThinking: expectedThinking,
      projectTrust: options.rootRuntime.projectTrust,
      extensionPath,
      ...(childPiPaths.cliPath === undefined ? {} : { cliPath: childPiPaths.cliPath }),
      ...(childPiPaths.modulePath === undefined ? {} : { piModulePath: childPiPaths.modulePath }),
      childReplyTools,
      managementTools,
    });
    const node = options.nodeFactory?.(template) ?? createManagedRpcNode({
      processTreeAdapter: options.processTreeAdapter,
      cwd: options.rootRuntime.cwd,
      env: options.rootRuntime.environment,
      rpcOptions,
      ...(options.bridgeScriptPath === undefined ? {} : { bridgeScriptPath: options.bridgeScriptPath }),
    });

    let rpcSupervisor: RpcSupervisor | undefined;
    let directAgentId: string | undefined;
    rpcSupervisor = new RpcSupervisor({
      controller: options.tree,
      actor: input.actor,
      reservation: input.reservation,
      ...(input.grant === undefined ? {} : { grant: input.grant }),
      managedNode: node,
      // nodeFactory 是测试/宿主 seam；生产受管节点必须在首任务前获得 manifest。
      ...(options.nodeFactory === undefined
        ? {
          validateCapability: (capability: SupervisorCapabilityManifest) => childCapabilityMatches(capability, {
            template,
            extensionPath,
            childReplyTools,
            managementTools,
            expectedModel,
            expectedThinking,
          }),
        }
        : {}),
      channelFactory: (context): RpcSupervisorChannelBinding => {
        directAgentId = context.agent_id;
        const credential = randomBytes(32).toString("base64url");
        const channel = new ManagedRpcSupervisorChannel({
          node,
          rootId,
          localAgentId,
          peerAgentId: context.agent_id,
          parentAgentId: context.parent_agent_id,
          depth: context.depth,
          credential,
          requestIdRegistry,
          onReply: (reply) => {
            if (rpcSupervisor === undefined || options.deliverReply === undefined) return false;
            return rpcSupervisor.acceptChildReply(reply.envelope, () => {
              try {
                return options.deliverReply!(context.agent_id, reply.envelope) === true;
              } catch {
                return false;
              }
            });
          },
        });
        let cleanup: (() => void) | void;
        try {
          cleanup = options.bindControlServer?.(context.agent_id, channel);
        } catch {
          void channel.release();
          throw new Error("监督控制服务绑定失败");
        }
        const supervisor: ManagedRpcSupervisorInit = {
          root_id: rootId,
          local_agent_id: context.agent_id,
          peer_agent_id: localAgentId ?? "",
          parent_agent_id: context.parent_agent_id,
          depth: context.depth,
          credential,
          initial_snapshot: context.initial_snapshot,
          initial_subtree_revision: 1,
        };
        const runtime = options.rootRuntime.createChildRuntimeContext({
          parentAgentId: context.parent_agent_id,
          agentId: context.agent_id,
          depth: context.depth,
          managementEnabled: childManagementCapability(options.tree, context.agent_id),
          ...(context.initial_snapshot[0]?.template_id === undefined
            ? {}
            : { templateId: context.initial_snapshot[0].template_id }),
          ...(context.initial_snapshot[0]?.name === undefined
            ? {}
            : { name: context.initial_snapshot[0].name }),
        });
        return Object.freeze({
          channel,
          ...(cleanup === undefined ? {} : { cleanup }),
          nodeStartContext: Object.freeze({
            supervisor,
            environment: runtime.environment,
          }),
        });
      },
      startupTimeoutMs,
      gracefulShutdownMs,
      onCompactionPrepare: (transactionId) => directAgentId === undefined
        ? false
        : options.onCompactionPrepare?.(directAgentId, transactionId) ?? false,
      onCompactionComplete: (transactionId, outcome) => directAgentId === undefined
        ? false
        : options.onCompactionComplete?.(directAgentId, transactionId, outcome) ?? false,
    });
    return rpcSupervisor;
  }) as AgentSupervisorFactory;
  factory.updateTemplateSnapshot = (snapshot: TemplateDiscoverySnapshot): void => {
    templateSnapshot = snapshot;
  };
  return factory;
}

function childManagementCapability(tree: TreeController, agentId: string): boolean {
  const capability = tree.getManagementBootstrapCapability(agentId);
  return capability.ok && capability.data.enabled;
}

function resolveTemplate(
  snapshot: TemplateDiscoverySnapshot,
  templateId: string,
): TemplateDefinition | undefined {
  const result = snapshot.resolveTemplate(templateId);
  return result.kind === "valid" ? result.template : undefined;
}

export function buildManagedRpcOptions(
  template: TemplateDefinition,
  options: {
    readonly currentModel?: AgentSupervisorFactoryOptions["currentModel"];
    readonly currentThinking?: AgentSupervisorFactoryOptions["currentThinking"];
    /** 根会话捕获的信任结论必须以 Pi CLI 覆盖参数传给全部后代。 */
    readonly projectTrust?: boolean;
    readonly childReplyTools?: readonly string[];
    readonly managementTools?: readonly string[];
    readonly extensionPath?: string;
    readonly cliPath?: string;
    readonly piModulePath?: string;
  } = {},
): Readonly<Record<string, unknown>> {
  const args: string[] = [
    "--no-session",
    ...(options.projectTrust === undefined ? [] : [options.projectTrust ? "--approve" : "--no-approve"]),
  ];
  // 缺省 extensions 完全遵循 Pi 发现规则；显式空数组与白名单均关闭普通发现。
  if (template.extensions !== undefined) args.push("--no-extensions");
  if (options.extensionPath !== undefined) args.push("-e", options.extensionPath);
  for (const extension of template.extensions ?? []) {
    args.push("-e", resolveTemplateExtensionSource(template, extension.displaySource));
  }
  if (!template.contextFiles) args.push("--no-context-files");
  const thinking = template.thinking ?? resolveCurrent(options.currentThinking);
  if (thinking !== undefined) args.push("--thinking", thinking);
  const templatePrompt = template.body.trim() === ""
    ? undefined
    : Object.freeze({
      mode: template.systemPromptMode,
      body: template.body,
    });
  // tools 缺省时绝不能传 --tools，否则会覆写 Pi 的原生活动工具集合。
  // 显式列表（包含 []）才与协议工具合并为 child 的严格 allowlist。
  if (template.tools !== undefined) {
    const tools = [...new Set([
      ...template.tools,
      ...(options.childReplyTools ?? []),
      ...(options.managementTools ?? []),
    ])];
    args.push("--tools", tools.join(","));
  }
  const selectedModel = template.model ?? resolveCurrent(options.currentModel);
  const [provider, model] = splitModel(selectedModel);
  return Object.freeze({
    ...(options.cliPath === undefined ? {} : { cliPath: options.cliPath }),
    ...(options.piModulePath === undefined ? {} : { piModulePath: options.piModulePath }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(templatePrompt === undefined ? {} : { templatePrompt }),
    args: Object.freeze(args),
  });
}

interface ExpectedChildCapability {
  readonly template: TemplateDefinition;
  readonly extensionPath: string;
  readonly childReplyTools: readonly string[];
  readonly managementTools: readonly string[];
  readonly expectedModel: string | undefined;
  readonly expectedThinking: string | undefined;
}

function childCapabilityMatches(
  capability: SupervisorCapabilityManifest,
  expected: ExpectedChildCapability,
): boolean {
  if (!sameStringSet(capability.system_active_tools, [
    ...expected.childReplyTools,
    ...expected.managementTools,
  ])) return false;
  if (expected.template.tools !== undefined && !sameStringSet(
    capability.business_active_tools,
    expected.template.tools,
  )) return false;

  const systemNames = new Set(capability.system_active_tools);
  const sourceNames = Object.keys(capability.system_tool_sources);
  if (!sameStringSet(sourceNames, [...systemNames])) return false;
  if (!samePathIdentity(capability.self_extension_path, expected.extensionPath)) return false;
  for (const name of systemNames) {
    if (!samePathIdentity(capability.system_tool_sources[name], expected.extensionPath)) return false;
  }

  const model = splitModel(expected.expectedModel);
  if (model[0] === undefined || model[1] === undefined) {
    if (capability.provider !== undefined || capability.model !== undefined) return false;
  } else if (capability.provider !== model[0] || capability.model !== model[1]) {
    return false;
  }
  return capability.thinking === expected.expectedThinking;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const values = new Set(left);
  return values.size === left.length && right.every((value) => values.has(value));
}

function samePathIdentity(left: string | undefined, right: string): boolean {
  if (left === undefined) return false;
  const normalize = (value: string): string => {
    const resolved = resolvePath(value).replace(/\\/g, "/");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  try {
    return normalize(left) === normalize(right);
  } catch {
    return false;
  }
}

interface ChildPiPaths {
  readonly cliPath?: string;
  readonly modulePath?: string;
}

/**
 * RpcClient 在子进程中运行，不能依赖 wj-pi-subagents 包目录中的 peer 依赖解析。
 * Pi CLI 的 argv[1] 是可靠的宿主入口；仅识别 cli.js，避免测试 runner 等路径
 * 被误判为 Pi CLI。
 */
function resolveChildPiPaths(
  options: Pick<AgentSupervisorFactoryOptions, "childPiCliPath" | "childPiModulePath">,
): ChildPiPaths {
  const configuredCliPath = normalizePath(options.childPiCliPath);
  const configuredModulePath = normalizePath(options.childPiModulePath);
  const inferredCliPath = configuredCliPath === undefined ? inferHostPiCliPath() : undefined;
  const cliPath = configuredCliPath ?? inferredCliPath;
  const modulePath = configuredModulePath
    ?? (cliPath === undefined ? undefined : join(dirname(cliPath), "index.js"));
  return Object.freeze({
    ...(cliPath === undefined ? {} : { cliPath }),
    ...(modulePath === undefined ? {} : { modulePath }),
  });
}

function inferHostPiCliPath(): string | undefined {
  const entry = process.argv[1];
  if (typeof entry !== "string" || basename(entry).toLowerCase() !== "cli.js") return undefined;
  return resolvePath(entry);
}

function normalizePath(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  return resolvePath(value);
}

function defaultChildExtensionPath(): string {
  try {
    return fileURLToPath(new URL("../index.ts", import.meta.url));
  } catch {
    throw new Error("子代理扩展入口不可用");
  }
}

function childManagementEnabled(
  options: Pick<AgentSupervisorFactoryOptions, "tree" | "rootRuntime">,
  input: AgentSupervisorFactoryInput,
  template: TemplateDefinition,
): boolean {
  if (!template.allowSubagents) return false;
  const parentCapability = options.tree.getManagementCapability(input.actor);
  if (!parentCapability.ok || !parentCapability.data.enabled) return false;
  if (input.actor.kind === "root") return 1 < options.rootRuntime.config.maxDepth;
  const parent = options.tree.getStatus(input.actor.agent_id);
  return parent.ok && parent.data.depth + 1 < options.rootRuntime.config.maxDepth;
}

function resolveTemplateExtensionSource(template: TemplateDefinition, source: string): string {
  if (!isLocalExtensionSource(source)) return source;
  return resolvePath(template.templateDirectory, source);
}

function isLocalExtensionSource(source: string): boolean {
  if (source.startsWith("npm:") || source.startsWith("git:")) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source) || /^git@/i.test(source)) return false;
  return true;
}

function resolveCurrent(
  value: string | (() => string | undefined) | undefined,
): string | undefined {
  if (typeof value !== "function") return value;
  try {
    return value();
  } catch {
    return undefined;
  }
}

function splitModel(value: string | undefined): [string | undefined, string | undefined] {
  if (value === undefined) return [undefined, undefined];
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) return [undefined, undefined];
  return [value.slice(0, separator), value.slice(separator + 1)];
}
