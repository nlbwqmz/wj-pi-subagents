import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentController,
  type AgentSupervisor,
} from "../src/agent-controller.ts";
import {
  ROOT_TREE_ACTOR,
  TreeController,
  type AgentLifecycleEvent,
  type ControlResult,
  type LifecycleEventOutcome,
  type ReserveStartingChildInput,
  type TerminationBarrierOutcome,
  type TreeActor,
} from "../src/tree-controller.ts";
import type {
  RpcSupervisorCommandResult,
  RpcSupervisorEvent,
  RpcSupervisorInterruptResult,
  RpcSupervisorStartupResult,
  RpcSupervisorTerminationResult,
} from "../src/rpc-supervisor.ts";
import type {
  AgentTemplateListItem,
  TemplateDefinition,
} from "../src/template-discovery-snapshot.ts";
import type {
  AuthorityControlAction,
  ControlAdmission,
  ResolvedTemplateGrant,
  SpawnGrant,
  TreeAuthorityPort,
} from "../src/tree-authority.ts";

const DIRECT_ID = "550e8400-e29b-41d4-a716-446655440000";
const GRANDCHILD_ID = "550e8400-e29b-41d4-a716-446655440001";

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function actor(agentId: string): TreeActor {
  return Object.freeze({ kind: "agent" as const, agent_id: agentId });
}

function makeTree(): TreeController {
  const ids = [DIRECT_ID, GRANDCHILD_ID];
  let next = 0;
  return new TreeController({
    config: {
      maxDepth: 3,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 8,
      waitTimeoutMs: 10_000,
    },
    idFactory: () => ids[next++] ?? GRANDCHILD_ID,
  });
}

function generation(tree: TreeController, agentId: string): number {
  const result = tree.getLifecycleGeneration(agentId);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
}

class BoundarySupervisor implements AgentSupervisor {
  private readonly listeners = new Set<(event: RpcSupervisorEvent) => void>();
  private readonly tree: TreeController;
  private readonly order: string[] | undefined;
  private reservation: ReserveStartingChildInput | undefined;
  private grant: SpawnGrant | undefined;
  private agentId: string | undefined;

  constructor(tree: TreeController, order?: string[]) {
    this.tree = tree;
    this.order = order;
  }

  configure(input: { readonly reservation: ReserveStartingChildInput; readonly grant?: SpawnGrant }): void {
    this.reservation = input.reservation;
    this.grant = input.grant;
  }

  async start(): Promise<RpcSupervisorStartupResult> {
    if (this.grant === undefined) {
      assert.ok(this.reservation !== undefined);
      const reserved = this.tree.reserveStartingChild(ROOT_TREE_ACTOR, this.reservation);
      assert.equal(reserved.ok, true, JSON.stringify(reserved));
      if (!reserved.ok) return { ok: false, code: "internal_error" };
      this.agentId = reserved.data.node.agent_id;
    } else {
      this.agentId = this.grant.node.agent_id;
    }
    const ready = this.tree.applyLifecycleEvent(this.agentId, {
      type: "startup_ready",
      expected_generation: generation(this.tree, this.agentId),
    });
    assert.equal(ready.ok, true, JSON.stringify(ready));
    assert.equal(ready.ok && ready.data.applied, true, JSON.stringify(ready));
    return { ok: true, agent_id: this.agentId, state: "idle" };
  }

  async sendMessage(_message: string): Promise<RpcSupervisorCommandResult> {
    return { ok: true, accepted: true };
  }

  async interrupt(): Promise<RpcSupervisorInterruptResult> {
    return { ok: true, accepted: false, changed: false };
  }

  async terminate(): Promise<RpcSupervisorTerminationResult> {
    return {
      ok: true,
      agent_id: this.agentId ?? DIRECT_ID,
      state: "terminated",
      cleanup: "confirmed",
    };
  }

  async reapOrphanedDescendants(): Promise<{ readonly confirmed: boolean; readonly forced: boolean }> {
    this.order?.push("reap");
    return { confirmed: true, forced: false };
  }

