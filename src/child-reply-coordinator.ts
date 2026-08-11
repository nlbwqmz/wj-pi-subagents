import { randomUUID } from "node:crypto";
import {
  CHILD_REPLY_ENVELOPE_LIMITS,
  CHILD_REPLY_SCHEMA,
  CHILD_REPLY_VERSION,
  parseChildReplyEnvelope,
  type ChildFinalEnvelope,
  type ChildFinalReasonCode,
  type ChildReplyEnvelope,
} from "./child-reply-envelope.ts";
import { normalizeAssistantMessageEnd } from "./rpc-bridge-event.ts";
import type {
  SupervisorTaskAssignment,
  SupervisorTaskStarted,
} from "./supervisor-channel.ts";
import { controlFailure, isCanonicalUuid, isCanonicalUuidV4, type ControlResult } from "./tree-controller.ts";

export interface ReplyToParentInput {
  readonly message: string;
  readonly requires_response: boolean;
}

export interface ReplyToParentData {
  readonly accepted: true;
}

export interface FinalCandidate {
  readonly text: string;
  readonly stopReason: "stop" | "length";
}

export interface ChildReplyPort {
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

type Publication = () => Promise<void>;
type RunFinalState = "normal" | "failed" | "interrupted";

const MAX_ID_GENERATION_ATTEMPTS = 32;

/**
 * child 侧任务/turn/final 深模块。raw settled 只准备候选并立即返回；隔离区内
 * 任何压缩、新轮或任务租约都会使旧提交失效。final ACK 在后台 outbox 等待。
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
  private publicationTail: Promise<void> = Promise.resolve();
  private candidate: FinalCandidate | undefined;
  private finalState: RunFinalState = "normal";
  private failureReason: Exclude<ChildFinalReasonCode, "no_output"> | undefined;
  private currentTaskId: string | undefined;
  private currentTurnId: string | undefined;
  private pendingSettledTurnId: string | undefined;
  private pendingPromptTaskId: string | undefined;
  private runActive = false;
  private compactionActive = false;
  private compactionAfterSettlement = false;
  private resumePending = false;
  private settlementEpoch = 0;
  private finalSubmitted = false;
  private terminalFailure = false;
  private finalFailureNotified = false;

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

  /** 监督租约先于 prompt/steer 到达；正文和任务标识始终分离。 */
  observeTaskAssignment(assignment: SupervisorTaskAssignment): void {
    if (this.terminalFailure) return;
    if (assignment.mode === "steer" && this.currentTaskId === assignment.task_id) return;
    // suspended/失败压缩后的新 prompt 必须取代旧逻辑任务，不能被误判为 resume。
    if (assignment.mode === "prompt" && assignment.task_id !== this.currentTaskId) {
      this.compactionActive = false;
      this.compactionAfterSettlement = false;
      this.resumePending = false;
      this.finalSubmitted = false;
    }
    this.pendingPromptTaskId = assignment.task_id;
    // 新任务租约到达结束隔离区时，旧 raw settled 不能抢先发布 final。
    this.settlementEpoch += 1;
  }

