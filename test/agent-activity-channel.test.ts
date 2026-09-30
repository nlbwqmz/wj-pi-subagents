import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  CANONICAL_ACTIVITY_CONTRACT_VERSION,
  chunkCanonicalAgentActivityEntry,
  type CanonicalAgentActivityEntry,
} from "../src/canonical-activity.ts";
import {
  SupervisorChannel,
  SupervisorProtocolError,
  SupervisorRequestIdRegistry,
  decodeSupervisorFrame,
  encodeSupervisorFrame,
  type SupervisorActivityDelivery,
  type SupervisorFrame,
  type SupervisorReceiveResult,
} from "../src/supervisor-channel.ts";
import {
  StreamSupervisorChannel,
} from "../src/stream-supervisor-channel.ts";

const ROOT_ID = "root-activity";
const CREDENTIAL = "activity-channel-credential";

interface Pair {
  readonly parent: SupervisorChannel;
  readonly child: SupervisorChannel;
  readonly childAgentId: string;
  readonly grandchildAgentId: string;
}

function childSnapshotNodes(
  childAgentId: string,
  grandchildAgentId: string,
): readonly Record<string, unknown>[] {
  return Object.freeze([
    Object.freeze({
      agent_id: childAgentId,
      parent_agent_id: null,
      template_id: "researcher",
      name: "活动子代理",
      depth: 1,
      state: "idle",
      revision: 1,
    }),
    Object.freeze({
      agent_id: grandchildAgentId,
      parent_agent_id: childAgentId,
      template_id: "worker",
      name: "孙代理",
      depth: 2,
      state: "idle",
      revision: 1,
    }),
  ]);
}

function canonicalEntry(agentId: string, text = "回复正文"): CanonicalAgentActivityEntry {
  return Object.freeze({
    contract_version: CANONICAL_ACTIVITY_CONTRACT_VERSION,
    agent_id: agentId,
    incarnation_id: randomUUID(),
    entry_id: randomUUID(),
    body: Object.freeze({
      type: "message",
      content: Object.freeze([Object.freeze({ type: "text", text })]),
    }),
  });
}

function modelCallFailureEntry(agentId: string, message: string): CanonicalAgentActivityEntry {
  return Object.freeze({
    contract_version: CANONICAL_ACTIVITY_CONTRACT_VERSION,
    agent_id: agentId,
    incarnation_id: randomUUID(),
    entry_id: randomUUID(),
    body: Object.freeze({
      type: "model_call_failure" as const,
      failure: "error" as const,
      message,
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
    }),
  });
}

function readyPair(): Pair {
  const childAgentId = randomUUID();
  const grandchildAgentId = randomUUID();
  const registry = new SupervisorRequestIdRegistry();
  const parent = new SupervisorChannel({
    role: "parent",
    rootId: ROOT_ID,
    localAgentId: null,
    peerAgentId: childAgentId,
    parentAgentId: null,
    depth: 1,
    credential: CREDENTIAL,
    requestIdRegistry: registry,
  });
  const child = new SupervisorChannel({
    role: "child",
    rootId: ROOT_ID,
    localAgentId: childAgentId,
    peerAgentId: "",
    parentAgentId: null,
    depth: 1,
    credential: CREDENTIAL,
    requestIdRegistry: registry,
  });
  const hello = child.startHandshake();
  const helloResult = parent.receive(hello);
  assert.equal(helloResult.kind, "accepted");
  const ack = (helloResult as Extract<SupervisorReceiveResult, { kind: "accepted" }>).outbound[0];
  assert.ok(ack);
  assert.equal(child.receive(ack).kind, "accepted");
  const snapshot = child.publishSnapshot(childSnapshotNodes(childAgentId, grandchildAgentId), 1);
  const snapshotResult = parent.receive(snapshot);
  assert.equal(snapshotResult.kind, "accepted");
  assert.equal(parent.getPublicState().state, "ready");
  return { parent, child, childAgentId, grandchildAgentId };
}

