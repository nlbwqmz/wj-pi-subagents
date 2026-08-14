import assert from "node:assert/strict";
import test from "node:test";
import { AgentTaskMailbox } from "../src/agent-task-mailbox.ts";
import {
  CHILD_REPLY_SCHEMA,
  CHILD_REPLY_VERSION,
  type ChildFinalEnvelope,
} from "../src/child-reply-envelope.ts";

const TASK_1 = "11111111-1111-4111-8111-111111111111";
const TASK_2 = "22222222-2222-4222-8222-222222222222";
const AUTO_TASK = "33333333-3333-4333-8333-333333333333";
const PLACEHOLDER_TASK = "44444444-4444-4444-8444-444444444444";
const TURN_1 = "55555555-5555-4555-8555-555555555555";
const TURN_2 = "66666666-6666-4666-8666-666666666666";
const COMMIT_1 = "77777777-7777-4777-8777-777777777777";
const COMMIT_2 = "88888888-8888-4888-8888-888888888888";
const MESSAGE_1 = "msg_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MESSAGE_2 = "msg_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function mailbox(taskIds = [TASK_1, TASK_2, PLACEHOLDER_TASK]): AgentTaskMailbox {
  let taskIndex = 0;
  let messageIndex = 0;
  const messageIds = [MESSAGE_1, MESSAGE_2];
  return new AgentTaskMailbox({
    taskIdFactory: () => taskIds[taskIndex++]!,
    messageIdFactory: () => messageIds[messageIndex++]!,
  });
}

function final(
  taskId: string,
  turnId: string,
  commitId: string,
  runState: ChildFinalEnvelope["run_state"] = "settled",
  outputState: ChildFinalEnvelope["output_state"] = "present",
): ChildFinalEnvelope {
  return Object.freeze({
    schema: CHILD_REPLY_SCHEMA,
    version: CHILD_REPLY_VERSION,
    kind: "final",
    agent_id: "99999999-9999-4999-8999-999999999999",
    task_id: taskId,
    turn_id: turnId,
    commit_id: commitId,
    run_state: runState,
    output_state: outputState,
    ...(outputState === "present" ? { text: "完成" } : runState === "settled" ? { reason_code: "no_output" as const } : {}),
  });
}

test("并发 submit 在一个任务内分配不同 message_id，并严格选择 prompt 后 steer", () => {
  const value = mailbox();
  const first = value.submit("第一条");
  const second = value.submit("第二条");
  assert.equal(first.task_id, TASK_1);
  assert.equal(second.task_id, TASK_1);
  assert.notEqual(first.message_id, second.message_id);

  const prompt = value.takeNextDelivery();
  assert.equal(prompt?.mode, "prompt");
  assert.equal(value.hostAccepted(prompt!.delivery_id), true);
  value.observeAgentStart();
  const steer = value.takeNextDelivery();
  assert.equal(steer?.mode, "steer");
  assert.equal(value.hostAccepted(steer!.delivery_id), true);
  assert.deepEqual(value.projection(), {
    state: "working",
    mailbox_pending_count: 0,
    host_pending_count: 0,
    reply_outbox_pending_count: 0,
    activity: { phase: "processing", task_id: TASK_1 },
  });
});

test("interrupt 栅栏后的消息获得后继 task_id，当前 final commit 后才允许 prompt", () => {
  const value = mailbox();
  const current = value.submit("当前任务");
  const delivery = value.takeNextDelivery();
  assert.equal(value.hostAccepted(delivery!.delivery_id), true);
  value.observeAgentStart();
  assert.equal(value.observeTaskStarted(current.task_id, TURN_1), true);
  assert.deepEqual(value.requestInterrupt(), { changed: true, should_abort: true });

  const successor = value.submit("后继任务");
  assert.equal(successor.task_id, TASK_2);
  assert.equal(value.takeNextDelivery(), undefined);
  value.observeAgentSettled();
  const interrupted = final(current.task_id, TURN_1, COMMIT_1, "interrupted", "absent");
  assert.equal(value.prepareFinal(interrupted), true);
  assert.equal(value.commitPreparedFinal(COMMIT_1), true);

  const next = value.takeNextDelivery();
  assert.equal(next?.task_id, TASK_2);
  assert.equal(next?.mode, "prompt");
  assert.equal(value.projection().last_task?.outcome, "interrupted");
});

