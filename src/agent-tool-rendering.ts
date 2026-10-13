import {
  hasStartupDiagnosticDetails,
  isCanonicalStartupDiagnosticDetails,
  normalizeStartupDiagnosticDetails,
  type StartupDiagnosticDetails,
} from "./startup-diagnostic.ts";
import { displayWidth, truncateToDisplayWidth } from "./agent-tree-ui.ts";
import {
  WAIT_AGENT_DEFAULT_TIMEOUT_MS,
  coerceWaitAgentTimeoutValue,
  isValidWaitAgentTimeout,
  isWaitAgentArgumentIssue,
  normalizeWaitAgentArgumentIssue,
  waitAgentArgumentIssueMessage,
  type WaitAgentArgumentIssue,
} from "./wait-agent-arguments.ts";
import {
  AGENT_FAULT_CODES,
  AGENT_LIFECYCLE_STATES,
  isCanonicalAgentUuid,
  parseAgentFault,
  parseAgentSnapshot,
  type AgentFaultCode,
  type AgentSnapshot,
} from "./agent-snapshot-codec.ts";
import {
  controlFailure,
  PUBLIC_ERROR_CODES,
  type PublicErrorCode,
  type ScopedAgentTreeSnapshot,
} from "./tree-controller.ts";
import { expandHintSegments } from "./expand-hint.ts";

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const UNSAFE_DISPLAY_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/gu;
const MAX_UNEXPECTED_ERROR_REASON_WIDTH = 240;
const MAX_COLLAPSED_BODY_LINES = 4;
const INTERNAL_ERROR_REASON = controlFailure("internal_error").error.message;
const OPERATION_ABORTED_REASON = "Operation aborted";

export interface AgentToolRenderTheme {
  fg(
    color: "toolTitle" | "success" | "error" | "warning" | "muted" | "dim"
      | "accent" | "customMessageText" | "customMessageLabel",
    text: string,
  ): string;
  bold(text: string): string;
}

export interface SafeRenderSegment {
  readonly text: string;
  readonly color: Parameters<AgentToolRenderTheme["fg"]>[0];
  readonly bold?: boolean;
}

export interface AgentToolRenderLookups {
  /** 只接受当前控制器确认的直接子代理名称；失败时必须返回 undefined。 */
  readonly resolveAgentName?: (agentId: string) => string | undefined;
  /** 读取当前控制器实际采用的默认等待期限。 */
  readonly readWaitTimeoutMs?: () => number | undefined;
}

export interface AgentToolRenderContext {
  readonly args?: unknown;
  readonly argsComplete?: boolean;
  readonly expanded?: boolean;
  readonly isError?: boolean;
  readonly lastComponent?: unknown;
  /** pi 1.2.0 渲染上下文：最终结果的单调耗时；partial 或未执行时为 undefined。 */
  readonly durationMs?: number;
}

export interface AgentToolResultView {
  readonly content: readonly {
    readonly type: string;
    readonly text?: string;
  }[];
  readonly details?: unknown;
}

export interface AgentToolResultRenderOptions {
  readonly expanded?: boolean;
  readonly isPartial?: boolean;
}

export interface AgentToolRenderComponent {
  render(width: number): string[];
  invalidate(): void;
}

export interface SafeRenderLine {
  readonly text: string;
  readonly color: Parameters<AgentToolRenderTheme["fg"]>[0];
  readonly bold?: boolean;
  /** 仅正文内容允许保留换行；标识、名称和结构化字段默认折叠为单行。 */
  readonly multiline?: boolean;
  readonly prefix?: string;
  readonly maxLines?: number;
  readonly overflowText?: string;
  readonly overflowHint?: (hiddenLines: number) => readonly SafeRenderSegment[];
  /** 追加在该行末尾的只读段（如 dim 耗时段）；随整行一起接受宽度约束。 */
  readonly suffix?: readonly SafeRenderSegment[];
}

export interface SafeTextComponentOptions {
  readonly maxLines?: number;
  readonly overflowText?: string;
  readonly outputPad?: number;
  /** 可选消息卡片的对称横向留白。 */
  readonly paddingX?: number;
  /** 可选消息卡片的上下留白。 */
  readonly paddingY?: number;
  /** 对整行（包括留白）应用主题背景。 */
  readonly background?: (text: string) => string;
}

/**
 * 供工具和 custom message 共用的纯文本组件。所有净化都发生在主题着色之前，
 * 因而不信任的正文不能注入终端控制序列，也不会绕过宿主的宽度约束。
 */
export class SafeTextComponent implements AgentToolRenderComponent {
  private lines: readonly SafeRenderLine[];
  private theme: AgentToolRenderTheme;
  private options: SafeTextComponentOptions;

  constructor(
    lines: readonly SafeRenderLine[],
    theme: AgentToolRenderTheme,
    options: SafeTextComponentOptions = {},
  ) {
    this.lines = lines;
    this.theme = theme;
    this.options = options;
  }

  update(
    lines: readonly SafeRenderLine[],
    theme: AgentToolRenderTheme,
    options: SafeTextComponentOptions = {},
  ): void {
    this.lines = lines;
    this.theme = theme;
    this.options = options;
  }

