import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import {
  CHILD_REPLY_SCHEMA,
  CHILD_REPLY_VERSION,
  type ChildMessageEnvelope,
} from "../src/child-reply-envelope.ts";
import {
  FakeRpcClient,
  RpcSupervisor,
  type RpcSupervisorEvent,
} from "../src/rpc-supervisor.ts";
import { normalizeRpcBridgeEvent } from "../src/rpc-bridge-event.ts";
import {
  controlFailure,
  ROOT_TREE_ACTOR,
  TreeController,
} from "../src/tree-controller.ts";
import {
  ManagedRpcCommandRejectedError,
} from "../src/managed-rpc-node.ts";
import type {
  ExitObservation,
  ResourceObservation,
} from "../src/process-tree-capability.ts";
import {
  StreamSupervisorChannel,
  type SupervisorByteTransport,
} from "../src/stream-supervisor-channel.ts";
import {
  ReplyDeliveryRejectedError,
  type ReplyDeliveryDecision,
} from "../src/reply-acceptance.ts";
import {
  SUPERVISOR_PROTOCOL_VERSION,
  SupervisorChannel,
  SupervisorRequestIdRegistry,
  type SupervisorReply,
} from "../src/supervisor-channel.ts";

const CHILD_ID = "550e8400-e29b-41d4-a716-446655440000";
const ROOT_ID = "root-test";
const CREDENTIAL = "stream-test-credential";

function message(text = "流式消息"): ChildMessageEnvelope {
  return {
    schema: CHILD_REPLY_SCHEMA,
    version: CHILD_REPLY_VERSION,
    kind: "message",
    agent_id: CHILD_ID,
    text,
  };
}

class TestManagedRpcNode {
  readonly process_binding = "managed" as const;

  readonly rpc: FakeRpcClient;

  constructor(rpc: FakeRpcClient) {
    this.rpc = rpc;
  }

  start(): Promise<void> {
    return this.rpc.start();
  }

  prompt(message: string): Promise<void> {
    return this.rpc.prompt(message);
  }

  steer(message: string): Promise<void> {
    return this.rpc.steer(message);
  }

  abort(): Promise<void> {
    return this.rpc.abort();
  }

  getState(): Promise<unknown> {
    return this.rpc.getState();
  }

  onEvent(listener: (event: unknown) => void): () => void {
    return this.rpc.onEvent(listener);
  }

  onTransportFault(listener: (fault: "eof" | "protocol_fault" | "process_exit") => void): () => void {
    return this.rpc.onTransportFault(listener);
  }

  async sendSupervisorFrame(_frame: Uint8Array): Promise<void> {}

  onSupervisorFrame(_listener: (frame: Uint8Array) => void): () => void {
    return () => {};
  }

  async requestGracefulClose(_signal: AbortSignal): Promise<void> {}

  async forceTerminate(): Promise<void> {}

  async waitForExit(_deadline: number | Date): Promise<ExitObservation> {
    return { state: "exited" };
  }

  async inspect(): Promise<ResourceObservation> {
    return { state: "released" };
  }

  async release(): Promise<void> {}
}

class ExplicitlyRejectingManagedRpcNode extends TestManagedRpcNode {
  override prompt(_message: string): Promise<void> {
    return Promise.reject(new ManagedRpcCommandRejectedError("compaction_active"));
  }

  override steer(_message: string): Promise<void> {
    return Promise.reject(new ManagedRpcCommandRejectedError("compaction_active"));
  }
}

function emitPiEvent(rpc: FakeRpcClient, rawEvent: unknown): void {
  const normalized = normalizeRpcBridgeEvent(rawEvent);
  assert.equal(normalized.kind, "event");
  if (normalized.kind === "event") rpc.emitEvent(normalized.event);
}

function snapshot(state: "starting" | "idle" = "idle"): Record<string, unknown> {
  return {
    agent_id: CHILD_ID,
    parent_agent_id: null,
    template_id: "researcher",
    name: "流式子代理",
    depth: 1,
    state,
    revision: 1,
  };
}

