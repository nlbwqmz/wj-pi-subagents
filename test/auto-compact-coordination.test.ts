import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTO_COMPACT_COORDINATION_CHANNELS,
  AUTO_COMPACT_COORDINATION_VERSION,
  AutoCompactCoordinationParticipant,
  type AutoCompactCoordinationEventBus,
} from "../src/auto-compact-coordination.ts";
import { ChildReplyCoordinator } from "../src/child-reply-coordinator.ts";
import { ParentReplyInbox } from "../src/parent-reply-inbox.ts";
import type { StreamSupervisorChannel } from "../src/stream-supervisor-channel.ts";
import type { SupervisorCompactionOutcome } from "../src/supervisor-channel.ts";

const PARTICIPANT_ID = "auto-compact-participant";
const AGENT_ID = "550e8400-e29b-41d4-a716-446655440000";

interface EmittedEvent {
  readonly channel: string;
  readonly value: unknown;
}

class TestEventBus implements AutoCompactCoordinationEventBus {
  readonly events: EmittedEvent[] = [];

  private readonly handlers = new Map<string, Set<(value: unknown) => void>>();

  emit(channel: string, value: unknown): void {
    this.events.push(Object.freeze({ channel, value }));
    for (const handler of [...(this.handlers.get(channel) ?? [])]) handler(value);
  }

  on(channel: string, handler: (value: unknown) => void): () => void {
    const handlers = this.handlers.get(channel) ?? new Set<(value: unknown) => void>();
    handlers.add(handler);
    this.handlers.set(channel, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.handlers.delete(channel);
    };
  }

  next(channel: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let unsubscribe = (): void => {};
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`未收到协调事件: ${channel}`));
      }, 1_000);
      unsubscribe = this.on(channel, (value) => {
        clearTimeout(timer);
        unsubscribe();
        resolve(value);
      });
    });
  }

  values(channel: string): readonly unknown[] {
    return this.events
      .filter((event) => event.channel === channel)
      .map((event) => event.value);
  }
}

interface CompleteCall {
  readonly requestId: string;
  readonly outcome: SupervisorCompactionOutcome;
  readonly continuationExpected: boolean;
}

class UpstreamChannelStub {
  readonly prepared: string[] = [];
  readonly completed: CompleteCall[] = [];
  protocolFailed = false;
  released = false;

  async requestCompactionPrepare(requestId: string, signal?: AbortSignal): Promise<boolean> {
    assert.equal(signal?.aborted, false);
    this.prepared.push(requestId);
    return true;
  }

  async requestCompactionComplete(
    requestId: string,
    outcome: SupervisorCompactionOutcome,
    signal?: AbortSignal,
    continuationExpected = false,
  ): Promise<boolean> {
    assert.equal(signal?.aborted, false);
    this.completed.push(Object.freeze({ requestId, outcome, continuationExpected }));
    return true;
  }

  failProtocol(): void {
    this.protocolFailed = true;
  }

  async release(): Promise<void> {
    this.released = true;
  }
}

interface Harness {
  readonly bus: TestEventBus;
  readonly upstream: UpstreamChannelStub;
  readonly replyCoordinator: ChildReplyCoordinator;
  readonly participant: AutoCompactCoordinationParticipant;
}

function createHarness(): Harness {
  const bus = new TestEventBus();
  const upstream = new UpstreamChannelStub();
  const replyCoordinator = new ChildReplyCoordinator({
    agentId: AGENT_ID,
    port: { publishReply: async () => {} },
  });
  const replyInbox = new ParentReplyInbox({
    readApi: () => ({ sendMessage: () => true }),
  });
  const participant = new AutoCompactCoordinationParticipant({
    eventBus: bus,
    participantId: PARTICIPANT_ID,
    readRuntime: () => ({
      replyInbox,
      replyCoordinator,
      upstream: { channel: upstream as unknown as StreamSupervisorChannel },
    }),
    upstreamAckTimeoutMs: 200,
  });
  return { bus, upstream, replyCoordinator, participant };
}

function targeted(requestId: string): Record<string, unknown> {
  return {
    protocolVersion: AUTO_COMPACT_COORDINATION_VERSION,
    requestId,
    participantId: PARTICIPANT_ID,
  };
}

async function prepare(harness: Harness, requestId: string): Promise<void> {
  const response = harness.bus.next(AUTO_COMPACT_COORDINATION_CHANNELS.prepared);
  harness.bus.emit(AUTO_COMPACT_COORDINATION_CHANNELS.prepare, targeted(requestId));
  assert.deepEqual(await response, {
    protocolVersion: AUTO_COMPACT_COORDINATION_VERSION,
    requestId,
    participantId: PARTICIPANT_ID,
    prepared: true,
  });
}

async function complete(
  harness: Harness,
  request: Record<string, unknown>,
  expectedCompleted: boolean,
): Promise<void> {
  const response = harness.bus.next(AUTO_COMPACT_COORDINATION_CHANNELS.completed);
  harness.bus.emit(AUTO_COMPACT_COORDINATION_CHANNELS.complete, request);
  assert.deepEqual(await response, {
    protocolVersion: AUTO_COMPACT_COORDINATION_VERSION,
    requestId: request.requestId,
    participantId: PARTICIPANT_ID,
    completed: expectedCompleted,
  });
}

