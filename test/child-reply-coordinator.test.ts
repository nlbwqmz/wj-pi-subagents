import assert from "node:assert/strict";
import test from "node:test";
import { displayWidth } from "../src/agent-tree-ui.ts";
import {
  CHILD_REPLY_SCHEMA,
  CHILD_REPLY_VERSION,
  CHILD_TERMINAL_SCHEMA,
  type ChildFinalEnvelope,
  type ChildMessageEnvelope,
  type ChildReplyEnvelope,
  type TerminalNotice,
} from "../src/child-reply-envelope.ts";
import {
  ChildReplyCoordinator,
  type ChildReplyPort,
} from "../src/child-reply-coordinator.ts";
import {
  ParentReplyInbox,
  createVisibleEnvelope,
  registerParentReplyMessageRenderers,
  type ParentReplyMessageRenderer,
} from "../src/parent-reply-inbox.ts";

const AGENT_ID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_AGENT_ID = "650e8400-e29b-41d4-a716-446655440000";
const TURN_1 = "550e8400-e29b-41d4-a716-446655440001";
const TURN_2 = "550e8400-e29b-41d4-a716-446655440002";
const TASK_1 = "450e8400-e29b-41d4-a716-446655440001";
const COMMIT_1 = "750e8400-e29b-41d4-a716-446655440001";
const UUID_V1 = "550e8400-e29b-11d4-a716-446655440001";

class RecordingPort implements ChildReplyPort {
  readonly replies: ChildReplyEnvelope[] = [];
  private pending: Array<() => void> = [];

  publishReplyAndWaitForAck(reply: ChildReplyEnvelope): Promise<void> {
    this.replies.push(reply);
    return new Promise<void>((resolve) => this.pending.push(resolve));
  }

  acknowledgeAll(): void {
    for (const resolve of this.pending.splice(0)) resolve();
  }
}

class TaskStartedBarrierPort implements ChildReplyPort {
  readonly events: Array<{ readonly kind: "started" | "reply"; readonly task_id: string; readonly turn_id: string }> = [];
  private releaseStarted!: () => void;
  private readonly startedAck = new Promise<void>((resolve) => {
    this.releaseStarted = resolve;
  });

  async publishTaskStarted(started: { readonly task_id: string; readonly turn_id: string }): Promise<void> {
    this.events.push({ kind: "started", ...started });
    await this.startedAck;
  }

  async publishReplyAndWaitForAck(reply: ChildReplyEnvelope): Promise<void> {
    this.events.push({ kind: "reply", task_id: reply.task_id, turn_id: reply.turn_id });
  }

  acknowledgeStarted(): void {
    this.releaseStarted();
  }
}

class RejectingPort implements ChildReplyPort {
  calls = 0;

  async publishReplyAndWaitForAck(): Promise<void> {
    this.calls += 1;
    throw new Error("父端未确认");
  }
}

function coordinator(port: ChildReplyPort, turns = [TURN_1, TURN_2]): ChildReplyCoordinator {
  let turnIndex = 0;
  let taskIndex = 0;
  let commitIndex = 0;
  return new ChildReplyCoordinator({
    agentId: AGENT_ID,
    port,
    turnIdFactory: () => turns[turnIndex++]!,
    taskIdFactory: () => `450e8400-e29b-41d4-a716-44665544000${++taskIndex}`,
    commitIdFactory: () => `750e8400-e29b-41d4-a716-44665544000${++commitIndex}`,
  });
}

function messageEnvelope(
  text: string,
  turnId = TURN_1,
): ChildMessageEnvelope {
  return {
    schema: CHILD_REPLY_SCHEMA,
    version: CHILD_REPLY_VERSION,
    kind: "message",
    agent_id: AGENT_ID,
    task_id: TASK_1,
    turn_id: turnId,
    text,
  };
}

