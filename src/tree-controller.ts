import { randomUUID } from "node:crypto";
import type { RuntimeConfig } from "./root-runtime-context.ts";

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

/** 公开控制面允许返回的稳定错误码闭集。 */
export const PUBLIC_ERROR_CODES = Object.freeze([
  "invalid_argument",
  "agent_not_found",
  "not_direct_child",
  "template_not_found",
  "template_invalid",
  "template_capability_unavailable",
  "max_depth_reached",
  "max_children_reached",
  "max_tree_agents_reached",
  "spawn_failed",
  "spawn_timeout",
  "agent_unavailable",
  "message_delivery_failed",
  "termination_incomplete",
  "internal_error",
] as const);

export type PublicErrorCode = (typeof PUBLIC_ERROR_CODES)[number];

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

export interface PublicControlError {
  readonly code: PublicErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, never>>;
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

const EMPTY_DETAILS: Readonly<Record<string, never>> = Object.freeze({});

const ERROR_METADATA: Readonly<Record<PublicErrorCode, Readonly<{
  message: string;
  retryable: boolean;
}>>> = Object.freeze({
  invalid_argument: Object.freeze({ message: "参数无效", retryable: false }),
  agent_not_found: Object.freeze({ message: "代理标识未注册", retryable: false }),
  not_direct_child: Object.freeze({ message: "目标不是直接子代理", retryable: false }),
  template_not_found: Object.freeze({ message: "未找到代理模板", retryable: false }),
  template_invalid: Object.freeze({ message: "代理模板无效", retryable: false }),
  template_capability_unavailable: Object.freeze({ message: "代理管理能力不可用", retryable: false }),
  max_depth_reached: Object.freeze({ message: "已达到最大代理深度", retryable: false }),
  max_children_reached: Object.freeze({ message: "直接子代理名额已满", retryable: true }),
  max_tree_agents_reached: Object.freeze({ message: "代理树名额已满", retryable: true }),
  spawn_failed: Object.freeze({ message: "代理启动失败", retryable: false }),
  spawn_timeout: Object.freeze({ message: "代理启动超时", retryable: true }),
  agent_unavailable: Object.freeze({ message: "代理当前不可用", retryable: false }),
  message_delivery_failed: Object.freeze({ message: "消息未获确认接收", retryable: false }),
  termination_incomplete: Object.freeze({ message: "代理资源尚未完全回收", retryable: true }),
  internal_error: Object.freeze({ message: "控制器内部错误", retryable: false }),
});

/** 所有公开失败均从此处创建，避免把路径、异常或句柄带出控制器。 */
export function controlFailure(code: PublicErrorCode): ControlFailure {
  const metadata = ERROR_METADATA[code];
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      code,
      message: metadata.message,
      retryable: metadata.retryable,
      details: EMPTY_DETAILS,
    }),
  });
}

function controlSuccess<T>(data: T): ControlSuccess<T> {
  return Object.freeze({ ok: true, data });
}

const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CANONICAL_UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_ID_GENERATION_ATTEMPTS = 32;

/** 判断输入是否为 RFC 9562 传输用的小写 canonical UUID 文本。 */
export function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_UUID_PATTERN.test(value);
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

export type TemplateSubagentCapability = "inherit" | "disabled";

export interface ReserveStartingChildInput {
  readonly templateId: string;
  readonly name: string;
  readonly subagents?: TemplateSubagentCapability;
}

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
  readonly error?: AgentFault;
}

export interface AgentTreeSnapshot {
  readonly tree_revision: number;
  readonly observed_at: string;
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
}

