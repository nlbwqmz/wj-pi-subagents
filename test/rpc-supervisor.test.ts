import assert from "node:assert/strict";
import test from "node:test";
import {
  ChildReplyCoordinator,
} from "../src/child-reply-coordinator.ts";
import {
  CHILD_REPLY_SCHEMA,
  CHILD_REPLY_VERSION,
  type ChildFinalEnvelope,
} from "../src/child-reply-envelope.ts";
import { ParentReplyInbox } from "../src/parent-reply-inbox.ts";
import {
  FakeRpcClient,
  PiRpcClientAdapter,
  RpcSupervisor,
  type RpcSupervisorChannel,
  type RpcSupervisorChannelCloseState,
  type RpcSupervisorEvent,
} from "../src/rpc-supervisor.ts";
import type {
  SupervisorReply,
  SupervisorReplyInput,
  SupervisorTaskAssignment,
  SupervisorTaskStarted,
  SupervisorCompactionComplete,
  SupervisorCompactionCompleted,
  SupervisorCompactionPrepare,
  SupervisorCompactionPrepared,
  SupervisorCapabilityManifest,
  SupervisorEvent,
} from "../src/supervisor-channel.ts";
import {
  ManagedRpcCommandRejectedError,
  type ManagedRpcNodeLike,
  type ManagedRpcNodeStartContext,
} from "../src/managed-rpc-node.ts";
import {
  FakeProcessTreeAdapter,
  type FakeProcessTreeAdapterOptions,
} from "../src/fake-process-tree-adapter.ts";
import type {
  ExitObservation,
  ProcessTreeHandle,
  ResourceObservation,
} from "../src/process-tree-capability.ts";
import {
  ROOT_TREE_ACTOR,
  TreeController,
  type AgentLifecycleEvent,
  type AgentTaskProjectionInput,
  type ControlResult,
  type LifecycleEventOutcome,
  type ReserveStartingChildInput,
  type ReservedAgentOutcome,
  type TreeActor,
} from "../src/tree-controller.ts";

const FIRST_AGENT_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const TURN_ID = "33333333-3333-4333-8333-333333333333";
const NEXT_TURN_ID = "44444444-4444-4444-8444-444444444444";
const COMMIT_ID = "55555555-5555-4555-8555-555555555555";
const AUTONOMOUS_TASK_ID = "66666666-6666-4666-8666-666666666666";

function finalEnvelope(taskId: string, turnId = TURN_ID, commitId = COMMIT_ID): ChildFinalEnvelope {
  return Object.freeze({
    schema: CHILD_REPLY_SCHEMA,
    version: CHILD_REPLY_VERSION,
    kind: "final",
    agent_id: FIRST_AGENT_ID,
    task_id: taskId,
    turn_id: turnId,
    commit_id: commitId,
    run_state: "settled",
    output_state: "present",
    text: "任务完成",
  });
}

test("PiRpcClientAdapter 只委托 Pi 公共命令并从 transport observer 补充故障观察", async () => {
  const operations: string[] = [];
  let piEventListener: ((event: unknown) => void) | undefined;
  let faultListener: ((fault: "eof" | "protocol_fault" | "process_exit") => void) | undefined;
  const adapter = new PiRpcClientAdapter({
    start: async () => { operations.push("start"); },
    prompt: async () => { operations.push("prompt"); },
    steer: async () => { operations.push("steer"); },
    abort: async () => { operations.push("abort"); },
    getState: async () => ({ isStreaming: false }),
    onEvent: (listener) => {
      piEventListener = listener;
      return () => { piEventListener = undefined; };
    },
  }, {
    onFault: (listener) => {
      faultListener = listener;
      return () => { faultListener = undefined; };
    },
  });
  const events: unknown[] = [];
  const faults: string[] = [];
  adapter.onEvent((event) => events.push(event));
  adapter.onTransportFault((fault) => faults.push(fault));

  await adapter.start();
  await adapter.prompt("hello");
  await adapter.steer("next");
  await adapter.abort();
  assert.deepEqual(await adapter.getState(), { isStreaming: false });
  piEventListener?.({ type: "agent_settled" });
  faultListener?.("eof");

  assert.deepEqual(operations, ["start", "prompt", "steer", "abort"]);
  assert.deepEqual(events, [{ type: "agent_settled" }]);
  assert.deepEqual(faults, ["eof"]);
});

function createController(ids = [FIRST_AGENT_ID, SECOND_AGENT_ID]): TreeController {
  let index = 0;
  return new TreeController({
    config: {
      maxDepth: 2,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 16,
      waitTimeoutMs: 60_000,
    },
    idFactory: () => ids[Math.min(index++, ids.length - 1)]!,
  });
}

class RecordingController {
  private readonly controller: TreeController;
  private readonly trace: string[];

  constructor(
    controller: TreeController,
    trace: string[],
  ) {
    this.controller = controller;
    this.trace = trace;
  }

  reserveStartingChild(
    actor: TreeActor | unknown,
    input: ReserveStartingChildInput | unknown,
  ): ControlResult<ReservedAgentOutcome> {
    this.trace.push("controller:reserve");
    return this.controller.reserveStartingChild(actor, input);
  }

  applyLifecycleEvent(
    agentId: unknown,
    event: AgentLifecycleEvent | unknown,
  ): ControlResult<LifecycleEventOutcome> {
    const type = typeof event === "object" && event !== null && "type" in event
      ? String(event.type)
      : "invalid";
    this.trace.push(`controller:${type}`);
    return this.controller.applyLifecycleEvent(agentId, event);
  }

  applyTaskProjection(
    agentId: unknown,
    projection: AgentTaskProjectionInput | unknown,
  ): ControlResult<LifecycleEventOutcome> {
    this.trace.push("controller:task_projection");
    return this.controller.applyTaskProjection(agentId, projection);
  }
}

/**
 * 测试仍复用 RPC 与进程树替身的可控行为，但监督器只能看到同一受管节点。
 * 启动中等待绑定的语义与生产 ManagedRpcNode 一致，用于覆盖迟到 launch 回收。
 */
class TestManagedRpcNode implements ManagedRpcNodeLike {
  readonly process_binding = "managed" as const;

  private readonly rpc: FakeRpcClient;
  private readonly adapter: FakeProcessTreeAdapter;
  private tree: ProcessTreeHandle | undefined;
  private phase: "new" | "starting" | "ready" | "failed" | "released" = "new";
  private startPromise: Promise<void> | undefined;
  private bindingSettled = false;
  private resolveBindingSettled!: () => void;
  private readonly bindingSettlement = new Promise<void>((resolve) => {
    this.resolveBindingSettled = resolve;
  });
  private gracefulCloseRequested = false;
  private forceTerminationRequested = false;
  private releaseRequested = false;

  constructor(rpc: FakeRpcClient, adapter: FakeProcessTreeAdapter) {
    this.rpc = rpc;
    this.adapter = adapter;
  }

  start(_signal?: AbortSignal, _context?: ManagedRpcNodeStartContext): Promise<void> {
    this.startPromise ??= this.runStart();
    return this.startPromise;
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

  async sendSupervisorFrame(): Promise<void> {}

  onSupervisorFrame(): () => void {
    return () => {};
  }

  async requestGracefulClose(signal: AbortSignal): Promise<void> {
    this.gracefulCloseRequested = true;
    await this.waitForBindingSettlement();
    if (this.tree !== undefined) await this.adapter.requestGracefulClose(this.tree, signal);
  }

  async forceTerminate(): Promise<void> {
    this.forceTerminationRequested = true;
    await this.waitForBindingSettlement();
    if (this.tree !== undefined) await this.adapter.forceTerminate(this.tree);
  }

  async waitForExit(deadline: number | Date): Promise<ExitObservation> {
    if (this.tree !== undefined) return this.adapter.waitForExit(this.tree, deadline);
    return this.phase === "starting" ? { state: "unknown" } : { state: "exited" };
  }

  async inspect(): Promise<ResourceObservation> {
    if (this.tree !== undefined) return this.adapter.inspect(this.tree);
    return this.phase === "starting" ? { state: "unknown" } : { state: "released" };
  }

  async release(): Promise<void> {
    this.releaseRequested = true;
    await this.waitForBindingSettlement();
    if (this.tree !== undefined) await this.adapter.release(this.tree);
    this.phase = "released";
  }

  private async runStart(): Promise<void> {
    if (this.phase !== "new") throw new Error("测试受管节点已启动");
    this.phase = "starting";
    try {
      const launch = await this.adapter.launch({ command: "test-rpc-bridge" });
      this.tree = launch.tree;
      this.recordBindingSettlement();
      if (this.cleanupRequested()) {
        this.phase = "failed";
        return;
      }
      await this.rpc.start();
      if (this.cleanupRequested()) {
        this.phase = "failed";
        return;
      }
      this.phase = "ready";
    } catch (error) {
      this.recordBindingSettlement();
      if (!this.releaseRequested) this.phase = "failed";
      throw error;
    }
  }

  private cleanupRequested(): boolean {
    return this.gracefulCloseRequested || this.forceTerminationRequested || this.releaseRequested;
  }

  private recordBindingSettlement(): void {
    if (this.bindingSettled) return;
    this.bindingSettled = true;
    this.resolveBindingSettled();
  }

  private async waitForBindingSettlement(): Promise<void> {
    if (this.phase === "starting" && !this.bindingSettled) await this.bindingSettlement;
  }
}

class RecordingProcessTreeAdapter extends FakeProcessTreeAdapter {
  private readonly trace: string[];

  constructor(
    trace: string[],
    options: FakeProcessTreeAdapterOptions = {},
  ) {
    super(options);
    this.trace = trace;
  }

  override async launch(spec: { readonly command: string }): Promise<{
    readonly tree: ProcessTreeHandle;
    readonly transport: import("../src/process-tree-capability.ts").ManagedProcessTransport;
  }> {
    this.trace.push("process:launch");
    return super.launch(spec);
  }

  override async requestGracefulClose(
    tree: ProcessTreeHandle,
    signal: AbortSignal,
  ): Promise<void> {
    this.trace.push("process:graceful_close");
    return super.requestGracefulClose(tree, signal);
  }

  override async forceTerminate(tree: ProcessTreeHandle): Promise<void> {
    this.trace.push("process:force_terminate");
    return super.forceTerminate(tree);
  }
}

class DelayedLaunchProcessTreeAdapter extends RecordingProcessTreeAdapter {
  readonly launchStarted: Promise<void>;
  private signalStarted!: () => void;
  private releasePromise: Promise<void>;
  private releaseAttach!: () => void;

  constructor(trace: string[]) {
    super(trace);
    this.launchStarted = new Promise<void>((resolve) => {
      this.signalStarted = resolve;
    });
    this.releasePromise = new Promise<void>((resolve) => {
      this.releaseAttach = resolve;
    });
  }

  override async launch(spec: { readonly command: string }): Promise<{
    readonly tree: ProcessTreeHandle;
    readonly transport: import("../src/process-tree-capability.ts").ManagedProcessTransport;
  }> {
    this.signalStarted();
    await this.releasePromise;
    return super.launch(spec);
  }

  completeLaunch(): void {
    this.releaseAttach();
  }
}

class ReleaseFailingProcessTreeAdapter extends RecordingProcessTreeAdapter {
  override async release(_tree: ProcessTreeHandle): Promise<void> {
    throw new Error("TOP_SECRET_RELEASE_ERROR");
  }
}

class HangingGracefulProcessTreeAdapter extends RecordingProcessTreeAdapter {
  closeSignal: AbortSignal | undefined;

  override async requestGracefulClose(
    _tree: ProcessTreeHandle,
    signal: AbortSignal,
  ): Promise<void> {
    this.closeSignal = signal;
    await new Promise<void>(() => {});
  }
}

class RecordingSupervisorChannel implements RpcSupervisorChannel {
  private ready = true;
  private closeState: RpcSupervisorChannelCloseState = "released";
  private readonly faultListeners = new Set<(fault: "eof" | "protocol_fault") => void>();
  private readonly replies: Array<SupervisorReplyInput | SupervisorReply> = [];
  private readonly taskAssignments: SupervisorTaskAssignment[] = [];
  private readonly eventListeners = new Set<(event: SupervisorEvent) => void>();
  private readonly taskStartedListeners = new Set<(started: SupervisorTaskStarted) => void>();
  private readonly compactionPrepareListeners = new Set<(request: SupervisorCompactionPrepare) => void>();
  private readonly compactionCompleteListeners = new Set<(request: SupervisorCompactionComplete) => void>();
  private readonly compactionResponses: Array<SupervisorCompactionPrepared | SupervisorCompactionCompleted> = [];
  private readonly trace: string[];
  private readonly readyPromise: Promise<void> | undefined;
  private readonly taskAssignmentHandler: ((
    assignment: SupervisorTaskAssignment,
    signal?: AbortSignal,
  ) => void | Promise<void>) | undefined;
  private replyRetryCount = 0;

  constructor(
    trace: string[],
    readyPromise?: Promise<void>,
    taskAssignmentHandler?: (
      assignment: SupervisorTaskAssignment,
      signal?: AbortSignal,
    ) => void | Promise<void>,
  ) {
    this.trace = trace;
    this.readyPromise = readyPromise;
    this.taskAssignmentHandler = taskAssignmentHandler;
  }

  async bind(): Promise<void> {
    this.trace.push("channel:bind");
  }

  async waitForReady(): Promise<void> {
    this.trace.push("channel:wait_ready");
    await this.readyPromise;
  }

  isReady(): boolean {
    return this.ready;
  }

  async publishReply(reply: SupervisorReplyInput | SupervisorReply): Promise<void> {
    this.trace.push("channel:reply");
    this.replies.push(reply);
  }

  async retryPendingReplies(): Promise<void> {
    this.replyRetryCount += 1;
  }

  pendingReplyRetries(): number {
    return this.replyRetryCount;
  }

  async publishTaskAssignmentAndWaitForAck(
    assignment: SupervisorTaskAssignment,
    signal?: AbortSignal,
  ): Promise<void> {
    this.trace.push("channel:task_assignment");
    this.taskAssignments.push(assignment);
    await this.taskAssignmentHandler?.(assignment, signal);
  }

