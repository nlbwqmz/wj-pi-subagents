import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_TOOL_NAMES,
  CHILD_REPLY_TOOL_NAME,
  registerAgentTools,
  registerReplyToParentTool,
  SubagentToolError,
} from "../src/agent-tools.ts";
import { displayWidth } from "../src/agent-tree-ui.ts";

const RENDER_THEME = Object.freeze({
  fg: (_color: string, text: string): string => text,
  bold: (text: string): string => text,
});

type ToolCallRenderer = (
  args: unknown,
  theme: typeof RENDER_THEME,
  context: { readonly expanded?: boolean; readonly lastComponent?: unknown },
) => {
  render(width: number): string[];
  invalidate(): void;
};

function toolCallRenderer(
  registrations: readonly Record<string, unknown>[],
  name: string,
): ToolCallRenderer {
  const tool = registrations.find((candidate) => candidate.name === name);
  assert.ok(tool, `未注册工具 ${name}`);
  assert.equal(typeof tool.renderCall, "function");
  return tool.renderCall as ToolCallRenderer;
}

test("公开注册入口一次注册完整八工具集合并说明模板选择契约", () => {
  const registrations: Array<Record<string, unknown>> = [];
  const names = registerAgentTools({ registerTool: (tool) => registrations.push(tool as Record<string, unknown>) }, async () => ({
    getAgentTree: () => ({ ok: true, data: { nodes: [] } }),
  } as never));

  assert.deepEqual(names, AGENT_TOOL_NAMES);
  assert.deepEqual(registrations.map((tool) => tool.name), [...AGENT_TOOL_NAMES]);
  for (const tool of registrations) {
    assert.equal(tool.executionMode, "sequential");
    assert.equal(typeof tool.execute, "function");
    assert.equal(typeof tool.parameters, "object");
    assert.equal(typeof tool.renderCall, "function");
  }

  const spawnTool = registrations.find((tool) => tool.name === "spawn_agent");
  assert.ok(spawnTool);
  assert.match(String(spawnTool.description), /get_agent_templates/);
  assert.match(String(spawnTool.description), /区分大小写/);
  assert.match(String(spawnTool.description), /\[\]/);
  assert.match(String(spawnTool.description), /不能调用|不得调用/);

  const parameters = spawnTool.parameters as {
    readonly properties?: { readonly template_id?: { readonly description?: string } };
  };
  assert.match(parameters.properties?.template_id?.description ?? "", /get_agent_templates/);
  assert.match(parameters.properties?.template_id?.description ?? "", /完全一致|精确/);
});

test("代理工具调用行显示入参，并安全折叠长消息和图片 payload", () => {
  const registrations: Array<Record<string, unknown>> = [];
  registerAgentTools({ registerTool: (tool) => registrations.push(tool as Record<string, unknown>) }, async () => ({} as never));
  const agentId = "550e8400-e29b-41d4-a716-446655440000";

  const waitLines = toolCallRenderer(registrations, "wait_agent")(
    { agent_id: agentId, timeout_ms: 600_000 },
    RENDER_THEME,
    {},
  ).render(80);
  const waitDisplay = waitLines.join("\n");
  assert.match(waitDisplay, /wait_agent/);
  assert.match(waitDisplay, new RegExp(agentId));
  assert.match(waitDisplay, /600000/);

  const base64Canary = "DO_NOT_RENDER_BASE64";
  const messageTail = "完整消息尾部";
  const message = `开头\u001b[31m\u202e${"消息内容".repeat(40)}${messageTail}`;
  const sendRenderer = toolCallRenderer(registrations, "send_message");
  const collapsedLines = sendRenderer({
    agent_id: agentId,
    message,
    images: [{ type: "image", data: base64Canary, mimeType: "image/png" }],
  }, RENDER_THEME, {}).render(36);
  const collapsedDisplay = collapsedLines.join("\n");
  assert.match(collapsedDisplay, /send_message/);
  assert.ok(collapsedDisplay.replaceAll(/\s/gu, "").includes(agentId));
  assert.match(collapsedDisplay, /展开查看完整入参/);
  assert.doesNotMatch(collapsedDisplay, new RegExp(base64Canary));
  assert.equal(collapsedDisplay.includes("\u001b"), false);
  assert.equal(collapsedDisplay.includes("\u202e"), false);
  assert.ok(collapsedLines.length <= 7);

  const expandedLines = sendRenderer({
    agent_id: agentId,
    message,
    images: [{ type: "image", data: base64Canary, mimeType: "image/png" }],
  }, RENDER_THEME, { expanded: true }).render(36);
  const expandedDisplay = expandedLines.join("\n");
  assert.match(expandedDisplay, new RegExp(messageTail));
  assert.match(expandedDisplay.replaceAll(/\s/gu, ""), /<已省略\d+个base64字符>/);
  assert.doesNotMatch(expandedDisplay, new RegExp(base64Canary));
  assert.equal(expandedDisplay.includes("\u001b"), false);
  assert.equal(expandedDisplay.includes("\u202e"), false);

  for (const line of waitLines) {
    assert.ok(displayWidth(line) <= 80, `工具调用行超出终端宽度：${line}`);
  }
  for (const line of [...collapsedLines, ...expandedLines]) {
    assert.ok(displayWidth(line) <= 36, `工具调用行超出终端宽度：${line}`);
  }
});

