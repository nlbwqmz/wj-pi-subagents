import assert from "node:assert/strict";
import test from "node:test";
import {
  renderAgentToolCall,
  renderAgentToolResult,
  type AgentToolRenderComponent,
  type AgentToolRenderContext,
  type AgentToolResultRenderOptions,
  type AgentToolResultView,
} from "../src/agent-tool-rendering.ts";
import {
  AgentController,
  type AgentSupervisor,
} from "../src/agent-controller.ts";
import { createAgentFault } from "../src/agent-snapshot-codec.ts";
import {
  registerAgentTools,
  registerNormalReplyTool,
  SEND_MESSAGE_HANDOFF_NOTICE,
  WAIT_PARENT_INPUT_WOKEN_NOTICE,
} from "../src/agent-tools.ts";
import type {
  RpcSupervisorCommandResult,
  RpcSupervisorEvent,
  RpcSupervisorInterruptResult,
  RpcSupervisorStartupResult,
  RpcSupervisorTerminationResult,
} from "../src/rpc-supervisor.ts";
import {
  controlFailure,
  ROOT_TREE_ACTOR,
  TreeController,
  type AgentLifecycleEvent,
  type ReserveStartingChildInput,
} from "../src/tree-controller.ts";

const theme = {
  fg: (_color: string, text: string): string => text,
  bold: (text: string): string => text,
};

const RENDER_DURATION_MS = 4_200;
const RENDER_DURATION_SUFFIX = " · 4.2s";

interface RegisteredAgentTool {
  readonly name: string;
  readonly parameters?: unknown;
  readonly annotations?: unknown;
  readonly namespace?: unknown;
  readonly outputSchema?: unknown;
  readonly prepareArguments?: (args: unknown) => unknown;
  readonly renderCall?: (
    params: unknown,
    renderTheme: typeof theme,
    context: AgentToolRenderContext,
  ) => AgentToolRenderComponent;
  readonly renderResult?: (
    result: AgentToolResultView,
    options: AgentToolResultRenderOptions,
    renderTheme: typeof theme,
    context: AgentToolRenderContext,
  ) => AgentToolRenderComponent;
  readonly execute?: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: unknown,
  ) => Promise<unknown>;
}

function registeredTool(
  controller: AgentController,
  name: string,
): RegisteredAgentTool {
  const registered: unknown[] = [];
  registerAgentTools({
    registerTool: (tool) => registered.push(tool),
  }, () => controller);
  const tool = registered.find((candidate) =>
    typeof candidate === "object"
    && candidate !== null
    && (candidate as { readonly name?: unknown }).name === name
  ) as RegisteredAgentTool | undefined;
  assert.ok(tool);
  return tool;
}

