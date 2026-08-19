import { randomUUID } from "node:crypto";
import type { ChildReplyCoordinator } from "./child-reply-coordinator.ts";
import type { ParentReplyInbox } from "./parent-reply-inbox.ts";
import type { StreamSupervisorChannel } from "./stream-supervisor-channel.ts";
import type { SupervisorCompactionOutcome } from "./supervisor-channel.ts";

export const AUTO_COMPACT_COORDINATION_VERSION = "wj-pi-auto-compact/coordination/v1" as const;

export const AUTO_COMPACT_COORDINATION_CHANNELS = Object.freeze({
  discover: "wj-pi-auto-compact/coordination/v1/discover",
  discovered: "wj-pi-auto-compact/coordination/v1/discovered",
  prepare: "wj-pi-auto-compact/coordination/v1/prepare",
  prepared: "wj-pi-auto-compact/coordination/v1/prepared",
  complete: "wj-pi-auto-compact/coordination/v1/complete",
  completed: "wj-pi-auto-compact/coordination/v1/completed",
} as const);

// 外层 CoordinationClient 的 12s waiter 必须覆盖一次业务等待与一次 not_started 补偿。
const UPSTREAM_ACK_TIMEOUT_MS = 4_500;
const CLEANUP_ACK_TIMEOUT_MS = 1_000;
const TRANSACTION_HISTORY_LIMIT = 64;
const OUTCOMES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "not_started",
]);

export interface AutoCompactCoordinationEventBus {
  emit(channel: string, value: unknown): void;
  on(channel: string, handler: (value: unknown) => void): () => void;
}

export interface AutoCompactCoordinationRuntime {
  readonly handoffPending?: boolean;
  readonly replyInbox: ParentReplyInbox;
  readonly replyCoordinator?: ChildReplyCoordinator;
  readonly upstream?: { readonly channel: StreamSupervisorChannel };
  retryPendingReplies(): Promise<void>;
}

export interface AutoCompactCoordinationParticipantOptions {
  readonly eventBus: AutoCompactCoordinationEventBus;
  readonly readRuntime: () => AutoCompactCoordinationRuntime | undefined;
  readonly participantId?: string;
  readonly upstreamAckTimeoutMs?: number;
}

interface PreparedBarrier {
  readonly runtime: AutoCompactCoordinationRuntime;
  readonly parentPrepared: boolean;
}

interface TransactionTerminal {
  readonly outcome: SupervisorCompactionOutcome;
  readonly accepted: boolean;
  compensationAccepted?: boolean;
}

interface TransactionRecord {
  preparation?: Promise<boolean>;
  prepared?: boolean;
  terminal?: TransactionTerminal;
}

type BusinessAckStatus = "accepted" | "rejected" | "uncertain";

/**
 * 把通用自动压缩事件映射到当前运行时的 reply/final 屏障。
 * 对外只暴露不透明 participantId；树身份和任务身份不会进入事件总线。
 */
export class AutoCompactCoordinationParticipant {
  readonly participantId: string;

  private readonly eventBus: AutoCompactCoordinationEventBus;
  private readonly readRuntime: () => AutoCompactCoordinationRuntime | undefined;
  private readonly upstreamAckTimeoutMs: number;
  private readonly cleanupAckTimeoutMs: number;
  private readonly barriers = new Map<string, PreparedBarrier>();
  private readonly pending = new Set<string>();
  private readonly transactions = new Map<string, TransactionRecord>();
  private readonly operationAbortController = new AbortController();
  private readonly unsubscribers: Array<() => void> = [];
  private readonly pendingManualCompactionAuthorizations = new Set<string>();
  private activeManualCompactionTransactionId: string | undefined;
  private completedManualCompactionTransactionId: string | undefined;
  private uncoordinatedManualCompactionActive = false;
  private completedLocalSuccess:
    | { readonly requestId: string; readonly runtime: AutoCompactCoordinationRuntime }
    | undefined;
  private operationQueue: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | undefined;
  private closed = false;

