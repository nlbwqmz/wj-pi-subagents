import type { AgentController } from "./agent-controller.ts";
import type { ChildReplyCoordinator } from "./child-reply-coordinator.ts";
import {
  renderAgentToolCall,
  renderAgentToolResult,
  type AgentToolRenderContext,
  type AgentToolRenderLookups,
  type AgentToolRenderTheme,
  type AgentToolResultRenderOptions,
  type AgentToolResultView,
} from "./agent-tool-rendering.ts";
import { controlFailure, type ControlResult } from "./tree-controller.ts";

/** Pi 扩展 API 的最小结构面；生产类型由宿主包提供，核心包不复制其定义。 */
export interface AgentToolRegistrationApi {
  registerTool: (tool: unknown) => void;
}

export type AgentToolControllerProvider = (
  context: unknown,
) => AgentController | Promise<AgentController>;

export const AGENT_TOOL_NAMES = Object.freeze([
  "get_agent_templates",
  "spawn_agent",
  "send_message",
  "wait_agent",
  "interrupt_agent",
  "terminate_agent",
  "get_agent_status",
  "get_agent_tree",
] as const);

/** 子代理向唯一直接父会话上行工作中回复的专用工具；不属于管理工具集合。 */
export const CHILD_REPLY_TOOL_NAME = "reply_to_parent" as const;

export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

/** 公开工具错误使用稳定 JSON 外壳，不把异常、路径或句柄带回模型。 */
export class SubagentToolError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly details?: Readonly<Record<string, never>>;
  }) {
    super(JSON.stringify({
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        details: error.details ?? {},
      },
    }));
    this.name = "SubagentToolError";
    this.code = error.code;
    this.retryable = error.retryable;
  }
}

interface JsonSchema {
  readonly type: string;
  readonly description?: string;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: JsonSchema;
  readonly enum?: readonly string[];
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
}

const uuidSchema: JsonSchema = Object.freeze({
  type: "string",
  minLength: 36,
  maxLength: 36,
});

const imageSchema: JsonSchema = Object.freeze({
  type: "object",
  properties: Object.freeze({
    type: Object.freeze({ type: "string", enum: ["image"] }),
    data: Object.freeze({ type: "string", minLength: 1, maxLength: 32 * 1024 }),
    mimeType: Object.freeze({ type: "string", minLength: 7, maxLength: 128 }),
  }),
  required: Object.freeze(["type", "data", "mimeType"]),
  additionalProperties: false,
});

const schemas: Readonly<Record<AgentToolName, JsonSchema>> = Object.freeze({
  get_agent_templates: Object.freeze({
    type: "object",
    properties: Object.freeze({}),
    additionalProperties: false,
  }),
  spawn_agent: Object.freeze({
    type: "object",
    properties: Object.freeze({
      template_id: Object.freeze({
        type: "string",
        description: "先调用 get_agent_templates，再原样复制其当前返回项的 template_id，两者必须完全一致；区分大小写，不得猜测、改写或使用 description 代替。",
        minLength: 1,
        maxLength: 256,
      }),
      name: Object.freeze({ type: "string", minLength: 1, maxLength: 256 }),
    }),
    required: Object.freeze(["template_id", "name"]),
    additionalProperties: false,
  }),
  send_message: Object.freeze({
    type: "object",
    properties: Object.freeze({
      agent_id: uuidSchema,
      message: Object.freeze({ type: "string", minLength: 1, maxLength: 16 * 1024 }),
      images: Object.freeze({ type: "array", items: imageSchema }),
    }),
    required: Object.freeze(["agent_id", "message"]),
    additionalProperties: false,
  }),
  wait_agent: Object.freeze({
    type: "object",
    properties: Object.freeze({
      agent_id: uuidSchema,
      timeout_ms: Object.freeze({ type: "integer", minimum: 10_000, maximum: 600_000 }),
    }),
    required: Object.freeze(["agent_id"]),
    additionalProperties: false,
  }),
  interrupt_agent: Object.freeze({
    type: "object",
    properties: Object.freeze({ agent_id: uuidSchema }),
    required: Object.freeze(["agent_id"]),
    additionalProperties: false,
  }),
  terminate_agent: Object.freeze({
    type: "object",
    properties: Object.freeze({ agent_id: uuidSchema }),
    required: Object.freeze(["agent_id"]),
    additionalProperties: false,
  }),
  get_agent_status: Object.freeze({
    type: "object",
    properties: Object.freeze({ agent_id: uuidSchema }),
    required: Object.freeze(["agent_id"]),
    additionalProperties: false,
  }),
  get_agent_tree: Object.freeze({
    type: "object",
    properties: Object.freeze({}),
    additionalProperties: false,
  }),
});

