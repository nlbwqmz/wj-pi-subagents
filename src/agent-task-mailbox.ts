import { randomUUID } from "node:crypto";
import {
  isCanonicalUuidV4Text,
  type AgentActivityCategory,
  type AgentActivitySummary,
  type AgentLastTask,
  type AgentLifecycleState,
} from "./agent-snapshot-codec.ts";
import type { ChildFinalEnvelope } from "./child-reply-envelope.ts";

export interface AgentTaskMailboxOptions {
  readonly taskIdFactory?: () => string;
  readonly messageIdFactory?: () => string;
}

export interface AgentTaskSubmission {
  readonly message_id: string;
  readonly task_id: string;
  readonly accepted: true;
}

export interface AgentHostDelivery {
  readonly delivery_id: number;
  readonly message_id: string;
  readonly task_id: string;
  readonly message: string;
  readonly mode: "prompt" | "steer";
  readonly start_epoch: number;
  readonly task_start_epoch: number;
  readonly host_queue_epoch: number;
}

export type AgentCompactionReason = "manual" | "threshold" | "overflow";
export type AgentCoordinationOutcome = "succeeded" | "failed" | "cancelled" | "not_started";
export type CoordinationBarrierReadiness = "waiting" | "quiescent" | "unsafe";

export interface AgentTaskProjection {
  readonly state: Extract<AgentLifecycleState, "idle" | "working" | "interrupting" | "suspended">;
  readonly mailbox_pending_count: number;
  readonly host_pending_count: number;
  readonly reply_outbox_pending_count: number;
  readonly activity?: AgentActivitySummary;
  readonly last_task?: AgentLastTask;
}

interface MailboxEntry {
  readonly messageId: string;
  readonly taskId: string;
  readonly message: string;
}

interface CurrentTask {
  taskId: string;
  turnId?: string;
  hostStarted: boolean;
  readonly origin: "assigned" | "automatic";
}

const MAX_ID_GENERATION_ATTEMPTS = 32;

/**
 * 单节点事务 mailbox。所有公开命令、宿主事实和 final commit 都先在这里
 * 线性化；调用方只负责按返回的 effect 操作 Pi 和把 projection 原子写入树。
 */
export class AgentTaskMailbox {
  private readonly taskIdFactory: () => string;
  private readonly messageIdFactory: () => string;
  private readonly issuedTaskIds = new Set<string>();
  private readonly issuedMessageIds = new Set<string>();
  private readonly mailbox: MailboxEntry[] = [];
  private readonly toolCounts = new Map<AgentActivityCategory, number>();
  private currentTask: CurrentTask | undefined;
  private successorTaskId: string | undefined;
  private inFlight: AgentHostDelivery | undefined;
  private preparedFinal: ChildFinalEnvelope | undefined;
  private lastTask: AgentLastTask | undefined;
  private state: AgentTaskProjection["state"] = "idle";
  private phase: AgentActivitySummary["phase"] | undefined;
  private hostPendingCount = 0;
  private hostQueueEpoch = 0;
  private replyOutboxPendingCount = 0;
  private interruptBarrier = false;
  private settlementObserved = false;
  private compactionActive = false;
  private readonly coordinationBarriers = new Set<string>();
  private coordinatedSettlementWorkPending = false;
  private coordinatedCompactionResolved = false;
  private coordinatedPhysicalLifecycleObserved = false;
  private coordinatedContinuationStarted = false;
  private awaitingCoordinatedContinuationStart = false;
  private awaitingNativeCompactionOutcome = false;
  private awaitingRetryStart = false;
  private awaitingPromptStart = false;
  private deliveryUncertain = false;
  private deliveryUncertainTaskId: string | undefined;
  private uncertainDelivery: AgentHostDelivery | undefined;
  private maintenanceFailed = false;
  private readonly staleFinalTurns = new Set<string>();
  private startEpoch = 0;
  private taskStartEpoch = 0;
  private confirmedTaskStartKey: string | undefined;
  private nextDeliveryId = 1;

  constructor(options: AgentTaskMailboxOptions = {}) {
    this.taskIdFactory = options.taskIdFactory ?? randomUUID;
    this.messageIdFactory = options.messageIdFactory ?? (() => `msg_${randomUUID()}`);
  }

