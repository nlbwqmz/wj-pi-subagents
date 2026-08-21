import { randomUUID } from "node:crypto";
import {
  CHILD_REPLY_SCHEMA,
  CHILD_REPLY_VERSION,
  parseChildReplyEnvelope,
  type ChildFinalEnvelope,
  type ChildFinalReasonCode,
  type ChildReplyEnvelope,
} from "./child-reply-envelope.ts";
import { REPLY_MAX_TEXT_BYTES } from "./child-reply-limits.ts";
import { normalizeAssistantMessageEnd } from "./rpc-bridge-event.ts";
import type {
  SupervisorCompactionOutcome,
  SupervisorReplyPublication,
  SupervisorTaskAssignment,
  SupervisorTaskStarted,
} from "./supervisor-channel.ts";
import { controlFailure, isCanonicalUuid, isCanonicalUuidV4, type ControlResult } from "./tree-controller.ts";

export interface ReplyToParentInput {
  readonly message: string;
}

export interface ReplyToParentData {
  readonly accepted: true;
}

export interface FinalCandidate {
  readonly text: string;
  readonly stopReason: "stop" | "length";
}

export type ChildCompactionReason = "manual" | "threshold" | "overflow";

export interface ChildReplyPort {
  /** 写入本地监督 outbox 后返回；不等待父端 reply ACK。 */
  publishReply?(
    reply: ChildReplyEnvelope,
  ): Promise<void>;
  /** 写入 final 帧后立即返回；父端 ACK 通过 publication 异步通知。 */
  publishReplyWithAck?(
    reply: ChildReplyEnvelope,
  ): Promise<SupervisorReplyPublication>;
  /** 显式等待父端接纳；仅兼容旧适配器，不用于 wirePublicationTail。 */
  publishReplyAndWaitForAck(
    reply: ChildReplyEnvelope,
    signal?: AbortSignal,
  ): Promise<void>;
  publishTaskStarted?(started: SupervisorTaskStarted): Promise<void>;
}

export interface ChildReplyCoordinatorOptions {
  readonly agentId: string;
  readonly port: ChildReplyPort;
  readonly turnIdFactory?: () => string;
  readonly taskIdFactory?: () => string;
  readonly commitIdFactory?: () => string;
  readonly scheduleQuarantine?: (operation: () => void) => void;
  /** parent 已同步接纳 final 后释放本轮 child reply trigger 栅栏。 */
  readonly onFinalAccepted?: () => void;
  readonly onFinalFailure?: () => void;
}

type Publication<T> = () => Promise<T>;
type RunFinalState = "normal" | "failed" | "interrupted";

const MAX_ID_GENERATION_ATTEMPTS = 32;

/**
 * child 侧任务、turn 和 final 协调器。
 *
 * Pi 的 assistant `message_end` 是正文唯一来源；只有在对应 loop 的
 * `agent_settled` 之后，正文才会进入 final outbox。工作中回复只等待本地
 * outbox 写入；final 的父端接纳和 reply ACK 仍由监督通道完成，当前回调不等待
 * 第三方扩展的任何续跑。
 */
export class ChildReplyCoordinator {
  private readonly agentId: string;
  private readonly port: ChildReplyPort;
  private readonly turnIdFactory: () => string;
  private readonly taskIdFactory: () => string;
  private readonly commitIdFactory: () => string;
  private readonly scheduleQuarantine: (operation: () => void) => void;
  private readonly issuedIds = new Set<string>();
  private readonly onFinalAccepted: (() => void) | undefined;
  private readonly onFinalFailure: (() => void) | undefined;
  private readonly coordinationBarriers = new Set<string>();
  private wirePublicationTail: Promise<void> = Promise.resolve();
  private candidate: FinalCandidate | undefined;
  private finalState: RunFinalState = "normal";
  private failureReason: Exclude<ChildFinalReasonCode, "no_output" | "reply_too_large"> | undefined;
  private absentReason: Extract<ChildFinalReasonCode, "reply_too_large"> | undefined;
  private currentTaskId: string | undefined;
  private currentTurnId: string | undefined;
  private pendingSettledTurnId: string | undefined;
  private pendingPromptTaskId: string | undefined;
  private runActive = false;
  private compactionActive = false;
  private awaitingRetryStart = false;
  private settlementEpoch = 0;
  private finalSubmitted = false;
  private terminalFailure = false;
  private finalFailureNotified = false;
  private awaitingCoordinatedContinuationTransactionId: string | undefined;

