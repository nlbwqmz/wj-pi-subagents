import assert from "node:assert/strict";
import test from "node:test";
import { REPLY_MAX_TEXT_BYTES } from "../src/child-reply-limits.ts";
import {
  ACTIVITY_MAX_TEXT_BYTES,
  normalizeAssistantMessageEnd,
  normalizeAssistantMessageUpdate,
  normalizeOwnCompactionFailure,
  normalizeRpcBridgeEvent,
  parseAgentActivityDisplayEvent,
  parseCanonicalAgentActivityDisplayEvent,
  parseAgentActivityEvent,
} from "../src/rpc-bridge-event.ts";

const AGENT_ID = "550e8400-e29b-41d4-a716-446655440000";
const INCARNATION_ID = "7f9c24e8-5b3d-4f6a-8c1e-9d2b7a4f6e81";
const DISPLAY_EPOCH = "128c3f70-2d40-4e21-a8b4-1c9d8e7f6a50";

test("真正 child 回复端点只公开文本，明确丢弃 thinking、toolCall 和图片内容", () => {
  const result = normalizeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      provider: "不得透传",
      content: [
        { type: "thinking", thinking: "不得透传的思考" },
        { type: "text", text: "完成", signature: "不得透传" },
        { type: "toolCall", id: "call-secret", name: "apply_patch", arguments: { secret: true } },
        { type: "image", data: "YWJj", mimeType: "image/png", source: "不得透传" },
      ],
    },
  });

  assert.deepEqual(result, {
    kind: "event",
    event: {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "完成" },
        ],
      },
    },
  });
});

test("任务桥接公开无载荷 agent_start 事实并剥离其余字段", () => {
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "agent_start",
    prompt: "不得透传",
    session: { secret: true },
  }), {
    kind: "event",
    event: { type: "agent_start" },
  });
});

test("桥接严格规范化 Pi 的完整压缩原因闭集，非法原因拒绝", () => {
  for (const reason of ["manual", "threshold", "overflow"] as const) {
    assert.deepEqual(normalizeRpcBridgeEvent({
      type: "compaction_start",
      reason,
      privateState: "不得透传",
    }), {
      kind: "event",
      event: { type: "compaction_start", reason },
    });
  }
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "compaction_start",
    reason: "third_party",
  }), { kind: "invalid" });
});

test("compaction_end 分离取消与真实错误，且不公开 provider 错误正文", () => {
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "compaction_end",
    reason: "threshold",
    aborted: false,
    willRetry: false,
    result: { summary: "不得透传" },
  }), {
    kind: "event",
    event: {
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      willRetry: false,
      failed: false,
    },
  });
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "compaction_end",
    reason: "overflow",
    aborted: false,
    willRetry: false,
    errorMessage: "TOP_SECRET_PROVIDER_ERROR",
  }), {
    kind: "event",
    event: {
      type: "compaction_end",
      reason: "overflow",
      aborted: false,
      willRetry: false,
      failed: true,
    },
  });
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "compaction_end",
    reason: "manual",
    aborted: true,
    willRetry: false,
  }), {
    kind: "event",
    event: {
      type: "compaction_end",
      reason: "manual",
      aborted: true,
      willRetry: false,
      failed: false,
    },
  });
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "compaction_end",
    reason: "threshold",
    aborted: "false",
    willRetry: false,
  }), { kind: "invalid" });
});

