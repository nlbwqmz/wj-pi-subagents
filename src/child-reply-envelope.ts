import { isCanonicalUuid, isCanonicalUuidV4 } from "./tree-controller.ts";

export const CHILD_REPLY_SCHEMA = "pi-subagent.reply" as const;
export const CHILD_TERMINAL_SCHEMA = "pi-subagent.terminal" as const;
/** v7 监督协议沿用第四版 reply 信封；旧监督主版本不可热接管。 */
export const CHILD_REPLY_VERSION = 4 as const;

export const CHILD_REPLY_ENVELOPE_LIMITS = Object.freeze({
  maxStringBytes: 16 * 1024,
});

interface ChildReplyCommon {
  readonly schema: typeof CHILD_REPLY_SCHEMA;
  readonly version: typeof CHILD_REPLY_VERSION;
  readonly agent_id: string;
  /** 跨 turn、压缩和恢复保持稳定的逻辑任务身份。 */
  readonly task_id: string;
  /** 单次 Pi agent loop 身份。 */
  readonly turn_id: string;
}

export interface ChildMessageEnvelope extends ChildReplyCommon {
  readonly kind: "message";
  readonly text: string;
}

export type ChildRunState = "settled" | "failed" | "interrupted";
export type ChildOutputState = "present" | "absent";
export type ChildFinalReasonCode = "no_output" | "provider_error" | "runtime_fault";

export interface ChildFinalEnvelope extends ChildReplyCommon {
  readonly kind: "final";
  /** 同一 final 重传保持不变；父端按它执行 prepared -> accepted 单调提交。 */
  readonly commit_id: string;
  readonly run_state: ChildRunState;
  readonly output_state: ChildOutputState;
  readonly reason_code?: ChildFinalReasonCode;
  readonly text?: string;
}

export type ChildReplyEnvelope = ChildMessageEnvelope | ChildFinalEnvelope;

export interface TerminalNotice {
  readonly schema: typeof CHILD_TERMINAL_SCHEMA;
  readonly version: typeof CHILD_REPLY_VERSION;
  readonly kind: "terminal";
  readonly agent_id: string;
  readonly task_id?: string;
  readonly turn_id?: string;
  readonly node_state: "failed";
  readonly reason_code: "runtime_fault";
}

export interface ChildReplyEnvelopeLimits {
  readonly maxStringBytes: number;
}

/** 校验并按字段闭集重建 v7 child reply。 */
export function parseChildReplyEnvelope(
  value: unknown,
  limits: ChildReplyEnvelopeLimits = CHILD_REPLY_ENVELOPE_LIMITS,
): ChildReplyEnvelope | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.schema !== CHILD_REPLY_SCHEMA
    || value.version !== CHILD_REPLY_VERSION
    || !isCanonicalUuid(value.agent_id)
    || !isCanonicalUuidV4(value.task_id)
    || !isCanonicalUuidV4(value.turn_id)
  ) return undefined;

  if (value.kind === "message") return parseMessageEnvelope(value, limits);
  if (value.kind === "final") return parseFinalEnvelope(value, limits);
  return undefined;
}

/** 节点终止通知不属于 reply_seq/final commit 顺序域。 */
export function parseTerminalNotice(value: unknown): TerminalNotice | undefined {
  if (!isRecord(value)) return undefined;
  const allowed = new Set([
    "schema",
    "version",
    "kind",
    "agent_id",
    "task_id",
    "turn_id",
    "node_state",
    "reason_code",
  ]);
  if (
    Object.keys(value).some((key) => !allowed.has(key))
    || value.schema !== CHILD_TERMINAL_SCHEMA
    || value.version !== CHILD_REPLY_VERSION
    || value.kind !== "terminal"
    || !isCanonicalUuid(value.agent_id)
    || (value.task_id !== undefined && !isCanonicalUuidV4(value.task_id))
    || (value.turn_id !== undefined && !isCanonicalUuidV4(value.turn_id))
    || value.node_state !== "failed"
    || value.reason_code !== "runtime_fault"
  ) return undefined;
  return Object.freeze({
    schema: CHILD_TERMINAL_SCHEMA,
    version: CHILD_REPLY_VERSION,
    kind: "terminal",
    agent_id: value.agent_id,
    ...(value.task_id === undefined ? {} : { task_id: value.task_id }),
    ...(value.turn_id === undefined ? {} : { turn_id: value.turn_id }),
    node_state: "failed",
    reason_code: "runtime_fault",
  });
}

export function encodeChildReplyEnvelope(value: ChildReplyEnvelope): string {
  const parsed = parseChildReplyEnvelope(value);
  if (parsed === undefined) throw new TypeError("invalid_child_reply_envelope");
  return JSON.stringify(parsed);
}

export function encodeTerminalNotice(value: TerminalNotice): string {
  const parsed = parseTerminalNotice(value);
  if (parsed === undefined) throw new TypeError("invalid_terminal_notice");
  return JSON.stringify(parsed);
}

function parseMessageEnvelope(
  value: Record<string, unknown>,
  limits: ChildReplyEnvelopeLimits,
): ChildMessageEnvelope | undefined {
  const allowed = new Set([
    "schema",
    "version",
    "kind",
    "agent_id",
    "task_id",
    "turn_id",
    "text",
  ]);
  if (
    Object.keys(value).some((key) => !allowed.has(key))
    || !validNonBlankText(value.text, limits.maxStringBytes)
  ) return undefined;
  return Object.freeze({
    schema: CHILD_REPLY_SCHEMA,
    version: CHILD_REPLY_VERSION,
    kind: "message",
    agent_id: value.agent_id as string,
    task_id: value.task_id as string,
    turn_id: value.turn_id as string,
    text: value.text,
  });
}

function parseFinalEnvelope(
  value: Record<string, unknown>,
  limits: ChildReplyEnvelopeLimits,
): ChildFinalEnvelope | undefined {
  const allowed = new Set([
    "schema",
    "version",
    "kind",
    "agent_id",
    "task_id",
    "turn_id",
    "commit_id",
    "run_state",
    "output_state",
    "reason_code",
    "text",
  ]);
  if (
    Object.keys(value).some((key) => !allowed.has(key))
    || !isCanonicalUuidV4(value.commit_id)
    || !isRunState(value.run_state)
    || !isOutputState(value.output_state)
  ) return undefined;
  if (value.text !== undefined && !validNonBlankText(value.text, limits.maxStringBytes)) {
    return undefined;
  }
  const hasOutput = value.text !== undefined;
  if ((value.output_state === "present") !== hasOutput) return undefined;
  if (!validFinalState(value.run_state, value.output_state, value.reason_code)) return undefined;

  return Object.freeze({
    schema: CHILD_REPLY_SCHEMA,
    version: CHILD_REPLY_VERSION,
    kind: "final",
    agent_id: value.agent_id as string,
    task_id: value.task_id as string,
    turn_id: value.turn_id as string,
    commit_id: value.commit_id,
    run_state: value.run_state,
    output_state: value.output_state,
    ...(value.reason_code === undefined ? {} : { reason_code: value.reason_code }),
    ...(value.text === undefined ? {} : { text: value.text }),
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
