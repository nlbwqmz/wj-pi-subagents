import { randomUUID } from "node:crypto";
import type { RuntimeConfig } from "./root-runtime-context.ts";
import { canTransition } from "./conversation-lifecycle.ts";
import {
  AGENT_ACTIVITY_PHASES,
  AGENT_FAULT_CODES,
  AGENT_FAULT_METADATA,
  DEFAULT_AGENT_ACTIVITY,
  createAgentFault,
  isCanonicalAgentUuid,
  parseAgentActivitySummary,
  parseAgentSnapshot,
  type AgentActivitySummary,
  type AgentActivityPhase,
  type AgentFault,
  type AgentFaultCode,
  type AgentLifecycleState,
  type AgentSnapshot,
  type AgentTerminationResult,
} from "./agent-snapshot-codec.ts";
import {
  EMPTY_STARTUP_DIAGNOSTIC_DETAILS,
  hasStartupDiagnosticDetails,
  isCanonicalStartupDiagnosticDetails,
  normalizeStartupDiagnosticDetails,
  type StartupDiagnosticDetails,
} from "./startup-diagnostic.ts";

import {
  normalizeWaitAgentArgumentIssue,
  waitAgentArgumentIssueMessage,
  type WaitAgentArgumentIssue,
} from "./wait-agent-arguments.ts";

type InternalAgentLifecycleState = AgentLifecycleState;

export {
  AGENT_ACTIVITY_PHASES,
  AGENT_FAULT_CODES,
  AGENT_LIFECYCLE_STATES,
  AGENT_TERMINATION_RESULTS,
  type AgentActivityPhase,
  type AgentActivitySummary,
  type AgentFault,
  type AgentFaultCode,
  type AgentLifecycleState,
  type AgentSnapshot,
  type AgentTerminationResult,
} from "./agent-snapshot-codec.ts";

/** 公开控制面允许返回的稳定错误码闭集。 */
export const PUBLIC_ERROR_CODES = Object.freeze([
  "invalid_argument",
  "reply_too_large",
  "agent_not_found",
  "not_direct_child",
  "template_not_found",
  "template_invalid",
  "template_capability_unavailable",
  "capability_mismatch",
  "max_depth_reached",
  "max_children_reached",
  "max_tree_agents_reached",
  "spawn_failed",
  "spawn_timeout",
  "provider_unavailable",
  "model_unavailable",
  "extension_load_failed",
  "agent_unavailable",
  "message_delivery_failed",
  "compaction_active",
  "protocol_mismatch",
  "termination_incomplete",
  "internal_error",
] as const);

export type PublicErrorCode = (typeof PUBLIC_ERROR_CODES)[number];

export type PublicErrorDetails = StartupDiagnosticDetails | WaitAgentArgumentIssue;

export interface PublicControlError {
  readonly code: PublicErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details: PublicErrorDetails;
}

export interface ControlSuccess<T> {
  readonly ok: true;
  readonly data: T;
}

export interface ControlFailure {
  readonly ok: false;
  readonly error: PublicControlError;
}

export type ControlResult<T> = ControlSuccess<T> | ControlFailure;

const EMPTY_DETAILS: PublicErrorDetails = EMPTY_STARTUP_DIAGNOSTIC_DETAILS;

const ERROR_METADATA: Readonly<Record<PublicErrorCode, Readonly<{
  message: string;
  retryable: boolean;
}>>> = Object.freeze({
  invalid_argument: Object.freeze({ message: "Invalid argument", retryable: false }),
  reply_too_large: Object.freeze({ message: "Reply exceeds the maximum size", retryable: false }),
  agent_not_found: Object.freeze({ message: "Subagent ID is not registered", retryable: false }),
  not_direct_child: Object.freeze({ message: "Target is not a direct child", retryable: false }),
  template_not_found: Object.freeze({ message: "Agent template not found", retryable: false }),
  template_invalid: Object.freeze({ message: "Invalid agent template", retryable: false }),
  template_capability_unavailable: Object.freeze({ message: "Required template capabilities unavailable", retryable: false }),
  capability_mismatch: AGENT_FAULT_METADATA.capability_mismatch,
  max_depth_reached: Object.freeze({ message: "Maximum subagent depth reached", retryable: false }),
  max_children_reached: Object.freeze({ message: "Direct child limit reached", retryable: true }),
  max_tree_agents_reached: Object.freeze({ message: "Agent tree limit reached", retryable: true }),
  spawn_failed: AGENT_FAULT_METADATA.spawn_failed,
  spawn_timeout: AGENT_FAULT_METADATA.spawn_timeout,
  provider_unavailable: AGENT_FAULT_METADATA.provider_unavailable,
  model_unavailable: AGENT_FAULT_METADATA.model_unavailable,
  extension_load_failed: AGENT_FAULT_METADATA.extension_load_failed,
  agent_unavailable: Object.freeze({ message: "Subagent currently unavailable", retryable: false }),
  message_delivery_failed: AGENT_FAULT_METADATA.message_delivery_failed,
  compaction_active: Object.freeze({
    message: "Message delivery blocked while compaction is active; retry after compaction finishes",
    retryable: true,
  }),
  protocol_mismatch: AGENT_FAULT_METADATA.protocol_mismatch,
  termination_incomplete: AGENT_FAULT_METADATA.termination_incomplete,
  internal_error: AGENT_FAULT_METADATA.internal_error,
});

/** 所有公开失败均从此处创建，避免把路径、异常或句柄带出控制器。 */
export function controlFailure(code: PublicErrorCode, details: unknown = EMPTY_DETAILS): ControlFailure {
  const metadata = ERROR_METADATA[code];
  const waitAgentIssue = code === "invalid_argument"
    ? normalizeWaitAgentArgumentIssue(details)
    : undefined;
  const normalizedDetails = waitAgentIssue ?? normalizeStartupDiagnosticDetails(code, details);
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      code,
      message: waitAgentIssue === undefined ? metadata.message : waitAgentArgumentIssueMessage(waitAgentIssue),
      retryable: metadata.retryable,
      details: normalizedDetails,
    }),
  });
}

function controlSuccess<T>(data: T): ControlSuccess<T> {
  return Object.freeze({ ok: true, data });
}

const CANONICAL_UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_ID_GENERATION_ATTEMPTS = 32;

/** 判断输入是否为 RFC 9562 传输用的小写 canonical UUID 文本。 */
export function isCanonicalUuid(value: unknown): value is string {
  return isCanonicalAgentUuid(value);
}

/** 新分配身份必须额外满足 UUID v4 版本位。 */
export function isCanonicalUuidV4(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_UUID_V4_PATTERN.test(value);
}

export interface RootTreeActor {
  readonly kind: "root";
}

export interface AgentTreeActor {
  readonly kind: "agent";
  readonly agent_id: string;
}

export type TreeActor = RootTreeActor | AgentTreeActor;

/** 根会话不是代理节点，使用此值表示其直接子代理作用域。 */
export const ROOT_TREE_ACTOR: RootTreeActor = Object.freeze({ kind: "root" });

export interface ReserveStartingChildInput {
  readonly templateId: string;
  readonly name: string;
  /** 未校验创建路径省略时沿用默认的递归管理能力。 */
  readonly allowSubagents?: boolean;
}

export interface AgentTreeSnapshot {
  readonly tree_revision: number;
  readonly nodes: readonly AgentSnapshot[];
}

export interface QuotaSnapshot {
  readonly active_tree_agents: number;
  readonly max_tree_agents: number;
  readonly active_children_of_root: number;
  readonly max_children_per_agent: number;
}

export interface ManagementCapabilitySnapshot {
  readonly enabled: boolean;
}

export interface TreeSnapshotScope {
  readonly kind: "root" | "subtree";
  readonly agent_id?: string;
}

export interface ScopedAgentTreeSnapshot extends AgentTreeSnapshot {
  readonly scope: TreeSnapshotScope;
}

export interface LifecycleEventOutcome {
  readonly applied: boolean;
  readonly node: AgentSnapshot;
  readonly lifecycle_generation: number;
  readonly tree_revision: number;
  /** 未应用事实的稳定归因；成功转换不携带诊断。 */
  readonly diagnostic?: "stale_generation" | "invalid_transition";
}

/** 一次树级终止屏障的固定成员和线性化修订。 */
export interface TerminationBarrierOutcome {
  readonly barrier_id: string;
  readonly agent_id: string;
  /** 成员按后代优先排列；这是清理协调的唯一固定顺序。 */
  readonly agent_ids: readonly string[];
  readonly changed: boolean;
  readonly tree_revision: number;
}

/** 父端接收的完整子树安全快照；正文不属于该结构。 */
export interface SubtreeSnapshotInput {
  readonly scope_agent_id: string;
  readonly subtree_revision: number;
  readonly nodes: readonly AgentSnapshot[];
}

export interface SubtreeSnapshotOutcome {
  readonly applied: boolean;
  readonly scope_agent_id: string;
  readonly subtree_revision: number;
  readonly tree_revision: number;
}

/** 子树投影采用根权威已经签发的身份，不得在本地重新生成 UUID。 */
export interface AdoptSpawnGrantInput {
  readonly node: AgentSnapshot;
  readonly lifecycle_generation: number;
  readonly management_enabled: boolean;
}