  /** 新 Pi loop：压缩恢复沿用 task_id，普通 prompt 消费监督租约。 */
  observeAgentStart(): void {
    if (this.terminalFailure) throw new Error("child_reply_coordinator_failed");
    const resume = this.compactionActive || this.resumePending;
    const taskId = resume && this.currentTaskId !== undefined
      ? this.currentTaskId
      : this.pendingPromptTaskId ?? this.allocateId(this.taskIdFactory);
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
    this.resumePending = false;
    this.finalSubmitted = false;
    this.candidate = undefined;
    this.finalState = "normal";
    this.failureReason = undefined;
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

  observeAssistantMessageEnd(event: unknown): void {
    if (!this.runActive || this.finalSubmitted || this.currentTurnId === undefined) return;
    const parsed = normalizeAssistantMessageEnd(event);
    if (parsed.kind === "ignored") return;
    if (parsed.kind !== "event" || parsed.event.type !== "message_end") {
      this.finalState = "failed";
      this.failureReason = "runtime_fault";
      return;
    }
    const raw = isRecord(event) && isRecord(event.message) ? event.message : undefined;
    const stopReason = raw?.stopReason;
    if (stopReason === "error") {
      this.finalState = "failed";
      this.failureReason = "provider_error";
      return;
    }
    if (stopReason === "aborted") {
      this.finalState = "interrupted";
      this.failureReason = undefined;
      return;
    }
    this.finalState = "normal";
    this.failureReason = undefined;
    if (stopReason !== "stop" && stopReason !== "length") return;
    if (Array.isArray(raw?.content) && raw.content.some((item) => isRecord(item) && item.type === "toolCall")) return;

    const text = parsed.event.message.content
      .filter((item): item is { readonly type: "text"; readonly text: string } => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    if (text.trim().length === 0 || utf8Length(text) > CHILD_REPLY_ENVELOPE_LIMITS.maxStringBytes) return;
    this.candidate = Object.freeze({ text, stopReason });
  }

  async replyToParent(
    input: ReplyToParentInput | unknown,
    signal?: AbortSignal,
  ): Promise<ControlResult<ReplyToParentData>> {
    if (!isReplyToParentInput(input)) return controlFailure("invalid_argument");
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
      requires_response: input.requires_response,
      text: input.message,
    });
    if (reply === undefined) return controlFailure("invalid_argument");
    try {
      await this.enqueue(() => this.port.publishReplyAndWaitForAck(reply, signal));
    } catch {
      return controlFailure("message_delivery_failed");
    }
    return Object.freeze({ ok: true, data: Object.freeze({ accepted: true as const }) });
  }

  /** Pi 已开始压缩；撤销所有未出站 final candidate，但保留逻辑任务。 */
  observeCompactionStart(): void {
    if (this.terminalFailure || this.currentTaskId === undefined) return;
    this.compactionAfterSettlement = !this.runActive;
    this.compactionActive = true;
    this.resumePending = false;
    this.finalSubmitted = false;
    this.settlementEpoch += 1;
  }

  /** 成功压缩若发生在 provisional settled 之后，必须等待恢复的新 agent_start。 */
  observeCompactionEnd(): void {
    if (!this.compactionActive) return;
    this.compactionActive = false;
    this.resumePending = this.compactionAfterSettlement;
    this.compactionAfterSettlement = false;
    this.settlementEpoch += 1;
  }

  /**
   * raw settled 只建立隔离候选并立即返回。发布与 ACK 都在回调之外执行，故不会
   * 阻塞第三方 settled handler 调用 ctx.compact()。
   */
  settle(): void {
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
    const epoch = ++this.settlementEpoch;
    this.scheduleQuarantine(() => {
      if (
        this.terminalFailure
        || this.compactionActive
        || this.resumePending
        || this.runActive
        || this.finalSubmitted
        || epoch !== this.settlementEpoch
      ) return;
      const final = this.createFinal();
      if (final === undefined) {
        this.failFinal();
        return;
      }
      this.finalSubmitted = true;
      void this.enqueue(() => this.port.publishReplyAndWaitForAck(final)).then(
        () => {
          if (this.currentTaskId !== final.task_id || this.currentTurnId !== final.turn_id) return;
          this.currentTaskId = undefined;
          this.currentTurnId = undefined;
          this.candidate = undefined;
          this.notifyFinalAccepted();
        },
        () => this.failFinal(),
      );
    });
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
      ? "no_output"
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

  private enqueue(operation: Publication): Promise<void> {
    const next = this.publicationTail.catch(() => {}).then(operation);
    this.publicationTail = next.catch(() => {});
    return next;
  }
}

function isReplyToParentInput(value: unknown): value is ReplyToParentInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.message === "string"
    && candidate.message.trim().length > 0
    && utf8Length(candidate.message) <= CHILD_REPLY_ENVELOPE_LIMITS.maxStringBytes
    && typeof candidate.requires_response === "boolean"
    && Object.keys(candidate).every((key) => key === "message" || key === "requires_response");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