test("显示层 message_update 只提取有序文本与 thinking delta，不进入完整活动事件闭集", () => {
  assert.deepEqual(normalizeAssistantMessageUpdate({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" },
  }, "message-1", 1), {
    kind: "event",
    event: {
      type: "message_delta",
      streamId: "message-1",
      sequence: 1,
      contentIndex: 0,
      contentType: "text",
      delta: "Hel",
    },
  });
  assert.deepEqual(normalizeAssistantMessageUpdate({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "" },
  }, "message-1", 2), { kind: "ignored" });
  assert.deepEqual(normalizeAssistantMessageUpdate({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "plan" },
  }, "message-1", 2), {
    kind: "event",
    event: {
      type: "message_delta",
      streamId: "message-1",
      sequence: 2,
      contentIndex: 1,
      contentType: "thinking",
      delta: "plan",
    },
  });
  assert.deepEqual(normalizeAssistantMessageUpdate({
    type: "message_update",
    assistantMessageEvent: { type: "toolcall_delta", contentIndex: 2, delta: "{}" },
  }, "message-1", 3), { kind: "ignored" });
  assert.deepEqual(normalizeAssistantMessageUpdate({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: -1, delta: "bad" },
  }, "message-1", 4), { kind: "invalid" });
  assert.deepEqual(parseAgentActivityDisplayEvent({
    type: "message_complete",
    streamId: "message-1",
    sequence: 3,
    agentId: AGENT_ID,
    incarnationId: INCARNATION_ID,
  }), {
    kind: "event",
    event: {
      type: "message_complete",
      streamId: "message-1",
      sequence: 3,
      agentId: AGENT_ID,
      incarnationId: INCARNATION_ID,
    },
  });
  // 实时流身份必须是规范 UUID：不同代理、重启实例或复用 stream ID 不会
  // 关联到同一草稿。
  assert.deepEqual(parseAgentActivityDisplayEvent({
    type: "message_complete",
    streamId: "message-1",
    sequence: 3,
    agentId: "not-a-uuid",
    incarnationId: INCARNATION_ID,
  }), { kind: "invalid" });
  assert.deepEqual(parseAgentActivityDisplayEvent({
    type: "message_delta",
    streamId: "",
    sequence: 1,
    contentIndex: 0,
    contentType: "text",
    delta: "bad",
    agentId: AGENT_ID,
    incarnationId: INCARNATION_ID,
  }), { kind: "invalid" });
});

test("canonical display wire 要求 UUID epoch 与完整有序 stream identity", () => {
  const canonical = {
    type: "message_delta" as const,
    streamId: "message-1",
    sequence: 1,
    displayEpoch: DISPLAY_EPOCH,
    displaySourceGeneration: 1,
    streamOrdinal: 1,
    contentIndex: 0,
    contentType: "text" as const,
    delta: "正文",
    agentId: AGENT_ID,
    incarnationId: INCARNATION_ID,
  };
  assert.equal(parseCanonicalAgentActivityDisplayEvent(canonical).kind, "event");

  const { streamOrdinal: _ordinal, ...missingOrdinal } = canonical;
  assert.equal(parseCanonicalAgentActivityDisplayEvent(missingOrdinal).kind, "invalid");
  assert.equal(parseCanonicalAgentActivityDisplayEvent({
    ...canonical,
    displayEpoch: "opaque-legacy-token",
  }).kind, "invalid");
  assert.equal(parseCanonicalAgentActivityDisplayEvent({
    ...canonical,
    displaySourceGeneration: 0,
  }).kind, "invalid");
  assert.equal(parseCanonicalAgentActivityDisplayEvent({
    ...canonical,
    displaySourceGeneration: Number.MAX_SAFE_INTEGER + 1,
  }).kind, "invalid");
  assert.equal(parseCanonicalAgentActivityDisplayEvent({
    ...canonical,
    streamOrdinal: 0,
  }).kind, "invalid");
  assert.equal(parseCanonicalAgentActivityDisplayEvent({
    ...canonical,
    streamOrdinal: Number.MAX_SAFE_INTEGER + 1,
  }).kind, "invalid");

  // local raw-Pi compatibility may omit the entire ordered identity, but cannot
  // smuggle a partial identity across either parser.
  const { displayEpoch, displaySourceGeneration, streamOrdinal, ...legacy } = canonical;
  assert.equal(parseAgentActivityDisplayEvent(legacy).kind, "event");
  assert.equal(parseCanonicalAgentActivityDisplayEvent(legacy).kind, "invalid");
  assert.equal(parseAgentActivityDisplayEvent({
    ...legacy,
    displayEpoch,
  }).kind, "invalid");
});

