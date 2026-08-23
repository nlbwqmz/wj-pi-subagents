import { isCanonicalAgentUuid } from "./agent-snapshot-codec.ts";

/** clean-break 后的会话消息协议；旧 v5 任务/提交信封不再解析。 */
export const CHILD_REPLY_SCHEMA = "wj-pi-subagents/conversation" as const;
export const CHILD_TERMINAL_SCHEMA = "wj-pi-subagents/terminal" as const;
export const CHILD_REPLY_VERSION = 1 as const;

export interface ChildMessageEnvelope {
  readonly schema: typeof CHILD_REPLY_SCHEMA;
  readonly version: typeof CHILD_REPLY_VERSION;
  readonly kind: "message";
  readonly agent_id: string;
  readonly text: string;
}

export interface ChildFinalReportEnvelope {
  readonly schema: typeof CHILD_REPLY_SCHEMA;
  readonly version: typeof CHILD_REPLY_VERSION;
  readonly kind: "final_report";
  readonly agent_id: string;
  readonly text: string;
}

export type ChildReplyEnvelope = ChildMessageEnvelope | ChildFinalReportEnvelope;

export interface TerminalNotice {
  readonly schema: typeof CHILD_TERMINAL_SCHEMA;
  readonly version: typeof CHILD_REPLY_VERSION;
  readonly kind: "terminal";
  readonly agent_id: string;
  readonly state?: "failed" | "terminated";
  readonly error_code?: string;
}

export interface ChildReplyEnvelopeLimits {
  readonly maxTextBytes?: number;
}

export const CHILD_REPLY_ENVELOPE_LIMITS: Required<ChildReplyEnvelopeLimits> = Object.freeze({
  maxTextBytes: 32 * 1024,
});

export function parseChildReplyEnvelope(
  value: unknown,
  limits: ChildReplyEnvelopeLimits = CHILD_REPLY_ENVELOPE_LIMITS,
): ChildReplyEnvelope | undefined {
  const record = plainRecord(value);
  if (record === undefined) return undefined;
  const common = record.schema === CHILD_REPLY_SCHEMA
    && record.version === CHILD_REPLY_VERSION
    && isCanonicalAgentUuid(record.agent_id)
    && validText(record.text, limits.maxTextBytes ?? CHILD_REPLY_ENVELOPE_LIMITS.maxTextBytes);
  if (!common) return undefined;
  if (record.kind === "message") {
    if (Object.keys(record).some((key) => !["schema", "version", "kind", "agent_id", "text"].includes(key))) return undefined;
    return Object.freeze({
      schema: CHILD_REPLY_SCHEMA,
      version: CHILD_REPLY_VERSION,
      kind: "message",
      agent_id: record.agent_id as string,
      text: record.text as string,
    }) as unknown as ChildMessageEnvelope;
  }
  if (record.kind === "final_report") {
    if (Object.keys(record).some((key) => !["schema", "version", "kind", "agent_id", "text"].includes(key))) return undefined;
    return Object.freeze({
      schema: CHILD_REPLY_SCHEMA,
      version: CHILD_REPLY_VERSION,
      kind: "final_report",
      agent_id: record.agent_id as string,
      text: record.text as string,
    }) as unknown as ChildFinalReportEnvelope;
  }
  return undefined;
}

export function parseTerminalNotice(value: unknown): TerminalNotice | undefined {
  const record = plainRecord(value);
  if (
    record === undefined
    || record.schema !== CHILD_TERMINAL_SCHEMA
    || record.version !== CHILD_REPLY_VERSION
    || record.kind !== "terminal"
    || !isCanonicalAgentUuid(record.agent_id)
    || (record.state !== undefined && record.state !== "failed" && record.state !== "terminated")
    || (record.error_code !== undefined && typeof record.error_code !== "string")
    || Object.keys(record).some((key) => !["schema", "version", "kind", "agent_id", "state", "error_code"].includes(key))
  ) return undefined;
  return Object.freeze({
    schema: CHILD_TERMINAL_SCHEMA,
    version: CHILD_REPLY_VERSION,
    kind: "terminal",
    agent_id: record.agent_id as string,
    state: (record.state ?? "failed") as "failed" | "terminated",
    ...(record.error_code === undefined ? {} : { error_code: record.error_code as string }),
  });
}

export function encodeChildReplyEnvelope(value: ChildReplyEnvelope): string {
  const parsed = parseChildReplyEnvelope(value);
  if (parsed === undefined) throw new TypeError("protocol_mismatch");
  return JSON.stringify(parsed);
}

export function encodeTerminalNotice(value: TerminalNotice): string {
  const parsed = parseTerminalNotice(value);
  if (parsed === undefined) throw new TypeError("protocol_mismatch");
  return JSON.stringify(parsed);
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  return value as Record<string, unknown>;
}

function validText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && new TextEncoder().encode(value).byteLength <= maxBytes;
}