  /** 接纳只写入插件 mailbox，不等待 Pi，也不声称模型已经读取。 */
  submit(message: string): AgentTaskSubmission {
    if (typeof message !== "string" || message.length === 0) throw new TypeError("invalid_task_message");
    const taskId = this.taskForSubmission();
    const messageId = this.allocateOpaqueId(this.messageIdFactory, this.issuedMessageIds, false);
    this.mailbox.push(Object.freeze({ messageId, taskId, message }));
    if (this.state === "idle") {
      this.state = "working";
      this.phase = "reconciling";
    }
    return Object.freeze({ message_id: messageId, task_id: taskId, accepted: true });
  }

  /** 选择 prompt/steer 也属于 reducer；外层控制器不得预读快照自行路由。 */
  takeNextDelivery(): AgentHostDelivery | undefined {
    if (this.inFlight !== undefined || !this.deliveryAllowed()) return undefined;
    this.promoteSuccessorIfPossible();
    const task = this.currentTask;
    if (task === undefined) return undefined;
    const entry = this.mailbox.find((candidate) => candidate.taskId === task.taskId);
    if (entry === undefined) return undefined;

    // settle 之前已接纳的 mailbox 工作优先于 provisional final；新的 prompt
    // 会让 child 在 quarantine 内作废旧 candidate。
    if (this.settlementObserved) {
      this.settlementObserved = false;
      this.preparedFinal = undefined;
      this.replyOutboxPendingCount = 0;
      this.clearCoordinatedSettlementWork();
      task.hostStarted = false;
    }
    this.phase = "reconciling";
    const delivery = Object.freeze({
      delivery_id: this.nextDeliveryId++,
      message_id: entry.messageId,
      task_id: entry.taskId,
      message: entry.message,
      mode: task.hostStarted ? "steer" as const : "prompt" as const,
      start_epoch: this.startEpoch,
      task_start_epoch: this.taskStartEpoch,
      host_queue_epoch: this.hostQueueEpoch,
    });
    this.inFlight = delivery;
    return delivery;
  }

  isDeliveryActive(deliveryId: number): boolean {
    return this.inFlight?.delivery_id === deliveryId;
  }

  hostAccepted(deliveryId: number): boolean {
    const delivery = this.claimDelivery(deliveryId);
    if (delivery === undefined) return false;
    this.removeMailboxEntry(delivery.message_id);
    const task = this.currentTask;
    const taskMatches = task?.taskId === delivery.task_id;
    if (!taskMatches) {
      this.markDeliveryUncertain(delivery.task_id, delivery);
      return true;
    }
    if (delivery.mode === "steer") {
      // steer 成功响应是 Pi 已完成同步入队的接纳事实。期间出现的新 run 或旧
      // settled 不能反向否定该事实；它们只说明队列由 continuation 消费。
      this.reconcileAcceptedSteer(delivery);
      return true;
    }
    const startsSinceDelivery = this.startEpoch - delivery.start_epoch;
    const promptExecutionObserved = this.promptExecutionObserved(delivery);
    if (
      !promptExecutionObserved
      && (
        startsSinceDelivery < 0
        || startsSinceDelivery > 1
        || this.settlementObserved
      )
    ) {
      this.markDeliveryUncertain(delivery.task_id, delivery);
      return true;
    }
    if (delivery.mode === "prompt") {
      if (promptExecutionObserved) {
        this.reconcileObservedPromptExecution();
        return true;
      }
      // RPC 成功只证明 Pi 接纳了命令。agent_start 可能先于这个响应到达；
      // 只有尚未观察到真实 start 时才保留 prompt-start 栅栏。
      this.awaitingPromptStart = !task.hostStarted;
      this.state = "working";
      this.phase = this.awaitingPromptStart
        ? "reconciling"
        : this.toolCounts.size > 0 ? "executing_tools" : "processing";
      return true;
    }
    this.state = "working";
    this.phase = this.toolCounts.size > 0 ? "executing_tools" : "processing";
    return true;
  }

  /** 明确拒绝证明正文未入 Pi；steer 可保留原正文并安全降级为新 prompt。 */
  hostRejected(deliveryId: number): boolean {
    const delivery = this.claimDelivery(deliveryId);
    if (delivery === undefined) return false;
    const task = this.currentTask;
    if (task?.taskId !== delivery.task_id) {
      this.markDeliveryUncertain(delivery.task_id, delivery);
      return true;
    }
    if (delivery.mode === "prompt") {
      // prompt 已经是最后一种安全投递模式；保留正文并等待新的宿主事实。
      this.markDeliveryUncertain(delivery.task_id, delivery);
      return true;
    }
    task.hostStarted = false;
    this.settlementObserved = false;
    this.preparedFinal = undefined;
    this.replyOutboxPendingCount = 0;
    this.awaitingPromptStart = false;
    if (!this.interruptBarrier) this.state = "working";
    this.phase = "reconciling";
    return true;
  }

