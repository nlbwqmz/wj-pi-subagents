import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  AgentController,
  type AgentSupervisor,
} from "../src/agent-controller.ts";
import {
  createRootAuthorityControlHandler,
  RemoteTreeAuthorityPort,
  SupervisorControlClient,
  SupervisorControlServer,
} from "../src/authority-control-router.ts";
import {
  FakeRpcClient,
  RpcSupervisor,
  type RpcSupervisorCommandResult,
  type RpcSupervisorEvent,
  type RpcSupervisorInterruptResult,
  type RpcSupervisorStartupResult,
  type RpcSupervisorTerminationResult,
} from "../src/rpc-supervisor.ts";
import type {
  ExitObservation,
  ResourceObservation,
} from "../src/process-tree-capability.ts";
import {
  SubtreePublisher,
  type SubtreeSnapshotSink,
} from "../src/subtree-publisher.ts";
import {
  StreamSupervisorChannel,
  type SupervisorByteTransport,
} from "../src/stream-supervisor-channel.ts";
import {
  SupervisorRequestIdRegistry,
} from "../src/supervisor-channel.ts";
import {
  ROOT_TREE_ACTOR,
  TreeController,
  type AgentLifecycleEventType,
  type AgentSnapshot,
  type AppliedLifecycleFact,
  type TreeActor,
} from "../src/tree-controller.ts";
import { RootTreeAuthority } from "../src/tree-authority.ts";
import type {
  TemplateDefinition,
  TemplateDiscoverySnapshot,
} from "../src/template-discovery-snapshot.ts";

const ROOT_ID = "nested-lifecycle-root";
const DIRECT_CHILD_ID = "550e8400-e29b-41d4-a716-446655440000";
const NESTED_ONE_ID = "550e8400-e29b-41d4-a716-446655440001";
const NESTED_TWO_ID = "550e8400-e29b-41d4-a716-446655440002";
const CREDENTIAL = "nested-lifecycle-supervisor-credential-0001";

