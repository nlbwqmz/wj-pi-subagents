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

test("直接边协调令牌可叠加，未接纳交付阻止 prepare，接纳后允许预检启动窗口", () => {
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
  assert.equal(value.coordinationBarrierReadiness(), "quiescent");
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

test("协调压缩的 provisional settled 期间接纳消息仍延续当前逻辑任务", () => {
  const value = mailbox();
  const current = value.submit("进入协调压缩的任务");
  const initial = value.takeNextDelivery();
  assert.equal(value.hostAccepted(initial!.delivery_id), true);
  value.observeAgentStart();
  assert.equal(value.observeTaskStarted(current.task_id, TURN_1), true);

  assert.equal(value.beginCoordinationBarrier("compact-continuation"), true);
  assert.equal(value.observeAgentSettled(), "candidate");
  const queued = value.submit("压缩完成后继续当前任务");
  assert.equal(queued.task_id, current.task_id);
  assert.equal(value.takeNextDelivery(), undefined);
  assert.deepEqual(value.projection(), {
    state: "working",
    mailbox_pending_count: 1,
    host_pending_count: 0,
    reply_outbox_pending_count: 1,
    activity: { phase: "reconciling", task_id: current.task_id },
  });

  assert.equal(value.completeCoordinationBarrier("compact-continuation", "succeeded"), true);
  assert.equal(value.takeNextDelivery(), undefined);
  value.observeCompactionStart("manual", true);
  value.observeCompactionEnd("manual", false, false, true);
  const resumed = value.takeNextDelivery();
  assert.equal(resumed?.message_id, queued.message_id);
  assert.equal(resumed?.task_id, current.task_id);
  assert.equal(resumed?.mode, "prompt");
});

test("协调完成声明 continuation 时，屏障前消息等待真实 start 后以 steer 投递", () => {
  const value = mailbox();
  const current = value.submit("进入协调压缩的任务");
  const initial = value.takeNextDelivery();
  assert.equal(value.hostAccepted(initial!.delivery_id), true);
  value.observeAgentStart();
  assert.equal(value.observeTaskStarted(current.task_id, TURN_1), true);

  assert.equal(value.beginCoordinationBarrier("compact-owned-continuation"), true);
  const queued = value.submit("settled 之前进入屏障的消息");
  assert.equal(value.observeAgentSettled(), "superseded");
  assert.equal(value.completeCoordinationBarrier(
    "compact-owned-continuation",
    "succeeded",
    true,
  ), true);
  assert.equal(value.takeNextDelivery(), undefined);

  value.observeCompactionStart("manual", true);
  value.observeCompactionEnd("manual", false, false, true);
  assert.equal(value.takeNextDelivery(), undefined);

  value.observeAgentStart();
  assert.equal(value.observeTaskStarted(current.task_id, TURN_2), true);
  const resumed = value.takeNextDelivery();
  assert.equal(resumed?.message_id, queued.message_id);
  assert.equal(resumed?.task_id, current.task_id);
  assert.equal(resumed?.mode, "steer");
});

test("协调 complete 后等待 continuation start 时接纳消息仍归当前任务", () => {
  const value = mailbox();
  const current = value.submit("进入协调压缩的任务");
  const initial = value.takeNextDelivery();
  assert.equal(value.hostAccepted(initial!.delivery_id), true);
  value.observeAgentStart();
  assert.equal(value.observeTaskStarted(current.task_id, TURN_1), true);

  assert.equal(value.beginCoordinationBarrier("compact-awaiting-start"), true);
  assert.equal(value.observeAgentSettled(), "candidate");
  value.observeCompactionStart("manual", true);
  value.observeCompactionEnd("manual", false, false, true);
  assert.equal(value.completeCoordinationBarrier(
    "compact-awaiting-start",
    "succeeded",
    true,
  ), true);

  const queued = value.submit("complete 后补充的消息");
  assert.equal(queued.task_id, current.task_id);
  assert.equal(value.takeNextDelivery(), undefined);

  value.observeAgentStart();
  assert.equal(value.observeTaskStarted(current.task_id, TURN_2), true);
  const resumed = value.takeNextDelivery();
  assert.equal(resumed?.message_id, queued.message_id);
  assert.equal(resumed?.task_id, current.task_id);
  assert.equal(resumed?.mode, "steer");
});

test("同事务 not_started 补偿撤销自动 continuation 等待并回退为 prompt", () => {
  const value = mailbox();
  const current = value.submit("进入协调压缩的任务");
  const initial = value.takeNextDelivery();
  assert.equal(value.hostAccepted(initial!.delivery_id), true);
  value.observeAgentStart();
  assert.equal(value.observeTaskStarted(current.task_id, TURN_1), true);

  assert.equal(value.beginCoordinationBarrier("compact-compensation"), true);
  const queued = value.submit("continuation 未启动时仍要处理");
  assert.equal(value.observeAgentSettled(), "superseded");
  value.observeCompactionStart("manual", true);
  value.observeCompactionEnd("manual", false, false, true);
  assert.equal(value.completeCoordinationBarrier(
    "compact-compensation",
    "succeeded",
    true,
  ), true);
  assert.equal(value.takeNextDelivery(), undefined);

  assert.equal(value.compensateCoordinationContinuation("compact-other"), false);
  assert.equal(value.takeNextDelivery(), undefined);
  assert.equal(value.compensateCoordinationContinuation("compact-compensation"), true);
  const fallback = value.takeNextDelivery();
  assert.equal(fallback?.message_id, queued.message_id);
  assert.equal(fallback?.task_id, current.task_id);
  assert.equal(fallback?.mode, "prompt");
  assert.equal(value.compensateCoordinationContinuation("compact-compensation"), false);
});

test("同事务 continuation 补偿在没有待投递正文时释放旧 interrupted final", () => {
  const value = mailbox();
  const current = value.submit("被压缩中断的任务");
  const initial = value.takeNextDelivery();
  assert.equal(value.hostAccepted(initial!.delivery_id), true);
  value.observeAgentStart();
  assert.equal(value.observeTaskStarted(current.task_id, TURN_1), true);

  assert.equal(value.beginCoordinationBarrier("compact-final-compensation"), true);
  assert.equal(value.observeAgentSettled(), "candidate");
  value.observeCompactionStart("manual", true);
  value.observeCompactionEnd("manual", false, false, true);
  const interrupted = final(current.task_id, TURN_1, COMMIT_1, "interrupted", "absent");
  assert.equal(value.prepareFinal(interrupted), false);
  assert.equal(value.completeCoordinationBarrier(
    "compact-final-compensation",
    "succeeded",
    true,
  ), true);
  assert.equal(value.prepareFinal(interrupted), false);

  assert.equal(value.compensateCoordinationContinuation("compact-final-compensation"), true);
  assert.equal(value.prepareFinal(interrupted), true);
  assert.equal(value.commitPreparedFinal(COMMIT_1), true);
  assert.equal(value.projection().state, "idle");
  assert.equal(value.projection().last_task?.outcome, "interrupted");
});

test("协调 continuation 中已入队并消费的 steer 不被旧 settled 降级", () => {
  const value = mailbox();
  const current = value.submit("进入协调压缩的任务");
  const initial = value.takeNextDelivery();
  assert.equal(value.hostAccepted(initial!.delivery_id), true);
  value.observeAgentStart();
  assert.equal(value.observeTaskStarted(current.task_id, TURN_1), true);

  assert.equal(value.beginCoordinationBarrier("compact-reentrant-continuation"), true);
  const queued = value.submit("压缩续跑时补充消息");
  assert.equal(value.completeCoordinationBarrier(
    "compact-reentrant-continuation",
    "succeeded",
    true,
  ), true);
  value.observeCompactionStart("manual", true);
  value.observeCompactionEnd("manual", false, false, true);
  assert.equal(value.takeNextDelivery(), undefined);

  assert.equal(value.observeTaskStarted(current.task_id, TURN_2), true);
  value.observeAgentStart();
  const steer = value.takeNextDelivery();
  assert.equal(steer?.mode, "steer");
  assert.equal(steer?.message_id, queued.message_id);
  assert.equal(value.reconcileHostPending(1), true);
  assert.equal(value.observeAgentSettled(), "superseded");
  assert.equal(value.projection().state, "working");

  assert.equal(value.hostAccepted(steer!.delivery_id), true);
  assert.deepEqual(value.projection(), {
    state: "working",
    mailbox_pending_count: 0,
    host_pending_count: 1,
    reply_outbox_pending_count: 0,
    activity: { phase: "processing", task_id: current.task_id },
  });

  assert.equal(value.reconcileHostPending(0), true);
  assert.equal(value.projection().state, "working");
  assert.equal(value.projection().activity?.phase, "processing");
});

test("迟到的 steer 入队事实解除 delivery uncertainty 且不重投正文", () => {
  const value = mailbox();
  const current = value.submit("当前任务");
  const initial = value.takeNextDelivery();
  assert.equal(value.hostAccepted(initial!.delivery_id), true);
  value.observeAgentStart();
  assert.equal(value.observeTaskStarted(current.task_id, TURN_1), true);

  const queued = value.submit("响应丢失但已经入队");
  const steer = value.takeNextDelivery();
  assert.equal(steer?.mode, "steer");
  assert.equal(value.hostDeliveryUncertain(steer!.delivery_id), true);
  assert.equal(value.projection().state, "suspended");
  assert.equal(value.projection().mailbox_pending_count, 0);

  assert.equal(value.reconcileHostPending(1), true);
  assert.equal(value.projection().state, "working");
  assert.equal(value.projection().activity?.task_id, queued.task_id);
  assert.equal(value.takeNextDelivery(), undefined);

  assert.equal(value.reconcileHostPending(0), true);
  assert.equal(value.projection().state, "working");
  assert.equal(value.takeNextDelivery(), undefined);
});

test("先到且已归零的队列事实仍能裁决迟到的 steer uncertainty", () => {
  const value = mailbox();
  const current = value.submit("当前任务");
  const initial = value.takeNextDelivery();
  assert.equal(value.hostAccepted(initial!.delivery_id), true);
  value.observeAgentStart();
  assert.equal(value.observeTaskStarted(current.task_id, TURN_1), true);

  value.submit("队列证据早于 RPC 尾部");
  const steer = value.takeNextDelivery();
  assert.equal(steer?.mode, "steer");
  assert.equal(value.reconcileHostPending(1), true);
  assert.equal(value.reconcileHostPending(0), true);
  assert.equal(value.hostDeliveryUncertain(steer!.delivery_id), true);

  assert.equal(value.projection().state, "working");
  assert.equal(value.projection().mailbox_pending_count, 0);
  assert.equal(value.projection().host_pending_count, 0);
  assert.equal(value.takeNextDelivery(), undefined);
});

test("明确拒绝的 steer 保留正文并安全降级为 prompt", () => {
  const value = mailbox();
  const current = value.submit("当前任务");
  const initial = value.takeNextDelivery();
  assert.equal(value.hostAccepted(initial!.delivery_id), true);
  value.observeAgentStart();
  assert.equal(value.observeTaskStarted(current.task_id, TURN_1), true);

  const queued = value.submit("steer 被明确拒绝");
  const rejected = value.takeNextDelivery();
  assert.equal(rejected?.mode, "steer");
  assert.equal(value.hostRejected(rejected!.delivery_id), true);
  assert.equal(value.projection().state, "working");
  assert.equal(value.projection().mailbox_pending_count, 1);

  const fallback = value.takeNextDelivery();
  assert.equal(fallback?.message_id, queued.message_id);
  assert.equal(fallback?.task_id, current.task_id);
  assert.equal(fallback?.mode, "prompt");
});

test("压缩期明确拒绝的 prompt 保留正文，等待物理压缩和真实 settled 后只重试一次", () => {
  const value = mailbox([TASK_1]);
  const submission = value.submit("压缩竞争正文");
  const rejected = value.takeNextDelivery();
  assert.equal(rejected?.mode, "prompt");

  value.observeCompactionStart("threshold");
  assert.equal(value.hostRejectedForCompaction(rejected!.delivery_id, true), true);
  assert.deepEqual(value.projection(), {
    state: "working",
    mailbox_pending_count: 1,
    host_pending_count: 0,
    reply_outbox_pending_count: 0,
    activity: { phase: "compacting", task_id: submission.task_id },
  });
  assert.equal(value.takeNextDelivery(), undefined);

  value.observeCompactionEnd("threshold", false, false);
  assert.equal(value.takeNextDelivery(), undefined);
  assert.equal(value.observeAgentSettled(), "superseded");
  const retried = value.takeNextDelivery();
  assert.equal(retried?.message_id, submission.message_id);
  assert.equal(retried?.task_id, submission.task_id);
  assert.equal(retried?.mode, "prompt");
  assert.equal(value.takeNextDelivery(), undefined);
});

test("自动 continuation 先于压缩拒绝响应启动时，被拒正文仍以 steer 投入同一任务", () => {
  const value = mailbox([TASK_1]);
  const submission = value.submit("不得被自动 continuation 冒充已送达");
  const rejected = value.takeNextDelivery();
  assert.equal(rejected?.mode, "prompt");

  assert.equal(value.beginCoordinationBarrier("compact-late-rejection"), true);
  value.observeCompactionStart("manual", true);
  value.observeCompactionEnd("manual", false, false, true);
  assert.equal(value.completeCoordinationBarrier(
    "compact-late-rejection",
    "succeeded",
    true,
  ), true);
  value.observeAgentStart();
  assert.equal(value.observeTaskStarted(submission.task_id, TURN_1), true);

  assert.equal(value.hostRejectedForCompaction(rejected!.delivery_id, false), true);
  const steered = value.takeNextDelivery();
  assert.equal(steered?.message_id, submission.message_id);
  assert.equal(steered?.task_id, submission.task_id);
  assert.equal(steered?.mode, "steer");
});

test("压缩前旧 final 在待投递正文完成续跑前只作为候选，下一 turn 后按 stale ACK", () => {
  const value = mailbox([TASK_1]);
  const current = value.submit("原任务");
  const initial = value.takeNextDelivery();
  assert.equal(value.hostAccepted(initial!.delivery_id), true);
  value.observeAgentStart();
  assert.equal(value.observeTaskStarted(current.task_id, TURN_1), true);
  assert.equal(value.observeAgentSettled(), "candidate");
  const oldFinal = final(current.task_id, TURN_1, COMMIT_1, "interrupted", "absent");
  assert.equal(value.prepareFinal(oldFinal), true);

  const queued = value.submit("压缩后必须继续处理的正文");
  const rejected = value.takeNextDelivery();
  assert.equal(rejected?.mode, "prompt");
  assert.equal(value.beginCoordinationBarrier("compact-old-final"), true);
  value.observeCompactionStart("manual", true);
  assert.equal(value.hostRejectedForCompaction(rejected!.delivery_id, true), true);
  assert.equal(value.prepareFinal(oldFinal), false);
  assert.equal(value.commitPreparedFinal(COMMIT_1), false);

  value.observeCompactionEnd("manual", false, false, true);
  assert.equal(value.completeCoordinationBarrier("compact-old-final", "succeeded", true), true);
  assert.equal(value.takeNextDelivery(), undefined);
  value.observeAgentStart();
  assert.equal(value.observeTaskStarted(current.task_id, TURN_2), true);
  assert.equal(value.shouldAcknowledgeSupersededFinal(oldFinal), true);
  const steered = value.takeNextDelivery();
  assert.equal(steered?.message_id, queued.message_id);
  assert.equal(steered?.mode, "steer");
});

test("直接边准备只把真实 delivery uncertainty 标记为 unsafe", () => {
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
  assert.equal(failed.coordinationBarrierReadiness(), "quiescent");
});

test("旧 final commit 后重放的 manual 压缩允许期间新任务在 end 后 prompt", () => {
  const value = mailbox();
  const current = value.submit("即将完成的任务");
  const first = value.takeNextDelivery();
  assert.ok(first);
  assert.equal(value.hostAccepted(first.delivery_id), true);
  value.observeAgentStart();
  assert.equal(value.observeTaskStarted(current.task_id, TURN_1), true);
  const candidate = final(current.task_id, TURN_1, COMMIT_1);
  assert.equal(value.observeAgentSettled(), "candidate");
  assert.equal(value.prepareFinal(candidate), true);
  assert.equal(value.commitPreparedFinal(COMMIT_1), true);

  value.observeCompactionStart("manual");
  const next = value.submit("压缩结束后的新任务");
  assert.notEqual(next.task_id, current.task_id);
  assert.equal(value.takeNextDelivery(), undefined);
  value.observeCompactionEnd("manual", false);

  const prompt = value.takeNextDelivery();
  assert.equal(prompt?.message_id, next.message_id);
  assert.equal(prompt?.task_id, next.task_id);
  assert.equal(prompt?.mode, "prompt");
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

test("automatic compaction failure 等待真实 settled 后恢复，而 delivery uncertainty 继续隔离", () => {
  const failed = mailbox([PLACEHOLDER_TASK]);
  const current = failed.submit("压缩失败任务");
  const first = failed.takeNextDelivery();
  assert.equal(failed.hostAccepted(first!.delivery_id), true);
  failed.observeAgentStart();
  assert.equal(failed.observeTaskStarted(current.task_id, TURN_1), true);
  failed.observeCompactionStart("overflow");
  const queued = failed.submit("压缩失败后继续");
  failed.observeCompactionEnd("overflow", true, false);
  assert.equal(failed.projection().state, "working");
  assert.notEqual(failed.projection().activity?.phase, "maintenance_failed");
  assert.equal(failed.takeNextDelivery(), undefined);

  failed.observeAgentSettled();
  const retried = failed.takeNextDelivery();
  assert.equal(retried?.message_id, queued.message_id);
  assert.equal(retried?.task_id, current.task_id);
  assert.equal(retried?.mode, "prompt");

  const uncertain = mailbox([PLACEHOLDER_TASK]);
  uncertain.submit("不确定交付");
  const delivery = uncertain.takeNextDelivery();
  assert.equal(uncertain.hostDeliveryUncertain(delivery!.delivery_id), true);
  assert.equal(uncertain.projection().activity?.phase, "delivery_uncertain");
  assert.equal(uncertain.takeNextDelivery(), undefined);
});

test("compaction failure 不阻止已完成任务的 final 提交", () => {
  const value = mailbox([PLACEHOLDER_TASK]);
  const current = value.submit("压缩失败但任务已产出结果");
  const prompt = value.takeNextDelivery();
  assert.equal(value.hostAccepted(prompt!.delivery_id), true);
  value.observeAgentStart();
  assert.equal(value.observeTaskStarted(current.task_id, TURN_1), true);

  value.observeCompactionStart("threshold");
  value.observeCompactionEnd("threshold", true, false);
  assert.equal(value.observeAgentSettled(), "candidate");
  const candidate = final(current.task_id, TURN_1, COMMIT_1);
  assert.equal(value.prepareFinal(candidate), true);
  assert.equal(value.commitPreparedFinal(COMMIT_1), true);
  assert.equal(value.projection().state, "idle");
  assert.equal(value.projection().last_task?.commit_id, COMMIT_1);
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

test("匹配 task_started 先于 prompt rejection 时直接确认交付，不进入 suspended", () => {
  const value = mailbox([TASK_1]);
  const submission = value.submit("已由 Pi 建立任务");
  const delivery = value.takeNextDelivery();
  assert.ok(delivery);

  value.observeAgentStart();
  assert.equal(value.observeTaskStarted(submission.task_id, TURN_1), true);
  assert.equal(value.hostDeliveryUncertain(delivery!.delivery_id), true);
  assert.equal(value.projection().state, "working");
  assert.equal(value.projection().activity?.phase, "processing");
  assert.equal(value.takeNextDelivery(), undefined);
});

test("prompt 命令尾部晚于 task_started 与 final 时，成功或拒绝都不锁死任务", () => {
  for (const outcome of ["accepted", "uncertain"] as const) {
    const value = mailbox([PLACEHOLDER_TASK]);
    const submission = value.submit("命令响应迟到");
    const delivery = value.takeNextDelivery();
    assert.ok(delivery);

    value.observeAgentStart();
    assert.equal(value.observeTaskStarted(submission.task_id, TURN_1), true);
    value.observeAgentSettled();
    const candidate = final(submission.task_id, TURN_1, COMMIT_1);
    assert.equal(value.prepareFinal(candidate), false);

    const reconciled = outcome === "accepted"
      ? value.hostAccepted(delivery!.delivery_id)
      : value.hostDeliveryUncertain(delivery!.delivery_id);
    assert.equal(reconciled, true);
    assert.equal(value.projection().state, "working");
    assert.equal(value.projection().activity?.phase, "waiting_parent_ack");
    assert.equal(value.commitPreparedFinal(COMMIT_1), true);
    assert.equal(value.projection().state, "idle");
    assert.equal(value.projection().last_task?.outcome, "completed");
  }
});

test("未获父端接纳的 prepared final 仍可由 continuation 消息撤销", () => {
  const value = mailbox();
  const current = value.submit("当前任务");
  const prompt = value.takeNextDelivery();
  assert.ok(prompt);
  assert.equal(value.hostAccepted(prompt.delivery_id), true);
  value.observeAgentStart();
  assert.equal(value.observeTaskStarted(current.task_id, TURN_1), true);

  const candidate = final(current.task_id, TURN_1, COMMIT_1);
  assert.equal(value.observeAgentSettled(), "candidate");
  assert.equal(value.prepareFinal(candidate), true);
  const progress = value.submit("final 未获接纳时继续任务");
  assert.equal(progress.task_id, current.task_id);

  value.observeAgentStart();
  assert.equal(value.observeTaskStarted(current.task_id, TURN_2), true);
  assert.equal(value.isSupersededFinal(candidate), true);
  const steer = value.takeNextDelivery();
  assert.equal(steer?.message_id, progress.message_id);
  assert.equal(steer?.task_id, current.task_id);
  assert.equal(steer?.mode, "steer");
});

test("provisional settled 后接纳的消息在 continuation start 后仍进入当前任务", () => {
  const value = mailbox();
  const current = value.submit("当前任务");
  const prompt = value.takeNextDelivery();
  assert.ok(prompt);
  assert.equal(value.hostAccepted(prompt.delivery_id), true);
  value.observeAgentStart();
  assert.equal(value.observeTaskStarted(current.task_id, TURN_1), true);

  assert.equal(value.observeAgentSettled(), "candidate");
  const progress = value.submit("继续汇报进度");
  assert.equal(progress.task_id, current.task_id);

  value.observeAgentStart();
  assert.equal(value.observeTaskStarted(current.task_id, TURN_2), true);
  const steer = value.takeNextDelivery();
  assert.equal(steer?.message_id, progress.message_id);
  assert.equal(steer?.task_id, current.task_id);
  assert.equal(steer?.mode, "steer");
  assert.equal(value.hostAccepted(steer!.delivery_id), true);
  assert.deepEqual(value.projection(), {
    state: "working",
    mailbox_pending_count: 0,
    host_pending_count: 0,
    reply_outbox_pending_count: 0,
    activity: { phase: "processing", task_id: current.task_id },
  });
});

test("已接纳 final 被 blocker 暂缓时解除后只继续本地 commit", () => {
  const value = mailbox();
  const current = value.submit("当前任务");
  const prompt = value.takeNextDelivery();
  assert.ok(prompt);
  assert.equal(value.hostAccepted(prompt.delivery_id), true);
  value.observeAgentStart();
  assert.equal(value.observeTaskStarted(current.task_id, TURN_1), true);

  const candidate = final(current.task_id, TURN_1, COMMIT_1);
  assert.equal(value.observeAgentSettled(), "candidate");
  assert.equal(value.prepareFinal(candidate), true);
  assert.equal(value.beginPreparedFinalDelivery(COMMIT_1), "deliver");
  value.observeCompactionStart("manual");
  assert.equal(value.completePreparedFinalDelivery(COMMIT_1, true), true);
  assert.equal(value.commitPreparedFinal(COMMIT_1), false);

  value.observeCompactionEnd("manual", false);
  assert.equal(value.prepareFinal(candidate), true);
  assert.equal(value.beginPreparedFinalDelivery(COMMIT_1), "commit");
  assert.equal(value.commitPreparedFinal(COMMIT_1), true);
  assert.equal(value.projection().last_task?.commit_id, COMMIT_1);
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
