import assert from "node:assert/strict";
import test from "node:test";
import {
  ROOT_TREE_ACTOR,
  TreeController,
  isCanonicalUuid,
  isCanonicalUuidV4,
  type ControlResult,
} from "../src/tree-controller.ts";

const currentGeneration = new WeakMap<TreeController, Map<string, number>>();

function rememberOutcome(
  tree: TreeController,
  outcome: { readonly node: { readonly agent_id: string }; readonly lifecycle_generation: number },
): void {
  let generations = currentGeneration.get(tree);
  if (generations === undefined) {
    generations = new Map();
    currentGeneration.set(tree, generations);
  }
  generations.set(outcome.node.agent_id, outcome.lifecycle_generation);
}

function applyEvent(
  tree: TreeController,
  agentId: string,
  event: Record<string, unknown>,
): ReturnType<TreeController["applyLifecycleEvent"]> {
  const generations = currentGeneration.get(tree);
  const expectedGeneration = generations?.get(agentId);
  assert.notEqual(expectedGeneration, undefined);
  const result = tree.applyLifecycleEvent(agentId, {
    ...event,
    expected_generation: expectedGeneration,
  });
  if (result.ok) rememberOutcome(tree, result.data);
  return result;
}

const FIRST_ID = "550e8400-e29b-41d4-a716-446655440000";
const SECOND_ID = "550e8400-e29b-41d4-a716-446655440001";
const THIRD_ID = "550e8400-e29b-41d4-a716-446655440002";

function expectSuccess<T>(result: ControlResult<T>): T {
  if (!result.ok) assert.fail(result.error.code);
  return result.data;
}

function expectFailure<T>(result: ControlResult<T>, code: string): void {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected a failed control result");
  assert.equal(result.error.code, code);
  assert.deepEqual(result.error.details, {});
  assert.doesNotMatch(JSON.stringify(result.error), /secret|path|stack|token/i);
}

function controller(
  ids: readonly string[] = [FIRST_ID, SECOND_ID, THIRD_ID],
  overrides: Partial<ConstructorParameters<typeof TreeController>[0]> = {},
): TreeController {
  let index = 0;
  let tick = 0;
  return new TreeController({
    config: {
      maxDepth: 2,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 16,
      waitTimeoutMs: 60_000,
    },
    idFactory: () => ids[index++] ?? "550e8400-e29b-41d4-a716-4466554400ff",
    now: () => new Date(Date.UTC(2026, 0, 2, 3, 4, 5, tick++)),
    ...overrides,
  });
}

function reserveRootChild(tree: TreeController, name = "研究代理") {
  const outcome = expectSuccess(tree.reserveStartingChild(ROOT_TREE_ACTOR, {
    templateId: "researcher",
    name,
  }));
  rememberOutcome(tree, outcome);
  return outcome;
}

test("创建原子预留 canonical UUID v4、直接父关系与初始 starting 快照", () => {
  const tree = controller();
  const created = reserveRootChild(tree);

  assert.equal(created.node.agent_id, FIRST_ID);
  assert.equal(created.node.parent_agent_id, null);
  assert.equal(created.node.depth, 1);
  assert.equal(created.node.state, "starting");
  assert.equal(created.node.pending_message_count, 0);
  assert.equal(created.node.revision, 1);
  assert.match(created.node.observed_at, /^2026-01-02T03:04:05\.000Z$/);
  assert.equal(created.lifecycle_generation, 0);
  assert.equal(created.tree_revision, 1);
  assert.equal(isCanonicalUuid(created.node.agent_id), true);
  assert.equal(isCanonicalUuidV4(created.node.agent_id), true);
  assert.equal(expectSuccess(tree.getQuotaSnapshot()).active_tree_agents, 1);
  assert.equal(expectSuccess(tree.getQuotaSnapshot()).active_children_of_root, 1);
  assert.doesNotMatch(JSON.stringify(created), /cwd|environment|credential|handle|stack/i);
});

