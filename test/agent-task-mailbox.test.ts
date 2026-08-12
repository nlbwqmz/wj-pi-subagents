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
    output_state: "present",
    text: "完成",
  });
}

test("并发 submit 在一个任务内分配不同 message_id，并严格选择 prompt 后 steer", () => {
  const value = mailbox();
  const first = value.submit("第一条");
  const second = value.submit("第二条");
  assert.equal(first.task_id, TASK_1);
  assert.equal(second.task_id, TASK_1);
  assert.notEqual(first.message_id, second.message_id);
  assert.equal(value.projection().mailbox_pending_count, 2);

  const prompt = value.takeNextDelivery();
  assert.equal(prompt?.mode, "prompt");
  assert.equal(value.hostAccepted(prompt!.delivery_id), true);
  const steer = value.takeNextDelivery();
  assert.equal(steer?.mode, "steer");
  assert.equal(value.hostAccepted(steer!.delivery_id), true);
  assert.deepEqual(value.projection(), {
    state: "working",
    mailbox_pending_count: 0,
    host_pending_count: 2,
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
  const interrupted = final(current.task_id, TURN_1, COMMIT_1, "interrupted");
  assert.equal(value.prepareFinal(interrupted), true);
  assert.equal(value.commitPreparedFinal(COMMIT_1), true);

  const next = value.takeNextDelivery();
  assert.equal(next?.task_id, TASK_2);
  assert.equal(next?.mode, "prompt");
  assert.equal(value.projection().last_task?.outcome, "interrupted");
});

test("宿主仍 streaming 时撤销 provisional settlement，不签发伪造 turn", () => {
  const value = mailbox([PLACEHOLDER_TASK]);
  value.observeAgentStart();
  assert.equal(value.observeTaskStarted(AUTO_TASK, TURN_1), true);
  value.observeAgentSettled();
  assert.equal(value.projection().activity?.phase, "finalizing");

  assert.equal(value.observeHostStillStreaming(0), true);
  assert.equal(value.currentTaskId(), AUTO_TASK);
  assert.equal(value.currentTurnId(), TURN_1);
  assert.deepEqual(value.projection().activity, {
    phase: "processing",
    task_id: AUTO_TASK,
  });
});

test("处理中原生压缩保持 task/turn；settled 后压缩必须等待恢复 turn", () => {
  const native = mailbox([PLACEHOLDER_TASK]);
  native.observeAgentStart();
  native.observeTaskStarted(AUTO_TASK, TURN_1);
  native.observeCompactionStart();
  assert.equal(native.observeCompactionEnd(false), false);
  assert.equal(native.currentTaskId(), AUTO_TASK);
  assert.equal(native.currentTurnId(), TURN_1);
  assert.equal(native.projection().activity?.phase, "processing");

  const resumed = mailbox([PLACEHOLDER_TASK]);
  resumed.observeAgentStart();
  resumed.observeTaskStarted(AUTO_TASK, TURN_1);
  resumed.observeAgentSettled();
  resumed.observeCompactionStart();
  assert.equal(resumed.observeCompactionEnd(false), true);
  assert.equal(resumed.projection().activity?.phase, "resume_required");
  assert.equal(resumed.observeCompactionResume(1, "continuation_pending"), "accepted");
  assert.equal(resumed.projection().activity?.phase, "resume_pending");
  resumed.observeAgentStart();
  assert.equal(resumed.observeTaskStarted(AUTO_TASK, TURN_2), true);
  assert.equal(resumed.currentTurnId(), TURN_2);
  assert.equal(resumed.projection().activity?.phase, "processing");
});

test("同一次压缩的重复 start 不重置 settlement 恢复要求或消耗 generation", () => {
  const value = mailbox([PLACEHOLDER_TASK]);
  value.observeAgentStart();
  value.observeTaskStarted(AUTO_TASK, TURN_1);
  value.observeAgentSettled();
  value.observeCompactionStart();
  value.observeCompactionStart();
  assert.equal(value.observeCompactionEnd(false), true);
  assert.equal(value.observeCompactionResume(1, "continuation_pending"), "accepted");
  assert.equal(value.projection().activity?.phase, "resume_pending");
});

test("compaction_resume 先于 compaction_end 到达时仍保留当前 generation 事实", () => {
  const value = mailbox([PLACEHOLDER_TASK]);
  value.observeAgentStart();
  value.observeTaskStarted(AUTO_TASK, TURN_1);
  value.observeAgentSettled();
  value.observeCompactionStart();
  assert.equal(value.observeCompactionResume(1, "continuation_pending"), "accepted");
  assert.equal(value.observeCompactionEnd(false), true);
  assert.equal(value.projection().state, "suspended");
  assert.equal(value.projection().activity?.phase, "resume_pending");
  value.observeAgentStart();
  assert.equal(value.projection().state, "working");
  assert.equal(value.projection().activity?.phase, "processing");
});

test("continuation 的恢复事实与 agent_start 任一先到都必须等待另一半", () => {
  const startFirst = mailbox([PLACEHOLDER_TASK]);
  startFirst.observeAgentStart();
  startFirst.observeTaskStarted(AUTO_TASK, TURN_1);
  startFirst.observeAgentSettled();
  startFirst.observeCompactionStart();
  assert.equal(startFirst.observeCompactionEnd(false), true);
  startFirst.observeAgentStart();
  assert.equal(startFirst.projection().state, "suspended");
  assert.equal(startFirst.projection().activity?.phase, "resume_required");
  assert.equal(startFirst.observeCompactionResume(1, "continuation_pending"), "accepted");
  assert.equal(startFirst.projection().state, "working");
  assert.equal(startFirst.projection().activity?.phase, "processing");

  const decisionFirst = mailbox([PLACEHOLDER_TASK]);
  decisionFirst.observeAgentStart();
  decisionFirst.observeTaskStarted(AUTO_TASK, TURN_1);
  decisionFirst.observeAgentSettled();
  decisionFirst.observeCompactionStart();
  assert.equal(decisionFirst.observeCompactionEnd(false), true);
  assert.equal(decisionFirst.observeCompactionResume(1, "continuation_pending"), "accepted");
  assert.equal(decisionFirst.projection().state, "suspended");
  assert.equal(decisionFirst.projection().activity?.phase, "resume_pending");
  decisionFirst.observeAgentStart();
  assert.equal(decisionFirst.projection().state, "working");
  assert.equal(decisionFirst.projection().activity?.phase, "processing");
});

test("当前 generation 的重复同值事实幂等，矛盾事实保持 suspended", () => {
  const value = mailbox([PLACEHOLDER_TASK]);
  value.observeAgentStart();
  value.observeTaskStarted(AUTO_TASK, TURN_1);
  value.observeAgentSettled();
  value.observeCompactionStart();
  value.observeCompactionEnd(false);
  assert.equal(value.observeCompactionResume(1, "continuation_pending"), "accepted");
  value.observeAgentStart();
  assert.equal(value.observeCompactionResume(1, "continuation_pending"), "accepted");
  assert.equal(value.observeCompactionResume(1, "host_idle"), "conflict");
  assert.equal(value.projection().state, "suspended");
  assert.equal(value.projection().activity?.phase, "resume_required");
});

test("迟到或矛盾 compaction_resume 绝不唤醒 mailbox", () => {
  const value = mailbox([PLACEHOLDER_TASK]);
  value.observeAgentStart();
  value.observeTaskStarted(AUTO_TASK, TURN_1);
  value.observeAgentSettled();
  value.observeCompactionStart();
  value.observeCompactionEnd(false);
  value.submit("保持积压");

  assert.equal(value.observeCompactionResume(2, "continuation_pending"), "conflict");
  assert.equal(value.takeNextDelivery(), undefined);
  assert.equal(value.projection().state, "suspended");
  assert.equal(value.projection().activity?.phase, "resume_required");
});

test("未解决或冲突的恢复 generation 阻止迟到 settlement 与 final 提交", () => {
  const value = mailbox([PLACEHOLDER_TASK]);
  value.observeAgentStart();
  value.observeTaskStarted(AUTO_TASK, TURN_1);
  value.observeAgentSettled();
  value.observeCompactionStart();
  assert.equal(value.observeCompactionEnd(false), true);

  value.observeAgentSettled();
  const candidate = final(AUTO_TASK, TURN_1, COMMIT_1);
  assert.equal(value.prepareFinal(candidate), false);
  assert.equal(value.commitPreparedFinal(COMMIT_1), false);
  assert.equal(value.projection().state, "suspended");
  assert.equal(value.projection().activity?.phase, "resume_required");

  assert.equal(value.observeCompactionResume(1, "host_idle"), "accepted");
  assert.equal(value.observeCompactionResume(1, "continuation_pending"), "conflict");
  assert.equal(value.prepareFinal(candidate), false);
  assert.equal(value.commitPreparedFinal(COMMIT_1), false);
  assert.equal(value.projection().state, "suspended");
  assert.equal(value.projection().activity?.phase, "resume_required");
});

test("未解决恢复 generation 遇到迟到 streaming 对账仍保持 suspended", () => {
  const value = mailbox([PLACEHOLDER_TASK]);
  value.observeAgentStart();
  value.observeTaskStarted(AUTO_TASK, TURN_1);
  value.observeAgentSettled();
  value.observeCompactionStart();
  assert.equal(value.observeCompactionEnd(false), true);

  value.observeAgentSettled();
  assert.equal(value.observeHostStillStreaming(0), true);
  assert.equal(value.projection().state, "suspended");
  assert.equal(value.projection().activity?.phase, "resume_required");
  assert.equal(value.takeNextDelivery(), undefined);
});

test("midrun 压缩失败与成功后无恢复分别稳定为 suspended", () => {
  const failed = mailbox([PLACEHOLDER_TASK]);
  failed.observeAgentStart();
  failed.observeTaskStarted(AUTO_TASK, TURN_1);
  failed.observeAgentSettled();
  failed.observeCompactionStart();
  assert.equal(failed.observeCompactionEnd(true), false);
  assert.deepEqual(failed.projection().activity, {
    phase: "maintenance_failed",
    task_id: AUTO_TASK,
  });
  assert.equal(failed.projection().state, "suspended");

  const missingResume = mailbox([PLACEHOLDER_TASK]);
  missingResume.observeAgentStart();
  missingResume.observeTaskStarted(AUTO_TASK, TURN_1);
  missingResume.observeAgentSettled();
  missingResume.observeCompactionStart();
  assert.equal(missingResume.observeCompactionEnd(false), true);
  assert.equal(missingResume.projection().state, "suspended");
  assert.equal(missingResume.projection().activity?.phase, "resume_required");
});

test("host_idle 首条消息原子恢复，后续 FIFO 消息继续原子 steering", () => {
  const value = mailbox([PLACEHOLDER_TASK]);
  value.observeAgentStart();
  value.observeTaskStarted(AUTO_TASK, TURN_1);
  value.observeAgentSettled();
  value.observeCompactionStart();
  value.submit("恢复第一条");
  value.submit("恢复第二条");
  assert.equal(value.observeCompactionEnd(false), true);
  assert.equal(value.observeCompactionResume(1, "host_idle"), "accepted");

  const first = value.takeNextDelivery();
  assert.equal(first?.mode, "prompt");
  assert.equal(first?.submission, "adaptive_steer");
  assert.equal(value.hostAccepted(first!.delivery_id), true);
  const second = value.takeNextDelivery();
  assert.equal(second?.mode, "steer");
  assert.equal(second?.submission, "adaptive_steer");
});

test("恢复 turn 拒绝旧 turn final，并只提交匹配 task/turn/commit 的 final", () => {
  const value = mailbox([PLACEHOLDER_TASK]);
  value.observeAgentStart();
  value.observeTaskStarted(AUTO_TASK, TURN_1);
  value.observeAgentSettled();
  value.observeCompactionStart();
  value.observeCompactionEnd(false);
  value.observeCompactionResume(1, "continuation_pending");
  value.observeAgentStart();
  value.observeTaskStarted(AUTO_TASK, TURN_2);
  value.observeAgentSettled();

  assert.equal(value.prepareFinal(final(AUTO_TASK, TURN_1, COMMIT_1)), false);
  const current = final(AUTO_TASK, TURN_2, COMMIT_2);
  assert.equal(value.prepareFinal(current), true);
  assert.equal(value.commitPreparedFinal(COMMIT_1), false);
  assert.equal(value.commitPreparedFinal(COMMIT_2), true);
  assert.equal(value.projection().state, "idle");
  assert.deepEqual(value.projection().last_task, {
    task_id: AUTO_TASK,
    turn_id: TURN_2,
    commit_id: COMMIT_2,
    outcome: "completed",
    output_state: "present",
  });
});

test("final 在 settlement 前只能 prepare，父端接纳与 settlement 都满足后才能 commit", () => {
  const value = mailbox([PLACEHOLDER_TASK]);
  value.observeAgentStart();
  value.observeTaskStarted(AUTO_TASK, TURN_1);
  const candidate = final(AUTO_TASK, TURN_1, COMMIT_1);
  assert.equal(value.prepareFinal(candidate), false);
  assert.equal(value.commitPreparedFinal(COMMIT_1), false);
  assert.equal(value.projection().state, "working");
  assert.equal(value.projection().reply_outbox_pending_count, 1);
  assert.equal(value.projection().activity?.phase, "finalizing");

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