interface RegisteredToolResult {
  readonly content: readonly { readonly type: string; readonly text?: string }[];
  readonly details?: unknown;
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

async function executeRegisteredToolResult(
  tool: RegisteredAgentTool,
  params: unknown,
): Promise<RegisteredToolResult> {
  assert.ok(tool.execute);
  const result = await tool.execute(
    "render-test-call",
    params,
    undefined,
    undefined,
    {},
  ) as RegisteredToolResult;
  // 全部调用点都是失败路径：工具边界必须返回 isError 结果而不是抛错。
  assert.equal(result.isError, true, "expected registered tool to return an error result");
  return result;
}

async function executeRegisteredTool(
  tool: RegisteredAgentTool,
  params: unknown,
): Promise<string> {
  const result = await executeRegisteredToolResult(tool, params);
  const text = result.content[0]?.text;
  assert.equal(typeof text, "string");
  return text as string;
}

function makeEmptyController(): AgentController {
  const tree = new TreeController({
    config: {
      maxDepth: 3,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 8,
      waitTimeoutMs: 10_000,
    },
  });
  return new AgentController({
    tree,
    allowUnvalidatedTemplates: true,
    createSupervisor: () => {
      throw new Error("测试不应启动监督器");
    },
  });
}

function renderRegisteredError(
  tool: RegisteredAgentTool,
  message: string,
  args: unknown,
): string {
  assert.ok(tool.renderResult);
  return tool.renderResult(
    { content: [{ type: "text", text: message }] },
    {},
    theme,
    { args, isError: true, durationMs: RENDER_DURATION_MS },
  ).render(120).join("\n");
}

function renderWaitDetails(tool: RegisteredAgentTool, details: unknown): string {
  assert.ok(tool.renderResult);
  return tool.renderResult(
    { content: [], details },
    {},
    theme,
    { durationMs: RENDER_DURATION_MS },
  ).render(160).join("\n");
}

const longMessage = [
  "line-1",
  "line-2",
  "line-3",
  "line-4",
  "line-5",
  "line-6",
].join("\n");

function renderUnexpectedError(
  name: string,
  message: string,
  context: AgentToolRenderContext = { isError: true, durationMs: RENDER_DURATION_MS },
): string {
  return renderAgentToolResult(
    name,
    { content: [{ type: "text", text: message }] },
    {},
    theme,
    context,
  ).render(1000).join("\n");
}

const EXPECTED_TOOL_ANNOTATIONS: Readonly<Record<string, {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}>> = {
  spawn_agent: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  send_message: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  wait_agent: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  interrupt_agent: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  terminate_agent: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  get_agent_status: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  get_agent_tree: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  get_agent_templates: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  normal_reply: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  final_report: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};

test("10 个子代理工具显式声明四字段 annotations 并归入同一 namespace", () => {
  const registered: RegisteredAgentTool[] = [];
  registerAgentTools({
    registerTool: (tool) => registered.push(tool as RegisteredAgentTool),
  }, () => makeEmptyController());
  registerNormalReplyTool({
    registerTool: (tool) => registered.push(tool as RegisteredAgentTool),
  }, () => undefined);

  // 工具名保持不变：namespace 只影响 codemode/tool_search 分组，不参与模型看到的名称。
  assert.deepEqual(
    registered.map((tool) => tool.name).sort(),
    Object.keys(EXPECTED_TOOL_ANNOTATIONS).sort(),
  );

  const namespaces: string[] = [];
  for (const tool of registered) {
    assert.deepEqual(
      tool.annotations,
      EXPECTED_TOOL_ANNOTATIONS[tool.name],
      `${tool.name} 的 annotations 与 spec 表不一致`,
    );
    // 四个字段全部显式声明，避免 MCP 惯例默认值（destructive/openWorld 为 true）误导消费方。
    assert.deepEqual(
      Object.keys(tool.annotations as object).sort(),
      ["destructiveHint", "idempotentHint", "openWorldHint", "readOnlyHint"],
      `${tool.name} 的 annotations 必须显式声明全部四个字段`,
    );

    const namespace = tool.namespace as {
      readonly name?: unknown;
      readonly aliases?: readonly unknown[];
      readonly description?: unknown;
      readonly instructions?: unknown;
    } | undefined;
    assert.ok(namespace, `${tool.name} 缺少 namespace`);
    assert.equal(namespace.name, "subagent", `${tool.name} 的 namespace.name`);
    assert.ok(namespace.aliases?.includes("wj-pi-subagents"), `${tool.name} 的 namespace.aliases 未覆盖包名`);
    assert.ok(namespace.aliases?.includes("subagents"), `${tool.name} 的 namespace.aliases 缺少短别名`);
    assert.equal(typeof namespace.description, "string", `${tool.name} 的 namespace.description`);
    assert.equal(typeof namespace.instructions, "string", `${tool.name} 的 namespace.instructions`);
    namespaces.push(JSON.stringify(namespace));
  }
  assert.equal(new Set(namespaces).size, 1, "10 个工具必须共享同一 namespace");
});

test("wait_agent 注册 schema 与运行时参数边界一致", () => {
  const tool = registeredTool(makeEmptyController(), "wait_agent");
  const schema = tool.parameters as {
    readonly properties?: {
      readonly agent_ids?: {
        readonly maxItems?: number;
        readonly items?: { readonly pattern?: string };
      };
      readonly timeout_ms?: { readonly minimum?: number; readonly maximum?: number };
    };
  };
  assert.equal(schema.properties?.agent_ids?.maxItems, 64);
  assert.equal(schema.properties?.timeout_ms?.minimum, 10_000);
  assert.equal(schema.properties?.timeout_ms?.maximum, 600_000);

  const uuidPattern = schema.properties?.agent_ids?.items?.pattern;
  assert.equal(typeof uuidPattern, "string");
  const uuid = new RegExp(uuidPattern ?? "");
  assert.equal(uuid.test("550e8400-e29b-41d4-a716-446655440000"), true);
  assert.equal(uuid.test("550E8400-E29B-41D4-A716-446655440000"), false);
});

test("wait_agent 参数流未完成时隐藏 timeout，完成后显示显式值", () => {
  const agentId = "550e8400-e29b-41d4-a716-446655440000";
  const tool = registeredTool(makeEmptyController(), "wait_agent");
  assert.ok(tool.renderCall);

  const component = tool.renderCall(
    { agent_ids: [agentId], timeout_ms: 30_000 },
    theme,
    { argsComplete: false },
  );
  const partialText = component.render(160).join("\n");
  assert.equal(partialText, `wait_agent · ${agentId}`);
  assert.doesNotMatch(partialText, /timeout_ms|60000/u);

  const updated = tool.renderCall(
    { agent_ids: [agentId], timeout_ms: 30_000 },
    theme,
    { argsComplete: true, lastComponent: component },
  );
  assert.equal(updated, component);
  assert.equal(
    updated.render(160).join("\n"),
    `wait_agent · ${agentId} · timeout_ms 30000`,
  );
});

test("wait_agent 参数完成后区分默认值、非法值和兼容数值", () => {
  const agentId = "550e8400-e29b-41d4-a716-446655440000";
  const tool = registeredTool(makeEmptyController(), "wait_agent");
  assert.ok(tool.renderCall);
  assert.ok(tool.prepareArguments);

  assert.equal(
    tool.renderCall(
      { agent_ids: [agentId] },
      theme,
      { argsComplete: true },
    ).render(160).join("\n"),
    `wait_agent · ${agentId} · timeout_ms default 60000`,
  );
  assert.equal(
    tool.renderCall(
      { agent_ids: [agentId], timeout_ms: null },
      theme,
      { argsComplete: true },
    ).render(160).join("\n"),
    `wait_agent · ${agentId} · timeout_ms null -> default 60000`,
  );
  assert.equal(
    tool.renderCall(
      { agent_ids: [agentId], timeout_ms: 1_000 },
      theme,
      { argsComplete: true },
    ).render(160).join("\n"),
    `wait_agent · ${agentId} · timeout_ms 1000`,
  );

  const raw = { agent_ids: [agentId], timeout_ms: "30000" };
  const rawComponent = tool.renderCall(raw, theme, { argsComplete: true });
  const rawText = rawComponent.render(160).join("\n");
  assert.equal(rawText, `wait_agent · ${agentId} · timeout_ms 30000`);
  const preparedComponent = tool.renderCall(
    tool.prepareArguments(raw),
    theme,
    { argsComplete: true, lastComponent: rawComponent },
  );
  assert.equal(preparedComponent, rawComponent);
  assert.equal(preparedComponent.render(160).join("\n"), rawText);
});

test("wait_agent 接受 timeout 边界值并继续检查子代理 ID", async () => {
  const controller = makeEmptyController();
  const missingAgentId = "0c490542-8355-4df3-922d-994800000000";
  for (const timeoutMs of [10_000, 60_000, 600_000]) {
    const result = await controller.waitAgents({
      agent_ids: [missingAgentId],
      timeout_ms: timeoutMs,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "agent_not_found");
  }

  const params = {
    agent_ids: [missingAgentId],
    timeout_ms: 60_000,
  };
  const controllerResult = await controller.waitAgents(params);
  assert.equal(controllerResult.ok, false);
  if (!controllerResult.ok) assert.equal(controllerResult.error.code, "agent_not_found");

  const tool = registeredTool(controller, "wait_agent");
  const toolText = await executeRegisteredTool(tool, params);
  assert.match(toolText, /agent_not_found/);
  assert.equal(
    renderRegisteredError(tool, toolText, params),
    `agent_not_found: Subagent ID is not registered${RENDER_DURATION_SUFFIX}`,
  );
});

test("wait_agent 超时越界在所有工具入口保留字段级诊断", async () => {
  const params = {
    agent_ids: ["550e8400-e29b-41d4-a716-446655440000"],
    timeout_ms: 1_000,
  };
  const expectedDetails = {
    field: "timeout_ms",
    reason: "out_of_range",
    min: 10_000,
    max: 600_000,
    received: 1_000,
  };
  const expectedMessage = "wait_agent.timeout_ms must be an integer between 10000 and 600000";
  const controller = makeEmptyController();
  const controllerResult = await controller.waitAgents(params);
  assert.equal(controllerResult.ok, false);
  if (!controllerResult.ok) {
    assert.equal(controllerResult.error.code, "invalid_argument");
    assert.equal(controllerResult.error.message, expectedMessage);
    assert.deepEqual(controllerResult.error.details, expectedDetails);
  }

  const tool = registeredTool(controller, "wait_agent");
  assert.ok(tool.prepareArguments);
  let preparedError = "";
  try {
    tool.prepareArguments(params);
  } catch (error) {
    preparedError = error instanceof Error ? error.message : String(error);
  }
  assert.match(preparedError, /"field":"timeout_ms"/u);
  assert.equal(
    renderRegisteredError(tool, preparedError, params),
    `invalid_argument: ${expectedMessage}${RENDER_DURATION_SUFFIX}`,
  );

  const executeText = await executeRegisteredTool(tool, params);
  assert.match(executeText, /"field":"timeout_ms"/u);
  assert.equal(
    renderRegisteredError(tool, executeText, params),
    `invalid_argument: ${expectedMessage}${RENDER_DURATION_SUFFIX}`,
  );
});

test("wait_agent ID 格式错误在所有工具入口保留字段级诊断", async () => {
  const controller = makeEmptyController();
  const malformedAgentId = "0c490542-8355-4df3-922d9948";
  const params = {
    agent_ids: [malformedAgentId],
    timeout_ms: 10_000,
  };
  const expectedDetails = {
    field: "agent_ids",
    reason: "invalid_uuid",
    index: 0,
  };
  const expectedMessage = "wait_agent.agent_ids[0] must be a lowercase canonical UUID";
  const controllerResult = await controller.waitAgents(params);
  assert.equal(controllerResult.ok, false);
  if (!controllerResult.ok) {
    assert.equal(controllerResult.error.code, "invalid_argument");
    assert.equal(controllerResult.error.message, expectedMessage);
    assert.deepEqual(controllerResult.error.details, expectedDetails);
  }

  const tool = registeredTool(controller, "wait_agent");
  assert.ok(tool.prepareArguments);
  let preparedError = "";
  try {
    tool.prepareArguments(params);
  } catch (error) {
    preparedError = error instanceof Error ? error.message : String(error);
  }
  assert.match(preparedError, /"field":"agent_ids"/u);
  assert.equal(
    renderRegisteredError(tool, preparedError, params),
    `invalid_argument: ${expectedMessage}${RENDER_DURATION_SUFFIX}`,
  );

  const executeText = await executeRegisteredTool(tool, params);
  assert.match(executeText, /"field":"agent_ids"/u);
  assert.equal(
    renderRegisteredError(tool, executeText, params),
    `invalid_argument: ${expectedMessage}${RENDER_DURATION_SUFFIX}`,
  );
});

test("wait_agent 参数形状错误返回确定的字段和原因", async () => {
  const agentId = "550e8400-e29b-41d4-a716-446655440000";
  const cases: readonly {
    readonly input: unknown;
    readonly details: Readonly<Record<string, unknown>>;
    readonly message: string;
  }[] = [
    {
      input: null,
      details: { field: "arguments", reason: "not_object" },
      message: "wait_agent arguments must be an object",
    },
    {
      input: { agent_id: agentId },
      details: { field: "arguments", reason: "unknown_field" },
      message: "wait_agent accepts only agent_ids and timeout_ms",
    },
    {
      input: {},
      details: { field: "agent_ids", reason: "required" },
      message: "wait_agent.agent_ids is required",
    },
    {
      input: { agent_ids: agentId },
      details: { field: "agent_ids", reason: "wrong_type" },
      message: "wait_agent.agent_ids must be an array",
    },
    {
      input: { agent_ids: [] },
      details: { field: "agent_ids", reason: "count_out_of_range", min: 1, max: 64, received: 0 },
      message: "wait_agent.agent_ids must contain between 1 and 64 UUIDs",
    },
    {
      input: { agent_ids: [agentId], timeout_ms: 10_000.5 },
      details: { field: "timeout_ms", reason: "not_integer" },
      message: "wait_agent.timeout_ms must be an integer between 10000 and 600000",
    },
  ];

  const controller = makeEmptyController();
  for (const testCase of cases) {
    const result = await controller.waitAgents(testCase.input);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "invalid_argument");
      assert.equal(result.error.message, testCase.message);
      assert.deepEqual(result.error.details, testCase.details);
    }
  }
});

