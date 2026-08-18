/** 子代理对外可观察的生命周期状态。idle 严格表示节点已经静止。 */
export const AGENT_LIFECYCLE_STATES = Object.freeze([
  "starting",
  "idle",
  "working",
  "interrupting",
  "suspended",
  "failed",
  "terminating",
  "terminated",
] as const);

export type AgentLifecycleState = (typeof AGENT_LIFECYCLE_STATES)[number];

/** 活动阶段与顶层生命周期正交，描述当前任务正在等待什么事实。 */
export const AGENT_ACTIVITY_PHASES = Object.freeze([
  "processing",
  "executing_tools",
  "settling",
  "compacting",
  "reconciling",
  "finalizing",
  "waiting_parent_ack",
  "maintenance_failed",
  "delivery_uncertain",
] as const);

export type AgentActivityPhase = (typeof AGENT_ACTIVITY_PHASES)[number];

/** 工具活动只允许固定安全类别，不承载工具名、参数或结果。 */
export const AGENT_ACTIVITY_CATEGORIES = Object.freeze([
  "editing",
  "reading",
  "running",
  "researching",
  "delegating",
  "other",
] as const);

export type AgentActivityCategory = (typeof AGENT_ACTIVITY_CATEGORIES)[number];

export interface AgentActivitySummary {
  readonly phase: AgentActivityPhase;
  readonly task_id?: string;
  readonly category?: AgentActivityCategory;
  readonly active_count?: number;
}

export const AGENT_TASK_OUTCOMES = Object.freeze([
  "completed",
  "failed",
  "interrupted",
] as const);

export type AgentTaskOutcome = (typeof AGENT_TASK_OUTCOMES)[number];

export interface AgentLastTask {
  readonly task_id: string;
  readonly turn_id: string;
  readonly commit_id: string;
  readonly outcome: AgentTaskOutcome;
  readonly output_state: "present" | "absent";
}

/** 节点状态中可以保留的安全故障码，不保存底层异常文字。 */
export const AGENT_FAULT_CODES = Object.freeze([
  "spawn_failed",
  "spawn_timeout",
  "capability_mismatch",
  "message_delivery_failed",
  "termination_incomplete",
  "internal_error",
] as const);

export type AgentFaultCode = (typeof AGENT_FAULT_CODES)[number];

export interface AgentFault {
  readonly code: AgentFaultCode;
  readonly message: string;
  readonly retryable: boolean;
}

/** `finished` 中只保存稳定、脱敏的终止历史分类。 */
export const AGENT_TERMINATION_RESULTS = Object.freeze([
  "completed",
  "failed",
  "incomplete",
] as const);

export type AgentTerminationResult = (typeof AGENT_TERMINATION_RESULTS)[number];

export interface AgentSnapshot {
  readonly agent_id: string;
  readonly parent_agent_id: string | null;
  readonly template_id: string;
  readonly name: string;
  readonly depth: number;
  readonly state: AgentLifecycleState;
  readonly mailbox_pending_count: number;
  readonly host_pending_count: number;
  readonly reply_outbox_pending_count: number;
  readonly revision: number;
  /** 成功创建的线性化点；starting 节点没有该时间。 */
  readonly created_at?: string;
  /** 由单调时钟派生，活动节点持续累加，终态节点固定。 */
  readonly lifecycle_elapsed_ms?: number;
  /** 由单调时钟派生，仅在工作或中断收尾阶段累加，空闲和终态节点固定。 */
  readonly working_elapsed_ms?: number;
  /** 当前 Pi 模型上下文窗口上限，单位为 token。 */
  readonly context_window_tokens?: number;
  /** 当前上下文占用百分比；压缩后尚未获得新 usage 时暂缺。 */
  readonly context_usage_percent?: number;
  readonly activity?: AgentActivitySummary;
  readonly last_task?: AgentLastTask;
  readonly error?: AgentFault;
  /** 仅 `terminated` 携带；活动节点不得提前声称终止结果。 */
  readonly termination_result?: AgentTerminationResult;
}

export const AGENT_FAULT_METADATA: Readonly<Record<AgentFaultCode, Readonly<{
  readonly message: string;
  readonly retryable: boolean;
}>>> = Object.freeze({
  spawn_failed: Object.freeze({ message: "Subagent startup failed", retryable: false }),
  spawn_timeout: Object.freeze({ message: "Subagent startup timed out", retryable: true }),
  capability_mismatch: Object.freeze({ message: "Subagent capability mismatch", retryable: false }),
  message_delivery_failed: Object.freeze({ message: "Message delivery status is uncertain", retryable: false }),
  termination_incomplete: Object.freeze({ message: "Subagent resources not fully reclaimed", retryable: true }),
  internal_error: Object.freeze({ message: "Internal controller error", retryable: false }),
});

