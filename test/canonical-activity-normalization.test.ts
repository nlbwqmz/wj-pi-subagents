import assert from "node:assert/strict";
import test from "node:test";
import {
  createOwnToolActivityNormalizer,
  createOwnToolActivityNormalizerState,
  normalizeOwnToolActivityEvent,
  normalizeRpcBridgeEvent,
  parseAgentActivityEvent,
  type SafeToolOrigin,
} from "../src/rpc-bridge-event.ts";

function assistantMessage(content: readonly unknown[]): unknown {
  return {
    type: "message_end",
    message: Object.freeze({ role: "assistant", content: Object.freeze(content) }),
  };
}

test("产生端逐块忽略图片、原生工具调用与未知 block", () => {
  const normalized = normalizeRpcBridgeEvent(assistantMessage([
    { type: "text", text: "结论在前" },
    { type: "image", source: "不得跨进程" },
    { type: "toolCall", id: "call_1", arguments: { secret: "不得跨进程" } },
    { type: "future_unknown_block", payload: "不得跨进程" },
    { type: "text", text: "结论在后" },
  ]));
  assert.equal(normalized.kind, "event");
  if (normalized.kind !== "event" || normalized.event.type !== "message") return;
  assert.deepEqual(normalized.event.content, [
    { type: "text", text: "结论在前" },
    { type: "text", text: "结论在后" },
  ]);
});

test("声明为 text/thinking 但结构无效的块被逐块忽略，不吞掉整条消息", () => {
  const normalized = normalizeRpcBridgeEvent(assistantMessage([
    { type: "text", text: 42 },
    { type: "thinking", thinking: { broken: true } },
    { type: "text" },
    { type: "thinking", thinking: "合法思考" },
    { type: "text", text: "合法正文" },
  ]));
  assert.equal(normalized.kind, "event");
  if (normalized.kind !== "event" || normalized.event.type !== "message") return;
  assert.deepEqual(normalized.event.content, [
    { type: "thinking", thinking: "合法思考" },
    { type: "text", text: "合法正文" },
  ]);
});

test("相邻 thinking 合并为同一块，被 text 隔开的 thinking 保持分离", () => {
  const normalized = normalizeRpcBridgeEvent(assistantMessage([
    { type: "thinking", thinking: "第一段思考" },
    { type: "thinking", thinking: "第二段思考" },
    { type: "text", text: "中间结论" },
    { type: "thinking", thinking: "第三段思考" },
    { type: "thinking", thinking: "第四段思考" },
  ]));
  assert.equal(normalized.kind, "event");
  if (normalized.kind !== "event" || normalized.event.type !== "message") return;
  assert.equal(normalized.event.content.length, 3);
  assert.deepEqual(normalized.event.content[0], {
    type: "thinking",
    thinking: "第一段思考\n\n第二段思考",
  });
  assert.deepEqual(normalized.event.content[1], { type: "text", text: "中间结论" });
  assert.deepEqual(normalized.event.content[2], {
    type: "thinking",
    thinking: "第三段思考\n\n第四段思考",
  });
});

test("过滤后无合法块的消息不产生活动事件，也不中断会话", () => {
  assert.equal(normalizeRpcBridgeEvent(assistantMessage([
    { type: "image", source: "x" },
    { type: "toolCall", id: "call_1" },
    { type: "text", text: "" },
  ])).kind, "ignored");
});

test("assistant 消息正文聚合不设置字节上限", () => {
  const large = "报告正文。".repeat(40_000);
  const normalized = normalizeRpcBridgeEvent(assistantMessage([
    { type: "text", text: large },
  ]));
  assert.equal(normalized.kind, "event");
  if (normalized.kind !== "event" || normalized.event.type !== "message") return;
  assert.equal(normalized.event.content.length, 1);
  assert.equal(normalized.event.content[0]?.type, "text");
  assert.equal(normalized.event.content[0]?.text, large);
});

test("活动事件闭集对 message 正文不再按字节拒绝，旧工具字段不属于闭集", () => {
  const large = "x".repeat(64 * 1024);
  const message = parseAgentActivityEvent({
    type: "message",
    content: [{ type: "text", text: large }],
  });
  assert.equal(message.kind, "event");

  // 旧契约的原始参数字段不再是合法活动事件。
  const legacyArgs = parseAgentActivityEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "read",
    origin: "pi_native",
    args: JSON.stringify({ path: "a".repeat(64 * 1024) }),
  });
  assert.equal(legacyArgs.kind, "invalid");
});

test("产生端规范化把非专用工具事实缩减为无载荷状态事实，来源身份随输入传递", () => {
  // 专用摘要只属于 Pi 原生专用工具与本插件的十个创建/消息/等待/控制工具；
  // 闭集外的本插件工具名仍是无载荷状态事实，参数不跨进程。
  assert.deepEqual(normalizeOwnToolActivityEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "future_plugin_tool",
    args: { agent_ids: ["550e8400-e29b-41d4-a716-446655440002"], timeout_ms: 1000 },
  }, "plugin"), {
    kind: "event",
    event: {
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "future_plugin_tool",
      origin: "plugin",
      executionGeneration: 1,
    },
  });
  assert.deepEqual(normalizeOwnToolActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "future_plugin_tool",
    result: { content: [{ type: "text", text: "结果正文不得跨进程" }] },
    isError: false,
  }, "plugin"), {
    kind: "event",
    event: {
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "future_plugin_tool",
      origin: "plugin",
      executionGeneration: 1,
      isError: false,
    },
  });
});

test("产生端规范化宽容未来新增字段并忽略未知载荷", () => {
  assert.deepEqual(normalizeOwnToolActivityEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "grep",
    pattern: "x",
    futureField: { nested: [1, 2, 3] },
    args: "遗留字段",
  }, "plugin"), {
    kind: "event",
    event: {
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "grep",
      origin: "plugin",
      executionGeneration: 1,
    },
  });
});

test("产生端规范化拒绝来源闭集之外的身份与结构违约，但不涉及载荷内容", () => {
  // 来源身份是闭集；无效来源不降级为 unknown，而是拒绝事件。
  assert.equal(normalizeOwnToolActivityEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "read",
  }, "extension" as never).kind, "invalid");
  // 关联身份缺失无法建立条目。
  assert.equal(normalizeOwnToolActivityEvent({
    type: "tool_execution_start",
    toolName: "read",
  }, "unknown").kind, "invalid");
  // 来源不明的合法事实仍按安全兜底产生。
  assert.equal(normalizeOwnToolActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "read",
    isError: false,
  }, "unknown").kind, "event");
  // 结束事实自包含状态：缺少 isError 拒绝。
  assert.equal(normalizeOwnToolActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "read",
  }, "plugin").kind, "invalid");
  assert.equal(normalizeOwnToolActivityEvent({
    type: "tool_execution_update",
    toolCallId: "call_1",
    toolName: "read",
  }, "plugin").kind, "invalid");
});

/** Pi 原生 read 事件的原始形状（参数在 start，正文/详情在 end 的 result）。 */
function readStart(args: unknown): unknown {
  return {
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "read",
    args,
  };
}

function readEnd(result: unknown, isError = false): unknown {
  return {
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "read",
    result,
    isError,
  };
}

function summaryOf(event: { readonly summary?: unknown }): unknown {
  return event.summary;
}

test("read 开始事实保留 path/offset/limit 白名单参数并忽略未来新增字段", () => {
  const normalized = normalizeOwnToolActivityEvent(readStart({
    path: "src/index.ts",
    offset: 5,
    limit: 20,
    encoding: "future-new-field",
  }), "pi_native");
  assert.equal(normalized.kind, "event");
  if (normalized.kind !== "event" || normalized.event.type !== "tool_execution_start") return;
  assert.deepEqual(summaryOf(normalized.event), {
    tool: "read",
    path: "src/index.ts",
    offset: 5,
    limit: 20,
  });
  // 白名单之外的未来字段永不跨进程。
  assert.equal(JSON.stringify(normalized.event).includes("future-new-field"), false);
});

test("read 成功结果只保留截断事实，文件正文与图片数据不跨进程", () => {
  const startArgs = { path: "big.log", offset: 1, limit: 2000 };
  const truncated = normalizeOwnToolActivityEvent(readEnd({
    content: [{ type: "text", text: "文件正文不得跨进程".repeat(1000) }],
    details: {
      truncation: {
        truncated: true,
        truncatedBy: "lines",
        totalLines: 4000,
        outputLines: 2000,
        content: "文件正文也不得进入 details",
      },
    },
  }), "pi_native", startArgs);
  assert.equal(truncated.kind, "event");
  if (truncated.kind !== "event" || truncated.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(truncated.event), {
    tool: "read",
    path: "big.log",
    offset: 1,
    limit: 2000,
    truncated: true,
    truncatedBy: "lines",
  });
  const serialized = JSON.stringify(truncated.event);
  assert.equal(serialized.includes("文件正文不得跨进程"), false);
  assert.equal(serialized.includes("details"), false);

  // 完整读取（无截断）：不附带成功事实。
  const complete = normalizeOwnToolActivityEvent(readEnd({
    content: [{ type: "text", text: "正文" }],
    details: undefined,
  }), "pi_native", startArgs);
  assert.equal(complete.kind, "event");
  if (complete.kind !== "event" || complete.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(complete.event), {
    tool: "read",
    path: "big.log",
    offset: 1,
    limit: 2000,
  });

  // 图片结果：二进制数据不进入事件，也不产生成功侧事实。
  const image = normalizeOwnToolActivityEvent(readEnd({
    content: [
      { type: "text", text: "Read image file [image/png]" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ],
  }), "pi_native", startArgs);
  assert.equal(image.kind, "event");
  if (image.kind !== "event" || image.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(image.event), {
    tool: "read",
    path: "big.log",
    offset: 1,
    limit: 2000,
  });
  const imageSerialized = JSON.stringify(image.event);
  assert.equal(imageSerialized.includes("aGVsbG8="), false);
  assert.equal(imageSerialized.includes("image"), false);
});

test("read 失败事实保留全部输入参数与净化后的完整错误正文，不附带成功侧统计", () => {
  const normalized = normalizeOwnToolActivityEvent(readEnd({
    content: [{ type: "text", text: "Offset 9000 is beyond end of file (12 lines total)" }],
    details: {},
  }, true), "pi_native", { path: "src/index.ts", offset: 9000 });
  assert.equal(normalized.kind, "event");
  if (normalized.kind !== "event" || normalized.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(normalized.event), {
    tool: "read",
    path: "src/index.ts",
    offset: 9000,
  });
  assert.equal(normalized.event.errorText, "Offset 9000 is beyond end of file (12 lines total)");
  // 失败事实不附带截断等成功侧统计。
  assert.equal(JSON.stringify(normalized.event).includes("truncated"), false);
});

test("grep 保留全部非默认搜索条件，未提供 path 时默认为 .", () => {
  const start = normalizeOwnToolActivityEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "grep",
    args: { pattern: "TODO|FIXME", glob: "*.ts", ignoreCase: true, context: 2, limit: 50 },
  }, "pi_native");
  assert.equal(start.kind, "event");
  if (start.kind !== "event" || start.event.type !== "tool_execution_start") return;
  assert.deepEqual(summaryOf(start.event), {
    tool: "grep",
    pattern: "TODO|FIXME",
    path: ".",
    glob: "*.ts",
    ignoreCase: true,
    context: 2,
    limit: 50,
  });

  // 默认值（ignoreCase:false、literal:false、context:0、limit:100）不携带。
  const defaults = normalizeOwnToolActivityEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "grep",
    args: { pattern: "x", ignoreCase: false, literal: false, context: 0, limit: 100 },
  }, "pi_native");
  assert.equal(defaults.kind, "event");
  if (defaults.kind !== "event" || defaults.event.type !== "tool_execution_start") return;
  assert.deepEqual(summaryOf(defaults.event), { tool: "grep", pattern: "x", path: "." });
});

test("grep 成功事实只保留无匹配/达到限制/截断/长行截断，匹配正文不跨进程", () => {
  const startArgs = { pattern: "secret", path: "src" };
  const noMatches = normalizeOwnToolActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "grep",
    result: { content: [{ type: "text", text: "No matches found" }], details: undefined },
    isError: false,
  }, "pi_native", startArgs);
  assert.equal(noMatches.kind, "event");
  if (noMatches.kind !== "event" || noMatches.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(noMatches.event), {
    tool: "grep",
    pattern: "secret",
    path: "src",
    noMatches: true,
  });

  const limited = normalizeOwnToolActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "grep",
    result: {
      content: [{ type: "text", text: "src/a.ts:1: 匹配正文不得跨进程" }],
      details: { matchLimitReached: 100, linesTruncated: true, truncation: { truncated: true, truncatedBy: "bytes" } },
    },
    isError: false,
  }, "pi_native", startArgs);
  assert.equal(limited.kind, "event");
  if (limited.kind !== "event" || limited.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(limited.event), {
    tool: "grep",
    pattern: "secret",
    path: "src",
    matchLimitReached: 100,
    truncated: true,
    truncatedBy: "bytes",
    linesTruncated: true,
  });
  assert.equal(JSON.stringify(limited.event).includes("匹配正文"), false);
});

test("find 保留 pattern/path/非默认 limit，成功事实不含命中路径列表", () => {
  const start = normalizeOwnToolActivityEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "find",
    args: { pattern: "**/*.spec.ts", limit: 500 },
  }, "pi_native");
  assert.equal(start.kind, "event");
  if (start.kind !== "event" || start.event.type !== "tool_execution_start") return;
  assert.deepEqual(summaryOf(start.event), {
    tool: "find",
    pattern: "**/*.spec.ts",
    path: ".",
    limit: 500,
  });

  const startArgs = { pattern: "*.ts", path: "src" };
  const noFiles = normalizeOwnToolActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "find",
    result: { content: [{ type: "text", text: "No files found matching pattern" }], details: undefined },
    isError: false,
  }, "pi_native", startArgs);
  assert.equal(noFiles.kind, "event");
  if (noFiles.kind !== "event" || noFiles.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(noFiles.event), {
    tool: "find",
    pattern: "*.ts",
    path: "src",
    noFiles: true,
  });

  const hit = normalizeOwnToolActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "find",
    result: {
      content: [{ type: "text", text: "a.ts\nb.ts\n命中路径列表不得跨进程" }],
      details: { resultLimitReached: 1000, truncation: { truncated: true, truncatedBy: "bytes" } },
    },
    isError: false,
  }, "pi_native", startArgs);
  assert.equal(hit.kind, "event");
  if (hit.kind !== "event" || hit.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(hit.event), {
    tool: "find",
    pattern: "*.ts",
    path: "src",
    resultLimitReached: 1000,
    truncated: true,
    truncatedBy: "bytes",
  });
  assert.equal(JSON.stringify(hit.event).includes("b.ts"), false);
});