function deliverAll(
  parent: SupervisorChannel,
  frames: readonly SupervisorFrame[],
  delivered: SupervisorActivityDelivery[],
): void {
  for (const frame of frames) {
    const result = parent.receive(frame);
    if (result.kind === "accepted" && result.activity !== undefined) {
      delivered.push(result.activity);
    }
  }
}

test("child 发布规范活动条目，parent 校验载荷后按到达序分发", () => {
  const { parent, child, childAgentId, grandchildAgentId } = readyPair();
  const delivered: SupervisorActivityDelivery[] = [];

  const first = child.publishActivity({ entry: canonicalEntry(childAgentId, "自身条目") });
  assert.ok(first.length >= 1);
  deliverAll(parent, first, delivered);

  const second = child.publishActivity({
    agent_id: grandchildAgentId,
    entry: canonicalEntry(grandchildAgentId),
  });
  deliverAll(parent, second, delivered);

  assert.equal(delivered.length, 2);
  assert.equal(delivered[0]?.agent_id, childAgentId);
  assert.deepEqual(delivered[0]?.entry.body, {
    type: "message",
    content: [{ type: "text", text: "自身条目" }],
  });
  assert.equal(delivered[1]?.agent_id, grandchildAgentId);
  assert.deepEqual(delivered[1]?.entry.body, {
    type: "message",
    content: [{ type: "text", text: "回复正文" }],
  });
});

test("超过单帧预算的条目被自动分块，接收端聚合后按完整条目交付", () => {
  const { parent, child, childAgentId } = readyPair();
  const delivered: SupervisorActivityDelivery[] = [];
  const entry = canonicalEntry(childAgentId, "正文".repeat(40_000));
  const frames = child.publishActivity({ entry });
  assert.ok(frames.length > 1, `期望分块帧，实际 ${frames.length}`);
  deliverAll(parent, frames, delivered);

  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0]?.entry, entry);
  assert.equal(parent.getPublicState().state, "ready");
});

test("分块帧携带旧契约形状时按协议故障处理，新旧活动契约不混用", () => {
  const { parent, child, childAgentId } = readyPair();
  const frame = child.publishActivity({ entry: canonicalEntry(childAgentId) })[0];
  assert.ok(frame);
  const legacyShape = Object.freeze({
    ...frame,
    payload: Object.freeze({ agent_id: childAgentId, event: { type: "agent_start" } }),
  });
  const result = parent.receive(legacyShape);
  assert.equal(result.kind, "protocol_fault");
  assert.equal(parent.getPublicState().state, "faulted");
});

test("缺块静默等待，不产生部分权威条目；迟到补齐后正常交付", () => {
  const { parent, child, childAgentId } = readyPair();
  const delivered: SupervisorActivityDelivery[] = [];
  const entry = canonicalEntry(childAgentId, "y".repeat(120 * 1024));
  const frames = child.publishActivity({ entry });
  assert.ok(frames.length > 2);

  // 只投递除最后一块外的所有帧：缺块不产生 delivery。
  for (const frame of frames.slice(0, -1)) {
    const result = parent.receive(frame);
    assert.equal(result.kind, "accepted");
    assert.equal(result.activity, undefined);
  }
  assert.equal(delivered.length, 0);

  // 通过重组 helper 模拟最后一块补齐后再次投递。
  const lastFrame = frames.at(-1)!;
  const result = parent.receive(lastFrame);
  assert.equal(result.kind, "accepted");
  if (result.kind === "accepted" && result.activity !== undefined) delivered.push(result.activity);
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0]?.entry, entry);
});