  render(width: number): string[] {
    const availableWidth = validWidth(width);
    const background = this.options.background;
    const outputPad = validPadding(this.options.outputPad, availableWidth);
    const horizontalPadding = background === undefined
      ? 0
      : validPadding(
        this.options.paddingX,
        Math.floor(Math.max(0, availableWidth - outputPad) / 2),
      );
    const contentWidth = Math.max(1, availableWidth - outputPad - horizontalPadding * 2);
    const rendered: string[] = [];

    const renderLine = (
      line: SafeRenderLine,
      text: string,
      isStyled = false,
    ): string => {
      const styledText = isStyled
        ? text
        : line.bold === true ? this.theme.bold(text) : text;
      const leftPad = " ".repeat(outputPad + horizontalPadding);
      if (background === undefined) {
        return isStyled
          ? `${leftPad}${styledText}`
          : this.theme.fg(line.color, `${leftPad}${styledText}`);
      }
      const rightPad = " ".repeat(Math.max(
        0,
        availableWidth - outputPad - horizontalPadding - displayWidth(text),
      ));
      const padded = `${leftPad}${styledText}${rightPad}`;
      return background(isStyled ? padded : this.theme.fg(line.color, padded));
    };
    const styleSegmentText = (segment: SafeRenderSegment, text: string): string =>
      this.theme.fg(
        segment.color,
        segment.bold === true ? this.theme.bold(text) : text,
      );
    /** 逐段着色并整体约束到 contentWidth；用于行尾附加段与分段折叠提示。 */
    const renderSegmentLine = (segments: readonly SafeRenderSegment[]): string => {
      let used = 0;
      const kept: SafeRenderSegment[] = [];
      for (const segment of segments) {
        if (used >= contentWidth) break;
        const width = displayWidth(segment.text);
        if (used + width <= contentWidth) {
          kept.push(segment);
          used += width;
          continue;
        }
        kept.push({ ...segment, text: truncateToDisplayWidth(segment.text, contentWidth - used) });
        used = contentWidth;
        break;
      }
      const plainWidth = kept.reduce((total, segment) => total + displayWidth(segment.text), 0);
      const styledText = kept.map((segment) => styleSegmentText(segment, segment.text)).join("");
      const leftPad = " ".repeat(outputPad + horizontalPadding);
      if (background === undefined) return `${leftPad}${styledText}`;
      const rightPad = " ".repeat(Math.max(
        0,
        availableWidth - outputPad - horizontalPadding - plainWidth,
      ));
      return background(`${leftPad}${styledText}${rightPad}`);
    };

    for (const line of this.lines) {
      const prefix = sanitizeInline(line.prefix ?? "");
      const lineColorSegment = (text: string): SafeRenderSegment => ({
        text,
        color: line.color,
        ...(line.bold === true ? { bold: true } : {}),
      });
      const lineWidth = Math.max(1, contentWidth - displayWidth(prefix));
      const safeText = line.multiline === true
        ? sanitizeMultiline(line.text)
        : sanitizeInline(line.text);
      const suffix = sanitizeRenderSegments(line.suffix);
      const suffixWidth = suffix.reduce((total, segment) => total + displayWidth(segment.text), 0);
      let wrapped = safeText
        .split("\n")
        .flatMap((part) => wrapToDisplayWidth(part, lineWidth));
      let overflowHintSegments: readonly SafeRenderSegment[] | undefined;
      if (line.maxLines !== undefined && wrapped.length > line.maxLines) {
        const keep = Math.max(0, line.maxLines - 1);
        const hidden = wrapped.length - keep;
        if (line.overflowHint !== undefined) {
          try {
            const segments: SafeRenderSegment[] = line.overflowHint(hidden).map((segment) => ({
              text: sanitizeInline(segment.text),
              color: segment.color,
              ...(segment.bold === undefined ? {} : { bold: segment.bold }),
            }));
            if (segments.length > 0) {
              overflowHintSegments = segments;
              wrapped = wrapped.slice(0, keep);
            }
          } catch {
            // A malformed optional hint must not break the safe text fallback.
          }
        }
        if (overflowHintSegments === undefined) {
          wrapped = [
            ...wrapped.slice(0, keep),
            line.overflowText ?? "…",
          ];
        }
      }
      for (let index = 0; index < wrapped.length; index += 1) {
        const part = wrapped[index]!;
        if (index === wrapped.length - 1 && suffix.length > 0 && overflowHintSegments === undefined) {
          const main = truncateToDisplayWidth(
            part,
            Math.max(0, contentWidth - displayWidth(prefix) - suffixWidth),
          );
          rendered.push(renderSegmentLine([
            ...(prefix.length === 0 ? [] : [lineColorSegment(prefix)]),
            ...(main.length === 0 ? [] : [lineColorSegment(main)]),
            ...suffix,
          ]));
          continue;
        }
        const text = truncateToDisplayWidth(`${prefix}${part}`, contentWidth);
        rendered.push(renderLine(line, text));
      }
      if (overflowHintSegments !== undefined) {
        if (suffix.length === 0) {
          const plainHint = `${prefix}${overflowHintSegments.map((segment) => segment.text).join("")}`;
          const styledHint = displayWidth(plainHint) > contentWidth
            ? styleSegmentText(
              overflowHintSegments[0]!,
              truncateToDisplayWidth(plainHint, contentWidth),
            )
            : `${prefix}${overflowHintSegments
              .map((segment) => styleSegmentText(segment, segment.text))
              .join("")}`;
          rendered.push(renderLine(line, styledHint, true));
        } else {
          rendered.push(renderSegmentLine([
            ...(prefix.length === 0 ? [] : [lineColorSegment(prefix)]),
            ...overflowHintSegments,
            ...suffix,
          ]));
        }
      }
    }

    if (this.options.maxLines !== undefined && rendered.length > this.options.maxLines) {
      const keep = Math.max(0, this.options.maxLines - 1);
      rendered.splice(
        keep,
        rendered.length - keep,
        renderLine({ text: "", color: "dim" }, truncateToDisplayWidth(
          this.options.overflowText ?? "…",
          contentWidth,
        )),
      );
    }

    if (background !== undefined) {
      const paddingY = validVerticalPadding(this.options.paddingY);
      const blank = background(" ".repeat(availableWidth));
      return [
        ...Array.from({ length: paddingY }, () => blank),
        ...rendered,
        ...Array.from({ length: paddingY }, () => blank),
      ];
    }
    return rendered;
  }

  invalidate(): void {}
}

export function createSafeTextComponent(
  lines: readonly SafeRenderLine[],
  theme: AgentToolRenderTheme,
  context: { readonly lastComponent?: unknown },
  options: SafeTextComponentOptions = {},
): AgentToolRenderComponent {
  if (context.lastComponent instanceof SafeTextComponent) {
    context.lastComponent.update(lines, theme, options);
    return context.lastComponent;
  }
  return new SafeTextComponent(lines, theme, options);
}