function pair(
  onReply: (reply: SupervisorReply) => ReplyDeliveryDecision,
  replyAcceptanceTimeoutMs = 200,
  initialState: "starting" | "idle" = "idle",
  createParent?: (
    options: ConstructorParameters<typeof StreamSupervisorChannel>[0],
  ) => StreamSupervisorChannel,
): {
  readonly parent: StreamSupervisorChannel;
  readonly child: StreamSupervisorChannel;
} {
  const parentToChild = new PassThrough();
  const childToParent = new PassThrough();
  const transportForParent: SupervisorByteTransport = {
    stdin: parentToChild,
    stdout: childToParent,
  };
  const transportForChild: SupervisorByteTransport = {
    stdin: childToParent,
    stdout: parentToChild,
  };
  const requestIdRegistry = new SupervisorRequestIdRegistry();
  const parentOptions: ConstructorParameters<typeof StreamSupervisorChannel>[0] = {
    role: "parent",
    rootId: ROOT_ID,
    localAgentId: null,
    peerAgentId: CHILD_ID,
    parentAgentId: null,
    depth: 1,
    credential: CREDENTIAL,
    requestIdRegistry,
    transport: transportForParent,
    onReply,
  };
  const parent = createParent?.(parentOptions) ?? new StreamSupervisorChannel(parentOptions);
  const child = new StreamSupervisorChannel({
    role: "child",
    rootId: ROOT_ID,
    localAgentId: CHILD_ID,
    peerAgentId: "",
    parentAgentId: null,
    depth: 1,
    credential: CREDENTIAL,
    requestIdRegistry,
    transport: transportForChild,
    initialSnapshot: [snapshot(initialState)],
    initialSubtreeRevision: 1,
    replyAcceptanceTimeoutMs,
  });
  return { parent, child };
}

async function readyChannels(channels: ReturnType<typeof pair>): Promise<void> {
  const signal = new AbortController().signal;
  await channels.parent.bind(signal);
  await channels.child.bind(signal);
  await Promise.all([
    channels.parent.waitForReady(signal),
    channels.child.waitForReady(signal),
  ]);
}

interface TestSignal {
  readonly promise: Promise<void>;
  resolve(): void;
}