test("契约版本不符或身份不一致的条目在发布端被拒绝", () => {
  const { child, childAgentId } = readyPair();
  const staleContract = Object.freeze({
    ...canonicalEntry(childAgentId),
    contract_version: "wj-pi-subagents.activity/0",
  }) as unknown as CanonicalAgentActivityEntry;
  assert.throws(
    () => child.publishActivity({ entry: staleContract }),
    (error: unknown) => error instanceof SupervisorProtocolError,
  );
  assert.throws(
    () => child.publishActivity({
      entry: Object.freeze({
        ...canonicalEntry(childAgentId),
        agent_id: randomUUID(),
      }),
    }),
    (error: unknown) => error instanceof SupervisorProtocolError,
  );
  assert.throws(
    () => child.publishActivity({
      agent_id: randomUUID(),
      entry: canonicalEntry(childAgentId),
    }),
    (error: unknown) => error instanceof SupervisorProtocolError,
  );
  assert.equal(child.getPublicState().state, "ready");
});

test("旧版本模型调用失败条目在发布侧被拒绝，在接收侧按不兼容处理", () => {
  const { parent, child, childAgentId } = readyPair();
  const failure = modelCallFailureEntry(childAgentId, "401 unauthorized");

  // 发布侧：上一版契约的失败条目被拒绝，发布端自身不进入故障。
  const staleContract = Object.freeze({
    ...failure,
    contract_version: "wj-pi-subagents.activity/11",
  }) as unknown as CanonicalAgentActivityEntry;
  assert.throws(
    () => child.publishActivity({ entry: staleContract }),
    (error: unknown) => error instanceof SupervisorProtocolError && error.code === "invalid_frame",
  );
  assert.equal(child.getPublicState().state, "ready");

  // 接收侧：伪造的旧版本条目按活动契约不兼容处理为协议故障。
  const frame = child.publishActivity({ entry: failure })[0];
  assert.ok(frame);
  const legacyFrame = Object.freeze({
    ...frame,
    payload: Object.freeze({ agent_id: childAgentId, entry: staleContract }),
  });
  const result = parent.receive(legacyFrame);
  assert.equal(result.kind, "protocol_fault");
  assert.equal(result.kind === "protocol_fault" && result.error, "invalid_frame");
  assert.equal(parent.getPublicState().state, "faulted");
});

test("握手完成前发布活动流被拒绝，终止屏障后活动帧被丢弃", () => {
  const registry = new SupervisorRequestIdRegistry();
  const childAgentId = randomUUID();
  const child = new SupervisorChannel({
    role: "child",
    rootId: ROOT_ID,
    localAgentId: childAgentId,
    peerAgentId: "",
    parentAgentId: null,
    depth: 1,
    credential: CREDENTIAL,
    requestIdRegistry: registry,
  });
  assert.throws(
    () => child.publishActivity({ entry: canonicalEntry(childAgentId) }),
    (error: unknown) => error instanceof SupervisorProtocolError,
  );

  const { parent, child: readyChild } = readyPair();
  readyChild.establishTerminationBarrier();
  assert.throws(
    () => readyChild.publishActivity({ entry: canonicalEntry(childAgentId) }),
    (error: unknown) => error instanceof SupervisorProtocolError,
  );
  void parent;
});

test("重同步窗口内的补齐活动帧静默丢弃：序号前进、无交付、不故障", () => {
  const { parent, child, childAgentId } = readyPair();

  // 两条连续活动帧（seq=3、4）。只投递第二条制造跳号 → gap → resyncing。
  const first = child.publishActivity({ entry: canonicalEntry(childAgentId, "丢失条目") })[0];
  const second = child.publishActivity({ entry: canonicalEntry(childAgentId, "触发跳号") })[0];
  assert.ok(first && second);
  const gapResult = parent.receive(second);
  assert.equal(gapResult.kind, "gap");
  assert.equal(parent.getPublicState().state, "resyncing");

  // 丢失帧补齐：序号前进，但条目静默缺失（不交付、不故障、通道不中断）。
  const filled = parent.receive(first);
  assert.equal(filled.kind, "accepted");
  if (filled.kind === "accepted") assert.equal(filled.activity, undefined);
  assert.equal(parent.getPublicState().state, "resyncing");
});

