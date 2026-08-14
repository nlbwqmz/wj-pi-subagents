import {
  Markdown,
  truncateToWidth,
  visibleWidth,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";
import {
  CHILD_REPLY_VERSION,
  CHILD_TERMINAL_SCHEMA,
  encodeChildReplyEnvelope,
  encodeTerminalNotice,
  parseChildReplyEnvelope,
  parseTerminalNotice,
  type ChildReplyEnvelope,
  type TerminalNotice,
} from "./child-reply-envelope.ts";
import {
  createSafeTextComponent,
  sanitizeMultiline,
  type AgentToolRenderComponent,
  type AgentToolRenderTheme,
  type SafeRenderLine,
} from "./agent-tool-rendering.ts";
import type { ManagedRpcReply } from "./managed-rpc-node.ts";
import { isCanonicalUuid } from "./tree-controller.ts";

export const WJ_PI_SUBAGENTS_MESSAGE_TYPE = "wj-pi-subagents-message" as const;
export const WJ_PI_SUBAGENTS_FINAL_TYPE = "wj-pi-subagents-final" as const;
export const WJ_PI_SUBAGENTS_TERMINAL_TYPE = "wj-pi-subagents-terminal" as const;

export interface ParentConversationApi {
  sendMessage(message: unknown, options?: unknown): void;
}

export interface ParentReplyInboxOptions {
  readonly readApi: () => ParentConversationApi;
  readonly notifyMessage: (agentId: string) => void;
  /** 只返回当前控制器确认的直接子代理名称。 */
  readonly readSenderName?: (agentId: string) => string | undefined;
}

export interface ParentReplyMessageRenderOptions {
  readonly expanded?: boolean;
  readonly outputPad?: number;
}

type ParentReplyMessageColor = Parameters<AgentToolRenderTheme["fg"]>[0]
  | "mdHeading"
  | "mdLink"
  | "mdLinkUrl"
  | "mdCode"
  | "mdCodeBlock"
  | "mdCodeBlockBorder"
  | "mdQuote"
  | "mdQuoteBorder"
  | "mdHr"
  | "mdListBullet";

export interface ParentReplyMessageTheme {
  fg(color: ParentReplyMessageColor, text: string): string;
  bg(color: "customMessageBg", text: string): string;
  bold(text: string): string;
  italic?(text: string): string;
  strikethrough?(text: string): string;
  underline?(text: string): string;
}

export type ParentReplyMessageRenderer = (
  message: unknown,
  options: ParentReplyMessageRenderOptions,
  theme: ParentReplyMessageTheme,
) => AgentToolRenderComponent;

export interface ParentReplyMessageRendererApi {
  registerMessageRenderer(customType: string, renderer: ParentReplyMessageRenderer): void;
}

export interface ParentReplyMessageRendererOptions {
  /** 生产运行时在每次 TUI 重建时重新确认直接子代理名称。 */
  readonly resolveSenderName?: (agentId: string) => string | undefined;
}

/**
 * 父端结构化回复接纳点。只有 Pi 会话已同步接受 custom message 后才返回 true，
 * 监督通道据此发送累计 ACK。
 */
export class ParentReplyInbox {
  private readApi!: () => ParentConversationApi;
  private notifyMessage!: (agentId: string) => void;
  private readSenderName: ((agentId: string) => string | undefined) | undefined;
  private turnTriggerState: "open" | "blocked" | "failed" = "open";
  private turnTriggerBlockToken = Symbol("turn-trigger-block");
  private readonly sessionCompactionBarriers = new Set<string>();
  private readonly childCompactionBarriers = new Map<string, Set<string>>();
  private readonly injectedFinalTurns = new Map<string, string>();

  constructor(options: ParentReplyInboxOptions) {
    this.rebind(options);
  }

  /** reload 交接后将已持有的 inbox 绑定到新扩展实例的 API 和控制器。 */
  rebind(options: ParentReplyInboxOptions): void {
    this.readApi = options.readApi;
    this.notifyMessage = options.notifyMessage;
    this.readSenderName = options.readSenderName;
  }

  /** Pi 即将结束当前 loop 时先阻止后代回复重入；重复调用返回同一屏障令牌。 */
  blockTurnTriggers(): symbol {
    if (this.turnTriggerState === "open") {
      this.turnTriggerState = "blocked";
      this.turnTriggerBlockToken = Symbol("turn-trigger-block");
    }
    return this.turnTriggerBlockToken;
  }

  /** 自动续跑可放行当前屏障；final 延迟回调只能放行它建立的那一轮。 */
  releaseTurnTriggers(expectedToken?: symbol): boolean {
    if (
      this.turnTriggerState !== "blocked"
      || (expectedToken !== undefined && expectedToken !== this.turnTriggerBlockToken)
    ) return false;
    this.turnTriggerState = "open";
    return true;
  }

  /** final 无法形成或确认后永久禁止自主唤醒，直到运行时被父端终止。 */
  failTurnTriggers(): void {
    this.turnTriggerState = "failed";
  }

  beginSessionCompactionBarrier(transactionId: string): boolean {
    if (!validCompactionTransactionId(transactionId)) return false;
    if (this.sessionCompactionBarriers.has(transactionId)) return true;
    this.sessionCompactionBarriers.add(transactionId);
    return true;
  }

  completeSessionCompactionBarrier(transactionId: string): boolean {
    if (!validCompactionTransactionId(transactionId)) return false;
    return this.sessionCompactionBarriers.delete(transactionId);
  }

  beginChildCompactionBarrier(agentId: string, transactionId: string): boolean {
    if (!isCanonicalUuid(agentId) || !validCompactionTransactionId(transactionId)) return false;
    const barriers = this.childCompactionBarriers.get(agentId) ?? new Set<string>();
    barriers.add(transactionId);
    this.childCompactionBarriers.set(agentId, barriers);
    return true;
  }

  completeChildCompactionBarrier(agentId: string, transactionId: string): boolean {
    if (!isCanonicalUuid(agentId) || !validCompactionTransactionId(transactionId)) return false;
    const barriers = this.childCompactionBarriers.get(agentId);
    if (barriers === undefined || !barriers.delete(transactionId)) return false;
    if (barriers.size === 0) this.childCompactionBarriers.delete(agentId);
    return true;
  }

  accept(agentId: string, reply: ManagedRpcReply): boolean {
    const envelope = parseChildReplyEnvelope(reply);
    if (envelope === undefined || envelope.agent_id !== agentId) return false;
    const content = messageContent(envelope);
    const finalTurnKey = envelope.kind === "final" ? `${agentId}:${envelope.turn_id}` : undefined;
    if (finalTurnKey !== undefined) {
      const injected = this.injectedFinalTurns.get(finalTurnKey);
      if (injected !== undefined) return injected === content[0]!.text;
    }
    const triggerTurn = true;
    if (
      this.turnTriggerState !== "open"
      || this.sessionCompactionBarriers.size > 0
      || (this.childCompactionBarriers.get(agentId)?.size ?? 0) > 0
    ) return false;
    const senderName = this.safeReadSenderName(agentId);
    try {
      this.readApi().sendMessage({
        customType: envelope.kind === "message" ? WJ_PI_SUBAGENTS_MESSAGE_TYPE : WJ_PI_SUBAGENTS_FINAL_TYPE,
        content,
        display: true,
        details: {
          agent_id: agentId,
          kind: envelope.kind,
          ...(envelope.kind === "final"
            ? { run_state: envelope.run_state, output_state: envelope.output_state }
            : {}),
          ...(senderName === undefined ? {} : { sender_name: senderName }),
        },
      }, {
        triggerTurn,
        deliverAs: "steer",
      });
    } catch {
      return false;
    }
    if (envelope.kind === "message") {
      try {
        this.notifyMessage(agentId);
      } catch {
        // 会话消息已经被接纳，等待观察者失败不能导致重复注入。
      }
    } else {
      this.injectedFinalTurns.set(finalTurnKey!, content[0]!.text);
      while (this.injectedFinalTurns.size > 128) {
        const oldest = this.injectedFinalTurns.keys().next().value;
        if (oldest === undefined) break;
        this.injectedFinalTurns.delete(oldest);
      }
    }
    return true;
  }

  /** 节点故障通知由直接父运行时生成，不伪装成 child final。 */
  acceptTerminal(agentId: string, turnId?: string): boolean {
    if (
      !isCanonicalUuid(agentId)
      || this.turnTriggerState !== "open"
      || this.sessionCompactionBarriers.size > 0
      || (this.childCompactionBarriers.get(agentId)?.size ?? 0) > 0
    ) return false;
    const notice: TerminalNotice = {
      schema: CHILD_TERMINAL_SCHEMA,
      version: CHILD_REPLY_VERSION,
      kind: "terminal",
      agent_id: agentId,
      ...(turnId === undefined ? {} : { turn_id: turnId }),
      node_state: "failed",
      reason_code: "runtime_fault",
    };
    const senderName = this.safeReadSenderName(agentId);
    try {
      this.readApi().sendMessage({
        customType: WJ_PI_SUBAGENTS_TERMINAL_TYPE,
        content: [{ type: "text", text: encodeTerminalNotice(notice) }],
        display: true,
        details: {
          agent_id: agentId,
          kind: "terminal",
          node_state: "failed",
          ...(senderName === undefined ? {} : { sender_name: senderName }),
        },
      }, {
        triggerTurn: true,
        deliverAs: "steer",
      });
    } catch {
      return false;
    }
    return true;
  }

  private safeReadSenderName(agentId: string): string | undefined {
    if (!isCanonicalUuid(agentId)) return undefined;
    try {
      const name = this.readSenderName?.(agentId);
      return typeof name === "string" && name.trim().length > 0 ? name : undefined;
    } catch {
      return undefined;
    }
  }
}

/** 注册工作中回复、最终答复和节点故障通知的 TUI 展示。 */
export function registerParentReplyMessageRenderers(
  api: ParentReplyMessageRendererApi,
  options: ParentReplyMessageRendererOptions = {},
): void {
  if (typeof api.registerMessageRenderer !== "function") {
    throw new TypeError("宿主缺少 registerMessageRenderer");
  }
  api.registerMessageRenderer(
    WJ_PI_SUBAGENTS_MESSAGE_TYPE,
    createParentReplyMessageRenderer("message", options),
  );
  api.registerMessageRenderer(
    WJ_PI_SUBAGENTS_FINAL_TYPE,
    createParentReplyMessageRenderer("final", options),
  );
  api.registerMessageRenderer(
    WJ_PI_SUBAGENTS_TERMINAL_TYPE,
    createParentReplyMessageRenderer("terminal", options),
  );
}

type VisibleKind = "message" | "final" | "terminal";
const MAX_COLLAPSED_PAYLOAD_LINES = 8;

function createParentReplyMessageRenderer(
  kind: VisibleKind,
  options: ParentReplyMessageRendererOptions,
): ParentReplyMessageRenderer {
  const customType = customTypeFor(kind);
  const messageType = kind === "message"
    ? "AGENT_MESSAGE"
    : kind === "final"
      ? "FINAL_ANSWER"
      : "TERMINAL_NOTICE";
  return (message, renderOptions, theme) => {
    const record = readRecord(message);
    const details = readRecord(readProperty(record, "details"));
    const content = readProperty(record, "content");
    const visible = parseVisibleEnvelope(readMessageText(content), kind);
    const rawDetailsAgentId = readProperty(details, "agent_id");
    const detailsAgentId = isCanonicalUuid(rawDetailsAgentId) ? rawDetailsAgentId : undefined;
    const agentId = visible?.agentId ?? detailsAgentId;
    const metadataMatches = visible !== undefined
      && readProperty(record, "customType") === customType
      && detailsAgentId === visible.agentId
      && readProperty(details, "kind") === kind;
    const senderName = metadataMatches
      ? resolveCurrentSenderName(visible.agentId, details, options)
      : undefined;
    const sender = agentId === undefined
      ? "unknown"
      : senderName === undefined
        ? agentId
        : `${senderName} · ${agentId}`;
    const headerLines: SafeRenderLine[] = [
      {
        text: `Message Type: ${messageType}`,
        color: kind === "message" ? "customMessageLabel" : "success",
        bold: true,
      },
      { text: `Sender: ${sender}`, color: "muted" },
    ];
    if (visible?.status !== undefined) {
      headerLines.push({ text: `Status: ${visible.status}`, color: "muted" });
    }
    headerLines.push(
      { text: "", color: "customMessageText" },
      {
        text: "Payload:",
        color: kind === "message" ? "customMessageLabel" : "success",
        bold: true,
      },
    );

    const payload = sanitizeMultiline(visible?.payload ?? "无法解析结构化回复。");
    const markdown = new Markdown(
      payload,
      0,
      0,
      createParentReplyMarkdownTheme(theme),
      { color: (text) => theme.fg("customMessageText", text) },
    );
    return new ParentReplyMarkdownComponent(
      createSafeTextComponent(headerLines, theme, {}),
      markdown,
      theme,
      renderOptions.expanded === true,
      renderOptions.outputPad ?? 1,
    );
  };
}

/** 将协议元数据的安全纯文本与业务 Markdown 组合为同一个消息区域。 */
class ParentReplyMarkdownComponent implements AgentToolRenderComponent {
  private readonly header: AgentToolRenderComponent;
  private readonly payload: AgentToolRenderComponent;
  private readonly theme: ParentReplyMessageTheme;
  private readonly expanded: boolean;
  private readonly requestedPadding: number;

  constructor(
    header: AgentToolRenderComponent,
    payload: AgentToolRenderComponent,
    theme: ParentReplyMessageTheme,
    expanded: boolean,
    requestedPadding: number,
  ) {
    this.header = header;
    this.payload = payload;
    this.theme = theme;
    this.expanded = expanded;
    this.requestedPadding = requestedPadding;
  }

  render(width: number): string[] {
    const availableWidth = Number.isSafeInteger(width) && width > 0 ? width : 1;
    const paddingX = safeMessagePadding(this.requestedPadding, availableWidth);
    const contentWidth = Math.max(1, availableWidth - paddingX * 2);
    const payloadLines = this.payload.render(contentWidth);
    const visiblePayloadLines = this.expanded || payloadLines.length <= MAX_COLLAPSED_PAYLOAD_LINES
      ? payloadLines
      : [
        ...payloadLines.slice(0, MAX_COLLAPSED_PAYLOAD_LINES - 1),
        this.theme.fg("customMessageText", "…（展开查看完整正文）"),
      ];
    const contentLines = [
      ...this.header.render(contentWidth),
      ...visiblePayloadLines,
    ];
    const background = (text: string): string => this.theme.bg("customMessageBg", text);
    const blank = background(" ".repeat(availableWidth));
    const leftPadding = " ".repeat(paddingX);
    return [
      blank,
      ...contentLines.map((line) => {
        const clipped = truncateToWidth(line, contentWidth, "");
        const rightPadding = " ".repeat(Math.max(
          0,
          availableWidth - paddingX - visibleWidth(clipped),
        ));
        return background(`${leftPadding}${clipped}${rightPadding}`);
      }),
      blank,
    ];
  }

  invalidate(): void {
    this.header.invalidate();
    this.payload.invalidate();
  }
}

function createParentReplyMarkdownTheme(theme: ParentReplyMessageTheme): MarkdownTheme {
  return {
    heading: (text) => theme.fg("mdHeading", text),
    link: (text) => theme.fg("mdLink", text),
    linkUrl: (text) => theme.fg("mdLinkUrl", text),
    code: (text) => theme.fg("mdCode", text),
    codeBlock: (text) => theme.fg("mdCodeBlock", text),
    codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
    quote: (text) => theme.fg("mdQuote", text),
    quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
    hr: (text) => theme.fg("mdHr", text),
    listBullet: (text) => theme.fg("mdListBullet", text),
    bold: (text) => theme.bold(text),
    italic: (text) => theme.italic?.(text) ?? text,
    strikethrough: (text) => theme.strikethrough?.(text) ?? text,
    underline: (text) => theme.underline?.(text) ?? text,
  };
}

function safeMessagePadding(value: number, width: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) return 0;
  return Math.min(value, Math.floor(Math.max(0, width - 1) / 2));
}

