import assert from "node:assert/strict";
import test from "node:test";
import {
  CHILD_REPLY_SCHEMA,
  CHILD_REPLY_VERSION,
  CHILD_TERMINAL_SCHEMA,
  encodeChildReplyEnvelope,
  parseChildReplyEnvelope,
  parseTerminalNotice,
  type ChildReplyEnvelope,
} from "../src/child-reply-envelope.ts";
import {
  ChildReplyCoordinator,
  type ChildReplyPort,
} from "../src/child-reply-coordinator.ts";
import {
  ParentReplyInbox,
  WJ_PI_SUBAGENTS_FINAL_TYPE,
  WJ_PI_SUBAGENTS_MESSAGE_TYPE,
  WJ_PI_SUBAGENTS_TERMINAL_TYPE,
} from "../src/parent-reply-inbox.ts";

const AGENT_ID = "550e8400-e29b-41d4-a716-446655440000";

function envelope(kind: ChildReplyEnvelope["kind"], text = "消息"): ChildReplyEnvelope {
  return {
    schema: CHILD_REPLY_SCHEMA,
    version: CHILD_REPLY_VERSION,
    kind,
    agent_id: AGENT_ID,
    text,
  } as ChildReplyEnvelope;
}

test("新消息信封只接受 message/final_report 闭集并拒绝旧字段", () => {
  const message = parseChildReplyEnvelope(envelope("message", "进度"));
  const report = parseChildReplyEnvelope(envelope("final_report", "报告"));
  assert.equal(message?.kind, "message");
  assert.equal(report?.kind, "final_report");
  assert.deepEqual(JSON.parse(encodeChildReplyEnvelope(report!)), report);

  assert.equal(parseChildReplyEnvelope({
    ...envelope("message"),
    task_id: "旧任务",
  }), undefined);
  assert.equal(parseChildReplyEnvelope({
    schema: "wj-pi-subagents.reply",
    version: 5,
    kind: "final",
    agent_id: AGENT_ID,
    task_id: "旧任务",
    turn_id: "旧回合",
    commit_id: "旧提交",
    text: "不应解析",
  }), undefined);
  assert.equal(parseTerminalNotice({
    schema: CHILD_TERMINAL_SCHEMA,
    version: CHILD_REPLY_VERSION,
    kind: "terminal",
    agent_id: AGENT_ID,
    state: "failed",
    error_code: "runtime_fault",
    task_id: "旧字段",
  }), undefined);
});

test("显式 normal_reply 和 final_report 可在同一活动回合交错多次发送", async () => {
  const sent: ChildReplyEnvelope[] = [];
  let failNext = false;
  const port: ChildReplyPort = {
    async publishReply(reply): Promise<void> {
      if (failNext) {
        failNext = false;
        throw new Error("父端拒绝");
      }
      sent.push(reply);
    },
  };
  const coordinator = new ChildReplyCoordinator({ agentId: AGENT_ID, port });

  coordinator.observeAgentStart();
  assert.deepEqual(await coordinator.normalReply({ message: "一" }), { ok: true, data: { accepted: true } });
  assert.deepEqual(await coordinator.finalReport({ message: "报告一" }), { ok: true, data: { accepted: true } });
  assert.deepEqual(await coordinator.finalReport({ message: "报告二" }), { ok: true, data: { accepted: true } });
  assert.deepEqual(await coordinator.normalReply({ message: "二" }), { ok: true, data: { accepted: true } });
  assert.deepEqual(sent.map((item) => [item.kind, item.text]), [
    ["message", "一"],
    ["final_report", "报告一"],
    ["final_report", "报告二"],
    ["message", "二"],
  ]);

  failNext = true;
  const failed = await coordinator.finalReport({ message: "发送失败" });
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.equal(failed.error.code, "message_delivery_failed");
  assert.deepEqual(await coordinator.normalReply({ message: "失败后仍可继续" }), {
    ok: true,
    data: { accepted: true },
  });

  coordinator.observeAssistantMessageEnd({ type: "message_end" });
  coordinator.observeAgentEnd();
  coordinator.settle();
  const afterNaturalStop = await coordinator.finalReport({ message: "不应自动续发" });
  assert.equal(afterNaturalStop.ok, false);
  if (!afterNaturalStop.ok) assert.equal(afterNaturalStop.error.code, "message_delivery_failed");
});