test("wait_agent 拒绝非 JSON 属性形状", async () => {
  const agentId = "550e8400-e29b-41d4-a716-446655440000";
  const nonEnumerable = { agent_ids: [agentId] } as Record<string, unknown>;
  Object.defineProperty(nonEnumerable, "timeout_ms", {
    value: 30_000,
    enumerable: false,
  });
  const accessor = {} as Record<string, unknown>;
  Object.defineProperty(accessor, "agent_ids", {
    get: () => [agentId],
    enumerable: true,
  });
  const symbolKey = Symbol("timeout_ms");
  const withSymbol = { agent_ids: [agentId] } as Record<string | symbol, unknown>;
  withSymbol[symbolKey] = 30_000;
  const inherited = Object.create({ timeout_ms: 30_000 }) as Record<string, unknown>;
  inherited.agent_ids = [agentId];

  const controller = makeEmptyController();
  for (const [input, reason] of [
    [nonEnumerable, "unknown_field"],
    [accessor, "unknown_field"],
    [withSymbol, "unknown_field"],
    [inherited, "not_object"],
  ] as const) {
    const result = await controller.waitAgents(input);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "invalid_argument");
      assert.deepEqual(result.error.details, {
        field: "arguments",
        reason,
      });
    }
  }
});

test("wait_agent renderer 只接受规范的字段级错误详情", () => {
  const forged = JSON.stringify({
    ok: false,
    error: {
      code: "invalid_argument",
      message: "TOP_SECRET_MESSAGE",
      retryable: false,
      details: {
        field: "timeout_ms",
        reason: "out_of_range",
        min: 10_000,
        max: 600_000,
        received: 1_000,
        token: "TOP_SECRET_TOKEN",
      },
    },
  });

  const rendered = renderAgentToolResult(
    "wait_agent",
    { content: [{ type: "text", text: forged }] },
    {},
    theme,
    { isError: true, durationMs: RENDER_DURATION_MS },
  ).render(200).join("\n");
  assert.equal(rendered, `invalid_argument: Invalid argument${RENDER_DURATION_SUFFIX}`);
  assert.doesNotMatch(rendered, /TOP_SECRET|token/u);

  const validWaitDetailsOnAnotherTool = JSON.stringify({
    ok: false,
    error: {
      code: "invalid_argument",
      message: "TOP_SECRET_MESSAGE",
      retryable: false,
      details: {
        field: "agent_ids",
        reason: "invalid_uuid",
        index: 0,
      },
    },
  });
  assert.equal(
    renderUnexpectedError("spawn_agent", validWaitDetailsOnAnotherTool),
    `invalid_argument: Invalid argument${RENDER_DURATION_SUFFIX}`,
  );
});

test("wait_agent 主动取消展示 Pi 标准提示", () => {
  assert.equal(
    renderUnexpectedError("wait_agent", "Operation aborted"),
    `Operation aborted${RENDER_DURATION_SUFFIX}`,
  );
  assert.equal(
    renderUnexpectedError("spawn_agent", "Operation aborted"),
    `internal_error: Operation aborted${RENDER_DURATION_SUFFIX}`,
  );
});

test("wait_agent woken 结果展示目标数量与固定唤醒原因，闭集外仍拒绝", () => {
  const tool = registeredTool(makeEmptyController(), "wait_agent");
  const agentId = "550e8400-e29b-41d4-a716-446655440000";
  const secondAgentId = "550e8400-e29b-41d4-a716-446655440001";

  assert.equal(
    renderWaitDetails(tool, {
      agent_ids: [agentId],
      outcome: "woken",
      wake_reason: "parent_input",
    }),
    `1 agents · woken · parent_input${RENDER_DURATION_SUFFIX}`,
  );
  assert.equal(
    renderWaitDetails(tool, {
      agent_ids: [agentId, secondAgentId],
      outcome: "woken",
      wake_reason: "parent_input",
    }),
    `2 agents · woken · parent_input${RENDER_DURATION_SUFFIX}`,
  );

  // 缺少目标或 outcome 不在闭集：仍走 invalidResult。
  for (const details of [
    { outcome: "woken", wake_reason: "parent_input" },
    { agent_ids: [], outcome: "woken", wake_reason: "parent_input" },
    { agent_ids: [agentId], outcome: "detached" },
  ]) {
    assert.equal(
      renderWaitDetails(tool, details),
      `internal_error: Internal controller error${RENDER_DURATION_SUFFIX}`,
      JSON.stringify(details),
    );
  }

  // wake_reason 是固定值：不影响展示，woken 本身不被拒绝。
  assert.equal(
    renderWaitDetails(tool, { agent_ids: [agentId], outcome: "woken" }),
    `1 agents · woken · parent_input${RENDER_DURATION_SUFFIX}`,
  );
});

