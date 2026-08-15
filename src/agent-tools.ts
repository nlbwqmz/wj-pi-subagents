import type { AgentController } from "./agent-controller.ts";
import { WAIT_AGENT_MAX_TARGETS } from "./agent-controller.ts";
import type { ChildReplyCoordinator } from "./child-reply-coordinator.ts";
import {
  ParentWaitBatchCoordinator,
  type WaitAgentToolResult,
} from "./parent-wait-batch-coordinator.ts";
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
  readonly minItems?: number;
  readonly maxItems?: number;
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
    }),
    required: Object.freeze(["agent_id", "message"]),
    additionalProperties: false,
  }),
  wait_agent: Object.freeze({
    type: "object",
    properties: Object.freeze({
      agent_ids: Object.freeze({
        type: "array",
        description: "要观察的直接子代理 UUID；一次调用传入全部目标，重复项会被忽略。",
        items: uuidSchema,
        minItems: 1,
        maxItems: WAIT_AGENT_MAX_TARGETS,
      }),
      timeout_ms: Object.freeze({ type: "integer", minimum: 10_000, maximum: 600_000 }),
    }),
    required: Object.freeze(["agent_ids"]),
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
  get_agent_templates: "列出当前发现且格式有效的子代理模板，返回 JSON 数组；每项包含 template_id、可选 description 和模板声明的业务 tools。返回 [] 时不能调用 spawn_agent。",
  spawn_agent: "使用有效 template_id 创建一个直接子代理并完成启动握手。必须先调用 get_agent_templates；template_id 必须原样复制、区分大小写，不能猜测、改写或用 description 替代。若 get_agent_templates 返回 []，则不能调用 spawn_agent。创建成功后再用 send_message 发送首项任务。",
  send_message: "向直接子代理发送任务消息或 steering。accepted: true 只表示 mailbox 已接纳并分配 message_id/task_id，不表示模型已读取或任务完成；若返回 message_delivery_failed，先查询状态并结合已有回复核对，不要盲目重发。",
  wait_agent: "等待一个或多个直接子代理的工作中回复、任务提交、suspended 或终态。一次调用传入本批次全部 agent_ids，不要为同一批次分别调用；outcome: reply 表示仍在处理，task_completed/task_failed/task_interrupted 表示最近任务已提交，suspended 需要查询并裁决，batch_released 表示被同批次其他 wait_agent 协同解除，timeout 只结束本次等待。",
  interrupt_agent: "协作式中断直接子代理当前任务并保留上下文。",
  terminate_agent: "永久终止直接子代理及其已登记子树，并确认资源回收；仅在确定不再复用该分支时使用。",
  get_agent_status: "读取直接子代理最近确认的安全状态快照。",
  get_agent_tree: "读取当前调用者作用域内的只读代理树快照。",
});

const DELIVERY_AND_WAITING_GUIDELINE =
  "交付与等待：消息被接纳不等于模型已读或任务完成；交付不确定时先核对状态和已有回复，不要盲目重发。一次 wait_agent 等待本批次全部目标。";
const TAKEOVER_GUIDELINE =
  "需要接管时，先 interrupt_agent，再 wait_agent 确认子代理已结束。";

