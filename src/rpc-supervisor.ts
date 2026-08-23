import type { ChildReplyEnvelope } from "./child-reply-envelope.ts";
import {
  ManagedRpcCommandRejectedError,
  type ManagedRpcNodeLike,
  type ManagedRpcNodeStartContext,
} from "./managed-rpc-node.ts";
import type {
  SupervisorCapabilityManifest,
  SupervisorCompactionComplete,
  SupervisorCompactionCompleted,
  SupervisorCompactionPrepare,
  SupervisorCompactionPrepared,
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

/**
 * Pi RpcClient 的监督适配接口。生产适配器委托 Pi 公共命令方法，并额外提供
 * 传输退出观察；监督器本身不解析或复制 Pi JSONL 协议。
 */
export interface RpcSupervisorClient {
  /** 客户端的 RPC 进程必须与监督器持有的平台树句柄属于同一启动事务。 */
  readonly process_binding: "managed";
  start(): Promise<void>;
  prompt(message: string): Promise<unknown>;
  steer(message: string): Promise<unknown>;
  abort(): Promise<unknown>;
  getState(): Promise<unknown>;
  onEvent(listener: (event: unknown) => void): () => void;
  onTransportFault(listener: (fault: RpcSupervisorTransportFault) => void): () => void;
}

/** Pi 公开 RpcClient 在监督器所需范围内的结构类型。 */
export interface PiRpcClientPublic {
  start(): Promise<void>;
  prompt(message: string): Promise<unknown>;
  steer(message: string): Promise<unknown>;
  abort(): Promise<unknown>;
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

  prompt(message: string): Promise<unknown> {
    return this.client.prompt(message);
  }

  steer(message: string): Promise<unknown> {
    return this.client.steer(message);
  }

  abort(): Promise<unknown> {
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

}

export interface FakeRpcClientOptions {
  readonly onOperation?: (operation: string) => void;
  readonly transportEventOnStart?: RpcSupervisorTransportFault;
  readonly state?: unknown;
}

export type FakeRpcControlledOperation = "prompt" | "steer" | "abort" | "get_state";

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
  private state: unknown;

  constructor(options: FakeRpcClientOptions = {}) {
    this.options = options;
    this.state = options.state ?? Object.freeze({
      isStreaming: false,
      isCompacting: false,
      pendingMessageCount: 0,
    });
  }

  async start(): Promise<void> {
    this.record("start");
    if (this.options.transportEventOnStart !== undefined) {
      this.emitTransportFault(this.options.transportEventOnStart);
    }
  }

  async prompt(_message: string): Promise<void> {
    this.record("prompt");
    await this.waitForGate("prompt");
  }

  async steer(_message: string): Promise<void> {
    this.record("steer");
    await this.waitForGate("steer");
  }

  async abort(): Promise<void> {
    this.record("abort");
    await this.waitForGate("abort");
  }

  async getState(): Promise<unknown> {
    this.record("get_state");
    await this.waitForGate("get_state");
    return this.state;
  }

  setState(state: unknown): void {
    this.state = state;
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

export interface RpcSupervisorRuntimeState {
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly pendingMessageCount: number;
}

export type RpcSupervisorFaultCode =
  | "rpc_eof"
  | "rpc_protocol_fault"
  | "rpc_process_exit"
  | "supervisor_eof"
  | "supervisor_protocol_fault"
  | "invalid_rpc_event"
  | "message_delivery_failed";

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
      readonly reply: ChildReplyEnvelope;
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
  publishReply(reply: SupervisorReply, signal?: AbortSignal): Promise<void>;
  /** parent 返回协调压缩准备结果。 */
  respondCompactionPrepared?(response: SupervisorCompactionPrepared): Promise<void>;
  onCompactionPrepare?(listener: (request: SupervisorCompactionPrepare) => void): () => void;
  /** parent 返回协调压缩完成结果。 */
  respondCompactionCompleted?(response: SupervisorCompactionCompleted): Promise<void>;
  onCompactionComplete?(listener: (request: SupervisorCompactionComplete) => void): () => void;
  establishTerminationBarrier(): void;
  requestClose(signal: AbortSignal): Promise<void>;
  waitForClose(deadline: number | Date): Promise<RpcSupervisorChannelCloseState>;
  release(): Promise<void>;
  onFault(listener: (fault: RpcSupervisorChannelFault) => void): () => void;
  /** 父端收到子端安全生命周期事实时调用；旧替身可省略。 */
  onEvent?(listener: (event: SupervisorEvent) => void): () => void;
  onSnapshot?(listener: (snapshot: SupervisorSnapshot) => void): () => void;
  /** parent 端缓存的 child 启动能力证明；仅用于启动裁决。 */
  getCapability?(): SupervisorCapabilityManifest | undefined;
  onCapability?(listener: (capability: SupervisorCapabilityManifest) => void): () => void;
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
  /** 清理诊断不改变生命周期，仅在终止屏障上记录不可确认事实。 */
  markTerminationBarrierIncomplete?(agentId: unknown): ControlResult<LifecycleEventOutcome>;
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
  /** child extension bind 后的实际能力裁决；缺失 manifest 必须失败关闭。 */
  readonly validateCapability?: (capability: SupervisorCapabilityManifest) => boolean;
  readonly now?: () => number;
  /** 当前父会话同步建立或释放该直接 child 的 reply 接纳令牌。 */
  readonly onCompactionPrepare?: (transactionId: string) => boolean;
  readonly onCompactionComplete?: (
    transactionId: string,
    outcome: SupervisorCompactionComplete["outcome"],
  ) => boolean;
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
      readonly code: "agent_unavailable" | "message_delivery_failed" | "compaction_active";
    };

export type RpcSupervisorInterruptResult =
  | {
      readonly ok: true;
      readonly accepted: boolean;
      readonly changed: boolean;
      readonly blocked_reason?: "compaction_active";
    }
  | {
      readonly ok: false;
      readonly code: "agent_unavailable";
    };

export type RpcSupervisorTerminationResult =
  /** 监督器物理资源已确认，但树屏障尚待外层权威提交。 */
  | {
      readonly ok: true;
      readonly agent_id: string;
      readonly state: "terminating";
      readonly cleanup: "confirmed";
      readonly tree_confirmation: "pending";
    }
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

class CapabilityMismatchError extends Error {
  constructor() {
    super("Subagent capability mismatch");
    this.name = "CapabilityMismatchError";
  }
}

class StartupTransportFaultError extends Error {
  constructor() {
    super("启动期间监督传输故障");
    this.name = "StartupTransportFaultError";
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
  "agent_end",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "tool_execution_update",
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

type AgentCompactionReason = "manual" | "threshold" | "overflow";

function isCompactionReason(value: unknown): value is AgentCompactionReason {
  return value === "manual" || value === "threshold" || value === "overflow";
}

type CoordinatedCompactionPhase = "preparing" | "prepared" | "release_failed" | "closed";

interface CoordinatedCompactionState {
  readonly transactionId: string;
  phase: CoordinatedCompactionPhase;
  replyPrepared: boolean;
  preparation?: Promise<boolean>;
  terminalAccepted?: boolean;
}

interface ClosedCoordinatedCompaction {
  readonly accepted: boolean;
  readonly outcome: SupervisorCompactionComplete["outcome"];
  readonly continuationExpected: boolean;
  compensationAccepted?: boolean;
}

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
  private readonly startupFaultListeners = new Set<() => void>();
  private startPromise: Promise<RpcSupervisorStartupResult> | undefined;
  private unsubscribeRpcEvent: (() => void) | undefined;
  private unsubscribeRpcFault: (() => void) | undefined;
  private unsubscribeChannelFault: (() => void) | undefined;
  private unsubscribeChannelEvent: (() => void) | undefined;
  private unsubscribeChannelSnapshot: (() => void) | undefined;
  private unsubscribeCompactionPrepare: (() => void) | undefined;
  private unsubscribeCompactionComplete: (() => void) | undefined;
  private readonly eventListeners = new Set<(event: RpcSupervisorEvent) => void>();
  private readonly activeTools = new Map<string, RpcSupervisorActivityCategory>();
  private readonly activeToolCounts = new Map<RpcSupervisorActivityCategory, number>();
  private readonly retiredToolCallIds = new Set<string>();
  private readonly coordinatedCompactions = new Map<string, CoordinatedCompactionState>();
  private readonly closedCoordinatedCompactions = new Map<string, ClosedCoordinatedCompaction>();
  private readonly manualCompactionAuthorizations = new Set<string>();
  private activeManualCompactionTransactionId: string | undefined;
  private uncoordinatedManualCompactionActive = false;
  private runtimeCompactionActive = false;
  private hostPendingInputCount = 0;
  private lifecycleObservationVersion = 0;
  private latestAgentStartVersion = 0;
  private compactionObservationVersion = 0;
  private queueObservationVersion = 0;
  private stateReconciliationQueue: Promise<boolean> = Promise.resolve(false);
  private terminationPromise: Promise<RpcSupervisorTerminationResult> | undefined;
  private cleanupInFlight: Promise<"confirmed" | "incomplete"> | undefined;
  private lateStartupCleanupScheduled = false;
  private processResourcesConfirmed = false;
  private channelResourcesConfirmed = false;
  private nodeHandleReleased = false;
  private channelHandleReleased = false;
  private forcedTerminationUsed = false;
  private treeConfirmationPending = false;

  constructor(options: RpcSupervisorOptions) {
    if (
      !validDuration(options.startupTimeoutMs)
      || !validDuration(options.gracefulShutdownMs)
    ) {
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

  /**
   * 在父端 Pi 接纳边界登记一条独立会话消息。消息和报告不携带任务/回合
   * 身份，也不做去重、排序或提交；每次调用都单独交给父端。
   */
  acceptChildReply(envelope: ChildReplyEnvelope, deliver: () => boolean): boolean {
    if (
      this.phase !== "ready"
      || this.lifecycleState === "interrupting"
      || this.lifecycleState === "terminating"
      || this.lifecycleState === "terminated"
      || this.lifecycleState === "failed"
    ) return false;
    let accepted = false;
    try {
      accepted = deliver();
    } catch {
      accepted = false;
    }
    if (accepted) this.emitEvent(Object.freeze({ kind: "reply", reply: envelope }));
    return accepted;
  }

  sendMessage(message: string): Promise<RpcSupervisorCommandResult> {
    return this.enqueueMessage(message);
  }

  /** 读取 Pi 的真实运行状态并校准本地生命周期。 */
  async synchronizeState(): Promise<boolean> {
    if (this.phase !== "ready") return false;
    return await this.enqueueStateReconciliation();
  }

  async interrupt(): Promise<RpcSupervisorInterruptResult> {
    if (this.phase !== "ready") {
      return Object.freeze({ ok: false, code: "agent_unavailable" });
    }
    await this.synchronizeState();
    if (this.phase !== "ready") {
      return Object.freeze({ ok: false, code: "agent_unavailable" });
    }
    if (this.compactionBarrierActive()) {
      return Object.freeze({
        ok: true,
        accepted: true,
        changed: false,
        blocked_reason: "compaction_active" as const,
      });
    }
    if (this.lifecycleState !== "working") {
      return Object.freeze({ ok: true, accepted: false, changed: false });
    }
    try {
      await this.commandClient().abort();
      this.applyLifecycle({ type: "interrupt_accepted" });
      return Object.freeze({ ok: true, accepted: true, changed: true });
    } catch {
      return Object.freeze({ ok: false, code: "agent_unavailable" });
    }
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

    const abortActiveRpc = this.lifecycleState === "working" ||
      this.lifecycleState === "interrupting";
    this.applyLifecycle({ type: "terminate_accepted" });
    this.phase = "terminating";
    this.channel?.establishTerminationBarrier();

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
      const failureCode = error instanceof StartupTimeoutError
        ? "spawn_timeout"
        : error instanceof CapabilityMismatchError
          ? "capability_mismatch"
          : "spawn_failed";
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
    if (this.options.validateCapability !== undefined) {
      const capability = await this.waitForCapability(channel, signal);
      if (!this.options.validateCapability(capability)) throw new CapabilityMismatchError();
    }
  }

  private async waitForCapability(
    channel: RpcSupervisorChannel,
    signal: AbortSignal,
  ): Promise<SupervisorCapabilityManifest> {
    const current = channel.getCapability?.();
    if (current !== undefined) return current;
    const subscribe = channel.onCapability;
    if (typeof subscribe !== "function") throw new CapabilityMismatchError();
    return new Promise<SupervisorCapabilityManifest>((resolve, reject) => {
      let unsubscribeCapability: (() => void) | undefined;
      let unsubscribeStartupFault: (() => void) | undefined;
      let settled = false;
      const cleanup = (): void => {
        signal.removeEventListener("abort", abort);
        unsubscribeCapability?.();
        unsubscribeStartupFault?.();
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const abort = (): void => fail(abortError());
      const listener = (capability: SupervisorCapabilityManifest): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(capability);
      };
      if (signal.aborted) {
        abort();
        return;
      }
      unsubscribeCapability = subscribe.call(channel, listener);
      if (settled) {
        cleanup();
        return;
      }
      unsubscribeStartupFault = this.onStartupFault(() => fail(new StartupTransportFaultError()));
      if (this.startupFault !== undefined) {
        fail(new StartupTransportFaultError());
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
      const late = channel.getCapability?.();
      if (late !== undefined) listener(late);
    });
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
    const onCompactionPrepare = channel.onCompactionPrepare;
    if (typeof onCompactionPrepare === "function") {
      this.unsubscribeCompactionPrepare = onCompactionPrepare.call(channel, (request) => {
        void this.receiveCompactionPrepare(request);
      });
    }
    const onCompactionComplete = channel.onCompactionComplete;
    if (typeof onCompactionComplete === "function") {
      this.unsubscribeCompactionComplete = onCompactionComplete.call(channel, (request) => {
        void this.receiveCompactionComplete(request);
      });
    }
  }

  private async receiveCompactionPrepare(request: SupervisorCompactionPrepare): Promise<void> {
    const channel = this.channel;
    const respond = channel?.respondCompactionPrepared;
    if (this.phase !== "ready" || typeof respond !== "function") return;
    const transactionId = request.transaction_id;
    const existing = this.coordinatedCompactions.get(transactionId);
    let accepted: boolean;
    if (existing !== undefined) {
      accepted = existing.phase === "prepared" || existing.preparation === undefined
        ? existing.phase === "prepared"
        : await existing.preparation;
    } else if (this.closedCoordinatedCompactions.has(transactionId)) {
      accepted = false;
    } else {
      const state: CoordinatedCompactionState = {
        transactionId,
        phase: "preparing",
        replyPrepared: false,
      };
      this.coordinatedCompactions.set(transactionId, state);
      try {
        state.replyPrepared = this.options.onCompactionPrepare?.(transactionId) === true;
      } catch {
        state.replyPrepared = false;
      }
      if (!state.replyPrepared) {
        state.phase = "closed";
        this.coordinatedCompactions.delete(transactionId);
        this.rememberClosedCoordinatedCompaction(transactionId, "not_started", false, false);
        accepted = false;
      } else {
        state.phase = "prepared";
        state.preparation = Promise.resolve(true);
        // child 收到 prepared ACK 后才会发出 manual compaction_start；先登记授权，
        // 避免 ACK 与 Pi 事件跨通道交错时把合法压缩误判为协议故障。
        this.manualCompactionAuthorizations.add(transactionId);
        accepted = true;
      }
    }
    try {
      await respond.call(channel, { transaction_id: transactionId, accepted });
    } catch {
      const state = this.coordinatedCompactions.get(transactionId);
      if (state !== undefined) this.releaseCoordinatedCompaction(state, "not_started");
      this.receiveTransportFault("protocol_fault", "supervisor");
    }
  }

  private async receiveCompactionComplete(request: SupervisorCompactionComplete): Promise<void> {
    const channel = this.channel;
    const respond = channel?.respondCompactionCompleted;
    if (this.phase !== "ready" || typeof respond !== "function") return;
    const state = this.coordinatedCompactions.get(request.transaction_id);
    let accepted: boolean;
    if (state === undefined) {
      const remembered = this.closedCoordinatedCompactions.get(request.transaction_id);
      if (remembered === undefined) {
        accepted = false;
        this.rememberClosedCoordinatedCompaction(
          request.transaction_id,
          request.outcome,
          false,
          request.continuation_expected,
        );
      } else {
        accepted = remembered.accepted;
      }
    } else if (state.terminalAccepted !== undefined) {
      accepted = state.terminalAccepted;
    } else {
      accepted = this.releaseCoordinatedCompaction(
        state,
        request.outcome,
        request.continuation_expected,
      );
      if (!accepted && this.coordinatedCompactions.get(request.transaction_id) === state) {
        state.terminalAccepted = false;
      }
    }
    try {
      await respond.call(channel, {
        transaction_id: request.transaction_id,
        accepted,
      });
    } catch {
      this.receiveTransportFault("protocol_fault", "supervisor");
    }
  }

  private releaseCoordinatedCompaction(
    state: CoordinatedCompactionState,
    outcome: SupervisorCompactionComplete["outcome"],
    continuationExpected = false,
  ): boolean {
    if (state.phase === "closed") return true;
    let replyReleased = !state.replyPrepared;
    if (state.replyPrepared) {
      try {
        replyReleased = this.options.onCompactionComplete?.(state.transactionId, outcome) === true;
      } catch {
        replyReleased = false;
      }
      if (replyReleased) state.replyPrepared = false;
    }
    const released = replyReleased;
    if (
      outcome === "not_started"
      && this.activeManualCompactionTransactionId !== state.transactionId
    ) {
      this.manualCompactionAuthorizations.delete(state.transactionId);
    }
    state.phase = released ? "closed" : "release_failed";
    if (released) {
      this.coordinatedCompactions.delete(state.transactionId);
      this.rememberClosedCoordinatedCompaction(
        state.transactionId,
        outcome,
        true,
        continuationExpected,
      );
    }
    return released;
  }

  private rememberClosedCoordinatedCompaction(
    transactionId: string,
    outcome: SupervisorCompactionComplete["outcome"],
    accepted = true,
    continuationExpected = false,
  ): void {
    if (!this.closedCoordinatedCompactions.has(transactionId)) {
      this.closedCoordinatedCompactions.set(transactionId, {
        accepted,
        outcome,
        continuationExpected,
      });
    }
    while (this.closedCoordinatedCompactions.size > 64) {
      const oldest = this.closedCoordinatedCompactions.keys().next().value;
      if (oldest === undefined) return;
      this.closedCoordinatedCompactions.delete(oldest);
      if (this.activeManualCompactionTransactionId !== oldest) {
        this.manualCompactionAuthorizations.delete(oldest);
      }
    }
  }

  private beginAuthorizedManualCompaction(): boolean {
    if (
      this.activeManualCompactionTransactionId !== undefined
      || this.manualCompactionAuthorizations.size !== 1
    ) return false;
    const transactionId = this.manualCompactionAuthorizations.values().next().value;
    if (transactionId === undefined) return false;
    this.manualCompactionAuthorizations.delete(transactionId);
    this.activeManualCompactionTransactionId = transactionId;
    return true;
  }

  private completeAuthorizedManualCompaction(): boolean {
    const transactionId = this.activeManualCompactionTransactionId;
    if (transactionId === undefined) return false;
    this.activeManualCompactionTransactionId = undefined;
    this.manualCompactionAuthorizations.delete(transactionId);
    return true;
  }

  /** 无协调事务时接管外部 manual 生命周期，避免把合法压缩误判为协议损坏。 */
  private beginUncoordinatedManualCompaction(): boolean {
    if (
      this.activeManualCompactionTransactionId !== undefined
      || this.uncoordinatedManualCompactionActive
      || this.manualCompactionAuthorizations.size > 0
      || this.coordinatedCompactions.size > 0
    ) return false;
    this.uncoordinatedManualCompactionActive = true;
    return true;
  }

  private completeUncoordinatedManualCompaction(): boolean {
    if (!this.uncoordinatedManualCompactionActive) return false;
    this.uncoordinatedManualCompactionActive = false;
    return true;
  }

  /** 自动压缩撤销全部尚未消费的授权；active manual 独立保留到 compaction_end。 */
  private revokePendingManualCompactionAuthorizations(): void {
    this.manualCompactionAuthorizations.clear();
  }


  private receiveRpcEvent(event: unknown): void {
    if (this.phase !== "ready") return;
    if (!isRecord(event) || typeof event.type !== "string") {
      this.failRuntime("invalid_rpc_event");
      return;
    }
    switch (event.type) {
      case "agent_start":
        this.hostPendingInputCount = 0;
        this.markLifecycleObservation("agent_start");
        this.resetToolActivity();
        if (this.lifecycleState === "idle") this.applyLifecycle({ type: "agent_start" });
        return;
      case "agent_end":
        // agent_end 只离开当前模型循环，不直接写入 idle。
        this.resetToolActivity();
        return;
      case "agent_settled": {
        const settlementVersion = this.markLifecycleObservation();
        void this.enqueueStateReconciliation(settlementVersion).catch(() => {
          // 状态探针失败不能伪造 idle；后续状态查询或消息发送仍可重试校准。
        });
        return;
      }
      case "compaction_start": {
        if (!isCompactionReason(event.reason)) {
          this.failRuntime("invalid_rpc_event");
          return;
        }
        const coordinatedManual = event.reason === "manual"
          && this.beginAuthorizedManualCompaction();
        if (
          event.reason === "manual"
          && !coordinatedManual
          && !this.beginUncoordinatedManualCompaction()
        ) {
          this.failRuntime("invalid_rpc_event");
          return;
        }
        if (event.reason !== "manual") this.revokePendingManualCompactionAuthorizations();
        this.runtimeCompactionActive = true;
        this.compactionObservationVersion += 1;
        this.markLifecycleObservation();
        return;
      }
      case "compaction_end":
        if (!isCompactionReason(event.reason)) {
          this.failRuntime("invalid_rpc_event");
          return;
        }
        const coordinatedManual = event.reason === "manual"
          && this.activeManualCompactionTransactionId !== undefined;
        if (
          (event.reason === "manual"
            && !this.completeAuthorizedManualCompaction()
            && !this.completeUncoordinatedManualCompaction())
          || typeof event.aborted !== "boolean"
          || typeof event.willRetry !== "boolean"
          || typeof event.failed !== "boolean"
        ) {
          this.failRuntime("invalid_rpc_event");
          return;
        }
        this.runtimeCompactionActive = false;
        this.compactionObservationVersion += 1;
        this.markLifecycleObservation();
        void coordinatedManual;
        return;
      case "queue_update": {
        if (!Number.isSafeInteger(event.pendingMessageCount) || (event.pendingMessageCount as number) < 0) {
          this.failRuntime("invalid_rpc_event");
          return;
        }
        // 只记录宿主是否还有待处理输入；它不属于公开快照或消息模型。
        this.hostPendingInputCount = event.pendingMessageCount as number;
        this.queueObservationVersion += 1;
        this.markLifecycleObservation();
        return;
      }
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
        // Pi 会捕获扩展 handler/sendMessage 异常并继续当前会话；它是诊断事件，
        // 不能升级为运行时或监督协议故障。关键扩展不变量通过监督通道显式失败。
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
      this.recordStartupFault(fault);
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
      if (event.agent_id === this.agentId && lifecycleEvent.type === "agent_settled") {
        const settlementVersion = this.markLifecycleObservation();
        void this.enqueueStateReconciliation(settlementVersion).catch(() => {
          // 状态探针失败不能伪造 idle；后续状态查询或消息发送仍可重试校准。
        });
        return;
      }
      const outcome = this.options.controller.applyLifecycleEvent(event.agent_id, lifecycleEvent);
      if (!outcome.ok) {
        this.receiveTransportFault("protocol_fault", "supervisor");
        return;
      }
      // 迟到代际或非法状态边只返回当前快照，不向上层伪造生命周期事实。
      if (!outcome.data.applied) return;
      if (event.agent_id === this.agentId) {
        this.lifecycleGeneration = outcome.data.lifecycle_generation;
        this.lifecycleState = outcome.data.node.state;
        if (lifecycleEvent.type === "agent_start") this.markLifecycleObservation("agent_start");
        else if (lifecycleEvent.type === "agent_settled") this.markLifecycleObservation();
        if (lifecycleEvent.type === "runtime_failed" && outcome.data.node.state === "failed") {
          if (this.phase === "starting") {
            this.recordStartupFault("protocol_fault");
            this.enterFailedPhase();
          } else if (this.phase === "ready") {
            this.enterFailedPhase();
          }
        }
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

  private onStartupFault(listener: () => void): () => void {
    this.startupFaultListeners.add(listener);
    return () => this.startupFaultListeners.delete(listener);
  }

  private throwIfStartupFaulted(): void {
    if (this.startupFault !== undefined) throw new StartupTransportFaultError();
  }

  private receiveToolStart(event: Record<string, unknown>): void {
    if (
      typeof event.toolCallId !== "string"
      || event.toolCallId.length === 0
      || typeof event.toolName !== "string"
      || event.toolName.length === 0
      || this.activeTools.has(event.toolCallId)
    ) {
      this.failRuntime("invalid_rpc_event");
      return;
    }
    this.retiredToolCallIds.delete(event.toolCallId);
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
      if (this.retiredToolCallIds.has(event.toolCallId)) return;
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

  private resetToolActivity(): void {
    if (this.activeTools.size === 0 && this.activeToolCounts.size === 0) return;
    for (const toolCallId of this.activeTools.keys()) {
      this.retiredToolCallIds.add(toolCallId);
    }
    while (this.retiredToolCallIds.size > 128) {
      const oldest = this.retiredToolCallIds.values().next().value;
      if (oldest === undefined) break;
      this.retiredToolCallIds.delete(oldest);
    }
    this.activeTools.clear();
    this.activeToolCounts.clear();
  }

  private quarantineRuntime(code: RpcSupervisorFaultCode, terminate = false): void {
    if (this.phase !== "ready") return;
    this.failRuntime(code);
    // 未知正文可能已经进入 Pi；只有该路径需要立即回收节点，避免迟到执行。
    if (terminate) void this.terminate().catch(() => {});
  }

  private recordStartupFault(fault: RpcSupervisorTransportFault | RpcSupervisorChannelFault): void {
    this.startupFault ??= fault;
    for (const listener of [...this.startupFaultListeners]) listener();
  }

  private enterFailedPhase(): void {
    this.phase = "failed";
    this.releaseCoordinatedCompactions();
    this.activeTools.clear();
    this.activeToolCounts.clear();
    this.retiredToolCallIds.clear();
  }

  private failRuntime(code: RpcSupervisorFaultCode): void {
    if (this.phase !== "ready") return;
    // applyLifecycle 会同步通知 AgentController；先固定内部失败态，确保其
    // 立即启动的 orphan cleanup 不会在 reapOrphanedDescendants 中看到 ready。
    this.enterFailedPhase();
    const lifecycleCode = code === "message_delivery_failed"
      ? "message_delivery_failed"
      : code === "invalid_rpc_event"
        || code === "rpc_protocol_fault"
        || code === "supervisor_protocol_fault"
        ? "protocol_mismatch"
        : "internal_error";
    this.applyLifecycle({ type: "runtime_failed", error_code: lifecycleCode });
    this.emitEvent(Object.freeze({ kind: "fault", code }));
  }

  private releaseCoordinatedCompactions(): void {
    const states = [...this.coordinatedCompactions.values()];
    for (const state of states) this.releaseCoordinatedCompaction(state, "not_started");
    this.coordinatedCompactions.clear();
    this.closedCoordinatedCompactions.clear();
    this.manualCompactionAuthorizations.clear();
    this.activeManualCompactionTransactionId = undefined;
    this.uncoordinatedManualCompactionActive = false;
    this.runtimeCompactionActive = false;
  }

  private compactionBarrierActive(): boolean {
    return this.runtimeCompactionActive
      || this.coordinatedCompactions.size > 0
      || this.activeManualCompactionTransactionId !== undefined
      || this.uncoordinatedManualCompactionActive;
  }

  private async enqueueMessage(
    message: string,
    mode?: "prompt" | "steer",
  ): Promise<RpcSupervisorCommandResult> {
    if (this.phase !== "ready" || typeof message !== "string" || message.length === 0) {
      return Object.freeze({ ok: false, code: "agent_unavailable" });
    }
    // 本地 lifecycle 可能落后于 Pi 的续跑事件；先读取真实状态，再决定
    // 使用 steer 还是启动新的 prompt。
    await this.synchronizeState();
    if (this.phase !== "ready") {
      return Object.freeze({ ok: false, code: "agent_unavailable" });
    }
    if (
      this.lifecycleState === "interrupting"
      || this.lifecycleState === "terminating"
      || this.lifecycleState === "terminated"
      || this.lifecycleState === "failed"
    ) return Object.freeze({ ok: false, code: "message_delivery_failed" });
    if (this.compactionBarrierActive()) {
      return Object.freeze({ ok: false, code: "compaction_active" });
    }
    const submissionMode = mode ?? (this.lifecycleState === "working" ? "steer" : "prompt");
    try {
      const operation = submissionMode === "steer"
        ? this.commandClient().steer(message)
        : this.commandClient().prompt(message);
      const response = await this.withMessageTimeout(operation);
      if (!isSynchronousAcceptance(response)) throw new Error("message_delivery_failed");
      return Object.freeze({ ok: true, accepted: true }) as unknown as RpcSupervisorCommandResult;
    } catch (error) {
      if (error instanceof ManagedRpcCommandRejectedError && error.reason === "compaction_active") {
        return Object.freeze({ ok: false, code: "compaction_active" });
      }
      // Pi 拒绝、调用异常或响应未知只结算本次消息，不升级生命周期。
      return Object.freeze({ ok: false, code: "message_delivery_failed" });
    }
  }

  private markLifecycleObservation(type?: "agent_start"): number {
    this.lifecycleObservationVersion += 1;
    if (type === "agent_start") this.latestAgentStartVersion = this.lifecycleObservationVersion;
    return this.lifecycleObservationVersion;
  }

  private enqueueStateReconciliation(expectedSettlementVersion?: number): Promise<boolean> {
    const operation = this.stateReconciliationQueue.then(
      () => this.reconcileRuntimeState(expectedSettlementVersion),
      () => this.reconcileRuntimeState(expectedSettlementVersion),
    );
    this.stateReconciliationQueue = operation.catch(() => false);
    return operation;
  }

  private async reconcileRuntimeState(expectedSettlementVersion?: number): Promise<boolean> {
    if (this.phase !== "ready") return false;
    const compactionVersion = this.compactionObservationVersion;
    const queueVersion = this.queueObservationVersion;
    const latestAgentStartAtProbe = this.latestAgentStartVersion;
    let observed: RpcSupervisorRuntimeState | undefined;
    try {
      observed = parseRpcSupervisorRuntimeState(await this.commandClient().getState());
    } catch {
      return false;
    }
    if (observed === undefined || this.phase !== "ready") return false;

    if (this.queueObservationVersion === queueVersion) {
      this.hostPendingInputCount = observed.pendingMessageCount;
    }
    if (this.compactionObservationVersion === compactionVersion && observed.isCompacting) {
      this.runtimeCompactionActive = true;
    }
    const pendingMessageCount = this.queueObservationVersion === queueVersion
      ? observed.pendingMessageCount
      : this.hostPendingInputCount;
    const isCompacting = this.compactionObservationVersion === compactionVersion
      ? observed.isCompacting
      : this.runtimeCompactionActive;
    const activeRun = observed.isStreaming || pendingMessageCount > 0;
    if (activeRun) {
      if (this.lifecycleState === "idle") {
        try {
          this.applyLifecycle({ type: "agent_start" });
        } catch {
          return false;
        }
      }
      return true;
    }

    // 续跑的 agent_start 可能已经先于旧 settled 事件抵达；旧 settled
    // 不能覆盖这个更新的真实运行事实。
    if (
      (expectedSettlementVersion !== undefined
        && this.latestAgentStartVersion > expectedSettlementVersion)
      || this.latestAgentStartVersion > latestAgentStartAtProbe
    ) return true;
    if (isCompacting || this.compactionBarrierActive() || pendingMessageCount !== 0) {
      return true;
    }
    if (this.lifecycleState === "working" || this.lifecycleState === "interrupting") {
      try {
        this.applyLifecycle({ type: "agent_settled" });
      } catch {
        return false;
      }
    }
    return true;
  }

  private async withMessageTimeout(operation: Promise<unknown>): Promise<unknown> {
    const timeoutMs = this.options.startupTimeoutMs;
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("message_delivery_unknown"));
      }, timeoutMs);
      void Promise.resolve(operation).then(
        (value: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private async rollbackStartup(
    code: "spawn_failed" | "spawn_timeout" | "capability_mismatch",
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
      if (this.treeConfirmationPending) {
        return Object.freeze({
          ok: true,
          agent_id: this.agentId,
          state: "terminating" as const,
          cleanup: "confirmed" as const,
          tree_confirmation: "pending" as const,
        });
      }
      return Object.freeze({
        ok: true,
        agent_id: this.agentId,
        state: "terminated" as const,
        cleanup: "confirmed" as const,
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
      if (confirmNode && this.agentId !== undefined) this.markTerminationCleanupIncomplete();
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
      if (confirmNode && this.agentId !== undefined) this.markTerminationCleanupIncomplete();
      return "incomplete";
    }

    if (this.agentId === undefined) return "incomplete";
    if (!confirmNode) {
      this.unsubscribeDependencies();
      return "confirmed";
    }
    const confirmation = this.applyLifecycle({ type: "resources_confirmed" });
    if (confirmation.node.state !== "terminated") {
      // 物理资源已经确认；固定屏障的整树提交由外层权威完成。
      this.treeConfirmationPending = true;
    }
    this.phase = "terminated";
    this.unsubscribeDependencies();
    return "confirmed";
  }

  private markTerminationCleanupIncomplete(): void {
    try {
      this.options.controller.markTerminationBarrierIncomplete?.(this.agentId);
    } catch {
      // 清理诊断失败不能伪造资源确认，也不能再次改变生命周期。
    }
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
    if (outcome.data.applied) {
      this.markLifecycleObservation(event.type === "agent_start" ? "agent_start" : undefined);
      this.emitEvent(Object.freeze({ kind: "lifecycle", event: normalized }));
    }
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
    this.unsubscribeCompactionPrepare?.();
    this.unsubscribeCompactionComplete?.();
    this.channelBindingCleanup?.();
    this.unsubscribeRpcEvent = undefined;
    this.unsubscribeRpcFault = undefined;
    this.unsubscribeChannelFault = undefined;
    this.unsubscribeChannelEvent = undefined;
    this.unsubscribeChannelSnapshot = undefined;
    this.unsubscribeCompactionPrepare = undefined;
    this.unsubscribeCompactionComplete = undefined;
    this.releaseCoordinatedCompactions();
    this.channelBindingCleanup = undefined;
  }
}

function parseRpcSupervisorRuntimeState(value: unknown): RpcSupervisorRuntimeState | undefined {
  if (!isRecord(value)
    || typeof value.isStreaming !== "boolean"
    || typeof value.isCompacting !== "boolean"
    || !Number.isSafeInteger(value.pendingMessageCount)
    || (value.pendingMessageCount as number) < 0
  ) return undefined;
  return Object.freeze({
    isStreaming: value.isStreaming,
    isCompacting: value.isCompacting,
    pendingMessageCount: value.pendingMessageCount as number,
  });
}

function isSynchronousAcceptance(value: unknown): boolean {
  if (value === undefined || value === true) return true;
  if (value === false || value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record.then === "function") return false;
  if (record.ok === true || record.accepted === true) {
    return record.ok !== false && record.accepted !== false;
  }
  return false;
}
