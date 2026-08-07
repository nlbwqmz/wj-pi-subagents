import assert from "node:assert/strict";
import test from "node:test";
import {
  ChildReplyCoordinator,
  type ChildReplyPort,
} from "../src/child-reply-coordinator.ts";
import {
  ParentReplyInbox,
  createVisibleEnvelope,
} from "../src/parent-reply-inbox.ts";

class RecordingPort implements ChildReplyPort {
  readonly replies: Array<Record<string, unknown>> = [];
  private pending: Array<() => void> = [];

  publishReplyAndWaitForAck(reply: Record<string, unknown>): Promise<void> {
    this.replies.push(reply);
    return new Promise<void>((resolve) => this.pending.push(resolve));
  }

  acknowledgeAll(): void {
    for (const resolve of this.pending.splice(0)) resolve();
  }
}

class RejectingPort implements ChildReplyPort {
  calls = 0;

  async publishReplyAndWaitForAck(): Promise<void> {
    this.calls += 1;
    throw new Error("父端未确认");
  }
}

test("过程 assistant 输出只缓存最终候选，显式回复和 settled final 分类有序", async () => {
  const port = new RecordingPort();
  const coordinator = new ChildReplyCoordinator({ port });
  coordinator.observeAgentStart();
  coordinator.observeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "toolUse",
      content: [{ type: "text", text: "我先检查文件" }, { type: "toolCall", id: "1", name: "read" }],
    },
  });
  const progress = coordinator.replyToParent({ message: "正在读取文件，完成后继续。" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(port.replies, [{ kind: "message", text: "正在读取文件，完成后继续。" }]);
  port.acknowledgeAll();
  assert.deepEqual(await progress, { ok: true, data: { accepted: true } });

  coordinator.observeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "最终结果" }],
    },
  });
  const settled = coordinator.settle();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(port.replies[1], { kind: "final", text: "最终结果" });
  port.acknowledgeAll();
  await settled;
  await coordinator.settle();
  assert.equal(port.replies.length, 2);
});

test("没有安全最终候选时发送空 final fence，确认失败只通知运行时一次", async () => {
  const port = new RecordingPort();
  const coordinator = new ChildReplyCoordinator({ port });
  coordinator.observeAgentStart();
  coordinator.observeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "toolUse",
      content: [
        { type: "thinking", thinking: "不得上行" },
        { type: "text", text: "工具前说明不得成为 final" },
        { type: "toolCall", id: "1", name: "read", arguments: {} },
      ],
    },
  });
  const settled = coordinator.settle();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(port.replies, [{ kind: "final", text: "" }]);
  port.acknowledgeAll();
  await settled;

  const rejectingPort = new RejectingPort();
  let failures = 0;
  const rejecting = new ChildReplyCoordinator({
    port: rejectingPort,
    onFinalFailure: () => { failures += 1; },
  });
  rejecting.observeAgentStart();
  await assert.rejects(rejecting.settle(), /子代理最终回复未获父会话确认/);
  await rejecting.settle();
  assert.equal(rejectingPort.calls, 1);
  assert.equal(failures, 1);
});

test("父端 inbox 把类别写入模型可见信封，并只让工作中消息唤醒 wait", () => {
  const sent: Array<{ message: unknown; options: unknown }> = [];
  const notified: string[] = [];
  const inbox = new ParentReplyInbox({
    readApi: () => ({ sendMessage: (message, options) => sent.push({ message, options }) }),
    notifyMessage: (agentId) => notified.push(agentId),
  });
  const agentId = "550e8400-e29b-41d4-a716-446655440000";
  assert.equal(inbox.accept(agentId, { kind: "message", text: "阶段发现" }), true);
  assert.equal(inbox.accept(agentId, { kind: "final", text: "完整结果" }), true);
  assert.equal(inbox.accept(agentId, { kind: "final", text: "" }), true);
  assert.equal(sent.length, 2);
  assert.equal((sent[0]!.message as { content: Array<{ text: string }> }).content[0]!.text,
    createVisibleEnvelope(agentId, "message", "阶段发现"));
  assert.deepEqual(sent.map((entry) => entry.options), [
    { triggerTurn: false, deliverAs: "steer" },
    { triggerTurn: true, deliverAs: "steer" },
  ]);
  assert.deepEqual(notified, [agentId]);
});