/** 监督通道专用完整子树读取；保留作用域根的真实直接父标识。 */
export interface SupervisionSubtreeSnapshot {
  readonly tree_revision: number;
  readonly nodes: readonly AgentSnapshot[];
}

/** 创建旅程的稳定返回名称；字段与生命周期事件结果保持相同安全外壳。 */
export type ReservedAgentOutcome = LifecycleEventOutcome;

interface EventGeneration {
  /**
   * 事件产生时读取的节点代际；所有监督事件都必须携带，避免无身份的迟到事件
   * 在新的消息或状态变化后再次消费当前节点事实。
   */
  readonly expected_generation: number;
}

interface FailureEvent extends EventGeneration {
  readonly error_code?: AgentFaultCode;
  /** 仅可与对应启动错误码组合的规范、冻结诊断。 */
  readonly error_details?: StartupDiagnosticDetails;
}

/** 来自 Pi ExtensionContext 的安全上下文用量投影。 */
export interface AgentContextUsageInput {
  readonly context_window_tokens: number;
  readonly context_usage_percent?: number;
}

/** 监督器可以归一化并提交给树控制器的资源生命周期事实闭集。 */
export const AGENT_LIFECYCLE_EVENT_TYPES = Object.freeze([
  "startup_ready",
  "startup_failed",
  "agent_start",
  "agent_settled",
  "interrupt_accepted",
  "terminate_accepted",
  "runtime_failed",
  "resources_confirmed",
] as const);

export type AgentLifecycleEventType = (typeof AGENT_LIFECYCLE_EVENT_TYPES)[number];

/**
 * 监督器把已接纳意图或已确认事实归一化后交给树控制器。
 * 未列出的底层事件不能直接改变公开状态。
 */
type FailureLifecycleEventType = "startup_failed" | "runtime_failed";

type LifecycleEventShape<Type extends AgentLifecycleEventType> =
  Type extends FailureLifecycleEventType ? FailureEvent : EventGeneration;

export type AgentLifecycleEvent = {
  readonly [Type in AgentLifecycleEventType]: LifecycleEventShape<Type> & { readonly type: Type };
}[AgentLifecycleEventType];

/** 树控制器已经实际应用的一条生命周期事实；观察者只能读取该冻结投影。 */
export type AppliedLifecycleFact = AgentLifecycleEvent & {
  readonly agent_id: string;
};

export interface TreeControllerOptions {
  readonly config: Pick<
    RuntimeConfig,
    "maxDepth" | "maxChildrenPerAgent" | "maxAgentsPerTree" | "waitTimeoutMs"
  >;
  readonly idFactory?: () => string;
  readonly now?: () => Date;
  readonly monotonicNow?: () => number;
  readonly rootManagementEnabled?: boolean;
  /** 子运行时在未接入同根权威时用于恢复自身作用域根的最小安全事实。 */
  readonly initialActor?: {
    readonly agentId: string;
    readonly parentAgentId: string | null;
    readonly depth: number;
    readonly templateId?: string;
    readonly name?: string;
    readonly managementEnabled: boolean;
  };
}

interface AgentRecord {
  readonly agentId: string;
  readonly parentAgentId: string | null;
  readonly templateId: string;
  readonly name: string;
  readonly depth: number;
  readonly managementEnabled: boolean;
  state: InternalAgentLifecycleState;
  revision: number;
  lifecycleGeneration: number;
  createdAt: string | undefined;
  workingStartedAt: number | undefined;
  accumulatedWorkingElapsedMs: number;
  contextWindowTokens: number | undefined;
  contextUsagePercent: number | undefined;
  activity: AgentActivitySummary | undefined;
  error: AgentFault | undefined;
  terminationResult: AgentTerminationResult | undefined;
  terminationHadFailure: boolean;
  terminationHadIncompleteCleanup: boolean;
  readonly scopeActorOnly: boolean;
}

interface TerminationBarrierRecord {
  readonly barrierId: string;
  readonly targetAgentId: string;
  readonly memberIds: readonly string[];
  readonly createdTreeRevision: number;
}

interface ResolvedActor {
  readonly parentAgentId: string | null;
  readonly depth: number;
  readonly managementEnabled: boolean;
  readonly record: AgentRecord | undefined;
}

interface PublicMutation {
  readonly state?: InternalAgentLifecycleState;
  readonly errorCode?: AgentFaultCode;
  /** errorCode 指定时重新规范化；未指定时不得改变既有故障详情。 */
  readonly errorDetails?: StartupDiagnosticDetails;
  readonly clearError?: boolean;
  /** undefined 表示保持，null 表示清除。 */
  readonly activity?: AgentActivitySummary | null;
  /** undefined 表示保持，null 表示清除。 */
  readonly contextWindowTokens?: number | null;
  /** undefined 表示保持，null 表示清除。 */
  readonly contextUsagePercent?: number | null;
}

function isAgentContextUsageInput(value: unknown): value is AgentContextUsageInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Number.isSafeInteger(candidate.context_window_tokens)
    && (candidate.context_window_tokens as number) > 0
    && (
      candidate.context_usage_percent === undefined
      || (
        typeof candidate.context_usage_percent === "number"
        && Number.isFinite(candidate.context_usage_percent)
        && candidate.context_usage_percent >= 0
        && candidate.context_usage_percent <= 1_000
      )
    )
    && Object.keys(candidate).every((key) => [
      "context_window_tokens",
      "context_usage_percent",
    ].includes(key));
}

function isAgentFaultCode(value: unknown): value is AgentFaultCode {
  return typeof value === "string" && (AGENT_FAULT_CODES as readonly string[]).includes(value);
}

/** 生命周期入口不接受原型字段、访问器或符号字段，避免绕过 details 闭集。 */
function plainLifecycleEventRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) return undefined;
  }
  return record;
}

function isLifecycleEvent(value: unknown): value is AgentLifecycleEvent {
  try {
    const candidate = plainLifecycleEventRecord(value);
    if (candidate === undefined || !Object.hasOwn(candidate, "type")) return false;
    const type = candidate.type;
    if (typeof type !== "string" || !(AGENT_LIFECYCLE_EVENT_TYPES as readonly string[]).includes(type)) {
      return false;
    }
    const failureEvent = type === "startup_failed" || type === "runtime_failed";
    const allowedKeys = [
      "type",
      "expected_generation",
      ...(failureEvent ? ["error_code", "error_details"] : []),
    ];
    if (Object.keys(candidate).some((key) => !allowedKeys.includes(key))) return false;
    if (
      !Object.hasOwn(candidate, "expected_generation")
      || !Number.isSafeInteger(candidate.expected_generation)
      || (candidate.expected_generation as number) < 0
    ) return false;
    if (!failureEvent) return true;
    if (
      Object.hasOwn(candidate, "error_code")
      && candidate.error_code !== undefined
      && !isAgentFaultCode(candidate.error_code)
    ) return false;
    if (!Object.hasOwn(candidate, "error_details")) return true;
    if (!isAgentFaultCode(candidate.error_code)) return false;
    if (!isCanonicalStartupDiagnosticDetails(candidate.error_code, candidate.error_details)) return false;
    return hasStartupDiagnosticDetails(
      normalizeStartupDiagnosticDetails(candidate.error_code, candidate.error_details),
    );
  } catch {
    return false;
  }
}

function validReserveInput(value: unknown): value is ReserveStartingChildInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Object.keys(candidate).every((key) => ["templateId", "name", "allowSubagents"].includes(key))
    && typeof candidate.templateId === "string"
    && typeof candidate.name === "string"
    && (candidate.allowSubagents === undefined || typeof candidate.allowSubagents === "boolean");
}

function reservationAllowsSubagents(input: ReserveStartingChildInput): boolean {
  return input.allowSubagents ?? true;
}

function isPublicAgentSnapshot(value: unknown): value is AgentSnapshot {
  return parseAgentSnapshot(value) !== undefined;
}

function isSubtreeSnapshotInput(value: unknown): value is SubtreeSnapshotInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return isCanonicalUuid(candidate.scope_agent_id)
    && Number.isSafeInteger(candidate.subtree_revision)
    && (candidate.subtree_revision as number) >= 1
    && Array.isArray(candidate.nodes)
    && candidate.nodes.every(isPublicAgentSnapshot)
    && Object.keys(candidate).every((key) => ["scope_agent_id", "subtree_revision", "nodes"].includes(key));
}

function isAdoptSpawnGrantInput(value: unknown): value is AdoptSpawnGrantInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return isPublicAgentSnapshot(candidate.node)
    && Number.isSafeInteger(candidate.lifecycle_generation)
    && (candidate.lifecycle_generation as number) >= 0
    && typeof candidate.management_enabled === "boolean"
    && Object.keys(candidate).every((key) => [
      "node", "lifecycle_generation", "management_enabled",
    ].includes(key));
}

function cloneAgentFault(fault: AgentFault | undefined): AgentFault | undefined {
  return fault === undefined ? undefined : createAgentFault(fault.code, fault.details);
}