test("ls 保留 path/非默认 limit，成功事实不含目录条目", () => {
  const start = normalizeOwnToolActivityEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "ls",
    args: { path: "src", limit: 100 },
  }, "pi_native");
  assert.equal(start.kind, "event");
  if (start.kind !== "event" || start.event.type !== "tool_execution_start") return;
  assert.deepEqual(summaryOf(start.event), { tool: "ls", path: "src", limit: 100 });

  const startArgs = { path: "empty-dir" };
  const empty = normalizeOwnToolActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "ls",
    result: { content: [{ type: "text", text: "(empty directory)" }], details: undefined },
    isError: false,
  }, "pi_native", startArgs);
  assert.equal(empty.kind, "event");
  if (empty.kind !== "event" || empty.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(empty.event), {
    tool: "ls",
    path: "empty-dir",
    emptyDirectory: true,
  });

  const listed = normalizeOwnToolActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "ls",
    result: {
      content: [{ type: "text", text: "a/\nb.ts\n目录条目不得跨进程" }],
      details: { entryLimitReached: 500, truncation: { truncated: true, truncatedBy: "bytes" } },
    },
    isError: false,
  }, "pi_native", startArgs);
  assert.equal(listed.kind, "event");
  if (listed.kind !== "event" || listed.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(listed.event), {
    tool: "ls",
    path: "empty-dir",
    entryLimitReached: 500,
    truncated: true,
    truncatedBy: "bytes",
  });
  assert.equal(JSON.stringify(listed.event).includes("b.ts"), false);
});

test("grep/find/ls 失败时保留全部输入参数与错误正文，不附带成功侧统计", () => {
  const cases: readonly {
    readonly toolName: string;
    readonly startArgs: unknown;
    readonly expectedSummary: unknown;
  }[] = [
    {
      toolName: "grep",
      startArgs: { pattern: "x", path: "src", ignoreCase: true },
      expectedSummary: { tool: "grep", pattern: "x", path: "src", ignoreCase: true },
    },
    {
      toolName: "find",
      startArgs: { pattern: "*.ts", path: "src", limit: 10 },
      expectedSummary: { tool: "find", pattern: "*.ts", path: "src", limit: 10 },
    },
    {
      toolName: "ls",
      startArgs: { path: "missing" },
      expectedSummary: { tool: "ls", path: "missing" },
    },
  ];
  for (const item of cases) {
    const normalized = normalizeOwnToolActivityEvent({
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: item.toolName,
      result: { content: [{ type: "text", text: "Path not found: missing" }] },
      isError: true,
    }, "pi_native", item.startArgs);
    assert.equal(normalized.kind, "event", item.toolName);
    if (normalized.kind !== "event" || normalized.event.type !== "tool_execution_end") continue;
    assert.deepEqual(summaryOf(normalized.event), item.expectedSummary, item.toolName);
    assert.equal(normalized.event.errorText, "Path not found: missing", item.toolName);
    assert.equal(
      JSON.stringify(normalized.event).match(/noMatches|noFiles|emptyDirectory|truncated|LimitReached/g)?.length ?? 0,
      0,
      item.toolName,
    );
  }
});

test("read 用户 limit 提前停止但文件尚有更多行时保留不完整事实", () => {
  // Pi 在该场景不写 details，不完整事实只出现在结果正文的已知 continuation 文案中。
  const startArgs = { path: "big.log", limit: 100 };
  const normalized = normalizeOwnToolActivityEvent(readEnd({
    content: [{ type: "text", text: "正文\n\n[100 more lines in file. Use offset=101 to continue.]" }],
    details: undefined,
  }), "pi_native", startArgs);
  assert.equal(normalized.kind, "event");
  if (normalized.kind !== "event" || normalized.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(normalized.event), {
    tool: "read",
    path: "big.log",
    limit: 100,
    hasMoreLines: true,
  });
  // 正文与 continuation 文案本身都不跨进程。
  const serialized = JSON.stringify(normalized.event);
  assert.equal(serialized.includes("正文"), false);
  assert.equal(serialized.includes("more lines in file"), false);

  // 完整读取与被截断读取不携带该事实。
  const complete = normalizeOwnToolActivityEvent(readEnd({
    content: [{ type: "text", text: "正文" }],
  }), "pi_native", startArgs);
  assert.equal(complete.kind, "event");
  if (complete.kind !== "event" || complete.event.type !== "tool_execution_end") return;
  assert.equal((summaryOf(complete.event) as { hasMoreLines?: boolean }).hasMoreLines, undefined);
});

test("错误正文在产生端过滤 ANSI 与危险终端控制字符并保留换行", () => {
  const normalized = normalizeOwnToolActivityEvent(readEnd({
    content: [{ type: "text", text: "first\x1b[31m-red\x1b[0m\nsecond\u0007 bell\r\nthird\u202e override" }],
  }, true), "pi_native", { path: "a.txt" });
  assert.equal(normalized.kind, "event");
  if (normalized.kind !== "event" || normalized.event.type !== "tool_execution_end") return;
  assert.equal(normalized.event.errorText, "first-red\nsecond  bell\nthird  override");
});

test("缺少必需字段或类型错误的专用调用完整降级为安全兜底", () => {
  const cases: readonly {
    readonly toolName: string;
    readonly startArgs: unknown;
  }[] = [
    { toolName: "read", startArgs: { offset: 1 } },
    { toolName: "read", startArgs: { path: 42 } },
    { toolName: "grep", startArgs: { path: "src" } },
    { toolName: "grep", startArgs: { pattern: null } },
    { toolName: "find", startArgs: {} },
    { toolName: "ls", startArgs: { path: { nested: true } } },
  ];
  for (const item of cases) {
    const start = normalizeOwnToolActivityEvent({
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: item.toolName,
      args: item.startArgs,
    }, "pi_native");
    assert.equal(start.kind, "event", item.toolName);
    if (start.kind !== "event" || start.event.type !== "tool_execution_start") continue;
    assert.equal(start.event.summary, undefined, item.toolName);

    const end = normalizeOwnToolActivityEvent({
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: item.toolName,
      result: { content: [{ type: "text", text: "anything" }] },
      isError: false,
    }, "pi_native", item.startArgs);
    assert.equal(end.kind, "event", item.toolName);
    if (end.kind !== "event" || end.event.type !== "tool_execution_end") continue;
    assert.equal(end.event.summary, undefined, item.toolName);
  }

  // args 整体缺失（非 record）同样降级。
  const missing = normalizeOwnToolActivityEvent(readStart(undefined), "pi_native");
  assert.equal(missing.kind, "event");
  if (missing.kind !== "event" || missing.event.type !== "tool_execution_start") return;
  assert.equal(missing.event.summary, undefined);
});

test("任何已知字段存在但类型错误时完整降级为安全兜底", () => {
  const start = normalizeOwnToolActivityEvent(readStart({ path: "a.txt", offset: "5", limit: true }), "pi_native");
  assert.equal(start.kind, "event");
  if (start.kind !== "event" || start.event.type !== "tool_execution_start") return;
  assert.equal(start.event.summary, undefined);
});

test("同名覆盖降级：非 pi_native 来源的四种工具不产生专用摘要", () => {
  const start = normalizeOwnToolActivityEvent(readStart({ path: "a.txt" }), "unknown");
  assert.equal(start.kind, "event");
  if (start.kind !== "event" || start.event.type !== "tool_execution_start") return;
  assert.equal(start.event.summary, undefined);

  const end = normalizeOwnToolActivityEvent(readEnd({
    content: [{ type: "text", text: "覆盖实现的错误正文不得跨进程" }],
  }, true), "unknown");
  assert.equal(end.kind, "event");
  if (end.kind !== "event" || end.event.type !== "tool_execution_end") return;
  assert.equal(end.event.summary, undefined);
  assert.equal(end.event.errorText, undefined);
});

test("结束事实缺少缓存的开始参数时降级为无摘要兜底", () => {
  const normalized = normalizeOwnToolActivityEvent(readEnd({
    content: [{ type: "text", text: "正文" }],
  }), "pi_native");
  assert.equal(normalized.kind, "event");
  if (normalized.kind !== "event" || normalized.event.type !== "tool_execution_end") return;
  assert.equal(normalized.event.summary, undefined);
  assert.equal(normalized.event.errorText, undefined);
});

test("运行时规范化器缓存开始参数供结束事实自包含，并保持有界与幂等", () => {
  const resolveOrigin = (toolName: string): SafeToolOrigin =>
    ["read", "grep", "find", "ls"].includes(toolName) ? "pi_native" : "unknown";
  const normalize = createOwnToolActivityNormalizer(resolveOrigin);

  const start = normalize({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "read",
    args: { path: "a.txt", offset: 2 },
  });
  assert.equal(start.kind, "event");
  if (start.kind !== "event" || start.event.type !== "tool_execution_start") return;
  assert.deepEqual(summaryOf(start.event), { tool: "read", path: "a.txt", offset: 2 });

  // 同 ID 结束事实自包含开始参数；缓存随即清空。
  const end = normalize({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "read",
    result: { content: [{ type: "text", text: "正文" }] },
    isError: false,
  });
  assert.equal(end.kind, "event");
  if (end.kind !== "event" || end.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(end.event), { tool: "read", path: "a.txt", offset: 2 });

  // 缓存已清空：同 ID 二次结束降级为无摘要兜底。
  const repeated = normalize({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "read",
    result: { content: [{ type: "text", text: "正文" }] },
    isError: false,
  });
  assert.equal(repeated.kind, "event");
  if (repeated.kind !== "event" || repeated.event.type !== "tool_execution_end") return;
  assert.equal(repeated.event.summary, undefined);

  // 重复开始覆盖旧参数：新参数进入后续结束事实。
  normalize({
    type: "tool_execution_start",
    toolCallId: "call_2",
    toolName: "ls",
    args: { path: "old-dir" },
  });
  normalize({
    type: "tool_execution_start",
    toolCallId: "call_2",
    toolName: "ls",
    args: { path: "new-dir" },
  });
  const overwritten = normalize({
    type: "tool_execution_end",
    toolCallId: "call_2",
    toolName: "ls",
    result: { content: [{ type: "text", text: "(empty directory)" }] },
    isError: false,
  });
  assert.equal(overwritten.kind, "event");
  if (overwritten.kind !== "event" || overwritten.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(overwritten.event), {
    tool: "ls",
    path: "new-dir",
    emptyDirectory: true,
  });

  // 容量上限：256 个待决条目，溢出时插入第 257 个淘汰最早；被淘汰的
  // 开始参数降级。
  for (let index = 0; index < 256; index += 1) {
    normalize({
      type: "tool_execution_start",
      toolCallId: `bulk_${index}`,
      toolName: "read",
      args: { path: `bulk_${index}.txt` },
    });
  }
  // 溢出时插入的新开始淘汰最早的 bulk_0。
  normalize({
    type: "tool_execution_start",
    toolCallId: "bulk_new",
    toolName: "read",
    args: { path: "new.txt" },
  });
  const evicted = normalize({
    type: "tool_execution_end",
    toolCallId: "bulk_0",
    toolName: "read",
    result: { content: [{ type: "text", text: "正文" }] },
    isError: false,
  });
  assert.equal(evicted.kind, "event");
  if (evicted.kind !== "event" || evicted.event.type !== "tool_execution_end") return;
  assert.equal(evicted.event.summary, undefined);

  // 溢出时插入的新开始仍然可用。
  const kept = normalize({
    type: "tool_execution_end",
    toolCallId: "bulk_new",
    toolName: "read",
    result: { content: [{ type: "text", text: "正文" }] },
    isError: false,
  });
  assert.equal(kept.kind, "event");
  if (kept.kind !== "event" || kept.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(kept.event), { tool: "read", path: "new.txt" });
});

test("工具执行代次在同一 toolCallId 复用时递增，并让 start/end 共享对应代次", () => {
  const normalize = createOwnToolActivityNormalizer(() => "unknown");
  const start1 = normalize({
    type: "tool_execution_start",
    toolCallId: "reused-call",
    toolName: "custom_tool",
  });
  const end1 = normalize({
    type: "tool_execution_end",
    toolCallId: "reused-call",
    toolName: "custom_tool",
    isError: false,
  });
  const start2 = normalize({
    type: "tool_execution_start",
    toolCallId: "reused-call",
    toolName: "custom_tool",
  });
  const end2 = normalize({
    type: "tool_execution_end",
    toolCallId: "reused-call",
    toolName: "custom_tool",
    isError: true,
  });
  for (const result of [start1, end1, start2, end2]) assert.equal(result.kind, "event");
  if (
    start1.kind !== "event"
    || end1.kind !== "event"
    || start2.kind !== "event"
    || end2.kind !== "event"
  ) return;
  assert.equal(start1.event.type, "tool_execution_start");
  assert.equal(end1.event.type, "tool_execution_end");
  assert.equal(start2.event.type, "tool_execution_start");
  assert.equal(end2.event.type, "tool_execution_end");
  assert.equal(start1.event.executionGeneration, 1);
  assert.equal(end1.event.executionGeneration, 1);
  assert.equal(start2.event.executionGeneration, 2);
  assert.equal(end2.event.executionGeneration, 2);
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_start",
    toolCallId: "bad-generation",
    toolName: "custom_tool",
    origin: "unknown",
    executionGeneration: 0,
  }).kind, "invalid");
});