  constructor(options: AutoCompactCoordinationParticipantOptions) {
    this.eventBus = options.eventBus;
    this.readRuntime = options.readRuntime;
    this.participantId = options.participantId ?? randomUUID();
    this.upstreamAckTimeoutMs = options.upstreamAckTimeoutMs ?? UPSTREAM_ACK_TIMEOUT_MS;
    this.cleanupAckTimeoutMs = Math.min(CLEANUP_ACK_TIMEOUT_MS, this.upstreamAckTimeoutMs);
    if (this.participantId.length === 0 || this.participantId.length > 256) {
      throw new TypeError("自动压缩协调参与者标识无效");
    }
    if (!Number.isSafeInteger(this.upstreamAckTimeoutMs) || this.upstreamAckTimeoutMs <= 0) {
      throw new TypeError("自动压缩协调上游期限无效");
    }

    this.unsubscribers.push(
      this.eventBus.on(AUTO_COMPACT_COORDINATION_CHANNELS.discover, (value) => this.discover(value)),
      this.eventBus.on(AUTO_COMPACT_COORDINATION_CHANNELS.prepare, (value) => {
        this.enqueue(() => this.prepare(value));
      }),
      this.eventBus.on(AUTO_COMPACT_COORDINATION_CHANNELS.complete, (value) => {
        this.enqueue(() => this.complete(value));
      }),
    );
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closed = true;
    this.operationAbortController.abort();
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.closePromise = (async () => {
      await this.operationQueue;
      const barriers = [...this.barriers];
      this.barriers.clear();
      await Promise.allSettled(barriers.map(([requestId, barrier]) =>
        this.releaseBarrier(requestId, barrier, "not_started", true)
      ));
      const completed = this.completedLocalSuccess;
      this.completedLocalSuccess = undefined;
      if (completed !== undefined) {
        const upstream = completed.runtime.upstream;
        if (upstream !== undefined) {
          await this.cleanupUpstream(upstream.channel, completed.requestId);
        }
        this.releaseLocal(completed.requestId, completed.runtime, "not_started");
        void completed.runtime.retryPendingReplies().catch(() => {});
      }
      this.pending.clear();
      this.transactions.clear();
      this.pendingManualCompactionAuthorizations.clear();
      this.activeManualCompactionTransactionId = undefined;
      this.completedManualCompactionTransactionId = undefined;
      this.uncoordinatedManualCompactionActive = false;
    })();
    return this.closePromise;
  }

  hasBarrier(): boolean {
    return this.barriers.size > 0 || this.pending.size > 0;
  }

  /** 只有全部 prepare 业务 ACK 已完成后，才存在可释放的消息屏障。 */
  hasPreparedBarrier(): boolean {
    return this.barriers.size > 0;
  }

  /** 新轮开始后不再可能收到上一轮失败压缩的成功 session_compact。 */
  observeAgentStart(): void {
    this.completedManualCompactionTransactionId = undefined;
    // 真实新轮已经取得续跑所有权，close 不得再把该事务补偿为 not_started。
    this.completedLocalSuccess = undefined;
    this.pruneTransactionHistory();
  }

  /** Pi 的真实 before_compact 消费授权；活动授权独立于消息屏障保留。 */
  beginManualCompaction(): boolean {
    if (
      this.closed
      || this.completedManualCompactionTransactionId !== undefined
      || this.activeManualCompactionTransactionId !== undefined
      || this.pendingManualCompactionAuthorizations.size !== 1
    ) return false;
    const transactionId = this.pendingManualCompactionAuthorizations.values().next().value;
    if (transactionId === undefined) return false;
    this.pendingManualCompactionAuthorizations.delete(transactionId);
    this.activeManualCompactionTransactionId = transactionId;
    return true;
  }

  /** 原生自动压缩只撤销尚未消费的 manual 授权。 */
  revokePendingManualCompactionAuthorization(): void {
    this.pendingManualCompactionAuthorizations.clear();
    this.pruneTransactionHistory();
  }

  /** 真实 compact end 或非成功事务的迟到 compact end 都只消费一次。 */
  completeManualCompaction(): boolean {
    if (this.activeManualCompactionTransactionId !== undefined) {
      this.activeManualCompactionTransactionId = undefined;
      this.pruneTransactionHistory();
      return true;
    }
    if (this.completedManualCompactionTransactionId === undefined) return false;
    this.completedManualCompactionTransactionId = undefined;
    this.pruneTransactionHistory();
    return true;
  }

  /** 没有协调事务时接管用户或其他扩展发起的 manual 生命周期。 */
  beginUncoordinatedManualCompaction(): boolean {
    if (
      this.closed
      || this.completedManualCompactionTransactionId !== undefined
      || this.activeManualCompactionTransactionId !== undefined
      || this.uncoordinatedManualCompactionActive
      || this.pendingManualCompactionAuthorizations.size > 0
      || this.pending.size > 0
      || this.barriers.size > 0
    ) return false;
    this.uncoordinatedManualCompactionActive = true;
    return true;
  }

  completeUncoordinatedManualCompaction(): boolean {
    if (!this.uncoordinatedManualCompactionActive) return false;
    this.uncoordinatedManualCompactionActive = false;
    return true;
  }

