import assert from "node:assert/strict";
import test from "node:test";
import {
  FakeRpcClient,
  RpcSupervisor,
  type RpcSupervisorChannel,
  type RpcSupervisorChannelCloseState,
  type RpcSupervisorChannelFault,
  type RpcSupervisorEvent,
} from "../src/rpc-supervisor.ts";
import { normalizeRpcBridgeEvent } from "../src/rpc-bridge-event.ts";
import type {
  ExitObservation,
  ResourceObservation,
} from "../src/process-tree-capability.ts";
import type { SupervisorReply } from "../src/supervisor-channel.ts";
import {
  ROOT_TREE_ACTOR,
  TreeController,
} from "../src/tree-controller.ts";

const CHILD_ID = "550e8400-e29b-41d4-a716-446655440000";

class TestManagedRpcNode {
  readonly process_binding = "managed" as const;

  readonly rpc: FakeRpcClient;

  constructor(rpc: FakeRpcClient) {
    this.rpc = rpc;
  }

  start(): Promise<void> { return this.rpc.start(); }
  prompt(message: string): Promise<void> { return this.rpc.prompt(message); }
  steer(message: string): Promise<void> { return this.rpc.steer(message); }
  abort(): Promise<void> { return this.rpc.abort(); }
  getState(): Promise<unknown> { return this.rpc.getState(); }
  onEvent(listener: (event: unknown) => void): () => void { return this.rpc.onEvent(listener); }
  onTransportFault(listener: (fault: "eof" | "protocol_fault" | "process_exit") => void): () => void {
    return this.rpc.onTransportFault(listener);
  }
  async sendSupervisorFrame(_frame: Uint8Array): Promise<void> {}
  onSupervisorFrame(_listener: (frame: Uint8Array) => void): () => void { return () => {}; }
  async requestGracefulClose(_signal: AbortSignal): Promise<void> {}
  async forceTerminate(): Promise<void> {}
  async waitForExit(_deadline: number | Date): Promise<ExitObservation> { return { state: "exited" }; }
  async inspect(): Promise<ResourceObservation> { return { state: "released" }; }
  async release(): Promise<void> {}
}

class ReadyChannel implements RpcSupervisorChannel {
  async bind(_signal: AbortSignal): Promise<void> {}
  async waitForReady(_signal: AbortSignal): Promise<void> {}
  isReady(): boolean { return true; }
  async publishReply(_reply: SupervisorReply): Promise<void> {}
  establishTerminationBarrier(): void {}
  async requestClose(_signal: AbortSignal): Promise<void> {}
  async waitForClose(_deadline: number | Date): Promise<RpcSupervisorChannelCloseState> { return "released"; }
  async release(): Promise<void> {}
  onFault(_listener: (fault: RpcSupervisorChannelFault) => void): () => void { return () => {}; }
}

function emitPiEvent(rpc: FakeRpcClient, rawEvent: unknown): void {
  const normalized = normalizeRpcBridgeEvent(rawEvent);
  assert.equal(normalized.kind, "event");
  if (normalized.kind === "event") rpc.emitEvent(normalized.event);
}

async function startHarness(initialState: Record<string, unknown> = {
  isStreaming: false,
  isCompacting: false,
  pendingMessageCount: 0,
}): Promise<{
  readonly rpc: FakeRpcClient;
  readonly supervisor: RpcSupervisor;
  readonly tree: TreeController;
  readonly events: RpcSupervisorEvent[];
}> {
  const rpc = new FakeRpcClient({ state: initialState });
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
    reservation: { templateId: "researcher", name: "原生压缩测试子代理" },
    managedNode: new TestManagedRpcNode(rpc),
    channel: new ReadyChannel(),
    startupTimeoutMs: 1_000,
    gracefulShutdownMs: 1_000,
  });
  const events: RpcSupervisorEvent[] = [];
  supervisor.onEvent((event) => events.push(event));
  assert.deepEqual(await supervisor.start(), {
    ok: true,
    agent_id: CHILD_ID,
    state: "idle",
  });
  return { rpc, supervisor, tree, events };
}

function stateOf(tree: TreeController): string {
  const status = tree.getStatus(CHILD_ID);
  assert.equal(status.ok, true);
  if (!status.ok) return "missing";
  return status.data.state;
}