export const PARENT_COORDINATION_GUIDELINES = Object.freeze({
  taskOwnership: "任务所有权：send_message 返回 accepted: true 后，该任务由目标直接子代理负责，直到其提交最终答复或进入终态。父会话不得重复调查、实现、测试、验证、评审或再次委派同一任务；只能等待、查询状态、向该子代理发送 steering，或处理事先明确拆分且无数据依赖、无共享写资源的独立工作。需要接管时，先 interrupt_agent，再 wait_agent 确认子代理已结束。",
  sendMessage: DELIVERY_AND_WAITING_GUIDELINE,
  waitAgent: DELIVERY_AND_WAITING_GUIDELINE,
  slowProgress: "慢任务：working/processing 或 timeout 不代表失败。不要仅因耗时而要求子代理提前总结、调用 interrupt_agent 或 terminate_agent；可以用 send_message 询问进度，然后继续 wait_agent。",
  taskRecovery: "异常恢复：task_failed、task_interrupted，或最终答复缺失、不可用时，先用 get_agent_status 核对，再向同一 agent_id 发送恢复指令。复用已有上下文，从未完成步骤继续，避免重复已完成的副作用，并要求其提交完整最终答复。",
  retryPolicy: "重试：除 spawn_failed 和 internal_error 外，其他异常均可重试，包括 message_delivery_failed 和 suspended。重试前先核对并修正原因；默认重试 3 次，若每次仍有进展、状态变化或错误变化，最多扩展到 5 次，每次尝试后都使用 wait_agent。节点终止、用户取消或达到上限时停止，并报告原因；不要自动切换模型或创建替代代理。",
  interruptAgent: TAKEOVER_GUIDELINE,
});

const childReplySchema: JsonSchema = Object.freeze({
  type: "object",
  properties: Object.freeze({
    message: Object.freeze({
      type: "string",
      description: "工作中回复正文。",
      minLength: 1,
      maxLength: 16 * 1024,
    }),
  }),
  required: Object.freeze(["message"]),
  additionalProperties: false,
});

export const CHILD_REPLY_GUIDELINE =
  "仅在直接父代理明确要求你回报，或遇到必须由父代理处理或裁决的阻塞时调用 reply_to_parent。不要将其用于完成通知或替代最终答复。消息被接纳后继续当前任务，任务完成时仍须提交正常的最终答复。";

const childReplyDescription =
  "仅在直接父代理明确要求你回报，或遇到必须由父代理处理或裁决的阻塞时调用 reply_to_parent。";

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
  execute: (
    controller: AgentController,
    params: unknown,
    call: {
      readonly toolCallId: string;
      readonly signal: AbortSignal | undefined;
      readonly context: unknown;
    },
  ) => Promise<ControlResult<unknown>>,
  dataOnly = false,
  lookups: AgentToolRenderLookups = {},
): Record<string, unknown> {
  return {
    name,
    label: name,
    description: descriptions[name],
    parameters: schemas[name],
    executionMode: name === "wait_agent" ? "parallel" : "sequential",
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
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      context: unknown,
    ) => toolResult(await execute(await controllerFor(provider, context), params, {
      toolCallId,
      signal,
      context,
    }), dataOnly),
  };
}

export interface AgentToolRegistrationOptions extends AgentToolRenderLookups {
  readonly waitBatchCoordinator?: ParentWaitBatchCoordinator;
}

/** 注册完整、不可拆分的八工具集合；返回已注册名称供宿主测试和诊断使用。 */
export function registerAgentTools(
  api: AgentToolRegistrationApi,
  provider: AgentToolControllerProvider,
  lookups: AgentToolRegistrationOptions = {},
): readonly AgentToolName[] {
  if (typeof api.registerTool !== "function") throw new TypeError("宿主缺少 registerTool");
  const waitBatchCoordinator = lookups.waitBatchCoordinator ?? new ParentWaitBatchCoordinator();
  const tools: readonly Record<string, unknown>[] = [
    executeTool("get_agent_templates", provider, async (controller, params) => {
      if (!isEmptyObject(params)) return controlFailure("invalid_argument");
      return controller.getAgentTemplates();
    }, true, lookups),
    executeTool("spawn_agent", provider, async (controller, params) => controller.spawnAgent(params), false, lookups),
    executeTool("send_message", provider, async (controller, params) => controller.sendMessage(params), false, lookups),
    executeTool("wait_agent", provider, async (controller, params, call): Promise<WaitAgentToolResult> =>
      waitBatchCoordinator.wait(controller, call.toolCallId, params, call.signal, call.context), false, lookups),
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