  onEvent(listener: (event: SupervisorEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  emitEvent(event: SupervisorEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }

  onTaskStarted(listener: (started: SupervisorTaskStarted) => void): () => void {
    this.taskStartedListeners.add(listener);
    return () => this.taskStartedListeners.delete(listener);
  }

  emitTaskStarted(started: SupervisorTaskStarted): void {
    for (const listener of this.taskStartedListeners) listener(started);
  }

  onCompactionPrepare(listener: (request: SupervisorCompactionPrepare) => void): () => void {
    this.compactionPrepareListeners.add(listener);
    return () => this.compactionPrepareListeners.delete(listener);
  }

  onCompactionComplete(listener: (request: SupervisorCompactionComplete) => void): () => void {
    this.compactionCompleteListeners.add(listener);
    return () => this.compactionCompleteListeners.delete(listener);
  }

  emitCompactionPrepare(transactionId: string): void {
    for (const listener of this.compactionPrepareListeners) listener({ transaction_id: transactionId });
  }

  emitCompactionComplete(
    transactionId: string,
    outcome: SupervisorCompactionComplete["outcome"],
    continuationExpected = false,
  ): void {
    for (const listener of this.compactionCompleteListeners) {
      listener({
        transaction_id: transactionId,
        outcome,
        continuation_expected: continuationExpected,
      });
    }
  }

  async respondCompactionPrepared(response: SupervisorCompactionPrepared): Promise<void> {
    this.compactionResponses.push(response);
  }

  async respondCompactionCompleted(response: SupervisorCompactionCompleted): Promise<void> {
    this.compactionResponses.push(response);
  }

  publishedCompactionResponses(): readonly (SupervisorCompactionPrepared | SupervisorCompactionCompleted)[] {
    return Object.freeze([...this.compactionResponses]);
  }

  establishTerminationBarrier(): void {
    this.trace.push("channel:termination_barrier");
  }

  async requestClose(_signal: AbortSignal): Promise<void> {
    this.trace.push("channel:close");
    this.ready = false;
  }

  async waitForClose(): Promise<RpcSupervisorChannelCloseState> {
    this.trace.push("channel:wait_close");
    return this.closeState;
  }

  async release(): Promise<void> {
    this.trace.push("channel:release");
  }

  onFault(listener: (fault: "eof" | "protocol_fault") => void): () => void {
    this.faultListeners.add(listener);
    return () => this.faultListeners.delete(listener);
  }

  emitFault(fault: "eof" | "protocol_fault"): void {
    for (const listener of this.faultListeners) listener(fault);
  }

  setCloseState(state: RpcSupervisorChannelCloseState): void {
    this.closeState = state;
  }

  publishedReplies(): readonly (SupervisorReplyInput | SupervisorReply)[] {
    return Object.freeze([...this.replies]);
  }

  publishedTaskAssignments(): readonly SupervisorTaskAssignment[] {
    return Object.freeze([...this.taskAssignments]);
  }
}

class CapabilityRecordingSupervisorChannel extends RecordingSupervisorChannel {
  private readonly capabilityListeners = new Set<(capability: SupervisorCapabilityManifest) => void>();
  private capabilitySubscribedResolve!: () => void;
  readonly capabilitySubscribed = new Promise<void>((resolve) => {
    this.capabilitySubscribedResolve = resolve;
  });

  getCapability(): SupervisorCapabilityManifest | undefined {
    return undefined;
  }

  onCapability(listener: (capability: SupervisorCapabilityManifest) => void): () => void {
    this.capabilityListeners.add(listener);
    this.capabilitySubscribedResolve();
    return () => this.capabilityListeners.delete(listener);
  }
}

class HangingCloseSupervisorChannel extends RecordingSupervisorChannel {
  closeSignal: AbortSignal | undefined;

  override async requestClose(signal: AbortSignal): Promise<void> {
    this.closeSignal = signal;
    await new Promise<void>(() => {});
  }
}

test("启动按预留、监督绑定、进程树、双通道握手和无副作用 RPC 顺序进入 idle", async () => {
  const trace: string[] = [];
  const tree = createController();
  const controller = new RecordingController(tree, trace);
  const processTreeAdapter = new RecordingProcessTreeAdapter(trace);
  const rpcClient = new FakeRpcClient({
    onOperation: (operation) => trace.push(`rpc:${operation}`),
  });
  const managedNode = new TestManagedRpcNode(rpcClient, processTreeAdapter);
  const channel = new RecordingSupervisorChannel(trace);
  const supervisor = new RpcSupervisor({
    controller,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "研究" },
    managedNode,
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 10,
  });

  const result = await supervisor.start();

  assert.deepEqual(result, {
    ok: true,
    agent_id: FIRST_AGENT_ID,
    state: "idle",
  });
  assert.deepEqual(trace.slice(0, 8), [
    "controller:reserve",
    "channel:bind",
    "process:launch",
    "rpc:start",
    "channel:wait_ready",
    "rpc:get_state",
    "controller:startup_ready",
  ]);
  assert.equal(tree.getStatus(FIRST_AGENT_ID).ok, true);
  const status = tree.getStatus(FIRST_AGENT_ID);
  if (status.ok) assert.equal(status.data.state, "idle");
});

test("等待 child capability 期间的监督故障立即以 spawn_failed 回滚", async () => {
  const trace: string[] = [];
  const tree = createController();
  const controller = new RecordingController(tree, trace);
  const processTreeAdapter = new RecordingProcessTreeAdapter(trace);
  const rpcClient = new FakeRpcClient();
  const stateGate = rpcClient.deferNext("get_state");
  const managedNode = new TestManagedRpcNode(rpcClient, processTreeAdapter);
  const channel = new CapabilityRecordingSupervisorChannel(trace);
  const supervisor = new RpcSupervisor({
    controller,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "能力故障" },
    managedNode,
    channel,
    startupTimeoutMs: 1_000,
    gracefulShutdownMs: 10,
    validateCapability: () => true,
  });

  const starting = supervisor.start();
  await stateGate.started;
  stateGate.resolve();
  await channel.capabilitySubscribed;
  channel.emitFault("protocol_fault");

  assert.deepEqual(await starting, {
    ok: false,
    agent_id: FIRST_AGENT_ID,
    code: "spawn_failed",
    cleanup: "confirmed",
  });
});

test("启动超时先记录安全故障再强制回滚，确认回收后释放名额且不复用身份", async () => {
  const trace: string[] = [];
  const tree = createController();
  const controller = new RecordingController(tree, trace);
  const processTreeAdapter = new RecordingProcessTreeAdapter(trace);
  const rpcClient = new FakeRpcClient();
  const managedNode = new TestManagedRpcNode(rpcClient, processTreeAdapter);
  const channel = new RecordingSupervisorChannel(trace, new Promise<void>(() => {}));
  const first = new RpcSupervisor({
    controller,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "超时" },
    managedNode,
    channel,
    startupTimeoutMs: 5,
    gracefulShutdownMs: 5,
  });

  const failed = await first.start();

  assert.deepEqual(failed, {
    ok: false,
    agent_id: FIRST_AGENT_ID,
    code: "spawn_timeout",
    cleanup: "confirmed",
  });
  assert.ok(trace.indexOf("controller:startup_failed") < trace.indexOf("process:force_terminate"));
  const failedStatus = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(failedStatus.ok, true);
  if (failedStatus.ok) assert.equal(failedStatus.data.state, "terminated");

  const second = tree.reserveStartingChild(ROOT_TREE_ACTOR, {
    templateId: "researcher",
    name: "新身份",
  });
  assert.equal(second.ok, true);
  if (second.ok) assert.equal(second.data.node.agent_id, SECOND_AGENT_ID);
});

test("launch 超时但树句柄迟到时先保留名额，随后后台确认并完成回收", async () => {
  const trace: string[] = [];
  const tree = createController();
  const processTreeAdapter = new DelayedLaunchProcessTreeAdapter(trace);
  const rpcClient = new FakeRpcClient();
  const managedNode = new TestManagedRpcNode(rpcClient, processTreeAdapter);
  const supervisor = new RpcSupervisor({
    controller: new RecordingController(tree, trace),
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "迟到句柄" },
    managedNode,
    channel: new RecordingSupervisorChannel(trace),
    startupTimeoutMs: 5,
    gracefulShutdownMs: 5,
  });

  const startup = supervisor.start();
  await processTreeAdapter.launchStarted;
  const failed = await startup;

  assert.deepEqual(failed, {
    ok: false,
    agent_id: FIRST_AGENT_ID,
    code: "termination_incomplete",
    cleanup: "incomplete",
  });
  let status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) assert.equal(status.data.state, "terminating");

  processTreeAdapter.completeLaunch();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) assert.equal(status.data.state, "terminated");
  assert.equal(trace.includes("process:force_terminate"), true);
});

test("RPC 在启动探测前提前 EOF 时走 spawn_failed 回滚而不发布 startup_ready", async () => {
  const trace: string[] = [];
  const tree = createController();
  const rpcClient = new FakeRpcClient({
    onOperation: (operation) => trace.push(`rpc:${operation}`),
    transportEventOnStart: "eof",
  });
  const managedNode = new TestManagedRpcNode(rpcClient, new RecordingProcessTreeAdapter(trace));
  const supervisor = new RpcSupervisor({
    controller: new RecordingController(tree, trace),
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "提前退出" },
    managedNode,
    channel: new RecordingSupervisorChannel(trace),
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });

  const result = await supervisor.start();

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "spawn_failed");
    assert.equal(result.cleanup, "confirmed");
  }
  assert.equal(trace.includes("controller:startup_ready"), false);
  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) assert.equal(status.data.state, "terminated");
});

test("同一节点的 prompt 与 steering 只按一个 RPC 写入顺序域执行", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const managedNode = new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter());
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "串行" },
    managedNode,
    channel: new RecordingSupervisorChannel([]),
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  const promptGate = rpcClient.deferNext("prompt");
  const steerGate = rpcClient.deferNext("steer");

  const prompt = supervisor.prompt("first");
  await promptGate.started;
  const steering = supervisor.steer("second");
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(rpcClient.operations(), ["start", "get_state", "prompt"]);
  promptGate.resolve();
  const promptResult = await prompt;
  assert.equal(promptResult.ok, true);
  if (!promptResult.ok) return;
  rpcClient.emitEvent({ type: "agent_start" });
  await steerGate.started;
  assert.deepEqual(rpcClient.operations(), ["start", "get_state", "prompt", "steer"]);
  steerGate.resolve();
  const steeringResult = await steering;
  assert.equal(steeringResult.ok, true);
  assert.equal(
    promptResult.ok && steeringResult.ok && promptResult.task_id === steeringResult.task_id,
    true,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "working");
    assert.equal(status.data.mailbox_pending_count, 0);
  }
});

test("任务租约 ACK 超时只暂停不确定投递，不把健康节点标为 failed", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  let resolveAcknowledgementTimeout!: () => void;
  const acknowledgementTimedOut = new Promise<void>((resolve) => {
    resolveAcknowledgementTimeout = resolve;
  });
  const channel = new RecordingSupervisorChannel([], undefined, async (_assignment, signal) => {
    await new Promise<void>((_resolve, reject) => {
      if (signal === undefined) {
        reject(new Error("测试租约 ACK 缺少取消信号"));
        return;
      }
      signal.addEventListener("abort", () => {
        resolveAcknowledgementTimeout();
        reject(new Error("测试租约 ACK 超时"));
      }, { once: true });
    });
  });
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "租约 ACK 期限" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
    taskAssignmentTimeoutMs: 10,
  });
  const events: RpcSupervisorEvent[] = [];
  supervisor.onEvent((event) => events.push(event));
  assert.equal((await supervisor.start()).ok, true);

  const first = await supervisor.prompt("等待租约确认");
  assert.equal(first.ok, true);
  if (!first.ok) return;
  await acknowledgementTimedOut;
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "suspended");
    assert.equal(status.data.error, undefined);
    assert.equal(status.data.activity?.phase, "delivery_uncertain");
    assert.equal(status.data.mailbox_pending_count, 0);
    assert.equal(status.data.host_pending_count, 0);
    assert.equal(status.data.reply_outbox_pending_count, 0);
  }
  assert.deepEqual(rpcClient.operations(), ["start", "get_state"]);
  const retry = await supervisor.prompt("超时后的后续消息");
  assert.equal(retry.ok, true);
  if (retry.ok) assert.equal(retry.task_id, first.task_id);
  const suspended = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(suspended.ok, true);
  if (suspended.ok) assert.equal(suspended.data.mailbox_pending_count, 1);
  assert.equal(events.some((event) => event.kind === "fault"), false);
  await supervisor.terminate();
});

test("任务租约 ACK 超时即使通道忽略取消也能收敛为 suspended", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([], undefined, async () => {
    // 模拟 send 本身卡住；该 Promise 不观察监督器传入的 signal。
    await new Promise<void>(() => {});
  });
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "忽略取消的租约" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
    taskAssignmentTimeoutMs: 10,
  });
  assert.equal((await supervisor.start()).ok, true);

  const delivery = await supervisor.prompt("通道忽略取消");
  assert.equal(delivery.ok, true);
  await new Promise<void>((resolve) => setTimeout(resolve, 30));

  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "suspended");
    assert.equal(status.data.error, undefined);
    assert.equal(status.data.activity?.phase, "delivery_uncertain");
    assert.equal(status.data.mailbox_pending_count, 0);
    assert.equal(status.data.host_pending_count, 0);
    assert.equal(status.data.reply_outbox_pending_count, 0);
  }
  assert.deepEqual(rpcClient.operations(), ["start", "get_state"]);
  const retry = await supervisor.prompt("暂停后的消息");
  assert.equal(retry.ok, true);
  await supervisor.terminate();
});

test("Pi 自动重试沿用父端任务身份且不把继续执行投影为 internal_error", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "自动重试" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  const promptGate = rpcClient.deferNext("prompt");
  const delivery = await supervisor.prompt("执行可能触发供应商重试的任务");
  assert.equal(delivery.ok, true);
  if (!delivery.ok) return;
  await promptGate.started;

  const assignment = channel.publishedTaskAssignments()[0];
  assert.ok(assignment);
  let turnIndex = 0;
  const child = new ChildReplyCoordinator({
    agentId: FIRST_AGENT_ID,
    port: {
      async publishTaskStarted(started): Promise<void> {
        channel.emitTaskStarted(started);
      },
      async publishReplyAndWaitForAck(): Promise<void> {},
    },
    taskIdFactory: () => AUTONOMOUS_TASK_ID,
    turnIdFactory: () => [TURN_ID, NEXT_TURN_ID][turnIndex++]!,
    commitIdFactory: () => COMMIT_ID,
  });
  child.observeTaskAssignment(assignment);
  rpcClient.emitEvent({ type: "agent_start" });
  child.observeAgentStart();
  await new Promise<void>((resolve) => setImmediate(resolve));
  promptGate.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));

  child.observeAgentEnd();
  rpcClient.emitEvent({ type: "agent_end", messages: [], willRetry: true });
  rpcClient.emitEvent({ type: "agent_start" });
  child.observeAgentStart();
  await new Promise<void>((resolve) => setImmediate(resolve));

  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "working");
    assert.equal(status.data.error, undefined);
    assert.equal(status.data.activity?.task_id, delivery.task_id);
  }
});

test("协调 continuation 已启动时，尾随旧 settled 不得降级活动轮次", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "尾随旧结算" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
    onCompactionPrepare: () => true,
    onCompactionComplete: () => true,
  });
  assert.equal((await supervisor.start()).ok, true);

  const current = await supervisor.prompt("进入协调压缩任务");
  assert.equal(current.ok, true);
  if (!current.ok) return;
  await new Promise<void>((resolve) => setImmediate(resolve));
  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: current.task_id, turn_id: TURN_ID });

  channel.emitCompactionPrepare("compact-trailing-settled");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(channel.publishedCompactionResponses(), [{
    transaction_id: "compact-trailing-settled",
    accepted: true,
  }]);

  rpcClient.emitEvent({ type: "compaction_start", reason: "manual" });
  rpcClient.emitEvent({
    type: "compaction_end",
    reason: "manual",
    aborted: false,
    willRetry: false,
    failed: false,
  });
  channel.emitCompactionComplete("compact-trailing-settled", "succeeded", true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  // 协调扩展可在旧 agent_settled handler 返回前启动 continuation。
  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: current.task_id, turn_id: NEXT_TURN_ID });
  rpcClient.emitEvent({
    type: "tool_execution_start",
    toolCallId: "continuation-tool",
    toolName: "spawn_agent",
  });
  rpcClient.emitEvent({ type: "agent_settled" });

  let status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "working");
    assert.equal(status.data.activity?.phase, "executing_tools");
    assert.equal(status.data.activity?.category, "delegating");
    assert.equal(status.data.activity?.active_count, 1);
    assert.equal(status.data.reply_outbox_pending_count, 0);
  }

  const unexpectedPrompt = rpcClient.deferNext("prompt");
  const queued = await supervisor.steer("续跑中的补充指令");
  assert.equal(queued.ok, true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  const assignment = channel.publishedTaskAssignments().at(-1);
  if (assignment?.mode === "prompt") {
    unexpectedPrompt.reject(new ManagedRpcCommandRejectedError());
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(assignment?.mode, "steer");
  assert.equal(rpcClient.operations().filter((operation) => operation === "prompt").length, 1);
  assert.equal(rpcClient.operations().filter((operation) => operation === "steer").length, 1);

  status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "working");
    assert.equal(status.data.mailbox_pending_count, 0);
    assert.equal(status.data.activity?.phase, "executing_tools");
    assert.equal(status.data.activity?.task_id, current.task_id);
  }
  await supervisor.terminate();
});