test("工厂产生的重复或非 v4 标识不会覆盖终止记录或被公开", () => {
  const tree = controller([
    FIRST_ID.toUpperCase(),
    FIRST_ID,
    FIRST_ID,
    SECOND_ID,
  ]);
  const first = reserveRootChild(tree);
  expectSuccess(applyEvent(tree, first.node.agent_id, { type: "termination_requested" }));
  expectSuccess(applyEvent(tree, first.node.agent_id, { type: "resources_confirmed" }));

  const second = reserveRootChild(tree, "第二代理");
  assert.equal(first.node.agent_id, FIRST_ID);
  assert.equal(second.node.agent_id, SECOND_ID);
  assert.equal(expectSuccess(tree.getStatus(FIRST_ID)).state, "terminated");
});

test("深度、直接子代理和全树名额在创建前同步裁决，完整回收后才释放", () => {
  const directQuota = controller([FIRST_ID, SECOND_ID], {
    config: {
      maxDepth: 3,
      maxChildrenPerAgent: 1,
      maxAgentsPerTree: 3,
      waitTimeoutMs: 60_000,
    },
  });
  const first = reserveRootChild(directQuota);
  expectFailure(
    directQuota.reserveStartingChild(ROOT_TREE_ACTOR, { templateId: "writer", name: "第二代理" }),
    "max_children_reached",
  );
  expectSuccess(applyEvent(directQuota, first.node.agent_id, { type: "termination_requested" }));
  expectSuccess(applyEvent(directQuota, first.node.agent_id, { type: "resources_confirmed" }));
  assert.equal(reserveRootChild(directQuota, "回收后代理").node.agent_id, SECOND_ID);

  const treeQuota = controller([FIRST_ID, SECOND_ID, THIRD_ID], {
    config: {
      maxDepth: 3,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 2,
      waitTimeoutMs: 60_000,
    },
  });
  reserveRootChild(treeQuota);
  reserveRootChild(treeQuota, "第二代理");
  expectFailure(
    treeQuota.reserveStartingChild(ROOT_TREE_ACTOR, { templateId: "writer", name: "第三代理" }),
    "max_tree_agents_reached",
  );

  const depthQuota = controller([FIRST_ID, SECOND_ID], {
    config: {
      maxDepth: 1,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 4,
      waitTimeoutMs: 60_000,
    },
  });
  const leaf = reserveRootChild(depthQuota);
  expectSuccess(applyEvent(depthQuota, leaf.node.agent_id, { type: "startup_ready" }));
  expectFailure(
    depthQuota.reserveStartingChild({ kind: "agent", agent_id: leaf.node.agent_id }, {
      templateId: "writer",
      name: "越界后代",
    }),
    "max_depth_reached",
  );
});

test("管理能力沿直接父、模板禁用与深度逐级收窄，不能由后代重新开启", () => {
  const tree = controller([FIRST_ID, SECOND_ID], {
    config: {
      maxDepth: 3,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 4,
      waitTimeoutMs: 60_000,
    },
  });
  const disabled = expectSuccess(tree.reserveStartingChild(ROOT_TREE_ACTOR, {
    templateId: "leaf-template",
    name: "叶代理",
    subagents: "disabled",
  }));
  rememberOutcome(tree, disabled);
  expectSuccess(applyEvent(tree, disabled.node.agent_id, { type: "startup_ready" }));

  assert.equal(expectSuccess(tree.getManagementCapability(ROOT_TREE_ACTOR)).enabled, true);
  assert.equal(
    expectSuccess(tree.getManagementCapability({ kind: "agent", agent_id: disabled.node.agent_id })).enabled,
    false,
  );
  expectFailure(
    tree.reserveStartingChild({ kind: "agent", agent_id: disabled.node.agent_id }, {
      templateId: "attempted-reenable",
      name: "不应创建",
      subagents: "inherit",
    }),
    "template_capability_unavailable",
  );
});

