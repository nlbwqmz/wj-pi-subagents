import {
  MANAGED_RPC_SUPERVISOR_MAX_BODY_BYTES,
  type ManagedRpcNodeLike,
} from "./managed-rpc-node.ts";
import type {
  RpcSupervisorChannel,
  RpcSupervisorChannelCloseState,
  RpcSupervisorChannelFault,
} from "./rpc-supervisor.ts";
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
  type SupervisorEvent,
  type SupervisorFrame,
  type SupervisorReply,
  type SupervisorReplyInput,
  type SupervisorSnapshot,
  type SupervisorTaskAssignment,
  type SupervisorTaskStarted,
} from "./supervisor-channel.ts";
import {
  createDeferred,
  notifySupervisorListeners,
  raceSupervisorAbort,
  supervisorAbortError,
  waitForSupervisorSignal,
} from "./supervisor-channel-async.ts";

type ParentSupervisorOptions = Omit<SupervisorChannelOptions, "role">;

export interface ManagedRpcSupervisorChannelOptions extends ParentSupervisorOptions {
  readonly node: ManagedRpcNodeLike;
  readonly onSnapshot?: (snapshot: SupervisorSnapshot) => void;
  /** parent 在普通 ready 后收到的一次性内部 capability manifest。 */
  readonly onCapability?: (capability: SupervisorCapabilityManifest) => void;
}

/**
 * 父端监督协议适配器。监督帧通过 ManagedRpcNode 的唯一桥接读取者复用，
 * 不会与任务命令争抢 stdout，也不会暴露底层进程或 transport。
 */
export class ManagedRpcSupervisorChannel implements RpcSupervisorChannel {
  private readonly node: ManagedRpcNodeLike;
  private readonly protocol: SupervisorChannel;
  private readonly decoder: SupervisorFrameDecoder;
  private readonly ready = createDeferred<void>();
  private readonly closed = createDeferred<void>();
  private readonly faults = new Set<(fault: RpcSupervisorChannelFault) => void>();
  private readonly events = new Set<(event: SupervisorEvent) => void>();
  private readonly snapshots = new Set<(snapshot: SupervisorSnapshot) => void>();
  private readonly capabilities = new Set<(capability: SupervisorCapabilityManifest) => void>();
  private readonly controlRequests = new Set<(request: SupervisorControlRequest) => void>();
  private readonly controlResponses = new Set<(response: SupervisorControlResponse) => void>();
  private readonly compactionPrepare = new Set<(request: SupervisorCompactionPrepare) => void>();
  private readonly compactionComplete = new Set<(request: SupervisorCompactionComplete) => void>();
  private readonly compactionPrepared = new Map<string, ReturnType<typeof createDeferred<boolean>>>();
  private readonly compactionCompleted = new Map<string, ReturnType<typeof createDeferred<boolean>>>();
  private readonly replies = new Set<(reply: SupervisorReply) => void>();
  private readonly taskStarted = new Set<(started: SupervisorTaskStarted) => void>();
  private readonly transportAcknowledgements = new Map<number, ReturnType<typeof createDeferred<void>>>();
  private readonly unsubscribeFrame: () => void;
  private readonly unsubscribeTransport: () => void;
  private writeQueue: Promise<void> = Promise.resolve();
  private deferredFrameSends: Array<{
    readonly frame: SupervisorFrame;
    readonly completion: ReturnType<typeof createDeferred<void>>;
  }> | undefined;
  private bound = false;
  private released = false;
  private endpointClosed = false;
  private faultNotified = false;