test("协调 continuation 的旧 settled 正常先到时仍建立 provisional candidate", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "正常结算顺序" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
    onCompactionPrepare: () => true,
    onCompactionComplete: () => true,
  });
  assert.equal((await supervisor.start()).ok, true);

  const current = await supervisor.prompt("进入协调压缩任务");
  assert.equal(current.ok, true);
  if (!current.ok) return;
  await new Promise<void>((resolve) => setImmediate(resolve));
  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: current.task_id, turn_id: TURN_ID });

  channel.emitCompactionPrepare("compact-settled-first");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  rpcClient.emitEvent({ type: "compaction_start", reason: "manual" });
  rpcClient.emitEvent({
    type: "compaction_end",
    reason: "manual",
    aborted: false,
    willRetry: false,
    failed: false,
  });
  channel.emitCompactionComplete("compact-settled-first", "succeeded", true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  // 没有新 start 时，这就是当前旧 run 的正常 settled，不能被标记误吞。
  rpcClient.emitEvent({ type: "agent_settled" });
  let status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "working");
    assert.equal(status.data.reply_outbox_pending_count, 1);
  }

  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: current.task_id, turn_id: NEXT_TURN_ID });
  status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "working");
    assert.equal(status.data.activity?.phase, "processing");
    assert.equal(status.data.reply_outbox_pending_count, 0);
  }
  await supervisor.terminate();
});

test("Pi 原生自动压缩续跑后，压缩期消息按 FIFO 通过公开 steer 进入同一任务", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "原生压缩续跑" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  const current = await supervisor.prompt("进入可能触发原生压缩的任务");
  assert.equal(current.ok, true);
  if (!current.ok) return;
  await new Promise<void>((resolve) => setImmediate(resolve));
  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: current.task_id, turn_id: TURN_ID });

  rpcClient.emitEvent({ type: "agent_end", messages: [], willRetry: true });
  rpcClient.emitEvent({ type: "compaction_start", reason: "overflow" });
  const first = await supervisor.steer("压缩期间第一条消息");
  const second = await supervisor.steer("压缩期间第二条消息");
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(first.task_id, current.task_id);
  assert.equal(second.task_id, current.task_id);

  let status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.mailbox_pending_count, 2);
    assert.equal(status.data.host_pending_count, 0);
    assert.equal(status.data.activity?.phase, "compacting");
  }

  rpcClient.emitEvent({
    type: "compaction_end",
    reason: "overflow",
    aborted: false,
    willRetry: true,
    failed: false,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(rpcClient.operations().filter((operation) => operation === "steer").length, 0);
  status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "working");
    assert.equal(status.data.mailbox_pending_count, 2);
    assert.equal(status.data.activity?.phase, "reconciling");
  }

  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: current.task_id, turn_id: NEXT_TURN_ID });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(rpcClient.operations().filter((operation) => operation === "steer").length, 2);
  assert.deepEqual(
    channel.publishedTaskAssignments().slice(1).map((assignment) => ({
      task_id: assignment.task_id,
      mode: assignment.mode,
    })),
    [
      { task_id: current.task_id, mode: "steer" },
      { task_id: current.task_id, mode: "steer" },
    ],
  );
  status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "working");
    assert.equal(status.data.mailbox_pending_count, 0);
    assert.equal(status.data.activity?.task_id, current.task_id);
  }
});

test("Pi 原生自动压缩结束后，在真实 start 或 settled 前不猜测消息投递模式", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "原生压缩事实栅栏" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  const current = await supervisor.prompt("进入压缩任务");
  assert.equal(current.ok, true);
  if (!current.ok) return;
  await new Promise<void>((resolve) => setImmediate(resolve));
  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: current.task_id, turn_id: TURN_ID });

  rpcClient.emitEvent({ type: "agent_end", messages: [], willRetry: false });
  rpcClient.emitEvent({ type: "compaction_start", reason: "threshold" });
  const queued = await supervisor.steer("压缩后继续");
  assert.equal(queued.ok, true);
  rpcClient.emitEvent({
    type: "compaction_end",
    reason: "threshold",
    aborted: false,
    willRetry: false,
    failed: false,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "working");
    assert.equal(status.data.mailbox_pending_count, 1);
    assert.equal(status.data.activity?.phase, "reconciling");
  }
  assert.equal(rpcClient.operations().filter((operation) => operation === "steer").length, 0);
  assert.equal(rpcClient.operations().filter((operation) => operation === "prompt").length, 1);
  assert.equal(rpcClient.operations().filter((operation) => operation === "get_state").length, 1);
});

test("threshold 压缩保留先到的 final，并在真实 settled 后完成双条件提交", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "阈值压缩候选" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  const current = await supervisor.prompt("形成可保留候选");
  assert.equal(current.ok, true);
  if (!current.ok) return;
  await new Promise<void>((resolve) => setImmediate(resolve));
  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: current.task_id, turn_id: TURN_ID });
  rpcClient.emitEvent({ type: "agent_end", messages: [], willRetry: false });
  rpcClient.emitEvent({ type: "compaction_start", reason: "threshold" });
  rpcClient.emitEvent({
    type: "compaction_end",
    reason: "threshold",
    aborted: false,
    willRetry: false,
    failed: false,
  });

  let deliveries = 0;
  const candidate = finalEnvelope(current.task_id);
  assert.equal(supervisor.acceptChildReply(candidate, () => {
    deliveries += 1;
    return true;
  }), false);
  assert.equal(deliveries, 0);

  rpcClient.emitEvent({ type: "agent_settled" });
  assert.equal(supervisor.acceptChildReply(candidate, () => {
    deliveries += 1;
    return true;
  }), true);
  assert.equal(deliveries, 1);
  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "idle");
    assert.equal(status.data.last_task?.turn_id, TURN_ID);
    assert.equal(status.data.last_task?.commit_id, COMMIT_ID);
  }
});

test("aborted compaction 即使携带 willRetry 也不等待不存在的续跑", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "压缩取消结算" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  const current = await supervisor.prompt("取消压缩仍需结算");
  assert.equal(current.ok, true);
  if (!current.ok) return;
  await new Promise<void>((resolve) => setImmediate(resolve));
  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: current.task_id, turn_id: TURN_ID });
  rpcClient.emitEvent({ type: "compaction_start", reason: "overflow" });
  rpcClient.emitEvent({
    type: "compaction_end",
    reason: "overflow",
    aborted: true,
    willRetry: true,
    failed: false,
  });
  rpcClient.emitEvent({ type: "agent_settled" });

  assert.equal(supervisor.acceptChildReply(finalEnvelope(current.task_id), () => true), true);
  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "idle");
    assert.equal(status.data.last_task?.commit_id, COMMIT_ID);
  }
});

test("provider compaction failure 释放任务结算，不把 final 卡在 maintenance_failed", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "压缩失败结算" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  const current = await supervisor.prompt("压缩失败仍需交付结果");
  assert.equal(current.ok, true);
  if (!current.ok) return;
  await new Promise<void>((resolve) => setImmediate(resolve));
  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: current.task_id, turn_id: TURN_ID });
  rpcClient.emitEvent({ type: "compaction_start", reason: "threshold" });
  rpcClient.emitEvent({
    type: "compaction_end",
    reason: "threshold",
    aborted: false,
    willRetry: false,
    failed: true,
  });
  rpcClient.emitEvent({ type: "agent_settled" });

  let deliveries = 0;
  assert.equal(supervisor.acceptChildReply(finalEnvelope(current.task_id), () => {
    deliveries += 1;
    return true;
  }), true);
  assert.equal(deliveries, 1);
  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "idle");
    assert.equal(status.data.activity, undefined);
    assert.equal(status.data.last_task?.commit_id, COMMIT_ID);
  }
});

test("overflow willRetry 隔离旧 turn final，必须等下一真实 start 才能提交新 turn", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "溢出重试候选" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  const current = await supervisor.prompt("触发溢出重试");
  assert.equal(current.ok, true);
  if (!current.ok) return;
  await new Promise<void>((resolve) => setImmediate(resolve));
  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: current.task_id, turn_id: TURN_ID });
  rpcClient.emitEvent({ type: "agent_end", messages: [], willRetry: true });
  rpcClient.emitEvent({ type: "compaction_start", reason: "overflow" });
  rpcClient.emitEvent({
    type: "compaction_end",
    reason: "overflow",
    aborted: false,
    willRetry: true,
    failed: false,
  });

  let deliveries = 0;
  const stale = finalEnvelope(current.task_id);
  assert.equal(supervisor.acceptChildReply(stale, () => {
    deliveries += 1;
    return true;
  }), false);
  rpcClient.emitEvent({ type: "agent_settled" });
  assert.equal(supervisor.acceptChildReply(stale, () => {
    deliveries += 1;
    return true;
  }), false);
  assert.equal(deliveries, 0);

  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: current.task_id, turn_id: NEXT_TURN_ID });
  assert.equal(supervisor.acceptChildReply(stale, () => {
    deliveries += 1;
    return true;
  }), true);
  assert.equal(deliveries, 0);

  rpcClient.emitEvent({ type: "agent_settled" });
  const retried = finalEnvelope(
    current.task_id,
    NEXT_TURN_ID,
    "77777777-7777-4777-8777-777777777777",
  );
  assert.equal(supervisor.acceptChildReply(retried, () => {
    deliveries += 1;
    return true;
  }), true);
  assert.equal(deliveries, 1);
  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "idle");
    assert.equal(status.data.last_task?.turn_id, NEXT_TURN_ID);
  }
});

test("同任务 settled 后保留 prompt assignment，但物理提交使用 adaptive steer", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "原生压缩后续消息" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  const current = await supervisor.prompt("进入原生自动压缩任务");
  assert.equal(current.ok, true);
  if (!current.ok) return;
  await new Promise<void>((resolve) => setImmediate(resolve));
  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: current.task_id, turn_id: TURN_ID });

  rpcClient.emitEvent({ type: "agent_end", messages: [], willRetry: false });
  rpcClient.emitEvent({ type: "compaction_start", reason: "threshold" });
  const queued = await supervisor.steer("压缩完成后继续处理");
  assert.equal(queued.ok, true);
  if (!queued.ok) return;
  assert.equal(queued.task_id, current.task_id);
  rpcClient.emitEvent({
    type: "compaction_end",
    reason: "threshold",
    aborted: false,
    willRetry: false,
    failed: false,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(rpcClient.operations().filter((operation) => operation === "prompt").length, 1);
  assert.equal(rpcClient.operations().filter((operation) => operation === "steer").length, 0);

  rpcClient.emitEvent({ type: "agent_settled" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(rpcClient.operations().filter((operation) => operation === "prompt").length, 1);
  assert.equal(rpcClient.operations().filter((operation) => operation === "steer").length, 1);
  const assignment = channel.publishedTaskAssignments().at(-1);
  assert.deepEqual(assignment === undefined ? undefined : {
    task_id: assignment.task_id,
    mode: assignment.mode,
  }, {
    task_id: current.task_id,
    mode: "prompt",
  });
  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "working");
    assert.equal(status.data.mailbox_pending_count, 0);
    assert.equal(status.data.activity?.phase, "reconciling");
    assert.equal(status.data.activity?.task_id, current.task_id);
  }
});

test("prompt、raw settled 与父端 final 接纳按双条件提交后才进入 idle", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const managedNode = new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter());
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "settle 竞态" },
    managedNode,
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  const promptGate = rpcClient.deferNext("prompt");

  const delivery = await supervisor.prompt("finish immediately");
  assert.equal(delivery.ok, true);
  if (!delivery.ok) return;
  await promptGate.started;
  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: delivery.task_id, turn_id: TURN_ID });
  let status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "working");
    assert.equal(status.data.mailbox_pending_count, 1);
  }

  promptGate.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  rpcClient.emitEvent({ type: "agent_settled" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "working");
    assert.equal(status.data.activity?.phase, "finalizing");
    assert.equal(status.data.reply_outbox_pending_count, 1);
  }

  assert.equal(supervisor.acceptChildReply(finalEnvelope(delivery.task_id), () => true), true);
  status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "idle");
    assert.equal(status.data.mailbox_pending_count, 0);
    assert.equal(status.data.last_task?.commit_id, COMMIT_ID);
  }
});

test("final 注入事务先于回调内压缩事实提交且不重复 final", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "final 两阶段提交" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  const submission = await supervisor.prompt("完成后触发父会话压缩");
  assert.equal(submission.ok, true);
  if (!submission.ok) return;
  await new Promise<void>((resolve) => setImmediate(resolve));
  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: submission.task_id, turn_id: TURN_ID });
  rpcClient.emitEvent({ type: "agent_settled" });

  const sent: unknown[] = [];
  const inbox = new ParentReplyInbox({
    readApi: () => ({ sendMessage: (message) => sent.push(message) }),
    notifyMessage: () => {},
  });
  const final = finalEnvelope(submission.task_id);
  assert.equal(supervisor.acceptChildReply(final, () => {
    const accepted = inbox.accept(FIRST_AGENT_ID, final);
    rpcClient.emitEvent({ type: "compaction_start", reason: "manual" });
    return accepted;
  }), true);
  assert.equal(sent.length, 1);

  let status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "working");
    assert.equal(status.data.activity?.phase, "compacting");
    assert.equal(status.data.reply_outbox_pending_count, 0);
    assert.equal(status.data.last_task?.commit_id, COMMIT_ID);
  }

  rpcClient.emitEvent({
    type: "compaction_end",
    reason: "manual",
    aborted: false,
    willRetry: false,
    failed: false,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "idle");
    assert.equal(status.data.last_task?.commit_id, COMMIT_ID);
  }
});

test("Pi 命令结果不确定时暂停当前投递且不重投递正文", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const managedNode = new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter());
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "接纳失败竞态" },
    managedNode,
    channel: new RecordingSupervisorChannel([]),
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  const promptGate = rpcClient.deferNext("prompt");

  const delivery = supervisor.prompt("与后代唤醒竞争");
  await promptGate.started;
  rpcClient.emitEvent({ type: "agent_start" });
  promptGate.reject();

  assert.equal((await delivery).ok, true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  let status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "suspended");
    assert.equal(status.data.activity?.phase, "delivery_uncertain");
    assert.equal(status.data.mailbox_pending_count, 0);
  }
  assert.deepEqual(await supervisor.interrupt(), {
    ok: true,
    accepted: false,
    changed: false,
  });
  rpcClient.emitEvent({ type: "agent_settled" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "suspended");
    assert.equal(status.data.reply_outbox_pending_count, 0);
  }
  await supervisor.terminate();
});

test("Pi 命令结果不确定时允许迟到 task_started 对账恢复任务", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "交付不确定对账" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  const promptGate = rpcClient.deferNext("prompt");
  const submission = await supervisor.prompt("可能已进入 Pi 的任务");
  assert.equal(submission.ok, true);
  if (!submission.ok) return;
  await promptGate.started;

  rpcClient.emitEvent({ type: "agent_start" });
  promptGate.reject();
  await new Promise<void>((resolve) => setImmediate(resolve));
  let status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "suspended");
    assert.equal(status.data.activity?.phase, "delivery_uncertain");
  }

  channel.emitTaskStarted({ task_id: submission.task_id, turn_id: TURN_ID });
  status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) assert.equal(status.data.state, "working");
  assert.equal(rpcClient.operations().filter((operation) => operation === "prompt").length, 1);

  rpcClient.emitEvent({ type: "agent_settled" });
  assert.equal(supervisor.acceptChildReply(finalEnvelope(submission.task_id), () => true), true);
  status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) assert.equal(status.data.state, "idle");
  await supervisor.terminate();
});