function testSignal(): TestSignal {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class FirstCompactionAckBlockingChannel extends StreamSupervisorChannel {
  readonly firstResponseStarted = testSignal();
  readonly firstResponseFinished = testSignal();
  readonly allowFirstResponse = testSignal();
  private responseCount = 0;

  override async respondCompactionCompleted(
    response: Parameters<StreamSupervisorChannel["respondCompactionCompleted"]>[0],
  ): Promise<void> {
    this.responseCount += 1;
    const first = this.responseCount === 1;
    if (first) {
      this.firstResponseStarted.resolve();
      await this.allowFirstResponse.promise;
    }
    await super.respondCompactionCompleted(response);
    if (first) this.firstResponseFinished.resolve();
  }
}

test("真实 Pi 手动压缩事件与监督 ACK 并发时保留协调授权", async () => {
  const channels = pair(() => true, 200, "starting");
  const rpc = new FakeRpcClient();
  const node = new TestManagedRpcNode(rpc);
  const tree = new TreeController({
    config: {
      maxDepth: 2,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 8,
      waitTimeoutMs: 1_000,
    },
    idFactory: () => CHILD_ID,
  });
  const supervisorEvents: RpcSupervisorEvent[] = [];
  const preparedTransactions: string[] = [];
  const completedTransactions: string[] = [];
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "流式子代理" },
    managedNode: node,
    channel: channels.parent,
    startupTimeoutMs: 1_000,
    gracefulShutdownMs: 1_000,
    onCompactionPrepare: (transactionId) => {
      preparedTransactions.push(transactionId);
      return true;
    },
    onCompactionComplete: (transactionId) => {
      completedTransactions.push(transactionId);
      return true;
    },
  });
  supervisor.onEvent((event) => supervisorEvents.push(event));

  const signal = new AbortController().signal;
  try {
    const startup = supervisor.start();
    await channels.child.bind(signal);
    assert.deepEqual(await startup, {
      ok: true,
      agent_id: CHILD_ID,
      state: "idle",
    });
    await channels.child.waitForReady(signal);

    const transactionId = "compaction-transaction-1";
    assert.equal(await channels.child.requestCompactionPrepare(transactionId), true);
    assert.deepEqual(await supervisor.sendMessage("压缩期间发送"), {
      ok: false,
      code: "compaction_active",
    });
    emitPiEvent(rpc, { type: "agent_start" });
    emitPiEvent(rpc, { type: "tool_execution_start", toolCallId: "call-1", toolName: "apply_patch" });
    assert.deepEqual(supervisorEvents.at(-1), {
      kind: "activity",
      activity: { phase: "executing_tools" },
    });
    emitPiEvent(rpc, { type: "tool_execution_end", toolCallId: "call-1", toolName: "apply_patch" });
    assert.deepEqual(supervisorEvents.at(-1), {
      kind: "activity",
      activity: { phase: "processing" },
    });
    emitPiEvent(rpc, { type: "queue_update", steering: [], followUp: [] });
    emitPiEvent(rpc, { type: "compaction_start", reason: "manual" });
    assert.deepEqual(await supervisor.sendMessage("压缩进行中发送"), {
      ok: false,
      code: "compaction_active",
    });
    assert.equal(supervisorEvents.some((event) => event.kind === "fault"), false);
    emitPiEvent(rpc, {
      type: "compaction_end",
      reason: "manual",
      aborted: false,
      willRetry: false,
    });

    // 自动压缩回调可能在旧回合的 settled 事件返回前同步接纳续跑。
    rpc.setState({ isStreaming: true, isCompacting: false, pendingMessageCount: 0 });
    emitPiEvent(rpc, { type: "agent_start" });

    // 旧 settled 不能覆盖续跑的 working 状态，也不能让后续消息退化为 prompt。
    const completion = channels.child.requestCompactionComplete(transactionId, "succeeded");
    assert.equal(await completion, true);
    emitPiEvent(rpc, { type: "agent_settled" });

    assert.deepEqual(preparedTransactions, [transactionId]);
    assert.deepEqual(completedTransactions, [transactionId]);
    assert.equal(supervisorEvents.some((event) => event.kind === "fault"), false);
    await supervisor.synchronizeState();
    let status = tree.getStatus(CHILD_ID);
    assert.equal(status.ok, true);
    if (status.ok) assert.equal(status.data.state, "working");

    // 同一事实也可能沿 child supervisor 通道到达，仍必须经过相同校准。
    const channelStatus = tree.getStatus(CHILD_ID);
    const channelGeneration = tree.getLifecycleGeneration(CHILD_ID);
    assert.equal(channelStatus.ok, true);
    assert.equal(channelGeneration.ok, true);
    if (channelStatus.ok && channelGeneration.ok) {
      await channels.child.publishEvent({
        type: "agent_settled",
        expected_generation: channelGeneration.data,
      });
    }
    await supervisor.synchronizeState();
    status = tree.getStatus(CHILD_ID);
    assert.equal(status.ok, true);
    if (status.ok) assert.equal(status.data.state, "working");

    // 探针在旧状态返回前若观察到新的 agent_start，旧的 false 结果也不能结算。
    const delayedState = rpc.deferNext("get_state");
    const delayedSync = supervisor.synchronizeState();
    await delayedState.started;
    emitPiEvent(rpc, { type: "agent_start" });
    rpc.setState({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
    delayedState.resolve();
    assert.equal(await delayedSync, true);
    status = tree.getStatus(CHILD_ID);
    assert.equal(status.ok, true);
    if (status.ok) assert.equal(status.data.state, "working");
    rpc.setState({ isStreaming: true, isCompacting: false, pendingMessageCount: 0 });

    assert.deepEqual(await supervisor.sendMessage("续跑期间的追加消息"), {
      ok: true,
      accepted: true,
    });
    assert.equal(rpc.operations().at(-1), "steer");

    rpc.setState({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
    emitPiEvent(rpc, { type: "agent_settled" });
    await supervisor.synchronizeState();
    status = tree.getStatus(CHILD_ID);
    assert.equal(status.ok, true);
    if (status.ok) assert.equal(status.data.state, "idle");
  } finally {
    await channels.parent.release();
    await channels.child.release();
  }
});
test("Pi 明确拒绝压缩期间命令时保留 compaction_active 原因", async () => {
  const channels = pair(() => true, 200, "idle");
  const rpc = new FakeRpcClient();
  const node = new ExplicitlyRejectingManagedRpcNode(rpc);
  const tree = new TreeController({
    config: {
      maxDepth: 2,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 8,
      waitTimeoutMs: 1_000,
    },
    idFactory: () => CHILD_ID,
  });
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "流式子代理" },
    managedNode: node,
    channel: channels.parent,
    startupTimeoutMs: 1_000,
    gracefulShutdownMs: 1_000,
  });
  const signal = new AbortController().signal;
  try {
    const startup = supervisor.start();
    await channels.child.bind(signal);
    assert.deepEqual(await startup, {
      ok: true,
      agent_id: CHILD_ID,
      state: "idle",
    });
    await channels.child.waitForReady(signal);
    assert.deepEqual(await supervisor.sendMessage("压缩期间 prompt"), {
      ok: false,
      code: "compaction_active",
    });
  } finally {
    await channels.parent.release();
    await channels.child.release();
  }
});

