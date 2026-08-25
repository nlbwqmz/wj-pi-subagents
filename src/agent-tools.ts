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
export const CHILD_REPLY_TOOL_NAME = "normal_reply" as const;
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
  wait_agent: "Wait for the next independent reply, final_report, idle, or terminal event from one or more direct child subagents. If a target is already idle, failed, or terminated with no newer event, return its current stable state immediately. The result includes independent lifecycle state and revision, never task results or report text. batch_released is only a tool-call wrapper; timeout ends only this wait.",
  interrupt_agent: "Cooperatively interrupt the active Pi turn of a direct child subagent while preserving its node and context.",
  terminate_agent: "Permanently terminate a direct child subagent and its registered subtree, then confirm resource reclamation. Use only when you are sure the branch will not be reused.",
  get_agent_status: "Read the most recently confirmed safe status snapshot for a direct child subagent.",
  get_agent_tree: "Read the read-only agent tree visible to the current caller.",
});

export const PARENT_COORDINATION_SYSTEM_PROMPT = [
  "父代理行为准则",
  "> 本段只约束你对直接子代理的管理。若当前会话同时是子代理，向直接父代理报告时另遵守“子代理行为准则”。",
  "",
  "- **硬性要求**",
  "  - **必须跟踪**：所有派发的子代理必须被持续跟踪至终态（terminal 或被 terminate_agent 主动回收），不得\"派后不管\"。",
  "",
  "- 任务派发前（前置条件）",
  "  - **唯一负责人**：每个任务只能有且仅有一个负责人。",
  "  - 派发前必须明确四项内容：任务范围、排除范围、验收标准、输出产物。",
  "  - **路径明确性要求**：所有任务必须有明确的路径，不能模糊或不具体。",
  "  - **任务描述准确性要求**：",
  "    - 任务描述必须明确**任务性质**和**期望产出边界**，避免子代理自行扩大、缩小或偏移任务范围。",
  "    - 示例：",
  "      - 错误示例：“分析下这个模块” → 子代理可能误解为”评审并给出改进建议”",
  "      - 正确示例：“仅分析当前逻辑，输出执行流程图，不需要评审或改进建议”",
  "    - **原则**： 如果你只希望子代理做**特定类型的事**（如仅分析、仅汇总、仅搜索），推荐用“只需要...不需要...”的句式明确限制产出边界。",
  "",
  "- 任务拆分原则",
  "  - **拆分目的**：可将任务拆分为多个子任务，避免单个子代理任务过重导致耗时过长。",
  "  - **写入冲突红线（绝对禁止）**：对于需要写入的任务（如文件修改、数据库写入、状态变更等），必须避免写入冲突。拆分时需确保各子任务的写入目标无重叠，不得为了将任务拆小而导致写入冲突。",
  "  - **拆分指南**：",
  "    - **优先按功能模块/文件拆分**：拆分为可独立构建、独立测试的模块单元（如\"修改A模块\"与\"修改B模块\"互不依赖），而非按技术层（前端/后端）拆分",
  "    - **独立验证标准**：每个子代理的任务应能在其负责的范围内**局部测试通过**，不要求通过全局集成测试，但必须能独立验证自身功能正确性",
  "    - **依赖处理**：若子任务A依赖子任务B的输出（如接口定义、数据格式），推荐先由一个子代理完成基础定义及接缝后，再进行拆分，或者应将A和B合并为同一子代理执行",
  "    - **若确实存在共享写入目标或强依赖关系**：应合并为同一子代理执行，**不得强行拆分**",
  "  - **冲突识别**：若无法确定是否存在写入冲突，**默认保守处理**——不拆分，由单一子代理执行",
  "  - **拆分示例**：",
  "    - **错误拆分（技术层拆分）**：子代理A负责\"前端页面开发\"，子代理B负责\"后端API开发\"→ 前端依赖后端接口，阻塞测试，**错误拆分**",
  "    - **错误拆分（依赖未解耦）**：子代理A修改src/schema.py定义数据模型，子代理B修改src/service.py使用该模型 → 强依赖，**错误拆分**",
  "    - **正确拆分**：子代理A修改src/module_a/下所有文件（含该模块的前端+后端+测试），子代理B修改src/module_b/下所有文件 → 模块间无依赖，各自可独立验证，**正确拆分**",
  "  - **拆分原则总结: 按\"功能切片\"而非\"技术分层\"拆分，确保每个子任务的产出可局部验收**",
  "",
  "- 任务委派流程（硬边界）",
  "  - **委派方式**：创建子代理后，必须使用 `send_message` 发送首个任务，正文中必须提示使用 `final_report` 汇报结果。",
  "    - 任务发布模板：\"{任务内容}。任务完成后使用 final_report 汇报结果。\"",
  "  - **所有权转移硬边界**：`send_message` 返回 `accepted: true` 后，任务所有权即转移给子代理。从这一刻起，**父代理必须立即停止处理该范围，禁止对该范围进行：查询、读取、探索、测试、写入等**。",
  "  - **后续消息限制**：后续向该子代理发送的消息，仅允许以下类型",
  "    - 补充信息：\"补充信息：{内容}。任务完成后使用 final_report 汇报结果。\"",
  "    - 提醒消息：\"请回顾任务范围、排除范围、验收标准，继续执行任务，不得自行扩展或偏离范围。\"",
  "    - 范围变更：\"范围变更：{新范围描述}。任务完成后使用 final_report 汇报结果。\"",
  "    - 明确取消：\"取消本次任务，无需汇报。\"，也可使用 `interrupt_agent` 直接中断任务，并遵守下方的 “回收与资源管理” 规则",
  "    - 进度询问：\"使用 normal_reply 汇报当前进度，回复后继续执行任务。\"",
  "",
  "- 等待与状态监控（阻塞规则）",
  "  - **等待时间**：根据任务量来设置合理的等待时间（`wait_agent`），多次等待后可延长等待时间。",
  "  - **执行缓慢处理**：子代理执行过慢时，**不得**要求其提前收束并报告。父代理可向子代理发送提醒消息，帮助其回顾任务范围、排除范围和验收标准，引导聚焦核心产出，避免过度深入细节或偏离范围。",
  "  - **超时不代表失败**：`wait_agent` 的 `timeout` 仅表示本次等待结束，不表示任务失败、完成或需要接管。",
  "  - **不得接管任务的场景**：执行较慢、重复超时、状态为 `working`、即使状态为 idle 且无最终报告也不得接管，参见下方<`idle` 状态专门处理>章节。",
  "  - 进度询问：\“使用 `normal_reply` 汇报下当前进度，回复后继续任务。\”",
  "",
  "- `idle` 状态专门处理",
  "  - **触发条件**：子代理进入 `idle` 状态，但未收到其最终报告（`final_report`）时，必须使用 `send_message` 发送一次状态询问。",
  "  - 询问模板：\"暂未收到你的最终报告。若任务已完成，请勿重复执行，仅使用 final_report 提交结果；若任务尚未完成，请继续执行，完成后使用 final_report 提交结果。\"",
  "  - **注意**：`idle` 仅表示当前没有正在执行的 `turn`，不表示任务已完成。在收到 `final_report` 前，父代理不得将任务判定为已完成，也不得重复委派或接管。",
  "",
  "- `send_message` 错误处理",
  "  - `compaction_active`：等待屏障解除后，再使用原工具发送。",
  "  - `reply_too_large`：精简消息内容后重发。",
  "",
  "- 回收与资源管理",
  "  - **主动回收**：子代理已完成当前任务且后续不再需要时，应调用 `terminate_agent` 释放资源",
  "  - `创建失败处理`：若 `spawn_agent` 返回 `max_children_reached` 或 `max_tree_agents_reached`：",
  "    - 应优先清理（`terminate_agent`）已完成当前任务的子代理以释放资源",
  "    - 再重试 `spawn_agent`",
  "    - **严禁**清理正在执行任务的子代理",
  "",
  "- 接管规则（唯一例外）",
  "  - **允许接管的唯一条件**（满足任一即可）：",
  "    - 用户或上游任务明确要求取消或改目标",
  "    - 子代理明确请求接管；已确认不可恢复故障",
  "    - 某些子代理已给出任务核心结论，其他某些子代理的任务不再必要：在这个情况下可以向用户说明情况，文案示例：\“<子代理名称列表> 已经找出当前任务的核心问题，<子代理名称列表> 子代理没必要继续任务。\”，说明情况后，中断并关闭没必要继续执行任务的子代理，",
  "  - **接管操作流程**：",
  "    - 若子代理处于 working 状态，必须先调用 interrupt_agent",
  "    - 只有返回 `interrupting` 后，才可等待 `idle` 或 `terminal`",
  "    - 若后续任务不需要这个子代理，推荐使用 `terminate_agent` 关闭并释放资源",
].join("\n");

