import assert from "node:assert/strict";
import test from "node:test";
import {
  FakeRpcClient,
  PiRpcClientAdapter,
  RpcSupervisor,
  type RpcSupervisorChannel,
  type RpcSupervisorChannelCloseState,
  type RpcSupervisorEvent,
} from "../src/rpc-supervisor.ts";
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
  type ControlResult,
  type LifecycleEventOutcome,
  type ReserveStartingChildInput,
  type ReservedAgentOutcome,
  type TreeActor,
} from "../src/tree-controller.ts";

const FIRST_AGENT_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_AGENT_ID = "22222222-2222-4222-8222-222222222222";

test("PiRpcClientAdapter 只委托 Pi 公共命令并从 transport observer 补充故障观察", async () => {
  const operations: string[] = [];
  let piEventListener: ((event: unknown) => void) | undefined;
  let faultListener: ((fault: "eof" | "protocol_fault" | "process_exit") => void) | undefined;
  const adapter = new PiRpcClientAdapter({
    start: async () => { operations.push("start"); },
    prompt: async (_message, images) => { operations.push(`prompt:${images?.length ?? 0}`); },
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
  await adapter.prompt("hello", [{ type: "image", data: "YWJj", mimeType: "image/png" }]);
  await adapter.steer("next");
  await adapter.abort();
  assert.deepEqual(await adapter.getState(), { isStreaming: false });
  piEventListener?.({ type: "agent_settled" });
  faultListener?.("eof");

  assert.deepEqual(operations, ["start", "prompt:1", "steer", "abort"]);
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

  prompt(message: string, images?: readonly { readonly type: "image"; readonly data: string; readonly mimeType: string }[]): Promise<void> {
    return this.rpc.prompt(message, images);
  }

  steer(message: string, images?: readonly { readonly type: "image"; readonly data: string; readonly mimeType: string }[]): Promise<void> {
    return this.rpc.steer(message, images);
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
  private readonly replies: Array<{ readonly text: string; readonly images?: readonly unknown[] }> = [];
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

  async publishReply(reply: { readonly text: string; readonly images?: readonly unknown[] }): Promise<void> {
    this.trace.push("channel:reply");
    this.replies.push(Object.freeze({
      text: reply.text,
      ...(reply.images === undefined ? {} : { images: Object.freeze([...reply.images]) }),
    }));
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

  publishedReplies(): readonly { readonly text: string; readonly images?: readonly unknown[] }[] {
    return Object.freeze([...this.replies]);
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
  assert.deepEqual(await prompt, { ok: true, accepted: true });
  await steerGate.started;
  assert.deepEqual(rpcClient.operations(), ["start", "get_state", "prompt", "steer"]);
  steerGate.resolve();
  assert.deepEqual(await steering, { ok: true, accepted: true });
  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "working");
    assert.equal(status.data.pending_message_count, 0);
  }
});

test("prompt 接受响应与 agent_settled 同批到达时按线序提交并最终保持 idle", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const managedNode = new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter());
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "settle 竞态" },
    managedNode,
    channel: new RecordingSupervisorChannel([]),
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  const promptGate = rpcClient.deferNext("prompt");

  const delivery = supervisor.prompt("finish immediately");
  await promptGate.started;
  promptGate.resolve();
  rpcClient.emitEvent({ type: "agent_settled" });

  assert.deepEqual(await delivery, { ok: true, accepted: true });
  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "idle");
    assert.equal(status.data.pending_message_count, 0);
  }
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

test("abort 与消息共用顺序域，响应和 agent_end 不 settle，只有 agent_settled 回到 idle", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const managedNode = new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter());
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "中断" },
    managedNode,
    channel: new RecordingSupervisorChannel([]),
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  assert.equal((await supervisor.prompt("work")).ok, true);
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
  status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) assert.equal(status.data.state, "interrupting");

  abortGate.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) assert.equal(status.data.state, "interrupting");

  rpcClient.emitEvent({ type: "agent_settled" });
  status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) assert.equal(status.data.state, "idle");
});