test("任务桥接忽略非 assistant 的 message_end；活动路径逐块忽略未知内容块，回复路径仍拒绝", () => {
  assert.deepEqual(normalizeRpcBridgeEvent({ type: "message_update", delta: "忽略" }), {
    kind: "ignored",
  });
  // 活动路径：未知块逐块忽略，无剩余合法块时整体忽略，不中断会话。
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "future_secret_block", secret: "不得静默丢弃" }],
    },
  }), {
    kind: "ignored",
  });
  // 最终回复路径（reply 通道）仍拒绝未知内容块。
  assert.deepEqual(normalizeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "future_secret_block", secret: "不得静默丢弃" }],
    },
  }), {
    kind: "invalid",
  });
  assert.deepEqual(normalizeAssistantMessageEnd({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: 42 }] },
  }), {
    kind: "invalid",
  });
});

test("真正 child 最终文本按拼接后的 64 KiB UTF-8 总长度区分回复超限", () => {
  const exactFirst = "x".repeat(REPLY_MAX_TEXT_BYTES - 4);
  const exact = normalizeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: exactFirst }, { type: "text", text: "完" }],
    },
  });
  assert.equal(exact.kind, "event");

  assert.deepEqual(normalizeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: exactFirst }, { type: "text", text: "abcd" }],
    },
  }), {
    kind: "rejected",
    reason: "reply_too_large",
  });

  // 多字节字符按 UTF-8 字节计算：21,846 个三字节字符 = 65,538 字节，超过 64 KiB 上限。
  assert.deepEqual(normalizeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "测".repeat(Math.ceil((REPLY_MAX_TEXT_BYTES + 1) / 3)) }],
    },
  }), {
    kind: "rejected",
    reason: "reply_too_large",
  });

  assert.deepEqual(normalizeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "x".repeat(REPLY_MAX_TEXT_BYTES + 1) },
        { type: "future_secret_block", secret: "仍须按非法事件拒绝" },
      ],
    },
  }), {
    kind: "invalid",
  });
});

test("真正 child 端忽略非 assistant 的 message_end，不把它当成直接回复或协议故障", () => {
  assert.deepEqual(normalizeAssistantMessageEnd({
    type: "message_end",
    message: { role: "toolResult", content: [{ type: "text", text: "工具结果" }] },
  }), {
    kind: "ignored",
  });
});

test("桥接闭集加宽：assistant 正文规范化为携带 text 与 thinking 块的消息活动事件", () => {
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "message_end",
    message: {
      role: "assistant",
      provider: "不得透传",
      content: [
        { type: "thinking", thinking: "内部推理", signature: "不得透传" },
        { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } },
        { type: "text", text: "开始处理" },
        { type: "image", data: "YWJj", mimeType: "image/png" },
      ],
    },
  }), {
    kind: "event",
    event: {
      type: "message",
      content: [
        { type: "thinking", thinking: "内部推理" },
        { type: "text", text: "开始处理" },
      ],
    },
  });
});

test("消息活动正文聚合不设字节上限", () => {
  // assistant 正文任意长，全部合法（传输分块由监督通道承担）。
  const large = normalizeRpcBridgeEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "x".repeat(ACTIVITY_MAX_TEXT_BYTES + 1024) }],
    },
  });
  assert.equal(large.kind, "event");
});

test("消息活动事件仍拒绝结构违约与非字符串正文", () => {
  // 声明为 text 但结构无效的块逐块忽略，不吞掉整条消息。
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: 42 }] },
  }), { kind: "ignored" });
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "message_end",
    message: { role: "assistant", content: "不是数组" },
  }), { kind: "invalid" });
  // 空 content 数组结构合法但无正文：按 ignored 处理，不中断会话。
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "message_end",
    message: { role: "assistant", content: [] },
  }), { kind: "ignored" });
});

test("空正文块被跳过，全空消息按 ignored 处理而不中断桥接", () => {
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "" },
        { type: "thinking", thinking: "" },
        { type: "text", text: "有效正文" },
      ],
    },
  }), {
    kind: "event",
    event: {
      type: "message",
      content: [{ type: "text", text: "有效正文" }],
    },
  });
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "" }, { type: "thinking", thinking: "" }],
    },
  }), { kind: "ignored" });
});