/**
 * 结果渲染专用组件：在最后一行尾部追加 dim 耗时段。
 * partial 结果由 renderAgentToolResult 提前返回 Processing，不经过这里。
 */
function createResultComponent(
  lines: readonly SafeRenderLine[],
  theme: AgentToolRenderTheme,
  context: AgentToolRenderContext,
): AgentToolRenderComponent {
  const durationMs = readDurationMs(context);
  return createSafeTextComponent(
    durationMs === undefined ? lines : appendDurationSuffix(lines, durationMs),
    theme,
    context,
  );
}

function appendDurationSuffix(
  lines: readonly SafeRenderLine[],
  durationMs: number,
): readonly SafeRenderLine[] {
  if (lines.length === 0) return lines;
  const suffix: SafeRenderSegment = {
    text: ` · ${formatToolDuration(durationMs)}`,
    color: "dim",
  };
  const last = lines[lines.length - 1]!;
  return [
    ...lines.slice(0, -1),
    { ...last, suffix: [...(last.suffix ?? []), suffix] },
  ];
}

function readDurationMs(context: AgentToolRenderContext): number | undefined {
  const value = readProperty(context, "durationMs");
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/**
 * 与 pi 1.2.0 formatToolDuration 相同的三个分支；小时分支按验收样例补零。
 * 秒分支保留一位小数，分钟分支不补零，小时分支的分钟与秒补足两位。
 */
function formatToolDuration(durationMs: number): string {
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m ${String(remainder).padStart(2, "0")}s`;
}

/** 按注册工具名称提供语义化调用行。 */
export function renderAgentToolCall(
  name: string,
  args: unknown,
  theme: AgentToolRenderTheme,
  context: AgentToolRenderContext,
  lookups: AgentToolRenderLookups = {},
): AgentToolRenderComponent {
  const title = (text = name): SafeRenderLine => ({ text, color: "toolTitle", bold: true });
  const input = readRecord(args);
  const expanded = context.expanded === true;

  if (name === "get_agent_templates" || name === "get_agent_tree") {
    return createSafeTextComponent([title()], theme, context);
  }
  if (name === "spawn_agent") {
    return createSafeTextComponent([
      title(),
      { text: `${readString(input, "template_id")} · ${readString(input, "name")}`, color: "dim" },
    ], theme, context);
  }
  if (name === "send_message") {
    return createMessageCallComponent(name, input, theme, context, expanded);
  }
  if (name === "wait_agent") {
    const agentIds = readStringArray(input, "agent_ids");
    const target = agentIds === undefined
      ? "…"
      : agentIds.length === 1
        ? agentIds[0]!
        : `${agentIds.length} agents`;
    const timeout = context.argsComplete === false
      ? undefined
      : formatWaitTimeout(readWaitTimeout(input, lookups));
    const callTitle = timeout === undefined
      ? `${name} · ${target}`
      : `${name} · ${target} · timeout_ms ${timeout}`;
    return createSafeTextComponent([
      title(callTitle),
    ], theme, context);
  }
  if (name === "interrupt_agent" || name === "terminate_agent" || name === "get_agent_status") {
    return createSafeTextComponent([
      title(`${name} · ${readString(input, "agent_id")}`),
    ], theme, context);
  }
  if (name === "normal_reply" || name === "final_report") {
    return createMessageCallComponent(name, input, theme, context, expanded);
  }

  return createSafeTextComponent([title()], theme, context);
}

function createMessageCallComponent(
  name: string,
  input: Record<string, unknown> | undefined,
  theme: AgentToolRenderTheme,
  context: AgentToolRenderContext,
  expanded: boolean,
): AgentToolRenderComponent {
  const agentId = name === "normal_reply" ? undefined : readOptionalString(input, "agent_id");
  const message = readOptionalString(input, "message") ?? "";
  const showFullMessage = expanded;
  const lines: SafeRenderLine[] = [{
    text: agentId === undefined ? name : `${name} · ${agentId}`,
    color: "toolTitle",
    bold: true,
  }, {
    text: message,
    color: "dim",
    multiline: true,
    ...(showFullMessage ? {} : name === "send_message" ? {
      maxLines: 7,
      overflowHint: (hiddenLines: number) => expandHintSegments(theme, "muted", hiddenLines),
    } : {
      maxLines: MAX_COLLAPSED_BODY_LINES,
      overflowText: "… (expand to view full content)",
    }),
  }];
  return createSafeTextComponent(lines, theme, context);
}

/** 按工具名称提供语义化结果行；不把原始 content 当作展示回退。 */
export function renderAgentToolResult(
  name: string,
  result: AgentToolResultView,
  options: AgentToolResultRenderOptions,
  theme: AgentToolRenderTheme,
  context: AgentToolRenderContext,
  lookups: AgentToolRenderLookups = {},
): AgentToolRenderComponent {
  if (options.isPartial === true) {
    return createSafeTextComponent([{ text: "Processing", color: "warning" }], theme, context);
  }

  const error = readStableError(name, result);
  const unexpectedErrorReason = error === undefined && context.isError === true
    ? readUnexpectedErrorReason(result)
    : undefined;
  if (
    name === "wait_agent"
    && error === undefined
    && unexpectedErrorReason === OPERATION_ABORTED_REASON
  ) {
    return createResultComponent([{
      text: OPERATION_ABORTED_REASON,
      color: "error",
    }], theme, context);
  }
  if (error !== undefined || context.isError === true) {
    const failure = error ?? {
      code: "internal_error",
      reason: unexpectedErrorReason ?? INTERNAL_ERROR_REASON,
    };
    return createResultComponent([{
      text: `${failure.code}: ${failure.reason}${formatStableErrorDetails(error?.details)}`,
      color: "error",
    }], theme, context);
  }

  if (name === "get_agent_templates") return renderTemplateResult(result, options, theme, context);
  if (name === "spawn_agent") return renderSpawnResult(result, theme, context);
  if (name === "send_message") return renderSendResult(result, theme, context, lookups);
  if (name === "wait_agent") return renderWaitResult(result, theme, context, lookups);
  if (name === "interrupt_agent") return renderInterruptResult(result, theme, context, lookups);
  if (name === "terminate_agent") return renderTerminateResult(result, theme, context, lookups);
  if (name === "get_agent_status") return renderStatusResult(result, options, theme, context);
  if (name === "get_agent_tree") return renderTreeResult(result, options, theme, context);
  if (name === "normal_reply" || name === "final_report") {
    const details = readRecord(readProperty(result, "details"));
    return readProperty(details, "accepted") === true
      ? createResultComponent([{
        text: name === "final_report" ? "Report received by parent session" : "Received by parent session",
        color: "success",
      }], theme, context)
      : invalidResult(theme, context);
  }
  return invalidResult(theme, context);
}

function invalidResult(
  theme: AgentToolRenderTheme,
  context: AgentToolRenderContext,
): AgentToolRenderComponent {
  return createResultComponent([{
    text: `internal_error: ${INTERNAL_ERROR_REASON}`,
    color: "error",
  }], theme, context);
}

function renderTemplateResult(
  result: AgentToolResultView,
  options: AgentToolResultRenderOptions,
  theme: AgentToolRenderTheme,
  context: AgentToolRenderContext,
): AgentToolRenderComponent {
  const templates = readTemplates(readProperty(result, "details"));
  if (templates === undefined) return invalidResult(theme, context);
  if (templates.length === 0) {
    return createResultComponent([{ text: "No available templates", color: "muted" }], theme, context);
  }
  if (options.expanded !== true) {
    return createResultComponent([{
      text: `Available templates: ${templates.length} · ${templates.map((item) => item.templateId).join(" · ")}`,
      color: "success",
    }], theme, context);
  }
  const lines: SafeRenderLine[] = [{ text: `Available templates: ${templates.length}`, color: "success" }];
  for (const template of templates) {
    lines.push({ text: `template_id: ${template.templateId}`, color: "muted" });
    lines.push({ text: `description: ${template.description}`, color: "dim" });
    lines.push({
      text: template.tools === undefined
        ? "tools: Pi default"
        : `tools: ${template.tools.length === 0 ? "None" : template.tools.join(", ")}`,
      color: "dim",
    });
    if (template.excludeTools !== undefined) {
      lines.push({
        text: `exclude_tools: ${template.excludeTools.length === 0 ? "None" : template.excludeTools.join(", ")}`,
        color: "dim",
      });
    }
    if (template.extensions !== undefined) {
      lines.push({
        text: `extensions: ${template.extensions.length === 0 ? "None" : template.extensions.join(", ")}`,
        color: "dim",
      });
    }
  }
  return createResultComponent(lines, theme, context);
}

function renderSpawnResult(
  result: AgentToolResultView,
  theme: AgentToolRenderTheme,
  context: AgentToolRenderContext,
): AgentToolRenderComponent {
  const details = readRecord(readProperty(result, "details"));
  const agentId = readOptionalString(details, "agent_id");
  const depth = readOptionalSafeInteger(details, "depth");
  if (agentId === undefined || depth === undefined) return invalidResult(theme, context);
  return createResultComponent([{
    text: `${agentId} · depth ${depth}`,
    color: "success",
  }], theme, context);
}

function renderSendResult(
  result: AgentToolResultView,
  theme: AgentToolRenderTheme,
  context: AgentToolRenderContext,
  lookups: AgentToolRenderLookups,
): AgentToolRenderComponent {
  const details = readRecord(readProperty(result, "details"));
  if (readProperty(details, "accepted") !== true) {
    return invalidResult(theme, context);
  }
  const agentId = readAgentId(context.args);
  const name = agentId === undefined ? undefined : resolveName(agentId, lookups);
  return createResultComponent([{
    text: name === undefined ? "Sent" : `Sent to ${name}`,
    color: "success",
  }], theme, context);
}

function renderWaitResult(
  result: AgentToolResultView,
  theme: AgentToolRenderTheme,
  context: AgentToolRenderContext,
  lookups: AgentToolRenderLookups,
): AgentToolRenderComponent {
  const details = readRecord(readProperty(result, "details"));
  const outcome = readOptionalString(details, "outcome");
  if (outcome === "timeout") {
    const agentIds = readStringArray(details, "agent_ids");
    if (agentIds === undefined || agentIds.length === 0) return invalidResult(theme, context);
    return createResultComponent([{
      text: `${agentIds.length} agents · timeout`,
      color: "warning",
    }], theme, context);
  }
  if (outcome === "woken") {
    // 父输入唤醒与 timeout 同构：目标未完成，因此使用 warning 而非 success。
    // wake_reason 是固定值（parent_input），不参与展示判定。
    const agentIds = readStringArray(details, "agent_ids");
    if (agentIds === undefined || agentIds.length === 0) return invalidResult(theme, context);
    return createResultComponent([{
      text: `${agentIds.length} agents · woken · parent_input`,
      color: "warning",
    }], theme, context);
  }
  if (outcome === "batch_released") {
    const agentIds = readStringArray(details, "agent_ids");
    const releasedByAgentId = readOptionalString(details, "released_by_agent_id");
    const releasedByOutcome = readOptionalString(details, "released_by_outcome");
    if (
      agentIds === undefined
      || agentIds.length === 0
      || releasedByAgentId === undefined
      || releasedByOutcome === undefined
      || ![
        "reply",
        "final_report",
        "idle",
        "terminal",
      ].includes(releasedByOutcome)
    ) return invalidResult(theme, context);
    const releasedBy = resolveName(releasedByAgentId, lookups) ?? releasedByAgentId;
    return createResultComponent([{
      text: `batch_released · ${releasedBy} · ${releasedByOutcome}`,
      color: "success",
    }], theme, context);
  }

  const agentId = readOptionalString(details, "agent_id");
  const state = readOptionalString(details, "state");
  const revision = readOptionalSafeInteger(details, "revision");
  if (
    agentId === undefined
    || outcome === undefined
    || ![
      "reply",
      "final_report",
      "idle",
      "terminal",
    ].includes(outcome)
    || state === undefined
    || !(AGENT_LIFECYCLE_STATES as readonly string[]).includes(state)
    || revision === undefined
  ) return invalidResult(theme, context);
  const errorCode = outcome === "terminal" ? readFaultCode(readProperty(details, "error")) : undefined;
  const warning = errorCode !== undefined
    || outcome === "idle";
  const name = resolveName(agentId, lookups) ?? agentId;
  return createResultComponent([{
    text: `${name} · ${outcome}${errorCode === undefined ? "" : ` · ${errorCode}`}`,
    color: warning ? "warning" : "success",
  }], theme, context);
}

function renderInterruptResult(
  result: AgentToolResultView,
  theme: AgentToolRenderTheme,
  context: AgentToolRenderContext,
  lookups: AgentToolRenderLookups,
): AgentToolRenderComponent {
  const details = readRecord(readProperty(result, "details"));
  const agentId = readOptionalString(details, "agent_id");
  const changed = readOptionalBoolean(details, "changed");
  const state = readOptionalString(details, "state");
  if (
    agentId === undefined
    || changed === undefined
    || state === undefined
    || !(AGENT_LIFECYCLE_STATES as readonly string[]).includes(state)
  ) return invalidResult(theme, context);
  const blockedReason = readOptionalString(details, "blocked_reason");
  if (
    blockedReason !== undefined
    && blockedReason !== "compaction_active"
  ) return invalidResult(theme, context);
  const name = resolveName(agentId, lookups) ?? agentId;
  if (blockedReason === "compaction_active") {
    return createResultComponent([{
      text: `${name} · unchanged · ${state} · Compaction active; retry after it finishes`,
      color: "warning",
    }], theme, context);
  }
  return createResultComponent([{
    text: `${name} · ${changed ? "changed" : "unchanged"} · ${state}`,
    color: "success",
  }], theme, context);
}

function renderTerminateResult(
  result: AgentToolResultView,
  theme: AgentToolRenderTheme,
  context: AgentToolRenderContext,
  lookups: AgentToolRenderLookups,
): AgentToolRenderComponent {
  const details = readRecord(readProperty(result, "details"));
  const agentId = readOptionalString(details, "agent_id");
  const changed = readOptionalBoolean(details, "changed");
  const forced = readOptionalBoolean(details, "forced");
  const count = readOptionalSafeInteger(details, "terminated_count");
  const state = readOptionalString(details, "state");
  if (
    agentId === undefined
    || changed === undefined
    || forced === undefined
    || count === undefined
    || count < 0
    || state !== "terminated"
  ) return invalidResult(theme, context);
  const name = resolveName(agentId, lookups) ?? agentId;
  if (!changed && count === 0) {
    return createResultComponent([{
      text: `${name} · Idempotent; no additional nodes reclaimed`,
      color: "muted",
    }], theme, context);
  }
  return createResultComponent([{
    text: `${name} · Reclaimed ${count} new node${count === 1 ? "" : "s"}${forced ? " · forced" : ""}`,
    color: forced ? "warning" : "success",
  }], theme, context);
}

function renderStatusResult(
  result: AgentToolResultView,
  options: AgentToolResultRenderOptions,
  theme: AgentToolRenderTheme,
  context: AgentToolRenderContext,
): AgentToolRenderComponent {
  const snapshot = parseAgentSnapshot(readProperty(result, "details"));
  if (snapshot === undefined) return invalidResult(theme, context);
  const lines = options.expanded === true
    ? expandedStatusLines(snapshot)
    : collapsedStatusLines(snapshot);
  return createResultComponent(lines, theme, context);
}

function collapsedStatusLines(snapshot: AgentSnapshot): readonly SafeRenderLine[] {
  const lines: SafeRenderLine[] = [
    { text: `template_id: ${snapshot.template_id}`, color: "muted" },
    { text: `name: ${snapshot.name}`, color: "muted" },
    { text: `state: ${snapshot.state}`, color: "dim" },
    { text: `depth: ${snapshot.depth}`, color: "dim" },
  ];
  if (snapshot.context_window_tokens !== undefined) {
    lines.push({ text: `context_window_tokens: ${snapshot.context_window_tokens}`, color: "dim" });
  }
  if (snapshot.context_usage_percent !== undefined) {
    lines.push({ text: `context_usage_percent: ${snapshot.context_usage_percent}`, color: "dim" });
  }
  if (snapshot.working_elapsed_ms !== undefined) {
    lines.push({ text: `working_elapsed_ms: ${snapshot.working_elapsed_ms}`, color: "dim" });
  }
  if (snapshot.activity !== undefined) {
    lines.push({ text: `activity.phase: ${snapshot.activity.phase}`, color: "dim" });
  }
  if (snapshot.error !== undefined) {
    lines.push({ text: `error.code: ${snapshot.error.code}`, color: "warning" });
    for (const [key, value] of Object.entries(snapshot.error.details ?? {})) {
      lines.push({ text: `error.${key}: ${value}`, color: "warning" });
    }
  }
  if (snapshot.termination_result !== undefined) {
    lines.push({ text: `termination_result: ${snapshot.termination_result}`, color: "dim" });
  }
  return lines;
}

function expandedStatusLines(snapshot: AgentSnapshot): readonly SafeRenderLine[] {
  const lines: SafeRenderLine[] = [
    { text: `template_id: ${snapshot.template_id}`, color: "muted" },
    { text: `name: ${snapshot.name}`, color: "muted" },
    { text: `agent_id: ${snapshot.agent_id}`, color: "dim" },
    { text: `parent_agent_id: ${snapshot.parent_agent_id}`, color: "dim" },
    { text: `depth: ${snapshot.depth}`, color: "dim" },
    { text: `state: ${snapshot.state}`, color: "dim" },
    { text: `revision: ${snapshot.revision}`, color: "dim" },
  ];
  if (snapshot.created_at !== undefined) lines.push({ text: `created_at: ${snapshot.created_at}`, color: "dim" });
  if (snapshot.context_window_tokens !== undefined) {
    lines.push({ text: `context_window_tokens: ${snapshot.context_window_tokens}`, color: "dim" });
  }
  if (snapshot.context_usage_percent !== undefined) {
    lines.push({ text: `context_usage_percent: ${snapshot.context_usage_percent}`, color: "dim" });
  }
  if (snapshot.working_elapsed_ms !== undefined) {
    lines.push({ text: `working_elapsed_ms: ${snapshot.working_elapsed_ms}`, color: "dim" });
  }
  if (snapshot.activity !== undefined) {
    lines.push({ text: `activity.phase: ${snapshot.activity.phase}`, color: "dim" });
  }
  if (snapshot.error !== undefined) {
    lines.push({ text: `error.code: ${snapshot.error.code}`, color: "warning" });
    lines.push({ text: `error.message: ${snapshot.error.message}`, color: "warning" });
    lines.push({ text: `error.retryable: ${snapshot.error.retryable}`, color: "warning" });
    for (const [key, value] of Object.entries(snapshot.error.details ?? {})) {
      lines.push({ text: `error.${key}: ${value}`, color: "warning" });
    }
  }
  if (snapshot.termination_result !== undefined) {
    lines.push({ text: `termination_result: ${snapshot.termination_result}`, color: "dim" });
  }
  return lines;
}

function renderTreeResult(
  result: AgentToolResultView,
  options: AgentToolResultRenderOptions,
  theme: AgentToolRenderTheme,
  context: AgentToolRenderContext,
): AgentToolRenderComponent {
  const tree = readTreeSnapshot(readProperty(result, "details"));
  if (tree === undefined) return invalidResult(theme, context);
  const summary = treeSummary(tree);
  if (options.expanded !== true) {
    return createResultComponent([{ text: summary, color: "success" }], theme, context);
  }
  const lines: SafeRenderLine[] = [
    { text: `scope: ${formatScope(tree)}`, color: "muted" },
    { text: `tree_revision: ${tree.tree_revision}`, color: "dim" },
  ];
  const activeNodes = tree.nodes.filter((node) => node.state !== "terminated");
  const children = new Map<string, AgentSnapshot[]>();
  for (const node of activeNodes) {
    if (node.parent_agent_id === null) continue;
    const list = children.get(node.parent_agent_id) ?? [];
    list.push(node);
    children.set(node.parent_agent_id, list);
  }
  const visited = new Set<string>();
  const append = (node: AgentSnapshot, level: number): void => {
    if (visited.has(node.agent_id)) return;
    visited.add(node.agent_id);
    lines.push({ text: `${"  ".repeat(level)}- ${formatTreeNode(node)}`, color: "dim" });
    for (const child of children.get(node.agent_id) ?? []) append(child, level + 1);
  };
  for (const node of activeNodes) {
    if (node.parent_agent_id === null) append(node, 0);
  }
  for (const node of activeNodes) {
    if (!visited.has(node.agent_id)) append(node, 0);
  }
  const finished = tree.nodes.filter((node) => node.state === "terminated");
  if (finished.length > 0) {
    const completed = finished.filter((node) => node.termination_result === "completed").length;
    const failed = finished.filter((node) => node.termination_result === "failed").length;
    const incomplete = finished.filter((node) => node.termination_result === "incomplete").length;
    lines.push({ text: `finished · completed ${completed} · failed ${failed} · incomplete ${incomplete}`, color: "muted" });
    for (const node of finished) {
      lines.push({
        text: `  - ${formatTreeNode(node)} · ${node.termination_result}`,
        color: "dim",
      });
    }
  }
  if (lines.length === 2) lines.push({ text: "No nodes", color: "dim" });
  return createResultComponent(lines, theme, context);
}

function readTreeSnapshot(value: unknown): ScopedAgentTreeSnapshot | undefined {
  const record = readRecord(value);
  const revision = readProperty(record, "tree_revision");
  if (!Number.isSafeInteger(revision) || (revision as number) < 0) return undefined;
  const scope = readRecord(readProperty(record, "scope"));
  const kind = readProperty(scope, "kind");
  const scopeAgentId = readProperty(scope, "agent_id");
  if (kind !== "root" && kind !== "subtree") return undefined;
  if (kind === "subtree" && !isCanonicalAgentUuid(scopeAgentId)) return undefined;
  if (kind === "root" && scopeAgentId !== undefined) return undefined;
  const rawNodes = readProperty(record, "nodes");
  if (!Array.isArray(rawNodes)) return undefined;
  const nodes: AgentSnapshot[] = [];
  for (const item of rawNodes) {
    const parsed = parseAgentSnapshot(item);
    if (parsed === undefined) return undefined;
    nodes.push(parsed);
  }
  return Object.freeze({
    tree_revision: revision as number,
    scope: Object.freeze(kind === "root"
      ? { kind: "root" as const }
      : { kind: "subtree" as const, agent_id: scopeAgentId as string }),
    nodes: Object.freeze(nodes),
  });
}

function treeSummary(tree: ScopedAgentTreeSnapshot): string {
  const active = tree.nodes.filter((node) => node.state !== "terminated").length;
  const working = tree.nodes.filter((node) => node.state === "working").length;
  const failed = tree.nodes.filter((node) => node.state === "failed" || node.termination_result === "failed").length;
  const completed = tree.nodes.filter((node) => node.termination_result === "completed").length;
  const incomplete = tree.nodes.filter((node) => node.termination_result === "incomplete").length;
  return `scope: ${formatScope(tree)} · active ${active} · working ${working} · failed ${failed} · completed ${completed}${incomplete === 0 ? "" : ` · incomplete ${incomplete}`}`;
}

function formatScope(tree: ScopedAgentTreeSnapshot): string {
  return tree.scope.kind === "root" ? "root" : `subtree · ${tree.scope.agent_id}`;
}

function formatTreeNode(node: AgentSnapshot): string {
  const context = node.context_window_tokens === undefined
    ? ""
    : ` · ${node.context_usage_percent === undefined ? "?" : `${node.context_usage_percent.toFixed(1)}%`}/${formatTokens(node.context_window_tokens)}`;
  const activity = node.activity === undefined ? "" : ` · ${node.activity.phase}`;
  const fault = node.error === undefined
    ? ""
    : ` · ${node.error.code}${formatStableErrorDetails(node.error.details)}`;
  return `${node.template_id} · ${node.name} · ${node.state}${activity} · ${node.agent_id}${context}${fault}`;
}

function formatTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function readTemplates(value: unknown): readonly {
  readonly templateId: string;
  readonly description: string;
  readonly tools?: readonly string[];
  readonly excludeTools?: readonly string[];
  readonly extensions?: readonly string[];
}[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const templates: Array<{
    readonly templateId: string;
    readonly description: string;
    readonly tools?: readonly string[];
    readonly excludeTools?: readonly string[];
    readonly extensions?: readonly string[];
  }> = [];
  for (const item of value) {
    const record = readRecord(item);
    const templateId = readOptionalString(record, "template_id");
    const description = readOptionalString(record, "description");
    const tools = readProperty(record, "tools");
    const excludeTools = readProperty(record, "exclude_tools");
    const extensions = readProperty(record, "extensions");
    if (
      templateId === undefined
      || description === undefined
      || (tools !== undefined && !isStringArray(tools))
      || (excludeTools !== undefined && !isStringArray(excludeTools))
      || (extensions !== undefined && !isStringArray(extensions))
    ) return undefined;
    templates.push({
      templateId,
      description,
      ...(tools === undefined ? {} : { tools }),
      ...(excludeTools === undefined ? {} : { excludeTools }),
      ...(extensions === undefined ? {} : { extensions }),
    });
  }
  return templates;
}

function readUnexpectedErrorReason(result: AgentToolResultView): string | undefined {
  const content = readProperty(result, "content");
  if (!Array.isArray(content)) return undefined;
  for (const item of content) {
    if (readProperty(item, "type") !== "text") continue;
    const text = readProperty(item, "text");
    if (typeof text !== "string") continue;
    const structuredMessage = extractStructuredErrorMessage(text);
    const message = structuredMessage === undefined
      ? extractErrorMessage(text)
      : structuredMessage ?? undefined;
    if (message === undefined) continue;
    return truncateToDisplayWidth(message, MAX_UNEXPECTED_ERROR_REASON_WIDTH);
  }
  return undefined;
}

function extractStructuredErrorMessage(value: string): string | null | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  const record = readRecord(parsed);
  const error = readRecord(readProperty(record, "error"));
  const message = readProperty(error, "message");
  if (typeof message !== "string") return null;
  return extractErrorMessage(message) ?? null;
}

function extractErrorMessage(value: string): string | undefined {
  const lines = sanitizeMultiline(value).split("\n");
  const first = lines[0]?.trim() ?? "";
  if (first.length === 0) {
    const firstContent = lines.findIndex((line) => line.trim().length > 0);
    if (firstContent < 0) return undefined;
    return extractErrorMessage(lines.slice(firstContent).join("\n"));
  }

  if (isTracebackHeader(first)) {
    for (let index = lines.length - 1; index > 0; index -= 1) {
      const candidate = lines[index]?.trim() ?? "";
      if (
        candidate.length === 0
        || isTracebackHeader(candidate)
        || isStackFrameLine(candidate)
      ) continue;
      return candidate;
    }
    return undefined;
  }

  const messageLines: string[] = [];
  for (const line of lines) {
    const candidate = line.trim();
    if (isTracebackHeader(candidate) || isStackFrameLine(candidate)) break;
    messageLines.push(line);
  }
  const message = messageLines.join("\n").trim();
  return message.length === 0 ? undefined : message;
}

function isTracebackHeader(value: string): boolean {
  return /^Traceback \(most recent call last\):$/iu.test(value);
}

function isStackFrameLine(value: string): boolean {
  return /^(?:at\b|File\s+["'`]|[^\s@]+@(?:file:|[a-z]:[\\/]|\/))/iu.test(value);
}

