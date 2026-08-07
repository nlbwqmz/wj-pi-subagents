import { randomUUID } from "node:crypto";

const RELOAD_LEASE_REQUEST_CHANNEL = "pi-subagent/runtime/reload/request/v1";
const SHARED_RELOAD_LEASE_REGISTRY = Symbol.for("pi-subagents-wj/runtime-reload-leases/v1");
const SHARED_RELOAD_LEASE_REGISTRY_VERSION = 1;
const DEFAULT_RELOAD_LEASE_TIMEOUT_MS = 5_000;

export interface RuntimeReloadEventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface RuntimeReloadIdentity {
  readonly isChild: boolean;
  readonly rootId?: string;
  readonly agentId?: string;
}

export interface IncomingRuntimeReloadLease<TRuntime> {
  readonly runtime: TRuntime;
  readonly expired: boolean;
}

/** 扩展 factory 仍在门禁或装配时，暂缓无人接管 watchdog。 */
export interface RuntimeReloadActivationHold {
  release(): Promise<void>;
}

export interface RuntimeReloadCoordinatorOptions<TRuntime, TTransfer> {
  readonly eventBus?: RuntimeReloadEventBus;
  readonly timeoutMs?: number;
  readonly activationIdentity: RuntimeReloadIdentity;
  readonly isTransfer: (value: unknown) => value is TTransfer;
  readonly identityOfRuntime: (runtime: TRuntime) => RuntimeReloadIdentity;
  readonly identityOfTransfer: (transfer: TTransfer) => RuntimeReloadIdentity;
  readonly createTransfer: (runtime: TRuntime) => TTransfer;
  readonly restoreTransfer: (transfer: TTransfer) => TRuntime;
  readonly getActive: () => TRuntime | undefined;
  readonly setActive: (runtime: TRuntime | undefined) => void;
  readonly setHandoffPending: (runtime: TRuntime, pending: boolean) => void;
  readonly cleanup: (runtime: TRuntime) => Promise<boolean>;
  /** 交接成功后旧实例只放弃根权威引用，不清除仍由新实例持有的树记录。 */
  readonly relinquish: (runtime: TRuntime) => void;
  /** 运行时完整清理后释放根权威及终止记录。 */
  readonly release: (runtime: TRuntime) => void;
}

interface ReloadLeaseRequest {
  readonly kind: "pi-subagent-reload-lease-request";
  readonly requestId: string;
  readonly identity: RuntimeReloadIdentity;
  claim(transfer: unknown): boolean;
}

interface PendingRuntimeReloadLease<TRuntime, TTransfer> {
  readonly runtime: TRuntime;
  readonly transfer: TTransfer;
  readonly activationHolds: Set<string>;
  timer: ReturnType<typeof setTimeout> | undefined;
  sharedLeaseId: string | undefined;
}

interface SharedRuntimeReloadLease {
  readonly identity: RuntimeReloadIdentity;
  claim(identity: RuntimeReloadIdentity, accept: (transfer: unknown) => boolean): boolean;
  holdActivation(): RuntimeReloadActivationHold | undefined;
}

interface SharedRuntimeReloadLeaseRegistry {
  readonly version: typeof SHARED_RELOAD_LEASE_REGISTRY_VERSION;
  readonly leases: Map<string, SharedRuntimeReloadLease>;
}

interface MutableIncomingRuntimeReloadLease<TRuntime> extends IncomingRuntimeReloadLease<TRuntime> {
  cleanup: Promise<boolean> | undefined;
  expired: boolean;
}

/**
 * 在真正隔离的扩展模块实例之间交接同一运行时。EventBus 提供同一 runner
 * 内的快路径，进程级共享 lease 覆盖旧 runner invalidate 后的跨实例认领；
 * 代理树、监督通道及清理裁决仍由调用方提供的运行时操作负责。
 */
export class RuntimeReloadCoordinator<TRuntime, TTransfer> {
  private readonly options: RuntimeReloadCoordinatorOptions<TRuntime, TTransfer>;
  private readonly eventBus: RuntimeReloadEventBus | undefined;
  private readonly timeoutMs: number;
  private unsubscribeRequests: (() => void) | undefined;
  private outgoing: PendingRuntimeReloadLease<TRuntime, TTransfer> | undefined;
  private incoming: MutableIncomingRuntimeReloadLease<TRuntime> | undefined;

