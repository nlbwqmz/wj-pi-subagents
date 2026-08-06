import {
  MANAGED_RPC_SUPERVISOR_MAX_BODY_BYTES,
  type ManagedRpcNodeLike,
  type ManagedRpcReply,
} from "./managed-rpc-node.ts";
import type {
  RpcSupervisorChannel,
  RpcSupervisorChannelCloseState,
  RpcSupervisorChannelFault,
} from "./rpc-supervisor.ts";
import {
  SupervisorChannel,
  type SupervisorChannelOptions,
  type SupervisorEvent,
  type SupervisorFrame,
  type SupervisorReply,
} from "./supervisor-channel.ts";

type ParentSupervisorOptions = Omit<SupervisorChannelOptions, "role">;

export interface ManagedRpcSupervisorChannelOptions extends ParentSupervisorOptions {
  readonly node: ManagedRpcNodeLike;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
  settled(): boolean;
}

function deferred<T>(): Deferred<T> {
  let done = false;
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    rejectPromise = (error) => {
      if (done) return;
      done = true;
      reject(error);
    };
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise, settled: () => done };
}

/**
 * 父端监督协议适配器。监督帧通过 ManagedRpcNode 的唯一桥接读取者复用，
 * 不会与任务命令争抢 stdout，也不会暴露底层进程或 transport。
 */
export class ManagedRpcSupervisorChannel implements RpcSupervisorChannel {
  private readonly node: ManagedRpcNodeLike;
  private readonly protocol: SupervisorChannel;
  private readonly ready = deferred<void>();
  private readonly closed = deferred<void>();
  private readonly faults = new Set<(fault: RpcSupervisorChannelFault) => void>();
  private readonly events = new Set<(event: SupervisorEvent) => void>();
  private readonly unsubscribeFrame: () => void;
  private readonly unsubscribeTransport: () => void;
  private writeQueue: Promise<void> = Promise.resolve();
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
    });
    this.unsubscribeFrame = this.node.onSupervisorFrame((frame) => this.receive(frame));
    this.unsubscribeTransport = this.node.onTransportFault((fault) => {
      this.endpointClosed = true;
      this.closed.resolve();
      this.fail(fault === "protocol_fault" ? "protocol_fault" : "eof");
    });
  }

  async bind(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw abortError();
    this.bound = true;
  }

  async waitForReady(signal: AbortSignal): Promise<void> {
    if (!this.bound) throw new Error("监督通道尚未绑定");
    if (this.isReady()) return;
    await raceAbort(this.ready.promise, signal);
  }

  isReady(): boolean {
    return this.protocol.getPublicState().state === "ready";
  }

  async publishReply(reply: Omit<SupervisorReply, "reply_seq">): Promise<void> {
    const value: ManagedRpcReply = {
      text: reply.text,
      ...(reply.images === undefined
        ? {}
        : { images: reply.images.map((image) => Object.freeze({ ...image })) }),
    };
    await this.node.publishSupervisorReply(value);
  }

  establishTerminationBarrier(): void {
    this.protocol.establishTerminationBarrier();
  }

  async requestClose(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw abortError();
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
    this.unsubscribeFrame();
    this.unsubscribeTransport();
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

  private receive(frame: Uint8Array): void {
    if (this.released) return;
    const result = this.protocol.receive(frame);
    if (result.kind === "protocol_fault" || result.kind === "eof") {
      this.fail(result.kind === "eof" ? "eof" : "protocol_fault");
      return;
    }
    if (result.kind === "accepted" && result.event !== undefined) {
      for (const listener of this.events) {
        try {
          listener(result.event);
        } catch {
          // 生命周期观察者异常不能改变协议状态。
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
      return;
    }
    if (this.isReady()) this.ready.resolve();
  }

  private send(frame: SupervisorFrame): Promise<void> {
    const bytes = this.protocol.encode(frame);
    const operation = this.writeQueue.catch(() => {}).then(
      () => this.node.sendSupervisorFrame(bytes),
    );
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  private fail(fault: RpcSupervisorChannelFault): void {
    if (this.released || this.faultNotified) return;
    this.faultNotified = true;
    if (!this.ready.settled()) this.ready.reject(new Error("监督通道不可用"));
    for (const listener of this.faults) {
      try {
        listener(fault);
      } catch {
        // 故障观察者异常不能再次进入失败路径。
      }
    }
  }
}

function abortError(): Error {
  const error = new Error("监督通道阶段已取消");
  error.name = "AbortError";
  return error;
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
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