  /** RpcClient 传输异常不能证明宿主未接纳；已有启动或 final 则按强事实对账。 */
  hostDeliveryUncertain(deliveryId: number): boolean {
    const delivery = this.claimDelivery(deliveryId);
    if (delivery === undefined) return false;
    this.removeMailboxEntry(delivery.message_id);
    if (this.promptExecutionObserved(delivery)) {
      this.reconcileObservedPromptExecution();
      return true;
    }
    if (delivery.mode === "steer" && this.hostQueueObservedSince(delivery)) {
      this.reconcileAcceptedSteer(delivery);
      return true;
    }
    this.markDeliveryUncertain(delivery.task_id, delivery);
    return true;
  }

  /** child 监督事实把实际轮次身份与父端占位任务对齐。 */
  observeTaskStarted(taskId: string, turnId: string): boolean {
    if (!isCanonicalUuidV4Text(taskId) || !isCanonicalUuidV4Text(turnId)) return false;
    const taskStartKey = `${taskId}:${turnId}`;
    const current = this.currentTask;
    const reconcilesUncertainDelivery = this.deliveryUncertain
      && this.deliveryUncertainTaskId === taskId
      && current?.taskId === taskId;
    if (reconcilesUncertainDelivery) {
      // task_started 是 Pi 已建立该任务轮次的强事实；它允许收敛此前
      // prompt/steer Promise 拒绝留下的交付不确定屏障，但不会重新发送正文。
      this.deliveryUncertain = false;
      this.deliveryUncertainTaskId = undefined;
      this.uncertainDelivery = undefined;
    }
    if (current === undefined) {
      this.currentTask = {
        taskId,
        turnId,
        hostStarted: true,
        origin: "automatic",
      };
    } else if (current.taskId !== taskId) {
      if (current.turnId !== undefined) this.rememberStaleFinalTurn(current.turnId);
      const ownsAssignedWork = current.origin === "assigned"
        || this.mailbox.some((entry) => entry.taskId === current.taskId)
        || this.inFlight?.task_id === current.taskId;
      if (ownsAssignedWork) return false;
      current.taskId = taskId;
      current.turnId = turnId;
      current.hostStarted = true;
    } else {
      if (current.turnId !== undefined && current.turnId !== turnId) {
        this.rememberStaleFinalTurn(current.turnId);
        this.preparedFinal = undefined;
        this.replyOutboxPendingCount = 0;
      }
      current.turnId = turnId;
      current.hostStarted = true;
    }
    if (
      !this.settlementObserved
      && !this.compactionActive
      && !this.deliveryUncertain
      && !this.maintenanceFailed
    ) {
      if (!this.interruptBarrier) this.state = "working";
      this.phase = this.toolCounts.size > 0 ? "executing_tools" : "processing";
    }
    if (this.confirmedTaskStartKey !== taskStartKey) {
      this.confirmedTaskStartKey = taskStartKey;
      this.taskStartEpoch += 1;
    }
    return true;
  }

  observeAgentStart(): void {
    this.startEpoch += 1;
    if (this.currentTask === undefined) {
      this.currentTask = {
        taskId: this.allocateTaskId(),
        hostStarted: true,
        origin: "automatic",
      };
    } else {
      this.currentTask.hostStarted = true;
    }
    const coordinatedContinuation = this.awaitingCoordinatedContinuationStart
      || (
        this.coordinatedSettlementWorkPending
        && this.coordinatedPhysicalLifecycleObserved
        && this.coordinatedCompactionResolved
      );
    if (coordinatedContinuation) {
      this.coordinatedContinuationStarted = true;
      this.awaitingCoordinatedContinuationStart = false;
    }
    this.compactionActive = false;
    this.awaitingNativeCompactionOutcome = false;
    this.awaitingRetryStart = false;
    this.awaitingPromptStart = false;
    this.settlementObserved = false;
    if (!coordinatedContinuation && this.coordinationBarriers.size === 0) {
      this.clearCoordinatedSettlementWork();
    }
    this.preparedFinal = undefined;
    this.replyOutboxPendingCount = 0;
    if (this.deliveryUncertain || this.maintenanceFailed) {
      this.applySuspendedBarrier();
      return;
    }
    if (!this.interruptBarrier) this.state = "working";
    this.phase = coordinatedContinuation && !this.coordinatedCompactionResolved
      ? "reconciling"
      : this.toolCounts.size > 0 ? "executing_tools" : "processing";
    this.reconcileCoordinatedSettlementWork();
  }

