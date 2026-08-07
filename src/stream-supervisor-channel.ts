import type { Readable, Writable } from "node:stream";
import {
  SupervisorChannel,
  SupervisorFrameDecoder,
  type SupervisorChannelOptions,
  type SupervisorControlRequest,
  type SupervisorControlResponse,
  type SupervisorFrame,
  type SupervisorEvent,
  type SupervisorReceiveResult,
  type SupervisorReply,
  type SupervisorReplyInput,
  type SupervisorSnapshot,
  type SupervisorChannelPublicState,
} from "./supervisor-channel.ts";
import type {
  RpcSupervisorChannel,
  RpcSupervisorChannelCloseState,
  RpcSupervisorChannelFault,
} from "./rpc-supervisor.ts";
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
  /** child 收到 close 后执行后代优先清理；只有 true 才关闭本地字节流。 */
  readonly onCloseRequested?: () => boolean | Promise<boolean>;
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
  private readonly ready = createDeferred<void>();
  private readonly closed = createDeferred<void>();
  private readonly replyAcknowledgements = new Map<number, Deferred<void>>();
  private readonly faults = new Set<(fault: RpcSupervisorChannelFault) => void>();
  private readonly eventListeners = new Set<(event: SupervisorEvent) => void>();
  private readonly snapshotListeners = new Set<(snapshot: SupervisorSnapshot) => void>();
  private readonly controlRequestListeners = new Set<(request: SupervisorControlRequest) => void>();
  private readonly controlResponseListeners = new Set<(response: SupervisorControlResponse) => void>();
  private writeQueue: Promise<void> = Promise.resolve();
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
    // child 可能在父端等待握手前先收到 EOF；不能让内部 ready 拒绝升级为
    // 未处理拒绝，但 waitForReady 仍需观察原始失败。
    void this.ready.promise.catch(() => {});
    if (options.onEvent !== undefined) this.eventListeners.add(options.onEvent);
    if (options.onSnapshot !== undefined) this.snapshotListeners.add(options.onSnapshot);
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

  async publishReply(reply: SupervisorReplyInput | SupervisorReply): Promise<void> {
    await this.send(this.protocol.publishReply(reply));
  }

  /** 发布 reply 并等待父端累计 ACK；同一 reply_seq 只创建一次逻辑消息。 */
  async publishReplyAndWaitForAck(
    reply: SupervisorReplyInput | SupervisorReply,
    signal?: AbortSignal,
  ): Promise<void> {
    const frame = this.protocol.publishReply(reply);
    const replySeq = readReplySeq(frame);
    const waiter = createDeferred<void>();
    void waiter.promise.catch(() => {});
    this.replyAcknowledgements.set(replySeq, waiter);
    try {
      await this.send(frame);
      if (signal === undefined) await waiter.promise;
      else await raceSupervisorAbort(waiter.promise, signal);
    } catch (error) {
      if (this.replyAcknowledgements.get(replySeq) === waiter) this.replyAcknowledgements.delete(replySeq);
      if (error instanceof Error && error.name === "AbortError") throw error;
      this.fail("protocol_fault");
      throw new Error("监督回复未获确认");
    }
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
    for (const waiter of this.replyAcknowledgements.values()) waiter.reject(new Error("监督通道已关闭"));
    this.replyAcknowledgements.clear();
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
    const result = this.protocol.receive(frame);
    if (result.kind === "eof" || result.kind === "protocol_fault") {
      this.fail(result.kind === "eof" ? "eof" : "protocol_fault");
      return;
    }
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
    if (result.kind === "accepted" && result.control_request !== undefined) {
      notifySupervisorListeners(this.controlRequestListeners, result.control_request);
    }
    if (result.kind === "accepted" && result.control_response !== undefined) {
      notifySupervisorListeners(this.controlResponseListeners, result.control_response);
    }
    if (result.kind === "accepted" && result.reply_ack !== undefined) {
      this.resolveReplyAcknowledgements(result.reply_ack);
    }
    if (result.kind === "accepted" && result.close_requested === true) {
      this.handleCloseRequested();
    }
    if (result.kind === "accepted" || result.kind === "duplicate" || result.kind === "gap") {
      const sends: Promise<void>[] = [];
      for (const outbound of result.outbound) {
        const send = this.send(outbound);
        sends.push(send);
        void send.catch(() => this.fail("protocol_fault"));
      }
      if (this.isReady()) {
        void Promise.all(sends).then(
          () => this.ready.resolve(),
          () => this.fail("protocol_fault"),
        );
      }
    }
    if (this.protocol.role === "child" && !this.snapshotSent && this.protocol.getPublicState().state === "awaiting_snapshot") {
      this.snapshotSent = true;
      try {
        void this.send(this.protocol.publishSnapshot(this.initialSnapshot, this.initialSubtreeRevision));
      } catch {
        this.fail("protocol_fault");
        return;
      }
    }
    if (this.isReady()) this.ready.resolve();
  }

  private publicState(): SupervisorChannelPublicState {
    return this.protocol.getPublicState();
  }

  private async send(frame: SupervisorFrame): Promise<void> {
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

  private resolveReplyAcknowledgements(replySeq: number): void {
    for (const [sequence, waiter] of this.replyAcknowledgements) {
      if (sequence > replySeq) continue;
      this.replyAcknowledgements.delete(sequence);
      waiter.resolve();
    }
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
    for (const waiter of this.replyAcknowledgements.values()) waiter.reject(new Error("监督通道不可用"));
    this.replyAcknowledgements.clear();
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

function readReplySeq(frame: SupervisorFrame): number {
  const value = frame.payload.reply_seq;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error("监督回复序号无效");
  }
  return value as number;
}