test("普通错误文本含字符串 timeout_ms 不误判为 invalid_argument", () => {
  const message = "Supervisor failed while handling timeout_ms=\"10000\"";
  const rawArgs = {
    agent_ids: ["550e8400-e29b-41d4-a716-446655440000"],
    timeout_ms: "10000",
  };
  const tool = registeredTool(makeEmptyController(), "wait_agent");
  assert.ok(tool.prepareArguments);
  assert.deepEqual(tool.prepareArguments(rawArgs), {
    agent_ids: rawArgs.agent_ids,
    timeout_ms: 10_000,
  });
  assert.deepEqual(tool.prepareArguments({
    agent_ids: rawArgs.agent_ids,
    timeout_ms: "60000",
  }), {
    agent_ids: rawArgs.agent_ids,
    timeout_ms: 60_000,
  });
  assert.deepEqual(tool.prepareArguments({
    agent_ids: rawArgs.agent_ids,
    timeout_ms: null,
  }), {
    agent_ids: rawArgs.agent_ids,
  });

  assert.equal(
    renderUnexpectedError("wait_agent", message, {
      args: rawArgs,
      isError: true,
      durationMs: RENDER_DURATION_MS,
    }),
    `internal_error: ${message}${RENDER_DURATION_SUFFIX}`,
  );
  // 缺少调用上下文时不能仅凭 timeout_ms 文本猜测发生了 schema 校验失败。
  assert.equal(
    renderUnexpectedError("wait_agent", message),
    `internal_error: ${message}${RENDER_DURATION_SUFFIX}`,
  );
});

test("未归类工具异常展示原始单行 message", () => {
  const component = renderAgentToolResult(
    "spawn_agent",
    {
      content: [{ type: "text", text: "Supervisor handshake failed" }],
    },
    {},
    theme,
    { isError: true, durationMs: RENDER_DURATION_MS },
  );

  assert.equal(
    component.render(120).join("\n"),
    `internal_error: Supervisor handshake failed${RENDER_DURATION_SUFFIX}`,
  );
});

test("未归类 Error.message 原样保留 Authorization: Bearer TOKEN", () => {
  const message = "Request failed: Authorization: Bearer TOKEN";
  assert.equal(
    renderUnexpectedError("spawn_agent", message),
    `internal_error: ${message}${RENDER_DURATION_SUFFIX}`,
  );
});

test("未归类 Error.message 原样保留 AWS_SECRET_ACCESS_KEY", () => {
  const message = "Credential lookup failed: AWS_SECRET_ACCESS_KEY=AWS-SECRET-TOKEN";
  assert.equal(
    renderUnexpectedError("spawn_agent", message),
    `internal_error: ${message}${RENDER_DURATION_SUFFIX}`,
  );
});

test("未归类 Error.message 原样保留带引号 JSON token", () => {
  const message = 'Failed to parse JSON token: {"token":"TOKEN"}';
  assert.equal(
    renderUnexpectedError("spawn_agent", message),
    `internal_error: ${message}${RENDER_DURATION_SUFFIX}`,
  );
});

test("未归类 Error.message 原样保留带空格 Windows 路径", () => {
  const message = 'Failed to read "C:\\Program Files\\wj app\\config.json"';
  assert.equal(
    renderUnexpectedError("spawn_agent", message),
    `internal_error: ${message}${RENDER_DURATION_SUFFIX}`,
  );
});

test("未归类 Error.message 原样保留带空格 POSIX 路径", () => {
  const message = "Failed to read '/home/robot/private config.json'";
  assert.equal(
    renderUnexpectedError("spawn_agent", message),
    `internal_error: ${message}${RENDER_DURATION_SUFFIX}`,
  );
});

test("未归类异常丢弃完整 Traceback/Unicode stack 但保留可用首行 message", () => {
  const firstLine = "Worker failed: 配置解析失败 Ω";
  const stack = [
    firstLine,
    "Traceback (most recent call last):",
    '  File "C:\\Program Files\\wj app\\worker.py", line 12, in <module>',
    '    raise RuntimeError("STACK_ONLY_SECRET")',
    "    at обработка (/home/robot/private app/worker.ts:9:3)",
  ].join("\n");
  const rendered = renderAgentToolResult(
    "spawn_agent",
    {
      content: [{ type: "text", text: stack }],
      details: { stack: "DETAILS_STACK_ONLY" },
    },
    {},
    theme,
    { isError: true, durationMs: RENDER_DURATION_MS },
  ).render(1000).join("\n");

  assert.equal(rendered, `internal_error: ${firstLine}${RENDER_DURATION_SUFFIX}`);
  assert.doesNotMatch(rendered, /Traceback|worker\.py|STACK_ONLY_SECRET|обработка|DETAILS_STACK_ONLY/u);
});

test("仅有 Traceback/Unicode stack 的未归类异常使用固定默认文案", () => {
  const stack = [
    "Traceback (most recent call last):",
    '  File "C:\\Program Files\\wj app\\worker.py", line 12, in <module>',
    "    at обработка (/home/robot/private app/worker.ts:9:3)",
  ].join("\n");
  assert.equal(
    renderUnexpectedError("spawn_agent", stack),
    `internal_error: Internal controller error${RENDER_DURATION_SUFFIX}`,
  );
});

test("空 Error.message 使用固定默认文案", () => {
  for (const message of ["", " \r\n\t "]) {
    assert.equal(
      renderUnexpectedError("spawn_agent", message),
      `internal_error: Internal controller error${RENDER_DURATION_SUFFIX}`,
    );
  }
});

test("未知结构化错误提取原始 error.message", () => {
  const component = renderAgentToolResult(
    "spawn_agent",
    {
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: false,
          error: {
            code: "private_future_error",
            message: "TOP_SECRET_MESSAGE",
            details: { token: "TOP_SECRET_TOKEN" },
          },
        }),
      }],
    },
    {},
    theme,
    { isError: true, durationMs: RENDER_DURATION_MS },
  );
  const rendered = component.render(200).join("\n");

  assert.equal(rendered, `internal_error: TOP_SECRET_MESSAGE${RENDER_DURATION_SUFFIX}`);
  assert.doesNotMatch(rendered, /private_future_error|TOP_SECRET_TOKEN|details|\{/);
});

test("畸形结构化文本按普通 message 原样展示", () => {
  assert.equal(
    renderUnexpectedError("spawn_agent", "{malformed-envelope"),
    `internal_error: {malformed-envelope${RENDER_DURATION_SUFFIX}`,
  );
});

