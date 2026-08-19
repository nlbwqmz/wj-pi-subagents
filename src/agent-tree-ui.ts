import type {
  AgentSnapshot,
  ControlResult,
  ScopedAgentTreeSnapshot,
} from "./tree-controller.ts";
import {
  isCanonicalUuid,
} from "./tree-controller.ts";
import { parseAgentSnapshot } from "./agent-snapshot-codec.ts";

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const COMBINING_MARK_PATTERN = /^\p{Mark}$/u;
const EXTENDED_PICTOGRAPHIC_PATTERN = /\p{Extended_Pictographic}/u;
const REGIONAL_INDICATOR_PATTERN = /\p{Regional_Indicator}/u;
const TERMINAL_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/gu;

export interface AgentTreePanelOptions {
  /** 同时显示的树正文行数，不包含标题和键位提示。 */
  readonly viewport_height?: number;
}

interface AgentTreeCustomOptions {
  readonly overlay?: boolean;
  readonly overlayOptions?: {
    readonly width?: number | `${number}%`;
    readonly anchor?: "center";
    readonly margin?: number;
  };
}

interface AgentTreePanelTheme {
  fg?(color: string, text: string): string;
  bg?(color: string, text: string): string;
  bold?(text: string): string;
}

interface PanelRow {
  readonly key: string;
  readonly text: string;
}

interface BranchAggregate {
  readonly descendants: number;
  readonly working: number;
  readonly failed: number;
  readonly pending: number;
}

interface FinishedAggregate {
  readonly completed: number;
  readonly failed: number;
  readonly incomplete: number;
}

export interface AgentTreePanelPublicState {
  readonly status: "ready" | "error";
  readonly tree_revision: number;
  readonly selected_key?: string;
  readonly scroll_offset: number;
  readonly expanded_agent_ids: readonly string[];
  readonly finished_expanded: boolean;
}

export interface AgentTreeSnapshotSource {
  read(): ControlResult<ScopedAgentTreeSnapshot>;
  onChange(listener: () => void): () => void;
}

interface AgentTreeTui {
  requestRender(): void;
}

interface AgentTreeComponent {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate(): void;
  dispose?(): void;
}

interface AgentTreeUiSurface {
  setWidget?(
    key: string,
    content: string[] | ((tui: AgentTreeTui, theme: unknown) => AgentTreeComponent) | undefined,
    options?: { readonly placement?: "aboveEditor" | "belowEditor" },
  ): void;
  custom?<T>(
    factory: (
      tui: AgentTreeTui,
      theme: unknown,
      keybindings: unknown,
      done: (result: T) => void,
    ) => AgentTreeComponent | Promise<AgentTreeComponent>,
    options?: AgentTreeCustomOptions,
  ): Promise<T>;
  notify?(message: string, type?: "info" | AgentTreeNotificationType): void;
}

export interface AgentTreeUiContext {
  readonly hasUI?: unknown;
  readonly mode?: unknown;
  readonly ui?: AgentTreeUiSurface;
}

export interface AgentTreeUiBinding {
  openPanel(context?: AgentTreeUiContext): Promise<void>;
  dispose(): void;
}

const AGENTS_WIDGET_KEY = "wj-pi-subagents-agents";
const AGENTS_WIDGET_TITLE = "● Agents";
const ELAPSED_REFRESH_INTERVAL_MS = 1_000;
/** 与 Pi Loader 默认 Working 指示器保持一致。 */
const WORKING_SPINNER_FRAMES = Object.freeze([
  "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏",
]);
const WORKING_SPINNER_INTERVAL_MS = 80;
const INITIAL_WORKING_SPINNER_FRAME = WORKING_SPINNER_FRAMES[0] ?? "⠋";
const DEFAULT_PANEL_VIEWPORT_HEIGHT = 12;
const AGENT_TREE_OVERLAY_OPTIONS = Object.freeze({
  width: 96,
  anchor: "center" as const,
  margin: 1,
});

export type AgentTreePanelInputOutcome = "changed" | "ignored" | "close";
export type AgentTreePanelUpdateOutcome = "changed" | "ignored" | "close" | "error";

export type AgentTreeNotificationType = "warning" | "error";
export type AgentTreeNotify = (message: string, type: AgentTreeNotificationType) => void;

/** 比较相邻完整修订，只通知新进入的异常事实。 */
export class AgentTreeFailureNotifier {
  private snapshot: ScopedAgentTreeSnapshot;
  private readonly notify: AgentTreeNotify;

  constructor(snapshot: ScopedAgentTreeSnapshot, notify: AgentTreeNotify) {
    this.snapshot = snapshot;
    this.notify = notify;
  }

  update(snapshot: ScopedAgentTreeSnapshot): "changed" | "ignored" | "error" {
    if (!isValidScopedSnapshot(snapshot) || !sameScope(this.snapshot, snapshot)) return "error";
    if (snapshot.tree_revision <= this.snapshot.tree_revision) return "ignored";
    const previous = new Map(this.snapshot.nodes.map((node) => [node.agent_id, node] as const));
    const failed = snapshot.nodes.filter((node) =>
      node.state === "failed" && previous.get(node.agent_id)?.state !== "failed",
    );
    const incomplete = snapshot.nodes.filter((node) =>
      node.error?.code === "termination_incomplete"
      && previous.get(node.agent_id)?.error?.code !== "termination_incomplete",
    );
    this.snapshot = snapshot;
    this.notifyAggregate("Subagent failures", failed, "internal_error", "warning");
    this.notifyAggregate("Subagent cleanup incomplete", incomplete, "termination_incomplete", "error");
    return "changed";
  }