class ManagedFakeNode {
  readonly process_binding = "managed" as const;
  readonly rpc = new FakeRpcClient();

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

function makeTree(idFactory: () => string, initialActor?: {
  readonly agentId: string;
  readonly parentAgentId: string | null;
  readonly depth: number;
  readonly managementEnabled: boolean;
  readonly templateId?: string;
  readonly name?: string;
}): TreeController {
  return new TreeController({
    config: {
      maxDepth: 3,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 8,
      waitTimeoutMs: 10_000,
    },
    idFactory,
    ...(initialActor === undefined ? {} : { initialActor }),
  });
}

function channelPair(initialSnapshot: readonly unknown[]): {
  readonly parent: StreamSupervisorChannel;
  readonly child: StreamSupervisorChannel;
} {
  const parentToChild = new PassThrough();
  const childToParent = new PassThrough();
  const requestIdRegistry = new SupervisorRequestIdRegistry();
  const parentTransport: SupervisorByteTransport = {
    stdin: parentToChild,
    stdout: childToParent,
  };
  const childTransport: SupervisorByteTransport = {
    stdin: childToParent,
    stdout: parentToChild,
  };
  return {
    parent: new StreamSupervisorChannel({
      role: "parent",
      rootId: ROOT_ID,
      localAgentId: null,
      peerAgentId: DIRECT_CHILD_ID,
      parentAgentId: null,
      depth: 1,
      credential: CREDENTIAL,
      requestIdRegistry,
      transport: parentTransport,
    }),
    child: new StreamSupervisorChannel({
      role: "child",
      rootId: ROOT_ID,
      localAgentId: DIRECT_CHILD_ID,
      peerAgentId: "",
      parentAgentId: null,
      depth: 1,
      credential: CREDENTIAL,
      requestIdRegistry,
      transport: childTransport,
      initialSnapshot,
      initialSubtreeRevision: 1,
    }),
  };
}

function actor(agentId: string): TreeActor {
  return Object.freeze({ kind: "agent", agent_id: agentId });
}

function generation(tree: TreeController, agentId: string): number {
  const result = tree.getLifecycleGeneration(agentId);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
}

function apply(tree: TreeController, agentId: string, type: AgentLifecycleEventType): void {
  const result = tree.applyLifecycleEvent(agentId, {
    type,
    expected_generation: generation(tree, agentId),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) assert.equal(result.data.applied, true, JSON.stringify(result));
}

interface Signal {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function signal(): Signal {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class ClosableGrandchildSupervisor implements AgentSupervisor {
  readonly terminationStarted = signal();
  readonly permitTermination = signal();
  private readonly listeners = new Set<(event: RpcSupervisorEvent) => void>();
  private readonly tree: TreeController;
  private readonly agentId: string;

  constructor(tree: TreeController, agentId: string) {
    this.tree = tree;
    this.agentId = agentId;
  }

  async start(): Promise<RpcSupervisorStartupResult> {
    // 真实子进程启动给 starting 完整快照留下一个发布回合，先建立事件身份作用域。
    await settle();
    apply(this.tree, this.agentId, "startup_ready");
    return { ok: true, agent_id: this.agentId, state: "idle" };
  }

  async sendMessage(_message: string): Promise<RpcSupervisorCommandResult> {
    return { ok: true, accepted: true };
  }

  async interrupt(): Promise<RpcSupervisorInterruptResult> {
    return { ok: true, accepted: false, changed: false };
  }

  async terminate(): Promise<RpcSupervisorTerminationResult> {
    this.terminationStarted.resolve();
    await this.permitTermination.promise;
    const status = this.tree.getStatus(this.agentId);
    assert.equal(status.ok, true, JSON.stringify(status));
    if (status.ok && status.data.state !== "terminated") {
      apply(this.tree, this.agentId, "resources_confirmed");
    }
    return {
      ok: true,
      agent_id: this.agentId,
      state: "terminated",
      cleanup: "confirmed",
    };
  }

  onEvent(listener: (event: RpcSupervisorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  wasForcedTerminationUsed(): boolean {
    return false;
  }
}

function makeTemplateSnapshot(): TemplateDiscoverySnapshot {
  const template: TemplateDefinition = Object.freeze({
    templateId: "nested",
    source: "project",
    templateDirectory: ".",
    description: "嵌套测试模板",
    tools: undefined,
    extensions: undefined,
    allowSubagents: true,
    contextFiles: false,
    systemPromptMode: "append",
    body: "",
  });
  return Object.freeze({
    templates: Object.freeze([template]),
    invalidCandidates: Object.freeze([]),
    sourceDiagnostics: Object.freeze([]),
    resolveTemplate: (templateId: string) => templateId === template.templateId
      ? Object.freeze({ kind: "valid" as const, template })
      : Object.freeze({ kind: "not_found" as const }),
    toJSON: () => ({}),
  });
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("子代理创建孙代理时预留前在途快照不使直接父协议失败", async () => {
  const allocated = [DIRECT_CHILD_ID, NESTED_ONE_ID];
  let allocation = 0;
  const rootTree = makeTree(() => allocated[allocation++] ?? NESTED_ONE_ID);
  const childTree = makeTree(
    () => NESTED_ONE_ID,
    {
      agentId: DIRECT_CHILD_ID,
      parentAgentId: null,
      depth: 1,
      managementEnabled: true,
      templateId: "direct",
      name: "直接父",
    },
  );
  const directChildActor = actor(DIRECT_CHILD_ID);
  const initial = childTree.getSupervisionSubtreeSnapshot(directChildActor);
  assert.equal(initial.ok, true, JSON.stringify(initial));
  if (!initial.ok) return;

  const channels = channelPair(initial.data.nodes);
  const managedNode = new ManagedFakeNode();
  const supervisor = new RpcSupervisor({
    controller: rootTree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "direct", name: "直接父" },
    managedNode,
    channel: channels.parent,
    startupTimeoutMs: 1_000,
    gracefulShutdownMs: 1_000,
  });
  const abort = new AbortController();
  const staleSnapshotCaptured = signal();
  const releaseStaleSnapshot = signal();
  const reservationApplied = signal();
  const releaseReservationResponse = signal();
  let publisher: SubtreePublisher<AgentSnapshot, AppliedLifecycleFact> | undefined;
  let controlClient: SupervisorControlClient | undefined;
  let controlServer: SupervisorControlServer | undefined;
  let reservation: ReturnType<RemoteTreeAuthorityPort["reserveChild"]> | undefined;
  try {
    const startup = supervisor.start();
    await channels.child.bind(abort.signal);
    assert.deepEqual(await startup, {
      ok: true,
      agent_id: DIRECT_CHILD_ID,
      state: "idle",
    });
    await channels.child.waitForReady(abort.signal);
    managedNode.rpc.emitEvent({ type: "agent_start" });
    await settle();

    const rootAuthority = new RootTreeAuthority({
      tree: rootTree,
      templateSnapshot: makeTemplateSnapshot(),
    });
    const rootHandler = createRootAuthorityControlHandler(rootAuthority);
    controlServer = new SupervisorControlServer(channels.parent, async (request) => {
      const response = await rootHandler(request);
      if (request.operation === "reserve_child") {
        reservationApplied.resolve();
        await releaseReservationResponse.promise;
      }
      return response;
    });
    controlClient = new SupervisorControlClient(channels.child);
    const remoteAuthority = new RemoteTreeAuthorityPort(DIRECT_CHILD_ID, controlClient);

    let pauseNextSnapshot = false;
    const sink: SubtreeSnapshotSink<AgentSnapshot, AppliedLifecycleFact> = {
      async publishEvent(event) {
        await channels.child.publishEvent(event);
      },
      async publishSnapshot(nodes, revision) {
        if (pauseNextSnapshot) {
          pauseNextSnapshot = false;
          staleSnapshotCaptured.resolve();
          await releaseStaleSnapshot.promise;
        }
        await channels.child.publishSnapshot(nodes, revision);
      },
    };
    publisher = new SubtreePublisher<AgentSnapshot, AppliedLifecycleFact>({
      read: () => {
        const current = childTree.getSupervisionSubtreeSnapshot(directChildActor);
        if (!current.ok) throw new Error("子树读取失败");
        return {
          nodes: current.data.nodes,
          subtreeRevision: current.data.tree_revision + 1,
        };
      },
      onChange: (listener) => childTree.onChange(listener),
      onLifecycleEvent: (listener) => childTree.onLifecycleEvent(listener),
    }, sink);
    await publisher.start({
      nodes: initial.data.nodes,
      subtreeRevision: initial.data.tree_revision + 1,
    });

    // 快照已经读取但尚未分配监督帧序号。随后 reserve_child 先在根权威
    // 登记 starting 身份，旧快照因而合法地暂时不包含这个新孙节点。
    pauseNextSnapshot = true;
    const usage = childTree.updateContextUsage(DIRECT_CHILD_ID, {
      context_window_tokens: 16_384,
      context_usage_percent: 10,
    });
    assert.equal(usage.ok && usage.data.applied, true, JSON.stringify(usage));
    await staleSnapshotCaptured.promise;

    reservation = remoteAuthority.reserveChild(directChildActor, {
      template_id: "nested",
      template_revision: 1,
      name: "孙代理",
    });
    await reservationApplied.promise;
    releaseStaleSnapshot.resolve();
    await publisher.flush();
    await settle();

    const directStatus = rootTree.getStatus(DIRECT_CHILD_ID);
    assert.equal(directStatus.ok, true, JSON.stringify(directStatus));
    if (directStatus.ok) {
      assert.equal(directStatus.data.state, "working", JSON.stringify(directStatus));
      assert.notEqual(directStatus.data.error?.code, "protocol_mismatch", JSON.stringify(directStatus));
    }

    releaseReservationResponse.resolve();
    const granted = await reservation;
    assert.equal(granted.ok, true, JSON.stringify(granted));
    const grandchildStatus = rootTree.getStatus(NESTED_ONE_ID);
    assert.equal(grandchildStatus.ok, true, JSON.stringify(grandchildStatus));
    if (grandchildStatus.ok) assert.equal(grandchildStatus.data.state, "starting");
  } finally {
    releaseStaleSnapshot.resolve();
    releaseReservationResponse.resolve();
    await reservation?.catch(() => undefined);
    controlClient?.close();
    controlServer?.close();
    await publisher?.close().catch(() => {});
    await channels.child.release().catch(() => {});
    await channels.parent.release().catch(() => {});
  }
});

test("尚未投影的授权进入回滚屏障时仍可暂时缺席", () => {
  const allocated = [DIRECT_CHILD_ID, NESTED_ONE_ID];
  let allocation = 0;
  const tree = makeTree(() => allocated[allocation++] ?? NESTED_ONE_ID);
  const direct = tree.reserveStartingChild(ROOT_TREE_ACTOR, {
    templateId: "direct",
    name: "直接父",
  });
  assert.equal(direct.ok, true, JSON.stringify(direct));
  apply(tree, DIRECT_CHILD_ID, "startup_ready");
  const nested = tree.reserveStartingChild(actor(DIRECT_CHILD_ID), {
    templateId: "nested",
    name: "孙代理",
  });
  assert.equal(nested.ok, true, JSON.stringify(nested));
  const barrier = tree.beginTerminationBarrier(actor(DIRECT_CHILD_ID), NESTED_ONE_ID);
  assert.equal(barrier.ok, true, JSON.stringify(barrier));

  const directStatus = tree.getStatus(DIRECT_CHILD_ID);
  assert.equal(directStatus.ok, true, JSON.stringify(directStatus));
  if (!directStatus.ok) return;
  const stale = tree.applySubtreeSnapshot(ROOT_TREE_ACTOR, {
    scope_agent_id: DIRECT_CHILD_ID,
    subtree_revision: 1,
    nodes: [directStatus.data],
  });
  assert.equal(stale.ok, true, JSON.stringify(stale));
});

test("已经投影的活动孙节点不能从后续完整快照消失", () => {
  const allocated = [DIRECT_CHILD_ID, NESTED_ONE_ID];
  let allocation = 0;
  const tree = makeTree(() => allocated[allocation++] ?? NESTED_ONE_ID);
  const direct = tree.reserveStartingChild(ROOT_TREE_ACTOR, {
    templateId: "direct",
    name: "直接父",
  });
  assert.equal(direct.ok, true, JSON.stringify(direct));
  apply(tree, DIRECT_CHILD_ID, "startup_ready");
  const nested = tree.reserveStartingChild(actor(DIRECT_CHILD_ID), {
    templateId: "nested",
    name: "孙代理",
  });
  assert.equal(nested.ok, true, JSON.stringify(nested));

  const directStatus = tree.getStatus(DIRECT_CHILD_ID);
  const nestedStatus = tree.getStatus(NESTED_ONE_ID);
  assert.equal(directStatus.ok, true, JSON.stringify(directStatus));
  assert.equal(nestedStatus.ok, true, JSON.stringify(nestedStatus));
  if (!directStatus.ok || !nestedStatus.ok) return;

  const projected = tree.applySubtreeSnapshot(ROOT_TREE_ACTOR, {
    scope_agent_id: DIRECT_CHILD_ID,
    subtree_revision: 1,
    nodes: [directStatus.data, nestedStatus.data],
  });
  assert.equal(projected.ok, true, JSON.stringify(projected));

  const omitted = tree.applySubtreeSnapshot(ROOT_TREE_ACTOR, {
    scope_agent_id: DIRECT_CHILD_ID,
    subtree_revision: 2,
    nodes: [directStatus.data],
  });
  assert.equal(omitted.ok, false, JSON.stringify(omitted));
  if (!omitted.ok) assert.equal(omitted.error.code, "invalid_argument");
});

test("孙节点同修订上下文观测分歧不使直接父协议失败", async () => {
  const allocated = [DIRECT_CHILD_ID, NESTED_ONE_ID];
  let allocation = 0;
  const rootTree = makeTree(() => allocated[allocation++] ?? NESTED_ONE_ID);
  const childTree = makeTree(
    () => NESTED_ONE_ID,
    {
      agentId: DIRECT_CHILD_ID,
      parentAgentId: null,
      depth: 1,
      managementEnabled: true,
      templateId: "direct",
      name: "直接父",
    },
  );
  const directChildActor = actor(DIRECT_CHILD_ID);
  const initial = childTree.getSupervisionSubtreeSnapshot(directChildActor);
  assert.equal(initial.ok, true, JSON.stringify(initial));
  if (!initial.ok) return;

  const channels = channelPair(initial.data.nodes);
  const managedNode = new ManagedFakeNode();
  const supervisor = new RpcSupervisor({
    controller: rootTree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "direct", name: "直接父" },
    managedNode,
    channel: channels.parent,
    startupTimeoutMs: 1_000,
    gracefulShutdownMs: 1_000,
  });
  const abort = new AbortController();
  let publisher: SubtreePublisher<AgentSnapshot, AppliedLifecycleFact> | undefined;
  try {
    const startup = supervisor.start();
    await channels.child.bind(abort.signal);
    assert.deepEqual(await startup, {
      ok: true,
      agent_id: DIRECT_CHILD_ID,
      state: "idle",
    });
    await channels.child.waitForReady(abort.signal);
    managedNode.rpc.emitEvent({ type: "agent_start" });
    await settle();

    const nested = rootTree.reserveStartingChild(directChildActor, {
      templateId: "nested",
      name: "孙代理",
    });
    assert.equal(nested.ok, true, JSON.stringify(nested));
    if (!nested.ok) return;
    const adopted = childTree.adoptSpawnGrant(directChildActor, {
      node: nested.data.node,
      lifecycle_generation: nested.data.lifecycle_generation,
      management_enabled: true,
    });
    assert.equal(adopted.ok, true, JSON.stringify(adopted));

    apply(rootTree, NESTED_ONE_ID, "startup_ready");
    apply(childTree, NESTED_ONE_ID, "startup_ready");
    const rootUsage = rootTree.updateContextUsage(NESTED_ONE_ID, {
      context_window_tokens: 16_384,
      context_usage_percent: 10,
    });
    const childUsage = childTree.updateContextUsage(NESTED_ONE_ID, {
      context_window_tokens: 32_768,
      context_usage_percent: 20,
    });
    assert.equal(rootUsage.ok && rootUsage.data.applied, true, JSON.stringify(rootUsage));
    assert.equal(childUsage.ok && childUsage.data.applied, true, JSON.stringify(childUsage));
    const rootBefore = rootTree.getStatus(NESTED_ONE_ID);
    const childBefore = childTree.getStatus(NESTED_ONE_ID);
    assert.equal(rootBefore.ok, true, JSON.stringify(rootBefore));
    assert.equal(childBefore.ok, true, JSON.stringify(childBefore));
    if (!rootBefore.ok || !childBefore.ok) return;
    assert.equal(rootBefore.data.revision, childBefore.data.revision);
    assert.notEqual(rootBefore.data.context_window_tokens, childBefore.data.context_window_tokens);

    publisher = new SubtreePublisher<AgentSnapshot, AppliedLifecycleFact>({
      read: () => {
        const current = childTree.getSupervisionSubtreeSnapshot(directChildActor);
        if (!current.ok) throw new Error("子树读取失败");
        return {
          nodes: current.data.nodes,
          subtreeRevision: current.data.tree_revision + 1,
        };
      },
      onChange: (listener) => childTree.onChange(listener),
      onLifecycleEvent: (listener) => childTree.onLifecycleEvent(listener),
    }, channels.child);
    await publisher.start();
    await settle();

    const directStatus = rootTree.getStatus(DIRECT_CHILD_ID);
    assert.equal(directStatus.ok, true, JSON.stringify(directStatus));
    if (directStatus.ok) {
      assert.equal(directStatus.data.state, "working", JSON.stringify(directStatus));
      assert.notEqual(directStatus.data.error?.code, "protocol_mismatch", JSON.stringify(directStatus));
    }
    const nestedStatus = rootTree.getStatus(NESTED_ONE_ID);
    assert.equal(nestedStatus.ok, true, JSON.stringify(nestedStatus));
    if (nestedStatus.ok) {
      assert.equal(nestedStatus.data.state, "idle");
      assert.equal(nestedStatus.data.revision, childBefore.data.revision);
      assert.equal(nestedStatus.data.context_window_tokens, 32_768);
      assert.equal(nestedStatus.data.context_usage_percent, 20);
      assert.equal(nestedStatus.data.created_at, rootBefore.data.created_at);
      assert.equal(nestedStatus.data.working_elapsed_ms, rootBefore.data.working_elapsed_ms);
    }
  } finally {
    await publisher?.close().catch(() => {});
    await channels.child.release().catch(() => {});
    await channels.parent.release().catch(() => {});
  }
});

test("孙节点同修订生命周期差异仍被拒绝", () => {
  const allocated = [DIRECT_CHILD_ID, NESTED_ONE_ID];
  let allocation = 0;
  const tree = makeTree(() => allocated[allocation++] ?? NESTED_ONE_ID);
  const direct = tree.reserveStartingChild(ROOT_TREE_ACTOR, {
    templateId: "direct",
    name: "直接父",
  });
  assert.equal(direct.ok, true, JSON.stringify(direct));
  apply(tree, DIRECT_CHILD_ID, "startup_ready");
  const nested = tree.reserveStartingChild(actor(DIRECT_CHILD_ID), {
    templateId: "nested",
    name: "孙代理",
  });
  assert.equal(nested.ok, true, JSON.stringify(nested));
  apply(tree, NESTED_ONE_ID, "startup_ready");

  const directStatus = tree.getStatus(DIRECT_CHILD_ID);
  const nestedStatus = tree.getStatus(NESTED_ONE_ID);
  assert.equal(directStatus.ok, true, JSON.stringify(directStatus));
  assert.equal(nestedStatus.ok, true, JSON.stringify(nestedStatus));
  if (!directStatus.ok || !nestedStatus.ok) return;

  const rejected = tree.applySubtreeSnapshot(ROOT_TREE_ACTOR, {
    scope_agent_id: DIRECT_CHILD_ID,
    subtree_revision: 1,
    nodes: [
      directStatus.data,
      {
        ...nestedStatus.data,
        state: "working",
        activity: { phase: "processing" },
      },
    ],
  });
  assert.equal(rejected.ok, false, JSON.stringify(rejected));
  if (!rejected.ok) assert.equal(rejected.error.code, "invalid_argument");
});

test("子代理关闭孙代理时屏障前在途快照不使直接父协议失败", async () => {
  const allocated = [DIRECT_CHILD_ID, NESTED_ONE_ID];
  let allocation = 0;
  const rootTree = makeTree(() => allocated[allocation++] ?? NESTED_ONE_ID);
  const childTree = makeTree(
    () => NESTED_ONE_ID,
    {
      agentId: DIRECT_CHILD_ID,
      parentAgentId: null,
      depth: 1,
      managementEnabled: true,
      templateId: "direct",
      name: "直接父",
    },
  );
  const directChildActor = actor(DIRECT_CHILD_ID);
  const initial = childTree.getSupervisionSubtreeSnapshot(directChildActor);
  assert.equal(initial.ok, true, JSON.stringify(initial));
  if (!initial.ok) return;

  const channels = channelPair(initial.data.nodes);
  const managedNode = new ManagedFakeNode();
  const supervisor = new RpcSupervisor({
    controller: rootTree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "direct", name: "直接父" },
    managedNode,
    channel: channels.parent,
    startupTimeoutMs: 1_000,
    gracefulShutdownMs: 1_000,
  });
  const abort = new AbortController();
  let publisher: SubtreePublisher<AgentSnapshot, AppliedLifecycleFact> | undefined;
  let controlClient: SupervisorControlClient | undefined;
  let controlServer: SupervisorControlServer | undefined;
  let childController: AgentController | undefined;
  let grandchildSupervisor: ClosableGrandchildSupervisor | undefined;
  const staleSnapshotCaptured = signal();
  const releaseStaleSnapshot = signal();
  try {
    const startup = supervisor.start();
    await channels.child.bind(abort.signal);
    assert.deepEqual(await startup, {
      ok: true,
      agent_id: DIRECT_CHILD_ID,
      state: "idle",
    });
    await channels.child.waitForReady(abort.signal);
    managedNode.rpc.emitEvent({ type: "agent_start" });
    await settle();

    const rootAuthority = new RootTreeAuthority({
      tree: rootTree,
      templateSnapshot: makeTemplateSnapshot(),
    });
    controlServer = new SupervisorControlServer(
      channels.parent,
      createRootAuthorityControlHandler(rootAuthority),
    );
    controlClient = new SupervisorControlClient(channels.child);
    const remoteAuthority = new RemoteTreeAuthorityPort(DIRECT_CHILD_ID, controlClient);

    let pauseNextSnapshot = false;
    const sink: SubtreeSnapshotSink<AgentSnapshot, AppliedLifecycleFact> = {
      async publishEvent(event) {
        await channels.child.publishEvent(event);
      },
      async publishSnapshot(nodes, revision) {
        if (pauseNextSnapshot) {
          pauseNextSnapshot = false;
          staleSnapshotCaptured.resolve();
          await releaseStaleSnapshot.promise;
        }
        await channels.child.publishSnapshot(nodes, revision);
      },
    };
    publisher = new SubtreePublisher<AgentSnapshot, AppliedLifecycleFact>({
      read: () => {
        const current = childTree.getSupervisionSubtreeSnapshot(directChildActor);
        if (!current.ok) throw new Error("子树读取失败");
        return {
          nodes: current.data.nodes,
          subtreeRevision: current.data.tree_revision + 1,
        };
      },
      onChange: (listener) => childTree.onChange(listener),
      onLifecycleEvent: (listener) => childTree.onLifecycleEvent(listener),
    }, sink);
    await publisher.start({
      nodes: initial.data.nodes,
      subtreeRevision: initial.data.tree_revision + 1,
    });

    childController = new AgentController({
      tree: childTree,
      actor: directChildActor,
      authority: remoteAuthority,
      templateSnapshot: makeTemplateSnapshot(),
      createSupervisor: (input) => {
        assert.ok(input.grant !== undefined);
        grandchildSupervisor = new ClosableGrandchildSupervisor(
          childTree,
          input.grant.node.agent_id,
        );
        return grandchildSupervisor;
      },
    });
    const spawned = await childController.spawnAgent({
      template_id: "nested",
      name: "孙代理",
    });
    assert.equal(spawned.ok, true, JSON.stringify(spawned));
    assert.ok(grandchildSupervisor !== undefined);
    await publisher.flush();
    await settle();

    const rootGrandchildBefore = rootTree.getStatus(NESTED_ONE_ID);
    assert.equal(rootGrandchildBefore.ok, true, JSON.stringify(rootGrandchildBefore));
    if (rootGrandchildBefore.ok) assert.equal(rootGrandchildBefore.data.state, "idle");

    // 发布器已经读取 idle 投影但尚未写入；随后 begin_termination 先在根建立屏障。
    // 这是控制帧与快照共用通道、但权威响应和本地投影分属两个方向时的合法交错。
    pauseNextSnapshot = true;
    const usage = childTree.updateContextUsage(NESTED_ONE_ID, {
      context_window_tokens: 16_384,
      context_usage_percent: 10,
    });
    assert.equal(usage.ok && usage.data.applied, true, JSON.stringify(usage));
    await staleSnapshotCaptured.promise;

    const terminating = childController.terminateAgent(NESTED_ONE_ID);
    await grandchildSupervisor.terminationStarted.promise;
    const rootDuringBarrier = rootTree.getStatus(NESTED_ONE_ID);
    assert.equal(rootDuringBarrier.ok, true, JSON.stringify(rootDuringBarrier));
    if (rootDuringBarrier.ok) assert.equal(rootDuringBarrier.data.state, "terminating");

    releaseStaleSnapshot.resolve();
    await settle();
    grandchildSupervisor.permitTermination.resolve();
    const terminated = await terminating;
    assert.equal(terminated.ok, true, JSON.stringify(terminated));
    await publisher.flush();
    await settle();

    const directStatus = rootTree.getStatus(DIRECT_CHILD_ID);
    assert.equal(directStatus.ok, true, JSON.stringify(directStatus));
    if (directStatus.ok) {
      assert.equal(directStatus.data.state, "working", JSON.stringify(directStatus));
      assert.notEqual(directStatus.data.error?.code, "protocol_mismatch", JSON.stringify(directStatus));
    }
    const grandchildStatus = rootTree.getStatus(NESTED_ONE_ID);
    assert.equal(grandchildStatus.ok, true, JSON.stringify(grandchildStatus));
    if (grandchildStatus.ok) {
      assert.equal(grandchildStatus.data.state, "terminated");
      assert.equal(grandchildStatus.data.termination_result, "completed");
    }
  } finally {
    releaseStaleSnapshot.resolve();
    grandchildSupervisor?.permitTermination.resolve();
    await childController?.shutdown().catch(() => false);
    controlClient?.close();
    controlServer?.close();
    await publisher?.close().catch(() => {});
    await channels.child.release().catch(() => {});
    await channels.parent.release().catch(() => {});
  }
});

test("嵌套子生命周期快速收敛时直接父保持健康并合并完整快照", async () => {
  const allocated = [DIRECT_CHILD_ID, NESTED_ONE_ID, NESTED_TWO_ID];
  let allocation = 0;
  const rootTree = makeTree(() => allocated[allocation++] ?? NESTED_TWO_ID);
  const childTree = makeTree(
    () => NESTED_TWO_ID,
    {
      agentId: DIRECT_CHILD_ID,
      parentAgentId: null,
      depth: 1,
      managementEnabled: true,
      templateId: "direct",
      name: "直接父",
    },
  );
  const directChildActor = actor(DIRECT_CHILD_ID);
  const initial = childTree.getSupervisionSubtreeSnapshot(directChildActor);
  assert.equal(initial.ok, true, JSON.stringify(initial));
  if (!initial.ok) return;

  const channels = channelPair(initial.data.nodes);
  const supervisor = new RpcSupervisor({
    controller: rootTree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "direct", name: "直接父" },
    managedNode: new ManagedFakeNode(),
    channel: channels.parent,
    startupTimeoutMs: 1_000,
    gracefulShutdownMs: 1_000,
  });
  const abort = new AbortController();
  let publisher: SubtreePublisher<unknown, AppliedLifecycleFact> | undefined;
  try {
    const startup = supervisor.start();
    await channels.child.bind(abort.signal);
    assert.deepEqual(await startup, {
      ok: true,
      agent_id: DIRECT_CHILD_ID,
      state: "idle",
    });
    await channels.child.waitForReady(abort.signal);

    const nestedOne = rootTree.reserveStartingChild(directChildActor, {
      templateId: "nested",
      name: "嵌套一",
    });
    const nestedTwo = rootTree.reserveStartingChild(directChildActor, {
      templateId: "nested",
      name: "嵌套二",
    });
    assert.equal(nestedOne.ok, true, JSON.stringify(nestedOne));
    assert.equal(nestedTwo.ok, true, JSON.stringify(nestedTwo));
    if (!nestedOne.ok || !nestedTwo.ok) return;

    for (const grant of [nestedOne.data, nestedTwo.data]) {
      const adopted = childTree.adoptSpawnGrant(directChildActor, {
        node: grant.node,
        lifecycle_generation: grant.lifecycle_generation,
        management_enabled: true,
      });
      assert.equal(adopted.ok, true, JSON.stringify(adopted));
    }

    publisher = new SubtreePublisher<unknown, AppliedLifecycleFact>({
      read: () => {
        const snapshot = childTree.getSupervisionSubtreeSnapshot(directChildActor);
        if (!snapshot.ok) throw new Error("子树读取失败");
        return {
          nodes: snapshot.data.nodes,
          subtreeRevision: snapshot.data.tree_revision + 1,
        };
      },
      onChange: (listener) => childTree.onChange(listener),
      onLifecycleEvent: (listener) => childTree.onLifecycleEvent(listener),
    }, channels.child);
    await publisher.start();
    await settle();

    for (const nestedId of [NESTED_ONE_ID, NESTED_TWO_ID]) {
      const status = rootTree.getStatus(nestedId);
      assert.equal(status.ok, true, JSON.stringify(status));
      if (status.ok) assert.equal(status.data.state, "starting");
    }

    // 所有事实在同一个同步监督回合中应用。发布器可以合并完整快照，
    // 但根仍必须逐条观察已经应用的生命周期事实。
    for (const nestedId of [NESTED_ONE_ID, NESTED_TWO_ID]) {
      apply(childTree, nestedId, "startup_ready");
      apply(childTree, nestedId, "agent_start");
      apply(childTree, nestedId, "agent_settled");
      apply(childTree, nestedId, "terminate_accepted");
      apply(childTree, nestedId, "resources_confirmed");
    }
    await publisher.flush();
    await settle();

    const directStatus = rootTree.getStatus(DIRECT_CHILD_ID);
    assert.equal(directStatus.ok, true, JSON.stringify(directStatus));
    if (directStatus.ok) {
      assert.equal(directStatus.data.state, "idle", JSON.stringify(directStatus));
      assert.notEqual(directStatus.data.error?.code, "protocol_mismatch", JSON.stringify(directStatus));
    }
    for (const nestedId of [NESTED_ONE_ID, NESTED_TWO_ID]) {
      const status = rootTree.getStatus(nestedId);
      assert.equal(status.ok, true, JSON.stringify(status));
      if (status.ok) {
        assert.equal(status.data.state, "terminated");
        assert.equal(status.data.termination_result, "completed");
      }
    }
  } finally {
    await publisher?.close().catch(() => {});
    await channels.child.release().catch(() => {});
    await channels.parent.release().catch(() => {});
  }
});
