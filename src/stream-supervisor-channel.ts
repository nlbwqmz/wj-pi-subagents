import type { Readable, Writable } from "node:stream";
import {
  SupervisorChannel,
  SupervisorFrameDecoder,
  type SupervisorChannelOptions,
  type SupervisorCapabilityManifest,
  type SupervisorCompactionComplete,
  type SupervisorCompactionCompleted,
  type SupervisorCompactionPrepare,
  type SupervisorCompactionPrepared,
  type SupervisorControlRequest,
  type SupervisorControlResponse,
  type SupervisorFrame,
  type SupervisorEvent,
  type SupervisorReceiveResult,
  type SupervisorReply,
  type SupervisorSnapshot,
  type SupervisorChannelPublicState,
} from "./supervisor-channel.ts";
import type {
  RpcSupervisorChannel,
  RpcSupervisorChannelCloseState,
  RpcSupervisorChannelFault,
} from "./rpc-supervisor.ts";
import {
  ReplyDeliveryRejectedError,
  type ReplyAcceptance,
} from "./reply-acceptance.ts";
import {
  createDeferred,
  notifySupervisorListeners,
  raceSupervisorAbort,
  supervisorAbortError,
  waitForSupervisorSignal,
  type Deferred,
} from "./supervisor-channel-async.ts";

export interface SupervisorByteTransport {
  readonly stdin: Writable;
  readonly stdout: Readable;
}

export interface StreamSupervisorChannelOptions extends SupervisorChannelOptions {
  readonly transport: SupervisorByteTransport;
  /** child 端握手后发送的首个完整安全快照。 */
  readonly initialSnapshot?: readonly unknown[];
  readonly initialSubtreeRevision?: number;
  /** 父端收到已经通过协议校验的生命周期事实。 */
  readonly onEvent?: (event: SupervisorEvent) => void;
  readonly onSnapshot?: (snapshot: SupervisorSnapshot) => void;
  /** parent 在普通 ready 后收到的一次性内部 capability manifest。 */
  readonly onCapability?: (capability: SupervisorCapabilityManifest) => void;
  /** child 收到 close 后执行后代优先清理；只有 true 才关闭本地字节流。 */
  readonly onCloseRequested?: () => boolean | Promise<boolean>;
  /** child 等待父端同步返回 Pi 接纳裁决的内部期限。 */
  readonly replyAcceptanceTimeoutMs?: number;
}

/**
 * 将 SupervisorChannel 协议状态机绑定到一条可靠字节流。该类只负责传输和
 * 期限，不替调用方裁决生命周期；协议故障通过稳定的 eof/protocol_fault 上报。
 */
export class StreamSupervisorChannel implements RpcSupervisorChannel {
  private readonly transport: SupervisorByteTransport;
  private readonly protocol: SupervisorChannel;
  private readonly decoder: SupervisorFrameDecoder;
  private readonly initialSnapshot: readonly unknown[];
  private readonly initialSubtreeRevision: number | undefined;
  private readonly onCloseRequested: (() => boolean | Promise<boolean>) | undefined;
  private readonly replyAcceptanceTimeoutMs: number;
  private readonly ready = createDeferred<void>();
  private readonly closed = createDeferred<void>();
  private readonly replyAcceptances = new Map<string, Deferred<ReplyAcceptance>>();
  private readonly compactionPrepared = new Map<string, Deferred<boolean>>();
  private readonly compactionCompleted = new Map<string, Deferred<boolean>>();
  private readonly compactionPrepareListeners = new Set<(request: SupervisorCompactionPrepare) => void>();
  private readonly compactionCompleteListeners = new Set<(request: SupervisorCompactionComplete) => void>();
  private readonly faults = new Set<(fault: RpcSupervisorChannelFault) => void>();
  private readonly eventListeners = new Set<(event: SupervisorEvent) => void>();
  private readonly snapshotListeners = new Set<(snapshot: SupervisorSnapshot) => void>();
  private readonly capabilityListeners = new Set<(capability: SupervisorCapabilityManifest) => void>();
  private readonly controlRequestListeners = new Set<(request: SupervisorControlRequest) => void>();
  private readonly controlResponseListeners = new Set<(response: SupervisorControlResponse) => void>();
  private writeQueue: Promise<void> = Promise.resolve();
  private deferredFrameSends: Array<{
    readonly frame: SupervisorFrame;
    readonly completion: Deferred<void>;
  }> | undefined;
  private bound = false;
  private snapshotSent = false;
  private released = false;
  private faultNotified = false;
  private endpointClosed = false;
  private closeHandling: Promise<void> | undefined;

