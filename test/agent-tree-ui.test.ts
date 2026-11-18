import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentTreePanelModel,
  bindAgentTreeUi,
  displayWidth,
  renderAgentTreePanelSurface,
  renderAgentsWidget,
  type AgentActivityStreamSource,
  type AgentTreeUiContext,
} from "../src/agent-tree-ui.ts";
import type { AgentDisplayDraftView } from "../src/agent-display-drafts.ts";
import type { AgentActivitySnapshot } from "../src/agent-activity-cache.ts";
import type { CanonicalAgentActivityEntry } from "../src/canonical-activity.ts";
import {
  CANONICAL_ACTIVITY_CONTRACT_VERSION,
} from "../src/canonical-activity.ts";
import { randomUUID } from "node:crypto";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
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

test("回车对选中节点返回进入查看结果", () => {
  const panel = new AgentTreePanelModel(treeSnapshot(), { viewport_height: 8 });
  assert.equal(panel.handleInput("\r"), "enter");
  assert.equal(panel.getPublicState().selected_key, PARENT_ID);

  assert.equal(panel.handleInput("\x1b[B"), "changed");
  assert.equal(panel.handleInput("\r"), "enter");
  assert.equal(panel.getPublicState().selected_key, WORKING_CHILD_ID);
});

test("错误态与无选中行的回车被忽略", () => {
  const errored = new AgentTreePanelModel(treeSnapshot(), { viewport_height: 8 });
  errored.markError();
  assert.equal(errored.handleInput("\r"), "ignored");

  const empty = new AgentTreePanelModel(Object.freeze({
    tree_revision: 1,
    scope: Object.freeze({ kind: "root" as const }),
    nodes: Object.freeze([]),
  }), { viewport_height: 8 });
  assert.equal(empty.handleInput("\r"), "ignored");
  assert.equal(empty.handleInput("\x1b"), "close");
});

test("回车兼容 Kitty CSI-u 编码", () => {
  const panel = new AgentTreePanelModel(treeSnapshot(), { viewport_height: 8 });
  assert.equal(panel.handleInput("\x1b[13u"), "enter");
  assert.equal(panel.getPublicState().selected_key, PARENT_ID);

  assert.equal(panel.handleInput("\x1b[B"), "changed");
  assert.equal(panel.handleInput("\x1b[13u"), "enter");
  assert.equal(panel.getPublicState().selected_key, WORKING_CHILD_ID);

  // 必须有选中行的前置条件不变：空树与错误态仍忽略回车。
  const empty = new AgentTreePanelModel(Object.freeze({
    tree_revision: 1,
    scope: Object.freeze({ kind: "root" as const }),
    nodes: Object.freeze([]),
  }), { viewport_height: 8 });
  assert.equal(empty.handleInput("\x1b[13u"), "ignored");

  const errored = new AgentTreePanelModel(treeSnapshot(), { viewport_height: 8 });
  errored.markError();
  assert.equal(errored.handleInput("\x1b[13u"), "ignored");
});

test("Esc 兼容 Kitty CSI-u 与 modifyOtherKeys 编码", () => {
  const panel = new AgentTreePanelModel(treeSnapshot(), { viewport_height: 8 });
  assert.equal(panel.handleInput("\x1b[27u"), "close");

  const otherKeys = new AgentTreePanelModel(treeSnapshot(), { viewport_height: 8 });
  assert.equal(otherKeys.handleInput("\x1b[27;1;27~"), "close");

  // Esc 的短路先于错误态，保持原有优先级。
  const errored = new AgentTreePanelModel(treeSnapshot(), { viewport_height: 8 });
  errored.markError();
  assert.equal(errored.handleInput("\x1b[27u"), "close");
});