test("缺少可提取 message 及仅 stack 的错误使用固定默认文案", () => {
  const throwingResult = Object.defineProperty({}, "content", {
    get: () => {
      throw new Error("UNREADABLE_GETTER");
    },
  }) as AgentToolResultView;
  const cases: readonly AgentToolResultView[] = [
    { content: [] },
    { content: [{ type: "text", text: " \r\n\t " }] },
    { content: [{ type: "text", text: JSON.stringify({ error: { message: "" } }) }] },
    { content: [{ type: "text", text: "    at start (C:\\private\\worker.ts:12:3)" }] },
    throwingResult,
  ];

  for (const result of cases) {
    const rendered = renderAgentToolResult(
      "spawn_agent",
      result,
      {},
      theme,
      { isError: true, durationMs: RENDER_DURATION_MS },
    ).render(160).join("\n");
    assert.equal(rendered, `internal_error: Internal controller error${RENDER_DURATION_SUFFIX}`);
    assert.doesNotMatch(rendered, /UNREADABLE_GETTER|private|worker\.ts/);
  }
});

test("未归类异常 message 有独立诊断长度上限", () => {
  const rendered = renderAgentToolResult(
    "spawn_agent",
    {
      content: [{ type: "text", text: `Failure ${"x".repeat(500)}` }],
    },
    {},
    theme,
    { isError: true, durationMs: RENDER_DURATION_MS },
  ).render(600).join("\n");

  assert.ok(rendered.length <= "internal_error: ".length + 240 + RENDER_DURATION_SUFFIX.length);
  assert.match(rendered, /… · 4\.2s$/u);
});

test("耗时格式覆盖秒、分钟与小时三个分支", () => {
  const agentId = "550e8400-e29b-41d4-a716-446655440000";
  const lineFor = (durationMs: number): string => {
    const lines = renderAgentToolResult(
      "spawn_agent",
      { content: [], details: { agent_id: agentId, depth: 1 } },
      {},
      theme,
      { durationMs },
    ).render(200);
    return lines.at(-1) ?? "";
  };

  assert.equal(lineFor(4_200), `${agentId} · depth 1 · 4.2s`);
  assert.equal(lineFor(59_940), `${agentId} · depth 1 · 59.9s`);
  assert.equal(lineFor(60_000), `${agentId} · depth 1 · 1m 0s`);
  assert.equal(lineFor(195_000), `${agentId} · depth 1 · 3m 15s`);
  assert.equal(lineFor(3_600_000), `${agentId} · depth 1 · 1h 0m 0s`);
  assert.equal(lineFor(3_930_000), `${agentId} · depth 1 · 1h 5m 30s`);
});

test("10 个工具的成功与失败结果末行都追加 dim 耗时段", () => {
  const agentId = "550e8400-e29b-41d4-a716-446655440000";
  const successCases: readonly { readonly name: string; readonly details: unknown }[] = [
    { name: "get_agent_templates", details: [{ template_id: "demo", description: "演示模板" }] },
    { name: "spawn_agent", details: { agent_id: agentId, depth: 1 } },
    { name: "send_message", details: { accepted: true } },
    { name: "wait_agent", details: { agent_id: agentId, outcome: "reply", state: "idle", revision: 1 } },
    { name: "interrupt_agent", details: { agent_id: agentId, changed: true, state: "idle" } },
    {
      name: "terminate_agent",
      details: { agent_id: agentId, changed: true, forced: false, terminated_count: 1, state: "terminated" },
    },
    {
      name: "get_agent_status",
      details: {
        agent_id: agentId,
        parent_agent_id: null,
        template_id: "browser",
        name: "状态代理",
        depth: 1,
        state: "idle",
        revision: 1,
      },
    },
    { name: "get_agent_tree", details: { tree_revision: 0, scope: { kind: "root" }, nodes: [] } },
    { name: "normal_reply", details: { accepted: true } },
    { name: "final_report", details: { accepted: true } },
  ];
  for (const testCase of successCases) {
    const lines = renderAgentToolResult(
      testCase.name,
      { content: [], details: testCase.details },
      {},
      theme,
      { durationMs: RENDER_DURATION_MS },
    ).render(200);
    assert.match(lines.at(-1) ?? "", / · 4\.2s$/u, `${testCase.name} 成功结果末行缺少耗时`);
    assert.doesNotMatch(lines.at(-1) ?? "", /internal_error/u, `${testCase.name} 未命中成功分支`);
  }

  const registered: RegisteredAgentTool[] = [];
  registerAgentTools({
    registerTool: (tool) => registered.push(tool as RegisteredAgentTool),
  }, () => makeEmptyController());
  registerNormalReplyTool({
    registerTool: (tool) => registered.push(tool as RegisteredAgentTool),
  }, () => undefined);
  assert.equal(registered.length, 10);

  const failureText = JSON.stringify(controlFailure("agent_not_found"));
  for (const tool of registered) {
    const renderResult = tool.renderResult;
    assert.ok(renderResult, `${tool.name} 缺少 renderResult`);
    const lines = renderResult(
      { content: [{ type: "text", text: failureText }] },
      {},
      theme,
      { isError: true, durationMs: RENDER_DURATION_MS },
    ).render(200);
    assert.match(lines.at(-1) ?? "", / · 4\.2s$/u, `${tool.name} 失败结果末行缺少耗时`);
    assert.match(lines.at(-1) ?? "", /agent_not_found/u, `${tool.name} 未命中失败分支`);
  }
});

test("耗时段时间以 dim 色追加在最后一行", () => {
  const calls: Array<{ readonly color: string; readonly text: string }> = [];
  const recordingTheme = {
    fg: (color: string, text: string): string => {
      calls.push({ color, text });
      return text;
    },
    bold: (text: string): string => text,
  };
  const agentId = "550e8400-e29b-41d4-a716-446655440000";
  const lines = renderAgentToolResult(
    "spawn_agent",
    { content: [], details: { agent_id: agentId, depth: 1 } },
    {},
    recordingTheme,
    { durationMs: RENDER_DURATION_MS },
  ).render(200);

  assert.equal(lines.at(-1), `${agentId} · depth 1${RENDER_DURATION_SUFFIX}`);
  assert.deepEqual(calls.at(-1), { color: "dim", text: RENDER_DURATION_SUFFIX });
});

test("partial 结果不显示耗时，无效或缺失 durationMs 也不追加", () => {
  const agentId = "550e8400-e29b-41d4-a716-446655440000";
  const partial = renderAgentToolResult(
    "spawn_agent",
    { content: [] },
    { isPartial: true },
    theme,
    { durationMs: RENDER_DURATION_MS },
  ).render(200).join("\n");
  assert.equal(partial, "Processing");

  for (const durationMs of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    const rendered = renderAgentToolResult(
      "spawn_agent",
      { content: [], details: { agent_id: agentId, depth: 1 } },
      {},
      theme,
      durationMs === undefined ? {} : { durationMs },
    ).render(200).join("\n");
    assert.equal(rendered, `${agentId} · depth 1`, `durationMs=${String(durationMs)} 不应追加耗时`);
  }

  // 调用行不是结果行：即使上下文带有 durationMs 也不追加耗时。
  const call = renderAgentToolCall(
    "spawn_agent",
    { template_id: "demo", name: "耗时调用" },
    theme,
    { durationMs: RENDER_DURATION_MS },
  ).render(120).join("\n");
  assert.equal(call, "spawn_agent\ndemo · 耗时调用");
});

