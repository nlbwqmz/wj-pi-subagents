import {
  Key,
  matchesKey,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type {
  AgentSnapshot,
  ControlResult,
  ScopedAgentTreeSnapshot,
} from "./tree-controller.ts";
import {
  isCanonicalUuid,
} from "./tree-controller.ts";
import { parseAgentSnapshot } from "./agent-snapshot-codec.ts";
import {
  AgentActivityViewerModel,
  renderAgentActivityViewerSurface,
} from "./agent-activity-viewer.ts";
import type { CanonicalAgentActivityEntry } from "./canonical-activity.ts";
import type { AgentActivitySnapshot } from "./agent-activity-cache.ts";
import type { AgentDisplayDraftView } from "./agent-display-drafts.ts";
import {
  displayWidth,
  renderFramedPanelLine,
  renderNarrowPanelLine,
  renderPanelRule,
  safeUiFact,
  stylePanelText,
  themeBg,
  themeBold,
  themeFg,
  truncateToDisplayWidth,
  type UiPanelLineStyle,
} from "./ui-surface.ts";

export { displayWidth, truncateToDisplayWidth } from "./ui-surface.ts";

export interface AgentTreePanelOptions {
  /** 同时显示的树正文行数，不包含标题和键位提示。 */
  readonly viewport_height?: number;
}

interface AgentTreeCustomOptions {
  readonly overlay?: boolean;
  readonly overlayOptions?: {
    readonly width?: number | `${number}%`;
    readonly maxHeight?: number | `${number}%`;
    readonly anchor?: "center";
    readonly margin?: number;
  };
}

interface PanelRow {
  readonly key: string;
  readonly text: string;
  readonly terminal: boolean;
}

interface PanelRenderedLine {
  readonly text: string;
  readonly terminal: boolean;
  readonly selected: boolean;
}

interface BranchAggregate {
  readonly descendants: number;
  readonly working: number;
  readonly failed: number;
  readonly terminated: number;
}

export interface AgentTreePanelPublicState {
  readonly status: "ready" | "error";
  readonly tree_revision: number;
  readonly selected_key?: string;
  readonly scroll_offset: number;
  readonly expanded_agent_ids: readonly string[];
}

export interface AgentTreeSnapshotSource {
  read(): ControlResult<ScopedAgentTreeSnapshot>;
  onChange(listener: () => void): () => void;
}

/** 活动流缓存来源 seam：优先读取一致快照，旧 source 继续使用 replay。 */
export interface AgentActivityStreamSource {
  readReplay(agentId: string): readonly CanonicalAgentActivityEntry[];
  /** 有界历史的权威快照；存在时 opening 与通知都不再读取旧 replay。 */
  readSnapshot?(agentId: string): AgentActivitySnapshot;
  onChange(listener: (agentId: string) => void): () => void;
  /**
   * 可选的顶层实时草稿快照。草稿只存在于顶层登记表：即使详情未打开也持续
   * 组装，打开时立即显示当前连续前缀；无回放、无缓存、不进入持久历史。
   */
  readDisplayDrafts?(agentId: string): readonly AgentDisplayDraftView[];
  /** 实时草稿变更通知；观察者应重新拉取对应代理的草稿快照。 */
  onDisplayChange?(listener: (agentId: string) => void): () => void;
}

interface AgentTreeTui {
  requestRender(): void;
  /** 宿主终端只读视图；用于响应式正文行数，测试桩可以省略。 */
  readonly terminal?: { readonly rows?: number };
}

interface AgentTreeComponent {
  render(width: number): string[];
  handleInput?(data: string): void;
  handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
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
const ACTIVITY_VIEWER_RENDER_THROTTLE_MS = 50;
/** 与 Pi Loader 默认 Working 指示器保持一致。 */
const WORKING_SPINNER_FRAMES = Object.freeze([
  "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏",
]);
const WORKING_SPINNER_INTERVAL_MS = 80;
const INITIAL_WORKING_SPINNER_FRAME = WORKING_SPINNER_FRAMES[0] ?? "⠋";
const DEFAULT_PANEL_VIEWPORT_HEIGHT = 12;
/** 两个 overlay 共用的固定外边距：四周各保留 2 个终端单元格。 */
const AGENT_TREE_OVERLAY_MARGIN = 2;
/** overlay 框线装饰固定行数：上下框线、标题行、两条分隔线与键位提示行。 */
const PANEL_CHROME_ROWS = 6;
/** 响应式正文的最低保底行数，仅用于避免极小终端下的空输出。 */
const MIN_PANEL_BODY_HEIGHT = 1;
/**
 * `/agents` 面板与子代理详情查看器共用的外框尺寸策略：宽度与高度都请求
 * 宿主可用空间（"100%"），由宿主每次渲染按当前终端尺寸扣除四周 2 格边距
 * 后自动钳制，并保持居中；终端 resize 时随宿主重绘自动适应。
 */
const AGENT_TREE_OVERLAY_OPTIONS = Object.freeze({
  width: "100%" as const,
  maxHeight: "100%" as const,
  anchor: "center" as const,
  margin: AGENT_TREE_OVERLAY_MARGIN,
});
const RENDER_PANEL_LINES = Symbol("renderPanelLines");

/** 读取宿主终端行数；宿主未暴露该视图（如测试桩）时返回 undefined。 */
function terminalRows(tui: AgentTreeTui): number | undefined {
  try {
    const rows = tui.terminal?.rows;
    return typeof rows === "number" && Number.isSafeInteger(rows) && rows > 0
      ? rows
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 响应式正文行数：终端行数扣除上下外边距与框线装饰。宿主未暴露终端行数
 * 时保持 fallback（即模型当前视口行数）；极小终端只保底 1 行避免空输出。
 */
function responsiveBodyHeight(tui: AgentTreeTui, fallback: number): number {
  const rows = terminalRows(tui);
  if (rows === undefined) return fallback;
  return Math.max(
    MIN_PANEL_BODY_HEIGHT,
    rows - 2 * AGENT_TREE_OVERLAY_MARGIN - PANEL_CHROME_ROWS,
  );
}

export type AgentTreePanelInputOutcome = "changed" | "ignored" | "close" | "enter";
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
  activity?: AgentActivityStreamSource,
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
  let viewerPromise: Promise<void> | undefined;
  let activeViewer: {
    readonly model: AgentActivityViewerModel;
    readonly done: () => void;
    readonly scheduleRender: () => void;
  } | undefined;
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
    if (activeViewer !== undefined) {
      activeViewer.scheduleRender();
      return;
    }
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
    requestRender();
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
    if (activeViewer !== undefined) {
      const viewer = activeViewer;
      const viewed = result.data.nodes.find((candidate) =>
        candidate.agent_id === viewer.model.agent_id
      );
      if (viewed !== undefined) viewer.model.updateLifecycle(viewed.state);
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

  /** 在面板 overlay 之上叠加打开查看器 overlay；Esc 关闭后面板重新接管输入。 */
  const openActivityViewer = (agentId: string): void => {
    if (activity === undefined || viewerPromise !== undefined) return;
    const node = snapshot?.nodes.find((candidate) => candidate.agent_id === agentId);
    if (node === undefined) return;
    const custom = context.ui?.custom;
    if (typeof custom !== "function") return;
    let invocation: Promise<void>;
    try {
      invocation = custom.call(context.ui, (tui, theme, _keybindings, done) => {
        let closed = false;
        let lastWidth = 0;
        let replay: readonly CanonicalAgentActivityEntry[] = [];
        let initialActivitySnapshot: AgentActivitySnapshot | undefined;
        try {
          if (typeof activity.readSnapshot === "function") {
            initialActivitySnapshot = activity.readSnapshot(node.agent_id);
          } else {
            replay = activity.readReplay(node.agent_id);
          }
        } catch {
          // 初始读取失败落到空态，不阻断 overlay 打开。
        }
        let initialDrafts: readonly AgentDisplayDraftView[] = [];
        if (typeof activity.readDisplayDrafts === "function") {
          try {
            // 打开详情时立即显示顶层已组装的当前连续前缀。
            initialDrafts = activity.readDisplayDrafts(node.agent_id);
          } catch {
            initialDrafts = [];
          }
        }
        const viewedAgent = Object.freeze({
          agent_id: node.agent_id,
          template_id: node.template_id,
          name: node.name,
          state: node.state,
        });
        const model = initialActivitySnapshot === undefined
          ? new AgentActivityViewerModel(viewedAgent, replay, { drafts: initialDrafts })
          : new AgentActivityViewerModel(
            viewedAgent,
            initialActivitySnapshot,
            { drafts: initialDrafts },
          );
        let renderTimer: ReturnType<typeof setTimeout> | undefined;
        const scheduleActivityRender = (): void => {
          if (closed || renderTimer !== undefined) return;
          renderTimer = setTimeout(() => {
            renderTimer = undefined;
            if (!closed) safeRequestRender(tui);
          }, ACTIVITY_VIEWER_RENDER_THROTTLE_MS);
          renderTimer.unref?.();
        };
        const clearActivityRenderTimer = (): void => {
          if (renderTimer === undefined) return;
          clearTimeout(renderTimer);
          renderTimer = undefined;
        };
        let unsubscribe: (() => void) | undefined;
        let unsubscribeDisplay: (() => void) | undefined;
        try {
          unsubscribe = activity.onChange((changedAgentId) => {
            if (closed || changedAgentId !== node.agent_id) return;
            let outcome: "changed" | "ignored" = "ignored";
            try {
              outcome = typeof activity.readSnapshot === "function"
                ? model.syncSnapshot(activity.readSnapshot(node.agent_id))
                : model.syncFrom(activity.readReplay(node.agent_id));
            } catch {
              // 缓存读取失败保持当前内容，不中断查看器。
            }
            if (outcome === "changed") scheduleActivityRender();
          });
        } catch {
          unsubscribe = undefined;
        }
        if (typeof activity.onDisplayChange === "function") {
          try {
            unsubscribeDisplay = activity.onDisplayChange((changedAgentId) => {
              if (closed || changedAgentId !== node.agent_id) return;
              if (typeof activity.readDisplayDrafts !== "function") return;
              try {
                model.setLiveDrafts(activity.readDisplayDrafts(node.agent_id));
              } catch {
                // 草稿读取失败保持当前内容，不中断查看器。
              }
              scheduleActivityRender();
            });
          } catch {
            unsubscribeDisplay = undefined;
          }
        }
        const finish = (): void => {
          if (closed) return;
          closed = true;
          try { unsubscribe?.(); } catch {}
          unsubscribe = undefined;
          try { unsubscribeDisplay?.(); } catch {}
          unsubscribeDisplay = undefined;
          clearActivityRenderTimer();
          if (activeViewer?.model === model) activeViewer = undefined;
          done(undefined);
          requestRender();
        };
        activeViewer = { model, done: finish, scheduleRender: scheduleActivityRender };
        return {
          render: (width) => {
            lastWidth = width;
            model.setViewportHeight(responsiveBodyHeight(tui, model.getViewportHeight()));
            try {
              return [...renderAgentActivityViewerSurface(model, width, theme)];
            } catch {
              return [...renderAgentActivityViewerSurface(model, width, undefined)];
            }
          },
          handleMouse: (event: TuiMouseEvent): TuiMouseEventResult | undefined => {
            try {
              if (closed) return undefined;
              const result = model.handleMouse(event, lastWidth >= 6);
              if (result !== undefined) safeRequestRender(tui);
              return result;
            } catch {
              // 鼠标处理异常保持在查看器边界内。
              return undefined;
            }
          },
          handleInput: (data) => {
            try {
              if (model.handleInput(data) === "close") finish();
            } catch {
              // 键盘处理异常保持在查看器边界内。
            }
            safeRequestRender(tui);
          },
          invalidate: () => {},
          dispose: () => {
            closed = true;
            try { unsubscribe?.(); } catch {}
            unsubscribe = undefined;
            try { unsubscribeDisplay?.(); } catch {}
            unsubscribeDisplay = undefined;
            clearActivityRenderTimer();
            if (activeViewer?.model === model) activeViewer = undefined;
          },
        };
      }, {
        overlay: true,
        overlayOptions: AGENT_TREE_OVERLAY_OPTIONS,
      }) as Promise<void>;
    } catch {
      return;
    }
    viewerPromise = invocation.finally(() => {
      viewerPromise = undefined;
      activeViewer = undefined;
    });
  };

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
          let lastWidth = 0;
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
              lastWidth = width;
              if (panel.model !== undefined) {
                panel.model.setViewportHeight(
                  responsiveBodyHeight(tui, panel.model.getViewportHeight()),
                );
              }
              try {
                return [...renderAgentTreePanelSurface(panel.model, width, theme)];
              } catch {
                panel.model?.markError();
                return [...renderAgentTreePanelSurface(panel.model, width, undefined)];
              }
            },
            handleMouse: (event: TuiMouseEvent): TuiMouseEventResult | undefined => {
              try {
                const result = panel.model?.handleMouse(event, lastWidth >= 6) ?? undefined;
                if (result !== undefined) safeRequestRender(tui);
                return result;
              } catch {
                // 鼠标处理异常保持在面板边界内。
                return undefined;
              }
            },
            handleInput: (data) => {
              try {
                if (panel.model === undefined) {
                  if (matchesKey(data, Key.escape)) finish();
                } else {
                  const outcome = panel.model.handleInput(data);
                  if (outcome === "close") finish();
                  else if (outcome === "enter") {
                    const selected = panel.model.getPublicState().selected_key;
                    if (selected !== undefined) openActivityViewer(selected);
                  }
                }
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
      activeViewer?.done();
      activeViewer = undefined;
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
    return truncateToDisplayWidth(`${branch} ${icon} ${formatAgentFacts(node)}`, width);
  });
  if (rows.length === 0) return Object.freeze([]);
  return Object.freeze([truncateToDisplayWidth(AGENTS_WIDGET_TITLE, width), ...rows]);
}

/** `/agents` 的纯交互投影；它只消费一次完整的作用域树快照。 */
export class AgentTreePanelModel {
  private snapshot: ScopedAgentTreeSnapshot;
  private status: "ready" | "error" = "ready";
  private viewportHeight: number;
  private readonly expandedAgentIds = new Set<string>();
  private selectedIndex = 0;
  private scrollOffset = 0;

  constructor(snapshot: ScopedAgentTreeSnapshot, options: AgentTreePanelOptions = {}) {
    this.snapshot = snapshot;
    this.viewportHeight = validViewportHeight(options.viewport_height);
    for (const node of this.topLevelNodes()) this.expandedAgentIds.add(node.agent_id);
  }

  render(width: number): readonly string[] {
    return Object.freeze(this[RENDER_PANEL_LINES](width).map((line) => line.text));
  }

  [RENDER_PANEL_LINES](width: number): readonly PanelRenderedLine[] {
    if (this.status === "error") {
      return Object.freeze(errorPanelLines(width).map(neutralPanelLine));
    }
    const rows = this.buildRows();
    this.clampSelection(rows.length);
    const visible = rows.slice(this.scrollOffset, this.scrollOffset + this.viewportHeight);
    return Object.freeze([
      neutralPanelLine(
        truncateToDisplayWidth(`Agent tree · revision ${this.snapshot.tree_revision}`, width),
      ),
      ...visible.map((row, index) => Object.freeze({
        text: truncateToDisplayWidth(
          `${this.scrollOffset + index === this.selectedIndex ? "› " : "  "}${row.text}`,
          width,
        ),
        terminal: row.terminal,
        selected: this.scrollOffset + index === this.selectedIndex,
      })),
      neutralPanelLine(truncateToDisplayWidth("↑↓ scroll · ←→ fold · Home/End jump · Esc close", width)),
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
    if (matchesKey(data, Key.escape)) return "close";
    if (this.status === "error") return "ignored";
    const rows = this.buildRows();
    this.clampSelection(rows.length);
    if (matchesKey(data, Key.home)) {
      if (rows.length === 0) return "ignored";
      if (this.selectedIndex === 0 && this.scrollOffset === 0) return "ignored";
      this.selectedIndex = 0;
      this.clampSelection(rows.length);
      return "changed";
    }
    if (matchesKey(data, Key.end)) {
      if (rows.length === 0) return "ignored";
      if (this.selectedIndex === rows.length - 1) return "ignored";
      this.selectedIndex = rows.length - 1;
      this.clampSelection(rows.length);
      return "changed";
    }
    if (matchesKey(data, Key.up) || data === "k") {
      if (this.selectedIndex <= 0) return "ignored";
      this.selectedIndex -= 1;
      this.clampSelection(rows.length);
      return "changed";
    }
    if (matchesKey(data, Key.down) || data === "j") {
      if (this.selectedIndex >= rows.length - 1) return "ignored";
      this.selectedIndex += 1;
      this.clampSelection(rows.length);
      return "changed";
    }
    const selected = rows[this.selectedIndex];
    if (selected === undefined) return "ignored";
    if (matchesKey(data, Key.enter)) return "enter";
    if (matchesKey(data, Key.right) || data === "l") return this.expandSelected(selected.key);
    if (matchesKey(data, Key.left) || data === "h") return this.collapseSelected(selected.key);
    return "ignored";
  }

  /**
   * 鼠标支持：滚轮滚动与左键点击。滚动只移动视口并把选中行同步进视口，
   * 不经 clampSelection（它会把视口拉回选中行导致互相打架）；点击未选
   * 中行只移动选择，点击已选中的有子节点行切换折叠。framed 表示表面按
   * 框线布局渲染，正文行从 y=3 开始；窄布局正文从 y=1 开始。事件 x 不
   * 参与命中判定。
   */
  handleMouse(event: TuiMouseEvent, framed: boolean): TuiMouseEventResult | undefined {
    if (event.type === "wheel") {
      const delta = event.wheelDelta ?? 0;
      if (delta === 0) return undefined;
      const rows = this.buildRows();
      if (rows.length === 0) return { handled: true };
      const maxOffset = Math.max(0, rows.length - this.viewportHeight);
      this.scrollOffset = Math.max(0, Math.min(this.scrollOffset + delta, maxOffset));
      if (this.selectedIndex < this.scrollOffset) this.selectedIndex = this.scrollOffset;
      if (this.selectedIndex >= this.scrollOffset + this.viewportHeight) {
        this.selectedIndex = this.scrollOffset + this.viewportHeight - 1;
      }
      this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, rows.length - 1));
      return { handled: true };
    }
    if (event.type === "click" && event.button === "left") {
      const bodyIndex = event.y - (framed ? 3 : 1);
      const rows = this.buildRows();
      if (bodyIndex >= 0 && bodyIndex < this.viewportHeight) {
        const index = this.scrollOffset + bodyIndex;
        const row = rows[index];
        const selectedKey = rows[this.selectedIndex]?.key;
        if (row !== undefined) {
          if (row.key === selectedKey) {
            const children = this.childrenByParent().get(row.key) ?? [];
            if (children.length > 0) {
              if (this.expandedAgentIds.has(row.key)) this.expandedAgentIds.delete(row.key);
              else this.expandedAgentIds.add(row.key);
              this.clampSelection(this.buildRows().length);
            }
          } else {
            this.selectedIndex = index;
            this.clampSelection(rows.length);
          }
        }
      }
      return { handled: true };
    }
    return undefined;
  }

  getViewportHeight(): number {
    return this.viewportHeight;
  }

  /** 响应式调整视口行数；非法输入忽略，选中与滚动收敛到新范围。 */
  setViewportHeight(height: number): void {
    if (!Number.isSafeInteger(height) || height <= 0) return;
    if (height === this.viewportHeight) return;
    this.viewportHeight = height;
    this.clampSelection(this.buildRows().length);
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
        text: `${"  ".repeat(level)}${marker} ${formatAgentFacts(node, true)}${aggregate}`,
        terminal: node.state === "terminated" || node.state === "failed",
      }));
      if (expanded) for (const child of children) append(child, level + 1);
    };
    for (const node of this.sortedTopLevelNodes(childrenByParent)) append(node, 0);
    return Object.freeze(rows);
  }

  private topLevelNodes(): readonly AgentSnapshot[] {
    const parentAgentId = this.snapshot.scope.kind === "root"
      ? null
      : this.snapshot.scope.agent_id ?? null;
    return this.snapshot.nodes.filter((node) =>
      node.parent_agent_id === parentAgentId,
    );
  }

  private childrenByParent(): ReadonlyMap<string, readonly AgentSnapshot[]> {
    const result = new Map<string, AgentSnapshot[]>();
    for (const node of this.snapshot.nodes) {
      if (node.parent_agent_id === null) continue;
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
    if (node.state === "terminated") return false;
    if (
      node.state !== "idle"
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
    let terminated = 0;
    const visit = (parentId: string): void => {
      for (const child of childrenByParent.get(parentId) ?? []) {
        descendants += 1;
        if (child.state === "working") working += 1;
        if (child.state === "failed") failed += 1;
        if (child.state === "terminated") terminated += 1;
        visit(child.agent_id);
      }
    };
    visit(agentId);
    return Object.freeze({ descendants, working, failed, terminated });
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
    const hasChildren = (this.childrenByParent().get(key) ?? []).length > 0;
    if (!hasChildren || this.expandedAgentIds.has(key)) return "ignored";
    this.expandedAgentIds.add(key);
    return "changed";
  }

  private collapseSelected(key: string): AgentTreePanelInputOutcome {
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

type AgentTreePanelLineStyle = UiPanelLineStyle;

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
    ? errorPanelLines(contentWidth).map(neutralPanelLine)
    : model[RENDER_PANEL_LINES](contentWidth);
  const state = model?.getPublicState();
  const isError = model === undefined || state?.status === "error";
  const bodyHeight = model?.getViewportHeight() ?? DEFAULT_PANEL_VIEWPORT_HEIGHT;
  const body = semanticLines.slice(1, -1).slice(0, bodyHeight);
  while (body.length < bodyHeight) body.push(neutralPanelLine(""));
  const header = formatPanelHeader(isError ? undefined : state?.tree_revision, contentWidth);
  const footer = semanticLines.at(-1)?.text ?? "";
  const bodyStyle = (line: PanelRenderedLine): AgentTreePanelLineStyle =>
    isError && line.text.length > 0
      ? "error"
      : line.terminal
        ? "terminal"
        : "body";

  if (!framed) {
    return Object.freeze([
      renderNarrowPanelLine(header, panelWidth, "header", false, theme),
      ...body.map((line) => renderNarrowPanelLine(
        line.text,
        panelWidth,
        bodyStyle(line),
        line.selected,
        theme,
      )),
      renderNarrowPanelLine(footer, panelWidth, "footer", false, theme),
    ]);
  }

  return Object.freeze([
    renderPanelRule(panelWidth, "top", theme),
    renderFramedPanelLine(header, contentWidth, "header", false, theme),
    renderPanelRule(panelWidth, "divider", theme),
    ...body.map((line) => renderFramedPanelLine(
      line.text,
      contentWidth,
      bodyStyle(line),
      line.selected,
      theme,
    )),
    renderPanelRule(panelWidth, "divider", theme),
    renderFramedPanelLine(footer, contentWidth, "footer", false, theme),
    renderPanelRule(panelWidth, "bottom", theme),
  ]);
}

function neutralPanelLine(text: string): PanelRenderedLine {
  return Object.freeze({ text, terminal: false, selected: false });
}

function formatPanelHeader(revision: number | undefined, width: number): string {
  const title = "AGENT TREE";
  const revisionLabel = revision === undefined ? "" : `REV ${revision}`;
  if (revisionLabel.length === 0) return truncateToDisplayWidth(title, width);
  const required = displayWidth(title) + displayWidth(revisionLabel) + 1;
  if (required > width) return truncateToDisplayWidth(`${title} · ${revisionLabel}`, width);
  return `${title}${" ".repeat(width - displayWidth(title) - displayWidth(revisionLabel))}${revisionLabel}`;
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
    case "failed":
      return "×";
    case "terminating":
      return "…";
    case "terminated":
      return "·";
  }
  return "·";
}

function formatAgentFacts(node: AgentSnapshot, includeTerminationResult = false): string {
  const facts = [safeUiFact(node.template_id), safeUiFact(node.name), node.state];
  if (node.activity !== undefined) facts.push(node.activity.phase);
  if (node.context_window_tokens !== undefined) {
    const percent = node.context_usage_percent === undefined
      ? "?"
      : `${node.context_usage_percent.toFixed(1)}%`;
    facts.push(`${percent}/${formatTokens(node.context_window_tokens)}`);
  }
  if (includeTerminationResult && node.state === "terminated" && node.termination_result !== undefined) {
    facts.push(node.termination_result);
  }
  if (node.state !== "starting" && node.working_elapsed_ms !== undefined) {
    facts.push(formatElapsed(node.working_elapsed_ms));
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

function formatBranchAggregate(aggregate: BranchAggregate): string {
  return ` · descendants ${aggregate.descendants} · working ${aggregate.working} · failed ${aggregate.failed} · terminated ${aggregate.terminated}`;
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
    && left.revision === right.revision
    && left.created_at === right.created_at
    && left.context_window_tokens === right.context_window_tokens
    && left.context_usage_percent === right.context_usage_percent
    && JSON.stringify(left.activity) === JSON.stringify(right.activity)
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