  constructor(options: ManagedRpcSupervisorChannelOptions) {
    this.node = options.node;
    this.protocol = new SupervisorChannel({
      role: "parent",
      rootId: options.rootId,
      localAgentId: options.localAgentId,
      peerAgentId: options.peerAgentId,
      parentAgentId: options.parentAgentId,
      depth: options.depth,
      credential: options.credential,
      requestIdRegistry: options.requestIdRegistry,
      limits: {
        ...options.limits,
        maxFrameBytes: Math.min(
          options.limits?.maxFrameBytes ?? MANAGED_RPC_SUPERVISOR_MAX_BODY_BYTES,
          MANAGED_RPC_SUPERVISOR_MAX_BODY_BYTES,
        ),
      },
      ...(options.streamIdFactory === undefined ? {} : { streamIdFactory: options.streamIdFactory }),
      ...(options.onReply === undefined ? {} : { onReply: options.onReply }),
      ...(options.resyncTimeoutMs === undefined ? {} : { resyncTimeoutMs: options.resyncTimeoutMs }),
      onProtocolFault: () => this.fail("protocol_fault"),
    });
    this.decoder = new SupervisorFrameDecoder({
      ...options.limits,
      maxFrameBytes: Math.min(
        options.limits?.maxFrameBytes ?? MANAGED_RPC_SUPERVISOR_MAX_BODY_BYTES,
        MANAGED_RPC_SUPERVISOR_MAX_BODY_BYTES,
      ),
    });
    // 启动阶段可能先收到传输故障，再进入 waitForReady；预先消费内部拒绝，
    // 同时保留原 Promise 的拒绝结果供稍后 waitForReady 观察。
    void this.ready.promise.catch(() => {});
    if (options.onSnapshot !== undefined) this.snapshots.add(options.onSnapshot);
    if (options.onCapability !== undefined) this.capabilities.add(options.onCapability);
    this.unsubscribeFrame = this.node.onSupervisorFrame((frame) => this.receive(frame));
    this.unsubscribeTransport = this.node.onTransportFault((fault) => {
      if (fault !== "protocol_fault") {
        try {
          this.decoder.finish();
        } catch {
          fault = "protocol_fault";
        }
      }
      this.endpointClosed = true;
      this.closed.resolve();
      this.fail(fault === "protocol_fault" ? "protocol_fault" : "eof");
    });
  }

  async bind(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw supervisorAbortError();
    this.bound = true;
  }

  async waitForReady(signal: AbortSignal): Promise<void> {
    if (!this.bound) throw new Error("监督通道尚未绑定");
    if (this.isReady()) return;
    await raceSupervisorAbort(this.ready.promise, signal);
  }

  isReady(): boolean {
    return this.protocol.getPublicState().state === "ready";
  }

  async publishReply(_reply: SupervisorReplyInput | SupervisorReply): Promise<void> {
    throw new Error("父端监督通道不能发布代理回复");
  }

  async publishReplyAndWaitForAck(
    _reply: SupervisorReplyInput | SupervisorReply,
    _signal?: AbortSignal,
  ): Promise<void> {
    throw new Error("父端监督通道不能发布代理回复");
  }

  async retryPendingReplies(): Promise<void> {
    const replyAck = this.protocol.retryPendingReplies();
    if (replyAck === undefined) return;
    try {
      await this.send(replyAck);
    } catch {
      this.fail("protocol_fault");
      throw new Error("监督回复确认发送失败");
    }
  }

  async publishTaskAssignmentAndWaitForAck(
    assignment: SupervisorTaskAssignment,
    signal?: AbortSignal,
  ): Promise<void> {
    const frame = this.protocol.publishTaskAssignment(assignment);
    const waiter = createDeferred<void>();
    void waiter.promise.catch(() => {});
    this.transportAcknowledgements.set(frame.seq, waiter);
    try {
      await this.send(frame);
      if (signal === undefined) await waiter.promise;
      else await raceSupervisorAbort(waiter.promise, signal);
    } catch (error) {
      // 调用方的期限取消只表示租约交付未知，不能伪造为通道协议故障。
      if (!(signal?.aborted === true && error instanceof Error && error.name === "AbortError")) {
        this.fail("protocol_fault");
      }
      throw error;
    } finally {
      if (this.transportAcknowledgements.get(frame.seq) === waiter) {
        this.transportAcknowledgements.delete(frame.seq);
      }
    }
  }

  establishTerminationBarrier(): void {
    this.protocol.establishTerminationBarrier();
  }