function finalEnvelope(
  text: string | undefined,
  overrides: Partial<Omit<ChildFinalEnvelope, "text" | "reason_code">> & {
    readonly reason_code?: ChildFinalEnvelope["reason_code"] | undefined;
  } = {},
): ChildFinalEnvelope {
  const value = {
    schema: CHILD_REPLY_SCHEMA,
    version: CHILD_REPLY_VERSION,
    kind: "final" as const,
    agent_id: AGENT_ID,
    task_id: TASK_1,
    turn_id: TURN_1,
    commit_id: COMMIT_1,
    run_state: "settled" as const,
    output_state: text === undefined ? "absent" as const : "present" as const,
    ...(text === undefined ? { reason_code: "no_output" as const } : { text }),
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as unknown as ChildFinalEnvelope;
}

async function nextTask(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("Pi 自动重试在 settled 前启动新轮时沿用同一逻辑任务", async () => {
  const port = new TaskStartedBarrierPort();
  const value = coordinator(port);
  const assignedTaskId = "450e8400-e29b-41d4-a716-446655440002";
  value.observeTaskAssignment({
    message_id: "msg_retry_assignment",
    task_id: assignedTaskId,
    mode: "prompt",
  });
  value.observeAgentStart();
  await nextTask();
  port.acknowledgeStarted();
  await nextTask();

  // Pi 的自动重试没有先发 agent_settled，会直接进入下一次 agent_start。
  value.observeAgentEnd();
  value.observeAgentStart();
  await nextTask();

  assert.deepEqual(port.events, [
    { kind: "started", task_id: assignedTaskId, turn_id: TURN_1 },
    { kind: "started", task_id: assignedTaskId, turn_id: TURN_2 },
  ]);
});

test("threshold 压缩按真实顺序保留 assistant 候选并只在最终 settled 后发布", async () => {
  const port = new RecordingPort();
  const value = coordinator(port);
  value.observeAgentStart();
  value.observeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "阈值压缩前已完成" }],
    },
  });
  value.observeAgentEnd();
  value.observeCompactionStart("threshold", false);
  value.observeCompactionEnd("threshold");
  await nextTask();
  assert.deepEqual(port.replies, []);

  value.settle();
  await nextTask();
  assert.deepEqual(port.replies, [finalEnvelope("阈值压缩前已完成")]);
  port.acknowledgeAll();
});

test("overflow willRetry 撤销旧候选并等待下一真实 turn", async () => {
  const port = new RecordingPort();
  const value = coordinator(port);
  value.observeAgentStart();
  value.observeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "length",
      content: [{ type: "text", text: "不得提交的溢出候选" }],
    },
  });
  value.observeAgentEnd();
  value.observeCompactionStart("overflow", true);
  value.observeCompactionEnd("overflow");
  value.settle();
  await nextTask();
  assert.deepEqual(port.replies, []);

  value.observeAgentStart();
  await nextTask();
  assert.deepEqual(port.replies, []);

  value.observeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "重试后的结果" }],
    },
  });
  value.observeAgentEnd();
  value.settle();
  await nextTask();
  assert.deepEqual(port.replies, [{
    ...finalEnvelope("重试后的结果"),
    turn_id: TURN_2,
  }]);
  port.acknowledgeAll();
});

test("task_started 获 transport ACK 前同一 turn 的业务 reply 不得越过身份事实", async () => {
  const port = new TaskStartedBarrierPort();
  const value = coordinator(port);
  value.observeTaskAssignment({
    message_id: "msg_assignment",
    task_id: TASK_1,
    mode: "prompt",
  });
  value.observeAgentStart();
  const reply = value.replyToParent({ message: "进行中" });
  await nextTask();
  assert.deepEqual(port.events, [{ kind: "started", task_id: TASK_1, turn_id: TURN_1 }]);

  port.acknowledgeStarted();
  assert.deepEqual(await reply, { ok: true, data: { accepted: true } });
  assert.deepEqual(port.events, [
    { kind: "started", task_id: TASK_1, turn_id: TURN_1 },
    { kind: "reply", task_id: TASK_1, turn_id: TURN_1 },
  ]);
});

test("工作中消息与 settled final 共享运行时轮次并按 ACK 顺序发布", async () => {
  const port = new RecordingPort();
  const value = coordinator(port);
  value.observeAgentStart();
  value.observeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "toolUse",
      content: [{ type: "text", text: "我先检查文件" }, { type: "toolCall", id: "1", name: "read" }],
    },
  });
  const progress = value.replyToParent({
    message: "正在读取文件，完成后继续。",
  });
  await nextTask();
  assert.deepEqual(port.replies, [messageEnvelope("正在读取文件，完成后继续。")]);
  port.acknowledgeAll();
  assert.deepEqual(await progress, { ok: true, data: { accepted: true } });

  value.observeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "最终结果" }],
    },
  });
  const settled = value.settle();
  await nextTask();
  assert.deepEqual(port.replies[1], finalEnvelope("最终结果"));
  port.acknowledgeAll();
  await settled;
  await value.settle();
  assert.equal(port.replies.length, 2);
});

test("final 提交后迟到的 message_end 不能重新打开同一轮工作中回复", async () => {
  const replies: ChildReplyEnvelope[] = [];
  const value = coordinator({
    async publishReplyAndWaitForAck(reply) {
      replies.push(reply);
    },
  });
  value.observeAgentStart();
  value.observeAssistantMessageEnd({
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "已完成" }] },
  });
  value.settle();
  await nextTask();

  value.observeAssistantMessageEnd({
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "迟到内容" }] },
  });
  const lateReply = await value.replyToParent({
    message: "不应出站",
  });
  assert.equal(lateReply.ok, false);
  if (!lateReply.ok) assert.equal(lateReply.error.code, "message_delivery_failed");
  assert.deepEqual(replies, [finalEnvelope("已完成")]);
});

