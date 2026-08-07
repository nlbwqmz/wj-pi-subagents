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
const FOURTH_ID = "550e8400-e29b-41d4-a716-446655440003";

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
  assert.equal("observed_at" in created.node, false);
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

test("启动失败立即建立终止屏障，资源确认完成后才释放预留名额", () => {
  const tree = controller();
  const created = reserveRootChild(tree);
  const id = created.node.agent_id;

  const failed = expectSuccess(applyEvent(tree, id, {
    type: "startup_failed",
    error_code: "spawn_timeout",
  }));
  assert.equal(failed.node.state, "terminating");
  assert.equal(failed.node.error?.code, "spawn_timeout");
  assert.equal(expectSuccess(tree.getQuotaSnapshot()).active_tree_agents, 1);

  const terminating = expectSuccess(applyEvent(tree, id, { type: "termination_requested" }));
  assert.equal(terminating.applied, false);
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

test("pending、revision 与 tree_revision 只在公开事实变化时更新", () => {
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
  assert.equal("observed_at" in (failed.node.error ?? {}), false);
  assert.doesNotMatch(JSON.stringify(failed.node), /secret|path|stack/i);

  const treeSnapshot = expectSuccess(tree.getTreeSnapshot());
  assert.equal(treeSnapshot.tree_revision, failed.tree_revision);
  assert.equal("observed_at" in treeSnapshot, false);
  assert.deepEqual(treeSnapshot.nodes.map((node) => node.agent_id), [id]);
});

test("安全活动只以固定类别和非负计数原子进入树快照", () => {
  const tree = controller();
  const created = reserveRootChild(tree);
  const id = created.node.agent_id;
  expectSuccess(applyEvent(tree, id, { type: "startup_ready" }));
  const before = expectSuccess(tree.getTreeSnapshot());

  const started = expectSuccess(tree.updateActivity(id, {
    category: "editing",
    active_count: 2,
  }));
  assert.deepEqual(started.node.activity, { category: "editing", active_count: 2 });
  assert.equal(started.node.revision, before.nodes[0]!.revision + 1);
  assert.equal(started.tree_revision, before.tree_revision + 1);

  expectFailure(tree.updateActivity(id, {
    category: "editing",
    active_count: 3,
    path: "C:\\secret-canary\\private.txt",
  }), "invalid_argument");
  assert.doesNotMatch(JSON.stringify(expectSuccess(tree.getTreeSnapshot())), /secret-canary|private\.txt/i);

  const finished = expectSuccess(tree.updateActivity(id, {
    category: "editing",
    active_count: 0,
  }));
  assert.equal(finished.node.activity, undefined);
});

test("starting 节点不接纳活动，递归快照也不能注入不可能的生命周期组合", () => {
  const tree = controller();
  const created = reserveRootChild(tree);

  const ignored = expectSuccess(tree.updateActivity(created.node.agent_id, {
    category: "running",
    active_count: 1,
  }));
  assert.equal(ignored.applied, false);
  assert.equal(ignored.node.activity, undefined);

  expectFailure(tree.applySubtreeSnapshot(ROOT_TREE_ACTOR, {
    scope_agent_id: created.node.agent_id,
    subtree_revision: 1,
    nodes: Object.freeze([Object.freeze({
      ...created.node,
      activity: Object.freeze({ category: "running" as const, active_count: 1 }),
    })]),
  }), "invalid_argument");

  expectFailure(tree.applySubtreeSnapshot(ROOT_TREE_ACTOR, {
    scope_agent_id: created.node.agent_id,
    subtree_revision: 1,
    nodes: Object.freeze([Object.freeze({
      ...created.node,
      state: "failed" as const,
      error: Object.freeze({
        code: "internal_error" as const,
        message: "D:\\private\\secret-canary.txt",
        retryable: false,
      }),
    })]),
  }), "invalid_argument");
  assert.doesNotMatch(JSON.stringify(expectSuccess(tree.getTreeSnapshot())), /private|secret-canary/i);
});

test("并行活动类别结束时保留仍在运行的安全摘要", () => {
  const tree = controller();
  const created = reserveRootChild(tree);
  const id = created.node.agent_id;
  expectSuccess(applyEvent(tree, id, { type: "startup_ready" }));

  expectSuccess(tree.updateActivity(id, { category: "editing", active_count: 1 }));
  expectSuccess(tree.updateActivity(id, { category: "reading", active_count: 1 }));
  const oneFinished = expectSuccess(tree.updateActivity(id, { category: "reading", active_count: 0 }));
  assert.deepEqual(oneFinished.node.activity, { category: "editing", active_count: 1 });

  const allFinished = expectSuccess(tree.updateActivity(id, { category: "editing", active_count: 0 }));
  assert.equal(allFinished.node.activity, undefined);
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

test("子树终止屏障在一个树修订中固定成员并按后代优先返回", () => {
  const ids = [FIRST_ID, SECOND_ID, THIRD_ID];
  let index = 0;
  const tree = controller(ids, {
    config: {
      maxDepth: 3,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 16,
      waitTimeoutMs: 60_000,
    },
  });
  const parent = reserveRootChild(tree, "父代理");
  expectSuccess(applyEvent(tree, parent.node.agent_id, { type: "startup_ready" }));
  const child = expectSuccess(tree.reserveStartingChild(
    { kind: "agent", agent_id: parent.node.agent_id },
    { templateId: "child", name: "子代理" },
  ));
  rememberOutcome(tree, child);
  expectSuccess(applyEvent(tree, child.node.agent_id, { type: "startup_ready" }));
  const grandchild = expectSuccess(tree.reserveStartingChild(
    { kind: "agent", agent_id: child.node.agent_id },
    { templateId: "grandchild", name: "孙代理" },
  ));
  rememberOutcome(tree, grandchild);
  expectSuccess(applyEvent(tree, grandchild.node.agent_id, { type: "startup_ready" }));
  assert.equal(index, 0);

  const before = expectSuccess(tree.getTreeSnapshot()).tree_revision;
  const barrier = expectSuccess(tree.beginTerminationBarrier(ROOT_TREE_ACTOR, parent.node.agent_id));
  assert.deepEqual(barrier.agent_ids, [grandchild.node.agent_id, child.node.agent_id, parent.node.agent_id]);
  assert.equal(barrier.tree_revision, before + 1);
  assert.equal(barrier.changed, true);
  assert.deepEqual(
    expectSuccess(tree.getTreeSnapshot()).nodes.map((node) => [node.agent_id, node.state]),
    [
      [parent.node.agent_id, "terminating"],
      [child.node.agent_id, "terminating"],
      [grandchild.node.agent_id, "terminating"],
    ],
  );
  expectFailure(
    tree.reserveStartingChild({ kind: "agent", agent_id: parent.node.agent_id }, {
      templateId: "late",
      name: "迟到创建",
    }),
    "agent_unavailable",
  );

  const repeated = expectSuccess(tree.beginTerminationBarrier(ROOT_TREE_ACTOR, parent.node.agent_id));
  assert.equal(repeated.changed, false);
  assert.equal(repeated.tree_revision, barrier.tree_revision);
  assert.deepEqual(repeated.agent_ids, barrier.agent_ids);
});

test("终止记录固定保留完成、失败终止与清理不完整结果", () => {
  const tree = controller([FIRST_ID, SECOND_ID, THIRD_ID]);
  const completed = reserveRootChild(tree, "正常完成");
  const failed = reserveRootChild(tree, "故障后终止");
  const incomplete = reserveRootChild(tree, "清理重试后终止");
  for (const outcome of [completed, failed, incomplete]) {
    expectSuccess(applyEvent(tree, outcome.node.agent_id, { type: "startup_ready" }));
  }

  expectSuccess(applyEvent(tree, completed.node.agent_id, { type: "termination_requested" }));
  expectSuccess(applyEvent(tree, completed.node.agent_id, { type: "resources_confirmed" }));

  expectSuccess(applyEvent(tree, failed.node.agent_id, {
    type: "runtime_failed",
    error_code: "internal_error",
  }));
  expectSuccess(applyEvent(tree, failed.node.agent_id, { type: "termination_requested" }));
  expectSuccess(applyEvent(tree, failed.node.agent_id, { type: "resources_confirmed" }));

  expectSuccess(applyEvent(tree, incomplete.node.agent_id, { type: "termination_requested" }));
  expectSuccess(applyEvent(tree, incomplete.node.agent_id, { type: "termination_incomplete" }));
  expectSuccess(applyEvent(tree, incomplete.node.agent_id, { type: "resources_confirmed" }));

  assert.deepEqual(
    expectSuccess(tree.getTreeSnapshot()).nodes.map((node) => ({
      name: node.name,
      state: node.state,
      termination_result: node.termination_result,
      error: node.error,
    })),
    [
      { name: "正常完成", state: "terminated", termination_result: "completed", error: undefined },
      { name: "故障后终止", state: "terminated", termination_result: "failed", error: undefined },
      { name: "清理重试后终止", state: "terminated", termination_result: "incomplete", error: undefined },
    ],
  );
});

test("运行故障先保留父节点 failed，并为全部后代建立防孤儿屏障", () => {
  const tree = controller([FIRST_ID, SECOND_ID, THIRD_ID], {
    config: {
      maxDepth: 3,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 16,
      waitTimeoutMs: 60_000,
    },
  });
  const parent = reserveRootChild(tree, "故障父");
  expectSuccess(applyEvent(tree, parent.node.agent_id, { type: "startup_ready" }));
  const child = expectSuccess(tree.reserveStartingChild(
    { kind: "agent", agent_id: parent.node.agent_id },
    { templateId: "child", name: "孤儿子" },
  ));
  rememberOutcome(tree, child);
  expectSuccess(applyEvent(tree, child.node.agent_id, { type: "startup_ready" }));
  const grandchild = expectSuccess(tree.reserveStartingChild(
    { kind: "agent", agent_id: child.node.agent_id },
    { templateId: "grandchild", name: "孤儿孙" },
  ));
  rememberOutcome(tree, grandchild);
  expectSuccess(applyEvent(tree, grandchild.node.agent_id, { type: "startup_ready" }));

  const failed = expectSuccess(applyEvent(tree, parent.node.agent_id, {
    type: "runtime_failed",
    error_code: "internal_error",
  }));
  assert.equal(failed.node.state, "failed");
  assert.equal(expectSuccess(tree.getStatus(child.node.agent_id)).state, "terminating");
  assert.equal(expectSuccess(tree.getStatus(grandchild.node.agent_id)).state, "terminating");
  expectFailure(
    tree.reserveStartingChild({ kind: "agent", agent_id: child.node.agent_id }, {
      templateId: "late",
      name: "孤儿迟到",
    }),
    "agent_unavailable",
  );
});

test("父端拒绝把既有兄弟节点伪装为直接子树快照中的后代", () => {
  const tree = controller([FIRST_ID, SECOND_ID, THIRD_ID], {
    config: {
      maxDepth: 3,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 16,
      waitTimeoutMs: 60_000,
    },
  });
  const parent = reserveRootChild(tree, "父代理");
  expectSuccess(applyEvent(tree, parent.node.agent_id, { type: "startup_ready" }));
  const sibling = reserveRootChild(tree, "兄弟代理");
  expectSuccess(applyEvent(tree, sibling.node.agent_id, { type: "startup_ready" }));
  const child = expectSuccess(tree.reserveStartingChild(
    { kind: "agent", agent_id: parent.node.agent_id },
    { templateId: "child", name: "真实子代理" },
  ));
  rememberOutcome(tree, child);
  expectSuccess(applyEvent(tree, child.node.agent_id, { type: "startup_ready" }));

  const before = expectSuccess(tree.getTreeSnapshot());
  const parentSnapshot = expectSuccess(tree.getStatus(parent.node.agent_id));
  const childSnapshot = expectSuccess(tree.getStatus(child.node.agent_id));
  const siblingSnapshot = expectSuccess(tree.getStatus(sibling.node.agent_id));
  const forgedSibling = Object.freeze({
    ...siblingSnapshot,
    parent_agent_id: parent.node.agent_id,
    depth: parentSnapshot.depth + 1,
  });

  expectFailure(tree.applySubtreeSnapshot(ROOT_TREE_ACTOR, {
    scope_agent_id: parent.node.agent_id,
    subtree_revision: 1,
    nodes: Object.freeze([parentSnapshot, forgedSibling, childSnapshot]),
  }), "invalid_argument");
  const after = expectSuccess(tree.getTreeSnapshot());
  assert.equal(after.tree_revision, before.tree_revision);
  assert.deepEqual(
    after.nodes.map((node) => [node.agent_id, node.parent_agent_id, node.depth, node.state, node.revision]),
    before.nodes.map((node) => [node.agent_id, node.parent_agent_id, node.depth, node.state, node.revision]),
  );
});

test("child 首快照只能校验作用域根身份，不能越过直接父把 starting 提前改成 idle", () => {
  const tree = controller([FIRST_ID]);
  const parent = reserveRootChild(tree, "正在握手的直接子代理");
  const beforeTree = expectSuccess(tree.getTreeSnapshot());
  const before = expectSuccess(tree.getStatus(parent.node.agent_id));
  assert.equal(before.state, "starting");

  const accepted = expectSuccess(tree.applySubtreeSnapshot(ROOT_TREE_ACTOR, {
    scope_agent_id: parent.node.agent_id,
    subtree_revision: 1,
    nodes: Object.freeze([Object.freeze({
      ...before,
      state: "idle" as const,
      pending_message_count: 7,
      revision: before.revision + 100,
    })]),
  }));

  assert.equal(accepted.applied, false);
  assert.equal(accepted.subtree_revision, 1);
  assert.equal(accepted.tree_revision, beforeTree.tree_revision);
  const after = expectSuccess(tree.getStatus(parent.node.agent_id));
  assert.deepEqual(after, before);

  const ready = expectSuccess(applyEvent(tree, parent.node.agent_id, { type: "startup_ready" }));
  assert.equal(ready.node.state, "idle");
});

test("根端只合入已预留完整子树并丢弃旧修订，查询保持稳定父先顺序", () => {
  const tree = controller([FIRST_ID, SECOND_ID, THIRD_ID], {
    config: {
      maxDepth: 3,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 16,
      waitTimeoutMs: 60_000,
    },
  });
  const parent = reserveRootChild(tree, "父代理");
  expectSuccess(applyEvent(tree, parent.node.agent_id, { type: "startup_ready" }));
  const reservedChild = expectSuccess(tree.reserveStartingChild(
    { kind: "agent", agent_id: parent.node.agent_id },
    { templateId: "child", name: "递归子代理" },
  ));
  rememberOutcome(tree, reservedChild);
  expectSuccess(applyEvent(tree, reservedChild.node.agent_id, { type: "startup_ready" }));
  const before = expectSuccess(tree.getTreeSnapshot());
  const parentSnapshot = expectSuccess(tree.getStatus(parent.node.agent_id));
  const currentChild = expectSuccess(tree.getStatus(reservedChild.node.agent_id));
  const child = Object.freeze({
    ...currentChild,
    state: "working" as const,
    revision: currentChild.revision + 1,
  });
  const accepted = expectSuccess(tree.applySubtreeSnapshot(ROOT_TREE_ACTOR, {
    scope_agent_id: FIRST_ID,
    subtree_revision: 1,
    nodes: Object.freeze([parentSnapshot, child]),
  }));
  assert.equal(accepted.applied, true);
  assert.equal(accepted.tree_revision, before.tree_revision + 1);
  assert.deepEqual(expectSuccess(tree.getTreeSnapshot()).nodes.map((node) => node.agent_id), [FIRST_ID, SECOND_ID]);
  assert.deepEqual(expectSuccess(tree.getTreeSnapshotFor(ROOT_TREE_ACTOR)).nodes.map((node) => [
    node.agent_id,
    node.parent_agent_id,
    node.depth,
  ]), [
    [FIRST_ID, null, 1],
    [SECOND_ID, FIRST_ID, 2],
  ]);
  const scoped = expectSuccess(tree.getTreeSnapshotFor({ kind: "agent", agent_id: FIRST_ID }));
  assert.deepEqual(scoped.scope, { kind: "subtree", agent_id: FIRST_ID });
  assert.deepEqual(scoped.nodes.map((node) => [node.agent_id, node.parent_agent_id, node.depth]), [
    [FIRST_ID, null, 1],
    [SECOND_ID, FIRST_ID, 2],
  ]);

  const stale = expectSuccess(tree.applySubtreeSnapshot(ROOT_TREE_ACTOR, {
    scope_agent_id: FIRST_ID,
    subtree_revision: 1,
    nodes: Object.freeze([parentSnapshot]),
  }));
  assert.equal(stale.applied, false);
  assert.equal(stale.tree_revision, accepted.tree_revision);
  assert.equal(stale.subtree_revision, 1);
});

test("递归子树的活动时长从快照基线继续累计并在终态精确冻结", () => {
  let monotonic = 10_000;
  const tree = controller([FIRST_ID, SECOND_ID], {
    config: {
      maxDepth: 3,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 16,
      waitTimeoutMs: 60_000,
    },
    monotonicNow: () => monotonic,
  });
  const parent = reserveRootChild(tree, "父代理");
  expectSuccess(applyEvent(tree, parent.node.agent_id, { type: "startup_ready" }));
  const child = expectSuccess(tree.reserveStartingChild(
    { kind: "agent", agent_id: parent.node.agent_id },
    { templateId: "child", name: "递归子代理" },
  ));
  rememberOutcome(tree, child);
  expectSuccess(applyEvent(tree, child.node.agent_id, { type: "startup_ready" }));
  const parentSnapshot = expectSuccess(tree.getStatus(parent.node.agent_id));
  const childSnapshot = expectSuccess(tree.getStatus(child.node.agent_id));

  const working = Object.freeze({
    ...childSnapshot,
    state: "working" as const,
    lifecycle_elapsed_ms: 5_000,
    revision: childSnapshot.revision + 1,
  });
  expectSuccess(tree.applySubtreeSnapshot(ROOT_TREE_ACTOR, {
    scope_agent_id: parent.node.agent_id,
    subtree_revision: 1,
    nodes: Object.freeze([parentSnapshot, working]),
  }));
  assert.equal(expectSuccess(tree.getStatus(child.node.agent_id)).lifecycle_elapsed_ms, 5_000);
  monotonic = 12_000;
  assert.equal(expectSuccess(tree.getStatus(child.node.agent_id)).lifecycle_elapsed_ms, 7_000);

  const failed = Object.freeze({
    ...working,
    state: "failed" as const,
    lifecycle_elapsed_ms: 7_000,
    revision: working.revision + 1,
    error: Object.freeze({
      code: "internal_error" as const,
      message: "控制器内部错误",
      retryable: false,
    }),
  });
  expectSuccess(tree.applySubtreeSnapshot(ROOT_TREE_ACTOR, {
    scope_agent_id: parent.node.agent_id,
    subtree_revision: 2,
    nodes: Object.freeze([parentSnapshot, failed]),
  }));
  monotonic = 20_000;
  assert.equal(expectSuccess(tree.getStatus(child.node.agent_id)).lifecycle_elapsed_ms, 7_000);
});

test("递归已登记节点在批量终止后保留故障与清理不完整分类", () => {
  const tree = controller([FIRST_ID, SECOND_ID, THIRD_ID], {
    config: {
      maxDepth: 3,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 16,
      waitTimeoutMs: 60_000,
    },
  });
  const parent = reserveRootChild(tree, "递归父代理");
  expectSuccess(applyEvent(tree, parent.node.agent_id, { type: "startup_ready" }));
  const failed = expectSuccess(tree.reserveStartingChild(
    { kind: "agent", agent_id: parent.node.agent_id },
    { templateId: "failed", name: "递归故障节点" },
  ));
  rememberOutcome(tree, failed);
  expectSuccess(applyEvent(tree, failed.node.agent_id, { type: "startup_ready" }));
  const incomplete = expectSuccess(tree.reserveStartingChild(
    { kind: "agent", agent_id: parent.node.agent_id },
    { templateId: "incomplete", name: "递归清理节点" },
  ));
  rememberOutcome(tree, incomplete);
  expectSuccess(applyEvent(tree, incomplete.node.agent_id, { type: "startup_ready" }));

  const parentSnapshot = expectSuccess(tree.getStatus(parent.node.agent_id));
  const failedSnapshot = expectSuccess(tree.getStatus(failed.node.agent_id));
  const incompleteSnapshot = expectSuccess(tree.getStatus(incomplete.node.agent_id));
  expectSuccess(tree.applySubtreeSnapshot(ROOT_TREE_ACTOR, {
    scope_agent_id: parent.node.agent_id,
    subtree_revision: 1,
    nodes: Object.freeze([
      parentSnapshot,
      Object.freeze({
        ...failedSnapshot,
        state: "failed" as const,
        revision: failedSnapshot.revision + 1,
        error: Object.freeze({
          code: "internal_error" as const,
          message: "控制器内部错误",
          retryable: false,
        }),
      }),
      Object.freeze({
        ...incompleteSnapshot,
        state: "terminating" as const,
        revision: incompleteSnapshot.revision + 1,
        error: Object.freeze({
          code: "termination_incomplete" as const,
          message: "代理资源尚未完全回收",
          retryable: true,
        }),
      }),
    ]),
  }));
  assert.equal(expectSuccess(tree.getStatus(failed.node.agent_id)).termination_result, undefined);
  assert.equal(expectSuccess(tree.getStatus(incomplete.node.agent_id)).termination_result, undefined);

  expectSuccess(tree.beginTerminationBarrier(ROOT_TREE_ACTOR, parent.node.agent_id));
  expectSuccess(tree.confirmTerminationBarrierResources(parent.node.agent_id));
  assert.deepEqual(
    expectSuccess(tree.getTreeSnapshot()).nodes.map((node) => [node.name, node.termination_result]),
    [
      ["递归父代理", "completed"],
      ["递归故障节点", "failed"],
      ["递归清理节点", "incomplete"],
    ],
  );
});

test("非权威中继首次接收的故障后代在终止后保留历史分类", () => {
  const tree = controller([], {
    config: {
      maxDepth: 4,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 16,
      waitTimeoutMs: 60_000,
    },
    initialActor: {
      agentId: FIRST_ID,
      parentAgentId: null,
      depth: 1,
      templateId: "relay",
      name: "中继父代理",
      managementEnabled: true,
    },
  });
  const relayActor = Object.freeze({ kind: "agent" as const, agent_id: FIRST_ID });
  const child = expectSuccess(tree.adoptSpawnGrant(relayActor, {
    node: Object.freeze({
      agent_id: SECOND_ID,
      parent_agent_id: FIRST_ID,
      template_id: "child",
      name: "直接子代理",
      depth: 2,
      state: "starting" as const,
      pending_message_count: 0,
      revision: 1,
    }),
    lifecycle_generation: 0,
    management_enabled: true,
  }));
  expectSuccess(tree.applyLifecycleEvent(SECOND_ID, {
    type: "startup_ready",
    expected_generation: child.lifecycle_generation,
  }));
  const childSnapshot = expectSuccess(tree.getStatus(SECOND_ID));
  const failedDescendant = Object.freeze({
    agent_id: THIRD_ID,
    parent_agent_id: SECOND_ID,
    template_id: "failed",
    name: "新故障后代",
    depth: 3,
    state: "failed" as const,
    pending_message_count: 0,
    revision: 2,
    created_at: "2026-01-02T03:04:02.000Z",
    lifecycle_elapsed_ms: 5_000,
    error: Object.freeze({
      code: "internal_error" as const,
      message: "控制器内部错误",
      retryable: false,
    }),
  });
  const incompleteDescendant = Object.freeze({
    agent_id: FOURTH_ID,
    parent_agent_id: SECOND_ID,
    template_id: "incomplete",
    name: "新清理后代",
    depth: 3,
    state: "terminating" as const,
    pending_message_count: 0,
    revision: 2,
    created_at: "2026-01-02T03:04:02.000Z",
    lifecycle_elapsed_ms: 5_000,
    error: Object.freeze({
      code: "termination_incomplete" as const,
      message: "代理资源尚未完全回收",
      retryable: true,
    }),
  });
  expectSuccess(tree.applySubtreeSnapshot(relayActor, {
    scope_agent_id: SECOND_ID,
    subtree_revision: 1,
    nodes: Object.freeze([childSnapshot, failedDescendant, incompleteDescendant]),
  }));

  const childActor = Object.freeze({ kind: "agent" as const, agent_id: SECOND_ID });
  expectSuccess(tree.beginTerminationBarrier(childActor, THIRD_ID));
  expectSuccess(tree.confirmTerminationBarrierResources(THIRD_ID));
  expectSuccess(tree.beginTerminationBarrier(childActor, FOURTH_ID));
  expectSuccess(tree.confirmTerminationBarrierResources(FOURTH_ID));
  assert.deepEqual(
    [THIRD_ID, FOURTH_ID].map((agentId) => {
      const node = expectSuccess(tree.getStatus(agentId));
      return [node.name, node.termination_result];
    }),
    [
      ["新故障后代", "failed"],
      ["新清理后代", "incomplete"],
    ],
  );
});

test("递归子树其他节点变化时允许 terminating 节点在同一节点修订继续计时", () => {
  let monotonic = 10_000;
  const tree = controller([FIRST_ID, SECOND_ID, THIRD_ID], {
    config: {
      maxDepth: 3,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 16,
      waitTimeoutMs: 60_000,
    },
    monotonicNow: () => monotonic,
  });
  const parent = reserveRootChild(tree, "父代理");
  expectSuccess(applyEvent(tree, parent.node.agent_id, { type: "startup_ready" }));
  const first = expectSuccess(tree.reserveStartingChild(
    { kind: "agent", agent_id: parent.node.agent_id },
    { templateId: "first", name: "清理中的后代" },
  ));
  rememberOutcome(tree, first);
  expectSuccess(applyEvent(tree, first.node.agent_id, { type: "startup_ready" }));
  const second = expectSuccess(tree.reserveStartingChild(
    { kind: "agent", agent_id: parent.node.agent_id },
    { templateId: "second", name: "变化的后代" },
  ));
  rememberOutcome(tree, second);
  expectSuccess(applyEvent(tree, second.node.agent_id, { type: "startup_ready" }));

  const parentSnapshot = expectSuccess(tree.getStatus(parent.node.agent_id));
  const firstSnapshot = expectSuccess(tree.getStatus(first.node.agent_id));
  const secondSnapshot = expectSuccess(tree.getStatus(second.node.agent_id));
  const terminating = Object.freeze({
    ...firstSnapshot,
    state: "terminating" as const,
    lifecycle_elapsed_ms: 5_000,
    revision: firstSnapshot.revision + 1,
  });
  expectSuccess(tree.applySubtreeSnapshot(ROOT_TREE_ACTOR, {
    scope_agent_id: parent.node.agent_id,
    subtree_revision: 1,
    nodes: Object.freeze([parentSnapshot, terminating, secondSnapshot]),
  }));

  monotonic = 12_000;
  const workingSecond = Object.freeze({
    ...secondSnapshot,
    state: "working" as const,
    lifecycle_elapsed_ms: 7_000,
    revision: secondSnapshot.revision + 1,
  });
  const accepted = expectSuccess(tree.applySubtreeSnapshot(ROOT_TREE_ACTOR, {
    scope_agent_id: parent.node.agent_id,
    subtree_revision: 2,
    nodes: Object.freeze([
      parentSnapshot,
      Object.freeze({ ...terminating, lifecycle_elapsed_ms: 7_000 }),
      workingSecond,
    ]),
  }));
  assert.equal(accepted.applied, true);
  assert.equal(expectSuccess(tree.getStatus(first.node.agent_id)).lifecycle_elapsed_ms, 7_000);
});

test("非权威中继首次接收的新活动后代从快照时长继续累计", () => {
  let monotonic = 10_000;
  const tree = controller([], {
    config: {
      maxDepth: 4,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 16,
      waitTimeoutMs: 60_000,
    },
    monotonicNow: () => monotonic,
    initialActor: {
      agentId: FIRST_ID,
      parentAgentId: null,
      depth: 1,
      templateId: "relay",
      name: "中继父代理",
      managementEnabled: true,
    },
  });
  const actor = Object.freeze({ kind: "agent" as const, agent_id: FIRST_ID });
  const adopted = expectSuccess(tree.adoptSpawnGrant(actor, {
    node: Object.freeze({
      agent_id: SECOND_ID,
      parent_agent_id: FIRST_ID,
      template_id: "child",
      name: "直接子代理",
      depth: 2,
      state: "starting" as const,
      pending_message_count: 0,
      revision: 1,
    }),
    lifecycle_generation: 0,
    management_enabled: true,
  }));
  expectSuccess(tree.applyLifecycleEvent(SECOND_ID, {
    type: "startup_ready",
    expected_generation: adopted.lifecycle_generation,
  }));
  const child = expectSuccess(tree.getStatus(SECOND_ID));
  const newDescendant = Object.freeze({
    agent_id: THIRD_ID,
    parent_agent_id: SECOND_ID,
    template_id: "worker",
    name: "新活动后代",
    depth: 3,
    state: "working" as const,
    pending_message_count: 0,
    revision: 2,
    created_at: "2026-01-02T03:04:02.000Z",
    lifecycle_elapsed_ms: 5_000,
  });

  expectSuccess(tree.applySubtreeSnapshot(actor, {
    scope_agent_id: SECOND_ID,
    subtree_revision: 1,
    nodes: Object.freeze([child, newDescendant]),
  }));
  assert.equal(expectSuccess(tree.getStatus(THIRD_ID)).lifecycle_elapsed_ms, 5_000);
  monotonic = 12_000;
  assert.equal(expectSuccess(tree.getStatus(THIRD_ID)).lifecycle_elapsed_ms, 7_000);
});

test("根快照拒绝未经过 reserve_child 预登记的未知身份", () => {
  const tree = controller([FIRST_ID, SECOND_ID], {
    config: {
      maxDepth: 3,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 16,
      waitTimeoutMs: 60_000,
    },
  });
  const parent = reserveRootChild(tree, "父代理");
  expectSuccess(applyEvent(tree, parent.node.agent_id, { type: "startup_ready" }));
  const parentSnapshot = expectSuccess(tree.getStatus(parent.node.agent_id));
  expectFailure(tree.applySubtreeSnapshot(ROOT_TREE_ACTOR, {
    scope_agent_id: parent.node.agent_id,
    subtree_revision: 1,
    nodes: Object.freeze([parentSnapshot, Object.freeze({
      agent_id: SECOND_ID,
      parent_agent_id: FIRST_ID,
      template_id: "child",
      name: "伪造后代",
      depth: 2,
      state: "idle" as const,
      pending_message_count: 0,
      revision: 1,
      created_at: "2026-01-02T03:04:06.000Z",
      lifecycle_elapsed_ms: 0,
    })]),
  }), "invalid_argument");
  assert.deepEqual(expectSuccess(tree.getTreeSnapshot()).nodes.map((node) => node.agent_id), [FIRST_ID]);
});

test("子树投影采用根 grant，监督快照保留真实父关系且公开查询隐藏祖先", () => {
  const tree = controller([], {
    config: {
      maxDepth: 3,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 16,
      waitTimeoutMs: 60_000,
    },
    initialActor: {
      agentId: FIRST_ID,
      parentAgentId: THIRD_ID,
      depth: 2,
      templateId: "parent",
      name: "投影根",
      managementEnabled: true,
    },
  });
  const actor = Object.freeze({ kind: "agent" as const, agent_id: FIRST_ID });
  const adopted = expectSuccess(tree.adoptSpawnGrant(actor, {
    node: Object.freeze({
      agent_id: SECOND_ID,
      parent_agent_id: FIRST_ID,
      template_id: "child",
      name: "已授权子代理",
      depth: 3,
      state: "starting" as const,
      pending_message_count: 0,
      revision: 1,
    }),
    lifecycle_generation: 0,
    management_enabled: false,
  }));
  assert.equal(adopted.node.agent_id, SECOND_ID);
  expectSuccess(tree.applyLifecycleEvent(SECOND_ID, {
    type: "startup_ready",
    expected_generation: adopted.lifecycle_generation,
  }));

  const supervision = expectSuccess(tree.getSupervisionSubtreeSnapshot(actor));
  assert.deepEqual(supervision.nodes.map((node) => [node.agent_id, node.parent_agent_id, node.depth]), [
    [FIRST_ID, THIRD_ID, 2],
    [SECOND_ID, FIRST_ID, 3],
  ]);
  const publicView = expectSuccess(tree.getTreeSnapshotFor(actor));
  assert.deepEqual(publicView.nodes.map((node) => [node.agent_id, node.parent_agent_id, node.depth]), [
    [FIRST_ID, null, 2],
    [SECOND_ID, FIRST_ID, 3],
  ]);
});