  private notifyAggregate(
    label: string,
    nodes: readonly AgentSnapshot[],
    fallbackCode: string,
    type: AgentTreeNotificationType,
  ): void {
    if (nodes.length === 0) return;
    const templates = countBy(nodes, (node) => node.template_id);
    const codes = countBy(nodes, (node) => node.error?.code ?? fallbackCode);
    const message = `${label}: ${formatCounts(templates)}; ${formatCounts(codes)}`;
    try {
      this.notify(message, type);
    } catch {
      // UI 观察者异常不能影响树控制面，也不能回退为模型消息。
    }
  }
}

/** 将纯投影绑定到 Pi UI API；任何失败都保持在 UI 边界内。 */
export function bindAgentTreeUi(
  source: AgentTreeSnapshotSource,
  context: AgentTreeUiContext,
): AgentTreeUiBinding {
  if (context.hasUI !== true || context.ui === undefined) return inertUiBinding();
  const ui = context.ui;
  let disposed = false;
  let snapshot: ScopedAgentTreeSnapshot | undefined;
  let sourceError = false;
  let notifier: AgentTreeFailureNotifier | undefined;
  let activePanel: {
    model: AgentTreePanelModel | undefined;
    readonly tui: AgentTreeTui;
    readonly done: () => void;
  } | undefined;
  let panelPromise: Promise<void> | undefined;
  let workingSpinnerFrame = 0;
  let widgetHasWorkingAgent = false;
  const widgetTuis = new Set<AgentTreeTui>();

  const read = (): ControlResult<ScopedAgentTreeSnapshot> | undefined => {
    try {
      return source.read();
    } catch {
      return undefined;
    }
  };
  const initial = read();
  if (initial?.ok === true && isValidScopedSnapshot(initial.data)) {
    snapshot = initial.data;
    widgetHasWorkingAgent = hasWorkingWidgetRows(initial.data);
    notifier = typeof ui.notify === "function"
      ? new AgentTreeFailureNotifier(initial.data, (message, type) => ui.notify?.(message, type))
      : undefined;
  } else {
    sourceError = true;
  }

  const requestRender = (): void => {
    for (const tui of widgetTuis) safeRequestRender(tui);
    if (activePanel !== undefined) safeRequestRender(activePanel.tui);
  };
  const widgetLines = (width: number): string[] => {
    if (sourceError || snapshot === undefined) return [
      truncateToDisplayWidth(AGENTS_WIDGET_TITLE, width),
      truncateToDisplayWidth("└─ × Agent tree temporarily unavailable", width),
    ];
    try {
      const frame = WORKING_SPINNER_FRAMES[workingSpinnerFrame] ?? INITIAL_WORKING_SPINNER_FRAME;
      return [...renderAgentsWidget(snapshot, width, frame)];
    } catch {
      sourceError = true;
      return [
        truncateToDisplayWidth(AGENTS_WIDGET_TITLE, width),
        truncateToDisplayWidth("└─ × Agent tree temporarily unavailable", width),
      ];
    }
  };
  const setWidget = (): void => {
    if (typeof ui.setWidget !== "function") return;
    try {
      if (context.mode === "tui") {
        ui.setWidget(AGENTS_WIDGET_KEY, (tui) => {
          widgetTuis.add(tui);
          return {
            render: (width) => widgetLines(width),
            invalidate: () => {},
            dispose: () => { widgetTuis.delete(tui); },
          };
        }, { placement: "aboveEditor" });
      } else if (context.mode === "rpc") {
        ui.setWidget(AGENTS_WIDGET_KEY, widgetLines(120), { placement: "aboveEditor" });
      }
    } catch {
      // 无 UI 或宿主拒绝 widget 时不建立模型消息回退。
    }
  };
  setWidget();

  const spinnerTimer = setInterval(() => {
    if (disposed || !widgetHasWorkingAgent) return;
    workingSpinnerFrame = (workingSpinnerFrame + 1) % WORKING_SPINNER_FRAMES.length;
    for (const tui of widgetTuis) safeRequestRender(tui);
    if (context.mode === "rpc") setWidget();
  }, WORKING_SPINNER_INTERVAL_MS);
  spinnerTimer.unref?.();

  const handleChange = (): void => {
    if (disposed) return;
    const result = read();
    if (result?.ok !== true || !isValidScopedSnapshot(result.data)) {
      widgetHasWorkingAgent = false;
      if (result?.ok === false && result.error.code === "agent_not_found") {
        activePanel?.done();
        activePanel = undefined;
      } else {
        sourceError = true;
        activePanel?.model?.markError();
      }
      requestRender();
      if (context.mode === "rpc") setWidget();
      return;
    }
    if (snapshot !== undefined && result.data.tree_revision <= snapshot.tree_revision) return;
    const previousWidgetHasWorkingAgent = widgetHasWorkingAgent;
    snapshot = result.data;
    widgetHasWorkingAgent = hasWorkingWidgetRows(result.data);
    if (!previousWidgetHasWorkingAgent && widgetHasWorkingAgent) workingSpinnerFrame = 0;
    sourceError = false;
    if (notifier === undefined && typeof ui.notify === "function") {
      notifier = new AgentTreeFailureNotifier(result.data, (message, type) => ui.notify?.(message, type));
    } else {
      notifier?.update(result.data);
    }
    if (activePanel !== undefined) {
      if (activePanel.model === undefined) {
        activePanel.model = new AgentTreePanelModel(result.data);
        requestRender();
        if (context.mode === "rpc") setWidget();
        return;
      }
      const outcome = activePanel.model.update(result.data);
      if (outcome === "close") {
        activePanel.done();
        activePanel = undefined;
      } else if (outcome === "error") {
        activePanel.model.markError();
      }
    }
    requestRender();
    if (context.mode === "rpc") setWidget();
  };
  let unsubscribe: (() => void) | undefined;
  try {
    unsubscribe = source.onChange(handleChange);
  } catch {
    sourceError = true;
  }
  const elapsedTimer = setInterval(() => {
    if (disposed || snapshot === undefined) return;
    const result = read();
    if (result?.ok !== true || !isValidScopedSnapshot(result.data)) return;
    if (result.data.tree_revision > snapshot.tree_revision) {
      handleChange();
      return;
    }
    if (result.data.tree_revision < snapshot.tree_revision) return;
    const comparison = compareElapsedRefresh(snapshot, result.data);
    if (comparison === "ignored") return;
    if (comparison === "error") {
      sourceError = true;
      activePanel?.model?.markError();
    } else {
      snapshot = result.data;
      if (activePanel?.model?.refreshElapsed(result.data) === "error") sourceError = true;
    }
    requestRender();
    if (context.mode === "rpc") setWidget();
  }, ELAPSED_REFRESH_INTERVAL_MS);
  elapsedTimer.unref?.();

  const binding: AgentTreeUiBinding = Object.freeze({
    openPanel: (overrideContext = context): Promise<void> => {
      if (disposed || overrideContext.hasUI !== true || overrideContext.mode !== "tui") {
        return Promise.resolve();
      }
      const custom = overrideContext.ui?.custom;
      if (typeof custom !== "function") return Promise.resolve();
      if (panelPromise !== undefined) return panelPromise;
      let invocation: Promise<void>;
      try {
        invocation = custom.call(overrideContext.ui, (tui, theme, _keybindings, done) => {
          let closed = false;
          const finish = (): void => {
            if (closed) return;
            closed = true;
            done(undefined);
          };
          const panel = {
            model: snapshot === undefined ? undefined : new AgentTreePanelModel(snapshot),
            tui,
            done: finish,
          };
          if (sourceError) panel.model?.markError();
          activePanel = panel;
          return {
            render: (width) => {
              try {
                return [...renderAgentTreePanelSurface(panel.model, width, theme)];
              } catch {
                panel.model?.markError();
                return [...renderAgentTreePanelSurface(panel.model, width, undefined)];
              }
            },
            handleInput: (data) => {
              try {
                if (panel.model === undefined) {
                  if (data === "\x1b") finish();
                } else if (panel.model.handleInput(data) === "close") finish();
              } catch {
                panel.model?.markError();
              }
              safeRequestRender(tui);
            },
            invalidate: () => {},
            dispose: () => {
              if (activePanel === panel) activePanel = undefined;
            },
          };
        }, {
          overlay: true,
          overlayOptions: AGENT_TREE_OVERLAY_OPTIONS,
        }) as Promise<void>;
      } catch {
        return Promise.resolve();
      }
      panelPromise = invocation.finally(() => {
        panelPromise = undefined;
        activePanel = undefined;
      });
      return panelPromise;
    },
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      clearInterval(elapsedTimer);
      clearInterval(spinnerTimer);
      try { unsubscribe?.(); } catch {}
      unsubscribe = undefined;
      activePanel?.done();
      activePanel = undefined;
      widgetTuis.clear();
      try {
        ui.setWidget?.(AGENTS_WIDGET_KEY, undefined, { placement: "aboveEditor" });
      } catch {
        // 宿主清理异常不恢复订阅或模型回退。
      }
    },
  });
  return binding;
}