test("显式复用同一 normalizer 状态时保留代次与待决参数", () => {
  const state = createOwnToolActivityNormalizerState();
  const resolveOrigin = (toolName: string): SafeToolOrigin =>
    toolName === "read" ? "pi_native" : "unknown";
  const first = createOwnToolActivityNormalizer(resolveOrigin, undefined, state);

  // 第一代完成后，第二代开始持有新的输入参数；显式把同一 state 交给
  // 新 normalizer 时，它仍属于同一观察代际，结束事实应读取该状态。
  const start1 = first({
    type: "tool_execution_start",
    toolCallId: "reload-call",
    toolName: "read",
    args: { path: "one.txt" },
  });
  const end1 = first({
    type: "tool_execution_end",
    toolCallId: "reload-call",
    toolName: "read",
    isError: false,
    result: { content: [{ type: "text", text: "one" }] },
  });
  const start2 = first({
    type: "tool_execution_start",
    toolCallId: "reload-call",
    toolName: "read",
    args: { path: "two.txt" },
  });
  assert.equal(start1.kind, "event");
  assert.equal(end1.kind, "event");
  if (start2.kind !== "event" || start2.event.type !== "tool_execution_start") return;
  assert.equal(start2.event.executionGeneration, 2);

  const continued = createOwnToolActivityNormalizer(resolveOrigin, undefined, state);
  const end2 = continued({
    type: "tool_execution_end",
    toolCallId: "reload-call",
    toolName: "read",
    isError: false,
    result: { content: [{ type: "text", text: "two" }] },
  });
  assert.equal(end2.kind, "event");
  if (end2.kind !== "event" || end2.event.type !== "tool_execution_end") return;
  assert.equal(end2.event.executionGeneration, 2);
  assert.deepEqual(summaryOf(end2.event), { tool: "read", path: "two.txt" });

  // 256 个其它 ID 不应淘汰 reload-call 的代次账本；再次复用必须是第 3 代。
  for (let index = 0; index < 256; index += 1) {
    continued({
      type: "tool_execution_start",
      toolCallId: `long-session-${index}`,
      toolName: "custom_tool",
    });
  }
  const start3 = continued({
    type: "tool_execution_start",
    toolCallId: "reload-call",
    toolName: "read",
    args: { path: "three.txt" },
  });
  assert.equal(start3.kind, "event");
  if (start3.kind !== "event" || start3.event.type !== "tool_execution_start") return;
  assert.equal(start3.event.executionGeneration, 3);
});
test("规范化器忽略迟到显式旧代次对最新代次账本的回退", () => {
  const normalize = createOwnToolActivityNormalizer(() => "unknown");
  const start2 = normalize({
    type: "tool_execution_start",
    toolCallId: "monotonic-call",
    toolName: "custom_tool",
    executionGeneration: 2,
  });
  assert.equal(start2.kind, "event");
  const staleEnd = normalize({
    type: "tool_execution_end",
    toolCallId: "monotonic-call",
    toolName: "custom_tool",
    executionGeneration: 1,
    isError: false,
  });
  assert.equal(staleEnd.kind, "event");
  const repeatedStart2 = normalize({
    type: "tool_execution_start",
    toolCallId: "monotonic-call",
    toolName: "custom_tool",
  });
  assert.equal(repeatedStart2.kind, "event");
  if (repeatedStart2.kind !== "event" || repeatedStart2.event.type !== "tool_execution_start") return;
  assert.equal(repeatedStart2.event.executionGeneration, 2);
  const end2 = normalize({
    type: "tool_execution_end",
    toolCallId: "monotonic-call",
    toolName: "custom_tool",
    isError: false,
  });
  assert.equal(end2.kind, "event");
  if (end2.kind !== "event" || end2.event.type !== "tool_execution_end") return;
  assert.equal(end2.event.executionGeneration, 2);
  const start3 = normalize({
    type: "tool_execution_start",
    toolCallId: "monotonic-call",
    toolName: "custom_tool",
  });
  assert.equal(start3.kind, "event");
  if (start3.kind !== "event" || start3.event.type !== "tool_execution_start") return;
  assert.equal(start3.event.executionGeneration, 3);

  // 结构非法的 start 不应消耗下一代。
  const invalid = normalize({
    type: "tool_execution_start",
    toolCallId: "invalid-call",
    toolName: 42,
  });
  assert.equal(invalid.kind, "invalid");
  const valid = normalize({
    type: "tool_execution_start",
    toolCallId: "invalid-call",
    toolName: "custom_tool",
  });
  assert.equal(valid.kind, "event");
  if (valid.kind !== "event" || valid.event.type !== "tool_execution_start") return;
  assert.equal(valid.event.executionGeneration, 1);
});
test("活动事件闭集只允许专用工具携带摘要与错误正文，结构违约判 invalid", () => {
  // 专用摘要出现在未知来源事件上属于协议违约。
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "read",
    origin: "unknown",
    summary: { tool: "read", path: "a.txt" },
  }).kind, "invalid");
  // summary.tool 与 toolName 不一致属于违约。
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "grep",
    origin: "pi_native",
    summary: { tool: "read", path: "a.txt" },
  }).kind, "invalid");
  // 摘要结构违约（缺必需字段）判 invalid。
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "read",
    origin: "pi_native",
    summary: { tool: "read" },
  }).kind, "invalid");
  // errorText 只允许出现在失败事实中。
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "read",
    origin: "pi_native",
    isError: false,
    errorText: "不得在成功事实出现",
  }).kind, "invalid");
  // errorText 只允许 Pi 原生专用工具携带。
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "spawn_agent",
    origin: "plugin",
    isError: true,
    errorText: "插件工具错误正文不进闭集",
  }).kind, "invalid");
  // 合法组合仍为 event。
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "ls",
    origin: "pi_native",
    isError: true,
    summary: { tool: "ls", path: "." },
    errorText: "Path not found",
  }).kind, "event");
});

/** Pi 原生 write/edit/bash 事件的原始形状（参数在 start，结果在 end）。 */
function mutationStart(toolName: string, args: unknown): unknown {
  return {
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName,
    args,
  };
}

function mutationEnd(toolName: string, result: unknown, isError = false): unknown {
  return {
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName,
    result,
    isError,
  };
}

test("write 开始事实只保留 path，写入正文与未来字段永不跨进程", () => {
  const normalized = normalizeOwnToolActivityEvent(mutationStart("write", {
    path: "out/result.md",
    content: "机密正文不得跨进程",
    futureField: { nested: [1, 2, 3] },
  }), "pi_native");
  assert.equal(normalized.kind, "event");
  if (normalized.kind !== "event" || normalized.event.type !== "tool_execution_start") return;
  assert.deepEqual(summaryOf(normalized.event), { tool: "write", path: "out/result.md" });
  const serialized = JSON.stringify(normalized.event);
  assert.equal(serialized.includes("机密正文"), false);
  assert.equal(serialized.includes("futureField"), false);
});

test("write 成功与失败摘要都只显示 path，写入统计不进入闭集", () => {
  const startArgs = { path: "out/result.md", content: "line1\nline2\nline3" };
  // 成功：行数、UTF-8 字节大小等任何写入统计都不携带；成功结果正文不跨进程。
  const success = normalizeOwnToolActivityEvent(mutationEnd("write", {
    content: [{ type: "text", text: "Successfully wrote to out/result.md" }],
    details: undefined,
  }), "pi_native", startArgs);
  assert.equal(success.kind, "event");
  if (success.kind !== "event" || success.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(success.event), { tool: "write", path: "out/result.md" });
  const serialized = JSON.stringify(success.event);
  assert.equal(serialized.includes("Successfully wrote"), false);
  assert.equal(serialized.includes("line1"), false);
  assert.equal(serialized.includes("lines"), false);
  assert.equal(serialized.includes("bytes"), false);

  // 失败：同样只显示 path，不显示未发生写入的统计；错误正文可携带。
  const failure = normalizeOwnToolActivityEvent(mutationEnd("write", {
    content: [{ type: "text", text: "Error: EACCES: permission denied, open '/etc/hosts'" }],
  }, true), "pi_native", { path: "/etc/hosts", content: "irrelevant" });
  assert.equal(failure.kind, "event");
  if (failure.kind !== "event" || failure.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(failure.event), { tool: "write", path: "/etc/hosts" });
  assert.equal(
    failure.event.errorText,
    "Error: EACCES: permission denied, open '/etc/hosts'",
  );
  assert.equal(JSON.stringify(failure.event).includes("lines"), false);
});

test("edit 成功与失败摘要都只显示 path，替换正文与 diff/patch 不跨进程", () => {
  const startArgs = {
    path: "src/a.ts",
    edits: [
      { oldText: "机密旧文本不得跨进程", newText: "新文本也不得跨进程" },
      { oldText: "second", newText: "second-new" },
    ],
  };
  // 成功：edits 数量、diff、patch、首个修改行都不携带；成功结果正文不跨进程。
  const success = normalizeOwnToolActivityEvent(mutationEnd("edit", {
    content: [{ type: "text", text: "Successfully replaced 2 block(s) in src/a.ts." }],
    details: {
      diff: "diff 正文不得跨进程",
      patch: "patch 不得跨进程",
      firstChangedLine: "首修改行不得跨进程",
    },
  }), "pi_native", startArgs);
  assert.equal(success.kind, "event");
  if (success.kind !== "event" || success.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(success.event), { tool: "edit", path: "src/a.ts" });
  const serialized = JSON.stringify(success.event);
  assert.equal(serialized.includes("机密旧文本"), false);
  assert.equal(serialized.includes("新文本也不得"), false);
  assert.equal(serialized.includes("diff"), false);
  assert.equal(serialized.includes("patch"), false);
  assert.equal(serialized.includes("firstChangedLine"), false);
  assert.equal(serialized.includes("edits"), false);

  // 失败：只显示 path，不显示编辑块数；错误正文可携带。
  const failure = normalizeOwnToolActivityEvent(mutationEnd("edit", {
    content: [{ type: "text", text: "Could not find unique text to replace in src/a.ts." }],
  }, true), "pi_native", startArgs);
  assert.equal(failure.kind, "event");
  if (failure.kind !== "event" || failure.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(failure.event), { tool: "edit", path: "src/a.ts" });
  assert.equal(
    failure.event.errorText,
    "Could not find unique text to replace in src/a.ts.",
  );
  assert.equal(JSON.stringify(failure.event).includes("edits"), false);
});

test("bash 与 powershell 摘要保留完整 command 与非默认 timeout，输出与错误正文不进闭集", () => {
  for (const toolName of ["bash", "powershell"] as const) {
    const start = normalizeOwnToolActivityEvent(mutationStart(toolName, {
      command: "echo hello",
      timeout: 5,
    }), "pi_native");
    assert.equal(start.kind, "event", toolName);
    if (start.kind !== "event" || start.event.type !== "tool_execution_start") continue;
    assert.deepEqual(
      summaryOf(start.event),
      { tool: toolName, command: "echo hello", timeout: 5 },
      toolName,
    );

    // 成功：stdout、truncation 详情与临时输出路径全部不跨进程；无 errorText。
    const success = normalizeOwnToolActivityEvent(mutationEnd(toolName, {
      content: [{ type: "text", text: "hello\n命令输出不得跨进程" }],
      details: {
        truncation: { truncated: true, truncatedBy: "lines" },
        fullOutputPath: "/tmp/pi-bash-temp",
      },
    }), "pi_native", { command: "echo hello", timeout: 5 });
    assert.equal(success.kind, "event", toolName);
    if (success.kind !== "event" || success.event.type !== "tool_execution_end") continue;
    assert.deepEqual(
      summaryOf(success.event),
      { tool: toolName, command: "echo hello", timeout: 5 },
      toolName,
    );
    assert.equal(success.event.errorText, undefined, toolName);
    const serialized = JSON.stringify(success.event);
    assert.equal(serialized.includes("命令输出"), false, toolName);
    assert.equal(serialized.includes("/tmp/pi-bash-temp"), false, toolName);

    // 失败（退出码、超时或取消）：摘要不变，异常正文不进入事件。
    const failure = normalizeOwnToolActivityEvent(mutationEnd(toolName, {
      content: [{ type: "text", text: "hello\n\nCommand exited with code 1" }],
    }, true), "pi_native", { command: "echo hello", timeout: 5 });
    assert.equal(failure.kind, "event", toolName);
    if (failure.kind !== "event" || failure.event.type !== "tool_execution_end") continue;
    assert.deepEqual(
      summaryOf(failure.event),
      { tool: toolName, command: "echo hello", timeout: 5 },
      toolName,
    );
    assert.equal(failure.event.errorText, undefined, toolName);
    assert.equal(JSON.stringify(failure.event).includes("exited with code"), false, toolName);
  }

  // 未提供 timeout 时不携带该字段。
  const noTimeout = normalizeOwnToolActivityEvent(mutationStart("bash", { command: "ls" }), "pi_native");
  assert.equal(noTimeout.kind, "event");
  if (noTimeout.kind !== "event" || noTimeout.event.type !== "tool_execution_start") return;
  assert.deepEqual(summaryOf(noTimeout.event), { tool: "bash", command: "ls" });
});

test("bash timeout 值域偏离只导致字段不携带，不降级为兜底", () => {
  const start = normalizeOwnToolActivityEvent(
    mutationStart("bash", { command: "ls", timeout: -5 }),
    "pi_native",
  );
  assert.equal(start.kind, "event");
  if (start.kind !== "event" || start.event.type !== "tool_execution_start") return;
  assert.deepEqual(summaryOf(start.event), { tool: "bash", command: "ls" });
});

test("命令正文的控制字符在产生端净化且保留多行结构", () => {
  const normalized = normalizeOwnToolActivityEvent(mutationStart("bash", {
    command: "echo \u001b[31m-red\u001b[0m\nsecond\u0007 bell\r\nthird\u202e override",
  }), "pi_native");
  assert.equal(normalized.kind, "event");
  if (normalized.kind !== "event" || normalized.event.type !== "tool_execution_start") return;
  assert.deepEqual(summaryOf(normalized.event), {
    tool: "bash",
    command: "echo -red\nsecond  bell\nthird  override",
  });
});

