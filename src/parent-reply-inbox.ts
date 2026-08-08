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

export type ParentReplyMessageRenderer = (
  message: unknown,
  options: ParentReplyMessageRenderOptions,
  theme: AgentToolRenderTheme,
) => AgentToolRenderComponent;

export interface ParentReplyMessageRendererApi {
  registerMessageRenderer(customType: string, renderer: ParentReplyMessageRenderer): void;
}

export interface ParentReplyMessageRendererOptions {
  /** 生产运行时在每次 TUI 重建时重新确认直接子代理名称。 */
  readonly resolveSenderName?: (agentId: string) => string | undefined;
}

/**
 * 父端 reply 接纳点。只有 Pi 会话已同步接受 custom message 后才返回 true，
 * 监督通道据此发送累计 ACK；空 final 只作为 completion fence 被确认。
 */
export class ParentReplyInbox {
  private readonly readApi: () => ParentConversationApi;
  private readonly notifyMessage: (agentId: string) => void;
  private readonly readSenderName: ((agentId: string) => string | undefined) | undefined;

  constructor(options: ParentReplyInboxOptions) {
    this.readApi = options.readApi;
    this.notifyMessage = options.notifyMessage;
    this.readSenderName = options.readSenderName;
  }

  accept(agentId: string, reply: ManagedRpcReply): boolean {
    const kind = reply.kind ?? "final";
    const images = reply.images ?? [];
    const hasText = reply.text.trim().length > 0;
    if (kind === "message" && !hasText && images.length === 0) return false;
    if (kind === "final" && !hasText && images.length === 0) return true;

    const content: Array<Record<string, string>> = [{
      type: "text",
      text: createVisibleEnvelope(agentId, kind, reply.text),
    }];
    for (const image of images) {
      content.push({ type: "image", data: image.data, mimeType: image.mimeType });
    }
    const senderName = this.safeReadSenderName(agentId);
    try {
      this.readApi().sendMessage({
        customType: kind === "message" ? PI_SUBAGENT_MESSAGE_TYPE : PI_SUBAGENT_FINAL_TYPE,
        content,
        display: true,
        details: {
          agent_id: agentId,
          kind,
          ...(senderName === undefined ? {} : { sender_name: senderName }),
        },
      }, {
        triggerTurn: kind === "final",
        deliverAs: "steer",
      });
    } catch {
      return false;
    }
    if (kind === "message") {
      try {
        this.notifyMessage(agentId);
      } catch {
        // 会话消息已经被接纳，通知观察者失败不能导致重复注入。
      }
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

/** 注册工作中回复和最终答复的同构 TUI 展示。 */
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
}

function createParentReplyMessageRenderer(
  kind: "message" | "final",
  options: ParentReplyMessageRendererOptions,
): ParentReplyMessageRenderer {
  const customType = kind === "message" ? PI_SUBAGENT_MESSAGE_TYPE : PI_SUBAGENT_FINAL_TYPE;
  const messageType = kind === "message" ? "AGENT_MESSAGE" : "FINAL_ANSWER";
  return (message, renderOptions, theme) => {
    const record = readRecord(message);
    const details = readRecord(readProperty(record, "details"));
    const content = readProperty(record, "content");
    const text = readMessageText(content);
    const envelope = parseVisibleEnvelope(text, kind);
    const rawDetailsAgentId = readProperty(details, "agent_id");
    const detailsAgentId = isCanonicalUuid(rawDetailsAgentId) ? rawDetailsAgentId : undefined;
    const agentId = envelope?.agentId ?? detailsAgentId;
    const metadataMatches = envelope !== undefined
      && readProperty(record, "customType") === customType
      && detailsAgentId === envelope.agentId
      && readProperty(details, "kind") === kind;
    const senderName = metadataMatches
      ? resolveCurrentSenderName(envelope.agentId, details, options)
      : undefined;
    const payload = envelope?.payload ?? text;
    const sender = agentId === undefined
      ? "unknown"
      : senderName === undefined
        ? agentId
        : `${senderName} · ${agentId}`;
    const lines: SafeRenderLine[] = [
      { text: `Message Type: ${messageType}`, color: "muted", bold: true },
      { text: `Sender: ${sender}`, color: "dim" },
      { text: "Payload:", color: "muted", bold: true },
      {
        text: payload,
        color: "dim",
        multiline: true,
        ...(renderOptions.expanded === true ? {} : {
          maxLines: 8,
          overflowText: "…（展开查看完整正文）",
        }),
      },
    ];
    const imageSummary = formatSafeImageSummary(content);
    if (imageSummary !== undefined) lines.push({ text: imageSummary, color: "muted" });
    return createSafeTextComponent(lines, theme, {}, {
      ...(renderOptions.outputPad === undefined ? {} : { outputPad: renderOptions.outputPad }),
    });
  };
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
}

function parseVisibleEnvelope(
  text: string,
  kind: "message" | "final",
): VisibleEnvelope | undefined {
  const messageType = kind === "message" ? "AGENT_MESSAGE" : "FINAL_ANSWER";
  const prefix = `Message Type: ${messageType}\nSender: `;
  if (!text.startsWith(prefix)) return undefined;
  const payloadMarker = "\nPayload:\n";
  const markerIndex = text.indexOf(payloadMarker, prefix.length);
  if (markerIndex < 0) return undefined;
  const agentId = text.slice(prefix.length, markerIndex);
  if (!isCanonicalUuid(agentId)) return undefined;
  return Object.freeze({
    agentId,
    payload: text.slice(markerIndex + payloadMarker.length),
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

export function createVisibleEnvelope(
  agentId: string,
  kind: "message" | "final",
  payload: string,
): string {
  const messageType = kind === "message" ? "AGENT_MESSAGE" : "FINAL_ANSWER";
  return `Message Type: ${messageType}\nSender: ${agentId}\nPayload:\n${payload}`;
}