test("reply_to_parent 也使用相同的入参渲染", () => {
  const registrations: Array<Record<string, unknown>> = [];
  registerReplyToParentTool({ registerTool: (tool) => registrations.push(tool as Record<string, unknown>) }, async () => undefined);
  const lines = toolCallRenderer(registrations, CHILD_REPLY_TOOL_NAME)(
    { message: "正在检查调用参数展示" },
    RENDER_THEME,
    {},
  ).render(80);

  assert.match(lines.join("\n"), /reply_to_parent/);
  assert.match(lines.join("\n"), /正在检查调用参数展示/);
});

test("get_agent_templates 直接返回安全模板数组并保留空数组", async () => {
  const registrations: Array<Record<string, unknown>> = [];
  const populated = Object.freeze([Object.freeze({
    template_id: "Explore",
    description: "Fast codebase exploration agent (read-only)",
    tools: Object.freeze(["read", "bash", "grep", "find", "ls"]),
  })]);
  let current: readonly unknown[] = populated;
  registerAgentTools({ registerTool: (tool) => registrations.push(tool as Record<string, unknown>) }, async () => ({
    getAgentTemplates: async () => ({ ok: true, data: current }),
  } as never));
  const templatesTool = registrations.find((tool) => tool.name === "get_agent_templates");
  assert.ok(templatesTool);
  const execute = templatesTool.execute as (...args: unknown[]) => Promise<{
    readonly content: readonly { readonly type: string; readonly text: string }[];
    readonly details: unknown;
  }>;

  const listed = await execute("call", {}, undefined, undefined, {});
  assert.equal(listed.content[0]?.text, JSON.stringify(populated));
  assert.deepEqual(listed.details, populated);
  assert.doesNotMatch(listed.content[0]?.text ?? "", /body|source|model|thinking/i);

  current = Object.freeze([]);
  const empty = await execute("call-empty", {}, undefined, undefined, {});
  assert.equal(empty.content[0]?.text, "[]");
  assert.deepEqual(empty.details, []);

  await assert.rejects(
    execute("call-invalid", { scope: "all" }, undefined, undefined, {}),
    (error: unknown) => error instanceof SubagentToolError && error.code === "invalid_argument",
  );
});

test("控制器失败映射为稳定 SubagentToolError 而不暴露异常", async () => {
  const registrations: Array<Record<string, unknown>> = [];
  registerAgentTools({ registerTool: (tool) => registrations.push(tool as Record<string, unknown>) }, async () => ({
    getAgentTree: () => ({ ok: false, error: {
      code: "agent_not_found",
      message: "代理标识未注册",
      retryable: false,
      details: {},
    } }),
  } as never));
  const treeTool = registrations.find((tool) => tool.name === "get_agent_tree");
  assert.ok(treeTool);
  const execute = treeTool?.execute as (...args: unknown[]) => Promise<unknown>;
  await assert.rejects(
    execute("call", {}, undefined, undefined, {}),
    (error: unknown) => error instanceof SubagentToolError
      && error.code === "agent_not_found"
      && !String(error).includes("stack"),
  );
});

test("get_agent_tree 在执行层拒绝任何调用方指定的范围", async () => {
  const registrations: Array<Record<string, unknown>> = [];
  registerAgentTools({ registerTool: (tool) => registrations.push(tool as Record<string, unknown>) }, async () => ({
    getAgentTree: () => ({ ok: true, data: { scope: { kind: "root" }, nodes: [] } }),
  } as never));
  const treeTool = registrations.find((tool) => tool.name === "get_agent_tree");
  assert.ok(treeTool);
  const execute = treeTool?.execute as (...args: unknown[]) => Promise<unknown>;
  await assert.rejects(
    execute("call", { agent_id: "550e8400-e29b-41d4-a716-446655440000" }, undefined, undefined, {}),
    (error: unknown) => error instanceof SubagentToolError
      && error.code === "invalid_argument"
      && String(error).includes('"details":{}'),
  );
});