test("32 KB 以内的 shell command 原样保留，不附加任何截断标记", () => {
  const command = Array.from({ length: 2000 }, (_, index) => `echo line-${index}`).join("\n");
  assert.ok(Buffer.byteLength(command, "utf8") < 32 * 1024);
  const normalized = normalizeOwnToolActivityEvent(
    mutationStart("bash", { command }),
    "pi_native",
  );
  assert.equal(normalized.kind, "event");
  if (normalized.kind !== "event" || normalized.event.type !== "tool_execution_start") return;
  assert.deepEqual(summaryOf(normalized.event), { tool: "bash", command });
});

test("超过 32 KB 的 shell command 按行截断，标记携带原文总行数", () => {
  const lines = Array.from({ length: 4000 }, (_, index) => `echo line-${index}`);
  const command = lines.join("\n");
  assert.ok(Buffer.byteLength(command, "utf8") > 32 * 1024);
  const normalized = normalizeOwnToolActivityEvent(
    mutationStart("powershell", { command }),
    "pi_native",
  );
  assert.equal(normalized.kind, "event");
  if (normalized.kind !== "event" || normalized.event.type !== "tool_execution_start") return;
  const summary = summaryOf(normalized.event) as { readonly command: string };
  assert.ok(Buffer.byteLength(summary.command, "utf8") <= 32 * 1024);
  assert.match(summary.command, /\n…（已截断，原文共 4000 行）$/u);
  // 保留部分必须是完整行序列，不得出现半行。
  const kept = summary.command.replace(/\n…（已截断，原文共 4000 行）$/u, "");
  assert.deepEqual(kept.split("\n"), lines.slice(0, kept.split("\n").length));
});

test("单行超过 32 KB 时按字节兜底截断，标记同样携带原文行数", () => {
  const command = "x".repeat(40 * 1024);
  const normalized = normalizeOwnToolActivityEvent(
    mutationStart("bash", { command }),
    "pi_native",
  );
  assert.equal(normalized.kind, "event");
  if (normalized.kind !== "event" || normalized.event.type !== "tool_execution_start") return;
  const summary = summaryOf(normalized.event) as { readonly command: string };
  assert.ok(Buffer.byteLength(summary.command, "utf8") <= 32 * 1024);
  assert.match(summary.command, /\n…（已截断，原文共 1 行）$/u);
  const kept = summary.command.replace(/\n…（已截断，原文共 1 行）$/u, "");
  assert.ok(command.startsWith(kept));
});

test("字节兜底截断不切断多字节字符，也不引入替换字符", () => {
  const command = "中".repeat(20 * 1024);
  const normalized = normalizeOwnToolActivityEvent(
    mutationStart("bash", { command }),
    "pi_native",
  );
  assert.equal(normalized.kind, "event");
  if (normalized.kind !== "event" || normalized.event.type !== "tool_execution_start") return;
  const summary = summaryOf(normalized.event) as { readonly command: string };
  assert.ok(Buffer.byteLength(summary.command, "utf8") <= 32 * 1024);
  const kept = summary.command.replace(/\n…（已截断，原文共 1 行）$/u, "");
  assert.ok(command.startsWith(kept));
  assert.equal(kept.includes("\ufffd"), false);
  assert.ok(kept.length > 0);
});

test("write/edit/bash/powershell 必需字段缺失或类型错误时完整降级为安全兜底", () => {
  const cases: readonly {
    readonly toolName: string;
    readonly startArgs: unknown;
  }[] = [
    { toolName: "write", startArgs: { content: "x" } },
    { toolName: "write", startArgs: { path: "a.txt" } },
    { toolName: "write", startArgs: { path: 42, content: "x" } },
    { toolName: "write", startArgs: { path: "a.txt", content: 42 } },
    { toolName: "edit", startArgs: { path: "a.ts" } },
    { toolName: "edit", startArgs: { path: "a.ts", edits: "not-array" } },
    { toolName: "edit", startArgs: { path: "a.ts", edits: [{ oldText: "x" }] } },
    { toolName: "edit", startArgs: { path: "a.ts", edits: [{ oldText: "x", newText: "y" }, "junk"] } },
    { toolName: "bash", startArgs: { timeout: 5 } },
    { toolName: "bash", startArgs: { command: 42 } },
    { toolName: "bash", startArgs: { command: "ls", timeout: "5" } },
    { toolName: "powershell", startArgs: {} },
  ];
  for (const item of cases) {
    const start = normalizeOwnToolActivityEvent({
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: item.toolName,
      args: item.startArgs,
    }, "pi_native");
    assert.equal(start.kind, "event", item.toolName);
    if (start.kind !== "event" || start.event.type !== "tool_execution_start") continue;
    assert.equal(start.event.summary, undefined, item.toolName);

    const end = normalizeOwnToolActivityEvent({
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: item.toolName,
      result: { content: [{ type: "text", text: "anything" }] },
      isError: false,
    }, "pi_native", item.startArgs);
    assert.equal(end.kind, "event", item.toolName);
    if (end.kind !== "event" || end.event.type !== "tool_execution_end") continue;
    assert.equal(end.event.summary, undefined, item.toolName);
    assert.equal(end.event.errorText, undefined, item.toolName);
  }
});

test("同名覆盖的 write/edit/bash 不产生专用摘要，错误正文随降级丢弃", () => {
  const writeEnd = normalizeOwnToolActivityEvent(mutationEnd("write", {
    content: [{ type: "text", text: "覆盖实现错误正文不得跨进程" }],
  }, true), "unknown", { path: "a.txt", content: "x" });
  assert.equal(writeEnd.kind, "event");
  if (writeEnd.kind !== "event" || writeEnd.event.type !== "tool_execution_end") return;
  assert.equal(writeEnd.event.summary, undefined);
  assert.equal(writeEnd.event.errorText, undefined);

  const bashEnd = normalizeOwnToolActivityEvent(mutationEnd("bash", {
    content: [{ type: "text", text: "覆盖实现输出不得跨进程" }],
  }, true), "unknown", { command: "ls" });
  assert.equal(bashEnd.kind, "event");
  if (bashEnd.kind !== "event" || bashEnd.event.type !== "tool_execution_end") return;
  assert.equal(bashEnd.event.summary, undefined);
  assert.equal(bashEnd.event.errorText, undefined);
});

test("write/bash 结束事实缺少缓存的开始参数时降级为无摘要兜底", () => {
  const writeEnd = normalizeOwnToolActivityEvent(mutationEnd("write", {
    content: [{ type: "text", text: "ok" }],
  }), "pi_native");
  assert.equal(writeEnd.kind, "event");
  if (writeEnd.kind !== "event" || writeEnd.event.type !== "tool_execution_end") return;
  assert.equal(writeEnd.event.summary, undefined);

  const bashEnd = normalizeOwnToolActivityEvent(mutationEnd("bash", {
    content: [{ type: "text", text: "out" }],
  }), "pi_native");
  assert.equal(bashEnd.kind, "event");
  if (bashEnd.kind !== "event" || bashEnd.event.type !== "tool_execution_end") return;
  assert.equal(bashEnd.event.summary, undefined);
});

test("codemode 开始摘要携带截断后的脚本与原文行数，其余参数不跨进程", () => {
  const code = "const text = await tools.read({ path: \"a.ts\" });\nreturn text.length;";
  const start = normalizeOwnToolActivityEvent(
    mutationStart("codemode", { code, futureField: "不得跨进程" }),
    "pi_extension",
  );
  assert.equal(start.kind, "event");
  if (start.kind !== "event" || start.event.type !== "tool_execution_start") return;
  assert.deepEqual(summaryOf(start.event), {
    tool: "codemode",
    code,
    codeLines: 2,
  });
  assert.equal(JSON.stringify(start.event).includes("futureField"), false);
});

test("codemode 结束摘要携带 isError 与嵌套调用数，脚本正文从开始参数缓存补齐", () => {
  const code = "await tools.read({ path: \"a.ts\" });";
  const result = {
    content: [{ type: "text", text: "Script completed\n输出正文不得跨进程" }],
    details: {
      calls: [
        { id: "call_1/1", name: "read", args: "{\"path\":\"a.ts\"}", status: "ok" },
        { id: "call_1/2", name: "grep", args: "{}", status: "error", error: "错误正文不得跨进程" },
      ],
      fullOutputPath: "/tmp/codemode-out",
    },
  };
  const end = normalizeOwnToolActivityEvent(
    mutationEnd("codemode", result, false),
    "pi_extension",
    { code },
  );
  assert.equal(end.kind, "event");
  if (end.kind !== "event" || end.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(end.event), {
    tool: "codemode",
    code,
    codeLines: 1,
    isError: false,
    nestedCalls: 2,
  });
  assert.equal(end.event.errorText, undefined);
  const serialized = JSON.stringify(end.event);
  assert.equal(serialized.includes("Script completed"), false);
  assert.equal(serialized.includes("输出正文不得跨进程"), false);
  assert.equal(serialized.includes("错误正文不得跨进程"), false);
  assert.equal(serialized.includes("/tmp/codemode-out"), false);
});

test("codemode 失败事实如实记录 isError，脚本错误正文不进入条目", () => {
  const end = normalizeOwnToolActivityEvent(
    mutationEnd("codemode", {
      content: [{ type: "text", text: "Script error:\nError: boom" }],
      details: { calls: [] },
    }, true),
    "pi_extension",
    { code: "throw new Error(\"boom\")" },
  );
  assert.equal(end.kind, "event");
  if (end.kind !== "event" || end.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(end.event), {
    tool: "codemode",
    code: "throw new Error(\"boom\")",
    codeLines: 1,
    isError: true,
    nestedCalls: 0,
  });
  assert.equal(end.event.errorText, undefined);
  assert.equal(JSON.stringify(end.event).includes("Script error"), false);
});

test("codemode 开始参数缓存缺失时结束摘要仍携带状态与嵌套调用数", () => {
  const end = normalizeOwnToolActivityEvent(
    mutationEnd("codemode", { details: { calls: [] } }, false),
    "pi_extension",
  );
  assert.equal(end.kind, "event");
  if (end.kind !== "event" || end.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(end.event), {
    tool: "codemode",
    isError: false,
    nestedCalls: 0,
  });
});

test("codemode 结果缺少嵌套调用记录时不臆造 nestedCalls", () => {
  const end = normalizeOwnToolActivityEvent(
    mutationEnd("codemode", { content: [{ type: "text", text: "x" }] }, false),
    "pi_extension",
    { code: "return 1;" },
  );
  assert.equal(end.kind, "event");
  if (end.kind !== "event" || end.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(end.event), {
    tool: "codemode",
    code: "return 1;",
    codeLines: 1,
    isError: false,
  });
});

test("codemode 的模型分类调用不计入嵌套工具调用数", () => {
  const end = normalizeOwnToolActivityEvent(
    mutationEnd("codemode", {
      details: {
        calls: [
          { id: "call_1/1", name: "read", args: "{}", status: "ok" },
          {
            id: "call_1/models.classify/1",
            name: "models.classify",
            args: "provider/model",
            status: "ok",
          },
          { id: "call_1/2", name: "grep", args: "{}", status: "ok" },
        ],
      },
    }, false),
    "pi_extension",
    { code: "return 1;" },
  );
  assert.equal(end.kind, "event");
  if (end.kind !== "event" || end.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(end.event), {
    tool: "codemode",
    code: "return 1;",
    codeLines: 1,
    isError: false,
    nestedCalls: 2,
  });
});

test("超过 32 KB 的 codemode 脚本与 command 共用截断规则与标记", () => {
  const lines = Array.from({ length: 4000 }, (_, index) => `const value${index} = ${index};`);
  const code = lines.join("\n");
  assert.ok(Buffer.byteLength(code, "utf8") > 32 * 1024);
  const start = normalizeOwnToolActivityEvent(
    mutationStart("codemode", { code }),
    "pi_extension",
  );
  assert.equal(start.kind, "event");
  if (start.kind !== "event" || start.event.type !== "tool_execution_start") return;
  const summary = summaryOf(start.event) as { readonly code: string; readonly codeLines: number };
  assert.ok(Buffer.byteLength(summary.code, "utf8") <= 32 * 1024);
  assert.match(summary.code, /\n…（已截断，原文共 4000 行）$/u);
  assert.equal(summary.codeLines, 4000);
});

test("codemode 必需参数缺失或来源未验证时降级为无摘要兜底", () => {
  const missingCode = normalizeOwnToolActivityEvent(
    mutationStart("codemode", { code: 42 }),
    "pi_extension",
  );
  assert.equal(missingCode.kind, "event");
  if (missingCode.kind !== "event" || missingCode.event.type !== "tool_execution_start") return;
  assert.equal(missingCode.event.summary, undefined);

  for (const origin of ["unknown", "pi_native", "plugin"] as const) {
    const wrongOrigin = normalizeOwnToolActivityEvent(
      mutationStart("codemode", { code: "return 1;" }),
      origin,
    );
    assert.equal(wrongOrigin.kind, "event", origin);
    if (wrongOrigin.kind !== "event" || wrongOrigin.event.type !== "tool_execution_start") continue;
    assert.equal(wrongOrigin.event.summary, undefined, origin);
  }
});