  /** raw settled 只形成 candidate；没有 final commit 时绝不进入 idle。 */
  observeAgentSettled(): "candidate" | "superseded" {
    if (this.awaitingRetryStart) {
      this.settlementObserved = false;
      this.preparedFinal = undefined;
      this.replyOutboxPendingCount = 0;
      if (this.deliveryUncertain || this.maintenanceFailed) this.applySuspendedBarrier();
      else {
        if (!this.interruptBarrier) this.state = "working";
        this.phase = "reconciling";
      }
      return "superseded";
    }
    this.awaitingNativeCompactionOutcome = false;
    const promptStartUnconfirmed = this.awaitingPromptStart;
    this.awaitingPromptStart = false;
    if (promptStartUnconfirmed) {
      this.preparedFinal = undefined;
      this.replyOutboxPendingCount = 0;
      this.markDeliveryUncertain();
      return "superseded";
    }
    if (this.deliveryUncertain || this.maintenanceFailed) {
      this.applySuspendedBarrier();
      return "superseded";
    }
    if (this.currentTask === undefined) {
      this.currentTask = {
        taskId: this.allocateTaskId(),
        hostStarted: false,
        origin: "automatic",
      };
    }
    this.currentTask.hostStarted = false;
    if (this.hostPendingCount > 0) {
      this.settlementObserved = false;
      this.preparedFinal = undefined;
      this.replyOutboxPendingCount = 0;
      if (this.inFlight?.mode === "steer" && this.hostQueueObservedSince(this.inFlight)) {
        this.currentTask.hostStarted = true;
        if (!this.interruptBarrier) this.state = "working";
        this.phase = this.toolCounts.size > 0 ? "executing_tools" : "processing";
        return "superseded";
      }
      this.markDeliveryUncertain();
      return "superseded";
    }
    this.hostPendingCount = 0;
    const hasEarlierMailboxWork = this.mailbox.some((entry) => entry.taskId === this.currentTask?.taskId)
      || this.inFlight?.task_id === this.currentTask.taskId;
    if (hasEarlierMailboxWork) {
      this.settlementObserved = true;
      this.replyOutboxPendingCount = 0;
      if (!this.interruptBarrier) this.state = "working";
      this.phase = "reconciling";
      return "superseded";
    }
    this.settlementObserved = true;
    this.replyOutboxPendingCount = 1;
    if (this.finalCommitBlocked()) return "candidate";
    if (this.state === "idle" || this.state === "suspended") this.state = "working";
    this.phase = this.preparedFinal === undefined ? "finalizing" : "waiting_parent_ack";
    return "candidate";
  }

  /** 直接 child 压缩时冻结这条父子边；不同事务令牌可以安全叠加。 */
  beginCoordinationBarrier(transactionId: string): boolean {
    if (!validCoordinationTransactionId(transactionId)) return false;
    if (this.coordinationBarriers.size === 0) {
      this.coordinatedCompactionResolved = false;
      this.coordinatedPhysicalLifecycleObserved = false;
      this.coordinatedContinuationStarted = false;
      this.awaitingCoordinatedContinuationStart = false;
    }
    this.coordinationBarriers.add(transactionId);
    if (this.hasCurrentTaskMailboxWork()) this.coordinatedSettlementWorkPending = true;
    return true;
  }

  completeCoordinationBarrier(
    transactionId: string,
    outcome?: AgentCoordinationOutcome,
    continuationExpected = false,
  ): boolean {
    if (!validCoordinationTransactionId(transactionId)) return false;
    if (!this.coordinationBarriers.delete(transactionId)) return false;
    if (this.coordinationBarriers.size === 0) {
      // not_started 或无物理结果的通用屏障都不会再出现本事务的压缩生命周期。
      if (outcome === undefined || outcome === "not_started") this.coordinatedCompactionResolved = true;
      this.awaitingCoordinatedContinuationStart = outcome === "succeeded"
        && continuationExpected
        && !this.coordinatedContinuationStarted;
    }
    this.reconcileCoordinatedSettlementWork();
    return true;
  }

  /**
   * prepare 只等待旧 RPC 交付和 Pi 队列；prompt 预检已成功但尚未收到
   * task_started 时，子端可能正等待本 prepare 响应才能进入真实启动。
   * 把该空档继续视为等待会形成自我依赖的压缩死锁。
   */
  coordinationBarrierReadiness(): CoordinationBarrierReadiness {
    if (this.deliveryUncertain || this.maintenanceFailed) return "unsafe";
    return this.inFlight === undefined
      && this.hostPendingCount === 0
      ? "quiescent"
      : "waiting";
  }