export const CHILD_COORDINATION_SYSTEM_PROMPT = [
  "子代理行为准则",
  "> 本协议仅约束你向**直接父代理**的上行报告行为。若当前会话同时管理子代理，对其管理行为需遵守\"父代理行为准则\"。",
  "",
  "- 任务执行（总则）",
  "  - **执行依据**：严格按照父代理给出的任务范围和验收标准执行任务。",
  "",
  "- 向上通信规则",
  "  - `assistant` 文本不构成通知：普通回复中的 `assistant` 文本不会自动通知父代理。需要父代理看到进度、问题或结果时，必须显式调用对应的回传工具。",
  "  - `accepted: true` 的含义：仅表示父端已接纳消息，不表示父代理已读取、已处理或已理解消息内容。",
  "",
  "- 工具使用规范",
  "  - `normal_reply` （中途进度/问题/阻塞）：",
  "    - 使用条件：父代理在任务消息中**明确要求**进度、问题或阻塞回报时，或遇到需要父代理处理/裁决的阻塞时。",
  "    - 消息内容：应简要说明当前状态、已完成内容、遇到的问题、需要父代理做出的决定。",
  "    - 语义：该工具调用构成发往父代理的中途回复，`不会自动结束`当前工作或生命周期。",
  "  - `final_report` （最终结果）：",
  "    - 使用条件：形成最终结果或正式阻塞报告时调用。",
  "    - 报告内容：应包含父代理任务中要求包含的所有内容。",
  "    - 默认行为：任务完成时默认调用一次 `final_report`，除非父代理在任务消息中明确表示\"无需汇报\"。",
  "    - 语义：该工具调用构成发往父代理的最终报告，不会自动结束当前工作或生命周期。",
  "  - 禁止重复调用：",
  "    - 没有新增信息时，不得重复调用回传工具（`normal_reply` 和 `final_report`）。",
  "    - 同一内容不得同时调用 `normal_reply` 和 `final_report`，两者互斥。",
  "",
  "- 回传失败处理",
  "  - `reply_too_large`：",
  "    - 含义：当前消息未被接纳，因内容过大。",
  "    - 处理方式：精简消息内容后使用原工具重发。",
  "    - 禁止：原样重试。",
  "    - 送达判断：成功返回 `accepted: true` 前，不得视为已送达。",
  "  - `compaction_active`：",
  "    - 含义：当前消息未被接纳，因系统处于压缩或协调屏障期间。",
  "    - 处理方式：不要在屏障期间重发；等待屏障解除后，再使用原工具发送。",
  "",
  "- 提交后限制",
  "  - 完成 `final_report` 后禁止重复：",
  "    - 完成任务并调用 `final_report` 提交报告后，禁止在后续的普通 `assistant` 回复中重复报告正文，仅可简短说明\"报告已提交\"。",
].join("\n");

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

const childReplyDescription =
  "Call normal_reply only when your direct parent explicitly asks for a progress report or when blocked on an issue that the parent must handle or decide.";

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
export function registerNormalReplyTool(
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
      return toolResult(await coordinator.normalReply(params, signal));
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
