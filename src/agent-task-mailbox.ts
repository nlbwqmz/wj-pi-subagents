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
}

export type AgentCompactionReason = "threshold" | "overflow";

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
  private replyOutboxPendingCount = 0;
  private interruptBarrier = false;
  private settlementObserved = false;
  private compactionActive = false;
  private awaitingNativeCompactionOutcome = false;
  private awaitingRetryStart = false;
  private awaitingPromptStart = false;
  private deliveryUncertain = false;
  private maintenanceFailed = false;
  private readonly staleFinalTurns = new Set<string>();
  private startEpoch = 0;
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
    const startsSinceDelivery = this.startEpoch - delivery.start_epoch;
    if (
      !taskMatches
      || startsSinceDelivery < 0
      || (delivery.mode === "steer" && (
        startsSinceDelivery !== 0
        || !task.hostStarted
        || this.settlementObserved
      ))
      || (delivery.mode === "prompt" && (
        startsSinceDelivery > 1
        || this.settlementObserved
      ))
    ) {
      this.markDeliveryUncertain();
      return true;
    }
    if (delivery.mode === "prompt") {
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

  /** RpcClient rejection 不能证明宿主未接纳；保留为可对账的 suspended 事实。 */
  hostDeliveryUncertain(deliveryId: number): boolean {
    const delivery = this.claimDelivery(deliveryId);
    if (delivery === undefined) return false;
    this.removeMailboxEntry(delivery.message_id);
    this.markDeliveryUncertain();
    return true;
  }

  /** child 监督事实把实际轮次身份与父端占位任务对齐。 */
  observeTaskStarted(taskId: string, turnId: string): boolean {
    if (!isCanonicalUuidV4Text(taskId) || !isCanonicalUuidV4Text(turnId)) return false;
    const current = this.currentTask;
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
    this.compactionActive = false;
    this.awaitingNativeCompactionOutcome = false;
    this.awaitingRetryStart = false;
    this.awaitingPromptStart = false;
    this.settlementObserved = false;
    this.preparedFinal = undefined;
    this.replyOutboxPendingCount = 0;
    if (this.deliveryUncertain || this.maintenanceFailed) {
      this.applySuspendedBarrier();
      return;
    }
    if (!this.interruptBarrier) this.state = "working";
    this.phase = this.toolCounts.size > 0 ? "executing_tools" : "processing";
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

  /** 子代理只接受 Pi 原生阈值或溢出压缩；逻辑任务身份保持不变。 */
  observeCompactionStart(_reason: AgentCompactionReason): void {
    if (this.compactionActive) return;
    this.compactionActive = true;
    this.awaitingNativeCompactionOutcome = false;
    this.awaitingRetryStart = false;
    this.awaitingPromptStart = false;
    if (this.deliveryUncertain || this.maintenanceFailed) {
      this.applySuspendedBarrier();
    } else {
      this.state = "working";
      this.phase = "compacting";
    }
  }

  /** 原生压缩结束后等待真实 agent_start 或 agent_settled 决定后续投递方式。 */
  observeCompactionEnd(_reason: AgentCompactionReason, failed: boolean, willRetry = false): void {
    this.compactionActive = false;
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
    if (this.currentTask === undefined) {
      this.state = "idle";
      this.phase = undefined;
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
    this.hostPendingCount = pendingMessageCount;
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
    this.deliveryUncertain = false;
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
    if (!this.interruptBarrier && !this.settlementObserved) return current.taskId;
    this.successorTaskId ??= this.allocateTaskId();
    return this.successorTaskId;
  }

  private deliveryAllowed(): boolean {
    if (
      this.interruptBarrier
      || this.compactionActive
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
      || this.awaitingNativeCompactionOutcome
      || this.deliveryUncertain
      || this.maintenanceFailed
      || this.phase === "maintenance_failed"
      || this.phase === "delivery_uncertain";
  }

  private markDeliveryUncertain(): void {
    this.awaitingPromptStart = false;
    this.deliveryUncertain = true;
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