export interface AgentSnapshotCodecOptions {
  readonly maxDepth?: number;
  readonly maxStringBytes?: number;
}

const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CANONICAL_UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RFC3339_MILLIS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SNAPSHOT_KEYS = new Set([
  "agent_id",
  "parent_agent_id",
  "template_id",
  "name",
  "depth",
  "state",
  "mailbox_pending_count",
  "host_pending_count",
  "reply_outbox_pending_count",
  "revision",
  "created_at",
  "lifecycle_elapsed_ms",
  "working_elapsed_ms",
  "context_window_tokens",
  "context_usage_percent",
  "activity",
  "last_task",
  "error",
  "termination_result",
]);
const ACTIVITY_KEYS = new Set(["phase", "task_id", "category", "active_count"]);
const LAST_TASK_KEYS = new Set([
  "task_id",
  "turn_id",
  "commit_id",
  "outcome",
  "output_state",
]);
const FAULT_KEYS = new Set(["code", "message", "retryable"]);
const UTF8_ENCODER = new TextEncoder();

export function isCanonicalAgentUuid(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_UUID_PATTERN.test(value);
}

export function isCanonicalUuidV4Text(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_UUID_V4_PATTERN.test(value);
}

export function isRfc3339Millis(value: unknown): value is string {
  return typeof value === "string" && RFC3339_MILLIS_PATTERN.test(value);
}

