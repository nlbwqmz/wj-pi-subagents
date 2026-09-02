import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentController,
  type AgentSupervisor,
  type AgentSupervisorFactoryInput,
} from "../src/agent-controller.ts";
import { ParentWaitBatchCoordinator } from "../src/parent-wait-batch-coordinator.ts";
import type {
  RpcSupervisorCommandResult,
  RpcSupervisorEvent,
  RpcSupervisorInterruptResult,
  RpcSupervisorStartupResult,
  RpcSupervisorTerminationResult,
} from "../src/rpc-supervisor.ts";
import {
  ROOT_TREE_ACTOR,
  TreeController,
} from "../src/tree-controller.ts";

const FIRST_AGENT_ID = "550e8400-e29b-41d4-a716-446655440000";
const SECOND_AGENT_ID = "550e8400-e29b-41d4-a716-446655440001";

class BatchTestSupervisor implements AgentSupervisor {
  private readonly listeners = new Set<(event: RpcSupervisorEvent) => void>();
  private readonly agentId: string;
  private readonly tree: TreeController;
  private readonly input: AgentSupervisorFactoryInput;

  constructor(
    agentId: string,
    tree: TreeController,
    input: AgentSupervisorFactoryInput,
  ) {
    this.agentId = agentId;
    this.tree = tree;
    this.input = input;
  }

  start(): Promise<RpcSupervisorStartupResult> {
    const reserved = this.tree.reserveStartingChild(ROOT_TREE_ACTOR, this.input.reservation);
    assert.equal(reserved.ok, true);
    this.tree.applyLifecycleEvent(this.agentId, {
      type: "startup_ready",
      expected_generation: 0,
    });
    return Promise.resolve({ ok: true, agent_id: this.agentId, state: "idle" });
  }

  sendMessage(_message: string): Promise<RpcSupervisorCommandResult> {
    return Promise.resolve({ ok: true, accepted: true });
  }

  interrupt(): Promise<RpcSupervisorInterruptResult> {
    return Promise.resolve({ ok: true, accepted: true, changed: true });
  }

  terminate(): Promise<RpcSupervisorTerminationResult> {
    return Promise.resolve({
      ok: true,
      agent_id: this.agentId,
      state: "terminated",
      cleanup: "confirmed",
    });
  }