test("迟到 task_started 对账后必须重新唤醒后续 mailbox 投递", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "迟到启动唤醒" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);

  const firstGate = rpcClient.deferNext("prompt");
  const first = await supervisor.prompt("首条正文");
  assert.equal(first.ok, true);
  if (!first.ok) return;
  await firstGate.started;
  rpcClient.emitEvent({ type: "agent_start" });
  firstGate.reject();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  const second = await supervisor.steer("后续 steering");
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(rpcClient.operations().filter((operation) => operation === "steer").length, 0);

  channel.emitTaskStarted({ task_id: first.task_id, turn_id: TURN_ID });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(rpcClient.operations().filter((operation) => operation === "steer").length, 1);
  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "working");
    assert.equal(status.data.mailbox_pending_count, 0);
    assert.equal(status.data.activity?.task_id, first.task_id);
  }
  await supervisor.terminate();
});

test("迟到 steer 入队事实恢复节点并唤醒后续 mailbox", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "迟到队列事实恢复" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);

  const current = await supervisor.prompt("先进入工作态");
  assert.equal(current.ok, true);
  if (!current.ok) return;
  await new Promise<void>((resolve) => setImmediate(resolve));
  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: current.task_id, turn_id: TURN_ID });

  const uncertainGate = rpcClient.deferNext("steer");
  const uncertain = await supervisor.steer("响应丢失但已经入队");
  assert.equal(uncertain.ok, true);
  await uncertainGate.started;
  uncertainGate.reject();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const suspended = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(suspended.ok, true);
  if (suspended.ok) assert.equal(suspended.data.state, "suspended");

  const later = await supervisor.steer("恢复后继续投递");
  assert.equal(later.ok, true);
  assert.equal(rpcClient.operations().filter((operation) => operation === "steer").length, 1);

  rpcClient.emitEvent({ type: "queue_update", pendingMessageCount: 1 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(rpcClient.operations().filter((operation) => operation === "steer").length, 2);
  const recovered = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(recovered.ok, true);
  if (recovered.ok) {
    assert.equal(recovered.data.state, "working");
    assert.equal(recovered.data.mailbox_pending_count, 0);
    assert.equal(recovered.data.host_pending_count, 1);
  }

  rpcClient.emitEvent({ type: "queue_update", pendingMessageCount: 0 });
  const drained = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(drained.ok, true);
  if (drained.ok) assert.equal(drained.data.state, "working");
  await supervisor.terminate();
});

test("命令尾部不确定时暂停节点并保留真实运行时", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "命令尾竞态" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel: new RecordingSupervisorChannel([]),
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  const promptGate = rpcClient.deferNext("prompt");

  const delivery = supervisor.prompt("接纳失败后自主唤醒");
  await promptGate.started;
  const startAfterResult = delivery.then(() => {
    rpcClient.emitEvent({ type: "agent_start" });
  });
  promptGate.reject();
  assert.equal((await delivery).ok, true);
  await startAfterResult;
  await new Promise<void>((resolve) => setImmediate(resolve));

  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "suspended");
    assert.equal(status.data.activity?.phase, "delivery_uncertain");
  }
  await supervisor.terminate();
});

test("命令结果不确定时不伪造 host pending 且不失败运行节点", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "接纳窗口多轮竞态" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel: new RecordingSupervisorChannel([]),
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  const promptGate = rpcClient.deferNext("prompt");

  const delivery = supervisor.prompt("与多轮自主唤醒竞争");
  await promptGate.started;
  rpcClient.emitEvent({ type: "agent_start" });
  rpcClient.emitEvent({ type: "agent_settled" });
  rpcClient.emitEvent({ type: "agent_start" });
  promptGate.reject();

  assert.equal((await delivery).ok, true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "suspended");
    assert.equal(status.data.activity?.phase, "delivery_uncertain");
    assert.equal(status.data.host_pending_count, 0);
  }
  await supervisor.terminate();
});

test("steer 成功响应不被期间到达的旧 settled 降级", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "接纳窗口探针" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  const current = await supervisor.prompt("先进入工作态");
  assert.equal(current.ok, true);
  if (!current.ok) return;
  await new Promise<void>((resolve) => setImmediate(resolve));
  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: current.task_id, turn_id: TURN_ID });
  const steerGate = rpcClient.deferNext("steer");

  const delivery = supervisor.steer("与 settled 竞争");
  await steerGate.started;
  rpcClient.emitEvent({ type: "agent_settled" });
  steerGate.resolve();
  assert.equal((await delivery).ok, true);
  await new Promise<void>((resolve) => setImmediate(resolve));

  let status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "working");
    assert.equal(status.data.activity?.phase, "processing");
    assert.equal(status.data.host_pending_count, 0);
  }
  rpcClient.emitEvent({ type: "agent_start" });
  status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) assert.equal(status.data.state, "working");
  await supervisor.terminate();
});

test("adaptive 入队响应先于旧 settled 时保留已接纳的宿主 pending", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "入队响应后旧 settled" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  const current = await supervisor.prompt("先进入工作态");
  assert.equal(current.ok, true);
  if (!current.ok) return;
  await new Promise<void>((resolve) => setImmediate(resolve));
  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: current.task_id, turn_id: TURN_ID });

  const steerGate = rpcClient.deferNext("steer");
  const queued = await supervisor.steer("先入队后收到旧 settled");
  assert.equal(queued.ok, true);
  if (!queued.ok) return;
  await steerGate.started;
  rpcClient.emitEvent({ type: "queue_update", pendingMessageCount: 1 });
  steerGate.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  rpcClient.emitEvent({ type: "agent_settled" });

  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "working");
    assert.equal(status.data.activity?.phase, "reconciling");
    assert.equal(status.data.mailbox_pending_count, 0);
    assert.equal(status.data.host_pending_count, 1);
  }
  await supervisor.terminate();
});

test("明确拒绝的 adaptive steer 不跨模式重投正文", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "明确拒绝恢复" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  const current = await supervisor.prompt("先进入工作态");
  assert.equal(current.ok, true);
  if (!current.ok) return;
  await new Promise<void>((resolve) => setImmediate(resolve));
  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: current.task_id, turn_id: TURN_ID });

  const rejectedSteer = rpcClient.deferNext("steer");
  const queued = await supervisor.steer("只允许投递一次的正文");
  assert.equal(queued.ok, true);
  if (!queued.ok) return;
  await rejectedSteer.started;
  rejectedSteer.reject(new ManagedRpcCommandRejectedError());
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(rpcClient.operations().filter((operation) => operation === "steer").length, 1);
  assert.equal(rpcClient.operations().filter((operation) => operation === "prompt").length, 1);
  assert.deepEqual(channel.publishedTaskAssignments().slice(-1), [
    { message_id: queued.message_id, task_id: current.task_id, mode: "steer" },
  ]);
  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "suspended");
    assert.equal(status.data.activity?.phase, "delivery_uncertain");
    assert.equal(status.data.mailbox_pending_count, 1);
  }
  await supervisor.terminate();
});

test("strict prompt 遇到 host_busy 后等待真实 settled 并以同一身份重试", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "宿主忙碌重试" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  const getStateBeforeRejection = rpcClient.operations()
    .filter((operation) => operation === "get_state").length;

  const rejectedPrompt = rpcClient.deferNext("prompt");
  const submission = await supervisor.prompt("只在宿主空闲后启动的新任务");
  assert.equal(submission.ok, true);
  if (!submission.ok) return;
  await rejectedPrompt.started;
  rpcClient.setState({ isStreaming: true, isCompacting: false, pendingMessageCount: 0 });
  rejectedPrompt.reject(new ManagedRpcCommandRejectedError("host_busy"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(rpcClient.operations().filter((operation) => operation === "prompt").length, 1);
  assert.equal(
    rpcClient.operations().filter((operation) => operation === "get_state").length,
    getStateBeforeRejection + 1,
  );
  let status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "working");
    assert.equal(status.data.activity?.phase, "reconciling");
    assert.equal(status.data.mailbox_pending_count, 1);
  }

  const retriedPrompt = rpcClient.deferNext("prompt");
  rpcClient.setState({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
  rpcClient.emitEvent({ type: "agent_settled" });
  await retriedPrompt.started;
  assert.deepEqual(channel.publishedTaskAssignments().slice(-2), [
    { message_id: submission.message_id, task_id: submission.task_id, mode: "prompt" },
    { message_id: submission.message_id, task_id: submission.task_id, mode: "prompt" },
  ]);
  retriedPrompt.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: submission.task_id, turn_id: TURN_ID });
  await new Promise<void>((resolve) => setImmediate(resolve));

  status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "working");
    assert.notEqual(status.data.activity?.phase, "delivery_uncertain");
    assert.equal(status.data.mailbox_pending_count, 0);
  }
  await supervisor.terminate();
});

test("adaptive steer 遇到 compaction_active 后等待 settled 并保持同一身份重试", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "adaptive 压缩拒绝" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  const current = await supervisor.prompt("先进入工作态");
  assert.equal(current.ok, true);
  if (!current.ok) return;
  await new Promise<void>((resolve) => setImmediate(resolve));
  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: current.task_id, turn_id: TURN_ID });

  const rejectedAdaptive = rpcClient.deferNext("steer");
  const queued = await supervisor.steer("压缩竞争中的同任务正文");
  assert.equal(queued.ok, true);
  if (!queued.ok) return;
  await rejectedAdaptive.started;
  rpcClient.setState({ isStreaming: false, isCompacting: true, pendingMessageCount: 0 });
  rpcClient.emitEvent({ type: "compaction_start", reason: "threshold" });
  rejectedAdaptive.reject(new ManagedRpcCommandRejectedError("compaction_active"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  let status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "working");
    assert.equal(status.data.activity?.phase, "compacting");
    assert.equal(status.data.mailbox_pending_count, 1);
  }
  assert.equal(rpcClient.operations().filter((operation) => operation === "steer").length, 1);
  assert.equal(rpcClient.operations().filter((operation) => operation === "prompt").length, 1);

  const retriedAdaptive = rpcClient.deferNext("steer");
  rpcClient.setState({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
  rpcClient.emitEvent({
    type: "compaction_end",
    reason: "threshold",
    aborted: false,
    willRetry: false,
    failed: false,
  });
  rpcClient.emitEvent({ type: "agent_settled" });
  await retriedAdaptive.started;
  assert.deepEqual(channel.publishedTaskAssignments().slice(-2), [
    { message_id: queued.message_id, task_id: current.task_id, mode: "steer" },
    { message_id: queued.message_id, task_id: current.task_id, mode: "prompt" },
  ]);
  retriedAdaptive.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: current.task_id, turn_id: NEXT_TURN_ID });

  status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.mailbox_pending_count, 0);
    assert.notEqual(status.data.activity?.phase, "delivery_uncertain");
  }
  await supervisor.terminate();
});

test("压缩期明确拒绝的 prompt 等待物理压缩和 settled 后以相同身份重试一次", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "压缩拒绝延迟重试" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  const getStateBeforeRejection = rpcClient.operations()
    .filter((operation) => operation === "get_state").length;

  const rejectedPrompt = rpcClient.deferNext("prompt");
  const submission = await supervisor.prompt("压缩竞争正文");
  assert.equal(submission.ok, true);
  if (!submission.ok) return;
  await rejectedPrompt.started;
  rpcClient.setState({ isStreaming: false, isCompacting: true, pendingMessageCount: 0 });
  rpcClient.emitEvent({ type: "compaction_start", reason: "threshold" });
  rejectedPrompt.reject(new ManagedRpcCommandRejectedError("compaction_active"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(rpcClient.operations().filter((operation) => operation === "prompt").length, 1);
  assert.equal(
    rpcClient.operations().filter((operation) => operation === "get_state").length,
    getStateBeforeRejection + 1,
  );
  let status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "working");
    assert.equal(status.data.activity?.phase, "compacting");
    assert.equal(status.data.mailbox_pending_count, 1);
  }

  const retriedPrompt = rpcClient.deferNext("prompt");
  rpcClient.setState({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
  rpcClient.emitEvent({
    type: "compaction_end",
    reason: "threshold",
    aborted: false,
    willRetry: false,
    failed: false,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(rpcClient.operations().filter((operation) => operation === "prompt").length, 1);

  rpcClient.emitEvent({ type: "agent_settled" });
  await retriedPrompt.started;
  assert.deepEqual(channel.publishedTaskAssignments().slice(-2), [
    { message_id: submission.message_id, task_id: submission.task_id, mode: "prompt" },
    { message_id: submission.message_id, task_id: submission.task_id, mode: "prompt" },
  ]);
  retriedPrompt.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) assert.notEqual(status.data.activity?.phase, "delivery_uncertain");
  await supervisor.terminate();
});

test("压缩状态探针连续失配时最多立即重试一次，随后等待真实生命周期", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "压缩拒绝防忙等" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  const getStateCount = rpcClient.operations().filter((operation) => operation === "get_state").length;
  rpcClient.setState({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });

  const first = rpcClient.deferNext("prompt");
  const submission = await supervisor.prompt("不得形成即时拒绝循环");
  assert.equal(submission.ok, true);
  await first.started;
  const second = rpcClient.deferNext("prompt");
  first.reject(new ManagedRpcCommandRejectedError("compaction_active"));
  await second.started;
  second.reject(new ManagedRpcCommandRejectedError("compaction_active"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(rpcClient.operations().filter((operation) => operation === "prompt").length, 2);
  assert.equal(
    rpcClient.operations().filter((operation) => operation === "get_state").length,
    getStateCount + 1,
  );
  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "working");
    assert.equal(status.data.activity?.phase, "compacting");
    assert.equal(status.data.mailbox_pending_count, 1);
  }
  await supervisor.terminate();
});

test("未分类的明确 prompt 拒绝仍保持 delivery uncertainty 且不自动重发", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "普通 prompt 拒绝" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  const getStateCount = rpcClient.operations().filter((operation) => operation === "get_state").length;

  const rejected = rpcClient.deferNext("prompt");
  const submission = await supervisor.prompt("普通拒绝不得盲目重试");
  assert.equal(submission.ok, true);
  await rejected.started;
  rejected.reject(new ManagedRpcCommandRejectedError());
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(rpcClient.operations().filter((operation) => operation === "prompt").length, 1);
  assert.equal(
    rpcClient.operations().filter((operation) => operation === "get_state").length,
    getStateCount,
  );
  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "suspended");
    assert.equal(status.data.activity?.phase, "delivery_uncertain");
  }
  await supervisor.terminate();
});

test("native continuation 先于压缩拒绝响应启动时，被拒正文只以 steer 投入续跑轮", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "迟到压缩拒绝" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);

  const rejectedPrompt = rpcClient.deferNext("prompt");
  const submission = await supervisor.prompt("续跑后仍需送达");
  assert.equal(submission.ok, true);
  if (!submission.ok) return;
  await rejectedPrompt.started;
  rpcClient.emitEvent({ type: "compaction_start", reason: "overflow" });
  rpcClient.emitEvent({
    type: "compaction_end",
    reason: "overflow",
    aborted: false,
    willRetry: true,
    failed: false,
  });
  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: submission.task_id, turn_id: TURN_ID });
  rpcClient.setState({ isStreaming: true, isCompacting: false, pendingMessageCount: 0 });

  const steered = rpcClient.deferNext("steer");
  rejectedPrompt.reject(new ManagedRpcCommandRejectedError("compaction_active"));
  await steered.started;
  assert.deepEqual(channel.publishedTaskAssignments().slice(-2), [
    { message_id: submission.message_id, task_id: submission.task_id, mode: "prompt" },
    { message_id: submission.message_id, task_id: submission.task_id, mode: "steer" },
  ]);
  assert.equal(rpcClient.operations().filter((operation) => operation === "prompt").length, 1);
  assert.equal(rpcClient.operations().filter((operation) => operation === "steer").length, 1);
  steered.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "working");
    assert.equal(status.data.mailbox_pending_count, 0);
  }
  await supervisor.terminate();
});