test("产生端采集嵌套调用的父引用，顶层调用不携带该字段", () => {
  const nestedStart = normalizeOwnToolActivityEvent({
    type: "tool_execution_start",
    toolCallId: "call_1/1",
    toolName: "read",
    parentToolCallId: "call_1",
    args: { path: "src/a.ts" },
  }, "pi_native");
  assert.equal(nestedStart.kind, "event");
  if (nestedStart.kind !== "event" || nestedStart.event.type !== "tool_execution_start") return;
  assert.equal(nestedStart.event.parentToolCallId, "call_1");
  // 嵌套条目的专用摘要照常提取，父引用不改变其余渲染输入。
  assert.deepEqual(summaryOf(nestedStart.event), { tool: "read", path: "src/a.ts" });

  const nestedEnd = normalizeOwnToolActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1/1",
    toolName: "read",
    parentToolCallId: "call_1",
    result: { content: [{ type: "text", text: "文件正文不得跨进程" }] },
    isError: false,
  }, "pi_native", { path: "src/a.ts" });
  assert.equal(nestedEnd.kind, "event");
  if (nestedEnd.kind !== "event" || nestedEnd.event.type !== "tool_execution_end") return;
  assert.equal(nestedEnd.event.parentToolCallId, "call_1");
  assert.deepEqual(summaryOf(nestedEnd.event), { tool: "read", path: "src/a.ts" });

  const topLevel = normalizeOwnToolActivityEvent(mutationStart("codemode", { code: "return 1;" }), "pi_extension");
  assert.equal(topLevel.kind, "event");
  if (topLevel.kind !== "event" || topLevel.event.type !== "tool_execution_start") return;
  assert.equal("parentToolCallId" in topLevel.event, false);
});

test("产生端拒绝越界、自引用或与活动 ID 不一致的父引用", () => {
  const base = {
    type: "tool_execution_start",
    toolCallId: "call_1/1",
    toolName: "read",
    args: { path: "a.ts" },
  };
  for (const parentToolCallId of ["", 42, "p".repeat(257), "call_1/1", "call_2", "call_1" + "/"]) {
    assert.equal(
      normalizeOwnToolActivityEvent({ ...base, parentToolCallId }, "pi_native").kind,
      "invalid",
      JSON.stringify(parentToolCallId),
    );
  }
  // 合法父引用仍被接受。
  assert.equal(
    normalizeOwnToolActivityEvent({ ...base, parentToolCallId: "call_1" }, "pi_native").kind,
    "event",
  );
});

test("tool_search 开始摘要携带查询词，描述与未来字段不跨进程", () => {
  const start = normalizeOwnToolActivityEvent(
    mutationStart("tool_search", { query: "mcp resource", limit: 5, futureField: "不得跨进程" }),
    "pi_extension",
  );
  assert.equal(start.kind, "event");
  if (start.kind !== "event" || start.event.type !== "tool_execution_start") return;
  assert.deepEqual(summaryOf(start.event), { tool: "tool_search", query: "mcp resource" });
  assert.equal(JSON.stringify(start.event).includes("futureField"), false);
  assert.equal(JSON.stringify(start.event).includes("limit"), false);
});

test("tool_search 查询词超过 1 KB 时按 UTF-8 字节截断且不切断多字节字符", () => {
  const query = "搜".repeat(1000);
  assert.ok(Buffer.byteLength(query, "utf8") > 1024);
  const start = normalizeOwnToolActivityEvent(
    mutationStart("tool_search", { query }),
    "pi_extension",
  );
  assert.equal(start.kind, "event");
  if (start.kind !== "event" || start.event.type !== "tool_execution_start") return;
  const summary = summaryOf(start.event) as { readonly query: string };
  assert.ok(Buffer.byteLength(summary.query, "utf8") <= 1024);
  assert.equal(summary.query.endsWith("搜"), true);
});

test("tool_search 结束摘要携带加载工具与真实总数，查询词从开始参数缓存补齐", () => {
  const loaded = Array.from({ length: 25 }, (_, index) => `tool_${index}`);
  const end = normalizeOwnToolActivityEvent(
    mutationEnd("tool_search", {
      content: [{ type: "text", text: "Loaded 25 tools. 工具描述正文不得跨进程" }],
      details: { loaded },
    }),
    "pi_extension",
    { query: "docs" },
  );
  assert.equal(end.kind, "event");
  if (end.kind !== "event" || end.event.type !== "tool_execution_end") return;
  const summary = summaryOf(end.event) as {
    readonly query: string;
    readonly loaded: readonly string[];
    readonly loadedTotal: number;
    readonly isError: boolean;
  };
  assert.equal(summary.query, "docs");
  assert.equal(summary.isError, false);
  assert.equal(summary.loaded.length, 20);
  assert.equal(summary.loaded[0], "tool_0");
  assert.equal(summary.loadedTotal, 25);
  const serialized = JSON.stringify(end.event);
  assert.equal(serialized.includes("工具描述正文不得跨进程"), false);
  assert.equal(serialized.includes("Loaded 25 tools"), false);
});

test("tool_search 无匹配结果携带空加载列表与零总数", () => {
  const end = normalizeOwnToolActivityEvent(
    mutationEnd("tool_search", {
      content: [{ type: "text", text: "No matching tools found." }],
      details: { loaded: [] },
    }),
    "pi_extension",
    { query: "不存在的工具" },
  );
  assert.equal(end.kind, "event");
  if (end.kind !== "event" || end.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(end.event), {
    tool: "tool_search",
    query: "不存在的工具",
    isError: false,
    loaded: [],
    loadedTotal: 0,
  });
});

test("tool_search 失败事实不携带加载结果，查询词缓存缺失时省略", () => {
  const end = normalizeOwnToolActivityEvent(
    mutationEnd("tool_search", {
      content: [{ type: "text", text: "query must not be empty" }],
    }, true),
    "pi_extension",
  );
  assert.equal(end.kind, "event");
  if (end.kind !== "event" || end.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(end.event), { tool: "tool_search", isError: true });
  assert.equal(JSON.stringify(end.event).includes("query must not be empty"), false);
});

test("tool_search 成功事实缺少加载结果结构时完整降级为无摘要兜底", () => {
  for (const result of [
    { content: [{ type: "text", text: "x" }] },
    { details: { loaded: "not-an-array" } },
    { details: { loaded: ["read", 42] } },
  ]) {
    const end = normalizeOwnToolActivityEvent(
      mutationEnd("tool_search", result),
      "pi_extension",
      { query: "docs" },
    );
    // 事件仍按安全兜底登记；只是不携带可能被 wire 拒绝的摘要。
    assert.equal(end.kind, "event");
    if (end.kind !== "event" || end.event.type !== "tool_execution_end") continue;
    assert.equal(end.event.summary, undefined);
  }
});

test("tool_search 必需参数缺失或来源未验证时降级为无摘要兜底", () => {
  const missingQuery = normalizeOwnToolActivityEvent(
    mutationStart("tool_search", { query: 42 }),
    "pi_extension",
  );
  assert.equal(missingQuery.kind, "event");
  if (missingQuery.kind !== "event" || missingQuery.event.type !== "tool_execution_start") return;
  assert.equal(missingQuery.event.summary, undefined);

  for (const origin of ["unknown", "pi_native", "mcp", "plugin"] as const) {
    const wrongOrigin = normalizeOwnToolActivityEvent(
      mutationStart("tool_search", { query: "docs" }),
      origin,
    );
    assert.equal(wrongOrigin.kind, "event", origin);
    if (wrongOrigin.kind !== "event" || wrongOrigin.event.type !== "tool_execution_start") continue;
    assert.equal(wrongOrigin.event.summary, undefined, origin);
  }
});

test("MCP 工具开始摘要携带服务器与工具名，参数与未来字段不跨进程", () => {
  const start = normalizeOwnToolActivityEvent(
    mutationStart("mcp__docs__search", { query: "secret", futureField: "不得跨进程" }),
    "mcp",
  );
  assert.equal(start.kind, "event");
  if (start.kind !== "event" || start.event.type !== "tool_execution_start") return;
  assert.deepEqual(summaryOf(start.event), {
    tool: "mcp__docs__search",
    server: "docs",
    mcpTool: "search",
  });
  assert.equal(JSON.stringify(start.event).includes("futureField"), false);
  assert.equal(JSON.stringify(start.event).includes("secret"), false);
});

test("MCP 工具名带哈希后缀时仍能解析出服务器与工具名", () => {
  const toolName = "mcp__very_long_server__very_long_tool_name_a1b2c3d4";
  const start = normalizeOwnToolActivityEvent(
    mutationStart(toolName, {}),
    "mcp",
  );
  assert.equal(start.kind, "event");
  if (start.kind !== "event" || start.event.type !== "tool_execution_start") return;
  assert.deepEqual(summaryOf(start.event), {
    tool: toolName,
    server: "very_long_server",
    mcpTool: "very_long_tool_name_a1b2c3d4",
  });
});

test("MCP 工具结束摘要携带失败状态与实际存在的 annotations", () => {
  const end = normalizeOwnToolActivityEvent(
    mutationEnd("mcp__docs__search", {
      content: [{ type: "text", text: "MCP 结果正文不得跨进程" }],
      structuredContent: { secret: "结构化正文不得跨进程" },
      details: { server: "docs", tool: "search" },
    }, true),
    "mcp",
    undefined,
    undefined,
    undefined,
    () => ({ readOnlyHint: true, destructiveHint: false }),
  );
  assert.equal(end.kind, "event");
  if (end.kind !== "event" || end.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(end.event), {
    tool: "mcp__docs__search",
    server: "docs",
    mcpTool: "search",
    isError: true,
    annotations: { readOnlyHint: true, destructiveHint: false },
  });
  const serialized = JSON.stringify(end.event);
  assert.equal(serialized.includes("MCP 结果正文不得跨进程"), false);
  assert.equal(serialized.includes("结构化正文不得跨进程"), false);
});

test("MCP 工具无 annotations 时不携带空对象，解析器缺失时也不臆造", () => {
  const end = normalizeOwnToolActivityEvent(
    mutationEnd("mcp__docs__search", {
      content: [{ type: "text", text: "结果" }],
      details: { server: "docs", tool: "search" },
    }),
    "mcp",
    undefined,
    undefined,
    undefined,
    () => undefined,
  );
  assert.equal(end.kind, "event");
  if (end.kind !== "event" || end.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(end.event), {
    tool: "mcp__docs__search",
    server: "docs",
    mcpTool: "search",
    isError: false,
  });
});

test("MCP annotations 在产生端只保留实际存在的布尔 hint", () => {
  const toolName = "mcp__docs__search";
  const end = normalizeOwnToolActivityEvent(
    mutationEnd(toolName, { details: { server: "docs", tool: "search" } }),
    "mcp",
    undefined,
    undefined,
    undefined,
    () => ({ readOnlyHint: true, destructiveHint: "yes", unknownHint: true, title: "x" }),
  );
  assert.equal(end.kind, "event");
  if (end.kind !== "event" || end.event.type !== "tool_execution_end") return;
  // 未知键与非布尔字段被过滤；实际存在的布尔 hint 保留。
  assert.deepEqual(summaryOf(end.event), {
    tool: toolName,
    server: "docs",
    mcpTool: "search",
    isError: false,
    annotations: { readOnlyHint: true },
  });

  // 空对象与非对象解析结果不产生 annotations。
  for (const value of [{}, null, "nope"] as const) {
    const empty = normalizeOwnToolActivityEvent(
      mutationEnd(toolName, { details: { server: "docs", tool: "search" } }),
      "mcp",
      undefined,
      undefined,
      undefined,
      () => value,
    );
    assert.equal(empty.kind, "event");
    if (empty.kind !== "event" || empty.event.type !== "tool_execution_end") continue;
    assert.deepEqual(summaryOf(empty.event), {
      tool: toolName,
      server: "docs",
      mcpTool: "search",
      isError: false,
    });
  }
});

test("MCP 工具名不符合命名规则或来源未验证时降级为无摘要兜底", () => {
  const malformed = normalizeOwnToolActivityEvent(
    mutationStart("mcp__malformed", {}),
    "mcp",
  );
  assert.equal(malformed.kind, "event");
  if (malformed.kind !== "event" || malformed.event.type !== "tool_execution_start") return;
  assert.equal(malformed.event.summary, undefined);

  for (const origin of ["unknown", "pi_native", "pi_extension", "plugin"] as const) {
    const wrongOrigin = normalizeOwnToolActivityEvent(
      mutationStart("mcp__docs__search", {}),
      origin,
    );
    assert.equal(wrongOrigin.kind, "event", origin);
    if (wrongOrigin.kind !== "event" || wrongOrigin.event.type !== "tool_execution_start") continue;
    assert.equal(wrongOrigin.event.summary, undefined, origin);
  }
});

test("MCP 资源工具开始摘要携带服务器与资源 URI，列出工具不携带 URI", () => {
  const read = normalizeOwnToolActivityEvent(
    mutationStart("read_mcp_resource", {
      server: "docs",
      uri: "file:///spec.md",
      futureField: "不得跨进程",
    }),
    "mcp",
  );
  assert.equal(read.kind, "event");
  if (read.kind !== "event" || read.event.type !== "tool_execution_start") return;
  assert.deepEqual(summaryOf(read.event), {
    tool: "read_mcp_resource",
    server: "docs",
    uri: "file:///spec.md",
  });
  assert.equal(JSON.stringify(read.event).includes("futureField"), false);

  const list = normalizeOwnToolActivityEvent(
    mutationStart("list_mcp_resources", { server: "docs", cursor: "opaque" }),
    "mcp",
  );
  assert.equal(list.kind, "event");
  if (list.kind !== "event" || list.event.type !== "tool_execution_start") return;
  assert.deepEqual(summaryOf(list.event), { tool: "list_mcp_resources", server: "docs" });
});

test("MCP 资源工具结束摘要携带 isError，服务器与 URI 从开始参数缓存补齐", () => {
  const end = normalizeOwnToolActivityEvent(
    mutationEnd("read_mcp_resource", {
      content: [{ type: "text", text: "资源正文不得跨进程" }],
      structuredContent: { contents: ["外部数据不得跨进程"] },
      details: { server: "docs", tool: "read_mcp_resource" },
    }),
    "mcp",
    { server: "docs", uri: "file:///spec.md" },
  );
  assert.equal(end.kind, "event");
  if (end.kind !== "event" || end.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(end.event), {
    tool: "read_mcp_resource",
    server: "docs",
    uri: "file:///spec.md",
    isError: false,
  });
  const serialized = JSON.stringify(end.event);
  assert.equal(serialized.includes("资源正文不得跨进程"), false);
  assert.equal(serialized.includes("外部数据不得跨进程"), false);
});