/** 计算无 ANSI 文本的终端列宽，避免按 UTF-16 单元切断 Unicode 字符。 */
export function displayWidth(value: string): number {
  let width = 0;
  for (const { segment } of SEGMENTER.segment(value)) width += graphemeWidth(segment);
  return width;
}

/** 超宽时保留一个省略号，并始终在字素簇边界截断。 */
export function truncateToDisplayWidth(value: string, width: number): string {
  if (!Number.isSafeInteger(width) || width <= 0) return "";
  if (displayWidth(value) <= width) return value;
  if (width === 1) return "…";
  const available = width - 1;
  let used = 0;
  let output = "";
  for (const { segment } of SEGMENTER.segment(value)) {
    const next = graphemeWidth(segment);
    if (used + next > available) break;
    output += segment;
    used += next;
  }
  return `${output}…`;
}

/** 常驻区域只投影当前会话的直接、未终止子代理。 */
export function renderAgentsWidget(
  snapshot: ScopedAgentTreeSnapshot,
  width: number,
  workingFrame: string = INITIAL_WORKING_SPINNER_FRAME,
): readonly string[] {
  const nodes = directWidgetNodes(snapshot);
  const rows = nodes.map((node, index) => {
    const branch = index === nodes.length - 1 ? "└─" : "├─";
    const icon = formatAgentStateIcon(node, workingFrame);
    return truncateToDisplayWidth(`${branch} ${icon} ${formatAgentFacts(node, {
      includeActivityCategoryCount: false,
    })}`, width);
  });
  if (rows.length === 0) return Object.freeze([]);
  return Object.freeze([truncateToDisplayWidth(AGENTS_WIDGET_TITLE, width), ...rows]);
}

