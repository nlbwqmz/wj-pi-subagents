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

export const PARENT_COORDINATION_GUIDELINES = Object.freeze({
  roleScope: "角色范围：本段只约束你对直接子代理的管理。若当前会话同时是子代理，向直接父代理报告时另遵守“子代理任务与回复/显式报告要求”。",
  workBoundary: "工作边界（特别注意）：子代理处于 working 且尚未交付时，不要并行重复执行同一未交付范围。可以发送任务或 steering、等待事件、查看状态，或处理已明确拆分且无数据依赖、无共享写资源的独立工作。收到明确交付后，可以读取产物并进行必要的整合、验证和测试；若仅确认 idle、failed、terminal 或中断结束，可以接管未完成工作，但不得把 idle 当作任务完成。",
  delivery: "创建与交付：创建子代理后使用 send_message 发送首个任务。send_message 返回 accepted: true 只表示接收侧已接纳消息，不表示模型已读取、开始处理或完成；",
  waiting: "等待与状态：wait_agent 等待目标直接子代理的下一条未消费 reply、final_report、idle 或 terminal 事件，返回生命周期状态和修订信息，不返回报告正文。get_agent_status 只提供最近确认的状态快照，不是事件历史。idle 不等于任务完成；terminal 必须结合 state 和 error 判断。",
  timeout: "超时：一次 wait_agent 超时不表示子代理失败。可以继续等待，或在确有必要时询问一次进度；不要仅因一次超时就 interrupt_agent 或 terminate_agent。",
  failure: "失败处理：reply_too_large 表示原消息未被接纳，精简后显式重发，不要原样重试。compaction_active 时不要在当前回合重放消息；待屏障解除后确认任务仍需要，再显式发送。",
  takeover: "接管与回收：需要接管 working 子代理时先调用 interrupt_agent。仅当结果为 interrupting 时，才用 wait_agent 等待 idle 或 terminal；若已返回终态，直接继续判断。terminate_agent 成功返回 terminated 即表示资源已回收。不要仅因 idle 就回收；只在已确认交付、明确放弃、不可恢复故障，或确有容量需要且分支不再使用时调用 terminate_agent。确认回收后再重试创建。",
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
  "上行路由：reply_to_parent 仅用于直接父代理明确要求的进度或问题回答，或需要父代理立即处理、裁决的阻塞；内容应简短并说明当前状态、问题和所需决定。final_report 用于父代理需要单独消费的阶段性或最终交付物、结论、风险或正式阻塞报告。完成委派任务时默认调用一次 final_report；父代理明确不需要报告时除外。没有新增信息时不要重复调用，也不要因同一内容同时调用两个工具。";

export const CHILD_REPLY_TOO_LARGE_GUIDELINE =
  "失败处理：reply_too_large 表示消息未被接纳，精简后显式重发，不要原样重试。compaction_active 时不要在当前回合重放消息；待屏障解除后，在可执行回合确认仍需要再调用。";

export const CHILD_MESSAGE_GUIDELINE =
  "消息语义：reply_to_parent 和 final_report 都是独立的父端可见消息，不结束当前 Pi 回合、当前工作或生命周期。任一工具返回 accepted: true 只表示父端 Pi 已接纳消息，不表示父代理模型已读取、处理或完成。";

export const CHILD_NORMAL_REPLY_GUIDELINE =
  "普通答复：普通 assistant 文本、message_end、agent_end、agent_settled、自然停止或压缩完成不会自动生成父端消息。需要父代理看到内容时，必须显式调用相应工具。";

export const CHILD_COMPLETION_GUIDELINE =
  "任务结束：需要 final_report 时先发送精炼报告，再输出非空且简短的正常 assistant 答复，说明完成内容和产物位置。不要在两个通道重复全文。";

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
