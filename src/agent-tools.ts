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
export const CHILD_FINAL_REPORT_TOOL_NAME = "final_report" as const;

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
  send_message: "Send a message or steering to a direct child subagent. accepted: true means only that the receiving Pi accepted this message; it does not mean the model read it, started work, or completed processing. A delivery failure affects only this call and does not change lifecycle state.",
  wait_agent: "Wait for the next independent reply, final_report, idle, or terminal event from one or more direct child subagents. The result includes independent lifecycle state and revision, never task results or report text. batch_released is only a tool-call wrapper; timeout ends only this wait.",
  interrupt_agent: "Cooperatively interrupt the active Pi turn of a direct child subagent while preserving its node and context.",
  terminate_agent: "Permanently terminate a direct child subagent and its registered subtree, then confirm resource reclamation. Use only when you are sure the branch will not be reused.",
  get_agent_status: "Read the most recently confirmed safe status snapshot for a direct child subagent.",
  get_agent_tree: "Read the read-only agent tree visible to the current caller.",
});

const DELIVERY_AND_WAITING_GUIDELINE =
  "交付与等待：消息被接纳不等于模型已读或工作完成；交付不确定时先核对状态和已有事件，不要盲目重发。wait_agent 等待目标子代理的下一条独立 reply、final_report、idle 或 terminal 事件。";
const TAKEOVER_GUIDELINE =
  "需要接管时，先 interrupt_agent，再 wait_agent 确认子代理已结束。";

export const PARENT_COORDINATION_GUIDELINES = Object.freeze({
  sessionOwnership: "工作边界：send_message 返回 accepted: true，只表示接收侧 Pi 已接纳这条消息；目标子代理继续负责当前工作范围，但这不代表模型已经读取、开始处理或完成。父会话不得重复调查或代做同一范围（包括读取、搜索、扫描、分析、实现、测试和评审），只能等待、查询状态、发送新的 steering，或处理事先明确拆分且无数据依赖、无共享写资源的独立工作。需要接管时，先 interrupt_agent，再 wait_agent 确认子代理已结束。",
  sendMessage: "交付与等待：消息被接纳不等于模型已读或工作完成；交付不确定时先核对状态和已有事件，不要盲目重发。wait_agent 等待目标子代理的下一条独立 reply、final_report、idle 或 terminal 事件。",
  sendMessageReply: "中途回复：只有在本次 send_message 明确要求子代理在当前工作完成前返回进度、回答问题或报告阻塞时，才在消息正文中要求其使用 reply_to_parent。需要父代理看到阶段性成果、明确交付物或需要单独记录的报告时，要求其调用 final_report。首次下发消息、追加要求、异常恢复指令，以及只需等待结果的消息，不要额外要求中途回复。",
  waitAgent: DELIVERY_AND_WAITING_GUIDELINE,
  slowProgress: "慢进展：working 或 timeout 不代表失败。不要仅因耗时就要求子代理停止探索、提前报告或调用 interrupt_agent、terminate_agent；需要了解情况时，可以用 send_message 询问进度，再继续 wait_agent。",
  sessionRecovery: "异常恢复：message_delivery_failed、reply_too_large 或等待超时只影响本次操作，不自动解释为子代理故障。先使用 get_agent_status 核对 state 和已有事件，再由模型决定是否发送一条新的独立消息。",
  retryPolicy: "重试：消息调用不会自动重试、暗存或重放正文。只有在确认失败原因、且明确知道重复发送不会造成副作用后，才由模型显式发起新的调用；不要因为结果不确定而盲目重复发送。",
  agentCleanup: "子代理回收：interrupt_agent 只建立 interrupting 屏障，必须等真实 idle 或后续控制结果；释放节点和子树资源必须调用 terminate_agent 并等待 terminated。是否发送 final_report 不决定回收时机。",
  capacityCleanup: "容量回收：spawn_agent 返回 max_children_reached 或 max_tree_agents_reached 时，检查现有子代理，优先使用 terminate_agent 回收已完成且暂不使用或已不可恢复的节点；确认名额释放后再重试创建。",
  replyTooLarge: "若收到 reply_too_large，说明本次消息过长而未被 Pi 接纳，不代表代理故障；精炼后由模型显式重新发送，不要终止、替换或自动重跑原工作。",
  interruptAgent: TAKEOVER_GUIDELINE,
});

const childReplySchema: JsonSchema = Object.freeze({
  type: "object",
  properties: Object.freeze({
    message: Object.freeze({
      type: "string",
      description: "Work-in-progress reply body.",
      minLength: 1,
    }),
  }),
  required: Object.freeze(["message"]),
  additionalProperties: false,
});

const childFinalReportSchema: JsonSchema = childReplySchema;

export const CHILD_REPLY_GUIDELINE =
  "仅在直接父代理明确要求你回报进度、回答问题，或遇到必须由父代理处理或裁决的阻塞时调用 reply_to_parent。它表示一条独立的父端可见消息，不结束当前 Pi 回合、当前工作或生命周期。";

export const CHILD_REPLY_TOO_LARGE_GUIDELINE =
  "若 reply_to_parent 或 final_report 返回 reply_too_large，说明本次消息过长而未被父端 Pi 接纳，不影响当前工作；请精炼后由模型显式重新调用，不要原样重试。";

const childReplyDescription =
  "Call reply_to_parent only when your direct parent explicitly asks for a progress report or when blocked on an issue that the parent must handle or decide.";

const childFinalReportDescription =
  "Send an explicit report to the direct parent. A successful call only means the parent Pi accepted this message; it does not end the current turn or session, and it may be called multiple times.";

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
      return controller.synchronizeAgentStatus(agentId);
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
  api.registerTool({
    name: CHILD_FINAL_REPORT_TOOL_NAME,
    label: CHILD_FINAL_REPORT_TOOL_NAME,
    description: childFinalReportDescription,
    parameters: childFinalReportSchema,
    executionMode: "sequential",
    renderCall: (
      params: unknown,
      theme: AgentToolRenderTheme,
      context: AgentToolRenderContext,
    ) => renderAgentToolCall(CHILD_FINAL_REPORT_TOOL_NAME, params, theme, context),
    renderResult: (
      result: AgentToolResultView,
      options: AgentToolResultRenderOptions,
      theme: AgentToolRenderTheme,
      context: AgentToolRenderContext,
    ) => renderAgentToolResult(CHILD_FINAL_REPORT_TOOL_NAME, result, options, theme, context),
    execute: async (
      _toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      context: unknown,
    ) => {
      const coordinator = await provider(context);
      if (coordinator === undefined) throw new SubagentToolError(controlFailure("agent_unavailable").error);
      return toolResult(await coordinator.finalReport(params, signal));
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