/** `/agents` 的纯交互投影；它只消费一次完整的作用域树快照。 */
export class AgentTreePanelModel {
  private snapshot: ScopedAgentTreeSnapshot;
  private status: "ready" | "error" = "ready";
  private readonly viewportHeight: number;
  private readonly expandedAgentIds = new Set<string>();
  private finishedExpanded = false;
  private selectedIndex = 0;
  private scrollOffset = 0;

  constructor(snapshot: ScopedAgentTreeSnapshot, options: AgentTreePanelOptions = {}) {
    this.snapshot = snapshot;
    this.viewportHeight = validViewportHeight(options.viewport_height);
    for (const node of this.topLevelNodes()) this.expandedAgentIds.add(node.agent_id);
  }

  render(width: number): readonly string[] {
    if (this.status === "error") return Object.freeze([
      truncateToDisplayWidth("Agent tree", width),
      truncateToDisplayWidth("Agent tree temporarily unavailable", width),
      truncateToDisplayWidth("Esc close", width),
    ]);
    const rows = this.buildRows();
    this.clampSelection(rows.length);
    const visible = rows.slice(this.scrollOffset, this.scrollOffset + this.viewportHeight);
    return Object.freeze([
      truncateToDisplayWidth(`Agent tree · revision ${this.snapshot.tree_revision}`, width),
      ...visible.map((row, index) => truncateToDisplayWidth(
        `${this.scrollOffset + index === this.selectedIndex ? "› " : "  "}${row.text}`,
        width,
      )),
      truncateToDisplayWidth("↑↓ scroll · ←→ fold · Esc close", width),
    ]);
  }

  markError(): void {
    this.status = "error";
  }

  update(snapshot: ScopedAgentTreeSnapshot): AgentTreePanelUpdateOutcome {
    if (!isValidScopedSnapshot(snapshot)) {
      this.status = "error";
      return "error";
    }
    if (snapshot.tree_revision <= this.snapshot.tree_revision) return "ignored";
    if (!sameScope(this.snapshot, snapshot)) {
      this.status = "error";
      return "error";
    }
    if (
      snapshot.scope.kind === "subtree"
      && !snapshot.nodes.some((node) =>
        node.agent_id === snapshot.scope.agent_id && node.parent_agent_id === null,
      )
    ) return "close";
    this.snapshot = snapshot;
    this.status = "ready";
    const ids = new Set(snapshot.nodes.map((node) => node.agent_id));
    for (const id of [...this.expandedAgentIds]) if (!ids.has(id)) this.expandedAgentIds.delete(id);
    const rows = this.buildRows();
    this.clampSelection(rows.length);
    return "changed";
  }

  /** 同一修订内只接受单调时钟派生的时长变化，其余事实必须保持完全一致。 */
  refreshElapsed(snapshot: ScopedAgentTreeSnapshot): AgentTreePanelUpdateOutcome {
    if (!isValidScopedSnapshot(snapshot) || !sameScope(this.snapshot, snapshot)) {
      this.status = "error";
      return "error";
    }
    if (snapshot.tree_revision > this.snapshot.tree_revision) return this.update(snapshot);
    if (snapshot.tree_revision < this.snapshot.tree_revision) return "ignored";
    const comparison = compareElapsedRefresh(this.snapshot, snapshot);
    if (comparison === "error") this.status = "error";
    if (comparison !== "changed") return comparison;
    this.snapshot = snapshot;
    return "changed";
  }

  handleInput(data: string): AgentTreePanelInputOutcome {
    if (data === "\x1b") return "close";
    if (this.status === "error") return "ignored";
    const rows = this.buildRows();
    this.clampSelection(rows.length);
    if (data === "\x1b[A" || data === "k") {
      if (this.selectedIndex <= 0) return "ignored";
      this.selectedIndex -= 1;
      this.clampSelection(rows.length);
      return "changed";
    }
    if (data === "\x1b[B" || data === "j") {
      if (this.selectedIndex >= rows.length - 1) return "ignored";
      this.selectedIndex += 1;
      this.clampSelection(rows.length);
      return "changed";
    }
    const selected = rows[this.selectedIndex];
    if (selected === undefined) return "ignored";
    if (data === "\x1b[C" || data === "l") return this.expandSelected(selected.key);
    if (data === "\x1b[D" || data === "h") return this.collapseSelected(selected.key);
    return "ignored";
  }

  getViewportHeight(): number {
    return this.viewportHeight;
  }

  getPublicState(): AgentTreePanelPublicState {
    const rows = this.buildRows();
    this.clampSelection(rows.length);
    return Object.freeze({
      status: "ready" as const,
      ...(this.status === "error" ? { status: "error" as const } : {}),
      tree_revision: this.snapshot.tree_revision,
      ...(this.status === "error" || rows[this.selectedIndex] === undefined
        ? {}
        : { selected_key: rows[this.selectedIndex]!.key }),
      scroll_offset: this.scrollOffset,
      expanded_agent_ids: Object.freeze(this.snapshot.nodes
        .filter((node) => this.expandedAgentIds.has(node.agent_id))
        .map((node) => node.agent_id)),
      finished_expanded: this.finishedExpanded,
    });
  }