test("压缩期间中断返回可重试提示，压缩结束后仍可正常中断", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "压缩中断提示" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  const events: RpcSupervisorEvent[] = [];
  supervisor.onEvent((event) => events.push(event));
  assert.equal((await supervisor.start()).ok, true);
  const task = await supervisor.prompt("进入压缩状态");
  assert.equal(task.ok, true);
  if (!task.ok) return;
  await new Promise<void>((resolve) => setImmediate(resolve));
  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: task.task_id, turn_id: TURN_ID });
  rpcClient.emitEvent({ type: "compaction_start", reason: "threshold" });

  assert.deepEqual(await supervisor.interrupt(), {
    ok: true,
    accepted: true,
    changed: false,
    blocked_reason: "compaction_active",
  });
  assert.equal(rpcClient.operations().includes("abort"), false);
  assert.equal(events.some((event) => event.kind === "fault"), false);
  const workingStatus = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(workingStatus.ok, true);
  if (workingStatus.ok) assert.equal(workingStatus.data.state, "working");

  rpcClient.emitEvent({
    type: "compaction_end",
    reason: "threshold",
    aborted: false,
    willRetry: false,
    failed: false,
  });
  assert.deepEqual(await supervisor.interrupt(), {
    ok: true,
    accepted: true,
    changed: true,
  });
  assert.equal(rpcClient.operations().includes("abort"), true);
  const termination = await supervisor.terminate();
  assert.equal(termination.ok, true);
});

test("中断缺失 settled/final 时在隔离期限后回收节点", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "中断收敛期限" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
    interruptTimeoutMs: 10,
  });
  assert.equal((await supervisor.start()).ok, true);
  const task = await supervisor.prompt("等待中断收敛");
  assert.equal(task.ok, true);
  if (!task.ok) return;
  await new Promise<void>((resolve) => setImmediate(resolve));
  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: task.task_id, turn_id: TURN_ID });

  const isolated = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("中断隔离未收敛")), 250);
    const unsubscribe = supervisor.onEvent((event) => {
      if (event.kind !== "fault" || event.code !== "message_delivery_failed") return;
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    });
  });
  assert.deepEqual(await supervisor.interrupt(), {
    ok: true,
    accepted: true,
    changed: true,
  });
  await isolated;
  assert.equal((await supervisor.terminate()).ok, true);

  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "terminated");
    assert.equal(status.data.termination_result, "failed");
  }
});

test("interrupt 栅栏后的消息属于后继任务，并在当前 final commit 后才 prompt", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "中断后新轮" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  const current = await supervisor.prompt("进入工作态");
  assert.equal(current.ok, true);
  if (!current.ok) return;
  await new Promise<void>((resolve) => setImmediate(resolve));
  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: current.task_id, turn_id: TURN_ID });

  assert.deepEqual(await supervisor.interrupt(), {
    ok: true,
    accepted: true,
    changed: true,
  });
  const successor = await supervisor.steer("中断后排队的新任务");
  assert.equal(successor.ok, true);
  if (!successor.ok) return;
  assert.notEqual(successor.task_id, current.task_id);
  assert.equal(rpcClient.operations().filter((operation) => operation === "prompt").length, 1);

  const successorPrompt = rpcClient.deferNext("prompt");
  rpcClient.emitEvent({ type: "agent_settled" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const interruptedFinal = Object.freeze({
    ...finalEnvelope(current.task_id),
    run_state: "interrupted" as const,
  });
  assert.equal(supervisor.acceptChildReply(interruptedFinal, () => true), true);
  await successorPrompt.started;
  successorPrompt.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));

  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "working");
    assert.equal(status.data.activity?.task_id, successor.task_id);
    assert.equal(status.data.last_task?.outcome, "interrupted");
  }
});

test("无祖先命令的 agent_start 立即公开自主工作态并允许中断", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const managedNode = new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter());
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "自主唤醒" },
    managedNode,
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);

  rpcClient.emitEvent({ type: "agent_start", prompt: "不得进入生命周期" });
  channel.emitTaskStarted({ task_id: AUTONOMOUS_TASK_ID, turn_id: TURN_ID });
  let status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "working");
    assert.equal(status.data.mailbox_pending_count, 0);
  }
  assert.deepEqual(await supervisor.interrupt(), {
    ok: true,
    accepted: true,
    changed: true,
  });
  assert.equal(rpcClient.operations().at(-1), "abort");

  rpcClient.emitEvent({ type: "agent_settled" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) assert.equal(status.data.activity?.phase, "finalizing");
  assert.equal(supervisor.acceptChildReply(Object.freeze({
    ...finalEnvelope(AUTONOMOUS_TASK_ID),
    run_state: "interrupted" as const,
  }), () => true), true);
  status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) assert.equal(status.data.state, "idle");
});

test("agent_settled 直接建立 provisional final 且不读取宿主状态", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "真实 settled" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: AUTONOMOUS_TASK_ID, turn_id: TURN_ID });
  const stateReadsBeforeSettlement = rpcClient.operations().filter((operation) => operation === "get_state").length;

  rpcClient.emitEvent({ type: "agent_settled" });
  await new Promise<void>((resolve) => setImmediate(resolve));

  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "working");
    assert.equal(status.data.activity?.phase, "finalizing");
    assert.equal(status.data.reply_outbox_pending_count, 1);
  }
  assert.equal(
    rpcClient.operations().filter((operation) => operation === "get_state").length,
    stateReadsBeforeSettlement,
  );
});

test("provisional final 后的新 task_started 撤销旧 turn 候选", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "后继真实轮次" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: AUTONOMOUS_TASK_ID, turn_id: TURN_ID });
  rpcClient.emitEvent({ type: "agent_settled" });
  await new Promise<void>((resolve) => setImmediate(resolve));

  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: AUTONOMOUS_TASK_ID, turn_id: NEXT_TURN_ID });
  let delivered = false;
  assert.equal(supervisor.acceptChildReply(finalEnvelope(AUTONOMOUS_TASK_ID), () => {
    delivered = true;
    return true;
  }), true);

  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "working");
    assert.equal(status.data.activity?.phase, "processing");
    assert.equal(status.data.reply_outbox_pending_count, 0);
  }
  assert.equal(delivered, false);
});

test("重复 agent_settled 保持同一 provisional candidate 且不额外读取状态", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "重复 settled" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: AUTONOMOUS_TASK_ID, turn_id: TURN_ID });
  const stateReadsBeforeSettlement = rpcClient.operations().filter((operation) => operation === "get_state").length;

  rpcClient.emitEvent({ type: "agent_settled" });
  rpcClient.emitEvent({ type: "agent_settled" });
  await new Promise<void>((resolve) => setImmediate(resolve));

  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.activity?.phase, "finalizing");
    assert.equal(status.data.reply_outbox_pending_count, 1);
  }
  assert.equal(
    rpcClient.operations().filter((operation) => operation === "get_state").length,
    stateReadsBeforeSettlement,
  );
});

test("final 注入回调中的 continuation 在当前 final commit 后重放", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "final 重入 continuation" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: AUTONOMOUS_TASK_ID, turn_id: TURN_ID });
  rpcClient.emitEvent({ type: "agent_settled" });
  await new Promise<void>((resolve) => setImmediate(resolve));

  const accepted = supervisor.acceptChildReply(finalEnvelope(AUTONOMOUS_TASK_ID), () => {
    rpcClient.emitEvent({ type: "agent_start" });
    channel.emitTaskStarted({ task_id: AUTONOMOUS_TASK_ID, turn_id: NEXT_TURN_ID });
    return true;
  });
  assert.equal(accepted, true);

  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "working");
    assert.equal(status.data.activity?.task_id, AUTONOMOUS_TASK_ID);
    assert.equal(status.data.last_task?.commit_id, COMMIT_ID);
    assert.equal(status.data.last_task?.turn_id, TURN_ID);
  }
});

test("final 注入回调中的压缩取消在 commit 后重放且不丢 final", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "final 重入压缩取消" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: AUTONOMOUS_TASK_ID, turn_id: TURN_ID });
  rpcClient.emitEvent({ type: "agent_settled" });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(supervisor.acceptChildReply(finalEnvelope(AUTONOMOUS_TASK_ID), () => {
    rpcClient.emitEvent({ type: "compaction_start", reason: "manual" });
    rpcClient.emitEvent({
      type: "compaction_end",
      reason: "manual",
      aborted: true,
      willRetry: false,
      failed: false,
    });
    return true;
  }), true);

  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "idle");
    assert.equal(status.data.activity, undefined);
    assert.equal(status.data.last_task?.commit_id, COMMIT_ID);
  }
});

test("final 注入失败时回调内消息在结果确定后仍归当前任务", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "final 重入消息" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: AUTONOMOUS_TASK_ID, turn_id: TURN_ID });
  rpcClient.emitEvent({ type: "agent_settled" });
  await new Promise<void>((resolve) => setImmediate(resolve));

  let reentrantMessage: ReturnType<RpcSupervisor["steer"]> | undefined;
  assert.equal(supervisor.acceptChildReply(finalEnvelope(AUTONOMOUS_TASK_ID), () => {
    reentrantMessage = supervisor.steer("final 未接纳时继续当前任务");
    return false;
  }), false);
  assert.ok(reentrantMessage);
  const resumed = await reentrantMessage;
  assert.equal(resumed.ok, true);
  if (resumed.ok) assert.equal(resumed.task_id, AUTONOMOUS_TASK_ID);
});

test("final 注入抛错后同一 commit 可以重试并提交", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "final 注入重试" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: AUTONOMOUS_TASK_ID, turn_id: TURN_ID });
  rpcClient.emitEvent({ type: "agent_settled" });
  await new Promise<void>((resolve) => setImmediate(resolve));

  const candidate = finalEnvelope(AUTONOMOUS_TASK_ID);
  let attempts = 0;
  assert.equal(supervisor.acceptChildReply(candidate, () => {
    attempts += 1;
    throw new Error("parent inbox unavailable");
  }), false);
  assert.equal(supervisor.acceptChildReply(candidate, () => {
    attempts += 1;
    return true;
  }), true);
  assert.equal(attempts, 2);

  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "idle");
    assert.equal(status.data.last_task?.commit_id, COMMIT_ID);
  }
});

test("final 注入成功时回调内消息在 commit 后建立新任务", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "final 重入后继消息" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: AUTONOMOUS_TASK_ID, turn_id: TURN_ID });
  rpcClient.emitEvent({ type: "agent_settled" });
  await new Promise<void>((resolve) => setImmediate(resolve));

  const promptGate = rpcClient.deferNext("prompt");
  let reentrantMessage: ReturnType<RpcSupervisor["steer"]> | undefined;
  assert.equal(supervisor.acceptChildReply(finalEnvelope(AUTONOMOUS_TASK_ID), () => {
    reentrantMessage = supervisor.steer("final 接纳后开始下一任务");
    return true;
  }), true);
  assert.ok(reentrantMessage);
  const successor = await reentrantMessage;
  assert.equal(successor.ok, true);
  if (!successor.ok) return;
  assert.notEqual(successor.task_id, AUTONOMOUS_TASK_ID);

  await promptGate.started;
  assert.deepEqual(channel.publishedTaskAssignments().at(-1), {
    message_id: successor.message_id,
    task_id: successor.task_id,
    mode: "prompt",
  });
  promptGate.resolve();
});

test("final 注入回调中的 interrupt 在 commit 后重新裁决", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "final 重入中断" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: AUTONOMOUS_TASK_ID, turn_id: TURN_ID });
  rpcClient.emitEvent({ type: "agent_settled" });
  await new Promise<void>((resolve) => setImmediate(resolve));

  let reentrantInterrupt: ReturnType<RpcSupervisor["interrupt"]> | undefined;
  assert.equal(supervisor.acceptChildReply(finalEnvelope(AUTONOMOUS_TASK_ID), () => {
    reentrantInterrupt = supervisor.interrupt();
    return true;
  }), true);
  assert.ok(reentrantInterrupt);
  assert.deepEqual(await reentrantInterrupt, {
    ok: true,
    accepted: false,
    changed: false,
  });
  assert.equal(rpcClient.operations().includes("abort"), false);

  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "idle");
    assert.equal(status.data.last_task?.commit_id, COMMIT_ID);
  }
});

test("父端未接纳 final 后以 adaptive steer 恢复当前任务并作废旧 turn final", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "raw settled 后恢复" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: AUTONOMOUS_TASK_ID, turn_id: TURN_ID });
  rpcClient.emitEvent({ type: "agent_settled" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const unacceptedFinal = finalEnvelope(AUTONOMOUS_TASK_ID);
  let finalDeliveryAttempts = 0;
  assert.equal(supervisor.acceptChildReply(unacceptedFinal, () => {
    finalDeliveryAttempts += 1;
    return false;
  }), false);
  assert.equal(finalDeliveryAttempts, 1);

  const adaptiveGate = rpcClient.deferNext("steer");
  const resumed = await supervisor.steer("final 未接纳时继续当前任务");
  assert.equal(resumed.ok, true);
  if (!resumed.ok) return;
  assert.equal(resumed.task_id, AUTONOMOUS_TASK_ID);
  await adaptiveGate.started;
  assert.equal(channel.publishedTaskAssignments().at(-1)?.mode, "prompt");

  let status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.activity?.phase, "reconciling");
    assert.equal(status.data.mailbox_pending_count, 1);
  }

  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: AUTONOMOUS_TASK_ID, turn_id: NEXT_TURN_ID });
  adaptiveGate.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  let oldFinalDelivered = false;
  assert.equal(supervisor.acceptChildReply(finalEnvelope(AUTONOMOUS_TASK_ID), () => {
    oldFinalDelivered = true;
    return true;
  }), true);
  assert.equal(oldFinalDelivered, false);

  rpcClient.emitEvent({ type: "agent_settled" });
  const nextCommitId = "77777777-7777-4777-8777-777777777777";
  assert.equal(supervisor.acceptChildReply(
    finalEnvelope(AUTONOMOUS_TASK_ID, NEXT_TURN_ID, nextCommitId),
    () => true,
  ), true);
  status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) assert.equal(status.data.state, "idle");
});

test("父端已接纳 final 后的消息保持 successor 并在本地 commit 后 prompt", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "final 后 successor" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: AUTONOMOUS_TASK_ID, turn_id: TURN_ID });
  rpcClient.emitEvent({ type: "agent_settled" });
  await new Promise<void>((resolve) => setImmediate(resolve));

  const prepared = finalEnvelope(AUTONOMOUS_TASK_ID);
  let finalDeliveries = 0;
  assert.equal(supervisor.acceptChildReply(prepared, () => {
    finalDeliveries += 1;
    rpcClient.emitEvent({ type: "compaction_start", reason: "manual" });
    return true;
  }), true);
  assert.equal(finalDeliveries, 1);
  const successor = await supervisor.steer("final 已接纳后的任务");
  assert.equal(successor.ok, true);
  if (!successor.ok) return;
  assert.notEqual(successor.task_id, AUTONOMOUS_TASK_ID);

  let status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.activity?.phase, "compacting");
    assert.equal(status.data.mailbox_pending_count, 1);
    assert.equal(status.data.reply_outbox_pending_count, 0);
  }

  const promptGate = rpcClient.deferNext("prompt");
  rpcClient.emitEvent({
    type: "compaction_end",
    reason: "manual",
    aborted: false,
    willRetry: false,
    failed: false,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(finalDeliveries, 1);
  await promptGate.started;
  promptGate.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(rpcClient.operations().at(-1), "prompt");
  status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) assert.equal(status.data.activity?.task_id, successor.task_id);
});