/** 从不可信边界逐字段重建 v7 安全快照。 */
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
      || !nonNegativeSafeInteger(record.mailbox_pending_count)
      || !nonNegativeSafeInteger(record.host_pending_count)
      || !nonNegativeSafeInteger(record.reply_outbox_pending_count)
      || !positiveSafeInteger(record.revision)
      || (record.created_at !== undefined && !isRfc3339Millis(record.created_at))
      || (record.lifecycle_elapsed_ms !== undefined && !nonNegativeSafeInteger(record.lifecycle_elapsed_ms))
      || (record.working_elapsed_ms !== undefined && !nonNegativeSafeInteger(record.working_elapsed_ms))
      || (record.context_window_tokens !== undefined && !positiveSafeInteger(record.context_window_tokens))
      || (record.context_usage_percent !== undefined && !validContextUsagePercent(record.context_usage_percent))
    ) return undefined;

    const activity = record.activity === undefined
      ? undefined
      : parseAgentActivitySummary(record.activity);
    const lastTask = record.last_task === undefined
      ? undefined
      : parseAgentLastTask(record.last_task);
    const fault = record.error === undefined
      ? undefined
      : parseAgentFault(record.error, options.maxStringBytes);
    if (
      (record.activity !== undefined && activity === undefined)
      || (record.last_task !== undefined && lastTask === undefined)
      || (record.error !== undefined && fault === undefined)
    ) return undefined;

    const state = record.state as AgentLifecycleState;
    const mailboxPending = record.mailbox_pending_count as number;
    const hostPending = record.host_pending_count as number;
    const replyPending = record.reply_outbox_pending_count as number;
    const terminationResult = record.termination_result === undefined
      ? undefined
      : (AGENT_TERMINATION_RESULTS as readonly unknown[]).includes(record.termination_result)
        ? record.termination_result as AgentTerminationResult
        : undefined;
    if (record.termination_result !== undefined && terminationResult === undefined) return undefined;
    if (state === "failed" && fault === undefined) return undefined;
    if (state !== "failed" && state !== "terminating" && fault !== undefined) return undefined;
    if (["starting", "idle", "failed", "terminating", "terminated"].includes(state) && activity !== undefined) {
      return undefined;
    }
    if ((state === "working" || state === "interrupting" || state === "suspended") && activity === undefined) {
      return undefined;
    }
    if (state === "suspended" && activity !== undefined && ![
      "maintenance_failed",
      "delivery_uncertain",
    ].includes(activity.phase)) return undefined;
    if (state === "idle" && (mailboxPending !== 0 || hostPending !== 0 || replyPending !== 0)) return undefined;
    if (["starting", "failed", "terminating", "terminated"].includes(state)
      && (mailboxPending !== 0 || hostPending !== 0 || replyPending !== 0)) return undefined;
    if (state === "terminated" && (fault !== undefined || terminationResult === undefined)) return undefined;
    if (state !== "terminated" && terminationResult !== undefined) return undefined;
    if (state === "starting" && (
      record.created_at !== undefined
      || record.lifecycle_elapsed_ms !== undefined
      || record.working_elapsed_ms !== undefined
      || record.context_window_tokens !== undefined
      || record.context_usage_percent !== undefined
      || lastTask !== undefined
      || fault !== undefined
    )) return undefined;
    if ((record.created_at === undefined) !== (record.lifecycle_elapsed_ms === undefined)) return undefined;
    if (
      record.working_elapsed_ms !== undefined
      && (
        record.lifecycle_elapsed_ms === undefined
        || (record.working_elapsed_ms as number) > (record.lifecycle_elapsed_ms as number)
      )
    ) return undefined;
    if (record.context_usage_percent !== undefined && record.context_window_tokens === undefined) return undefined;

    return Object.freeze({
      agent_id: record.agent_id,
      parent_agent_id: record.parent_agent_id as string | null,
      template_id: record.template_id,
      name: record.name,
      depth: record.depth as number,
      state,
      mailbox_pending_count: mailboxPending,
      host_pending_count: hostPending,
      reply_outbox_pending_count: replyPending,
      revision: record.revision as number,
      ...(record.created_at === undefined ? {} : { created_at: record.created_at as string }),
      ...(record.lifecycle_elapsed_ms === undefined
        ? {}
        : { lifecycle_elapsed_ms: record.lifecycle_elapsed_ms as number }),
      ...(record.working_elapsed_ms === undefined
        ? {}
        : { working_elapsed_ms: record.working_elapsed_ms as number }),
      ...(record.context_window_tokens === undefined
        ? {}
        : { context_window_tokens: record.context_window_tokens as number }),
      ...(record.context_usage_percent === undefined
        ? {}
        : { context_usage_percent: record.context_usage_percent as number }),
      ...(activity === undefined ? {} : { activity }),
      ...(lastTask === undefined ? {} : { last_task: lastTask }),
      ...(fault === undefined ? {} : { error: fault }),
      ...(terminationResult === undefined ? {} : { termination_result: terminationResult }),
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
    || (record.task_id !== undefined && !isCanonicalUuidV4Text(record.task_id))
    || (record.category !== undefined
      && !(AGENT_ACTIVITY_CATEGORIES as readonly unknown[]).includes(record.category))
    || (record.active_count !== undefined && !positiveSafeInteger(record.active_count))
    || ((record.category === undefined) !== (record.active_count === undefined))
  ) return undefined;
  return Object.freeze({
    phase: record.phase as AgentActivityPhase,
    ...(record.task_id === undefined ? {} : { task_id: record.task_id as string }),
    ...(record.category === undefined ? {} : {
      category: record.category as AgentActivityCategory,
      active_count: record.active_count as number,
    }),
  });
}

export function parseAgentLastTask(value: unknown): AgentLastTask | undefined {
  const record = plainDataRecord(value, LAST_TASK_KEYS);
  if (
    record === undefined
    || !isCanonicalUuidV4Text(record.task_id)
    || !isCanonicalUuidV4Text(record.turn_id)
    || !isCanonicalUuidV4Text(record.commit_id)
    || !(AGENT_TASK_OUTCOMES as readonly unknown[]).includes(record.outcome)
    || (record.output_state !== "present" && record.output_state !== "absent")
  ) return undefined;
  return Object.freeze({
    task_id: record.task_id,
    turn_id: record.turn_id,
    commit_id: record.commit_id,
    outcome: record.outcome as AgentTaskOutcome,
    output_state: record.output_state,
  });
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
  // 只接受当前协议的规范字段；不兼容旧描述或伪造 retryable，语义仍由 code 识别。
  if (record.message !== metadata.message || record.retryable !== metadata.retryable) return undefined;
  return Object.freeze({ code, message: metadata.message, retryable: metadata.retryable });
}

function plainDataRecord(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
): Record<string, unknown> | undefined {
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

function boundedString(value: unknown, maxStringBytes: number | undefined): value is string {
  return typeof value === "string"
    && (maxStringBytes === undefined || UTF8_ENCODER.encode(value).byteLength <= maxStringBytes);
}

function positiveSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonNegativeSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** 允许超过 100% 表示 provider/估算在压缩前短暂超过窗口，但限制异常大值。 */
function validContextUsagePercent(value: unknown): boolean {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= 0
    && value <= 1_000;
}
