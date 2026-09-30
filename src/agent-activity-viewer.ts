import {
  Key,
  Markdown,
  matchesKey,
  type MarkdownTheme,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { AgentLifecycleState } from "./agent-snapshot-codec.ts";
import type { AgentActivitySnapshot } from "./agent-activity-cache.ts";
import {
  isMessageToolSummary,
  sanitizeSafeActivityText,
  type SafeAgentActivityContentBlock,
  type SafeMcpToolAnnotations,
  type SafeToolOrigin,
  type SafeToolSummary,
} from "./rpc-bridge-event.ts";
import {
  agentDisplayDraftKey,
  type AgentDisplayDraftView,
} from "./agent-display-drafts.ts";
import type { CanonicalAgentActivityEntry } from "./canonical-activity.ts";
import {
  displayWidth,
  graphemeWidth,
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

export { displayWidth } from "./ui-surface.ts";

const DEFAULT_VIEWER_VIEWPORT_HEIGHT = 20;
const DEFAULT_LAYOUT_WIDTH = 80;
const THINKING_COLLAPSED_TEXT = "Thinking";
/** 流式 thinking 的折叠标题：完整权威消息到达后恢复普通 `Thinking`；已展开的正文跨替换保持展开。 */
const THINKING_STREAMING_TEXT = "Thinking · streaming";
/** 冻结流的折叠标题：异常乱序冻结后等待权威完整消息。 */
const THINKING_FROZEN_TEXT = "Thinking · streaming incomplete";
/** wait_agent 参数摘要尚未到达时的运行中占位，只表达当前等待事实。 */
const WAIT_AGENT_RUNNING_TEXT = "…";
/** 冻结草稿末尾的弱化省略号：实时预览不完整的显示事实。 */
const FROZEN_DRAFT_ELLIPSIS = "…";
const EMPTY_ACTIVITY_TEXT = "No cached activity yet";
const OLDER_ACTIVITY_OMITTED_TEXT = "Older activity omitted";
/** 模型调用失败条目的折叠前缀；错误与已中止两种收尾同形。 */
const MODEL_CALL_FAILURE_TITLE_PREFIX = "Error:";
const VIEWER_HEADER_TEXT = "AGENT ACTIVITY";
const VIEWER_FOOTER_TEXT = "↑↓ scroll · Tab/Shift+Tab select · Enter expand · Home/End jump · Esc back";
const RENDER_VIEWER_LINES = Symbol("renderViewerLines");
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const PLAIN_MARKDOWN_THEME: MarkdownTheme = Object.freeze({
  heading: identity,
  link: identity,
  linkUrl: identity,
  code: identity,
  codeBlock: identity,
  codeBlockBorder: identity,
  quote: identity,
  quoteBorder: identity,
  hr: identity,
  listBullet: identity,
  bold: identity,
  italic: identity,
  strikethrough: identity,
  underline: identity,
});

export interface AgentActivityViewerAgent {
  readonly agent_id: string;
  readonly template_id: string;
  readonly name: string;
  readonly state: AgentLifecycleState;
}

export interface AgentActivityViewerOptions {
  /** 同时显示的活动正文行数，不包含标题和键位提示。 */
  readonly viewport_height?: number;
  /** 打开时的初始实时草稿快照；后续通过 setLiveDrafts 持续替换。 */
  readonly drafts?: readonly AgentDisplayDraftView[];
}

export type AgentActivityViewerInputOutcome = "changed" | "ignored" | "close";
export type AgentActivityViewerUpdateOutcome = "changed" | "ignored";

export interface AgentActivityViewerPublicState {
  readonly event_count: number;
  readonly scroll_offset: number;
  readonly max_scroll_offset: number;
  readonly follow_enabled: boolean;
  readonly lifecycle_state: AgentLifecycleState;
  readonly selected_key: string | undefined;
}

interface ViewerStatusIcon {
  readonly text: string;
  readonly style: UiPanelLineStyle;
}

interface ViewerSemanticLine {
  readonly text: string;
  readonly style: UiPanelLineStyle;
  /** 可展开条目身份；选中背景只作用于该标题行。 */
  readonly selectable_key?: string;
  /** 该行是否为当前选中条目；仅渲染层消费。 */
  readonly selected?: boolean;
  /** 标题使用粗体；标题颜色由该行 style 决定。 */
  readonly emphasized_title?: boolean;
  /** 独立使用 dim 色的可展开标题指示符。 */
  readonly disclosure_marker?: "▸" | "▾";
  /** 工具状态图标；位于折叠符之后、标题之前，并使用独立状态色。 */
  readonly status_icon?: ViewerStatusIcon;
  /** 行尾局部错误片段：仅该片段使用错误色，其余保持行样式。 */
  readonly error_tail?: string;
}

const BODY_LAYOUT_WIDTH_CACHE_LIMIT = 2;

type CachedBodyKind =
  | "markdown-body"
  | "markdown-terminal"
  | "guided-markdown-body"
  | "guided-markdown-terminal"
  | "guided-tool-error"
  | "guided-model-call-failure"
  | "guided-shell-command"
  | "guided-codemode-code";

/** 预格式化正文：不解析 Markdown、不做字符截断，只按宽度软折行。 */
function isPreformattedBodyKind(kind: CachedBodyKind): boolean {
  return kind === "guided-tool-error"
    || kind === "guided-model-call-failure"
    || kind === "guided-shell-command"
    || kind === "guided-codemode-code";
}

/** 正文块行样式：工具失败与模型调用失败共用面板既有的错误色。 */
function cachedBodyStyle(kind: CachedBodyKind): UiPanelLineStyle {
  if (kind === "guided-tool-error" || kind === "guided-model-call-failure") return "error";
  return kind.includes("terminal") ? "terminal" : "body";
}

interface CachedBodySpec {
  readonly key: string;
  readonly kind: CachedBodyKind;
  readonly source: string;
}

interface CachedBodyWidthLayout {
  readonly lineCount: () => number;
  readonly renderWindow: (start: number, limit: number) => readonly ViewerSemanticLine[];
  readonly renderTail: (limit: number) => readonly ViewerSemanticLine[];
}

interface ViewerLayoutBlock {
  /** 当前块内按视觉顺序出现的可选择条目，不依赖正文已经布局。 */
  readonly selectableKeys: readonly string[];
  /** 当前宽度下的精确行数；不得以估算值参与公开滚动状态。 */
  readonly lineCount: (width: number) => number;
  /** 只物化块内与绝对窗口相交的行。 */
  readonly renderWindow: (
    width: number,
    start: number,
    limit: number,
  ) => readonly ViewerSemanticLine[];
  /** 从块尾部只物化请求的行数。 */
  readonly renderTail: (width: number, limit: number) => readonly ViewerSemanticLine[];
}

interface ViewerLayout {
  readonly blocks: readonly ViewerLayoutBlock[];
  readonly selectableKeys: readonly string[];
}

/**
 * 纯文本正文的按需布局器。它只保留精确行数和请求窗口，不创建整块行数组；
 * 每一行仍按现有 Markdown 的软换行规则处理，复杂语法则交给完整 Markdown
 * 渲染器，避免为了性能牺牲 Markdown 语义。
 */
class PlainTextBodyLayout {
  private readonly source: string;
  private readonly width: number;
  private readonly style: UiPanelLineStyle;
  private readonly guided: boolean;
  private readonly outerWidth: number;
  private readonly trimTrailing: boolean;
  private cachedLineCount: number | undefined;

  constructor(
    source: string,
    width: number,
    style: UiPanelLineStyle,
    guided: boolean,
    outerWidth: number,
    trimTrailing: boolean,
  ) {
    this.source = source;
    this.width = Math.max(1, width);
    this.style = style;
    this.guided = guided;
    this.outerWidth = outerWidth;
    this.trimTrailing = trimTrailing;
  }

  lineCount(): number {
    if (this.cachedLineCount !== undefined) return this.cachedLineCount;
    if (this.source.length === 0) {
      this.cachedLineCount = 0;
      return 0;
    }
    let total = 0;
    this.forEachPhysicalLine((line) => {
      total += countWrappedPlainLine(line, this.width, this.trimTrailing);
      return false;
    });
    this.cachedLineCount = total;
    return total;
  }

  renderWindow(start: number, limit: number): readonly ViewerSemanticLine[] {
    const first = Math.max(0, start);
    const last = first + Math.max(0, limit);
    if (last <= first || this.source.length === 0) return Object.freeze([]);

    const result: ViewerSemanticLine[] = [];
    let position = 0;
    this.forEachPhysicalLine((line) => {
      const lineStart = position;
      const lineCount = countWrappedPlainLine(line, this.width, this.trimTrailing);
      if (lineStart < last && lineStart + lineCount > first) {
        let emitted = 0;
        const stopped = visitWrappedPlainLine(line, this.width, this.trimTrailing, (wrapped) => {
          const absolute = lineStart + emitted;
          emitted += 1;
          if (absolute >= first && absolute < last) {
            result.push(this.decorate(wrapped));
          }
          return absolute + 1 >= last;
        });
        if (stopped && result.length >= last - first) return true;
      }
      position += lineCount;
      return position >= last;
    });
    return Object.freeze(result);
  }

  renderTail(limit: number): readonly ViewerSemanticLine[] {
    const requested = Math.max(0, limit);
    if (requested === 0 || this.source.length === 0) return Object.freeze([]);

    const result: ViewerSemanticLine[] = [];
    let end = this.source.length;
    let remaining = requested;
    while (remaining > 0) {
      const newline = this.source.lastIndexOf("\n", end - 1);
      const start = newline + 1;
      const line = this.source.slice(start, end);
      // 固定环缓冲只保留本物理行最后的可见窗口，避免长单行在每个
      // 软换行处 shift() 造成 viewport 倍数的数组搬移。
      const localTail = new Array<string>(remaining);
      let localCount = 0;
      visitWrappedPlainLine(line, this.width, this.trimTrailing, (wrapped) => {
        localTail[localCount % remaining] = wrapped;
        localCount += 1;
        return false;
      });
      const take = Math.min(localCount, remaining);
      const first = Math.max(0, localCount - take);
      const renderedTail: ViewerSemanticLine[] = [];
      for (let index = first; index < localCount; index += 1) {
        const item = localTail[index % remaining];
        if (item !== undefined) renderedTail.push(this.decorate(item));
      }
      // 当前物理行的软换行顺序必须保持自然顺序；再作为一个整体放到更早
      // 的物理行之后，避免长单行的尾部窗口被逐项 unshift 反转。
      result.unshift(...renderedTail);
      remaining -= take;
      if (newline < 0) break;
      end = newline;
    }
    return Object.freeze(result);
  }

  private decorate(value: string): ViewerSemanticLine {
    const text = this.trimTrailing ? value.replace(/[ \t]+$/u, "") : value;
    if (!this.guided) return Object.freeze({ text, style: this.style });
    if (this.outerWidth <= 1) return Object.freeze({ text: "│", style: this.style });
    return Object.freeze({ text: `│ ${text}`, style: this.style });
  }

  private forEachPhysicalLine(callback: (line: string) => boolean): void {
    let start = 0;
    while (true) {
      const newline = this.source.indexOf("\n", start);
      const end = newline < 0 ? this.source.length : newline;
      if (callback(this.source.slice(start, end))) return;
      if (newline < 0) return;
      start = newline + 1;
    }
  }
}

/**
 * 同一正文块只在内容、布局方式或宽度变化时重新生成行。纯文本块只保存精确
 * 计数和按需窗口；复杂 Markdown 在第一次需要该宽度时完整解析并缓存，保证
 * 标题、列表、链接、代码块等语义不被快速路径改写。
 */
class CachedViewerBodyBlock {
  private kind: CachedBodyKind | undefined;
  private source: string | undefined;
  private safeSource: string | undefined;
  private readonly layoutsByWidth = new Map<number, CachedBodyWidthLayout>();

  update(spec: CachedBodySpec): void {
    if (this.kind === spec.kind && this.source === spec.source) return;
    this.kind = spec.kind;
    this.source = spec.source;
    this.safeSource = undefined;
    this.layoutsByWidth.clear();
  }

  lineCount(width: number): number {
    return this.layout(width).lineCount();
  }

  renderWindow(width: number, start: number, limit: number): readonly ViewerSemanticLine[] {
    return this.layout(width).renderWindow(start, limit);
  }

  renderTail(width: number, limit: number): readonly ViewerSemanticLine[] {
    return this.layout(width).renderTail(limit);
  }

  render(width: number): readonly ViewerSemanticLine[] {
    return this.layout(width).renderWindow(0, Number.MAX_SAFE_INTEGER);
  }

  private layout(width: number): CachedBodyWidthLayout {
    const cached = this.layoutsByWidth.get(width);
    if (cached !== undefined) {
      this.layoutsByWidth.delete(width);
      this.layoutsByWidth.set(width, cached);
      return cached;
    }

    const kind = this.kind!;
    const source = this.source!;
    const safe = this.getSafeSource();
    const preformatted = isPreformattedBodyKind(kind);
    const guided = kind.startsWith("guided-");
    const style = cachedBodyStyle(kind);
    let layout: CachedBodyWidthLayout;
    if (preformatted || isPlainMarkdownSource(safe)) {
      const plain = new PlainTextBodyLayout(
        safe,
        guided ? Math.max(1, width - 2) : width,
        style,
        guided,
        width,
        !preformatted,
      );
      layout = {
        lineCount: () => plain.lineCount(),
        renderWindow: (start, limit) => plain.renderWindow(start, limit),
        renderTail: (limit) => plain.renderTail(limit),
      };
    } else {
      const lines = renderCachedBodyBlock(kind, source, width);
      layout = {
        lineCount: () => lines.length,
        renderWindow: (start, limit) => Object.freeze(
          lines.slice(Math.max(0, start), Math.max(0, start) + Math.max(0, limit)),
        ),
        renderTail: (limit) => Object.freeze(
          lines.slice(Math.max(0, lines.length - Math.max(0, limit))),
        ),
      };
    }

    this.layoutsByWidth.set(width, layout);
    while (this.layoutsByWidth.size > BODY_LAYOUT_WIDTH_CACHE_LIMIT) {
      const oldestWidth = this.layoutsByWidth.keys().next().value;
      if (oldestWidth === undefined) break;
      this.layoutsByWidth.delete(oldestWidth);
    }
    return layout;
  }

  private getSafeSource(): string {
    if (this.safeSource === undefined) this.safeSource = sanitizeViewerMarkup(this.source!);
    return this.safeSource;
  }
}

type SettledLifecycleState = "idle" | "failed" | "terminated";

/**
 * 工具活动的运行状态。完成态不可退回运行中；unavailable/terminated 是生命
 * 周期收束语义，仍可被身份匹配的结束事实回填为真实结果。
 */
type ToolRunState =
  | { readonly phase: "running" }
  | { readonly phase: "success" }
  | { readonly phase: "failure" }
  | { readonly phase: "unavailable" }
  | { readonly phase: "terminated" };

interface ToolDisplayEntry {
  readonly kind: "tool";
  /** 条目身份：工具附属正文使用的稳定可展开键。 */
  readonly entryId: string;
  /** 运行实例身份；与工具活动 ID、执行代次共同承担回填匹配职责。 */
  readonly incarnationId: string;
  readonly toolCallId: string;
  /**
   * 执行代次：同身份与活动 ID 的重新发起会递增；本状态机对“完成后迟到
   * 开始”的忽略规则使每个已确立条目的代次固定为首次发起代。
   */
  readonly generation: number;
  /** 工具首次出现时的规范原子身份；生命周期收束不依赖易变的窗口下标。 */
  readonly settlementKey: string;
  toolName: string;
  origin: SafeToolOrigin;
  state: ToolRunState;
  /** 专用摘要：只有来源验证通过的专用工具携带；结束事实覆盖开始。 */
  summary: SafeToolSummary | undefined;
  /** 失败事实自包含的完整错误正文（已净化）；默认折叠，展开后红色显示。 */
  errorText: string | undefined;
  /** 插件工具失败事实的规范稳定错误码；追加在摘要行尾。 */
  errorCode: string | undefined;
}

/**
 * 失败事实的统一视觉：`×` 图标与错误色。工具失败与模型调用失败各自携带
 * 不同语义，但折叠行呈现完全相同。
 */
const FAILURE_VISUAL = Object.freeze({ icon: "×", style: "error" as const });

/**
 * 标题使用统一展开标记和强调样式，工具状态图标固定在标题前缀。状态视觉为：
 * 运行中 `↻` 强调色、成功 `✓` 弱化色、失败 `×` 错误色；收束警告与
 * terminated 继续保留各自语义。
 */
const TOOL_STATE_VISUALS: Readonly<Record<ToolRunState["phase"], {
  readonly icon: string;
  readonly style: UiPanelLineStyle;
  readonly suffix?: string;
}>> = Object.freeze({
  running: Object.freeze({ icon: "↻", style: "accent" as const }),
  success: Object.freeze({ icon: "✓", style: "terminal" as const }),
  failure: FAILURE_VISUAL,
  unavailable: Object.freeze({ icon: "⚠", style: "warning" as const, suffix: "result unavailable" }),
  terminated: Object.freeze({
    icon: "○",
    style: "terminal" as const,
    suffix: "terminated before result",
  }),
});

/** terminate_agent 强制回收成功：警告而非失败，成功结果与风险事实同时保留。 */
const TOOL_FORCED_VISUAL = Object.freeze({ icon: "⚠", style: "warning" as const });

/**
 * 模型调用失败条目与工具失败同形：同一 `×` 图标与错误色；它与工具失败
 * 不共享错误码/正文语义，只是复用同一套呈现。
 */
const MODEL_CALL_FAILURE_VISUAL = FAILURE_VISUAL;

/**
 * 工具条目的显示视觉。运行状态机语义不变；只有来源验证通过的专用摘要在
 * 成功事实携带特殊控制事实时覆盖显示：wait_agent 观察到目标 state failed
 * 的成功调用显示红色失败，terminate_agent 强制回收成功显示警告。
 */
function toolDisplayVisual(entry: ToolDisplayEntry): {
  readonly icon: string;
  readonly style: UiPanelLineStyle;
  readonly suffix?: string;
} {
  const base = TOOL_STATE_VISUALS[entry.state.phase];
  const summary = entry.summary;
  if (entry.state.phase !== "success" || summary === undefined) return base;
  if (summary.tool === "wait_agent" && summary.state === "failed") {
    return TOOL_STATE_VISUALS.failure;
  }
  if (summary.tool === "terminate_agent" && summary.forced === true) {
    return TOOL_FORCED_VISUAL;
  }
  return base;
}

/**
 * 可展开条目身份：规范条目内的 thinking 组使用条目身份加块序号；工具错误
 * 正文与消息正文使用独立前缀；父代理消息与实时草稿使用独立前缀。身份跨
 * 重绘稳定。
 */
function thinkingKey(entryId: string, blockIndex: number): string {
  return `thinking:${entryId}:${blockIndex}`;
}

function toolErrorKey(entryId: string): string {
  return `tool-error:${entryId}`;
}

function toolMessageKey(entryId: string): string {
  return `tool-message:${entryId}`;
}

function toolCommandKey(entryId: string): string {
  return `tool-command:${entryId}`;
}

function toolCodeKey(entryId: string): string {
  return `tool-code:${entryId}`;
}

function parentMessageKey(entryId: string): string {
  return `parent-message:${entryId}`;
}

/** 模型调用失败条目的展开身份：折叠行与展开体共用同一稳定键。 */
function modelCallFailureKey(entryId: string): string {
  return `model-call-failure:${entryId}`;
}

function liveThinkingKey(draftKey: string, contentIndex: number): string {
  return `thinking:live:${draftKey}:${contentIndex}`;
}

/**
 * 与实时显示流关联的权威消息 thinking 复用草稿期展开身份：展开状态跨
 * “草稿被权威消息替换”保持稳定，streaming 结束不自动折叠。
 */
function messageThinkingKey(
  entryId: string,
  displayDraftKey: string | undefined,
  blockIndex: number,
): string {
  return displayDraftKey === undefined
    ? thinkingKey(entryId, blockIndex)
    : liveThinkingKey(displayDraftKey, blockIndex);
}

/**
 * 活动查看器的纯交互投影：打开即消费一次全量回放，随后接受追加通知。
 * text 块独立完整渲染；thinking 默认折叠；Tab/Shift+Tab 在全部可展开
 * 条目间循环选择；展开暂停自动跟随。它只渲染到显示层，不向父会话发送
 * 消息或追加条目。
 */
export class AgentActivityViewerModel {
  private readonly agentId: string;
  private readonly templateId: string;
  private readonly name: string;
  private lifecycleState: AgentLifecycleState;
  private readonly entries: CanonicalAgentActivityEntry[] = [];
  /**
   * 顶层草稿登记表的快照：从 sequence 1 开始的连续前缀。它只渲染到显示层，
   * 不进入回放、事件数或父端缓存；由 setLiveDrafts 整体替换保持单一事实源。
   */
  private liveDrafts: readonly AgentDisplayDraftView[] = Object.freeze([]);
  private viewportHeight: number;
  private readonly expandedKeys = new Set<string>();
  private selectedKey: string | undefined;
  private replayCursor = 0;
  /** 最近接纳的权威快照观察代际；undefined 表示当前仍在旧 replay 兼容模式。 */
  private snapshotEpoch: number | undefined;
  /** 同一观察代际中最近接纳的权威快照修订。 */
  private snapshotRevision: number | undefined;
  private olderActivityOmitted = false;
  private layoutWidth = DEFAULT_LAYOUT_WIDTH;
  private scrollOffset = 0;
  private followEnabled = true;
  private projectionRevision = 0;
  /**
   * 查看器实际观察到生命周期收束时仍运行的工具。按规范原子身份记录，
   * 因此前缀淘汰和窗口重排不会改变边界，后来出现的工具也不会继承它。
   */
  private readonly settledTools = new Map<string, SettledLifecycleState>();
  /** 正文块缓存按稳定显示身份持有；窗口滑动或草稿替换后由投影重建时清理。 */
  private readonly bodyBlockCache = new Map<string, CachedViewerBodyBlock>();
  private cachedLayout: {
    readonly revision: number;
    readonly layout: ViewerLayout;
  } | undefined;
  private cachedLineCount: {
    readonly width: number;
    readonly revision: number;
    readonly count: number;
  } | undefined;
  private batching = false;
  private initializing = true;

  constructor(
    agent: AgentActivityViewerAgent,
    replay: readonly CanonicalAgentActivityEntry[],
    options?: AgentActivityViewerOptions,
  );
  constructor(
    agent: AgentActivityViewerAgent,
    snapshot: AgentActivitySnapshot,
    options?: AgentActivityViewerOptions,
  );
  constructor(
    agent: AgentActivityViewerAgent,
    initialActivity: readonly CanonicalAgentActivityEntry[] | AgentActivitySnapshot,
    options: AgentActivityViewerOptions = {},
  ) {
    this.agentId = agent.agent_id;
    this.templateId = agent.template_id;
    this.name = agent.name;
    this.lifecycleState = agent.state;
    this.viewportHeight = validViewportHeight(options.viewport_height);
    this.batching = true;
    try {
      if (Array.isArray(initialActivity)) {
        this.syncFrom(initialActivity as readonly CanonicalAgentActivityEntry[]);
      } else {
        this.syncSnapshot(initialActivity as AgentActivitySnapshot);
      }
      if (isSettledLifecycleState(agent.state)) this.recordRunningToolSettlement(agent.state);
      this.setLiveDrafts(options.drafts ?? []);
    } finally {
      this.batching = false;
      this.initializing = false;
    }
    this.initializeSelection();
    this.settleFollow();
  }

  get agent_id(): string {
    return this.agentId;
  }

  /** 标题中的生命周期状态随树快照刷新；相同状态忽略。 */
  updateLifecycle(state: AgentLifecycleState): AgentActivityViewerUpdateOutcome {
    if (state === this.lifecycleState) return "ignored";
    this.lifecycleState = state;
    // 只标记此刻已经观察到的 running 工具；后到活动不继承旧收束。
    if (isSettledLifecycleState(state)) this.recordRunningToolSettlement(state);
    this.touchProjection();
    return "changed";
  }

  /** 追加一条规范活动条目；保留给旧 append-only 调用方。 */
  appendEntry(entry: CanonicalAgentActivityEntry): AgentActivityViewerUpdateOutcome {
    this.snapshotEpoch = undefined;
    this.snapshotRevision = undefined;
    this.entries.push(entry);
    this.touchProjection();
    if (!this.batching) this.settleFollow();
    return "changed";
  }

  /**
   * 以旧式全量回放对齐本地条目；仅用于没有 snapshot 能力的 append-only
   * source。游标独立于条目数，因此被拒绝的输入不会跳过后续合法条目。
   */
  syncFrom(replay: readonly CanonicalAgentActivityEntry[]): AgentActivityViewerUpdateOutcome {
    if (replay.length < this.replayCursor) return "ignored";
    let start = this.replayCursor;
    if (this.entries.length > start && this.replayPrefixMatches(replay)) start = this.entries.length;
    let outcome: AgentActivityViewerUpdateOutcome = "ignored";
    const wasBatching = this.batching;
    this.batching = true;
    try {
      for (let index = start; index < replay.length; index += 1) {
        const entry = replay[index];
        if (entry !== undefined && this.appendEntry(entry) === "changed") outcome = "changed";
      }
    } finally {
      this.batching = wasBatching;
    }
    if (outcome === "changed" && !this.batching) this.settleFollow();
    this.replayCursor = replay.length;
    return outcome;
  }

  /**
   * 以权威有界快照完整对账。同一观察代际中 revision 未前进时严格 no-op；
   * 新观察代际无条件接纳，从而允许 cache clear 后 revision 从 0 重新开始。
   * 前进后按规范原子身份重建顺序，因此同槽位替换、窗口缩短和 100 条滑动
   * 都不会依赖 append-only 游标。
   */
  syncSnapshot(snapshot: AgentActivitySnapshot): AgentActivityViewerUpdateOutcome {
    if (!isValidActivitySnapshot(snapshot)) return "ignored";
    const epochChanged = this.snapshotEpoch !== undefined
      && snapshot.snapshotEpoch > this.snapshotEpoch;
    if (
      this.snapshotEpoch !== undefined
      && (
        snapshot.snapshotEpoch < this.snapshotEpoch
        || (!epochChanged && snapshot.revision <= (this.snapshotRevision ?? -1))
      )
    ) return "ignored";

    if (epochChanged) this.resetForSnapshotEpoch();
    const reconcileInteraction = !epochChanged
      && !this.initializing
      && (this.selectedKey !== undefined || this.expandedKeys.size > 0);
    const previousKeys = reconcileInteraction ? this.selectableKeys() : Object.freeze([]);
    const previousSelectedKey = this.selectedKey;
    const reconciled = reconcileCanonicalEntries(this.entries, snapshot.entries);

    this.entries.splice(0, this.entries.length, ...reconciled);
    this.olderActivityOmitted = snapshot.olderActivityOmitted;
    this.snapshotEpoch = snapshot.snapshotEpoch;
    this.snapshotRevision = snapshot.revision;
    this.replayCursor = snapshot.entries.length;
    this.retainVisibleToolSettlements();
    this.touchProjection();

    if (!this.initializing) {
      if (epochChanged) {
        this.initializeSelection();
      } else if (reconcileInteraction) {
        const currentKeys = this.selectableKeys();
        const currentKeySet = new Set(currentKeys);
        let removedExpansion = false;
        for (const key of [...this.expandedKeys]) {
          if (currentKeySet.has(key)) continue;
          this.expandedKeys.delete(key);
          removedExpansion = true;
        }
        if (removedExpansion) this.touchProjection();
        if (previousSelectedKey !== undefined && !currentKeySet.has(previousSelectedKey)) {
          this.selectedKey = nearestSurvivingKey(
            previousKeys,
            previousSelectedKey,
            currentKeys,
          );
        }
      }
      if (this.followEnabled) {
        this.settleFollow();
      } else {
        const maxOffset = this.maxScrollOffset();
        this.scrollOffset = clamp(this.scrollOffset, 0, maxOffset);
      }
    }
    return "changed";
  }

  render(width: number): readonly string[] {
    return Object.freeze(this[RENDER_VIEWER_LINES](width).map((line) => line.text));
  }

  /**
   * 以顶层草稿登记表的最新快照替换本投影的实时草稿。登记表是唯一事实源：
   * 查看 detail 打开时立即看到当前连续前缀，期间到达的新帧经登记表应用后
   * 再以快照形式到达这里。草稿增长与普通追加一样服从 follow 规则。
   */
  setLiveDrafts(drafts: readonly AgentDisplayDraftView[]): AgentActivityViewerUpdateOutcome {
    if (sameLiveDraftSnapshot(this.liveDrafts, drafts)) return "ignored";
    this.liveDrafts = Object.freeze([...drafts]);
    this.touchProjection();
    if (!this.batching) this.settleFollow();
    return "changed";
  }

  /** 当前选中的可展开条目身份；打开时由视口最新可展开项初始化。 */
  getSelectedKey(): string | undefined {
    return this.selectedKey;
  }

  /** 当前处于展开状态的可展开条目身份集合。 */
  getExpandedKeys(): readonly string[] {
    return Object.freeze([...this.expandedKeys]);
  }

  [RENDER_VIEWER_LINES](width: number): readonly ViewerSemanticLine[] {
    const contentWidth = validRenderWidth(width);
    this.layoutWidth = contentWidth;
    const bodyLines = this.visibleEventLines(contentWidth);
    const cached = this.cachedLineCount;
    if (!this.followEnabled || (
      cached !== undefined
      && cached.width === contentWidth
      && cached.revision === this.projectionRevision
    )) {
      const maxOffset = this.maxScrollOffset();
      this.settleFollow(maxOffset);
      this.scrollOffset = clamp(this.scrollOffset, 0, maxOffset);
    } else {
      // 跟随尾部时允许首次渲染只物化视口；公开精确滚动范围由
      // getPublicState/交互路径按需收敛，不能在这里提前布局整段历史。
      this.settleFollow();
    }
    const identity = truncateToDisplayWidth(
      `${VIEWER_HEADER_TEXT} · ${safeUiFact(this.templateId)} · ${safeUiFact(this.name)} · ${this.lifecycleState}`,
      contentWidth,
    );
    const visible = bodyLines.map((line) => Object.freeze({
      text: truncateToDisplayWidth(line.text, contentWidth),
      style: line.style,
      selected: line.selectable_key !== undefined && line.selectable_key === this.selectedKey,
      ...(line.emphasized_title === undefined
        ? {}
        : { emphasized_title: line.emphasized_title }),
      ...(line.disclosure_marker === undefined
        ? {}
        : { disclosure_marker: line.disclosure_marker }),
      ...(line.status_icon === undefined ? {} : { status_icon: line.status_icon }),
      ...(line.error_tail === undefined ? {} : { error_tail: line.error_tail }),
    }));
    while (visible.length < this.viewportHeight) {
      visible.push(Object.freeze({ text: "", style: "body" as const, selected: false }));
    }
    const footer = truncateToDisplayWidth(VIEWER_FOOTER_TEXT, contentWidth);
    return Object.freeze([
      Object.freeze({ text: identity, style: "header" as const, selected: false }),
      ...visible,
      Object.freeze({ text: footer, style: "footer" as const, selected: false }),
    ]);
  }
  handleInput(data: string): AgentActivityViewerInputOutcome {
    if (data === "\x1b") return "close";
    if (data === "\t") return this.moveSelection(1);
    if (data === "\x1b[Z") return this.moveSelection(-1);
    if (data === "\r" || data === "\n" || data === " ") return this.toggleSelectedKey();
    if (data === "\x1b[C") return this.setSelectedExpansion(true);
    if (data === "\x1b[D") return this.setSelectedExpansion(false);
    if (matchesKey(data, Key.home)) {
      if (this.scrollOffset === 0 && !this.followEnabled) return "ignored";
      // 跳到首部 = 回看历史：暂停自动跟随。
      this.scrollOffset = 0;
      this.followEnabled = false;
      return "changed";
    }
    if (matchesKey(data, Key.end)) {
      const maxOffset = this.maxScrollOffset();
      if (this.scrollOffset === maxOffset && this.followEnabled) return "ignored";
      // 跳到尾部 = 观察最新活动：恢复自动跟随。
      this.scrollOffset = maxOffset;
      this.followEnabled = true;
      return "changed";
    }

    const maxOffset = this.maxScrollOffset();
    if (this.followEnabled) this.scrollOffset = maxOffset;
    if (data === "\x1b[A" || data === "k") {
      if (this.scrollOffset <= 0) return "ignored";
      this.followEnabled = false;
      this.scrollOffset -= 1;
      return "changed";
    }
    if (data === "\x1b[B" || data === "j") {
      if (this.scrollOffset >= maxOffset) return "ignored";
      this.scrollOffset += 1;
      if (this.scrollOffset >= maxOffset) this.followEnabled = true;
      return "changed";
    }
    return "ignored";
  }

  /**
   * 鼠标支持：滚轮滚动与左键点击切换展开。framed 表示表面按框线布局渲染，
   * 正文行从 y=3 开始；窄布局正文从 y=1 开始。事件 x 不参与命中判定。
   */
  handleMouse(event: TuiMouseEvent, framed: boolean): TuiMouseEventResult | undefined {
    if (event.type === "wheel") {
      const delta = event.wheelDelta ?? 0;
      if (delta === 0) return undefined;
      this.scrollBy(delta);
      return { handled: true };
    }
    if (event.type === "click" && event.button === "left") {
      const bodyIndex = event.y - (framed ? 3 : 1);
      if (bodyIndex >= 0 && bodyIndex < this.viewportHeight) {
        const line = this.visibleEventLines(this.layoutWidth)[bodyIndex];
        const key = line?.selectable_key;
        if (key !== undefined && this.isExpandableKey(key)) {
          this.setKeyExpanded(key, !this.expandedKeys.has(key));
        }
      }
      return { handled: true };
    }
    return undefined;
  }

  /** 与键盘 ↓ 相同的滚动语义：滚到底恢复自动跟随，其余移动暂停跟随。 */
  private scrollBy(delta: number): "changed" | "ignored" {
    const maxOffset = this.maxScrollOffset();
    const next = clamp(this.scrollOffset + delta, 0, maxOffset);
    if (next === this.scrollOffset) return "ignored";
    this.scrollOffset = next;
    this.followEnabled = next >= maxOffset;
    return "changed";
  }

  getViewportHeight(): number {
    return this.viewportHeight;
  }

  /** 响应式调整视口行数；非法输入忽略，跟随与滚动在新范围内收敛。 */
  setViewportHeight(height: number): void {
    if (!Number.isSafeInteger(height) || height <= 0) return;
    if (height === this.viewportHeight) return;
    this.viewportHeight = height;
    this.settleFollow();
  }

  getPublicState(): AgentActivityViewerPublicState {
    const maxOffset = this.maxScrollOffset();
    this.settleFollow(maxOffset);
    this.scrollOffset = clamp(this.scrollOffset, 0, maxOffset);
    return Object.freeze({
      event_count: this.entries.length,
      scroll_offset: this.scrollOffset,
      max_scroll_offset: maxOffset,
      follow_enabled: this.followEnabled,
      lifecycle_state: this.lifecycleState,
      selected_key: this.selectedKey,
    });
  }

  /** 跟随尾部时优先保持惰性；需要绝对滚动几何的调用方显式传入精确范围。 */
  private settleFollow(maxOffset?: number): void {
    if (!this.followEnabled) return;
    if (maxOffset !== undefined) {
      this.scrollOffset = Math.max(0, maxOffset);
      return;
    }
    const cached = this.cachedLineCount;
    if (
      cached !== undefined
      && cached.width === validRenderWidth(this.layoutWidth)
      && cached.revision === this.projectionRevision
    ) {
      this.scrollOffset = Math.max(0, cached.count - this.viewportHeight);
    }
  }

  /** 所有块的精确总行数；结果按投影修订与宽度缓存。 */
  private exactEventLineCount(width = this.layoutWidth): number {
    const contentWidth = validRenderWidth(width);
    const cached = this.cachedLineCount;
    if (
      cached !== undefined
      && cached.width === contentWidth
      && cached.revision === this.projectionRevision
    ) return cached.count;

    let total = 0;
    for (const block of this.layout().blocks) total += block.lineCount(contentWidth);
    this.cachedLineCount = {
      width: contentWidth,
      revision: this.projectionRevision,
      count: total,
    };
    return total;
  }

  /** 公开滚动几何始终建立在精确布局上。 */
  private maxScrollOffset(): number {
    return Math.max(0, this.exactEventLineCount() - this.viewportHeight);
  }

  private touchProjection(): void {
    this.projectionRevision += 1;
    this.cachedLayout = undefined;
    this.cachedLineCount = undefined;
  }

  private resetForSnapshotEpoch(): void {
    this.expandedKeys.clear();
    this.selectedKey = undefined;
    this.liveDrafts = Object.freeze([]);
    this.scrollOffset = 0;
    this.followEnabled = true;
    this.settledTools.clear();
    this.bodyBlockCache.clear();
    this.cachedLayout = undefined;
    this.cachedLineCount = undefined;
  }

  /** 打开时只检查尾部视口，选择其中最新的可展开项。 */
  private initializeSelection(): void {
    const lines = this.visibleEventLines(this.layoutWidth);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const key = lines[index]?.selectable_key;
      if (key !== undefined) {
        this.selectedKey = key;
        return;
      }
    }
    this.selectedKey = undefined;
  }

  /** Tab/Shift+Tab 循环选择；Tab 回到最新条目时恢复自动跟随。 */
  private moveSelection(direction: 1 | -1): AgentActivityViewerInputOutcome {
    const keys = this.selectableKeys();
    if (keys.length === 0) return "ignored";
    const latest = keys.at(-1);
    let next: string | undefined;
    if (this.selectedKey === undefined || !keys.includes(this.selectedKey)) {
      next = direction === 1 ? keys[0] : latest;
    } else {
      const index = keys.indexOf(this.selectedKey);
      next = keys[(index + direction + keys.length) % keys.length];
    }
    if (next === undefined) return "ignored";
    this.selectedKey = next;
    if (next === latest) {
      this.followEnabled = true;
      this.settleFollow();
    } else {
      this.followEnabled = false;
      this.ensureLineVisible(next);
    }
    return "changed";
  }

  private selectableKeys(): readonly string[] {
    return this.layout().selectableKeys;
  }

  /** 视口外目标只触发使其刚好可见的最小滚动。 */
  private ensureLineVisible(key: string): void {
    const width = validRenderWidth(this.layoutWidth);
    const maxOffset = this.maxScrollOffset();
    this.scrollOffset = clamp(this.scrollOffset, 0, maxOffset);
    let position = 0;
    for (const block of this.layout().blocks) {
      const count = block.lineCount(width);
      if (block.selectableKeys.includes(key)) {
        const index = position;
        if (index < this.scrollOffset) this.scrollOffset = index;
        else if (index >= this.scrollOffset + this.viewportHeight) {
          this.scrollOffset = index - this.viewportHeight + 1;
        }
        return;
      }
      position += count;
    }
  }

  private toggleSelectedKey(): AgentActivityViewerInputOutcome {
    if (this.selectedKey === undefined) return "ignored";
    return this.setKeyExpanded(this.selectedKey, !this.expandedKeys.has(this.selectedKey));
  }

  private setSelectedExpansion(expanded: boolean): AgentActivityViewerInputOutcome {
    if (this.selectedKey === undefined) return "ignored";
    if (this.expandedKeys.has(this.selectedKey) === expanded) return "ignored";
    return this.setKeyExpanded(this.selectedKey, expanded);
  }

  private setKeyExpanded(key: string, expanded: boolean): AgentActivityViewerInputOutcome {
    if (!this.isExpandableKey(key)) return "ignored";
    if (expanded) {
      // 从跟随尾部改为暂停前先收敛已有布局，保证展开标题仍停留在同一屏幕行。
      if (this.followEnabled) this.scrollOffset = this.maxScrollOffset();
      this.expandedKeys.add(key);
      // 展开保持当前屏幕位置并暂停自动跟随；折叠不自动恢复。
      this.followEnabled = false;
    } else {
      this.expandedKeys.delete(key);
    }
    this.touchProjection();
    this.settleFollow();
    return "changed";
  }

  private isExpandableKey(key: string): boolean {
    if (typeof key !== "string" || key.length === 0) return false;
    return key.startsWith("thinking:")
      || key.startsWith("tool-error:")
      || key.startsWith("tool-message:")
      || key.startsWith("tool-command:")
      || key.startsWith("tool-code:")
      || key.startsWith("parent-message:")
      || key.startsWith("model-call-failure:");
  }

  private replayPrefixMatches(replay: readonly CanonicalAgentActivityEntry[]): boolean {
    if (this.entries.length > replay.length) return false;
    for (let index = 0; index < this.entries.length; index += 1) {
      const left = this.entries[index];
      const right = replay[index];
      if (left === undefined || right === undefined || !sameEntry(left, right)) return false;
    }
    return true;
  }

  /** 记录当前仍运行工具的稳定身份；已有收束采用首次观察到的状态。 */
  private recordRunningToolSettlement(state: SettledLifecycleState): void {
    for (const key of runningToolSettlementKeys(this.entries)) {
      if (!this.settledTools.has(key)) this.settledTools.set(key, state);
    }
  }

  /** 快照淘汰后移除已不可见的边界，避免查看器本地状态无界增长。 */
  private retainVisibleToolSettlements(): void {
    if (this.settledTools.size === 0) return;
    const visibleRunning = new Set(runningToolSettlementKeys(this.entries));
    for (const key of [...this.settledTools.keys()]) {
      if (!visibleRunning.has(key)) this.settledTools.delete(key);
    }
  }

  /**
   * 将规范条目重放为显示条目。工具开始/结束按稳定调用身份合并为同一原子
   * 条目：结束先到或开始缺失时自建完成条目；重复与迟到事实幂等；完成态
   * 不可退回运行中。重放后仍运行中的工具只按其开始前已经观察到的生命周期
   * 收束边界结算，避免滞后快照影响随后出现的新活动。
   */
  private projectEntries(): DisplayEntry[] {
    const entries: DisplayEntry[] = [];
    const toolIndex = new Map<string, ToolDisplayEntry>();

    for (const entry of this.entries) {
      const body = entry.body;
      if (body.type === "message") {
        const streamId = body.displayStream?.streamId ?? body.streamId;
        const displayDraftKey = body.displayStream === undefined
          ? (streamId === undefined ? undefined : agentDisplayDraftKey(entry.incarnation_id, streamId))
          : agentDisplayDraftKey(entry.incarnation_id, body.displayStream);
        entries.push({
          kind: "message",
          entryId: entry.entry_id,
          incarnationId: entry.incarnation_id,
          ...(displayDraftKey === undefined ? {} : { displayDraftKey }),
          content: body.content,
        });
        continue;
      }

      if (body.type === "parent_message") {
        // 接收侧实际接纳的父代理输入；未接纳输入不产生该条目。
        entries.push({
          kind: "parent_message",
          entryId: entry.entry_id,
          incarnationId: entry.incarnation_id,
          content: body.content,
        });
        continue;
      }

      if (body.type === "model_call_failure") {
        // 失败条目只服务活动显示：折叠态用错误文本首行，展开体用身份行（可得时）
        // 与错误文本原文；压缩自身失败不携带身份，展开体直接从原文开始。
        entries.push({
          kind: "model_call_failure",
          entryId: entry.entry_id,
          incarnationId: entry.incarnation_id,
          message: body.message,
          ...(body.provider === undefined || body.model === undefined
            ? {}
            : { provider: body.provider, model: body.model }),
        });
        continue;
      }

      if (body.type === "tool_execution_start") {
        // 旧 replay 可包含 start/end 两个事实，按运行实例、toolCallId 与
        // executionGeneration 合并；缺省代次 1 保持旧条目兼容。
        const identity = toolProjectionIdentity(entry);
        if (toolIndex.has(identity)) continue;
        const tool: ToolDisplayEntry = {
          kind: "tool",
          entryId: entry.entry_id,
          incarnationId: entry.incarnation_id,
          toolCallId: body.toolCallId,
          generation: body.executionGeneration ?? 1,
          settlementKey: canonicalEntryIdentity(entry),
          toolName: body.toolName,
          origin: body.origin,
          state: { phase: "running" },
          summary: body.summary,
          errorText: undefined,
          errorCode: undefined,
        };
        entries.push(tool);
        toolIndex.set(identity, tool);
        continue;
      }

      // 结束事实自包含状态与摘要：开始缺失时仍建立完成条目。只有运行实例、
      // 活动 ID 与代次都匹配的结束事实才能更新或回填既有条目。
      const identity = toolProjectionIdentity(entry);
      const existing = toolIndex.get(identity);
      const state: ToolRunState = body.isError ? { phase: "failure" } : { phase: "success" };
      if (existing === undefined) {
        const tool: ToolDisplayEntry = {
          kind: "tool",
          entryId: entry.entry_id,
          incarnationId: entry.incarnation_id,
          toolCallId: body.toolCallId,
          generation: body.executionGeneration ?? 1,
          settlementKey: canonicalEntryIdentity(entry),
          toolName: body.toolName,
          origin: body.origin,
          state,
          summary: body.summary,
          errorText: body.errorText,
          errorCode: body.errorCode,
        };
        entries.push(tool);
        toolIndex.set(identity, tool);
        continue;
      }
      // 匹配结束原地更新（幂等或回填），绝不退回运行中；结束事实携带更
      // 完整的摘要与错误正文，覆盖开始事实的输入参数摘要。
      existing.toolName = body.toolName;
      existing.origin = body.origin;
      existing.state = state;
      existing.summary = body.summary;
      existing.errorText = body.errorText;
      existing.errorCode = body.errorCode;
    }

    if (toolIndex.size > 0) {
      for (const tool of toolIndex.values()) {
        if (tool.state.phase !== "running") continue;
        const settlement = this.settledTools.get(tool.settlementKey);
        if (settlement === "idle") tool.state = { phase: "unavailable" };
        else if (settlement === "failed") tool.state = { phase: "failure" };
        else if (settlement === "terminated") tool.state = { phase: "terminated" };
      }
    }
    for (const draft of this.liveDrafts) {
      if (draft.blocks.length === 0) continue;
      entries.push({ kind: "live", draft });
    }
    return entries;
  }

  /**
   * 构建条目顺序、标题和正文块身份。正文块在这里仅登记 source；行数与窗口
   * 由块在具体宽度下精确计算，避免布局阶段复制不可见的大正文。
   */
  private layout(): ViewerLayout {
    if (
      this.cachedLayout !== undefined
      && this.cachedLayout.revision === this.projectionRevision
    ) return this.cachedLayout.layout;

    const blocks: ViewerLayoutBlock[] = [];
    const activeCacheKeys = new Set<string>();
    const addStatic = (
      lines: readonly ViewerSemanticLine[],
      selectableKeys: readonly string[] = Object.freeze([]),
    ): void => {
      const frozenLines = Object.freeze([...lines]);
      const keys = Object.freeze([...selectableKeys]);
      blocks.push(Object.freeze({
        selectableKeys: keys,
        lineCount: () => frozenLines.length,
        renderWindow: (_width: number, start: number, limit: number) => Object.freeze(
          frozenLines.slice(Math.max(0, start), Math.max(0, start) + Math.max(0, limit)),
        ),
        renderTail: (_width: number, limit: number) => Object.freeze(
          frozenLines.slice(Math.max(0, frozenLines.length - Math.max(0, limit))),
        ),
      }));
    };
    const addDynamicLine = (
      render: (width: number) => ViewerSemanticLine,
      selectableKey?: string,
    ): void => {
      const keys = selectableKey === undefined ? Object.freeze([]) : Object.freeze([selectableKey]);
      blocks.push(Object.freeze({
        selectableKeys: keys,
        lineCount: () => 1,
        renderWindow: (width: number, start: number, limit: number) => {
          if (start > 0 || limit <= 0) return Object.freeze([]);
          return Object.freeze([render(width)]);
        },
        renderTail: (width: number, limit: number) => limit <= 0
          ? Object.freeze([])
          : Object.freeze([render(width)]),
      }));
    };
    const addGuidedStatic = (line: ViewerSemanticLine, selectableKey: string): void => {
      const keys = Object.freeze([selectableKey]);
      blocks.push(Object.freeze({
        selectableKeys: keys,
        lineCount: () => 1,
        renderWindow: (width: number, start: number, limit: number) => {
          if (start > 0 || limit <= 0) return Object.freeze([]);
          return renderGuidedBody(width, () => Object.freeze([line]));
        },
        renderTail: (width: number, limit: number) => limit <= 0
          ? Object.freeze([])
          : renderGuidedBody(width, () => Object.freeze([line])),
      }));
    };
    const cacheFor = (
      key: string,
      kind: CachedBodyKind,
      source: string,
    ): CachedViewerBodyBlock => {
      activeCacheKeys.add(key);
      let cached = this.bodyBlockCache.get(key);
      if (cached === undefined) {
        cached = new CachedViewerBodyBlock();
        this.bodyBlockCache.set(key, cached);
      }
      cached.update({ key, kind, source });
      return cached;
    };
    const retainCached = (key: string, kind: CachedBodyKind, source: string): void => {
      cacheFor(key, kind, source);
    };
    const addCached = (key: string, kind: CachedBodyKind, source: string): void => {
      const cached = cacheFor(key, kind, source);
      blocks.push(Object.freeze({
        selectableKeys: Object.freeze([]),
        lineCount: (width: number) => cached.lineCount(width),
        renderWindow: (width: number, start: number, limit: number) => (
          cached.renderWindow(width, start, limit)
        ),
        renderTail: (width: number, limit: number) => cached.renderTail(width, limit),
      }));
    };
    const addMaybeExpandedCached = (
      expanded: boolean,
      key: string,
      kind: CachedBodyKind,
      source: string,
    ): void => {
      if (expanded) addCached(key, kind, source);
      else retainCached(key, kind, source);
    };

    if (
      !this.olderActivityOmitted
      && this.entries.length === 0
      && this.liveDrafts.every((draft) => draft.blocks.length === 0)
    ) {
      this.bodyBlockCache.clear();
      addStatic(Object.freeze([{ text: EMPTY_ACTIVITY_TEXT, style: "body" as const }]));
    } else {
      if (this.olderActivityOmitted) {
        addStatic(Object.freeze([{ text: OLDER_ACTIVITY_OMITTED_TEXT, style: "terminal" as const }]));
      }
      for (const entry of this.projectEntries()) {
        if (entry.kind === "message") {
          let blockIndex = 0;
          for (const block of entry.content) {
            if (block.type === "text") {
              addCached(
                entry.displayDraftKey === undefined
                  ? `message-text:${entry.incarnationId}:${entry.entryId}:${blockIndex}`
                  : `live-text:${entry.displayDraftKey}:${blockIndex}`,
                "markdown-body",
                block.text,
              );
            } else {
              const key = messageThinkingKey(
                entry.entryId,
                entry.displayDraftKey,
                blockIndex,
              );
              const expanded = this.expandedKeys.has(key);
              addStatic(
                Object.freeze([disclosureTitleLine(THINKING_COLLAPSED_TEXT, key, expanded)]),
                Object.freeze([key]),
              );
              addMaybeExpandedCached(
                expanded,
                entry.displayDraftKey === undefined
                  ? `message-thinking:${entry.incarnationId}:${entry.entryId}:${blockIndex}`
                  : `live-thinking:${entry.displayDraftKey}:${blockIndex}`,
                "guided-markdown-terminal",
                block.thinking,
              );
            }
            blockIndex += 1;
          }
          continue;
        }

        if (entry.kind === "parent_message") {
          const key = parentMessageKey(entry.entryId);
          const expanded = this.expandedKeys.has(key);
          addStatic(
            Object.freeze([disclosureTitleLine(PARENT_MESSAGE_TITLE, key, expanded)]),
            Object.freeze([key]),
          );
          let blockIndex = 0;
          for (const block of entry.content) {
            if (block.type === "text") {
              addMaybeExpandedCached(
                expanded,
                `parent-text:${entry.incarnationId}:${entry.entryId}:${blockIndex}`,
                "guided-markdown-body",
                block.text,
              );
            } else {
              const thinkingTitleKey = `${key}:${blockIndex}`;
              if (expanded) {
                addGuidedStatic(
                  disclosureTitleLine(THINKING_COLLAPSED_TEXT, thinkingTitleKey, true),
                  thinkingTitleKey,
                );
              }
              addMaybeExpandedCached(
                expanded,
                `parent-thinking:${entry.incarnationId}:${entry.entryId}:${blockIndex}`,
                "guided-markdown-terminal",
                block.thinking,
              );
            }
            blockIndex += 1;
          }
          continue;
        }

        if (entry.kind === "live") {
          const thinkingTitle = entry.draft.state === "frozen"
            ? THINKING_FROZEN_TEXT
            : entry.draft.state === "complete"
              ? THINKING_COLLAPSED_TEXT
              : THINKING_STREAMING_TEXT;
          for (const block of entry.draft.blocks) {
            if (block.contentType === "text") {
              addCached(
                `live-text:${entry.draft.key}:${block.contentIndex}`,
                "markdown-body",
                block.value,
              );
              continue;
            }
            const key = liveThinkingKey(entry.draft.key, block.contentIndex);
            const expanded = this.expandedKeys.has(key);
            addStatic(
              Object.freeze([disclosureTitleLine(thinkingTitle, key, expanded)]),
              Object.freeze([key]),
            );
            addMaybeExpandedCached(
              expanded,
              `live-thinking:${entry.draft.key}:${block.contentIndex}`,
              "guided-markdown-terminal",
              block.value,
            );
          }
          if (entry.draft.state === "frozen" && entry.draft.blocks.length > 0) {
            const last = entry.draft.blocks.at(-1)!;
            if (last.contentType === "text") {
              addStatic(Object.freeze([{ text: FROZEN_DRAFT_ELLIPSIS, style: "terminal" as const }]));
            } else if (this.expandedKeys.has(liveThinkingKey(entry.draft.key, last.contentIndex))) {
              addStatic(Object.freeze([{
                text: `${EXPANDED_BODY_GUIDE}${FROZEN_DRAFT_ELLIPSIS}`,
                style: "terminal" as const,
              }]));
            }
          }
          continue;
        }

        if (entry.kind === "model_call_failure") {
          const key = modelCallFailureKey(entry.entryId);
          const expanded = this.expandedKeys.has(key);
          const label = `${MODEL_CALL_FAILURE_TITLE_PREFIX} ${firstLine(entry.message)}`;
          addDynamicLine((width) => toolTitleLine({
            label,
            visual: MODEL_CALL_FAILURE_VISUAL,
            width,
            key,
            expanded,
          }), key);
          addMaybeExpandedCached(
            expanded,
            `model-call-failure:${entry.incarnationId}:${entry.entryId}`,
            "guided-model-call-failure",
            modelCallFailureBodySource(entry.provider, entry.model, entry.message),
          );
          continue;
        }

        const visual = toolDisplayVisual(entry);
        // 工具摘要统一作为标题：状态图标位于标题前缀；可展开项顺序为折叠符、
        // 状态图标、摘要，不可展开项由状态图标占据最左侧。
        if (entry.summary !== undefined) {
          const shell = entry.summary.tool === "bash" || entry.summary.tool === "powershell";
          // codemode 脚本与 Shell 命令一样是预格式化正文；结束事实缺少
          // 脚本正文（开始参数缓存缺失）时没有可展开内容。
          const codeBody = entry.summary.tool === "codemode" ? entry.summary.code : undefined;
          const messageBody = toolMessageBody(entry.summary);
          const errorBody = shell ? undefined : entry.errorText;
          const expandable = shell || codeBody !== undefined
            || errorBody !== undefined || messageBody !== undefined;
          const expandKey = shell
            ? toolCommandKey(entry.entryId)
            : codeBody !== undefined
              ? toolCodeKey(entry.entryId)
              : errorBody !== undefined
                ? toolErrorKey(entry.entryId)
                : toolMessageKey(entry.entryId);
          const expanded = expandable && this.expandedKeys.has(expandKey);
          addDynamicLine((width) => {
            const suffix = toolLineSuffix(visual, entry.errorCode);
            const summaryWidth = Math.max(
              1,
              width
                - (expandable ? 2 : 0)
                - displayWidth(suffix)
                - displayWidth(visual.icon) - 1,
            );
            const failureTail = statusFailureTail(entry.summary!);
            const summaryText = formatStatusSummary(entry.summary!, summaryWidth, failureTail);
            return toolTitleLine({
              label: `${summaryText}${suffix}`,
              visual,
              width,
              ...(expandable ? { key: expandKey, expanded } : {}),
              ...(failureTail === undefined ? {} : { errorTail: failureTail }),
            });
          }, expandable ? expandKey : undefined);
          if (entry.summary.tool === "bash" || entry.summary.tool === "powershell") {
            addMaybeExpandedCached(
              expanded,
              `tool-command:${entry.incarnationId}:${entry.entryId}`,
              "guided-shell-command",
              entry.summary.command,
            );
          } else if (codeBody !== undefined) {
            addMaybeExpandedCached(
              expanded,
              `tool-code:${entry.incarnationId}:${entry.entryId}`,
              "guided-codemode-code",
              codeBody,
            );
          } else if (errorBody !== undefined) {
            addMaybeExpandedCached(
              expanded,
              `tool-error:${entry.incarnationId}:${entry.entryId}`,
              "guided-tool-error",
              errorBody,
            );
          } else if (messageBody !== undefined) {
            addMaybeExpandedCached(
              expanded,
              `tool-message:${entry.incarnationId}:${entry.entryId}`,
              "guided-markdown-body",
              messageBody,
            );
          }
          continue;
        }

        // 安全兜底只显示工具名、静态运行提示与状态，不提供展开入口。
        addDynamicLine((width) => {
          const summary = safeUiFact(entry.toolName);
          const runningLabel = entry.state.phase === "running" && entry.toolName === "wait_agent"
            ? `${summary}${SUMMARY_SEPARATOR}${WAIT_AGENT_RUNNING_TEXT}`
            : summary;
          const suffixParts = [
            ...(visual.suffix === undefined ? [] : [visual.suffix]),
            ...(entry.errorCode === undefined ? [] : [entry.errorCode]),
          ];
          return toolTitleLine({
            label: `${runningLabel}${
              suffixParts.length === 0 ? "" : ` · ${suffixParts.join(SUMMARY_SEPARATOR)}`
            }`,
            visual,
            width,
          });
        });
      }
      for (const key of this.bodyBlockCache.keys()) {
        if (!activeCacheKeys.has(key)) this.bodyBlockCache.delete(key);
      }
    }

    const selectableKeys: string[] = [];
    const seenKeys = new Set<string>();
    for (const block of blocks) {
      for (const key of block.selectableKeys) {
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        selectableKeys.push(key);
      }
    }
    const layout = Object.freeze({
      blocks: Object.freeze(blocks),
      selectableKeys: Object.freeze(selectableKeys),
    });
    this.cachedLayout = { revision: this.projectionRevision, layout };
    return layout;
  }

  /** 只物化当前可见窗口；跟随尾部时不为绝对行号提前布局整段历史。 */
  private visibleEventLines(width: number): readonly ViewerSemanticLine[] {
    const contentWidth = validRenderWidth(width);
    if (this.followEnabled) {
      const cached = this.cachedLineCount;
      if (
        cached !== undefined
        && cached.width === contentWidth
        && cached.revision === this.projectionRevision
      ) {
        this.scrollOffset = Math.max(0, cached.count - this.viewportHeight);
      }
      return this.tailVisibleEventLines(contentWidth);
    }
    const maxOffset = Math.max(0, this.exactEventLineCount(contentWidth) - this.viewportHeight);
    this.scrollOffset = clamp(this.scrollOffset, 0, maxOffset);
    return this.windowVisibleEventLines(contentWidth);
  }

  /** 倒序逐块取尾部窗口；不为 follow 模式提前计算整个历史的精确行数。 */
  private tailVisibleEventLines(width: number): readonly ViewerSemanticLine[] {
    const visible: ViewerSemanticLine[] = [];
    let remaining = this.viewportHeight;
    const blocks = this.layout().blocks;
    for (let index = blocks.length - 1; index >= 0 && remaining > 0; index -= 1) {
      const block = blocks[index]!;
      const lines = block.renderTail(width, remaining);
      if (lines.length === 0) continue;
      visible.unshift(...lines);
      remaining -= lines.length;
    }
    return Object.freeze(visible);
  }

  private windowVisibleEventLines(width: number): readonly ViewerSemanticLine[] {
    const start = Math.max(0, this.scrollOffset);
    const end = start + this.viewportHeight;
    const visible: ViewerSemanticLine[] = [];
    let position = 0;
    for (const block of this.layout().blocks) {
      const count = block.lineCount(width);
      const nextPosition = position + count;
      if (nextPosition > start && position < end) {
        const localStart = Math.max(0, start - position);
        const localLimit = Math.min(count, end - position) - localStart;
        if (localLimit > 0) {
          visible.push(...block.renderWindow(width, localStart, localLimit));
        }
      }
      position = nextPosition;
      if (position >= end) break;
    }
    return Object.freeze(visible);
  }
}

type DisplayEntry =
  | {
      readonly kind: "message";
      readonly entryId: string;
      /** 运行实例身份。 */
      readonly incarnationId: string;
      /** 与实时显示流的精确关联身份；缺省表示没有可关联的实时流。 */
      readonly displayDraftKey?: string;
      readonly content: readonly SafeAgentActivityContentBlock[];
    }
  | {
      readonly kind: "parent_message";
      readonly entryId: string;
      readonly incarnationId: string;
      readonly content: readonly SafeAgentActivityContentBlock[];
    }
  | {
      /** 一次模型调用失败的活动事实；每次失败尝试各自成条。 */
      readonly kind: "model_call_failure";
      readonly entryId: string;
      readonly incarnationId: string;
      readonly message: string;
      /** 发起该次失败的模型；压缩自身失败等场景不可得时缺失。 */
      readonly provider?: string;
      readonly model?: string;
    }
  | {
      readonly kind: "live";
      readonly draft: AgentDisplayDraftView;
    }
  | ToolDisplayEntry;

interface ToolTitleLineOptions {
  readonly label: string;
  readonly visual: ReturnType<typeof toolDisplayVisual>;
  readonly width: number;
  readonly key?: string;
  readonly expanded?: boolean;
  readonly errorTail?: string;
}

/** 工具标题固定为“可选折叠符、状态图标、摘要”。 */
function toolTitleLine(options: ToolTitleLineOptions): ViewerSemanticLine {
  const disclosureMarker = options.key === undefined
    ? undefined
    : options.expanded === true ? "▾" as const : "▸" as const;
  const prefix = disclosureMarker === undefined
    ? options.visual.icon
    : `${disclosureMarker} ${options.visual.icon}`;
  const labelWidth = Math.max(0, options.width - displayWidth(prefix) - 1);
  const label = truncateToDisplayWidth(options.label, labelWidth);
  const text = label.length === 0
    ? truncateToDisplayWidth(prefix, options.width)
    : `${prefix} ${label}`;
  return Object.freeze({
    text,
    style: options.visual.style,
    emphasized_title: true,
    status_icon: Object.freeze({ text: options.visual.icon, style: options.visual.style }),
    ...(disclosureMarker === undefined ? {} : { disclosure_marker: disclosureMarker }),
    ...(options.key === undefined ? {} : { selectable_key: options.key }),
    ...(options.errorTail === undefined ? {} : { error_tail: options.errorTail }),
  });
}

/** 无工具状态的可展开标题同样使用统一箭头和粗体强调色。 */
function disclosureTitleLine(
  label: string,
  key: string,
  expanded: boolean,
): ViewerSemanticLine {
  const marker = expanded ? "▾" as const : "▸" as const;
  return Object.freeze({
    text: `${marker} ${label}`,
    style: "accent" as const,
    selectable_key: key,
    emphasized_title: true,
    disclosure_marker: marker,
  });
}

const EXPANDED_BODY_GUIDE = "│ ";

/** 展开正文先扣除引导线宽度再渲染，保证换行后每一行都保留 `│`。 */
function renderGuidedBody(
  width: number,
  renderBody: (bodyWidth: number) => readonly ViewerSemanticLine[],
): readonly ViewerSemanticLine[] {
  if (width <= 1) {
    return Object.freeze(renderBody(1).map((line) => Object.freeze({ ...line, text: "│" })));
  }
  const bodyWidth = width - displayWidth(EXPANDED_BODY_GUIDE);
  return Object.freeze(renderBody(bodyWidth).map((line) => Object.freeze({
    ...line,
    text: `${EXPANDED_BODY_GUIDE}${line.text}`,
  })));
}

/** 将纯查看器投影包装成完整主题表面，避免 overlay 内部继续透出底层会话内容。 */
export function renderAgentActivityViewerSurface(
  model: AgentActivityViewerModel | undefined,
  width: number,
  theme: unknown,
): readonly string[] {
  const panelWidth = Number.isSafeInteger(width) && width > 0 ? width : 0;
  if (panelWidth === 0) return Object.freeze([]);
  const framed = panelWidth >= 6;
  const contentWidth = framed ? panelWidth - 4 : panelWidth;
  const semanticLines = model === undefined
    ? unavailableViewerLines(contentWidth)
    : model[RENDER_VIEWER_LINES](contentWidth);
  const header = semanticLines[0]?.text ?? "";
  const footer = semanticLines.at(-1)?.text ?? "";
  const body = semanticLines.slice(1, -1);

  if (!framed) {
    return Object.freeze([
      renderNarrowPanelLine(header, panelWidth, "header", false, theme),
      ...body.map((line) => renderViewerNarrowPanelLine(
        line,
        panelWidth,
        theme,
      )),
      renderNarrowPanelLine(footer, panelWidth, "footer", false, theme),
    ]);
  }

  return Object.freeze([
    renderPanelRule(panelWidth, "top", theme),
    renderFramedPanelLine(header, contentWidth, "header", false, theme),
    renderPanelRule(panelWidth, "divider", theme),
    ...body.map((line) => renderViewerFramedPanelLine(
      line,
      contentWidth,
      theme,
    )),
    renderPanelRule(panelWidth, "divider", theme),
    renderFramedPanelLine(footer, contentWidth, "footer", false, theme),
    renderPanelRule(panelWidth, "bottom", theme),
  ]);
}

/** 标题和前置状态需要独立着色；普通正文继续复用共享面板渲染器。 */
function renderViewerFramedPanelLine(
  line: ViewerSemanticLine,
  contentWidth: number,
  theme: unknown,
): string {
  if (line.emphasized_title !== true && line.status_icon === undefined) {
    return renderFramedPanelLine(
      line.text,
      contentWidth,
      line.style,
      line.selected === true,
      theme,
      line.error_tail,
    );
  }
  const value = truncateToDisplayWidth(line.text, contentWidth);
  const pad = " ".repeat(Math.max(0, contentWidth - displayWidth(value)));
  const borderColor = line.selected === true ? "borderAccent" : "border";
  const rendered = `${themeFg(theme, borderColor, "┃")} ${
    styleViewerSemanticText({ ...line, text: value }, theme)
  }${pad} ${themeFg(theme, borderColor, "┃")}`;
  return themeBg(theme, line.selected === true ? "selectedBg" : "customMessageBg", rendered);
}

function renderViewerNarrowPanelLine(
  line: ViewerSemanticLine,
  width: number,
  theme: unknown,
): string {
  if (line.emphasized_title !== true && line.status_icon === undefined) {
    return renderNarrowPanelLine(
      line.text,
      width,
      line.style,
      line.selected === true,
      theme,
      line.error_tail,
    );
  }
  const value = truncateToDisplayWidth(line.text, width);
  const pad = " ".repeat(Math.max(0, width - displayWidth(value)));
  return themeBg(
    theme,
    line.selected === true ? "selectedBg" : "customMessageBg",
    `${styleViewerSemanticText({ ...line, text: value }, theme)}${pad}`,
  );
}

/** 折叠符、工具状态、标题与局部错误事实分别应用主题。 */
function styleViewerSemanticText(line: ViewerSemanticLine, theme: unknown): string {
  let title = line.text;
  let marker: "▸" | "▾" | undefined;
  if (line.disclosure_marker !== undefined && title.startsWith(line.disclosure_marker)) {
    marker = line.disclosure_marker;
    title = title.slice(marker.length);
    if (title.startsWith(" ")) title = title.slice(1);
  }

  let status: ViewerStatusIcon | undefined;
  if (line.status_icon !== undefined && title.startsWith(line.status_icon.text)) {
    status = line.status_icon;
    title = title.slice(status.text.length);
    if (title.startsWith(" ")) title = title.slice(1);
  }

  let errorTail: string | undefined;
  if (line.error_tail !== undefined && title.endsWith(line.error_tail)) {
    title = title.slice(0, -line.error_tail.length);
    errorTail = line.error_tail;
  }
  const styledTitle = title.length === 0
    ? ""
    : line.emphasized_title === true
      ? stylePanelText(themeBold(theme, title), line.style, theme)
      : stylePanelText(title, line.style, theme);
  const styledError = errorTail === undefined
    ? ""
    : themeFg(
      theme,
      "error",
      line.emphasized_title === true ? themeBold(theme, errorTail) : errorTail,
    );
  const parts = [
    ...(marker === undefined ? [] : [stylePanelText(marker, "terminal", theme)]),
    ...(status === undefined ? [] : [stylePanelText(status.text, status.style, theme)]),
  ];
  const styledBody = `${styledTitle}${styledError}`;
  if (styledBody.length > 0) parts.push(styledBody);
  return parts.join(" ");
}

function unavailableViewerLines(width: number): readonly ViewerSemanticLine[] {
  const lines: ViewerSemanticLine[] = [
    { text: truncateToDisplayWidth(`${VIEWER_HEADER_TEXT} · temporarily unavailable`, width), style: "header" },
  ];
  while (lines.length < DEFAULT_VIEWER_VIEWPORT_HEIGHT + 1) lines.push({ text: "", style: "body" });
  lines.push({ text: truncateToDisplayWidth("Esc back", width), style: "footer" });
  return Object.freeze(lines.map((line) => Object.freeze(line)));
}

/** text 块按正常 Markdown 完整渲染；不增加角色标签、容器或分隔线。 */
function renderMarkdownBlock(
  raw: string,
  width: number,
  style: UiPanelLineStyle,
): readonly ViewerSemanticLine[] {
  const safe = sanitizeViewerMarkup(raw);
  if (safe.length === 0) return Object.freeze([]);
  let rendered: readonly string[];
  try {
    rendered = new Markdown(safe, 0, 0, PLAIN_MARKDOWN_THEME).render(width);
  } catch {
    rendered = wrapPlainText(safe, width);
  }
  const lines = rendered.map((line) => {
    const clean = sanitizeViewerMarkup(line).replace(/[ \t]+$/u, "");
    return Object.freeze({ text: clean, style });
  });
  return Object.freeze(lines);
}

function renderCachedBodyBlock(
  kind: CachedBodyKind,
  source: string,
  width: number,
): readonly ViewerSemanticLine[] {
  switch (kind) {
    case "markdown-body":
      return renderMarkdownBlock(source, width, "body");
    case "markdown-terminal":
      return renderMarkdownBlock(source, width, "terminal");
    case "guided-markdown-body":
      return renderGuidedBody(width, (bodyWidth) => renderMarkdownBlock(source, bodyWidth, "body"));
    case "guided-markdown-terminal":
      return renderGuidedBody(width, (bodyWidth) => renderMarkdownBlock(source, bodyWidth, "terminal"));
    case "guided-tool-error":
    case "guided-model-call-failure":
      return renderGuidedBody(width, (bodyWidth) => renderPreformattedErrorBody(source, bodyWidth));
    case "guided-shell-command":
    case "guided-codemode-code":
      return renderGuidedBody(width, (bodyWidth) => renderPreformattedBody(source, bodyWidth));
  }
}

const PARENT_MESSAGE_TITLE = "Parent message";

function wrapPlainText(value: string, width: number): readonly string[] {
  return Object.freeze(value.split("\n").flatMap((line) => wrapPlainLine(line, width)));
}

/**
 * 错误文本首行：跳过开头的空行后取第一段，不裁剪其后的空白、不摘要、
 * 不加省略号。
 */
function firstLine(value: string): string {
  const fromFirstLine = value.replace(/^\n+/u, "");
  const breakIndex = fromFirstLine.indexOf("\n");
  return breakIndex < 0 ? fromFirstLine : fromFirstLine.slice(0, breakIndex);
}

/**
 * 模型调用失败展开体：身份可得时首行为 `provider · model`，其后为错误文本
 * 原文；身份缺失（压缩自身失败）时正文直接以错误原文开头，不写占位文案、
 * 不留空行。整段作为一块预格式化正文渲染，因此换行、前导空白与软折行行为
 * 与工具失败一致。
 */
function modelCallFailureBodySource(
  provider: string | undefined,
  model: string | undefined,
  message: string,
): string {
  return provider === undefined || model === undefined
    ? message
    : `${provider}${SUMMARY_SEPARATOR}${model}\n${message}`;
}

/**
 * 工具错误正文：红色预格式化纯文本。不解析 Markdown、不做语义摘要或字符
 * 截断，只按正文宽度软换行，保留换行与可读空白；调用方统一添加引导线。
 * 模型调用失败展开体复用同一渲染。
 */
function renderPreformattedErrorBody(
  errorText: string,
  width: number,
): readonly ViewerSemanticLine[] {
  const safe = sanitizeViewerMarkup(errorText);
  if (safe.length === 0) return Object.freeze([]);
  return Object.freeze(wrapPlainText(safe, width).map((line) => Object.freeze({
    text: line,
    style: "error" as const,
  })));
}

/**
 * 预格式化正文（Shell 命令与 codemode 脚本）：默认折叠，展开后作为独立
 * 预格式化正文显示。单行与多行内容采用同一种软换行结构，不截断字符。
 */
function renderPreformattedBody(
  value: string,
  width: number,
): readonly ViewerSemanticLine[] {
  const safe = sanitizeViewerMarkup(value);
  if (safe.length === 0) return Object.freeze([]);
  return Object.freeze(wrapPlainText(safe, width).map((line) => Object.freeze({
    text: line,
    style: "body" as const,
  })));
}

/**
 * 超宽路径中间省略：保留首尾两端，中间以单个省略号连接；在字素簇边界
 * 切分，不切断组合字符或宽字符。
 */
function truncateMiddleToDisplayWidth(value: string, width: number): string {
  if (!Number.isSafeInteger(width) || width <= 0) return "";
  if (displayWidth(value) <= width) return value;
  if (width <= 1) return "…";
  const segments = [...SEGMENTER.segment(value)];
  const headBudget = Math.floor((width - 1) / 2);
  const tailBudget = width - 1 - headBudget;
  let head = "";
  let headUsed = 0;
  let headIndex = 0;
  for (; headIndex < segments.length; headIndex += 1) {
    const segment = segments[headIndex]!.segment;
    const segmentWidth = displayWidth(segment);
    if (headUsed + segmentWidth > headBudget) break;
    head += segment;
    headUsed += segmentWidth;
  }
  let tail = "";
  let tailUsed = 0;
  let tailIndex = segments.length - 1;
  while (tailIndex >= headIndex) {
    const segment = segments[tailIndex]!.segment;
    const segmentWidth = displayWidth(segment);
    if (tailUsed + segmentWidth > tailBudget) break;
    tail = segment + tail;
    tailUsed += segmentWidth;
    tailIndex -= 1;
  }
  return `${head}…${tail}`;
}

/** 路径超宽时中间省略；其余字段从右侧省略。 */
const SUMMARY_SEPARATOR = " · ";

interface SummaryFragments {
  readonly head: readonly string[];
  readonly path: string;
  readonly tail: readonly string[];
}

/** 把专用摘要拆为“路径前字段 / 路径 / 路径后字段”，供省略策略使用。 */
function summaryFragments(summary: SafeToolSummary): SummaryFragments {
  switch (summary.tool) {
    case "read": {
      const tail = [
        ...(summary.offset === undefined ? [] : [`offset ${summary.offset}`]),
        ...(summary.limit === undefined ? [] : [`limit ${summary.limit}`]),
        ...readTruncationFacts(summary.truncated, summary.truncatedBy, summary.firstLineExceedsLimit),
        ...(summary.hasMoreLines === true ? ["more lines"] : []),
      ];
      return { head: ["read"], path: summary.path, tail };
    }
    case "grep": {
      const tail = [
        ...(summary.glob === undefined ? [] : [`glob ${summary.glob}`]),
        ...(summary.ignoreCase === true ? ["ignoreCase"] : []),
        ...(summary.literal === true ? ["literal"] : []),
        ...(summary.context === undefined ? [] : [`context ${summary.context}`]),
        ...(summary.limit === undefined ? [] : [`limit ${summary.limit}`]),
        ...(summary.noMatches === true ? ["no matches"] : []),
        ...(summary.matchLimitReached === undefined
          ? []
          : [`${summary.matchLimitReached} matches limit`]),
        ...readTruncationFacts(summary.truncated, summary.truncatedBy),
        ...(summary.linesTruncated === true ? ["lines truncated"] : []),
      ];
      return { head: ["grep", `/${summary.pattern}/`], path: summary.path, tail };
    }
    case "find": {
      const tail = [
        ...(summary.limit === undefined ? [] : [`limit ${summary.limit}`]),
        ...(summary.noFiles === true ? ["no files"] : []),
        ...(summary.resultLimitReached === undefined
          ? []
          : [`${summary.resultLimitReached} results limit`]),
        ...readTruncationFacts(summary.truncated, summary.truncatedBy),
      ];
      return { head: ["find", summary.pattern], path: summary.path, tail };
    }
    case "ls": {
      const tail = [
        ...(summary.limit === undefined ? [] : [`limit ${summary.limit}`]),
        ...(summary.emptyDirectory === true ? ["empty directory"] : []),
        ...(summary.entryLimitReached === undefined
          ? []
          : [`${summary.entryLimitReached} entries limit`]),
        ...readTruncationFacts(summary.truncated, summary.truncatedBy),
      ];
      return { head: ["ls"], path: summary.path, tail };
    }
    case "write":
    case "edit": {
      // 成功与失败摘要都只有 path：写入/编辑统计不属于展示闭集。
      return { head: [summary.tool], path: summary.path, tail: [] };
    }
    case "bash":
    case "powershell": {
      // 状态摘要只显示工具名和可选 timeout；command 正文（可能已在产生端
      // 截断）在独立可展开代码区域。
      const tail = summary.timeout === undefined ? [] : [`timeout ${summary.timeout}`];
      return { head: [summary.tool], path: "", tail };
    }
    case "codemode": {
      // 折叠态只显示脚本行数与嵌套调用数；截断后的脚本在独立可展开正文区。
      const tail = [
        ...(summary.codeLines === undefined ? [] : [`${summary.codeLines} lines`]),
        ...(summary.nestedCalls === undefined ? [] : [`${summary.nestedCalls} nested calls`]),
      ];
      return { head: [summary.tool], path: "", tail };
    }
    case "tool_search": {
      // 折叠态显示查询词与加载结果：查询词在头部，加载的工具名列表作为
      // 可中间省略的路径字段，尾部只保留数量事实（截断时给出前/总数）。
      const head = ["tool_search"];
      if (summary.query !== undefined) head.push(`"${summary.query}"`);
      const loaded = summary.loaded ?? [];
      const tail = summary.loadedTotal === undefined
        ? []
        : [loaded.length === summary.loadedTotal
          ? `${summary.loadedTotal} tools`
          : `${loaded.length}/${summary.loadedTotal} tools`];
      return { head, path: loaded.join(", "), tail };
    }
    case "list_mcp_resources":
    case "list_mcp_resource_templates":
    case "read_mcp_resource": {
      // 服务器在头部；资源 URI 作为可中间省略的路径字段。
      const head: string[] = [summary.tool];
      if (summary.server !== undefined) head.push(summary.server);
      return { head, path: summary.uri ?? "", tail: [] };
    }
    case "get_agent_templates": {
      // 成功只显示模板数量；失败摘要没有该字段，也不显示模板配置。
      const tail = summary.count === undefined ? [] : [`${summary.count} templates`];
      return { head: [summary.tool], path: "", tail };
    }
    case "spawn_agent": {
      // 显示 name、template ID 与完整 UUID 的固定前八位；不显示 depth 或
      // 初始 state。成功才有 agent_id。
      const tail = summary.agent_id === undefined ? [] : [shortAgentId(summary.agent_id)];
      return { head: [summary.tool, summary.name, summary.template_id], path: "", tail };
    }
    case "send_message": {
      // 显示目标名称与固定八位短 ID；不显示 accepted。完整 message 在
      // 独立可展开正文区域。
      const head: string[] = [summary.tool];
      if (summary.name !== undefined) head.push(summary.name);
      head.push(shortAgentId(summary.agent_id));
      return { head, path: "", tail: [] };
    }
    case "normal_reply":
    case "final_report": {
      // 摘要只显示工具名；完整 message 在独立可展开正文区域。
      return { head: [summary.tool], path: "", tail: [] };
    }
    case "wait_agent": {
      // 单目标显示名称与固定八位短 ID，多目标只显示数量；实际 outcome、
      // batch release 的释放者与释放 outcome、目标 failed 的安全错误码并列。
      const head: string[] = ["wait_agent"];
      if (summary.agent_id !== undefined) {
        if (summary.name !== undefined) head.push(summary.name);
        head.push(shortAgentId(summary.agent_id));
      } else if (summary.target_count !== undefined) {
        head.push(`${summary.target_count} targets`);
      }
      const tail: string[] = [];
      if (summary.outcome !== undefined) tail.push(summary.outcome);
      if (summary.released_by !== undefined) {
        if (summary.released_by_name !== undefined) tail.push(summary.released_by_name);
        tail.push(shortAgentId(summary.released_by));
      }
      if (summary.released_outcome !== undefined) tail.push(summary.released_outcome);
      if (summary.state === "failed") {
        tail.push("failed");
        if (summary.error_code !== undefined) tail.push(summary.error_code);
      }
      return { head, path: "", tail };
    }
    case "interrupt_agent": {
      // 显示目标与真实控制结果：unchanged 与压缩阻塞为中性事实。
      const head: string[] = ["interrupt_agent"];
      if (summary.name !== undefined) head.push(summary.name);
      head.push(shortAgentId(summary.agent_id));
      const tail = summary.changed === false
        ? [summary.blocked_reason === undefined ? "unchanged" : summary.blocked_reason]
        : [];
      return { head, path: "", tail };
    }
    case "terminate_agent": {
      // 显示目标、回收数量、幂等与强制回收事实。
      const head: string[] = ["terminate_agent"];
      if (summary.name !== undefined) head.push(summary.name);
      head.push(shortAgentId(summary.agent_id));
      const tail: string[] = [];
      if (summary.changed === false) tail.push("already terminated");
      else if (summary.terminated_count !== undefined) {
        tail.push(`${summary.terminated_count} reclaimed`);
      }
      if (summary.forced === true) tail.push("forced");
      return { head, path: "", tail };
    }
    case "get_agent_status": {
      // 显示目标、生命周期状态与条件性 phase、错误码、终止结果；revision、
      // 时间与上下文占用不进入显示。
      const head: string[] = ["get_agent_status"];
      if (summary.name !== undefined) head.push(summary.name);
      head.push(shortAgentId(summary.agent_id));
      const tail: string[] = [];
      if (summary.state !== undefined) tail.push(summary.state);
      if (summary.phase !== undefined) tail.push(summary.phase);
      if (summary.termination_result !== undefined) tail.push(summary.termination_result);
      if (summary.error_code !== undefined) tail.push(summary.error_code);
      return { head, path: "", tail };
    }
    case "get_agent_tree": {
      // 成功只显示工具名与成功状态；不保存 revision、scope、节点列表或统计。
      return { head: ["get_agent_tree"], path: "", tail: [] };
    }
    default: {
      // MCP 工具：工具名本身携带服务器与工具名（哈希后缀保留在工具名
      // 侧）；只读、破坏性等 annotations 作为风险提示并列显示。
      return {
        head: [summary.tool],
        path: "",
        tail: mcpAnnotationLabels(summary.annotations),
      };
    }
  }
}

/**
 * MCP annotations 的显示标签：只显示实际存在的 true hint（缺省与 false
 * 不产生标签，避免把默认值误当风险事实）；顺序与 MCP 规范定义一致。
 */
function mcpAnnotationLabels(
  annotations: SafeMcpToolAnnotations | undefined,
): readonly string[] {
  if (annotations === undefined) return [];
  return [
    ...(annotations.readOnlyHint === true ? ["read-only"] : []),
    ...(annotations.destructiveHint === true ? ["destructive"] : []),
    ...(annotations.idempotentHint === true ? ["idempotent"] : []),
    ...(annotations.openWorldHint === true ? ["open world"] : []),
  ];
}

/** 显示层固定八位短 ID：完整 UUID 的前八位；内部关联仍使用完整 UUID。 */
function shortAgentId(agentId: string): string {
  return agentId.slice(0, 8);
}

/** 消息类插件工具摘要自包含的完整尝试正文（成功与失败都保留）。 */
function toolMessageBody(summary: SafeToolSummary): string | undefined {
  return isMessageToolSummary(summary) ? summary.message : undefined;
}

/** 工具标题中的收束事实：状态视觉后缀与规范稳定错误码并列。 */
function toolLineSuffix(
  visual: { readonly suffix?: string },
  errorCode: string | undefined,
): string {
  const parts = [
    ...(visual.suffix === undefined ? [] : [visual.suffix]),
    ...(errorCode === undefined ? [] : [errorCode]),
  ];
  return parts.length === 0 ? "" : ` · ${parts.join(SUMMARY_SEPARATOR)}`;
}

function readTruncationFacts(
  truncated: boolean | undefined,
  truncatedBy: "lines" | "bytes" | undefined,
  firstLineExceedsLimit?: boolean,
): readonly string[] {
  if (truncated !== true) return [];
  if (firstLineExceedsLimit === true) return ["truncated (first line)"];
  return [`truncated (${truncatedBy ?? "bytes"})`];
}

/**
 * 专用摘要单行格式：状态图标与折叠标记之外的全部内容。长路径中间省略
 * 保留两端；其余超宽内容依赖整行右侧省略兜底。
 */
function formatToolSummary(summary: SafeToolSummary, contentWidth: number): string {
  const fragments = summaryFragments(summary);
  const head = fragments.head.join(SUMMARY_SEPARATOR);
  const tail = fragments.tail.join(SUMMARY_SEPARATOR);
  const join = (path: string): string =>
    [head, path, tail].filter((part) => part.length > 0).join(SUMMARY_SEPARATOR);
  const full = join(fragments.path);
  if (displayWidth(full) <= contentWidth) return full;
  // 路径预算：整行减去固定部分、路径前的分隔符与省略号一位。
  const fixed = [head, tail].filter((part) => part.length > 0).join(SUMMARY_SEPARATOR);
  const budget = contentWidth - displayWidth(fixed)
    - (fixed.length > 0 ? SUMMARY_SEPARATOR.length : 0) - 1;
  const middlePath = truncateMiddleToDisplayWidth(fragments.path, Math.max(1, budget));
  return join(middlePath);
}

/** get_agent_status 目标 failed 时的行尾红色片段：failed 状态与安全错误码。 */
function statusFailureTail(summary: SafeToolSummary): string | undefined {
  if (summary.tool !== "get_agent_status" || summary.state !== "failed") return undefined;
  return summary.error_code === undefined
    ? "failed"
    : `failed${SUMMARY_SEPARATOR}${summary.error_code}`;
}

/**
 * get_agent_status 摘要格式：查询成功时整行保持成功视觉，只把行尾的
 * failed 与错误码片段留给错误色；前段超宽时先于红色片段右侧省略。
 */
function formatStatusSummary(
  summary: SafeToolSummary,
  contentWidth: number,
  failureTail: string | undefined,
): string {
  const full = formatToolSummary(summary, contentWidth);
  if (failureTail === undefined) return full;
  const redPart = `${SUMMARY_SEPARATOR}${failureTail}`;
  if (!full.endsWith(redPart)) return full;
  const dim = truncateToDisplayWidth(
    full.slice(0, full.length - redPart.length),
    Math.max(1, contentWidth - displayWidth(redPart)),
  );
  return `${dim}${redPart}`;
}

function countWrappedPlainLine(value: string, width: number, trimTrailing: boolean): number {
  let count = 0;
  visitWrappedPlainLine(value, width, trimTrailing, () => {
    count += 1;
    return false;
  });
  return count;
}

/**
 * 按与旧 wrapPlainLine 相同的字素簇和单词边界规则遍历软换行结果。
 * 只在每个输出行边界创建字符串，避免对长正文反复重新分割剩余全文。
 */
function visitWrappedPlainLine(
  value: string,
  width: number,
  trimTrailing: boolean,
  callback: (wrapped: string) => boolean,
): boolean {
  void trimTrailing;
  const normalized = value.includes("\t") ? value.replace(/\t/gu, "   ") : value;
  const contentWidth = Math.max(1, width);
  // 产生端净化后的大多数正文是可打印 ASCII。该分支与下方字素簇算法
  // 的空白断行规则相同，但避免为数百万个 ASCII 字符创建 SegmentData 对象。
  if (isPrintableAsciiLine(normalized)) {
    return visitAsciiWrappedPlainLine(normalized, contentWidth, callback);
  }
  if (isSimpleCjkAsciiLine(normalized)) {
    return visitSimpleCjkAsciiWrappedPlainLine(normalized, contentWidth, callback);
  }
  let totalWidth = 0;
  const segments = [...SEGMENTER.segment(normalized)].map(({ segment, index }) => {
    const segmentWidth = graphemeWidth(segment);
    totalWidth += segmentWidth;
    return { segment, index, width: segmentWidth };
  });
  if (totalWidth <= contentWidth) return callback(normalized);
  if (segments.length === 0) return callback(normalized);

  let cursor = 0;
  let lineStart = 0;
  while (cursor < segments.length) {
    let used = 0;
    let overflowAt = segments.length;
    let overflowed = false;
    let lastBreakAt = -1;
    for (let index = cursor; index < segments.length; index += 1) {
      const current = segments[index]!;
      if (used > 0 && used + current.width > contentWidth) {
        overflowAt = index;
        overflowed = true;
        break;
      }
      if (used === 0 && current.width > contentWidth) {
        overflowAt = index + 1;
        overflowed = true;
        const localBreak = lastWhitespaceOffset(current.segment);
        if (localBreak >= 0) lastBreakAt = current.index + localBreak;
        break;
      }
      used += current.width;
      const localBreak = lastWhitespaceOffset(current.segment);
      if (localBreak >= 0) lastBreakAt = current.index + localBreak;
    }

    if (!overflowed) return callback(normalized.slice(lineStart));

    if (lastBreakAt > lineStart) {
      if (callback(normalized.slice(lineStart, lastBreakAt).trimEnd())) return true;
      let nextStart = lastBreakAt + 1;
      while (/\s/u.test(normalized[nextStart] ?? "")) nextStart += 1;
      lineStart = nextStart;
      while (cursor < segments.length && segments[cursor]!.index < nextStart) cursor += 1;
      if (cursor >= segments.length) return callback("");
      continue;
    }

    const cutAt = segments[overflowAt]?.index ?? normalized.length;
    if (callback(normalized.slice(lineStart, cutAt))) return true;
    lineStart = cutAt;
    cursor = overflowAt;
    if (cursor >= segments.length) return callback(normalized.slice(lineStart));
  }
  return false;
}

/** 已净化单行的 ASCII 快速路径；只有普通空格可作为断词空白。 */
function isPrintableAsciiLine(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

/**
 * 与 visitWrappedPlainLine 的 ASCII 子集等价：优先在当前宽度范围内最后一个
 * 空格换行，并跳过断词点后的连续空格；没有空格时按固定宽度切分。
 */
function visitAsciiWrappedPlainLine(
  value: string,
  width: number,
  callback: (wrapped: string) => boolean,
): boolean {
  if (value.length <= width) return callback(value);
  let lineStart = 0;
  let cursor = 0;
  let used = 0;
  let lastBreakAt = -1;
  while (cursor < value.length) {
    if (used > 0 && used + 1 > width) {
      if (lastBreakAt > lineStart) {
        if (callback(value.slice(lineStart, lastBreakAt).trimEnd())) return true;
        let nextStart = lastBreakAt + 1;
        while (value.charCodeAt(nextStart) === 0x20) nextStart += 1;
        if (nextStart >= value.length) return callback("");
        lineStart = nextStart;
        cursor = nextStart;
      } else {
        if (callback(value.slice(lineStart, cursor))) return true;
        lineStart = cursor;
      }
      used = 0;
      lastBreakAt = -1;
      continue;
    }
    if (value.charCodeAt(cursor) === 0x20) lastBreakAt = cursor;
    used += 1;
    cursor += 1;
  }
  return callback(value.slice(lineStart));
}

function isSimpleCjkAsciiLine(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const first = value.charCodeAt(index);
    if (first >= 0x20 && first <= 0x7e) continue;
    if (first < 0xd800 || first > 0xdfff) {
      if (!isSimpleWideCjkCodePoint(first)) return false;
      continue;
    }
    if (first > 0xdbff) return false;
    const second = value.charCodeAt(index + 1);
    if (second < 0xdc00 || second > 0xdfff) return false;
    const codePoint = ((first - 0xd800) * 0x400) + second - 0xdc00 + 0x10000;
    if (!isSimpleWideCjkCodePoint(codePoint)) return false;
    index += 1;
  }
  return true;
}

/** 只接受不存在扩展字素簇组合的东亚宽字符，保留复杂 Unicode 的精确回退。 */
function isSimpleWideCjkCodePoint(codePoint: number): boolean {
  return codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x3000 && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd);
}

