import { classifyProcessTreeResources } from "./process-tree-resource-boundary.ts";
import type {
  ProcessTreeAdapter,
  ProcessTreeHandle,
} from "./process-tree-capability.ts";
import type { SupervisorReply } from "./supervisor-channel.ts";
import type {
  AgentLifecycleEvent,
  AgentLifecycleState,
  ControlResult,
  LifecycleEventOutcome,
  PublicErrorCode,
  ReserveStartingChildInput,
  ReservedAgentOutcome,
  TreeActor,
} from "./tree-controller.ts";

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
}

export interface RpcSupervisorOptions {
  readonly controller: RpcSupervisorController;
  readonly actor: TreeActor;
  readonly reservation: ReserveStartingChildInput;
  readonly rpcClient: RpcSupervisorClient;
  readonly processTreeAdapter: ProcessTreeAdapter;
  /** 平台适配器接收的启动前说明；监督器不读取 PID 或底层句柄。 */
  readonly processHandle: unknown;
  readonly channel: RpcSupervisorChannel;
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

function safeTreeFromError(error: unknown): ProcessTreeHandle | undefined {
  if (typeof error !== "object" || error === null || !("tree" in error)) return undefined;
  return (error as { readonly tree?: ProcessTreeHandle }).tree;
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

function freezeReply(
  text: string,
  images: readonly RpcSupervisorImage[],
): Omit<SupervisorReply, "reply_seq"> {
  if (images.length === 0) return Object.freeze({ text });
  return Object.freeze({
    text,
    images: Object.freeze(images.map((image) => Object.freeze({ ...image }))),
  });
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
  private phase: "new" | "starting" | "ready" | "failed" | "terminating" | "terminated" = "new";
  private agentId: string | undefined;
  private lifecycleGeneration = 0;
  private lifecycleState: AgentLifecycleState | undefined;
  private tree: ProcessTreeHandle | undefined;
  private processAttachPending = false;
  private startupFault: RpcSupervisorTransportFault | RpcSupervisorChannelFault | undefined;
  private startPromise: Promise<RpcSupervisorStartupResult> | undefined;
  private unsubscribeRpcEvent: (() => void) | undefined;
  private unsubscribeRpcFault: (() => void) | undefined;
  private unsubscribeChannelFault: (() => void) | undefined;
  private readonly commandQueue: QueuedCommand[] = [];
  private activeCommand: QueuedCommand | undefined;
  private acceptancePending = false;
  private settlePending = false;
  private readonly eventListeners = new Set<(event: RpcSupervisorEvent) => void>();
  private readonly activeTools = new Map<string, RpcSupervisorActivityCategory>();
  private readonly activeToolCounts = new Map<RpcSupervisorActivityCategory, number>();
  private terminationPromise: Promise<RpcSupervisorTerminationResult> | undefined;
  private cleanupInFlight: Promise<"confirmed" | "incomplete"> | undefined;
  private lateAttachCleanupScheduled = false;
  private processResourcesConfirmed = false;
  private channelResourcesConfirmed = false;
  private processHandleReleased = false;
  private channelHandleReleased = false;

  constructor(options: RpcSupervisorOptions) {
    if (!validDuration(options.startupTimeoutMs) || !validDuration(options.gracefulShutdownMs)) {
      throw new TypeError("RPC 监督器期限无效");
    }
    this.options = options;
    this.now = options.now ?? Date.now;
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
    this.options.channel.establishTerminationBarrier();
    this.cancelQueuedCommands();
    this.resolveActiveMessageAsUnavailable();

    if (abortActiveRpc) {
      try {
        void this.options.rpcClient.abort().catch(() => {
          // 终止屏障已经线性化；abort 失败不撤销关闭意图。
        });
      } catch {
        // 同步适配器异常同样由最终资源观察裁决。
      }
    }

    return this.beginTerminationAttempt();
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

    const reserved = this.options.controller.reserveStartingChild(
      this.options.actor,
      this.options.reservation,
    );
    if (!reserved.ok) {
      this.phase = "terminated";
      return Object.freeze({ ok: false, code: reserved.error.code });
    }

    this.agentId = reserved.data.node.agent_id;
    this.lifecycleGeneration = reserved.data.lifecycle_generation;
    this.lifecycleState = reserved.data.node.state;
    this.subscribeToDependencies();

    const abortController = new AbortController();
    try {
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
      return this.rollbackStartup(failureCode, safeTreeFromError(error));
    }
  }

  private async performStartup(signal: AbortSignal): Promise<void> {
    await this.options.channel.bind(signal);
    if (signal.aborted) throw abortError();

    this.processAttachPending = true;
    try {
      this.tree = await this.options.processTreeAdapter.attach(this.options.processHandle);
    } catch (error: unknown) {
      this.tree = safeTreeFromError(error);
      if (signal.aborted && this.tree !== undefined) this.scheduleLateAttachCleanup();
      throw error;
    } finally {
      this.processAttachPending = false;
    }
    if (signal.aborted) {
      this.scheduleLateAttachCleanup();
      throw abortError();
    }

    await this.options.channel.waitForReady(signal);
    if (signal.aborted) throw abortError();
    if (!this.options.channel.isReady()) throw new Error("监督通道未就绪");

    await this.options.rpcClient.start();
    this.throwIfStartupFaulted();
    await this.options.rpcClient.getState();
    this.throwIfStartupFaulted();
    if (!this.options.channel.isReady()) throw new Error("双通道未同时就绪");
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
    this.unsubscribeRpcEvent = this.options.rpcClient.onEvent((event) => {
      this.receiveRpcEvent(event);
    });
    this.unsubscribeRpcFault = this.options.rpcClient.onTransportFault((fault) => {
      this.receiveTransportFault(fault, "rpc");
    });
    this.unsubscribeChannelFault = this.options.channel.onFault((fault) => {
      this.receiveTransportFault(fault, "supervisor");
    });
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
        this.receiveMessageEnd(event);
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

  private receiveMessageEnd(event: Record<string, unknown>): void {
    if (!isRecord(event.message)) {
      this.failRuntime("invalid_rpc_event");
      return;
    }
    if (event.message.role !== "assistant") return;
    if (!Array.isArray(event.message.content)) {
      this.failRuntime("invalid_rpc_event");
      return;
    }

    const text: string[] = [];
    const images: RpcSupervisorImage[] = [];
    for (const item of event.message.content) {
      if (!isRecord(item) || typeof item.type !== "string") {
        this.failRuntime("invalid_rpc_event");
        return;
      }
      if (item.type === "text") {
        if (typeof item.text !== "string") {
          this.failRuntime("invalid_rpc_event");
          return;
        }
        text.push(item.text);
      } else if (item.type === "image") {
        if (typeof item.data !== "string" || typeof item.mimeType !== "string") {
          this.failRuntime("invalid_rpc_event");
          return;
        }
        images.push(Object.freeze({
          type: "image",
          data: item.data,
          mimeType: item.mimeType,
        }));
      }
    }
    if (text.length === 0 && images.length === 0) return;
    const reply = freezeReply(text.join(""), images);
    void this.options.channel.publishReply(reply).then(
      () => this.emitEvent(Object.freeze({ kind: "reply", reply })),
      () => this.failRuntime("supervisor_protocol_fault"),
    );
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
        await this.options.rpcClient.prompt(command.message, command.images);
      } else {
        await this.options.rpcClient.steer(command.message, command.images);
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
      response = this.options.rpcClient.abort();
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
    errorTree: ProcessTreeHandle | undefined,
  ): Promise<RpcSupervisorStartupResult> {
    if (this.tree === undefined && errorTree !== undefined) this.tree = errorTree;
    if (this.agentId !== undefined) {
      this.applyLifecycle({ type: "startup_failed", error_code: code });
    }
    this.phase = "terminating";
    const cleanup = await this.cleanupResources(false);
    return Object.freeze({
      ok: false,
      ...(this.agentId === undefined ? {} : { agent_id: this.agentId }),
      code: cleanup === "confirmed" ? code : "termination_incomplete",
      cleanup,
    });
  }

  private async runTermination(): Promise<RpcSupervisorTerminationResult> {
    const cleanup = await this.cleanupResources(true);
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
  ): Promise<"confirmed" | "incomplete"> {
    const previous = this.cleanupInFlight;
    const cleanup = (async () => {
      if (previous !== undefined) {
        const previousResult = await previous;
        if (previousResult === "confirmed") return previousResult;
      }
      return this.performCleanupResources(barrierEstablished);
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
  ): Promise<"confirmed" | "incomplete"> {
    if (!barrierEstablished) this.options.channel.establishTerminationBarrier();
    const tree = this.tree;
    if (tree === undefined && !this.processAttachPending) {
      this.processResourcesConfirmed = true;
      this.processHandleReleased = true;
    }

    const closeAbort = new AbortController();
    const gracefulRequests: Promise<unknown>[] = [
      this.startOperation(() => this.options.channel.requestClose(closeAbort.signal)),
    ];
    if (tree !== undefined && !this.processHandleReleased) {
      gracefulRequests.push(this.startOperation(
        () => this.options.processTreeAdapter.requestGracefulClose(tree, closeAbort.signal),
      ));
    }

    const gracefulDeadline = this.now() + this.options.gracefulShutdownMs;
    await this.waitForDeadline(Promise.allSettled(gracefulRequests), gracefulDeadline);
    closeAbort.abort();
    if (!this.processResourcesConfirmed && tree !== undefined && !this.processHandleReleased) {
      this.processResourcesConfirmed = await this.observeProcessTree(tree, gracefulDeadline);
    }
    if (!this.channelResourcesConfirmed && !this.channelHandleReleased) {
      this.channelResourcesConfirmed = await this.observeChannelClose(gracefulDeadline);
    }

    if (!this.processResourcesConfirmed || !this.channelResourcesConfirmed) {
      if (tree !== undefined && !this.processResourcesConfirmed && !this.processHandleReleased) {
        const forceDeadline = this.now() + this.options.gracefulShutdownMs;
        await this.waitForDeadline(
          this.startOperation(() => this.options.processTreeAdapter.forceTerminate(tree)),
          forceDeadline,
        );
      }
      const confirmationDeadline = this.now() + this.options.gracefulShutdownMs;
      if (tree !== undefined && !this.processResourcesConfirmed && !this.processHandleReleased) {
        this.processResourcesConfirmed = await this.observeProcessTree(tree, confirmationDeadline);
      }
      if (!this.channelResourcesConfirmed && !this.channelHandleReleased) {
        this.channelResourcesConfirmed = await this.observeChannelClose(confirmationDeadline);
      }
    }

    if (!this.processResourcesConfirmed || !this.channelResourcesConfirmed) {
      if (this.agentId !== undefined) this.applyLifecycle({ type: "termination_incomplete" });
      return "incomplete";
    }

    const releaseOperations: Promise<unknown>[] = [];
    if (tree !== undefined && !this.processHandleReleased) {
      releaseOperations.push(this.startOperation(
        () => this.options.processTreeAdapter.release(tree),
      ).then(() => {
        this.processHandleReleased = true;
      }));
    }
    if (!this.channelHandleReleased) {
      releaseOperations.push(this.startOperation(
        () => this.options.channel.release(),
      ).then(() => {
        this.channelHandleReleased = true;
      }));
    }
    const releaseDeadline = this.now() + this.options.gracefulShutdownMs;
    await this.waitForDeadline(Promise.allSettled(releaseOperations), releaseDeadline);
    if (!this.processHandleReleased || !this.channelHandleReleased) {
      if (this.agentId !== undefined) this.applyLifecycle({ type: "termination_incomplete" });
      return "incomplete";
    }

    if (this.agentId === undefined) return "incomplete";
    const confirmation = this.applyLifecycle({ type: "resources_confirmed" });
    if (confirmation.node.state !== "terminated") {
      this.applyLifecycle({ type: "termination_incomplete" });
      return "incomplete";
    }
    this.phase = "terminated";
    this.unsubscribeDependencies();
    return "confirmed";
  }

  private async observeProcessTree(
    tree: ProcessTreeHandle,
    deadline: number | Date,
  ): Promise<boolean> {
    const deadlineMs = deadline instanceof Date ? deadline.getTime() : deadline;
    const exit = await this.waitForDeadline(
      this.startOperation(() => this.options.processTreeAdapter.waitForExit(tree, deadline)),
      deadlineMs,
    );
    if (!exit.settled) return false;
    const resources = await this.waitForDeadline(
      this.startOperation(() => this.options.processTreeAdapter.inspect(tree)),
      deadlineMs,
    );
    return resources.settled &&
      classifyProcessTreeResources({ exit: exit.value, resources: resources.value }).state ===
        "confirmed_exited";
  }

  private async observeChannelClose(deadline: number | Date): Promise<boolean> {
    const deadlineMs = deadline instanceof Date ? deadline.getTime() : deadline;
    const close = await this.waitForDeadline(
      this.startOperation(() => this.options.channel.waitForClose(deadline)),
      deadlineMs,
    );
    return close.settled && close.value === "released";
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

  private scheduleLateAttachCleanup(): void {
    if (this.lateAttachCleanupScheduled || this.tree === undefined) return;
    this.lateAttachCleanupScheduled = true;
    queueMicrotask(() => {
      this.lateAttachCleanupScheduled = false;
      if (this.phase !== "terminating" || this.tree === undefined) return;
      void this.cleanupResources(true).catch(() => {
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
    this.unsubscribeRpcEvent = undefined;
    this.unsubscribeRpcFault = undefined;
    this.unsubscribeChannelFault = undefined;
  }
}
