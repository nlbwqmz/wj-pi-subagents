/** 回复接纳失败的公开细分原因；其余失败保持 message_delivery_failed。 */
export type ReplyBlockedReason = "compaction_active";

/** 父端同步返回的回复接纳裁决。 */
export type ReplyAcceptance =
  | {
      readonly accepted: true;
    }
  | {
      readonly accepted: false;
      readonly blocked_reason?: ReplyBlockedReason;
    };

/** 父端接纳回调兼容旧的 boolean 返回值。 */
export type ReplyDeliveryDecision = ReplyAcceptance | boolean;

/** 将旧布尔结果和新结构化结果归一化为安全裁决。 */
export function normalizeReplyAcceptance(value: ReplyDeliveryDecision | unknown): ReplyAcceptance {
  if (value === true) return Object.freeze({ accepted: true });
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Object.freeze({ accepted: false });
  }
  const record = value as Record<string, unknown>;
  if (record.accepted === true) {
    return record.blocked_reason === undefined
      ? Object.freeze({ accepted: true })
      : Object.freeze({ accepted: false });
  }
  if (record.accepted !== false) return Object.freeze({ accepted: false });
  return record.blocked_reason === "compaction_active"
    ? Object.freeze({ accepted: false, blocked_reason: "compaction_active" as const })
    : Object.freeze({ accepted: false });
}

/** 子端监督通道把父端拒绝原因转换为本地可识别异常。 */
export class ReplyDeliveryRejectedError extends Error {
  readonly blockedReason: ReplyBlockedReason | undefined;

  constructor(blockedReason?: ReplyBlockedReason) {
    super(blockedReason === "compaction_active" ? "compaction_active" : "message_delivery_failed");
    this.name = "ReplyDeliveryRejectedError";
    this.blockedReason = blockedReason;
  }
}