type StableErrorDetails = StartupDiagnosticDetails | WaitAgentArgumentIssue;

function readStableError(name: string, result: AgentToolResultView): {
  readonly code: string;
  readonly reason: string;
  readonly details?: StableErrorDetails;
} | undefined {
  const content = readProperty(result, "content");
  if (!Array.isArray(content)) return undefined;
  for (const item of content) {
    const type = readProperty(item, "type");
    const text = readProperty(item, "text");
    if (type !== "text" || typeof text !== "string") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const record = readRecord(parsed);
    const error = readRecord(readProperty(record, "error"));
    const code = readProperty(error, "code");
    if (typeof code === "string" && isPublicErrorCode(code)) {
      const details = readSafeErrorDetails(name, code, readProperty(error, "details"));
      return {
        code,
        reason: isWaitAgentArgumentIssue(details)
          ? waitAgentArgumentIssueMessage(details)
          : stableErrorReason(code),
        ...(details === undefined ? {} : { details }),
      };
    }
  }
  return undefined;
}

function isPublicErrorCode(value: string): value is PublicErrorCode {
  return (PUBLIC_ERROR_CODES as readonly string[]).includes(value);
}

function stableErrorReason(code: PublicErrorCode): string {
  try {
    return controlFailure(code).error.message;
  } catch {
    return INTERNAL_ERROR_REASON;
  }
}

