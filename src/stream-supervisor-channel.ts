import type { Readable, Writable } from "node:stream";
import {
  SupervisorChannel,
  SupervisorFrameDecoder,
  type SupervisorChannelOptions,
  type SupervisorFrame,
  type SupervisorEvent,
  type SupervisorReceiveResult,
  type SupervisorReply,
  type SupervisorChannelPublicState,
} from "./supervisor-channel.ts";
import type {
  RpcSupervisorChannel,
  RpcSupervisorChannelCloseState,
  RpcSupervisorChannelFault,
} from "./rpc-supervisor.ts";

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
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
  settled(): boolean;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: Error) => void;
  let done = false;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    rejectPromise = (reason) => {
      if (done) return;
      done = true;
      reject(reason);
    };
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise, settled: () => done };
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
  private readonly ready = deferred<void>();
  private readonly closed = deferred<void>();
  private readonly faults = new Set<(fault: RpcSupervisorChannelFault) => void>();
  private readonly eventListeners = new Set<(event: SupervisorEvent) => void>();
  private writeQueue: Promise<void> = Promise.resolve();
  private bound = false;
  private snapshotSent = false;
  private released = false;
  private faultNotified = false;
  private endpointClosed = false;

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
    });
    this.decoder = new SupervisorFrameDecoder(options.limits);
    this.initialSnapshot = Object.freeze([...(options.initialSnapshot ?? [])]);
    this.initialSubtreeRevision = options.initialSubtreeRevision;
    if (options.onEvent !== undefined) this.eventListeners.add(options.onEvent);
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
    if (signal.aborted) throw abortError();
    if (this.protocol.role === "child") {
      await this.send(this.protocol.startHandshake());
    }
  }

  async waitForReady(signal: AbortSignal): Promise<void> {
    if (this.isReady()) return;
    if (signal.aborted) throw abortError();
    await raceAbort(this.ready.promise, signal);
  }

  isReady(): boolean {
    return this.publicState().state === "ready";
  }

  async publishReply(reply: Omit<SupervisorReply, "reply_seq">): Promise<void> {
    await this.send(this.protocol.publishReply(reply));
  }

  /** child 端发布已经由 SupervisorChannel 校验的生命周期事实。 */
  async publishEvent(
    event: Omit<SupervisorEvent, "root_id" | "agent_id"> & { readonly agent_id?: string },
  ): Promise<void> {
    await this.send(this.protocol.publishEvent(event));
  }

  establishTerminationBarrier(): void {
    this.protocol.establishTerminationBarrier();
  }

  async requestClose(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw abortError();
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
      await Promise.race([
        this.closed.promise,
        new Promise<void>((resolve) => setTimeout(resolve, remaining)),
      ]);
    }
    return this.endpointClosed ? "released" : "present";
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.endpointClosed = true;
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

  private fail(fault: RpcSupervisorChannelFault): void {
    if (this.released) return;
    if (this.faultNotified) return;
    this.faultNotified = true;
    this.closed.resolve();
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

function abortError(): Error {
  const error = new Error("监督通道阶段已取消");
  error.name = "AbortError";
  return error;
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error("监督通道不可用"));
      },
    );
  });
}