  private discover(value: unknown): void {
    if (this.closed) return;
    const request = parseDiscover(value);
    if (request === undefined) return;
    const runtime = this.readRuntime();
    if (runtime === undefined || runtime.handoffPending === true) return;
    this.eventBus.emit(AUTO_COMPACT_COORDINATION_CHANNELS.discovered, Object.freeze({
      protocolVersion: AUTO_COMPACT_COORDINATION_VERSION,
      requestId: request.requestId,
      participantId: this.participantId,
      requiresBarrier: true,
    }));
  }

  private enqueue(operation: () => Promise<void>): void {
    this.operationQueue = this.operationQueue.then(operation, operation).catch(() => {
      // 单个事务失败不能阻塞后续幂等 complete。
    });
  }

  private async prepare(value: unknown): Promise<void> {
    if (this.closed) return;
    const request = parseTargeted(value, this.participantId);
    if (request === undefined) return;
    const existing = this.transactions.get(request.requestId);
    if (existing !== undefined) {
      const prepared = existing.prepared ?? await existing.preparation ?? false;
      this.emitPrepared(request.requestId, prepared);
      return;
    }

    const record: TransactionRecord = {};
    this.transactions.set(request.requestId, record);
    const preparation = this.establishBarrier(request.requestId);
    record.preparation = preparation;
    const prepared = await preparation;
    delete record.preparation;
    record.prepared = prepared;
    this.pruneTransactionHistory();
    this.emitPrepared(request.requestId, prepared);
  }

  private async establishBarrier(requestId: string): Promise<boolean> {
    if (
      this.closed
      || this.uncoordinatedManualCompactionActive
      || this.barriers.has(requestId)
      || this.pending.has(requestId)
    ) return false;
    if (this.barriers.size > 0 || this.pending.size > 0) return false;
    const runtime = this.readRuntime();
    if (runtime === undefined || runtime.handoffPending === true) return false;

    this.pending.add(requestId);
    const inboxPrepared = runtime.replyInbox.beginSessionCompactionBarrier(requestId);
    const replyPrepared = runtime.replyCoordinator?.beginCoordinationBarrier(requestId) ?? true;
    if (!inboxPrepared || !replyPrepared) {
      if (replyPrepared) runtime.replyCoordinator?.completeCoordinationBarrier(requestId, "not_started");
      if (inboxPrepared) runtime.replyInbox.completeSessionCompactionBarrier(requestId);
      this.pending.delete(requestId);
      return false;
    }
    const parentRequested = runtime.upstream !== undefined;
    try {
      const parentStatus = parentRequested
        ? await requestBusinessAck(
            (signal) => runtime.upstream!.channel.requestCompactionPrepare(requestId, signal),
            this.upstreamAckTimeoutMs,
            this.operationAbortController.signal,
          )
        : "accepted";
      if (parentStatus !== "accepted" || this.closed) {
        if (parentRequested && runtime.upstream !== undefined) {
          await this.releaseRequestedUpstream(
            runtime.upstream.channel,
            requestId,
            "not_started",
            parentStatus !== "rejected",
          );
        }
        this.releaseLocal(requestId, runtime);
        void runtime.retryPendingReplies().catch(() => {});
        return false;
      }
      this.barriers.set(requestId, Object.freeze({
        runtime,
        parentPrepared: parentRequested,
      }));
      this.pendingManualCompactionAuthorizations.add(requestId);
      return true;
    } catch {
      if (parentRequested && runtime.upstream !== undefined) {
        await this.releaseRequestedUpstream(runtime.upstream.channel, requestId, "not_started", true);
      }
      this.releaseLocal(requestId, runtime);
      void runtime.retryPendingReplies().catch(() => {});
      return false;
    } finally {
      this.pending.delete(requestId);
    }
  }