test("新 turn 会作废旧 turn provisional final", () => {
  const value = mailbox([PLACEHOLDER_TASK]);
  value.observeAgentStart();
  assert.equal(value.observeTaskStarted(AUTO_TASK, TURN_1), true);
  value.observeAgentSettled();
  assert.equal(value.prepareFinal(final(AUTO_TASK, TURN_1, COMMIT_1)), true);

  value.observeAgentStart();
  assert.equal(value.observeTaskStarted(AUTO_TASK, TURN_2), true);
  assert.equal(value.isSupersededFinal(final(AUTO_TASK, TURN_1, COMMIT_1)), true);
  value.observeAgentSettled();
  assert.equal(value.prepareFinal(final(AUTO_TASK, TURN_2, COMMIT_2)), true);
  assert.equal(value.commitPreparedFinal(COMMIT_2), true);
  assert.equal(value.projection().last_task?.turn_id, TURN_2);
});

test("直接边协调令牌可叠加，旧交付排空后仍阻止新消息与 final commit", () => {
  const value = mailbox([PLACEHOLDER_TASK]);
  const current = value.submit("屏障前消息");
  const inFlight = value.takeNextDelivery();
  assert.ok(inFlight);

  assert.equal(value.beginCoordinationBarrier("compact-a"), true);
  assert.equal(value.beginCoordinationBarrier("compact-b"), true);
  assert.equal(value.beginCoordinationBarrier("compact-a"), true);
  assert.equal(value.hasCoordinationBarrier(), true);
  assert.equal(value.coordinationBarrierReadiness(), "waiting");

  assert.equal(value.hostAccepted(inFlight!.delivery_id), true);
  assert.equal(value.coordinationBarrierReadiness(), "waiting");
  value.observeAgentStart();
  assert.equal(value.observeTaskStarted(current.task_id, TURN_1), true);
  assert.equal(value.coordinationBarrierReadiness(), "quiescent");

  const queued = value.submit("屏障期间消息");
  assert.equal(queued.task_id, current.task_id);
  assert.equal(value.takeNextDelivery(), undefined);
  value.observeAgentSettled();
  const candidate = final(current.task_id, TURN_1, COMMIT_1);
  assert.equal(value.prepareFinal(candidate), false);
  assert.equal(value.commitPreparedFinal(COMMIT_1), false);

  assert.equal(value.completeCoordinationBarrier("compact-a"), true);
  assert.equal(value.hasCoordinationBarrier(), true);
  assert.equal(value.takeNextDelivery(), undefined);
  assert.equal(value.commitPreparedFinal(COMMIT_1), false);

  assert.equal(value.completeCoordinationBarrier("compact-b"), true);
  assert.equal(value.hasCoordinationBarrier(), false);
  assert.equal(value.prepareFinal(candidate), false);
  const delivery = value.takeNextDelivery();
  assert.equal(delivery?.mode, "prompt");
  assert.equal(delivery?.message_id, queued.message_id);
  assert.equal(value.completeCoordinationBarrier("compact-b"), false);
  assert.equal(value.beginCoordinationBarrier(""), false);
  assert.equal(value.beginCoordinationBarrier("x".repeat(257)), false);
});

test("直接边准备把 delivery uncertainty 与维护失败标记为 unsafe", () => {
  const uncertain = mailbox([PLACEHOLDER_TASK]);
  uncertain.submit("不确定交付");
  const delivery = uncertain.takeNextDelivery();
  assert.ok(delivery);
  assert.equal(uncertain.beginCoordinationBarrier("compact-uncertain"), true);
  assert.equal(uncertain.hostDeliveryUncertain(delivery!.delivery_id), true);
  assert.equal(uncertain.coordinationBarrierReadiness(), "unsafe");

  const failed = mailbox([PLACEHOLDER_TASK]);
  failed.submit("压缩失败");
  const first = failed.takeNextDelivery();
  assert.ok(first);
  assert.equal(failed.hostAccepted(first!.delivery_id), true);
  failed.observeCompactionStart("overflow");
  failed.observeCompactionEnd("overflow", true);
  assert.equal(failed.beginCoordinationBarrier("compact-failed"), true);
  assert.equal(failed.coordinationBarrierReadiness(), "unsafe");
});

