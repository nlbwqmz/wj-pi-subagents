import type { AgentController } from "./agent-controller.ts";
import { controlFailure, type ControlResult } from "./tree-controller.ts";

/** Pi 扩展 API 的最小结构面；生产类型由宿主包提供，核心包不复制其定义。 */
export interface AgentToolRegistrationApi {
  registerTool: (tool: unknown) => void;
}

export type AgentToolControllerProvider = (
  context: unknown,
) => AgentController | Promise<AgentController>;

export const AGENT_TOOL_NAMES = Object.freeze([
  "spawn_agent",
  "send_message",
  "wait_agent",
  "interrupt_agent",
  "terminate_agent",
  "get_agent_status",
  "get_agent_tree",
] as const);

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
  spawn_agent: Object.freeze({
    type: "object",
    properties: Object.freeze({
      template_id: Object.freeze({ type: "string", minLength: 1, maxLength: 256 }),
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
  spawn_agent: "创建一个直接子代理并等待它完成启动握手。",
  send_message: "向直接子代理发送任务消息或当前处理的 steering。",
  wait_agent: "等待直接子代理 settled 或进入终态。",
  interrupt_agent: "协作式中断直接子代理当前处理，保留节点和上下文。",
  terminate_agent: "终止直接子代理及其已登记子树并确认资源回收。",
  get_agent_status: "读取直接子代理最近确认的安全状态快照。",
  get_agent_tree: "读取当前调用者作用域内的安全代理树快照。",
});

/** 返回给 Pi 的固定工具结果；details 只包含控制器安全数据。 */
function toolResult<T>(result: ControlResult<T>): unknown {
  if (!result.ok) throw new SubagentToolError(result.error);
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
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
): Record<string, unknown> {
  return {
    name,
    label: name,
    description: descriptions[name],
    parameters: schemas[name],
    executionMode: "sequential",
    execute: async (
      _toolCallId: string,
      params: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      context: unknown,
    ) => toolResult(await execute(await controllerFor(provider, context), params)),
  };
}

/** 注册完整、不可拆分的七工具集合；返回已注册名称供宿主测试和诊断使用。 */
export function registerAgentTools(
  api: AgentToolRegistrationApi,
  provider: AgentToolControllerProvider,
): readonly AgentToolName[] {
  if (typeof api.registerTool !== "function") throw new TypeError("宿主缺少 registerTool");
  const tools: readonly Record<string, unknown>[] = [
    executeTool("spawn_agent", provider, async (controller, params) => controller.spawnAgent(params)),
    executeTool("send_message", provider, async (controller, params) => controller.sendMessage(params)),
    executeTool("wait_agent", provider, async (controller, params) => controller.waitAgent(params)),
    executeTool("interrupt_agent", provider, async (controller, params) => {
      const agentId = readAgentId(params);
      return controller.interruptAgent(agentId);
    }),
    executeTool("terminate_agent", provider, async (controller, params) => {
      const agentId = readAgentId(params);
      return controller.terminateAgent(agentId);
    }),
    executeTool("get_agent_status", provider, async (controller, params) => {
      const agentId = readAgentId(params);
      return Promise.resolve(controller.getAgentStatus(agentId));
    }),
    executeTool("get_agent_tree", provider, async (controller, params) => {
      if (!isEmptyObject(params)) return controlFailure("invalid_argument");
      return Promise.resolve(controller.getAgentTree());
    }),
  ];
  for (const tool of tools) api.registerTool(tool);
  return AGENT_TOOL_NAMES;
}

function readAgentId(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>).agent_id;
}

function isEmptyObject(value: unknown): value is Readonly<Record<string, never>> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
}
