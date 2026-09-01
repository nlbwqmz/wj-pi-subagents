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
import { AgentController } from "../src/agent-controller.ts";
import { createAgentFault } from "../src/agent-snapshot-codec.ts";
import { registerAgentTools } from "../src/agent-tools.ts";
import { controlFailure, TreeController } from "../src/tree-controller.ts";

const theme = {
  fg: (_color: string, text: string): string => text,
  bold: (text: string): string => text,
};

interface RegisteredAgentTool {
  readonly name: string;
  readonly prepareArguments?: (args: unknown) => unknown;
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

test("wait_agent 对合法但不存在的 UUID 映射 agent_not_found", async () => {
  const controller = makeEmptyController();
  const missingAgentId = "0c490542-8355-4df3-922d-994800000000";
  const params = {
    agent_ids: [missingAgentId],
    timeout_ms: 10_000,
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

test("wait_agent 对真正非法参数映射 invalid_argument", async () => {
  const controller = makeEmptyController();
  const malformedAgentId = "0c490542-8355-4df3-922d9948";
  const params = {
    agent_ids: [malformedAgentId],
    timeout_ms: 10_000,
  };
  const controllerResult = await controller.waitAgents(params);
  assert.equal(controllerResult.ok, false);
  if (!controllerResult.ok) assert.equal(controllerResult.error.code, "invalid_argument");

  const tool = registeredTool(controller, "wait_agent");
  assert.ok(tool.prepareArguments);
  let preparedError: string | undefined;
  try {
    tool.prepareArguments(params);
  } catch (error) {
    preparedError = error instanceof Error ? error.message : String(error);
  }
  assert.match(preparedError ?? "", /invalid_argument/);
  assert.equal(
    renderRegisteredError(tool, preparedError ?? "", params),
    "invalid_argument: Invalid argument",
  );

  const executeText = await executeRegisteredTool(tool, params);
  assert.match(executeText, /invalid_argument/);
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