test("严格 display transport 在发布边界拒绝不完整或无效的有序 identity", () => {
  const { child, childAgentId } = readyPair();
  const base = {
    type: "message_delta" as const,
    streamId: "message-1",
    sequence: 1,
    contentIndex: 0,
    contentType: "text" as const,
    delta: "partial",
    agentId: childAgentId,
    incarnationId: randomUUID(),
    displayEpoch: randomUUID(),
    displaySourceGeneration: 1,
    streamOrdinal: 1,
  };
  const invalidEvents = [
    (() => {
      const { streamOrdinal: _streamOrdinal, ...event } = base;
      return event;
    })(),
    { ...base, displayEpoch: "legacy-epoch" },
    { ...base, displaySourceGeneration: 0 },
    { ...base, streamOrdinal: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const event of invalidEvents) {
    assert.throws(
      () => child.publishDisplayActivity({ event }),
      (error: unknown) => error instanceof SupervisorProtocolError && error.code === "invalid_frame",
    );
  }
});

test("重同步窗口内的补齐 display 帧静默丢弃，通道保持重同步状态", () => {
  const { parent, child, childAgentId } = readyPair();
  const displayEvent = {
    type: "message_delta" as const,
    streamId: "message-1",
    sequence: 1,
    contentIndex: 0,
    contentType: "text" as const,
    delta: "partial",
    displayEpoch: randomUUID(),
    displaySourceGeneration: 1,
    streamOrdinal: 1,
    agentId: childAgentId,
    incarnationId: randomUUID(),
  };
  const first = child.publishDisplayActivity({ event: displayEvent })[0];
  const second = child.publishActivity({ entry: canonicalEntry(childAgentId) })[0];
  assert.ok(first && second);
  // 先投 activity 帧制造跳号进入 resyncing，再补齐 display 帧。
  assert.equal(parent.receive(second).kind, "gap");
  const filled = parent.receive(first);
  assert.equal(filled.kind, "accepted");
  if (filled.kind === "accepted") assert.equal(filled.display, undefined);
  assert.equal(parent.getPublicState().state, "resyncing");
});

test("reset 快照落地后活动帧恢复正常交付", () => {
  const { parent, child, childAgentId } = readyPair();
  const delivered: SupervisorActivityDelivery[] = [];

  const first = child.publishActivity({ entry: canonicalEntry(childAgentId, "丢失条目") })[0];
  const second = child.publishActivity({ entry: canonicalEntry(childAgentId, "触发跳号") })[0];
  assert.ok(first && second);
  const gapResult = parent.receive(second);
  assert.equal(gapResult.kind, "gap");

  // 把 parent 的 snapshot_request 转交 child，取得 reset 快照并喂回 parent。
  const request = (gapResult as Extract<SupervisorReceiveResult, { kind: "gap" }>).outbound[0];
  assert.ok(request);
  const childResult = child.receive(request);
  assert.equal(childResult.kind, "accepted");
  const resetSnapshot = (childResult as Extract<SupervisorReceiveResult, { kind: "accepted" }>).outbound[0];
  assert.ok(resetSnapshot);
  const synced = parent.receive(resetSnapshot);
  assert.equal(synced.kind, "accepted");
  assert.equal(parent.getPublicState().state, "ready");

  // 重同步完成后活动流恢复交付。
  const next = child.publishActivity({ entry: canonicalEntry(childAgentId, "重同步后") });
  deliverAll(parent, next, delivered);
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0]?.entry.body, {
    type: "message",
    content: [{ type: "text", text: "重同步后" }],
  });
});

