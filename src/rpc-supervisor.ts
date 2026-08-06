import type {
  ManagedRpcNodeLike,
  ManagedRpcNodeStartContext,
} from "./managed-rpc-node.ts";
import type {
  SupervisorControlRequest,
  SupervisorControlResponse,
  SupervisorEvent,
  SupervisorReply,
  SupervisorSnapshot,
} from "./supervisor-channel.ts";
import type {
  AgentLifecycleEvent,
  AgentLifecycleState,
  AgentSnapshot,
  ControlResult,
  LifecycleEventOutcome,
  PublicErrorCode,
  ReserveStartingChildInput,
  ReservedAgentOutcome,
  TreeActor,
} from "./tree-controller.ts";
import type { SpawnGrant } from "./tree-authority.ts";

export type RpcSupervisorTransportFault = "eof" | "protocol_fault" | "process_exit";

export interface RpcSupervisorImage {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

/**
 * Pi RpcClient 的监督适配接口。生产适配器委托 Pi 公共命令方法，并额外提供
 * 传输退出观察；监督器本身不解析或复制 Pi JSONL 协议。
 */
export interface RpcSupervisorClient {
  /** 客户端的 RPC 进程必须与监督器持有的平台树句柄属于同一启动事务。 */
  readonly process_binding: "managed";
  start(): Promise<void>;
  prompt(message: string, images?: readonly RpcSupervisorImage[]): Promise<void>;
  steer(message: string, images?: readonly RpcSupervisorImage[]): Promise<void>;
  abort(): Promise<void>;
  getState(): Promise<unknown>;
  onEvent(listener: (event: unknown) => void): () => void;
  onTransportFault(listener: (fault: RpcSupervisorTransportFault) => void): () => void;
}

/** Pi 公开 RpcClient 在监督器所需范围内的结构类型。 */
export interface PiRpcClientPublic {
  start(): Promise<void>;
  prompt(message: string, images?: RpcSupervisorImage[]): Promise<void>;
  steer(message: string, images?: RpcSupervisorImage[]): Promise<void>;
  abort(): Promise<void>;
  getState(): Promise<unknown>;
  onEvent(listener: (event: unknown) => void): () => void;
}

/** 由进程/传输装配层提供，不读取或重复解析 Pi RPC stdout。 */
export interface RpcTransportFaultObserver {
  onFault(listener: (fault: RpcSupervisorTransportFault) => void): () => void;
}

/**
 * Pi 公共 RpcClient 的命令/事件适配层。
 *
 * 该类型本身不声称 Pi 自行 spawn 的进程已经进入平台进程树；生产装配必须先
 * 提供同一进程的受管 transport 与退出观察，再包装为 `RpcSupervisorClient`。
 */
export class PiRpcClientAdapter {
  private readonly client: PiRpcClientPublic;
  private readonly transport: RpcTransportFaultObserver;

  constructor(client: PiRpcClientPublic, transport: RpcTransportFaultObserver) {
    this.client = client;
    this.transport = transport;
  }

  start(): Promise<void> {
    return this.client.start();
  }

  prompt(message: string, images?: readonly RpcSupervisorImage[]): Promise<void> {
    return this.client.prompt(message, this.copyImages(images));
  }

  steer(message: string, images?: readonly RpcSupervisorImage[]): Promise<void> {
    return this.client.steer(message, this.copyImages(images));
  }

  abort(): Promise<void> {
    return this.client.abort();
  }

  getState(): Promise<unknown> {
    return this.client.getState();
  }

  onEvent(listener: (event: unknown) => void): () => void {
    return this.client.onEvent(listener);
  }

  onTransportFault(listener: (fault: RpcSupervisorTransportFault) => void): () => void {
    return this.transport.onFault(listener);
  }

  private copyImages(
    images: readonly RpcSupervisorImage[] | undefined,
  ): RpcSupervisorImage[] | undefined {
    return images?.map((image) => ({ ...image }));
  }
}

export interface FakeRpcClientOptions {
  readonly onOperation?: (operation: string) => void;
  readonly transportEventOnStart?: RpcSupervisorTransportFault;
  readonly state?: unknown;
}

export type FakeRpcControlledOperation = "prompt" | "steer" | "abort";

export interface FakeRpcCommandGate {
  readonly started: Promise<void>;
  resolve(): void;
  reject(error?: Error): void;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

interface FakeRpcInternalGate {
  readonly started: Deferred<void>;
  readonly completion: Deferred<void>;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

/** Pi RpcClient 系统 seam 的确定性替身，不实现或模拟 JSONL 编解码。 */
export class FakeRpcClient implements RpcSupervisorClient {
  readonly process_binding = "managed" as const;

  private readonly options: FakeRpcClientOptions;
  private readonly eventListeners = new Set<(event: unknown) => void>();
  private readonly transportListeners = new Set<(fault: RpcSupervisorTransportFault) => void>();
  private readonly operationLog: string[] = [];
  private readonly gates = new Map<FakeRpcControlledOperation, FakeRpcInternalGate[]>();
  private readonly inFlightGates = new Set<FakeRpcInternalGate>();

  constructor(options: FakeRpcClientOptions = {}) {
    this.options = options;
  }

  async start(): Promise<void> {
    this.record("start");
    if (this.options.transportEventOnStart !== undefined) {
      this.emitTransportFault(this.options.transportEventOnStart);
    }
  }

  async prompt(_message: string, _images?: readonly RpcSupervisorImage[]): Promise<void> {
    this.record("prompt");
    await this.waitForGate("prompt");
  }

  async steer(_message: string, _images?: readonly RpcSupervisorImage[]): Promise<void> {
    this.record("steer");
    await this.waitForGate("steer");
  }

  async abort(): Promise<void> {
    this.record("abort");
    await this.waitForGate("abort");
  }

