import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeAssistantMessageEnd,
  normalizeRpcBridgeEvent,
} from "../src/rpc-bridge-event.ts";

test("真正 child 回复端点只公开文本，明确丢弃 thinking、toolCall 和图片内容", () => {
  const result = normalizeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      provider: "不得透传",
      content: [
        { type: "thinking", thinking: "不得透传的思考" },
        { type: "text", text: "完成", signature: "不得透传" },
        { type: "toolCall", id: "call-secret", name: "apply_patch", arguments: { secret: true } },
        { type: "image", data: "YWJj", mimeType: "image/png", source: "不得透传" },
      ],
    },
  });

  assert.deepEqual(result, {
    kind: "event",
    event: {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "完成" },
        ],
      },
    },
  });
});

test("任务桥接公开无载荷 agent_start 事实并剥离其余字段", () => {
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "agent_start",
    prompt: "不得透传",
    session: { secret: true },
  }), {
    kind: "event",
    event: { type: "agent_start" },
  });
});

test("任务桥接忽略全部 message_end，真正 child 回复端点仍拒绝未知内容块", () => {
  assert.deepEqual(normalizeRpcBridgeEvent({ type: "message_update", delta: "忽略" }), {
    kind: "ignored",
  });
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "future_secret_block", secret: "不得静默丢弃" }],
    },
  }), {
    kind: "ignored",
  });
  assert.deepEqual(normalizeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "future_secret_block", secret: "不得静默丢弃" }],
    },
  }), {
    kind: "invalid",
  });
  assert.deepEqual(normalizeAssistantMessageEnd({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: 42 }] },
  }), {
    kind: "invalid",
  });
});

test("真正 child 端忽略非 assistant 的 message_end，不把它当成直接回复或协议故障", () => {
  assert.deepEqual(normalizeAssistantMessageEnd({
    type: "message_end",
    message: { role: "toolResult", content: [{ type: "text", text: "工具结果" }] },
  }), {
    kind: "ignored",
  });
});