function formatStableErrorDetails(details: StableErrorDetails | undefined): string {
  if (details === undefined || isWaitAgentArgumentIssue(details)) return "";
  const entries = Object.entries(details);
  return entries.length === 0 ? "" : ` (${entries.map(([key, value]) => `${key}: ${value}`).join(", ")})`;
}

function readSafeErrorDetails(
  name: string,
  code: PublicErrorCode,
  value: unknown,
): StableErrorDetails | undefined {
  if (name === "wait_agent" && code === "invalid_argument") {
    return normalizeWaitAgentArgumentIssue(value);
  }
  if (!isCanonicalStartupDiagnosticDetails(code, value)) return undefined;
  const details = normalizeStartupDiagnosticDetails(code, value);
  return hasStartupDiagnosticDetails(details) ? details : undefined;
}

function readFaultCode(value: unknown): AgentFaultCode | undefined {
  if (value === undefined) return undefined;
  const parsed = parseAgentFault(value);
  if (parsed !== undefined) return parsed.code;
  const record = readRecord(value);
  const code = readProperty(record, "code");
  return typeof code === "string" && (AGENT_FAULT_CODES as readonly string[]).includes(code)
    ? code as AgentFaultCode
    : undefined;
}

type WaitTimeoutPresentation =
  | { readonly kind: "explicit"; readonly value: number }
  | { readonly kind: "explicit_default"; readonly value: number }
  | { readonly kind: "default"; readonly value: number }
  | { readonly kind: "invalid"; readonly display: string };