  onEvent(listener: (event: RpcSupervisorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  wasForcedTerminationUsed(): boolean {
    return false;
  }

  emit(eventAgentId: string, event: AgentLifecycleEvent): void {
    const emitted: RpcSupervisorEvent = Object.freeze({
      kind: "lifecycle",
      agent_id: eventAgentId,
      event,
    });
    for (const listener of this.listeners) listener(emitted);
  }
}

function makeAuthority(
  tree: TreeController,
  order: string[],
  confirmationSeen: Deferred,
): TreeAuthorityPort {
  const template: TemplateDefinition = Object.freeze({
    templateId: "managed",
    source: "project",
    templateDirectory: ".",
    description: "测试模板",
    tools: undefined,
    extensions: undefined,
    allowSubagents: true,
    contextFiles: false,
    systemPromptMode: "append",
    body: "",
  });
  return {
    async listTemplates(_actor: TreeActor): Promise<ControlResult<readonly AgentTemplateListItem[]>> {
      return { ok: true, data: [] };
    },
    async resolveTemplate(
      _actor: TreeActor,
      _templateId: string,
    ): Promise<ControlResult<ResolvedTemplateGrant>> {
      return { ok: true, data: { template, template_revision: 1 } };
    },
    async reserveChild(
      actorValue: TreeActor,
      input: { readonly template_id: string; readonly template_revision: number; readonly name: string },
    ): Promise<ControlResult<SpawnGrant>> {
      const reserved = tree.reserveStartingChild(actorValue, {
        templateId: input.template_id,
        name: input.name,
        allowSubagents: true,
      });
      if (!reserved.ok) return reserved;
      return {
        ok: true,
        data: {
          node: reserved.data.node,
          lifecycle_generation: reserved.data.lifecycle_generation,
          tree_revision: reserved.data.tree_revision,
          template_revision: input.template_revision,
          management_enabled: true,
        },
      };
    },
    async admitControl(
      actorValue: TreeActor,
      agentId: string,
      action: AuthorityControlAction,
    ): Promise<ControlResult<ControlAdmission>> {
      const target = tree.assertDirectChild(actorValue, agentId);
      if (!target.ok) return target;
      return {
        ok: true,
        data: { action, node: target.data, tree_revision: target.data.revision },
      };
    },
    async beginTermination(
      actorValue: TreeActor,
      agentId: string,
    ): Promise<ControlResult<TerminationBarrierOutcome>> {
      return tree.beginTerminationBarrier(actorValue, agentId);
    },
    async confirmResources(
      _actorValue: TreeActor,
      agentId: string,
    ): Promise<ControlResult<LifecycleEventOutcome>> {
      order.push("confirm");
      confirmationSeen.resolve();
      return tree.confirmTerminationBarrierResources(agentId, true);
    },
  };
}

test("TreeController 只发布真正应用的生命周期事实", () => {
  const tree = makeTree();
  const facts: unknown[] = [];
  tree.onLifecycleEvent((fact) => facts.push(fact));
  const reserved = tree.reserveStartingChild(ROOT_TREE_ACTOR, {
    templateId: "managed",
    name: "直接子",
  });
  assert.equal(reserved.ok, true, JSON.stringify(reserved));

  const applied = tree.applyLifecycleEvent(DIRECT_ID, {
    type: "startup_ready",
    expected_generation: 0,
  });
  const stale = tree.applyLifecycleEvent(DIRECT_ID, {
    type: "agent_start",
    expected_generation: 0,
  });
  const invalid = tree.applyLifecycleEvent(DIRECT_ID, {
    type: "startup_ready",
    expected_generation: 1,
  });

  assert.equal(applied.ok && applied.data.applied, true, JSON.stringify(applied));
  assert.equal(stale.ok && stale.data.applied, false, JSON.stringify(stale));
  assert.equal(invalid.ok && invalid.data.applied, false, JSON.stringify(invalid));
  assert.deepEqual(facts, [{
    agent_id: DIRECT_ID,
    type: "startup_ready",
    expected_generation: 0,
  }]);
});

test("孙节点生命周期事件保留真实身份，不把故障通知归因给直接父", async () => {
  const tree = makeTree();
  let supervisor!: BoundarySupervisor;
  const terminalIds: string[] = [];
  const controller = new AgentController({
    tree,
    allowUnvalidatedTemplates: true,
    createSupervisor: (input) => {
      supervisor = new BoundarySupervisor(tree);
      supervisor.configure(input);
      return supervisor;
    },
    onTerminal: (agentId) => {
      terminalIds.push(agentId);
    },
  });

  const spawned = await controller.spawnAgent({ template_id: "managed", name: "直接父" });
  assert.equal(spawned.ok, true, JSON.stringify(spawned));
  const nested = tree.reserveStartingChild(actor(DIRECT_ID), {
    templateId: "managed",
    name: "孙节点",
  });
  assert.equal(nested.ok, true, JSON.stringify(nested));

  const nestedReady = tree.applyLifecycleEvent(GRANDCHILD_ID, {
    type: "startup_ready",
    expected_generation: generation(tree, GRANDCHILD_ID),
  });
  assert.equal(nestedReady.ok && nestedReady.data.applied, true, JSON.stringify(nestedReady));
  const nestedFailureGeneration = generation(tree, GRANDCHILD_ID);
  const nestedFailure = tree.applyLifecycleEvent(GRANDCHILD_ID, {
    type: "runtime_failed",
    expected_generation: nestedFailureGeneration,
  });
  const directFailure = tree.applyLifecycleEvent(DIRECT_ID, {
    type: "runtime_failed",
    expected_generation: generation(tree, DIRECT_ID),
  });
  assert.equal(directFailure.ok && directFailure.data.applied, true, JSON.stringify(directFailure));
  assert.equal(nestedFailure.ok && nestedFailure.data.applied, true, JSON.stringify(nestedFailure));

  // 孙节点故障事实的 expected_generation + 1 与直接父当前代际同为 2；
  // 旧实现若丢失 agent_id，会把它错误解释为直接父的已应用故障，
  // 并发送直接父 terminal 通知。
  supervisor.emit(GRANDCHILD_ID, {
    type: "runtime_failed",
    expected_generation: nestedFailureGeneration,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(terminalIds, []);
  const directStatus = tree.getStatus(DIRECT_ID);
  const nestedStatus = tree.getStatus(GRANDCHILD_ID);
  assert.equal(directStatus.ok && directStatus.data.state, "failed");
  assert.equal(nestedStatus.ok && nestedStatus.data.state, "terminating");
});

test("故障后代回收在根 confirmResources 前先刷新上行生命周期事实", async () => {
  const tree = makeTree();
  const order: string[] = [];
  const confirmationSeen = deferred();
  const authority = makeAuthority(tree, order, confirmationSeen);
  let supervisor!: BoundarySupervisor;
  const controller = new AgentController({
    tree,
    authority,
    flushUpstreamLifecycle: async () => {
      order.push("flush");
    },
    createSupervisor: (input) => {
      supervisor = new BoundarySupervisor(tree, order);
      supervisor.configure(input);
      return supervisor;
    },
  });

  const spawned = await controller.spawnAgent({ template_id: "managed", name: "故障父" });
  assert.equal(spawned.ok, true, JSON.stringify(spawned));
  const nested = tree.reserveStartingChild(actor(DIRECT_ID), {
    templateId: "managed",
    name: "故障后代",
  });
  assert.equal(nested.ok, true, JSON.stringify(nested));

  const failed = tree.applyLifecycleEvent(DIRECT_ID, {
    type: "runtime_failed",
    expected_generation: generation(tree, DIRECT_ID),
  });
  assert.equal(failed.ok && failed.data.applied, true, JSON.stringify(failed));
  supervisor.emit(DIRECT_ID, {
    type: "runtime_failed",
    expected_generation: failed.ok ? failed.data.lifecycle_generation - 1 : 0,
  });
  await confirmationSeen.promise;

  assert.deepEqual(order, ["reap", "flush", "confirm"]);
  const nestedStatus = tree.getStatus(GRANDCHILD_ID);
  assert.equal(nestedStatus.ok && nestedStatus.data.state, "terminated");
  const directStatus = tree.getStatus(DIRECT_ID);
  assert.equal(directStatus.ok && directStatus.data.state, "failed");
});