test("MCP 资源工具失败事实携带 isError，外部错误正文不进入条目", () => {
  const end = normalizeOwnToolActivityEvent(
    mutationEnd("read_mcp_resource", {
      content: [{ type: "text", text: "MCP 错误正文不得跨进程" }],
    }, true),
    "mcp",
    { server: "docs", uri: "file:///spec.md" },
  );
  assert.equal(end.kind, "event");
  if (end.kind !== "event" || end.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(end.event), {
    tool: "read_mcp_resource",
    server: "docs",
    uri: "file:///spec.md",
    isError: true,
  });
  assert.equal(JSON.stringify(end.event).includes("MCP 错误正文不得跨进程"), false);
});

test("MCP 资源工具缺少服务器参数或来源未验证时降级为无摘要兜底", () => {
  const missingServer = normalizeOwnToolActivityEvent(
    mutationStart("list_mcp_resources", {}),
    "mcp",
  );
  assert.equal(missingServer.kind, "event");
  if (missingServer.kind !== "event" || missingServer.event.type !== "tool_execution_start") return;
  assert.equal(missingServer.event.summary, undefined);

  for (const origin of ["unknown", "pi_native", "pi_extension", "plugin"] as const) {
    const wrongOrigin = normalizeOwnToolActivityEvent(
      mutationStart("list_mcp_resources", { server: "docs" }),
      origin,
    );
    assert.equal(wrongOrigin.kind, "event", origin);
    if (wrongOrigin.kind !== "event" || wrongOrigin.event.type !== "tool_execution_start") continue;
    assert.equal(wrongOrigin.event.summary, undefined, origin);
  }
});

test("MCP 资源工具开始参数缓存缺失时结束摘要仍携带 isError", () => {
  const end = normalizeOwnToolActivityEvent(
    mutationEnd("list_mcp_resources", {
      content: [{ type: "text", text: "JSON 列表正文不得跨进程" }],
      details: { server: "", tool: "list_mcp_resources" },
    }),
    "mcp",
  );
  assert.equal(end.kind, "event");
  if (end.kind !== "event" || end.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(end.event), { tool: "list_mcp_resources", isError: false });
  assert.equal(JSON.stringify(end.event).includes("JSON 列表正文不得跨进程"), false);
});

test("活动事件闭集对 Shell 工具拒绝错误正文，write/edit 可携带且键集合严格闭合", () => {
  // Shell 工具失败不携带错误正文：携带即协议违约。
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "bash",
    origin: "pi_native",
    isError: true,
    summary: { tool: "bash", command: "ls" },
    errorText: "Shell 异常正文不得进入闭集",
  }).kind, "invalid");
  // write/edit 失败携带 errorText 合法。
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "write",
    origin: "pi_native",
    isError: true,
    summary: { tool: "write", path: "a.txt" },
    errorText: "permission denied",
  }).kind, "event");
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "edit",
    origin: "pi_native",
    isError: true,
    summary: { tool: "edit", path: "a.ts" },
    errorText: "not found",
  }).kind, "event");
  // Shell 摘要缺 command 判 invalid。
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "bash",
    origin: "pi_native",
    summary: { tool: "bash", timeout: 5 },
  }).kind, "invalid");
  // Shell 摘要未知键（stdout）判 invalid。
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "bash",
    origin: "pi_native",
    summary: { tool: "bash", command: "ls", stdout: "x" },
  }).kind, "invalid");
  // write 摘要未知键（lines 统计）判 invalid。
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "write",
    origin: "pi_native",
    isError: false,
    summary: { tool: "write", path: "a.txt", lines: 3 },
  }).kind, "invalid");
  // edit 摘要未知键（edits 统计）判 invalid。
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "edit",
    origin: "pi_native",
    isError: false,
    summary: { tool: "edit", path: "a.ts", edits: 2 },
  }).kind, "invalid");
  // plugin 来源的 write 摘要判 invalid。
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "write",
    origin: "plugin",
    summary: { tool: "write", path: "a.txt" },
  }).kind, "invalid");
});

const PLUGIN_CHILD_ID = "550e8400-e29b-41d4-a716-446655440009";

/** 本插件专用工具事件的原始形状（参数在 start，结果在 end）。 */
function pluginStart(toolName: string, args: unknown): unknown {
  return {
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName,
    args,
  };
}

function pluginEnd(toolName: string, result: unknown, isError = false): unknown {
  return {
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName,
    result,
    isError,
  };
}

/** SubagentToolError 的稳定 JSON 外壳：content text 块中的完整 JSON 字符串。 */
function pluginErrorShell(code: string, message = "boom"): unknown {
  return {
    content: [{
      type: "text",
      text: JSON.stringify({ ok: false, error: { code, message, retryable: false, details: {} } }),
    }],
  };
}

test("五种插件专用工具的开始事实自包含白名单参数并忽略未来新增字段", () => {
  // get_agent_templates 无输入参数；空 args 也产生无载荷工具名摘要。
  const templates = normalizeOwnToolActivityEvent(pluginStart("get_agent_templates", {}), "plugin");
  assert.equal(templates.kind, "event");
  if (templates.kind !== "event" || templates.event.type !== "tool_execution_start") return;
  assert.deepEqual(summaryOf(templates.event), { tool: "get_agent_templates" });

  // spawn_agent 只保留 name 与 template_id；depth、初始 state、任务正文等
  // 未来字段与敏感载荷一律忽略。
  const spawn = normalizeOwnToolActivityEvent(pluginStart("spawn_agent", {
    name: "worker-a",
    template_id: "worker",
    depth: 2,
    initial_state: { secret: "state" },
    task: "机密任务正文",
  }), "plugin");
  assert.equal(spawn.kind, "event");
  if (spawn.kind !== "event" || spawn.event.type !== "tool_execution_start") return;
  assert.deepEqual(summaryOf(spawn.event), {
    tool: "spawn_agent",
    name: "worker-a",
    template_id: "worker",
  });

  // send_message 自包含完整尝试正文；resolveAgentName 命中时携带目标名称，
  // 未命中时不携带。accepted 等其它字段忽略。
  const resolved = normalizeOwnToolActivityEvent(
    pluginStart("send_message", {
      agent_id: PLUGIN_CHILD_ID,
      message: "你好\n多行正文",
      accepted: true,
      priority: 1,
    }),
    "plugin",
    undefined,
    (agentId) => (agentId === PLUGIN_CHILD_ID ? "worker-a" : undefined),
  );
  assert.equal(resolved.kind, "event");
  if (resolved.kind !== "event" || resolved.event.type !== "tool_execution_start") return;
  assert.deepEqual(summaryOf(resolved.event), {
    tool: "send_message",
    agent_id: PLUGIN_CHILD_ID,
    message: "你好\n多行正文",
    name: "worker-a",
  });

  const unresolved = normalizeOwnToolActivityEvent(
    pluginStart("send_message", { agent_id: PLUGIN_CHILD_ID, message: "你好" }),
    "plugin",
  );
  assert.equal(unresolved.kind, "event");
  if (unresolved.kind !== "event" || unresolved.event.type !== "tool_execution_start") return;
  assert.deepEqual(summaryOf(unresolved.event), {
    tool: "send_message",
    agent_id: PLUGIN_CHILD_ID,
    message: "你好",
  });

  // normal_reply 与 final_report 自包含完整 message。
  for (const toolName of ["normal_reply", "final_report"] as const) {
    const normalized = normalizeOwnToolActivityEvent(
      pluginStart(toolName, { message: "回复正文", accepted: false }),
      "plugin",
    );
    assert.equal(normalized.kind, "event", toolName);
    if (normalized.kind !== "event" || normalized.event.type !== "tool_execution_start") return;
    assert.deepEqual(summaryOf(normalized.event), { tool: toolName, message: "回复正文" }, toolName);
  }
});

test("系统提示、模板正文与上下文文件清单永不进入插件工具摘要", () => {
  // spawn_agent 的输入与成功结果携带系统内容载荷，摘要只保留白名单字段。
  const spawned = normalizeOwnToolActivityEvent(
    pluginEnd(
      "spawn_agent",
      {
        details: {
          agent_id: PLUGIN_CHILD_ID,
          state: "idle",
          system_prompt: "机密系统提示",
          template_body: "机密模板正文",
          context_files: [{ path: "AGENTS.md", content: "机密上下文正文" }],
        },
      },
      false,
    ),
    "plugin",
    {
      name: "worker-a",
      template_id: "worker",
      system_prompt: "机密系统提示",
      context_files: [{ path: "AGENTS.md", content: "机密上下文正文" }],
    },
  );
  assert.equal(spawned.kind, "event");
  if (spawned.kind !== "event" || spawned.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(spawned.event), {
    tool: "spawn_agent",
    name: "worker-a",
    template_id: "worker",
    agent_id: PLUGIN_CHILD_ID,
  });

  // send_message 的输入携带系统内容字段，摘要只保留白名单字段。
  const send = normalizeOwnToolActivityEvent(
    pluginStart("send_message", {
      agent_id: PLUGIN_CHILD_ID,
      message: "普通投递正文",
      system_prompt: "机密系统提示",
      context_files: [{ path: "CONTEXT.md", content: "机密上下文正文" }],
    }),
    "plugin",
  );
  assert.equal(send.kind, "event");
  if (send.kind !== "event" || send.event.type !== "tool_execution_start") return;
  assert.deepEqual(summaryOf(send.event), {
    tool: "send_message",
    agent_id: PLUGIN_CHILD_ID,
    message: "普通投递正文",
  });
});

test("插件工具结束事实区分成功与失败摘要并只携带白名单稳定错误码", () => {
  // get_agent_templates 成功只提取模板数量；details 缺失或非数组时不携带。
  const counted = normalizeOwnToolActivityEvent(
    pluginEnd("get_agent_templates", { details: [{ id: "a" }, { id: "b" }, { id: "c" }] }, false),
    "plugin",
    {},
  );
  assert.equal(counted.kind, "event");
  if (counted.kind !== "event" || counted.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(counted.event), { tool: "get_agent_templates", count: 3 });

  const uncounted = normalizeOwnToolActivityEvent(
    pluginEnd("get_agent_templates", {}, false),
    "plugin",
    {},
  );
  assert.equal(uncounted.kind, "event");
  if (uncounted.kind !== "event" || uncounted.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(uncounted.event), { tool: "get_agent_templates" });

  // spawn_agent 成功追加完整 UUID；失败摘要没有 agent_id。
  const spawned = normalizeOwnToolActivityEvent(
    pluginEnd(
      "spawn_agent",
      { details: { agent_id: PLUGIN_CHILD_ID, state: "idle", depth: 1 } },
      false,
    ),
    "plugin",
    { name: "worker-a", template_id: "worker" },
  );
  assert.equal(spawned.kind, "event");
  if (spawned.kind !== "event" || spawned.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(spawned.event), {
    tool: "spawn_agent",
    name: "worker-a",
    template_id: "worker",
    agent_id: PLUGIN_CHILD_ID,
  });

  // 消息类工具失败保留完整尝试正文；错误码来自白名单 JSON 外壳。
  const failedSend = normalizeOwnToolActivityEvent(
    pluginEnd("send_message", pluginErrorShell("agent_unavailable", "child busy"), true),
    "plugin",
    { agent_id: PLUGIN_CHILD_ID, message: "投递正文" },
  );
  assert.equal(failedSend.kind, "event");
  if (failedSend.kind !== "event" || failedSend.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(failedSend.event), {
    tool: "send_message",
    agent_id: PLUGIN_CHILD_ID,
    message: "投递正文",
  });
  assert.equal(failedSend.event.errorCode, "agent_unavailable");
  // 插件失败不携带错误正文。
  assert.equal(failedSend.event.errorText, undefined);

  const failedReply = normalizeOwnToolActivityEvent(
    pluginEnd("normal_reply", pluginErrorShell("reply_too_large"), true),
    "plugin",
    { message: "过长回复" },
  );
  assert.equal(failedReply.kind, "event");
  if (failedReply.kind !== "event" || failedReply.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(failedReply.event), { tool: "normal_reply", message: "过长回复" });
  assert.equal(failedReply.event.errorCode, "reply_too_large");

  // final_report 成功保留完整正文，不携带错误码。
  const report = normalizeOwnToolActivityEvent(
    pluginEnd("final_report", { details: { accepted: true } }, false),
    "plugin",
    { message: "最终报告" },
  );
  assert.equal(report.kind, "event");
  if (report.kind !== "event" || report.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(report.event), { tool: "final_report", message: "最终报告" });
  assert.equal(report.event.errorCode, undefined);

  // get_agent_templates 失败摘要无模板数量，只携带稳定错误码。
  const templatesFailed = normalizeOwnToolActivityEvent(
    pluginEnd("get_agent_templates", pluginErrorShell("internal_error"), true),
    "plugin",
    {},
  );
  assert.equal(templatesFailed.kind, "event");
  if (templatesFailed.kind !== "event" || templatesFailed.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(templatesFailed.event), { tool: "get_agent_templates" });
  assert.equal(templatesFailed.event.errorCode, "internal_error");

  // 白名单外错误码、非 JSON 外壳与缺失外壳都静默省略错误码。
  for (const result of [
    pluginErrorShell("secret_internal_code"),
    { content: [{ type: "text", text: "plain failure text" }] },
    { content: [] },
  ]) {
    const degraded = normalizeOwnToolActivityEvent(
      pluginEnd("spawn_agent", result, true),
      "plugin",
      { name: "worker-a", template_id: "worker" },
    );
    assert.equal(degraded.kind, "event");
    if (degraded.kind !== "event" || degraded.event.type !== "tool_execution_end") return;
    assert.equal(degraded.event.errorCode, undefined);
  }
});

