import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTO_COMPACT_COORDINATION_CHANNELS,
  AUTO_COMPACT_COORDINATION_VERSION,
  AutoCompactCoordinationParticipant,
  type AutoCompactCoordinationEventBus,
  type AutoCompactCoordinationRuntime,
} from "../src/auto-compact-coordination.ts";
import {
  CHILD_REPLY_SCHEMA,
  CHILD_REPLY_VERSION,
  type ChildMessageEnvelope,
} from "../src/child-reply-envelope.ts";
import { ChildReplyCoordinator } from "../src/child-reply-coordinator.ts";
import { ParentReplyInbox } from "../src/parent-reply-inbox.ts";
import type { StreamSupervisorChannel } from "../src/stream-supervisor-channel.ts";
import type { SupervisorCompactionComplete } from "../src/supervisor-channel.ts";

const CHILD_ID = "550e8400-e29b-41d4-a716-446655440000";
const TASK_ID = "450e8400-e29b-41d4-a716-446655440001";
const TURN_ID = "550e8400-e29b-41d4-a716-446655440001";
const COMMIT_ID = "750e8400-e29b-41d4-a716-446655440001";

class TestEventBus implements AutoCompactCoordinationEventBus {
  private readonly listeners = new Map<string, Set<(value: unknown) => void>>();
  readonly emitted: Array<{ readonly channel: string; readonly value: unknown }> = [];

  emit(channel: string, value: unknown): void {
    this.emitted.push({ channel, value });
    for (const listener of this.listeners.get(channel) ?? []) listener(value);
  }

  on(channel: string, handler: (value: unknown) => void): () => void {
    const listeners = this.listeners.get(channel) ?? new Set<(value: unknown) => void>();
    listeners.add(handler);
    this.listeners.set(channel, listeners);
    return () => listeners.delete(handler);
  }
}

class FakeUpstreamChannel {
  readonly requests: Array<{
    readonly kind: "prepare" | "complete";
    readonly transactionId: string;
    readonly outcome?: SupervisorCompactionComplete["outcome"];
  }> = [];
  protocolFailures = 0;
  releases = 0;
  prepareOperation: (transactionId: string, signal?: AbortSignal) => Promise<boolean> = async () => true;
  completeOperation: (
    transactionId: string,
    outcome: SupervisorCompactionComplete["outcome"],
    signal?: AbortSignal,
  ) => Promise<boolean> = async () => true;

  async requestCompactionPrepare(transactionId: string, signal?: AbortSignal): Promise<boolean> {
    this.requests.push({ kind: "prepare", transactionId });
    return this.prepareOperation(transactionId, signal);
  }

  async requestCompactionComplete(
    transactionId: string,
    outcome: SupervisorCompactionComplete["outcome"],
    signal?: AbortSignal,
  ): Promise<boolean> {
    this.requests.push({ kind: "complete", transactionId, outcome });
    return this.completeOperation(transactionId, outcome, signal);
  }

  failProtocol(): void {
    this.protocolFailures += 1;
  }

  async release(): Promise<void> {
    this.releases += 1;
  }
}

function workingReply(text = "直接子代理回复"): ChildMessageEnvelope {
  return Object.freeze({
    schema: CHILD_REPLY_SCHEMA,
    version: CHILD_REPLY_VERSION,
    kind: "message",
    agent_id: CHILD_ID,
    task_id: TASK_ID,
    turn_id: TURN_ID,
    text,
  });
}

function createRuntime(options: {
  readonly upstream?: FakeUpstreamChannel;
  readonly replyCoordinator?: ChildReplyCoordinator;
} = {}): {
  readonly runtime: AutoCompactCoordinationRuntime;
  readonly replyInbox: ParentReplyInbox;
  readonly acceptedMessages: unknown[];
  readonly retryCount: () => number;
} {
  const acceptedMessages: unknown[] = [];
  let retries = 0;
  const replyInbox = new ParentReplyInbox({
    readApi: () => ({ sendMessage: (message) => { acceptedMessages.push(message); } }),
    notifyMessage: () => {},
  });
  return {
    replyInbox,
    acceptedMessages,
    retryCount: () => retries,
    runtime: {
      replyInbox,
      ...(options.replyCoordinator === undefined ? {} : { replyCoordinator: options.replyCoordinator }),
      ...(options.upstream === undefined
        ? {}
        : { upstream: { channel: options.upstream as unknown as StreamSupervisorChannel } }),
      retryPendingReplies: async () => { retries += 1; },
    },
  };
}

