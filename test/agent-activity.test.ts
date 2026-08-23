import assert from "node:assert/strict";
import test from "node:test";
import {
  parseAgentActivitySummary,
  parseAgentSnapshot,
} from "../src/agent-snapshot-codec.ts";
import {
  AgentTreePanelModel,
  renderAgentsWidget,
} from "../src/agent-tree-ui.ts";
import type {
  AgentSnapshot,
  ScopedAgentTreeSnapshot,
  SubtreeSnapshotInput,
} from "../src/tree-controller.ts";
import {
  ROOT_TREE_ACTOR,
  TreeController,
} from "../src/tree-controller.ts";

const AGENT_ID = "550e8400-e29b-41d4-a716-446655440000";

function snapshot(
  phase: "processing" | "executing_tools" | "compacting",
): AgentSnapshot {
  return Object.freeze({
    agent_id: AGENT_ID,
    parent_agent_id: null,
    template_id: "demo",
    name: "活动测试",
    depth: 1,
    state: "working",
    revision: 2,
    created_at: "2025-01-01T00:00:00.000Z",
    working_elapsed_ms: 100,
    activity: Object.freeze({ phase }),
  });
}

function scoped(node: AgentSnapshot): ScopedAgentTreeSnapshot {
  return Object.freeze({
    tree_revision: node.revision,
    scope: Object.freeze({ kind: "root" as const }),
    nodes: Object.freeze([node]),
  });
}

test("活动阶段快照只接受三个公开值，并限制在 working/interrupting", () => {
  assert.deepEqual(parseAgentActivitySummary({ phase: "processing" }), { phase: "processing" });
  assert.deepEqual(parseAgentActivitySummary({ phase: "executing_tools" }), { phase: "executing_tools" });
  assert.deepEqual(parseAgentActivitySummary({ phase: "compacting" }), { phase: "compacting" });
  assert.equal(parseAgentActivitySummary({ phase: "editing" }), undefined);
  assert.equal(parseAgentActivitySummary({ phase: "processing", category: "reading" }), undefined);

  const working = snapshot("processing");
  assert.deepEqual(parseAgentSnapshot(working), working);
  assert.equal(parseAgentSnapshot({ ...working, state: "idle" }), undefined);
});

test("子树快照可以传播活动阶段清除，父端不会保留过期值", () => {
  const tree = new TreeController({
    config: {
      maxDepth: 3,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 8,
      waitTimeoutMs: 10_000,
    },
    idFactory: () => AGENT_ID,
  });
  const reserved = tree.reserveStartingChild(ROOT_TREE_ACTOR, {
    templateId: "demo",
    name: "子树活动",
  });
  assert.equal(reserved.ok, true, JSON.stringify(reserved));
  const ready = tree.applyLifecycleEvent(AGENT_ID, { type: "startup_ready", expected_generation: 0 });
  assert.equal(ready.ok, true, JSON.stringify(ready));
  const started = tree.applyLifecycleEvent(AGENT_ID, { type: "agent_start", expected_generation: 1 });
  assert.equal(started.ok, true, JSON.stringify(started));
  const current = tree.getStatus(AGENT_ID);
  assert.equal(current.ok, true, JSON.stringify(current));
  if (!current.ok) return;

  const withActivity = { ...current.data, activity: { phase: "executing_tools" as const } };
  const first: SubtreeSnapshotInput = {
    scope_agent_id: AGENT_ID,
    subtree_revision: 1,
    nodes: [withActivity],
  };
  const applied = tree.applySubtreeSnapshot(ROOT_TREE_ACTOR, first);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  let status = tree.getStatus(AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) assert.deepEqual(status.data.activity, { phase: "executing_tools" });

  const cleared: SubtreeSnapshotInput = {
    scope_agent_id: AGENT_ID,
    subtree_revision: 2,
    nodes: [current.data],
  };
  const clearedResult = tree.applySubtreeSnapshot(ROOT_TREE_ACTOR, cleared);
  assert.equal(clearedResult.ok, true, JSON.stringify(clearedResult));
  status = tree.getStatus(AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) assert.equal(status.data.activity, undefined);
});

test("输入框 widget 和子代理面板显示活动阶段但不显示工具类别", () => {
  const current = scoped(snapshot("executing_tools"));
  const widget = renderAgentsWidget(current, 160);
  assert.equal(widget.length, 2);
  assert.match(widget[1] ?? "", /executing_tools/);
  assert.doesNotMatch(widget[1] ?? "", /reading|editing|running|active_count/);

  const panel = new AgentTreePanelModel(current, { viewport_height: 8 });
  const lines = panel.render(160);
  assert.ok(lines.some((line) => line.includes("executing_tools")));
  assert.ok(lines.every((line) => !line.includes("active_count") && !line.includes("reading")));
});