  onEvent(listener: (event: RpcSupervisorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  wasForcedTerminationUsed(): boolean {
    return false;
  }
}

function makeController(): {
  readonly controller: AgentController;
  readonly tree: TreeController;
} {
  const agentIds = [FIRST_AGENT_ID, SECOND_AGENT_ID];
  let allocated = 0;
  let supervised = 0;
  const tree = new TreeController({
    config: {
      maxDepth: 3,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 8,
      waitTimeoutMs: 10_000,
    },
    idFactory: () => agentIds[allocated++]!,
  });
  const controller = new AgentController({
    tree,
    allowUnvalidatedTemplates: true,
    createSupervisor: (input) => new BatchTestSupervisor(agentIds[supervised++]!, tree, input),
  });
  return { controller, tree };
}

function generation(tree: TreeController, agentId: string): number {
  const result = tree.getLifecycleGeneration(agentId);
  assert.equal(result.ok, true);
  return result.data;
}

function batchContext(): unknown {
  return {
    sessionManager: {
      getBranch: () => [{
        type: "message",
        id: "assistant-message-1",
        message: {
          role: "assistant",
          content: [{
            type: "toolCall",
            id: "wait-call-1",
            name: "wait_agent",
            arguments: { agent_ids: [FIRST_AGENT_ID], timeout_ms: "30000" },
          }, {
            type: "toolCall",
            id: "wait-call-2",
            name: "wait_agent",
            arguments: { agent_ids: [SECOND_AGENT_ID], timeout_ms: "30000" },
          }],
        },
      }],
    },
  };
}

function customBatchContext(
  firstIds: readonly string[],
  secondIds: readonly string[],
): unknown {
  return {
    sessionManager: {
      getBranch: () => [{
        type: "message",
        id: "assistant-message-large",
        message: {
          role: "assistant",
          content: [{
            type: "toolCall",
            id: "wait-call-large-1",
            name: "wait_agent",
            arguments: { agent_ids: firstIds, timeout_ms: "30000" },
          }, {
            type: "toolCall",
            id: "wait-call-large-2",
            name: "wait_agent",
            arguments: { agent_ids: secondIds, timeout_ms: "30000" },
          }],
        },
      }],
    },
  };
}

function stubController(
  waitAgents: (input: unknown, signal?: AbortSignal) => Promise<unknown>,
): AgentController {
  return {
    waitAgents,
    getAgentStatus: () => ({ ok: true, data: {} }),
    getWaitTimeoutMs: () => 60_000,
  } as unknown as AgentController;
}

function generatedAgentId(index: number): string {
  return `00000000-0000-0000-0000-${index.toString(16).padStart(12, "0")}`;
}

test("wait_agent 批次 timeout 按各调用重投影目标 ID", async () => {
  const calls: unknown[] = [];
  const controller = stubController(async (input) => {
    calls.push(input);
    const value = input as { readonly agent_ids: readonly string[] };
    return {
      ok: true,
      data: { agent_ids: value.agent_ids, outcome: "timeout" },
    };
  });
  const coordinator = new ParentWaitBatchCoordinator();
  const context = batchContext();
  const first = coordinator.wait(
    controller,
    "wait-call-1",
    { agent_ids: [FIRST_AGENT_ID], timeout_ms: 30_000 },
    undefined,
    context,
  );
  const second = coordinator.wait(
    controller,
    "wait-call-2",
    { agent_ids: [SECOND_AGENT_ID], timeout_ms: 30_000 },
    undefined,
    context,
  );
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(calls.length, 1);
  assert.equal(firstResult.ok, true);
  assert.equal(secondResult.ok, true);
  if (firstResult.ok) assert.deepEqual(firstResult.data, {
    agent_ids: [FIRST_AGENT_ID],
    outcome: "timeout",
  });
  if (secondResult.ok) assert.deepEqual(secondResult.data, {
    agent_ids: [SECOND_AGENT_ID],
    outcome: "timeout",
  });
});

test("wait_agent 批次 union 超过目标上限时退回独立调用", async () => {
  const firstIds = Array.from({ length: 64 }, (_, index) => generatedAgentId(index));
  const secondIds = Array.from({ length: 64 }, (_, index) => generatedAgentId(index + 64));
  const calls: unknown[] = [];
  const controller = stubController(async (input) => {
    calls.push(input);
    const value = input as { readonly agent_ids: readonly string[] };
    return {
      ok: true,
      data: { agent_ids: value.agent_ids, outcome: "timeout" },
    };
  });
  const coordinator = new ParentWaitBatchCoordinator();
  const result = await coordinator.wait(
    controller,
    "wait-call-large-1",
    { agent_ids: firstIds, timeout_ms: 30_000 },
    undefined,
    customBatchContext(firstIds, secondIds),
  );

  assert.equal(calls.length, 1);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.outcome, "timeout");
    assert.deepEqual(result.data.agent_ids, firstIds);
  }
});

test("wait_agent 批次对 persisted raw 和 prepared timeout 使用同一规范值", async () => {
  const { controller, tree } = makeController();
  const firstSpawn = await controller.spawnAgent({ template_id: "demo", name: "first" });
  const secondSpawn = await controller.spawnAgent({ template_id: "demo", name: "second" });
  assert.equal(firstSpawn.ok, true);
  assert.equal(secondSpawn.ok, true);

  for (const agentId of [FIRST_AGENT_ID, SECOND_AGENT_ID]) {
    tree.applyLifecycleEvent(agentId, {
      type: "agent_start",
      expected_generation: generation(tree, agentId),
    });
  }

  const coordinator = new ParentWaitBatchCoordinator();
  const abort = new AbortController();
  const guard = setTimeout(() => abort.abort(), 500);
  const context = batchContext();
  try {
    const first = coordinator.wait(
      controller,
      "wait-call-1",
      { agent_ids: [FIRST_AGENT_ID], timeout_ms: 30_000 },
      abort.signal,
      context,
    );
    const second = coordinator.wait(
      controller,
      "wait-call-2",
      { agent_ids: [SECOND_AGENT_ID], timeout_ms: 30_000 },
      abort.signal,
      context,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(controller.notifySessionEvent(FIRST_AGENT_ID, "reply"), true);

    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.ok, true);
    assert.equal(secondResult.ok, true);
    if (firstResult.ok) {
      assert.equal(firstResult.data.outcome, "reply");
      assert.equal("agent_id" in firstResult.data && firstResult.data.agent_id, FIRST_AGENT_ID);
    }
    if (secondResult.ok) {
      assert.deepEqual(secondResult.data, {
        agent_ids: [SECOND_AGENT_ID],
        outcome: "batch_released",
        released_by_agent_id: FIRST_AGENT_ID,
        released_by_outcome: "reply",
      });
    }
  } finally {
    clearTimeout(guard);
    coordinator.clear();
    controller.dispose();
  }
});
