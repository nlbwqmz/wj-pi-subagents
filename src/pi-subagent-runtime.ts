import { randomUUID } from "node:crypto";
import type { AgentController as AgentControllerType } from "./agent-controller.ts";
import { AgentController } from "./agent-controller.ts";
import {
  createAgentSupervisorFactory,
  type AgentSupervisorFactoryOptions,
} from "./agent-supervisor-factory.ts";
import {
  AGENT_TOOL_NAMES,
  registerAgentTools,
  type AgentToolRegistrationApi,
} from "./agent-tools.ts";
import type {
  AvailableHostCapabilities,
  ExtensionApiSurface,
} from "./host-gate.ts";
import type { EnvironmentInput } from "./root-runtime-context.ts";
import { captureRootRuntimeContext } from "./root-runtime-context.ts";
import { SUPERVISOR_PROTOCOL_VERSION } from "./supervisor-channel.ts";
import {
  TemplateSnapshotController,
  type TemplateDefinition,
  type TemplateDiscoveryFileSystem,
} from "./template-discovery-snapshot.ts";
import {
  controlFailure,
  ROOT_TREE_ACTOR,
  TreeController,
  type ControlResult,
} from "./tree-controller.ts";

export const PI_SUBAGENT_REPLY_MESSAGE_TYPE = "pi-subagent-reply" as const;

interface RuntimeExtensionApi extends AgentToolRegistrationApi {
  on(event: string, handler: (event: unknown, context: unknown) => unknown): void;
  getActiveTools(): string[];
  getAllTools(): unknown[];
  sendMessage(message: unknown, options?: unknown): void;
}

interface RuntimeModel {
  readonly provider: string;
  readonly id: string;
  readonly reasoning?: boolean;
  readonly thinkingLevelMap?: Readonly<Record<string, unknown>>;
}

interface RuntimeContextView {
  readonly cwd?: unknown;
  readonly hasUI?: unknown;
  readonly ui?: { readonly notify?: unknown };
  readonly model?: unknown;
  readonly thinkingLevel?: unknown;
  readonly modelRegistry?: unknown;
  readonly scopedModels?: unknown;
  readonly isProjectTrusted?: unknown;
}

interface RuntimeSessionStartEvent {
  readonly type?: unknown;
  readonly reason?: unknown;
}

export interface PiSubagentRuntimeOptions {
  readonly rootIdFactory?: () => string;
  readonly agentIdFactory?: () => string;
  readonly environment?: EnvironmentInput;
  readonly rootArguments?: unknown;
  readonly templateFileSystem?: TemplateDiscoveryFileSystem;
  readonly bridgeScriptPath?: string;
  readonly nodeFactory?: AgentSupervisorFactoryOptions["nodeFactory"];
  /** 测试/宿主观察接缝；异常不会改变激活结果。 */
  readonly onController?: (controller: AgentControllerType) => void;
}

export type PiSubagentRuntimeActivator = (
  extensionApi: ExtensionApiSurface,
  capabilities: AvailableHostCapabilities,
) => void | Promise<void>;

interface ActiveRuntime {
  controller: AgentController;
  readonly templates: TemplateSnapshotController;
  context: RuntimeContextView;
}

const MANAGEMENT_TOOL_NAMES = new Set<string>(AGENT_TOOL_NAMES);

function asRuntimeApi(api: ExtensionApiSurface): RuntimeExtensionApi {
  return api as RuntimeExtensionApi;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readContext(value: unknown): RuntimeContextView {
  return isRecord(value) ? value as RuntimeContextView : {};
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
    if (!isRecord(tool) || typeof tool.name !== "string" || MANAGEMENT_TOOL_NAMES.has(tool.name)) continue;
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
    (name): name is string => typeof name === "string" && !MANAGEMENT_TOOL_NAMES.has(name),
  ));
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

function deliverReply(
  api: RuntimeExtensionApi,
  agentId: string,
  reply: ManagedReplyShape,
): boolean {
  const content: Array<Record<string, string>> = [];
  if (reply.text.length > 0) content.push({ type: "text", text: reply.text });
  for (const image of reply.images ?? []) {
    content.push({ type: "image", data: image.data, mimeType: image.mimeType });
  }
  if (content.length === 0) return false;
  try {
    api.sendMessage({
      customType: PI_SUBAGENT_REPLY_MESSAGE_TYPE,
      content,
      display: true,
      details: { agent_id: agentId },
    }, { triggerTurn: true, deliverAs: "steer" });
    return true;
  } catch {
    return false;
  }
}