test("生命周期只接受七态的合法事实，状态代际会丢弃迟到事件", () => {
  const tree = controller();
  const created = reserveRootChild(tree);
  const id = created.node.agent_id;

  expectFailure(tree.applyLifecycleEvent(id, { type: "startup_ready" }), "invalid_argument");

  const ready = expectSuccess(tree.applyLifecycleEvent(id, {
    type: "startup_ready",
    expected_generation: created.lifecycle_generation,
  }));
  rememberOutcome(tree, ready);
  assert.equal(ready.applied, true);
  assert.equal(ready.node.state, "idle");
  assert.equal(ready.node.revision, 2);

  const stale = expectSuccess(tree.applyLifecycleEvent(id, {
    type: "startup_failed",
    expected_generation: created.lifecycle_generation,
    error_code: "spawn_failed",
  }));
  assert.equal(stale.applied, false);
  assert.equal(stale.node.state, "idle");
  assert.equal(stale.node.revision, 2);

  const prompt = expectSuccess(applyEvent(tree, id, { type: "prompt_accepted" }));
  assert.equal(prompt.node.state, "working");
  const firstWorkingGeneration = prompt.lifecycle_generation;
  const interrupted = expectSuccess(applyEvent(tree, id, { type: "interrupt_accepted" }));
  assert.equal(interrupted.node.state, "interrupting");
  const abortResponse = expectSuccess(applyEvent(tree, id, { type: "abort_completed" }));
  assert.equal(abortResponse.applied, false);
  assert.equal(abortResponse.node.state, "interrupting");
  assert.equal(expectSuccess(applyEvent(tree, id, { type: "agent_settled" })).node.state, "idle");

  expectSuccess(applyEvent(tree, id, { type: "message_admitted" }));
  const nextPrompt = expectSuccess(applyEvent(tree, id, { type: "prompt_accepted" }));
  assert.equal(nextPrompt.node.state, "working");
  const oldSettle = expectSuccess(tree.applyLifecycleEvent(id, {
    type: "agent_settled",
    expected_generation: firstWorkingGeneration,
  }));
  assert.equal(oldSettle.applied, false);
  assert.equal(oldSettle.node.state, "working");

  expectSuccess(applyEvent(tree, id, { type: "runtime_failed", error_code: "spawn_failed" }));
  const failed = expectSuccess(tree.getStatus(id));
  assert.equal(failed.state, "failed");
  const ignoredSettle = expectSuccess(applyEvent(tree, id, { type: "agent_settled" }));
  assert.equal(ignoredSettle.applied, false);
  assert.equal(ignoredSettle.node.state, "failed");
});

test("启动失败保留失败事实，终止屏障和资源确认完成后才释放预留名额", () => {
  const tree = controller();
  const created = reserveRootChild(tree);
  const id = created.node.agent_id;

  const failed = expectSuccess(applyEvent(tree, id, {
    type: "startup_failed",
    error_code: "spawn_timeout",
  }));
  assert.equal(failed.node.state, "failed");
  assert.equal(failed.node.error?.code, "spawn_timeout");
  assert.equal(expectSuccess(tree.getQuotaSnapshot()).active_tree_agents, 1);

  const terminating = expectSuccess(applyEvent(tree, id, { type: "termination_requested" }));
  assert.equal(terminating.node.state, "terminating");
  assert.equal(expectSuccess(tree.getQuotaSnapshot()).active_tree_agents, 1);

  const terminated = expectSuccess(applyEvent(tree, id, { type: "resources_confirmed" }));
  assert.equal(terminated.node.state, "terminated");
  assert.equal(expectSuccess(tree.getQuotaSnapshot()).active_tree_agents, 0);
});