  constructor(options: RuntimeReloadCoordinatorOptions<TRuntime, TTransfer>) {
    this.options = options;
    this.eventBus = options.eventBus;
    this.timeoutMs = validateRuntimeReloadLeaseTimeout(options.timeoutMs);
    if (this.eventBus === undefined) return;
    this.claimSharedIncoming(options.activationIdentity);
    if (this.incoming === undefined) this.requestIncoming(options.activationIdentity);
    this.subscribe();
  }

  /** reload shutdown 建立有界待交接 lease；无 EventBus 时由调用方正常清树。 */
  beginHandoff(runtime: TRuntime): boolean {
    if (this.eventBus === undefined) return false;
    if (this.outgoing?.runtime === runtime) return true;
    this.options.setHandoffPending(runtime, true);
    const lease: PendingRuntimeReloadLease<TRuntime, TTransfer> = {
      runtime,
      transfer: this.options.createTransfer(runtime),
      activationHolds: new Set<string>(),
      timer: undefined,
      sharedLeaseId: undefined,
    };
    this.outgoing = lease;
    this.publishSharedOutgoing(lease);
    this.armOutgoingTimeout(lease);
    return true;
  }

  /** 同一扩展实例收到 reload start 时撤回尚未转移的本地 lease。 */
  resumeLocal(runtime: TRuntime): boolean {
    const lease = this.outgoing;
    if (lease === undefined) return false;
    if (lease.runtime !== runtime) throw new Error("reload 交接 lease 已失效");
    this.clearOutgoing(lease);
    this.options.setHandoffPending(runtime, false);
    return true;
  }

  cancelHandoff(runtime: TRuntime): void {
    const lease = this.outgoing;
    if (lease?.runtime !== runtime) return;
    this.clearOutgoing(lease);
    this.options.setHandoffPending(runtime, false);
  }

  hasIncoming(): boolean {
    return this.incoming !== undefined;
  }

  /** 返回尚未提交的传入 lease；调用方完成重新绑定后必须显式 commit。 */
  prepareIncoming(): IncomingRuntimeReloadLease<TRuntime> {
    const lease = this.incoming;
    if (lease === undefined) throw new Error("reload 交接 lease 不可用");
    if (lease.expired) throw new Error("reload 交接 lease 已过期");
    return lease;
  }

  commitIncoming(lease: IncomingRuntimeReloadLease<TRuntime>): TRuntime {
    if (this.incoming !== lease || lease.expired) throw new Error("reload 交接 lease 已失效");
    this.incoming = undefined;
    return lease.runtime;
  }

  async cleanupIncoming(
    candidate: IncomingRuntimeReloadLease<TRuntime> | undefined = this.incoming,
  ): Promise<boolean> {
    if (candidate === undefined) return true;
    const lease = candidate as MutableIncomingRuntimeReloadLease<TRuntime>;
    if (this.incoming !== lease) return false;
    lease.expired = true;
    const cleanup = lease.cleanup ?? this.options.cleanup(lease.runtime);
    lease.cleanup = cleanup;
    let complete: boolean;
    try {
      complete = await cleanup;
    } catch {
      complete = false;
    } finally {
      if (lease.cleanup === cleanup) lease.cleanup = undefined;
    }
    if (complete && this.incoming === lease) {
      this.incoming = undefined;
      this.unsubscribe();
      this.options.release(lease.runtime);
    }
    return complete;
  }

  /** 正常关闭确认后撤销交接订阅并释放最终运行时所有权。 */
  releaseRuntime(runtime: TRuntime): void {
    this.cancelHandoff(runtime);
    this.unsubscribe();
    this.options.release(runtime);
  }

  private claimSharedIncoming(identity: RuntimeReloadIdentity): void {
    const registry = sharedReloadLeaseRegistry();
    const candidates = [...registry.leases.entries()].filter(([, lease]) =>
      sameIdentity(lease.identity, identity));
    if (candidates.length !== 1) return;
    const [leaseId, lease] = candidates[0]!;
    if (lease.claim(identity, (transfer) => this.acceptIncoming(transfer, identity))) {
      registry.leases.delete(leaseId);
    }
  }

  private acceptIncoming(value: unknown, identity: RuntimeReloadIdentity): boolean {
    if (this.incoming !== undefined || !this.options.isTransfer(value)) return false;
    if (!sameIdentity(this.options.identityOfTransfer(value), identity)) return false;
    let runtime: TRuntime;
    try {
      runtime = this.options.restoreTransfer(value);
    } catch {
      return false;
    }
    const lease: MutableIncomingRuntimeReloadLease<TRuntime> = {
      runtime,
      cleanup: undefined,
      expired: false,
    };
    this.incoming = lease;
    return true;
  }