  constructor(options: StreamSupervisorChannelOptions) {
    this.transport = options.transport;
    this.protocol = new SupervisorChannel({
      role: options.role,
      rootId: options.rootId,
      localAgentId: options.localAgentId,
      peerAgentId: options.peerAgentId,
      parentAgentId: options.parentAgentId,
      depth: options.depth,
      credential: options.credential,
      requestIdRegistry: options.requestIdRegistry,
      ...(options.limits === undefined ? {} : { limits: options.limits }),
      ...(options.streamIdFactory === undefined ? {} : { streamIdFactory: options.streamIdFactory }),
      ...(options.onReply === undefined ? {} : { onReply: options.onReply }),
      ...(options.resyncTimeoutMs === undefined ? {} : { resyncTimeoutMs: options.resyncTimeoutMs }),
      onProtocolFault: () => this.fail("protocol_fault"),
    });
    this.decoder = new SupervisorFrameDecoder(options.limits);
    this.initialSnapshot = Object.freeze([...(options.initialSnapshot ?? [])]);
    this.initialSubtreeRevision = options.initialSubtreeRevision;
    this.onCloseRequested = options.onCloseRequested;
    this.replyAcceptanceTimeoutMs = validPositiveDuration(options.replyAcceptanceTimeoutMs)
      ? options.replyAcceptanceTimeoutMs
      : validPositiveDuration(options.resyncTimeoutMs)
        ? options.resyncTimeoutMs
        : 5_000;
    // child 可能在父端等待握手前先收到 EOF；不能让内部 ready 拒绝升级为
    // 未处理拒绝，但 waitForReady 仍需观察原始失败。
    void this.ready.promise.catch(() => {});
    if (options.onEvent !== undefined) this.eventListeners.add(options.onEvent);
    if (options.onSnapshot !== undefined) this.snapshotListeners.add(options.onSnapshot);
    if (options.onCapability !== undefined) this.capabilityListeners.add(options.onCapability);
    this.transport.stdout.on("data", (chunk: Uint8Array | string) => {
      try {
        const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
        for (const frame of this.decoder.push(bytes)) this.receive(frame);
      } catch {
        this.protocol.markProtocolFault();
        this.fail("protocol_fault");
      }
    });
    this.transport.stdout.on("end", () => this.onEof());
    this.transport.stdout.on("close", () => this.onEof());
    this.transport.stdout.on("error", () => this.fail("protocol_fault"));
    this.transport.stdin.on("error", () => this.fail("protocol_fault"));
  }

  async bind(signal: AbortSignal): Promise<void> {
    if (this.bound) return;
    this.bound = true;
    if (signal.aborted) throw supervisorAbortError();
    if (this.protocol.role === "child") {
      await this.send(this.protocol.startHandshake());
    }
  }

  async waitForReady(signal: AbortSignal): Promise<void> {
    if (this.isReady()) return;
    if (signal.aborted) throw supervisorAbortError();
    await raceSupervisorAbort(this.ready.promise, signal);
  }

  isReady(): boolean {
    return this.publicState().state === "ready";
  }

