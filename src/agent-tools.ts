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
import {
  PUBLIC_ERROR_CODES,
  controlFailure,
  type ControlResult,
  type PublicErrorCode,
} from "./tree-controller.ts";

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
    // 工具边界只信任 code；message、retryable 和 details 始终重新生成。
    const code = (PUBLIC_ERROR_CODES as readonly string[]).includes(error.code)
      ? error.code
      : "internal_error";
    const canonical = controlFailure(
      code as PublicErrorCode,
    ).error;
    super(JSON.stringify({
      ok: false,
      error: canonical,
    }));
    this.name = "SubagentToolError";
    this.code = canonical.code;
    this.retryable = canonical.retryable;
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
        description: "Call get_agent_templates first and copy its current template_id exactly. It is case-sensitive; do not guess, rewrite, or substitute description.",
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
        description: "Direct child subagent UUIDs to observe. Pass all targets in one call; duplicates are ignored.",
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
  get_agent_templates: "List currently discovered and valid subagent templates as a JSON array. Each item includes template_id, optional description, and declared business tools. Do not call spawn_agent when the result is [].",
  spawn_agent: "Create a direct child subagent with a valid template_id and complete the startup handshake. Call get_agent_templates first; copy template_id exactly and preserve case. Do not guess, rewrite, or substitute description. Do not call spawn_agent when get_agent_templates returns []. After creation, use send_message to send the first task.",
  send_message: "Send a task message or steering to a direct child subagent. accepted: true means only that the mailbox accepted the message and assigned message_id/task_id; it does not mean the model read it or the task completed. If message_delivery_failed is returned, check status and existing replies before deciding; do not blindly resend.",
  wait_agent: "Wait for a work-in-progress reply, task submission, suspended state, or terminal state from one or more direct child subagents. Pass all targets in this batch in one agent_ids call; do not call this separately for the same batch. outcome: reply means still processing; task_completed/task_failed/task_interrupted mean the latest task was submitted; suspended requires status inspection and a decision; batch_released means another wait_agent in the same batch released this call; timeout ends only this wait.",
  interrupt_agent: "Cooperatively interrupt the current task of a direct child subagent while preserving its node and context.",
  terminate_agent: "Permanently terminate a direct child subagent and its registered subtree, then confirm resource reclamation. Use only when you are sure the branch will not be reused.",
  get_agent_status: "Read the most recently confirmed safe status snapshot for a direct child subagent.",
  get_agent_tree: "Read the read-only agent tree visible to the current caller.",
});

const DELIVERY_AND_WAITING_GUIDELINE =
  "交付与等待：消息被接纳不等于模型已读或任务完成；交付不确定时先核对状态和已有回复，不要盲目重发。一次 wait_agent 等待本批次全部目标。";
const TAKEOVER_GUIDELINE =
  "需要接管时，先 interrupt_agent，再 wait_agent 确认子代理已结束。";

export const PARENT_COORDINATION_GUIDELINES = Object.freeze({
  taskOwnership: "任务所有权：send_message 返回 accepted: true 后，该任务由目标直接子代理负责，直到其提交最终答复或进入终态。父会话不得重复调查、实现、测试、验证、评审或再次委派同一任务；只能等待、查询状态、向该子代理发送 steering，或处理事先明确拆分且无数据依赖、无共享写资源的独立工作。需要接管时，先 interrupt_agent，再 wait_agent 确认子代理已结束。",
  sendMessage: DELIVERY_AND_WAITING_GUIDELINE,
  sendMessageReply: "中途回复（特别注意）：仅当本次 send_message 明确要求子代理在当前任务完成前返回一次信息，并在回复后继续当前任务时，才在消息正文中要求其使用 reply_to_parent 进行回复。典型场景包括询问当前进度、索取阶段性结果，或要求先回答执行中的问题再继续。首次下发任务、任务完成后下发新任务、只追加或修正任务要求且无需中途回应、异常恢复指令，以及任何只需等待最终答复的消息，均按普通任务消息发送，不添加 reply_to_parent 提示。判断依据是“是否需要任务完成前的中途回复”，不是目标子代理是否处于 working/processing 状态。",
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
      description: "Work-in-progress reply body.",
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
  "Call reply_to_parent only when your direct parent explicitly asks for a progress report or when blocked on an issue that the parent must handle or decide.";

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
  if (controller === undefined || controller === null) {
    throw new SubagentToolError(controlFailure("agent_unavailable").error);
  }
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
        throw new SubagentToolError(controlFailure("agent_unavailable").error);
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
