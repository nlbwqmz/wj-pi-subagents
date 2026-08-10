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
  formatSafeImageSummary,
  type AgentToolRenderComponent,
  type AgentToolRenderTheme,
  type SafeRenderLine,
} from "./agent-tool-rendering.ts";
import type { ManagedRpcReply } from "./managed-rpc-node.ts";
import { isCanonicalUuid } from "./tree-controller.ts";

export const PI_SUBAGENT_MESSAGE_TYPE = "pi-subagent-message" as const;
export const PI_SUBAGENT_FINAL_TYPE = "pi-subagent-final" as const;
export const PI_SUBAGENT_TERMINAL_TYPE = "pi-subagent-terminal" as const;

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

export interface ParentReplyMessageTheme extends AgentToolRenderTheme {
  bg(color: "customMessageBg", text: string): string;
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

  accept(agentId: string, reply: ManagedRpcReply): boolean {
    const envelope = parseChildReplyEnvelope(reply);
    if (envelope === undefined || envelope.agent_id !== agentId) return false;
    const triggerTurn = envelope.kind === "final" || envelope.requires_response;
    if (triggerTurn && this.turnTriggerState !== "open") return false;
    const content = messageContent(envelope);
    const senderName = this.safeReadSenderName(agentId);
    try {
      this.readApi().sendMessage({
        customType: envelope.kind === "message" ? PI_SUBAGENT_MESSAGE_TYPE : PI_SUBAGENT_FINAL_TYPE,
        content,
        display: true,
        details: {
          agent_id: agentId,
          kind: envelope.kind,
          ...(envelope.kind === "final"
            ? { run_state: envelope.run_state, output_state: envelope.output_state }
            : { requires_response: envelope.requires_response }),
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
    }
    return true;
  }

  /** 节点故障通知由直接父运行时生成，不伪装成 child final。 */
  acceptTerminal(agentId: string, turnId?: string): boolean {
    if (!isCanonicalUuid(agentId) || this.turnTriggerState !== "open") return false;
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
        customType: PI_SUBAGENT_TERMINAL_TYPE,
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
    PI_SUBAGENT_MESSAGE_TYPE,
    createParentReplyMessageRenderer("message", options),
  );
  api.registerMessageRenderer(
    PI_SUBAGENT_FINAL_TYPE,
    createParentReplyMessageRenderer("final", options),
  );
  api.registerMessageRenderer(
    PI_SUBAGENT_TERMINAL_TYPE,
    createParentReplyMessageRenderer("terminal", options),
  );
}

type VisibleKind = "message" | "final" | "terminal";

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
    const lines: SafeRenderLine[] = [
      {
        text: `Message Type: ${messageType}`,
        color: kind === "message" ? "customMessageLabel" : "success",
        bold: true,
      },
      { text: `Sender: ${sender}`, color: "muted" },
    ];
    if (visible?.status !== undefined) {
      lines.push({ text: `Status: ${visible.status}`, color: "muted" });
    }
    lines.push(
      { text: "", color: "customMessageText" },
      {
        text: "Payload:",
        color: kind === "message" ? "customMessageLabel" : "success",
        bold: true,
      },
      {
        text: visible?.payload ?? "无法解析结构化回复。",
        color: "customMessageText",
        multiline: true,
        ...(renderOptions.expanded === true ? {} : {
          maxLines: 8,
          overflowText: "…（展开查看完整正文）",
        }),
      },
    );
    const imageSummary = formatSafeImageSummary(content);
    if (imageSummary !== undefined) lines.push({ text: imageSummary, color: "muted" });
    return createSafeTextComponent(lines, theme, {}, {
      paddingX: renderOptions.outputPad ?? 1,
      paddingY: 1,
      background: (text) => theme.bg("customMessageBg", text),
    });
  };
}

function messageContent(envelope: ChildReplyEnvelope): Array<Record<string, string>> {
  const content: Array<Record<string, string>> = [{
    type: "text",
    text: encodeChildReplyEnvelope(envelope),
  }];
  for (const image of envelope.images ?? []) {
    content.push({ type: "image", data: image.data, mimeType: image.mimeType });
  }
  return content;
}

function customTypeFor(kind: VisibleKind): string {
  if (kind === "message") return PI_SUBAGENT_MESSAGE_TYPE;
  if (kind === "final") return PI_SUBAGENT_FINAL_TYPE;
  return PI_SUBAGENT_TERMINAL_TYPE;
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
      status: envelope.requires_response ? "response required" : "informational",
      payload: envelope.text,
    });
  }
  return Object.freeze({
    agentId: envelope.agent_id,
    status: `${envelope.run_state} / ${envelope.output_state}${
      envelope.reason_code === undefined ? "" : ` / ${envelope.reason_code}`
    }`,
    payload: envelope.text ?? (envelope.output_state === "absent" ? "无可用业务输出。" : "仅包含图片输出。"),
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