test("插件专用工具必需字段缺失或类型错误时完整降级为安全兜底", () => {
  const cases: readonly {
    readonly toolName: string;
    readonly startArgs: unknown;
  }[] = [
    { toolName: "spawn_agent", startArgs: { template_id: "worker" } },
    { toolName: "spawn_agent", startArgs: { name: 42, template_id: "worker" } },
    { toolName: "send_message", startArgs: { agent_id: "not-a-uuid", message: "正文" } },
    { toolName: "send_message", startArgs: { agent_id: PLUGIN_CHILD_ID, message: 42 } },
    { toolName: "normal_reply", startArgs: { message: null } },
    { toolName: "final_report", startArgs: {} },
    { toolName: "get_agent_templates", startArgs: null },
  ];
  for (const item of cases) {
    const start = normalizeOwnToolActivityEvent(
      pluginStart(item.toolName, item.startArgs),
      "plugin",
    );
    assert.equal(start.kind, "event", item.toolName);
    if (start.kind !== "event" || start.event.type !== "tool_execution_start") continue;
    assert.equal(start.event.summary, undefined, item.toolName);

    const end = normalizeOwnToolActivityEvent(
      pluginEnd(item.toolName, pluginErrorShell("spawn_failed"), true),
      "plugin",
      isRecordArgs(item.startArgs) ? item.startArgs : undefined,
    );
    assert.equal(end.kind, "event", item.toolName);
    if (end.kind !== "event" || end.event.type !== "tool_execution_end") continue;
    // 摘要完整降级为无载荷兜底，但失败事实的稳定错误码仍然提取。
    assert.equal(end.event.summary, undefined, item.toolName);
    assert.equal(end.event.errorCode, "spawn_failed", item.toolName);
  }
});

function isRecordArgs(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("同名覆盖的本插件专用工具名不产生插件摘要与错误码", () => {
  // 用户同名覆盖使来源验证不再是 plugin：专用摘要与稳定错误码都不可用。
  for (const origin of ["unknown", "pi_native"] as const) {
    const start = normalizeOwnToolActivityEvent(
      pluginStart("spawn_agent", { name: "worker-a", template_id: "worker" }),
      origin,
    );
    assert.equal(start.kind, "event", origin);
    if (start.kind !== "event" || start.event.type !== "tool_execution_start") continue;
    assert.equal(start.event.summary, undefined, origin);

    const end = normalizeOwnToolActivityEvent(
      pluginEnd("send_message", pluginErrorShell("agent_unavailable"), true),
      origin,
      { agent_id: PLUGIN_CHILD_ID, message: "正文" },
    );
    assert.equal(end.kind, "event", origin);
    if (end.kind !== "event" || end.event.type !== "tool_execution_end") continue;
    assert.equal(end.event.summary, undefined, origin);
    assert.equal(end.event.errorCode, undefined, origin);
    // 插件工具失败正文不属于任何来源的白名单。
    assert.equal(end.event.errorText, undefined, origin);
  }
});

test("插件摘要的 wire 闭集：未知键、非法 UUID 与负数量判违约", () => {
  // 摘要未知键判 invalid。
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "spawn_agent",
    origin: "plugin",
    summary: { tool: "spawn_agent", name: "a", template_id: "w", depth: 2 },
  }).kind, "invalid");
  // spawn 成功摘要的 agent_id 必须是完整规范 UUID。
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "spawn_agent",
    origin: "plugin",
    isError: false,
    summary: { tool: "spawn_agent", name: "a", template_id: "w", agent_id: "short-id" },
  }).kind, "invalid");
  // get_agent_templates 数量必须是非负安全整数。
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "get_agent_templates",
    origin: "plugin",
    isError: false,
    summary: { tool: "get_agent_templates", count: -1 },
  }).kind, "invalid");
  // send_message 摘要要求完整正文与规范 UUID。
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "send_message",
    origin: "plugin",
    summary: { tool: "send_message", agent_id: PLUGIN_CHILD_ID, message: "" },
  }).kind, "invalid");
  // 白名单外错误码判 invalid；白名单内合法。
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "normal_reply",
    origin: "plugin",
    isError: true,
    summary: { tool: "normal_reply", message: "正文" },
    errorCode: "not_public",
  }).kind, "invalid");
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "normal_reply",
    origin: "plugin",
    isError: true,
    summary: { tool: "normal_reply", message: "正文" },
    errorCode: "message_delivery_failed",
  }).kind, "event");
});

const WAIT_RELEASED_BY_ID = "22c4d1e8-3a5b-4c6d-8e9f-0a1b2c3d4e5f";

/** 等待与控制工具的结束事件（结果 details 在 end）。 */
function controlEnd(
  toolName: string,
  details: unknown,
  isError = false,
): unknown {
  return isError
    ? pluginEnd(toolName, pluginErrorShell("agent_not_found"), true)
    : pluginEnd(toolName, { details }, false);
}

test("等待与控制工具的开始事实自包含白名单目标事实并忽略未来新增字段", () => {
  // wait_agent 单目标：完整 UUID 加解析名称；timeout_ms 等其余参数忽略。
  const waitResolved = normalizeOwnToolActivityEvent(
    pluginStart("wait_agent", { agent_ids: [PLUGIN_CHILD_ID], timeout_ms: 300_000, priority: 1 }),
    "plugin",
    undefined,
    (agentId) => (agentId === PLUGIN_CHILD_ID ? "worker-a" : undefined),
  );
  assert.equal(waitResolved.kind, "event");
  if (waitResolved.kind !== "event" || waitResolved.event.type !== "tool_execution_start") return;
  assert.deepEqual(summaryOf(waitResolved.event), {
    tool: "wait_agent",
    agent_id: PLUGIN_CHILD_ID,
    name: "worker-a",
  });

  const waitUnresolved = normalizeOwnToolActivityEvent(
    pluginStart("wait_agent", { agent_ids: [PLUGIN_CHILD_ID] }),
    "plugin",
  );
  assert.equal(waitUnresolved.kind, "event");
  if (waitUnresolved.kind !== "event" || waitUnresolved.event.type !== "tool_execution_start") return;
  assert.deepEqual(summaryOf(waitUnresolved.event), { tool: "wait_agent", agent_id: PLUGIN_CHILD_ID });

  // 多目标只显示数量；部分非法 UUID 完整降级。
  const waitMulti = normalizeOwnToolActivityEvent(
    pluginStart("wait_agent", { agent_ids: [PLUGIN_CHILD_ID, WAIT_RELEASED_BY_ID, PLUGIN_CHILD_ID] }),
    "plugin",
  );
  assert.equal(waitMulti.kind, "event");
  if (waitMulti.kind !== "event" || waitMulti.event.type !== "tool_execution_start") return;
  assert.deepEqual(summaryOf(waitMulti.event), { tool: "wait_agent", target_count: 3 });

  // interrupt/terminate/get_agent_status 只保留目标事实。
  for (const toolName of ["interrupt_agent", "terminate_agent", "get_agent_status"] as const) {
    const started = normalizeOwnToolActivityEvent(
      pluginStart(toolName, { agent_id: PLUGIN_CHILD_ID, future_field: { secret: true } }),
      "plugin",
      undefined,
      (agentId) => (agentId === PLUGIN_CHILD_ID ? "worker-a" : undefined),
    );
    assert.equal(started.kind, "event", toolName);
    if (started.kind !== "event" || started.event.type !== "tool_execution_start") return;
    assert.deepEqual(summaryOf(started.event), {
      tool: toolName,
      agent_id: PLUGIN_CHILD_ID,
      name: "worker-a",
    }, toolName);
  }

  // get_agent_tree 无输入参数：无载荷工具名摘要。
  const tree = normalizeOwnToolActivityEvent(pluginStart("get_agent_tree", {}), "plugin");
  assert.equal(tree.kind, "event");
  if (tree.kind !== "event" || tree.event.type !== "tool_execution_start") return;
  assert.deepEqual(summaryOf(tree.event), { tool: "get_agent_tree" });
});

test("wait_agent 成功事实显示实际 outcome 与 batch release 事实，不保存原始结果", () => {
  const startArgs = { agent_ids: [PLUGIN_CHILD_ID] };
  for (const outcome of ["reply", "final_report", "idle", "terminal", "timeout"] as const) {
    const ended = normalizeOwnToolActivityEvent(
      pluginEnd("wait_agent", {
        details: {
          agent_id: PLUGIN_CHILD_ID,
          outcome,
          state: outcome === "terminal" ? "terminated" : "working",
          revision: 41,
          report_body: "报告正文不得进入摘要",
          task_result: { secret: true },
        },
      }, false),
      "plugin",
      startArgs,
    );
    assert.equal(ended.kind, "event", outcome);
    if (ended.kind !== "event" || ended.event.type !== "tool_execution_end") return;
    assert.deepEqual(summaryOf(ended.event), {
      tool: "wait_agent",
      agent_id: PLUGIN_CHILD_ID,
      outcome,
    }, outcome);
  }

  // 多目标 timeout：数量加 outcome。
  const multiTimeout = normalizeOwnToolActivityEvent(
    pluginEnd("wait_agent", { details: { agent_ids: [PLUGIN_CHILD_ID], outcome: "timeout" } }, false),
    "plugin",
    { agent_ids: [PLUGIN_CHILD_ID, WAIT_RELEASED_BY_ID, PLUGIN_CHILD_ID] },
  );
  assert.equal(multiTimeout.kind, "event");
  if (multiTimeout.kind !== "event" || multiTimeout.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(multiTimeout.event), { tool: "wait_agent", target_count: 3, outcome: "timeout" });

  // 父输入唤醒与 timeout 同构：只保留目标事实与实际 outcome，wake_reason 不进入摘要。
  const woken = normalizeOwnToolActivityEvent(
    pluginEnd("wait_agent", {
      details: {
        agent_ids: [PLUGIN_CHILD_ID, WAIT_RELEASED_BY_ID],
        outcome: "woken",
        wake_reason: "parent_input",
      },
    }, false),
    "plugin",
    { agent_ids: [PLUGIN_CHILD_ID, WAIT_RELEASED_BY_ID] },
  );
  assert.equal(woken.kind, "event");
  if (woken.kind !== "event" || woken.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(woken.event), { tool: "wait_agent", target_count: 2, outcome: "woken" });

  // batch release：释放者名称（解析命中时）与释放 outcome。
  const batch = normalizeOwnToolActivityEvent(
    pluginEnd("wait_agent", {
      details: {
        agent_ids: [PLUGIN_CHILD_ID, WAIT_RELEASED_BY_ID],
        outcome: "batch_released",
        released_by_agent_id: WAIT_RELEASED_BY_ID,
        released_by_outcome: "final_report",
      },
    }, false),
    "plugin",
    { agent_ids: [PLUGIN_CHILD_ID, WAIT_RELEASED_BY_ID] },
    (agentId) => (agentId === WAIT_RELEASED_BY_ID ? "worker-b" : undefined),
  );
  assert.equal(batch.kind, "event");
  if (batch.kind !== "event" || batch.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(batch.event), {
    tool: "wait_agent",
    target_count: 2,
    outcome: "batch_released",
    released_by: WAIT_RELEASED_BY_ID,
    released_by_name: "worker-b",
    released_outcome: "final_report",
  });

  // 目标 state failed：红色失败事实与白名单内安全错误码。
  const targetFailed = normalizeOwnToolActivityEvent(
    pluginEnd("wait_agent", {
      details: {
        agent_id: PLUGIN_CHILD_ID,
        outcome: "terminal",
        state: "failed",
        revision: 42,
        error: { code: "model_unavailable", message: "底层异常正文", retryable: false },
      },
    }, false),
    "plugin",
    startArgs,
  );
  assert.equal(targetFailed.kind, "event");
  if (targetFailed.kind !== "event" || targetFailed.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(targetFailed.event), {
    tool: "wait_agent",
    agent_id: PLUGIN_CHILD_ID,
    outcome: "terminal",
    state: "failed",
    error_code: "model_unavailable",
  });
  // 成功事实不携带事件级错误码。
  assert.equal(targetFailed.event.errorCode, undefined);

  // 白名单外错误码静默省略；state failed 事实仍保留。
  const unlistedFault = normalizeOwnToolActivityEvent(
    pluginEnd("wait_agent", {
      details: {
        agent_id: PLUGIN_CHILD_ID,
        outcome: "terminal",
        state: "failed",
        error: { code: "secret_internal_code" },
      },
    }, false),
    "plugin",
    startArgs,
  );
  assert.equal(unlistedFault.kind, "event");
  if (unlistedFault.kind !== "event" || unlistedFault.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(unlistedFault.event), {
    tool: "wait_agent",
    agent_id: PLUGIN_CHILD_ID,
    outcome: "terminal",
    state: "failed",
  });
});