test("get_state.isCompacting 校准 activity，agent_settled 在稳定 false 后收束", async () => {
  const { rpc, supervisor, tree, events } = await startHarness();

  rpc.setState({ isStreaming: true, isCompacting: true, pendingMessageCount: 0 });
  assert.equal(await supervisor.synchronizeState(), true);
  assert.equal(stateOf(tree), "working");
  assert.deepEqual(events.at(-1), {
    kind: "activity",
    activity: { phase: "compacting" },
  });

  rpc.setState({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
  emitPiEvent(rpc, { type: "agent_settled" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(await supervisor.synchronizeState(), true);
  assert.equal(stateOf(tree), "idle");
});

test("willRetry 后直接 settled 时清除未启动的续跑保护", async () => {
  const { rpc, supervisor, tree } = await startHarness();

  rpc.setState({ isStreaming: true, isCompacting: false, pendingMessageCount: 0 });
  emitPiEvent(rpc, { type: "agent_start" });
  rpc.setState({ isStreaming: false, isCompacting: true, pendingMessageCount: 0 });
  emitPiEvent(rpc, { type: "compaction_start", reason: "overflow" });
  rpc.setState({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
  emitPiEvent(rpc, {
    type: "compaction_end",
    reason: "overflow",
    aborted: false,
    willRetry: true,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stateOf(tree), "working");

  emitPiEvent(rpc, { type: "agent_settled" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(await supervisor.synchronizeState(), true);
  assert.equal(stateOf(tree), "idle");
});

test("abort 请求间隙启动压缩时不把普通 abort 误报为中断成功", async () => {
  const { rpc, supervisor, tree, events } = await startHarness();

  rpc.setState({ isStreaming: true, isCompacting: false, pendingMessageCount: 0 });
  emitPiEvent(rpc, { type: "agent_start" });
  const abortGate = rpc.deferNext("abort");
  const interrupt = supervisor.interrupt();
  await abortGate.started;

  rpc.setState({ isStreaming: false, isCompacting: true, pendingMessageCount: 0 });
  emitPiEvent(rpc, { type: "compaction_start", reason: "threshold" });
  rpc.setState({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
  emitPiEvent(rpc, {
    type: "compaction_end",
    reason: "threshold",
    aborted: false,
    willRetry: false,
  });
  abortGate.resolve();

  assert.deepEqual(await interrupt, {
    ok: true,
    accepted: true,
    changed: false,
    blocked_reason: "compaction_active",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.notEqual(stateOf(tree), "interrupting");
  assert.equal(
    events.some((event) => event.kind === "lifecycle" && event.event.type === "interrupt_accepted"),
    false,
  );
});

test("abort 响应晚于 agent_settled 时不倒写 interrupting", async () => {
  const { rpc, supervisor, tree, events } = await startHarness();

  rpc.setState({ isStreaming: true, isCompacting: false, pendingMessageCount: 0 });
  emitPiEvent(rpc, { type: "agent_start" });
  const abortGate = rpc.deferNext("abort");
  const interrupt = supervisor.interrupt();
  await abortGate.started;

  rpc.setState({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
  emitPiEvent(rpc, { type: "agent_settled" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  abortGate.resolve();

  assert.deepEqual(await interrupt, {
    ok: true,
    accepted: true,
    changed: false,
  });
  assert.equal(stateOf(tree), "idle");
  assert.equal(
    events.some((event) => event.kind === "lifecycle" && event.event.type === "interrupt_accepted"),
    false,
  );
});

test("compaction_end fence 忽略 stale true，并允许稳定 false 收敛", async () => {
  const { rpc, supervisor, tree, events } = await startHarness();

  rpc.setState({ isStreaming: true, isCompacting: false, pendingMessageCount: 0 });
  emitPiEvent(rpc, { type: "agent_start" });
  rpc.setState({ isStreaming: false, isCompacting: true, pendingMessageCount: 0 });
  emitPiEvent(rpc, { type: "compaction_start", reason: "threshold" });

  const staleProbe = rpc.deferNext("get_state");
  const activityAfterEnd: string[] = [];
  let afterEnd = false;
  supervisor.onEvent((event) => {
    if (afterEnd && event.kind === "activity") activityAfterEnd.push(event.activity.phase);
  });
  afterEnd = true;
  emitPiEvent(rpc, {
    type: "compaction_end",
    reason: "threshold",
    aborted: false,
    willRetry: false,
  });
  await staleProbe.started;
  staleProbe.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(activityAfterEnd, ["processing"]);
  assert.equal(stateOf(tree), "working");

  rpc.setState({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
  emitPiEvent(rpc, { type: "agent_settled" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(await supervisor.synchronizeState(), true);
  assert.equal(stateOf(tree), "idle");
  assert.equal(events.some((event) => event.kind === "fault"), false);
});