function emitPrepare(bus: TestEventBus, participantId: string, requestId: string): void {
  bus.emit(AUTO_COMPACT_COORDINATION_CHANNELS.prepare, {
    protocolVersion: AUTO_COMPACT_COORDINATION_VERSION,
    requestId,
    participantId,
  });
}

function emitComplete(
  bus: TestEventBus,
  participantId: string,
  requestId: string,
  outcome: SupervisorCompactionComplete["outcome"],
): void {
  bus.emit(AUTO_COMPACT_COORDINATION_CHANNELS.complete, {
    protocolVersion: AUTO_COMPACT_COORDINATION_VERSION,
    requestId,
    participantId,
    outcome,
  });
}

function acknowledgement(
  bus: TestEventBus,
  channel: string,
  requestId: string,
): Record<string, unknown> | undefined {
  return bus.emitted
    .filter((event) => event.channel === channel)
    .map((event) => event.value)
    .find((value): value is Record<string, unknown> => (
      typeof value === "object"
      && value !== null
      && (value as { requestId?: unknown }).requestId === requestId
    ));
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("等待测试条件超时");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

test("发现只公开不透明参与者身份", async () => {
  const bus = new TestEventBus();
  const value = createRuntime();
  const participant = new AutoCompactCoordinationParticipant({
    eventBus: bus,
    readRuntime: () => value.runtime,
    participantId: "participant-root",
  });

  bus.emit(AUTO_COMPACT_COORDINATION_CHANNELS.discover, {
    protocolVersion: AUTO_COMPACT_COORDINATION_VERSION,
    requestId: "discover-1",
  });

  assert.deepEqual(acknowledgement(
    bus,
    AUTO_COMPACT_COORDINATION_CHANNELS.discovered,
    "discover-1",
  ), {
    protocolVersion: AUTO_COMPACT_COORDINATION_VERSION,
    requestId: "discover-1",
    participantId: "participant-root",
    requiresBarrier: true,
  });
  await participant.close();
});

test("runtime 未就绪时不参与 discovery，就绪后才公开参与者", async () => {
  const bus = new TestEventBus();
  let runtime: AutoCompactCoordinationRuntime | undefined;
  const participant = new AutoCompactCoordinationParticipant({
    eventBus: bus,
    readRuntime: () => runtime,
    participantId: "participant-late-runtime",
  });

  bus.emit(AUTO_COMPACT_COORDINATION_CHANNELS.discover, {
    protocolVersion: AUTO_COMPACT_COORDINATION_VERSION,
    requestId: "discover-before-ready",
  });
  assert.equal(acknowledgement(
    bus,
    AUTO_COMPACT_COORDINATION_CHANNELS.discovered,
    "discover-before-ready",
  ), undefined);

  runtime = createRuntime().runtime;
  bus.emit(AUTO_COMPACT_COORDINATION_CHANNELS.discover, {
    protocolVersion: AUTO_COMPACT_COORDINATION_VERSION,
    requestId: "discover-after-ready",
  });
  assert.equal(acknowledgement(
    bus,
    AUTO_COMPACT_COORDINATION_CHANNELS.discovered,
    "discover-after-ready",
  )?.participantId, "participant-late-runtime");
  await participant.close();
});

test("根会话压缩只冻结本地直接子回复入口，完成后重新接纳", async () => {
  const bus = new TestEventBus();
  const value = createRuntime();
  const participant = new AutoCompactCoordinationParticipant({
    eventBus: bus,
    readRuntime: () => value.runtime,
    participantId: "participant-root",
  });

  emitPrepare(bus, "participant-root", "compact-root");
  await settle();
  assert.equal(participant.hasPreparedBarrier(), true);
  assert.equal(value.replyInbox.accept(CHILD_ID, workingReply()), false);
  assert.deepEqual(acknowledgement(
    bus,
    AUTO_COMPACT_COORDINATION_CHANNELS.prepared,
    "compact-root",
  ), {
    protocolVersion: AUTO_COMPACT_COORDINATION_VERSION,
    requestId: "compact-root",
    participantId: "participant-root",
    prepared: true,
  });

  emitComplete(bus, "participant-root", "compact-root", "cancelled");
  await settle();
  assert.equal(participant.hasBarrier(), false);
  assert.equal(value.retryCount(), 1);
  assert.equal(value.replyInbox.accept(CHILD_ID, workingReply()), true);
  assert.equal(value.acceptedMessages.length, 1);
  assert.equal(acknowledgement(
    bus,
    AUTO_COMPACT_COORDINATION_CHANNELS.completed,
    "compact-root",
  )?.completed, true);
  await participant.close();
});

test("子会话只协调本地入口、自己的 reply 边和直接父边", async () => {
  const bus = new TestEventBus();
  const upstream = new FakeUpstreamChannel();
  const replies: unknown[] = [];
  const replyCoordinator = new ChildReplyCoordinator({
    agentId: CHILD_ID,
    port: { publishReplyAndWaitForAck: async (reply) => { replies.push(reply); } },
    taskIdFactory: () => TASK_ID,
    turnIdFactory: () => TURN_ID,
    commitIdFactory: () => COMMIT_ID,
  });
  replyCoordinator.observeAgentStart();
  const value = createRuntime({ upstream, replyCoordinator });
  const participant = new AutoCompactCoordinationParticipant({
    eventBus: bus,
    readRuntime: () => value.runtime,
    participantId: "participant-child",
    upstreamAckTimeoutMs: 100,
  });

  emitPrepare(bus, "participant-child", "compact-child");
  await settle();
  assert.deepEqual(upstream.requests, [
    { kind: "prepare", transactionId: "compact-child" },
  ]);
  assert.equal(replyCoordinator.hasCoordinationBarrier(), true);
  assert.equal(value.replyInbox.accept(CHILD_ID, workingReply()), false);

  emitComplete(bus, "participant-child", "compact-child", "failed");
  await settle();
  assert.deepEqual(upstream.requests, [
    { kind: "prepare", transactionId: "compact-child" },
    { kind: "complete", transactionId: "compact-child", outcome: "failed" },
  ]);
  assert.equal(replyCoordinator.hasCoordinationBarrier(), false);
  assert.equal(value.replyInbox.accept(CHILD_ID, workingReply()), true);
  assert.deepEqual(replies, []);
  await participant.close();
});

test("协调 manual 失败即使没有 session_compact 也会解除本地压缩屏障", async () => {
  const bus = new TestEventBus();
  const replies: unknown[] = [];
  const replyCoordinator = new ChildReplyCoordinator({
    agentId: CHILD_ID,
    port: { publishReplyAndWaitForAck: async (reply) => { replies.push(reply); } },
    taskIdFactory: () => TASK_ID,
    turnIdFactory: () => TURN_ID,
    commitIdFactory: () => COMMIT_ID,
  });
  replyCoordinator.observeAgentStart();
  replyCoordinator.observeAssistantMessageEnd({
    type: "message_end",
    message: { role: "assistant", stopReason: "aborted", content: [] },
  });
  const value = createRuntime({ replyCoordinator });
  const participant = new AutoCompactCoordinationParticipant({
    eventBus: bus,
    readRuntime: () => value.runtime,
    participantId: "participant-failed-manual",
  });

  emitPrepare(bus, "participant-failed-manual", "compact-failed-manual");
  await settle();
  assert.equal(participant.beginManualCompaction(), true);
  replyCoordinator.observeCompactionStart("manual");
  replyCoordinator.observeAgentEnd();
  replyCoordinator.settle();
  await settle();
  assert.deepEqual(replies, []);

  emitComplete(bus, "participant-failed-manual", "compact-failed-manual", "failed");
  await settle();
  await settle();
  assert.equal(replies.length, 1);
  assert.equal((replies[0] as { kind?: unknown } | undefined)?.kind, "final");
  assert.equal(participant.completeManualCompaction(), true);
  assert.equal(participant.completeManualCompaction(), false);
  await participant.close();
});

test("重复 prepare 共用首次等待，重复 complete 重放首次 terminal ACK", async () => {
  const bus = new TestEventBus();
  const upstream = new FakeUpstreamChannel();
  let allowPrepare!: () => void;
  const prepareAllowed = new Promise<void>((resolve) => { allowPrepare = resolve; });
  upstream.prepareOperation = async () => { await prepareAllowed; return true; };
  const value = createRuntime({ upstream });
  const participant = new AutoCompactCoordinationParticipant({
    eventBus: bus,
    readRuntime: () => value.runtime,
    participantId: "participant-idempotent",
    upstreamAckTimeoutMs: 100,
  });

  emitPrepare(bus, "participant-idempotent", "compact-replayed");
  emitPrepare(bus, "participant-idempotent", "compact-replayed");
  await settle();
  assert.deepEqual(upstream.requests, [
    { kind: "prepare", transactionId: "compact-replayed" },
  ]);

  allowPrepare();
  await settle();
  await settle();
  assert.deepEqual(
    bus.emitted
      .filter((event) => event.channel === AUTO_COMPACT_COORDINATION_CHANNELS.prepared)
      .map((event) => event.value as { requestId: string; prepared: boolean })
      .filter((event) => event.requestId === "compact-replayed")
      .map((event) => event.prepared),
    [true, true],
  );

  emitComplete(bus, "participant-idempotent", "compact-replayed", "cancelled");
  emitComplete(bus, "participant-idempotent", "compact-replayed", "cancelled");
  await settle();
  await settle();
  assert.deepEqual(upstream.requests, [
    { kind: "prepare", transactionId: "compact-replayed" },
    { kind: "complete", transactionId: "compact-replayed", outcome: "cancelled" },
  ]);
  emitComplete(bus, "participant-idempotent", "compact-replayed", "not_started");
  await settle();
  assert.deepEqual(
    bus.emitted
      .filter((event) => event.channel === AUTO_COMPACT_COORDINATION_CHANNELS.completed)
      .map((event) => event.value as { requestId: string; completed: boolean })
      .filter((event) => event.requestId === "compact-replayed")
      .map((event) => event.completed),
    [true, true, true],
  );
  assert.equal(participant.beginManualCompaction(), false);
  await participant.close();
});

test("无协调事务时可接管外部 manual 生命周期，并拒绝重入和并发 prepare", async () => {
  const bus = new TestEventBus();
  const value = createRuntime();
  const participant = new AutoCompactCoordinationParticipant({
    eventBus: bus,
    readRuntime: () => value.runtime,
    participantId: "participant-external-manual",
  });

  assert.equal(participant.beginUncoordinatedManualCompaction(), true);
  assert.equal(participant.beginUncoordinatedManualCompaction(), false);
  emitPrepare(bus, "participant-external-manual", "compact-during-external-manual");
  await settle();
  assert.equal(acknowledgement(
    bus,
    AUTO_COMPACT_COORDINATION_CHANNELS.prepared,
    "compact-during-external-manual",
  )?.prepared, false);
  assert.equal(participant.completeUncoordinatedManualCompaction(), true);
  assert.equal(participant.completeUncoordinatedManualCompaction(), false);
  await participant.close();
});

test("多个未消费 manual 授权存在歧义时拒绝按插入顺序选择", async () => {
  const bus = new TestEventBus();
  const value = createRuntime();
  const participant = new AutoCompactCoordinationParticipant({
    eventBus: bus,
    readRuntime: () => value.runtime,
    participantId: "participant-manual-order",
  });

  emitPrepare(bus, "participant-manual-order", "compact-manual-old");
  await settle();
  emitComplete(bus, "participant-manual-order", "compact-manual-old", "succeeded");
  await settle();

  emitPrepare(bus, "participant-manual-order", "compact-manual-current");
  await settle();
  assert.equal(participant.beginManualCompaction(), false);

  participant.revokePendingManualCompactionAuthorization();
  emitComplete(bus, "participant-manual-order", "compact-manual-current", "not_started");
  await settle();

  assert.equal(participant.beginManualCompaction(), false);
  await participant.close();
});

test("native 撤销只清理 pending，不影响已开始的 manual 生命周期", async () => {
  const bus = new TestEventBus();
  const value = createRuntime();
  const participant = new AutoCompactCoordinationParticipant({
    eventBus: bus,
    readRuntime: () => value.runtime,
    participantId: "participant-active-manual",
  });

  emitPrepare(bus, "participant-active-manual", "compact-active-manual");
  await settle();
  assert.equal(participant.beginManualCompaction(), true);

  participant.revokePendingManualCompactionAuthorization();
  emitComplete(bus, "participant-active-manual", "compact-active-manual", "succeeded");
  await settle();

  assert.equal(participant.completeManualCompaction(), true);
  assert.equal(participant.completeManualCompaction(), false);
  assert.equal(participant.beginManualCompaction(), false);
  await participant.close();
});

test("先到 terminal complete 固定事务结果，迟到 prepare 不再安装 barrier", async () => {
  const bus = new TestEventBus();
  const value = createRuntime();
  const participant = new AutoCompactCoordinationParticipant({
    eventBus: bus,
    readRuntime: () => value.runtime,
    participantId: "participant-terminal-first",
  });

  emitComplete(bus, "participant-terminal-first", "compact-terminal-first", "cancelled");
  emitComplete(bus, "participant-terminal-first", "compact-terminal-first", "failed");
  emitPrepare(bus, "participant-terminal-first", "compact-terminal-first");
  await settle();
  await settle();

  assert.deepEqual(
    bus.emitted
      .filter((event) => event.channel === AUTO_COMPACT_COORDINATION_CHANNELS.completed)
      .map((event) => event.value as { requestId: string; completed: boolean })
      .filter((event) => event.requestId === "compact-terminal-first")
      .map((event) => event.completed),
    [false, false],
  );
  assert.equal(acknowledgement(
    bus,
    AUTO_COMPACT_COORDINATION_CHANNELS.prepared,
    "compact-terminal-first",
  )?.prepared, false);
  assert.equal(participant.hasBarrier(), false);
  assert.equal(value.replyInbox.accept(CHILD_ID, workingReply()), true);
  await participant.close();
});

test("不同会话参与者并行准备，不受另一会话上游等待阻塞", async () => {
  const bus = new TestEventBus();
  const rootValue = createRuntime();
  const upstream = new FakeUpstreamChannel();
  let releaseChild!: () => void;
  const childAllowed = new Promise<void>((resolve) => { releaseChild = resolve; });
  upstream.prepareOperation = async () => { await childAllowed; return true; };
  const childValue = createRuntime({ upstream });
  const root = new AutoCompactCoordinationParticipant({
    eventBus: bus,
    readRuntime: () => rootValue.runtime,
    participantId: "participant-root",
  });
  const child = new AutoCompactCoordinationParticipant({
    eventBus: bus,
    readRuntime: () => childValue.runtime,
    participantId: "participant-child",
    upstreamAckTimeoutMs: 100,
  });

  emitPrepare(bus, "participant-child", "compact-child-slow");
  emitPrepare(bus, "participant-root", "compact-root-fast");
  await settle();
  assert.equal(acknowledgement(
    bus,
    AUTO_COMPACT_COORDINATION_CHANNELS.prepared,
    "compact-root-fast",
  )?.prepared, true);
  assert.equal(acknowledgement(
    bus,
    AUTO_COMPACT_COORDINATION_CHANNELS.prepared,
    "compact-child-slow",
  ), undefined);

  releaseChild();
  await settle();
  assert.equal(acknowledgement(
    bus,
    AUTO_COMPACT_COORDINATION_CHANNELS.prepared,
    "compact-child-slow",
  )?.prepared, true);
  emitComplete(bus, "participant-root", "compact-root-fast", "not_started");
  emitComplete(bus, "participant-child", "compact-child-slow", "not_started");
  await settle();
  await Promise.all([root.close(), child.close()]);
});

test("complete 业务响应不确定时补发同事务 not_started", async () => {
  const bus = new TestEventBus();
  const upstream = new FakeUpstreamChannel();
  upstream.completeOperation = async (_transactionId, outcome) => {
    if (outcome === "succeeded") return new Promise<boolean>(() => {});
    return false;
  };
  const value = createRuntime({ upstream });
  const participant = new AutoCompactCoordinationParticipant({
    eventBus: bus,
    readRuntime: () => value.runtime,
    participantId: "participant-child",
    upstreamAckTimeoutMs: 10,
  });

  emitPrepare(bus, "participant-child", "compact-uncertain");
  await settle();
  emitComplete(bus, "participant-child", "compact-uncertain", "succeeded");
  await waitFor(() => acknowledgement(
    bus,
    AUTO_COMPACT_COORDINATION_CHANNELS.completed,
    "compact-uncertain",
  )?.completed === false);

  assert.deepEqual(upstream.requests, [
    { kind: "prepare", transactionId: "compact-uncertain" },
    { kind: "complete", transactionId: "compact-uncertain", outcome: "succeeded" },
    { kind: "complete", transactionId: "compact-uncertain", outcome: "not_started" },
  ]);
  assert.equal(upstream.protocolFailures, 0);
  assert.equal(upstream.releases, 0);
  assert.equal(acknowledgement(
    bus,
    AUTO_COMPACT_COORDINATION_CHANNELS.completed,
    "compact-uncertain",
  )?.completed, false);
  await participant.close();
});

test("complete 与补偿都无业务响应时废止直接上游通道", async () => {
  const bus = new TestEventBus();
  const upstream = new FakeUpstreamChannel();
  upstream.completeOperation = async () => new Promise<boolean>(() => {});
  const value = createRuntime({ upstream });
  const participant = new AutoCompactCoordinationParticipant({
    eventBus: bus,
    readRuntime: () => value.runtime,
    participantId: "participant-child",
    upstreamAckTimeoutMs: 10,
  });

  emitPrepare(bus, "participant-child", "compact-unrecoverable");
  await settle();
  emitComplete(bus, "participant-child", "compact-unrecoverable", "succeeded");
  await waitFor(() => upstream.protocolFailures === 1 && upstream.releases === 1);

  assert.equal(upstream.protocolFailures, 1);
  assert.equal(upstream.releases, 1);
  await participant.close();
});

test("成功 complete 后同事务 not_started 撤销 continuation 等待并发布旧 interrupted final", async () => {
  const bus = new TestEventBus();
  const upstream = new FakeUpstreamChannel();
  const replies: Array<{ readonly kind: string; readonly run_state?: string }> = [];
  const replyCoordinator = new ChildReplyCoordinator({
    agentId: CHILD_ID,
    port: { publishReplyAndWaitForAck: async (reply) => { replies.push(reply); } },
    taskIdFactory: () => TASK_ID,
    turnIdFactory: () => TURN_ID,
    commitIdFactory: () => COMMIT_ID,
  });
  replyCoordinator.observeAgentStart();
  const value = createRuntime({ upstream, replyCoordinator });
  const participant = new AutoCompactCoordinationParticipant({
    eventBus: bus,
    readRuntime: () => value.runtime,
    participantId: "participant-child",
    upstreamAckTimeoutMs: 100,
  });

  emitPrepare(bus, "participant-child", "compact-compensated");
  await settle();
  replyCoordinator.observeAssistantMessageEnd({
    type: "message_end",
    message: { role: "assistant", stopReason: "aborted", content: [] },
  });
  replyCoordinator.observeAgentEnd();
  replyCoordinator.settle();
  emitComplete(bus, "participant-child", "compact-compensated", "succeeded");
  await settle();
  assert.equal(replyCoordinator.awaitsCoordinationContinuation("compact-compensated"), true);

  emitComplete(bus, "participant-child", "compact-compensated", "not_started");
  await settle();
  await settle();
  assert.deepEqual(replies.map((reply) => ({ kind: reply.kind, run_state: reply.run_state })), [
    { kind: "final", run_state: "interrupted" },
  ]);
  const completed = bus.emitted
    .filter((event) => event.channel === AUTO_COMPACT_COORDINATION_CHANNELS.completed)
    .map((event) => event.value as { requestId: string; completed: boolean })
    .filter((event) => event.requestId === "compact-compensated");
  assert.deepEqual(completed, [
    {
      protocolVersion: AUTO_COMPACT_COORDINATION_VERSION,
      requestId: "compact-compensated",
      participantId: "participant-child",
      completed: true,
    },
    {
      protocolVersion: AUTO_COMPACT_COORDINATION_VERSION,
      requestId: "compact-compensated",
      participantId: "participant-child",
      completed: true,
    },
  ]);
  await participant.close();
});

test("prepare 明确拒绝时释放本地令牌并向直接父发送 not_started", async () => {
  const bus = new TestEventBus();
  const upstream = new FakeUpstreamChannel();
  upstream.prepareOperation = async () => false;
  const value = createRuntime({ upstream });
  const participant = new AutoCompactCoordinationParticipant({
    eventBus: bus,
    readRuntime: () => value.runtime,
    participantId: "participant-child",
    upstreamAckTimeoutMs: 100,
  });

  emitPrepare(bus, "participant-child", "compact-rejected");
  await settle();
  assert.deepEqual(upstream.requests, [
    { kind: "prepare", transactionId: "compact-rejected" },
    { kind: "complete", transactionId: "compact-rejected", outcome: "not_started" },
  ]);
  assert.equal(participant.hasBarrier(), false);
  assert.equal(value.replyInbox.accept(CHILD_ID, workingReply()), true);
  assert.equal(acknowledgement(
    bus,
    AUTO_COMPACT_COORDINATION_CHANNELS.prepared,
    "compact-rejected",
  )?.prepared, false);
  await participant.close();
});

test("close 主动取消未决 prepare，并用独立清理请求释放边界", async () => {
  const bus = new TestEventBus();
  const upstream = new FakeUpstreamChannel();
  let prepareSignal: AbortSignal | undefined;
  upstream.prepareOperation = async (_transactionId, signal) => {
    prepareSignal = signal;
    return new Promise<boolean>(() => {});
  };
  const value = createRuntime({ upstream });
  const participant = new AutoCompactCoordinationParticipant({
    eventBus: bus,
    readRuntime: () => value.runtime,
    participantId: "participant-child",
    upstreamAckTimeoutMs: 60_000,
  });

  emitPrepare(bus, "participant-child", "compact-close");
  await settle();
  assert.equal(prepareSignal?.aborted, false);

  const closing = participant.close();
  assert.equal(prepareSignal?.aborted, true);
  await closing;
  assert.deepEqual(upstream.requests, [
    { kind: "prepare", transactionId: "compact-close" },
    { kind: "complete", transactionId: "compact-close", outcome: "not_started" },
  ]);
  assert.equal(participant.hasBarrier(), false);
  assert.equal(value.replyInbox.accept(CHILD_ID, workingReply()), true);
});

test("close 的清理 deadline 不被可配置业务 ACK 期限放大", async () => {
  const bus = new TestEventBus();
  const upstream = new FakeUpstreamChannel();
  let prepareSignal: AbortSignal | undefined;
  let cleanupSignal: AbortSignal | undefined;
  upstream.prepareOperation = async (_transactionId, signal) => {
    prepareSignal = signal;
    return new Promise<boolean>(() => {});
  };
  upstream.completeOperation = async (_transactionId, _outcome, signal) => {
    cleanupSignal = signal;
    return new Promise<boolean>(() => {});
  };
  const value = createRuntime({ upstream });
  const participant = new AutoCompactCoordinationParticipant({
    eventBus: bus,
    readRuntime: () => value.runtime,
    participantId: "participant-bounded-close",
    upstreamAckTimeoutMs: 60_000,
  });

  emitPrepare(bus, "participant-bounded-close", "compact-bounded-close");
  await settle();
  const closing = participant.close();
  assert.equal(prepareSignal?.aborted, true);

  let deadline: ReturnType<typeof setTimeout>;
  const verdict = await Promise.race([
    closing.then(() => {
      clearTimeout(deadline);
      return "closed" as const;
    }),
    new Promise<"timed_out">((resolve) => {
      deadline = setTimeout(() => resolve("timed_out"), 2_000);
    }),
  ]);
  assert.equal(verdict, "closed");
  assert.equal(cleanupSignal?.aborted, true);
  assert.equal(upstream.protocolFailures, 1);
  assert.equal(upstream.releases, 1);
  assert.equal(value.replyInbox.accept(CHILD_ID, workingReply()), true);
});

test("close 主动取消未决 complete，并以未取消的 deadline 补偿", async () => {
  const bus = new TestEventBus();
  const upstream = new FakeUpstreamChannel();
  let completeSignal: AbortSignal | undefined;
  let cleanupSignal: AbortSignal | undefined;
  upstream.completeOperation = async (_transactionId, outcome, signal) => {
    if (outcome === "succeeded") {
      completeSignal = signal;
      return new Promise<boolean>(() => {});
    }
    cleanupSignal = signal;
    return true;
  };
  const value = createRuntime({ upstream });
  const participant = new AutoCompactCoordinationParticipant({
    eventBus: bus,
    readRuntime: () => value.runtime,
    participantId: "participant-complete-close",
    upstreamAckTimeoutMs: 60_000,
  });

  emitPrepare(bus, "participant-complete-close", "compact-complete-close");
  await settle();
  emitComplete(bus, "participant-complete-close", "compact-complete-close", "succeeded");
  await settle();
  assert.equal(completeSignal?.aborted, false);

  const closing = participant.close();
  assert.equal(completeSignal?.aborted, true);
  await closing;
  assert.equal(cleanupSignal?.aborted, false);
  assert.deepEqual(upstream.requests, [
    { kind: "prepare", transactionId: "compact-complete-close" },
    { kind: "complete", transactionId: "compact-complete-close", outcome: "succeeded" },
    { kind: "complete", transactionId: "compact-complete-close", outcome: "not_started" },
  ]);
  assert.equal(participant.hasBarrier(), false);
  assert.equal(value.replyInbox.accept(CHILD_ID, workingReply()), true);
});

test("本地 reply 屏障拒绝时不会请求直接父级", async () => {
  const bus = new TestEventBus();
  const upstream = new FakeUpstreamChannel();
  const replyCoordinator = new ChildReplyCoordinator({
    agentId: CHILD_ID,
    port: { publishReplyAndWaitForAck: async () => {} },
    taskIdFactory: () => "invalid-task-id",
  });
  assert.throws(() => replyCoordinator.observeAgentStart(), /invalid_child_task_identity/);
  const value = createRuntime({ upstream, replyCoordinator });
  const participant = new AutoCompactCoordinationParticipant({
    eventBus: bus,
    readRuntime: () => value.runtime,
    participantId: "participant-child",
  });

  emitPrepare(bus, "participant-child", "compact-local-rejected");
  await settle();
  assert.deepEqual(upstream.requests, []);
  assert.equal(value.replyInbox.completeSessionCompactionBarrier("compact-local-rejected"), false);
  assert.equal(acknowledgement(
    bus,
    AUTO_COMPACT_COORDINATION_CHANNELS.prepared,
    "compact-local-rejected",
  )?.prepared, false);
  await participant.close();
});