test("工作中回复拒绝 images 扩展字段", async () => {
  const port = new RecordingPort();
  const value = coordinator(port);
  value.observeAgentStart();
  const progress = await value.replyToParent({
    message: "附带截图的进度",
    images: [{ type: "image", data: "YWJj", mimeType: "image/png" }],
  });

  assert.equal(progress.ok, false);
  if (!progress.ok) assert.equal(progress.error.code, "invalid_argument");
  assert.deepEqual(port.replies, []);
});

test("每次 agent_start 生成新轮次且不会覆盖上一轮 final", async () => {
  const port = new RecordingPort();
  const value = coordinator(port);
  value.observeAgentStart();
  value.observeAssistantMessageEnd({
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "第一轮" }] },
  });
  const first = value.settle();
  await nextTask();
  port.acknowledgeAll();
  await first;

  value.observeAgentStart();
  assert.equal(value.getCurrentTurnId(), TURN_2);
  value.observeAssistantMessageEnd({
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "第二轮" }] },
  });
  const second = value.settle();
  await nextTask();
  assert.equal(port.replies[0]?.turn_id, TURN_1);
  assert.equal(port.replies[1]?.turn_id, TURN_2);
  port.acknowledgeAll();
  await second;
});

test("轮次分配拒绝 UUID v1，重试重复值，并在耗尽后废止旧轮次", async () => {
  const port = new RecordingPort();
  let invalidFailures = 0;
  const invalid = new ChildReplyCoordinator({
    agentId: AGENT_ID,
    port,
    turnIdFactory: () => UUID_V1,
    onFinalFailure: () => { invalidFailures += 1; },
  });
  assert.throws(() => invalid.observeAgentStart(), /invalid_child_task_identity/);
  assert.equal(invalid.getCurrentTurnId(), undefined);
  await nextTask();
  assert.equal(invalidFailures, 1);

  const retried = coordinator(port, [TURN_1, TURN_1, TURN_2]);
  retried.observeAgentStart();
  retried.observeAgentStart();
  assert.equal(retried.getCurrentTurnId(), TURN_2);

  const exhaustedPort = new RecordingPort();
  let exhaustedFailures = 0;
  const exhausted = new ChildReplyCoordinator({
    agentId: AGENT_ID,
    port: exhaustedPort,
    turnIdFactory: () => TURN_1,
    onFinalFailure: () => { exhaustedFailures += 1; },
  });
  exhausted.observeAgentStart();
  exhausted.observeAssistantMessageEnd({
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "第一轮" }] },
  });
  const first = exhausted.settle();
  await nextTask();
  exhaustedPort.acknowledgeAll();
  await first;
  await nextTask();

  assert.throws(() => exhausted.observeAgentStart(), /invalid_child_task_identity/);
  assert.equal(exhausted.getCurrentTurnId(), undefined);
  await nextTask();
  assert.equal(exhaustedFailures, 1);
  exhausted.observeAssistantMessageEnd({
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "不得出站的第二轮" }] },
  });
  await exhausted.settle();
  assert.equal(exhaustedPort.replies.length, 1);
  assert.equal(exhausted.getFinalCandidate(), undefined);
});

test("最终候选连接文本块并忽略图片内容", async () => {
  const port = new RecordingPort();
  const value = coordinator(port);
  value.observeAgentStart();
  value.observeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [
        { type: "text", text: "第一部分" },
        { type: "text", text: "第二部分" },
      ],
    },
  });
  value.observeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
    },
  });
  const settled = value.settle();
  await nextTask();
  assert.deepEqual(port.replies, [finalEnvelope("第一部分\n第二部分")]);
  port.acknowledgeAll();
  await settled;
});

test("图片-only assistant 输出形成无正文 final", async () => {
  const port = new RecordingPort();
  const value = coordinator(port);
  value.observeAgentStart();
  value.observeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{
        type: "image",
        data: "iVBORw0KGgo=",
        mimeType: "image/png",
      }],
    },
  });

  const settled = value.settle();
  await nextTask();
  assert.deepEqual(port.replies, [finalEnvelope(undefined)]);
  port.acknowledgeAll();
  await settled;
});

test("provider error 保留上一安全候选并仅通过状态标记部分输出", async () => {
  const port = new RecordingPort();
  const value = coordinator(port);
  value.observeAgentStart();
  value.observeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "已完成的部分结论" }],
    },
  });
  value.observeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "error",
      errorMessage: "PROVIDER_SECRET_ERROR",
      content: [{ type: "text", text: "不得作为最终答复" }],
    },
  });

  const settled = value.settle();
  await nextTask();
  assert.deepEqual(port.replies, [finalEnvelope("已完成的部分结论", {
    run_state: "failed",
    reason_code: "provider_error",
  })]);
  assert.doesNotMatch(JSON.stringify(port.replies), /PROVIDER_SECRET_ERROR|不得作为最终答复|继续沟通/);
  port.acknowledgeAll();
  await settled;
});