  hasCoordinationBarrier(): boolean {
    return this.coordinationBarriers.size > 0;
  }

  /** 监督器已完成授权后记录手工或原生压缩生命周期；逻辑任务身份保持不变。 */
  observeCompactionStart(_reason: AgentCompactionReason, coordinated = false): void {
    if (this.compactionActive) return;
    this.compactionActive = true;
    if (coordinated) {
      this.coordinatedPhysicalLifecycleObserved = true;
      if (this.coordinatedSettlementWorkPending) this.coordinatedCompactionResolved = false;
    }
    this.awaitingNativeCompactionOutcome = false;
    this.awaitingRetryStart = false;
    this.awaitingPromptStart = false;
    if (this.deliveryUncertain || this.maintenanceFailed) {
      this.applySuspendedBarrier();
    } else {
      this.state = "working";
      this.phase = coordinated && this.coordinatedContinuationStarted ? "reconciling" : "compacting";
    }
  }

  /** 协调 manual 压缩已经发生在 raw settlement 之后，不再等待新的 settled。 */
  observeCompactionEnd(
    reason: AgentCompactionReason,
    failed: boolean,
    willRetry = false,
    coordinated = false,
  ): void {
    this.compactionActive = false;
    if (coordinated) {
      this.coordinatedPhysicalLifecycleObserved = true;
      if (this.coordinatedSettlementWorkPending) this.coordinatedCompactionResolved = true;
    }
    this.awaitingRetryStart = !failed && willRetry;
    if (failed || willRetry) {
      this.settlementObserved = false;
      this.preparedFinal = undefined;
      this.replyOutboxPendingCount = 0;
    }
    if (failed) {
      this.maintenanceFailed = true;
      this.applySuspendedBarrier();
      return;
    }
    if (coordinated && this.coordinatedContinuationStarted) {
      if (!this.interruptBarrier) this.state = "working";
      this.phase = "reconciling";
      this.reconcileCoordinatedSettlementWork();
      return;
    }
    if (this.currentTask === undefined) {
      this.state = "idle";
      this.phase = undefined;
      return;
    }
    if (reason === "manual" && !willRetry) {
      this.awaitingNativeCompactionOutcome = false;
      if (this.deliveryUncertain || this.maintenanceFailed) {
        this.applySuspendedBarrier();
        return;
      }
      if (!this.interruptBarrier) this.state = "working";
      this.phase = this.preparedFinal === undefined ? "finalizing" : "waiting_parent_ack";
      this.reconcileCoordinatedSettlementWork();
      return;
    }
    this.awaitingNativeCompactionOutcome = true;
    if (this.deliveryUncertain || this.maintenanceFailed) {
      this.applySuspendedBarrier();
      return;
    }
    if (!this.interruptBarrier) this.state = "working";
    this.phase = "reconciling";
  }

  reconcileHostPending(pendingMessageCount: number): boolean {
    if (!Number.isSafeInteger(pendingMessageCount) || pendingMessageCount < 0) return false;
    if (this.hostPendingCount === pendingMessageCount) return false;
    if (pendingMessageCount > this.hostPendingCount) this.hostQueueEpoch += 1;
    this.hostPendingCount = pendingMessageCount;
    const uncertain = this.uncertainDelivery;
    if (
      this.deliveryUncertain
      && uncertain?.mode === "steer"
      && this.hostQueueObservedSince(uncertain)
    ) {
      this.reconcileAcceptedSteer(uncertain);
    }
    return true;
  }

  /** final 先 prepare，父会话注入成功后再用 commitPreparedFinal 单调提交。 */
  prepareFinal(final: ChildFinalEnvelope): boolean {
    if (this.preparedFinal?.commit_id === final.commit_id) return this.canCommitPreparedFinal();
    if (this.preparedFinal !== undefined) return false;
    const current = this.currentTask;
    if (current === undefined) {
      this.currentTask = {
        taskId: final.task_id,
        turnId: final.turn_id,
        hostStarted: false,
        origin: "automatic",
      };
    } else if (current.taskId !== final.task_id) {
      if (current.origin !== "automatic" || this.mailbox.some((entry) => entry.taskId === current.taskId)) {
        return false;
      }
      current.taskId = final.task_id;
      current.turnId = final.turn_id;
    } else if (current.turnId !== undefined && current.turnId !== final.turn_id) {
      return false;
    } else {
      current.turnId = final.turn_id;
    }
    this.preparedFinal = final;
    this.replyOutboxPendingCount = 1;
    if (this.finalCommitBlocked()) return false;
    if (this.state === "idle") this.state = "working";
    this.phase = this.settlementObserved ? "waiting_parent_ack" : "finalizing";
    return this.canCommitPreparedFinal();
  }

