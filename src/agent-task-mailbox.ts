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
  /** child task/turn 协调模式；不用于猜测 Pi 的瞬时 active 状态。 */
  readonly mode: "prompt" | "steer";
  /** 物理宿主提交方式；同一已启动任务始终由 Pi 原子判断 active/idle。 */
  readonly host_submission: "strict_prompt" | "adaptive_steer";
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
  /** 单调任务事实；同一 task final commit 前绝不恢复为 false。 */
  hasStarted: boolean;
  readonly origin: "assigned" | "automatic";
}

type PreparedFinalDeliveryState = "prepared" | "delivering" | "accepted";

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
  private preparedFinalDeliveryState: PreparedFinalDeliveryState | undefined;
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
  private awaitingCoordinatedContinuationTransactionId: string | undefined;
  private coordinatedTrailingSettlement: {
    readonly transactionId: string;
    readonly startEpoch: number;
  } | undefined;
  private awaitingNativeCompactionOutcome = false;
  private awaitingRetryStart = false;
  private awaitingPromptStart = false;
  private awaitingCompactionPromptRetry = false;
  private awaitingHostIdlePromptRetry = false;
  private deliveryUncertain = false;
  private deliveryUncertainTaskId: string | undefined;
  private uncertainDelivery: AgentHostDelivery | undefined;
  private acceptedAdaptiveDelivery: AgentHostDelivery | undefined;
  private readonly staleFinalTurns = new Set<string>();
  private readonly unsettledStartEpochs: number[] = [];
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
      this.clearPreparedFinal();
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
      host_submission: task.hostStarted || task.hasStarted
        ? "adaptive_steer" as const
        : "strict_prompt" as const,
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
    if (
      delivery.mode === "steer"
      || (
        delivery.host_submission === "adaptive_steer"
        && this.hostQueueObservedSince(delivery)
      )
    ) {
      // adaptive steer 的 queue_update 可能先于 RPC 尾部到达；即使 child
      // assignment 为 prompt，这仍是正文已进入当前 host run 的强事实。
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

  /** 未分类明确拒绝证明正文未入 Pi，但不提供安全自动重试条件。 */
  hostRejected(deliveryId: number): boolean {
    const delivery = this.claimDelivery(deliveryId);
    if (delivery === undefined) return false;
    this.markDeliveryUncertain(delivery.task_id);
    // 返回值只表示是否应把原命令重新排队；未知拒绝必须等待外部裁决。
    return false;
  }

  /**
   * 压缩期明确拒绝证明正文未进入 Pi。保留同一 mailbox 条目，物理压缩
   * 结束前冻结重试；重试时仍由 host_submission 保持任务身份边界。
   */
  hostRejectedForCompaction(deliveryId: number, hostCompacting: boolean): boolean {
    const delivery = this.claimDelivery(deliveryId);
    if (delivery === undefined) return false;
    const task = this.currentTask;
    if (task?.taskId !== delivery.task_id) {
      this.markDeliveryUncertain(delivery.task_id);
      return false;
    }
    this.awaitingPromptStart = false;
    this.awaitingCompactionPromptRetry = hostCompacting || this.compactionActive;
    if (!this.interruptBarrier) this.state = "working";
    this.phase = this.awaitingCompactionPromptRetry ? "compacting" : "reconciling";
    return true;
  }

  /** strict prompt 的 busy 拒绝等待真实 idle；adaptive steer 不允许走此恢复路径。 */
  hostRejectedForBusy(deliveryId: number, hostStreaming: boolean): boolean {
    const delivery = this.claimDelivery(deliveryId);
    if (delivery === undefined) return false;
    const task = this.currentTask;
    if (
      delivery.host_submission !== "strict_prompt"
      || task?.taskId !== delivery.task_id
    ) {
      this.markDeliveryUncertain(delivery.task_id);
      return false;
    }
    this.awaitingPromptStart = false;
    // settled 可能先于拒绝响应到达；该事实同样允许立即重试。
    this.awaitingHostIdlePromptRetry = hostStreaming && !this.settlementObserved;
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
    if (
      delivery.host_submission === "adaptive_steer"
      && this.hostQueueObservedSince(delivery)
    ) {
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
        hasStarted: true,
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
      current.hasStarted = true;
    } else {
      if (current.turnId !== undefined && current.turnId !== turnId) {
        this.rememberStaleFinalTurn(current.turnId);
        this.clearPreparedFinal();
        this.replyOutboxPendingCount = 0;
      }
      current.turnId = turnId;
      current.hostStarted = true;
      current.hasStarted = true;
    }
    if (
      !this.settlementObserved
      && !this.compactionActive
      && !this.deliveryUncertain
    ) {
      if (!this.interruptBarrier) this.state = "working";
      this.phase = this.toolCounts.size > 0 ? "executing_tools" : "processing";
    }
    this.awaitingCompactionPromptRetry = false;
    this.awaitingHostIdlePromptRetry = false;
    if (this.confirmedTaskStartKey !== taskStartKey) {
      this.confirmedTaskStartKey = taskStartKey;
      this.taskStartEpoch += 1;
    }
    return true;
  }

  observeAgentStart(): void {
    this.startEpoch += 1;
    this.unsettledStartEpochs.push(this.startEpoch);
    if (
      this.acceptedAdaptiveDelivery !== undefined
      && this.startEpoch > this.acceptedAdaptiveDelivery.start_epoch
    ) this.acceptedAdaptiveDelivery = undefined;
    if (this.currentTask === undefined) {
      this.currentTask = {
        taskId: this.allocateTaskId(),
        hostStarted: true,
        hasStarted: true,
        origin: "automatic",
      };
    } else {
      this.currentTask.hostStarted = true;
      this.currentTask.hasStarted = true;
    }
    const coordinatedContinuation = this.awaitingCoordinatedContinuationTransactionId !== undefined
      || (
        this.coordinatedSettlementWorkPending
        && this.coordinatedPhysicalLifecycleObserved
        && this.coordinatedCompactionResolved
      );
    if (coordinatedContinuation) {
      this.coordinatedContinuationStarted = true;
      this.awaitingCoordinatedContinuationTransactionId = undefined;
    }
    this.compactionActive = false;
    this.awaitingNativeCompactionOutcome = false;
    this.awaitingRetryStart = false;
    this.awaitingPromptStart = false;
    this.awaitingCompactionPromptRetry = false;
    this.settlementObserved = false;
    if (!coordinatedContinuation && this.coordinationBarriers.size === 0) {
      this.clearCoordinatedSettlementWork();
    }
    this.clearPreparedFinal();
    this.replyOutboxPendingCount = 0;
    if (this.deliveryUncertain) {
      this.applySuspendedBarrier();
      return;
    }
    if (!this.interruptBarrier) this.state = "working";
    this.phase = coordinatedContinuation && !this.coordinatedCompactionResolved
      ? "reconciling"
      : this.toolCounts.size > 0 ? "executing_tools" : "processing";
    this.reconcileCoordinatedSettlementWork();
  }

  /** 新 run 先于旧 settled 出现时，只消费最旧 run 的尾随事实。 */
  classifyAgentSettled():
    | "current"
    | "superseded_coordinated_continuation"
    | "superseded_active_run" {
    if (this.unsettledStartEpochs.length > 1) {
      this.unsettledStartEpochs.shift();
      const coordinated = this.coordinatedTrailingSettlement;
      if (coordinated !== undefined && this.startEpoch > coordinated.startEpoch) {
        this.coordinatedTrailingSettlement = undefined;
        return "superseded_coordinated_continuation";
      }
      return "superseded_active_run";
    }
    const trailing = this.coordinatedTrailingSettlement;
    if (trailing === undefined) return "current";
    this.coordinatedTrailingSettlement = undefined;
    return this.startEpoch > trailing.startEpoch
      ? "superseded_coordinated_continuation"
      : "current";
  }

  /** raw settled 只形成 candidate；没有 final commit 时绝不进入 idle。 */
  observeAgentSettled(): "candidate" | "superseded" {
    if (this.unsettledStartEpochs.length > 0) this.unsettledStartEpochs.shift();
    this.awaitingCompactionPromptRetry = false;
    this.awaitingHostIdlePromptRetry = false;
    if (this.awaitingRetryStart) {
      this.settlementObserved = false;
      this.clearPreparedFinal();
      this.replyOutboxPendingCount = 0;
      if (this.deliveryUncertain) this.applySuspendedBarrier();
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
      this.clearPreparedFinal();
      this.replyOutboxPendingCount = 0;
      this.markDeliveryUncertain();
      return "superseded";
    }
    if (this.deliveryUncertain) {
      this.applySuspendedBarrier();
      return "superseded";
    }
    if (this.currentTask === undefined) {
      this.currentTask = {
        taskId: this.allocateTaskId(),
        hostStarted: false,
        hasStarted: true,
        origin: "automatic",
      };
    }
    this.currentTask.hostStarted = false;
    const acceptedAdaptive = this.acceptedAdaptiveDelivery;
    if (
      acceptedAdaptive?.task_id === this.currentTask.taskId
      && this.hostPendingCount > 0
      && this.hostQueueObservedSince(acceptedAdaptive)
    ) {
      // adaptive preflight 已确认正文入队，但命令可能落在 Pi 最后一次 queue poll
      // 与 settled 之间。保留宿主 pending 事实，不能降级为未知交付。
      this.settlementObserved = false;
      this.clearPreparedFinal();
      this.replyOutboxPendingCount = 0;
      if (!this.interruptBarrier) this.state = "working";
      this.phase = "reconciling";
      return "superseded";
    }
    if (
      acceptedAdaptive?.task_id === this.currentTask.taskId
      && !this.hostQueueObservedSince(acceptedAdaptive)
      && this.startEpoch <= acceptedAdaptive.start_epoch
    ) {
      // Pi 已在 idle 分支接纳新 prompt，但旧 run 的 settled 先于新 start
      // 离开扩展 handler；等待对应 start，不能提交旧 final。
      this.settlementObserved = false;
      this.clearPreparedFinal();
      this.replyOutboxPendingCount = 0;
      if (!this.interruptBarrier) this.state = "working";
      this.phase = "reconciling";
      return "superseded";
    }
    this.acceptedAdaptiveDelivery = undefined;
    if (this.hostPendingCount > 0) {
      this.settlementObserved = false;
      this.clearPreparedFinal();
      this.replyOutboxPendingCount = 0;
      if (
        this.inFlight?.host_submission === "adaptive_steer"
        && this.hostQueueObservedSince(this.inFlight)
      ) {
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
      this.awaitingCoordinatedContinuationTransactionId = undefined;
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
      const expectsContinuation = outcome === "succeeded" && continuationExpected;
      this.awaitingCoordinatedContinuationTransactionId = expectsContinuation
        && !this.coordinatedContinuationStarted
        ? transactionId
        : undefined;
      if (expectsContinuation && this.coordinatedTrailingSettlement === undefined) {
        // continuation 可在旧 agent_settled handler 返回前启动；保存旧 run 的
        // start epoch，让随后转发的 settled 无法覆盖新 run。
        this.coordinatedTrailingSettlement = Object.freeze({
          transactionId,
          startEpoch: this.startEpoch,
        });
      }
    }
    this.reconcileCoordinatedSettlementWork();
    return true;
  }

  /** succeeded 后 continuation 明确 not_started，只允许同事务撤销等待。 */
  compensateCoordinationContinuation(transactionId: string): boolean {
    if (
      !validCoordinationTransactionId(transactionId)
      || this.awaitingCoordinatedContinuationTransactionId !== transactionId
    ) return false;
    this.awaitingCoordinatedContinuationTransactionId = undefined;
    if (this.coordinatedTrailingSettlement?.transactionId === transactionId) {
      this.coordinatedTrailingSettlement = undefined;
    }
    this.coordinatedCompactionResolved = true;
    this.reconcileCoordinatedSettlementWork();
    return true;
  }

  /**
   * prepare 只等待旧 RPC 交付和 Pi 队列；prompt 预检已成功但尚未收到
   * task_started 时，子端可能正等待本 prepare 响应才能进入真实启动。
   * 把该空档继续视为等待会形成自我依赖的压缩死锁。
   */
  coordinationBarrierReadiness(): CoordinationBarrierReadiness {
    if (this.deliveryUncertain) return "unsafe";
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
    if (this.deliveryUncertain) {
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
    this.awaitingCompactionPromptRetry = false;
    if (coordinated) {
      this.coordinatedPhysicalLifecycleObserved = true;
      if (this.coordinatedSettlementWorkPending) this.coordinatedCompactionResolved = true;
    }
    this.awaitingRetryStart = !failed && willRetry;
    // compaction_end 的失败是已知业务结果：Pi 已退出压缩，原上下文仍可结算。
    // 只有 willRetry 会作废旧轮候选；失败本身不得升级为永久维护隔离。
    if (willRetry) {
      this.settlementObserved = false;
      this.clearPreparedFinal();
      this.replyOutboxPendingCount = 0;
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
      if (this.deliveryUncertain) {
        this.applySuspendedBarrier();
        return;
      }
      if (!this.interruptBarrier) this.state = "working";
      this.phase = !this.settlementObserved && this.preparedFinal === undefined
        ? "reconciling"
        : this.preparedFinal === undefined ? "finalizing" : "waiting_parent_ack";
      this.reconcileCoordinatedSettlementWork();
      return;
    }
    this.awaitingNativeCompactionOutcome = true;
    if (this.deliveryUncertain) {
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
      && uncertain?.host_submission === "adaptive_steer"
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
        hasStarted: true,
        origin: "automatic",
      };
    } else if (current.taskId !== final.task_id) {
      if (current.origin !== "automatic" || this.mailbox.some((entry) => entry.taskId === current.taskId)) {
        return false;
      }
      current.taskId = final.task_id;
      current.turnId = final.turn_id;
      current.hasStarted = true;
    } else if (current.turnId !== undefined && current.turnId !== final.turn_id) {
      return false;
    } else {
      current.turnId = final.turn_id;
      current.hasStarted = true;
    }
    this.preparedFinal = final;
    this.preparedFinalDeliveryState = "prepared";
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

  /** 在 final 注入回调前固定重入路由；已接纳重试只需继续本地 commit。 */
  beginPreparedFinalDelivery(commitId: string): "deliver" | "commit" | undefined {
    if (this.preparedFinal?.commit_id !== commitId) return undefined;
    if (this.preparedFinalDeliveryState === "accepted") return "commit";
    if (this.preparedFinalDeliveryState !== "prepared" || !this.canCommitPreparedFinal()) return undefined;
    this.preparedFinalDeliveryState = "delivering";
    return "deliver";
  }

  completePreparedFinalDelivery(commitId: string, accepted: boolean): boolean {
    if (
      this.preparedFinal?.commit_id !== commitId
      || this.preparedFinalDeliveryState !== "delivering"
    ) return false;
    this.preparedFinalDeliveryState = accepted ? "accepted" : "prepared";
    return true;
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
    this.clearPreparedFinal();
    this.currentTask = undefined;
    this.settlementObserved = false;
    this.interruptBarrier = false;
    this.compactionActive = false;
    this.awaitingNativeCompactionOutcome = false;
    this.awaitingRetryStart = false;
    this.awaitingPromptStart = false;
    this.awaitingCompactionPromptRetry = false;
    this.awaitingHostIdlePromptRetry = false;
    this.clearCoordinatedSettlementWork();
    this.deliveryUncertain = false;
    this.deliveryUncertainTaskId = undefined;
    this.uncertainDelivery = undefined;
    this.acceptedAdaptiveDelivery = undefined;
    this.unsettledStartEpochs.length = 0;
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
   * Pi 的公共 abort 不会取消正在执行的自动压缩；压缩期间拒绝普通中断，
   * 由调用方在 compaction_end 后重新发起请求。
   */
  isCompactionActive(): boolean {
    return this.compactionActive || this.awaitingCompactionPromptRetry;
  }

  hasUncertainDelivery(): boolean {
    return this.deliveryUncertain;
  }

  /** 普通 compaction_end 不再产生永久维护隔离；保留查询接口兼容旧调用方。 */
  hasMaintenanceFailure(): boolean {
    return false;
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
      this.currentTask = {
        taskId,
        hostStarted: false,
        hasStarted: false,
        origin: "assigned",
      };
      return taskId;
    }
    if (this.successorTaskId !== undefined) return this.successorTaskId;
    if (!this.interruptBarrier && !this.settlementObserved) {
      if (this.coordinationBarriers.size > 0) {
        this.coordinatedSettlementWorkPending = true;
        this.phase = this.compactionActive ? "compacting" : "reconciling";
      }
      return current.taskId;
    }
    if (
      !this.interruptBarrier
      && this.settlementObserved
      && this.preparedFinalDeliveryState !== "delivering"
      && this.preparedFinalDeliveryState !== "accepted"
      && !this.finalCommitBlocked()
    ) {
      // raw settled 和未获父端接纳的 final 都仍可由当前逻辑任务撤销；
      // 提前分配 successor 会让后续 continuation 无法取得该 mailbox 项。
      this.replyOutboxPendingCount = 0;
      this.phase = "reconciling";
      return current.taskId;
    }
    if (
      !this.interruptBarrier
      && (
        this.coordinationBarriers.size > 0
        || this.awaitingCoordinatedContinuationTransactionId !== undefined
      )
    ) {
      // 协调压缩中的 raw settlement 不是逻辑任务终点；保持已返回 task_id
      // 稳定，并等待压缩结束或真实 continuation start 后再投递。
      this.coordinatedSettlementWorkPending = true;
      if (
        this.awaitingCoordinatedContinuationTransactionId !== undefined
        && this.coordinatedPhysicalLifecycleObserved
        && !this.compactionActive
      ) this.coordinatedCompactionResolved = true;
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
      || this.awaitingCoordinatedContinuationTransactionId !== undefined
      || this.awaitingNativeCompactionOutcome
      || this.awaitingPromptStart
      || this.awaitingCompactionPromptRetry
      || this.awaitingHostIdlePromptRetry
      || this.deliveryUncertain
      || this.state !== "working"
    ) return false;
    return this.phase !== "finalizing"
      && this.phase !== "waiting_parent_ack"
      && this.phase !== "delivery_uncertain";
  }

  private finalCommitBlocked(): boolean {
    return this.compactionActive
      || this.coordinationBarriers.size > 0
      || this.coordinatedSettlementWorkPending
      || this.awaitingCoordinatedContinuationTransactionId !== undefined
      || this.awaitingNativeCompactionOutcome
      || this.awaitingCompactionPromptRetry
      || this.awaitingHostIdlePromptRetry
      || this.deliveryUncertain
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
    this.acceptedAdaptiveDelivery = this.startEpoch <= delivery.start_epoch
      ? delivery
      : undefined;
    this.settlementObserved = false;
    this.clearPreparedFinal();
    this.replyOutboxPendingCount = 0;
    if (this.deliveryUncertainTaskId === delivery.task_id) {
      this.deliveryUncertain = false;
      this.deliveryUncertainTaskId = undefined;
      this.uncertainDelivery = undefined;
    }
    const task = this.currentTask;
    if (task?.taskId === delivery.task_id) task.hostStarted = true;
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
      || this.awaitingCoordinatedContinuationTransactionId !== undefined
      || this.awaitingNativeCompactionOutcome
      || this.awaitingCompactionPromptRetry
      || this.deliveryUncertain
    ) return;
    this.coordinatedSettlementWorkPending = false;
    this.coordinatedCompactionResolved = false;
    this.coordinatedPhysicalLifecycleObserved = false;
    this.coordinatedContinuationStarted = false;
    if (!this.interruptBarrier) this.state = "working";
    this.phase = "reconciling";
  }

  private clearPreparedFinal(): void {
    this.preparedFinal = undefined;
    this.preparedFinalDeliveryState = undefined;
  }

  private clearCoordinatedSettlementWork(): void {
    this.coordinatedSettlementWorkPending = false;
    this.coordinatedCompactionResolved = false;
    this.coordinatedPhysicalLifecycleObserved = false;
    this.coordinatedContinuationStarted = false;
    this.awaitingCoordinatedContinuationTransactionId = undefined;
    this.coordinatedTrailingSettlement = undefined;
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
    this.uncertainDelivery = delivery?.host_submission === "adaptive_steer"
      ? delivery
      : undefined;
    this.applySuspendedBarrier();
  }

  private applySuspendedBarrier(): void {
    this.state = "suspended";
    this.phase = "delivery_uncertain";
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
    this.currentTask = {
      taskId,
      hostStarted: false,
      hasStarted: false,
      origin: "assigned",
    };
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