test("协作式中断保留安全候选且不生成说明性业务正文", async () => {
  const port = new RecordingPort();
  const value = coordinator(port);
  value.observeAgentStart();
  value.observeAssistantMessageEnd({
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "中断前内容" }] },
  });
  value.observeAssistantMessageEnd({
    type: "message_end",
    message: { role: "assistant", stopReason: "aborted", content: [] },
  });
  const settled = value.settle();
  await nextTask();
  assert.deepEqual(port.replies, [finalEnvelope("中断前内容", {
    run_state: "interrupted",
    reason_code: undefined,
  })]);
  port.acknowledgeAll();
  await settled;
});

test("协调压缩成功冻结旧中断 final，并由下一真实轮沿用逻辑任务", async () => {
  const port = new RecordingPort();
  const value = coordinator(port);
  value.observeAgentStart();
  assert.equal(value.getCurrentTaskId(), TASK_1);
  assert.equal(value.beginCoordinationBarrier("compact-success"), true);
  value.observeAssistantMessageEnd({
    type: "message_end",
    message: { role: "assistant", stopReason: "aborted", content: [] },
  });
  value.observeAgentEnd();
  value.settle();
  await nextTask();
  assert.deepEqual(port.replies, []);

  assert.equal(value.completeCoordinationBarrier("compact-success", "succeeded"), true);
  await nextTask();
  assert.deepEqual(port.replies, []);
  value.observeAgentStart();
  assert.equal(value.getCurrentTaskId(), TASK_1);
  assert.equal(value.getCurrentTurnId(), TURN_2);
  value.observeAssistantMessageEnd({
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "续轮完成" }] },
  });
  value.observeAgentEnd();
  value.settle();
  await nextTask();
  assert.deepEqual(port.replies, [{
    ...finalEnvelope("续轮完成"),
    turn_id: TURN_2,
  }]);
  port.acknowledgeAll();
});

test("child reply 协调令牌可叠加，释放一个不解除另一个", () => {
  const value = coordinator(new RecordingPort());
  assert.equal(value.beginCoordinationBarrier("compact-token-a"), true);
  assert.equal(value.beginCoordinationBarrier("compact-token-b"), true);
  assert.equal(value.hasCoordinationBarrier(), true);

  assert.equal(value.completeCoordinationBarrier("compact-token-a", "not_started"), true);
  assert.equal(value.hasCoordinationBarrier(), true);
  assert.equal(value.completeCoordinationBarrier("compact-token-b", "not_started"), true);
  assert.equal(value.hasCoordinationBarrier(), false);
});

test("协调 complete 先于 raw settled 到达时仍冻结被中断旧轮", async () => {
  const port = new RecordingPort();
  const value = coordinator(port);
  value.observeAgentStart();
  assert.equal(value.beginCoordinationBarrier("compact-complete-first"), true);
  value.observeAssistantMessageEnd({
    type: "message_end",
    message: { role: "assistant", stopReason: "aborted", content: [] },
  });
  value.observeAgentEnd();

  assert.equal(value.completeCoordinationBarrier("compact-complete-first", "succeeded"), true);
  value.settle();
  await nextTask();
  assert.deepEqual(port.replies, []);

  value.observeAgentStart();
  assert.equal(value.getCurrentTaskId(), TASK_1);
  assert.equal(value.getCurrentTurnId(), TURN_2);
  value.observeAssistantMessageEnd({
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "新轮" }] },
  });
  value.observeAgentEnd();
  value.settle();
  await nextTask();
  assert.deepEqual(port.replies, [{
    ...finalEnvelope("新轮"),
    turn_id: TURN_2,
  }]);
  port.acknowledgeAll();
});

test("协调成功后等待本地 continuation 时拒绝第二个物理压缩，补偿可释放旧中断轮", async () => {
  const port = new RecordingPort();
  const value = coordinator(port);
  value.observeAgentStart();
  assert.equal(value.beginCoordinationBarrier("compact-compensated"), true);
  value.observeAssistantMessageEnd({
    type: "message_end",
    message: { role: "assistant", stopReason: "aborted", content: [] },
  });
  value.observeAgentEnd();
  value.settle();
  assert.equal(value.completeCoordinationBarrier("compact-compensated", "succeeded"), true);
  assert.equal(value.awaitsCoordinationContinuation("compact-compensated"), true);
  // 令牌集合本身允许叠加；此处拒绝的是尚未出现 successor turn 的第二次物理压缩。
  assert.equal(value.beginCoordinationBarrier("compact-overlap"), false);

  assert.equal(value.completeCoordinationBarrier("compact-compensated", "not_started"), true);
  await nextTask();
  assert.deepEqual(port.replies, [finalEnvelope(undefined, {
    run_state: "interrupted",
    reason_code: undefined,
  })]);
  port.acknowledgeAll();
});