  private buildRows(): readonly PanelRow[] {
    const childrenByParent = this.childrenByParent();
    const rows: PanelRow[] = [];
    const append = (node: AgentSnapshot, level: number): void => {
      const children = this.sortedChildren(node.agent_id, childrenByParent);
      const expandable = children.length > 0;
      const expanded = expandable && this.expandedAgentIds.has(node.agent_id);
      const marker = expandable ? (expanded ? "▾" : "▸") : "·";
      const aggregate = expanded || !expandable ? "" : formatBranchAggregate(
        this.branchAggregate(node.agent_id, childrenByParent),
      );
      rows.push(Object.freeze({
        key: node.agent_id,
        text: `${"  ".repeat(level)}${marker} ${formatAgentFacts(node)}${aggregate}`,
      }));
      if (expanded) for (const child of children) append(child, level + 1);
    };
    for (const node of this.sortedTopLevelNodes(childrenByParent)) append(node, 0);
    const finished = this.finishedAggregate();
    if (finished.completed + finished.failed + finished.incomplete > 0) {
      rows.push(Object.freeze({
        key: "finished",
        text: `${this.finishedExpanded ? "▾" : "▸"} finished · completed ${finished.completed} · failed ${finished.failed} · incomplete ${finished.incomplete}`,
      }));
      if (this.finishedExpanded) {
        for (const node of this.finishedNodes()) {
          rows.push(Object.freeze({
            key: `finished:${node.agent_id}`,
            text: `  · ${safeUiFact(node.template_id)} · ${safeUiFact(node.name)} · ${finishedKind(node)}${node.error === undefined ? "" : ` · ${node.error.code}`}`,
          }));
        }
      }
    }
    return Object.freeze(rows);
  }

  private topLevelNodes(): readonly AgentSnapshot[] {
    const parentAgentId = this.snapshot.scope.kind === "root"
      ? null
      : this.snapshot.scope.agent_id ?? null;
    return this.snapshot.nodes.filter((node) =>
      node.parent_agent_id === parentAgentId && node.state !== "terminated",
    );
  }

  private childrenByParent(): ReadonlyMap<string, readonly AgentSnapshot[]> {
    const result = new Map<string, AgentSnapshot[]>();
    for (const node of this.snapshot.nodes) {
      if (node.parent_agent_id === null || node.state === "terminated") continue;
      const children = result.get(node.parent_agent_id) ?? [];
      children.push(node);
      result.set(node.parent_agent_id, children);
    }
    return result;
  }

  private sortedTopLevelNodes(
    childrenByParent: ReadonlyMap<string, readonly AgentSnapshot[]>,
  ): readonly AgentSnapshot[] {
    return stablePrioritySort(this.topLevelNodes(), (node) => this.branchNeedsAttention(node, childrenByParent));
  }

  private sortedChildren(
    agentId: string,
    childrenByParent: ReadonlyMap<string, readonly AgentSnapshot[]>,
  ): readonly AgentSnapshot[] {
    return stablePrioritySort(childrenByParent.get(agentId) ?? [], (node) =>
      this.branchNeedsAttention(node, childrenByParent));
  }

  private branchNeedsAttention(
    node: AgentSnapshot,
    childrenByParent: ReadonlyMap<string, readonly AgentSnapshot[]>,
  ): boolean {
    if (
      node.state !== "idle"
      || pendingQueueCount(node) > 0
      || node.activity !== undefined
      || node.error !== undefined
    ) return true;
    return (childrenByParent.get(node.agent_id) ?? [])
      .some((child) => this.branchNeedsAttention(child, childrenByParent));
  }

  private branchAggregate(
    agentId: string,
    childrenByParent: ReadonlyMap<string, readonly AgentSnapshot[]>,
  ): BranchAggregate {
    let descendants = 0;
    let working = 0;
    let failed = 0;
    let pending = 0;
    const visit = (parentId: string): void => {
      for (const child of childrenByParent.get(parentId) ?? []) {
        descendants += 1;
        if (child.state === "working") working += 1;
        if (child.state === "failed") failed += 1;
        pending += pendingQueueCount(child);
        visit(child.agent_id);
      }
    };
    visit(agentId);
    return Object.freeze({ descendants, working, failed, pending });
  }

  private finishedAggregate(): FinishedAggregate {
    let completed = 0;
    let failed = 0;
    let incomplete = 0;
    for (const node of this.snapshot.nodes) {
      if (node.state !== "terminated") continue;
      if (node.termination_result === "completed") completed += 1;
      if (node.termination_result === "failed") failed += 1;
      if (node.termination_result === "incomplete") incomplete += 1;
    }
    return Object.freeze({ completed, failed, incomplete });
  }

  private finishedNodes(): readonly AgentSnapshot[] {
    return this.snapshot.nodes.filter((node) => node.state === "terminated");
  }

  private clampSelection(rowCount: number): void {
    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, Math.max(0, rowCount - 1)));
    const maxOffset = Math.max(0, rowCount - this.viewportHeight);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
    if (this.selectedIndex < this.scrollOffset) this.scrollOffset = this.selectedIndex;
    if (this.selectedIndex >= this.scrollOffset + this.viewportHeight) {
      this.scrollOffset = this.selectedIndex - this.viewportHeight + 1;
    }
  }

  private expandSelected(key: string): AgentTreePanelInputOutcome {
    if (key === "finished") {
      if (this.finishedExpanded) return "ignored";
      this.finishedExpanded = true;
      return "changed";
    }
    const hasChildren = (this.childrenByParent().get(key) ?? []).length > 0;
    if (!hasChildren || this.expandedAgentIds.has(key)) return "ignored";
    this.expandedAgentIds.add(key);
    return "changed";
  }

  private collapseSelected(key: string): AgentTreePanelInputOutcome {
    if (key === "finished") {
      if (!this.finishedExpanded) return "ignored";
      this.finishedExpanded = false;
      return "changed";
    }
    if (this.expandedAgentIds.has(key)) {
      this.expandedAgentIds.delete(key);
      this.clampSelection(this.buildRows().length);
      return "changed";
    }
    const node = this.snapshot.nodes.find((candidate) => candidate.agent_id === key);
    const parentId = node?.parent_agent_id;
    if (parentId === null || parentId === undefined) return "ignored";
    const rows = this.buildRows();
    const parentIndex = rows.findIndex((row) => row.key === parentId);
    if (parentIndex < 0) return "ignored";
    this.selectedIndex = parentIndex;
    this.clampSelection(rows.length);
    return "changed";
  }
}