  private publishSharedOutgoing(lease: PendingRuntimeReloadLease<TRuntime, TTransfer>): void {
    const leaseId = randomUUID();
    lease.sharedLeaseId = leaseId;
    const identity = Object.freeze({ ...this.options.identityOfRuntime(lease.runtime) });
    sharedReloadLeaseRegistry().leases.set(leaseId, Object.freeze({
      identity,
      claim: (
        candidate: RuntimeReloadIdentity,
        accept: (transfer: unknown) => boolean,
      ): boolean => {
        const active = this.options.getActive();
        if (this.outgoing !== lease || active !== lease.runtime) return false;
        if (!sameIdentity(identity, candidate) || !accept(lease.transfer)) return false;
        this.clearOutgoing(lease);
        this.options.setActive(undefined);
        this.options.relinquish(lease.runtime);
        this.unsubscribe();
        return true;
      },
      holdActivation: () => this.holdOutgoingActivation(lease),
    }));
  }

  private requestIncoming(identity: RuntimeReloadIdentity): void {
    const eventBus = this.eventBus;
    if (eventBus === undefined) return;
    let accepting = true;
    const request: ReloadLeaseRequest = Object.freeze({
      kind: "pi-subagent-reload-lease-request" as const,
      requestId: randomUUID(),
      identity: Object.freeze({ ...identity }),
      claim: (value: unknown): boolean => accepting && this.acceptIncoming(value, identity),
    });
    try {
      eventBus.emit(RELOAD_LEASE_REQUEST_CHANNEL, request);
    } catch {
      // 同步 claim 若已完成仍然有效；EventBus 观察者异常不能撤销所有权转移。
    } finally {
      accepting = false;
    }
  }

  private subscribe(): void {
    const eventBus = this.eventBus;
    if (eventBus === undefined) return;
    try {
      this.unsubscribeRequests = eventBus.on(RELOAD_LEASE_REQUEST_CHANNEL, (value) => {
        if (!isReloadLeaseRequest(value)) return;
        const active = this.options.getActive();
        const lease = this.outgoing;
        if (active === undefined || lease === undefined || lease.runtime !== active) return;
        if (!sameIdentity(value.identity, this.options.identityOfRuntime(active))) return;
        if (!value.claim(lease.transfer)) return;
        this.clearOutgoing(lease);
        this.options.setActive(undefined);
        this.options.relinquish(active);
        this.unsubscribe();
      });
    } catch {
      this.unsubscribeRequests = undefined;
    }
  }

  private holdOutgoingActivation(
    lease: PendingRuntimeReloadLease<TRuntime, TTransfer>,
  ): RuntimeReloadActivationHold | undefined {
    if (this.outgoing !== lease || this.options.getActive() !== lease.runtime) return undefined;
    const holdId = randomUUID();
    lease.activationHolds.add(holdId);
    if (lease.timer !== undefined) clearTimeout(lease.timer);
    lease.timer = undefined;
    let released = false;
    return Object.freeze({
      release: async (): Promise<void> => {
        if (released) return;
        released = true;
        if (!lease.activationHolds.delete(holdId)) return;
        if (this.outgoing !== lease || lease.activationHolds.size > 0) return;
        await this.expireOutgoing(lease);
      },
    });
  }

  private armOutgoingTimeout(lease: PendingRuntimeReloadLease<TRuntime, TTransfer>): void {
    if (this.outgoing !== lease || lease.activationHolds.size > 0) return;
    const timer = setTimeout(() => {
      if (lease.timer !== timer) return;
      lease.timer = undefined;
      void this.expireOutgoing(lease);
    }, this.timeoutMs);
    timer.unref?.();
    lease.timer = timer;
  }

  private async expireOutgoing(lease: PendingRuntimeReloadLease<TRuntime, TTransfer>): Promise<void> {
    if (this.outgoing !== lease || this.options.getActive() !== lease.runtime) return;
    this.clearOutgoing(lease);
    this.options.setHandoffPending(lease.runtime, false);
    let complete: boolean;
    try {
      complete = await this.options.cleanup(lease.runtime);
    } catch {
      // watchdog 失败时保留 owner，后续 shutdown 事件仍可重试。
      return;
    }
    if (!complete) return;
    if (this.options.getActive() === lease.runtime) this.options.setActive(undefined);
    this.unsubscribe();
    this.options.release(lease.runtime);
  }