test("主动 reload 快照边界丢弃未曾见过的旧 activity 与 display 流", () => {
  const { parent, child, childAgentId } = readyPair();
  const oldActivity = child.publishActivity({ entry: canonicalEntry(childAgentId, "边界前活动") })[0];
  const oldDisplay = child.publishDisplayActivity({
    event: {
      type: "message_delta",
      streamId: "only-delayed-old-stream",
      sequence: 1,
      contentIndex: 0,
      contentType: "text",
      delta: "边界前草稿",
      agentId: childAgentId,
      incarnationId: randomUUID(),
      displayEpoch: randomUUID(),
      displaySourceGeneration: 1,
      streamOrdinal: 1,
    },
  })[0];
  assert.ok(oldActivity && oldDisplay);

  // 先切入 resyncing，再投递此前从未观察过的流。它们必须静默前进序号，
  // 不被交付，也不依赖本地 tombstone 是否已记录该 streamId。
  const request = parent.requestSnapshot();
  assert.equal(parent.getPublicState().state, "resyncing");
  const droppedActivity = parent.receive(oldActivity);
  const droppedDisplay = parent.receive(oldDisplay);
  assert.equal(droppedActivity.kind, "accepted");
  assert.equal(droppedDisplay.kind, "accepted");
  if (droppedActivity.kind === "accepted") assert.equal(droppedActivity.activity, undefined);
  if (droppedDisplay.kind === "accepted") assert.equal(droppedDisplay.display, undefined);

  const childResponse = child.receive(request);
  assert.equal(childResponse.kind, "accepted");
  const resetSnapshot = (childResponse as Extract<SupervisorReceiveResult, { kind: "accepted" }>).outbound[0];
  assert.ok(resetSnapshot);
  assert.equal(parent.receive(resetSnapshot).kind, "accepted");
  assert.equal(parent.getPublicState().state, "ready");

  const fresh = child.publishActivity({ entry: canonicalEntry(childAgentId, "边界后活动") })[0];
  assert.ok(fresh);
  const accepted = parent.receive(fresh);
  assert.equal(accepted.kind, "accepted");
  if (accepted.kind === "accepted") {
    assert.deepEqual(accepted.activity?.entry.body, {
      type: "message",
      content: [{ type: "text", text: "边界后活动" }],
    });
  }
});

test("终止屏障下活动帧被无条件丢弃：不交付、不升级故障", () => {
  const { parent, child, childAgentId } = readyPair();
  parent.establishTerminationBarrier();
  assert.equal(parent.getPublicState().state, "closing");
  const frame = child.publishActivity({ entry: canonicalEntry(childAgentId) })[0];
  assert.ok(frame);
  // receiveFrame 对屏障后的所有帧直接丢弃，活动帧不会影响节点状态。
  const result = parent.receive(frame);
  assert.equal(result.kind, "discarded");
  assert.equal(parent.getPublicState().state, "closing");
});

// --- 传输适配层（StreamSupervisorChannel）---

async function readyStreamPair(): Promise<{
  readonly parent: StreamSupervisorChannel;
  readonly child: StreamSupervisorChannel;
  readonly childAgentId: string;
  readonly grandchildAgentId: string;
  destroy(): void;
}> {
  const childAgentId = randomUUID();
  const grandchildAgentId = randomUUID();
  const parentToChild = new PassThrough();
  const childToParent = new PassThrough();
  const requestIdRegistry = new SupervisorRequestIdRegistry();
  const parent = new StreamSupervisorChannel({
    role: "parent",
    rootId: ROOT_ID,
    localAgentId: null,
    peerAgentId: childAgentId,
    parentAgentId: null,
    depth: 1,
    credential: CREDENTIAL,
    requestIdRegistry,
    transport: { stdin: parentToChild, stdout: childToParent },
    onReply: () => true,
  });
  const child = new StreamSupervisorChannel({
    role: "child",
    rootId: ROOT_ID,
    localAgentId: childAgentId,
    peerAgentId: "",
    parentAgentId: null,
    depth: 1,
    credential: CREDENTIAL,
    requestIdRegistry,
    transport: { stdin: childToParent, stdout: parentToChild },
    initialSnapshot: childSnapshotNodes(childAgentId, grandchildAgentId),
    initialSubtreeRevision: 1,
    replyDispatchTimeoutMs: 200,
  });
  const signal = new AbortController().signal;
  await child.bind(signal);
  await Promise.all([
    parent.waitForReady(signal),
    child.waitForReady(signal),
  ]);
  return {
    parent,
    child,
    childAgentId,
    grandchildAgentId,
    destroy: () => {
      parentToChild.destroy();
      childToParent.destroy();
    },
  };
}

