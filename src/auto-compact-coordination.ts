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
  private readonly barriers = new Map<string, PreparedBarrier>();
  private readonly pending = new Set<string>();
  private readonly unsubscribers: Array<() => void> = [];
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
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.closePromise = (async () => {
      await this.operationQueue;
      const barriers = [...this.barriers];
      this.barriers.clear();
      await Promise.allSettled(barriers.map(([requestId, barrier]) =>
        this.releaseBarrier(requestId, barrier, "not_started")
      ));
      const completed = this.completedLocalSuccess;
      this.completedLocalSuccess = undefined;
      if (completed !== undefined) {
        this.releaseLocal(completed.requestId, completed.runtime, "not_started");
        void completed.runtime.retryPendingReplies().catch(() => {});
      }
      this.pending.clear();
    })();
    return this.closePromise;
  }

  hasBarrier(): boolean {
    return this.barriers.size > 0 || this.pending.size > 0;
  }

  /** 只有全部 prepare 业务 ACK 已完成后，才授权当前 child 的 manual 压缩事实。 */
  hasPreparedBarrier(): boolean {
    return this.barriers.size > 0;
  }

  private discover(value: unknown): void {
    if (this.closed) return;
    const request = parseDiscover(value);
    if (request === undefined) return;
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
    const prepared = await this.establishBarrier(request.requestId);
    this.emitPrepared(request.requestId, prepared);
  }

  private async establishBarrier(requestId: string): Promise<boolean> {
    if (this.closed || this.barriers.has(requestId) || this.pending.has(requestId)) return false;
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
        return false;
      }
      this.barriers.set(requestId, Object.freeze({
        runtime,
        parentPrepared: parentRequested,
      }));
      return true;
    } catch {
      if (parentRequested && runtime.upstream !== undefined) {
        await this.releaseRequestedUpstream(runtime.upstream.channel, requestId, "not_started", true);
      }
      this.releaseLocal(requestId, runtime);
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
    const barrier = this.barriers.get(request.requestId);
    if (barrier === undefined) {
      const completed = this.completedLocalSuccess;
      if (
        request.outcome === "not_started"
        && completed?.requestId === request.requestId
      ) {
        this.completedLocalSuccess = undefined;
        this.releaseLocal(request.requestId, completed.runtime, "not_started");
        void completed.runtime.retryPendingReplies().catch(() => {});
        this.emitCompleted(request.requestId, true);
        return;
      }
      this.emitCompleted(request.requestId, false);
      return;
    }

    this.barriers.delete(request.requestId);
    const accepted = await this.releaseBarrier(request.requestId, barrier, request.outcome);
    if (
      accepted
      && request.outcome === "succeeded"
      && barrier.runtime.replyCoordinator?.awaitsCoordinationContinuation(request.requestId) === true
    ) {
      this.completedLocalSuccess = Object.freeze({ requestId: request.requestId, runtime: barrier.runtime });
    }
    this.emitCompleted(request.requestId, accepted);
  }

  private async releaseBarrier(
    requestId: string,
    barrier: PreparedBarrier,
    outcome: SupervisorCompactionOutcome,
  ): Promise<boolean> {
    const accepted = barrier.parentPrepared && barrier.runtime.upstream !== undefined
      ? await this.completeUpstream(barrier.runtime.upstream.channel, requestId, outcome)
      : true;
    this.releaseLocal(requestId, barrier.runtime, accepted ? outcome : "not_started");
    void barrier.runtime.retryPendingReplies().catch(() => {});
    return accepted;
  }

  private async completeUpstream(
    channel: StreamSupervisorChannel,
    requestId: string,
    outcome: SupervisorCompactionOutcome,
  ): Promise<boolean> {
    const status = await requestBusinessAck(
      (signal) => channel.requestCompactionComplete(requestId, outcome, signal),
      this.upstreamAckTimeoutMs,
    );
    if (status === "accepted") return true;
    if (status === "rejected") return false;

    const cleanup = await requestBusinessAck(
      (signal) => channel.requestCompactionComplete(requestId, "not_started", signal),
      this.upstreamAckTimeoutMs,
    );
    if (cleanup === "uncertain") await failUncertainUpstreamResponse(channel);
    return false;
  }

  private async releaseRequestedUpstream(
    channel: StreamSupervisorChannel,
    requestId: string,
    outcome: SupervisorCompactionOutcome,
    parentAtRisk: boolean,
  ): Promise<void> {
    const status = await requestBusinessAck(
      (signal) => channel.requestCompactionComplete(requestId, outcome, signal),
      this.upstreamAckTimeoutMs,
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
): Promise<BusinessAckStatus> {
  try {
    return await withAbortTimeout(operation, timeoutMs) ? "accepted" : "rejected";
  } catch {
    return "uncertain";
  }
}

function withAbortTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      controller.abort();
      reject(new Error("自动压缩协调上游确认超时"));
    }, timeoutMs);
    timer.unref?.();
    void Promise.resolve()
      .then(() => operation(controller.signal))
      .then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error("自动压缩协调上游确认失败"));
        },
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