test("raw settled sibling 与 working sibling 的进度消息都独立进入当前任务", async () => {
  const tree = createController();
  const firstRpc = new FakeRpcClient();
  const secondRpc = new FakeRpcClient();
  const firstChannel = new RecordingSupervisorChannel([]);
  const secondChannel = new RecordingSupervisorChannel([]);
  const secondTaskId = "88888888-8888-4888-8888-888888888888";
  const first = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "raw settled sibling" },
    managedNode: new TestManagedRpcNode(firstRpc, new FakeProcessTreeAdapter()),
    channel: firstChannel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  const second = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "working sibling" },
    managedNode: new TestManagedRpcNode(secondRpc, new FakeProcessTreeAdapter()),
    channel: secondChannel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await first.start()).ok, true);
  assert.equal((await second.start()).ok, true);

  firstRpc.emitEvent({ type: "agent_start" });
  firstChannel.emitTaskStarted({ task_id: AUTONOMOUS_TASK_ID, turn_id: TURN_ID });
  secondRpc.emitEvent({ type: "agent_start" });
  secondChannel.emitTaskStarted({ task_id: secondTaskId, turn_id: TURN_ID });
  firstRpc.emitEvent({ type: "agent_settled" });
  await new Promise<void>((resolve) => setImmediate(resolve));

  const firstAdaptive = firstRpc.deferNext("steer");
  const secondSteer = secondRpc.deferNext("steer");
  const firstProgress = await first.steer("first progress");
  const secondProgress = await second.steer("second progress");
  assert.equal(firstProgress.ok, true);
  assert.equal(secondProgress.ok, true);
  if (!firstProgress.ok || !secondProgress.ok) return;
  assert.equal(firstProgress.task_id, AUTONOMOUS_TASK_ID);
  assert.equal(secondProgress.task_id, secondTaskId);

  await Promise.all([firstAdaptive.started, secondSteer.started]);
  firstAdaptive.resolve();
  secondSteer.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(firstRpc.operations().at(-1), "steer");
  assert.equal(secondRpc.operations().at(-1), "steer");
  assert.deepEqual(firstChannel.publishedTaskAssignments().at(-1), {
    message_id: firstProgress.message_id,
    task_id: AUTONOMOUS_TASK_ID,
    mode: "prompt",
  });
  assert.deepEqual(secondChannel.publishedTaskAssignments().at(-1), {
    message_id: secondProgress.message_id,
    task_id: secondTaskId,
    mode: "steer",
  });

  const firstStatus = tree.getStatus(FIRST_AGENT_ID);
  const secondStatus = tree.getStatus(SECOND_AGENT_ID);
  assert.equal(firstStatus.ok, true);
  assert.equal(secondStatus.ok, true);
  if (firstStatus.ok) assert.equal(firstStatus.data.mailbox_pending_count, 0);
  if (secondStatus.ok) assert.equal(secondStatus.data.mailbox_pending_count, 0);
});

test("不同节点拥有独立命令顺序域并可同时写入各自 RPC", async () => {
  const tree = createController();
  const firstRpc = new FakeRpcClient();
  const secondRpc = new FakeRpcClient();
  const firstNode = new TestManagedRpcNode(firstRpc, new FakeProcessTreeAdapter());
  const secondNode = new TestManagedRpcNode(secondRpc, new FakeProcessTreeAdapter());
  const first = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "并行一" },
    managedNode: firstNode,
    channel: new RecordingSupervisorChannel([]),
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  const second = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "并行二" },
    managedNode: secondNode,
    channel: new RecordingSupervisorChannel([]),
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await first.start()).ok, true);
  assert.equal((await second.start()).ok, true);
  const firstGate = firstRpc.deferNext("prompt");
  const secondGate = secondRpc.deferNext("prompt");

  const firstPrompt = first.prompt("one");
  const secondPrompt = second.prompt("two");
  await Promise.all([firstGate.started, secondGate.started]);

  assert.equal(firstRpc.operations().at(-1), "prompt");
  assert.equal(secondRpc.operations().at(-1), "prompt");
  firstGate.resolve();
  secondGate.resolve();
  assert.equal((await firstPrompt).ok, true);
  assert.equal((await secondPrompt).ok, true);
});

test("协调压缩的 provisional settled 不阻塞当前任务消息且保持 sibling 隔离", async () => {
  const tree = createController();
  const firstRpc = new FakeRpcClient();
  const secondRpc = new FakeRpcClient();
  const firstChannel = new RecordingSupervisorChannel([]);
  const secondChannel = new RecordingSupervisorChannel([]);
  const first = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "正常 sibling" },
    managedNode: new TestManagedRpcNode(firstRpc, new FakeProcessTreeAdapter()),
    channel: firstChannel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  const second = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "协调压缩 sibling" },
    managedNode: new TestManagedRpcNode(secondRpc, new FakeProcessTreeAdapter()),
    channel: secondChannel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
    onCompactionPrepare: () => true,
    onCompactionComplete: () => true,
  });
  assert.equal((await first.start()).ok, true);
  assert.equal((await second.start()).ok, true);

  const firstTask = await first.prompt("first work");
  const secondTask = await second.prompt("second work");
  assert.equal(firstTask.ok, true);
  assert.equal(secondTask.ok, true);
  if (!firstTask.ok || !secondTask.ok) return;
  await new Promise<void>((resolve) => setImmediate(resolve));
  firstRpc.emitEvent({ type: "agent_start" });
  firstChannel.emitTaskStarted({ task_id: firstTask.task_id, turn_id: TURN_ID });
  secondRpc.emitEvent({ type: "agent_start" });
  secondChannel.emitTaskStarted({ task_id: secondTask.task_id, turn_id: TURN_ID });

  const firstProgress = await first.steer("first progress");
  assert.equal(firstProgress.ok, true);
  if (firstProgress.ok) assert.equal(firstProgress.task_id, firstTask.task_id);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(firstRpc.operations().filter((operation) => operation === "steer").length, 1);

  secondChannel.emitCompactionPrepare("compact-live-stall");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(secondChannel.publishedCompactionResponses(), [{
    transaction_id: "compact-live-stall",
    accepted: true,
  }]);
  secondRpc.emitEvent({ type: "agent_settled" });

  const secondProgress = await second.steer("second progress during compaction");
  assert.equal(secondProgress.ok, true);
  if (!secondProgress.ok) return;
  assert.equal(secondProgress.task_id, secondTask.task_id);
  let secondStatus = tree.getStatus(SECOND_AGENT_ID);
  assert.equal(secondStatus.ok, true);
  if (secondStatus.ok) {
    assert.equal(secondStatus.data.state, "working");
    assert.equal(secondStatus.data.mailbox_pending_count, 1);
    assert.equal(secondStatus.data.host_pending_count, 0);
  }
  assert.equal(secondRpc.operations().filter((operation) => operation === "prompt").length, 1);
  assert.equal(secondRpc.operations().filter((operation) => operation === "steer").length, 0);

  const continuationSteer = secondRpc.deferNext("steer");
  // 业务 complete 走监督流，可能先于 RPC 流上的物理压缩事件到达。
  secondChannel.emitCompactionComplete("compact-live-stall", "succeeded", true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(secondRpc.operations().filter((operation) => operation === "prompt").length, 1);
  assert.equal(secondRpc.operations().filter((operation) => operation === "steer").length, 0);
  const lateProgress = await second.steer("second progress after complete");
  assert.equal(lateProgress.ok, true);
  if (!lateProgress.ok) return;
  assert.equal(lateProgress.task_id, secondTask.task_id);
  secondStatus = tree.getStatus(SECOND_AGENT_ID);
  assert.equal(secondStatus.ok, true);
  if (secondStatus.ok) assert.equal(secondStatus.data.mailbox_pending_count, 2);

  secondChannel.emitTaskStarted({ task_id: secondTask.task_id, turn_id: NEXT_TURN_ID });
  secondRpc.emitEvent({ type: "agent_start" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(secondRpc.operations().filter((operation) => operation === "steer").length, 0);

  secondRpc.emitEvent({ type: "compaction_start", reason: "manual" });
  secondRpc.emitEvent({
    type: "compaction_end",
    reason: "manual",
    aborted: false,
    willRetry: false,
    failed: false,
  });
  await continuationSteer.started;
  secondRpc.emitEvent({ type: "queue_update", pendingMessageCount: 1 });
  secondRpc.emitEvent({ type: "agent_settled" });
  continuationSteer.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(secondRpc.operations().filter((operation) => operation === "steer").length, 2);
  assert.deepEqual(secondChannel.publishedTaskAssignments().slice(-2), [
    {
      message_id: secondProgress.message_id,
      task_id: secondTask.task_id,
      mode: "steer",
    },
    {
      message_id: lateProgress.message_id,
      task_id: secondTask.task_id,
      mode: "steer",
    },
  ]);
  secondStatus = tree.getStatus(SECOND_AGENT_ID);
  assert.equal(secondStatus.ok, true);
  if (secondStatus.ok) {
    assert.equal(secondStatus.data.state, "working");
    assert.equal(secondStatus.data.mailbox_pending_count, 0);
    assert.equal(secondStatus.data.host_pending_count, 1);
  }
  secondRpc.emitEvent({ type: "queue_update", pendingMessageCount: 0 });
  secondStatus = tree.getStatus(SECOND_AGENT_ID);
  assert.equal(secondStatus.ok, true);
  if (secondStatus.ok) assert.equal(secondStatus.data.state, "working");

  const firstStatus = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(firstStatus.ok, true);
  if (firstStatus.ok) {
    assert.equal(firstStatus.data.state, "working");
    assert.equal(firstStatus.data.mailbox_pending_count, 0);
    assert.equal(firstStatus.data.host_pending_count, 0);
  }
});

test("abort 响应和 agent_end 不 settle，raw settled 后仍须 final commit", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const managedNode = new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter());
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "中断" },
    managedNode,
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  const task = await supervisor.prompt("work");
  assert.equal(task.ok, true);
  if (!task.ok) return;
  await new Promise<void>((resolve) => setImmediate(resolve));
  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: task.task_id, turn_id: TURN_ID });
  const abortGate = rpcClient.deferNext("abort");

  const interrupt = supervisor.interrupt();
  await abortGate.started;
  assert.deepEqual(await interrupt, {
    ok: true,
    accepted: true,
    changed: true,
  });
  let status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) assert.equal(status.data.state, "interrupting");

  rpcClient.emitEvent({ type: "agent_end", messages: [], willRetry: false });
  abortGate.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) assert.equal(status.data.state, "interrupting");

  rpcClient.emitEvent({ type: "agent_settled" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) assert.equal(status.data.activity?.phase, "finalizing");
  assert.equal(supervisor.acceptChildReply(Object.freeze({
    ...finalEnvelope(task.task_id),
    run_state: "interrupted" as const,
  }), () => true), true);
  status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) assert.equal(status.data.state, "idle");
});

test("中断会按 message_id 丢弃未交付旧任务命令，只在 final 后启动后继 prompt", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "中断命令关联" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  const firstPrompt = rpcClient.deferNext("prompt");
  const current = await supervisor.prompt("已经开始交付的当前消息");
  assert.equal(current.ok, true);
  if (!current.ok) return;
  await firstPrompt.started;

  const stale = await supervisor.steer("中断时必须丢弃的旧任务消息");
  assert.equal(stale.ok, true);
  if (!stale.ok) return;
  assert.equal(stale.task_id, current.task_id);
  assert.deepEqual(await supervisor.interrupt(), {
    ok: true,
    accepted: true,
    changed: true,
  });
  const successor = await supervisor.steer("中断后的后继任务");
  assert.equal(successor.ok, true);
  if (!successor.ok) return;
  assert.notEqual(successor.task_id, current.task_id);

  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: current.task_id, turn_id: TURN_ID });
  firstPrompt.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  rpcClient.emitEvent({ type: "agent_settled" });
  const successorPrompt = rpcClient.deferNext("prompt");
  assert.equal(supervisor.acceptChildReply(Object.freeze({
    schema: CHILD_REPLY_SCHEMA,
    version: CHILD_REPLY_VERSION,
    kind: "final",
    agent_id: FIRST_AGENT_ID,
    task_id: current.task_id,
    turn_id: TURN_ID,
    commit_id: COMMIT_ID,
    run_state: "interrupted" as const,
    output_state: "absent" as const,
  }), () => true), true);
  await successorPrompt.started;

  assert.deepEqual(
    channel.publishedTaskAssignments().map((assignment) => assignment.message_id),
    [current.message_id, successor.message_id],
  );
  assert.equal(channel.publishedTaskAssignments().some(
    (assignment) => assignment.message_id === stale.message_id,
  ), false);
  assert.equal(rpcClient.operations().filter((operation) => operation === "steer").length, 0);
  successorPrompt.resolve();
});

test("abort 写入不等待响应，栅栏后消息只在 mailbox 接纳为后继任务", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "中断后消息" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  const current = await supervisor.prompt("work");
  assert.equal(current.ok, true);
  if (!current.ok) return;
  await new Promise<void>((resolve) => setImmediate(resolve));
  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: current.task_id, turn_id: TURN_ID });
  const abortGate = rpcClient.deferNext("abort");

  assert.deepEqual(await supervisor.interrupt(), {
    ok: true,
    accepted: true,
    changed: true,
  });
  await abortGate.started;
  const successor = await supervisor.steer("after interrupt");
  assert.equal(successor.ok, true);
  if (!successor.ok) return;
  assert.notEqual(successor.task_id, current.task_id);
  await new Promise<void>((resolve) => setImmediate(resolve));

  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "interrupting");
    assert.equal(status.data.mailbox_pending_count, 1);
  }
  assert.equal(rpcClient.operations().includes("steer"), false);
  abortGate.resolve();
});

test("Pi 任务 RPC 只归一化生命周期和安全活动，assistant 回复留给真正 child 监督端点", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const managedNode = new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter());
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "事件" },
    managedNode,
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  const events: RpcSupervisorEvent[] = [];
  supervisor.onEvent((event) => events.push(event));
  assert.equal((await supervisor.start()).ok, true);
  const submission = await supervisor.prompt("work");
  assert.equal(submission.ok, true);
  if (!submission.ok) return;
  await new Promise<void>((resolve) => setImmediate(resolve));
  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: submission.task_id, turn_id: TURN_ID });

  rpcClient.emitEvent({
    type: "tool_execution_start",
    toolCallId: "call-secret",
    toolName: "apply_patch",
    args: { path: "D:\\private\\secret.txt", patch: "TOP_SECRET" },
  });
  rpcClient.emitEvent({
    type: "tool_execution_end",
    toolCallId: "call-secret",
    toolName: "apply_patch",
    result: { output: "TOP_SECRET_RESULT" },
    isError: false,
  });
  rpcClient.emitEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "TOP_SECRET_THOUGHT" },
        { type: "text", text: "任务已完成" },
        { type: "image", data: "YWJj", mimeType: "image/png" },
        { type: "toolCall", name: "apply_patch", arguments: { path: "D:\\private" } },
      ],
    },
  });
  rpcClient.emitEvent({ type: "agent_settled" });
  await new Promise<void>((resolve) => setImmediate(resolve));

  const lifecycleTypes = events
    .filter((event) => event.kind === "lifecycle")
    .map((event) => event.event.type);
  assert.deepEqual(lifecycleTypes, ["startup_ready"]);
  assert.deepEqual(
    events.filter((event) => event.kind === "activity"),
    [
      {
        kind: "activity",
        activity: { category: "editing", phase: "started", active_count: 1 },
      },
      {
        kind: "activity",
        activity: { category: "editing", phase: "finished", active_count: 0 },
      },
    ],
  );
  assert.deepEqual(channel.publishedReplies(), []);
  assert.equal(channel.publishedTaskAssignments().length, 1);
  const serialized = JSON.stringify(events);
  for (const secret of [
    "call-secret",
    "apply_patch",
    "D:\\private",
    "TOP_SECRET",
    "TOP_SECRET_RESULT",
    "TOP_SECRET_THOUGHT",
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("轮次边界清理缺失结束事件的 delegating 活动并忽略迟到结束", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "工具活动收敛" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  const events: RpcSupervisorEvent[] = [];
  supervisor.onEvent((event) => events.push(event));
  assert.equal((await supervisor.start()).ok, true);
  const submission = await supervisor.prompt("运行子任务");
  assert.equal(submission.ok, true);
  if (!submission.ok) return;
  await new Promise<void>((resolve) => setImmediate(resolve));
  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: submission.task_id, turn_id: TURN_ID });
  rpcClient.emitEvent({
    type: "tool_execution_start",
    toolCallId: "delegating-call",
    toolName: "spawn_agent",
  });

  let status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.activity?.category, "delegating");
    assert.equal(status.data.activity?.active_count, 1);
  }

  rpcClient.emitEvent({ type: "agent_end", messages: [], willRetry: false });
  status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "working");
    assert.equal(status.data.activity?.phase, "processing");
    assert.equal(status.data.activity?.category, undefined);
  }

  rpcClient.emitEvent({
    type: "tool_execution_end",
    toolCallId: "delegating-call",
    toolName: "spawn_agent",
    isError: false,
  });
  assert.deepEqual(events.filter((event) => event.kind === "fault"), []);
});

