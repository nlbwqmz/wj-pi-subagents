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

test("子端始终尝试父端提交，单次失败不建立持久屏障", async () => {
  let attempts = 0;
  let failNext = true;
  const coordinator = new ChildReplyCoordinator({
    agentId: AGENT_ID,
    port: {
      async publishReply(): Promise<void> {
        attempts += 1;
        if (failNext) throw new Error("父端不可用");
      },
    },
  });
  coordinator.observeAgentStart();

  const failed = await coordinator.normalReply({ message: "提交失败" });
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.equal(failed.error.code, "message_delivery_failed");
  assert.equal(attempts, 1);

  failNext = false;
  assert.deepEqual(await coordinator.normalReply({ message: "失败后继续提交" }), {
    ok: true,
    data: { accepted: true },
  });
  assert.equal(attempts, 2);
});
test("父端 fire-and-forget 提交决定消息事件，context/UI 异常不撤销已提交事实", () => {
  const delivered: Array<{ readonly customType: string; readonly text: string }> = [];
  const events: string[] = [];
  let throwFromObserver = true;
  const inbox = new ParentReplyInbox({
    readApi: () => ({
      sendMessage(message: unknown, options?: unknown): void {
        const record = message as { customType: string; content: readonly { text: string }[] };
        delivered.push({ customType: record.customType, text: record.content[0]!.text });
        assert.deepEqual(options, { triggerTurn: true, deliverAs: "steer" });
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

  let synchronousFailures = 0;
  const rejectingInbox = new ParentReplyInbox({
    readApi: () => ({
      sendMessage: () => {
        synchronousFailures += 1;
        throw new Error("扩展消息 API 尚未绑定");
      },
    }),
  });
  assert.equal(rejectingInbox.accept(AGENT_ID, reply), false);
  assert.equal(rejectingInbox.acceptTerminal(AGENT_ID), false);
  assert.equal(synchronousFailures, 2);

  const terminalMessages: string[] = [];
  const terminalInbox = new ParentReplyInbox({
    readApi: () => ({
      sendMessage(message: unknown): void {
        const record = message as { customType: string };
        terminalMessages.push(record.customType);
      },
    }),
  });
  assert.equal(terminalInbox.acceptTerminal(AGENT_ID), true);
  assert.deepEqual(terminalMessages, [WJ_PI_SUBAGENTS_TERMINAL_TYPE]);
});
