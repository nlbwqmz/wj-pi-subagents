/** 桥接进程允许跨进程公开的 Pi 事件闭集。 */
export type SafeRpcBridgeEvent =
  | { readonly type: "agent_settled" }
  | {
      readonly type: "tool_execution_start" | "tool_execution_end";
      readonly toolCallId: string;
      readonly toolName: string;
    }
  | {
      readonly type: "message_end";
      readonly message: {
        readonly role: "assistant";
        readonly content: readonly (
          | { readonly type: "text"; readonly text: string }
          | { readonly type: "image"; readonly data: string; readonly mimeType: string }
        )[];
      };
    }
  | { readonly type: "extension_error" };

export type RpcBridgeEventNormalization =
  | { readonly kind: "event"; readonly event: SafeRpcBridgeEvent }
  | { readonly kind: "ignored" }
  | { readonly kind: "invalid" };

const MAX_MESSAGE_BYTES = 16 * 1024;
const MAX_IMAGE_BYTES = 24 * 1024;
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
    case "agent_settled":
      return safeEvent(Object.freeze({ type: "agent_settled" }));
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
      return normalizeMessageEnd(event);
    case "extension_error":
      return safeEvent(Object.freeze({ type: "extension_error" }));
    default:
      return IGNORED_EVENT;
  }
}

function normalizeMessageEnd(event: Record<string, unknown>): RpcBridgeEventNormalization {
  if (!isRecord(event.message)) return INVALID_EVENT;
  // Pi 会为 user、toolResult 等角色发布同名事件，它们不属于直接回复。
  if (event.message.role !== "assistant") return IGNORED_EVENT;
  if (!Array.isArray(event.message.content) || event.message.content.length > MAX_CONTENT_BLOCKS) {
    return INVALID_EVENT;
  }
  const content: Array<
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "image"; readonly data: string; readonly mimeType: string }
  > = [];
  for (const item of event.message.content) {
    if (!isRecord(item) || typeof item.type !== "string") return INVALID_EVENT;
    if (item.type === "thinking" || item.type === "toolCall") {
      // 这两类是 Pi AssistantMessage 的合法内容，但不得越过桥接安全边界。
      continue;
    }
    if (item.type === "text") {
      if (typeof item.text !== "string" || utf8Length(item.text) > MAX_MESSAGE_BYTES) {
        return INVALID_EVENT;
      }
      content.push(Object.freeze({ type: "text", text: item.text }));
      continue;
    }
    if (item.type === "image") {
      if (
        typeof item.data !== "string"
        || !validBase64(item.data)
        || decodedBase64Length(item.data) > MAX_IMAGE_BYTES
        || typeof item.mimeType !== "string"
        || !/^image\/[a-z0-9.+-]+$/.test(item.mimeType)
      ) return INVALID_EVENT;
      content.push(Object.freeze({
        type: "image",
        data: item.data,
        mimeType: item.mimeType,
      }));
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

function safeEvent(event: SafeRpcBridgeEvent): RpcBridgeEventNormalization {
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

function validBase64(value: string): boolean {
  if (value.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if (padding > 0 && value.length % 4 !== 0) return false;
  if ((value.length - padding) % 4 === 1) return false;
  try {
    const normalized = padding > 0 ? value : value + "=".repeat((4 - (value.length % 4)) % 4);
    return Buffer.from(normalized, "base64").toString("base64").replace(/=+$/, "")
      === normalized.replace(/=+$/, "");
  } catch {
    return false;
  }
}

function decodedBase64Length(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.floor(value.length * 3 / 4) - padding;
}
