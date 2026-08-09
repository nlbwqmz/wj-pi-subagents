import { normalizeAssistantMessageEnd } from "./rpc-bridge-event.ts";
import {
  SUPERVISOR_CHANNEL_LIMITS,
  type SupervisorReplyImage,
  type SupervisorReplyInput,
} from "./supervisor-channel.ts";
import { controlFailure, type ControlResult } from "./tree-controller.ts";

export interface ReplyToParentInput {
  readonly message: string;
}

export interface ReplyToParentData {
  readonly accepted: true;
}

export interface FinalCandidate {
  readonly text: string;
  readonly images?: readonly SupervisorReplyImage[];
  readonly stopReason: "stop" | "length";
}

/** 子端上行端口由已经认证的直接父监督通道绑定，不接受目标身份参数。 */
export interface ChildReplyPort {
  publishReplyAndWaitForAck(
    reply: SupervisorReplyInput,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface ChildReplyCoordinatorOptions {
  readonly port: ChildReplyPort;
  /** 最终答复无法确认时通知运行时关闭监督通道，避免 Pi 误报 idle。 */
  readonly onFinalFailure?: () => void;
}

type Publication = () => Promise<void>;
type RunFinalState = "normal" | "failed" | "interrupted";

const MISSING_FINAL_REPLY_NOTICE =
  "子代理本轮已结束，但未产生可用的最终答复。若仍需结果，请在该子代理进入 idle 后，使用 send_message 向同一 agent_id 追问一次：“请仅总结上一轮已完成的工作并给出最终答复，不要重新执行任务；若没有可用结果，请说明原因。”若再次没有最终答复，请停止追问并报告无可用结果。";
const FAILED_WITH_PARTIAL_NOTICE =
  "子代理本轮未能正常完成，以下为已保留的部分内容。如有必要，可以尝试继续与该子代理沟通。";
const INTERRUPTED_NOTICE =
  "子代理本轮处理已中断。如有必要，可以尝试继续与该子代理沟通。";

/**
 * 将 Pi 生命周期事件和父端回复语义集中在一个小而有状态的模块中。
 * message_end 从不直接上行，只有显式工具和 settled final 能进入端口。
 */
export class ChildReplyCoordinator {
  private readonly port: ChildReplyPort;
  private readonly onFinalFailure: (() => void) | undefined;
  private publicationTail: Promise<void> = Promise.resolve();
  private candidate: FinalCandidate | undefined;
  private finalState: RunFinalState = "normal";
  private runActive = false;
  private finalSubmitted = false;
  private finalFailureNotified = false;

  constructor(options: ChildReplyCoordinatorOptions) {
    this.port = options.port;
    this.onFinalFailure = options.onFinalFailure;
  }

  /** 一个新的 Pi agent loop 开始，清除上一轮候选和 settled latch。 */
  observeAgentStart(): void {
    this.runActive = true;
    this.finalSubmitted = false;
    this.finalFailureNotified = false;
    this.candidate = undefined;
    this.finalState = "normal";
  }

  /** 只在本地更新候选；非 assistant 消息不会影响上一条合法候选。 */
  observeAssistantMessageEnd(event: unknown): void {
    const parsed = normalizeAssistantMessageEnd(event);
    if (parsed.kind === "ignored") return;
    this.runActive = true;
    if (parsed.kind !== "event" || parsed.event.type !== "message_end") {
      this.finalState = "failed";
      return;
    }
    const raw = isRecord(event) && isRecord(event.message) ? event.message : undefined;
    const stopReason = raw?.stopReason;
    if (stopReason === "error") {
      this.finalState = "failed";
      return;
    }
    if (stopReason === "aborted") {
      this.finalState = "interrupted";
      return;
    }
    this.finalState = "normal";
    if (stopReason !== "stop" && stopReason !== "length") return;
    if (Array.isArray(raw?.content) && raw.content.some((item) => isRecord(item) && item.type === "toolCall")) return;

    const text = parsed.event.message.content
      .filter((item): item is { readonly type: "text"; readonly text: string } => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    const images = parsed.event.message.content
      .filter((item): item is SupervisorReplyImage => item.type === "image")
      .map((item) => Object.freeze({ ...item }));
    if (
      text.trim().length === 0
      && images.length === 0
      || utf8Length(text) > SUPERVISOR_CHANNEL_LIMITS.maxStringBytes
      || images.length > SUPERVISOR_CHANNEL_LIMITS.maxImagesPerReply
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
    try {
      await this.enqueue(async () => {
        await this.port.publishReplyAndWaitForAck({
          kind: "message",
          text: input.message,
        }, signal);
      });
    } catch {
      return controlFailure("message_delivery_failed");
    }
    return Object.freeze({ ok: true, data: Object.freeze({ accepted: true as const }) });
  }

  /** settled 是唯一 final 提交入口；没有正文时发送说明性结果。 */
  async settle(): Promise<void> {
    if (!this.runActive || this.finalSubmitted) return;
    this.finalSubmitted = true;
    this.runActive = false;
    const candidate = this.candidate;
    const failedWithPartial = this.finalState === "failed" && candidate !== undefined;
    const partialText = failedWithPartial && candidate.text.trim().length > 0
      ? `\n\n${candidate.text}`
      : "";
    const failedText = `${FAILED_WITH_PARTIAL_NOTICE}${partialText}`;
    const text = this.finalState === "interrupted"
      ? INTERRUPTED_NOTICE
      : failedWithPartial
        ? utf8Length(failedText) <= SUPERVISOR_CHANNEL_LIMITS.maxStringBytes
          ? failedText
          : FAILED_WITH_PARTIAL_NOTICE
        : candidate?.text ?? MISSING_FINAL_REPLY_NOTICE;
    const includeCandidateImages = this.finalState !== "interrupted" && candidate?.images !== undefined;
    const reply: SupervisorReplyInput = {
      kind: "final",
      text,
      ...(includeCandidateImages ? { images: candidate.images } : {}),
    };
    try {
      await this.enqueue(() => this.port.publishReplyAndWaitForAck(reply));
    } catch {
      if (!this.finalFailureNotified) {
        this.finalFailureNotified = true;
        try {
          this.onFinalFailure?.();
        } catch {
          // 故障通知只是关闭提示，不能再次冒泡到 Pi 进程。
        }
      }
      throw new Error("子代理最终回复未获父会话确认");
    }
  }

  getFinalCandidate(): FinalCandidate | undefined {
    return this.candidate;
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
    && utf8Length(candidate.message) <= SUPERVISOR_CHANNEL_LIMITS.maxStringBytes
    && Object.keys(candidate).every((key) => key === "message");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