test("协调成功先于 raw settled 时同事务补偿仍释放旧中断轮", async () => {
  const port = new RecordingPort();
  const value = coordinator(port);
  value.observeAgentStart();
  assert.equal(value.beginCoordinationBarrier("compact-compensated-first"), true);
  value.observeAssistantMessageEnd({
    type: "message_end",
    message: { role: "assistant", stopReason: "aborted", content: [] },
  });
  value.observeAgentEnd();
  assert.equal(value.completeCoordinationBarrier("compact-compensated-first", "succeeded"), true);
  assert.equal(value.completeCoordinationBarrier("compact-compensated-first", "not_started"), true);
  value.settle();
  await nextTask();
  assert.deepEqual(port.replies, [finalEnvelope(undefined, {
    run_state: "interrupted",
    reason_code: undefined,
  })]);
  port.acknowledgeAll();
});

test("协调压缩失败释放旧轮并发布 interrupted final", async () => {
  const port = new RecordingPort();
  const value = coordinator(port);
  value.observeAgentStart();
  assert.equal(value.beginCoordinationBarrier("compact-failed"), true);
  value.observeAssistantMessageEnd({
    type: "message_end",
    message: { role: "assistant", stopReason: "aborted", content: [] },
  });
  value.observeAgentEnd();
  value.settle();
  await nextTask();
  assert.deepEqual(port.replies, []);

  assert.equal(value.completeCoordinationBarrier("compact-failed", "failed"), true);
  await nextTask();
  assert.deepEqual(port.replies, [finalEnvelope(undefined, {
    run_state: "interrupted",
    reason_code: undefined,
  })]);
  port.acknowledgeAll();
});

test("正常无输出与运行时故障均发送无正文结构化 final", async () => {
  const normalPort = new RecordingPort();
  const normal = coordinator(normalPort);
  normal.observeAgentStart();
  const normalSettle = normal.settle();
  await nextTask();
  assert.deepEqual(normalPort.replies, [finalEnvelope(undefined)]);
  normalPort.acknowledgeAll();
  await normalSettle;

  const failedPort = new RecordingPort();
  const failed = coordinator(failedPort);
  failed.observeAgentStart();
  failed.observeAssistantMessageEnd({ type: "message_end", message: null });
  const failedSettle = failed.settle();
  await nextTask();
  assert.deepEqual(failedPort.replies, [finalEnvelope(undefined, {
    run_state: "failed",
    reason_code: "runtime_fault",
  })]);
  failedPort.acknowledgeAll();
  await failedSettle;
});

test("reply_to_parent 拒绝已移除的配置字段，final 确认失败只通知一次", async () => {
  const port = new RecordingPort();
  const value = coordinator(port);
  value.observeAgentStart();
  const invalid = await value.replyToParent({ message: "旧格式", requires_response: false });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.error.code, "invalid_argument");

  const rejectingPort = new RejectingPort();
  let failures = 0;
  const rejecting = new ChildReplyCoordinator({
    agentId: AGENT_ID,
    port: rejectingPort,
    turnIdFactory: () => TURN_1,
    onFinalFailure: () => { failures += 1; },
  });
  rejecting.observeAgentStart();
  rejecting.settle();
  rejecting.settle();
  await nextTask();
  await nextTask();
  assert.equal(rejectingPort.calls, 1);
  assert.equal(failures, 1);
});

test("final 失败不阻塞 settled handler，并通过独立监督流关闭信号报告", async () => {
  const order: string[] = [];
  const value = new ChildReplyCoordinator({
    agentId: AGENT_ID,
    port: new RejectingPort(),
    turnIdFactory: () => TURN_1,
    onFinalFailure: () => { order.push("close"); },
  });
  value.observeAgentStart();

  assert.equal(value.settle(), undefined);
  order.push("handler_returned");
  await nextTask();
  await nextTask();
  assert.deepEqual(order, ["handler_returned", "close"]);
});

test("final 失败后协调器永久废止轮次且不能签发下一轮", async () => {
  const port = new RejectingPort();
  let turnIndex = 0;
  let failures = 0;
  const value = new ChildReplyCoordinator({
    agentId: AGENT_ID,
    port,
    turnIdFactory: () => [TURN_1, TURN_2][turnIndex++]!,
    onFinalFailure: () => { failures += 1; },
  });
  value.observeAgentStart();
  value.settle();
  await nextTask();
  await nextTask();

  assert.throws(() => value.observeAgentStart());
  assert.equal(value.getCurrentTurnId(), undefined);
  await nextTask();
  assert.equal(failures, 1);
  assert.equal(port.calls, 1);
});

const RENDER_THEME = Object.freeze({
  fg: (_color: string, text: string): string => text,
  bg: (_color: string, text: string): string => text,
  bold: (text: string): string => text,
});