function snapshotHadTerminationFailure(node: AgentSnapshot): boolean {
  return node.state === "failed" || node.termination_result === "failed";
}

function snapshotHadIncompleteCleanup(node: AgentSnapshot): boolean {
  return node.error?.code === "termination_incomplete" || node.termination_result === "incomplete";
}

function terminationResultFromHistory(
  hadFailure: boolean,
  hadIncompleteCleanup: boolean,
): AgentTerminationResult {
  return hadIncompleteCleanup ? "incomplete" : hadFailure ? "failed" : "completed";
}

function sameSnapshotExceptContext(
  record: AgentRecord,
  node: AgentSnapshot,
  hiddenParent: boolean,
): boolean {
  const currentFault = record.error;
  const nextFault = node.error;
  return (
    record.parentAgentId === (hiddenParent ? record.parentAgentId : node.parent_agent_id)
    && record.templateId === node.template_id
    && record.name === node.name
    && record.depth === node.depth
    && record.state === node.state
    && record.revision === node.revision
    // created_at 与 working_elapsed_ms 由各运行时本地时钟派生；同一事实
    // 在根和子运行时独立应用时可以不同，不能据此否定同修订投影。
    && JSON.stringify(record.activity) === JSON.stringify(node.activity)
    && JSON.stringify(currentFault) === JSON.stringify(nextFault)
    && record.terminationResult === node.termination_result
  );
}

function sameSnapshot(
  record: AgentRecord,
  node: AgentSnapshot,
  hiddenParent: boolean,
): boolean {
  const contextMatches = node.context_window_tokens === undefined
    || (
      record.contextWindowTokens === node.context_window_tokens
      && record.contextUsagePercent === node.context_usage_percent
    );
  return sameSnapshotExceptContext(record, node, hiddenParent) && contextMatches;
}

function safeWallClockNow(now: () => Date): string {
  try {
    const value = now();
    if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  } catch {
    // 时钟异常不能把异常内容进入公开控制面。
  }
  return new Date(0).toISOString();
}

function isManagementState(state: InternalAgentLifecycleState): boolean {
  return state === "idle"
    || state === "working"
    || state === "interrupting";
}

/** 工作时长覆盖任务实际处理和中断收尾，不计入静止、挂起或资源清理。 */
function isWorkingTimeState(state: InternalAgentLifecycleState): boolean {
  return state === "working" || state === "interrupting";
}

/** 将工作态缺失的活动阶段归一化，确保所有公开树记录满足状态不变量。 */
function activityForState(
  state: InternalAgentLifecycleState,
  activity: AgentActivitySummary | undefined,
): AgentActivitySummary | undefined {
  return isWorkingTimeState(state) ? activity ?? DEFAULT_AGENT_ACTIVITY : undefined;
}

function isQuotaConsumingState(state: InternalAgentLifecycleState): boolean {
  return state !== "terminated";
}

function eventGeneration(event: AgentLifecycleEvent): number {
  return event.expected_generation;
}

function eventFaultCode(event: FailureEvent, fallback: AgentFaultCode): AgentFaultCode {
  return event.error_code ?? fallback;
}

/**
 * 树控制器是身份、所有权、配额和生命周期事实的单一顺序域。
 * 它不访问 RPC、进程 PID、管道、文件路径或模型正文。
 */
export class TreeController {
  private readonly config: Readonly<Pick<
    RuntimeConfig,
    "maxDepth" | "maxChildrenPerAgent" | "maxAgentsPerTree" | "waitTimeoutMs"
  >>;
  private readonly idFactory: () => string;
  private readonly now: () => Date;
  private readonly monotonicNow: () => number;
  private readonly rootManagementEnabled: boolean;
  private readonly authoritative: boolean;
  private readonly agents = new Map<string, AgentRecord>();
  private readonly issuedAgentIds = new Set<string>();
  private readonly terminationBarriers = new Map<string, TerminationBarrierRecord>();
  private readonly subtreeRevisions = new Map<string, number>();
  /** 根权威已预留、但尚未在任何已接受子树快照中出现的后代身份。 */
  private readonly pendingSubtreeProjectionAgentIds = new Set<string>();
  private readonly changeListeners = new Set<() => void>();
  private readonly lifecycleListeners = new Set<(fact: AppliedLifecycleFact) => void>();
  private treeRevision = 0;

  constructor(options: TreeControllerOptions) {
    this.config = Object.freeze({
      maxDepth: options.config.maxDepth,
      maxChildrenPerAgent: options.config.maxChildrenPerAgent,
      maxAgentsPerTree: options.config.maxAgentsPerTree,
      waitTimeoutMs: options.config.waitTimeoutMs,
    });
    this.idFactory = options.idFactory ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.rootManagementEnabled = options.rootManagementEnabled !== false;
    const initialActor = options.initialActor;
    this.authoritative = initialActor === undefined;
    if (initialActor !== undefined) {
      if (
        !isCanonicalUuid(initialActor.agentId)
        || (initialActor.parentAgentId !== null && !isCanonicalUuid(initialActor.parentAgentId))
        || initialActor.parentAgentId === initialActor.agentId
        || !Number.isSafeInteger(initialActor.depth)
        || initialActor.depth < 1
        || initialActor.depth > this.config.maxDepth
        || typeof initialActor.managementEnabled !== "boolean"
      ) throw new TypeError("子运行时身份无效");
      const createdAt = safeWallClockNow(this.now);
      this.agents.set(initialActor.agentId, {
        agentId: initialActor.agentId,
        parentAgentId: initialActor.parentAgentId,
        templateId: initialActor.templateId ?? "inherited",
        name: initialActor.name ?? "Subagent",
        depth: initialActor.depth,
        managementEnabled: initialActor.managementEnabled,
        state: "idle",
        revision: 1,
        lifecycleGeneration: 0,
        createdAt,
        workingStartedAt: undefined,
        accumulatedWorkingElapsedMs: 0,
        contextWindowTokens: undefined,
        contextUsagePercent: undefined,
        activity: undefined,
        error: undefined,
        terminationResult: undefined,
        terminationHadFailure: false,
        terminationHadIncompleteCleanup: false,
        scopeActorOnly: true,
      });
      this.issuedAgentIds.add(initialActor.agentId);
    }
  }

  /** 只读观察树事实变化；观察者异常不会影响控制器顺序域。 */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /** 只观察真正应用的生命周期事实；迟到、重复和非法事实不会回调。 */
  onLifecycleEvent(listener: (fact: AppliedLifecycleFact) => void): () => void {
    this.lifecycleListeners.add(listener);
    return () => this.lifecycleListeners.delete(listener);
  }

  /** 返回节点当前生命周期代际，供受管监督事件构造安全事件。 */
  getLifecycleGeneration(agentId: unknown): ControlResult<number> {
    const resolved = this.findAgent(agentId);
    return resolved.ok ? controlSuccess(resolved.data.lifecycleGeneration) : resolved;
  }

  /** 返回调用者作用域内、按后代优先排列的当前节点标识。 */
  getSubtreeAgentIds(actor: TreeActor | unknown): ControlResult<readonly string[]> {
    const resolved = this.resolveActor(actor);
    if (!resolved.ok) return resolved;
    const record = resolved.data.record;
    const records = record === undefined
      ? [...this.agents.values()].filter((candidate) => !candidate.scopeActorOnly)
      : [...this.agents.values()].filter((candidate) =>
        candidate.agentId === record.agentId || this.isDescendantOf(candidate, record.agentId),
      );
    return controlSuccess(Object.freeze(this.orderDescendantsFirst(records).map((candidate) => candidate.agentId)));
  }

  /**
   * 在一个树级线性化点建立不可逆终止屏障。支持两参数的直接父授权形式，
   * 以及供根关闭协调使用的单参数根形式。
   */
  beginTerminationBarrier(
    actor: TreeActor | unknown,
    agentId?: unknown,
  ): ControlResult<TerminationBarrierOutcome> {
    const caller = agentId === undefined ? ROOT_TREE_ACTOR : actor;
    const targetId = agentId === undefined ? actor : agentId;
    const authorization = this.assertDirectChild(caller, targetId);
    if (!authorization.ok) return authorization;
    return this.beginTerminationBarrierInternal(authorization.data.agent_id, false);
  }

  /** 读取已经建立的屏障固定成员；不存在时返回 agent_not_found。 */
  getTerminationBarrier(agentId: unknown): ControlResult<TerminationBarrierOutcome> {
    const target = this.findAgent(agentId);
    if (!target.ok) return target;
    const barrier = this.terminationBarriers.get(target.data.agentId)
      ?? [...this.terminationBarriers.values()].find((candidate) => candidate.memberIds.includes(target.data.agentId));
    if (barrier === undefined) return controlFailure("agent_unavailable");
    return controlSuccess(this.barrierOutcome(barrier, false));
  }