  async getState(): Promise<unknown> {
    this.record("get_state");
    return this.options.state ?? Object.freeze({ isStreaming: false, pendingMessageCount: 0 });
  }

  onEvent(listener: (event: unknown) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onTransportFault(listener: (fault: RpcSupervisorTransportFault) => void): () => void {
    this.transportListeners.add(listener);
    return () => this.transportListeners.delete(listener);
  }

  emitEvent(event: unknown): void {
    for (const listener of this.eventListeners) listener(event);
  }

  emitTransportFault(fault: RpcSupervisorTransportFault): void {
    for (const gate of this.inFlightGates) {
      gate.completion.reject(new Error(`Fake RPC transport ${fault}`));
    }
    for (const listener of this.transportListeners) listener(fault);
  }

  operations(): readonly string[] {
    return Object.freeze([...this.operationLog]);
  }

  deferNext(operation: FakeRpcControlledOperation): FakeRpcCommandGate {
    const gate: FakeRpcInternalGate = {
      started: deferred<void>(),
      completion: deferred<void>(),
    };
    const queue = this.gates.get(operation) ?? [];
    queue.push(gate);
    this.gates.set(operation, queue);
    return Object.freeze({
      started: gate.started.promise,
      resolve: () => gate.completion.resolve(),
      reject: (error = new Error(`Fake RPC ${operation} 失败`)) => gate.completion.reject(error),
    });
  }

  private record(operation: string): void {
    this.operationLog.push(operation);
    this.options.onOperation?.(operation);
  }

  private async waitForGate(operation: FakeRpcControlledOperation): Promise<void> {
    const queue = this.gates.get(operation);
    const gate = queue?.shift();
    if (queue !== undefined && queue.length === 0) this.gates.delete(operation);
    if (gate === undefined) return;
    gate.started.resolve();
    this.inFlightGates.add(gate);
    try {
      await gate.completion.promise;
    } finally {
      this.inFlightGates.delete(gate);
    }
  }
}

export type RpcSupervisorChannelCloseState = "released" | "present" | "unknown";
export type RpcSupervisorChannelFault = "eof" | "protocol_fault";

export type RpcSupervisorActivityCategory =
  | "editing"
  | "reading"
  | "running"
  | "researching"
  | "delegating"
  | "other";

export interface RpcSupervisorActivity {
  readonly category: RpcSupervisorActivityCategory;
  readonly phase: "started" | "finished";
  readonly active_count: number;
}

export type RpcSupervisorFaultCode =
  | "rpc_eof"
  | "rpc_protocol_fault"
  | "rpc_process_exit"
  | "supervisor_eof"
  | "supervisor_protocol_fault"
  | "invalid_rpc_event";

export type RpcSupervisorEvent =
  | {
      readonly kind: "lifecycle";
      readonly event: AgentLifecycleEvent;
    }
  | {
      readonly kind: "activity";
      readonly activity: RpcSupervisorActivity;
    }
  | {
      readonly kind: "reply";
      readonly reply: Omit<SupervisorReply, "reply_seq">;
    }
  | {
      readonly kind: "fault";
      readonly code: RpcSupervisorFaultCode;
    };

/** 监督协议端点与本机传输组合后的单关系会话接口。 */
export interface RpcSupervisorChannel {
  bind(signal: AbortSignal): Promise<void>;
  waitForReady(signal: AbortSignal): Promise<void>;
  isReady(): boolean;
  publishReply(reply: Omit<SupervisorReply, "reply_seq">): Promise<void>;
  establishTerminationBarrier(): void;
  requestClose(signal: AbortSignal): Promise<void>;
  waitForClose(deadline: number | Date): Promise<RpcSupervisorChannelCloseState>;
  release(): Promise<void>;
  onFault(listener: (fault: RpcSupervisorChannelFault) => void): () => void;
  /** 父端收到子端安全生命周期事实时调用；旧替身可省略。 */
  onEvent?(listener: (event: SupervisorEvent) => void): () => void;
  onSnapshot?(listener: (snapshot: SupervisorSnapshot) => void): () => void;
  /** child 端沿唯一祖先方向发布内部控制请求。 */
  publishControlRequest?(request: SupervisorControlRequest): Promise<void>;
  /** parent 端向直接子控制器返回内部控制结果。 */
  publishControlResponse?(response: SupervisorControlResponse): Promise<void>;
  onControlRequest?(listener: (request: SupervisorControlRequest) => void): () => void;
  onControlResponse?(listener: (response: SupervisorControlResponse) => void): () => void;
  /** 子端向直接父端发布安全生命周期事实；旧替身可省略。 */
  publishEvent?(event: Omit<SupervisorEvent, "root_id" | "agent_id"> & {
    readonly agent_id?: string;
  }): Promise<void>;
}

export interface RpcSupervisorChannelFactoryContext {
  readonly agent_id: string;
  readonly parent_agent_id: string | null;
  readonly depth: number;
  readonly initial_snapshot: readonly AgentSnapshot[];
}

export interface RpcSupervisorChannelBinding {
  readonly channel: RpcSupervisorChannel;
  readonly nodeStartContext?: ManagedRpcNodeStartContext;
  /** 通道上的控制路由等附属资源，随监督器最终释放。 */
  readonly cleanup?: () => void;
}

export interface RpcSupervisorController {
  reserveStartingChild(
    actor: TreeActor | unknown,
    input: ReserveStartingChildInput | unknown,
  ): ControlResult<ReservedAgentOutcome>;
  applyLifecycleEvent(
    agentId: unknown,
    event: AgentLifecycleEvent | unknown,
  ): ControlResult<LifecycleEventOutcome>;
  applySubtreeSnapshot?(
    actor: TreeActor | unknown,
    input: SupervisorSnapshot,
  ): ControlResult<unknown>;
}

export interface RpcSupervisorOptions {
  readonly controller: RpcSupervisorController;
  readonly actor: TreeActor;
  readonly reservation: ReserveStartingChildInput;
  /** AgentController 已从根权威取得的预留；生产路径必须提供。 */
  readonly grant?: SpawnGrant;
  /** RPC 命令面和进程树必须由同一受管节点在同一启动事务中提供。 */
  readonly managedNode: ManagedRpcNodeLike;
  readonly channel?: RpcSupervisorChannel;
  /** 生产装配在身份预留后创建通道，并把同一身份上下文交给桥接进程。 */
  readonly channelFactory?: (
    context: RpcSupervisorChannelFactoryContext,
  ) => RpcSupervisorChannelBinding;
  readonly startupTimeoutMs: number;
  readonly gracefulShutdownMs: number;
  readonly now?: () => number;
}

export type RpcSupervisorStartupResult =
  | {
      readonly ok: true;
      readonly agent_id: string;
      readonly state: "idle";
    }
  | {
      readonly ok: false;
      readonly code: PublicErrorCode;
      readonly agent_id?: string;
      readonly cleanup?: "confirmed" | "incomplete";
    };

export type RpcSupervisorCommandResult =
  | {
      readonly ok: true;
      readonly accepted: true;
    }
  | {
      readonly ok: false;
      readonly code: "agent_unavailable" | "message_delivery_failed";
    };

export type RpcSupervisorInterruptResult =
  | {
      readonly ok: true;
      readonly accepted: boolean;
      readonly changed: boolean;
    }
  | {
      readonly ok: false;
      readonly code: "agent_unavailable";
    };

export type RpcSupervisorTerminationResult =
  | {
      readonly ok: true;
      readonly agent_id: string;
      readonly state: "terminated";
      readonly cleanup: "confirmed";
    }
  | {
      readonly ok: false;
      readonly agent_id?: string;
      readonly code: "agent_unavailable" | "termination_incomplete";
      readonly state?: "terminating";
      readonly cleanup?: "incomplete";
    };

type LifecycleEventWithoutGeneration = AgentLifecycleEvent extends infer Event
  ? Event extends AgentLifecycleEvent
    ? Omit<Event, "expected_generation">
    : never
  : never;

class StartupTimeoutError extends Error {
  constructor() {
    super("RPC 监督器启动超时");
    this.name = "StartupTimeoutError";
  }
}

function validDuration(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function abortError(): Error {
  const error = new Error("RPC 监督器阶段已取消");
  error.name = "AbortError";
  return error;
}

const IGNORED_RPC_EVENT_TYPES = new Set([
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "tool_execution_update",
  "queue_update",
  "compaction_start",
  "compaction_end",
  "entry_appended",
  "session_info_changed",
  "thinking_level_changed",
  "auto_retry_start",
  "auto_retry_end",
  "summarization_retry_scheduled",
  "summarization_retry_attempt_start",
  "summarization_retry_finished",
  "bash_execution_update",
]);

function activityCategory(toolName: string): RpcSupervisorActivityCategory {
  const normalized = toolName.toLowerCase();
  if (/apply[_-]?patch|edit|write|create|delete|move|rename/.test(normalized)) return "editing";
  if (/read|view|list|find|grep|search|glob|stat/.test(normalized)) return "reading";
  if (/bash|shell|exec|command|terminal/.test(normalized)) return "running";
  if (/web|browser|browse|fetch|http|research/.test(normalized)) return "researching";
  if (/agent|delegate|subtask/.test(normalized)) return "delegating";
  return "other";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type MessageCommandKind = "prompt" | "steer";

interface QueuedMessageCommand {
  readonly kind: MessageCommandKind;
  readonly message: string;
  readonly images: readonly RpcSupervisorImage[] | undefined;
  resolve(result: RpcSupervisorCommandResult): void;
}

interface QueuedInterruptCommand {
  readonly kind: "abort";
  resolve(result: RpcSupervisorInterruptResult): void;
}

type QueuedCommand = QueuedMessageCommand | QueuedInterruptCommand;

/**
 * 单节点 RPC 监督器。树所有权和公开生命周期仍由注入控制器裁决；本模块只
 * 串行协调该节点的 RPC、监督通道和进程树资源。
 */
export class RpcSupervisor {
  private readonly options: RpcSupervisorOptions;
  private readonly now: () => number;
  private channel: RpcSupervisorChannel | undefined;
  private managedNodeStartContext: ManagedRpcNodeStartContext | undefined;
  private channelBindingCleanup: (() => void) | undefined;
  private phase: "new" | "starting" | "ready" | "failed" | "terminating" | "terminated" = "new";
  private agentId: string | undefined;
  private lifecycleGeneration = 0;
  private lifecycleState: AgentLifecycleState | undefined;
  private startupFault: RpcSupervisorTransportFault | RpcSupervisorChannelFault | undefined;
  private startPromise: Promise<RpcSupervisorStartupResult> | undefined;
  private unsubscribeRpcEvent: (() => void) | undefined;
  private unsubscribeRpcFault: (() => void) | undefined;
  private unsubscribeChannelFault: (() => void) | undefined;
  private unsubscribeChannelEvent: (() => void) | undefined;
  private unsubscribeChannelSnapshot: (() => void) | undefined;
  private readonly commandQueue: QueuedCommand[] = [];
  private activeCommand: QueuedCommand | undefined;
  private acceptancePending = false;
  private settlePending = false;
  private readonly eventListeners = new Set<(event: RpcSupervisorEvent) => void>();
  private readonly activeTools = new Map<string, RpcSupervisorActivityCategory>();
  private readonly activeToolCounts = new Map<RpcSupervisorActivityCategory, number>();
  private terminationPromise: Promise<RpcSupervisorTerminationResult> | undefined;
  private cleanupInFlight: Promise<"confirmed" | "incomplete"> | undefined;
  private lateStartupCleanupScheduled = false;
  private processResourcesConfirmed = false;
  private channelResourcesConfirmed = false;
  private nodeHandleReleased = false;
  private channelHandleReleased = false;
  private forcedTerminationUsed = false;

  constructor(options: RpcSupervisorOptions) {
    if (!validDuration(options.startupTimeoutMs) || !validDuration(options.gracefulShutdownMs)) {
      throw new TypeError("RPC 监督器期限无效");
    }
    if (options.managedNode.process_binding !== "managed") {
      throw new TypeError("受管 RPC 节点绑定标记无效");
    }
    if ((options.channel === undefined) === (options.channelFactory === undefined)) {
      throw new TypeError("RPC 监督器必须使用一个监督通道或身份后通道工厂");
    }
    this.options = options;
    this.now = options.now ?? Date.now;
    this.channel = options.channel;
  }

  start(): Promise<RpcSupervisorStartupResult> {
    this.startPromise ??= this.runStart();
    return this.startPromise;
  }

  onEvent(listener: (event: RpcSupervisorEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  prompt(
    message: string,
    images?: readonly RpcSupervisorImage[],
  ): Promise<RpcSupervisorCommandResult> {
    return this.enqueueMessage("prompt", message, images);
  }

  steer(
    message: string,
    images?: readonly RpcSupervisorImage[],
  ): Promise<RpcSupervisorCommandResult> {
    return this.enqueueMessage("steer", message, images);
  }

  interrupt(): Promise<RpcSupervisorInterruptResult> {
    if (this.phase !== "ready") {
      return Promise.resolve(Object.freeze({ ok: false, code: "agent_unavailable" }));
    }
    if (this.lifecycleState !== "working") {
      return Promise.resolve(Object.freeze({
        ok: true,
        accepted: false,
        changed: false,
      }));
    }
    return new Promise<RpcSupervisorInterruptResult>((resolve) => {
      this.commandQueue.push({ kind: "abort", resolve });
      this.drainCommandQueue();
    });
  }

  terminate(): Promise<RpcSupervisorTerminationResult> {
    if (this.terminationPromise !== undefined) return this.terminationPromise;
    if (this.phase === "terminated" && this.agentId !== undefined) {
      return Promise.resolve(Object.freeze({
        ok: true,
        agent_id: this.agentId,
        state: "terminated",
        cleanup: "confirmed",
      }));
    }
    if (this.phase === "terminating" && this.agentId !== undefined) {
      return this.beginTerminationAttempt();
    }
    if ((this.phase !== "ready" && this.phase !== "failed") || this.agentId === undefined) {
      return Promise.resolve(Object.freeze({ ok: false, code: "agent_unavailable" }));
    }

    const abortActiveRpc = this.activeCommand !== undefined ||
      this.lifecycleState === "working" ||
      this.lifecycleState === "interrupting";
    this.applyLifecycle({ type: "termination_requested" });
    this.phase = "terminating";
    this.settlePending = false;
    this.channel?.establishTerminationBarrier();
    this.cancelQueuedCommands();
    this.resolveActiveMessageAsUnavailable();

    if (abortActiveRpc) {
      try {
        void this.commandClient().abort().catch(() => {
          // 终止屏障已经线性化；abort 失败不撤销关闭意图。
        });
      } catch {
        // 同步适配器异常同样由最终资源观察裁决。
      }
    }

    return this.beginTerminationAttempt();
  }

  /** 清理结果摘要使用；不会暴露平台句柄或底层阶段。 */
  wasForcedTerminationUsed(): boolean {
    return this.forcedTerminationUsed;
  }

  /**
   * 中间父故障后回收其整棵平台进程树，但不把故障父记录伪装成 terminated。
   * 根权威随后只确认该边界覆盖的后代，故障父继续占名额等待显式终止。
   */
  async reapOrphanedDescendants(): Promise<{ readonly confirmed: boolean; readonly forced: boolean }> {
    if (this.phase !== "failed" || this.agentId === undefined) {
      return Object.freeze({ confirmed: false, forced: this.forcedTerminationUsed });
    }
    this.channel?.establishTerminationBarrier();
    const cleanup = await this.cleanupResources(true, false);
    return Object.freeze({
      confirmed: cleanup === "confirmed",
      forced: this.forcedTerminationUsed,
    });
  }

  private beginTerminationAttempt(): Promise<RpcSupervisorTerminationResult> {
    const attempt = this.runTermination();
    this.terminationPromise = attempt;
    void attempt.then(
      (result) => {
        if (!result.ok && this.terminationPromise === attempt) this.terminationPromise = undefined;
      },
      () => {
        if (this.terminationPromise === attempt) this.terminationPromise = undefined;
      },
    );
    return attempt;
  }

  private async runStart(): Promise<RpcSupervisorStartupResult> {
    if (this.phase !== "new") {
      return Object.freeze({ ok: false, code: "internal_error" });
    }
    this.phase = "starting";

    const reserved = this.options.grant === undefined
      ? this.options.controller.reserveStartingChild(
          this.options.actor,
          this.options.reservation,
        )
      : Object.freeze({
          ok: true as const,
          data: Object.freeze({
            node: this.options.grant.node,
            lifecycle_generation: this.options.grant.lifecycle_generation,
            tree_revision: this.options.grant.tree_revision,
          }),
        });
    if (!reserved.ok) {
      this.phase = "terminated";
      return Object.freeze({ ok: false, code: reserved.error.code });
    }

    this.agentId = reserved.data.node.agent_id;
    this.lifecycleGeneration = reserved.data.lifecycle_generation;
    this.lifecycleState = reserved.data.node.state;

    const abortController = new AbortController();
    try {
      if (this.channel === undefined) {
        const factory = this.options.channelFactory;
        if (factory === undefined) throw new Error("缺少监督通道工厂");
        const binding = factory(Object.freeze({
          agent_id: reserved.data.node.agent_id,
          parent_agent_id: reserved.data.node.parent_agent_id,
          depth: reserved.data.node.depth,
          initial_snapshot: Object.freeze([reserved.data.node]),
        }));
        if (binding === null || typeof binding !== "object" || binding.channel === undefined) {
          throw new Error("监督通道工厂返回值无效");
        }
        this.channel = binding.channel;
        this.managedNodeStartContext = binding.nodeStartContext;
        this.channelBindingCleanup = binding.cleanup;
      }
      this.subscribeToDependencies();
      await this.withStartupTimeout(this.performStartup(abortController.signal), abortController);
      const ready = this.applyLifecycle({ type: "startup_ready" });
      if (!ready.applied || ready.node.state !== "idle") {
        throw new Error("控制器未接受启动就绪事实");
      }
      this.phase = "ready";
      return Object.freeze({
        ok: true,
        agent_id: this.agentId,
        state: "idle",
      });
    } catch (error: unknown) {
      const failureCode = error instanceof StartupTimeoutError ? "spawn_timeout" : "spawn_failed";
      return this.rollbackStartup(failureCode);
    }
  }

  private async performStartup(signal: AbortSignal): Promise<void> {
    const channel = this.channelOrThrow();
    await channel.bind(signal);
    if (signal.aborted) throw abortError();

    try {
      await this.options.managedNode.start(signal, this.managedNodeStartContext);
    } catch (error: unknown) {
      if (signal.aborted) this.scheduleLateStartupCleanup();
      throw error;
    }
    if (signal.aborted) {
      this.scheduleLateStartupCleanup();
      throw abortError();
    }

    await channel.waitForReady(signal);
    if (signal.aborted) throw abortError();
    if (!channel.isReady()) throw new Error("监督通道未就绪");

    this.throwIfStartupFaulted();
    await this.options.managedNode.getState();
    this.throwIfStartupFaulted();
    if (!channel.isReady()) throw new Error("双通道未同时就绪");
  }

  private withStartupTimeout(
    startup: Promise<void>,
    abortController: AbortController,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        abortController.abort();
        reject(new StartupTimeoutError());
      }, this.options.startupTimeoutMs);
      void startup.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private subscribeToDependencies(): void {
    const client = this.commandClient();
    this.unsubscribeRpcEvent = client.onEvent((event) => {
      this.receiveRpcEvent(event);
    });
    this.unsubscribeRpcFault = client.onTransportFault((fault) => {
      this.receiveTransportFault(fault, "rpc");
    });
    const channel = this.channelOrThrow();
    this.unsubscribeChannelFault = channel.onFault((fault) => {
      this.receiveTransportFault(fault, "supervisor");
    });
    const onChannelEvent = channel.onEvent;
    if (typeof onChannelEvent === "function") {
      this.unsubscribeChannelEvent = onChannelEvent.call(channel, (event) => {
        this.receiveSupervisorEvent(event);
      });
    }
    const onChannelSnapshot = channel.onSnapshot;
    if (typeof onChannelSnapshot === "function") {
      this.unsubscribeChannelSnapshot = onChannelSnapshot.call(channel, (snapshot) => {
        this.receiveSupervisorSnapshot(snapshot);
      });
    }
  }

  private receiveRpcEvent(event: unknown): void {
    if (this.phase !== "ready") return;
    if (!isRecord(event) || typeof event.type !== "string") {
      this.failRuntime("invalid_rpc_event");
      return;
    }
    switch (event.type) {
      case "agent_settled":
        if (this.acceptancePending) {
          this.settlePending = true;
        } else {
          this.applyLifecycle({ type: "agent_settled" });
        }
        return;
      case "tool_execution_start":
        this.receiveToolStart(event);
        return;
      case "tool_execution_end":
        this.receiveToolEnd(event);
        return;
      case "message_end":
        // 回复只能由真正 child 扩展经监督通道上行；任务 RPC 事件不再发布回复。
        return;
      case "extension_error":
        this.failRuntime("rpc_protocol_fault");
        return;
      default:
        if (!IGNORED_RPC_EVENT_TYPES.has(event.type)) this.failRuntime("invalid_rpc_event");
    }
  }

  private receiveTransportFault(
    fault: RpcSupervisorTransportFault | RpcSupervisorChannelFault,
    source: "rpc" | "supervisor",
  ): void {
    if (this.phase === "starting") {
      this.startupFault = fault;
      return;
    }
    if (this.phase !== "ready") return;
    const code: RpcSupervisorFaultCode = source === "supervisor"
      ? (fault === "eof" ? "supervisor_eof" : "supervisor_protocol_fault")
      : fault === "eof"
        ? "rpc_eof"
        : fault === "process_exit"
          ? "rpc_process_exit"
          : "rpc_protocol_fault";
    this.failRuntime(code);
  }

  /** 父端只接受监督协议已脱敏的生命周期事实，并按当前代际提交。 */
  private receiveSupervisorEvent(event: SupervisorEvent): void {
    if (this.phase !== "ready" && this.phase !== "starting") return;
    const expectedGeneration = event.expected_generation;
    if (typeof expectedGeneration !== "number" || !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) {
      this.receiveTransportFault("protocol_fault", "supervisor");
      return;
    }
    try {
      const lifecycleEvent = Object.freeze({
        type: event.type,
        expected_generation: expectedGeneration,
        ...(event.error_code === undefined ? {} : { error_code: event.error_code }),
      }) as AgentLifecycleEvent;
      const outcome = this.options.controller.applyLifecycleEvent(event.agent_id, lifecycleEvent);
      if (!outcome.ok) {
        this.receiveTransportFault("protocol_fault", "supervisor");
        return;
      }
      if (event.agent_id === this.agentId) {
        this.lifecycleGeneration = outcome.data.lifecycle_generation;
        this.lifecycleState = outcome.data.node.state;
      }
      this.emitEvent(Object.freeze({ kind: "lifecycle", event: lifecycleEvent }));
    } catch {
      this.receiveTransportFault("protocol_fault", "supervisor");
    }
  }

  /** 完整快照先由通道校验，再由树控制器在一个修订中合并。 */
  private receiveSupervisorSnapshot(snapshot: SupervisorSnapshot): void {
    if (this.phase !== "ready" && this.phase !== "starting") return;
    const applySnapshot = this.options.controller.applySubtreeSnapshot;
    if (typeof applySnapshot !== "function") return;
    try {
      const outcome = applySnapshot.call(this.options.controller, this.options.actor, snapshot);
      if (!outcome.ok) this.receiveTransportFault("protocol_fault", "supervisor");
    } catch {
      this.receiveTransportFault("protocol_fault", "supervisor");
    }
  }

  private throwIfStartupFaulted(): void {
    if (this.startupFault !== undefined) throw new Error("RPC 监督通道提前退出");
  }

  private receiveToolStart(event: Record<string, unknown>): void {
    if (
      typeof event.toolCallId !== "string" ||
      event.toolCallId.length === 0 ||
      typeof event.toolName !== "string" ||
      event.toolName.length === 0 ||
      this.activeTools.has(event.toolCallId)
    ) {
      this.failRuntime("invalid_rpc_event");
      return;
    }
    const category = activityCategory(event.toolName);
    this.activeTools.set(event.toolCallId, category);
    const activeCount = (this.activeToolCounts.get(category) ?? 0) + 1;
    this.activeToolCounts.set(category, activeCount);
    this.emitEvent(Object.freeze({
      kind: "activity",
      activity: Object.freeze({ category, phase: "started", active_count: activeCount }),
    }));
  }

  private receiveToolEnd(event: Record<string, unknown>): void {
    if (typeof event.toolCallId !== "string" || typeof event.toolName !== "string") {
      this.failRuntime("invalid_rpc_event");
      return;
    }
    const category = this.activeTools.get(event.toolCallId);
    if (category === undefined) {
      this.failRuntime("invalid_rpc_event");
      return;
    }
    this.activeTools.delete(event.toolCallId);
    const activeCount = Math.max(0, (this.activeToolCounts.get(category) ?? 1) - 1);
    if (activeCount === 0) this.activeToolCounts.delete(category);
    else this.activeToolCounts.set(category, activeCount);
    this.emitEvent(Object.freeze({
      kind: "activity",
      activity: Object.freeze({ category, phase: "finished", active_count: activeCount }),
    }));
  }

  private failRuntime(code: RpcSupervisorFaultCode): void {
    if (this.phase !== "ready") return;
    this.applyLifecycle({ type: "runtime_failed", error_code: "internal_error" });
    this.phase = "failed";
    this.settlePending = false;
    this.activeTools.clear();
    this.activeToolCounts.clear();
    while (this.commandQueue.length > 0) {
      this.resolveUnavailableCommand(this.commandQueue.shift()!);
    }
    this.resolveActiveMessageAsUnavailable();
    this.emitEvent(Object.freeze({ kind: "fault", code }));
  }

  private enqueueMessage(
    kind: MessageCommandKind,
    message: string,
    images: readonly RpcSupervisorImage[] | undefined,
  ): Promise<RpcSupervisorCommandResult> {
    if (this.phase !== "ready" || typeof message !== "string" || message.length === 0) {
      return Promise.resolve(Object.freeze({ ok: false, code: "agent_unavailable" }));
    }
    this.applyLifecycle({ type: "message_admitted" });
    return new Promise<RpcSupervisorCommandResult>((resolve) => {
      this.commandQueue.push({ kind, message, images, resolve });
      this.drainCommandQueue();
    });
  }

  private drainCommandQueue(): void {
    if (this.activeCommand !== undefined || this.phase !== "ready") return;
    const command = this.commandQueue.shift();
    if (command === undefined) return;
    this.activeCommand = command;
    const execution = this.executeQueuedCommand(command);
    void execution.then(
      () => this.finishCommand(command),
      () => {
        this.resolveUnavailableCommand(command);
        this.finishCommand(command);
      },
    );
  }

  private executeQueuedCommand(command: QueuedCommand): Promise<void> {
    return command.kind === "abort"
      ? this.executeInterruptCommand(command)
      : this.executeMessageCommand(command);
  }

  private async executeMessageCommand(command: QueuedMessageCommand): Promise<void> {
    const commandGeneration = this.lifecycleGeneration;
    this.acceptancePending = true;
    try {
      if (command.kind === "prompt") {
        await this.commandClient().prompt(command.message, command.images);
      } else {
        await this.commandClient().steer(command.message, command.images);
      }
      if (this.phase !== "ready" || commandGeneration !== this.lifecycleGeneration) {
        command.resolve(Object.freeze({ ok: false, code: "message_delivery_failed" }));
        return;
      }
      this.applyLifecycle({
        type: command.kind === "prompt" ? "prompt_accepted" : "steering_accepted",
      });
      command.resolve(Object.freeze({ ok: true, accepted: true }));
    } catch {
      if (this.phase === "ready" && commandGeneration === this.lifecycleGeneration) {
        this.applyLifecycle({ type: "message_delivery_failed" });
      }
      command.resolve(Object.freeze({ ok: false, code: "message_delivery_failed" }));
    } finally {
      this.acceptancePending = false;
      this.flushPendingSettle();
    }
  }

  private async executeInterruptCommand(command: QueuedInterruptCommand): Promise<void> {
    if (this.phase !== "ready" || this.lifecycleState !== "working") {
      command.resolve(Object.freeze({
        ok: true,
        accepted: false,
        changed: false,
      }));
      return;
    }

    this.applyLifecycle({ type: "interrupt_accepted" });
    const responseGeneration = this.lifecycleGeneration;
    let response: Promise<void>;
    try {
      response = this.commandClient().abort();
    } catch {
      command.resolve(Object.freeze({ ok: false, code: "agent_unavailable" }));
      this.failRuntime("rpc_protocol_fault");
      return;
    }
    command.resolve(Object.freeze({
      ok: true,
      accepted: true,
      changed: true,
    }));
    void response.then(
      () => {
        if (this.phase === "ready" && responseGeneration === this.lifecycleGeneration) {
          this.applyLifecycle({ type: "abort_completed" });
        }
      },
      () => {
        // 接纳结果已经线性化；后续 RPC 故障由 transport 观察或状态事件报告。
      },
    );
  }

  private finishCommand(command: QueuedCommand): void {
    if (this.activeCommand === command) this.activeCommand = undefined;
    this.drainCommandQueue();
  }

  private resolveActiveMessageAsUnavailable(): void {
    const command = this.activeCommand;
    if (command !== undefined && command.kind !== "abort") {
      command.resolve(Object.freeze({ ok: false, code: "message_delivery_failed" }));
    }
  }

  private resolveUnavailableCommand(command: QueuedCommand): void {
    if (command.kind === "abort") {
      command.resolve(Object.freeze({ ok: false, code: "agent_unavailable" }));
    } else {
      command.resolve(Object.freeze({ ok: false, code: "message_delivery_failed" }));
    }
  }

  private flushPendingSettle(): void {
    if (!this.settlePending) return;
    this.settlePending = false;
    if (this.phase === "ready") this.applyLifecycle({ type: "agent_settled" });
  }

  private cancelQueuedCommands(): void {
    while (this.commandQueue.length > 0) {
      const command = this.commandQueue.shift()!;
      if (command.kind !== "abort") {
        this.applyLifecycle({ type: "message_cancelled" });
      }
      this.resolveUnavailableCommand(command);
    }
  }

  private async rollbackStartup(
    code: "spawn_failed" | "spawn_timeout",
  ): Promise<RpcSupervisorStartupResult> {
    if (this.agentId !== undefined) {
      this.applyLifecycle({ type: "startup_failed", error_code: code });
    }
    this.phase = "terminating";
    const cleanup = await this.cleanupResources(false, true);
    return Object.freeze({
      ok: false,
      ...(this.agentId === undefined ? {} : { agent_id: this.agentId }),
      code: cleanup === "confirmed" ? code : "termination_incomplete",
      cleanup,
    });
  }

  private async runTermination(): Promise<RpcSupervisorTerminationResult> {
    const cleanup = await this.cleanupResources(true, true);
    if (cleanup === "confirmed" && this.agentId !== undefined) {
      return Object.freeze({
        ok: true,
        agent_id: this.agentId,
        state: "terminated",
        cleanup: "confirmed",
      });
    }
    return Object.freeze({
      ok: false,
      ...(this.agentId === undefined ? {} : { agent_id: this.agentId }),
      code: "termination_incomplete",
      state: "terminating",
      cleanup: "incomplete",
    });
  }

  private cleanupResources(
    barrierEstablished: boolean,
    confirmNode: boolean,
  ): Promise<"confirmed" | "incomplete"> {
    const previous = this.cleanupInFlight;
    const cleanup = (async () => {
      if (previous !== undefined) {
        const previousResult = await previous;
        if (previousResult === "confirmed" && !confirmNode) return previousResult;
      }
      return this.performCleanupResources(barrierEstablished, confirmNode);
    })();
    this.cleanupInFlight = cleanup;
    void cleanup.then(
      () => {
        if (this.cleanupInFlight === cleanup) this.cleanupInFlight = undefined;
      },
      () => {
        if (this.cleanupInFlight === cleanup) this.cleanupInFlight = undefined;
      },
    );
    return cleanup;
  }

  private async performCleanupResources(
    barrierEstablished: boolean,
    confirmNode: boolean,
  ): Promise<"confirmed" | "incomplete"> {
    if (!barrierEstablished) this.channel?.establishTerminationBarrier();
    const node = this.options.managedNode;

    // 第一阶段只请求真正 child 递归关闭后代，并以监督字节流 EOF 作为受控
    // 确认；在此之前不得停止当前 Pi 进程，否则会截断 child 的级联清理。
    if (this.channel !== undefined) {
      const childCloseAbort = new AbortController();
      const childCloseDeadline = this.now() + this.options.gracefulShutdownMs;
      await this.waitForDeadline(
        this.startOperation(() => this.channel!.requestClose(childCloseAbort.signal)),
        childCloseDeadline,
      );
      if (!this.channelResourcesConfirmed && !this.channelHandleReleased) {
        this.channelResourcesConfirmed = await this.observeChannelClose(childCloseDeadline);
      }
      childCloseAbort.abort();
    } else {
      this.channelResourcesConfirmed = true;
      this.channelHandleReleased = true;
    }

    // 第二阶段才关闭当前 Pi/bridge。即使 child 未在第一阶段确认，也保留一次
    // 平台优雅窗口；随后才允许整棵平台进程树强制回收。
    const closeAbort = new AbortController();
    const gracefulDeadline = this.now() + this.options.gracefulShutdownMs;
    await this.waitForDeadline(
      this.startOperation(() => node.requestGracefulClose(closeAbort.signal)),
      gracefulDeadline,
    );
    closeAbort.abort();
    if (!this.processResourcesConfirmed) {
      this.processResourcesConfirmed = await this.observeManagedNode(gracefulDeadline);
    }
    if (!this.channelResourcesConfirmed && !this.channelHandleReleased) {
      this.channelResourcesConfirmed = await this.observeChannelClose(gracefulDeadline);
    }

    if (!this.processResourcesConfirmed || !this.channelResourcesConfirmed) {
      if (!this.processResourcesConfirmed) {
        const forceDeadline = this.now() + this.options.gracefulShutdownMs;
        this.forcedTerminationUsed = true;
        await this.waitForDeadline(
          this.startOperation(() => node.forceTerminate()),
          forceDeadline,
        );
      }
      const confirmationDeadline = this.now() + this.options.gracefulShutdownMs;
      if (!this.processResourcesConfirmed) {
        this.processResourcesConfirmed = await this.observeManagedNode(confirmationDeadline);
      }
      if (!this.channelResourcesConfirmed && !this.channelHandleReleased) {
        this.channelResourcesConfirmed = await this.observeChannelClose(confirmationDeadline);
      }
    }

    if (!this.processResourcesConfirmed || !this.channelResourcesConfirmed) {
      if (confirmNode && this.agentId !== undefined) this.applyLifecycle({ type: "termination_incomplete" });
      return "incomplete";
    }

    const releaseOperations: Promise<unknown>[] = [];
    if (!this.nodeHandleReleased) {
      releaseOperations.push(this.startOperation(
        () => node.release(),
      ).then(() => {
        this.nodeHandleReleased = true;
      }));
    }
    if (!this.channelHandleReleased) {
      releaseOperations.push(this.startOperation(
        () => this.channelOrThrow().release(),
      ).then(() => {
        this.channelHandleReleased = true;
      }));
    }
    const releaseDeadline = this.now() + this.options.gracefulShutdownMs;
    await this.waitForDeadline(Promise.allSettled(releaseOperations), releaseDeadline);
    if (!this.nodeHandleReleased || !this.channelHandleReleased) {
      if (confirmNode && this.agentId !== undefined) this.applyLifecycle({ type: "termination_incomplete" });
      return "incomplete";
    }

    if (this.agentId === undefined) return "incomplete";
    if (!confirmNode) {
      this.unsubscribeDependencies();
      return "confirmed";
    }
    const confirmation = this.applyLifecycle({ type: "resources_confirmed" });
    if (confirmation.node.state !== "terminated") {
      this.applyLifecycle({ type: "termination_incomplete" });
      return "incomplete";
    }
    this.phase = "terminated";
    this.unsubscribeDependencies();
    return "confirmed";
  }

  private async observeChannelClose(deadline: number | Date): Promise<boolean> {
    const deadlineMs = deadline instanceof Date ? deadline.getTime() : deadline;
    const close = await this.waitForDeadline(
      this.startOperation(() => this.channelOrThrow().waitForClose(deadline)),
      deadlineMs,
    );
    return close.settled && close.value === "released";
  }

  private async observeManagedNode(deadline: number | Date): Promise<boolean> {
    const node = this.options.managedNode;
    const deadlineMs = deadline instanceof Date ? deadline.getTime() : deadline;
    const exit = await this.waitForDeadline(
      this.startOperation(() => node.waitForExit(deadline)),
      deadlineMs,
    );
    const resources = await this.waitForDeadline(
      this.startOperation(() => node.inspect()),
      deadlineMs,
    );
    return exit.settled
      && resources.settled
      && exit.value.state === "exited"
      && resources.value.state === "released";
  }

  private commandClient(): ManagedRpcNodeLike {
    return this.options.managedNode;
  }

  private channelOrThrow(): RpcSupervisorChannel {
    const channel = this.channel;
    if (channel === undefined) throw new Error("监督通道尚未创建");
    return channel;
  }

  private startOperation<T>(operation: () => Promise<T>): Promise<T> {
    return Promise.resolve().then(operation);
  }

  private waitForDeadline<T>(
    operation: Promise<T>,
    deadline: number,
  ): Promise<{ readonly settled: true; readonly value: T } | { readonly settled: false }> {
    return new Promise((resolve) => {
      let finished = false;
      const complete = (
        result: { readonly settled: true; readonly value: T } | { readonly settled: false },
      ): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(
        () => complete(Object.freeze({ settled: false })),
        Math.max(0, deadline - this.now()),
      );
      void operation.then(
        (value) => complete(Object.freeze({ settled: true, value })),
        () => complete(Object.freeze({ settled: false })),
      );
    });
  }

  private scheduleLateStartupCleanup(): void {
    if (this.lateStartupCleanupScheduled) return;
    this.lateStartupCleanupScheduled = true;
    queueMicrotask(() => {
      this.lateStartupCleanupScheduled = false;
      if (this.phase !== "terminating") return;
      void this.cleanupResources(true, true).catch(() => {
        // 已公开 termination_incomplete；后台重试失败不能伪造确认或泄露异常。
      });
    });
  }

  private applyLifecycle(
    event: LifecycleEventWithoutGeneration,
  ): LifecycleEventOutcome {
    if (this.agentId === undefined) throw new Error("代理尚未预留");
    const normalized = Object.freeze({
      ...event,
      expected_generation: this.lifecycleGeneration,
    }) as AgentLifecycleEvent;
    const outcome = this.options.controller.applyLifecycleEvent(this.agentId, normalized);
    if (!outcome.ok) throw new Error("控制器拒绝监督器生命周期事实");
    this.lifecycleGeneration = outcome.data.lifecycle_generation;
    this.lifecycleState = outcome.data.node.state;
    this.emitEvent(Object.freeze({ kind: "lifecycle", event: normalized }));
    return outcome.data;
  }

  private emitEvent(event: RpcSupervisorEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // 观察者异常不能改变节点生命周期或 RPC 顺序。
      }
    }
  }

  private unsubscribeDependencies(): void {
    this.unsubscribeRpcEvent?.();
    this.unsubscribeRpcFault?.();
    this.unsubscribeChannelFault?.();
    this.unsubscribeChannelEvent?.();
    this.unsubscribeChannelSnapshot?.();
    this.channelBindingCleanup?.();
    this.unsubscribeRpcEvent = undefined;
    this.unsubscribeRpcFault = undefined;
    this.unsubscribeChannelFault = undefined;
    this.unsubscribeChannelEvent = undefined;
    this.unsubscribeChannelSnapshot = undefined;
    this.channelBindingCleanup = undefined;
  }
}
