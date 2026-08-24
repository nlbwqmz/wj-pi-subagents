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
  workBoundary: "任务所有权：每个任务只能有一个负责人。委派前明确任务范围、排除范围、验收标准和产物。子代理明确交付、取消或确认失败前，父代理及其他子代理不得执行、探索或重新实现相同范围，只能处理无范围和写入冲突的独立工作。",
  delivery: "任务委派：创建子代理后必须使用 send_message 发送首个任务。send_message 返回 accepted: true 后，任务即视为已委派；该结果只表示消息已被接纳，不表示子代理已读取、开始或完成，不得因此重复发送相同任务。后续消息只能用于补充信息、范围变更、明确取消或必要的进度询问，不得重复原任务。",
  waiting: "等待规则：wait_agent 的 timeout 只表示本次等待结束，不表示任务失败、完成或需要接管。执行较慢、没有回复、重复超时、处于 working，或处于 idle 但没有最终报告，都不是中断或接管理由。默认继续等待或查询状态，不得要求子代理提前收尾。",
  timeout: "超时处理：wait_agent 超时后不得重发任务、重新执行任务或调用 interrupt_agent。确需了解进度时，只发送一次简短的进度询问。",
  failure: "错误处理：send_message 失败只影响本次发送，不得盲目重试。reply_too_large 需精简后重发；compaction_active 需等待屏障解除后确认是否仍需发送。accepted: true 的消息不得再次发送。",
  completion: "完成判断：reply_to_parent 只表示进度、问题或阻塞；final_report 表示阶段性或最终交付，但不会自动结束子代理。idle、terminal、failed 也不自动表示任务完成，必须结合报告、产物、state 和 error 判断。",
  messaging: "发送消息时的提示（特别注意）：按 send_message 目的添加提示：\n- 需要子代理在任务过程中进行回复时，提示子代理使用 reply_to_parent 进行回复。\n- 需要子代理完成任务并需要任务结果时，提示子代理使用 final_report 提交报告。",
  reclaim: "回收规则：子代理已完成当前任务且后续不再需要时，应调用 terminate_agent 释放资源。若 spawn_agent 返回 max_children_reached 或 max_tree_agents_reached，应优先清理已完成当前任务的子代理以释放资源，再重试 spawn_agent。不得清理正在执行任务的子代理。",
  takeover: "接管规则：只有用户或上游任务明确要求取消或改目标、子代理明确请求接管、已确认不可恢复故障，或存在必须停止的资源、安全或协议问题时，才允许接管。working 状态下必须先调用 interrupt_agent；只有返回 interrupting 后，才可等待 idle 或 terminal。terminate_agent 仅用于确认不再复用的分支。",
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

export const CHILD_EXECUTION_GUIDELINE =
  "任务执行：只向直接父代理报告。按照父代理给出的范围和验收标准执行，不得因父代理暂时没有回复或任务耗时较长而提前结束。";

export const CHILD_REPLY_GUIDELINE =
  "中途回复：父代理明确要求进度，或遇到需要父代理处理、裁决的阻塞时，调用 reply_to_parent，简要说明当前状态、已完成内容、问题和所需决定。";

export const CHILD_REPLY_TOO_LARGE_GUIDELINE =
  "回传失败：reply_too_large 表示当前消息未被接纳。精简后使用原工具重发，禁止原样重试；成功返回 accepted: true 前，不得视为已送达。compaction_active 表示当前消息未被接纳；不要在压缩或协调屏障期间重发，屏障解除后确认消息仍有必要，再使用原工具发送。";

export const CHILD_MESSAGE_GUIDELINE =
  "工具语义：reply_to_parent 和 final_report 都不会自动结束当前工作或生命周期。普通 assistant 文本不会自动通知父代理；accepted: true 只表示父端已接纳消息，不表示父代理已读取、处理或任务已完成。";

export const CHILD_NORMAL_REPLY_GUIDELINE =
  "普通答复：普通 assistant 文本、message_end、agent_end、agent_settled、自然停止或压缩完成不会自动生成父端消息。需要父代理看到进度、问题或结果时，必须显式调用对应工具。";

export const CHILD_COMPLETION_GUIDELINE =
  "阶段性和最终结果：形成阶段性成果、最终结果或正式阻塞报告时，调用 final_report。报告应包含结论、产物位置、验证结果和遗留问题。任务完成时默认调用一次 final_report，除非父代理明确表示不需要。没有新增信息时不得重复调用回传工具，同一内容不得同时调用 reply_to_parent 和 final_report。";

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