  /**
   * 将同一屏障内全部可确认成员按后代优先顺序提交为一个公开树修订。
   * 故障父的防孤儿回收可保留目标 `failed`，只确认其后代。
   */
  confirmTerminationBarrierResources(
    agentId: unknown,
    preserveFailedTarget = false,
  ): ControlResult<LifecycleEventOutcome> {
    const target = this.findAgent(agentId);
    if (!target.ok) return target;
    const barrier = this.terminationBarriers.get(target.data.agentId);
    if (barrier === undefined) return controlFailure("agent_unavailable");
    if (preserveFailedTarget && target.data.state !== "failed") return controlFailure("agent_unavailable");
    const members: AgentRecord[] = [];
    for (const memberId of barrier.memberIds) {
      const member = this.agents.get(memberId);
      if (member === undefined) return controlFailure("internal_error");
      if (preserveFailedTarget && memberId === target.data.agentId) continue;
      if (member.state !== "terminating" && member.state !== "terminated") {
        return controlFailure("agent_unavailable");
      }
      members.push(member);
    }
    const targetWasTerminated = target.data.state === "terminated";
    this.mutateMany(members, (member) => member.state === "terminated"
      ? {}
      : {
          state: "terminated",
          clearError: true,
        });
    return controlSuccess(this.outcome(
      target.data,
      !targetWasTerminated && target.data.state === "terminated",
    ));
  }

  /** 同一故障清理批次只发布一个修订，供 UI 聚合一次安全通知。 */
  markTerminationBarrierIncomplete(
    agentId: unknown,
    preserveTarget = false,
  ): ControlResult<LifecycleEventOutcome> {
    const target = this.findAgent(agentId);
    if (!target.ok) return target;
    const barrier = this.terminationBarriers.get(target.data.agentId);
    if (barrier === undefined) return controlFailure("agent_unavailable");
    const members: AgentRecord[] = [];
    for (const memberId of barrier.memberIds) {
      if (preserveTarget && memberId === target.data.agentId) continue;
      const member = this.agents.get(memberId);
      if (member === undefined) return controlFailure("internal_error");
      if (member.state !== "terminating" && member.state !== "terminated") {
        return controlFailure("agent_unavailable");
      }
      members.push(member);
    }
    const targetHadIncomplete = target.data.error?.code === "termination_incomplete";
    this.mutateMany(members, (member) => member.state === "terminating"
      ? { errorCode: "termination_incomplete" }
      : {});
    return controlSuccess(this.outcome(
      target.data,
      !targetHadIncomplete && target.data.error?.code === "termination_incomplete",
    ));
  }

  /** 创建调用在同步临界区内同时预留两类名额并登记 starting。 */
  reserveStartingChild(
    actor: TreeActor | unknown,
    input: ReserveStartingChildInput | unknown,
  ): ControlResult<ReservedAgentOutcome> {
    if (!validReserveInput(input)) return controlFailure("invalid_argument");
    const resolved = this.resolveActor(actor);
    if (!resolved.ok) return resolved;

    const parent = resolved.data;
    if (parent.record !== undefined && !isManagementState(parent.record.state)) {
      return controlFailure("agent_unavailable");
    }
    if (parent.depth >= this.config.maxDepth) return controlFailure("max_depth_reached");
    if (!parent.managementEnabled) return controlFailure("template_capability_unavailable");
    if (this.activeChildrenOf(parent.parentAgentId) >= this.config.maxChildrenPerAgent) {
      return controlFailure("max_children_reached");
    }
    if (this.activeTreeAgentCount() >= this.config.maxAgentsPerTree) {
      return controlFailure("max_tree_agents_reached");
    }

    const agentId = this.allocateAgentId();
    if (agentId === undefined) return controlFailure("internal_error");

    const depth = parent.depth + 1;
    const record: AgentRecord = {
      agentId,
      parentAgentId: parent.parentAgentId,
      templateId: input.templateId,
      name: input.name,
      depth,
      managementEnabled: parent.managementEnabled
        && reservationAllowsSubagents(input)
        && depth < this.config.maxDepth,
      state: "starting",
      revision: 1,
      lifecycleGeneration: 0,
      createdAt: undefined,
      workingStartedAt: undefined,
      accumulatedWorkingElapsedMs: 0,
      contextWindowTokens: undefined,
      contextUsagePercent: undefined,
      activity: undefined,
      error: undefined,
      terminationResult: undefined,
      terminationHadFailure: false,
      terminationHadIncompleteCleanup: false,
      scopeActorOnly: false,
    };

    // 写入注册表即完成配额预留，之后任何同步竞争者都会看到该节点。
    this.agents.set(agentId, record);
    this.issuedAgentIds.add(agentId);
    if (this.authoritative && record.parentAgentId !== null) {
      this.pendingSubtreeProjectionAgentIds.add(agentId);
    }
    this.treeRevision += 1;
    this.notifyChange();
    return controlSuccess(this.outcome(record, true));
  }

  /**
   * 子运行时在根权威 reserve_child 成功后采用精确 grant。根控制器本身调用时
   * 只会命中已经登记的同一节点，不重新计数、分配或推进修订。
   */
  adoptSpawnGrant(
    actor: TreeActor | unknown,
    input: AdoptSpawnGrantInput | unknown,
  ): ControlResult<ReservedAgentOutcome> {
    if (!isAdoptSpawnGrantInput(input)) return controlFailure("invalid_argument");
    const parent = this.resolveActor(actor);
    if (!parent.ok) return parent;
    const node = input.node;
    if (
      node.state !== "starting"
      || node.parent_agent_id !== parent.data.parentAgentId
      || node.depth !== parent.data.depth + 1
      || node.depth > this.config.maxDepth
    ) return controlFailure("invalid_argument");
    const existing = this.agents.get(node.agent_id);
    if (existing !== undefined) {
      if (
        existing.parentAgentId !== node.parent_agent_id
        || existing.templateId !== node.template_id
        || existing.name !== node.name
        || existing.depth !== node.depth
        || existing.state !== node.state
        || existing.lifecycleGeneration !== input.lifecycle_generation
        || existing.managementEnabled !== input.management_enabled
      ) return controlFailure("invalid_argument");
      return controlSuccess(this.outcome(existing, false));
    }
    if (this.authoritative || this.issuedAgentIds.has(node.agent_id) || !isCanonicalUuidV4(node.agent_id)) {
      return controlFailure("invalid_argument");
    }
    const record: AgentRecord = {
      agentId: node.agent_id,
      parentAgentId: node.parent_agent_id,
      templateId: node.template_id,
      name: node.name,
      depth: node.depth,
      managementEnabled: input.management_enabled,
      state: "starting",
      revision: node.revision,
      lifecycleGeneration: input.lifecycle_generation,
      createdAt: undefined,
      workingStartedAt: undefined,
      accumulatedWorkingElapsedMs: 0,
      contextWindowTokens: undefined,
      contextUsagePercent: undefined,
      activity: undefined,
      error: undefined,
      terminationResult: undefined,
      terminationHadFailure: false,
      terminationHadIncompleteCleanup: false,
      scopeActorOnly: false,
    };
    this.agents.set(record.agentId, record);
    this.issuedAgentIds.add(record.agentId);
    this.treeRevision += 1;
    this.notifyChange();
    return controlSuccess(this.outcome(record, true));
  }

  /**
   * 应用监督器事件；每个事件都必须携带产生时的代际，不匹配或非法状态边
   * 会安全地成为无变化。启动失败先记录 failed，再立即建立 terminating 屏障；
   * 监督器仍须提交资源确认，控制器不会在未确认资源时释放预留名额。
   */
  applyLifecycleEvent(
    agentId: unknown,
    event: AgentLifecycleEvent | unknown,
  ): ControlResult<LifecycleEventOutcome> {
    const resolved = this.findAgent(agentId);
    if (!resolved.ok) return resolved;
    if (!isLifecycleEvent(event)) return controlFailure("invalid_argument");
    const record = resolved.data;
    const expectedGeneration = eventGeneration(event);
    if (expectedGeneration !== record.lifecycleGeneration) {
      return controlSuccess(this.outcome(record, false, "stale_generation"));
    }

    let applied = false;
    switch (event.type) {
      case "startup_ready":
        if (record.state === "starting") applied = this.mutate(record, { state: "idle" });
        break;
      case "agent_start":
        if (record.state === "idle") {
          applied = this.mutate(record, { state: "working" });
        }
        break;
      case "agent_settled":
        if (record.state === "working" || record.state === "interrupting") {
          applied = this.mutate(record, { state: "idle" });
        }
        break;
      case "interrupt_accepted":
        if (record.state === "working") applied = this.mutate(record, { state: "interrupting" });
        break;
      case "terminate_accepted":
        if (record.state !== "terminated" && record.state !== "terminating") {
          // 终止事实本身建立不可逆屏障，避免任何绕过管理控制器的
          // 监督器入口只改目标状态而留下可继续接纳的后代。
          const barrier = this.beginTerminationBarrierInternal(record.agentId, false);
          applied = barrier.ok && barrier.data.changed;
        }
        break;
      case "startup_failed":
        if (record.state === "starting") {
          applied = this.failStartingNode(
            record,
            eventFaultCode(event, "spawn_failed"),
            event.error_details,
          );
        }
        break;
      case "runtime_failed":
        if (record.state === "starting") {
          applied = this.failStartingNode(
            record,
            eventFaultCode(event, "spawn_failed"),
            event.error_details,
          );
        } else if (
          record.state === "idle"
          || record.state === "working"
          || record.state === "interrupting"
        ) {
          applied = this.failRuntimeAndOrphans(
            record,
            eventFaultCode(event, "spawn_failed"),
            event.error_details,
          );
        }
        break;
      case "resources_confirmed":
        if (record.state === "terminating" && this.allDirectChildrenTerminated(record.agentId)) {
          applied = this.mutate(record, {
            state: "terminated",
            clearError: true,
          });
        }
        break;
    }
    const outcome = this.outcome(
      record,
      applied,
      applied ? undefined : "invalid_transition",
    );
    if (applied) this.notifyLifecycleFact(record.agentId, event);
    return controlSuccess(outcome);
  }