test("native 压缩不猜测续跑，在新的真实 start 前不投递 mailbox", () => {
  const value = mailbox([PLACEHOLDER_TASK]);
  const current = value.submit("原任务");
  const first = value.takeNextDelivery();
  assert.equal(value.hostAccepted(first!.delivery_id), true);
  value.observeAgentStart();
  value.observeTaskStarted(current.task_id, TURN_1);

  value.observeCompactionStart("threshold");
  const queued = value.submit("压缩期间消息");
  assert.equal(queued.task_id, current.task_id);
  value.observeCompactionEnd("threshold", false);
  assert.equal(value.takeNextDelivery(), undefined);

  value.observeAgentStart();
  value.observeTaskStarted(current.task_id, TURN_2);
  const resumed = value.takeNextDelivery();
  assert.equal(resumed?.mode, "steer");
  assert.equal(resumed?.task_id, current.task_id);
});

test("native 压缩后若 Pi 已 settled，mailbox 使用 prompt 启动后续任务", () => {
  const value = mailbox([PLACEHOLDER_TASK]);
  const current = value.submit("原任务");
  const first = value.takeNextDelivery();
  assert.equal(value.hostAccepted(first!.delivery_id), true);
  value.observeAgentStart();
  value.observeTaskStarted(current.task_id, TURN_1);
  value.observeCompactionStart("threshold");
  const queued = value.submit("压缩后的新消息");
  assert.equal(queued.task_id, current.task_id);
  value.observeCompactionEnd("threshold", false);
  value.observeAgentSettled();

  const next = value.takeNextDelivery();
  assert.equal(next?.mode, "prompt");
  assert.equal(next?.task_id, current.task_id);
});

test("threshold 压缩保留旧 turn 候选，但必须等真实 settled 才能提交", () => {
  const value = mailbox([PLACEHOLDER_TASK]);
  const current = value.submit("阈值压缩任务");
  const first = value.takeNextDelivery();
  assert.equal(value.hostAccepted(first!.delivery_id), true);
  value.observeAgentStart();
  value.observeTaskStarted(current.task_id, TURN_1);
  const candidate = final(current.task_id, TURN_1, COMMIT_1);
  assert.equal(value.prepareFinal(candidate), false);

  value.observeCompactionStart("threshold");
  value.observeCompactionEnd("threshold", false, false);
  assert.equal(value.prepareFinal(candidate), false);
  assert.equal(value.commitPreparedFinal(COMMIT_1), false);

  value.observeAgentSettled();
  assert.equal(value.prepareFinal(candidate), true);
  assert.equal(value.commitPreparedFinal(COMMIT_1), true);
  assert.equal(value.projection().last_task?.commit_id, COMMIT_1);
});

test("overflow willRetry 撤销旧候选并由下一真实 turn 取代", () => {
  const value = mailbox([PLACEHOLDER_TASK]);
  const current = value.submit("溢出恢复任务");
  const first = value.takeNextDelivery();
  assert.equal(value.hostAccepted(first!.delivery_id), true);
  value.observeAgentStart();
  value.observeTaskStarted(current.task_id, TURN_1);
  assert.equal(value.prepareFinal(final(current.task_id, TURN_1, COMMIT_1)), false);

  value.observeCompactionStart("overflow");
  value.observeCompactionEnd("overflow", false, true);
  assert.equal(value.observeAgentSettled(), "superseded");
  assert.equal(value.prepareFinal(final(current.task_id, TURN_1, COMMIT_1)), false);
  value.observeAgentStart();
  value.observeTaskStarted(current.task_id, TURN_2);
  assert.equal(value.isSupersededFinal(final(current.task_id, TURN_1, COMMIT_1)), true);
  value.observeAgentSettled();
  assert.equal(value.prepareFinal(final(current.task_id, TURN_2, COMMIT_2)), true);
  assert.equal(value.commitPreparedFinal(COMMIT_2), true);
  assert.equal(value.projection().last_task?.turn_id, TURN_2);
});