type AgentTreePanelLineStyle = "header" | "body" | "selected" | "error" | "footer";

/** 将纯树投影包装成完整主题表面，避免 overlay 内部继续透出底层会话内容。 */
export function renderAgentTreePanelSurface(
  model: AgentTreePanelModel | undefined,
  width: number,
  theme: unknown,
): readonly string[] {
  const panelWidth = Number.isSafeInteger(width) && width > 0 ? width : 0;
  if (panelWidth === 0) return Object.freeze([]);
  const framed = panelWidth >= 6;
  const contentWidth = framed ? panelWidth - 4 : panelWidth;
  const semanticLines = model === undefined
    ? errorPanelLines(contentWidth)
    : [...model.render(contentWidth)];
  const state = model?.getPublicState();
  const isError = model === undefined || state?.status === "error";
  const bodyHeight = model?.getViewportHeight() ?? DEFAULT_PANEL_VIEWPORT_HEIGHT;
  const body = semanticLines.slice(1, -1).slice(0, bodyHeight);
  while (body.length < bodyHeight) body.push("");
  const header = formatPanelHeader(isError ? undefined : state?.tree_revision, contentWidth);
  const footer = semanticLines.at(-1) ?? "";

  if (!framed) {
    return Object.freeze([
      renderNarrowPanelLine(header, panelWidth, "header", theme),
      ...body.map((line) => renderNarrowPanelLine(
        line,
        panelWidth,
        isError && line.length > 0 ? "error" : line.startsWith("› ") ? "selected" : "body",
        theme,
      )),
      renderNarrowPanelLine(footer, panelWidth, "footer", theme),
    ]);
  }

  return Object.freeze([
    renderPanelRule(panelWidth, "top", theme),
    renderFramedPanelLine(header, contentWidth, "header", theme),
    renderPanelRule(panelWidth, "divider", theme),
    ...body.map((line) => renderFramedPanelLine(
      line,
      contentWidth,
      isError && line.length > 0 ? "error" : line.startsWith("› ") ? "selected" : "body",
      theme,
    )),
    renderPanelRule(panelWidth, "divider", theme),
    renderFramedPanelLine(footer, contentWidth, "footer", theme),
    renderPanelRule(panelWidth, "bottom", theme),
  ]);
}

function formatPanelHeader(revision: number | undefined, width: number): string {
  const title = "AGENT TREE";
  const revisionLabel = revision === undefined ? "" : `REV ${revision}`;
  if (revisionLabel.length === 0) return truncateToDisplayWidth(title, width);
  const required = displayWidth(title) + displayWidth(revisionLabel) + 1;
  if (required > width) return truncateToDisplayWidth(`${title} · ${revisionLabel}`, width);
  return `${title}${" ".repeat(width - displayWidth(title) - displayWidth(revisionLabel))}${revisionLabel}`;
}

function renderPanelRule(
  width: number,
  position: "top" | "divider" | "bottom",
  theme: unknown,
): string {
  const [left, fill, right] = position === "top"
    ? ["┏", "━", "┓"]
    : position === "bottom"
      ? ["┗", "━", "┛"]
      : ["┣", "━", "┫"];
  const color = position === "divider" ? "border" : "borderAccent";
  const rule = `${left}${fill.repeat(Math.max(0, width - 2))}${right}`;
  return themeBg(theme, "customMessageBg", themeFg(theme, color, rule));
}

function renderFramedPanelLine(
  value: string,
  contentWidth: number,
  style: AgentTreePanelLineStyle,
  theme: unknown,
): string {
  const padded = padToDisplayWidth(value, contentWidth);
  const borderColor = style === "header" || style === "selected" ? "borderAccent" : "border";
  const line = `${themeFg(theme, borderColor, "┃")} ${stylePanelText(padded, style, theme)} ${themeFg(theme, borderColor, "┃")}`;
  return themeBg(theme, style === "selected" ? "selectedBg" : "customMessageBg", line);
}

function renderNarrowPanelLine(
  value: string,
  width: number,
  style: AgentTreePanelLineStyle,
  theme: unknown,
): string {
  const padded = padToDisplayWidth(value, width);
  return themeBg(
    theme,
    style === "selected" ? "selectedBg" : "customMessageBg",
    stylePanelText(padded, style, theme),
  );
}

function stylePanelText(value: string, style: AgentTreePanelLineStyle, theme: unknown): string {
  switch (style) {
    case "header":
      return themeFg(theme, "accent", themeBold(theme, value));
    case "selected":
      return themeFg(theme, "text", themeBold(theme, value));
    case "error":
      return themeFg(theme, "error", value);
    case "footer":
      return themeFg(theme, "dim", value);
    case "body":
      return themeFg(theme, "customMessageText", value);
  }
}