test("错误收尾且正文为空的收尾消息登记为模型调用失败事实", () => {
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      stopReason: "error",
      errorMessage: "Invalid API key",
    },
  }), {
    kind: "event",
    event: {
      type: "model_call_failure",
      failure: "error",
      message: "Invalid API key",
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
    },
  });
  // 错误文本原样保留（只做终端安全净化），不翻译、不摘要、不加前缀。
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      provider: "openai",
      model: "gpt-5",
      stopReason: "error",
      errorMessage: "line1\r\nline2\tend\u001b[31m",
    },
  }), {
    kind: "event",
    event: {
      type: "model_call_failure",
      failure: "error",
      message: "line1\nline2  end",
      provider: "openai",
      model: "gpt-5",
    },
  });
});

test("已中止收尾与错误同形登记失败条目，正文为空的静默溢出不登记", () => {
  const message = (
    overrides: Record<string, unknown>,
  ): Record<string, unknown> => ({
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      stopReason: "error",
      errorMessage: "Invalid API key",
      ...overrides,
    },
  });
  // 已中止收尾与错误收尾同形登记，收尾原因如实记录。
  assert.deepEqual(normalizeRpcBridgeEvent(message({ stopReason: "aborted" })), {
    kind: "event",
    event: {
      type: "model_call_failure",
      failure: "aborted",
      message: "Invalid API key",
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
    },
  });
  // 正常收尾与无错误文本的静默溢出（长度收尾且零输出）都不登记。
  assert.deepEqual(normalizeRpcBridgeEvent(message({ stopReason: "stop" })), { kind: "ignored" });
  assert.deepEqual(normalizeRpcBridgeEvent(message({ stopReason: "length" })), { kind: "ignored" });
  // provider/model 不是合法短引用时不登记，不把宿主事实差异升级为违约。
  assert.deepEqual(normalizeRpcBridgeEvent(message({ provider: undefined })), { kind: "ignored" });
  assert.deepEqual(normalizeRpcBridgeEvent(message({ model: undefined })), { kind: "ignored" });
  assert.deepEqual(normalizeRpcBridgeEvent(message({ provider: 42 })), { kind: "ignored" });
  // 两个都不可得同样不登记：收尾消息的失败事实仍以身份在场为采集前提，
  // 无身份失败条目只来自压缩自身失败的产生端订阅。
  assert.deepEqual(
    normalizeRpcBridgeEvent(message({ provider: undefined, model: undefined })),
    { kind: "ignored" },
  );
});

test("压缩自身失败的产生端归一化：无身份登记、中止如实记录、文本缺失用兜底文案", () => {
  // session_compact_failed 不携带 provider/model，条目以无身份形状成立。
  assert.deepEqual(normalizeOwnCompactionFailure({
    type: "session_compact_failed",
    reason: "overflow",
    errorMessage: "summarization request failed",
    aborted: false,
    willRetry: true,
    fromExtension: false,
  }), {
    kind: "event",
    event: {
      type: "model_call_failure",
      failure: "error",
      message: "summarization request failed",
    },
  });
  // aborted 为真记 aborted，与错误同形登记；无错误文本时用 Pi 兜底文案。
  assert.deepEqual(normalizeOwnCompactionFailure({
    type: "session_compact_failed",
    reason: "threshold",
    aborted: true,
    willRetry: false,
    fromExtension: false,
  }), {
    kind: "event",
    event: { type: "model_call_failure", failure: "aborted", message: "Unknown error" },
  });
  // 错误文本原样保留（只做终端安全净化）。
  assert.deepEqual(normalizeOwnCompactionFailure({
    type: "session_compact_failed",
    reason: "manual",
    errorMessage: "line1\r\nline2\tend",
    aborted: false,
    willRetry: false,
    fromExtension: true,
  }), {
    kind: "event",
    event: { type: "model_call_failure", failure: "error", message: "line1\nline2  end" },
  });
  // 非压缩失败事件不登记条目；中止标志非真（含缺失）时按 error 记录。
  assert.deepEqual(
    normalizeOwnCompactionFailure({ type: "summarization_retry_finished", attempt: 2 }),
    { kind: "invalid" },
  );
  assert.deepEqual(
    normalizeOwnCompactionFailure({
      type: "session_compact_failed",
      reason: "manual",
      errorMessage: "compaction failed",
    }),
    {
      kind: "event",
      event: { type: "model_call_failure", failure: "error", message: "compaction failed" },
    },
  );
});