function messageContent(envelope: ChildReplyEnvelope): Array<{ readonly type: string; readonly text: string }> {
  return [{
    type: "text",
    text: encodeChildReplyEnvelope(envelope),
  }];
}

function customTypeFor(kind: VisibleKind): string {
  if (kind === "message") return WJ_PI_SUBAGENTS_MESSAGE_TYPE;
  if (kind === "final") return WJ_PI_SUBAGENTS_FINAL_TYPE;
  return WJ_PI_SUBAGENTS_TERMINAL_TYPE;
}

function resolveCurrentSenderName(
  agentId: string,
  details: Record<string, unknown> | undefined,
  options: ParentReplyMessageRendererOptions,
): string | undefined {
  if (options.resolveSenderName !== undefined) {
    try {
      const name = options.resolveSenderName(agentId);
      return typeof name === "string" && name.trim().length > 0 ? name : undefined;
    } catch {
      return undefined;
    }
  }
  const persisted = readProperty(details, "sender_name");
  return typeof persisted === "string" && persisted.trim().length > 0 ? persisted : undefined;
}

interface VisibleEnvelope {
  readonly agentId: string;
  readonly payload: string;
  readonly status?: string;
}

function parseVisibleEnvelope(text: string, kind: VisibleKind): VisibleEnvelope | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (kind === "terminal") {
    const notice = parseTerminalNotice(value);
    if (notice === undefined) return undefined;
    return Object.freeze({
      agentId: notice.agent_id,
      status: `${notice.node_state} / ${notice.reason_code}`,
      payload: "子代理运行时发生故障。",
    });
  }
  const envelope = parseChildReplyEnvelope(value);
  if (envelope === undefined || envelope.kind !== kind) return undefined;
  if (envelope.kind === "message") {
    return Object.freeze({
      agentId: envelope.agent_id,
      status: "working reply",
      payload: envelope.text,
    });
  }
  return Object.freeze({
    agentId: envelope.agent_id,
    status: `${envelope.run_state} / ${envelope.output_state}${
      envelope.reason_code === undefined ? "" : ` / ${envelope.reason_code}`
    }`,
    payload: envelope.text ?? "无可用业务输出。",
  });
}

function readMessageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  const texts: string[] = [];
  for (const item of value) {
    const record = readRecord(item);
    const type = readProperty(record, "type");
    const text = readProperty(record, "text");
    if (type === "text" && typeof text === "string") texts.push(text);
  }
  return texts.join("\n");
}

function validCompactionTransactionId(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readProperty(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

export function createVisibleEnvelope(envelope: ChildReplyEnvelope | TerminalNotice): string {
  return envelope.kind === "terminal"
    ? encodeTerminalNotice(envelope)
    : encodeChildReplyEnvelope(envelope);
}