  private async complete(value: unknown): Promise<void> {
    if (this.closed) return;
    const request = parseComplete(value, this.participantId);
    if (request === undefined) return;
    if (
      this.completedLocalSuccess !== undefined
      && !this.completedLocalSuccess.runtime.replyCoordinator?.awaitsCoordinationContinuation(
        this.completedLocalSuccess.requestId,
      )
    ) {
      this.completedLocalSuccess = undefined;
    }
    const record = this.transactions.get(request.requestId) ?? {};
    if (!this.transactions.has(request.requestId)) this.transactions.set(request.requestId, record);
    const terminal = record.terminal;
    if (terminal !== undefined) {
      if (
        request.outcome === "not_started"
        && terminal.outcome !== "not_started"
        && terminal.accepted
      ) {
        if (terminal.compensationAccepted === undefined) {
          const completed = this.completedLocalSuccess;
          let accepted = true;
          if (completed?.requestId === request.requestId) {
            const upstream = completed.runtime.upstream;
            if (upstream !== undefined) {
              accepted = await this.cleanupUpstream(upstream.channel, request.requestId);
            }
            this.completedLocalSuccess = undefined;
            this.releaseLocal(request.requestId, completed.runtime, "not_started");
            void completed.runtime.retryPendingReplies().catch(() => {});
          }
          terminal.compensationAccepted = accepted;
        }
        this.pendingManualCompactionAuthorizations.delete(request.requestId);
        this.emitCompleted(request.requestId, terminal.compensationAccepted);
        return;
      }
      this.emitCompleted(request.requestId, terminal.accepted);
      return;
    }

    const barrier = this.barriers.get(request.requestId);
    if (barrier === undefined) {
      record.terminal = { outcome: request.outcome, accepted: false };
      this.pruneTransactionHistory();
      this.emitCompleted(request.requestId, false);
      return;
    }

    this.barriers.delete(request.requestId);
    const continuationExpected = barrier.runtime.replyCoordinator?.expectsCoordinationContinuation(
      request.requestId,
      request.outcome,
    ) ?? false;
    const accepted = await this.releaseBarrier(
      request.requestId,
      barrier,
      request.outcome,
      false,
      continuationExpected,
    );
    if (
      request.outcome !== "succeeded"
      && this.activeManualCompactionTransactionId === request.requestId
    ) {
      this.activeManualCompactionTransactionId = undefined;
      this.completedManualCompactionTransactionId = request.requestId;
      barrier.runtime.replyCoordinator?.observeCompactionEnd("manual");
    }
    record.terminal = { outcome: request.outcome, accepted };
    if (request.outcome === "not_started") {
      this.pendingManualCompactionAuthorizations.delete(request.requestId);
    }
    if (
      accepted
      && request.outcome === "succeeded"
      && barrier.runtime.replyCoordinator?.awaitsCoordinationContinuation(request.requestId) === true
    ) {
      this.completedLocalSuccess = Object.freeze({ requestId: request.requestId, runtime: barrier.runtime });
    }
    this.pruneTransactionHistory();
    this.emitCompleted(request.requestId, accepted);
  }

  private pruneTransactionHistory(): void {
    while (this.transactions.size > TRANSACTION_HISTORY_LIMIT) {
      let removed = false;
      for (const [requestId, record] of this.transactions) {
        if (
          record.preparation !== undefined
          || this.pending.has(requestId)
          || this.barriers.has(requestId)
          || this.completedLocalSuccess?.requestId === requestId
          || this.pendingManualCompactionAuthorizations.has(requestId)
          || this.activeManualCompactionTransactionId === requestId
          || this.completedManualCompactionTransactionId === requestId
        ) continue;
        this.transactions.delete(requestId);
        removed = true;
        break;
      }
      if (!removed) return;
    }
  }

  private async releaseBarrier(
    requestId: string,
    barrier: PreparedBarrier,
    outcome: SupervisorCompactionOutcome,
    cleanup = false,
    continuationExpected = false,
  ): Promise<boolean> {
    const accepted = barrier.parentPrepared && barrier.runtime.upstream !== undefined
      ? cleanup
        ? await this.cleanupUpstream(barrier.runtime.upstream.channel, requestId)
        : await this.completeUpstream(
            barrier.runtime.upstream.channel,
            requestId,
            outcome,
            continuationExpected,
          )
      : true;
    this.releaseLocal(requestId, barrier.runtime, accepted ? outcome : "not_started");
    void barrier.runtime.retryPendingReplies().catch(() => {});
    return accepted;
  }

  private async completeUpstream(
    channel: StreamSupervisorChannel,
    requestId: string,
    outcome: SupervisorCompactionOutcome,
    continuationExpected: boolean,
  ): Promise<boolean> {
    const status = await requestBusinessAck(
      (signal) => channel.requestCompactionComplete(requestId, outcome, signal, continuationExpected),
      this.upstreamAckTimeoutMs,
      this.operationAbortController.signal,
    );
    if (status === "accepted") return true;
    if (status === "rejected") return false;

    const cleanup = await requestBusinessAck(
      (signal) => channel.requestCompactionComplete(requestId, "not_started", signal),
      this.cleanupAckTimeoutMs,
    );
    if (cleanup === "uncertain") await failUncertainUpstreamResponse(channel);
    return false;
  }

