/** 子代理对外可观察的生命周期仅限这七种状态。 */
export const AGENT_LIFECYCLE_STATES = Object.freeze([
  "starting",
  "idle",
  "working",
  "interrupting",
  "failed",
  "terminating",
  "terminated",
] as const);

export type AgentLifecycleState = (typeof AGENT_LIFECYCLE_STATES)[number];

/** 安全活动摘要只允许控制器确认的固定类别，不承载工具名或参数。 */
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
  readonly category: AgentActivityCategory;
  readonly active_count: number;
}

/** 节点状态中可以保留的安全故障码，不保存底层异常文字。 */
export const AGENT_FAULT_CODES = Object.freeze([
  "spawn_failed",
  "spawn_timeout",
  "message_delivery_failed",
  "termination_incomplete",
  "internal_error",
] as const);

export type AgentFaultCode = (typeof AGENT_FAULT_CODES)[number];

export interface AgentFault {
  readonly code: AgentFaultCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly observed_at: string;
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
  readonly pending_message_count: number;
  readonly revision: number;
  readonly observed_at: string;
  /** 成功创建的线性化点；starting 节点没有该时间。 */
  readonly created_at?: string;
  /** 由单调时钟派生，活动节点持续累加，终态节点固定。 */
  readonly lifecycle_elapsed_ms?: number;
  readonly activity?: AgentActivitySummary;
  readonly error?: AgentFault;
  /** 仅 `terminated` 携带；活动节点不得提前声称终止结果。 */
  readonly termination_result?: AgentTerminationResult;
}

export const AGENT_FAULT_METADATA: Readonly<Record<AgentFaultCode, Readonly<{
  readonly message: string;
  readonly retryable: boolean;
}>>> = Object.freeze({
  spawn_failed: Object.freeze({ message: "代理启动失败", retryable: false }),
  spawn_timeout: Object.freeze({ message: "代理启动超时", retryable: true }),
  message_delivery_failed: Object.freeze({ message: "消息未获确认接收", retryable: false }),
  termination_incomplete: Object.freeze({ message: "代理资源尚未完全回收", retryable: true }),
  internal_error: Object.freeze({ message: "控制器内部错误", retryable: false }),
});

export interface AgentSnapshotCodecOptions {
  /** 协议边界可进一步收窄深度；省略时只要求正安全整数。 */
  readonly maxDepth?: number;
  /** 协议边界可限制模板、名称和故障消息的 UTF-8 字节数。 */
  readonly maxStringBytes?: number;
}

const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RFC3339_MILLIS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SNAPSHOT_KEYS = new Set([
  "agent_id",
  "parent_agent_id",
  "template_id",
  "name",
  "depth",
  "state",
  "pending_message_count",
  "revision",
  "observed_at",
  "created_at",
  "lifecycle_elapsed_ms",
  "activity",
  "error",
  "termination_result",
]);
const ACTIVITY_KEYS = new Set(["category", "active_count"]);
const FAULT_KEYS = new Set(["code", "message", "retryable", "observed_at"]);
const UTF8_ENCODER = new TextEncoder();

/** 判断输入是否为 RFC 9562 传输用的小写 canonical UUID 文本。 */
export function isCanonicalAgentUuid(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_UUID_PATTERN.test(value);
}

export function isRfc3339Millis(value: unknown): value is string {
  return typeof value === "string" && RFC3339_MILLIS_PATTERN.test(value);
}

/**
 * 从不可信边界逐字段重建安全快照。失败只返回 `undefined`，调用边界自行转换
 * 为协议错误、公开控制错误或 UI 安全状态。
 */
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
      || !nonNegativeSafeInteger(record.pending_message_count)
      || !positiveSafeInteger(record.revision)
      || !isRfc3339Millis(record.observed_at)
      || (record.created_at !== undefined && !isRfc3339Millis(record.created_at))
      || (record.lifecycle_elapsed_ms !== undefined && !nonNegativeSafeInteger(record.lifecycle_elapsed_ms))
    ) return undefined;

    const activity = record.activity === undefined
      ? undefined
      : parseAgentActivitySummary(record.activity);
    const fault = record.error === undefined
      ? undefined
      : parseAgentFault(record.error, options.maxStringBytes);
    if ((record.activity !== undefined && activity === undefined) || (record.error !== undefined && fault === undefined)) {
      return undefined;
    }
    const state = record.state as AgentLifecycleState;
    const terminationResult = record.termination_result === undefined
      ? undefined
      : (AGENT_TERMINATION_RESULTS as readonly unknown[]).includes(record.termination_result)
        ? record.termination_result as AgentTerminationResult
        : undefined;
    if (record.termination_result !== undefined && terminationResult === undefined) return undefined;
    if (state === "failed" && fault === undefined) return undefined;
    if (state !== "failed" && state !== "terminating" && fault !== undefined) return undefined;
    if (["starting", "failed", "terminating", "terminated"].includes(state) && activity !== undefined) return undefined;
    if (state === "terminated" && (
      record.pending_message_count !== 0
      || fault !== undefined
      || terminationResult === undefined
    )) return undefined;
    if (state !== "terminated" && terminationResult !== undefined) return undefined;
    if (state === "starting" && (
      record.pending_message_count !== 0
      || record.created_at !== undefined
      || record.lifecycle_elapsed_ms !== undefined
      || activity !== undefined
      || fault !== undefined
    )) return undefined;
    if ((record.created_at === undefined) !== (record.lifecycle_elapsed_ms === undefined)) return undefined;

    return Object.freeze({
      agent_id: record.agent_id,
      parent_agent_id: record.parent_agent_id as string | null,
      template_id: record.template_id,
      name: record.name,
      depth: record.depth as number,
      state,
      pending_message_count: record.pending_message_count as number,
      revision: record.revision as number,
      observed_at: record.observed_at,
      ...(record.created_at === undefined ? {} : { created_at: record.created_at as string }),
      ...(record.lifecycle_elapsed_ms === undefined
        ? {}
        : { lifecycle_elapsed_ms: record.lifecycle_elapsed_ms as number }),
      ...(activity === undefined ? {} : { activity }),
      ...(fault === undefined ? {} : { error: fault }),
      ...(terminationResult === undefined ? {} : { termination_result: terminationResult }),
    });
  } catch {
    return undefined;
  }
}

export function parseAgentActivitySummary(
  value: unknown,
  allowZero = false,
): AgentActivitySummary | undefined {
  const record = plainDataRecord(value, ACTIVITY_KEYS);
  if (
    record === undefined
    || !(AGENT_ACTIVITY_CATEGORIES as readonly unknown[]).includes(record.category)
    || !Number.isSafeInteger(record.active_count)
    || (record.active_count as number) < (allowZero ? 0 : 1)
  ) return undefined;
  return Object.freeze({
    category: record.category as AgentActivityCategory,
    active_count: record.active_count as number,
  });
}

export function parseAgentFault(value: unknown, maxStringBytes?: number): AgentFault | undefined {
  const record = plainDataRecord(value, FAULT_KEYS);
  if (
    record === undefined
    || !(AGENT_FAULT_CODES as readonly unknown[]).includes(record.code)
    || !boundedString(record.message, maxStringBytes)
    || typeof record.retryable !== "boolean"
    || !isRfc3339Millis(record.observed_at)
  ) return undefined;
  const code = record.code as AgentFaultCode;
  const metadata = AGENT_FAULT_METADATA[code];
  if (record.message !== metadata.message || record.retryable !== metadata.retryable) return undefined;
  return Object.freeze({
    code,
    message: metadata.message,
    retryable: metadata.retryable,
    observed_at: record.observed_at,
  });
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