test("直接边 prepare 同步安装令牌，并等待旧 RPC 与 Pi 队列静止", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const edgeOperations: string[] = [];
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "直接边静止" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
    onCompactionPrepare: (transactionId) => {
      edgeOperations.push(`begin:${transactionId}`);
      return true;
    },
    onCompactionComplete: (transactionId, outcome) => {
      edgeOperations.push(`complete:${transactionId}:${outcome}`);
      return true;
    },
  });
  assert.equal((await supervisor.start()).ok, true);

  const promptGate = rpcClient.deferNext("prompt");
  const first = await supervisor.prompt("线性化点前的消息");
  assert.equal(first.ok, true);
  await promptGate.started;

  channel.emitCompactionPrepare("compact-edge");
  assert.deepEqual(edgeOperations, ["begin:compact-edge"]);
  const queued = await supervisor.steer("屏障后的消息");
  assert.equal(queued.ok, true);
  assert.equal(rpcClient.operations().filter((operation) => operation === "steer").length, 0);
  assert.deepEqual(channel.publishedCompactionResponses(), []);

  rpcClient.setState({ pendingMessageCount: 1 });
  promptGate.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(channel.publishedCompactionResponses(), []);

  rpcClient.emitEvent({ type: "agent_start" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(channel.publishedCompactionResponses(), []);
  let status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) assert.equal(status.data.host_pending_count, 1);

  rpcClient.setState({ pendingMessageCount: 0 });
  rpcClient.emitEvent({ type: "queue_update", pendingMessageCount: 0 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(channel.publishedCompactionResponses(), [
    { transaction_id: "compact-edge", accepted: true },
  ]);
  assert.equal(rpcClient.operations().filter((operation) => operation === "steer").length, 0);

  channel.emitCompactionComplete("compact-edge", "not_started");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(edgeOperations, [
    "begin:compact-edge",
    "complete:compact-edge:not_started",
  ]);
  assert.deepEqual(channel.publishedCompactionResponses(), [
    { transaction_id: "compact-edge", accepted: true },
    { transaction_id: "compact-edge", accepted: true },
  ]);
  assert.equal(rpcClient.operations().filter((operation) => operation === "steer").length, 1);
  status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) assert.equal(status.data.mailbox_pending_count, 0);
});

test("prompt 预检完成但 child 尚未 task_started 时 prepare 不等待自身前置条件", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "预检压缩闭环" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
    onCompactionPrepare: () => true,
    onCompactionComplete: () => true,
  });
  assert.equal((await supervisor.start()).ok, true);

  const promptGate = rpcClient.deferNext("prompt");
  const submission = await supervisor.prompt("预检后等待启动");
  assert.equal(submission.ok, true);
  await promptGate.started;
  promptGate.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));

  // 此时没有 agent_start/task_started；这正是 child 正等待父端 prepare 的窗口。
  channel.emitCompactionPrepare("preflight-start-gap");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(channel.publishedCompactionResponses(), [
    { transaction_id: "preflight-start-gap", accepted: true },
  ]);

  channel.emitCompactionComplete("preflight-start-gap", "not_started");
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("早到 not_started 取消等待中的 prepare，重复 complete 由事务墓碑幂等确认", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const edgeOperations: string[] = [];
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "直接边取消" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
    onCompactionPrepare: (transactionId) => {
      edgeOperations.push(`begin:${transactionId}`);
      return true;
    },
    onCompactionComplete: (transactionId, outcome) => {
      edgeOperations.push(`complete:${transactionId}:${outcome}`);
      return true;
    },
  });
  assert.equal((await supervisor.start()).ok, true);
  const stateGate = rpcClient.deferNext("get_state");

  channel.emitCompactionPrepare("compact-cancelled");
  await stateGate.started;
  channel.emitCompactionComplete("compact-cancelled", "not_started");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(edgeOperations, [
    "begin:compact-cancelled",
    "complete:compact-cancelled:not_started",
  ]);
  assert.deepEqual(
    channel.publishedCompactionResponses()
      .filter((response) => response.transaction_id === "compact-cancelled")
      .map((response) => response.accepted)
      .sort(),
    [false, true],
  );

  channel.emitCompactionComplete("compact-cancelled", "not_started");
  channel.emitCompactionPrepare("compact-cancelled");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(edgeOperations, [
    "begin:compact-cancelled",
    "complete:compact-cancelled:not_started",
  ]);
  assert.deepEqual(
    channel.publishedCompactionResponses()
      .filter((response) => response.transaction_id === "compact-cancelled")
      .map((response) => response.accepted)
      .sort(),
    [false, false, true, true],
  );
  stateGate.resolve();
});

test("先到 terminal complete 固定直接边事务 ACK，迟到 prepare 不重装 barrier", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const edgeOperations: string[] = [];
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "直接边 terminal-first" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
    onCompactionPrepare: (transactionId) => {
      edgeOperations.push(`begin:${transactionId}`);
      return true;
    },
    onCompactionComplete: (transactionId, outcome) => {
      edgeOperations.push(`complete:${transactionId}:${outcome}`);
      return true;
    },
  });
  assert.equal((await supervisor.start()).ok, true);

  channel.emitCompactionComplete("compact-terminal-first", "cancelled");
  await new Promise<void>((resolve) => setImmediate(resolve));
  channel.emitCompactionPrepare("compact-terminal-first");
  channel.emitCompactionComplete("compact-terminal-first", "failed");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(edgeOperations, []);
  assert.deepEqual(
    channel.publishedCompactionResponses()
      .filter((response) => response.transaction_id === "compact-terminal-first")
      .map((response) => response.accepted),
    [false, false, false],
  );
});

test("业务 complete 与补偿先于 manual start/end 到达时仍保留生命周期授权", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "manual 结束重排" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
    onCompactionPrepare: () => true,
    onCompactionComplete: () => true,
  });
  assert.equal((await supervisor.start()).ok, true);

  channel.emitCompactionPrepare("compact-manual-reordered");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(channel.publishedCompactionResponses(), [
    { transaction_id: "compact-manual-reordered", accepted: true },
  ]);

  channel.emitCompactionComplete("compact-manual-reordered", "succeeded");
  await new Promise<void>((resolve) => setImmediate(resolve));
  channel.emitCompactionComplete("compact-manual-reordered", "not_started");
  await new Promise<void>((resolve) => setImmediate(resolve));

  rpcClient.emitEvent({ type: "compaction_start", reason: "manual" });
  rpcClient.emitEvent({
    type: "compaction_end",
    reason: "manual",
    aborted: false,
    willRetry: false,
    failed: false,
  });

  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) assert.notEqual(status.data.state, "failed");
  assert.equal((await supervisor.prompt("manual 后仍可用")).ok, true);
});

test("成功 complete 后的 not_started 补偿撤销 continuation 等待并恢复 prompt assignment", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const edgeOperations: string[] = [];
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "continuation 补偿" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
    onCompactionPrepare: (transactionId) => {
      edgeOperations.push(`begin:${transactionId}`);
      return true;
    },
    onCompactionComplete: (transactionId, outcome) => {
      edgeOperations.push(`complete:${transactionId}:${outcome}`);
      return true;
    },
  });
  assert.equal((await supervisor.start()).ok, true);
  const current = await supervisor.prompt("进入自动压缩的任务");
  assert.equal(current.ok, true);
  if (!current.ok) return;
  await new Promise<void>((resolve) => setImmediate(resolve));
  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: current.task_id, turn_id: TURN_ID });

  channel.emitCompactionPrepare("compact-continuation-compensation");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  const queued = await supervisor.steer("续跑未启动也必须处理");
  assert.equal(queued.ok, true);
  if (!queued.ok) return;
  rpcClient.emitEvent({ type: "agent_settled" });
  rpcClient.emitEvent({ type: "compaction_start", reason: "manual" });
  rpcClient.emitEvent({
    type: "compaction_end",
    reason: "manual",
    aborted: false,
    willRetry: false,
    failed: false,
  });
  channel.emitCompactionComplete(
    "compact-continuation-compensation",
    "succeeded",
    true,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(rpcClient.operations().filter((operation) => operation === "steer").length, 0);
  assert.equal(rpcClient.operations().filter((operation) => operation === "prompt").length, 1);

  const adaptiveFallback = rpcClient.deferNext("steer");
  channel.emitCompactionComplete("compact-continuation-compensation", "not_started");
  await adaptiveFallback.started;
  assert.deepEqual(channel.publishedTaskAssignments().at(-1), {
    message_id: queued.message_id,
    task_id: current.task_id,
    mode: "prompt",
  });
  assert.deepEqual(edgeOperations, [
    "begin:compact-continuation-compensation",
    "complete:compact-continuation-compensation:succeeded",
  ]);
  assert.deepEqual(
    channel.publishedCompactionResponses()
      .filter((response) => response.transaction_id === "compact-continuation-compensation")
      .map((response) => response.accepted),
    [true, true, true],
  );
  adaptiveFallback.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));

  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: current.task_id, turn_id: NEXT_TURN_ID });
  rpcClient.emitEvent({ type: "agent_settled" });
  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) assert.equal(status.data.reply_outbox_pending_count, 1);
  await supervisor.terminate();
});

test("自动 continuation 已真实启动后拒绝迟到的 not_started 补偿", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "迟到 continuation 补偿" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
    onCompactionPrepare: () => true,
    onCompactionComplete: () => true,
  });
  assert.equal((await supervisor.start()).ok, true);
  const current = await supervisor.prompt("进入协调压缩");
  assert.equal(current.ok, true);
  if (!current.ok) return;
  await new Promise<void>((resolve) => setImmediate(resolve));
  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: current.task_id, turn_id: TURN_ID });

  channel.emitCompactionPrepare("compact-late-compensation");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  rpcClient.emitEvent({ type: "agent_settled" });
  rpcClient.emitEvent({ type: "compaction_start", reason: "manual" });
  rpcClient.emitEvent({
    type: "compaction_end",
    reason: "manual",
    aborted: false,
    willRetry: false,
    failed: false,
  });
  channel.emitCompactionComplete("compact-late-compensation", "succeeded", true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  rpcClient.emitEvent({ type: "agent_start" });

  channel.emitCompactionComplete("compact-late-compensation", "not_started");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    channel.publishedCompactionResponses()
      .filter((response) => response.transaction_id === "compact-late-compensation")
      .map((response) => response.accepted),
    [true, true, false],
  );
  await supervisor.terminate();
});

test("单个 pending manual 授权可通过公开事件正常 start/end", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "单个 manual 授权" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
    onCompactionPrepare: () => true,
    onCompactionComplete: () => true,
  });
  const events: RpcSupervisorEvent[] = [];
  supervisor.onEvent((event) => events.push(event));
  assert.equal((await supervisor.start()).ok, true);

  channel.emitCompactionPrepare("manual-single");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  rpcClient.emitEvent({ type: "compaction_start", reason: "manual" });
  rpcClient.emitEvent({
    type: "compaction_end",
    reason: "manual",
    aborted: false,
    willRetry: false,
    failed: false,
  });
  channel.emitCompactionComplete("manual-single", "succeeded");
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(events.filter((event) => event.kind === "fault"), []);
  assert.equal((await supervisor.prompt("manual 后仍可用")).ok, true);
});

test("多个 pending manual 授权存在歧义时通过公开事件 fail-closed", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "manual 授权歧义" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
    onCompactionPrepare: () => true,
    onCompactionComplete: () => true,
  });
  const events: RpcSupervisorEvent[] = [];
  supervisor.onEvent((event) => events.push(event));
  assert.equal((await supervisor.start()).ok, true);

  channel.emitCompactionPrepare("manual-ambiguous-a");
  channel.emitCompactionPrepare("manual-ambiguous-b");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    channel.publishedCompactionResponses().filter((response) => response.accepted),
    [
      { transaction_id: "manual-ambiguous-a", accepted: true },
      { transaction_id: "manual-ambiguous-b", accepted: true },
    ],
  );

  rpcClient.emitEvent({ type: "compaction_start", reason: "manual" });

  assert.deepEqual(
    events.filter((event) => event.kind === "fault"),
    [{ kind: "fault", code: "invalid_rpc_event" }],
  );
  assert.deepEqual(await supervisor.prompt("歧义授权后不可继续"), {
    ok: false,
    code: "agent_unavailable",
  });
});

for (const nativeReason of ["threshold", "overflow"] as const) {
  test(`native ${nativeReason} 撤销全部 pending 且不影响等待 manual end 的 active`, async () => {
    const tree = createController();
    const rpcClient = new FakeRpcClient();
    const channel = new RecordingSupervisorChannel([]);
    const supervisor = new RpcSupervisor({
      controller: tree,
      actor: ROOT_TREE_ACTOR,
      reservation: { templateId: "researcher", name: `manual 与 ${nativeReason} 交错` },
      managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
      channel,
      startupTimeoutMs: 100,
      gracefulShutdownMs: 5,
      onCompactionPrepare: () => true,
      onCompactionComplete: () => true,
    });
    const events: RpcSupervisorEvent[] = [];
    supervisor.onEvent((event) => events.push(event));
    assert.equal((await supervisor.start()).ok, true);

    channel.emitCompactionPrepare("manual-active");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    rpcClient.emitEvent({ type: "compaction_start", reason: "manual" });

    channel.emitCompactionComplete("manual-active", "succeeded");
    await new Promise<void>((resolve) => setImmediate(resolve));
    channel.emitCompactionPrepare("manual-pending-a");
    channel.emitCompactionPrepare("manual-pending-b");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    rpcClient.emitEvent({ type: "compaction_start", reason: nativeReason });
    rpcClient.emitEvent({
      type: "compaction_end",
      reason: nativeReason,
      aborted: false,
      willRetry: nativeReason === "overflow",
      failed: false,
    });
    rpcClient.emitEvent({
      type: "compaction_end",
      reason: "manual",
      aborted: false,
      willRetry: false,
      failed: false,
    });

    assert.deepEqual(events.filter((event) => event.kind === "fault"), []);

    rpcClient.emitEvent({ type: "compaction_start", reason: "manual" });
    assert.deepEqual(
      events.filter((event) => event.kind === "fault"),
      [{ kind: "fault", code: "invalid_rpc_event" }],
    );
  });
}