const descriptions: Readonly<Record<AgentToolName, string>> = Object.freeze({
  get_agent_templates: "列出当前发现且格式有效的子代理模板，直接返回 JSON 数组。每项包含 template_id、可选 description 和模板声明的子代理初始业务 tools；tools 不要求向父会话当前活动工具向下缩减。返回 [] 表示当前没有有效模板，此时不能调用 spawn_agent。非空模板仍须通过 spawn_agent 的模板格式、工具注册、模型、thinking 和管理能力预检。",
  spawn_agent: "使用有效模板创建一个直接子代理并等待它完成启动握手。调用前先调用 get_agent_templates；template_id 必须从当前返回数组中原样复制、区分大小写，不得猜测、裁剪、改写或用 description 代替。模板 tools 是子代理的初始业务工具请求，不要求是父会话活动工具的子集。若 get_agent_templates 返回 []，则不能调用 spawn_agent。创建成功后使用 send_message 发送首项任务。",
  send_message: "向直接子代理发送任务消息或当前处理的 steering。返回 accepted: true 只表示消息已被接受，不表示任务完成；若返回 message_delivery_failed，交付状态可能无法确认，不要盲目重发。",
  wait_agent: "等待直接子代理发来工作中回复、完全 settled 或进入终态。收到 outcome: reply 时子代理会继续处理；outcome: timeout 只结束本次等待，不改变节点生命周期。",
  interrupt_agent: "协作式中断直接子代理当前处理，保留节点和上下文；调用成功后仍需使用 wait_agent 确认处理真正结束。",
  terminate_agent: "永久终止直接子代理及其已登记子树并确认资源回收；只有确定不再复用该分支时使用。",
  get_agent_status: "读取直接子代理最近确认的安全状态快照。",
  get_agent_tree: "读取当前调用者作用域内的安全代理树快照。",
});

export const PARENT_COORDINATION_GUIDELINES = Object.freeze({
  sendMessage: "send_message 返回 accepted: true 后，该任务继续由目标直接子代理负责。直接父会话使用 wait_agent 等待，或只处理明确拆分、无数据依赖且无共享写资源的工作；在子代理给出最终答复或进入终态前，不在父会话实施或再次委派同一任务。若返回 message_delivery_failed，交付状态可能无法确认，不要盲目重发，先查询状态并结合已有回复判断。",
  waitAgent: "wait_agent 返回 outcome: reply 时，子代理仍在处理；直接父会话继续等待或使用 send_message 引导同一子代理。wait_agent 返回 outcome: timeout 只结束本次等待，不改变子代理生命周期，也不把任务交回直接父会话。",
  interruptAgent: "直接父会话需要接管已下发任务时，先使用 interrupt_agent，再使用 wait_agent 确认子代理已结束当前处理；确认后再实施相同任务或修改相同资源。",
});

const promptGuidelines: Readonly<Partial<Record<AgentToolName, readonly string[]>>> = Object.freeze({
  send_message: Object.freeze([PARENT_COORDINATION_GUIDELINES.sendMessage]),
  wait_agent: Object.freeze([PARENT_COORDINATION_GUIDELINES.waitAgent]),
  interrupt_agent: Object.freeze([PARENT_COORDINATION_GUIDELINES.interruptAgent]),
});

const childReplySchema: JsonSchema = Object.freeze({
  type: "object",
  properties: Object.freeze({
    message: Object.freeze({
      type: "string",
      description: "发给创建你的直接父会话的工作中回复正文。",
      minLength: 1,
      maxLength: 16 * 1024,
    }),
  }),
  required: Object.freeze(["message"]),
  additionalProperties: false,
});

const childReplyDescription =
  "向创建你的直接父会话发送一条工作中的回复，可用于汇报进度、提出问题或发送阶段性发现。无需提供 agent_id 或目标；调用成功后不会结束当前处理，请继续原任务。最终结果由运行时在完全 settled 后自动发送，不要使用本工具模拟最终完成。";

/** 返回给 Pi 的固定工具结果；details 只包含控制器安全数据。 */
function toolResult<T>(result: ControlResult<T>, dataOnly = false): unknown {
  if (!result.ok) throw new SubagentToolError(result.error);
  return {
    content: [{ type: "text", text: JSON.stringify(dataOnly ? result.data : result) }],
    details: result.data,
  };
}

async function controllerFor(
  provider: AgentToolControllerProvider,
  context: unknown,
): Promise<AgentController> {
  const controller = await provider(context);
  if (controller === undefined || controller === null) throw new SubagentToolError({
    code: "agent_unavailable",
    message: "代理控制器不可用",
    retryable: false,
  });
  return controller;
}