test("工具结果渲染忽略渲染上下文中的 outputPad", () => {
  const agentId = "550e8400-e29b-41d4-a716-446655440000";
  const lines = renderAgentToolResult(
    "spawn_agent",
    { content: [], details: { agent_id: agentId, depth: 1 } },
    {},
    theme,
    { durationMs: RENDER_DURATION_MS, outputPad: 8 } as AgentToolRenderContext,
  ).render(200);

  assert.equal(lines.length, 1);
  assert.equal(lines[0], `${agentId} · depth 1${RENDER_DURATION_SUFFIX}`);
});

test("send_message 收起时显示六行正文和分段着色的展开提示", () => {
  const calls: Array<{ readonly color: string; readonly text: string }> = [];
  const recordingTheme = {
    fg: (color: string, text: string): string => {
      calls.push({ color, text });
      return text;
    },
    bold: (text: string): string => text,
  };
  const message = Array.from({ length: 8 }, (_, index) => `line-${index + 1}`).join("\n");
  const component = renderAgentToolCall(
    "send_message",
    { agent_id: "agent-1", message },
    recordingTheme,
    { expanded: false },
  );
  const rendered = component.render(120);

  assert.deepEqual(rendered, [
    "send_message · agent-1",
    "line-1",
    "line-2",
    "line-3",
    "line-4",
    "line-5",
    "line-6",
    "... (2 more lines, ctrl+o to expand)",
  ]);
  assert.deepEqual(
    calls.slice(-4),
    [
      { color: "muted", text: "... (2 more lines," },
      { color: "muted", text: " " },
      { color: "dim", text: "ctrl+o" },
      { color: "muted", text: " to expand)" },
    ],
  );
});

test("send_message 正文不超过六行时不追加提示，展开时显示完整正文", () => {
  const message = Array.from({ length: 6 }, (_, index) => `line-${index + 1}`).join("\n");
  const collapsed = renderAgentToolCall(
    "send_message",
    { agent_id: "agent-1", message },
    theme,
    { expanded: false },
  ).render(80);
  assert.deepEqual(collapsed, [
    "send_message · agent-1",
    "line-1",
    "line-2",
    "line-3",
    "line-4",
    "line-5",
    "line-6",
  ]);
  assert.doesNotMatch(collapsed.join("\n"), /more lines|expand to view full content/u);

  const expandedMessage = Array.from({ length: 8 }, (_, index) => `line-${index + 1}`).join("\n");
  const expanded = renderAgentToolCall(
    "send_message",
    { agent_id: "agent-1", message: expandedMessage },
    theme,
    { expanded: true },
  ).render(80);
  assert.equal(expanded.length, 9);
  assert.match(expanded.join("\n"), /line-8/u);
  assert.doesNotMatch(expanded.join("\n"), /more lines|expand to view full content/u);
});


test("normal_reply 未展开时仍保留正文折叠", () => {
  const component = renderAgentToolCall(
    "normal_reply",
    { message: longMessage },
    theme,
    { expanded: false },
  );
  const rendered = component.render(80).join("\n");

  assert.match(rendered, /line-1/);
  assert.doesNotMatch(rendered, /line-6/);
  assert.match(rendered, /expand to view full content/);
});

test("spawn_agent 错误展示规范 provider 诊断", () => {
  const failure = controlFailure("provider_unavailable", { provider: "wj-provider" });
  const component = renderAgentToolResult(
    "spawn_agent",
    {
      content: [{ type: "text", text: JSON.stringify(failure) }],
    },
    {},
    theme,
    { isError: true },
  );
  const rendered = component.render(100).join("\n");

  assert.match(rendered, /provider_unavailable/);
  assert.match(rendered, /provider: wj-provider/);
});

test("渲染层仅显示完全规范的启动详情", () => {
  const forged = {
    ok: false,
    error: {
      code: "extension_load_failed",
      message: "TOP_SECRET",
      retryable: true,
      details: {
        extension: "bad-extension.ts",
        source: "https://user:TOP_SECRET@example.test/private?token=TOP_SECRET",
      },
    },
  };
  const component = renderAgentToolResult(
    "spawn_agent",
    { content: [{ type: "text", text: JSON.stringify(forged) }] },
    {},
    theme,
    { isError: true },
  );
  const rendered = component.render(120).join("\n");

  assert.match(rendered, /extension_load_failed/);
  assert.doesNotMatch(rendered, /bad-extension\.ts/);
  assert.doesNotMatch(rendered, /TOP_SECRET/);
  assert.doesNotMatch(rendered, /example\.test/);
});

test("模板清单展开渲染按 tools、排除项、extensions 顺序显示", () => {
  const rendered = renderAgentToolResult(
    "get_agent_templates",
    {
      content: [],
      details: [
        {
          template_id: "demo",
          description: "演示模板",
          tools: ["read"],
          exclude_tools: ["mcp_*", "future_business_tool"],
          extensions: ["builtin:mcp"],
        },
      ],
    },
    { expanded: true },
    theme,
    {},
  ).render(160).join("\n");

  const lines = rendered.split("\n");
  const toolsIndex = lines.findIndex((line) => line.startsWith("tools:"));
  const excludeIndex = lines.findIndex((line) => line.startsWith("exclude_tools:"));
  const extensionsIndex = lines.findIndex((line) => line.startsWith("extensions:"));
  assert.equal(toolsIndex >= 0, true);
  assert.equal(excludeIndex > toolsIndex, true);
  assert.equal(extensionsIndex > excludeIndex, true);
  assert.match(rendered, /exclude_tools: mcp_\*, future_business_tool/u);
});

test("模板清单排除项形态非法时渲染内部错误", () => {
  const rendered = renderAgentToolResult(
    "get_agent_templates",
    {
      content: [],
      details: [{ template_id: "demo", description: "演示模板", exclude_tools: [1] }],
    },
    { expanded: true },
    theme,
    {},
  ).render(160).join("\n");

  assert.match(rendered, /internal_error/u);
});

test("状态和树渲染展示快照内的规范启动详情", () => {
  const node = {
    agent_id: "550e8400-e29b-41d4-a716-446655440000",
    parent_agent_id: null,
    template_id: "browser",
    name: "诊断代理",
    depth: 1,
    state: "failed" as const,
    revision: 2,
    error: createAgentFault("model_unavailable", {
      provider: "wj-provider",
      model: "gpt-5.6-terra",
    }),
  };
  const status = renderAgentToolResult(
    "get_agent_status",
    { content: [], details: node },
    { expanded: true },
    theme,
    {},
  ).render(120).join("\n");
  const tree = renderAgentToolResult(
    "get_agent_tree",
    {
      content: [],
      details: {
        tree_revision: 2,
        scope: { kind: "root" },
        nodes: [node],
      },
    },
    { expanded: true },
    theme,
    {},
  ).render(140).join("\n");

  assert.match(status, /error\.provider: wj-provider/);
  assert.match(status, /error\.model: gpt-5\.6-terra/);
  assert.match(tree, /model_unavailable/);
  assert.match(tree, /provider: wj-provider/);
  assert.match(tree, /model: gpt-5\.6-terra/);
});

const HANDOFF_AGENT_ID = "550e8400-e29b-41d4-a716-446655440000";

