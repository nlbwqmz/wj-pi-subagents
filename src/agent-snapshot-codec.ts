import {
  LIFECYCLE_STATES,
  type LifecycleState,
} from "./conversation-lifecycle.ts";

/** 子代理公开生命周期只描述真实运行事实。 */
export const AGENT_LIFECYCLE_STATES = LIFECYCLE_STATES;
/** 公开生命周期状态闭集。 */
export type AgentLifecycleState = LifecycleState;

/** working 期间可安全展示的当前活动阶段。 */
export const AGENT_ACTIVITY_PHASES = Object.freeze([
  "processing",
  "executing_tools",
  "compacting",
] as const);
export type AgentActivityPhase = (typeof AGENT_ACTIVITY_PHASES)[number];

export interface AgentActivitySummary {
  readonly phase: AgentActivityPhase;
}

/** 旧快照缺少 activity 时使用的兼容阶段。 */
export const DEFAULT_AGENT_ACTIVITY: AgentActivitySummary = Object.freeze({ phase: "processing" });

export const AGENT_FAULT_CODES = Object.freeze([
  "spawn_failed",
  "spawn_timeout",
  "capability_mismatch",
  "message_delivery_failed",
  "termination_incomplete",
  "protocol_mismatch",
  "internal_error",
] as const);
export type AgentFaultCode = (typeof AGENT_FAULT_CODES)[number];

export interface AgentFault {
  readonly code: AgentFaultCode;
  readonly message: string;
  readonly retryable: boolean;
}

export const AGENT_TERMINATION_RESULTS = Object.freeze(["completed", "failed", "incomplete"] as const);
export type AgentTerminationResult = (typeof AGENT_TERMINATION_RESULTS)[number];

/**
 * 公开树快照保留生命周期和受限的活动阶段；任务、邮箱、ACK、消息身份以及工具
 * 名称、参数和结果都不进入该投影。
 */
export interface AgentSnapshot {
  readonly agent_id: string;
  readonly parent_agent_id: string | null;
  readonly template_id: string;
  readonly name: string;
  readonly depth: number;
  readonly state: AgentLifecycleState;
  readonly revision: number;
  readonly created_at?: string;
  readonly working_elapsed_ms?: number;
  readonly context_window_tokens?: number;
  readonly context_usage_percent?: number;
  readonly activity?: AgentActivitySummary;
  readonly error?: AgentFault;
  readonly termination_result?: AgentTerminationResult;
}

export const AGENT_FAULT_METADATA: Readonly<Record<AgentFaultCode, Readonly<{
  readonly message: string;
  readonly retryable: boolean;
}>>> = Object.freeze({
  spawn_failed: Object.freeze({ message: "Subagent startup failed", retryable: false }),
  spawn_timeout: Object.freeze({ message: "Subagent startup timed out", retryable: true }),
  capability_mismatch: Object.freeze({ message: "Subagent capability mismatch", retryable: false }),
  message_delivery_failed: Object.freeze({ message: "Message delivery failed", retryable: false }),
  termination_incomplete: Object.freeze({ message: "Subagent resources not fully reclaimed", retryable: true }),
  protocol_mismatch: Object.freeze({ message: "Subagent protocol mismatch", retryable: false }),
  internal_error: Object.freeze({ message: "Internal controller error", retryable: false }),
});

export interface AgentSnapshotCodecOptions {
  readonly maxDepth?: number;
  readonly maxStringBytes?: number;
}

const SNAPSHOT_KEYS = new Set([
  "agent_id", "parent_agent_id", "template_id", "name", "depth", "state", "revision",
  "created_at", "working_elapsed_ms", "context_window_tokens", "context_usage_percent",
  "activity", "error", "termination_result",
]);
const ACTIVITY_KEYS = new Set(["phase"]);
const FAULT_KEYS = new Set(["code", "message", "retryable"]);
const UTF8_ENCODER = new TextEncoder();
const RFC3339_MILLIS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isCanonicalAgentUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function isRfc3339Millis(value: unknown): value is string {
  return typeof value === "string" && RFC3339_MILLIS_PATTERN.test(value);
}