  constructor(options: ChildReplyCoordinatorOptions) {
    if (!isCanonicalUuid(options.agentId)) throw new TypeError("invalid_child_agent_id");
    this.agentId = options.agentId;
    this.port = options.port;
    this.turnIdFactory = options.turnIdFactory ?? randomUUID;
    this.taskIdFactory = options.taskIdFactory ?? randomUUID;
    this.commitIdFactory = options.commitIdFactory ?? randomUUID;
    this.scheduleQuarantine = options.scheduleQuarantine ?? ((operation) => setImmediate(operation));
    this.onFinalAccepted = options.onFinalAccepted;
    this.onFinalFailure = options.onFinalFailure;
  }

  /** 协调令牌可叠加；但成功压缩等待 successor turn 时，同一会话不能再次开始物理压缩。 */
  beginCoordinationBarrier(transactionId: string): boolean {
    if (
      this.terminalFailure
      || !validCompactionTransactionId(transactionId)
      || this.awaitingCoordinatedContinuationTransactionId !== undefined
    ) return false;
    this.coordinationBarriers.add(transactionId);
    this.settlementEpoch += 1;
    return true;
  }

  /** 释放匹配协调屏障；成功压缩的中断轮等待 continuation 建立新 turn。 */
  completeCoordinationBarrier(transactionId: string, outcome: SupervisorCompactionOutcome): boolean {
    if (!this.coordinationBarriers.delete(transactionId)) {
      if (
        outcome !== "not_started"
        || this.awaitingCoordinatedContinuationTransactionId !== transactionId
      ) return false;
      // 其他固定参与者 complete 失败时，同事务补偿必须撤销 continuation 等待。
      this.awaitingCoordinatedContinuationTransactionId = undefined;
      this.settlementEpoch += 1;
      if (!this.runActive && !this.finalSubmitted) this.scheduleFinalSubmission();
      return true;
    }
    this.settlementEpoch += 1;
    if (this.coordinationBarriers.size !== 0 || this.finalSubmitted) return true;
    if (outcome === "succeeded" && this.finalState === "interrupted") {
      // complete 可能先于本扩展的 agent_settled handler；状态必须跨该顺序保存。
      this.awaitingCoordinatedContinuationTransactionId = transactionId;
      return true;
    }
    if (this.runActive) return true;
    this.scheduleFinalSubmission();
    return true;
  }

  hasCoordinationBarrier(): boolean {
    return this.coordinationBarriers.size > 0;
  }

  expectsCoordinationContinuation(
    transactionId: string,
    outcome: SupervisorCompactionOutcome,
  ): boolean {
    return outcome === "succeeded"
      && this.coordinationBarriers.has(transactionId)
      && this.finalState === "interrupted";
  }

  awaitsCoordinationContinuation(transactionId: string): boolean {
    return this.awaitingCoordinatedContinuationTransactionId === transactionId;
  }

  /** 监督租约先于 prompt/steer 到达；正文和任务标识始终分离。 */
  observeTaskAssignment(assignment: SupervisorTaskAssignment): void {
    if (this.terminalFailure) return;
    if (assignment.mode === "steer" && this.currentTaskId === assignment.task_id) return;
    if (assignment.mode === "prompt" && assignment.task_id !== this.currentTaskId) {
      // 新任务租约意味着旧任务不能再发布 delayed final。
      this.compactionActive = false;
      this.awaitingRetryStart = false;
      this.finalSubmitted = false;
      this.candidate = undefined;
      this.absentReason = undefined;
    }
    this.pendingPromptTaskId = assignment.task_id;
    this.settlementEpoch += 1;
  }