test("方向键兼容 SS3 与 Kitty CSI 编码", () => {
  const panel = new AgentTreePanelModel(treeSnapshot(), { viewport_height: 8 });
  // SS3：↓ 下移、↑ 回退。
  assert.equal(panel.handleInput("\x1bOB"), "changed");
  assert.equal(panel.getPublicState().selected_key, WORKING_CHILD_ID);
  assert.equal(panel.handleInput("\x1bOA"), "changed");
  assert.equal(panel.getPublicState().selected_key, PARENT_ID);

  // SS3：← 折叠选中分支，→ 重新展开。
  assert.equal(panel.handleInput("\x1bOD"), "changed");
  assert.equal(panel.getPublicState().expanded_agent_ids.includes(PARENT_ID), false);
  assert.equal(panel.handleInput("\x1bOC"), "changed");
  assert.equal(panel.getPublicState().expanded_agent_ids.includes(PARENT_ID), true);

  // Kitty CSI（带 modifier 参数）：↑↓ 移动，←→ 折叠展开。
  assert.equal(panel.handleInput("\x1b[1;1B"), "changed");
  assert.equal(panel.getPublicState().selected_key, WORKING_CHILD_ID);
  assert.equal(panel.handleInput("\x1b[1;1A"), "changed");
  assert.equal(panel.getPublicState().selected_key, PARENT_ID);
  assert.equal(panel.handleInput("\x1b[1;1D"), "changed");
  assert.equal(panel.getPublicState().expanded_agent_ids.includes(PARENT_ID), false);
  assert.equal(panel.handleInput("\x1b[1;1C"), "changed");
  assert.equal(panel.getPublicState().expanded_agent_ids.includes(PARENT_ID), true);
});

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