  private async cleanupUpstream(
    channel: StreamSupervisorChannel,
    requestId: string,
  ): Promise<boolean> {
    const status = await requestBusinessAck(
      (signal) => channel.requestCompactionComplete(requestId, "not_started", signal),
      this.cleanupAckTimeoutMs,
    );
    if (status === "uncertain") await failUncertainUpstreamResponse(channel);
    return status === "accepted";
  }

  private async releaseRequestedUpstream(
    channel: StreamSupervisorChannel,
    requestId: string,
    outcome: SupervisorCompactionOutcome,
    parentAtRisk: boolean,
  ): Promise<void> {
    const status = await requestBusinessAck(
      (signal) => channel.requestCompactionComplete(requestId, outcome, signal),
      this.cleanupAckTimeoutMs,
    );
    if (status === "uncertain" && parentAtRisk) await failUncertainUpstreamResponse(channel);
  }

  private releaseLocal(
    requestId: string,
    runtime: AutoCompactCoordinationRuntime,
    outcome: SupervisorCompactionOutcome = "not_started",
  ): void {
    runtime.replyCoordinator?.completeCoordinationBarrier(requestId, outcome);
    runtime.replyInbox.completeSessionCompactionBarrier(requestId);
  }

  private emitPrepared(requestId: string, prepared: boolean): void {
    this.eventBus.emit(AUTO_COMPACT_COORDINATION_CHANNELS.prepared, Object.freeze({
      protocolVersion: AUTO_COMPACT_COORDINATION_VERSION,
      requestId,
      participantId: this.participantId,
      prepared,
    }));
  }

  private emitCompleted(requestId: string, completed: boolean): void {
    this.eventBus.emit(AUTO_COMPACT_COORDINATION_CHANNELS.completed, Object.freeze({
      protocolVersion: AUTO_COMPACT_COORDINATION_VERSION,
      requestId,
      participantId: this.participantId,
      completed,
    }));
  }
}

function parseDiscover(value: unknown): { readonly requestId: string } | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["protocolVersion", "requestId"])) return undefined;
  if (value.protocolVersion !== AUTO_COMPACT_COORDINATION_VERSION || !validId(value.requestId)) return undefined;
  return Object.freeze({ requestId: value.requestId });
}

function parseTargeted(
  value: unknown,
  participantId: string,
): { readonly requestId: string } | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["protocolVersion", "requestId", "participantId"])) return undefined;
  if (
    value.protocolVersion !== AUTO_COMPACT_COORDINATION_VERSION
    || !validId(value.requestId)
    || value.participantId !== participantId
  ) return undefined;
  return Object.freeze({ requestId: value.requestId });
}

function parseComplete(
  value: unknown,
  participantId: string,
): { readonly requestId: string; readonly outcome: SupervisorCompactionOutcome } | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["protocolVersion", "requestId", "participantId", "outcome"])) {
    return undefined;
  }
  if (
    value.protocolVersion !== AUTO_COMPACT_COORDINATION_VERSION
    || !validId(value.requestId)
    || value.participantId !== participantId
    || typeof value.outcome !== "string"
    || !OUTCOMES.has(value.outcome)
  ) return undefined;
  return Object.freeze({
    requestId: value.requestId,
    outcome: value.outcome as SupervisorCompactionOutcome,
  });
}

async function failUncertainUpstreamResponse(channel: StreamSupervisorChannel): Promise<void> {
  channel.failProtocol();
  try {
    await channel.release();
  } catch {
    // failProtocol 已完成故障裁决；句柄释放失败由外层 runtime 清理继续收敛。
  }
}

async function requestBusinessAck(
  operation: (signal: AbortSignal) => Promise<boolean>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<BusinessAckStatus> {
  try {
    return await withAbortTimeout(operation, timeoutMs, signal) ? "accepted" : "rejected";
  } catch {
    return "uncertain";
  }
}

function withAbortTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
      outcome();
    };
    const onExternalAbort = (): void => {
      controller.abort();
      finish(() => reject(new Error("自动压缩协调等待已取消")));
    };
    timer = setTimeout(() => {
      controller.abort();
      finish(() => reject(new Error("自动压缩协调上游确认超时")));
    }, timeoutMs);
    timer.unref?.();
    if (externalSignal?.aborted) {
      onExternalAbort();
      return;
    }
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
    void Promise.resolve()
      .then(() => operation(controller.signal))
      .then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(
          error instanceof Error ? error : new Error("自动压缩协调上游确认失败"),
        )),
      );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}