  /** 更新当前子代理的 Pi 上下文窗口事实；undefined 清除当前可用度量。 */
  updateContextUsage(
    agentId: unknown,
    usage: unknown,
  ): ControlResult<LifecycleEventOutcome> {
    const resolved = this.findAgent(agentId);
    if (!resolved.ok) return resolved;
    if (usage !== undefined && !isAgentContextUsageInput(usage)) {
      return controlFailure("invalid_argument");
    }
    const record = resolved.data;
    if (record.state === "starting"
      || record.state === "failed"
      || record.state === "terminating"
      || record.state === "terminated") {
      return controlSuccess(this.outcome(record, false));
    }
    const applied = this.mutate(record, {
      contextWindowTokens: usage?.context_window_tokens ?? null,
      contextUsagePercent: usage?.context_usage_percent ?? null,
    });
    return controlSuccess(this.outcome(record, applied));
  }

  /** 更新当前子代理 working 期间的安全活动阶段。 */
  updateActivity(
    agentId: unknown,
    activity: AgentActivitySummary | unknown,
  ): ControlResult<LifecycleEventOutcome> {
    const resolved = this.findAgent(agentId);
    if (!resolved.ok) return resolved;
    const parsed = parseAgentActivitySummary(activity);
    if (parsed === undefined) return controlFailure("invalid_argument");
    const record = resolved.data;
    if (record.state !== "working" && record.state !== "interrupting") {
      return controlSuccess(this.outcome(record, false));
    }
    const applied = this.mutate(record, { activity: parsed });
    return controlSuccess(this.outcome(record, applied));
  }

  /** 只读单节点状态查询；它不会等待 RPC 或触发状态同步。 */
  getStatus(agentId: unknown): ControlResult<AgentSnapshot> {
    const resolved = this.findAgent(agentId);
    if (!resolved.ok) return resolved;
    return controlSuccess(this.snapshot(resolved.data));
  }

  /** 验证调用者对目标拥有直接父关系，但不执行任何控制动作。 */
  assertDirectChild(actor: TreeActor | unknown, agentId: unknown): ControlResult<AgentSnapshot> {
    const parent = this.resolveActor(actor);
    if (!parent.ok) return parent;
    const target = this.findAgent(agentId);
    if (!target.ok) return target;
    if (target.data.parentAgentId !== parent.data.parentAgentId) {
      return controlFailure("not_direct_child");
    }
    return controlSuccess(this.snapshot(target.data));
  }

  /** 查询某个会话当前是否拥有不可拆分的子代理管理能力。 */
  getManagementCapability(actor: TreeActor | unknown): ControlResult<ManagementCapabilitySnapshot> {
    const resolved = this.resolveActor(actor);
    if (!resolved.ok) return resolved;
    const record = resolved.data.record;
    const enabled = record === undefined
      ? resolved.data.managementEnabled
      : resolved.data.managementEnabled && isManagementState(record.state);
    return controlSuccess(Object.freeze({ enabled }));
  }

  /**
   * 仅用于已预留节点启动子运行时前写入受控 bootstrap。这里读取的是创建时
   * 已经收窄的授权，不把 starting 的暂时不可接单误判为永久叶节点。
   */
  getManagementBootstrapCapability(agentId: unknown): ControlResult<ManagementCapabilitySnapshot> {
    const record = this.findAgent(agentId);
    if (!record.ok) return record;
    const enabled = record.data.managementEnabled
      && (record.data.state === "starting" || isManagementState(record.data.state));
    return controlSuccess(Object.freeze({ enabled }));
  }

  /** 返回整个当前根树的安全、创建顺序快照。 */
  getTreeSnapshot(): ControlResult<AgentTreeSnapshot> {
    const monotonicAt = this.safeMonotonicNow();
    return controlSuccess(Object.freeze({
      tree_revision: this.treeRevision,
      nodes: Object.freeze(this.orderParentFirst(
        [...this.agents.values()].filter((record) => !record.scopeActorOnly),
      )
        .map((record) => this.snapshot(record, monotonicAt))),
    }));
  }

  /** child 监督端发布自身及全部后代，且不应用公开查询的祖先隐藏规则。 */
  getSupervisionSubtreeSnapshot(actor: TreeActor | unknown): ControlResult<SupervisionSubtreeSnapshot> {
    const resolved = this.resolveActor(actor);
    if (!resolved.ok) return resolved;
    const scope = resolved.data.record;
    if (scope === undefined) return controlFailure("invalid_argument");
    const records = [...this.agents.values()].filter((record) =>
      record.agentId === scope.agentId || this.isDescendantOf(record, scope.agentId),
    );
    const monotonicAt = this.safeMonotonicNow();
    return controlSuccess(Object.freeze({
      tree_revision: this.treeRevision,
      nodes: Object.freeze(this.orderParentFirst(records).map((record) => this.snapshot(record, monotonicAt))),
    }));
  }

  /** 根会话完全关闭后释放终止历史；未全部确认时保持原注册表不变。 */
  clearTerminatedRecords(): boolean {
    for (const record of this.agents.values()) {
      if (record.state !== "terminated") return false;
    }
    if (this.agents.size === 0) return true;
    this.agents.clear();
    this.terminationBarriers.clear();
    this.subtreeRevisions.clear();
    this.pendingSubtreeProjectionAgentIds.clear();
    this.notifyChange();
    return true;
  }