function readWaitTimeout(
  input: Record<string, unknown> | undefined,
  lookups: AgentToolRenderLookups,
): WaitTimeoutPresentation {
  const hasExplicit = hasOwnProperty(input, "timeout_ms");
  const raw = readProperty(input, "timeout_ms");
  if (hasExplicit && raw === null) {
    return Object.freeze({ kind: "explicit_default", value: readConfiguredWaitTimeout(lookups) });
  }
  if (raw !== undefined) {
    const explicit = coerceWaitAgentTimeoutValue(raw);
    if (isValidWaitAgentTimeout(explicit)) {
      return Object.freeze({ kind: "explicit", value: explicit });
    }
    return Object.freeze({ kind: "invalid", display: displayWaitTimeoutValue(raw) });
  }
  return Object.freeze({
    kind: "default",
    value: readConfiguredWaitTimeout(lookups),
  });
}

function readConfiguredWaitTimeout(lookups: AgentToolRenderLookups): number {
  let configured: unknown;
  try {
    configured = lookups.readWaitTimeoutMs?.();
  } catch {
    configured = undefined;
  }
  return isValidWaitAgentTimeout(configured)
    ? configured
    : WAIT_AGENT_DEFAULT_TIMEOUT_MS;
}

function formatWaitTimeout(timeout: WaitTimeoutPresentation): string {
  if (timeout.kind === "default") return `default ${timeout.value}`;
  if (timeout.kind === "explicit_default") return `null -> default ${timeout.value}`;
  return timeout.kind === "explicit" ? String(timeout.value) : timeout.display;
}

