/**
 * 子代理向直接父会话交付的单条业务回复正文上限，按 UTF-8 字节计算。
 * 帧解析的单字符串预算由 maxFrameStringBytes 取三者最大值自动跟随，
 * 无需同步调整 maxControlStringBytes。
 */
export const REPLY_MAX_TEXT_BYTES = 64 * 1024;