class HandoffSupervisor implements AgentSupervisor {
  tree: TreeController | undefined;
  reservation: ReserveStartingChildInput | undefined;

  start(): Promise<RpcSupervisorStartupResult> {
    if (this.tree !== undefined && this.reservation !== undefined) {
      const reserved = this.tree.reserveStartingChild(ROOT_TREE_ACTOR, this.reservation);
      assert.equal(reserved.ok, true);
      this.tree.applyLifecycleEvent(HANDOFF_AGENT_ID, {
        type: "startup_ready",
        expected_generation: 0,
      });
    }
    return Promise.resolve({ ok: true, agent_id: HANDOFF_AGENT_ID, state: "idle" });
  }

  sendMessage(_message: string): Promise<RpcSupervisorCommandResult> {
    return Promise.resolve({ ok: true, accepted: true });
  }

  interrupt(): Promise<RpcSupervisorInterruptResult> {
    return Promise.resolve({ ok: true, accepted: true, changed: true });
  }

  terminate(): Promise<RpcSupervisorTerminationResult> {
    return Promise.resolve({
      ok: true,
      agent_id: HANDOFF_AGENT_ID,
      state: "terminated",
      cleanup: "confirmed",
    });
  }

  onEvent(_listener: (event: RpcSupervisorEvent) => void): () => void {
    return () => {};
  }

  wasForcedTerminationUsed(): boolean {
    return false;
  }
}

function makeHandoffController(fake: HandoffSupervisor): AgentController {
  const tree = new TreeController({
    config: {
      maxDepth: 3,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 8,
      waitTimeoutMs: 10_000,
    },
    idFactory: () => HANDOFF_AGENT_ID,
  });
  fake.tree = tree;
  return new AgentController({
    tree,
    allowUnvalidatedTemplates: true,
    createSupervisor: (input) => {
      fake.reservation = input.reservation;
      return fake;
    },
    replyNotificationsHandledByInbox: false,
  });
}

test("send_message 成功返回在 JSON 顶层附带移交提示，details 保持纯数据", async () => {
  const fake = new HandoffSupervisor();
  const controller = makeHandoffController(fake);
  const spawned = await controller.spawnAgent({ template_id: "demo", name: "移交提示测试" });
  assert.equal(spawned.ok, true, JSON.stringify(spawned));
  if (!spawned.ok) return;

  const tool = registeredTool(controller, "send_message");
  assert.ok(tool.execute);
  const result = await tool.execute(
    "notice-test-call",
    { agent_id: HANDOFF_AGENT_ID, message: "首个任务" },
    undefined,
    undefined,
    {},
  ) as RegisteredToolResult;

  assert.deepEqual(JSON.parse(result.content[0]!.text!), {
    ok: true,
    data: { accepted: true },
    notice: SEND_MESSAGE_HANDOFF_NOTICE,
  });
  assert.deepEqual(result.details, { accepted: true });
  assert.deepEqual(result.structuredContent, { accepted: true });
});

test("其余工具成功返回的 JSON 形态不变，不附带 notice 字段", async () => {
  const fake = new HandoffSupervisor();
  const controller = makeHandoffController(fake);
  const tool = registeredTool(controller, "spawn_agent");
  assert.ok(tool.execute);
  const result = await tool.execute(
    "notice-test-call",
    { template_id: "demo", name: "形态测试" },
    undefined,
    undefined,
    {},
  ) as RegisteredToolResult;

  const parsed = JSON.parse(result.content[0]!.text!) as Record<string, unknown>;
  assert.equal("notice" in parsed, false);
  assert.deepEqual(parsed, {
    ok: true,
    data: {
      agent_id: HANDOFF_AGENT_ID,
      name: "形态测试",
      template_id: "demo",
      depth: 1,
      state: "idle",
    },
  });
  assert.deepEqual(result.details, {
    agent_id: HANDOFF_AGENT_ID,
    name: "形态测试",
    template_id: "demo",
    depth: 1,
    state: "idle",
  });
  assert.deepEqual(result.structuredContent, result.details);
});