/** ASCII 空格与简单 CJK 标量的等价软换行，不调用 Intl.Segmenter。 */
function visitSimpleCjkAsciiWrappedPlainLine(
  value: string,
  width: number,
  callback: (wrapped: string) => boolean,
): boolean {
  let lineStart = 0;
  let cursor = 0;
  let used = 0;
  let lastBreakAt = -1;
  while (cursor < value.length) {
    const first = value.charCodeAt(cursor);
    const currentLength = first >= 0xd800 && first <= 0xdbff ? 2 : 1;
    const currentWidth = first <= 0x7e ? 1 : 2;
    if (used > 0 && used + currentWidth > width) {
      if (lastBreakAt > lineStart) {
        if (callback(value.slice(lineStart, lastBreakAt).trimEnd())) return true;
        let nextStart = lastBreakAt + 1;
        while (value.charCodeAt(nextStart) === 0x20) nextStart += 1;
        if (nextStart >= value.length) return callback("");
        lineStart = nextStart;
        cursor = nextStart;
      } else {
        if (callback(value.slice(lineStart, cursor))) return true;
        lineStart = cursor;
      }
      used = 0;
      lastBreakAt = -1;
      continue;
    }
    if (used === 0 && currentWidth > width) {
      const next = cursor + currentLength;
      if (callback(value.slice(lineStart, next))) return true;
      lineStart = next;
      cursor = next;
      lastBreakAt = -1;
      continue;
    }
    if (value.charCodeAt(cursor) === 0x20) lastBreakAt = cursor;
    used += currentWidth;
    cursor += currentLength;
  }
  return callback(value.slice(lineStart));
}