test("流式监督通道等待父端 reply_acceptance，拒绝不进入普通 control response", async () => {
  let accepted = false;
  const channels = pair(() => accepted);
  const controlResponses: unknown[] = [];
  channels.parent.onControlResponse?.((response) => controlResponses.push(response));
  await readyChannels(channels);

  await assert.rejects(
    channels.child.publishReply(message("明确拒绝")),
    /message_delivery_failed/,
  );
  accepted = true;
  await channels.child.publishReply(message("明确接纳"));
  assert.deepEqual(controlResponses, []);

  await channels.parent.release();
  await channels.child.release();
});

test("流式监督通道向子端传播父端 compaction_active 拒绝原因", async () => {
  const channels = pair(() => ({
    accepted: false,
    blocked_reason: "compaction_active" as const,
  }));
  await readyChannels(channels);

  await assert.rejects(
    channels.child.publishReply(message("父端压缩期间消息")),
    (error: unknown) => error instanceof ReplyDeliveryRejectedError
      && error.blockedReason === "compaction_active",
  );

  await channels.parent.release();
  await channels.child.release();
});
test("回复等待器有界超时并在失败后清理，后续独立消息仍可发送", async () => {
  let accepted = false;
  const channels = pair(() => accepted, 30);
  await readyChannels(channels);

  const first = channels.child.publishReply(message("超时消息"));
  await assert.rejects(first, /message_delivery_failed/);
  accepted = true;
  await channels.child.publishReply(message("超时后的独立消息"));

  await channels.parent.release();
  await channels.child.release();
});

test("控制响应在监督 wire 上保留规范启动错误 details", () => {
  const requestIdRegistry = new SupervisorRequestIdRegistry();
  const parent = new SupervisorChannel({
    role: "parent",
    rootId: ROOT_ID,
    localAgentId: null,
    peerAgentId: CHILD_ID,
    parentAgentId: null,
    depth: 1,
    credential: CREDENTIAL,
    requestIdRegistry,
  });
  const child = new SupervisorChannel({
    role: "child",
    rootId: ROOT_ID,
    localAgentId: CHILD_ID,
    peerAgentId: "",
    parentAgentId: null,
    depth: 1,
    credential: CREDENTIAL,
    requestIdRegistry,
  });
  const helloResult = parent.receive(child.startHandshake());
  assert.equal(helloResult.kind, "accepted");
  if (helloResult.kind !== "accepted") return;
  for (const outbound of helloResult.outbound) child.receive(outbound);
  const snapshotResult = parent.receive(child.publishSnapshot([snapshot()], 1));
  assert.equal(snapshotResult.kind, "accepted");

  const response = {
    operation_id: "startup-error-operation",
    ok: false as const,
    error: controlFailure("provider_unavailable", { provider: "wj-provider" }).error,
  };
  const received = child.receive(parent.publishControlResponse(response));
  assert.equal(received.kind, "accepted");
  if (received.kind === "accepted") assert.deepEqual(received.control_response, response);
});