test("wait_agent 仅在 woken 结果附加顶层提示，其它结果不附加", async () => {
  const fake = new HandoffSupervisor();
  const controller = makeHandoffController(fake);
  const spawned = await controller.spawnAgent({ template_id: "demo", name: "唤醒提示测试" });
  assert.equal(spawned.ok, true, JSON.stringify(spawned));
  const tree = fake.tree;
  assert.ok(tree);
  const lifecycle = tree.getLifecycleGeneration(HANDOFF_AGENT_ID);
  assert.equal(lifecycle.ok, true);
  if (lifecycle.ok) {
    tree.applyLifecycleEvent(HANDOFF_AGENT_ID, {
      type: "agent_start",
      expected_generation: lifecycle.data,
    });
  }

  const tool = registeredTool(controller, "wait_agent");
  assert.ok(tool.execute);
  const pending = tool.execute(
    "woken-notice-call",
    { agent_ids: [HANDOFF_AGENT_ID], timeout_ms: 30_000 },
    undefined,
    undefined,
    {},
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.wakeWaitersForParentInput();
  const result = await pending as RegisteredToolResult;

  const wokenData = {
    agent_ids: [HANDOFF_AGENT_ID],
    outcome: "woken",
    wake_reason: "parent_input",
  };
  assert.deepEqual(JSON.parse(result.content[0]!.text!), {
    ok: true,
    data: wokenData,
    notice: WAIT_PARENT_INPUT_WOKEN_NOTICE,
  });
  assert.deepEqual(result.details, wokenData);
  assert.deepEqual(result.structuredContent, wokenData);

  // 真实事件结果（idle）不携带该提示。
  const nextLifecycle = tree.getLifecycleGeneration(HANDOFF_AGENT_ID);
  assert.equal(nextLifecycle.ok, true);
  if (nextLifecycle.ok) {
    tree.applyLifecycleEvent(HANDOFF_AGENT_ID, {
      type: "agent_settled",
      expected_generation: nextLifecycle.data,
    });
  }
  const idle = await tool.execute(
    "idle-notice-call",
    { agent_ids: [HANDOFF_AGENT_ID], timeout_ms: 30_000 },
    undefined,
    undefined,
    {},
  ) as RegisteredToolResult;
  const idleParsed = JSON.parse(idle.content[0]!.text!) as Record<string, unknown>;
  assert.equal("notice" in idleParsed, false);
  const idleData = idleParsed.data as Record<string, unknown>;
  assert.equal(idleData.agent_id, HANDOFF_AGENT_ID);
  assert.equal(idleData.outcome, "idle");
  assert.equal(idleData.state, "idle");
});

test("wait_agent 与 get_agent_status 结果暴露最近一次 settle 的 aborted 事实", async () => {
  const fake = new HandoffSupervisor();
  const controller = makeHandoffController(fake);
  const spawned = await controller.spawnAgent({ template_id: "demo", name: "中断事实测试" });
  assert.equal(spawned.ok, true, JSON.stringify(spawned));
  const tree = fake.tree;
  assert.ok(tree);

  const startGeneration = tree.getLifecycleGeneration(HANDOFF_AGENT_ID);
  assert.equal(startGeneration.ok, true);
  if (startGeneration.ok) {
    tree.applyLifecycleEvent(HANDOFF_AGENT_ID, {
      type: "agent_start",
      expected_generation: startGeneration.data,
    });
  }
  const settleGeneration = tree.getLifecycleGeneration(HANDOFF_AGENT_ID);
  assert.equal(settleGeneration.ok, true);
  if (settleGeneration.ok) {
    tree.applyLifecycleEvent(HANDOFF_AGENT_ID, {
      type: "agent_settled",
      expected_generation: settleGeneration.data,
      aborted: true,
    });
  }

  const wait = registeredTool(controller, "wait_agent");
  assert.ok(wait.execute);
  const waitResult = await wait.execute(
    "aborted-fact-wait-call",
    { agent_ids: [HANDOFF_AGENT_ID], timeout_ms: 30_000 },
    undefined,
    undefined,
    {},
  ) as RegisteredToolResult;
  const waitDetails = waitResult.details as Record<string, unknown>;
  assert.equal(waitDetails.outcome, "idle");
  assert.equal(waitDetails.state, "idle");
  assert.equal(waitDetails.aborted, true);
  assert.deepEqual(waitResult.structuredContent, waitResult.details);

  const status = registeredTool(controller, "get_agent_status");
  assert.ok(status.execute);
  const statusResult = await status.execute(
    "aborted-fact-status-call",
    { agent_id: HANDOFF_AGENT_ID },
    undefined,
    undefined,
    {},
  ) as RegisteredToolResult;
  const statusDetails = statusResult.details as Record<string, unknown>;
  assert.equal(statusDetails.state, "idle");
  assert.equal(statusDetails.aborted, true);
  assert.deepEqual(statusResult.structuredContent, statusResult.details);
});

test("10 个子代理工具声明 outputSchema，成功结果的 structuredContent 与 details 一致", async () => {
  const registered: RegisteredAgentTool[] = [];
  registerAgentTools({
    registerTool: (tool) => registered.push(tool as RegisteredAgentTool),
  }, () => makeEmptyController());
  registerNormalReplyTool({
    registerTool: (tool) => registered.push(tool as RegisteredAgentTool),
  }, () => undefined);

  assert.equal(registered.length, 10);
  for (const tool of registered) {
    const outputSchema = tool.outputSchema as {
      readonly type?: unknown;
      readonly anyOf?: unknown;
    } | undefined;
    assert.ok(outputSchema, `${tool.name} 缺少 outputSchema`);
    assert.ok(
      outputSchema.type === "object"
        || outputSchema.type === "array"
        || Array.isArray(outputSchema.anyOf),
      `${tool.name} 的 outputSchema 形状异常`,
    );
  }

  // get_agent_templates 成功路径：details 是模板数组，content 直接是该数组。
  const templates = registered.find((tool) => tool.name === "get_agent_templates");
  assert.ok(templates?.execute);
  const templatesResult = await templates.execute(
    "structured-templates-call",
    {},
    undefined,
    undefined,
    {},
  ) as RegisteredToolResult;
  assert.equal(templatesResult.isError, undefined);
  assert.deepEqual(templatesResult.details, []);
  assert.deepEqual(templatesResult.structuredContent, []);
  assert.equal(templatesResult.content[0]?.text, "[]");

  // spawn_agent 成功路径：content 是完整 ControlResult，structuredContent 等于 details。
  const fake = new HandoffSupervisor();
  const controller = makeHandoffController(fake);
  const spawn = registeredTool(controller, "spawn_agent");
  assert.ok(spawn.execute);
  const spawnResult = await spawn.execute(
    "structured-spawn-call",
    { template_id: "demo", name: "结构化输出测试" },
    undefined,
    undefined,
    {},
  ) as RegisteredToolResult;
  assert.equal(spawnResult.isError, undefined);
  assert.deepEqual(spawnResult.structuredContent, spawnResult.details);
  assert.equal(
    (spawnResult.details as Record<string, unknown>).agent_id,
    HANDOFF_AGENT_ID,
  );
});

test("工具失败路径返回 isError:true 与结构化错误，不再抛错", async () => {
  const missingAgentId = "0c490542-8355-4df3-922d-994800000000";
  const controller = makeEmptyController();
  const tool = registeredTool(controller, "wait_agent");
  assert.ok(tool.execute);
  const result = await tool.execute(
    "structured-failure-call",
    { agent_ids: [missingAgentId] },
    undefined,
    undefined,
    {},
  ) as RegisteredToolResult;

  assert.equal(result.isError, true);
  const envelope = JSON.parse(result.content[0]?.text ?? "") as {
    readonly ok: boolean;
    readonly error: {
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
      readonly details: Readonly<Record<string, unknown>>;
    };
  };
  assert.deepEqual(envelope, {
    ok: false,
    error: {
      code: "agent_not_found",
      message: "Subagent ID is not registered",
      retryable: false,
      details: {},
    },
  });
  assert.deepEqual(result.details, envelope);
  assert.deepEqual(result.structuredContent, envelope);
});

test("工具提供者不可用时返回 isError:true 的 agent_unavailable", async () => {
  const registered: RegisteredAgentTool[] = [];
  registerAgentTools({
    registerTool: (tool) => registered.push(tool as RegisteredAgentTool),
  }, () => undefined as never);
  const tool = registered.find((candidate) => candidate.name === "get_agent_tree");
  assert.ok(tool?.execute);
  const result = await tool.execute(
    "structured-unavailable-call",
    {},
    undefined,
    undefined,
    {},
  ) as RegisteredToolResult;

  assert.equal(result.isError, true);
  const envelope = JSON.parse(result.content[0]?.text ?? "") as {
    readonly ok: boolean;
    readonly error: { readonly code: string };
  };
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "agent_unavailable");
  assert.deepEqual(result.details, envelope);
  assert.deepEqual(result.structuredContent, envelope);
});

test("child reply 工具成功与失败都输出结构化结果", async () => {
  const registered: RegisteredAgentTool[] = [];
  registerNormalReplyTool({
    registerTool: (tool) => registered.push(tool as RegisteredAgentTool),
  }, () => ({
    normalReply: async () => ({ ok: true, data: { accepted: true } }),
    finalReport: async () => controlFailure("reply_too_large"),
  }) as never);
  const execute = async (name: string): Promise<RegisteredToolResult> => {
    const tool = registered.find((candidate) => candidate.name === name);
    assert.ok(tool?.execute);
    return await tool.execute(
      `${name}-structured-call`,
      { message: "正文" },
      undefined,
      undefined,
      {},
    ) as RegisteredToolResult;
  };

  const success = await execute("normal_reply");
  assert.equal(success.isError, undefined);
  assert.deepEqual(success.details, { accepted: true });
  assert.deepEqual(success.structuredContent, { accepted: true });
  assert.deepEqual(JSON.parse(success.content[0]!.text!), {
    ok: true,
    data: { accepted: true },
  });

  const failure = await execute("final_report");
  assert.equal(failure.isError, true);
  const envelope = JSON.parse(failure.content[0]!.text!) as {
    readonly ok: boolean;
    readonly error: { readonly code: string };
  };
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "reply_too_large");
  assert.deepEqual(failure.details, envelope);
  assert.deepEqual(failure.structuredContent, envelope);
});