function executeTool(
  name: AgentToolName,
  provider: AgentToolControllerProvider,
  execute: (controller: AgentController, params: unknown) => Promise<ControlResult<unknown>>,
  dataOnly = false,
  lookups: AgentToolRenderLookups = {},
): Record<string, unknown> {
  const guidelines = promptGuidelines[name];
  return {
    name,
    label: name,
    description: descriptions[name],
    ...(guidelines === undefined ? {} : { promptGuidelines: guidelines }),
    parameters: schemas[name],
    executionMode: "sequential",
    renderCall: (
      params: unknown,
      theme: AgentToolRenderTheme,
      context: AgentToolRenderContext,
    ) => renderAgentToolCall(name, params, theme, context, lookups),
    renderResult: (
      result: AgentToolResultView,
      options: AgentToolResultRenderOptions,
      theme: AgentToolRenderTheme,
      context: AgentToolRenderContext,
    ) => renderAgentToolResult(name, result, options, theme, context, lookups),
    execute: async (
      _toolCallId: string,
      params: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      context: unknown,
    ) => toolResult(await execute(await controllerFor(provider, context), params), dataOnly),
  };
}

export interface AgentToolRegistrationOptions extends AgentToolRenderLookups {}

/** 注册完整、不可拆分的八工具集合；返回已注册名称供宿主测试和诊断使用。 */
export function registerAgentTools(
  api: AgentToolRegistrationApi,
  provider: AgentToolControllerProvider,
  lookups: AgentToolRegistrationOptions = {},
): readonly AgentToolName[] {
  if (typeof api.registerTool !== "function") throw new TypeError("宿主缺少 registerTool");
  const tools: readonly Record<string, unknown>[] = [
    executeTool("get_agent_templates", provider, async (controller, params) => {
      if (!isEmptyObject(params)) return controlFailure("invalid_argument");
      return controller.getAgentTemplates();
    }, true, lookups),
    executeTool("spawn_agent", provider, async (controller, params) => controller.spawnAgent(params), false, lookups),
    executeTool("send_message", provider, async (controller, params) => controller.sendMessage(params), false, lookups),
    executeTool("wait_agent", provider, async (controller, params) => controller.waitAgent(params), false, lookups),
    executeTool("interrupt_agent", provider, async (controller, params) => {
      const agentId = readAgentId(params);
      return controller.interruptAgent(agentId);
    }, false, lookups),
    executeTool("terminate_agent", provider, async (controller, params) => {
      const agentId = readAgentId(params);
      return controller.terminateAgent(agentId);
    }, false, lookups),
    executeTool("get_agent_status", provider, async (controller, params) => {
      const agentId = readAgentId(params);
      return Promise.resolve(controller.getAgentStatus(agentId));
    }, false, lookups),
    executeTool("get_agent_tree", provider, async (controller, params) => {
      if (!isEmptyObject(params)) return controlFailure("invalid_argument");
      return Promise.resolve(controller.getAgentTree());
    }, false, lookups),
  ];
  for (const tool of tools) api.registerTool(tool);
  return AGENT_TOOL_NAMES;
}

export type ChildReplyCoordinatorProvider = (
  context: unknown,
) => ChildReplyCoordinator | undefined | Promise<ChildReplyCoordinator | undefined>;

/** 只在 child runtime 注册；工具始终独立于八个管理工具的能力开关。 */
export function registerReplyToParentTool(
  api: AgentToolRegistrationApi,
  provider: ChildReplyCoordinatorProvider,
): void {
  if (typeof api.registerTool !== "function") throw new TypeError("宿主缺少 registerTool");
  api.registerTool({
    name: CHILD_REPLY_TOOL_NAME,
    label: CHILD_REPLY_TOOL_NAME,
    description: childReplyDescription,
    parameters: childReplySchema,
    executionMode: "sequential",
    renderCall: (
      params: unknown,
      theme: AgentToolRenderTheme,
      context: AgentToolRenderContext,
    ) => renderAgentToolCall(CHILD_REPLY_TOOL_NAME, params, theme, context),
    renderResult: (
      result: AgentToolResultView,
      options: AgentToolResultRenderOptions,
      theme: AgentToolRenderTheme,
      context: AgentToolRenderContext,
    ) => renderAgentToolResult(CHILD_REPLY_TOOL_NAME, result, options, theme, context),
    execute: async (
      _toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      context: unknown,
    ) => {
      const coordinator = await provider(context);
      if (coordinator === undefined) {
        throw new SubagentToolError({
          code: "agent_unavailable",
          message: "直接父会话不可用",
          retryable: false,
        });
      }
      return toolResult(await coordinator.replyToParent(params, signal));
    },
  });
}

function readAgentId(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>).agent_id;
}

function isEmptyObject(value: unknown): value is Readonly<Record<string, never>> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
}
