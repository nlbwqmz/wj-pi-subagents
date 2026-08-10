import { isCanonicalUuid, isCanonicalUuidV4 } from "./tree-controller.ts";

export const CHILD_REPLY_SCHEMA = "pi-subagent.reply" as const;
export const CHILD_TERMINAL_SCHEMA = "pi-subagent.terminal" as const;
export const CHILD_REPLY_VERSION = 1 as const;

export const CHILD_REPLY_MAX_IMAGE_MIME_TYPE_LENGTH = 128;

export const CHILD_REPLY_ENVELOPE_LIMITS = Object.freeze({
  maxStringBytes: 16 * 1024,
  maxImagesPerReply: 8,
  maxImageBytes: 24 * 1024,
});

export interface ChildReplyImage {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

interface ChildReplyCommon {
  readonly schema: typeof CHILD_REPLY_SCHEMA;
  readonly version: typeof CHILD_REPLY_VERSION;
  readonly agent_id: string;
  readonly turn_id: string;
}

export interface ChildMessageEnvelope extends ChildReplyCommon {
  readonly kind: "message";
  readonly requires_response: boolean;
  readonly text: string;
  readonly images?: readonly ChildReplyImage[];
}

export type ChildRunState = "settled" | "failed" | "interrupted";
export type ChildOutputState = "present" | "absent";
export type ChildFinalReasonCode = "no_output" | "provider_error" | "runtime_fault";

export interface ChildFinalEnvelope extends ChildReplyCommon {
  readonly kind: "final";
  readonly run_state: ChildRunState;
  readonly output_state: ChildOutputState;
  readonly reason_code?: ChildFinalReasonCode;
  readonly text?: string;
  readonly images?: readonly ChildReplyImage[];
}

export type ChildReplyEnvelope = ChildMessageEnvelope | ChildFinalEnvelope;

export interface TerminalNotice {
  readonly schema: typeof CHILD_TERMINAL_SCHEMA;
  readonly version: typeof CHILD_REPLY_VERSION;
  readonly kind: "terminal";
  readonly agent_id: string;
  readonly turn_id?: string;
  readonly node_state: "failed";
  readonly reason_code: "runtime_fault";
}

export interface ChildReplyEnvelopeLimits {
  readonly maxStringBytes: number;
  readonly maxImagesPerReply: number;
  readonly maxImageBytes: number;
}

/**
 * 校验并收窄 child reply。协议允许未来字段，因此返回值只保留当前版本定义的字段。
 */
export function parseChildReplyEnvelope(
  value: unknown,
  limits: ChildReplyEnvelopeLimits = CHILD_REPLY_ENVELOPE_LIMITS,
): ChildReplyEnvelope | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.schema !== CHILD_REPLY_SCHEMA
    || value.version !== CHILD_REPLY_VERSION
    || !isCanonicalUuid(value.agent_id)
    || !isCanonicalUuidV4(value.turn_id)
  ) return undefined;

  if (value.kind === "message") return parseMessageEnvelope(value, limits);
  if (value.kind === "final") return parseFinalEnvelope(value, limits);
  return undefined;
}

/** 校验父端生成的节点终止通知；它不属于 child reply 序号域。 */
export function parseTerminalNotice(value: unknown): TerminalNotice | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.schema !== CHILD_TERMINAL_SCHEMA
    || value.version !== CHILD_REPLY_VERSION
    || value.kind !== "terminal"
    || !isCanonicalUuid(value.agent_id)
    || (value.turn_id !== undefined && !isCanonicalUuidV4(value.turn_id))
    || value.node_state !== "failed"
    || value.reason_code !== "runtime_fault"
  ) return undefined;
  return Object.freeze({
    schema: CHILD_TERMINAL_SCHEMA,
    version: CHILD_REPLY_VERSION,
    kind: "terminal",
    agent_id: value.agent_id,
    ...(value.turn_id === undefined ? {} : { turn_id: value.turn_id }),
    node_state: "failed",
    reason_code: "runtime_fault",
  });
}

export function isValidChildReplyImages(
  value: unknown,
  limits: ChildReplyEnvelopeLimits = CHILD_REPLY_ENVELOPE_LIMITS,
): value is readonly ChildReplyImage[] {
  return value !== undefined && parseImages(value, limits).ok;
}

/** 使用普通 JSON 序列化；字段顺序不属于协议语义。 */
export function encodeChildReplyEnvelope(value: ChildReplyEnvelope): string {
  const parsed = parseChildReplyEnvelope(value);
  if (parsed === undefined) throw new TypeError("invalid_child_reply_envelope");
  return JSON.stringify(parsed);
}