  /**
   * 原子接收直接子代理发布的完整安全子树。所有校验完成前不触碰本地注册表；
   * 迟到或重复的 subtree_revision 只被丢弃，不改变公开 tree_revision。
   */
  applySubtreeSnapshot(
    actor: TreeActor | unknown,
    input: SubtreeSnapshotInput | unknown,
  ): ControlResult<SubtreeSnapshotOutcome> {
    if (!isSubtreeSnapshotInput(input)) return controlFailure("invalid_argument");
    const parent = this.resolveActor(actor);
    if (!parent.ok) return parent;
    const scope = this.agents.get(input.scope_agent_id);
    if (scope === undefined) return controlFailure("agent_not_found");
    if (scope.parentAgentId !== parent.data.parentAgentId) return controlFailure("not_direct_child");
    const previousRevision = this.subtreeRevisions.get(scope.agentId) ?? 0;
    if (input.subtree_revision <= previousRevision) {
      return controlSuccess(Object.freeze({
        applied: false,
        scope_agent_id: scope.agentId,
        subtree_revision: previousRevision,
        tree_revision: this.treeRevision,
      }));
    }

    const parsed = this.validateSubtreeSnapshot(scope, input.nodes);
    if (!parsed.ok) return parsed;
    // begin_termination 的根权威响应与 child 本地屏障分属两个传输方向；
    // 响应前已读取的旧投影可以在根屏障之后抵达，但不能逆转该屏障。
    const barrierSupersededNodeIds = new Set<string>();
    const addedActiveChildren = new Map<string, number>();
    let addedActiveNodes = 0;
    for (const node of parsed.data) {
      const current = this.agents.get(node.agent_id);
      if (current !== undefined) {
        const isScopeNode = current.agentId === scope.agentId;
        if (
          !this.isDescendantOrSelf(current, scope.agentId)
          || current.parentAgentId !== node.parent_agent_id
          || current.templateId !== node.template_id
          || current.name !== node.name
          || current.depth !== node.depth
        ) return controlFailure("invalid_argument");
        if (
          !isScopeNode
          && current.state === "terminating"
          && this.isTerminationBarrierMember(current.agentId)
          && node.state !== "terminating"
          && node.state !== "terminated"
        ) {
          barrierSupersededNodeIds.add(current.agentId);
          continue;
        }
        if (
          (!isScopeNode && current.state === "terminated" && node.state !== "terminated")
          || (!isScopeNode
            && this.isTerminationBarrierMember(current.agentId)
            && node.state !== "terminating"
            && node.state !== "terminated")
        ) return controlFailure("invalid_argument");
        continue;
      }
      // 根权威只接受 reserve_child 已经预登记的身份；完整快照不能成为绕过
      // UUID/深度/两类配额裁决的第二条创建路径。
      if (this.authoritative) return controlFailure("invalid_argument");
      if (!isCanonicalUuidV4(node.agent_id) || this.issuedAgentIds.has(node.agent_id)) {
        return controlFailure("invalid_argument");
      }
      if (
        node.state !== "terminated"
        && (
          node.state !== "starting"
          || scope.state === "failed"
          || scope.state === "terminating"
          || scope.state === "terminated"
        )
      ) return controlFailure("invalid_argument");
      if (node.state === "terminated") continue;
      addedActiveNodes += 1;
      if (node.parent_agent_id !== null) {
        addedActiveChildren.set(
          node.parent_agent_id,
          (addedActiveChildren.get(node.parent_agent_id) ?? 0) + 1,
        );
      }
    }
    if (this.activeTreeAgentCount() + addedActiveNodes > this.config.maxAgentsPerTree) {
      return controlFailure("invalid_argument");
    }
    for (const [parentAgentId, count] of addedActiveChildren) {
      if (this.activeChildrenOf(parentAgentId) + count > this.config.maxChildrenPerAgent) {
        return controlFailure("invalid_argument");
      }
    }
    const existingIds = new Set(parsed.data.map((node) => node.agent_id));
    for (const record of this.agents.values()) {
      if (
        record.agentId === scope.agentId
        || !this.isDescendantOf(record, scope.agentId)
        || record.state === "terminated"
        || existingIds.has(record.agentId)
      ) continue;
      // reserve_child 先由根权威登记身份，再把 grant 返回 child。该响应前
      // 已读取的完整快照可以合法地暂时缺少尚未投影、甚至正回滚的身份。
      if (
        this.authoritative
        && this.pendingSubtreeProjectionAgentIds.has(record.agentId)
      ) continue;
      return controlFailure("invalid_argument");
    }

    const monotonicAt = this.safeMonotonicNow();
    const changes: Array<{
      readonly record: AgentRecord;
      readonly node: AgentSnapshot;
      readonly contextOnly: boolean;
    }> = [];
    const additions: AgentRecord[] = [];
    const additionById = new Map<string, AgentRecord>();
    let scopeContextUsage: AgentContextUsageInput | undefined;
    for (const node of parsed.data) {
      const current = this.agents.get(node.agent_id);
      if (current === undefined) {
        // terminated 节点可以作为历史身份保留；活动后代必须从 starting
        // 建档，不能借完整快照直接伪造 working/failed/idle。
        if (node.state !== "terminated" && node.state !== "starting") {
          return controlFailure("invalid_argument");
        }
        const parentRecord = node.agent_id === scope.agentId
          ? undefined
          : this.agents.get(node.parent_agent_id ?? "")
            ?? additionById.get(node.parent_agent_id ?? "");
        if (node.agent_id !== scope.agentId && parentRecord === undefined) return controlFailure("invalid_argument");
        const added: AgentRecord = {
          agentId: node.agent_id,
          parentAgentId: node.agent_id === scope.agentId ? scope.parentAgentId : node.parent_agent_id,
          templateId: node.template_id,
          name: node.name,
          depth: node.depth,
          managementEnabled: parentRecord?.managementEnabled ?? scope.managementEnabled,
          state: node.state,
          revision: node.revision,
          lifecycleGeneration: 0,
          createdAt: node.created_at,
          workingStartedAt: isWorkingTimeState(node.state) ? monotonicAt : undefined,
          accumulatedWorkingElapsedMs: node.working_elapsed_ms ?? 0,
          contextWindowTokens: node.context_window_tokens,
          contextUsagePercent: node.context_usage_percent,
          activity: activityForState(node.state, node.activity),
          error: cloneAgentFault(node.error),
          terminationResult: node.termination_result,
          terminationHadFailure: snapshotHadTerminationFailure(node),
          terminationHadIncompleteCleanup: snapshotHadIncompleteCleanup(node),
          scopeActorOnly: false,
        };
        additions.push(added);
        additionById.set(added.agentId, added);
        continue;
      }
      // 作用域根的生命周期只由其直接父 RpcSupervisor 裁决。child 快照中的
      // 同一节点只允许补充 Pi 自身提供的上下文窗口事实，不能越过生命周期屏障。
      if (current.agentId === scope.agentId) {
        if (node.context_window_tokens !== undefined) {
          scopeContextUsage = Object.freeze({
            context_window_tokens: node.context_window_tokens,
            ...(node.context_usage_percent === undefined
              ? {}
              : { context_usage_percent: node.context_usage_percent }),
          });
        }
        continue;
      }
      if (barrierSupersededNodeIds.has(current.agentId)) continue;
      if (current.state === "terminated" && node.revision !== current.revision) {
        // terminated 是吸收态；终止后的远端修订不能重写资源事实。
        return controlFailure("invalid_argument");
      }
      // 快照是生命周期事实的投影，不是第二条写入路径。已有节点的状态
      // 改变必须仍落在七状态合法转换矩阵内，不能借 revision 越过屏障或吸收态。
      if (current.state !== node.state && !canTransition(current.state, node.state)) {
        return controlFailure("invalid_argument");
      }
      if (node.revision < current.revision) return controlFailure("invalid_argument");
      const hiddenParent = current.parentAgentId === scope.parentAgentId
        && current.agentId === scope.agentId;
      if (
        node.revision === current.revision
        && !sameSnapshotExceptContext(current, node, hiddenParent)
      ) return controlFailure("invalid_argument");
      if (!sameSnapshot(current, node, hiddenParent)) {
        // 上下文窗口由各层 Pi 会话独立观测，不属于生命周期修订的事实域。
        // 同修订差异只合并该观测，不能借此重写生命周期派生字段。
        changes.push({
          record: current,
          node,
          contextOnly: node.revision === current.revision,
        });
      }
    }
    for (const record of additions) {
      this.agents.set(record.agentId, record);
      this.issuedAgentIds.add(record.agentId);
    }
    for (const change of changes) {
      if (change.contextOnly) {
        change.record.contextWindowTokens = change.node.context_window_tokens;
        change.record.contextUsagePercent = change.node.context_usage_percent;
      } else {
        this.applySnapshotToRecord(change.record, change.node, monotonicAt);
      }
    }
    const scopeContextChanged = scopeContextUsage === undefined
      || scope.state === "failed"
      || scope.state === "terminating"
      || scope.state === "terminated"
      ? false
      : this.applyMutation(scope, {
          contextWindowTokens: scopeContextUsage.context_window_tokens,
          contextUsagePercent: scopeContextUsage.context_usage_percent ?? null,
        }, safeWallClockNow(this.now), monotonicAt);
    this.subtreeRevisions.set(scope.agentId, input.subtree_revision);
    if (this.authoritative) {
      for (const node of parsed.data) this.pendingSubtreeProjectionAgentIds.delete(node.agent_id);
    }
    if (additions.length > 0 || changes.length > 0 || scopeContextChanged) {
      this.treeRevision += 1;
      this.notifyChange();
    }
    return controlSuccess(Object.freeze({
      applied: additions.length > 0 || changes.length > 0 || scopeContextChanged,
      scope_agent_id: scope.agentId,
      subtree_revision: input.subtree_revision,
      tree_revision: this.treeRevision,
    }));
  }

  private validateSubtreeSnapshot(
    scope: AgentRecord,
    nodes: readonly AgentSnapshot[],
  ): ControlResult<readonly AgentSnapshot[]> {
    const normalizedNodes: AgentSnapshot[] = [];
    for (const node of nodes) {
      const normalized = parseAgentSnapshot(node);
      if (normalized === undefined) return controlFailure("invalid_argument");
      normalizedNodes.push(normalized);
    }
    if (normalizedNodes.length === 0 || normalizedNodes[0]?.agent_id !== scope.agentId) {
      return controlFailure("invalid_argument");
    }
    const ids = new Set<string>();
    for (let index = 0; index < normalizedNodes.length; index += 1) {
      const node = normalizedNodes[index]!;
      if (ids.has(node.agent_id)) return controlFailure("invalid_argument");
      ids.add(node.agent_id);
      if (node.agent_id === scope.agentId) {
        if (node.parent_agent_id !== scope.parentAgentId || node.depth !== scope.depth) {
          return controlFailure("invalid_argument");
        }
        if (node.template_id !== scope.templateId || node.name !== scope.name) return controlFailure("invalid_argument");
      } else {
        if (node.parent_agent_id === null) return controlFailure("invalid_argument");
        const parentIndex = normalizedNodes.findIndex((candidate) => candidate.agent_id === node.parent_agent_id);
        if (
          node.depth > this.config.maxDepth
          || parentIndex < 0
          || parentIndex >= index
          || node.depth !== normalizedNodes[parentIndex]!.depth + 1
        ) {
          return controlFailure("invalid_argument");
        }
      }
    }
    return controlSuccess(Object.freeze(normalizedNodes.map((node) => Object.freeze({
      ...node,
      ...(node.error === undefined ? {} : { error: cloneAgentFault(node.error)! }),
    }))));
  }

