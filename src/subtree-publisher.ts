import { isDeepStrictEqual } from "node:util";

/** 数据源每次读取都返回当前完整子树，而不是增量事件。 */
export interface SubtreeSnapshot<TNode> {
  readonly nodes: readonly TNode[];
  readonly subtreeRevision: number;
}

/** 完整子树发布器所需的最小只读数据源。 */
export interface SubtreeSnapshotSource<TNode, TEvent = never> {
  read(): SubtreeSnapshot<TNode>;
  onChange(listener: () => void): () => void;
  /** 可选的已应用生命周期事实观察；只读、按产生顺序交付。 */
  onLifecycleEvent?(listener: (event: TEvent) => void): () => void;
}

/** 完整子树发布器所需的最小异步写入端。 */
export interface SubtreeSnapshotSink<TNode, TEvent = never> {
  publishSnapshot(nodes: readonly TNode[], revision: number): Promise<void>;
  /** 与快照共用同一写入流的生命周期事实写入。 */
  publishEvent?(event: TEvent): Promise<void>;
}

type PublisherState = "idle" | "running" | "closing" | "closed";

interface PendingFailure {
  readonly error: unknown;
}

function cloneFrozenValue<T>(value: T, copies: WeakMap<object, unknown>): T {
  if (value === null || typeof value !== "object") {
    if (typeof value === "function") throw new TypeError("子树节点不能包含函数");
    return value;
  }

  const existing = copies.get(value);
  if (existing !== undefined) return existing as T;

  if (Array.isArray(value)) {
    const copy: unknown[] = new Array(value.length);
    copies.set(value, copy);
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor?.enumerable !== true) continue;
      Object.defineProperty(copy, key, {
        value: cloneFrozenValue(Reflect.get(value, key), copies),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return Object.freeze(copy) as T;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("子树节点只能包含普通对象、数组和原始值");
  }

  const copy = Object.create(prototype) as Record<PropertyKey, unknown>;
  copies.set(value, copy);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.enumerable !== true) continue;
    Object.defineProperty(copy, key, {
      value: cloneFrozenValue(Reflect.get(value, key), copies),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return Object.freeze(copy) as T;
}

/** 创建不共享源对象引用的深冻结完整快照。 */
function cloneFrozenNodes<TNode>(nodes: readonly TNode[]): readonly TNode[] {
  if (!Array.isArray(nodes)) throw new TypeError("子树快照 nodes 必须是数组");
  return cloneFrozenValue(nodes, new WeakMap<object, unknown>());
}

function assertRevision(revision: number, acceptedRevision: number | undefined): void {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new RangeError("子树修订必须是非负安全整数");
  }
  if (acceptedRevision !== undefined && revision < acceptedRevision) {
    throw new RangeError("子树修订不能倒退");
  }
}

/**
 * 把易变的完整子树事实合并到单写入流，并保留生命周期事实的 FIFO。
 *
 * 快照可以合并为最新值；生命周期事实处于运行态时按 FIFO 发布。每次事实
 * 成功写入后才从队首移除，失败会保留原事实供下一次 flush 重试。
 */
export class SubtreePublisher<TNode, TEvent = never> {
  private readonly source: SubtreeSnapshotSource<TNode, TEvent>;
  private readonly sink: SubtreeSnapshotSink<TNode, TEvent>;
  private state: PublisherState = "idle";
  private unsubscribe: (() => void) | undefined;
  private unsubscribeLifecycle: (() => void) | undefined;
  private inFlight: Promise<void> | undefined;
  private closeOperation: Promise<void> | undefined;
  private dirty = false;
  private readonly pendingLifecycleEvents: TEvent[] = [];
  private acceptedRevision: number | undefined;
  private lastPublishedNodes: readonly TNode[] | undefined;
  private pendingFailure: PendingFailure | undefined;

  constructor(
    source: SubtreeSnapshotSource<TNode, TEvent>,
    sink: SubtreeSnapshotSink<TNode, TEvent>,
  ) {
    this.source = source;
    this.sink = sink;
  }

  /**
   * 订阅数据源并发布启动时的当前完整快照。调用方已经通过握手可靠发送首
   * 快照时，可传入该基线，避免在 ready 后重复发送同一修订。
   */
  start(initial?: SubtreeSnapshot<TNode>): Promise<void> {
    if (this.state === "running") return this.flush();
    if (this.state === "closing" || this.state === "closed") {
      return Promise.reject(new Error("子树发布器已经关闭"));
    }

    if (initial !== undefined) {
      assertRevision(initial.subtreeRevision, undefined);
      this.acceptedRevision = initial.subtreeRevision;
      this.lastPublishedNodes = cloneFrozenNodes(initial.nodes);
    }
    this.state = "running";
    this.dirty = true;
    let unsubscribe: (() => void) | undefined;
    let unsubscribeLifecycle: (() => void) | undefined;
    try {
      unsubscribe = this.source.onChange(this.handleSourceChange);
      if (typeof unsubscribe !== "function") {
        throw new TypeError("子树数据源必须返回退订函数");
      }
      const onLifecycleEvent = this.source.onLifecycleEvent;
      if (onLifecycleEvent !== undefined) {
        if (typeof this.sink.publishEvent !== "function") {
          throw new TypeError("生命周期事实写入端不可用");
        }
        unsubscribeLifecycle = onLifecycleEvent.call(this.source, this.handleLifecycleEvent);
        if (typeof unsubscribeLifecycle !== "function") {
          throw new TypeError("生命周期事实数据源必须返回退订函数");
        }
      }
      this.unsubscribe = unsubscribe;
      this.unsubscribeLifecycle = unsubscribeLifecycle;
    } catch (error) {
      try { unsubscribeLifecycle?.(); } catch { /* 保持原始启动错误。 */ }
      try { unsubscribe?.(); } catch { /* 保持原始启动错误。 */ }
      this.state = "idle";
      this.dirty = false;
      return Promise.reject(error);
    }
    return this.flush();
  }

  /** 等到当前 dirty 快照发布完成；失败会原样返回，并保留 dirty 供重试。 */
  async flush(): Promise<void> {
    if (this.state === "idle") throw new Error("子树发布器尚未启动");
    if (this.state === "closing" || this.state === "closed") {
      if (this.inFlight !== undefined) await this.inFlight;
      return;
    }

    if (this.inFlight === undefined && this.pendingFailure !== undefined) {
      const failure = this.pendingFailure;
      this.pendingFailure = undefined;
      throw failure.error;
    }

    const operation = this.ensureDrain();
    try {
      await operation;
    } catch (error) {
      if (this.pendingFailure !== undefined && Object.is(this.pendingFailure.error, error)) {
        this.pendingFailure = undefined;
      }
      throw error;
    }
  }

  /** 立即退订，等待已经开始的写入，然后永久停止发布。 */
  close(): Promise<void> {
    if (this.closeOperation !== undefined) return this.closeOperation;
    if (this.state === "closed") return Promise.resolve();

    this.state = "closing";
    const unsubscribe = this.unsubscribe;
    const unsubscribeLifecycle = this.unsubscribeLifecycle;
    this.unsubscribe = undefined;
    this.unsubscribeLifecycle = undefined;
    let unsubscribeFailure: PendingFailure | undefined;
    if (unsubscribe !== undefined) {
      try {
        unsubscribe();
      } catch (error) {
        unsubscribeFailure = { error };
      }
    }
    if (unsubscribeLifecycle !== undefined) {
      try {
        unsubscribeLifecycle();
      } catch (error) {
        unsubscribeFailure = unsubscribeFailure === undefined
          ? { error }
          : { error: new AggregateError([unsubscribeFailure.error, error], "子树发布器退订失败") };
      }
    }

    const operation = this.finishClose(this.inFlight, unsubscribeFailure);
    this.closeOperation = operation;
    return operation;
  }

  private readonly handleSourceChange = (): void => {
    if (this.state !== "running") return;
    this.dirty = true;
    this.launchBackgroundDrain();
  };

  private readonly handleLifecycleEvent = (event: TEvent): void => {
    if (this.state !== "running") return;
    this.pendingLifecycleEvents.push(event);
    this.launchBackgroundDrain();
  };

  private launchBackgroundDrain(): void {
    const operation = this.ensureDrain();
    void operation.catch(() => {
      // 观察回调没有错误接收端；失败已保存在 pendingFailure，供 flush 返回。
    });
  }

  private ensureDrain(): Promise<void> {
    if (this.inFlight !== undefined) return this.inFlight;
    if (this.state !== "running" || (!this.dirty && this.pendingLifecycleEvents.length === 0)) {
      return Promise.resolve();
    }

    this.pendingFailure = undefined;
    let succeeded = false;
    const running = Promise.resolve().then(async () => {
      await this.drain();
      succeeded = true;
    });
    let tracked!: Promise<void>;
    tracked = running.finally(() => {
      if (this.inFlight !== tracked) return;
      this.inFlight = undefined;
      // 覆盖 drain 结束与 Promise 清理之间到达的事实或变化，不为失败做无界自动重试。
      if (
        succeeded
        && this.state === "running"
        && (this.dirty || this.pendingLifecycleEvents.length > 0)
      ) this.launchBackgroundDrain();
    });
    this.inFlight = tracked;
    return tracked;
  }

  private async drain(): Promise<void> {
    while (
      this.state === "running"
      && (this.pendingLifecycleEvents.length > 0 || this.dirty)
    ) {
      let snapshotAttempted = false;
      try {
        while (this.pendingLifecycleEvents.length > 0) {
          const publishEvent = this.sink.publishEvent;
          if (typeof publishEvent !== "function") {
            throw new TypeError("生命周期事实写入端不可用");
          }
          const event = this.pendingLifecycleEvents[0]!;
          await publishEvent.call(this.sink, event);
          this.pendingLifecycleEvents.shift();
        }
        if (this.dirty) {
          this.dirty = false;
          snapshotAttempted = true;
          await this.publishLatest();
        }
      } catch (error) {
        // 事件只在成功后出队；快照失败则保留 dirty 供显式重试。
        if (snapshotAttempted) this.dirty = true;
        this.pendingFailure = { error };
        throw error;
      }
    }
  }

  private async publishLatest(): Promise<void> {
    const current = this.source.read();
    assertRevision(current.subtreeRevision, this.acceptedRevision);
    const nodes = cloneFrozenNodes(current.nodes);

    // close 可能由同步 read 实现重入；此时尚未开始的写入必须取消。
    if (this.state !== "running") return;

    if (this.acceptedRevision !== undefined) {
      if (current.subtreeRevision === this.acceptedRevision) return;
      if (
        this.lastPublishedNodes !== undefined
        && isDeepStrictEqual(nodes, this.lastPublishedNodes)
      ) {
        this.acceptedRevision = current.subtreeRevision;
        return;
      }
    }

    await this.sink.publishSnapshot(nodes, current.subtreeRevision);
    this.lastPublishedNodes = nodes;
    this.acceptedRevision = current.subtreeRevision;
  }

  private async finishClose(
    activeWrite: Promise<void> | undefined,
    unsubscribeFailure: PendingFailure | undefined,
  ): Promise<void> {
    let writeFailure: PendingFailure | undefined;
    if (activeWrite !== undefined) {
      try {
        await activeWrite;
      } catch (error) {
        writeFailure = { error };
      }
    }

    this.dirty = false;
    this.pendingLifecycleEvents.length = 0;
    this.pendingFailure = undefined;
    this.state = "closed";

    if (unsubscribeFailure !== undefined && writeFailure !== undefined) {
      throw new AggregateError(
        [unsubscribeFailure.error, writeFailure.error],
        "子树发布器关闭时退订和在途写入均失败",
      );
    }
    if (unsubscribeFailure !== undefined) throw unsubscribeFailure.error;
    if (writeFailure !== undefined) throw writeFailure.error;
  }
}