test("错误文本缺失时用 Pi 兜底文案 Unknown error", () => {
  const message = (
    overrides: Record<string, unknown>,
  ): Record<string, unknown> => ({
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      provider: "openai",
      model: "gpt-5",
      stopReason: "error",
      ...overrides,
    },
  });
  const expected = {
    kind: "event",
    event: {
      type: "model_call_failure",
      failure: "error",
      message: "Unknown error",
      provider: "openai",
      model: "gpt-5",
    },
  };
  assert.deepEqual(normalizeRpcBridgeEvent(message({})), expected);
  assert.deepEqual(normalizeRpcBridgeEvent(message({ errorMessage: "" })), expected);
  assert.deepEqual(normalizeRpcBridgeEvent(message({ errorMessage: undefined })), expected);
  // 已中止且无错误文本同样落到兜底文案。
  assert.deepEqual(normalizeRpcBridgeEvent(message({ stopReason: "aborted" })), {
    kind: "event",
    event: { ...expected.event, failure: "aborted" },
  });
});

test("正文非空的失败消息产生正文与失败两条独立条目，顺序为到达顺序", () => {
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "半句输出" }],
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      stopReason: "error",
      errorMessage: "401 unauthorized\nline2",
    },
  }), {
    kind: "events",
    events: [
      { type: "message", content: [{ type: "text", text: "半句输出" }] },
      {
        type: "model_call_failure",
        failure: "error",
        message: "401 unauthorized\nline2",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
      },
    ],
  });
  // 已中止且带正文的收尾同样是两条独立条目。
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "半句" }],
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      stopReason: "aborted",
    },
  }), {
    kind: "events",
    events: [
      { type: "message", content: [{ type: "text", text: "半句" }] },
      {
        type: "model_call_failure",
        failure: "aborted",
        message: "Unknown error",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
      },
    ],
  });
  // 无失败事实的正文消息仍只是单条正文条目。
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "完整回复" }],
      stopReason: "stop",
    },
  }), {
    kind: "event",
    event: { type: "message", content: [{ type: "text", text: "完整回复" }] },
  });
});

test("上下文超限失败随收尾消息登记，无错误文本的静默溢出不登记", () => {
  // Pi 把上下文超限失败先持久化在收尾 assistant 消息上（随后才进入压缩
  // 重试），因此带错误文本的溢出/压缩触发失败与普通错误收尾共享同一采集点，
  // provider/model 也随该消息一并采集。
  // 静默溢出（用量超窗口或长度收尾且零输出）没有错误文本，不登记也不自造文案。
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      stopReason: "error",
      errorMessage: "context_length_exceeded: prompt is too long for this model",
      usage: { input: 200_000, output: 0 },
    },
  }), {
    kind: "event",
    event: {
      type: "model_call_failure",
      failure: "error",
      message: "context_length_exceeded: prompt is too long for this model",
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
    },
  });
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      stopReason: "length",
      usage: { input: 200_000, output: 0 },
    },
  }), { kind: "ignored" });
});

test("自动重试与压缩重试事件不在桥接闭集内，不产生任何条目", () => {
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "auto_retry_start",
    attempt: 2,
    maxAttempts: 3,
    delayMs: 1_000,
    errorMessage: "rate limited",
  }), { kind: "ignored" });
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "auto_retry_end",
    success: true,
    attempt: 2,
  }), { kind: "ignored" });
  // 压缩重试事件与自动重试同属重试类：桥接闭集不新增条目。
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "summarization_retry_scheduled",
    attempt: 2,
    maxAttempts: 3,
    delayMs: 1_000,
  }), { kind: "ignored" });
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "summarization_retry_attempt_start",
    attempt: 2,
  }), { kind: "ignored" });
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "summarization_retry_finished",
    attempt: 2,
    success: false,
  }), { kind: "ignored" });
});

