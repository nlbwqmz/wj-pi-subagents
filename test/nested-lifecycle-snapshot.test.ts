import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  FakeRpcClient,
  RpcSupervisor,
} from "../src/rpc-supervisor.ts";
import type {
  ExitObservation,
  ResourceObservation,
} from "../src/process-tree-capability.ts";
import { SubtreePublisher } from "../src/subtree-publisher.ts";
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
  type AppliedLifecycleFact,
  type TreeActor,
} from "../src/tree-controller.ts";

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

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

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