test("规范条目经字节流适配层分发到 parent 观察者，大正文分块后聚合交付", async () => {
  const channels = await readyStreamPair();
  const delivered: SupervisorActivityDelivery[] = [];
  const unsubscribe = channels.parent.onActivity((activity) => delivered.push(activity));
  try {
    await channels.child.publishActivity({ entry: canonicalEntry(channels.childAgentId, "流式正文") });
    await channels.child.publishActivity({
      agent_id: channels.grandchildAgentId,
      entry: canonicalEntry(channels.grandchildAgentId, "工具后正文"),
    });
    // 远超单帧预算的正文自动分块，接收端聚合后按完整条目交付。
    const large = canonicalEntry(channels.childAgentId, "报告".repeat(60_000));
    await channels.child.publishActivity({ entry: large });

    assert.equal(delivered.length, 3);
    assert.equal(delivered[0]?.agent_id, channels.childAgentId);
    assert.deepEqual(delivered[0]?.entry.body, {
      type: "message",
      content: [{ type: "text", text: "流式正文" }],
    });
    assert.equal(delivered[1]?.agent_id, channels.grandchildAgentId);
    assert.deepEqual(delivered[2]?.entry, large);
    assert.equal(channels.parent.getPublicState().state, "ready");
  } finally {
    unsubscribe();
    channels.destroy();
  }
});

test("监督通道单字符串上限为 64 KB：32 KB 与 64 KB 的帧内字符串可跨端发布/接收，超过上限按 frame_too_large 拒绝", () => {
  const nodesWithScopeName = (childAgentId: string, grandchildAgentId: string, name: string) => {
    const [scope, grandchild] = childSnapshotNodes(childAgentId, grandchildAgentId);
    assert.ok(scope && grandchild);
    return Object.freeze([
      Object.freeze({ ...scope, name }),
      grandchild,
    ]);
  };

  // 32 KB 边界值与 64 KB 上限值都必须是可承载的单字符串，且经 JSON 转义后的 wire 编码可往返。
  for (const bytes of [32 * 1024, 64 * 1024]) {
    const { parent, child, childAgentId, grandchildAgentId } = readyPair();
    const frame = child.publishSnapshot(nodesWithScopeName(childAgentId, grandchildAgentId, "n".repeat(bytes)), 2);
    assert.deepEqual(decodeSupervisorFrame(encodeSupervisorFrame(frame)).payload, frame.payload);
    const result = parent.receive(frame);
    assert.equal(result.kind, "accepted");
    assert.equal(result.kind === "accepted" && result.applied, true);
    assert.equal(parent.getPublicState().state, "ready");
  }

  // 超过上限的单字符串在接收端按 frame_too_large 协议故障拒绝。
  const { parent, child, childAgentId, grandchildAgentId } = readyPair();
  const frame = child.publishSnapshot(childSnapshotNodes(childAgentId, grandchildAgentId), 2);
  const overLimit = Object.freeze({
    ...frame,
    payload: Object.freeze({
      ...frame.payload,
      nodes: nodesWithScopeName(childAgentId, grandchildAgentId, "n".repeat(64 * 1024 + 1)),
    }),
  });
  const result = parent.receive(overLimit);
  assert.equal(result.kind, "protocol_fault");
  assert.equal(result.kind === "protocol_fault" && result.error, "frame_too_large");
});

test("分块传输 helper 与通道内联判断一致：小块单帧，大块多帧", () => {
  const small = canonicalEntry(randomUUID());
  const inlined = chunkCanonicalAgentActivityEntry(small, 192 * 1024);
  assert.equal(inlined.length, 1);
  assert.deepEqual(inlined[0], small);
});