test("生命周期时间从 idle 线性化点开始，并在故障后由单调时钟冻结", () => {
  let monotonic = 0;
  const tree = controller([FIRST_ID], {
    monotonicNow: () => {
      monotonic += 100;
      return monotonic;
    },
  });
  const created = reserveRootChild(tree);
  assert.equal(expectSuccess(tree.getStatus(created.node.agent_id)).created_at, undefined);
  const ready = expectSuccess(applyEvent(tree, created.node.agent_id, { type: "startup_ready" }));
  assert.match(ready.node.created_at ?? "", /Z$/);
  assert.equal(typeof ready.node.lifecycle_elapsed_ms, "number");
  const active = expectSuccess(tree.getStatus(created.node.agent_id));
  assert.equal((active.lifecycle_elapsed_ms ?? 0) >= (ready.node.lifecycle_elapsed_ms ?? 0), true);

  const failed = expectSuccess(applyEvent(tree, created.node.agent_id, {
    type: "runtime_failed",
    error_code: "spawn_failed",
  }));
  const frozen = failed.node.lifecycle_elapsed_ms;
  assert.equal(typeof frozen, "number");
  const later = expectSuccess(tree.getStatus(created.node.agent_id));
  assert.equal(later.lifecycle_elapsed_ms, frozen);

  const terminating = expectSuccess(applyEvent(tree, created.node.agent_id, {
    type: "termination_requested",
  }));
  assert.equal(terminating.node.state, "terminating");
  assert.equal((terminating.node.lifecycle_elapsed_ms ?? 0) >= (frozen ?? 0), true);
  const duringCleanup = expectSuccess(tree.getStatus(created.node.agent_id));
  assert.equal((duringCleanup.lifecycle_elapsed_ms ?? 0) > (terminating.node.lifecycle_elapsed_ms ?? 0), true);

  const terminated = expectSuccess(applyEvent(tree, created.node.agent_id, {
    type: "resources_confirmed",
  }));
  const terminatedElapsed = terminated.node.lifecycle_elapsed_ms;
  assert.equal(terminated.node.state, "terminated");
  assert.equal(typeof terminatedElapsed, "number");
  assert.equal(expectSuccess(tree.getStatus(created.node.agent_id)).lifecycle_elapsed_ms, terminatedElapsed);
});

test("pending、revision、observed_at 与 tree_revision 只在公开事实变化时更新", () => {
  const tree = controller();
  const created = reserveRootChild(tree);
  const id = created.node.agent_id;
  expectSuccess(applyEvent(tree, id, { type: "startup_ready" }));
  const idle = expectSuccess(tree.getStatus(id));
  const beforeTreeRevision = expectSuccess(tree.getTreeSnapshot()).tree_revision;

  const admitted = expectSuccess(applyEvent(tree, id, { type: "message_admitted" }));
  assert.equal(admitted.node.state, "idle");
  assert.equal(admitted.node.pending_message_count, 1);
  assert.equal(admitted.node.revision, idle.revision + 1);
  assert.match(admitted.node.observed_at, /^2026-01-02T03:04:05\.\d{3}Z$/);
  assert.equal(admitted.tree_revision, beforeTreeRevision + 1);

  const accepted = expectSuccess(applyEvent(tree, id, { type: "prompt_accepted" }));
  assert.equal(accepted.node.state, "working");
  assert.equal(accepted.node.pending_message_count, 0);
  const noChangeRevision = accepted.node.revision;
  const noChangeTreeRevision = accepted.tree_revision;
  const duplicate = expectSuccess(applyEvent(tree, id, { type: "prompt_accepted" }));
  assert.equal(duplicate.applied, false);
  assert.equal(duplicate.node.revision, noChangeRevision);
  assert.equal(duplicate.tree_revision, noChangeTreeRevision);

  expectSuccess(applyEvent(tree, id, { type: "message_admitted" }));
  const failed = expectSuccess(applyEvent(tree, id, { type: "runtime_failed", error_code: "spawn_failed" }));
  assert.equal(failed.node.state, "failed");
  assert.equal(failed.node.pending_message_count, 0);
  assert.equal(failed.node.error?.code, "spawn_failed");
  assert.equal(failed.node.error?.message, "代理启动失败");
  assert.equal(failed.node.error?.retryable, false);
  assert.match(failed.node.error?.observed_at ?? "", /Z$/);
  assert.doesNotMatch(JSON.stringify(failed.node), /secret|path|stack/i);

  const treeSnapshot = expectSuccess(tree.getTreeSnapshot());
  assert.equal(treeSnapshot.tree_revision, failed.tree_revision);
  assert.match(treeSnapshot.observed_at, /Z$/);
  assert.deepEqual(treeSnapshot.nodes.map((node) => node.agent_id), [id]);
});

