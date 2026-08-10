import { randomUUID } from "node:crypto";
import {
  CHILD_REPLY_ENVELOPE_LIMITS,
  CHILD_REPLY_SCHEMA,
  CHILD_REPLY_VERSION,
  isValidChildReplyImages,
  parseChildReplyEnvelope,
  type ChildFinalEnvelope,
  type ChildFinalReasonCode,
  type ChildReplyImage,
  type ChildReplyEnvelope,
} from "./child-reply-envelope.ts";
import { normalizeAssistantMessageEnd } from "./rpc-bridge-event.ts";
import { controlFailure, isCanonicalUuid, isCanonicalUuidV4, type ControlResult } from "./tree-controller.ts";

export interface ReplyToParentInput {
  readonly message: string;
  readonly requires_response: boolean;
  readonly images?: readonly ChildReplyImage[];
}

export interface ReplyToParentData {
  readonly accepted: true;
}

export interface FinalCandidate {
  readonly text: string;
  readonly images?: readonly ChildReplyImage[];
  readonly stopReason: "stop" | "length";
}

/** 子端上行端口由已经认证的直接父监督通道绑定，不接受目标身份参数。 */
export interface ChildReplyPort {
  publishReplyAndWaitForAck(
    reply: ChildReplyEnvelope,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface ChildReplyCoordinatorOptions {
  readonly agentId: string;
  readonly port: ChildReplyPort;
  readonly turnIdFactory?: () => string;
  /** 无法形成或确认 final 时通知运行时关闭监督通道，避免 Pi 误报 idle。 */
  readonly onFinalFailure?: () => void;
}

type Publication = () => Promise<void>;
type RunFinalState = "normal" | "failed" | "interrupted";

const MAX_TURN_ID_GENERATION_ATTEMPTS = 32;

/**
 * 将 Pi 生命周期事件和父端回复语义集中在一个小而有状态的模块中。
 * message_end 从不直接上行，只有显式工具和 settled final 能进入端口。
 */
export class ChildReplyCoordinator {
  private readonly agentId: string;
  private readonly port: ChildReplyPort;
  private readonly turnIdFactory: () => string;
  private readonly issuedTurnIds = new Set<string>();
  private readonly onFinalFailure: (() => void) | undefined;
  private publicationTail: Promise<void> = Promise.resolve();
  private candidate: FinalCandidate | undefined;
  private finalState: RunFinalState = "normal";
  private failureReason: Exclude<ChildFinalReasonCode, "no_output"> | undefined;
  private currentTurnId: string | undefined;
  private runActive = false;
  private finalSubmitted = false;
  private terminalFailure = false;
  private finalFailureNotified = false;

  constructor(options: ChildReplyCoordinatorOptions) {
    if (!isCanonicalUuid(options.agentId)) throw new TypeError("invalid_child_agent_id");
    this.agentId = options.agentId;
    this.port = options.port;
    this.turnIdFactory = options.turnIdFactory ?? randomUUID;
    this.onFinalFailure = options.onFinalFailure;
  }

  /** 一个新的 Pi agent loop 开始，生成轮次并清除上一轮候选和 settled latch。 */
  observeAgentStart(): void {
    if (this.terminalFailure) throw new Error("child_reply_coordinator_failed");
    this.currentTurnId = undefined;
    this.runActive = false;
    this.finalSubmitted = true;
    this.candidate = undefined;
    this.finalState = "normal";
    this.failureReason = undefined;

    const turnId = this.allocateTurnId();
    if (turnId === undefined) {
      this.terminalFailure = true;
      this.notifyFinalFailure();
      throw new TypeError("invalid_child_turn_id");
    }
    this.issuedTurnIds.add(turnId);
    this.currentTurnId = turnId;
    this.runActive = true;
    this.finalSubmitted = false;
  }

  /** 只在活动轮次内更新候选；非 assistant 或迟到消息不会改变已提交 final。 */
  observeAssistantMessageEnd(event: unknown): void {
    if (!this.runActive || this.finalSubmitted || this.currentTurnId === undefined) return;
    const parsed = normalizeAssistantMessageEnd(event);
    if (parsed.kind === "ignored") return;
    this.runActive = true;
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
    const images = parsed.event.message.content
      .filter((item): item is ChildReplyImage => item.type === "image")
      .map((item) => Object.freeze({ ...item }));
    if (
      text.trim().length === 0
      && images.length === 0
      || utf8Length(text) > CHILD_REPLY_ENVELOPE_LIMITS.maxStringBytes
      || images.length > CHILD_REPLY_ENVELOPE_LIMITS.maxImagesPerReply
      || (images.length > 0 && !isValidChildReplyImages(images))
    ) return;
    this.candidate = Object.freeze({
      text,
      ...(images.length === 0 ? {} : { images: Object.freeze(images) }),
      stopReason,
    });
  }

  /**
   * 向唯一直接父会话发送工作中回复。成功只代表父端已经 ACK 接纳，
   * 不改变当前处理或最终候选。
   */
  async replyToParent(
    input: ReplyToParentInput | unknown,
    signal?: AbortSignal,
  ): Promise<ControlResult<ReplyToParentData>> {
    if (!isReplyToParentInput(input)) return controlFailure("invalid_argument");
    const turnId = this.currentTurnId;
    if (!this.runActive || turnId === undefined) return controlFailure("message_delivery_failed");
    const reply = parseChildReplyEnvelope({
      schema: CHILD_REPLY_SCHEMA,
      version: CHILD_REPLY_VERSION,
      kind: "message",
      agent_id: this.agentId,
      turn_id: turnId,
      requires_response: input.requires_response,
      text: input.message,
      ...(input.images === undefined ? {} : { images: input.images }),
    });
    if (reply === undefined) return controlFailure("invalid_argument");
    try {
      await this.enqueue(async () => {
        await this.port.publishReplyAndWaitForAck(reply, signal);
      });
    } catch {
      return controlFailure("message_delivery_failed");
    }
    return Object.freeze({ ok: true, data: Object.freeze({ accepted: true as const }) });
  }

  /** settled 是唯一 final 提交入口；无业务载荷时只发送状态字段。 */
  async settle(): Promise<void> {
    if (!this.runActive || this.finalSubmitted || this.currentTurnId === undefined) return;
    this.finalSubmitted = true;
    this.runActive = false;
    const candidate = this.candidate;
    const hasText = candidate !== undefined && candidate.text.trim().length > 0;
    const hasImages = candidate?.images !== undefined && candidate.images.length > 0;
    const outputState = hasText || hasImages ? "present" : "absent";
    const runState: ChildFinalEnvelope["run_state"] = this.finalState === "normal"
      ? "settled"
      : this.finalState;
    const reasonCode: ChildFinalReasonCode | undefined = runState === "settled" && outputState === "absent"
      ? "no_output"
      : runState === "failed"
        ? this.failureReason ?? "runtime_fault"
        : undefined;
    const reply: ChildFinalEnvelope = {
      schema: CHILD_REPLY_SCHEMA,
      version: CHILD_REPLY_VERSION,
      kind: "final",
      agent_id: this.agentId,
      turn_id: this.currentTurnId,
      run_state: runState,
      output_state: outputState,
      ...(reasonCode === undefined ? {} : { reason_code: reasonCode }),
      ...(hasText ? { text: candidate.text } : {}),
      ...(hasImages ? { images: candidate.images } : {}),
    };
    try {
      await this.enqueue(() => this.port.publishReplyAndWaitForAck(reply));
    } catch {
      this.currentTurnId = undefined;
      this.candidate = undefined;
      this.terminalFailure = true;
      this.notifyFinalFailure();
      throw new Error("子代理最终回复未获父会话确认");
    }
  }

  getFinalCandidate(): FinalCandidate | undefined {
    return this.candidate;
  }

  getCurrentTurnId(): string | undefined {
    return this.currentTurnId;
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
        // 独立监督流关闭是 rejection 之后的第二信号，回调异常不能再次冒泡。
      }
    });
  }

  private allocateTurnId(): string | undefined {
    for (let attempt = 0; attempt < MAX_TURN_ID_GENERATION_ATTEMPTS; attempt += 1) {
      let candidate: unknown;
      try {
        candidate = this.turnIdFactory();
      } catch {
        continue;
      }
      if (!isCanonicalUuidV4(candidate) || this.issuedTurnIds.has(candidate)) continue;
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
    && (candidate.images === undefined || isValidChildReplyImages(candidate.images))
    && Object.keys(candidate).every((key) => key === "message" || key === "requires_response" || key === "images");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