  canCommitPreparedFinal(): boolean {
    const final = this.preparedFinal;
    const task = this.currentTask;
    return final !== undefined
      && task !== undefined
      && final.task_id === task.taskId
      && (task.turnId === undefined || final.turn_id === task.turnId)
      && this.settlementObserved
      && !this.finalCommitBlocked()
      && this.inFlight === undefined
      && !this.mailbox.some((entry) => entry.taskId === task.taskId);
  }

  commitPreparedFinal(commitId: string): boolean {
    const final = this.preparedFinal;
    if (final === undefined || final.commit_id !== commitId || !this.canCommitPreparedFinal()) return false;
    this.lastTask = Object.freeze({
      task_id: final.task_id,
      turn_id: final.turn_id,
      commit_id: final.commit_id,
      outcome: final.run_state === "settled"
        ? "completed"
        : final.run_state === "failed"
          ? "failed"
          : "interrupted",
      output_state: final.output_state,
    });
    this.preparedFinal = undefined;
    this.currentTask = undefined;
    this.settlementObserved = false;
    this.interruptBarrier = false;
    this.compactionActive = false;
    this.awaitingNativeCompactionOutcome = false;
    this.awaitingRetryStart = false;
    this.awaitingPromptStart = false;
    this.clearCoordinatedSettlementWork();
    this.deliveryUncertain = false;
    this.deliveryUncertainTaskId = undefined;
    this.uncertainDelivery = undefined;
    this.maintenanceFailed = false;
    this.hostPendingCount = 0;
    this.replyOutboxPendingCount = 0;
    this.toolCounts.clear();
    this.promoteSuccessorIfPossible();
    if (this.currentTask === undefined && this.mailbox.length === 0) {
      this.state = "idle";
      this.phase = undefined;
    } else {
      this.state = "working";
      this.phase = "reconciling";
    }
    return true;
  }

  hasInterruptBarrier(): boolean {
    return this.interruptBarrier;
  }

  /**
   * 当前中断无法由 Pi 公共 API 产生可验证的 settled 事实时，节点必须隔离。
   * Pi 的 abort 不会取消 prompt 预检中的自动压缩；该阶段没有 agent loop，
   * 继续保留 interrupt barrier 会永久阻塞后继任务。
   */
  requiresNodeIsolationForInterrupt(): boolean {
    return this.compactionActive;
  }

  hasUncertainDelivery(): boolean {
    return this.deliveryUncertain;
  }

  hasMaintenanceFailure(): boolean {
    return this.maintenanceFailed;
  }

  requestInterrupt(): { readonly changed: boolean; readonly should_abort: boolean } {
    if (this.state !== "working" || this.currentTask === undefined || this.interruptBarrier) {
      return Object.freeze({ changed: false, should_abort: false });
    }
    this.interruptBarrier = true;
    // 已发出的租约不代表正文已送入 Pi；栅栏后废弃尚未完成的旧投递。
    this.inFlight = undefined;
    const interruptedTaskId = this.currentTask.taskId;
    for (let index = this.mailbox.length - 1; index >= 0; index -= 1) {
      if (this.mailbox[index]!.taskId === interruptedTaskId) this.mailbox.splice(index, 1);
    }
    this.clearCoordinatedSettlementWork();
    this.state = "interrupting";
    this.phase = "processing";
    return Object.freeze({ changed: true, should_abort: true });
  }

  observeToolActivity(category: AgentActivityCategory, activeCount: number): void {
    if (!Number.isSafeInteger(activeCount) || activeCount < 0) return;
    if (activeCount === 0) this.toolCounts.delete(category);
    else this.toolCounts.set(category, activeCount);
    if (this.state !== "working" && this.state !== "interrupting") return;
    this.phase = this.toolCounts.size > 0 ? "executing_tools" : "processing";
  }

  projection(): AgentTaskProjection {
    const taskId = this.currentTask?.taskId;
    const activeTool = [...this.toolCounts].at(-1);
    const activity = this.phase === undefined
      ? undefined
      : Object.freeze({
          phase: this.phase,
          ...(taskId === undefined ? {} : { task_id: taskId }),
          ...(activeTool === undefined ? {} : {
            category: activeTool[0],
            active_count: activeTool[1],
          }),
        });
    return Object.freeze({
      state: this.state,
      mailbox_pending_count: this.mailbox.length,
      host_pending_count: this.hostPendingCount,
      reply_outbox_pending_count: this.replyOutboxPendingCount,
      ...(activity === undefined ? {} : { activity }),
      ...(this.lastTask === undefined ? {} : { last_task: this.lastTask }),
    });
  }