function hasOwnProperty(
  record: Record<string, unknown> | undefined,
  key: string,
): boolean {
  try {
    return record !== undefined && Object.hasOwn(record, key);
  } catch {
    return false;
  }
}

function displayWaitTimeoutValue(value: unknown): string {
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "<array>";
  return typeof value === "object" && value !== null ? "<object>" : `<${typeof value}>`;
}

function resolveName(agentId: string, lookups: AgentToolRenderLookups): string | undefined {
  try {
    const name = lookups.resolveAgentName?.(agentId);
    return typeof name === "string" && name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

function readAgentId(value: unknown): string | undefined {
  return readOptionalString(readRecord(value), "agent_id");
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  try {
    return value as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function readProperty(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function readOptionalString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  try {
    const value = record?.[key];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function readStringArray(record: Record<string, unknown> | undefined, key: string): readonly string[] | undefined {
  try {
    const value = record?.[key];
    return Array.isArray(value) && value.every((item) => typeof item === "string")
      ? value as string[]
      : undefined;
  } catch {
    return undefined;
  }
}

function readString(record: Record<string, unknown> | undefined, key: string): string {
  return readOptionalString(record, key) ?? "…";
}

function readOptionalSafeInteger(record: Record<string, unknown> | undefined, key: string): number | undefined {
  try {
    const value = record?.[key];
    return Number.isSafeInteger(value) ? value as number : undefined;
  } catch {
    return undefined;
  }
}

function readOptionalBoolean(record: Record<string, unknown> | undefined, key: string): boolean | undefined {
  try {
    const value = record?.[key];
    return typeof value === "boolean" ? value : undefined;
  } catch {
    return undefined;
  }
}

export function sanitizeMultiline(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .replace(UNSAFE_DISPLAY_PATTERN, " ");
}

function sanitizeInline(value: string): string {
  return sanitizeMultiline(value).replace(/\n/g, " ");
}

function sanitizeRenderSegments(
  segments: readonly SafeRenderSegment[] | undefined,
): readonly SafeRenderSegment[] {
  if (!Array.isArray(segments) || segments.length === 0) return [];
  return segments.map((segment) => ({
    text: sanitizeInline(segment.text),
    color: segment.color,
    ...(segment.bold === undefined ? {} : { bold: segment.bold }),
  }));
}

function validWidth(width: number): number {
  return Number.isSafeInteger(width) && width > 0 ? width : 1;
}

function validPadding(value: number | undefined, width: number): number {
  if (!Number.isSafeInteger(value) || value === undefined || value <= 0) return 0;
  return Math.min(value, Math.max(0, width - 1));
}

function validVerticalPadding(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || value === undefined || value <= 0) return 0;
  return Math.min(value, 16);
}

function wrapToDisplayWidth(value: string, width: number): string[] {
  if (value.length === 0) return [""];
  const lines: string[] = [];
  let line = "";
  let lineWidth = 0;
  for (const { segment } of SEGMENTER.segment(value)) {
    const segmentWidth = displayWidth(segment);
    if (segmentWidth > width) {
      if (line.length > 0) lines.push(line);
      lines.push(truncateToDisplayWidth(segment, width));
      line = "";
      lineWidth = 0;
      continue;
    }
    if (line.length > 0 && lineWidth + segmentWidth > width) {
      lines.push(line);
      line = segment;
      lineWidth = segmentWidth;
      continue;
    }
    line += segment;
    lineWidth += segmentWidth;
  }
  if (line.length > 0) lines.push(line);
  return lines.length > 0 ? lines : [""];
}