test("父端 inbox 对所有工作中回复和 final 使用完整唤醒矩阵", () => {
  const sent: Array<{ message: unknown; options: unknown }> = [];
  const notified: string[] = [];
  const inbox = new ParentReplyInbox({
    readApi: () => ({ sendMessage: (message, options) => sent.push({ message, options }) }),
    notifyMessage: (agentId) => notified.push(agentId),
  });
  const firstMessage = messageEnvelope("第一条工作中回复");
  const secondMessage = messageEnvelope("第二条工作中回复");
  const final = finalEnvelope(undefined);
  const imageFinal = {
    ...finalEnvelope("不得接纳"),
    images: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
  };
  assert.equal(inbox.accept(AGENT_ID, firstMessage), true);
  assert.equal(inbox.accept(AGENT_ID, secondMessage), true);
  assert.equal(inbox.accept(AGENT_ID, final), true);
  assert.equal(inbox.accept(AGENT_ID, imageFinal as never), false);
  assert.equal(inbox.accept(OTHER_AGENT_ID, firstMessage), false);
  assert.equal(inbox.acceptTerminal(AGENT_ID, TURN_1), true);

  assert.deepEqual(sent.map((entry) => entry.options), [
    { triggerTurn: true, deliverAs: "steer" },
    { triggerTurn: true, deliverAs: "steer" },
    { triggerTurn: true, deliverAs: "steer" },
    { triggerTurn: true, deliverAs: "steer" },
  ]);
  assert.deepEqual(notified, [AGENT_ID, AGENT_ID]);
  const firstText = (sent[0]!.message as { content: Array<{ text: string }> }).content[0]!.text;
  assert.deepEqual(JSON.parse(firstText), firstMessage);
  assert.equal((sent[2]!.message as { content: unknown[] }).content.length, 1);
  const terminal = JSON.parse(
    (sent[3]!.message as { content: Array<{ text: string }> }).content[0]!.text,
  ) as TerminalNotice;
  assert.deepEqual(terminal, {
    schema: CHILD_TERMINAL_SCHEMA,
    version: CHILD_REPLY_VERSION,
    kind: "terminal",
    agent_id: AGENT_ID,
    turn_id: TURN_1,
    node_state: "failed",
    reason_code: "runtime_fault",
  });
});

test("父端 inbox 对已注入 final 的精确重试只确认而不重复触发会话", () => {
  const sent: unknown[] = [];
  const inbox = new ParentReplyInbox({
    readApi: () => ({ sendMessage: (message) => sent.push(message) }),
    notifyMessage: () => {},
  });
  const final = finalEnvelope("只注入一次");
  const conflicting = finalEnvelope("同 turn 的冲突正文");

  assert.equal(inbox.accept(AGENT_ID, final), true);
  assert.equal(inbox.accept(AGENT_ID, final), true);
  assert.equal(inbox.accept(AGENT_ID, conflicting), false);
  assert.equal(sent.length, 1);
});

test("单个 child 压缩屏障只冻结目标 child，不污染 sibling 回复", () => {
  const sent: unknown[] = [];
  const inbox = new ParentReplyInbox({
    readApi: () => ({ sendMessage: (message) => sent.push(message) }),
    notifyMessage: () => {},
  });
  const siblingMessage = {
    ...messageEnvelope("兄弟回复"),
    agent_id: OTHER_AGENT_ID,
  };

  assert.equal(inbox.beginChildCompactionBarrier(AGENT_ID, "compact-child"), true);
  assert.equal(inbox.accept(AGENT_ID, messageEnvelope("目标回复暂缓")), false);
  assert.equal(inbox.accept(OTHER_AGENT_ID, siblingMessage), true);
  assert.equal(sent.length, 1);
  assert.equal(inbox.completeChildCompactionBarrier(AGENT_ID, "compact-child"), true);
  assert.equal(inbox.accept(AGENT_ID, messageEnvelope("目标回复放行")), true);
  assert.equal(sent.length, 2);
});

test("settling gate 暂缓所有工作中回复、final 和 TerminalNotice", () => {
  const sent: Array<{ message: unknown; options: unknown }> = [];
  const inbox = new ParentReplyInbox({
    readApi: () => ({ sendMessage: (message, options) => sent.push({ message, options }) }),
    notifyMessage: () => {},
  });
  inbox.blockTurnTriggers();
  inbox.blockTurnTriggers();

  assert.equal(inbox.accept(AGENT_ID, messageEnvelope("工作中回复")), false);
  assert.equal(inbox.accept(AGENT_ID, finalEnvelope("阶段结果")), false);
  assert.equal(inbox.acceptTerminal(AGENT_ID, TURN_1), false);
  assert.equal(sent.length, 0);

  assert.equal(inbox.releaseTurnTriggers(), true);
  assert.equal(inbox.releaseTurnTriggers(), false);
  assert.equal(inbox.accept(AGENT_ID, messageEnvelope("已放行回复")), true);
  assert.equal(inbox.accept(AGENT_ID, finalEnvelope("阶段结果")), true);
  assert.equal(inbox.acceptTerminal(AGENT_ID, TURN_1), true);
  assert.deepEqual(sent.map((entry) => entry.options), [
    { triggerTurn: true, deliverAs: "steer" },
    { triggerTurn: true, deliverAs: "steer" },
    { triggerTurn: true, deliverAs: "steer" },
  ]);
});