test("complete 缺省 continuationExpected 时按 false 直传且普通成功不保留补偿", async () => {
  const harness = createHarness();
  const requestId = "ordinary-success";
  try {
    await prepare(harness, requestId);
    assert.equal(harness.replyCoordinator.hasCoordinationBarrier(), true);

    await complete(harness, {
      ...targeted(requestId),
      outcome: "succeeded",
    }, true);

    assert.deepEqual(harness.upstream.completed, [{
      requestId,
      outcome: "succeeded",
      continuationExpected: false,
    }]);
    assert.equal(harness.replyCoordinator.hasCoordinationBarrier(), false);

    await harness.participant.close();
    assert.equal(harness.upstream.completed.length, 1);
  } finally {
    await harness.participant.close();
  }
});

test("成功续跑依据请求 flag 留存同事务补偿并清除远端保护", async () => {
  const harness = createHarness();
  const requestId = "continued-success";
  try {
    await prepare(harness, requestId);
    assert.equal(
      harness.replyCoordinator.expectsCoordinationContinuation(requestId, "succeeded"),
      false,
    );
    assert.equal(harness.replyCoordinator.awaitsCoordinationContinuation(requestId), false);

    await complete(harness, {
      ...targeted(requestId),
      outcome: "succeeded",
      continuationExpected: true,
    }, true);
    await complete(harness, {
      ...targeted(requestId),
      outcome: "not_started",
    }, true);

    assert.deepEqual(harness.upstream.completed, [
      { requestId, outcome: "succeeded", continuationExpected: true },
      { requestId, outcome: "not_started", continuationExpected: false },
    ]);

    await complete(harness, {
      ...targeted(requestId),
      outcome: "not_started",
    }, true);
    assert.equal(harness.upstream.completed.length, 2);

    await harness.participant.close();
    assert.equal(harness.upstream.completed.length, 2);
  } finally {
    await harness.participant.close();
  }
});

test("无关 complete 不清除按 requestId 绑定的续跑补偿", async () => {
  const harness = createHarness();
  const requestId = "continued-before-unrelated-complete";
  try {
    await prepare(harness, requestId);
    await complete(harness, {
      ...targeted(requestId),
      outcome: "succeeded",
      continuationExpected: true,
    }, true);

    await complete(harness, {
      ...targeted("unrelated-complete"),
      outcome: "failed",
    }, false);
    await complete(harness, {
      ...targeted(requestId),
      outcome: "not_started",
    }, true);

    assert.deepEqual(harness.upstream.completed, [
      { requestId, outcome: "succeeded", continuationExpected: true },
      { requestId, outcome: "not_started", continuationExpected: false },
    ]);
  } finally {
    await harness.participant.close();
  }
});

test("真实 agent_start 消费续跑补偿记录", async () => {
  const harness = createHarness();
  const requestId = "continued-before-agent-start";
  try {
    await prepare(harness, requestId);
    await complete(harness, {
      ...targeted(requestId),
      outcome: "succeeded",
      continuationExpected: true,
    }, true);

    harness.participant.observeAgentStart();
    await complete(harness, {
      ...targeted(requestId),
      outcome: "not_started",
    }, true);

    assert.deepEqual(harness.upstream.completed, [
      { requestId, outcome: "succeeded", continuationExpected: true },
    ]);
  } finally {
    await harness.participant.close();
  }
});

test("complete 严格拒绝非 boolean flag 以及非成功事务的 true", async (t) => {
  const invalidRequests: ReadonlyArray<{
    readonly name: string;
    readonly request: (requestId: string) => Record<string, unknown>;
  }> = [
    {
      name: "字符串 flag",
      request: (requestId) => ({
        ...targeted(requestId),
        outcome: "succeeded",
        continuationExpected: "true",
      }),
    },
    {
      name: "显式 undefined flag",
      request: (requestId) => ({
        ...targeted(requestId),
        outcome: "succeeded",
        continuationExpected: undefined,
      }),
    },
    {
      name: "失败事务的 true flag",
      request: (requestId) => ({
        ...targeted(requestId),
        outcome: "failed",
        continuationExpected: true,
      }),
    },
    {
      name: "取消事务的 true flag",
      request: (requestId) => ({
        ...targeted(requestId),
        outcome: "cancelled",
        continuationExpected: true,
      }),
    },
    {
      name: "未开始事务的 true flag",
      request: (requestId) => ({
        ...targeted(requestId),
        outcome: "not_started",
        continuationExpected: true,
      }),
    },
  ];

  for (const [index, invalid] of invalidRequests.entries()) {
    await t.test(invalid.name, async () => {
      const harness = createHarness();
      const requestId = `invalid-complete-${index}`;
      try {
        await prepare(harness, requestId);
        harness.bus.emit(
          AUTO_COMPACT_COORDINATION_CHANNELS.complete,
          invalid.request(requestId),
        );
        await complete(harness, {
          ...targeted(requestId),
          outcome: "failed",
          continuationExpected: false,
        }, true);

        assert.deepEqual(harness.upstream.completed, [{
          requestId,
          outcome: "failed",
          continuationExpected: false,
        }]);
        assert.equal(
          harness.bus.values(AUTO_COMPACT_COORDINATION_CHANNELS.completed).length,
          1,
        );
      } finally {
        await harness.participant.close();
      }
    });
  }
});
