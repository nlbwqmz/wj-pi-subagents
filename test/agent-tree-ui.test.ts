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
const FAILED_CHILD_ID = "550e8400-e29b-41d4-a716-446655440006";

type TerminationResult = NonNullable<AgentSnapshot["termination_result"]>;

const MARKER_THEME = Object.freeze({
  fg: (color: string, text: string): string => `<fg:${color}>${text}</fg:${color}>`,
  bg: (color: string, text: string): string => `<bg:${color}>${text}</bg:${color}>`,
  bold: (text: string): string => `<bold>${text}</bold>`,
});

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
    ...(state === "starting" ? {} : {
      created_at: "2025-01-01T00:00:00.000Z",
      working_elapsed_ms: 100,
    }),
    ...(state === "working" || state === "interrupting"
      ? { activity: Object.freeze({ phase: "processing" as const }) }
      : {}),
    ...(state === "failed" ? {
      error: Object.freeze({
        code: "internal_error" as const,
        message: "Internal controller error",
        retryable: false,
      }),
    } : {}),
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

test("面板表面使用 160 列，并保持窄宽度渲染路径", () => {
  const panel = new AgentTreePanelModel(treeSnapshot(), { viewport_height: 4 });
  const surface = renderAgentTreePanelSurface(panel, 160, undefined);
  assert.ok(surface.length > 0);
  assert.ok(surface.every((line) => displayWidth(line) === 160), surface.join("\n"));

  const narrow = renderAgentTreePanelSurface(panel, 5, undefined);
  assert.ok(narrow.length > 0);
  assert.ok(narrow.every((line) => displayWidth(line) === 5), narrow.join("\n"));
});

test("resize 只改变布局宽度，不重置选择、滚动或展开状态", () => {
  const panel = new AgentTreePanelModel(treeSnapshot(), { viewport_height: 2 });
  assert.equal(panel.handleInput("\x1b[D"), "changed");
  assert.equal(panel.handleInput("\x1b[B"), "changed");
  assert.equal(panel.handleInput("\x1b[B"), "changed");
  const stateBeforeResize = panel.getPublicState();

  const wide = renderAgentTreePanelSurface(panel, 160, undefined);
  assert.ok(wide.every((line) => displayWidth(line) === 160), wide.join("\n"));
  assert.deepEqual(panel.getPublicState(), stateBeforeResize);

  const narrow = renderAgentTreePanelSurface(panel, 24, undefined);
  assert.ok(narrow.every((line) => displayWidth(line) === 24), narrow.join("\n"));
  assert.deepEqual(panel.getPublicState(), stateBeforeResize);
  assert.equal(stateBeforeResize.selected_key, INCOMPLETE_CHILD_ID);
  assert.equal(stateBeforeResize.scroll_offset, 1);
  assert.deepEqual(stateBeforeResize.expanded_agent_ids, [TERMINATED_PARENT_ID]);
});

test("未选中的 terminated 与 failed 节点整行使用弱化主题", () => {
  const snapshot: ScopedAgentTreeSnapshot = Object.freeze({
    ...treeSnapshot(),
    nodes: Object.freeze([
      ...treeSnapshot().nodes,
      makeNode(FAILED_CHILD_ID, PARENT_ID, 2, "failed", "failed-child"),
    ]),
  });
  const surface = renderAgentTreePanelSurface(
    new AgentTreePanelModel(snapshot, { viewport_height: 8 }),
    120,
    MARKER_THEME,
  );
  const terminatedLine = surface.find((line) => line.includes("completed-child"));
  const failedLine = surface.find((line) => line.includes("failed-child"));
  const workingLine = surface.find((line) => line.includes("working-child"));
  const terminatedText = /<fg:dim>(.*?)<\/fg:dim>/.exec(terminatedLine ?? "")?.[1];
  const failedText = /<fg:dim>(.*?)<\/fg:dim>/.exec(failedLine ?? "")?.[1];

  assert.match(terminatedText ?? "", /    · worker · completed-child · terminated · completed · 0s/);
  assert.equal(displayWidth(terminatedText ?? ""), 116);
  assert.match(failedText ?? "", /    · worker · failed-child · failed · 0s · internal_error/);
  assert.equal(displayWidth(failedText ?? ""), 116);
  assert.match(workingLine ?? "", /<fg:customMessageText>.*working-child.*<\/fg:customMessageText>/);
  assert.doesNotMatch(workingLine ?? "", /<fg:dim>/);
});

test("所有非终态节点继续使用普通正文主题", () => {
  const states = ["starting", "idle", "working", "interrupting", "terminating"] as const;
  const snapshot: ScopedAgentTreeSnapshot = Object.freeze({
    tree_revision: 8,
    scope: Object.freeze({ kind: "root" as const }),
    nodes: Object.freeze([
      ...states.map((state, index) => makeNode(
        `550e8400-e29b-41d4-a716-44665544001${index}`,
        null,
        1,
        state,
        `state-${state}`,
      )),
      makeNode(
        "550e8400-e29b-41d4-a716-446655440020",
        null,
        1,
        "terminated",
        "selected-terminal",
        "completed",
      ),
    ]),
  });
  const panel = new AgentTreePanelModel(snapshot, { viewport_height: 8 });
  for (let index = 0; index < states.length; index += 1) {
    assert.equal(panel.handleInput("\x1b[B"), "changed");
  }
  const surface = renderAgentTreePanelSurface(panel, 120, MARKER_THEME);

  for (const state of states) {
    const line = surface.find((candidate) => candidate.includes(`state-${state}`));
    assert.match(line ?? "", new RegExp(`<fg:customMessageText>.*state-${state} · ${state}`));
    assert.doesNotMatch(line ?? "", /<fg:dim>/);
  }
});