  currentTaskId(): string | undefined {
    return this.currentTask?.taskId;
  }

  currentTurnId(): string | undefined {
    return this.currentTask?.turnId;
  }

  preparedFinalCommitId(): string | undefined {
    return this.preparedFinal?.commit_id;
  }

  hasPendingMessage(messageId: string): boolean {
    return this.mailbox.some((entry) => entry.messageId === messageId);
  }

  hasObservedSettlement(): boolean {
    return this.settlementObserved;
  }

  isSupersededFinal(final: ChildFinalEnvelope): boolean {
    return this.staleFinalTurns.has(final.turn_id);
  }

  /** 已作废 final 只允许完成其传输 ACK；它从不成为任务结果。 */
  shouldAcknowledgeSupersededFinal(final: ChildFinalEnvelope): boolean {
    return this.isSupersededFinal(final);
  }

  acceptsReplyTask(taskId: string, turnId?: string): boolean {
    return this.currentTask?.taskId === taskId
      && (turnId === undefined || this.currentTask.turnId === undefined || this.currentTask.turnId === turnId);
  }

  private taskForSubmission(): string {
    const current = this.currentTask;
    if (current === undefined) {
      const taskId = this.allocateTaskId();
      this.currentTask = { taskId, hostStarted: false, origin: "assigned" };
      return taskId;
    }
    if (!this.interruptBarrier && !this.settlementObserved) {
      if (this.coordinationBarriers.size > 0) {
        this.coordinatedSettlementWorkPending = true;
        this.phase = this.compactionActive ? "compacting" : "reconciling";
      }
      return current.taskId;
    }
    if (!this.interruptBarrier && this.coordinationBarriers.size > 0) {
      // 协调压缩中的 raw settlement 不是逻辑任务终点；保持已返回 task_id
      // 稳定，并等待压缩结束或真实 continuation start 后再投递。
      this.coordinatedSettlementWorkPending = true;
      this.phase = this.compactionActive ? "compacting" : "reconciling";
      return current.taskId;
    }
    this.successorTaskId ??= this.allocateTaskId();
    return this.successorTaskId;
  }

  private deliveryAllowed(): boolean {
    if (
      this.interruptBarrier
      || this.compactionActive
      || this.coordinationBarriers.size > 0
      || (this.coordinatedSettlementWorkPending && !this.coordinatedCompactionResolved)
      || this.awaitingCoordinatedContinuationStart
      || this.awaitingNativeCompactionOutcome
      || this.awaitingPromptStart
      || this.deliveryUncertain
      || this.maintenanceFailed
      || this.state !== "working"
    ) return false;
    return this.phase !== "finalizing"
      && this.phase !== "waiting_parent_ack"
      && this.phase !== "maintenance_failed"
      && this.phase !== "delivery_uncertain";
  }

  private finalCommitBlocked(): boolean {
    return this.compactionActive
      || this.coordinationBarriers.size > 0
      || this.coordinatedSettlementWorkPending
      || this.awaitingCoordinatedContinuationStart
      || this.awaitingNativeCompactionOutcome
      || this.deliveryUncertain
      || this.maintenanceFailed
      || this.phase === "maintenance_failed"
      || this.phase === "delivery_uncertain";
  }

  private promptExecutionObserved(delivery: AgentHostDelivery): boolean {
    if (delivery.mode !== "prompt" || this.currentTask?.taskId !== delivery.task_id) return false;
    return this.taskStartEpoch > delivery.task_start_epoch
      || this.preparedFinal?.task_id === delivery.task_id;
  }

  private reconcileObservedPromptExecution(): void {
    this.awaitingPromptStart = false;
    if (this.finalCommitBlocked()) return;
    if (this.settlementObserved) {
      if (!this.interruptBarrier) this.state = "working";
      this.phase = this.preparedFinal === undefined ? "finalizing" : "waiting_parent_ack";
      return;
    }
    if (!this.interruptBarrier) this.state = "working";
    this.phase = this.toolCounts.size > 0 ? "executing_tools" : "processing";
  }