test("automatic compaction failure 与 delivery uncertainty 都不自动重投递", () => {
  const failed = mailbox([PLACEHOLDER_TASK]);
  failed.submit("压缩失败任务");
  const first = failed.takeNextDelivery();
  assert.equal(failed.hostAccepted(first!.delivery_id), true);
  failed.observeCompactionStart("overflow");
  failed.observeCompactionEnd("overflow", true, false);
  assert.equal(failed.projection().state, "suspended");
  assert.equal(failed.projection().activity?.phase, "maintenance_failed");
  assert.equal(failed.takeNextDelivery(), undefined);

  const uncertain = mailbox([PLACEHOLDER_TASK]);
  uncertain.submit("不确定交付");
  const delivery = uncertain.takeNextDelivery();
  assert.equal(uncertain.hostDeliveryUncertain(delivery!.delivery_id), true);
  assert.equal(uncertain.projection().activity?.phase, "delivery_uncertain");
  assert.equal(uncertain.takeNextDelivery(), undefined);
});

test("delivery uncertainty 只由匹配任务的真实 task_started 收敛", () => {
  const value = mailbox([TASK_1]);
  const submission = value.submit("可能已被 Pi 接纳");
  const delivery = value.takeNextDelivery();
  assert.ok(delivery);
  assert.equal(value.hostDeliveryUncertain(delivery!.delivery_id), true);
  assert.equal(value.projection().state, "suspended");

  assert.equal(value.observeTaskStarted(TASK_2, TURN_1), false);
  assert.equal(value.projection().state, "suspended");
  assert.equal(value.observeTaskStarted(submission.task_id, TURN_1), true);
  assert.deepEqual(value.projection(), {
    state: "working",
    mailbox_pending_count: 0,
    host_pending_count: 0,
    reply_outbox_pending_count: 0,
    activity: { phase: "processing", task_id: TASK_1 },
  });
  assert.equal(value.takeNextDelivery(), undefined);
});

test("final 在 settlement 前只能 prepare，父端接纳与 settlement 都满足后才能 commit", () => {
  const value = mailbox([PLACEHOLDER_TASK]);
  value.observeAgentStart();
  assert.equal(value.observeTaskStarted(AUTO_TASK, TURN_1), true);
  const candidate = final(AUTO_TASK, TURN_1, COMMIT_1);
  assert.equal(value.prepareFinal(candidate), false);
  assert.equal(value.commitPreparedFinal(COMMIT_1), false);
  assert.equal(value.projection().state, "working");
  assert.equal(value.projection().reply_outbox_pending_count, 1);

  value.observeAgentSettled();
  assert.equal(value.prepareFinal(candidate), true);
  assert.equal(value.projection().activity?.phase, "waiting_parent_ack");
  assert.equal(value.commitPreparedFinal(COMMIT_1), true);
  assert.equal(value.projection().state, "idle");
});

test("raw settlement 先于 task_started 时保持可对齐的非 idle 候选", () => {
  const value = mailbox([PLACEHOLDER_TASK]);
  assert.equal(value.observeAgentSettled(), "candidate");
  assert.equal(value.projection().state, "working");
  assert.equal(value.projection().reply_outbox_pending_count, 1);
  assert.equal(value.projection().activity?.phase, "finalizing");

  assert.equal(value.observeTaskStarted(AUTO_TASK, TURN_1), true);
  const candidate = final(AUTO_TASK, TURN_1, COMMIT_1);
  assert.equal(value.prepareFinal(candidate), true);
  assert.equal(value.commitPreparedFinal(COMMIT_1), true);
  assert.equal(value.projection().state, "idle");
});