/** 监督器可以归一化并提交给树控制器的生命周期事实闭集。 */
export const AGENT_LIFECYCLE_EVENT_TYPES = Object.freeze([
  "startup_ready",
  "startup_failed",
  "message_admitted",
  "message_rejected",
  "message_delivery_failed",
  "message_cancelled",
  "prompt_accepted",
  "steering_accepted",
  "agent_settled",
  "interrupt_accepted",
  "abort_completed",
  "runtime_failed",
  "termination_requested",
  "termination_incomplete",
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

export interface TreeControllerOptions {
  readonly config: Pick<
    RuntimeConfig,
    "maxDepth" | "maxChildrenPerAgent" | "maxAgentsPerTree" | "waitTimeoutMs"
  >;
  readonly idFactory?: () => string;
  readonly now?: () => Date;
  readonly monotonicNow?: () => number;
  readonly rootManagementEnabled?: boolean;
}

interface AgentRecord {
  readonly agentId: string;
  readonly parentAgentId: string | null;
  readonly templateId: string;
  readonly name: string;
  readonly depth: number;
  readonly managementEnabled: boolean;
  state: AgentLifecycleState;
  pendingMessageCount: number;
  revision: number;
  observedAt: string;
  lifecycleGeneration: number;
  createdAt: string | undefined;
  lifecycleStartedAt: number | undefined;
  frozenLifecycleElapsedMs: number | undefined;
  error: AgentFault | undefined;
}

interface ResolvedActor {
  readonly parentAgentId: string | null;
  readonly depth: number;
  readonly managementEnabled: boolean;
  readonly record: AgentRecord | undefined;
}

interface PublicMutation {
  readonly state?: AgentLifecycleState;
  readonly pendingMessageCount?: number;
  readonly errorCode?: AgentFaultCode;
  readonly clearError?: boolean;
}

function isAgentFaultCode(value: unknown): value is AgentFaultCode {
  return typeof value === "string" && (AGENT_FAULT_CODES as readonly string[]).includes(value);
}

function isLifecycleEvent(value: unknown): value is AgentLifecycleEvent {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const type = candidate.type;
  if (typeof type !== "string") return false;
  const supported = [
    "startup_ready",
    "startup_failed",
    "message_admitted",
    "message_rejected",
    "message_delivery_failed",
    "message_cancelled",
    "prompt_accepted",
    "steering_accepted",
    "agent_settled",
    "interrupt_accepted",
    "abort_completed",
    "runtime_failed",
    "termination_requested",
    "termination_incomplete",
    "resources_confirmed",
  ];
  if (!supported.includes(type)) return false;
  if (
    !("expected_generation" in candidate) ||
    !Number.isSafeInteger(candidate.expected_generation) ||
    (candidate.expected_generation as number) < 0
  ) {
    return false;
  }
  if (
    "error_code" in candidate &&
    candidate.error_code !== undefined &&
    !isAgentFaultCode(candidate.error_code)
  ) {
    return false;
  }
  return true;
}

function validReserveInput(value: unknown): value is ReserveStartingChildInput {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.templateId !== "string" || typeof candidate.name !== "string") return false;
  return candidate.subagents === undefined || candidate.subagents === "inherit" || candidate.subagents === "disabled";
}

function safeObservedAt(now: () => Date): string {
  try {
    const value = now();
    if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  } catch {
    // 时钟异常不能把异常内容进入公开控制面。
  }
  return new Date(0).toISOString();
}

function isManagementState(state: AgentLifecycleState): boolean {
  return state === "idle" || state === "working" || state === "interrupting";
}

function isQuotaConsumingState(state: AgentLifecycleState): boolean {
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
  private readonly agents = new Map<string, AgentRecord>();
  private readonly issuedAgentIds = new Set<string>();
  private readonly changeListeners = new Set<() => void>();
  private treeRevision = 0;
  private treeObservedAt = new Date(0).toISOString();

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
  }

  /** 只读观察树事实变化；观察者异常不会影响控制器顺序域。 */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
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
        && input.subagents !== "disabled"
        && depth < this.config.maxDepth,
      state: "starting",
      pendingMessageCount: 0,
      revision: 1,
      observedAt: safeObservedAt(this.now),
      lifecycleGeneration: 0,
      createdAt: undefined,
      lifecycleStartedAt: undefined,
      frozenLifecycleElapsedMs: undefined,
      error: undefined,
    };

    // 写入注册表即完成配额预留，之后任何同步竞争者都会看到该节点。
    this.agents.set(agentId, record);
    this.issuedAgentIds.add(agentId);
    this.treeRevision += 1;
    this.treeObservedAt = record.observedAt;
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
      return controlSuccess(this.outcome(record, false));
    }

    let applied = false;
    switch (event.type) {
      case "startup_ready":
        if (record.state === "starting") applied = this.mutate(record, { state: "idle" });
        break;
      case "startup_failed":
        if (record.state === "starting") {
          applied = this.failStartingNode(record, eventFaultCode(event, "spawn_failed"));
        }
        break;
      case "message_admitted":
        if (record.state === "idle" || record.state === "working" || record.state === "interrupting") {
          applied = this.mutate(record, { pendingMessageCount: record.pendingMessageCount + 1 });
        }
        break;
      case "message_rejected":
      case "message_delivery_failed":
      case "message_cancelled":
        if (record.pendingMessageCount > 0 && record.state !== "failed" && record.state !== "terminated") {
          applied = this.mutate(record, { pendingMessageCount: record.pendingMessageCount - 1 });
        }
        break;
      case "prompt_accepted":
        if (record.state === "idle") {
          applied = this.mutate(record, {
            state: "working",
            pendingMessageCount: Math.max(0, record.pendingMessageCount - 1),
          });
        }
        break;
      case "steering_accepted":
        if (
          (record.state === "working" || record.state === "interrupting") &&
          record.pendingMessageCount > 0
        ) {
          applied = this.mutate(record, { pendingMessageCount: record.pendingMessageCount - 1 });
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
      case "abort_completed":
        // abort 响应不是 settle 事实，故意不改变生命周期。
        break;
      case "runtime_failed":
        if (record.state === "starting") {
          applied = this.failStartingNode(record, eventFaultCode(event, "spawn_failed"));
        } else if (
          record.state === "idle" ||
          record.state === "working" ||
          record.state === "interrupting"
        ) {
          applied = this.mutate(record, {
            state: "failed",
            pendingMessageCount: 0,
            errorCode: eventFaultCode(event, "spawn_failed"),
          });
        }
        break;
      case "termination_requested":
        if (record.state !== "terminated" && record.state !== "terminating") {
          // 运行故障是历史诊断；进入终止阶段后仅暴露清理是否完成。
          applied = this.mutate(record, { state: "terminating", clearError: true });
        }
        break;
      case "termination_incomplete":
        if (record.state === "terminating") {
          applied = this.mutate(record, { errorCode: "termination_incomplete" });
        }
        break;
      case "resources_confirmed":
        if (record.state === "terminating" && this.allDirectChildrenTerminated(record.agentId)) {
          applied = this.mutate(record, {
            state: "terminated",
            pendingMessageCount: 0,
            clearError: true,
          });
        }
        break;
    }
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

  /** 返回整个当前根树的安全、创建顺序快照。 */
  getTreeSnapshot(): ControlResult<AgentTreeSnapshot> {
    const monotonicAt = this.safeMonotonicNow();
    return controlSuccess(Object.freeze({
      tree_revision: this.treeRevision,
      observed_at: this.treeObservedAt,
      nodes: Object.freeze(Array.from(this.agents.values(), (record) => this.snapshot(record, monotonicAt))),
    }));
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
    const nodes = records.map((record) => {
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
      observed_at: this.treeObservedAt,
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
      if (isQuotaConsumingState(record.state)) count += 1;
    }
    return count;
  }

  private activeChildrenOf(parentAgentId: string | null): number {
    let count = 0;
    for (const record of this.agents.values()) {
      if (record.parentAgentId === parentAgentId && isQuotaConsumingState(record.state)) count += 1;
    }
    return count;
  }

  private allDirectChildrenTerminated(parentAgentId: string): boolean {
    for (const record of this.agents.values()) {
      if (record.parentAgentId === parentAgentId && record.state !== "terminated") return false;
    }
    return true;
  }

  /** 启动残骸先留存失败事实，再在同一顺序域建立不可逆清理屏障。 */
  private failStartingNode(record: AgentRecord, errorCode: AgentFaultCode): boolean {
    const failedApplied = this.mutate(record, {
      state: "failed",
      pendingMessageCount: 0,
      errorCode,
    });
    const terminatingApplied = this.mutate(record, { state: "terminating" });
    return failedApplied || terminatingApplied;
  }

  private mutate(record: AgentRecord, mutation: PublicMutation): boolean {
    const nextState = mutation.state ?? record.state;
    const nextPending = mutation.pendingMessageCount ?? record.pendingMessageCount;
    const nextErrorCode = mutation.errorCode === undefined
      ? (mutation.clearError === true ? undefined : record.error?.code)
      : mutation.errorCode;
    const stateChanged = nextState !== record.state;
    const pendingChanged = nextPending !== record.pendingMessageCount;
    const errorChanged = nextErrorCode !== record.error?.code;
    if (!stateChanged && !pendingChanged && !errorChanged) return false;

    const observedAt = safeObservedAt(this.now);
    const monotonicAt = this.safeMonotonicNow();
    const elapsedAtMutation = this.lifecycleElapsed(record, monotonicAt);
    const nextError = mutation.errorCode === undefined
      ? (mutation.clearError === true ? undefined : record.error)
      : this.createFault(mutation.errorCode, observedAt);
    record.state = nextState;
    record.pendingMessageCount = nextPending;
    record.error = nextError;
    // 生命周期代际只随状态转换推进。pending 事件仍在节点顺序域内串行处理，
    // 允许同一状态快照上并行获准的多条消息各自完成，不互相误判为迟到。
    if (stateChanged) record.lifecycleGeneration += 1;
    if (stateChanged && nextState === "idle" && record.lifecycleStartedAt === undefined) {
      record.createdAt = observedAt;
      record.lifecycleStartedAt = monotonicAt;
    }
    if (stateChanged && nextState === "terminating" && record.frozenLifecycleElapsedMs !== undefined) {
      // failed 的展示时长固定；开始清理后从该固定值继续累计，但不把停留在
      // failed 的时间误算为清理时长。
      record.lifecycleStartedAt = monotonicAt - record.frozenLifecycleElapsedMs;
      record.frozenLifecycleElapsedMs = undefined;
    }
    if (
      stateChanged &&
      (nextState === "failed" || nextState === "terminated") &&
      elapsedAtMutation !== undefined
    ) {
      record.frozenLifecycleElapsedMs = elapsedAtMutation;
    }
    record.revision += 1;
    record.observedAt = observedAt;
    this.treeRevision += 1;
    this.treeObservedAt = observedAt;
    this.notifyChange();
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

  private notifyChange(): void {
    for (const listener of this.changeListeners) {
      try {
        listener();
      } catch {
        // 只读观察者异常不能改变身份、配额或生命周期事实。
      }
    }
  }

  private createFault(code: AgentFaultCode, observedAt: string): AgentFault {
    const metadata = ERROR_METADATA[code];
    return Object.freeze({
      code,
      message: metadata.message,
      retryable: metadata.retryable,
      observed_at: observedAt,
    });
  }

  private safeMonotonicNow(): number {
    try {
      const value = this.monotonicNow();
      return Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  }

  private lifecycleElapsed(record: AgentRecord, monotonicAt: number): number | undefined {
    if (record.lifecycleStartedAt === undefined) return undefined;
    if (record.frozenLifecycleElapsedMs !== undefined) return record.frozenLifecycleElapsedMs;
    return Math.max(0, Math.round(monotonicAt - record.lifecycleStartedAt));
  }

  private snapshot(record: AgentRecord, monotonicAt = this.safeMonotonicNow()): AgentSnapshot {
    const common = {
      agent_id: record.agentId,
      parent_agent_id: record.parentAgentId,
      template_id: record.templateId,
      name: record.name,
      depth: record.depth,
      state: record.state,
      pending_message_count: record.pendingMessageCount,
      revision: record.revision,
      observed_at: record.observedAt,
    } as const;
    const base = record.createdAt === undefined
      ? common
      : {
          ...common,
          created_at: record.createdAt,
          lifecycle_elapsed_ms: this.lifecycleElapsed(record, monotonicAt) ?? 0,
        };
    if (record.error === undefined) return Object.freeze(base);
    return Object.freeze({ ...base, error: record.error });
  }

  private outcome(record: AgentRecord, applied: boolean): LifecycleEventOutcome {
    return Object.freeze({
      applied,
      node: this.snapshot(record),
      lifecycle_generation: record.lifecycleGeneration,
      tree_revision: this.treeRevision,
    });
  }
}

// 兼容后续纵向旅程采用的命名，不复制控制器实现或状态。
export { TreeController as AgentTreeController };