test("活动事件闭集校验器拒绝空正文，与桥接端‘空块跳过’不冲突", () => {
  assert.equal(parseAgentActivityEvent({ type: "message", content: [] }).kind, "invalid");
  assert.equal(parseAgentActivityEvent({
    type: "message",
    content: [{ type: "text", text: "" }],
  }).kind, "invalid");
});

test("桥接副本工具事件不再携带参数与结果，来源身份标记为未知", () => {
  // 桥接 RPC 副本只服务活动阶段跟踪；参数与结果正文在产生端被丢弃。
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "read",
    args: { path: "a.ts", limit: 10 },
  }), {
    kind: "event",
    event: {
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "read",
      origin: "unknown",
    },
  });
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "read",
    result: { lines: ["a", "b"], truncated: false },
    isError: false,
  }), {
    kind: "event",
    event: {
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "read",
      origin: "unknown",
      isError: false,
    },
  });
});

test("桥接工具结束事件缺少 isError 布尔事实时按结构违约拒绝", () => {
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "tool_execution_end",
    toolCallId: "call_2",
    toolName: "edit",
  }), { kind: "invalid" });
  assert.deepEqual(normalizeRpcBridgeEvent({
    type: "tool_execution_end",
    toolCallId: "call_2",
    toolName: "edit",
    isError: "false",
  }), { kind: "invalid" });
});

test("工具事件携带旧参数或结果字段时闭集校验器按违约拒绝，不再存在预算路径", () => {
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "write",
    origin: "unknown",
    args: { path: "a.ts" },
  }).kind, "invalid");
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "bash",
    origin: "unknown",
    isError: true,
    result: { output: "stdout" },
  }).kind, "invalid");
});

test("活动事件闭集校验器接受合法事件并拒绝违约、未知与超限", () => {
  assert.deepEqual(parseAgentActivityEvent({
    type: "message",
    content: [
      { type: "thinking", thinking: "推理" },
      { type: "text", text: "回复" },
    ],
  }), {
    kind: "event",
    event: {
      type: "message",
      content: [
        { type: "thinking", thinking: "推理" },
        { type: "text", text: "回复" },
      ],
    },
  });
  assert.deepEqual(parseAgentActivityEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "read",
    origin: "pi_native",
  }), {
    kind: "event",
    event: {
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "read",
      origin: "pi_native",
    },
  });
  assert.deepEqual(parseAgentActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "read",
    origin: "unknown",
    isError: true,
  }), {
    kind: "event",
    event: {
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "read",
      origin: "unknown",
      isError: true,
    },
  });
  // 旧契约的原始参数/结果字段不再属于闭集：出现即违约。
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "read",
    origin: "pi_native",
    args: '{"path":"a.ts"}',
  }).kind, "invalid");
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "read",
    origin: "unknown",
    isError: false,
    result: '"ok"',
  }).kind, "invalid");
  // 来源身份是必填闭集字段。
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "read",
  }).kind, "invalid");
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "read",
    origin: "extension",
  }).kind, "invalid");
  // 结束事实自包含状态：isError 缺失或非布尔属于违约。
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "read",
    origin: "unknown",
  }).kind, "invalid");
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "read",
    origin: "unknown",
    isError: "false",
  }).kind, "invalid");
  assert.equal(parseAgentActivityEvent({ type: "agent_start" }).kind, "invalid");
  assert.equal(parseAgentActivityEvent({
    type: "message",
    content: [{ type: "text", text: 1 }],
  }).kind, "invalid");
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_end",
    toolCallId: "",
    toolName: "read",
  }).kind, "invalid");
  // assistant 消息正文聚合不设字节上限；超长正文仍走合法闭集。
  const oversized = parseAgentActivityEvent({
    type: "message",
    content: [{ type: "text", text: "z".repeat(ACTIVITY_MAX_TEXT_BYTES + 1) }],
  });
  assert.equal(oversized.kind, "event");
});