test("终止屏障不可逆，父节点必须等已登记后代确认回收后才能进入 terminated", () => {
  const tree = controller();
  const parent = reserveRootChild(tree);
  expectSuccess(applyEvent(tree, parent.node.agent_id, { type: "startup_ready" }));
  const child = expectSuccess(tree.reserveStartingChild({ kind: "agent", agent_id: parent.node.agent_id }, {
    templateId: "worker",
    name: "子代理",
  }));
  rememberOutcome(tree, child);

  expectSuccess(applyEvent(tree, parent.node.agent_id, { type: "termination_requested" }));
  expectFailure(
    tree.reserveStartingChild({ kind: "agent", agent_id: parent.node.agent_id }, {
      templateId: "late",
      name: "迟到创建",
    }),
    "agent_unavailable",
  );
  expectSuccess(applyEvent(tree, parent.node.agent_id, { type: "termination_incomplete" }));
  const parentTerminating = expectSuccess(tree.getStatus(parent.node.agent_id));
  assert.equal(parentTerminating.state, "terminating");
  assert.equal(parentTerminating.error?.code, "termination_incomplete");
  assert.equal(parentTerminating.error?.message, "代理资源尚未完全回收");
  assert.equal(parentTerminating.error?.retryable, true);
  const repeatedBarrier = expectSuccess(applyEvent(tree, parent.node.agent_id, {
    type: "termination_requested",
  }));
  assert.equal(repeatedBarrier.applied, false);
  assert.equal(repeatedBarrier.node.error?.code, "termination_incomplete");
  const premature = expectSuccess(applyEvent(tree, parent.node.agent_id, { type: "resources_confirmed" }));
  assert.equal(premature.applied, false);

  expectSuccess(applyEvent(tree, child.node.agent_id, { type: "termination_requested" }));
  expectSuccess(applyEvent(tree, child.node.agent_id, { type: "resources_confirmed" }));
  const terminated = expectSuccess(applyEvent(tree, parent.node.agent_id, { type: "resources_confirmed" }));
  assert.equal(terminated.node.state, "terminated");
  assert.equal(terminated.node.pending_message_count, 0);
  assert.equal(terminated.node.error, undefined);
  assert.equal(expectSuccess(tree.getQuotaSnapshot()).active_tree_agents, 0);
  assert.equal(expectSuccess(tree.getStatus(parent.node.agent_id)).state, "terminated");
});

test("定向标识按 canonical 格式与注册表分流，直接父检查不授予越级控制", () => {
  const tree = controller();
  const parent = reserveRootChild(tree);
  expectSuccess(applyEvent(tree, parent.node.agent_id, { type: "startup_ready" }));
  const child = expectSuccess(tree.reserveStartingChild({ kind: "agent", agent_id: parent.node.agent_id }, {
    templateId: "worker",
    name: "子代理",
  }));
  rememberOutcome(tree, child);

  expectFailure(tree.getStatus("agent_123"), "invalid_argument");
  expectFailure(tree.getStatus("550e8400-e29b-41d4-a716-4466554400aa"), "agent_not_found");
  expectFailure(tree.getStatus("00000000-0000-0000-0000-000000000000"), "agent_not_found");
  expectFailure(tree.assertDirectChild(ROOT_TREE_ACTOR, child.node.agent_id), "not_direct_child");
  assert.equal(
    expectSuccess(tree.assertDirectChild({ kind: "agent", agent_id: parent.node.agent_id }, child.node.agent_id)).agent_id,
    child.node.agent_id,
  );
});