export function parseAgentSnapshot(
  value: unknown,
  options: AgentSnapshotCodecOptions = {},
): AgentSnapshot | undefined {
  try {
    const record = plainDataRecord(value, SNAPSHOT_KEYS);
    if (record === undefined) return undefined;
    if (
      !isCanonicalAgentUuid(record.agent_id)
      || (record.parent_agent_id !== null && !isCanonicalAgentUuid(record.parent_agent_id))
      || !boundedString(record.template_id, options.maxStringBytes)
      || !boundedString(record.name, options.maxStringBytes)
      || !positiveSafeInteger(record.depth)
      || (options.maxDepth !== undefined && (record.depth as number) > options.maxDepth)
      || !(AGENT_LIFECYCLE_STATES as readonly unknown[]).includes(record.state)
      || !positiveSafeInteger(record.revision)
      || (record.created_at !== undefined && !isRfc3339Millis(record.created_at))
      || (record.working_elapsed_ms !== undefined && !nonNegativeSafeInteger(record.working_elapsed_ms))
      || (record.context_window_tokens !== undefined && !positiveSafeInteger(record.context_window_tokens))
      || (record.context_usage_percent !== undefined && !validContextUsagePercent(record.context_usage_percent))
    ) return undefined;
    const state = record.state as AgentLifecycleState;
    // 兼容旧版本快照：工作态缺少 activity 时按安全的默认阶段归一化。
    const activity = record.activity === undefined
      ? isWorkingTimeState(state) ? DEFAULT_AGENT_ACTIVITY : undefined
      : parseAgentActivitySummary(record.activity);
    if (record.activity !== undefined && activity === undefined) return undefined;
    const fault = record.error === undefined ? undefined : parseAgentFault(record.error, options.maxStringBytes);
    if (record.error !== undefined && fault === undefined) return undefined;
    const termination = record.termination_result;
    if (termination !== undefined && !(AGENT_TERMINATION_RESULTS as readonly unknown[]).includes(termination)) return undefined;
    if (state === "failed" && fault === undefined) return undefined;
    if (state !== "failed" && fault !== undefined) return undefined;
    if (state === "terminated" && termination === undefined) return undefined;
    if (state !== "terminated" && termination !== undefined) return undefined;
    if (activity !== undefined && state !== "working" && state !== "interrupting") return undefined;
    if (state === "starting" && (record.created_at !== undefined || record.working_elapsed_ms !== undefined)) return undefined;
    if (record.context_usage_percent !== undefined && record.context_window_tokens === undefined) return undefined;
    return Object.freeze({
      agent_id: record.agent_id,
      parent_agent_id: record.parent_agent_id as string | null,
      template_id: record.template_id,
      name: record.name,
      depth: record.depth as number,
      state,
      revision: record.revision as number,
      ...(record.created_at === undefined ? {} : { created_at: record.created_at as string }),
      ...(record.working_elapsed_ms === undefined ? {} : { working_elapsed_ms: record.working_elapsed_ms as number }),
      ...(record.context_window_tokens === undefined ? {} : { context_window_tokens: record.context_window_tokens as number }),
      ...(record.context_usage_percent === undefined ? {} : { context_usage_percent: record.context_usage_percent as number }),
      ...(activity === undefined ? {} : { activity }),
      ...(fault === undefined ? {} : { error: fault }),
      ...(termination === undefined ? {} : { termination_result: termination as AgentTerminationResult }),
    });
  } catch {
    return undefined;
  }
}

export function parseAgentActivitySummary(value: unknown): AgentActivitySummary | undefined {
  const record = plainDataRecord(value, ACTIVITY_KEYS);
  if (
    record === undefined
    || !(AGENT_ACTIVITY_PHASES as readonly unknown[]).includes(record.phase)
    || Object.keys(record).some((key) => key !== "phase")
  ) return undefined;
  return Object.freeze({ phase: record.phase as AgentActivityPhase });
}

export function parseAgentFault(value: unknown, maxStringBytes?: number): AgentFault | undefined {
  const record = plainDataRecord(value, FAULT_KEYS);
  if (
    record === undefined
    || !(AGENT_FAULT_CODES as readonly unknown[]).includes(record.code)
    || !boundedString(record.message, maxStringBytes)
    || typeof record.retryable !== "boolean"
  ) return undefined;
  const code = record.code as AgentFaultCode;
  const metadata = AGENT_FAULT_METADATA[code];
  if (record.message !== metadata.message || record.retryable !== metadata.retryable) return undefined;
  return Object.freeze({ code, message: metadata.message, retryable: metadata.retryable });
}

export interface AgentContextUsageInput {
  readonly context_window_tokens: number;
  readonly context_usage_percent?: number;
}

function plainDataRecord(value: unknown, allowedKeys: ReadonlySet<string>): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) return undefined;
  }
  return record;
}

function isWorkingTimeState(state: AgentLifecycleState): boolean {
  return state === "working" || state === "interrupting";
}

function boundedString(value: unknown, maxBytes: number | undefined): value is string {
  return typeof value === "string" && (maxBytes === undefined || UTF8_ENCODER.encode(value).byteLength <= maxBytes);
}

function positiveSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonNegativeSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validContextUsagePercent(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000;
}
