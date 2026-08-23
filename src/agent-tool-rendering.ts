import { displayWidth, truncateToDisplayWidth } from "./agent-tree-ui.ts";
import {
  WAIT_AGENT_DEFAULT_TIMEOUT_MS,
  WAIT_AGENT_MAX_TIMEOUT_MS,
  WAIT_AGENT_MIN_TIMEOUT_MS,
} from "./agent-controller.ts";
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

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const UNSAFE_DISPLAY_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/gu;
const MAX_COLLAPSED_BODY_LINES = 4;
const INTERNAL_ERROR_REASON = controlFailure("internal_error").error.message;

export interface AgentToolRenderTheme {
  fg(
    color: "toolTitle" | "success" | "error" | "warning" | "muted" | "dim"
      | "accent" | "customMessageText" | "customMessageLabel",
    text: string,
  ): string;
  bold(text: string): string;
}

export interface AgentToolRenderLookups {
  /** 只接受当前控制器确认的直接子代理名称；失败时必须返回 undefined。 */
  readonly resolveAgentName?: (agentId: string) => string | undefined;
  /** 读取当前控制器实际采用的默认等待期限。 */
  readonly readWaitTimeoutMs?: () => number | undefined;
}

export interface AgentToolRenderContext {
  readonly args?: unknown;
  readonly expanded?: boolean;
  readonly isError?: boolean;
  readonly lastComponent?: unknown;
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

    const renderLine = (line: SafeRenderLine, text: string): string => {
      const styled = line.bold === true ? this.theme.bold(text) : text;
      const leftPad = " ".repeat(outputPad + horizontalPadding);
      if (background === undefined) {
        return this.theme.fg(line.color, `${leftPad}${styled}`);
      }
      const rightPad = " ".repeat(Math.max(
        0,
        availableWidth - outputPad - horizontalPadding - displayWidth(text),
      ));
      return background(this.theme.fg(line.color, `${leftPad}${styled}${rightPad}`));
    };

