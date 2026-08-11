/** 桥接进程允许跨进程公开的 Pi 事件闭集。 */
export type SafeRpcBridgeEvent =
  | { readonly type: "agent_start" | "agent_settled" | "compaction_start" }
  | { readonly type: "queue_update"; readonly pendingMessageCount: number }
  | {
      readonly type: "compaction_end";
      readonly reason: "manual" | "threshold" | "overflow";
      readonly aborted: boolean;
      readonly willRetry: boolean;
      readonly failed: boolean;
    }
  | {
      readonly type: "tool_execution_start" | "tool_execution_end";
      readonly toolCallId: string;
      readonly toolName: string;
    }
  | { readonly type: "extension_error" };

export interface SafeAssistantMessageEndEvent {
  readonly type: "message_end";
  readonly message: {
    readonly role: "assistant";
    readonly content: readonly { readonly type: "text"; readonly text: string }[];
  };
}

export type RpcBridgeEventNormalization =
  | { readonly kind: "event"; readonly event: SafeRpcBridgeEvent | SafeAssistantMessageEndEvent }
  | { readonly kind: "ignored" }
  | { readonly kind: "invalid" };

const MAX_MESSAGE_BYTES = 16 * 1024;
const MAX_CONTENT_BLOCKS = 64;
const MAX_TOOL_ID_BYTES = 256;

const IGNORED_EVENT: RpcBridgeEventNormalization = Object.freeze({ kind: "ignored" });
const INVALID_EVENT: RpcBridgeEventNormalization = Object.freeze({ kind: "invalid" });

/**
 * 把 Pi 公共 RpcClient 事件缩减为安全事件。未知顶层事件属于无关观察，直接忽略；
 * 已知事件若结构违约则返回 invalid，由桥接进程关闭传输。
 */
export function normalizeRpcBridgeEvent(event: unknown): RpcBridgeEventNormalization {
  if (!isRecord(event) || typeof event.type !== "string") return INVALID_EVENT;
  switch (event.type) {
    case "agent_start":
    case "agent_settled":
    case "compaction_start":
      return safeEvent(Object.freeze({ type: event.type }));
    case "compaction_end":
      if (
        (event.reason !== "manual" && event.reason !== "threshold" && event.reason !== "overflow")
        || typeof event.aborted !== "boolean"
        || typeof event.willRetry !== "boolean"
        || (event.errorMessage !== undefined && typeof event.errorMessage !== "string")
      ) return INVALID_EVENT;
      return safeEvent(Object.freeze({
        type: "compaction_end",
        reason: event.reason,
        aborted: event.aborted,
        willRetry: event.willRetry,
        failed: event.aborted || event.errorMessage !== undefined,
      }));
    case "queue_update":
      if (!Array.isArray(event.steering) || !Array.isArray(event.followUp)) return INVALID_EVENT;
      return safeEvent(Object.freeze({
        type: "queue_update",
        pendingMessageCount: event.steering.length + event.followUp.length,
      }));
    case "tool_execution_start":
    case "tool_execution_end":
      if (
        !validBoundedText(event.toolCallId, MAX_TOOL_ID_BYTES)
        || !validBoundedText(event.toolName, MAX_TOOL_ID_BYTES)
      ) return INVALID_EVENT;
      return safeEvent(Object.freeze({
        type: event.type,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      }));
    case "message_end":
      // 最终回复由真正 child 扩展经独立监督通道上行，任务 RPC 不再复制正文。
      return IGNORED_EVENT;
    case "extension_error":
      return safeEvent(Object.freeze({ type: "extension_error" }));
    default:
      return IGNORED_EVENT;
  }
}

/** child 扩展把最终 assistant 消息收窄为可进入监督 reply 的安全内容。 */
export function normalizeAssistantMessageEnd(event: unknown): RpcBridgeEventNormalization {
  if (!isRecord(event) || event.type !== "message_end") return INVALID_EVENT;
  if (!isRecord(event.message)) return INVALID_EVENT;
  // Pi 会为 user、toolResult 等角色发布同名事件，它们不属于直接回复。
  if (event.message.role !== "assistant") return IGNORED_EVENT;
  if (!Array.isArray(event.message.content) || event.message.content.length > MAX_CONTENT_BLOCKS) {
    return INVALID_EVENT;
  }
  const content: Array<{ readonly type: "text"; readonly text: string }> = [];
  for (const item of event.message.content) {
    if (!isRecord(item) || typeof item.type !== "string") return INVALID_EVENT;
    if (item.type === "thinking" || item.type === "toolCall" || item.type === "image") {
      // 非文本块不得越过最终回复的安全边界。
      continue;
    }
    if (item.type === "text") {
      if (typeof item.text !== "string" || utf8Length(item.text) > MAX_MESSAGE_BYTES) {
        return INVALID_EVENT;
      }
      content.push(Object.freeze({ type: "text", text: item.text }));
      continue;
    }
    return INVALID_EVENT;
  }
  return safeEvent(Object.freeze({
    type: "message_end",
    message: Object.freeze({
      role: "assistant",
      content: Object.freeze(content),
    }),
  }));
}

function safeEvent(
  event: SafeRpcBridgeEvent | SafeAssistantMessageEndEvent,
): RpcBridgeEventNormalization {
  return Object.freeze({ kind: "event", event });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validBoundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && utf8Length(value) <= maxBytes;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