test("not_started 在 manual start 前后都允许接管外部生命周期，重复 end 仍进入故障", async () => {
  for (const timing of ["before_start", "after_start"] as const) {
    const tree = createController();
    const rpcClient = new FakeRpcClient();
    const channel = new RecordingSupervisorChannel([]);
    const transactionId = `manual-not-started-${timing}`;
    const supervisor = new RpcSupervisor({
      controller: tree,
      actor: ROOT_TREE_ACTOR,
      reservation: { templateId: "researcher", name: `manual ${timing}` },
      managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
      channel,
      startupTimeoutMs: 100,
      gracefulShutdownMs: 5,
      onCompactionPrepare: () => true,
      onCompactionComplete: () => true,
    });
    assert.equal((await supervisor.start()).ok, true);

    channel.emitCompactionPrepare(transactionId);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    if (timing === "before_start") {
      channel.emitCompactionComplete(transactionId, "not_started");
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    rpcClient.emitEvent({ type: "compaction_start", reason: "manual" });
    if (timing === "after_start") {
      channel.emitCompactionComplete(transactionId, "not_started");
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    rpcClient.emitEvent({
      type: "compaction_end",
      reason: "manual",
      aborted: false,
      willRetry: false,
      failed: false,
    });
    let status = tree.getStatus(FIRST_AGENT_ID);
    assert.equal(status.ok, true);
    if (status.ok) assert.notEqual(status.data.state, "failed");

    rpcClient.emitEvent({
      type: "compaction_end",
      reason: "manual",
      aborted: false,
      willRetry: false,
      failed: false,
    });
    status = tree.getStatus(FIRST_AGENT_ID);
    assert.equal(status.ok, true);
    if (status.ok) assert.equal(status.data.state, "failed");
  }
});

test("runtime_failed 发布前先固定 failed phase，使同步 orphan cleanup 可以启动", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "同步故障回收" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel: new RecordingSupervisorChannel([]),
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);

  let cleanup: Promise<{ readonly confirmed: boolean; readonly forced: boolean }> | undefined;
  supervisor.onEvent((event) => {
    if (event.kind === "lifecycle" && event.event.type === "runtime_failed") {
      cleanup = supervisor.reapOrphanedDescendants();
    }
  });
  rpcClient.emitTransportFault("eof");

  if (cleanup === undefined) throw new Error("同步故障回收未启动");
  assert.equal((await cleanup).confirmed, true);
  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) assert.equal(status.data.state, "failed");
});

test("迟到的 child runtime_failed 事实先固定本地 failed phase，再启动 orphan cleanup", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "child 运行故障传播" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  const statusBefore = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(statusBefore.ok, true);
  if (!statusBefore.ok) return;

  let cleanup: Promise<{ readonly confirmed: boolean; readonly forced: boolean }> | undefined;
  supervisor.onEvent((event) => {
    if (event.kind === "lifecycle" && event.event.type === "runtime_failed") {
      cleanup = supervisor.reapOrphanedDescendants();
    }
  });
  channel.emitEvent({
    root_id: "root",
    agent_id: FIRST_AGENT_ID,
    type: "runtime_failed",
    expected_generation: 1,
    error_code: "internal_error",
  });

  if (cleanup === undefined) throw new Error("child 故障回收未启动");
  assert.equal((await cleanup).confirmed, true);
  assert.deepEqual(await supervisor.prompt("故障后不得复用"), {
    ok: false,
    code: "agent_unavailable",
  });
  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) assert.equal(status.data.state, "failed");
});

test("过期的 child runtime_failed 事实不降级仍可用节点", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "过期 child 故障" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);

  channel.emitEvent({
    root_id: "root",
    agent_id: FIRST_AGENT_ID,
    type: "runtime_failed",
    expected_generation: 0,
    error_code: "internal_error",
  });

  assert.equal((await supervisor.prompt("过期故障后仍可投递")).ok, true);
  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) assert.notEqual(status.data.state, "failed");
});

test("监督传输故障释放同一直接边上的全部叠加压缩事务", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const releases: Array<{ readonly transactionId: string; readonly outcome: string }> = [];
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "故障释放直接边" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
    onCompactionPrepare: () => true,
    onCompactionComplete: (transactionId, outcome) => {
      releases.push({ transactionId, outcome });
      return true;
    },
  });
  assert.equal((await supervisor.start()).ok, true);
  const firstProbe = rpcClient.deferNext("get_state");
  const secondProbe = rpcClient.deferNext("get_state");

  channel.emitCompactionPrepare("compact-a");
  channel.emitCompactionPrepare("compact-b");
  await Promise.all([firstProbe.started, secondProbe.started]);
  channel.emitFault("eof");
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(releases, [
    { transactionId: "compact-a", outcome: "not_started" },
    { transactionId: "compact-b", outcome: "not_started" },
  ]);
  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) assert.equal(status.data.state, "failed");
  firstProbe.resolve();
  secondProbe.resolve();
});

test("命令响应晚于 task_started 与 final 时自动重试并提交已完成任务", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "final 响应尾竞态" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  const promptGate = rpcClient.deferNext("prompt");
  const submission = await supervisor.prompt("final 先于命令响应");
  assert.equal(submission.ok, true);
  if (!submission.ok) return;
  await promptGate.started;

  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: submission.task_id, turn_id: TURN_ID });
  rpcClient.emitEvent({ type: "agent_settled" });
  const final = finalEnvelope(submission.task_id);
  assert.equal(supervisor.acceptChildReply(final, () => true), false);

  const retriesBefore = channel.pendingReplyRetries();
  promptGate.reject();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(channel.pendingReplyRetries(), retriesBefore + 1);

  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "working");
    assert.equal(status.data.activity?.phase, "waiting_parent_ack");
    assert.equal(status.data.reply_outbox_pending_count, 1);
  }
  assert.equal(supervisor.acceptChildReply(final, () => true), true);
  const committed = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(committed.ok, true);
  if (committed.ok) {
    assert.equal(committed.data.state, "idle");
    assert.equal(committed.data.last_task?.outcome, "completed");
  }
});

test("Pi extension_error 不覆盖 final，但真实 EOF 仍使不可复用节点失败", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "可恢复扩展错误" },
    managedNode: new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter()),
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  rpcClient.emitEvent({ type: "agent_start" });
  channel.emitTaskStarted({ task_id: AUTONOMOUS_TASK_ID, turn_id: TURN_ID });
  rpcClient.emitEvent({ type: "agent_settled" });
  assert.equal(supervisor.acceptChildReply(finalEnvelope(AUTONOMOUS_TASK_ID), () => true), true);

  rpcClient.emitEvent({ type: "extension_error" });
  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "idle");
    assert.equal(status.data.last_task?.outcome, "completed");
    assert.equal(status.data.error, undefined);
  }

  rpcClient.emitTransportFault("eof");
  const failed = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(failed.ok, true);
  if (failed.ok) {
    assert.equal(failed.data.state, "failed");
    assert.equal(failed.data.last_task?.outcome, "completed");
    assert.equal(failed.data.error?.code, "internal_error");
  }
});

test("非法 Pi 事件、重复 manual compaction 和运行期 EOF 归一化为稳定故障", async () => {
  for (const scenario of ["invalid_event", "duplicate_manual_compaction", "eof"] as const) {
    const tree = createController();
    const rpcClient = new FakeRpcClient();
    const managedNode = new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter());
    const supervisor = new RpcSupervisor({
      controller: tree,
      actor: ROOT_TREE_ACTOR,
      reservation: { templateId: "researcher", name: scenario },
      managedNode,
      channel: new RecordingSupervisorChannel([]),
      startupTimeoutMs: 100,
      gracefulShutdownMs: 5,
    });
    const events: RpcSupervisorEvent[] = [];
    supervisor.onEvent((event) => events.push(event));
    assert.equal((await supervisor.start()).ok, true);

    if (scenario === "invalid_event") {
      rpcClient.emitEvent({ type: "unknown_pi_event", error: "TOP_SECRET_STACK" });
    } else if (scenario === "duplicate_manual_compaction") {
      rpcClient.emitEvent({ type: "compaction_start", reason: "manual" });
      rpcClient.emitEvent({ type: "compaction_start", reason: "manual" });
    } else {
      rpcClient.emitTransportFault("eof");
    }

    const status = tree.getStatus(FIRST_AGENT_ID);
    assert.equal(status.ok, true);
    if (status.ok) {
      assert.equal(status.data.state, "failed");
      assert.equal(status.data.error?.code, "internal_error");
    }
    assert.deepEqual(await supervisor.prompt("late"), {
      ok: false,
      code: "agent_unavailable",
    });
    const fault = events.find((event) => event.kind === "fault");
    assert.deepEqual(fault, {
      kind: "fault",
      code: scenario === "eof"
        ? "rpc_eof"
        : "invalid_rpc_event",
    });
    assert.equal(JSON.stringify(events).includes("TOP_SECRET_STACK"), false);
  }
});

test("mailbox 已接纳后遇到 EOF 保持 accepted 事实且不重发未知 Pi 交付", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const managedNode = new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter());
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "未决交付" },
    managedNode,
    channel: new RecordingSupervisorChannel([]),
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  const promptGate = rpcClient.deferNext("prompt");
  const delivery = supervisor.prompt("unknown acceptance");
  await promptGate.started;

  rpcClient.emitTransportFault("eof");

  assert.equal((await delivery).ok, true);
  assert.equal(rpcClient.operations().filter((operation) => operation === "prompt").length, 1);
  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "failed");
    assert.equal(status.data.mailbox_pending_count, 0);
  }
});

test("终止屏障取消未写命令、抢占活动 RPC、合并并发终止并丢弃迟到响应", async () => {
  const trace: string[] = [];
  const tree = createController();
  const rpcClient = new FakeRpcClient({
    onOperation: (operation) => trace.push(`rpc:${operation}`),
  });
  const managedNode = new TestManagedRpcNode(rpcClient, new RecordingProcessTreeAdapter(trace));
  const supervisor = new RpcSupervisor({
    controller: new RecordingController(tree, trace),
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "终止" },
    managedNode,
    channel: new RecordingSupervisorChannel(trace),
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  const promptGate = rpcClient.deferNext("prompt");
  const activePrompt = supervisor.prompt("active");
  await promptGate.started;
  const cancelledSteering = supervisor.steer("queued");

  const firstTermination = supervisor.terminate();
  const secondTermination = supervisor.terminate();

  assert.strictEqual(firstTermination, secondTermination);
  const cancelledResult = await cancelledSteering;
  assert.equal(cancelledResult.ok, true);
  assert.deepEqual(await supervisor.prompt("late"), {
    ok: false,
    code: "agent_unavailable",
  });
  assert.deepEqual(await firstTermination, {
    ok: true,
    agent_id: FIRST_AGENT_ID,
    state: "terminated",
    cleanup: "confirmed",
  });
  assert.equal(rpcClient.operations().includes("steer"), false);
  assert.equal(rpcClient.operations().includes("abort"), true);
  assert.ok(trace.indexOf("controller:termination_requested") < trace.indexOf("rpc:abort"));
  assert.ok(trace.indexOf("rpc:abort") < trace.indexOf("process:graceful_close"));
  assert.ok(trace.indexOf("process:graceful_close") < trace.indexOf("process:force_terminate"));
  assert.ok(trace.indexOf("process:force_terminate") < trace.indexOf("controller:resources_confirmed"));

  promptGate.resolve();
  assert.equal((await activePrompt).ok, true);
  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) assert.equal(status.data.state, "terminated");
});

test("终止目标物理资源确认后等待外层批量提交固定屏障", async () => {
  const tree = createController();
  const managedNode = new TestManagedRpcNode(new FakeRpcClient(), new FakeProcessTreeAdapter());
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "父节点" },
    managedNode,
    channel: new RecordingSupervisorChannel([]),
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  const child = tree.reserveStartingChild(
    { kind: "agent", agent_id: FIRST_AGENT_ID },
    { templateId: "researcher", name: "后代" },
  );
  assert.equal(child.ok, true);
  const barrier = tree.beginTerminationBarrier(ROOT_TREE_ACTOR, FIRST_AGENT_ID);
  assert.equal(barrier.ok, true);

  assert.deepEqual(await supervisor.terminate(), {
    ok: true,
    agent_id: FIRST_AGENT_ID,
    state: "terminating",
    cleanup: "confirmed",
    tree_confirmation: "pending",
  });
  const parentStatus = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(parentStatus.ok, true);
  if (parentStatus.ok) assert.equal(parentStatus.data.state, "terminating");
  if (!child.ok) throw new Error("测试后代预留失败");
  const childStatus = tree.getStatus(child.data.node.agent_id);
  assert.equal(childStatus.ok, true);
  if (childStatus.ok) assert.equal(childStatus.data.state, "terminating");

  const confirmed = tree.confirmTerminationBarrierResources(FIRST_AGENT_ID);
  assert.equal(confirmed.ok, true);
  if (confirmed.ok) assert.equal(confirmed.data.node.state, "terminated");
  const confirmedChild = tree.getStatus(child.data.node.agent_id);
  assert.equal(confirmedChild.ok, true);
  if (confirmedChild.ok) assert.equal(confirmedChild.data.state, "terminated");
});

test("关闭请求不返回时仍在内部期限后强制回收并结束等待", async () => {
  const trace: string[] = [];
  const processTreeAdapter = new HangingGracefulProcessTreeAdapter(trace);
  const managedNode = new TestManagedRpcNode(new FakeRpcClient(), processTreeAdapter);
  const channel = new HangingCloseSupervisorChannel(trace);
  const supervisor = new RpcSupervisor({
    controller: createController(),
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "关闭期限" },
    managedNode,
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);

  const timeout = new Promise<"external_timeout">((resolve) => {
    setTimeout(() => resolve("external_timeout"), 250);
  });
  const result = await Promise.race([supervisor.terminate(), timeout]);

  assert.notEqual(result, "external_timeout");
  assert.deepEqual(result, {
    ok: true,
    agent_id: FIRST_AGENT_ID,
    state: "terminated",
    cleanup: "confirmed",
  });
  assert.equal(processTreeAdapter.closeSignal?.aborted, true);
  assert.equal(channel.closeSignal?.aborted, true);
  assert.equal(trace.includes("process:force_terminate"), true);
});

test("强制回收后资源仍存在时保持 terminating 并报告 termination_incomplete", async () => {
  const trace: string[] = [];
  const tree = createController();
  const managedNode = new TestManagedRpcNode(
    new FakeRpcClient(),
    new RecordingProcessTreeAdapter(trace, {
      scenarios: [{
        initial: { exit: "present", resources: "present" },
        afterGracefulClose: { exit: "present", resources: "present" },
        afterForceTerminate: [{ exit: "present", resources: "present" }],
      }],
    }),
  );
  const channel = new RecordingSupervisorChannel(trace);
  const supervisor = new RpcSupervisor({
    controller: new RecordingController(tree, trace),
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "残留" },
    managedNode,
    channel,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);

  const result = await supervisor.terminate();

  assert.deepEqual(result, {
    ok: false,
    agent_id: FIRST_AGENT_ID,
    code: "termination_incomplete",
    state: "terminating",
    cleanup: "incomplete",
  });
  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "terminating");
    assert.equal(status.data.error?.code, "termination_incomplete");
  }
  assert.equal(trace.includes("process:force_terminate"), true);
  assert.equal(trace.includes("channel:release"), false);
  assert.equal(trace.includes("controller:resources_confirmed"), false);
});

test("资源观察已确认但句柄释放失败时仍保持 terminating 且不泄露异常", async () => {
  const trace: string[] = [];
  const tree = createController();
  const managedNode = new TestManagedRpcNode(
    new FakeRpcClient(),
    new ReleaseFailingProcessTreeAdapter(trace),
  );
  const supervisor = new RpcSupervisor({
    controller: new RecordingController(tree, trace),
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "释放失败" },
    managedNode,
    channel: new RecordingSupervisorChannel(trace),
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  const events: RpcSupervisorEvent[] = [];
  supervisor.onEvent((event) => events.push(event));
  assert.equal((await supervisor.start()).ok, true);

  const result = await supervisor.terminate();

  assert.deepEqual(result, {
    ok: false,
    agent_id: FIRST_AGENT_ID,
    code: "termination_incomplete",
    state: "terminating",
    cleanup: "incomplete",
  });
  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "terminating");
    assert.equal(status.data.error?.code, "termination_incomplete");
  }
  assert.equal(trace.includes("controller:resources_confirmed"), false);
  assert.equal(JSON.stringify(events).includes("TOP_SECRET_RELEASE_ERROR"), false);
});
