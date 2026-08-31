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
  SUPERVISOR_FRAME_KINDS,
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
  promptAttempts = 0;
  steerAttempts = 0;
  abortAttempts = 0;

  override prompt(_message: string): Promise<void> {
    this.promptAttempts += 1;
    return Promise.reject(new ManagedRpcCommandRejectedError("compaction_active"));
  }

  override steer(_message: string): Promise<void> {
    this.steerAttempts += 1;
    return Promise.reject(new ManagedRpcCommandRejectedError("compaction_active"));
  }

  override abort(): Promise<void> {
    this.abortAttempts += 1;
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
  onReply: (reply: SupervisorReply) => boolean,
  replyDispatchTimeoutMs = 200,
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
    replyDispatchTimeoutMs,
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

test("消息交给 Pi 裁决，压缩期间中断由原生状态观察拒绝", async () => {
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
    assert.equal(node.promptAttempts, 1);

    rpc.setState({ isStreaming: false, isCompacting: true, pendingMessageCount: 0 });
    emitPiEvent(rpc, { type: "compaction_start", reason: "manual" });
    assert.deepEqual(await supervisor.interrupt(), {
      ok: true,
      accepted: true,
      changed: false,
      blocked_reason: "compaction_active",
    });
    assert.equal(node.abortAttempts, 0);
  } finally {
    await channels.parent.release();
    await channels.child.release();
  }
});

test("流式监督通道等待父端 reply_dispatch，拒绝不进入普通 control response", async () => {
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

test("旧协议、已删除压缩帧和旧任务字段稳定拒绝为 protocol_mismatch", () => {
  assert.equal(SUPERVISOR_PROTOCOL_VERSION, "wj-pi-subagents/18");
  assert.equal((SUPERVISOR_FRAME_KINDS as readonly string[]).includes("compaction_prepare"), false);
  assert.equal((SUPERVISOR_FRAME_KINDS as readonly string[]).includes("compaction_prepared"), false);
  assert.equal((SUPERVISOR_FRAME_KINDS as readonly string[]).includes("compaction_complete"), false);
  assert.equal((SUPERVISOR_FRAME_KINDS as readonly string[]).includes("compaction_completed"), false);
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

  const oldVersionParent = new SupervisorChannel({
    role: "parent",
    rootId: ROOT_ID,
    localAgentId: null,
    peerAgentId: CHILD_ID,
    parentAgentId: null,
    depth: 1,
    credential: CREDENTIAL,
    requestIdRegistry: new SupervisorRequestIdRegistry(),
  });
  assert.deepEqual(oldVersionParent.receive({
    protocol: "wj-pi-subagents/17",
    kind: "compaction_prepare",
    stream_id: "stream_old_compaction",
    sender_agent_id: CHILD_ID,
    target_agent_id: null,
    seq: 1,
    payload: { transaction_id: "old-transaction" },
  }), { kind: "protocol_fault", error: "protocol_mismatch" });
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

test("Pi threshold 压缩续跑时不把后继 agent_start 前的间隙结算为 idle", async () => {
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
