import type { ManagedRpcReply } from "./managed-rpc-node.ts";

export const PI_SUBAGENT_MESSAGE_TYPE = "pi-subagent-message" as const;
export const PI_SUBAGENT_FINAL_TYPE = "pi-subagent-final" as const;

export interface ParentConversationApi {
  sendMessage(message: unknown, options?: unknown): void;
}

export interface ParentReplyInboxOptions {
  readonly readApi: () => ParentConversationApi;
  readonly notifyMessage: (agentId: string) => void;
}

/**
 * 父端 reply 接纳点。只有 Pi 会话已同步接受 custom message 后才返回 true，
 * 监督通道据此发送累计 ACK；空 final 只作为 completion fence 被确认。
 */
export class ParentReplyInbox {
  private readonly readApi: () => ParentConversationApi;
  private readonly notifyMessage: (agentId: string) => void;

  constructor(options: ParentReplyInboxOptions) {
    this.readApi = options.readApi;
    this.notifyMessage = options.notifyMessage;
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
    try {
      this.readApi().sendMessage({
        customType: kind === "message" ? PI_SUBAGENT_MESSAGE_TYPE : PI_SUBAGENT_FINAL_TYPE,
        content,
        display: true,
        details: { agent_id: agentId, kind },
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
}

export function createVisibleEnvelope(
  agentId: string,
  kind: "message" | "final",
  payload: string,
): string {
  const messageType = kind === "message" ? "AGENT_MESSAGE" : "FINAL_ANSWER";
  return `Message Type: ${messageType}\nSender: ${agentId}\nPayload:\n${payload}`;
}