  private applySnapshotToRecord(
    record: AgentRecord,
    node: AgentSnapshot,
    monotonicAt: number,
  ): void {
    const stateChanged = record.state !== node.state;
    const previousWorkingElapsed = this.workingElapsedValue(record, monotonicAt);
    record.state = node.state;
    record.revision = node.revision;
    record.createdAt = node.created_at;
    record.activity = activityForState(node.state, node.activity);
    record.error = cloneAgentFault(node.error);
    record.terminationHadFailure ||= snapshotHadTerminationFailure(node);
    record.terminationHadIncompleteCleanup ||= snapshotHadIncompleteCleanup(node);
    record.terminationResult = node.state === "terminated"
      ? terminationResultFromHistory(
          record.terminationHadFailure,
          record.terminationHadIncompleteCleanup,
        )
      : undefined;
    if (stateChanged) record.lifecycleGeneration += 1;
    record.accumulatedWorkingElapsedMs = node.working_elapsed_ms ?? previousWorkingElapsed;
    record.workingStartedAt = isWorkingTimeState(node.state) ? monotonicAt : undefined;
    if (node.context_window_tokens !== undefined) {
      record.contextWindowTokens = node.context_window_tokens;
      record.contextUsagePercent = node.context_usage_percent;
    }
  }

  /** 按调用者作用域裁剪安全树快照，不触发 RPC 或生命周期变化。 */
  getTreeSnapshotFor(actor: TreeActor | unknown): ControlResult<ScopedAgentTreeSnapshot> {
    const resolved = this.resolveActor(actor);
    if (!resolved.ok) return resolved;
    const scope = resolved.data.record;
    const monotonicAt = this.safeMonotonicNow();
    const records = scope === undefined
      ? Array.from(this.agents.values())
      : Array.from(this.agents.values()).filter((record) =>
        record.agentId === scope.agentId || this.isDescendantOf(record, scope.agentId),
      );
    const nodes = this.orderParentFirst(records).map((record) => {
      const snapshot = this.snapshot(record, monotonicAt);
      if (scope !== undefined && record.agentId === scope.agentId) {
        return Object.freeze({ ...snapshot, parent_agent_id: null });
      }
      if (scope !== undefined && record.parentAgentId !== null && !records.some((candidate) => candidate.agentId === record.parentAgentId)) {
        return Object.freeze({ ...snapshot, parent_agent_id: null });
      }
      return snapshot;
    });
    const scoped = Object.freeze({
      scope: Object.freeze(scope === undefined
        ? { kind: "root" as const }
        : { kind: "subtree" as const, agent_id: scope.agentId }),
      tree_revision: this.treeRevision,
      nodes: Object.freeze(nodes),
    });
    return controlSuccess(scoped);
  }

  /** 返回配额事实；终止记录仍可查询但不会计入这些数字。 */
  getQuotaSnapshot(): ControlResult<QuotaSnapshot> {
    return controlSuccess(Object.freeze({
      active_tree_agents: this.activeTreeAgentCount(),
      max_tree_agents: this.config.maxAgentsPerTree,
      active_children_of_root: this.activeChildrenOf(null),
      max_children_per_agent: this.config.maxChildrenPerAgent,
    }));
  }

  private resolveActor(actor: unknown): ControlResult<ResolvedActor> {
    if (typeof actor !== "object" || actor === null) return controlFailure("invalid_argument");
    const candidate = actor as Record<string, unknown>;
    if (candidate.kind === "root") {
      return controlSuccess({
        parentAgentId: null,
        depth: 0,
        managementEnabled: this.rootManagementEnabled,
        record: undefined,
      });
    }
    if (candidate.kind !== "agent") return controlFailure("invalid_argument");
    const agentId = candidate.agent_id;
    if (!isCanonicalUuid(agentId)) return controlFailure("invalid_argument");
    const record = this.agents.get(agentId);
    if (record === undefined) return controlFailure("agent_not_found");
    return controlSuccess({
      parentAgentId: record.agentId,
      depth: record.depth,
      managementEnabled: record.managementEnabled,
      record,
    });
  }

  private findAgent(agentId: unknown): ControlResult<AgentRecord> {
    if (!isCanonicalUuid(agentId)) return controlFailure("invalid_argument");
    const record = this.agents.get(agentId);
    return record === undefined ? controlFailure("agent_not_found") : controlSuccess(record);
  }

  private allocateAgentId(): string | undefined {
    for (let attempt = 0; attempt < MAX_ID_GENERATION_ATTEMPTS; attempt += 1) {
      let candidate: unknown;
      try {
        candidate = this.idFactory();
      } catch {
        continue;
      }
      if (!isCanonicalUuidV4(candidate) || this.issuedAgentIds.has(candidate)) continue;
      return candidate;
    }
    return undefined;
  }

  private activeTreeAgentCount(): number {
    let count = 0;
    for (const record of this.agents.values()) {
      if (!record.scopeActorOnly && isQuotaConsumingState(record.state)) count += 1;
    }
    return count;
  }

  private activeChildrenOf(parentAgentId: string | null): number {
    let count = 0;
    for (const record of this.agents.values()) {
      if (!record.scopeActorOnly && record.parentAgentId === parentAgentId && isQuotaConsumingState(record.state)) count += 1;
    }
    return count;
  }

  private allDirectChildrenTerminated(parentAgentId: string): boolean {
    for (const record of this.agents.values()) {
      if (record.parentAgentId === parentAgentId && record.state !== "terminated") return false;
    }
    return true;
  }

  private beginTerminationBarrierInternal(
    targetAgentId: string,
    preserveTargetFailure: boolean,
  ): ControlResult<TerminationBarrierOutcome> {
    const existing = this.terminationBarriers.get(targetAgentId)
      ?? [...this.terminationBarriers.values()].find((barrier) => barrier.memberIds.includes(targetAgentId));
    if (existing !== undefined) {
      let changed = false;
      if (!preserveTargetFailure && existing.targetAgentId === targetAgentId) {
        const existingTarget = this.agents.get(targetAgentId);
        if (existingTarget?.state === "failed") {
          changed = this.mutate(existingTarget, {
            state: "terminating",
            clearError: true,
          });
        }
      }
      return controlSuccess(this.barrierOutcome(existing, changed));
    }
    const target = this.agents.get(targetAgentId);
    if (target === undefined) return controlFailure("agent_not_found");
    const records = this.collectSubtree(targetAgentId);
    const memberRecords = this.orderDescendantsFirst(records.filter((record) => record.state !== "terminated"));
    const memberIds = Object.freeze(memberRecords.map((record) => record.agentId));
    const changed = this.mutateMany(memberRecords, (record) => {
      if (preserveTargetFailure && record.agentId === targetAgentId) return {};
      return {
        state: "terminating",
        clearError: true,
      };
    });
    const barrier: TerminationBarrierRecord = Object.freeze({
      barrierId: `termination_${targetAgentId}`,
      targetAgentId,
      memberIds,
      createdTreeRevision: this.treeRevision,
    });
    this.terminationBarriers.set(targetAgentId, barrier);
    return controlSuccess(this.barrierOutcome(barrier, changed));
  }

  private barrierOutcome(barrier: TerminationBarrierRecord, changed: boolean): TerminationBarrierOutcome {
    return Object.freeze({
      barrier_id: barrier.barrierId,
      agent_id: barrier.targetAgentId,
      agent_ids: barrier.memberIds,
      changed,
      tree_revision: changed ? this.treeRevision : barrier.createdTreeRevision,
    });
  }

  private collectSubtree(agentId: string): AgentRecord[] {
    return [...this.agents.values()].filter((record) =>
      record.agentId === agentId || this.isDescendantOf(record, agentId),
    );
  }

  private orderDescendantsFirst(records: readonly AgentRecord[]): AgentRecord[] {
    const insertionOrder = new Map<string, number>();
    let index = 0;
    for (const record of this.agents.values()) insertionOrder.set(record.agentId, index++);
    return [...records].sort((left, right) => {
      if (left.depth !== right.depth) return right.depth - left.depth;
      return (insertionOrder.get(left.agentId) ?? 0) - (insertionOrder.get(right.agentId) ?? 0);
    });
  }

  private orderParentFirst(records: readonly AgentRecord[]): AgentRecord[] {
    const insertionOrder = new Map<string, number>();
    let index = 0;
    for (const record of this.agents.values()) insertionOrder.set(record.agentId, index++);
    return [...records].sort((left, right) => {
      if (left.depth !== right.depth) return left.depth - right.depth;
      return (insertionOrder.get(left.agentId) ?? 0) - (insertionOrder.get(right.agentId) ?? 0);
    });
  }

  private failRuntimeAndOrphans(
    record: AgentRecord,
    errorCode: AgentFaultCode,
    errorDetails?: StartupDiagnosticDetails,
  ): boolean {
    const descendants = this.collectSubtree(record.agentId)
      .filter((candidate) => candidate.agentId !== record.agentId && candidate.state !== "terminated");
    const members = [record, ...this.orderDescendantsFirst(descendants)];
    const applied = this.mutateMany(members, (candidate) => candidate.agentId === record.agentId
      ? {
          state: "failed",
          errorCode,
          ...(errorDetails === undefined ? {} : { errorDetails }),
        }
      : {
          state: "terminating",
          clearError: true,
        });
    const barrier: TerminationBarrierRecord = Object.freeze({
      barrierId: `termination_${record.agentId}`,
      targetAgentId: record.agentId,
      memberIds: Object.freeze(this.orderDescendantsFirst(members).map((candidate) => candidate.agentId)),
      createdTreeRevision: this.treeRevision,
    });
    this.terminationBarriers.set(record.agentId, barrier);
    return applied;
  }