function lastWhitespaceOffset(value: string): number {
  let result = -1;
  for (let index = 0; index < value.length; index += 1) {
    if (/\s/u.test(value[index] ?? "")) result = index;
  }
  return result;
}

const PLAIN_LAYOUT_MIN_SOURCE_LENGTH = 4096;

/** 只对没有 Markdown 语义标记的长正文走纯文本布局；短正文继续经过 Markdown，保持既有渲染语义与缓存观测。 */
function isPlainMarkdownSource(value: string): boolean {
  if (value.length < PLAIN_LAYOUT_MIN_SOURCE_LENGTH) return false;
  for (const marker of "\\*_~`[]<>#|&") {
    if (value.includes(marker)) return false;
  }
  if (/\b(?:https?|ftp):\/\//u.test(value)) return false;
  for (const line of value.split("\n")) {
    if (/^ {4,}/u.test(line)) return false;
    if (/^\s{0,3}(?:[-+*]|\d+[.)]|>|#{1,6}(?:\s|$)|```|~~~)/u.test(line)) return false;
    if (/^\s*(?:-{3,}|={3,}|_{3,}|\*{3,})\s*$/u.test(line)) return false;
    if (/ {2,}$/u.test(line)) return false;
  }
  return true;
}

function wrapPlainLine(value: string, width: number): string[] {
  const normalized = value.replace(/\t/gu, "   ");
  if (displayWidth(normalized) <= width) return [normalized];
  const output: string[] = [];
  let remaining = normalized;
  while (displayWidth(remaining) > width) {
    const segments = [...SEGMENTER.segment(remaining)];
    let used = 0;
    let cut = 0;
    for (const segment of segments) {
      const segmentWidth = displayWidth(segment.segment);
      if (cut > 0 && used + segmentWidth > width) break;
      if (cut === 0 && segmentWidth > width) {
        cut = segment.segment.length;
        used = segmentWidth;
        break;
      }
      used += segmentWidth;
      cut += segment.segment.length;
    }
    if (cut <= 0) break;
    let breakAt = -1;
    for (let index = 0; index < cut; index += 1) {
      if (/\s/u.test(remaining[index] ?? "")) breakAt = index;
    }
    if (breakAt > 0) {
      output.push(remaining.slice(0, breakAt).trimEnd());
      let next = breakAt + 1;
      while (/\s/u.test(remaining[next] ?? "")) next += 1;
      remaining = remaining.slice(next);
    } else {
      output.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut);
    }
  }
  output.push(remaining);
  return output;
}

function sanitizeViewerMarkup(value: string): string {
  return sanitizeSafeActivityText(value);
}

function sameLiveDraftSnapshot(
  left: readonly AgentDisplayDraftView[],
  right: readonly AgentDisplayDraftView[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let draftIndex = 0; draftIndex < left.length; draftIndex += 1) {
    const leftDraft = left[draftIndex];
    const rightDraft = right[draftIndex];
    if (leftDraft === undefined || rightDraft === undefined) return false;
    if (
      leftDraft.key !== rightDraft.key
      || leftDraft.state !== rightDraft.state
      || leftDraft.blocks.length !== rightDraft.blocks.length
    ) return false;
    for (let blockIndex = 0; blockIndex < leftDraft.blocks.length; blockIndex += 1) {
      const leftBlock = leftDraft.blocks[blockIndex];
      const rightBlock = rightDraft.blocks[blockIndex];
      if (leftBlock === undefined || rightBlock === undefined) return false;
      if (
        leftBlock.contentIndex !== rightBlock.contentIndex
        || leftBlock.contentType !== rightBlock.contentType
        || leftBlock.value !== rightBlock.value
      ) return false;
    }
  }
  return true;
}

function reconcileCanonicalEntries(
  current: readonly CanonicalAgentActivityEntry[],
  next: readonly CanonicalAgentActivityEntry[],
): readonly CanonicalAgentActivityEntry[] {
  const currentByIdentity = new Map(
    current.map((entry) => [canonicalEntryIdentity(entry), entry] as const),
  );
  return Object.freeze(next.map((entry) => {
    const retained = currentByIdentity.get(canonicalEntryIdentity(entry));
    return retained !== undefined && sameEntry(retained, entry) ? retained : entry;
  }));
}

/** 规范原子身份跨工具 start→end 保持稳定，并隔离代理、运行实例、调用 ID
 * 与执行代次；缺省代次 1 兼容旧事实。 */
function canonicalEntryIdentity(entry: CanonicalAgentActivityEntry): string {
  const body = entry.body;
  const kind = body.type === "tool_execution_start" || body.type === "tool_execution_end"
    ? "tool"
    : body.type;
  const toolCallId = body.type === "tool_execution_start" || body.type === "tool_execution_end"
    ? body.toolCallId
    : undefined;
  const executionGeneration = body.type === "tool_execution_start"
    || body.type === "tool_execution_end"
    ? body.executionGeneration ?? 1
    : undefined;
  return JSON.stringify([
    kind,
    entry.agent_id,
    entry.incarnation_id,
    entry.entry_id,
    toolCallId,
    executionGeneration,
  ]);
}

/** 旧 replay 可包含 start/end 两个事实，因此投影按调用 ID 与执行代次合并。 */
function toolProjectionIdentity(entry: CanonicalAgentActivityEntry): string {
  const body = entry.body;
  if (body.type !== "tool_execution_start" && body.type !== "tool_execution_end") return "";
  return JSON.stringify([
    entry.incarnation_id,
    body.toolCallId,
    body.executionGeneration ?? 1,
  ]);
}

/** 返回当前可观察 replay 中尚未被 end 收束的工具规范原子身份。 */
function runningToolSettlementKeys(
  entries: readonly CanonicalAgentActivityEntry[],
): readonly string[] {
  const tools = new Map<string, { settlementKey: string; completed: boolean }>();
  for (const entry of entries) {
    const body = entry.body;
    if (body.type !== "tool_execution_start" && body.type !== "tool_execution_end") continue;
    const identity = toolProjectionIdentity(entry);
    const existing = tools.get(identity);
    if (body.type === "tool_execution_start") {
      if (existing === undefined) {
        tools.set(identity, { settlementKey: canonicalEntryIdentity(entry), completed: false });
      }
      continue;
    }
    if (existing === undefined) {
      tools.set(identity, { settlementKey: canonicalEntryIdentity(entry), completed: true });
    } else {
      existing.completed = true;
    }
  }
  return Object.freeze([...tools.values()]
    .filter((tool) => !tool.completed)
    .map((tool) => tool.settlementKey));
}

function nearestSurvivingKey(
  previousKeys: readonly string[],
  removedKey: string,
  currentKeys: readonly string[],
): string | undefined {
  if (currentKeys.length === 0) return undefined;
  const current = new Set(currentKeys);
  const removedIndex = previousKeys.indexOf(removedKey);
  if (removedIndex >= 0) {
    for (let index = removedIndex + 1; index < previousKeys.length; index += 1) {
      const key = previousKeys[index];
      if (key !== undefined && current.has(key)) return key;
    }
    for (let index = removedIndex - 1; index >= 0; index -= 1) {
      const key = previousKeys[index];
      if (key !== undefined && current.has(key)) return key;
    }
  }
  return currentKeys[0];
}

function isValidActivitySnapshot(value: AgentActivitySnapshot): boolean {
  return Number.isSafeInteger(value.snapshotEpoch)
    && value.snapshotEpoch >= 0
    && Number.isSafeInteger(value.revision)
    && value.revision >= 0
    && Array.isArray(value.entries)
    && typeof value.olderActivityOmitted === "boolean";
}

function isSettledLifecycleState(value: AgentLifecycleState): value is SettledLifecycleState {
  return value === "idle" || value === "failed" || value === "terminated";
}

function sameEntry(left: CanonicalAgentActivityEntry, right: CanonicalAgentActivityEntry): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validViewportHeight(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : DEFAULT_VIEWER_VIEWPORT_HEIGHT;
}

function validRenderWidth(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}

function identity(text: string): string {
  return text;
}