  private clearOutgoing(lease: PendingRuntimeReloadLease<TRuntime, TTransfer>): void {
    if (lease.timer !== undefined) clearTimeout(lease.timer);
    lease.timer = undefined;
    lease.activationHolds.clear();
    if (lease.sharedLeaseId !== undefined) {
      sharedReloadLeaseRegistry().leases.delete(lease.sharedLeaseId);
      lease.sharedLeaseId = undefined;
    }
    if (this.outgoing === lease) this.outgoing = undefined;
  }

  private unsubscribe(): void {
    const unsubscribe = this.unsubscribeRequests;
    this.unsubscribeRequests = undefined;
    try {
      unsubscribe?.();
    } catch {
      // EventBus 退订失败不能恢复已经交接或完成清理的运行时所有权。
    }
  }
}

interface GlobalSymbolStore {
  [key: symbol]: unknown;
}

function sharedReloadLeaseRegistry(): SharedRuntimeReloadLeaseRegistry {
  const store = globalThis as unknown as GlobalSymbolStore;
  const current = store[SHARED_RELOAD_LEASE_REGISTRY];
  if (
    isRecord(current)
    && current.version === SHARED_RELOAD_LEASE_REGISTRY_VERSION
    && current.leases instanceof Map
  ) {
    return current as unknown as SharedRuntimeReloadLeaseRegistry;
  }
  const created: SharedRuntimeReloadLeaseRegistry = Object.freeze({
    version: SHARED_RELOAD_LEASE_REGISTRY_VERSION,
    leases: new Map<string, SharedRuntimeReloadLease>(),
  });
  store[SHARED_RELOAD_LEASE_REGISTRY] = created;
  return created;
}

const EMPTY_RUNTIME_RELOAD_ACTIVATION_HOLD: RuntimeReloadActivationHold = Object.freeze({
  release: async () => {},
});

/**
 * 新扩展 factory 一开始即持有唯一待交接 lease，避免异步宿主门禁耗时被误判
 * 为无人接管。成功激活时 coordinator 会先认领 lease；失败时 release 负责清树。
 */
export function holdRuntimeReloadLeaseDuringActivation(): RuntimeReloadActivationHold {
  const candidates = [...sharedReloadLeaseRegistry().leases.values()];
  if (candidates.length !== 1) return EMPTY_RUNTIME_RELOAD_ACTIVATION_HOLD;
  const candidate = candidates[0] as SharedRuntimeReloadLease & {
    readonly holdActivation?: unknown;
  };
  if (typeof candidate.holdActivation !== "function") return EMPTY_RUNTIME_RELOAD_ACTIVATION_HOLD;
  try {
    return candidate.holdActivation() ?? EMPTY_RUNTIME_RELOAD_ACTIVATION_HOLD;
  } catch {
    return EMPTY_RUNTIME_RELOAD_ACTIVATION_HOLD;
  }
}

export function readRuntimeReloadEventBus(candidate: unknown): RuntimeReloadEventBus | undefined {
  if (!isRecord(candidate) || typeof candidate.emit !== "function" || typeof candidate.on !== "function") {
    return undefined;
  }
  try {
    return Object.freeze({
      emit: candidate.emit.bind(candidate) as RuntimeReloadEventBus["emit"],
      on: candidate.on.bind(candidate) as RuntimeReloadEventBus["on"],
    });
  } catch {
    return undefined;
  }
}

export function validateRuntimeReloadLeaseTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_RELOAD_LEASE_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError("reload lease 期限无效");
  return value;
}

function isReloadLeaseRequest(value: unknown): value is ReloadLeaseRequest {
  return isRecord(value)
    && value.kind === "pi-subagent-reload-lease-request"
    && typeof value.requestId === "string"
    && value.requestId.length > 0
    && isReloadIdentity(value.identity)
    && typeof value.claim === "function";
}

function isReloadIdentity(value: unknown): value is RuntimeReloadIdentity {
  if (!isRecord(value) || typeof value.isChild !== "boolean") return false;
  if (!value.isChild) return true;
  return typeof value.rootId === "string"
    && value.rootId.length > 0
    && typeof value.agentId === "string"
    && value.agentId.length > 0;
}

function sameIdentity(left: RuntimeReloadIdentity, right: RuntimeReloadIdentity): boolean {
  if (left.isChild !== right.isChild) return false;
  return !left.isChild || (left.rootId === right.rootId && left.agentId === right.agentId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