  /** 启动残骸先留存失败事实，再在同一顺序域建立不可逆清理屏障。 */
  private failStartingNode(
    record: AgentRecord,
    errorCode: AgentFaultCode,
    errorDetails?: StartupDiagnosticDetails,
  ): boolean {
    const failedApplied = this.mutate(record, {
      state: "failed",
      errorCode,
      ...(errorDetails === undefined ? {} : { errorDetails }),
    });
    if (!this.terminationBarriers.has(record.agentId)) {
      const members = this.orderDescendantsFirst(this.collectSubtree(record.agentId));
      this.terminationBarriers.set(record.agentId, Object.freeze({
        barrierId: `termination_${record.agentId}`,
        targetAgentId: record.agentId,
        memberIds: Object.freeze(members.filter((candidate) => candidate.state !== "terminated").map((candidate) => candidate.agentId)),
        createdTreeRevision: this.treeRevision,
      }));
    }
    // startup_failed 只记录真实启动故障；后续资源清理由显式 terminate_accepted
    // 建立 terminating 屏障，避免把清理意图伪装成启动事实。
    return failedApplied;
  }

  private mutate(record: AgentRecord, mutation: PublicMutation): boolean {
    return this.mutateMany([record], () => mutation);
  }

  /** 将多个节点的公开事实批量提交为一个 tree_revision。 */
  private mutateMany(
    records: readonly AgentRecord[],
    mutationFor: (record: AgentRecord) => PublicMutation,
  ): boolean {
    const createdAt = safeWallClockNow(this.now);
    const monotonicAt = this.safeMonotonicNow();
    let changed = false;
    for (const record of records) {
      if (this.applyMutation(record, mutationFor(record), createdAt, monotonicAt)) changed = true;
    }
    if (!changed) return false;
    this.treeRevision += 1;
    this.notifyChange();
    return true;
  }

  private applyMutation(
    record: AgentRecord,
    mutation: PublicMutation,
    createdAt: string,
    monotonicAt: number,
  ): boolean {
    const nextState = mutation.state ?? record.state;
    const nextContextWindowTokens = mutation.contextWindowTokens === undefined
      ? record.contextWindowTokens
      : mutation.contextWindowTokens === null ? undefined : mutation.contextWindowTokens;
    const nextContextUsagePercent = nextContextWindowTokens === undefined
      ? undefined
      : mutation.contextUsagePercent === undefined
        ? record.contextUsagePercent
        : mutation.contextUsagePercent === null ? undefined : mutation.contextUsagePercent;
    const nextError = mutation.errorCode === undefined
      ? (mutation.clearError === true ? undefined : record.error)
      : this.createFault(mutation.errorCode, mutation.errorDetails);
    const nextErrorCode = nextError?.code;
    const requestedActivity = mutation.activity === undefined
      ? record.activity
      : mutation.activity === null
        ? undefined
        : mutation.activity;
    const stateChanged = nextState !== record.state;
    const wasWorking = isWorkingTimeState(record.state);
    const willBeWorking = isWorkingTimeState(nextState);
    const nextActivity = activityForState(nextState, requestedActivity);
    const contextChanged = nextContextWindowTokens !== record.contextWindowTokens
      || nextContextUsagePercent !== record.contextUsagePercent;
    const errorChanged = JSON.stringify(nextError) !== JSON.stringify(record.error);
    const activityChanged = JSON.stringify(nextActivity) !== JSON.stringify(record.activity);
    if (!stateChanged && !contextChanged && !errorChanged && !activityChanged) return false;

    const workingElapsedAtMutation = this.workingElapsedValue(record, monotonicAt);
    record.state = nextState;
    record.contextWindowTokens = nextContextWindowTokens;
    record.contextUsagePercent = nextContextUsagePercent;
    record.activity = nextActivity;
    record.error = nextError;
    if (wasWorking && !willBeWorking) {
      record.accumulatedWorkingElapsedMs = workingElapsedAtMutation;
      record.workingStartedAt = undefined;
    } else if (!wasWorking && willBeWorking) {
      record.workingStartedAt = monotonicAt;
    }
    if (nextState === "failed") record.terminationHadFailure = true;
    if (nextErrorCode === "termination_incomplete") record.terminationHadIncompleteCleanup = true;
    if (stateChanged && nextState === "terminated") {
      record.terminationResult = terminationResultFromHistory(
        record.terminationHadFailure,
        record.terminationHadIncompleteCleanup,
      );
    }
    // 生命周期代际只随状态转换推进。pending 事件仍在节点顺序域内串行处理，
    // 允许同一状态快照上并行获准的多条消息各自完成，不互相误判为迟到。
    if (stateChanged) record.lifecycleGeneration += 1;
    if (stateChanged && nextState === "idle" && record.createdAt === undefined) {
      record.createdAt = createdAt;
    }
    record.revision += 1;
    return true;
  }

  private isDescendantOf(record: AgentRecord, ancestorAgentId: string): boolean {
    let parentId = record.parentAgentId;
    const visited = new Set<string>();
    while (parentId !== null && !visited.has(parentId)) {
      if (parentId === ancestorAgentId) return true;
      visited.add(parentId);
      parentId = this.agents.get(parentId)?.parentAgentId ?? null;
    }
    return false;
  }

  private isDescendantOrSelf(record: AgentRecord, ancestorAgentId: string): boolean {
    return record.agentId === ancestorAgentId || this.isDescendantOf(record, ancestorAgentId);
  }

  private isTerminationBarrierMember(agentId: string): boolean {
    return [...this.terminationBarriers.values()].some((barrier) => barrier.memberIds.includes(agentId));
  }

  private notifyLifecycleFact(
    agentId: string,
    event: AgentLifecycleEvent,
  ): void {
    const errorCode = "error_code" in event ? event.error_code : undefined;
    const errorDetails = "error_details" in event ? event.error_details : undefined;
    const details = errorDetails === undefined
      ? undefined
      : normalizeStartupDiagnosticDetails(errorCode, errorDetails);
    const fact = Object.freeze({
      agent_id: agentId,
      type: event.type,
      expected_generation: event.expected_generation,
      ...(errorCode === undefined ? {} : { error_code: errorCode }),
      ...(details === undefined || !hasStartupDiagnosticDetails(details)
        ? {}
        : { error_details: details }),
    }) as AppliedLifecycleFact;
    for (const listener of this.lifecycleListeners) {
      try {
        listener(fact);
      } catch {
        // 事实观察者异常不能改变已经完成的生命周期裁决。
      }
    }
  }

  private notifyChange(): void {
    for (const listener of this.changeListeners) {
      try {
        listener();
      } catch {
        // 只读观察者异常不能改变身份、配额或生命周期事实。
      }
    }
  }

  private createFault(code: AgentFaultCode, details?: StartupDiagnosticDetails): AgentFault {
    return createAgentFault(code, details);
  }

  private safeMonotonicNow(): number {
    try {
      const value = this.monotonicNow();
      return Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  }

  private workingElapsedValue(record: AgentRecord, monotonicAt: number): number {
    if (!isWorkingTimeState(record.state) || record.workingStartedAt === undefined) {
      return record.accumulatedWorkingElapsedMs;
    }
    return record.accumulatedWorkingElapsedMs
      + Math.max(0, monotonicAt - record.workingStartedAt);
  }

  private workingElapsed(record: AgentRecord, monotonicAt: number): number {
    return Math.max(0, Math.round(this.workingElapsedValue(record, monotonicAt)));
  }

  private snapshot(record: AgentRecord, monotonicAt = this.safeMonotonicNow()): AgentSnapshot {
    const common = {
      agent_id: record.agentId,
      parent_agent_id: record.parentAgentId,
      template_id: record.templateId,
      name: record.name,
      depth: record.depth,
      state: record.state,
      revision: record.revision,
    } as const;
    const base = record.createdAt === undefined
      ? common
      : {
          ...common,
          created_at: record.createdAt,
          working_elapsed_ms: this.workingElapsed(record, monotonicAt),
        };
    const withContextUsage = record.createdAt === undefined || record.contextWindowTokens === undefined
      ? base
      : {
          ...base,
          context_window_tokens: record.contextWindowTokens,
          ...(record.contextUsagePercent === undefined
            ? {}
            : { context_usage_percent: record.contextUsagePercent }),
        };
    const withActivity = record.activity === undefined
      ? withContextUsage
      : { ...withContextUsage, activity: Object.freeze({ ...record.activity }) };
    const withTerminationResult = record.terminationResult === undefined
      ? withActivity
      : { ...withActivity, termination_result: record.terminationResult };
    if (record.error === undefined) return Object.freeze(withTerminationResult);
    return Object.freeze({ ...withTerminationResult, error: cloneAgentFault(record.error)! });
  }

  private outcome(
    record: AgentRecord,
    applied: boolean,
    diagnostic?: LifecycleEventOutcome["diagnostic"],
  ): LifecycleEventOutcome {
    return Object.freeze({
      applied,
      node: this.snapshot(record),
      lifecycle_generation: record.lifecycleGeneration,
      tree_revision: this.treeRevision,
      ...(diagnostic === undefined ? {} : { diagnostic }),
    });
  }
}