test("控制工具成功事实区分幂等、强制回收、压缩阻塞与状态查询片段", () => {
  // interrupt：进入 interrupting、unchanged 与压缩阻塞。
  const interruptCases: readonly {
    readonly details: unknown;
    readonly expected: unknown;
  }[] = [
    { details: { agent_id: PLUGIN_CHILD_ID, accepted: true, changed: true, state: "interrupting" }, expected: { tool: "interrupt_agent", agent_id: PLUGIN_CHILD_ID, changed: true } },
    { details: { agent_id: PLUGIN_CHILD_ID, accepted: true, changed: false, state: "working" }, expected: { tool: "interrupt_agent", agent_id: PLUGIN_CHILD_ID, changed: false } },
    {
      details: { agent_id: PLUGIN_CHILD_ID, accepted: true, changed: false, state: "working", blocked_reason: "compaction_active" },
      expected: { tool: "interrupt_agent", agent_id: PLUGIN_CHILD_ID, changed: false, blocked_reason: "compaction_active" },
    },
  ];
  for (const item of interruptCases) {
    const ended = normalizeOwnToolActivityEvent(
      controlEnd("interrupt_agent", item.details),
      "plugin",
      { agent_id: PLUGIN_CHILD_ID },
    );
    assert.equal(ended.kind, "event");
    if (ended.kind !== "event" || ended.event.type !== "tool_execution_end") return;
    assert.deepEqual(summaryOf(ended.event), item.expected);
  }

  // terminate：回收数量、幂等与强制回收事实。
  const terminateCases: readonly { readonly details: unknown; readonly expected: unknown }[] = [
    {
      details: { agent_id: PLUGIN_CHILD_ID, state: "terminated", changed: true, forced: false, terminated_count: 2 },
      expected: { tool: "terminate_agent", agent_id: PLUGIN_CHILD_ID, changed: true, terminated_count: 2 },
    },
    {
      details: { agent_id: PLUGIN_CHILD_ID, state: "terminated", changed: true, forced: true, terminated_count: 3 },
      expected: { tool: "terminate_agent", agent_id: PLUGIN_CHILD_ID, changed: true, forced: true, terminated_count: 3 },
    },
    {
      details: { agent_id: PLUGIN_CHILD_ID, state: "terminated", changed: false, forced: false, terminated_count: 0 },
      expected: { tool: "terminate_agent", agent_id: PLUGIN_CHILD_ID, changed: false, terminated_count: 0 },
    },
  ];
  for (const item of terminateCases) {
    const ended = normalizeOwnToolActivityEvent(
      controlEnd("terminate_agent", item.details),
      "plugin",
      { agent_id: PLUGIN_CHILD_ID },
    );
    assert.equal(ended.kind, "event");
    if (ended.kind !== "event" || ended.event.type !== "tool_execution_end") return;
    assert.deepEqual(summaryOf(ended.event), item.expected);
  }

  // get_agent_status：working 携带 phase，failed 携带错误码，terminated 携带
  // 终止结果；revision、时间与上下文占用一律忽略。
  const statusCases: readonly { readonly details: unknown; readonly expected: unknown }[] = [
    {
      details: {
        agent_id: PLUGIN_CHILD_ID, state: "working", revision: 7,
        activity: { phase: "tool_calls" }, context_usage_percent: 88,
      },
      expected: { tool: "get_agent_status", agent_id: PLUGIN_CHILD_ID, state: "working", phase: "tool_calls" },
    },
    {
      details: { agent_id: PLUGIN_CHILD_ID, state: "idle", revision: 8 },
      expected: { tool: "get_agent_status", agent_id: PLUGIN_CHILD_ID, state: "idle" },
    },
    {
      details: {
        agent_id: PLUGIN_CHILD_ID, state: "failed", revision: 9,
        error: { code: "provider_unavailable", message: "底层异常", retryable: false },
      },
      expected: { tool: "get_agent_status", agent_id: PLUGIN_CHILD_ID, state: "failed", error_code: "provider_unavailable" },
    },
    {
      details: {
        agent_id: PLUGIN_CHILD_ID, state: "terminated", revision: 10,
        termination_result: "completed",
      },
      expected: { tool: "get_agent_status", agent_id: PLUGIN_CHILD_ID, state: "terminated", termination_result: "completed" },
    },
  ];
  for (const item of statusCases) {
    const ended = normalizeOwnToolActivityEvent(
      controlEnd("get_agent_status", item.details),
      "plugin",
      { agent_id: PLUGIN_CHILD_ID },
    );
    assert.equal(ended.kind, "event");
    if (ended.kind !== "event" || ended.event.type !== "tool_execution_end") return;
    assert.deepEqual(summaryOf(ended.event), item.expected);
  }

  // get_agent_tree：成功与失败都是无载荷摘要；树统计不进入摘要。
  for (const isError of [false, true]) {
    const ended = normalizeOwnToolActivityEvent(
      controlEnd("get_agent_tree", {
        revision: 11,
        scope: "subtree",
        nodes: [{ agent_id: PLUGIN_CHILD_ID, state: "working" }],
        stats: { working: 1 },
      }, isError),
      "plugin",
      {},
    );
    assert.equal(ended.kind, "event");
    if (ended.kind !== "event" || ended.event.type !== "tool_execution_end") return;
    assert.deepEqual(summaryOf(ended.event), { tool: "get_agent_tree" });
    if (isError) assert.equal(ended.event.errorCode, "agent_not_found");
  }
});

test("等待与控制工具失败事实携带输入目标与白名单稳定错误码", () => {
  const failed = normalizeOwnToolActivityEvent(
    controlEnd("wait_agent", undefined, true),
    "plugin",
    { agent_ids: [PLUGIN_CHILD_ID] },
  );
  assert.equal(failed.kind, "event");
  if (failed.kind !== "event" || failed.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(failed.event), { tool: "wait_agent", agent_id: PLUGIN_CHILD_ID });
  assert.equal(failed.event.errorCode, "agent_not_found");

  const failedStatus = normalizeOwnToolActivityEvent(
    controlEnd("get_agent_status", undefined, true),
    "plugin",
    { agent_id: PLUGIN_CHILD_ID },
  );
  assert.equal(failedStatus.kind, "event");
  if (failedStatus.kind !== "event" || failedStatus.event.type !== "tool_execution_end") return;
  assert.deepEqual(summaryOf(failedStatus.event), { tool: "get_agent_status", agent_id: PLUGIN_CHILD_ID });
  assert.equal(failedStatus.event.errorCode, "agent_not_found");
});

test("等待与控制工具必需字段缺失或类型错误时完整降级为安全兜底", () => {
  // 开始参数违约：开始与失败结束事实都完整降级，失败错误码仍提取。
  const startCases: readonly { readonly toolName: string; readonly startArgs: unknown }[] = [
    { toolName: "wait_agent", startArgs: { agent_ids: ["not-a-uuid"] } },
    { toolName: "wait_agent", startArgs: { agent_ids: [] } },
    { toolName: "wait_agent", startArgs: {} },
    { toolName: "interrupt_agent", startArgs: { agent_id: "short" } },
    { toolName: "terminate_agent", startArgs: {} },
    { toolName: "get_agent_status", startArgs: { agent_id: 42 } },
  ];
  for (const item of startCases) {
    const start = normalizeOwnToolActivityEvent(pluginStart(item.toolName, item.startArgs), "plugin");
    assert.equal(start.kind, "event", item.toolName);
    if (start.kind !== "event" || start.event.type !== "tool_execution_start") continue;
    assert.equal(start.event.summary, undefined, `${item.toolName} start`);

    const end = normalizeOwnToolActivityEvent(
      pluginEnd(item.toolName, pluginErrorShell("agent_not_found"), true),
      "plugin",
      isRecordArgs(item.startArgs) ? item.startArgs : undefined,
    );
    assert.equal(end.kind, "event", item.toolName);
    if (end.kind !== "event" || end.event.type !== "tool_execution_end") continue;
    assert.equal(end.event.summary, undefined, `${item.toolName} end`);
    assert.equal(end.event.errorCode, "agent_not_found", item.toolName);
  }

  // 成功结果违约：开始事实保留目标事实，结束事实完整降级为无载荷兜底。
  const endCases: readonly {
    readonly toolName: string;
    readonly startArgs: unknown;
    readonly endResult: unknown;
  }[] = [
    { toolName: "wait_agent", startArgs: { agent_ids: [PLUGIN_CHILD_ID] }, endResult: { details: { agent_id: PLUGIN_CHILD_ID, revision: 1 } } },
    { toolName: "wait_agent", startArgs: { agent_ids: [PLUGIN_CHILD_ID] }, endResult: { details: { agent_id: PLUGIN_CHILD_ID, outcome: "detached" } } },
    { toolName: "wait_agent", startArgs: { agent_ids: [PLUGIN_CHILD_ID] }, endResult: { details: { outcome: "batch_released" } } },
    { toolName: "wait_agent", startArgs: { agent_ids: [PLUGIN_CHILD_ID] }, endResult: { details: { outcome: "batch_released", released_by_agent_id: "short", released_by_outcome: "reply" } } },
    { toolName: "interrupt_agent", startArgs: { agent_id: PLUGIN_CHILD_ID }, endResult: { details: { agent_id: PLUGIN_CHILD_ID, accepted: true } } },
    { toolName: "terminate_agent", startArgs: { agent_id: PLUGIN_CHILD_ID }, endResult: { details: { agent_id: PLUGIN_CHILD_ID, changed: true, terminated_count: -1 } } },
    { toolName: "get_agent_status", startArgs: { agent_id: PLUGIN_CHILD_ID }, endResult: { details: { agent_id: PLUGIN_CHILD_ID, state: "detached" } } },
    { toolName: "get_agent_status", startArgs: { agent_id: PLUGIN_CHILD_ID }, endResult: {} },
  ];
  for (const item of endCases) {
    const start = normalizeOwnToolActivityEvent(pluginStart(item.toolName, item.startArgs), "plugin");
    assert.equal(start.kind, "event", item.toolName);
    if (start.kind !== "event" || start.event.type !== "tool_execution_start") continue;
    assert.notEqual(start.event.summary, undefined, `${item.toolName} start`);

    const end = normalizeOwnToolActivityEvent(
      pluginEnd(item.toolName, item.endResult, false),
      "plugin",
      isRecordArgs(item.startArgs) ? item.startArgs : undefined,
    );
    assert.equal(end.kind, "event", item.toolName);
    if (end.kind !== "event" || end.event.type !== "tool_execution_end") continue;
    assert.equal(end.event.summary, undefined, `${item.toolName} end`);
  }
});

test("同名覆盖的等待与控制工具名不产生插件摘要与错误码", () => {
  for (const origin of ["unknown", "pi_native"] as const) {
    const start = normalizeOwnToolActivityEvent(
      pluginStart("wait_agent", { agent_ids: [PLUGIN_CHILD_ID] }),
      origin,
    );
    assert.equal(start.kind, "event", origin);
    if (start.kind !== "event" || start.event.type !== "tool_execution_start") continue;
    assert.equal(start.event.summary, undefined, origin);

    const end = normalizeOwnToolActivityEvent(
      pluginEnd("get_agent_status", { details: { agent_id: PLUGIN_CHILD_ID, state: "working" } }, false),
      origin,
      { agent_id: PLUGIN_CHILD_ID },
    );
    assert.equal(end.kind, "event", origin);
    if (end.kind !== "event" || end.event.type !== "tool_execution_end") continue;
    assert.equal(end.event.summary, undefined, origin);
  }
});

test("等待与控制摘要的 wire 闭集：未知键、非法目标与闭集外枚举判违约", () => {
  const validWait = {
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "wait_agent",
    origin: "plugin",
    isError: false,
    summary: {
      tool: "wait_agent", target_count: 2, outcome: "batch_released",
      released_by: WAIT_RELEASED_BY_ID, released_outcome: "reply",
    },
  };
  assert.equal(parseAgentActivityEvent(validWait).kind, "event");

  // woken 属于 wait_agent 活动摘要闭集；wake_reason 不进入摘要。
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "wait_agent",
    origin: "plugin",
    isError: false,
    summary: { tool: "wait_agent", target_count: 2, outcome: "woken" },
  }).kind, "event");

  const invalidCases: readonly Record<string, unknown>[] = [
    // 未知键判违约。
    { ...validWait, summary: { ...validWait.summary, revision: 3 } },
    // 单目标与多目标互斥，也不允许同时缺失。
    { ...validWait, summary: { tool: "wait_agent", agent_id: PLUGIN_CHILD_ID, target_count: 2, outcome: "reply" } },
    { ...validWait, summary: { tool: "wait_agent", outcome: "reply" } },
    // 目标必须是完整 UUID；数量必须是正数。
    { ...validWait, summary: { tool: "wait_agent", agent_id: "short-id", outcome: "reply" } },
    { ...validWait, summary: { tool: "wait_agent", target_count: 0, outcome: "timeout" } },
    // outcome 与释放事实闭集。
    { ...validWait, summary: { tool: "wait_agent", target_count: 2, outcome: "detached" } },
    { ...validWait, summary: { tool: "wait_agent", target_count: 2, outcome: "batch_released", released_by: "short", released_outcome: "reply" } },
    { ...validWait, summary: { tool: "wait_agent", target_count: 2, outcome: "batch_released", released_by: WAIT_RELEASED_BY_ID, released_outcome: "timeout" } },
    // 目标失败状态只允许 failed；错误码必须白名单内。
    { ...validWait, summary: { tool: "wait_agent", agent_id: PLUGIN_CHILD_ID, outcome: "terminal", state: "terminated" } },
    { ...validWait, summary: { tool: "wait_agent", agent_id: PLUGIN_CHILD_ID, outcome: "terminal", state: "failed", error_code: "not_public" } },
  ];
  for (const candidate of invalidCases) {
    assert.equal(parseAgentActivityEvent(candidate).kind, "invalid");
  }

  // interrupt：压缩阻塞只属于未变更事实。
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "interrupt_agent",
    origin: "plugin",
    isError: false,
    summary: { tool: "interrupt_agent", agent_id: PLUGIN_CHILD_ID, changed: false, blocked_reason: "compaction_active" },
  }).kind, "event");
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "interrupt_agent",
    origin: "plugin",
    isError: false,
    summary: { tool: "interrupt_agent", agent_id: PLUGIN_CHILD_ID, changed: true, blocked_reason: "compaction_active" },
  }).kind, "invalid");

  // terminate：forced 只允许 true；数量非负。
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "terminate_agent",
    origin: "plugin",
    isError: false,
    summary: { tool: "terminate_agent", agent_id: PLUGIN_CHILD_ID, changed: true, forced: false, terminated_count: 1 },
  }).kind, "invalid");

  // status：phase、错误码与终止结果闭集。
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "get_agent_status",
    origin: "plugin",
    isError: false,
    summary: { tool: "get_agent_status", agent_id: PLUGIN_CHILD_ID, state: "failed", phase: "tool_calls" },
  }).kind, "event");
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "get_agent_status",
    origin: "plugin",
    isError: false,
    summary: { tool: "get_agent_status", agent_id: PLUGIN_CHILD_ID, state: "working", phase: "thinking" },
  }).kind, "invalid");
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "get_agent_status",
    origin: "plugin",
    isError: false,
    summary: { tool: "get_agent_status", agent_id: PLUGIN_CHILD_ID, state: "terminated", termination_result: "aborted" },
  }).kind, "invalid");

  // tree：无载荷摘要之外的任何键判违约；失败事实可携带白名单错误码。
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "get_agent_tree",
    origin: "plugin",
    isError: true,
    summary: { tool: "get_agent_tree" },
    errorCode: "agent_unavailable",
  }).kind, "event");
  assert.equal(parseAgentActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "get_agent_tree",
    origin: "plugin",
    isError: false,
    summary: { tool: "get_agent_tree", revision: 3 },
  }).kind, "invalid");
});