test("旧轮延迟放行不能解除新轮 settling gate", () => {
  const sent: unknown[] = [];
  const inbox = new ParentReplyInbox({
    readApi: () => ({ sendMessage: (message) => sent.push(message) }),
    notifyMessage: () => {},
  });

  const oldGeneration = inbox.blockTurnTriggers();
  assert.equal(inbox.releaseTurnTriggers(), true);
  const currentGeneration = inbox.blockTurnTriggers();
  assert.notEqual(currentGeneration, oldGeneration);
  assert.equal(inbox.releaseTurnTriggers(oldGeneration), false);
  assert.equal(inbox.accept(AGENT_ID, finalEnvelope("新轮收尾期间不得投递")), false);
  assert.equal(inbox.releaseTurnTriggers(currentGeneration), true);
  assert.equal(inbox.accept(AGENT_ID, finalEnvelope("新轮已放行")), true);
  assert.equal(sent.length, 1);
});

test("final 失败后 settling gate 不可由后续 agent_start 重新放行", () => {
  const sent: unknown[] = [];
  const inbox = new ParentReplyInbox({
    readApi: () => ({ sendMessage: (message) => sent.push(message) }),
    notifyMessage: () => {},
  });
  inbox.blockTurnTriggers();
  inbox.failTurnTriggers();
  assert.equal(inbox.releaseTurnTriggers(), false);
  assert.equal(inbox.accept(AGENT_ID, finalEnvelope("不得投递")), false);
  assert.equal(inbox.accept(AGENT_ID, messageEnvelope("不得唤醒")), false);
  assert.equal(inbox.acceptTerminal(AGENT_ID), false);
  assert.deepEqual(sent, []);
});

test("父回复 renderer 隐藏原始 JSON 与协议字段并展示发送者、状态和正文", () => {
  const sent: Array<{ message: unknown; options: unknown }> = [];
  const inbox = new ParentReplyInbox({
    readApi: () => ({ sendMessage: (message, options) => sent.push({ message, options }) }),
    notifyMessage: () => {},
    readSenderName: (candidate) => candidate === AGENT_ID ? "鉴权调查" : undefined,
  });
  assert.equal(inbox.accept(AGENT_ID, messageEnvelope("正在核对第二个实现分支。")), true);
  assert.equal(inbox.accept(AGENT_ID, finalEnvelope(undefined)), true);
  assert.equal(inbox.acceptTerminal(AGENT_ID), true);

  const renderers = new Map<string, ParentReplyMessageRenderer>();
  registerParentReplyMessageRenderers({
    registerMessageRenderer: (type, renderer) => { renderers.set(type, renderer); },
  });
  assert.deepEqual([...renderers.keys()], [
    "wj-pi-subagents-message",
    "wj-pi-subagents-final",
    "wj-pi-subagents-terminal",
  ]);
  for (const [index, type] of [...renderers.keys()].entries()) {
    const message = sent[index]!.message as Record<string, unknown>;
    const lines = renderers.get(type)!(message, { expanded: true, outputPad: 0 }, RENDER_THEME).render(120);
    const rendered = lines.join("\n");
    assert.match(rendered, new RegExp(`Sender: 鉴权调查 · ${AGENT_ID}`));
    assert.match(rendered, /Status:/);
    assert.match(rendered, /Payload:/);
    assert.doesNotMatch(rendered, /wj-pi-subagents\.reply|wj-pi-subagents\.terminal|turn_id|schema|550e8400-e29b-41d4-a716-446655440001/);
    assert.ok(lines.every((line) => displayWidth(line) <= 120));
  }
  const terminalText = (sent[2]!.message as { content: Array<{ text: string }> }).content[0]!.text;
  assert.equal("turn_id" in (JSON.parse(terminalText) as Record<string, unknown>), false);
  const finalRendered = renderers.get("wj-pi-subagents-final")!(
    sent[1]!.message,
    { expanded: true, outputPad: 0 },
    RENDER_THEME,
  ).render(120).join("\n");
  assert.match(finalRendered, /settled \/ absent \/ no_output/);
  assert.match(finalRendered, /无可用业务输出/);
});

