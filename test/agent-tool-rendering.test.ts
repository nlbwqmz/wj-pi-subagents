import assert from "node:assert/strict";
import test from "node:test";
import { renderAgentToolCall } from "../src/agent-tool-rendering.ts";

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