function padToDisplayWidth(value: string, width: number): string {
  const truncated = truncateToDisplayWidth(value, width);
  return `${truncated}${" ".repeat(Math.max(0, width - displayWidth(truncated)))}`;
}

function themeFg(theme: unknown, color: string, text: string): string {
  if (typeof theme !== "object" || theme === null) return text;
  const candidate = theme as AgentTreePanelTheme;
  if (typeof candidate.fg !== "function") return text;
  try {
    const styled = candidate.fg.call(candidate, color, text);
    return typeof styled === "string" ? styled : text;
  } catch {
    return text;
  }
}

function themeBg(theme: unknown, color: string, text: string): string {
  if (typeof theme !== "object" || theme === null) return text;
  const candidate = theme as AgentTreePanelTheme;
  if (typeof candidate.bg !== "function") return text;
  try {
    const styled = candidate.bg.call(candidate, color, text);
    return typeof styled === "string" ? styled : text;
  } catch {
    return text;
  }
}

function themeBold(theme: unknown, text: string): string {
  if (typeof theme !== "object" || theme === null) return text;
  const candidate = theme as AgentTreePanelTheme;
  if (typeof candidate.bold !== "function") return text;
  try {
    const styled = candidate.bold.call(candidate, text);
    return typeof styled === "string" ? styled : text;
  } catch {
    return text;
  }
}

function directWidgetNodes(snapshot: ScopedAgentTreeSnapshot): readonly AgentSnapshot[] {
  const parentAgentId = snapshot.scope.kind === "root"
    ? null
    : snapshot.scope.agent_id ?? null;
  return snapshot.nodes.filter((node) =>
    node.parent_agent_id === parentAgentId && node.state !== "terminated",
  );
}

function hasWorkingWidgetRows(snapshot: ScopedAgentTreeSnapshot): boolean {
  return directWidgetNodes(snapshot).some((node) => node.state === "working");
}

function formatAgentStateIcon(node: AgentSnapshot, workingFrame: string): string {
  switch (node.state) {
    case "starting":
      return "◌";
    case "idle":
      return "○";
    case "working": {
      const frame = truncateToDisplayWidth(safeUiFact(workingFrame), 1);
      return frame.length === 0 ? INITIAL_WORKING_SPINNER_FRAME : frame;
    }
    case "interrupting":
      return "↻";
    case "suspended":
      return "Ⅱ";
    case "failed":
      return "×";
    case "terminating":
      return "…";
    case "terminated":
      return "·";
  }
}

interface FormatAgentFactsOptions {
  readonly includeActivityCategoryCount?: boolean;
}

function formatAgentFacts(node: AgentSnapshot, options: FormatAgentFactsOptions = {}): string {
  const facts = [safeUiFact(node.template_id), safeUiFact(node.name), node.state];
  if (node.activity !== undefined) {
    facts.push(node.activity.phase);
    if (
      options.includeActivityCategoryCount !== false
      && node.activity.category !== undefined
      && node.activity.active_count !== undefined
    ) {
      facts.push(`${node.activity.category} ${node.activity.active_count}`);
    }
  }
  if (node.context_window_tokens !== undefined) {
    const percent = node.context_usage_percent === undefined
      ? "?"
      : `${node.context_usage_percent.toFixed(1)}%`;
    facts.push(`${percent}/${formatTokens(node.context_window_tokens)}`);
  }
  if (node.state !== "starting" && node.working_elapsed_ms !== undefined) {
    facts.push(formatElapsed(node.working_elapsed_ms));
  }
  const pending = pendingQueueCount(node);
  if (pending > 0) {
    facts.push(`queues ${node.mailbox_pending_count}/${node.host_pending_count}/${node.reply_outbox_pending_count}`);
  }
  if (
    node.error !== undefined
    && (
      node.state === "failed"
      || (node.state === "terminating" && node.error.code === "termination_incomplete")
    )
  ) facts.push(node.error.code);
  return facts.join(" · ");
}

function pendingQueueCount(node: AgentSnapshot): number {
  return node.mailbox_pending_count + node.host_pending_count + node.reply_outbox_pending_count;
}

function formatBranchAggregate(aggregate: BranchAggregate): string {
  return ` · descendants ${aggregate.descendants} · working ${aggregate.working} · failed ${aggregate.failed} · pending ${aggregate.pending}`;
}

function finishedKind(node: AgentSnapshot): "completed" | "failed" | "incomplete" {
  return node.termination_result ?? "completed";
}

function stablePrioritySort(
  nodes: readonly AgentSnapshot[],
  priority: (node: AgentSnapshot) => boolean,
): readonly AgentSnapshot[] {
  return [...nodes]
    .map((node, index) => Object.freeze({ node, index, priority: priority(node) }))
    .sort((left, right) => Number(right.priority) - Number(left.priority) || left.index - right.index)
    .map((item) => item.node);
}

function validViewportHeight(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : DEFAULT_PANEL_VIEWPORT_HEIGHT;
}

function countBy<T>(items: readonly T[], keyOf: (item: T) => string): ReadonlyMap<string, number> {
  const result = new Map<string, number>();
  for (const item of items) {
    const key = keyOf(item);
    result.set(key, (result.get(key) ?? 0) + 1);
  }
  return result;
}

function formatCounts(counts: ReadonlyMap<string, number>): string {
  return [...counts].map(([key, count]) => `${safeUiFact(key)} ×${count}`).join(", ");
}

