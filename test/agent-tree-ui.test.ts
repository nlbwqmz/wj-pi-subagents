import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentTreePanelModel,
  bindAgentTreeUi,
  displayWidth,
  renderAgentTreePanelSurface,
  renderAgentsWidget,
  type AgentTreeUiContext,
} from "../src/agent-tree-ui.ts";
import type {
  AgentSnapshot,
  ScopedAgentTreeSnapshot,
} from "../src/tree-controller.ts";

const PARENT_ID = "550e8400-e29b-41d4-a716-446655440001";
const WORKING_CHILD_ID = "550e8400-e29b-41d4-a716-446655440002";
const COMPLETED_CHILD_ID = "550e8400-e29b-41d4-a716-446655440003";
const TERMINATED_PARENT_ID = "550e8400-e29b-41d4-a716-446655440004";
const INCOMPLETE_CHILD_ID = "550e8400-e29b-41d4-a716-446655440005";

type TerminationResult = NonNullable<AgentSnapshot["termination_result"]>;

function makeNode(
  agent_id: string,
  parent_agent_id: string | null,
  depth: number,
  state: AgentSnapshot["state"],
  name: string,
  termination_result?: TerminationResult,
): AgentSnapshot {
  return Object.freeze({
    agent_id,
    parent_agent_id,
    template_id: "worker",
    name,
    depth,
    state,
    revision: 1,
    created_at: "2025-01-01T00:00:00.000Z",
    working_elapsed_ms: 100,
    ...(state === "working" ? { activity: Object.freeze({ phase: "processing" as const }) } : {}),
    ...(state === "terminated" ? { termination_result } : {}),
  } as AgentSnapshot);
}

function treeSnapshot(): ScopedAgentTreeSnapshot {
  return Object.freeze({
    tree_revision: 7,
    scope: Object.freeze({ kind: "root" as const }),
    nodes: Object.freeze([
      makeNode(PARENT_ID, null, 1, "idle", "parent"),
      makeNode(WORKING_CHILD_ID, PARENT_ID, 2, "working", "working-child"),
      makeNode(COMPLETED_CHILD_ID, PARENT_ID, 2, "terminated", "completed-child", "completed"),
      makeNode(TERMINATED_PARENT_ID, null, 1, "terminated", "terminated-parent", "failed"),
      makeNode(INCOMPLETE_CHILD_ID, TERMINATED_PARENT_ID, 2, "terminated", "incomplete-child", "incomplete"),
    ]),
  });
}

test("面板将终态节点保留在对应父代理的树分支中", () => {
  const panel = new AgentTreePanelModel(treeSnapshot(), { viewport_height: 12 });
  const lines = panel.render(240);
  const completedLine = lines.find((line) => line.includes("completed-child"));
  const incompleteLine = lines.find((line) => line.includes("incomplete-child"));

  assert.ok(completedLine?.startsWith("    ·"), lines.join("\n"));
  assert.match(completedLine ?? "", /completed-child · terminated .*completed/);
  assert.ok(incompleteLine?.startsWith("    ·"), lines.join("\n"));
  assert.match(incompleteLine ?? "", /incomplete-child · terminated .*incomplete/);
  assert.ok(lines.every((line) => !line.includes("finished")), lines.join("\n"));
  assert.equal(Object.hasOwn(panel.getPublicState(), "finished_expanded"), false);
});

test("折叠树枝时终态节点计入分支摘要，并可继续使用普通树交互", () => {
  const panel = new AgentTreePanelModel(treeSnapshot(), { viewport_height: 12 });

  assert.equal(panel.handleInput("\x1b[D"), "changed");
  const collapsedParent = panel.render(240).find((line) => line.includes("parent"));
  assert.match(collapsedParent ?? "", /descendants 2 · working 1 · failed 0 · terminated 1/);

  assert.equal(panel.handleInput("\x1b[C"), "changed");
  assert.ok(panel.render(240).some((line) => line.includes("completed-child")));
});

test("面板表面使用 120 列，并保持窄宽度渲染路径", () => {
  const panel = new AgentTreePanelModel(treeSnapshot(), { viewport_height: 4 });
  const surface = renderAgentTreePanelSurface(panel, 120, undefined);
  assert.ok(surface.length > 0);
  assert.ok(surface.every((line) => displayWidth(line) === 120), surface.join("\n"));

  const narrow = renderAgentTreePanelSurface(panel, 5, undefined);
  assert.ok(narrow.length > 0);
  assert.ok(narrow.every((line) => displayWidth(line) === 5), narrow.join("\n"));
});

test("widget 仍只展示直接且未终止的子代理", () => {
  const widget = renderAgentsWidget(treeSnapshot(), 240);
  assert.equal(widget.length, 2);
  assert.match(widget[1] ?? "", /parent/);
  assert.doesNotMatch(widget.join("\n"), /terminated-parent|completed|incomplete|terminated/);
});

test("/agents 面板 overlay 宽度为 120", async () => {
  let overlayWidth: number | `${number}%` | undefined;
  const ui = {
    custom: (_factory: unknown, options?: { overlayOptions?: { width?: number | `${number}%` } }) => {
      overlayWidth = options?.overlayOptions?.width;
      return Promise.resolve();
    },
  } as unknown as NonNullable<AgentTreeUiContext["ui"]>;
  const source = {
    read: () => ({ ok: true as const, data: treeSnapshot() }),
    onChange: (_listener: () => void) => () => {},
  };
  const binding = bindAgentTreeUi(source, { hasUI: true, mode: "tui", ui });

  await binding.openPanel();
  assert.equal(overlayWidth, 120);
  binding.dispose();
});
