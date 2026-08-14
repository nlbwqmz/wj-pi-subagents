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
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  await settle();

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
  await new Promise<void>((resolve) => setTimeout(resolve, 35));
  await settle();

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

test("close 等待未决直接父 prepare，并以独立 not_started 释放已建立边界", async () => {
  const bus = new TestEventBus();
  const upstream = new FakeUpstreamChannel();
  let allowPrepare!: () => void;
  const prepareAllowed = new Promise<void>((resolve) => { allowPrepare = resolve; });
  upstream.prepareOperation = async () => { await prepareAllowed; return true; };
  const value = createRuntime({ upstream });
  const participant = new AutoCompactCoordinationParticipant({
    eventBus: bus,
    readRuntime: () => value.runtime,
    participantId: "participant-child",
    upstreamAckTimeoutMs: 100,
  });

  emitPrepare(bus, "participant-child", "compact-close");
  await settle();
  let closed = false;
  const closing = participant.close().then(() => { closed = true; });
  await settle();
  assert.equal(closed, false);

  allowPrepare();
  await closing;
  assert.deepEqual(upstream.requests, [
    { kind: "prepare", transactionId: "compact-close" },
    { kind: "complete", transactionId: "compact-close", outcome: "not_started" },
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