test("旧协议和旧任务字段在新监督 wire 上稳定拒绝为 protocol_mismatch", () => {
  const requestIdRegistry = new SupervisorRequestIdRegistry();
  const parent = new SupervisorChannel({
    role: "parent",
    rootId: ROOT_ID,
    localAgentId: null,
    peerAgentId: CHILD_ID,
    parentAgentId: null,
    depth: 1,
    credential: CREDENTIAL,
    requestIdRegistry,
  });
  const child = new SupervisorChannel({
    role: "child",
    rootId: ROOT_ID,
    localAgentId: CHILD_ID,
    peerAgentId: "",
    parentAgentId: null,
    depth: 1,
    credential: CREDENTIAL,
    requestIdRegistry,
  });
  const hello = child.startHandshake();
  const helloResult = parent.receive(hello);
  assert.equal(helloResult.kind, "accepted");
  if (helloResult.kind === "accepted") {
    for (const outbound of helloResult.outbound) child.receive(outbound);
  }
  const snapshotFrame = child.publishSnapshot([snapshot()], 1);
  const snapshotResult = parent.receive(snapshotFrame);
  assert.equal(snapshotResult.kind, "accepted");

  const legacyFrame = {
    protocol: SUPERVISOR_PROTOCOL_VERSION,
    kind: "reply",
    stream_id: snapshotFrame.stream_id,
    sender_agent_id: CHILD_ID,
    target_agent_id: null,
    seq: snapshotFrame.seq + 1,
    request_id: "request-1",
    payload: {
      schema: "wj-pi-subagents.reply",
      version: 5,
      kind: "final",
      agent_id: CHILD_ID,
      task_id: "old-task",
      turn_id: "old-turn",
      commit_id: "old-commit",
      text: "old payload",
    },
  };
  const result = parent.receive(legacyFrame);
  assert.deepEqual(result, { kind: "protocol_fault", error: "protocol_mismatch" });
});

test("监督 wire 仅传输规范且独立复制的启动失败详情", () => {
  const requestIdRegistry = new SupervisorRequestIdRegistry();
  const parent = new SupervisorChannel({
    role: "parent",
    rootId: ROOT_ID,
    localAgentId: null,
    peerAgentId: CHILD_ID,
    parentAgentId: null,
    depth: 1,
    credential: CREDENTIAL,
    requestIdRegistry,
  });
  const child = new SupervisorChannel({
    role: "child",
    rootId: ROOT_ID,
    localAgentId: CHILD_ID,
    peerAgentId: "",
    parentAgentId: null,
    depth: 1,
    credential: CREDENTIAL,
    requestIdRegistry,
  });
  const helloResult = parent.receive(child.startHandshake());
  assert.equal(helloResult.kind, "accepted");
  if (helloResult.kind !== "accepted") return;
  for (const outbound of helloResult.outbound) child.receive(outbound);
  assert.equal(parent.receive(child.publishSnapshot([snapshot()], 1)).kind, "accepted");

  const details = { provider: "wj-provider", model: "gpt-5.6-terra" };
  const frame = child.publishEvent({
    type: "startup_failed",
    expected_generation: 0,
    error_code: "model_unavailable",
    error_details: details,
  });
  details.model = "forged-model";
  const accepted = parent.receive(frame);
  assert.equal(accepted.kind, "accepted");
  if (accepted.kind !== "accepted") return;
  assert.deepEqual(accepted.event, {
    root_id: ROOT_ID,
    agent_id: CHILD_ID,
    type: "startup_failed",
    expected_generation: 0,
    error_code: "model_unavailable",
    error_details: { provider: "wj-provider", model: "gpt-5.6-terra" },
  });
  assert.equal(Object.isFrozen(accepted.event?.error_details), true);

  assert.throws(() => child.publishEvent({
    type: "startup_failed",
    expected_generation: 0,
    error_code: "provider_unavailable",
    error_details: {
      provider: "wj-provider",
      source: "https://user:TOP_SECRET@example.test/private?token=TOP_SECRET",
    },
  } as unknown as Parameters<typeof child.publishEvent>[0]));
});