test("abort 写入后不等待响应，interrupting 中的后续消息继续按顺序交付", async () => {
  const tree = createController();
  const rpcClient = new FakeRpcClient();
  const managedNode = new TestManagedRpcNode(rpcClient, new FakeProcessTreeAdapter());
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "中断后消息" },
    managedNode,
    channel: new RecordingSupervisorChannel([]),
    startupTimeoutMs: 100,
    gracefulShutdownMs: 5,
  });
  assert.equal((await supervisor.start()).ok, true);
  assert.equal((await supervisor.prompt("work")).ok, true);
  const abortGate = rpcClient.deferNext("abort");
  const steerGate = rpcClient.deferNext("steer");

  assert.deepEqual(await supervisor.interrupt(), {
    ok: true,
    accepted: true,
    changed: true,
  });
  await abortGate.started;
  const steering = supervisor.steer("after interrupt");
  await steerGate.started;
  steerGate.resolve();

  assert.deepEqual(await steering, { ok: true, accepted: true });
  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "interrupting");
    assert.equal(status.data.pending_message_count, 0);
  }
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
  assert.deepEqual(lifecycleTypes, [
    "startup_ready",
    "message_admitted",
    "prompt_accepted",
    "agent_settled",
  ]);
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

test("非法 Pi 事件和运行期 EOF 归一化为稳定故障且不泄露原始载荷", async () => {
  for (const scenario of ["invalid_event", "eof"] as const) {
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
      code: scenario === "eof" ? "rpc_eof" : "invalid_rpc_event",
    });
    assert.equal(JSON.stringify(events).includes("TOP_SECRET_STACK"), false);
  }
});

test("prompt 接受响应未决时遇到 EOF 返回 message_delivery_failed 且不重发", async () => {
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

  assert.deepEqual(await delivery, {
    ok: false,
    code: "message_delivery_failed",
  });
  assert.equal(rpcClient.operations().filter((operation) => operation === "prompt").length, 1);
  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "failed");
    assert.equal(status.data.pending_message_count, 0);
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
  assert.deepEqual(await cancelledSteering, {
    ok: false,
    code: "message_delivery_failed",
  });
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
  assert.deepEqual(await activePrompt, {
    ok: false,
    code: "message_delivery_failed",
  });
  const status = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) assert.equal(status.data.state, "terminated");
});

test("直接后代尚未终止时不把本节点资源确认误报为终止成功", async () => {
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

  assert.deepEqual(await supervisor.terminate(), {
    ok: false,
    agent_id: FIRST_AGENT_ID,
    code: "termination_incomplete",
    state: "terminating",
    cleanup: "incomplete",
  });
  let parentStatus = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(parentStatus.ok, true);
  if (parentStatus.ok) assert.equal(parentStatus.data.state, "terminating");

  if (!child.ok) throw new Error("测试后代预留失败");
  const childFailed = tree.applyLifecycleEvent(child.data.node.agent_id, {
    type: "startup_failed",
    error_code: "spawn_failed",
    expected_generation: child.data.lifecycle_generation,
  });
  assert.equal(childFailed.ok, true);
  if (!childFailed.ok) throw new Error("测试后代启动失败事件未生效");
  const childTerminated = tree.applyLifecycleEvent(child.data.node.agent_id, {
    type: "resources_confirmed",
    expected_generation: childFailed.data.lifecycle_generation,
  });
  assert.equal(childTerminated.ok, true);

  assert.deepEqual(await supervisor.terminate(), {
    ok: true,
    agent_id: FIRST_AGENT_ID,
    state: "terminated",
    cleanup: "confirmed",
  });
  parentStatus = tree.getStatus(FIRST_AGENT_ID);
  assert.equal(parentStatus.ok, true);
  if (parentStatus.ok) assert.equal(parentStatus.data.state, "terminated");
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
