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
} from "../src/supervisor-channel.ts";
import type {
  ManagedRpcNodeLike,
  ManagedRpcNodeStartContext,
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
  private readonly taskStartedListeners = new Set<(started: SupervisorTaskStarted) => void>();
  private readonly compactionPrepareListeners = new Set<(request: SupervisorCompactionPrepare) => void>();
  private readonly compactionCompleteListeners = new Set<(request: SupervisorCompactionComplete) => void>();
  private readonly compactionResponses: Array<SupervisorCompactionPrepared | SupervisorCompactionCompleted> = [];
  private readonly trace: string[];
  private readonly readyPromise: Promise<void> | undefined;

  constructor(
    trace: string[],
    readyPromise?: Promise<void>,
  ) {
    this.trace = trace;
    this.readyPromise = readyPromise;
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

  async publishTaskAssignmentAndWaitForAck(assignment: SupervisorTaskAssignment): Promise<void> {
    this.trace.push("channel:task_assignment");
    this.taskAssignments.push(assignment);
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
  ): void {
    for (const listener of this.compactionCompleteListeners) {
      listener({ transaction_id: transactionId, outcome });
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

test("Pi 原生自动压缩后若真实 settled，mailbox 用 prompt 延续同一逻辑任务", async () => {
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

  assert.equal(rpcClient.operations().filter((operation) => operation === "prompt").length, 2);
  assert.equal(rpcClient.operations().filter((operation) => operation === "steer").length, 0);
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

test("Pi 命令 rejection 不撤销 mailbox 接纳，并投影为 delivery_uncertain", async () => {
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
    assert.equal(status.data.activity?.phase, "delivery_uncertain");
    assert.equal(status.data.reply_outbox_pending_count, 0);
  }
});

test("命令结果与队列释放之间到达 agent_start 后的 rejection 仍保持 delivery_uncertain", async () => {
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
  if (status.ok) assert.equal(status.data.state, "suspended");
});

test("命令窗口内多轮 lifecycle 后的 rejection 不伪造 host pending", async () => {
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
});

test("steer 交付未确认时到达 settled 会进入粘性 delivery_uncertain", async () => {
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
    assert.equal(status.data.state, "suspended");
    assert.equal(status.data.activity?.phase, "delivery_uncertain");
    assert.equal(status.data.host_pending_count, 0);
  }
  rpcClient.emitEvent({ type: "agent_start" });
  status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) assert.equal(status.data.state, "suspended");
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

test("settled 后接纳的后继消息在当前 final commit 后改用 prompt", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const channel = new RecordingSupervisorChannel([]);
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "settled 后消息路由" },
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

  const steering = await supervisor.steer("settled 后排入的任务");
  assert.equal(steering.ok, true);
  if (!steering.ok) return;
  assert.notEqual(steering.task_id, AUTONOMOUS_TASK_ID);
  let status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.activity?.phase, "finalizing");
    assert.equal(status.data.mailbox_pending_count, 1);
  }

  const promptGate = rpcClient.deferNext("prompt");
  assert.equal(supervisor.acceptChildReply(finalEnvelope(AUTONOMOUS_TASK_ID), () => true), true);
  await promptGate.started;
  promptGate.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(rpcClient.operations().at(-1), "prompt");
  status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) assert.equal(status.data.activity?.task_id, steering.task_id);
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
  assert.equal((await supervisor.prompt("work")).ok, true);

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

test("直接边 prepare 同步安装令牌，并等待旧 RPC、prompt start 与 Pi 队列静止", async () => {
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

  promptGate.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(channel.publishedCompactionResponses(), []);

  rpcClient.setState({ pendingMessageCount: 1 });
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

test("not_started 在 manual start 前后分别处理授权，重复 manual end 进入故障", async () => {
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
      rpcClient.emitEvent({ type: "compaction_start", reason: "manual" });
      const status = tree.getStatus(FIRST_AGENT_ID);
      assert.equal(status.ok, true);
      if (status.ok) assert.equal(status.data.state, "failed");
      continue;
    }

    rpcClient.emitEvent({ type: "compaction_start", reason: "manual" });
    channel.emitCompactionComplete(transactionId, "not_started");
    await new Promise<void>((resolve) => setImmediate(resolve));
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

test("非法 Pi 事件、未经协调的 child manual compaction、extension_error 和运行期 EOF 归一化为稳定故障", async () => {
  for (const scenario of ["invalid_event", "manual_compaction", "extension_error", "eof"] as const) {
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
    } else if (scenario === "manual_compaction") {
      rpcClient.emitEvent({ type: "compaction_start", reason: "manual" });
    } else if (scenario === "extension_error") {
      rpcClient.emitEvent({ type: "extension_error", error: "TOP_SECRET_STACK" });
      // Pi 保证 handler 错误先于同一轮 agent_settled；迟到 settle 不得覆盖 failed。
      rpcClient.emitEvent({ type: "agent_settled" });
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
        : scenario === "extension_error"
          ? "rpc_protocol_fault"
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