test("setViewportHeight 响应式扩展或收缩视口并保持选中可见", () => {
  const panel = new AgentTreePanelModel(treeSnapshot(), { viewport_height: 2 });
  assert.equal(panel.handleInput("\x1b[D"), "changed");
  assert.equal(panel.handleInput("\x1b[B"), "changed");
  assert.equal(panel.handleInput("\x1b[B"), "changed");
  assert.equal(panel.getPublicState().selected_key, INCOMPLETE_CHILD_ID);

  // 扩展视口：选中节点保持可见，滚动收敛到顶部，正文行数随视口扩展。
  panel.setViewportHeight(20);
  const grown = panel.getPublicState();
  assert.equal(grown.selected_key, INCOMPLETE_CHILD_ID);
  assert.equal(grown.scroll_offset, 0);
  const grownSurface = renderAgentTreePanelSurface(panel, 120, undefined);
  assert.equal(grownSurface.length, 26);
  assert.ok(grownSurface.some((line) => line.includes("incomplete-child")));

  // 收缩视口：选中节点保持可见并翻页到对应偏移。
  panel.setViewportHeight(1);
  const shrunk = panel.getPublicState();
  assert.equal(shrunk.selected_key, INCOMPLETE_CHILD_ID);
  assert.equal(shrunk.scroll_offset, 2);
  const shrunkSurface = renderAgentTreePanelSurface(panel, 120, undefined);
  assert.equal(shrunkSurface.length, 7);
  assert.ok(shrunkSurface.some((line) => line.includes("incomplete-child")));

  // 非法输入忽略，不重置当前视口。
  panel.setViewportHeight(0);
  assert.equal(panel.getViewportHeight(), 1);
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

test("选中只叠加背景并保留节点原有文字颜色", () => {
  const panel = new AgentTreePanelModel(treeSnapshot(), { viewport_height: 8 });
  const initiallySelectedSurface = renderAgentTreePanelSurface(panel, 120, MARKER_THEME);
  const initiallySelectedLine = initiallySelectedSurface.find((line) => line.includes("parent"));

  assert.match(
    initiallySelectedLine ?? "",
    /<bg:selectedBg>.*<fg:customMessageText>.*parent.*<\/fg:customMessageText>/,
  );
  assert.doesNotMatch(initiallySelectedLine ?? "", /<bold>|<fg:text>|<fg:dim>/);

  assert.equal(panel.handleInput("\x1b[B"), "changed");
  assert.equal(panel.handleInput("\x1b[B"), "changed");
  assert.equal(panel.handleInput("\x1b[B"), "changed");
  assert.equal(panel.handleInput("\x1b[D"), "changed");
  const selectedSurface = renderAgentTreePanelSurface(panel, 120, MARKER_THEME);
  const selectedLine = selectedSurface.find((line) => line.includes("terminated-parent"));

  assert.match(
    selectedLine ?? "",
    /<bg:selectedBg>.*<fg:dim>.*terminated-parent.*<\/fg:dim>/,
  );
  assert.match(selectedLine ?? "", /descendants 1 · working 0 · failed 0 · terminated 1/);
  assert.doesNotMatch(selectedLine ?? "", /<bold>|<fg:text>|<fg:customMessageText>/);

  assert.equal(panel.handleInput("\x1b[A"), "changed");
  const restoredSurface = renderAgentTreePanelSurface(panel, 120, MARKER_THEME);
  const restoredLine = restoredSurface.find((line) => line.includes("terminated-parent"));
  const restoredText = /<fg:dim>(.*?)<\/fg:dim>/.exec(restoredLine ?? "")?.[1];

  assert.match(restoredText ?? "", /terminated-parent · terminated · failed · 0s/);
  assert.match(restoredText ?? "", /descendants 1 · working 0 · failed 0 · terminated 1/);
  assert.equal(displayWidth(restoredText ?? ""), 116);
  assert.doesNotMatch(restoredLine ?? "", /<bg:selectedBg>/);
});

test("极窄宽度下选中的终态节点仍保留弱化文字", () => {
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
    assert.match(selectedLine ?? "", /<bg:selectedBg><fg:dim>/);
    assert.doesNotMatch(selectedLine ?? "", /<bold>|<fg:text>|<fg:customMessageText>/);
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

test("/agents overlay 请求响应式尺寸并经宿主路径渲染生命周期主题", async () => {
  let overlayWidth: number | `${number}%` | undefined;
  let overlayMaxHeight: number | `${number}%` | undefined;
  let overlayAnchor: "center" | undefined;
  let overlayMargin: number | undefined;
  let overlayComponent: { render(width: number): string[] } | undefined;
  const ui = {
    custom: (
      factory: (
        tui: { requestRender(): void; terminal?: { rows?: number } },
        theme: unknown,
        keybindings: unknown,
        done: (result: undefined) => void,
      ) => { render(width: number): string[] },
      options?: {
        overlayOptions?: {
          width?: number | `${number}%`;
          maxHeight?: number | `${number}%`;
          anchor?: "center";
          margin?: number;
        };
      },
    ) => {
      overlayWidth = options?.overlayOptions?.width;
      overlayMaxHeight = options?.overlayOptions?.maxHeight;
      overlayAnchor = options?.overlayOptions?.anchor;
      overlayMargin = options?.overlayOptions?.margin;
      overlayComponent = factory(
        { requestRender: () => {}, terminal: { rows: 30 } },
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
  assert.equal(overlayWidth, "100%");
  assert.equal(overlayMaxHeight, "100%");
  assert.equal(overlayAnchor, "center");
  assert.equal(overlayMargin, 2);
  const surface = overlayComponent?.render(120) ?? [];
  // 终端 30 行 → 正文 30 - 2×2(边距) - 6(框线装饰) = 20 行，共 26 行。
  assert.equal(surface.length, 26);
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

test("孙代理查看器同步回放，并将连续草稿通知合并到一次 50ms 重绘", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  type OverlayComponent = {
    render(width: number): string[];
    handleInput?(data: string): void;
    dispose?(): void;
  };
  const overlays: OverlayComponent[] = [];
  const overlayCompletions: Promise<void>[] = [];
  const renderRequests: number[] = [];
  const ui = {
    custom: (
      factory: (
        tui: { requestRender(): void },
        theme: unknown,
        keybindings: unknown,
        done: (result: undefined) => void,
      ) => OverlayComponent,
    ) => {
      const index = overlays.length;
      let settle: () => void = () => {};
      const completion = new Promise<void>((resolve) => { settle = resolve; });
      const component = factory(
        { requestRender: () => { renderRequests[index] = (renderRequests[index] ?? 0) + 1; } },
        MARKER_THEME,
        undefined,
        () => settle(),
      );
      overlays.push(component);
      overlayCompletions.push(completion);
      return completion;
    },
  } as unknown as NonNullable<AgentTreeUiContext["ui"]>;
  let currentSnapshot = treeSnapshot();
  let treeChange: (() => void) | undefined;
  const source = {
    read: () => ({ ok: true as const, data: currentSnapshot }),
    onChange: (listener: () => void) => {
      treeChange = listener;
      return () => { if (treeChange === listener) treeChange = undefined; };
    },
  };
  const replay: CanonicalAgentActivityEntry[] = [Object.freeze({
    contract_version: CANONICAL_ACTIVITY_CONTRACT_VERSION,
    agent_id: WORKING_CHILD_ID,
    incarnation_id: randomUUID(),
    entry_id: randomUUID(),
    body: Object.freeze({
      type: "message",
      content: Object.freeze([Object.freeze({ type: "text", text: "孙代理历史" })]),
    }),
  })];
  const replayReads: string[] = [];
  let activityChange: ((agentId: string) => void) | undefined;
  let displayChange: ((agentId: string) => void) | undefined;
  let drafts: readonly AgentDisplayDraftView[] = Object.freeze([]);
  const displayDraft = (value: string): AgentDisplayDraftView => Object.freeze({
    key: "7f9c24e8-5b3d-4f6a-8c1e-9d2b7a4f6e81|message-1",
    state: "streaming",
    blocks: Object.freeze([Object.freeze({
      contentIndex: 0,
      contentType: "text",
      value,
    })]),
  });
  const draftReads: string[] = [];
  const activity: AgentActivityStreamSource = {
    readReplay: (agentId) => {
      replayReads.push(agentId);
      return agentId === WORKING_CHILD_ID ? replay : [];
    },
    onChange: (listener) => {
      activityChange = listener;
      return () => { if (activityChange === listener) activityChange = undefined; };
    },
    readDisplayDrafts: (agentId) => {
      draftReads.push(agentId);
      return agentId === WORKING_CHILD_ID ? drafts : [];
    },
    onDisplayChange: (listener) => {
      displayChange = listener;
      return () => { if (displayChange === listener) displayChange = undefined; };
    },
  };
  const binding = bindAgentTreeUi(source, { hasUI: true, mode: "tui", ui }, activity);

  const panelPromise = binding.openPanel();
  await Promise.resolve();
  const panel = overlays[0];
  panel?.handleInput?.("\x1b[B");
  panel?.handleInput?.("\r");
  const viewer = overlays[1];
  assert.ok(viewer !== undefined);
  assert.ok(activityChange !== undefined);
  assert.ok(displayChange !== undefined);
  assert.deepEqual(replayReads, [WORKING_CHILD_ID]);
  // 打开详情时立即读取顶层草稿快照（此时为空）。
  assert.deepEqual(draftReads, [WORKING_CHILD_ID]);
  assert.match(viewer?.render(120).join("\n") ?? "", /working-child.*孙代理历史/us);

  replay.push(Object.freeze({
    contract_version: CANONICAL_ACTIVITY_CONTRACT_VERSION,
    agent_id: WORKING_CHILD_ID,
    incarnation_id: randomUUID(),
    entry_id: randomUUID(),
    body: Object.freeze({
      type: "message",
      content: Object.freeze([Object.freeze({ type: "text", text: "孙代理实时完整事件" })]),
    }),
  }));
  activityChange?.(PARENT_ID);
  assert.equal(replayReads.length, 1);
  activityChange?.(WORKING_CHILD_ID);
  assert.match(viewer?.render(120).join("\n") ?? "", /孙代理实时完整事件/u);

  // 草稿变更通知在 timer 前立即更新模型；连续通知仍只合并一次 50ms 重绘。
  drafts = Object.freeze([displayDraft("草稿第一版")]);
  displayChange?.(PARENT_ID);
  displayChange?.(WORKING_CHILD_ID);
  drafts = Object.freeze([displayDraft("草稿最后一版")]);
  displayChange?.(WORKING_CHILD_ID);
  displayChange?.(WORKING_CHILD_ID);
  assert.deepEqual(draftReads, [
    WORKING_CHILD_ID,
    WORKING_CHILD_ID,
    WORKING_CHILD_ID,
    WORKING_CHILD_ID,
  ]);
  assert.equal(renderRequests[1] ?? 0, 0);
  const beforeDraftFlush = viewer?.render(120).join("\n") ?? "";
  assert.doesNotMatch(beforeDraftFlush, /草稿第一版/u);
  assert.match(beforeDraftFlush, /草稿最后一版/u);

  // canonical 历史与树更新继续同步生效，但与草稿共用同一个待处理重绘。
  currentSnapshot = Object.freeze({ ...treeSnapshot(), tree_revision: 8 });
  treeChange?.();
  t.mock.timers.tick(49);
  assert.deepEqual(draftReads, [
    WORKING_CHILD_ID,
    WORKING_CHILD_ID,
    WORKING_CHILD_ID,
    WORKING_CHILD_ID,
  ]);
  assert.equal(renderRequests[1] ?? 0, 0);

  t.mock.timers.tick(1);
  assert.deepEqual(draftReads, [
    WORKING_CHILD_ID,
    WORKING_CHILD_ID,
    WORKING_CHILD_ID,
    WORKING_CHILD_ID,
  ]);
  assert.equal(renderRequests[1], 1);
  const afterDraftFlush = viewer?.render(120).join("\n") ?? "";
  assert.doesNotMatch(afterDraftFlush, /草稿第一版/u);
  assert.match(afterDraftFlush, /草稿最后一版/u);

  // Esc 关闭会退订并清除待处理调度；旧回调也不再读草稿或重绘。
  drafts = Object.freeze([displayDraft("关闭前待处理草稿")]);
  displayChange?.(WORKING_CHILD_ID);
  assert.equal(draftReads.length, 5);
  const staleDisplayChange = displayChange;
  viewer?.handleInput?.("\x1b");
  assert.equal(activityChange, undefined);
  assert.equal(displayChange, undefined);
  const readsAfterClose = draftReads.length;
  const rendersAfterClose = renderRequests[1] ?? 0;
  drafts = Object.freeze([displayDraft("关闭后草稿")]);
  staleDisplayChange?.(WORKING_CHILD_ID);
  t.mock.timers.tick(50);
  assert.equal(draftReads.length, readsAfterClose);
  assert.equal(renderRequests[1] ?? 0, rendersAfterClose);

  binding.dispose();
  await panelPromise;
  await Promise.all(overlayCompletions);
});

test("活动查看器优先消费一致 snapshot，并按 revision 忽略重复通知", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  type OverlayComponent = {
    render(width: number): string[];
    handleInput?(data: string): void;
  };
  const overlays: OverlayComponent[] = [];
  const completions: Promise<void>[] = [];
  const renderRequests: number[] = [];
  const ui = {
    custom: (
      factory: (
        tui: { requestRender(): void },
        theme: unknown,
        keybindings: unknown,
        done: (result: undefined) => void,
      ) => OverlayComponent,
    ) => {
      const index = overlays.length;
      let settle: () => void = () => {};
      const completion = new Promise<void>((resolve) => { settle = resolve; });
      overlays.push(factory(
        { requestRender: () => { renderRequests[index] = (renderRequests[index] ?? 0) + 1; } },
        MARKER_THEME,
        undefined,
        () => settle(),
      ));
      completions.push(completion);
      return completion;
    },
  } as unknown as NonNullable<AgentTreeUiContext["ui"]>;
  const source = {
    read: () => ({ ok: true as const, data: treeSnapshot() }),
    onChange: (_listener: () => void) => () => {},
  };
  const entryId = "11111111-1111-4111-8111-111111111111";
  const incarnationId = "22222222-2222-4222-8222-222222222222";
  const start: CanonicalAgentActivityEntry = Object.freeze({
    contract_version: CANONICAL_ACTIVITY_CONTRACT_VERSION,
    agent_id: WORKING_CHILD_ID,
    incarnation_id: incarnationId,
    entry_id: entryId,
    body: Object.freeze({
      type: "tool_execution_start",
      toolCallId: "snapshot-call",
      toolName: "read_file",
      origin: "unknown",
    }),
  });
  const end: CanonicalAgentActivityEntry = Object.freeze({
    ...start,
    body: Object.freeze({
      type: "tool_execution_end",
      toolCallId: "snapshot-call",
      toolName: "read_file",
      origin: "unknown",
      isError: false,
    }),
  });
  let currentActivity: AgentActivitySnapshot = Object.freeze({
    snapshotEpoch: 0,
    entries: Object.freeze([start]),
    revision: 1,
    olderActivityOmitted: false,
  });
  const snapshotReads: string[] = [];
  const replayReads: string[] = [];
  let activityChange: ((agentId: string) => void) | undefined;
  const activity: AgentActivityStreamSource = {
    readSnapshot: (agentId) => {
      snapshotReads.push(agentId);
      return currentActivity;
    },
    readReplay: (agentId) => {
      replayReads.push(agentId);
      return [];
    },
    onChange: (listener) => {
      activityChange = listener;
      return () => { if (activityChange === listener) activityChange = undefined; };
    },
  };
  const binding = bindAgentTreeUi(source, { hasUI: true, mode: "tui", ui }, activity);

  const panelPromise = binding.openPanel();
  await Promise.resolve();
  overlays[0]?.handleInput?.("\x1b[B");
  overlays[0]?.handleInput?.("\r");
  const viewer = overlays[1];
  assert.ok(viewer !== undefined);
  assert.deepEqual(snapshotReads, [WORKING_CHILD_ID]);
  assert.deepEqual(replayReads, []);
  assert.match(viewer.render(120).join("\n"), /↻.*read_file/u);

  currentActivity = Object.freeze({
    snapshotEpoch: 0,
    entries: Object.freeze([end]),
    revision: 2,
    olderActivityOmitted: true,
  });
  activityChange?.(WORKING_CHILD_ID);
  const updated = viewer.render(120).join("\n");
  assert.match(updated, /Older activity omitted/u);
  assert.match(updated, /✓.*read_file/u);
  assert.doesNotMatch(updated, /↻/u);
  t.mock.timers.tick(50);
  assert.equal(renderRequests[1], 1);

  // 同 revision 的冲突载荷是 stale 快照：读取一次，但模型与重绘都 no-op。
  currentActivity = Object.freeze({
    snapshotEpoch: 0,
    entries: Object.freeze([start]),
    revision: 2,
    olderActivityOmitted: false,
  });
  activityChange?.(WORKING_CHILD_ID);
  t.mock.timers.tick(50);
  assert.equal(renderRequests[1], 1);
  assert.match(viewer.render(120).join("\n"), /✓.*read_file/u);
  assert.deepEqual(snapshotReads, [WORKING_CHILD_ID, WORKING_CHILD_ID, WORKING_CHILD_ID]);
  assert.deepEqual(replayReads, []);

  binding.dispose();
  await panelPromise;
  await Promise.all(completions);
});

/* ---------------------------------- 鼠标支持 ---------------------------------- */

/** 全字段填齐的 TuiMouseEvent 构造器；未覆盖字段使用中性默认值。 */
function mkMouseEvent(
  overrides: Partial<TuiMouseEvent> & Pick<TuiMouseEvent, "type">,
): TuiMouseEvent {
  return {
    button: "none",
    x: 0,
    y: 0,
    screenX: 0,
    screenY: 0,
    width: 80,
    height: 24,
    shift: false,
    alt: false,
    ctrl: false,
    ...overrides,
  };
}

test("鼠标滚轮滚动树视口并把选中行同步进视口", () => {
  const panel = new AgentTreePanelModel(treeSnapshot(), { viewport_height: 2 });
  // 初始 5 行（顶层默认展开），offset=0，选中第一行。
  assert.equal(panel.getPublicState().selected_key, PARENT_ID);
  assert.equal(panel.getPublicState().scroll_offset, 0);

  // 向下滚 3 行：offset 夹紧到 3，选中行同步到视口内第一行。
  assert.deepEqual(
    panel.handleMouse(mkMouseEvent({ type: "wheel", wheelDelta: 3, y: 4 }), true),
    { handled: true },
  );
  const scrolled = panel.getPublicState();
  assert.equal(scrolled.scroll_offset, 3);
  assert.equal(scrolled.selected_key, TERMINATED_PARENT_ID);

  // 继续向下滚：offset 已到底，选中行保持在视口内。
  panel.handleMouse(mkMouseEvent({ type: "wheel", wheelDelta: 5, y: 4 }), true);
  const bottom = panel.getPublicState();
  assert.equal(bottom.scroll_offset, 3);
  assert.equal(bottom.selected_key, TERMINATED_PARENT_ID);

  // 向上滚回顶部：选中行同步到视口内最后一行。
  assert.deepEqual(
    panel.handleMouse(mkMouseEvent({ type: "wheel", wheelDelta: -5, y: 4 }), true),
    { handled: true },
  );
  const top = panel.getPublicState();
  assert.equal(top.scroll_offset, 0);
  assert.equal(top.selected_key, WORKING_CHILD_ID);

  // wheelDelta 为 0 的滚轮事件被忽略。
  assert.equal(
    panel.handleMouse(mkMouseEvent({ type: "wheel", wheelDelta: 0, y: 4 }), true),
    undefined,
  );
  assert.equal(panel.getPublicState().scroll_offset, 0);

  // 空树滚轮与点击仍吞事件且不产生选中。
  const empty = new AgentTreePanelModel(Object.freeze({
    tree_revision: 1,
    scope: Object.freeze({ kind: "root" as const }),
    nodes: Object.freeze([]),
  }), { viewport_height: 2 });
  assert.deepEqual(
    empty.handleMouse(mkMouseEvent({ type: "wheel", wheelDelta: 3, y: 3 }), true),
    { handled: true },
  );
  assert.deepEqual(
    empty.handleMouse(mkMouseEvent({ type: "click", button: "left", y: 3 }), true),
    { handled: true },
  );
  assert.equal(empty.getPublicState().selected_key, undefined);
});

test("鼠标左键点击已选中的有子节点行切换折叠，再点还原", () => {
  const panel = new AgentTreePanelModel(treeSnapshot(), { viewport_height: 8 });
  assert.equal(panel.getPublicState().selected_key, PARENT_ID);

  // framed：正文从 y=3 开始；点击选中行折叠其子树。
  assert.deepEqual(
    panel.handleMouse(mkMouseEvent({ type: "click", button: "left", y: 3 }), true),
    { handled: true },
  );
  const collapsed = panel.getPublicState();
  assert.ok(!collapsed.expanded_agent_ids.includes(PARENT_ID));
  assert.equal(collapsed.selected_key, PARENT_ID);
  assert.match(
    panel.render(160).join("\n"),
    /descendants 2 · working 1 · failed 0 · terminated 1/u,
  );

  // 再次点击还原展开。
  assert.deepEqual(
    panel.handleMouse(mkMouseEvent({ type: "click", button: "left", y: 3 }), true),
    { handled: true },
  );
  assert.ok(panel.getPublicState().expanded_agent_ids.includes(PARENT_ID));

  // narrow：正文从 y=1 开始。
  assert.deepEqual(
    panel.handleMouse(mkMouseEvent({ type: "click", button: "left", y: 1 }), false),
    { handled: true },
  );
  assert.ok(!panel.getPublicState().expanded_agent_ids.includes(PARENT_ID));
  panel.handleMouse(mkMouseEvent({ type: "click", button: "left", y: 1 }), false);
  assert.ok(panel.getPublicState().expanded_agent_ids.includes(PARENT_ID));
});

test("鼠标左键点击未选中行移动选择，点击选中但无子节点的行不折叠", () => {
  const panel = new AgentTreePanelModel(treeSnapshot(), { viewport_height: 8 });

  // 点击第二行（working-child）：只移动选择，不折叠任何节点。
  assert.deepEqual(
    panel.handleMouse(mkMouseEvent({ type: "click", button: "left", y: 4 }), true),
    { handled: true },
  );
  const moved = panel.getPublicState();
  assert.equal(moved.selected_key, WORKING_CHILD_ID);
  assert.ok(moved.expanded_agent_ids.includes(PARENT_ID));

  // 点击已选中的叶子行（无子节点）：无折叠变化，仍吞事件。
  assert.deepEqual(
    panel.handleMouse(mkMouseEvent({ type: "click", button: "left", y: 4 }), true),
    { handled: true },
  );
  assert.equal(panel.getPublicState().selected_key, WORKING_CHILD_ID);
  assert.equal(panel.getPublicState().scroll_offset, 0);
});

test("鼠标点击 header、footer 与边框行吞事件但无状态变化", () => {
  const panel = new AgentTreePanelModel(treeSnapshot(), { viewport_height: 8 });
  assert.equal(panel.getPublicState().selected_key, PARENT_ID);

  // framed：顶边框、header、分隔线、分隔线、footer、底边框都在正文区之外。
  for (const y of [0, 1, 2, 11, 12, 13]) {
    assert.deepEqual(
      panel.handleMouse(mkMouseEvent({ type: "click", button: "left", y }), true),
      { handled: true },
    );
  }
  const untouched = panel.getPublicState();
  assert.equal(untouched.selected_key, PARENT_ID);
  assert.equal(untouched.scroll_offset, 0);
  assert.ok(untouched.expanded_agent_ids.includes(PARENT_ID));

  // narrow：header 与 footer 同样只吞事件。
  for (const y of [0, 9]) {
    assert.deepEqual(
      panel.handleMouse(mkMouseEvent({ type: "click", button: "left", y }), false),
      { handled: true },
    );
  }
  assert.equal(panel.getPublicState().selected_key, PARENT_ID);
});

test("非滚轮与非左键点击的鼠标事件返回 undefined", () => {
  const panel = new AgentTreePanelModel(treeSnapshot(), { viewport_height: 8 });

  for (const type of ["press", "release", "move", "drag"] as const) {
    assert.equal(
      panel.handleMouse(mkMouseEvent({ type, button: "left", y: 3 }), true),
      undefined,
    );
  }
  // 右键点击同样不处理。
  assert.equal(
    panel.handleMouse(mkMouseEvent({ type: "click", button: "right", y: 3 }), true),
    undefined,
  );
  assert.equal(panel.getPublicState().selected_key, PARENT_ID);
});

/* --------------------------------- Home/End 跳转 --------------------------------- */

test("Home/End 跳转树首尾行，重复按键忽略且 footer 提示更新", () => {
  const panel = new AgentTreePanelModel(treeSnapshot(), { viewport_height: 2 });
  // 初始在首行：按 Home 忽略。
  assert.equal(panel.getPublicState().selected_key, PARENT_ID);
  assert.equal(panel.handleInput("\x1b[H"), "ignored");

  // End 跳到最后一行：选中 incomplete-child，视口收敛到底部。
  assert.equal(panel.handleInput("\x1b[F"), "changed");
  let state = panel.getPublicState();
  assert.equal(state.selected_key, INCOMPLETE_CHILD_ID);
  assert.equal(state.scroll_offset, 3);
  // 已在尾部：再次 End 忽略。
  assert.equal(panel.handleInput("\x1b[F"), "ignored");

  // Home 跳回首行：视口回顶。
  assert.equal(panel.handleInput("\x1b[H"), "changed");
  state = panel.getPublicState();
  assert.equal(state.selected_key, PARENT_ID);
  assert.equal(state.scroll_offset, 0);
  // 已在首部：再次 Home 忽略。
  assert.equal(panel.handleInput("\x1b[H"), "ignored");

  // 空树：Home/End 均忽略。
  const empty = new AgentTreePanelModel(Object.freeze({
    tree_revision: 1,
    scope: Object.freeze({ kind: "root" as const }),
    nodes: Object.freeze([]),
  }), { viewport_height: 2 });
  assert.equal(empty.handleInput("\x1b[H"), "ignored");
  assert.equal(empty.handleInput("\x1b[F"), "ignored");

  // footer 提示新快捷键。
  assert.ok(
    (panel.render(160).at(-1) ?? "").includes("Home/End jump"),
    panel.render(160).join("\n"),
  );
});