  private reconcileAcceptedSteer(delivery: AgentHostDelivery): void {
    this.awaitingPromptStart = false;
    this.settlementObserved = false;
    this.preparedFinal = undefined;
    this.replyOutboxPendingCount = 0;
    if (this.deliveryUncertainTaskId === delivery.task_id) {
      this.deliveryUncertain = false;
      this.deliveryUncertainTaskId = undefined;
      this.uncertainDelivery = undefined;
    }
    const task = this.currentTask;
    if (task?.taskId === delivery.task_id) task.hostStarted = true;
    if (this.maintenanceFailed) {
      this.applySuspendedBarrier();
      return;
    }
    if (!this.interruptBarrier) this.state = "working";
    this.phase = this.compactionActive
      ? "compacting"
      : this.toolCounts.size > 0 ? "executing_tools" : "processing";
  }

  private hostQueueObservedSince(delivery: AgentHostDelivery): boolean {
    return this.hostQueueEpoch > delivery.host_queue_epoch;
  }

  private reconcileCoordinatedSettlementWork(): void {
    if (
      !this.coordinatedSettlementWorkPending
      || this.coordinationBarriers.size > 0
      || !this.coordinatedCompactionResolved
      || this.compactionActive
      || this.awaitingCoordinatedContinuationStart
      || this.awaitingNativeCompactionOutcome
      || this.deliveryUncertain
      || this.maintenanceFailed
    ) return;
    this.coordinatedSettlementWorkPending = false;
    this.coordinatedCompactionResolved = false;
    this.coordinatedPhysicalLifecycleObserved = false;
    this.coordinatedContinuationStarted = false;
    if (!this.interruptBarrier) this.state = "working";
    this.phase = "reconciling";
  }

  private clearCoordinatedSettlementWork(): void {
    this.coordinatedSettlementWorkPending = false;
    this.coordinatedCompactionResolved = false;
    this.coordinatedPhysicalLifecycleObserved = false;
    this.coordinatedContinuationStarted = false;
    this.awaitingCoordinatedContinuationStart = false;
  }

  private hasCurrentTaskMailboxWork(): boolean {
    const taskId = this.currentTask?.taskId;
    return taskId !== undefined && this.mailbox.some((entry) => entry.taskId === taskId);
  }

  private markDeliveryUncertain(
    taskId?: string,
    delivery: AgentHostDelivery | undefined = this.inFlight,
  ): void {
    this.awaitingPromptStart = false;
    this.deliveryUncertain = true;
    this.deliveryUncertainTaskId = taskId ?? this.currentTask?.taskId;
    this.uncertainDelivery = delivery?.mode === "steer" ? delivery : undefined;
    this.applySuspendedBarrier();
  }

  private applySuspendedBarrier(): void {
    this.state = "suspended";
    this.phase = this.deliveryUncertain ? "delivery_uncertain" : "maintenance_failed";
  }

  private rememberStaleFinalTurn(turnId: string): void {
    this.staleFinalTurns.add(turnId);
    while (this.staleFinalTurns.size > 32) {
      const oldest = this.staleFinalTurns.values().next().value;
      if (oldest === undefined) return;
      this.staleFinalTurns.delete(oldest);
    }
  }

  private promoteSuccessorIfPossible(): void {
    if (this.currentTask !== undefined) return;
    const taskId = this.successorTaskId ?? this.mailbox[0]?.taskId;
    if (taskId === undefined) return;
    this.successorTaskId = undefined;
    this.currentTask = { taskId, hostStarted: false, origin: "assigned" };
  }

  private claimDelivery(deliveryId: number): AgentHostDelivery | undefined {
    if (this.inFlight?.delivery_id !== deliveryId) return undefined;
    const delivery = this.inFlight;
    this.inFlight = undefined;
    return delivery;
  }

  private removeMailboxEntry(messageId: string): void {
    const index = this.mailbox.findIndex((entry) => entry.messageId === messageId);
    if (index >= 0) this.mailbox.splice(index, 1);
  }

  private allocateTaskId(): string {
    return this.allocateOpaqueId(this.taskIdFactory, this.issuedTaskIds, true);
  }

  private allocateOpaqueId(
    factory: () => string,
    issued: Set<string>,
    requireUuid: boolean,
  ): string {
    for (let attempt = 0; attempt < MAX_ID_GENERATION_ATTEMPTS; attempt += 1) {
      let candidate: unknown;
      try {
        candidate = factory();
      } catch {
        continue;
      }
      if (typeof candidate !== "string" || candidate.length === 0 || issued.has(candidate)) continue;
      if (requireUuid && !isCanonicalUuidV4Text(candidate)) continue;
      issued.add(candidate);
      return candidate;
    }
    throw new Error("task_identity_exhausted");
  }
}

function validCoordinationTransactionId(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}
