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

/**
 * 子端消息发送端口。每次 publishReply 正常返回只表示父端扩展运行时已接受
 * 本次提交；Pi 的 fire-and-forget 扩展 API 不提供异步处理结果。
 * ACK、应用序号和消息重放不属于该接口。
 */
export interface ChildReplyPort {
  publishReply(reply: ChildReplyEnvelope, signal?: AbortSignal): Promise<void>;
}

export interface ChildReplyCoordinatorOptions {
  readonly agentId: string;
  readonly port: ChildReplyPort;
}

/**
 * 持续会话的子端消息边界。
 *
 * 该类只记录当前 Pi 是否存在活动回合。assistant 文本、message_end、
 * agent_end、settle 都不会自动生成报告；显式工具调用才会构造消息或
 * 报告信封并交给父端 Pi。
 */
export class ChildReplyCoordinator {
  private readonly agentId: string;
  private readonly port: ChildReplyPort;
  private runActive = false;
  private terminalFailure = false;

  constructor(options: ChildReplyCoordinatorOptions) {
    if (!isCanonicalUuid(options.agentId)) throw new TypeError("invalid_child_agent_id");
    this.agentId = options.agentId;
    this.port = options.port;
  }

  observeAgentStart(): void {
    if (this.terminalFailure) return;
    this.runActive = true;
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

    const envelope = parseChildReplyEnvelope({
      schema: CHILD_REPLY_SCHEMA,
      version: CHILD_REPLY_VERSION,
      kind,
      agent_id: this.agentId,
      text: input.message,
    });
    if (envelope === undefined) return controlFailure("invalid_argument");
    try {
      await this.port.publishReply(envelope, signal);
    } catch {
      return controlFailure("message_delivery_failed");
    }
    return Object.freeze({ ok: true, data: Object.freeze({ accepted: true as const }) });
  }
}

function isNormalReplyInput(value: unknown): value is NormalReplyInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.message === "string"
    && candidate.message.trim().length > 0
    && Object.keys(candidate).every((key) => key === "message");
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