test("压缩或协调压缩屏障返回 compaction_active，普通传输失败仍保持原错误", async () => {
  const coordinator = new ChildReplyCoordinator({
    agentId: AGENT_ID,
    port: {
      async publishReply(): Promise<void> {
        throw new Error("父端不可用");
      },
    },
  });
  coordinator.observeAgentStart();
  coordinator.observeCompactionStart("threshold");
  const localBlocked = await coordinator.normalReply({ message: "压缩期间消息" });
  assert.equal(localBlocked.ok, false);
  if (!localBlocked.ok) assert.equal(localBlocked.error.code, "compaction_active");
  coordinator.observeCompactionEnd("threshold");

  coordinator.beginCoordinationBarrier("parent-compaction");
  const coordinatedBlocked = await coordinator.finalReport({ message: "协调屏障期间报告" });
  assert.equal(coordinatedBlocked.ok, false);
  if (!coordinatedBlocked.ok) assert.equal(coordinatedBlocked.error.code, "compaction_active");
  coordinator.completeCoordinationBarrier("parent-compaction", "succeeded");

  const failed = await coordinator.normalReply({ message: "普通失败" });
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.equal(failed.error.code, "message_delivery_failed");
});
test("父端 Pi 同步接纳决定消息事件，context/UI 异常不撤销已接纳事实", () => {
  const delivered: Array<{ readonly customType: string; readonly text: string }> = [];
  const events: string[] = [];
  let throwFromObserver = true;
  const inbox = new ParentReplyInbox({
    readApi: () => ({
      sendMessage(message: unknown): { readonly ok: true; readonly accepted: true } {
        const record = message as { customType: string; content: readonly { text: string }[] };
        delivered.push({ customType: record.customType, text: record.content[0]!.text });
        return { ok: true, accepted: true };
      },
    }),
    readSenderName: () => { throw new Error("UI 尚未准备"); },
    onSessionEvent: (_agentId, event) => {
      events.push(event);
      if (throwFromObserver) {
        throwFromObserver = false;
        throw new Error("context 观察失败");
      }
    },
  });

  const reply = envelope("message", "父端可见消息");
  assert.equal(inbox.accept(AGENT_ID, reply), true);
  assert.equal(inbox.accept(AGENT_ID, envelope("final_report", "父端可见报告")), true);
  inbox.observeContext(new Error("延迟 context"));
  assert.deepEqual(delivered.map((item) => item.customType), [
    WJ_PI_SUBAGENTS_MESSAGE_TYPE,
    WJ_PI_SUBAGENTS_FINAL_TYPE,
  ]);
  assert.deepEqual(events, ["reply", "final_report"]);

  const barrierInbox = new ParentReplyInbox({
    readApi: () => ({
      sendMessage: () => {
        throw new Error("压缩期间不应调用父端 Pi");
      },
    }),
  });
  barrierInbox.beginSessionCompactionBarrier("parent-compaction");
  assert.deepEqual(barrierInbox.acceptResult(AGENT_ID, reply), {
    accepted: false,
    blocked_reason: "compaction_active",
  });
  assert.equal(barrierInbox.accept(AGENT_ID, reply), false);
  barrierInbox.completeSessionCompactionBarrier("parent-compaction");
  barrierInbox.observeCompactionStart();
  assert.deepEqual(barrierInbox.acceptResult(AGENT_ID, reply), {
    accepted: false,
    blocked_reason: "compaction_active",
  });
  barrierInbox.observeCompactionEnd();

  const rejectingInbox = new ParentReplyInbox({
    readApi: () => ({ sendMessage: () => ({ ok: false, accepted: false }) }),
  });
  assert.equal(rejectingInbox.accept(AGENT_ID, reply), false);
  assert.equal(rejectingInbox.acceptTerminal(AGENT_ID), false);

  const terminalMessages: string[] = [];
  const terminalInbox = new ParentReplyInbox({
    readApi: () => ({
      sendMessage(message: unknown): { readonly accepted: true } {
        const record = message as { customType: string };
        terminalMessages.push(record.customType);
        return { accepted: true };
      },
    }),
  });
  assert.equal(terminalInbox.acceptTerminal(AGENT_ID), true);
  assert.deepEqual(terminalMessages, [WJ_PI_SUBAGENTS_TERMINAL_TYPE]);
});