  /** 新 Pi loop：没有新的父端 task_assignment 时沿用当前逻辑任务，只递增 turn_id。 */
  observeAgentStart(): void {
    if (this.terminalFailure) throw new Error("child_reply_coordinator_failed");
    const taskId = this.pendingPromptTaskId
      ?? this.currentTaskId
      ?? this.allocateId(this.taskIdFactory);
    const turnId = this.allocateId(this.turnIdFactory);
    if (taskId === undefined || turnId === undefined) {
      this.terminalFailure = true;
      this.currentTaskId = undefined;
      this.currentTurnId = undefined;
      this.runActive = false;
      this.notifyFinalFailure();
      throw new TypeError("invalid_child_task_identity");
    }
    this.pendingPromptTaskId = undefined;
    this.currentTaskId = taskId;
    this.currentTurnId = turnId;
    this.runActive = true;
    this.compactionActive = false;
    this.awaitingRetryStart = false;
    this.awaitingCoordinatedContinuationTransactionId = undefined;
    this.finalSubmitted = false;
    this.candidate = undefined;
    this.finalState = "normal";
    this.failureReason = undefined;
    this.absentReason = undefined;
    this.settlementEpoch += 1;
    const publishTaskStarted = this.port.publishTaskStarted;
    if (publishTaskStarted !== undefined) {
      const started = Object.freeze({ task_id: taskId, turn_id: turnId });
      void this.enqueue(() => publishTaskStarted.call(this.port, started)).catch(() => this.failFinal());
    }
  }

  /** agent_end 先记录本次 Pi loop；迟到的 settled handler 不能结算后继 turn。 */
  observeAgentEnd(): void {
    if (!this.runActive || this.currentTurnId === undefined) return;
    this.pendingSettledTurnId = this.currentTurnId;
  }