  async requestClose(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw supervisorAbortError();
    try {
      await this.send(this.protocol.createCloseFrame());
    } catch {
      // 最终状态仍由节点退出与平台资源观察裁决。
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
    this.unsubscribeFrame();
    this.unsubscribeTransport();
    for (const waiter of this.transportAcknowledgements.values()) waiter.reject(new Error("监督通道已关闭"));
    this.transportAcknowledgements.clear();
    this.rejectCompactionWaiters("监督通道已关闭");
    this.closed.resolve();
  }

  onFault(listener: (fault: RpcSupervisorChannelFault) => void): () => void {
    this.faults.add(listener);
    return () => this.faults.delete(listener);
  }

  onEvent(listener: (event: SupervisorEvent) => void): () => void {
    this.events.add(listener);
    return () => this.events.delete(listener);
  }

  onSnapshot(listener: (snapshot: SupervisorSnapshot) => void): () => void {
    this.snapshots.add(listener);
    return () => this.snapshots.delete(listener);
  }

  /** 获取 parent 已缓存的一次性 capability；该信息不属于公开状态。 */
  getCapability(): SupervisorCapabilityManifest | undefined {
    return this.protocol.getCapability();
  }

  /** 注册 capability 观察者；若已缓存则同步交付安全副本。 */
  onCapability(listener: (capability: SupervisorCapabilityManifest) => void): () => void {
    this.capabilities.add(listener);
    const capability = this.protocol.getCapability();
    if (capability !== undefined) notifySupervisorListeners(new Set([listener]), capability);
    return () => this.capabilities.delete(listener);
  }

  async publishControlRequest(request: SupervisorControlRequest): Promise<void> {
    await this.send(this.protocol.publishControlRequest(request));
  }

  async publishControlResponse(response: SupervisorControlResponse): Promise<void> {
    await this.send(this.protocol.publishControlResponse(response));
  }

  onControlRequest(listener: (request: SupervisorControlRequest) => void): () => void {
    this.controlRequests.add(listener);
    return () => this.controlRequests.delete(listener);
  }

  onControlResponse(listener: (response: SupervisorControlResponse) => void): () => void {
    this.controlResponses.add(listener);
    return () => this.controlResponses.delete(listener);
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
    this.compactionPrepare.add(listener);
    return () => this.compactionPrepare.delete(listener);
  }

  async requestCompactionComplete(
    transactionId: string,
    outcome: SupervisorCompactionComplete["outcome"],
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.requestCompactionAcknowledgement(
      transactionId,
      this.compactionCompleted,
      this.protocol.publishCompactionComplete({ transaction_id: transactionId, outcome }),
      signal,
    );
  }

  async respondCompactionCompleted(response: SupervisorCompactionCompleted): Promise<void> {
    await this.send(this.protocol.publishCompactionCompleted(response));
  }

  onCompactionComplete(listener: (request: SupervisorCompactionComplete) => void): () => void {
    this.compactionComplete.add(listener);
    return () => this.compactionComplete.delete(listener);
  }

  onReply(listener: (reply: SupervisorReply) => void): () => void {
    this.replies.add(listener);
    return () => this.replies.delete(listener);
  }

  onTaskStarted(listener: (started: SupervisorTaskStarted) => void): () => void {
    this.taskStarted.add(listener);
    return () => this.taskStarted.delete(listener);
  }

  /** 路由相关性或 operation_id 复用违约时固定为监督协议故障。 */
  failProtocol(): void {
    this.protocol.markProtocolFault();
    this.fail("protocol_fault");
  }

  private receive(bytes: Uint8Array): void {
    if (this.released) return;
    let frames: readonly SupervisorFrame[];
    try {
      frames = this.decoder.push(bytes);
    } catch {
      this.protocol.markProtocolFault();
      this.fail("protocol_fault");
      return;
    }
    for (const frame of frames) this.receiveFrame(frame);
  }

  private receiveFrame(frame: SupervisorFrame): void {
    if (this.released) return;
    if (this.deferredFrameSends !== undefined) {
      this.protocol.markProtocolFault();
      this.fail("protocol_fault");
      return;
    }
    this.deferredFrameSends = [];
    const result = this.protocol.receive(frame);
    if (result.kind === "protocol_fault" || result.kind === "eof") {
      this.rejectDeferredFrameSends();
      this.fail(result.kind === "eof" ? "eof" : "protocol_fault");
      return;
    }
    // onReply 在 protocol.receive() 内同步执行，可能先创建下一条业务帧；
    // 记录边界，确保这些较早分配序号的帧先于本次协议 ACK 写出。
    const framesBeforeProtocolResponses = this.deferredFrameSends?.length ?? 0;
    if (result.kind === "accepted" && result.event !== undefined) {
      for (const listener of this.events) {
        try {
          listener(result.event);
        } catch {
          // 生命周期观察者异常不能改变协议状态。
        }
      }
    }
    if (result.kind === "accepted" && result.snapshot !== undefined) {
      for (const listener of this.snapshots) {
        try {
          listener(result.snapshot);
        } catch {
          // 快照观察者异常不能回滚已经原子接受的协议缓存。
        }
      }
    }
    if (result.kind === "accepted" && result.capability !== undefined) {
      notifySupervisorListeners(this.capabilities, result.capability);
    }
    if (result.kind === "accepted" && result.control_request !== undefined) {
      notifySupervisorListeners(this.controlRequests, result.control_request);
    }
    if (result.kind === "accepted" && result.control_response !== undefined) {
      notifySupervisorListeners(this.controlResponses, result.control_response);
    }
    if (result.kind === "accepted" && result.compaction_prepare !== undefined) {
      notifySupervisorListeners(this.compactionPrepare, result.compaction_prepare);
    }
    if (result.kind === "accepted" && result.compaction_prepared !== undefined) {
      this.resolveCompactionAcknowledgement(this.compactionPrepared, result.compaction_prepared);
    }
    if (result.kind === "accepted" && result.compaction_complete !== undefined) {
      notifySupervisorListeners(this.compactionComplete, result.compaction_complete);
    }
    if (result.kind === "accepted" && result.compaction_completed !== undefined) {
      this.resolveCompactionAcknowledgement(this.compactionCompleted, result.compaction_completed);
    }
    if (result.kind === "accepted") {
      for (const reply of result.replies) notifySupervisorListeners(this.replies, reply);
    }
    if (result.kind === "accepted" && result.task_started !== undefined) {
      notifySupervisorListeners(this.taskStarted, result.task_started);
    }
    if (result.kind === "accepted" && result.transport_ack !== undefined) {
      for (const [sequence, waiter] of this.transportAcknowledgements) {
        if (sequence > result.transport_ack) continue;
        this.transportAcknowledgements.delete(sequence);
        waiter.resolve();
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
      return;
    }
    if (this.isReady()) this.ready.resolve();
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

  private sendDirect(frame: SupervisorFrame): Promise<void> {
    const bytes = this.protocol.encode(frame);
    const operation = this.writeQueue.catch(() => {}).then(
      () => this.node.sendSupervisorFrame(bytes),
    );
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

  private async requestCompactionAcknowledgement(
    transactionId: string,
    waiters: Map<string, ReturnType<typeof createDeferred<boolean>>>,
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
    waiters: Map<string, ReturnType<typeof createDeferred<boolean>>>,
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

  private fail(fault: RpcSupervisorChannelFault): void {
    if (this.released || this.faultNotified) return;
    this.faultNotified = true;
    if (!this.ready.settled()) this.ready.reject(new Error("监督通道不可用"));
    for (const waiter of this.transportAcknowledgements.values()) waiter.reject(new Error("监督通道不可用"));
    this.transportAcknowledgements.clear();
    this.rejectCompactionWaiters("监督通道不可用");
    for (const listener of this.faults) {
      try {
        listener(fault);
      } catch {
        // 故障观察者异常不能再次进入失败路径。
      }
    }
  }
}