/** 使用普通 JSON 序列化父端终止通知。 */
export function encodeTerminalNotice(value: TerminalNotice): string {
  const parsed = parseTerminalNotice(value);
  if (parsed === undefined) throw new TypeError("invalid_terminal_notice");
  return JSON.stringify(parsed);
}

function parseMessageEnvelope(
  value: Record<string, unknown>,
  limits: ChildReplyEnvelopeLimits,
): ChildMessageEnvelope | undefined {
  if (
    typeof value.requires_response !== "boolean"
    || !validNonBlankText(value.text, limits.maxStringBytes)
    || value.run_state !== undefined
    || value.output_state !== undefined
    || value.reason_code !== undefined
  ) return undefined;
  const images = parseImages(value.images, limits);
  if (!images.ok) return undefined;
  return Object.freeze({
    schema: CHILD_REPLY_SCHEMA,
    version: CHILD_REPLY_VERSION,
    kind: "message",
    agent_id: value.agent_id as string,
    turn_id: value.turn_id as string,
    requires_response: value.requires_response,
    text: value.text,
    ...(images.value === undefined ? {} : { images: images.value }),
  });
}

function parseFinalEnvelope(
  value: Record<string, unknown>,
  limits: ChildReplyEnvelopeLimits,
): ChildFinalEnvelope | undefined {
  if (
    !isRunState(value.run_state)
    || !isOutputState(value.output_state)
    || value.requires_response !== undefined
  ) return undefined;
  if (value.text !== undefined && !validNonBlankText(value.text, limits.maxStringBytes)) {
    return undefined;
  }
  const images = parseImages(value.images, limits);
  if (!images.ok) return undefined;
  const hasOutput = value.text !== undefined || images.value !== undefined;
  if ((value.output_state === "present") !== hasOutput) return undefined;
  if (!validFinalState(value.run_state, value.output_state, value.reason_code)) return undefined;

  return Object.freeze({
    schema: CHILD_REPLY_SCHEMA,
    version: CHILD_REPLY_VERSION,
    kind: "final",
    agent_id: value.agent_id as string,
    turn_id: value.turn_id as string,
    run_state: value.run_state,
    output_state: value.output_state,
    ...(value.reason_code === undefined ? {} : { reason_code: value.reason_code }),
    ...(value.text === undefined ? {} : { text: value.text }),
    ...(images.value === undefined ? {} : { images: images.value }),
  });
}

function validFinalState(
  runState: ChildRunState,
  outputState: ChildOutputState,
  reasonCode: unknown,
): reasonCode is ChildFinalReasonCode | undefined {
  if (runState === "settled") {
    return outputState === "present" ? reasonCode === undefined : reasonCode === "no_output";
  }
  if (runState === "failed") {
    return reasonCode === "provider_error" || reasonCode === "runtime_fault";
  }
  return reasonCode === undefined;
}

function parseImages(
  value: unknown,
  limits: ChildReplyEnvelopeLimits,
): { readonly ok: true; readonly value?: readonly ChildReplyImage[] } | { readonly ok: false } {
  if (value === undefined) return Object.freeze({ ok: true });
  if (!Array.isArray(value) || value.length === 0 || value.length > limits.maxImagesPerReply) {
    return Object.freeze({ ok: false });
  }
  const images: ChildReplyImage[] = [];
  for (const item of value) {
    if (!isRecord(item)) return Object.freeze({ ok: false });
    if (
      item.type !== "image"
      || typeof item.data !== "string"
      || !validBase64(item.data)
      || decodedBase64Length(item.data) > limits.maxImageBytes
      || typeof item.mimeType !== "string"
      || item.mimeType.length > CHILD_REPLY_MAX_IMAGE_MIME_TYPE_LENGTH
      || !/^image\/[a-z0-9.+-]+$/.test(item.mimeType)
      || Object.keys(item).some((key) => key !== "type" && key !== "data" && key !== "mimeType")
    ) return Object.freeze({ ok: false });
    images.push(Object.freeze({
      type: "image",
      data: item.data,
      mimeType: item.mimeType,
    }));
  }
  return Object.freeze({ ok: true, value: Object.freeze(images) });
}

function isRunState(value: unknown): value is ChildRunState {
  return value === "settled" || value === "failed" || value === "interrupted";
}

function isOutputState(value: unknown): value is ChildOutputState {
  return value === "present" || value === "absent";
}

function validNonBlankText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && utf8Length(value) <= maxBytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