interface ManagedReplyShape {
  readonly text: string;
  readonly images?: readonly {
    readonly type: "image";
    readonly data: string;
    readonly mimeType: string;
  }[];
}

export function createPiSubagentRuntimeActivator(
  options: PiSubagentRuntimeOptions = {},
): PiSubagentRuntimeActivator {
  return async (extensionApi, capabilities) => {
    const api = asRuntimeApi(extensionApi);
    let active: ActiveRuntime | undefined;
    let lifecycle: Promise<void> = Promise.resolve();

    registerAgentTools(api, async (toolContext) => {
      if (active !== undefined) active.context = readContext(toolContext);
      return active?.controller as AgentController;
    });

    const startSession = async (event: unknown, rawContext: unknown): Promise<void> => {
      const context = readContext(rawContext);
      const sessionEvent = isRecord(event) ? event as RuntimeSessionStartEvent : {};
      if (active !== undefined && sessionEvent.reason === "reload") {
        active.context = context;
        active.controller.updateTemplateSnapshot(active.templates.reload(context));
        return;
      }
      if (active !== undefined) await active.controller.shutdown();

      const rootId = readRootId(options.rootIdFactory);
      const rootRuntime = captureRootRuntimeContext({
        cwd: contextCwd(context),
        projectTrust: contextProjectTrust(context),
        ...(options.environment === undefined ? {} : { environment: options.environment }),
        ...(options.rootArguments === undefined ? {} : { rootArguments: options.rootArguments }),
        controllerMetadata: {
          rootId,
          protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
        },
        uiContext: context,
      });
      const templates = new TemplateSnapshotController({
        root: rootRuntime,
        knownTools: knownBusinessTools(api),
        ...(options.templateFileSystem === undefined ? {} : { fileSystem: options.templateFileSystem }),
      });
      const templateSnapshot = templates.initialize(context);
      const tree = new TreeController({
        config: rootRuntime.config,
        ...(options.agentIdFactory === undefined ? {} : { idFactory: options.agentIdFactory }),
      });
      const state: ActiveRuntime = {
        controller: undefined as unknown as AgentController,
        templates,
        context,
      };
      const createSupervisor = createAgentSupervisorFactory({
        tree,
        actor: ROOT_TREE_ACTOR,
        processTreeAdapter: capabilities.processTreeAdapter,
        rootRuntime,
        templateSnapshot,
        rootId,
        activeTools: () => activeBusinessTools(api),
        currentModel: () => currentModelReference(state.context),
        currentThinking: () => currentThinking(state.context),
        deliverReply: (agentId, reply) => deliverReply(api, agentId, reply),
        ...(options.bridgeScriptPath === undefined ? {} : { bridgeScriptPath: options.bridgeScriptPath }),
        ...(options.nodeFactory === undefined ? {} : { nodeFactory: options.nodeFactory }),
      });
      const controller = new AgentController({
        tree,
        actor: ROOT_TREE_ACTOR,
        createSupervisor,
        templateSnapshot,
        activeTools: () => activeBusinessTools(api),
        validateTemplate: (template) => validateTemplateAgainstContext(template, state.context),
        waitTimeoutMs: rootRuntime.config.waitTimeoutMs,
      });
      state.controller = controller;
      active = state;
      try {
        options.onController?.(controller);
      } catch {
        // 测试/宿主观察者不属于控制面。
      }
    };

    const shutdownSession = async (): Promise<void> => {
      const current = active;
      active = undefined;
      if (current !== undefined) await current.controller.shutdown();
    };

    api.on("session_start", (event, context) => {
      lifecycle = lifecycle.then(
        () => startSession(event, context),
        () => startSession(event, context),
      );
      return lifecycle;
    });
    api.on("session_shutdown", () => {
      lifecycle = lifecycle.then(shutdownSession, shutdownSession);
      return lifecycle;
    });
  };
}

export const activatePiSubagentRuntime = createPiSubagentRuntimeActivator();