  /** 从 Pi 扩展事件取得真正 assistant message_end；custom/tool/user 消息会被忽略。 */
  observeAssistantMessageEnd(event: unknown): void {
    if (!this.runActive || this.finalSubmitted || this.currentTurnId === undefined) return;
    const parsed = normalizeAssistantMessageEnd(event);
    if (parsed.kind === "ignored") return;
    const raw = isRecord(event) && isRecord(event.message) ? event.message : undefined;
    const stopReason = raw?.stopReason;
    if (parsed.kind === "invalid") {
      this.finalState = "failed";
      this.failureReason = "runtime_fault";
      this.absentReason = undefined;
      return;
    }
    if (stopReason === "error") {
      this.finalState = "failed";
      this.failureReason = "provider_error";
      this.absentReason = undefined;
      return;
    }
    if (stopReason === "aborted") {
      this.finalState = "interrupted";
      this.failureReason = undefined;
      this.absentReason = undefined;
      return;
    }
    this.finalState = "normal";
    this.failureReason = undefined;
    if (stopReason !== "stop" && stopReason !== "length") return;
    if (Array.isArray(raw?.content) && raw.content.some((item) => isRecord(item) && item.type === "toolCall")) return;

    if (parsed.kind === "rejected") {
      this.candidate = undefined;
      this.absentReason = parsed.reason;
      return;
    }
    if (parsed.event.type !== "message_end") {
      this.finalState = "failed";
      this.failureReason = "runtime_fault";
      this.absentReason = undefined;
      return;
    }
    const text = parsed.event.message.content
      .filter((item): item is { readonly type: "text"; readonly text: string } => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    if (text.trim().length === 0) return;
    if (utf8Length(text) > REPLY_MAX_TEXT_BYTES) {
      this.candidate = undefined;
      this.absentReason = "reply_too_large";
      return;
    }
    this.candidate = Object.freeze({ text, stopReason });
    this.absentReason = undefined;
  }

  async replyToParent(
    input: ReplyToParentInput | unknown,
    signal?: AbortSignal,
  ): Promise<ControlResult<ReplyToParentData>> {
    if (!isReplyToParentInput(input)) return controlFailure("invalid_argument");
    if (utf8Length(input.message) > REPLY_MAX_TEXT_BYTES) {
      return controlFailure("reply_too_large");
    }
    const taskId = this.currentTaskId;
    const turnId = this.currentTurnId;
    if (!this.runActive || taskId === undefined || turnId === undefined) {
      return controlFailure("message_delivery_failed");
    }
    const reply = parseChildReplyEnvelope({
      schema: CHILD_REPLY_SCHEMA,
      version: CHILD_REPLY_VERSION,
      kind: "message",
      agent_id: this.agentId,
      task_id: taskId,
      turn_id: turnId,
      text: input.message,
    });
    if (reply === undefined) return controlFailure("invalid_argument");
    try {
      const publishReply = this.port.publishReply;
      if (publishReply !== undefined) {
        await this.enqueue(() => publishReply.call(this.port, reply));
      } else {
        await this.enqueue(() => this.port.publishReplyAndWaitForAck(reply, signal));
      }
    } catch {
      return controlFailure("message_delivery_failed");
    }
    return Object.freeze({ ok: true, data: Object.freeze({ accepted: true as const }) });
  }

  /** Pi 已开始原生自动压缩；只有溢出重试会撤销当前 final candidate。 */
  observeCompactionStart(reason: ChildCompactionReason, willRetry = false): void {
    if (this.terminalFailure || this.compactionActive) return;
    this.compactionActive = true;
    this.awaitingRetryStart = willRetry;
    if (willRetry) {
      this.candidate = undefined;
      this.absentReason = undefined;
    }
    this.settlementEpoch += 1;
  }

  /** 压缩完成只解除压缩屏障；协调 manual 会沿用已有 raw settlement。 */
  observeCompactionEnd(reason: ChildCompactionReason): void {
    if (!this.compactionActive) return;
    this.compactionActive = false;
    this.settlementEpoch += 1;
    if (reason === "manual" && !this.runActive && !this.finalSubmitted) this.scheduleFinalSubmission();
  }

  /**
   * raw settled 只建立隔离候选并立即返回。发布与 ACK 都在回调之外执行，
   * 不会阻塞 Pi 的 settled handler 或其他扩展的生命周期回调。
   */
  settle(): void {
    if (this.awaitingRetryStart) {
      this.pendingSettledTurnId = undefined;
      return;
    }
    if (this.awaitingCoordinatedContinuationTransactionId !== undefined) {
      this.pendingSettledTurnId = undefined;
      this.runActive = false;
      return;
    }
    const settledTurnId = this.pendingSettledTurnId ?? this.currentTurnId;
    this.pendingSettledTurnId = undefined;
    if (
      !this.runActive
      || this.finalSubmitted
      || this.currentTaskId === undefined
      || this.currentTurnId === undefined
      || settledTurnId !== this.currentTurnId
    ) return;
    this.runActive = false;
    this.scheduleFinalSubmission();
  }

  getFinalCandidate(): FinalCandidate | undefined {
    return this.candidate;
  }

  getCurrentTurnId(): string | undefined {
    return this.currentTurnId;
  }

  getCurrentTaskId(): string | undefined {
    return this.currentTaskId;
  }

  private scheduleFinalSubmission(): void {
    const taskId = this.currentTaskId;
    const turnId = this.currentTurnId;
    if (taskId === undefined || turnId === undefined || this.finalSubmitted) return;
    const epoch = ++this.settlementEpoch;
    this.scheduleQuarantine(() => {
      if (
        this.terminalFailure
        || this.compactionActive
        || this.coordinationBarriers.size > 0
        || this.awaitingCoordinatedContinuationTransactionId !== undefined
        || this.runActive
        || this.finalSubmitted
        || epoch !== this.settlementEpoch
        || this.currentTaskId !== taskId
        || this.currentTurnId !== turnId
      ) return;
      const final = this.createFinal();
      if (final === undefined) {
        this.failFinal();
        return;
      }
      this.finalSubmitted = true;
      const publishReplyWithAck = this.port.publishReplyWithAck;
      if (publishReplyWithAck === undefined) {
        // 旧适配器仍保留同步语义；生产监督通道走下方非阻塞句柄路径。
        void this.enqueue(() => this.port.publishReplyAndWaitForAck(final)).then(
          () => this.handleFinalAcknowledged(final),
          () => this.failFinal(),
        );
        return;
      }
      void this.enqueue(() => publishReplyWithAck.call(this.port, final)).then(
        (publication) => {
          void publication.acknowledged.then(
            () => this.handleFinalAcknowledged(final),
            () => this.failFinal(),
          );
        },
        () => this.failFinal(),
      );
    });
  }

  private handleFinalAcknowledged(final: ChildFinalEnvelope): void {
    if (this.currentTaskId !== final.task_id || this.currentTurnId !== final.turn_id) return;
    this.currentTaskId = undefined;
    this.currentTurnId = undefined;
    this.candidate = undefined;
    this.absentReason = undefined;
    this.notifyFinalAccepted();
  }

  private createFinal(): ChildFinalEnvelope | undefined {
    const taskId = this.currentTaskId;
    const turnId = this.currentTurnId;
    const commitId = this.allocateId(this.commitIdFactory);
    if (taskId === undefined || turnId === undefined || commitId === undefined) return undefined;
    const candidate = this.candidate;
    const hasText = candidate !== undefined && candidate.text.trim().length > 0;
    const outputState = hasText ? "present" : "absent";
    const runState: ChildFinalEnvelope["run_state"] = this.finalState === "normal"
      ? "settled"
      : this.finalState;
    const reasonCode: ChildFinalReasonCode | undefined = runState === "settled" && outputState === "absent"
      ? this.absentReason ?? "no_output"
      : runState === "failed"
        ? this.failureReason ?? "runtime_fault"
        : undefined;
    return parseChildReplyEnvelope({
      schema: CHILD_REPLY_SCHEMA,
      version: CHILD_REPLY_VERSION,
      kind: "final",
      agent_id: this.agentId,
      task_id: taskId,
      turn_id: turnId,
      commit_id: commitId,
      run_state: runState,
      output_state: outputState,
      ...(reasonCode === undefined ? {} : { reason_code: reasonCode }),
      ...(hasText ? { text: candidate.text } : {}),
    }) as ChildFinalEnvelope | undefined;
  }

  private notifyFinalAccepted(): void {
    const notify = this.onFinalAccepted;
    if (notify === undefined) return;
    setImmediate(() => {
      try {
        notify();
      } catch {
        // final 已被父端确认，通知失败不能倒退 commit。
      }
    });
  }

  private failFinal(): void {
    this.terminalFailure = true;
    this.runActive = false;
    this.currentTaskId = undefined;
    this.currentTurnId = undefined;
    this.candidate = undefined;
    this.absentReason = undefined;
    this.notifyFinalFailure();
  }

  private notifyFinalFailure(): void {
    if (this.finalFailureNotified) return;
    this.finalFailureNotified = true;
    const notify = this.onFinalFailure;
    if (notify === undefined) return;
    setImmediate(() => {
      try {
        notify();
      } catch {
        // 独立监督流关闭是第二信号，回调异常不能再次冒泡。
      }
    });
  }

  private allocateId(factory: () => string): string | undefined {
    for (let attempt = 0; attempt < MAX_ID_GENERATION_ATTEMPTS; attempt += 1) {
      let candidate: unknown;
      try {
        candidate = factory();
      } catch {
        continue;
      }
      if (!isCanonicalUuidV4(candidate) || this.issuedIds.has(candidate)) continue;
      this.issuedIds.add(candidate);
      return candidate;
    }
    return undefined;
  }

  private enqueue<T>(operation: Publication<T>): Promise<T> {
    const next = this.wirePublicationTail.catch(() => {}).then(operation);
    this.wirePublicationTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

function validCompactionTransactionId(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function isReplyToParentInput(value: unknown): value is ReplyToParentInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.message === "string"
    && candidate.message.trim().length > 0
    && Object.keys(candidate).every((key) => key === "message");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