test("自动压缩声明续跑时不把后继 agent_start 前的间隙结算为 idle", async () => {
  const channels = pair(() => true, 200, "idle");
  const rpc = new FakeRpcClient({
    state: { isStreaming: false, isCompacting: false, pendingMessageCount: 0 },
  });
  const node = new TestManagedRpcNode(rpc);
  const tree = new TreeController({
    config: {
      maxDepth: 2,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 8,
      waitTimeoutMs: 1_000,
    },
    idFactory: () => CHILD_ID,
  });
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "流式子代理" },
    managedNode: node,
    channel: channels.parent,
    startupTimeoutMs: 1_000,
    gracefulShutdownMs: 1_000,
  });
  const signal = new AbortController().signal;
  try {
    const startup = supervisor.start();
    await channels.child.bind(signal);
    assert.equal((await startup).ok, true);
    await channels.child.waitForReady(signal);

    rpc.setState({ isStreaming: true, isCompacting: false, pendingMessageCount: 0 });
    emitPiEvent(rpc, { type: "agent_start" });
    emitPiEvent(rpc, { type: "compaction_start", reason: "threshold" });

    // Pi 在 compaction_end 后才开始 continue()；此时 get_state 可能短暂静止。
    rpc.setState({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
    emitPiEvent(rpc, {
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      willRetry: true,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const status = tree.getStatus(CHILD_ID);
    assert.equal(status.ok, true);
    if (status.ok) assert.equal(status.data.state, "working");
  } finally {
    await channels.parent.release();
    await channels.child.release();
  }
});

test("协调压缩声明后继回合时不在完成 ACK 间隙结算 idle", async () => {
  const channels = pair(() => true, 200, "idle");
  const rpc = new FakeRpcClient({
    state: { isStreaming: false, isCompacting: false, pendingMessageCount: 0 },
  });
  const tree = new TreeController({
    config: {
      maxDepth: 2,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 8,
      waitTimeoutMs: 1_000,
    },
    idFactory: () => CHILD_ID,
  });
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "流式子代理" },
    managedNode: new TestManagedRpcNode(rpc),
    channel: channels.parent,
    startupTimeoutMs: 1_000,
    gracefulShutdownMs: 1_000,
    onCompactionPrepare: () => true,
    onCompactionComplete: () => true,
  });
  const signal = new AbortController().signal;
  try {
    const startup = supervisor.start();
    await channels.child.bind(signal);
    assert.equal((await startup).ok, true);
    await channels.child.waitForReady(signal);

    const transactionId = "continuation-compaction";
    assert.equal(await channels.child.requestCompactionPrepare(transactionId), true);
    rpc.setState({ isStreaming: true, isCompacting: false, pendingMessageCount: 0 });
    emitPiEvent(rpc, { type: "agent_start" });
    emitPiEvent(rpc, { type: "compaction_start", reason: "manual" });
    rpc.setState({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
    emitPiEvent(rpc, {
      type: "compaction_end",
      reason: "manual",
      aborted: false,
      willRetry: false,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(
      await channels.child.requestCompactionComplete(
        transactionId,
        "succeeded",
        undefined,
        true,
      ),
      true,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    const status = tree.getStatus(CHILD_ID);
    assert.equal(status.ok, true);
    if (status.ok) assert.equal(status.data.state, "working");
  } finally {
    await channels.parent.release();
    await channels.child.release();
  }
});

test("协调完成先于 compaction_end 时续跑意图不被旧事件覆盖", async () => {
  const channels = pair(() => true, 200, "idle");
  const rpc = new FakeRpcClient({
    state: { isStreaming: false, isCompacting: false, pendingMessageCount: 0 },
  });
  const tree = new TreeController({
    config: {
      maxDepth: 2,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 8,
      waitTimeoutMs: 1_000,
    },
    idFactory: () => CHILD_ID,
  });
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "流式子代理" },
    managedNode: new TestManagedRpcNode(rpc),
    channel: channels.parent,
    startupTimeoutMs: 1_000,
    gracefulShutdownMs: 1_000,
    onCompactionPrepare: () => true,
    onCompactionComplete: () => true,
  });
  const signal = new AbortController().signal;
  try {
    const startup = supervisor.start();
    await channels.child.bind(signal);
    assert.equal((await startup).ok, true);
    await channels.child.waitForReady(signal);

    const transactionId = "completion-before-end";
    assert.equal(await channels.child.requestCompactionPrepare(transactionId), true);
    rpc.setState({ isStreaming: true, isCompacting: false, pendingMessageCount: 0 });
    emitPiEvent(rpc, { type: "agent_start" });
    emitPiEvent(rpc, { type: "compaction_start", reason: "manual" });
    rpc.setState({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });

    // 监督帧和 Pi 事件来自不同传输；complete 可能先于 bridge 的 end 事件抵达。
    assert.equal(
      await channels.child.requestCompactionComplete(
        transactionId,
        "succeeded",
        undefined,
        true,
      ),
      true,
    );
    emitPiEvent(rpc, {
      type: "compaction_end",
      reason: "manual",
      aborted: false,
      willRetry: false,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const status = tree.getStatus(CHILD_ID);
    assert.equal(status.ok, true);
    if (status.ok) assert.equal(status.data.state, "working");
  } finally {
    await channels.parent.release();
    await channels.child.release();
  }
});
test("协调完成先于后继 agent_start 到达时最终 settled 仍能收束 idle", async () => {
  const channels = pair(() => true, 200, "idle");
  const rpc = new FakeRpcClient({
    state: { isStreaming: false, isCompacting: false, pendingMessageCount: 0 },
  });
  const tree = new TreeController({
    config: {
      maxDepth: 2,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 8,
      waitTimeoutMs: 1_000,
    },
    idFactory: () => CHILD_ID,
  });
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "流式子代理" },
    managedNode: new TestManagedRpcNode(rpc),
    channel: channels.parent,
    startupTimeoutMs: 1_000,
    gracefulShutdownMs: 1_000,
    onCompactionPrepare: () => true,
    onCompactionComplete: () => true,
  });
  const signal = new AbortController().signal;
  try {
    const startup = supervisor.start();
    await channels.child.bind(signal);
    assert.equal((await startup).ok, true);
    await channels.child.waitForReady(signal);

    const transactionId = "completion-after-continuation-start";
    assert.equal(await channels.child.requestCompactionPrepare(transactionId), true);
    rpc.setState({ isStreaming: true, isCompacting: false, pendingMessageCount: 0 });
    emitPiEvent(rpc, { type: "agent_start" });
    emitPiEvent(rpc, { type: "compaction_start", reason: "manual" });
    rpc.setState({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
    emitPiEvent(rpc, {
      type: "compaction_end",
      reason: "manual",
      aborted: false,
      willRetry: false,
    });

    // 上游监督帧延迟到后继回合已经开始之后才抵达。
    rpc.setState({ isStreaming: true, isCompacting: false, pendingMessageCount: 0 });
    emitPiEvent(rpc, { type: "agent_start" });
    rpc.setState({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
    assert.equal(
      await channels.child.requestCompactionComplete(
        transactionId,
        "succeeded",
        undefined,
        true,
      ),
      true,
    );
    emitPiEvent(rpc, { type: "agent_settled" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await supervisor.synchronizeState();

    const status = tree.getStatus(CHILD_ID);
    assert.equal(status.ok, true);
    if (status.ok) assert.equal(status.data.state, "idle");
  } finally {
    await channels.parent.release();
    await channels.child.release();
  }
});
test("协调压缩完成 ACK 超时后的补偿撤销续跑保护", async () => {
  let blockingParent!: FirstCompactionAckBlockingChannel;
  const channels = pair(
    () => true,
    200,
    "idle",
    (options) => {
      blockingParent = new FirstCompactionAckBlockingChannel(options);
      return blockingParent;
    },
  );
  const rpc = new FakeRpcClient({
    state: { isStreaming: false, isCompacting: false, pendingMessageCount: 0 },
  });
  const tree = new TreeController({
    config: {
      maxDepth: 2,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 8,
      waitTimeoutMs: 1_000,
    },
    idFactory: () => CHILD_ID,
  });
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "流式子代理" },
    managedNode: new TestManagedRpcNode(rpc),
    channel: channels.parent,
    startupTimeoutMs: 1_000,
    gracefulShutdownMs: 1_000,
    onCompactionPrepare: () => true,
    onCompactionComplete: () => true,
  });
  const signal = new AbortController().signal;
  const completionAbort = new AbortController();
  let firstCompletion: Promise<boolean> | undefined;
  try {
    const startup = supervisor.start();
    await channels.child.bind(signal);
    assert.equal((await startup).ok, true);
    await channels.child.waitForReady(signal);

    const transactionId = "delayed-continuation-ack";
    assert.equal(await channels.child.requestCompactionPrepare(transactionId), true);
    rpc.setState({ isStreaming: true, isCompacting: false, pendingMessageCount: 0 });
    emitPiEvent(rpc, { type: "agent_start" });
    emitPiEvent(rpc, { type: "compaction_start", reason: "manual" });
    rpc.setState({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
    emitPiEvent(rpc, {
      type: "compaction_end",
      reason: "manual",
      aborted: false,
      willRetry: false,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    firstCompletion = channels.child.requestCompactionComplete(
      transactionId,
      "succeeded",
      completionAbort.signal,
      true,
    );
    await blockingParent.firstResponseStarted.promise;

    // 业务裁决已经释放协调屏障，但 ACK 尚未写回；续跑意图必须先于 ACK 生效。
    await supervisor.synchronizeState();
    let status = tree.getStatus(CHILD_ID);
    assert.equal(status.ok, true);
    if (status.ok) assert.equal(status.data.state, "working");

    // 调用方未观察到首个 ACK 时会以同一事务发送 not_started 补偿。
    completionAbort.abort();
    await assert.rejects(firstCompletion);
    blockingParent.allowFirstResponse.resolve();
    await blockingParent.firstResponseFinished.promise;
    assert.equal(
      await channels.child.requestCompactionComplete(transactionId, "not_started"),
      true,
    );
    await supervisor.synchronizeState();

    status = tree.getStatus(CHILD_ID);
    assert.equal(status.ok, true);
    if (status.ok) assert.equal(status.data.state, "idle");
  } finally {
    completionAbort.abort();
    blockingParent.allowFirstResponse.resolve();
    await firstCompletion?.catch(() => undefined);
    await channels.parent.release();
    await channels.child.release();
  }
});

test("手动压缩在 settled 探针前开始仍能结算 idle", async () => {
  const channels = pair(() => true, 200, "idle");
  const rpc = new FakeRpcClient({
    state: { isStreaming: false, isCompacting: false, pendingMessageCount: 0 },
  });
  const node = new TestManagedRpcNode(rpc);
  const tree = new TreeController({
    config: {
      maxDepth: 2,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 8,
      waitTimeoutMs: 1_000,
    },
    idFactory: () => CHILD_ID,
  });
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "流式子代理" },
    managedNode: node,
    channel: channels.parent,
    startupTimeoutMs: 1_000,
    gracefulShutdownMs: 1_000,
  });
  const signal = new AbortController().signal;
  try {
    const startup = supervisor.start();
    await channels.child.bind(signal);
    assert.deepEqual(await startup, {
      ok: true,
      agent_id: CHILD_ID,
      state: "idle",
    });
    await channels.child.waitForReady(signal);

    rpc.setState({ isStreaming: true, isCompacting: false, pendingMessageCount: 0 });
    emitPiEvent(rpc, { type: "agent_start" });
    const settledProbe = rpc.deferNext("get_state");
    emitPiEvent(rpc, { type: "agent_settled" });
    await settledProbe.started;

    rpc.setState({ isStreaming: false, isCompacting: true, pendingMessageCount: 0 });
    emitPiEvent(rpc, { type: "compaction_start", reason: "manual" });
    settledProbe.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));

    rpc.setState({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
    emitPiEvent(rpc, {
      type: "compaction_end",
      reason: "manual",
      aborted: false,
      willRetry: false,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const status = tree.getStatus(CHILD_ID);
    assert.equal(status.ok, true);
    if (status.ok) assert.equal(status.data.state, "idle");
  } finally {
    await channels.parent.release();
    await channels.child.release();
  }
});
