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
  SEND_MESSAGE_HANDOFF_NOTICE,
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

interface RegisteredAgentTool {
  readonly name: string;
  readonly parameters?: unknown;
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

async function executeRegisteredTool(
  tool: RegisteredAgentTool,
  params: unknown,
): Promise<string> {
  assert.ok(tool.execute);
  try {
    await tool.execute("render-test-call", params, undefined, undefined, {});
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected registered tool to fail");
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
    { args, isError: true },
  ).render(120).join("\n");
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
  context: AgentToolRenderContext = { isError: true },
): string {
  return renderAgentToolResult(
    name,
    { content: [{ type: "text", text: message }] },
    {},
    theme,
    context,
  ).render(1000).join("\n");
}

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
    "agent_not_found: Subagent ID is not registered",
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
    `invalid_argument: ${expectedMessage}`,
  );

  const executeText = await executeRegisteredTool(tool, params);
  assert.match(executeText, /"field":"timeout_ms"/u);
  assert.equal(
    renderRegisteredError(tool, executeText, params),
    `invalid_argument: ${expectedMessage}`,
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
    `invalid_argument: ${expectedMessage}`,
  );

  const executeText = await executeRegisteredTool(tool, params);
  assert.match(executeText, /"field":"agent_ids"/u);
  assert.equal(
    renderRegisteredError(tool, executeText, params),
    `invalid_argument: ${expectedMessage}`,
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
    { isError: true },
  ).render(200).join("\n");
  assert.equal(rendered, "invalid_argument: Invalid argument");
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
    "invalid_argument: Invalid argument",
  );
});

test("wait_agent 主动取消展示 Pi 标准提示", () => {
  assert.equal(renderUnexpectedError("wait_agent", "Operation aborted"), "Operation aborted");
  assert.equal(
    renderUnexpectedError("spawn_agent", "Operation aborted"),
    "internal_error: Operation aborted",
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
    renderUnexpectedError("wait_agent", message, { args: rawArgs, isError: true }),
    `internal_error: ${message}`,
  );
  // 缺少调用上下文时不能仅凭 timeout_ms 文本猜测发生了 schema 校验失败。
  assert.equal(renderUnexpectedError("wait_agent", message), `internal_error: ${message}`);
});

test("未归类工具异常展示原始单行 message", () => {
  const component = renderAgentToolResult(
    "spawn_agent",
    {
      content: [{ type: "text", text: "Supervisor handshake failed" }],
    },
    {},
    theme,
    { isError: true },
  );

  assert.equal(
    component.render(120).join("\n"),
    "internal_error: Supervisor handshake failed",
  );
});

test("未归类 Error.message 原样保留 Authorization: Bearer TOKEN", () => {
  const message = "Request failed: Authorization: Bearer TOKEN";
  assert.equal(renderUnexpectedError("spawn_agent", message), `internal_error: ${message}`);
});

test("未归类 Error.message 原样保留 AWS_SECRET_ACCESS_KEY", () => {
  const message = "Credential lookup failed: AWS_SECRET_ACCESS_KEY=AWS-SECRET-TOKEN";
  assert.equal(renderUnexpectedError("spawn_agent", message), `internal_error: ${message}`);
});

test("未归类 Error.message 原样保留带引号 JSON token", () => {
  const message = 'Failed to parse JSON token: {"token":"TOKEN"}';
  assert.equal(renderUnexpectedError("spawn_agent", message), `internal_error: ${message}`);
});

test("未归类 Error.message 原样保留带空格 Windows 路径", () => {
  const message = 'Failed to read "C:\\Program Files\\wj app\\config.json"';
  assert.equal(renderUnexpectedError("spawn_agent", message), `internal_error: ${message}`);
});

test("未归类 Error.message 原样保留带空格 POSIX 路径", () => {
  const message = "Failed to read '/home/robot/private config.json'";
  assert.equal(renderUnexpectedError("spawn_agent", message), `internal_error: ${message}`);
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
    { isError: true },
  ).render(1000).join("\n");

  assert.equal(rendered, `internal_error: ${firstLine}`);
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
    "internal_error: Internal controller error",
  );
});

test("空 Error.message 使用固定默认文案", () => {
  for (const message of ["", " \r\n\t "]) {
    assert.equal(
      renderUnexpectedError("spawn_agent", message),
      "internal_error: Internal controller error",
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
    { isError: true },
  );
  const rendered = component.render(200).join("\n");

  assert.equal(rendered, "internal_error: TOP_SECRET_MESSAGE");
  assert.doesNotMatch(rendered, /private_future_error|TOP_SECRET_TOKEN|details|\{/);
});

test("畸形结构化文本按普通 message 原样展示", () => {
  assert.equal(
    renderUnexpectedError("spawn_agent", "{malformed-envelope"),
    "internal_error: {malformed-envelope",
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
      { isError: true },
    ).render(160).join("\n");
    assert.equal(rendered, "internal_error: Internal controller error");
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
    { isError: true },
  ).render(600).join("\n");

  assert.ok(rendered.length <= "internal_error: ".length + 240);
  assert.match(rendered, /…$/u);
});

test("send_message 在默认收起上下文中也完整展示消息正文", () => {
  const component = renderAgentToolCall(
    "send_message",
    { agent_id: "agent-1", message: longMessage },
    theme,
    { expanded: false },
  );
  const rendered = component.render(80).join("\n");

  assert.match(rendered, /line-1/);
  assert.match(rendered, /line-6/);
  assert.doesNotMatch(rendered, /expand to view full content/);
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
  ) as {
    content: readonly { readonly type: string; readonly text: string }[];
    details: unknown;
  };

  assert.deepEqual(JSON.parse(result.content[0]!.text), {
    ok: true,
    data: { accepted: true },
    notice: SEND_MESSAGE_HANDOFF_NOTICE,
  });
  assert.deepEqual(result.details, { accepted: true });
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
  ) as {
    content: readonly { readonly type: string; readonly text: string }[];
    details: unknown;
  };

  const parsed = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
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
});
