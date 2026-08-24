import {
  controlFailure,
  isCanonicalUuid,
  type ControlResult,
} from "./tree-controller.ts";
import {
  CHILD_REPLY_SCHEMA,
  CHILD_REPLY_VERSION,
  parseChildReplyEnvelope,
  type ChildReplyEnvelope,
} from "./child-reply-envelope.ts";
import { REPLY_MAX_TEXT_BYTES } from "./child-reply-limits.ts";
import {
  normalizeReplyAcceptance,
  ReplyDeliveryRejectedError,
  type ReplyAcceptance,
} from "./reply-acceptance.ts";

export interface NormalReplyInput {
  readonly message: string;
}

export interface NormalReplyData {
  readonly accepted: true;
}

export interface FinalReportInput {
  readonly message: string;
}

export type FinalReportData = NormalReplyData;

export type ChildCompactionReason = "manual" | "threshold" | "overflow";

/**
 * 子端消息发送端口。每次 publishReply 正常返回即表示接收侧 Pi 已接纳。
 * ACK、应用序号和消息重放不属于该接口。
 */
export interface ChildReplyPort {
  publishReply(reply: ChildReplyEnvelope, signal?: AbortSignal): Promise<void | ReplyAcceptance>;
}

export interface ChildReplyCoordinatorOptions {
  readonly agentId: string;
  readonly port: ChildReplyPort;
}

/**
 * 持续会话的子端消息边界。
 *
 * 该类只记录当前 Pi 是否存在活动回合和上下文屏障。assistant 文本、
 * message_end、agent_end、settle 都不会自动生成报告；显式工具调用才会
 * 构造消息或报告信封并交给父端 Pi。
 */
export class ChildReplyCoordinator {
  private readonly agentId: string;
  private readonly port: ChildReplyPort;
  private readonly coordinationBarriers = new Set<string>();
  private runActive = false;
  private compactionActive = false;
  private terminalFailure = false;

  constructor(options: ChildReplyCoordinatorOptions) {
    if (!isCanonicalUuid(options.agentId)) throw new TypeError("invalid_child_agent_id");
    this.agentId = options.agentId;
    this.port = options.port;
  }

  beginCoordinationBarrier(transactionId: string): boolean {
    if (this.terminalFailure || !validCompactionTransactionId(transactionId)) return false;
    this.coordinationBarriers.add(transactionId);
    return true;
  }

  completeCoordinationBarrier(transactionId: string, _outcome: string): boolean {
    if (!validCompactionTransactionId(transactionId)) return false;
    return this.coordinationBarriers.delete(transactionId);
  }

  hasCoordinationBarrier(): boolean {
    return this.coordinationBarriers.size > 0;
  }

  expectsCoordinationContinuation(_transactionId: string, _outcome: string): boolean {
    return false;
  }

  awaitsCoordinationContinuation(_transactionId: string): boolean {
    return false;
  }

  observeAgentStart(): void {
    if (this.terminalFailure) return;
    this.runActive = true;
    this.compactionActive = false;
  }

  observeAgentEnd(): void {
    // agent_end 只离开当前模型循环；它不生成报告或 idle 事件，但也不再
    // 允许本轮结束后伪造“活动回合”继续发送报告。
    this.runActive = false;
  }

  observeAssistantMessageEnd(_event: unknown): void {
    // assistant 文本不是父端消息；只有显式 normal_reply/final_report 才出站。
  }

  async normalReply(
    input: NormalReplyInput | unknown,
    signal?: AbortSignal,
  ): Promise<ControlResult<NormalReplyData>> {
    return this.sendMessage(input, "message", signal);
  }

  async finalReport(
    input: FinalReportInput | unknown,
    signal?: AbortSignal,
  ): Promise<ControlResult<FinalReportData>> {
    return this.sendMessage(input, "final_report", signal);
  }

  observeCompactionStart(_reason: ChildCompactionReason, _willRetry = false): void {
    if (this.terminalFailure) return;
    this.compactionActive = true;
  }

  observeCompactionEnd(_reason: ChildCompactionReason): void {
    this.compactionActive = false;
  }

  settle(): void {
    // 自然停止不生成自动 final；生命周期 idle 由真实 agent_settled 事实负责。
    this.runActive = false;
  }

  private async sendMessage(
    input: NormalReplyInput | FinalReportInput | unknown,
    kind: "message" | "final_report",
    signal?: AbortSignal,
  ): Promise<ControlResult<NormalReplyData>> {
    if (!isNormalReplyInput(input)) return controlFailure("invalid_argument");
    if (utf8Length(input.message) > REPLY_MAX_TEXT_BYTES) return controlFailure("reply_too_large");
    if (
      !this.runActive
      || this.terminalFailure
      || signal?.aborted === true
    ) return controlFailure("message_delivery_failed");
    if (this.compactionActive || this.coordinationBarriers.size > 0) {
      return controlFailure("compaction_active");
    }

    const envelope = parseChildReplyEnvelope({
      schema: CHILD_REPLY_SCHEMA,
      version: CHILD_REPLY_VERSION,
      kind,
      agent_id: this.agentId,
      text: input.message,
    });
    if (envelope === undefined) return controlFailure("invalid_argument");
    try {
      const result: unknown = await this.port.publishReply(envelope, signal);
      if (!isSynchronousAcceptance(result)) {
        const acceptance = normalizeReplyAcceptance(result);
        if (!acceptance.accepted && acceptance.blocked_reason === "compaction_active") {
          return controlFailure("compaction_active");
        }
        throw new Error("message_delivery_failed");
      }
    } catch (error) {
      if (error instanceof ReplyDeliveryRejectedError && error.blockedReason === "compaction_active") {
        return controlFailure("compaction_active");
      }
      return controlFailure("message_delivery_failed");
    }
    return Object.freeze({ ok: true, data: Object.freeze({ accepted: true as const }) });
  }
}

function isSynchronousAcceptance(value: unknown): boolean {
  if (value === undefined || value === true) return true;
  if (value === false || value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record.then === "function") return false;
  return (record.ok === true || record.accepted === true)
    && record.ok !== false
    && record.accepted !== false;
}

function isNormalReplyInput(value: unknown): value is NormalReplyInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.message === "string"
    && candidate.message.trim().length > 0
    && Object.keys(candidate).every((key) => key === "message");
}

function validCompactionTransactionId(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