test("工作中回复与最终答复正文按 Markdown 渲染", () => {
  const renderers = new Map<string, ParentReplyMessageRenderer>();
  registerParentReplyMessageRenderers({
    registerMessageRenderer: (type, renderer) => { renderers.set(type, renderer); },
  });
  const markdown = "# 结论\n\n已完成 **Markdown 渲染**，并保留 `code`。";

  for (const [type, envelope] of [
    ["wj-pi-subagents-message", messageEnvelope(markdown)],
    ["wj-pi-subagents-final", finalEnvelope(markdown)],
  ] as const) {
    const rendered = renderers.get(type)!({
      customType: type,
      content: [{ type: "text", text: createVisibleEnvelope(envelope) }],
      details: { agent_id: AGENT_ID, kind: envelope.kind },
    }, { expanded: true, outputPad: 0 }, RENDER_THEME).render(120).join("\n");

    assert.match(rendered, /结论/);
    assert.match(rendered, /已完成 Markdown 渲染，并保留 code。/);
    assert.doesNotMatch(rendered, /# 结论|\*\*Markdown 渲染\*\*|`code`/);
  }

  const collapsedMarkdown = Array.from(
    { length: 10 },
    (_, index) => `段落 ${index + 1}`,
  ).join("\n\n");
  const collapsedEnvelope = messageEnvelope(collapsedMarkdown);
  const collapsed = renderers.get("wj-pi-subagents-message")!({
    customType: "wj-pi-subagents-message",
    content: [{ type: "text", text: createVisibleEnvelope(collapsedEnvelope) }],
    details: { agent_id: AGENT_ID, kind: "message" },
  }, { expanded: false, outputPad: 0 }, RENDER_THEME).render(120).join("\n");
  assert.match(collapsed, /…（展开查看完整正文）/);
  assert.doesNotMatch(collapsed, /段落 10/);
});

test("renderer 清理不可信名称和无效结构化正文并保持宽度", () => {
  const renderers = new Map<string, ParentReplyMessageRenderer>();
  registerParentReplyMessageRenderers({
    registerMessageRenderer: (type, renderer) => { renderers.set(type, renderer); },
  });
  const valid = messageEnvelope("第一行 **重点**\n第二行\u001b[31m危险\u202e");
  const lines = renderers.get("wj-pi-subagents-message")!({
    customType: "wj-pi-subagents-message",
    content: [{ type: "text", text: createVisibleEnvelope(valid) }],
    details: { agent_id: AGENT_ID, kind: "message", sender_name: "鉴权\n调查" },
  }, { expanded: false, outputPad: 0 }, RENDER_THEME).render(120);
  const validDisplay = lines.join("\n");
  assert.match(validDisplay, new RegExp(`Sender: 鉴权 调查 · ${AGENT_ID}`));
  assert.match(validDisplay, /第一行 重点/);
  assert.match(validDisplay, /第二行/);
  assert.doesNotMatch(validDisplay, /\*\*重点\*\*|\u001b|\u202e/);

  const malformed = renderers.get("wj-pi-subagents-message")!({
    customType: "wj-pi-subagents-message",
    content: [{ type: "text", text: "{\"schema\":\"\u001b[31m危险\u202e\"}" }],
    details: { agent_id: AGENT_ID, kind: "message", sender_name: "过期名称" },
  }, { expanded: true, outputPad: 0 }, RENDER_THEME);
  const malformedDisplay = malformed.render(24).join("\n");
  assert.match(malformedDisplay, /无法解析结构化回复/);
  assert.doesNotMatch(malformedDisplay, /\u001b|\u202e/);
  assert.ok(malformed.render(24).every((line) => displayWidth(line) <= 24));
});

test("父回复 renderer 使用整行背景和分类颜色", () => {
  const foregrounds: string[] = [];
  const backgrounds: Array<{ color: string; text: string }> = [];
  const theme = {
    fg: (color: string, text: string): string => {
      foregrounds.push(color);
      return text;
    },
    bg: (color: string, text: string): string => {
      backgrounds.push({ color, text });
      return text;
    },
    bold: (text: string): string => text,
  };
  const renderers = new Map<string, ParentReplyMessageRenderer>();
  registerParentReplyMessageRenderers({
    registerMessageRenderer: (type, renderer) => { renderers.set(type, renderer); },
  });
  const message = {
    customType: "wj-pi-subagents-message",
    content: [{ type: "text", text: createVisibleEnvelope(messageEnvelope("工作中发现")) }],
    details: { agent_id: AGENT_ID, kind: "message" },
  };
  const messageLines = renderers.get("wj-pi-subagents-message")!(
    message,
    { expanded: true, outputPad: 1 },
    theme,
  ).render(40);
  assert.ok(foregrounds.includes("customMessageLabel"));
  assert.ok(foregrounds.includes("customMessageText"));
  assert.ok(backgrounds.length > 0);
  assert.ok(backgrounds.every((entry) =>
    entry.color === "customMessageBg" && displayWidth(entry.text) === 40));
  assert.equal(messageLines.length >= 5, true);

  foregrounds.length = 0;
  backgrounds.length = 0;
  const final = {
    customType: "wj-pi-subagents-final",
    content: [{ type: "text", text: createVisibleEnvelope(finalEnvelope("最终结果")) }],
    details: { agent_id: AGENT_ID, kind: "final" },
  };
  renderers.get("wj-pi-subagents-final")!(final, { expanded: true, outputPad: 1 }, theme).render(40);
  assert.ok(foregrounds.includes("success"));
  assert.ok(foregrounds.includes("customMessageText"));
  assert.ok(backgrounds.every((entry) =>
    entry.color === "customMessageBg" && displayWidth(entry.text) === 40));
});