/** 将外部可命名事实约束为单行纯文本，阻断 ANSI、换行与方向控制注入。 */
function safeUiFact(value: string): string {
  return value.replace(TERMINAL_CONTROL_PATTERN, " ").replace(/ {2,}/g, " ").trim();
}

function sameScope(left: ScopedAgentTreeSnapshot, right: ScopedAgentTreeSnapshot): boolean {
  return left.scope.kind === right.scope.kind
    && left.scope.agent_id === right.scope.agent_id;
}

function compareElapsedRefresh(
  previous: ScopedAgentTreeSnapshot,
  next: ScopedAgentTreeSnapshot,
): "changed" | "ignored" | "error" {
  if (
    previous.tree_revision !== next.tree_revision
    || !sameScope(previous, next)
    || previous.nodes.length !== next.nodes.length
  ) return "error";
  let changed = false;
  for (let index = 0; index < previous.nodes.length; index += 1) {
    const before = previous.nodes[index]!;
    const after = next.nodes[index]!;
    if (!sameAgentFactsExceptElapsed(before, after)) return "error";
    const beforeWorkingElapsed = before.working_elapsed_ms;
    const afterWorkingElapsed = after.working_elapsed_ms;
    if (beforeWorkingElapsed !== afterWorkingElapsed) {
      if (
        (before.state !== "working" && before.state !== "interrupting")
        || beforeWorkingElapsed === undefined
        || afterWorkingElapsed === undefined
        || afterWorkingElapsed < beforeWorkingElapsed
      ) return "error";
      changed = true;
    }
  }
  return changed ? "changed" : "ignored";
}

function sameAgentFactsExceptElapsed(left: AgentSnapshot, right: AgentSnapshot): boolean {
  return left.agent_id === right.agent_id
    && left.parent_agent_id === right.parent_agent_id
    && left.template_id === right.template_id
    && left.name === right.name
    && left.depth === right.depth
    && left.state === right.state
    && left.mailbox_pending_count === right.mailbox_pending_count
    && left.host_pending_count === right.host_pending_count
    && left.reply_outbox_pending_count === right.reply_outbox_pending_count
    && left.revision === right.revision
    && left.created_at === right.created_at
    && left.context_window_tokens === right.context_window_tokens
    && left.context_usage_percent === right.context_usage_percent
    && JSON.stringify(left.activity) === JSON.stringify(right.activity)
    && JSON.stringify(left.last_task) === JSON.stringify(right.last_task)
    && JSON.stringify(left.error) === JSON.stringify(right.error)
    && left.termination_result === right.termination_result;
}

function isValidScopedSnapshot(value: unknown): value is ScopedAgentTreeSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.tree_revision !== "number"
    || !Number.isSafeInteger(candidate.tree_revision)
    || candidate.tree_revision < 0
    || !Array.isArray(candidate.nodes)
    || typeof candidate.scope !== "object"
    || candidate.scope === null
    || Array.isArray(candidate.scope)
  ) return false;
  const scope = candidate.scope as Record<string, unknown>;
  if (scope.kind === "root") {
    if (Object.keys(scope).some((key) => key !== "kind")) return false;
  } else if (scope.kind === "subtree") {
    if (!isCanonicalUuid(scope.agent_id)) return false;
    if (Object.keys(scope).some((key) => !["kind", "agent_id"].includes(key))) return false;
  } else return false;
  if (Object.keys(candidate).some((key) => !["scope", "tree_revision", "nodes"].includes(key))) {
    return false;
  }
  const ids = new Set<string>();
  const nodes: AgentSnapshot[] = [];
  for (const item of candidate.nodes) {
    const node = parseAgentSnapshot(item);
    if (node === undefined || ids.has(node.agent_id)) return false;
    if (node.parent_agent_id !== null) {
      const parent = nodes.find((candidateNode) => candidateNode.agent_id === node.parent_agent_id);
      if (parent === undefined || node.depth !== parent.depth + 1) return false;
    }
    ids.add(node.agent_id);
    nodes.push(node);
  }
  return true;
}

function formatTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function formatElapsed(value: number): string {
  const seconds = Math.max(0, Math.floor(value / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${String(remainingSeconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function graphemeWidth(grapheme: string): number {
  if (EXTENDED_PICTOGRAPHIC_PATTERN.test(grapheme) || REGIONAL_INDICATOR_PATTERN.test(grapheme)) return 2;
  let width = 0;
  for (const character of grapheme) width += codePointWidth(character);
  return width;
}

function codePointWidth(character: string): number {
  const codePoint = character.codePointAt(0) ?? 0;
  if (
    codePoint === 0
    || codePoint < 32
    || (codePoint >= 0x7f && codePoint < 0xa0)
    || codePoint === 0x200d
    || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
    || (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
    || COMBINING_MARK_PATTERN.test(character)
  ) return 0;
  return isWideCodePoint(codePoint) ? 2 : 1;
}

function isWideCodePoint(codePoint: number): boolean {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

function safeRequestRender(tui: AgentTreeTui): void {
  try {
    tui.requestRender();
  } catch {
    // 重绘失败只影响本次 UI 展示。
  }
}

function errorPanelLines(width: number): string[] {
  return [
    truncateToDisplayWidth("Agent tree", width),
    truncateToDisplayWidth("Agent tree temporarily unavailable", width),
    truncateToDisplayWidth("Esc close", width),
  ];
}

function inertUiBinding(): AgentTreeUiBinding {
  return Object.freeze({
    openPanel: () => Promise.resolve(),
    dispose: () => {},
  });
}