  async publishReply(
    reply: SupervisorReply,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted === true) throw supervisorAbortError();
    const frame = this.protocol.publishReply(reply);
    const requestId = frame.request_id;
    if (requestId === undefined) throw new Error("message_delivery_failed");
    const waiter = createDeferred<ReplyAcceptance>();
    void waiter.promise.catch(() => {});
    this.replyAcceptances.set(requestId, waiter);
    try {
      await this.send(frame);
      const accepted = await this.waitForReplyAcceptance(waiter, signal);
      if (!accepted.accepted) throw new ReplyDeliveryRejectedError(accepted.blocked_reason);
    } finally {
      if (this.replyAcceptances.get(requestId) === waiter) this.replyAcceptances.delete(requestId);
    }
  }

  /** child 在普通 ready 后发布一次内部 capability manifest。 */
  async publishCapability(capability: SupervisorCapabilityManifest): Promise<void> {
    await this.send(this.protocol.publishCapability(capability));
  }

  /** child 端发布已经由 SupervisorChannel 校验的生命周期事实。 */
  async publishEvent(
    event: Omit<SupervisorEvent, "root_id" | "agent_id"> & { readonly agent_id?: string },
  ): Promise<void> {
    await this.send(this.protocol.publishEvent(event));
  }

  /** child 端发布新的完整子树；修订和正文边界仍由协议状态机校验。 */
  async publishSnapshot(nodes: readonly unknown[], subtreeRevision: number): Promise<void> {
    await this.send(this.protocol.publishSnapshot(nodes, subtreeRevision));
  }

  async publishControlRequest(request: SupervisorControlRequest): Promise<void> {
    await this.send(this.protocol.publishControlRequest(request));
  }

  async publishControlResponse(response: SupervisorControlResponse): Promise<void> {
    await this.send(this.protocol.publishControlResponse(response));
  }

  async requestCompactionPrepare(transactionId: string, signal?: AbortSignal): Promise<boolean> {
    return this.requestCompactionAcknowledgement(
      transactionId,
      this.compactionPrepared,
      this.protocol.publishCompactionPrepare({ transaction_id: transactionId }),
      signal,
    );
  }

  async respondCompactionPrepared(response: SupervisorCompactionPrepared): Promise<void> {
    await this.send(this.protocol.publishCompactionPrepared(response));
  }

  onCompactionPrepare(listener: (request: SupervisorCompactionPrepare) => void): () => void {
    this.compactionPrepareListeners.add(listener);
    return () => this.compactionPrepareListeners.delete(listener);
  }

  async requestCompactionComplete(
    transactionId: string,
    outcome: SupervisorCompactionComplete["outcome"],
    signal?: AbortSignal,
    continuationExpected = false,
  ): Promise<boolean> {
    return this.requestCompactionAcknowledgement(
      transactionId,
      this.compactionCompleted,
      this.protocol.publishCompactionComplete({
        transaction_id: transactionId,
        outcome,
        continuation_expected: continuationExpected,
      }),
      signal,
    );
  }

  async respondCompactionCompleted(response: SupervisorCompactionCompleted): Promise<void> {
    await this.send(this.protocol.publishCompactionCompleted(response));
  }

  onCompactionComplete(listener: (request: SupervisorCompactionComplete) => void): () => void {
    this.compactionCompleteListeners.add(listener);
    return () => this.compactionCompleteListeners.delete(listener);
  }

  establishTerminationBarrier(): void {
    this.protocol.establishTerminationBarrier();
  }

  async requestClose(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw supervisorAbortError();
    try {
      await this.send(this.protocol.createCloseFrame());
    } catch {
      // 关闭帧无法送达时，资源观察仍由受管节点/平台适配器裁决。
    }
  }

  async waitForClose(deadline: number | Date): Promise<RpcSupervisorChannelCloseState> {
    if (this.released) return "unknown";
    const end = deadline instanceof Date ? deadline.getTime() : deadline;
    const remaining = Math.max(0, end - Date.now());
    if (!this.closed.settled() && remaining > 0) {
      await waitForSupervisorSignal(this.closed.promise, remaining);
    }
    return this.endpointClosed ? "released" : "present";
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.endpointClosed = true;
    for (const waiter of this.replyAcceptances.values()) waiter.reject(new Error("监督通道已关闭"));
    this.replyAcceptances.clear();
    this.rejectCompactionWaiters("监督通道已关闭");
    try {
      if (!this.transport.stdin.destroyed) this.transport.stdin.destroy();
      if (!this.transport.stdout.destroyed) this.transport.stdout.destroy();
    } finally {
      this.closed.resolve();
    }
  }

  onFault(listener: (fault: RpcSupervisorChannelFault) => void): () => void {
    this.faults.add(listener);
    return () => this.faults.delete(listener);
  }

  onEvent(listener: (event: SupervisorEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onSnapshot(listener: (snapshot: SupervisorSnapshot) => void): () => void {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }

  /** 获取 parent 已缓存的一次性 capability；该信息不属于公开状态。 */
  getCapability(): SupervisorCapabilityManifest | undefined {
    return this.protocol.getCapability();
  }

  /** 注册 capability 观察者；若已缓存则同步交付安全副本。 */
  onCapability(listener: (capability: SupervisorCapabilityManifest) => void): () => void {
    this.capabilityListeners.add(listener);
    const capability = this.protocol.getCapability();
    if (capability !== undefined) notifySupervisorListeners(new Set([listener]), capability);
    return () => this.capabilityListeners.delete(listener);
  }

  onControlRequest(listener: (request: SupervisorControlRequest) => void): () => void {
    this.controlRequestListeners.add(listener);
    return () => this.controlRequestListeners.delete(listener);
  }

  onControlResponse(listener: (response: SupervisorControlResponse) => void): () => void {
    this.controlResponseListeners.add(listener);
    return () => this.controlResponseListeners.delete(listener);
  }

  /** 路由相关性或 operation_id 复用违约时固定为监督协议故障。 */
  failProtocol(): void {
    this.protocol.markProtocolFault();
    this.fail("protocol_fault");
  }

  /** 只读协议状态用于测试/诊断，不暴露凭据或端点。 */
  getPublicState(): SupervisorChannelPublicState {
    return this.protocol.getPublicState();
  }

  private receive(frame: SupervisorFrame): void {
    if (this.deferredFrameSends !== undefined) {
      this.protocol.markProtocolFault();
      this.fail("protocol_fault");
      return;
    }
    this.deferredFrameSends = [];
    const result = this.protocol.receive(frame);
    if (result.kind === "eof" || result.kind === "protocol_fault") {
      this.rejectDeferredFrameSends();
      this.fail(result.kind === "eof" ? "eof" : "protocol_fault");
      return;
    }
    // onReply 在 protocol.receive() 内同步执行，可能先创建下一条业务帧；
    // 记录边界，确保这些较早分配序号的帧先于本次协议 ACK 写出。
    const framesBeforeProtocolResponses = this.deferredFrameSends?.length ?? 0;
    if (result.kind === "accepted" && result.event !== undefined) {
      for (const listener of this.eventListeners) {
        try {
          listener(result.event);
        } catch {
          // 观察者异常不能改变协议状态或破坏后续帧读取。
        }
      }
    }
    if (result.kind === "accepted" && result.snapshot !== undefined) {
      for (const listener of this.snapshotListeners) {
        try {
          listener(result.snapshot);
        } catch {
          // 快照观察者异常不能回滚协议已接受的原子替换。
        }
      }
    }
    if (result.kind === "accepted" && result.capability !== undefined) {
      notifySupervisorListeners(this.capabilityListeners, result.capability);
    }
    if (result.kind === "accepted" && result.control_request !== undefined) {
      notifySupervisorListeners(this.controlRequestListeners, result.control_request);
    }
    if (result.kind === "accepted" && result.control_response !== undefined) {
      const acceptance = readReplyAcceptance(result.control_response);
      if (acceptance === undefined) {
        notifySupervisorListeners(this.controlResponseListeners, result.control_response);
      } else {
        this.resolveReplyAcceptance(acceptance.operationId, acceptance.acceptance);
      }
    }
    if (result.kind === "accepted" && result.compaction_prepare !== undefined) {
      notifySupervisorListeners(this.compactionPrepareListeners, result.compaction_prepare);
    }
    if (result.kind === "accepted" && result.compaction_prepared !== undefined) {
      this.resolveCompactionAcknowledgement(this.compactionPrepared, result.compaction_prepared);
    }
    if (result.kind === "accepted" && result.compaction_complete !== undefined) {
      notifySupervisorListeners(this.compactionCompleteListeners, result.compaction_complete);
    }
    if (result.kind === "accepted" && result.compaction_completed !== undefined) {
      this.resolveCompactionAcknowledgement(this.compactionCompleted, result.compaction_completed);
    }
    if (result.kind === "accepted" && result.close_requested === true) {
      this.handleCloseRequested();
    }
    if (this.protocol.role === "child" && !this.snapshotSent && this.protocol.getPublicState().state === "awaiting_snapshot") {
      this.snapshotSent = true;
      try {
        void this.send(this.protocol.publishSnapshot(this.initialSnapshot, this.initialSubtreeRevision));
      } catch {
        this.rejectDeferredFrameSends();
        this.fail("protocol_fault");
        return;
      }
    }
    const protocolSends = result.kind === "accepted" || result.kind === "duplicate" || result.kind === "gap"
      ? this.flushDeferredFrameSends(result.outbound, framesBeforeProtocolResponses)
      : this.flushDeferredFrameSends([], framesBeforeProtocolResponses);
    if (
      (result.kind === "accepted" || result.kind === "duplicate" || result.kind === "gap")
      && this.isReady()
    ) {
      void Promise.all(protocolSends).then(
        () => this.ready.resolve(),
        () => this.fail("protocol_fault"),
      );
    }
    if (this.isReady()) this.ready.resolve();
  }

  private publicState(): SupervisorChannelPublicState {
    return this.protocol.getPublicState();
  }

  private send(frame: SupervisorFrame): Promise<void> {
    if (this.deferredFrameSends !== undefined) {
      const completion = createDeferred<void>();
      void completion.promise.catch(() => {});
      this.deferredFrameSends.push({ frame, completion });
      return completion.promise;
    }
    return this.sendDirect(frame);
  }

  private async sendDirect(frame: SupervisorFrame): Promise<void> {
    const encoded = this.protocol.encode(frame);
    const operation = this.writeQueue.catch(() => {}).then(() => new Promise<void>((resolve, reject) => {
      try {
        this.transport.stdin.write(encoded, (error?: Error | null) => {
          if (error === undefined || error === null) resolve();
          else reject(error);
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error("监督帧写入失败"));
      }
    }));
    // 保留一个已恢复的尾部，单次写入失败不能毒化后续控制帧。
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  private flushDeferredFrameSends(
    protocolFrames: readonly SupervisorFrame[],
    framesBeforeProtocolResponses: number,
  ): readonly Promise<void>[] {
    const pending = this.deferredFrameSends ?? [];
    this.deferredFrameSends = undefined;
    const sendDeferred = (items: typeof pending): void => {
      for (const item of items) {
        void this.sendDirect(item.frame).then(item.completion.resolve, item.completion.reject);
      }
    };
    sendDeferred(pending.slice(0, framesBeforeProtocolResponses));
    const protocolSends = protocolFrames.map((frame) => {
      const send = this.sendDirect(frame);
      void send.catch(() => this.fail("protocol_fault"));
      return send;
    });
    sendDeferred(pending.slice(framesBeforeProtocolResponses));
    return Object.freeze(protocolSends);
  }

  private rejectDeferredFrameSends(): void {
    const pending = this.deferredFrameSends ?? [];
    this.deferredFrameSends = undefined;
    for (const item of pending) item.completion.reject(new Error("监督通道不可用"));
  }

  private resolveReplyAcceptance(operationId: string, acceptance: ReplyAcceptance): void {
    const waiter = this.replyAcceptances.get(operationId);
    if (waiter === undefined) return;
    this.replyAcceptances.delete(operationId);
    waiter.resolve(acceptance);
  }

  private async waitForReplyAcceptance(
    waiter: Deferred<ReplyAcceptance>,
    signal?: AbortSignal,
  ): Promise<ReplyAcceptance> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ReplyAcceptance>((_, reject) => {
      timer = setTimeout(() => reject(new Error("message_delivery_failed")), this.replyAcceptanceTimeoutMs);
      timer.unref?.();
    });
    try {
      const pending = Promise.race([waiter.promise, timeout]);
      return signal === undefined ? await pending : await raceSupervisorAbort(pending, signal);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async requestCompactionAcknowledgement(
    transactionId: string,
    waiters: Map<string, Deferred<boolean>>,
    frame: SupervisorFrame,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (waiters.has(transactionId)) throw new Error("压缩协调事务已存在");
    const waiter = createDeferred<boolean>();
    void waiter.promise.catch(() => {});
    waiters.set(transactionId, waiter);
    try {
      await this.send(frame);
      return signal === undefined
        ? await waiter.promise
        : await raceSupervisorAbort(waiter.promise, signal);
    } finally {
      if (waiters.get(transactionId) === waiter) waiters.delete(transactionId);
    }
  }

  private resolveCompactionAcknowledgement(
    waiters: Map<string, Deferred<boolean>>,
    response: SupervisorCompactionPrepared | SupervisorCompactionCompleted,
  ): void {
    const waiter = waiters.get(response.transaction_id);
    if (waiter === undefined) return;
    waiters.delete(response.transaction_id);
    waiter.resolve(response.accepted);
  }

  private rejectCompactionWaiters(message: string): void {
    for (const waiter of this.compactionPrepared.values()) waiter.reject(new Error(message));
    this.compactionPrepared.clear();
    for (const waiter of this.compactionCompleted.values()) waiter.reject(new Error(message));
    this.compactionCompleted.clear();
  }

  private onEof(): void {
    if (this.released) return;
    if (this.endpointClosed) return;
    this.endpointClosed = true;
    try {
      this.decoder.finish();
    } catch {
      this.protocol.markProtocolFault();
      this.closed.resolve();
      this.fail("protocol_fault");
      return;
    }
    this.protocol.receiveEof();
    this.closed.resolve();
    this.fail("eof");
  }

  private handleCloseRequested(): void {
    if (this.closeHandling !== undefined || this.onCloseRequested === undefined) return;
    const operation = Promise.resolve()
      .then(() => this.onCloseRequested?.() ?? false)
      .then(async (complete) => {
        if (complete === true) await this.release();
      })
      .catch(() => {
        // 未确认清理时保持传输存在，由父端内部期限和平台树回收继续裁决。
      });
    this.closeHandling = operation;
  }

  private fail(fault: RpcSupervisorChannelFault): void {
    if (this.released) return;
    if (this.faultNotified) return;
    this.faultNotified = true;
    this.closed.resolve();
    for (const waiter of this.replyAcceptances.values()) waiter.reject(new Error("监督通道不可用"));
    this.replyAcceptances.clear();
    this.rejectCompactionWaiters("监督通道不可用");
    if (!this.ready.settled()) this.ready.reject(new Error("监督通道不可用"));
    for (const listener of this.faults) {
      try {
        listener(fault);
      } catch {
        // 观察者异常不能再次破坏通道状态。
      }
    }
  }
}

function readReplyAcceptance(
  response: SupervisorControlResponse,
): { readonly operationId: string; readonly acceptance: ReplyAcceptance } | undefined {
  if (!response.ok || typeof response.data !== "object" || response.data === null || Array.isArray(response.data)) {
    return undefined;
  }
  const data = response.data as Record<string, unknown>;
  if (data.kind !== "reply_acceptance" || typeof data.accepted !== "boolean") return undefined;
  const blockedReason = data.blocked_reason;
  if (
    (blockedReason !== undefined && blockedReason !== "compaction_active")
    || (data.accepted === true && blockedReason !== undefined)
  ) return undefined;
  return Object.freeze({
    operationId: response.operation_id,
    acceptance: data.accepted === true
      ? Object.freeze({ accepted: true })
      : blockedReason === "compaction_active"
        ? Object.freeze({ accepted: false, blocked_reason: "compaction_active" as const })
        : Object.freeze({ accepted: false }),
  });
}

function validPositiveDuration(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0;
}
