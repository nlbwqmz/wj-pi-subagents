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
  get_agent_templates: "列出当前发现且格式有效的子代理模板，直接返回 JSON 数组。每项包含 template_id、可选 description 和模板声明的子代理初始业务 tools；tools 不要求向父会话当前活动工具向下缩减。返回 [] 表示当前没有有效模板，此时不能调用 spawn_agent。非空模板仍须通过 spawn_agent 的模板格式、工具注册、模型、thinking 和管理能力预检。",
  spawn_agent: "使用有效模板创建一个直接子代理并等待它完成启动握手。调用前先调用 get_agent_templates；template_id 必须从当前返回数组中原样复制、区分大小写，不得猜测、裁剪、改写或用 description 代替。模板 tools 是子代理的初始业务工具请求，不要求是父会话活动工具的子集。若 get_agent_templates 返回 []，则不能调用 spawn_agent。创建成功后使用 send_message 发送首项任务。",
  send_message: "向直接子代理发送纯文本任务消息或当前处理的 steering；不支持 images，也不要构造或附带图片 Base64。返回 accepted: true 只表示插件 mailbox 已接纳并分配 message_id/task_id，不表示 Pi 或模型已经读取，更不表示任务完成；若返回 message_delivery_failed，交付状态可能无法确认，不要盲目重发。",
  wait_agent: "等待一个或多个直接子代理中的任意一个发来工作中回复、提交当前任务结果、进入 suspended 或终态。应在一次调用的 agent_ids 中传入全部目标，不要为同一批次分别调用本工具。outcome: reply 表示获胜子代理仍在处理；task_completed、task_failed 和 task_interrupted 表示其最近逻辑任务已提交；suspended 表示需要查询状态并人工裁决；batch_released 表示本调用被同一工具批次中另一个 wait_agent 的结果协同解除；timeout 只结束本批次等待，不改变节点生命周期。",
  interrupt_agent: "协作式中断直接子代理当前处理，保留节点和上下文；调用成功后仍需使用 wait_agent 确认处理真正结束。",
  terminate_agent: "永久终止直接子代理及其已登记子树并确认资源回收；只有确定不再复用该分支时使用。",
  get_agent_status: "读取直接子代理最近确认的安全状态快照。",
  get_agent_tree: "读取当前调用者作用域内的安全代理树快照。",
});

export const PARENT_COORDINATION_GUIDELINES = Object.freeze({
  taskOwnership: "任务所有权硬约束：send_message 返回 accepted: true 后，已下发任务范围由目标直接子代理负责，直到该子代理给出最终答复或进入终态。同一任务包括为同一问题、工单或结论执行的调查、实现、测试、复现、验证、评审及其子范围；父会话不得亲自实施或再次委派这些工作。读取或搜索同一源码与文档、运行同一测试、只读分析和独立验证都属于重复实施；‘只读’‘无写冲突’‘交叉验证’不是例外。父会话只能使用 wait_agent 等待、查询状态、向同一子代理发送 steering，或处理派发前已明确拆分、产出独立、无数据依赖且无共享写资源的其他工作。",
  sendMessage: "send_message 返回 accepted: true 只表示插件 mailbox 已接纳消息并分配 message_id/task_id，不表示 Pi 或模型已经读取，也不表示任务完成；若返回 message_delivery_failed，交付状态可能无法确认，不要盲目重发，先查询状态并结合已有回复判断。",
  unusableFinal: "收到 output_state: absent 的最终答复，或判断 present 正文仍不可用时，必须向同一 agent_id 尝试追问：只总结上一轮已完成工作并给出最终答复，不要重新执行任务；协议不自动重跑任务或切换模型。",
  waitAgent: "wait_agent 应在一次调用的 agent_ids 中传入所有待观察的直接子代理，并在任一目标产生结果时返回。outcome: reply 时获胜子代理仍在处理；task_completed、task_failed 或 task_interrupted 表示其最近逻辑任务已提交；suspended 表示需要查询状态并人工裁决；batch_released 表示同一 assistant 工具批次的另一个 wait_agent 已取得结果；timeout 只结束共享观察窗口，不改变任何节点生命周期，也不把任务交回直接父会话。",
  interruptAgent: "直接父会话需要接管已下发任务时，先使用 interrupt_agent，再使用 wait_agent 确认子代理已结束当前处理；确认后再实施相同任务或修改相同资源。",
});

const promptGuidelines: Readonly<Partial<Record<AgentToolName, readonly string[]>>> = Object.freeze({
  send_message: Object.freeze([
    PARENT_COORDINATION_GUIDELINES.taskOwnership,
    PARENT_COORDINATION_GUIDELINES.sendMessage,
    PARENT_COORDINATION_GUIDELINES.unusableFinal,
  ]),
  wait_agent: Object.freeze([
    PARENT_COORDINATION_GUIDELINES.waitAgent,
    PARENT_COORDINATION_GUIDELINES.unusableFinal,
  ]),
  interrupt_agent: Object.freeze([PARENT_COORDINATION_GUIDELINES.interruptAgent]),
});

const childReplySchema: JsonSchema = Object.freeze({
  type: "object",
  properties: Object.freeze({
    message: Object.freeze({
      type: "string",
      description: "发给创建你的直接父会话的必要工作中回复正文。",
      minLength: 1,
      maxLength: 16 * 1024,
    }),
  }),
  required: Object.freeze(["message"]),
  additionalProperties: false,
});

export const CHILD_REPLY_GUIDELINE =
  "仅在以下情况下使用 reply_to_parent：当前任务在最终答复前遇到必须由直接父代理处理或裁决的阻塞问题；或者直接父代理已明确要求你在任务执行过程中回报某项内容。除此之外不要调用本工具，尤其不得用于常规进度、心跳、阶段性总结、完成通知或替代最终答复。消息被接纳后继续当前任务；任务完成时仍须提交正常的最终答复。";

const childReplyDescription =
  `${CHILD_REPLY_GUIDELINE} 本工具只发送文本，不支持 images，也不要构造或附带图片 Base64；无需提供 agent_id 或目标。`;

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
  const guidelines = promptGuidelines[name];
  return {
    name,
    label: name,
    description: descriptions[name],
    ...(guidelines === undefined ? {} : { promptGuidelines: guidelines }),
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
    promptGuidelines: Object.freeze([CHILD_REPLY_GUIDELINE]),
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