    for (const line of this.lines) {
      const prefix = sanitizeInline(line.prefix ?? "");
      const lineWidth = Math.max(1, contentWidth - displayWidth(prefix));
      const safeText = line.multiline === true
        ? sanitizeMultiline(line.text)
        : sanitizeInline(line.text);
      let wrapped = safeText
        .split("\n")
        .flatMap((part) => wrapToDisplayWidth(part, lineWidth));
      if (line.maxLines !== undefined && wrapped.length > line.maxLines) {
        const keep = Math.max(0, line.maxLines - 1);
        wrapped = [
          ...wrapped.slice(0, keep),
          line.overflowText ?? "…",
        ];
      }
      for (const part of wrapped) {
        const text = truncateToDisplayWidth(`${prefix}${part}`, contentWidth);
        rendered.push(renderLine(line, text));
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
    const timeout = readWaitTimeout(input, lookups);
    return createSafeTextComponent([
      title(`${name} · ${target} · timeout_ms ${timeout}`),
    ], theme, context);
  }
  if (name === "interrupt_agent" || name === "terminate_agent" || name === "get_agent_status") {
    return createSafeTextComponent([
      title(`${name} · ${readString(input, "agent_id")}`),
    ], theme, context);
  }
  if (name === "reply_to_parent" || name === "final_report") {
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
  const agentId = name === "reply_to_parent" ? undefined : readOptionalString(input, "agent_id");
  const message = readOptionalString(input, "message") ?? "";
  const lines: SafeRenderLine[] = [{
    text: agentId === undefined ? name : `${name} · ${agentId}`,
    color: "toolTitle",
    bold: true,
  }, {
    text: message,
    color: "dim",
    multiline: true,
    ...(expanded ? {} : {
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

  const error = readStableError(result);
  if (error !== undefined || context.isError === true) {
    const failure = error ?? { code: "internal_error", reason: INTERNAL_ERROR_REASON };
    return createSafeTextComponent([{
      text: `${failure.code}: ${failure.reason}`,
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
  if (name === "reply_to_parent" || name === "final_report") {
    const details = readRecord(readProperty(result, "details"));
    return readProperty(details, "accepted") === true
      ? createSafeTextComponent([{
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
  return createSafeTextComponent([{
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
    return createSafeTextComponent([{ text: "No available templates", color: "muted" }], theme, context);
  }
  if (options.expanded !== true) {
    return createSafeTextComponent([{
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
    if (template.extensions !== undefined) {
      lines.push({
        text: `extensions: ${template.extensions.length === 0 ? "None" : template.extensions.join(", ")}`,
        color: "dim",
      });
    }
  }
  return createSafeTextComponent(lines, theme, context);
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
  return createSafeTextComponent([{
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
  return createSafeTextComponent([{
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
    return createSafeTextComponent([{
      text: `${agentIds.length} agents · timeout`,
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
    return createSafeTextComponent([{
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
  return createSafeTextComponent([{
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
    return createSafeTextComponent([{
      text: `${name} · unchanged · ${state} · Compaction active; retry after it finishes`,
      color: "warning",
    }], theme, context);
  }
  return createSafeTextComponent([{
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
    return createSafeTextComponent([{
      text: `${name} · Idempotent; no additional nodes reclaimed`,
      color: "muted",
    }], theme, context);
  }
  return createSafeTextComponent([{
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
  return createSafeTextComponent(lines, theme, context);
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
  if (snapshot.error !== undefined) lines.push({ text: `error.code: ${snapshot.error.code}`, color: "warning" });
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
    return createSafeTextComponent([{ text: summary, color: "success" }], theme, context);
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
  return createSafeTextComponent(lines, theme, context);
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
  return `${node.template_id} · ${node.name} · ${node.state}${activity} · ${node.agent_id}${context}`;
}

function formatTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function readTemplates(value: unknown): readonly {
  readonly templateId: string;
  readonly description: string;
  readonly tools?: readonly string[];
  readonly extensions?: readonly string[];
}[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const templates: Array<{
    readonly templateId: string;
    readonly description: string;
    readonly tools?: readonly string[];
    readonly extensions?: readonly string[];
  }> = [];
  for (const item of value) {
    const record = readRecord(item);
    const templateId = readOptionalString(record, "template_id");
    const description = readOptionalString(record, "description");
    const tools = readProperty(record, "tools");
    const extensions = readProperty(record, "extensions");
    if (
      templateId === undefined
      || description === undefined
      || (tools !== undefined && (!Array.isArray(tools) || !tools.every((tool) => typeof tool === "string")))
      || (extensions !== undefined
        && (!Array.isArray(extensions) || !extensions.every((extension) => typeof extension === "string")))
    ) return undefined;
    templates.push({
      templateId,
      description,
      ...(tools === undefined ? {} : { tools: tools as readonly string[] }),
      ...(extensions === undefined ? {} : { extensions: extensions as readonly string[] }),
    });
  }
  return templates;
}

function readStableError(result: AgentToolResultView): { readonly code: string; readonly reason: string } | undefined {
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
      return { code, reason: stableErrorReason(code) };
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

function readWaitTimeout(
  input: Record<string, unknown> | undefined,
  lookups: AgentToolRenderLookups,
): number {
  const explicit = readOptionalSafeInteger(input, "timeout_ms");
  if (explicit !== undefined && explicit >= WAIT_AGENT_MIN_TIMEOUT_MS && explicit <= WAIT_AGENT_MAX_TIMEOUT_MS) {
    return explicit;
  }
  let configured: unknown;
  try {
    configured = lookups.readWaitTimeoutMs?.();
  } catch {
    configured = undefined;
  }
  return Number.isSafeInteger(configured)
    && (configured as number) >= WAIT_AGENT_MIN_TIMEOUT_MS
    && (configured as number) <= WAIT_AGENT_MAX_TIMEOUT_MS
    ? configured as number
    : WAIT_AGENT_DEFAULT_TIMEOUT_MS;
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
