import assert from "node:assert/strict";
import test from "node:test";
import {
  renderAgentToolCall,
  renderAgentToolResult,
} from "../src/agent-tool-rendering.ts";
import { createAgentFault } from "../src/agent-snapshot-codec.ts";
import { controlFailure } from "../src/tree-controller.ts";

const theme = {
  fg: (_color: string, text: string): string => text,
  bold: (text: string): string => text,
};

const longMessage = [
  "line-1",
  "line-2",
  "line-3",
  "line-4",
  "line-5",
  "line-6",
].join("\n");

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