test("选中的终态节点保持高对比，移开后整行恢复弱化主题", () => {
  const panel = new AgentTreePanelModel(treeSnapshot(), { viewport_height: 8 });

  assert.equal(panel.handleInput("\x1b[B"), "changed");
  assert.equal(panel.handleInput("\x1b[B"), "changed");
  assert.equal(panel.handleInput("\x1b[B"), "changed");
  assert.equal(panel.handleInput("\x1b[D"), "changed");
  const selectedSurface = renderAgentTreePanelSurface(panel, 120, MARKER_THEME);
  const selectedLine = selectedSurface.find((line) => line.includes("terminated-parent"));

  assert.match(selectedLine ?? "", /<bg:selectedBg>.*<fg:text><bold>.*terminated-parent/);
  assert.match(selectedLine ?? "", /descendants 1 · working 0 · failed 0 · terminated 1/);
  assert.doesNotMatch(selectedLine ?? "", /<fg:dim>/);

  assert.equal(panel.handleInput("\x1b[A"), "changed");
  const restoredSurface = renderAgentTreePanelSurface(panel, 120, MARKER_THEME);
  const restoredLine = restoredSurface.find((line) => line.includes("terminated-parent"));
  const restoredText = /<fg:dim>(.*?)<\/fg:dim>/.exec(restoredLine ?? "")?.[1];

  assert.match(restoredText ?? "", /terminated-parent · terminated · failed · 0s/);
  assert.match(restoredText ?? "", /descendants 1 · working 0 · failed 0 · terminated 1/);
  assert.equal(displayWidth(restoredText ?? ""), 116);
  assert.doesNotMatch(restoredLine ?? "", /<bg:selectedBg>/);
});

test("极窄宽度下选中的终态节点仍保持高对比主题", () => {
  const snapshot: ScopedAgentTreeSnapshot = Object.freeze({
    tree_revision: 9,
    scope: Object.freeze({ kind: "root" as const }),
    nodes: Object.freeze([
      makeNode(COMPLETED_CHILD_ID, null, 1, "terminated", "selected-terminal", "completed"),
    ]),
  });
  const panel = new AgentTreePanelModel(snapshot, { viewport_height: 1 });

  for (const width of [1, 2]) {
    const selectedLine = renderAgentTreePanelSurface(panel, width, MARKER_THEME)[1];
    assert.match(selectedLine ?? "", /<bg:selectedBg><fg:text><bold>/);
    assert.doesNotMatch(selectedLine ?? "", /<fg:dim>/);
  }
});

test("面板级错误继续使用错误主题而非终态弱化主题", () => {
  const panel = new AgentTreePanelModel(treeSnapshot(), { viewport_height: 4 });
  panel.markError();
  const surface = renderAgentTreePanelSurface(panel, 120, MARKER_THEME);
  const errorLine = surface.find((line) => line.includes("temporarily unavailable"));

  assert.match(errorLine ?? "", /<fg:error>.*Agent tree temporarily unavailable.*<\/fg:error>/);
  assert.doesNotMatch(errorLine ?? "", /<fg:dim>/);
});

test("widget 仍只展示直接且未终止的子代理", () => {
  const widget = renderAgentsWidget(treeSnapshot(), 240);
  assert.equal(widget.length, 2);
  assert.match(widget[1] ?? "", /parent/);
  assert.doesNotMatch(widget.join("\n"), /terminated-parent|completed|incomplete|terminated/);
});

test("/agents overlay 使用既定布局并经宿主路径渲染生命周期主题", async () => {
  let overlayWidth: number | `${number}%` | undefined;
  let overlayAnchor: "center" | undefined;
  let overlayMargin: number | undefined;
  let overlayComponent: { render(width: number): string[] } | undefined;
  const ui = {
    custom: (
      factory: (
        tui: { requestRender(): void },
        theme: unknown,
        keybindings: unknown,
        done: (result: undefined) => void,
      ) => { render(width: number): string[] },
      options?: {
        overlayOptions?: {
          width?: number | `${number}%`;
          anchor?: "center";
          margin?: number;
        };
      },
    ) => {
      overlayWidth = options?.overlayOptions?.width;
      overlayAnchor = options?.overlayOptions?.anchor;
      overlayMargin = options?.overlayOptions?.margin;
      overlayComponent = factory(
        { requestRender: () => {} },
        MARKER_THEME,
        undefined,
        () => {},
      );
      return Promise.resolve();
    },
  } as unknown as NonNullable<AgentTreeUiContext["ui"]>;
  const source = {
    read: () => ({ ok: true as const, data: treeSnapshot() }),
    onChange: (_listener: () => void) => () => {},
  };
  const binding = bindAgentTreeUi(source, { hasUI: true, mode: "tui", ui });

  await binding.openPanel();
  assert.equal(overlayWidth, 160);
  assert.equal(overlayAnchor, "center");
  assert.equal(overlayMargin, 1);
  const surface = overlayComponent?.render(120) ?? [];
  assert.match(
    surface.find((line) => line.includes("working-child")) ?? "",
    /<fg:customMessageText>.*working-child.*<\/fg:customMessageText>/,
  );
  assert.match(
    surface.find((line) => line.includes("completed-child")) ?? "",
    /<fg:dim>.*completed-child.*<\/fg:dim>/,
  );
  binding.dispose();
});
