import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Markdown, type TuiMouseEvent } from "@earendil-works/pi-tui";
import {
  AgentActivityViewerModel,
  NESTED_ACTIVITY_DISPLAY_LIMIT,
  displayWidth,
  renderAgentActivityViewerSurface,
} from "../src/agent-activity-viewer.ts";
import type {
  SafeAgentActivityDisplayEvent,
  SafeAgentActivityEvent,
  SafeToolSummary,
  SafeToolOrigin,
} from "../src/rpc-bridge-event.ts";
import { normalizeOwnToolActivityEvent, normalizeRpcBridgeEvent } from "../src/rpc-bridge-event.ts";
import {
  AgentDisplayDraftRegistry,
  type AgentDisplayDraftView,
} from "../src/agent-display-drafts.ts";
import {
  CANONICAL_ACTIVITY_CONTRACT_VERSION,
  type CanonicalAgentActivityEntry,
} from "../src/canonical-activity.ts";
import type { AgentLifecycleState } from "../src/agent-snapshot-codec.ts";
import { AgentActivityCache, type AgentActivitySnapshot } from "../src/agent-activity-cache.ts";

const AGENT_ID = "550e8400-e29b-41d4-a716-446655440002";
const INCARNATION_ID = "7f9c24e8-5b3d-4f6a-8c1e-9d2b7a4f6e81";
const VIEWPORT = 3;

function viewerAgent(state: AgentLifecycleState = "working") {
  return {
    agent_id: AGENT_ID,
    template_id: "worker",
    name: "worker-a",
    state,
  } as const;
}

function messageEntry(
  content: ReadonlyArray<{ type: "text"; text: string } | { type: "thinking"; thinking: string }>,
  streamId?: string,
): CanonicalAgentActivityEntry {
  return Object.freeze({
    contract_version: CANONICAL_ACTIVITY_CONTRACT_VERSION,
    agent_id: AGENT_ID,
    incarnation_id: streamId === undefined ? randomUUID() : INCARNATION_ID,
    entry_id: randomUUID(),
    body: Object.freeze({
      type: "message",
      content: Object.freeze(content.map((block) => Object.freeze(block))),
      ...(streamId === undefined ? {} : { streamId }),
    }),
  });
}

function textMessage(text: string): CanonicalAgentActivityEntry {
  return messageEntry([{ type: "text", text }]);
}

function modelFailureEntry(
  message: string,
  failure: "error" | "aborted" = "error",
  entryId: string = randomUUID(),
): CanonicalAgentActivityEntry {
  return Object.freeze({
    contract_version: CANONICAL_ACTIVITY_CONTRACT_VERSION,
    agent_id: AGENT_ID,
    incarnation_id: INCARNATION_ID,
    entry_id: entryId,
    body: Object.freeze({
      type: "model_call_failure" as const,
      failure,
      message,
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
    }),
  });
}

/** 压缩自身失败等拿不到发起模型身份的失败条目。 */
function identitylessModelFailureEntry(
  message: string,
  failure: "error" | "aborted" = "error",
  entryId: string = randomUUID(),
): CanonicalAgentActivityEntry {
  return Object.freeze({
    contract_version: CANONICAL_ACTIVITY_CONTRACT_VERSION,
    agent_id: AGENT_ID,
    incarnation_id: INCARNATION_ID,
    entry_id: entryId,
    body: Object.freeze({
      type: "model_call_failure" as const,
      failure,
      message,
    }),
  });
}

function toolStart(
  toolCallId: string,
  toolName: string,
  origin: SafeToolOrigin = "unknown",
  incarnationId: string = INCARNATION_ID,
  summary?: SafeToolSummary,
  entryId: string = randomUUID(),
  executionGeneration?: number,
  parentToolCallId?: string,
): CanonicalAgentActivityEntry {
  return Object.freeze({
    contract_version: CANONICAL_ACTIVITY_CONTRACT_VERSION,
    agent_id: AGENT_ID,
    incarnation_id: incarnationId,
    entry_id: entryId,
    body: Object.freeze({
      type: "tool_execution_start",
      toolCallId,
      toolName,
      origin,
      ...(parentToolCallId === undefined ? {} : { parentToolCallId }),
      ...(executionGeneration === undefined ? {} : { executionGeneration }),
      ...(summary === undefined ? {} : { summary }),
    }),
  });
}

function toolEnd(
  toolCallId: string,
  toolName: string,
  isError: boolean,
  origin: SafeToolOrigin = "unknown",
  incarnationId: string = INCARNATION_ID,
  summary?: SafeToolSummary,
  errorText?: string,
  errorCode?: string,
  entryId: string = randomUUID(),
  executionGeneration?: number,
  parentToolCallId?: string,
): CanonicalAgentActivityEntry {
  return Object.freeze({
    contract_version: CANONICAL_ACTIVITY_CONTRACT_VERSION,
    agent_id: AGENT_ID,
    incarnation_id: incarnationId,
    entry_id: entryId,
    body: Object.freeze({
      type: "tool_execution_end",
      toolCallId,
      toolName,
      origin,
      ...(parentToolCallId === undefined ? {} : { parentToolCallId }),
      ...(executionGeneration === undefined ? {} : { executionGeneration }),
      isError,
      ...(summary === undefined ? {} : { summary }),
      ...(errorText === undefined ? {} : { errorText }),
      ...(errorCode === undefined ? {} : { errorCode }),
    }),
  });
}

function displayDelta(
  streamId: string,
  sequence: number,
  contentIndex: number,
  contentType: "text" | "thinking",
  delta: string,
  agentId: string = AGENT_ID,
  incarnationId: string = INCARNATION_ID,
): SafeAgentActivityDisplayEvent {
  return Object.freeze({
    type: "message_delta",
    streamId,
    sequence,
    contentIndex,
    contentType,
    delta,
    agentId,
    incarnationId,
  });
}

function displayComplete(
  streamId: string,
  sequence: number,
  agentId: string = AGENT_ID,
  incarnationId: string = INCARNATION_ID,
): SafeAgentActivityDisplayEvent {
  return Object.freeze({ type: "message_complete", streamId, sequence, agentId, incarnationId });
}

/** 顶层草稿登记表装配：按给定事件序列组装后返回该代理的草稿快照。 */
function assembledDrafts(
  events: readonly SafeAgentActivityDisplayEvent[],
  agentId: string = AGENT_ID,
): readonly AgentDisplayDraftView[] {
  const registry = new AgentDisplayDraftRegistry();
  for (const event of events) registry.applyEvent(agentId, event);
  return registry.drafts(agentId);
}

/** 构造独立对象的 thinking 草稿快照，用于验证查看器的快照等价与状态切换。 */
function thinkingDraftSnapshot(
  state: AgentDisplayDraftView["state"],
  key = `${INCARNATION_ID}|message-1`,
  value = "流式思考",
): readonly AgentDisplayDraftView[] {
  return Object.freeze([
    Object.freeze({
      key,
      state,
      blocks: Object.freeze([
        Object.freeze({ contentIndex: 0, contentType: "thinking" as const, value }),
      ]),
    }),
  ]);
}

function activitySnapshot(
  entries: readonly CanonicalAgentActivityEntry[],
  revision: number,
  olderActivityOmitted = false,
  snapshotEpoch = 0,
): AgentActivitySnapshot {
  return Object.freeze({
    snapshotEpoch,
    entries: Object.freeze([...entries]),
    revision,
    olderActivityOmitted,
  });
}

/** 4 行正文消息 + 一条完成工具 = 6 行事件正文。 */
function replayFixture(): readonly CanonicalAgentActivityEntry[] {
  return Object.freeze([
    textMessage("line1\nline2\nline3\nline4"),
    toolStart("t1", "read_file"),
    toolEnd("t1", "read_file", false),
  ]);
}

test("打开即回放全部规范条目历史", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), replayFixture());
  const lines = viewer.render(160);

  assert.match(lines[0] ?? "", /worker · worker-a · working/);
  assert.ok(lines.some((line) => line.includes("line1")), lines.join("\n"));
  assert.ok(lines.some((line) => line.includes("line4")));
  assert.ok(lines.some((line) => line.includes("read_file")), lines.join("\n"));
  assert.equal(viewer.getPublicState().event_count, 3);
});

test("模型调用失败条目折叠为一行 ▸ × Error: 错误文本首行", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    modelFailureEntry("401 unauthorized\nx-request-id: abc"),
  ], { viewport_height: 20 });
  const lines = viewer.render(160).slice(1, -1);
  assert.deepEqual(lines.filter((line) => line.length > 0), ["▸ × Error: 401 unauthorized"]);
  // 折叠态不带动 provider/model 或错误正文其余行。
  assert.doesNotMatch(lines[0] ?? "", /x-request-id|anthropic|claude/u);
  assert.equal(viewer.getPublicState().event_count, 1);
  // 失败条目只服务历史显示，不抢实时草稿的空白投影。
  assert.deepEqual(viewer.getExpandedKeys(), []);
});

test("错误文本以空行开头时折叠行取第一个非空行", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    modelFailureEntry("\n\n429 rate limited\nretry-after: 5"),
  ], { viewport_height: 20 });
  assert.deepEqual(
    viewer.render(160).slice(1, -1).filter((line) => line.length > 0),
    ["▸ × Error: 429 rate limited"],
  );
});

test("模型调用失败条目折叠行带展开标记，默认选中并沿用既有展开按键", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    modelFailureEntry("401 unauthorized\nx-request-id: abc"),
  ], { viewport_height: 20 });
  const selected = viewer.getSelectedKey();
  assert.match(selected ?? "", /^model-call-failure:/u);
  assert.deepEqual(viewer.getExpandedKeys(), []);
  // 折叠态仍只有一行标题：不出现行数提示或额外说明文案。
  assert.deepEqual(
    viewer.render(160).slice(1, -1).filter((line) => line.length > 0),
    ["▸ × Error: 401 unauthorized"],
  );

  // 沿用既有交互：Enter 展开当前选中项，左方向键折叠。
  assert.equal(viewer.handleInput("\r"), "changed");
  const expandLines = viewer.render(160).slice(1, -1).filter((line) => line.length > 0);
  assert.equal(expandLines[0], "▾ × Error: 401 unauthorized");
  assert.deepEqual(viewer.getExpandedKeys(), [selected]);

  assert.equal(viewer.handleInput("\x1b[D"), "changed");
  assert.deepEqual(
    viewer.render(160).slice(1, -1).filter((line) => line.length > 0),
    ["▸ × Error: 401 unauthorized"],
  );
});

test("缺身份的失败条目折叠行不变，展开体直接以错误原文开头且不留空行", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    identitylessModelFailureEntry("compaction summarization failed\n  detail line"),
  ], { viewport_height: 20 });
  assert.deepEqual(
    viewer.render(160).slice(1, -1).filter((line) => line.length > 0),
    ["▸ × Error: compaction summarization failed"],
  );
  assert.equal(viewer.handleInput("\r"), "changed");
  const lines = viewer.render(160).slice(1, -1).filter((line) => line.length > 0);
  // 正文直接从错误原文开始：没有身份行、没有空行、没有占位文案。
  assert.deepEqual(lines.map((line) => line.trimEnd()), [
    "▾ × Error: compaction summarization failed",
    "│ compaction summarization failed",
    "│   detail line",
  ]);
  assert.doesNotMatch(lines.join("\n"), /anthropic|claude|·|n\/a|unknown identity/iu);
});

test("展开模型调用失败条目：首行 provider · model，其后为逐字保留换行与前导空白的错误原文", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    modelFailureEntry("401 unauthorized\n  x-request-id: abc\n\nsecond *literal* line"),
  ], { viewport_height: 20 });
  assert.equal(viewer.handleInput("\r"), "changed");
  const lines = viewer.render(160).slice(1, -1).filter((line) => line.length > 0);
  assert.equal(lines[0], "▾ × Error: 401 unauthorized");
  // 展开体逐行带引导线；空白行仍占一行、前导空白不被压缩、Markdown 不被解析。
  assert.deepEqual(lines.slice(1).map((line) => line.trimEnd()), [
    "│ anthropic · claude-sonnet-4-20250514",
    "│ 401 unauthorized",
    "│   x-request-id: abc",
    "│",
    "│ second *literal* line",
  ]);
});

test("展开的失败正文按面板宽度软折行，宽度变化后按新宽度重新折行", () => {
  const message = "provider said: " + "x".repeat(40);
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    modelFailureEntry(message),
  ], { viewport_height: 20 });
  assert.equal(viewer.handleInput("\r"), "changed");
  const bodyOf = (width: number): readonly string[] => viewer
    .render(width)
    .slice(1, -1)
    .filter((line) => line.startsWith("│"))
    .map((line) => line.replace(/^│ /u, ""));

  const narrow = bodyOf(40);
  const wide = bodyOf(160);
  assert.deepEqual(wide, ["anthropic · claude-sonnet-4-20250514", message]);
  assert.ok(narrow.length > wide.length, narrow.join("\n"));
  // 宽度变化只改变折行位置，不改变正文内容与顺序。
  const compact = (lines: readonly string[]): string => lines.join("").replace(/\s+/gu, "");
  assert.equal(compact(narrow), compact(wide));
  for (const line of narrow) assert.ok(displayWidth(`│ ${line}`) <= 40, `│ ${line}`);
});

test("模型调用失败条目使用错误色与 × 图标，并提供既有展开入口", () => {
  const theme = {
    fg: (color: string, text: string): string => `<fg:${color}>${text}</fg:${color}>`,
    bg: (color: string, text: string): string => `<bg:${color}>${text}</bg:${color}>`,
    bold: (text: string): string => `<bold>${text}</bold>`,
  };
  const viewer = new AgentActivityViewerModel(viewerAgent(), [modelFailureEntry("boom")], {
    viewport_height: 20,
  });
  const surface = renderAgentActivityViewerSurface(viewer, 120, theme).join("\n");
  assert.match(surface, /<fg:error>×<\/fg:error>/u);
  assert.match(surface, /<fg:error><bold>Error: boom<\/bold><\/fg:error>/u);
  // 展开标记沿用工具条目同一套呈现：折叠 `▸`、展开后 `▾`。
  assert.match(surface, /▸/u);
  assert.doesNotMatch(surface, /▾/u, surface);

  // 展开体与工具失败展开体同款：错误色预格式化正文，逐行带引导线。
  assert.equal(viewer.handleInput("\r"), "changed");
  const expandedSurface = renderAgentActivityViewerSurface(viewer, 120, theme).join("\n");
  assert.match(expandedSurface, /▾/u);
  assert.match(expandedSurface, /<fg:error>│ anthropic · claude-sonnet-4-20250514/u);
  assert.match(expandedSurface, /<fg:error>│ boom/u);
});

test("展开的失败正文与工具失败展开体同款：同样的错误文本逐行一致", () => {
  const errorText = "Error: EACCES: permission denied\n  at open('/etc/hosts')\n\nsecond *literal* line";
  const toolViewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t1", "write", true, "pi_native", INCARNATION_ID, { tool: "write", path: "/etc/hosts" }, errorText),
  ], { viewport_height: 20 });
  assert.equal(toolViewer.handleInput("\r"), "changed");
  const toolBody = toolViewer.render(120).slice(1, -1).filter((line) => line.startsWith("│"));
  assert.ok(toolBody.length > 1, toolBody.join("\n"));

  const failureViewer = new AgentActivityViewerModel(viewerAgent(), [
    modelFailureEntry(errorText),
  ], { viewport_height: 20 });
  assert.equal(failureViewer.handleInput("\r"), "changed");
  const failureBody = failureViewer.render(120).slice(1, -1).filter((line) => line.startsWith("│"));
  // 首行是 provider · model 事实；其余行与工具失败展开体逐行相同。
  assert.deepEqual(failureBody.slice(1), toolBody);
});

test("已中止收尾与错误收尾条目完全同形：同图标、同文案前缀、同样式", () => {
  const theme = {
    fg: (color: string, text: string): string => `<fg:${color}>${text}</fg:${color}>`,
    bg: (color: string, text: string): string => `<bg:${color}>${text}</bg:${color}>`,
    bold: (text: string): string => `<bold>${text}</bold>`,
  };
  const renderWith = (failure: "error" | "aborted"): string => {
    const viewer = new AgentActivityViewerModel(viewerAgent(), [
      modelFailureEntry("Operation aborted", failure),
    ], { viewport_height: 20 });
    return renderAgentActivityViewerSurface(viewer, 120, theme).join("\n");
  };
  const errorSurface = renderWith("error");
  // 收尾原因只作为事实保留，不参与任何呈现分支。
  assert.equal(renderWith("aborted"), errorSurface);
  assert.match(errorSurface, /<fg:error><bold>Error: Operation aborted<\/bold><\/fg:error>/u);
});

test("模型调用失败条目与既有条目按到达序共存且不影响其渲染", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    textMessage("第一段正文"),
    modelFailureEntry("配额用尽"),
    toolStart("t1", "read_file"),
    toolEnd("t1", "read_file", false),
    modelFailureEntry("重试仍失败"),
  ], { viewport_height: 20 });
  const lines = viewer.render(160).slice(1, -1).filter((line) => line.length > 0);
  assert.deepEqual(lines, [
    "第一段正文",
    "▸ × Error: 配额用尽",
    "✓ read_file",
    "▸ × Error: 重试仍失败",
  ]);
  assert.equal(viewer.getPublicState().event_count, 5);
  assert.match(viewer.render(160)[0] ?? "", /worker · worker-a · working/u);
});

test("超宽失败行按面板既有规则右侧省略", () => {
  const width = 40;
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    modelFailureEntry("provider said: " + "x".repeat(200)),
  ], { viewport_height: 20 });
  const line = viewer.render(width).slice(1, -1)[0] ?? "";
  assert.ok(displayWidth(line) <= width, line);
  assert.match(line, /…$/u);
});

test("模型调用失败条目不进入实时显示草稿投影", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [modelFailureEntry("boom")], {
    viewport_height: 20,
  });
  const body = viewer.render(160).slice(1, -1).join("\n");
  assert.doesNotMatch(body, /Thinking|streaming/u);
  assert.deepEqual(viewer.getPublicState().event_count, 1);
});

test("snapshot 同槽位把工具 start 原地更新为 end，并按 revision 幂等", () => {
  const entryId = randomUUID();
  const summary = { tool: "bash", command: "npm test", timeout: 5 } as const;
  const start = toolStart("snapshot-tool", "bash", "pi_native", INCARNATION_ID, summary, entryId);
  const end = toolEnd(
    "snapshot-tool",
    "bash",
    false,
    "pi_native",
    INCARNATION_ID,
    summary,
    undefined,
    undefined,
    entryId,
  );
  const viewer = new AgentActivityViewerModel(
    viewerAgent(),
    activitySnapshot([start], 1),
    { viewport_height: 20 },
  );
  const selected = viewer.getSelectedKey();
  assert.match(selected ?? "", /^tool-command:/u);
  assert.equal(viewer.handleInput("\r"), "changed");
  assert.deepEqual(viewer.getExpandedKeys(), [selected]);
  assert.match(viewer.render(120).join("\n"), /↻ bash.*npm test/us);

  assert.equal(viewer.syncSnapshot(activitySnapshot([end], 2)), "changed");
  const completed = viewer.render(120).slice(1, -1);
  assert.ok(completed.some((line) => line.includes("✓ bash")), completed.join("\n"));
  assert.ok(completed.includes("│ npm test"), completed.join("\n"));
  assert.doesNotMatch(completed.join("\n"), /↻/u);
  assert.equal(completed.filter((line) => line.includes("bash")).length, 1);
  assert.equal(viewer.getPublicState().event_count, 1);
  assert.equal(viewer.getSelectedKey(), selected);
  assert.deepEqual(viewer.getExpandedKeys(), [selected]);

  // 同一 revision 即使携带旧内容也必须 no-op，不能把完成态回退。
  assert.equal(viewer.syncSnapshot(activitySnapshot([start], 2)), "ignored");
  assert.match(viewer.render(120).join("\n"), /✓ bash/u);
});

test("新 snapshot epoch 接纳清空并重置存活查看器的交互状态", () => {
  const start = toolStart("epoch-tool", "bash", "pi_native", INCARNATION_ID, {
    tool: "bash", command: "echo before",
  });
  const viewer = new AgentActivityViewerModel(
    viewerAgent(),
    activitySnapshot([start], 8, false, 4),
    { viewport_height: 3 },
  );
  const selected = viewer.getSelectedKey();
  assert.ok(selected !== undefined);
  assert.equal(viewer.handleInput("\r"), "changed");
  assert.deepEqual(viewer.getExpandedKeys(), [selected]);
  assert.equal(viewer.getPublicState().follow_enabled, false);

  assert.equal(viewer.syncSnapshot(activitySnapshot([], 0, false, 5)), "changed");
  assert.equal(viewer.getPublicState().event_count, 0);
  assert.equal(viewer.getSelectedKey(), undefined);
  assert.deepEqual(viewer.getExpandedKeys(), []);
  assert.equal(viewer.getPublicState().follow_enabled, true);
  assert.equal(viewer.getPublicState().scroll_offset, 0);

  const after = textMessage("新观察代际");
  assert.equal(viewer.syncSnapshot(activitySnapshot([after], 1, false, 5)), "changed");
  assert.match(viewer.render(120).join("\n"), /新观察代际/u);
  // 旧代际即使携带更高 revision 也绝不能回退当前显示。
  assert.equal(viewer.syncSnapshot(activitySnapshot([start], 99, false, 4)), "ignored");
  assert.match(viewer.render(120).join("\n"), /新观察代际/u);
});

test("snapshot 100 条窗口滑动不会被同长度游标忽略，follow 始终贴尾", () => {
  const initial = Array.from({ length: 100 }, (_, index) => textMessage(`activity-${index}`));
  const viewer = new AgentActivityViewerModel(
    viewerAgent(),
    activitySnapshot(initial, 1),
    { viewport_height: 3 },
  );
  assert.equal(viewer.getPublicState().scroll_offset, 97);

  const next = [...initial.slice(1), textMessage("activity-100")];
  assert.equal(viewer.syncSnapshot(activitySnapshot(next, 2, true)), "changed");
  const state = viewer.getPublicState();
  assert.equal(state.event_count, 100);
  assert.equal(state.follow_enabled, true);
  assert.equal(state.scroll_offset, state.max_scroll_offset);
  assert.match(viewer.render(120).join("\n"), /activity-100/u);

  assert.equal(viewer.handleInput("\x1b[H"), "changed");
  const top = viewer.render(120).slice(1, -1);
  assert.equal(top[0], "Older activity omitted");
  assert.match(top[1] ?? "", /activity-1/u);
  assert.doesNotMatch(top.join("\n"), /activity-0/u);
});

test("omission-only snapshot 显示固定 dim 提示且不计数、不参与选择", () => {
  const thinking = messageEntry([{ type: "thinking", thinking: "保留思考" }]);
  const viewer = new AgentActivityViewerModel(
    viewerAgent(),
    activitySnapshot([thinking], 4),
    { viewport_height: 20 },
  );
  const selected = viewer.getSelectedKey();
  assert.ok(selected !== undefined);

  assert.equal(viewer.syncSnapshot(activitySnapshot([thinking], 5, true)), "changed");
  assert.equal(viewer.render(120).slice(1, -1)[0], "Older activity omitted");
  assert.equal(viewer.getPublicState().event_count, 1);
  assert.equal(viewer.getSelectedKey(), selected);
  assert.deepEqual(viewer.getExpandedKeys(), []);

  const surface = renderAgentActivityViewerSurface(viewer, 120, Object.freeze({
    fg: (color: string, text: string): string => `<fg:${color}>${text}</fg:${color}>`,
    bg: (color: string, text: string): string => `<bg:${color}>${text}</bg:${color}>`,
    bold: (text: string): string => `<bold>${text}</bold>`,
  })).join("\n");
  assert.match(surface, /<fg:dim>Older activity omitted/u);
});

test("snapshot 淘汰选中项时优先选择其后 survivor，再选其前并清理展开键", () => {
  const [first, selectedEntry, after, last, appended] = [
    "first", "selected", "after", "last", "appended",
  ].map((label) => messageEntry([{ type: "thinking", thinking: label }]));
  const viewer = new AgentActivityViewerModel(
    viewerAgent(),
    activitySnapshot([first!, selectedEntry!, after!, last!], 1),
    { viewport_height: 2 },
  );

  assert.equal(viewer.handleInput("\t"), "changed");
  const firstKey = viewer.getSelectedKey();
  assert.equal(viewer.handleInput("\r"), "changed");
  assert.equal(viewer.handleInput("\t"), "changed");
  const removedKey = viewer.getSelectedKey();
  assert.equal(viewer.handleInput("\r"), "changed");
  assert.deepEqual(new Set(viewer.getExpandedKeys()), new Set([firstKey, removedKey]));

  assert.equal(viewer.syncSnapshot(activitySnapshot([
    first!, after!, last!, appended!,
  ], 2, true)), "changed");
  assert.equal(viewer.getSelectedKey(), `thinking:${after!.entry_id}:0`);
  assert.deepEqual(viewer.getExpandedKeys(), [firstKey]);

  // 没有其后 survivor 时回退到其前；没有任何候选时清空选择与展开。
  assert.equal(viewer.syncSnapshot(activitySnapshot([first!], 3, true)), "changed");
  assert.equal(viewer.getSelectedKey(), firstKey);
  assert.deepEqual(viewer.getExpandedKeys(), [firstKey]);
  assert.equal(viewer.syncSnapshot(activitySnapshot([textMessage("only text")], 4, true)), "changed");
  assert.equal(viewer.getSelectedKey(), undefined);
  assert.deepEqual(viewer.getExpandedKeys(), []);
  const state = viewer.getPublicState();
  assert.ok(state.scroll_offset >= 0 && state.scroll_offset <= state.max_scroll_offset);
});

test("snapshot 缩短时暂停位置保持并 clamp，恢复增长后不擅自 follow", () => {
  const entries = Array.from({ length: 8 }, (_, index) => textMessage(`scroll-${index}`));
  const viewer = new AgentActivityViewerModel(
    viewerAgent(),
    activitySnapshot(entries, 1),
    { viewport_height: 3 },
  );
  assert.equal(viewer.handleInput("\x1b[H"), "changed");
  assert.equal(viewer.handleInput("j"), "changed");
  assert.equal(viewer.handleInput("j"), "changed");
  assert.equal(viewer.getPublicState().scroll_offset, 2);

  assert.equal(viewer.syncSnapshot(activitySnapshot(entries.slice(0, 4), 2)), "changed");
  let state = viewer.getPublicState();
  assert.equal(state.follow_enabled, false);
  assert.equal(state.scroll_offset, 1);
  assert.equal(state.max_scroll_offset, 1);

  assert.equal(viewer.syncSnapshot(activitySnapshot(entries, 3)), "changed");
  state = viewer.getPublicState();
  assert.equal(state.follow_enabled, false);
  assert.equal(state.scroll_offset, 1);
  assert.ok(state.scroll_offset <= state.max_scroll_offset);
});

test("snapshot 窗口移动不改变既有工具收束，也不让后来工具继承旧 settlement", () => {
  const settledId = randomUUID();
  const settled = toolStart("settled", "read_file", "unknown", INCARNATION_ID, undefined, settledId);
  const viewer = new AgentActivityViewerModel(
    viewerAgent("idle"),
    activitySnapshot([textMessage("older"), settled], 1),
    { viewport_height: 20 },
  );
  assert.match(viewer.render(120).join("\n"), /read_file · result unavailable/u);

  assert.equal(viewer.syncSnapshot(activitySnapshot([settled], 2, true)), "changed");
  assert.match(viewer.render(120).join("\n"), /read_file · result unavailable/u);

  const later = toolStart("later", "wait_agent", "plugin");
  assert.equal(viewer.syncSnapshot(activitySnapshot([settled, later], 3, true)), "changed");
  const body = viewer.render(120).join("\n");
  assert.match(body, /read_file · result unavailable/u);
  assert.match(body, /↻ wait_agent · …/u);
  assert.doesNotMatch(
    body.split("\n").find((line) => line.includes("wait_agent")) ?? "",
    /result unavailable/u,
  );
});

test("工具开始立即建立运行中条目，结束原地更新同一条目且不产生独立结果行", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolStart("t1", "read_file"),
  ], { viewport_height: 20 });
  let lines = viewer.render(160).slice(1, -1).join("\n");
  assert.match(lines, /↻ read_file/u);
  assert.doesNotMatch(lines, /✓|×/u);

  viewer.syncFrom([toolStart("t1", "read_file"), toolEnd("t1", "read_file", false)]);
  lines = viewer.render(160).slice(1, -1).join("\n");
  assert.match(lines, /✓ read_file/u);
  assert.doesNotMatch(lines, /↻/u);
  // 不显示执行耗时。
  assert.doesNotMatch(lines, /ms|耗时|elapsed/u);
  // 一次调用只有一个条目：结束不产生第二行。
  assert.equal(
    viewer.render(160).slice(1, -1).filter((line) => line.includes("read_file")).length,
    1,
  );

  viewer.syncFrom([
    toolStart("t1", "read_file"),
    toolEnd("t1", "read_file", false),
    toolStart("t2", "run_cmd"),
    toolEnd("t2", "run_cmd", true),
  ]);
  lines = viewer.render(160).slice(1, -1).join("\n");
  assert.match(lines, /✓ read_file/u);
  assert.match(lines, /× run_cmd/u);
});

test("查看器按 executionGeneration 分离同 toolCallId 的复用执行", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolStart("reused", "read_file", "unknown", INCARNATION_ID, undefined, "11111111-1111-4111-8111-111111111111", 1),
    toolEnd("reused", "read_file", false, "unknown", INCARNATION_ID, undefined, undefined, undefined, "11111111-1111-4111-8111-111111111111", 1),
    toolStart("reused", "read_file", "unknown", INCARNATION_ID, undefined, "22222222-2222-4222-8222-222222222222", 2),
    toolEnd("reused", "read_file", true, "unknown", INCARNATION_ID, undefined, undefined, undefined, "22222222-2222-4222-8222-222222222222", 2),
  ], { viewport_height: 20 });
  const lines = viewer.render(160).slice(1, -1).filter((line) => line.includes("read_file"));
  assert.equal(lines.length, 2);
  assert.match(lines[0] ?? "", /✓ read_file/u);
  assert.match(lines[1] ?? "", /× read_file/u);
});


test("工具状态图标前置，标题颜色跟随状态，折叠指示符始终为 dim", () => {
  const theme = {
    fg: (color: string, text: string): string => `<fg:${color}>${text}</fg:${color}>`,
    bg: (color: string, text: string): string => `<bg:${color}>${text}</bg:${color}>`,
    bold: (text: string): string => `<bold>${text}</bold>`,
  };
  const summary = { tool: "bash", command: "echo ok", timeout: 5 } as const;

  const running = new AgentActivityViewerModel(viewerAgent(), [
    toolStart("t1", "bash", "pi_native", INCARNATION_ID, summary),
  ], { viewport_height: 20 });
  const runningLine = running.render(120).find((line) => line.includes("bash"));
  assert.equal(runningLine, "▸ ↻ bash · timeout 5");
  const runningSurface = renderAgentActivityViewerSurface(running, 120, theme).join("\n");
  assert.match(
    runningSurface,
    /<fg:dim>▸<\/fg:dim> <fg:accent>↻<\/fg:accent> <fg:accent><bold>bash · timeout 5<\/bold><\/fg:accent>/u,
  );

  const success = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t1", "bash", false, "pi_native", INCARNATION_ID, summary),
  ], { viewport_height: 20 });
  const successLine = success.render(120).find((line) => line.includes("bash"));
  assert.equal(successLine, "▸ ✓ bash · timeout 5");
  const successSurface = renderAgentActivityViewerSurface(success, 120, theme).join("\n");
  assert.match(
    successSurface,
    /<fg:dim>▸<\/fg:dim> <fg:dim>✓<\/fg:dim> <fg:dim><bold>bash · timeout 5<\/bold><\/fg:dim>/u,
  );
  assert.doesNotMatch(successSurface, /<fg:error>/u);

  const failure = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t1", "bash", true, "pi_native", INCARNATION_ID, summary),
  ], { viewport_height: 20 });
  const failureLine = failure.render(120).find((line) => line.includes("bash"));
  assert.equal(failureLine, "▸ × bash · timeout 5");
  const failureSurface = renderAgentActivityViewerSurface(failure, 120, theme).join("\n");
  assert.match(
    failureSurface,
    /<fg:dim>▸<\/fg:dim> <fg:error>×<\/fg:error> <fg:error><bold>bash · timeout 5<\/bold><\/fg:error>/u,
  );

  const plain = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t2", "read_file", false),
  ], { viewport_height: 20 });
  const plainLine = plain.render(120).find((line) => line.includes("read_file"));
  assert.equal(plainLine, "✓ read_file");
  const plainSurface = renderAgentActivityViewerSurface(plain, 120, theme).join("\n");
  assert.match(
    plainSurface,
    /<fg:dim>✓<\/fg:dim> <fg:dim><bold>read_file<\/bold><\/fg:dim>/u,
  );
});

test("安全兜底只显示工具名与前置状态，不显示参数、结果或错误正文", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolStart("t1", "read_file", "unknown"),
    toolEnd("t1", "read_file", true, "unknown"),
    toolStart("t2", "query_database", "unknown"),
    toolEnd("t2", "query_database", false, "unknown"),
  ], { viewport_height: 20 });
  const body = viewer.render(160).slice(1, -1).join("\n");

  assert.match(body, /× read_file/u);
  assert.match(body, /✓ query_database/u);
  // 任何载荷、错误正文与可展开入口都不出现。
  assert.doesNotMatch(body, /collapsed|Enter to expand/u);
  assert.equal(
    viewer.render(160).slice(1, -1).filter((line) => line.includes("read_file")).length,
    1,
  );
  // 兜底条目不可展开：不参与选择循环。
  for (const key of viewer.getExpandedKeys()) {
    assert.doesNotMatch(key, /tool:/u);
  }
});

test("结束先到时自建完成条目，迟到开始被忽略且不重置状态", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t1", "read_file", false),
  ], { viewport_height: 20 });
  assert.match(viewer.render(160).slice(1, -1).join("\n"), /✓ read_file/u);

  // 迟到开始不得把完成条目退回运行中。
  viewer.syncFrom([toolEnd("t1", "read_file", false), toolStart("t1", "read_file")]);
  const body = viewer.render(160).slice(1, -1).join("\n");
  assert.match(body, /✓ read_file/u);
  assert.doesNotMatch(body, /↻/u);
  assert.equal(viewer.getPublicState().event_count, 2);
});

test("重复开始与重复结束保持幂等", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolStart("t1", "read_file"),
    toolStart("t1", "read_file"),
    toolEnd("t1", "read_file", false),
    toolEnd("t1", "read_file", false),
  ], { viewport_height: 20 });

  const body = viewer.render(160).slice(1, -1).join("\n");
  assert.match(body, /✓ read_file/u);
  assert.doesNotMatch(body, /↻/u);
  assert.equal(
    viewer.render(160).slice(1, -1).filter((line) => line.includes("read_file")).length,
    1,
  );
});

test("代理进入 idle 时运行中工具收束为警告 result unavailable，匹配结束仍可回填", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent("idle"), [
    toolStart("t1", "read_file"),
  ], { viewport_height: 20 });
  const lines = viewer.render(160).slice(1, -1);
  assert.match(lines.join("\n"), /read_file · result unavailable/u);
  assert.ok(lines.some((line) => line.includes("read_file") && !line.includes("↻")));

  // 收束后身份匹配的结束事实回填真实状态。
  viewer.syncFrom([toolStart("t1", "read_file"), toolEnd("t1", "read_file", false)]);
  assert.match(viewer.render(160).slice(1, -1).join("\n"), /✓ read_file/u);
  assert.doesNotMatch(viewer.render(160).slice(1, -1).join("\n"), /result unavailable/u);
});

test("代理进入 failed 与 terminated 时按各自语义收束运行中工具", () => {
  const failed = new AgentActivityViewerModel(viewerAgent("failed"), [
    toolStart("t1", "read_file"),
  ], { viewport_height: 20 });
  const failedLines = failed.render(160).slice(1, -1);
  assert.ok(failedLines.some((line) => line.includes("read_file") && !line.includes("↻")));

  const terminated = new AgentActivityViewerModel(viewerAgent("terminated"), [
    toolStart("t1", "read_file"),
  ], { viewport_height: 20 });
  const terminatedBody = terminated.render(160).slice(1, -1).join("\n");
  assert.match(terminatedBody, /read_file · terminated before result/u);

  // 终态收束后匹配结束仍可回填；失败结束回填为真实失败。
  terminated.syncFrom([toolStart("t1", "read_file"), toolEnd("t1", "read_file", true)]);
  assert.match(terminated.render(160).slice(1, -1).join("\n"), /× read_file/u);
  assert.doesNotMatch(
    terminated.render(160).slice(1, -1).join("\n"),
    /terminated before result/u,
  );
});

test("非终态生命周期不收束运行中工具，收束只发生在 idle/failed/terminated", () => {
  for (const state of [
    "starting",
    "working",
    "interrupting",
    "terminating",
  ] as const) {
    const viewer = new AgentActivityViewerModel(viewerAgent(state), [
      toolStart("t1", "read_file"),
    ], { viewport_height: 20 });
    const body = viewer.render(160).slice(1, -1).join("\n");
    assert.match(body, /↻ read_file/u, state);
    assert.doesNotMatch(body, /result unavailable|terminated before result/u, state);
  }
});

test("生命周期变化立即失效投影：working 期间进入 idle 即收束运行中工具", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent("working"), [
    toolStart("t1", "read_file"),
  ], { viewport_height: 20 });
  assert.match(viewer.render(160).slice(1, -1).join("\n"), /↻ read_file/u);

  // 不需要任何新事件：进入 idle 后运行中工具立即收束为警告。
  assert.equal(viewer.updateLifecycle("idle"), "changed");
  assert.match(viewer.render(160).slice(1, -1).join("\n"), /result unavailable/u);
});

test("wait_agent 早到于 working 快照且尚无摘要时显示等待中", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent("idle"), [
    toolStart("previous", "read_file"),
  ], { viewport_height: 20 });
  assert.match(viewer.render(160).slice(1, -1).join("\n"), /result unavailable/u);

  // 工具开始事件可能先于 working 生命周期快照到达；不能继承上一回合收束。
  viewer.appendEntry(toolStart("waiting", "wait_agent", "plugin"));
  let body = viewer.render(160).slice(1, -1);
  let waitLine = body.find((line) => line.includes("wait_agent"));
  assert.equal(waitLine, "↻ wait_agent · …");
  assert.doesNotMatch(waitLine ?? "", /result unavailable/u);
  // 上一回合已经收束的工具仍保持收束，不被新工具反向恢复。
  assert.ok(body.some((line) => line.includes("read_file · result unavailable")), body.join("\n"));

  assert.equal(viewer.updateLifecycle("working"), "changed");
  body = viewer.render(160).slice(1, -1);
  waitLine = body.find((line) => line.includes("wait_agent"));
  assert.equal(waitLine, "↻ wait_agent · …");
});

test("不同运行实例的同名工具活动不互相回填或合并", () => {
  const otherIncarnation = "2c3b4d5e-6f70-4a81-9b2c-3d4e5f6a7b8c";
  const viewer = new AgentActivityViewerModel(viewerAgent("terminated"), [
    toolStart("t1", "read_file"),
  ], { viewport_height: 20 });
  assert.match(viewer.render(160).slice(1, -1).join("\n"), /terminated before result/u);

  // 另一运行实例的同 ID 结束事实身份不匹配：既不回填也不串流。
  viewer.syncFrom([toolEnd("t1", "read_file", false, "unknown", otherIncarnation)]);
  const body = viewer.render(160).slice(1, -1).join("\n");
  assert.match(body, /terminated before result/u);
  assert.doesNotMatch(body, /✓ read_file/u);
  assert.doesNotMatch(body, /↻ read_file/u);
});

test("工具取消按普通失败显示", () => {
  const theme = {
    fg: (color: string, text: string): string => `<fg:${color}>${text}</fg:${color}>`,
    bg: (color: string, text: string): string => `<bg:${color}>${text}</bg:${color}>`,
    bold: (text: string): string => `<bold>${text}</bold>`,
  };
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolStart("t1", "bash"),
    toolEnd("t1", "bash", true),
  ], { viewport_height: 20 });

  const body = viewer.render(160).slice(1, -1).join("\n");
  assert.match(body, /× bash/u);
  const surface = renderAgentActivityViewerSurface(viewer, 120, theme).join("\n");
  assert.match(surface, /<fg:error>×<\/fg:error>/u);
});

test("生命周期收束不可逆：回看与重放不会把收束条目退回运行中", () => {
  const entries = [toolStart("t1", "read_file")];
  const viewer = new AgentActivityViewerModel(viewerAgent("terminated"), entries, {
    viewport_height: 20,
  });
  assert.match(viewer.render(160).slice(1, -1).join("\n"), /terminated before result/u);

  // lifecycle 回到 working 也不恢复运行中显示（收束只由条目事实回填）。
  viewer.updateLifecycle("working");
  assert.doesNotMatch(viewer.render(160).slice(1, -1).join("\n"), /↻ read_file/u);
});

test("text block 独立按正常 Markdown 完整渲染，不加角色标签或分隔线", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    messageEntry([
      { type: "text", text: "# First block\n\nunclosed **bold" },
      { type: "text", text: "## Second block\n\ncomplete" },
    ]),
  ], { viewport_height: 20 });
  const body = viewer.render(80).slice(1, -1).join("\n");

  assert.ok(body.includes("First block"), body);
  assert.ok(body.includes("Second block"), body);
  // 前一块未闭合语法不破坏后一块；无角色标签、消息容器或分隔线。
  assert.doesNotMatch(body, /Assistant|assistant/u);
  assert.doesNotMatch(body, /━|┃/u);
  // 每块独立解析：未闭合 bold 不会跨块吞掉后文。
  assert.ok(body.includes("complete"), body);
});

test("超长 text 仍完整渲染，不按长度折叠", () => {
  const long = "很长的报告正文。".repeat(4000);
  const viewer = new AgentActivityViewerModel(viewerAgent(), [textMessage(long)], {
    viewport_height: 20,
  });
  const body = viewer.render(160).slice(1, -1).join("\n");

  assert.ok(body.includes("很长的报告正文。"), body);
  assert.doesNotMatch(body, /collapsed|省略|truncated/u);
});

test("3 MB ASCII 正文尾部惰性布局后仍完整保留，并精确响应 End", () => {
  const markers = Array.from({ length: 30_000 }, (_, index) => (
    `marker-${String(index).padStart(5, "0")} ${"x".repeat(89)}`
  ));
  const finalLine = "z".repeat(43);
  const expected = [...markers, finalLine];
  const source = expected.join("\n");
  assert.equal(Buffer.byteLength(source), 3_090_043);

  const viewer = new AgentActivityViewerModel(viewerAgent(), [textMessage(source)], {
    viewport_height: 3,
  });
  assert.deepEqual(viewer.render(120).slice(1, -1), expected.slice(-3));

  let state = viewer.getPublicState();
  assert.equal(state.max_scroll_offset, expected.length - 3);
  assert.equal(state.scroll_offset, state.max_scroll_offset);
  assert.equal(viewer.handleInput("\x1b[H"), "changed");
  assert.deepEqual(viewer.render(120).slice(1, -1), expected.slice(0, 3));
  for (let index = 0; index < 15_000; index += 1) viewer.handleInput("\x1b[B");
  assert.deepEqual(viewer.render(120).slice(1, -1), expected.slice(15_000, 15_003));
  assert.equal(viewer.handleInput("\x1b[F"), "changed");
  state = viewer.getPublicState();
  assert.equal(state.scroll_offset, state.max_scroll_offset);
  assert.deepEqual(viewer.render(120).slice(1, -1), expected.slice(-3));
});

test("长单行正文的尾部窗口保持自然软换行顺序", () => {
  const segments = Array.from({ length: 1_000 }, (_, index) => `part-${String(index).padStart(4, "0")}`);
  const viewer = new AgentActivityViewerModel(viewerAgent(), [textMessage(segments.join(" "))], {
    viewport_height: 3,
  });

  assert.deepEqual(viewer.render(10).slice(1, -1), segments.slice(-3));
});

test("长简单 CJK 正文的尾部窗口保持字素宽度与自然顺序", () => {
  const segments = Array.from(
    { length: 1_000 },
    (_, index) => `${index % 2 === 0 ? "你" : "𠀀"}${String(index).padStart(4, "0")}`,
  );
  const viewer = new AgentActivityViewerModel(viewerAgent(), [textMessage(segments.join(" "))], {
    viewport_height: 3,
  });

  assert.deepEqual(viewer.render(12).slice(1, -1), segments.slice(-3));
  const state = viewer.getPublicState();
  assert.equal(state.max_scroll_offset, segments.length - 3);
});

test("长 Markdown 缩进代码与 Setext 标题仍走 Markdown 解析", () => {
  const source = `${"    const retained = true;\n".repeat(180)}Heading\n=======`;
  assert.ok(source.length > 4_096);
  const originalRender = Markdown.prototype.render;
  let markdownRenderCount = 0;
  Markdown.prototype.render = function renderWithCount(width: number): string[] {
    markdownRenderCount += 1;
    return originalRender.call(this, width);
  };

  try {
    const viewer = new AgentActivityViewerModel(viewerAgent(), [textMessage(source)], {
      viewport_height: 3,
    });
    viewer.render(80);
    assert.ok(markdownRenderCount > 0);
  } finally {
    Markdown.prototype.render = originalRender;
  }
});

test("thinking 默认以统一折叠标题显示，不包含行数或正文预览", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    messageEntry([
      { type: "thinking", thinking: "内部计划第一行\n内部计划第二行\n内部计划第三行" },
      { type: "text", text: "answer" },
    ]),
  ], { viewport_height: 20 });
  const lines = viewer.render(160);
  const body = lines.slice(1, -1);

  const thinkingLines = body.filter((line) => line.includes("Thinking"));
  assert.deepEqual(thinkingLines, ["▸ Thinking"], lines.join("\n"));
  assert.doesNotMatch(body.join("\n"), /内部计划/u);
  assert.doesNotMatch(thinkingLines[0] ?? "", /lines|行|…/u);
  assert.ok(body.some((line) => line.includes("answer")));
});

test("展开 thinking 后标题变为 ▾ 且粗体强调，正文每行带 │ 引导线", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    messageEntry([
      { type: "thinking", thinking: "计划 A\n计划 B" },
      { type: "text", text: "answer" },
    ]),
  ], { viewport_height: 20 });
  // Tab 选中第一个可展开项（thinking）并切换展开。
  assert.equal(viewer.handleInput("\t"), "changed");
  assert.equal(viewer.handleInput("\r"), "changed");

  const body = viewer.render(160).slice(1, -1);
  assert.ok(body.includes("▾ Thinking"), body.join("\n"));
  assert.ok(body.includes("│ 计划 A"), body.join("\n"));
  assert.ok(body.includes("│ 计划 B"), body.join("\n"));
  assert.ok(body.some((line) => line.includes("answer")));

  const theme = {
    fg: (color: string, text: string): string => `<fg:${color}>${text}</fg:${color}>`,
    bg: (color: string, text: string): string => `<bg:${color}>${text}</bg:${color}>`,
    bold: (text: string): string => `<bold>${text}</bold>`,
  };
  const surface = renderAgentActivityViewerSurface(viewer, 120, theme).join("\n");
  assert.match(
    surface,
    /<fg:dim>▾<\/fg:dim> <fg:accent><bold>Thinking<\/bold><\/fg:accent>/u,
  );
});

test("相邻 thinking 合并为同一折叠条目，被 text 隔开的 thinking 保持分离", () => {
  // 模拟产生端输出：相邻 thinking 已在规范化时合并。
  const normalized = normalizeRpcBridgeEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "第一段" },
        { type: "thinking", thinking: "第二段" },
        { type: "text", text: "中间" },
        { type: "thinking", thinking: "第三段" },
      ],
    },
  });
  assert.ok(normalized.kind === "event" && normalized.event.type === "message");
  const entry = Object.freeze({
    contract_version: CANONICAL_ACTIVITY_CONTRACT_VERSION,
    agent_id: AGENT_ID,
    incarnation_id: randomUUID(),
    entry_id: randomUUID(),
    body: normalized.event,
  });
  const viewer = new AgentActivityViewerModel(viewerAgent(), [entry], { viewport_height: 20 });

  const collapsed = viewer.render(160).slice(1, -1);
  assert.equal(collapsed.filter((line) => line.includes("Thinking")).length, 2, collapsed.join("\n"));

  // 展开第一组，确认两段合并在同一展开正文里；第三段仍折叠。
  assert.equal(viewer.handleInput("\t"), "changed");
  assert.equal(viewer.handleInput("\r"), "changed");
  const expandedBody = viewer.render(160).slice(1, -1).join("\n");
  assert.equal(expandedBody.split("Thinking").length - 1, 2, expandedBody);
  assert.ok(expandedBody.includes("第一段") && expandedBody.includes("第二段"), expandedBody);
  assert.doesNotMatch(expandedBody, /第三段/u);
});

test("查看器支持 Tab 与 Shift+Tab 在全部可展开条目间正反循环", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    messageEntry([{ type: "thinking", thinking: "思考一" }]),
    messageEntry([{ type: "thinking", thinking: "思考二" }]),
    messageEntry([{ type: "thinking", thinking: "思考三" }]),
  ], { viewport_height: 20 });

  // 打开时选择当前视口最新（最后）可展开项。
  assert.match(viewer.getSelectedKey() ?? "", /thinking:/u);
  const initial = viewer.getSelectedKey();
  assert.equal(viewer.handleInput("\t"), "changed");
  // Tab 从最新项向后循环回第一个。
  assert.notEqual(viewer.getSelectedKey(), initial);
  const afterTab = viewer.getSelectedKey();
  assert.equal(viewer.handleInput("\x1b[Z"), "changed");
  assert.equal(viewer.getSelectedKey(), initial);
  assert.equal(viewer.handleInput("\t"), "changed");
  assert.equal(viewer.getSelectedKey(), afterTab);
});

test("打开时默认选择当前视口最新可展开项，新活动不抢选择", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    messageEntry([{ type: "thinking", thinking: "早思考" }]),
    textMessage("正文\n正文\n正文\n正文"),
    messageEntry([{ type: "thinking", thinking: "晚思考" }]),
  ], { viewport_height: VIEWPORT });
  const initial = viewer.getSelectedKey();
  // 跟随底部时视口覆盖最后几行：选中项是视口内最新的可展开条目（晚思考）。
  assert.ok(initial !== undefined, "应建立初始选择");

  // 相同前缀同步与新事件追加都不改变选择。
  viewer.syncFrom([
    messageEntry([{ type: "thinking", thinking: "早思考" }]),
    textMessage("正文\n正文\n正文\n正文"),
    messageEntry([{ type: "thinking", thinking: "晚思考" }]),
    toolStart("new-1", "run_cmd"),
  ]);
  assert.equal(viewer.getSelectedKey(), initial);
});

test("Enter 与空格切换展开，右键展开、左键折叠", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    messageEntry([{ type: "thinking", thinking: "计划" }]),
  ], { viewport_height: 20 });

  assert.equal(viewer.handleInput("\t"), "changed");
  assert.equal(viewer.handleInput("\x1b[C"), "changed");
  assert.ok(viewer.getExpandedKeys().length === 1);
  assert.equal(viewer.handleInput("\x1b[C"), "ignored");
  assert.equal(viewer.handleInput("\x1b[D"), "changed");
  assert.equal(viewer.getExpandedKeys().length, 0);
  assert.equal(viewer.handleInput(" "), "changed");
  assert.equal(viewer.getExpandedKeys().length, 1);
  assert.equal(viewer.handleInput("\r"), "changed");
  assert.equal(viewer.getExpandedKeys().length, 0);
});

test("视口外 Tab 目标只触发使其可见的最小滚动", () => {
  const entries: CanonicalAgentActivityEntry[] = [
    messageEntry([{ type: "thinking", thinking: "第一条" }]),
  ];
  for (let index = 0; index < 30; index += 1) entries.push(textMessage(`填充行 ${index}`));
  entries.push(messageEntry([{ type: "thinking", thinking: "最后一条" }]));
  const viewer = new AgentActivityViewerModel(viewerAgent(), entries, {
    viewport_height: VIEWPORT,
  });
  // 初始选择：视口（底部 3 行）内的最新可展开项。
  const initialKey = viewer.getSelectedKey();
  assert.ok(initialKey !== undefined);
  const initialOffset = viewer.getPublicState().scroll_offset;

  // Tab 回到第一条（在视口上方远处）：只滚动到刚好可见（首行）。
  assert.equal(viewer.handleInput("\t"), "changed");
  const afterOffset = viewer.getPublicState().scroll_offset;
  assert.ok(afterOffset < initialOffset, `${afterOffset} !< ${initialOffset}`);
  const lines = viewer.render(160).slice(1, -1);
  assert.equal(lines[0], "▸ Thinking", lines.join("\n"));
});

test("展开保持屏幕位置并暂停 follow；折叠不自动恢复；滚到底部或 Tab 回最新项恢复", () => {
  const entries: CanonicalAgentActivityEntry[] = [];
  for (let index = 0; index < 6; index += 1) entries.push(textMessage(`正文块 ${index}`));
  entries.push(messageEntry([{ type: "thinking", thinking: "思考" }]));
  const viewer = new AgentActivityViewerModel(viewerAgent(), entries, {
    viewport_height: VIEWPORT,
  });
  assert.equal(viewer.getPublicState().follow_enabled, true);

  // 选择最新 thinking（视口内）并展开：暂停 follow。
  assert.equal(viewer.handleInput("\t"), "changed");
  const selectedBefore = viewer.getSelectedKey();
  assert.equal(viewer.handleInput("\x1b[C"), "changed");
  assert.equal(viewer.getPublicState().follow_enabled, false);

  // 展开动作后追加新条目不拉到底部；屏幕位置保持。
  const offsetAfterExpand = viewer.getPublicState().scroll_offset;
  viewer.syncFrom(entries.concat([
    toolStart("late-1", "run_cmd"),
  ]));
  assert.equal(viewer.getPublicState().scroll_offset, offsetAfterExpand);
  assert.equal(viewer.getSelectedKey(), selectedBefore);

  // 折叠不自动恢复 follow。
  assert.equal(viewer.handleInput("\x1b[D"), "changed");
  assert.equal(viewer.getPublicState().follow_enabled, false);

  // Tab 回到底部最新项后恢复 follow。
  assert.equal(viewer.handleInput("\t"), "changed");
  assert.equal(viewer.getPublicState().follow_enabled, true);
  assert.equal(viewer.getPublicState().scroll_offset, viewer.getPublicState().max_scroll_offset);
});

test("向上滚动暂停 follow，向下滚到底恢复，footer 始终固定且不显示 paused", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), replayFixture(), {
    viewport_height: VIEWPORT,
  });
  assert.equal(viewer.getPublicState().follow_enabled, true);
  assert.equal(
    viewer.render(160).at(-1),
    "↑↓ scroll · Tab/Shift+Tab select · Enter expand · Home/End jump · Esc back",
  );

  assert.equal(viewer.handleInput("\x1b[A"), "changed");
  assert.equal(viewer.getPublicState().follow_enabled, false);
  assert.equal(
    viewer.render(160).at(-1),
    "↑↓ scroll · Tab/Shift+Tab select · Enter expand · Home/End jump · Esc back",
  );
  assert.doesNotMatch(viewer.render(160).at(-1) ?? "", /paused/u);

  viewer.syncFrom([...replayFixture(), toolStart("t2", "run_cmd")]);
  // 暂停后追加新条目保持用户回看位置。
  assert.equal(viewer.getPublicState().follow_enabled, false);
  const pausedOffset = viewer.getPublicState().scroll_offset;

  // 向下滚动到底部恢复跟随。
  assert.equal(viewer.handleInput("\x1b[B"), "changed");
  assert.equal(viewer.getPublicState().follow_enabled, false);
  assert.equal(viewer.handleInput("\x1b[B"), "changed");
  assert.equal(viewer.getPublicState().follow_enabled, true);
  assert.equal(
    viewer.getPublicState().scroll_offset,
    viewer.getPublicState().max_scroll_offset,
  );
  void pausedOffset;
});

test("选中条目使用整行选中背景渲染", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    messageEntry([{ type: "thinking", thinking: "思考" }]),
  ], { viewport_height: 20 });
  assert.equal(viewer.handleInput("\t"), "changed");

  const surface = renderAgentActivityViewerSurface(viewer, 120, Object.freeze({
    fg: (color: string, text: string): string => `<fg:${color}>${text}</fg:${color}>`,
    bg: (color: string, text: string): string => `<bg:${color}>${text}</bg:${color}>`,
    bold: (text: string): string => `<bold>${text}</bold>`,
  }));
  const selectedLines = surface.filter((line) => line.includes("<bg:selectedBg>"));
  assert.equal(selectedLines.length, 1, surface.join("\n"));
  assert.match(selectedLines[0] ?? "", /Thinking/u);
});

test("构造时只布局尾部，公开状态收敛后复用默认宽度 Markdown 布局", () => {
  const originalRender = Markdown.prototype.render;
  let markdownRenderCount = 0;
  Markdown.prototype.render = function renderWithCount(width: number): string[] {
    markdownRenderCount += 1;
    return originalRender.call(this, width);
  };

  try {
    const viewer = new AgentActivityViewerModel(viewerAgent("idle"), [
      textMessage("历史正文"),
      toolStart("settled-tool", "read_file"),
      messageEntry([{ type: "thinking", thinking: "最近思考" }]),
    ], { drafts: Object.freeze([]), viewport_height: 2 });

    assert.equal(markdownRenderCount, 0);
    const state = viewer.getPublicState();
    assert.equal(state.follow_enabled, true);
    assert.equal(state.scroll_offset, state.max_scroll_offset);
    assert.match(state.selected_key ?? "", /^thinking:/u);
    assert.equal(markdownRenderCount, 1);
    assert.match(viewer.render(80).join("\n"), /read_file · result unavailable/u);
    assert.equal(markdownRenderCount, 1);
  } finally {
    Markdown.prototype.render = originalRender;
  }
});

test("等价实时草稿快照返回 ignored 且复用现有 Markdown 投影", () => {
  const key = `${INCARNATION_ID}|message-1`;
  const viewer = new AgentActivityViewerModel(viewerAgent(), [textMessage("历史正文")], {
    drafts: thinkingDraftSnapshot("streaming", key),
    viewport_height: 20,
  });
  assert.match(viewer.render(80).join("\n"), /Thinking · streaming/u);
  const stateBefore = viewer.getPublicState();
  const originalRender = Markdown.prototype.render;
  let markdownRenderCount = 0;
  Markdown.prototype.render = function renderWithCount(width: number): string[] {
    markdownRenderCount += 1;
    return originalRender.call(this, width);
  };

  try {
    assert.equal(viewer.setLiveDrafts(thinkingDraftSnapshot("streaming", key)), "ignored");
    assert.deepEqual(viewer.getPublicState(), stateBefore);
    assert.match(viewer.render(80).join("\n"), /Thinking · streaming/u);
    assert.equal(markdownRenderCount, 0);
  } finally {
    Markdown.prototype.render = originalRender;
  }

  assert.equal(
    viewer.setLiveDrafts(thinkingDraftSnapshot("streaming", `${INCARNATION_ID}|message-2`)),
    "changed",
  );
});

test("实时草稿增长只重渲染变化草稿块，不重解析大历史", () => {
  const history = Array.from({ length: 40 }, (_, index) => textMessage(
    `## 历史 ${index}\n\n${"不变 Markdown 正文 ".repeat(30)}`,
  ));
  const draft = (value: string): readonly AgentDisplayDraftView[] => Object.freeze([
    Object.freeze({
      key: `${INCARNATION_ID}|streaming-text`,
      state: "streaming" as const,
      blocks: Object.freeze([
        Object.freeze({ contentIndex: 0, contentType: "text" as const, value }),
      ]),
    }),
  ]);
  const viewer = new AgentActivityViewerModel(viewerAgent(), history, {
    drafts: draft("draft one"),
    viewport_height: 4,
  });
  viewer.render(120);

  const originalRender = Markdown.prototype.render;
  let markdownRenderCount = 0;
  Markdown.prototype.render = function renderWithCount(width: number): string[] {
    markdownRenderCount += 1;
    return originalRender.call(this, width);
  };

  try {
    assert.equal(viewer.setLiveDrafts(draft("draft one grows")), "changed");
    const body = viewer.render(120).slice(1, -1).join("\n");
    assert.match(body, /draft one grows/u);
    assert.equal(markdownRenderCount, 1);
  } finally {
    Markdown.prototype.render = originalRender;
  }
});

test("snapshot 原地替换不重解析未变化的 Markdown 历史", () => {
  const history = Array.from({ length: 40 }, (_, index) => textMessage(
    `## 历史 ${index}\n\n${"不变 Markdown 正文 ".repeat(30)}`,
  ));
  const entryId = randomUUID();
  const summary = { tool: "bash", command: "echo snapshot" } as const;
  const start = toolStart("snapshot-cache", "bash", "pi_native", INCARNATION_ID, summary, entryId);
  const end = toolEnd(
    "snapshot-cache",
    "bash",
    false,
    "pi_native",
    INCARNATION_ID,
    summary,
    undefined,
    undefined,
    entryId,
  );
  const viewer = new AgentActivityViewerModel(
    viewerAgent(),
    activitySnapshot([...history, start], 1),
    { viewport_height: 4 },
  );
  viewer.render(120);

  const originalRender = Markdown.prototype.render;
  let markdownRenderCount = 0;
  Markdown.prototype.render = function renderWithCount(width: number): string[] {
    markdownRenderCount += 1;
    return originalRender.call(this, width);
  };

  try {
    assert.equal(viewer.syncSnapshot(activitySnapshot([...history, end], 2)), "changed");
    assert.match(viewer.render(120).join("\n"), /✓ bash/u);
    assert.equal(markdownRenderCount, 0);
  } finally {
    Markdown.prototype.render = originalRender;
  }
});

test("首次打开只布局尾部视口，公开滚动范围按需精确收敛", () => {
  const history = Array.from({ length: 60 }, (_, index) => textMessage(`History ${index}`));
  const originalRender = Markdown.prototype.render;
  let markdownRenderCount = 0;
  Markdown.prototype.render = function renderWithCount(width: number): string[] {
    markdownRenderCount += 1;
    return originalRender.call(this, width);
  };

  try {
    const viewer = new AgentActivityViewerModel(viewerAgent(), history, { viewport_height: 3 });
    const body = viewer.render(120).slice(1, -1).join("\n");
    assert.match(body, /History 59/u);
    assert.ok(markdownRenderCount <= 6, `expected tail-only layout, got ${markdownRenderCount}`);

    const beforeExactState = markdownRenderCount;
    const state = viewer.getPublicState();
    assert.equal(state.max_scroll_offset, 57);
    assert.ok(markdownRenderCount > beforeExactState);
  } finally {
    Markdown.prototype.render = originalRender;
  }
});

test("草稿内容不变时 streaming、complete 与 frozen 状态仍更新标题", () => {
  const key = `${INCARNATION_ID}|message-1`;
  const viewer = new AgentActivityViewerModel(viewerAgent(), [], {
    drafts: thinkingDraftSnapshot("streaming", key),
    viewport_height: 20,
  });
  assert.ok(viewer.render(80).slice(1, -1).includes("▸ Thinking · streaming"));

  assert.equal(viewer.setLiveDrafts(thinkingDraftSnapshot("complete", key)), "changed");
  let body = viewer.render(80).slice(1, -1);
  assert.ok(body.includes("▸ Thinking"), body.join("\n"));
  assert.doesNotMatch(body.join("\n"), /streaming/u);

  assert.equal(viewer.setLiveDrafts(thinkingDraftSnapshot("frozen", key)), "changed");
  body = viewer.render(80).slice(1, -1);
  assert.ok(body.includes("▸ Thinking · streaming incomplete"), body.join("\n"));
  assert.equal(viewer.setLiveDrafts(thinkingDraftSnapshot("frozen", key)), "ignored");
});

test("实时草稿驻留查看器投影，complete 后保持显示并被权威条目原地替换", () => {
  const registry = new AgentDisplayDraftRegistry();
  assert.equal(registry.applyEvent(AGENT_ID, displayDelta("message-1", 1, 0, "text", "Hel")), true);
  assert.equal(registry.applyEvent(AGENT_ID, displayDelta("message-1", 2, 0, "text", "lo")), true);
  const viewer = new AgentActivityViewerModel(viewerAgent(), [], {
    drafts: registry.drafts(AGENT_ID),
  });
  assert.equal(viewer.getPublicState().event_count, 0);
  assert.match(viewer.render(120).join("\n"), /Hello/u);

  // message_complete 只收束显示流：连续草稿继续显示，等待权威消息不闪空。
  assert.equal(registry.applyEvent(AGENT_ID, displayComplete("message-1", 3)), true);
  viewer.setLiveDrafts(registry.drafts(AGENT_ID));
  assert.match(viewer.render(120).join("\n"), /Hello/u);

  // 权威完整消息携带可精确关联的身份：原地替换并清除对应草稿。
  assert.equal(registry.replaceDraft(AGENT_ID, INCARNATION_ID, "message-1"), true);
  viewer.setLiveDrafts(registry.drafts(AGENT_ID));
  assert.doesNotMatch(viewer.render(120).join("\n"), /Hello/u);
  viewer.syncFrom([messageEntry([{ type: "text", text: "Hello" }], "message-1")]);
  assert.equal(viewer.getPublicState().event_count, 1);
  assert.match(viewer.render(120).join("\n"), /Hello/u);
});

test("权威消息先到时迟到 delta 与 complete 被忽略，旧流不复活", () => {
  const registry = new AgentDisplayDraftRegistry();
  // 权威消息先落账：草稿登记表登记该流墓碑。
  assert.equal(registry.replaceDraft(AGENT_ID, INCARNATION_ID, "message-1"), false);
  assert.equal(registry.applyEvent(AGENT_ID, displayDelta("message-1", 1, 0, "text", "迟到")), false);
  assert.equal(registry.applyEvent(AGENT_ID, displayComplete("message-1", 2)), false);
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    messageEntry([{ type: "text", text: "完整正文" }], "message-1"),
  ], { drafts: registry.drafts(AGENT_ID) });
  const lines = viewer.render(120).join("\n");
  assert.doesNotMatch(lines, /迟到/u);
  assert.match(lines, /完整正文/u);
});

test("实时 thinking 草稿默认折叠为 Thinking · streaming 并可展开观察流式内容", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [], {
    drafts: assembledDrafts([displayDelta("message-1", 1, 0, "thinking", "流式思考")]),
  });
  const collapsed = viewer.render(120).join("\n");
  assert.match(collapsed, /Thinking · streaming/u);
  assert.doesNotMatch(collapsed, /流式思考/u);

  // 选择实时 thinking 折叠条目并展开。
  assert.equal(viewer.handleInput("\t"), "changed");
  assert.equal(viewer.handleInput("\r"), "changed");
  assert.match(viewer.render(120).join("\n"), /流式思考/u);
});

test("权威消息落地替换草稿后，已展开的 streaming thinking 保持展开", () => {
  const registry = new AgentDisplayDraftRegistry();
  registry.applyEvent(AGENT_ID, displayDelta("message-1", 1, 0, "thinking", "流式思考"));
  registry.applyEvent(AGENT_ID, displayComplete("message-1", 2));
  const viewer = new AgentActivityViewerModel(viewerAgent(), [], {
    drafts: registry.drafts(AGENT_ID),
    viewport_height: 20,
  });

  // streaming 期间用户展开 thinking 草稿。
  assert.equal(viewer.handleInput("\t"), "changed");
  assert.equal(viewer.handleInput("\r"), "changed");
  assert.match(viewer.render(120).join("\n"), /流式思考/u);

  // 权威完整消息落地：控制器登记条目并原地替换对应实时草稿。
  assert.equal(
    viewer.appendEntry(messageEntry([{ type: "thinking", thinking: "完整思考" }], "message-1")),
    "changed",
  );
  assert.equal(registry.replaceDraft(AGENT_ID, INCARNATION_ID, "message-1"), true);
  viewer.setLiveDrafts(registry.drafts(AGENT_ID));

  // 展开状态跨草稿→权威替换保持：正文可见且标题不再标记 streaming。
  const body = viewer.render(120).join("\n");
  assert.match(body, /完整思考/u);
  assert.doesNotMatch(body, /streaming/u);
});

test("完整有序 displayStream 在草稿替换后保持 thinking 展开状态", () => {
  const displayStream = Object.freeze({
    streamId: "message-1",
    displayEpoch: randomUUID(),
    displaySourceGeneration: 1,
    streamOrdinal: 1,
  });
  const registry = new AgentDisplayDraftRegistry();
  assert.equal(registry.applyEvent(AGENT_ID, Object.freeze({
    type: "message_delta" as const,
    ...displayStream,
    sequence: 1,
    contentIndex: 0,
    contentType: "thinking" as const,
    delta: "流式思考",
    agentId: AGENT_ID,
    incarnationId: INCARNATION_ID,
  })), true);
  const viewer = new AgentActivityViewerModel(
    viewerAgent(),
    activitySnapshot([], 0),
    { drafts: registry.drafts(AGENT_ID), viewport_height: 20 },
  );
  assert.equal(viewer.handleInput("\t"), "changed");
  assert.equal(viewer.handleInput("\r"), "changed");

  const authority: CanonicalAgentActivityEntry = Object.freeze({
    contract_version: CANONICAL_ACTIVITY_CONTRACT_VERSION,
    agent_id: AGENT_ID,
    incarnation_id: INCARNATION_ID,
    entry_id: randomUUID(),
    body: Object.freeze({
      type: "message" as const,
      content: Object.freeze([Object.freeze({ type: "thinking" as const, thinking: "完整思考" })]),
      displayStream,
    }),
  });
  assert.equal(viewer.syncSnapshot(activitySnapshot([authority], 1)), "changed");
  assert.equal(registry.replaceDraft(AGENT_ID, INCARNATION_ID, displayStream), true);
  viewer.setLiveDrafts(registry.drafts(AGENT_ID));

  const body = viewer.render(120).join("\n");
  assert.match(body, /完整思考/u);
  assert.doesNotMatch(body, /streaming/u);
});

test("冻结 text 草稿末尾显示弱化省略号，冻结 thinking 标题显示 streaming incomplete", () => {
  const registry = new AgentDisplayDraftRegistry();
  // 256 个未来帧恰好到达边界（帧 3..258），第 257 个未来帧（帧 259）触发冻结：
  // 保留已验证前缀，丢弃 future buffer。
  const events = [displayDelta("message-1", 1, 0, "text", "前缀")];
  for (let sequence = 3; sequence <= 258; sequence += 1) {
    events.push(displayDelta("message-1", sequence, 0, "text", "x"));
  }
  for (const event of events) registry.applyEvent(AGENT_ID, event);
  assert.equal(registry.applyEvent(AGENT_ID, displayDelta("message-1", 259, 0, "text", "x")), true);
  const viewer = new AgentActivityViewerModel(viewerAgent(), [], {
    drafts: registry.drafts(AGENT_ID),
  });
  const lines = viewer.render(120);
  assert.match(lines.join("\n"), /前缀/u);
  assert.ok(lines.some((line) => line === "…"), lines.join("\n"));
  // 冻结后不再应用任何 token，等待权威完整消息。
  assert.equal(registry.applyEvent(AGENT_ID, displayDelta("message-1", 2, 0, "text", "y")), false);
  assert.equal(registry.applyEvent(AGENT_ID, displayComplete("message-1", 260)), false);
  viewer.setLiveDrafts(registry.drafts(AGENT_ID));
  assert.doesNotMatch(viewer.render(120).join("\n"), /前缀y/u);

  const thinkingRegistry = new AgentDisplayDraftRegistry();
  const thinkingEvents = [
    displayDelta("message-2", 1, 0, "thinking", "冻结的思考"),
    ...Array.from({ length: 300 }, (_, index) =>
      displayDelta("message-2", index + 3, 0, "thinking", "x")),
  ];
  for (const event of thinkingEvents) thinkingRegistry.applyEvent(AGENT_ID, event);
  const thinkingViewer = new AgentActivityViewerModel(viewerAgent(), [], {
    drafts: thinkingRegistry.drafts(AGENT_ID),
    viewport_height: 20,
  });
  // 折叠状态只由标题表达 streaming incomplete，不显示省略号。
  const collapsedThinking = thinkingViewer.render(120);
  assert.match(collapsedThinking.join("\n"), /Thinking · streaming incomplete/u);
  assert.ok(!collapsedThinking.some((line) => line === "…"), collapsedThinking.join("\n"));
  // 展开后正文末尾同时显示弱化省略号。
  assert.equal(thinkingViewer.handleInput("\t"), "changed");
  assert.equal(thinkingViewer.handleInput("\r"), "changed");
  const expandedThinking = thinkingViewer.render(120);
  assert.match(expandedThinking.join("\n"), /冻结的思考/u);
  assert.ok(expandedThinking.some((line) => line === "│ …"), expandedThinking.join("\n"));
});

test("Esc 关闭查看器，其余未知输入被忽略", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), replayFixture());
  assert.equal(viewer.handleInput("\x1b"), "close");
  assert.equal(viewer.handleInput("x"), "ignored");
});

test("标题展示模板、名称与生命周期状态并净化控制字符", () => {
  const viewer = new AgentActivityViewerModel({
    agent_id: AGENT_ID,
    template_id: "worker",
    name: "bad\tname",
    state: "working",
  }, replayFixture());
  assert.match(viewer.render(160)[0] ?? "", /worker · bad name · working/);

  assert.equal(viewer.updateLifecycle("terminated"), "changed");
  assert.match(viewer.render(160)[0] ?? "", /terminated/);
  assert.equal(viewer.updateLifecycle("terminated"), "ignored");
});

test("违约条目被静默忽略", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), replayFixture());
  const stale = Object.freeze({
    contract_version: "wj-pi-subagents.activity/1",
    agent_id: AGENT_ID,
    incarnation_id: randomUUID(),
    entry_id: randomUUID(),
    body: Object.freeze({ type: "message", content: [] }),
  }) as unknown as CanonicalAgentActivityEntry;
  assert.equal(viewer.syncFrom([stale]), "ignored");
  assert.equal(viewer.getPublicState().event_count, 3);
});

test("查看器表面使用既定框线布局并应用主题", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), replayFixture());
  const surface = renderAgentActivityViewerSurface(viewer, 160, undefined);
  assert.ok(surface.length > 0);
  assert.ok(surface.every((line) => displayWidth(line) === 160), surface.join("\n"));
  assert.ok(surface.some((line) => line.includes("AGENT ACTIVITY")), surface.join("\n"));
});

test("正文净化 ANSI 与方向控制序列并保持宽字符显示宽度", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    textMessage("safe\x1b[31m red\x1b[0m\u202e hidden\u0007 text"),
    textMessage("宽度🌍字符"),
  ]);
  const body = viewer.render(120).slice(1, -1).join("\n");

  assert.doesNotMatch(body, /\x1b|\\u202e|\\u0007/u);
  assert.match(body, /safe red\s+hidden\s+text/u);
  assert.match(body, /宽度🌍字符/u);

  const surface = renderAgentActivityViewerSurface(viewer, 40, undefined);
  assert.ok(surface.every((line) => displayWidth(line) === 40), surface.join("\n"));
});

test("关闭重开后展开、选择、滚动与 follow 状态重置", () => {
  const replay = [
    messageEntry([{ type: "thinking", thinking: "第一条思考" }]),
    messageEntry([{ type: "thinking", thinking: "第二条思考" }]),
    messageEntry([{ type: "thinking", thinking: "第三条思考" }]),
    messageEntry([{ type: "thinking", thinking: "第四条思考" }]),
  ];
  // 第一次会话：展开并向上滚动。
  const first = new AgentActivityViewerModel(viewerAgent(), replay, {
    viewport_height: VIEWPORT,
  });
  first.handleInput("\t");
  first.handleInput("\x1b[C");
  first.handleInput("\x1b[A");
  assert.equal(first.getPublicState().follow_enabled, false);
  assert.equal(first.getExpandedKeys().length, 1);

  // 关闭后重新打开：全新实例。
  const second = new AgentActivityViewerModel(viewerAgent(), replay, {
    viewport_height: VIEWPORT,
  });
  assert.equal(second.getExpandedKeys().length, 0);
  assert.equal(second.getPublicState().follow_enabled, true);
  assert.equal(second.getPublicState().scroll_offset, second.getPublicState().max_scroll_offset);
  assert.notEqual(second.getSelectedKey(), first.getSelectedKey());
});

test("多个条目可同时保持展开", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    messageEntry([{ type: "thinking", thinking: "思考一" }]),
    messageEntry([{ type: "thinking", thinking: "思考二" }]),
    messageEntry([{ type: "thinking", thinking: "思考三" }]),
  ], { viewport_height: 20 });
  viewer.handleInput("\t");
  viewer.handleInput("\r");
  viewer.handleInput("\t");
  viewer.handleInput("\r");
  assert.equal(viewer.getExpandedKeys().length, 2);

  const body = viewer.render(160).slice(1, -1).join("\n");
  assert.ok(body.includes("思考一"), body);
  assert.ok(body.includes("思考二"));
  assert.doesNotMatch(body, /思考三/u);
});

test("无缓存活动时显示明确空态", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), []);
  const lines = viewer.render(160);

  assert.ok(lines.some((line) => line.includes("No cached activity yet")), lines.join("\n"));
  assert.equal(viewer.getPublicState().event_count, 0);
  assert.equal(viewer.getSelectedKey(), undefined);
});

function dedicatedToolLine(viewer: AgentActivityViewerModel, toolName: string): string | undefined {
  return viewer.render(160).slice(1, -1).find((line) => line.includes(toolName));
}

test("read 运行中显示 path/offset/limit，结束原地补充截断事实且保持单行", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolStart("t1", "read", "pi_native", INCARNATION_ID, {
      tool: "read", path: "src/index.ts", offset: 5, limit: 20,
    }),
  ], { viewport_height: 20 });
  const running = dedicatedToolLine(viewer, "read");
  assert.match(running ?? "", /^↻ read · src\/index\.ts · offset 5 · limit 20$/u);
  assert.doesNotMatch(running ?? "", /truncated/u);

  viewer.syncFrom([
    toolStart("t1", "read", "pi_native", INCARNATION_ID, {
      tool: "read", path: "src/index.ts", offset: 5, limit: 20,
    }),
    toolEnd("t1", "read", false, "pi_native", INCARNATION_ID, {
      tool: "read", path: "src/index.ts", offset: 5, limit: 20, truncated: true, truncatedBy: "lines",
    }),
  ]);
  const done = dedicatedToolLine(viewer, "read");
  assert.match(done ?? "", /^✓ read · src\/index\.ts · offset 5 · limit 20 · truncated \(lines\)$/u);
  assert.equal(done, done?.trimEnd());
  // 专用摘要仍是一个条目一行。
  assert.equal(viewer.render(160).slice(1, -1).filter((line) => line.includes("src/index.ts")).length, 1);
});

test("read 首行超限与字节截断使用对应事实文本，图片结果不产生成功侧事实", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t1", "read", false, "pi_native", INCARNATION_ID, {
      tool: "read", path: "big.log", truncated: true, truncatedBy: "bytes", firstLineExceedsLimit: true,
    }),
    toolEnd("t2", "read", false, "pi_native", INCARNATION_ID, {
      tool: "read", path: "img.png",
    }),
    toolEnd("t3", "read", false, "pi_native", INCARNATION_ID, {
      tool: "read", path: "limited.txt", limit: 100, hasMoreLines: true,
    }),
  ], { viewport_height: 20 });
  const body = viewer.render(160).slice(1, -1).join("\n");
  assert.match(body, /read · big\.log · truncated \(first line\)/u);
  assert.match(body, /read · img\.png/u);
  assert.match(body, /read · limited\.txt · limit 100 · more lines/u);
  assert.doesNotMatch(body, /Read image file/u);
});

test("grep 摘要显示 pattern、path 与全部非默认条件，未提供 path 显示 .", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t1", "grep", false, "pi_native", INCARNATION_ID, {
      tool: "grep", pattern: "TODO", path: "src", glob: "*.ts", ignoreCase: true, literal: true,
      context: 2, limit: 50,
    }),
    toolEnd("t2", "grep", false, "pi_native", INCARNATION_ID, {
      tool: "grep", pattern: "x", path: ".",
    }),
  ], { viewport_height: 20 });
  const lines = viewer.render(160).slice(1, -1);
  assert.ok(lines.some((line) => line.includes(
    "grep · /TODO/ · src · glob *.ts · ignoreCase · literal · context 2 · limit 50",
  )), lines.join("\n"));
  // 未提供 path 时明确显示 .
  assert.ok(lines.some((line) => line.includes("grep · /x/ · .")), lines.join("\n"));
});

test("grep 结果事实：无匹配、达到限制、截断与长行截断，不显示匹配正文", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t1", "grep", false, "pi_native", INCARNATION_ID, {
      tool: "grep", pattern: "secret", path: "src", noMatches: true,
    }),
    toolEnd("t2", "grep", false, "pi_native", INCARNATION_ID, {
      tool: "grep", pattern: "secret", path: "src",
      matchLimitReached: 100, truncated: true, truncatedBy: "bytes", linesTruncated: true,
    }),
  ], { viewport_height: 20 });
  const body = viewer.render(160).slice(1, -1).join("\n");
  assert.match(body, /grep · \/secret\/ · src · no matches/u);
  assert.match(body, /100 matches limit · truncated \(bytes\) · lines truncated/u);
  assert.doesNotMatch(body, /src\/a\.ts:1/u);
});

test("find 与 ls 摘要显示输入参数并保留各自空结果与限制事实", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t1", "find", false, "pi_native", INCARNATION_ID, {
      tool: "find", pattern: "*.ts", path: "src", noFiles: true,
    }),
    toolEnd("t2", "find", false, "pi_native", INCARNATION_ID, {
      tool: "find", pattern: "*.ts", path: ".", limit: 500, resultLimitReached: 1000, truncated: true, truncatedBy: "bytes",
    }),
    toolEnd("t3", "ls", false, "pi_native", INCARNATION_ID, {
      tool: "ls", path: "empty-dir", emptyDirectory: true,
    }),
    toolEnd("t4", "ls", false, "pi_native", INCARNATION_ID, {
      tool: "ls", path: ".", entryLimitReached: 500, truncated: true, truncatedBy: "lines",
    }),
  ], { viewport_height: 20 });
  const body = viewer.render(160).slice(1, -1).join("\n");
  assert.match(body, /find · \*\.ts · src · no files/u);
  assert.match(body, /find · \*\.ts · \. · limit 500 · 1000 results limit · truncated \(bytes\)/u);
  assert.match(body, /ls · empty-dir · empty directory/u);
  assert.match(body, /ls · \. · 500 entries limit · truncated \(lines\)/u);
  // 不显示命中路径列表或目录条目。
  assert.doesNotMatch(body, /a\.ts\nb\.ts|entry one/u);
});

test("专用工具失败保留统一标题，展开错误为带引导线的红色纯文本", () => {
  const theme = {
    fg: (color: string, text: string): string => `<fg:${color}>${text}</fg:${color}>`,
    bg: (color: string, text: string): string => `<bg:${color}>${text}</bg:${color}>`,
    bold: (text: string): string => `<bold>${text}</bold>`,
  };
  const errorText = "Offset 9000 is beyond end of file (12 lines total)\nsecond *line* stays literal";
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolStart("t1", "read", "pi_native", INCARNATION_ID, { tool: "read", path: "src/index.ts", offset: 9000 }),
    toolEnd("t1", "read", true, "pi_native", INCARNATION_ID, { tool: "read", path: "src/index.ts", offset: 9000 }, errorText),
  ], { viewport_height: 20 });
  const collapsed = viewer.render(160).slice(1, -1);
  const summaryLine = collapsed.find((line) => line.includes("read"));
  // 失败摘要仍是输入参数，不附带成功侧统计，并有折叠标记。
  assert.match(summaryLine ?? "", /^▸ × read · src\/index\.ts · offset 9000$/u);
  assert.doesNotMatch(summaryLine ?? "", /truncated/u);
  assert.match(summaryLine ?? "", /▸/u);
  // 错误正文默认不展开。
  assert.doesNotMatch(collapsed.join("\n"), /beyond end of file/u);

  // 选中并展开：错误以红色预格式化纯文本显示，保留换行与逐行引导线。
  assert.equal(viewer.handleInput("\t"), "changed");
  assert.match(viewer.getSelectedKey() ?? "", /tool-error:/u);
  assert.equal(viewer.handleInput("\r"), "changed");
  const expanded = viewer.render(160).slice(1, -1);
  assert.match(viewer.render(160).slice(1, -1).join("\n"), /▾/u);
  const errorLines = expanded.filter((line) => line.includes("beyond end of file") || line.includes("second"));
  assert.equal(errorLines.length, 2, expanded.join("\n"));
  // 保留换行：两行各自存在；不解析 Markdown：星号保持字面。
  assert.ok(expanded.some((line) => line.startsWith("│ Offset 9000")), expanded.join("\n"));
  assert.ok(expanded.some((line) => line.startsWith("│ second *line*")), expanded.join("\n"));
  // 红色错误样式。
  const surface = renderAgentActivityViewerSurface(viewer, 160, theme).join("\n");
  assert.match(surface, /<fg:error>[^]*beyond end of file/u);
});

test("长错误正文按面板宽度软换行且不截断字符，ANSI 与控制字符已过滤", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t1", "grep", true, "pi_native", INCARNATION_ID, { tool: "grep", pattern: "x", path: "." },
      "E".repeat(200) + "\x1b[31m-red\x1b[0m\n\u202etail"),
  ], { viewport_height: 20 });
  viewer.handleInput("\t");
  viewer.handleInput("\r");
  const width = 60;
  const expanded = viewer.render(width).slice(1, -1);
  const errorLines = expanded.filter((line) => line.includes("E") || line.includes("tail"));
  assert.ok(errorLines.length > 2, expanded.join("\n"));
  assert.ok(errorLines.every((line) => displayWidth(line) <= width), expanded.join("\n"));
  // 字符不丢失：全部 E 都在（软换行不截断）。
  const totalE = errorLines.join("").split("E").length - 1;
  assert.equal(totalE, 200);
  assert.doesNotMatch(expanded.join("\n"), /\x1b|\u202e/u);
});

test("结束先到的专用工具仍自包含摘要；运行中收束后不可展开错误", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent("idle"), [
    toolEnd("t1", "ls", false, "pi_native", INCARNATION_ID, { tool: "ls", path: "src" }),
    toolStart("t2", "read", "pi_native", INCARNATION_ID, { tool: "read", path: "pending.txt" }),
  ], { viewport_height: 20 });
  const body = viewer.render(160).slice(1, -1).join("\n");
  assert.match(body, /✓ ls · src/u);
  // 收束后的运行中工具保留输入参数摘要但无错误可展开。
  assert.match(body, /read · pending\.txt · result unavailable/u);
  for (const key of viewer.getExpandedKeys()) {
    assert.doesNotMatch(key, /tool-error:/u);
  }
});

test("长路径中间省略保留两端，其余超宽字段从右侧省略且不溢出", () => {
  const deepPath = `${"very-long-directory-name/".repeat(8)}file-with-long-name.txt`;
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t1", "read", false, "pi_native", INCARNATION_ID, { tool: "read", path: deepPath }),
  ], { viewport_height: 20 });
  // 足够宽时两端完整保留且只有一个省略号。
  const wide = viewer.render(140).slice(1, -1).find((item) => item.includes("read")) ?? "";
  assert.ok(wide.includes("very-long-directory-name/"), wide);
  assert.ok(wide.includes("file-with-long-name.txt"), wide);
  assert.equal(wide.split("…").length - 1, 1, wide);

  // 窄宽度：行不溢出，中间省略生效，两端前缀仍可识别。
  const width = 50;
  const line = viewer.render(width).slice(1, -1).find((item) => item.includes("read")) ?? "";
  assert.ok(displayWidth(line) <= width, line);
  assert.ok(line.includes("very-long-directory…"), line);
  assert.ok(line.includes("long-name.txt"), line);
  assert.equal(line.split("…").length - 1, 1, line);

  // 非 path 字段（超长 pattern）从右侧省略：行不溢出但头部保留。
  const grepViewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t2", "grep", false, "pi_native", INCARNATION_ID, {
      tool: "grep", pattern: "P".repeat(200), path: "src",
    }),
  ], { viewport_height: 20 });
  const grepLine = grepViewer.render(width).slice(1, -1).find((item) => item.includes("grep")) ?? "";
  assert.ok(displayWidth(grepLine) <= width, grepLine);
  assert.ok(grepLine.includes("grep · /PPPP"), grepLine);
  assert.ok(grepLine.includes("…"), grepLine);
});

test("未知来源与同名覆盖工具仍走安全兜底，不显示专用摘要", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t1", "read", false, "unknown"),
    toolEnd("t2", "grep", true, "plugin"),
  ], { viewport_height: 20 });
  const lines = viewer.render(160).slice(1, -1);
  // 兜底条目只显示工具名与状态，无分隔符或摘要字段。
  assert.ok(lines.some((line) => line === "✓ read"), lines.join("\n"));
  assert.ok(lines.some((line) => line === "× grep"), lines.join("\n"));
  assert.doesNotMatch(lines.join("\n"), /·|glob|truncated/u);
});

test("成功专用工具无展开入口，不参与选择循环", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t1", "read", false, "pi_native", INCARNATION_ID, { tool: "read", path: "a.txt" }),
    toolEnd("t2", "read", true, "pi_native", INCARNATION_ID, { tool: "read", path: "b.txt" }, "boom"),
  ], { viewport_height: 20 });
  // 唯一可展开项是失败条目；Tab 选中它且循环只在该条目上。
  const first = viewer.getSelectedKey();
  assert.match(first ?? "", /tool-error:/u);
  viewer.handleInput("\t");
  assert.equal(viewer.getSelectedKey(), first);
});

test("write 运行中与成功摘要都只显示 path，不显示写入统计", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolStart("t1", "write", "pi_native", INCARNATION_ID, { tool: "write", path: "out/result.md" }),
  ], { viewport_height: 20 });
  const running = dedicatedToolLine(viewer, "write");
  assert.match(running ?? "", /^↻ write · out\/result\.md$/u);

  viewer.syncFrom([
    toolStart("t1", "write", "pi_native", INCARNATION_ID, { tool: "write", path: "out/result.md" }),
    toolEnd("t1", "write", false, "pi_native", INCARNATION_ID, { tool: "write", path: "out/result.md" }),
  ]);
  const done = dedicatedToolLine(viewer, "write");
  // 成功摘要仍只有 path：行数、字节数等写入统计不出现。
  assert.match(done ?? "", /^✓ write · out\/result\.md$/u);
  assert.doesNotMatch(done ?? "", /lines|bytes/u);
  // 成功摘要不可展开，无折叠标记。
  assert.doesNotMatch(done ?? "", /▸|▾/u);
});

test("edit 成功摘要只显示 path，不显示编辑统计", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t1", "edit", false, "pi_native", INCARNATION_ID, { tool: "edit", path: "src/a.ts" }),
  ], { viewport_height: 20 });
  const line = dedicatedToolLine(viewer, "edit");
  assert.match(line ?? "", /^✓ edit · src\/a\.ts$/u);
  assert.doesNotMatch(line ?? "", /edits|edits count/u);
  assert.doesNotMatch(line ?? "", /▸|▾/u);
});

test("write/edit 失败标题状态前置，展开错误正文逐行带引导线", () => {
  const theme = {
    fg: (color: string, text: string): string => `<fg:${color}>${text}</fg:${color}>`,
    bg: (color: string, text: string): string => `<bg:${color}>${text}</bg:${color}>`,
    bold: (text: string): string => `<bold>${text}</bold>`,
  };
  const errorText = "Error: EACCES: permission denied, open '/etc/hosts'\nsecond *literal* line";
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolStart("t1", "write", "pi_native", INCARNATION_ID, { tool: "write", path: "/etc/hosts" }),
    toolEnd("t1", "write", true, "pi_native", INCARNATION_ID, { tool: "write", path: "/etc/hosts" }, errorText),
    toolEnd("t2", "edit", true, "pi_native", INCARNATION_ID, { tool: "edit", path: "src/a.ts" }, "not found"),
  ], { viewport_height: 20 });
  const collapsed = viewer.render(160).slice(1, -1);
  // 失败摘要只显示 path：无写入统计、无编辑统计。
  const writeLine = collapsed.find((line) => line.includes("write"));
  assert.match(writeLine ?? "", /^▸ × write · \/etc\/hosts$/u);
  assert.doesNotMatch(writeLine ?? "", /lines|bytes|edits/u);
  assert.match(writeLine ?? "", /▸/u);
  const editLine = collapsed.find((line) => line.includes("edit"));
  assert.match(editLine ?? "", /^▸ × edit · src\/a\.ts$/u);
  assert.doesNotMatch(editLine ?? "", /edits/u);
  // 错误正文默认不展开。
  assert.doesNotMatch(collapsed.join("\n"), /permission denied/u);

  // 展开后：红色预格式化纯文本、保留换行、逐行带 `│` 且不解析 Markdown。
  assert.equal(viewer.handleInput("\t"), "changed");
  assert.match(viewer.getSelectedKey() ?? "", /tool-error:/u);
  assert.equal(viewer.handleInput("\r"), "changed");
  const expanded = viewer.render(160).slice(1, -1);
  const errorLines = expanded.filter((line) => line.includes("permission denied") || line.includes("second"));
  assert.equal(errorLines.length, 2, expanded.join("\n"));
  assert.ok(expanded.some((line) => line.startsWith("│ Error: EACCES")), expanded.join("\n"));
  assert.ok(expanded.some((line) => line.startsWith("│ second *literal*")), expanded.join("\n"));
  const surface = renderAgentActivityViewerSurface(viewer, 160, theme).join("\n");
  assert.match(surface, /<fg:error>[^]*permission denied/u);
});

test("bash 命令默认折叠，状态原地更新后保持展开状态", () => {
  const command = 'echo "hello world"';
  const start = toolStart("t1", "bash", "pi_native", INCARNATION_ID, {
    tool: "bash", command, timeout: 5,
  });
  const viewer = new AgentActivityViewerModel(viewerAgent(), [start], { viewport_height: 20 });
  let lines = viewer.render(160).slice(1, -1);
  assert.ok(lines.includes("▸ ↻ bash · timeout 5"), lines.join("\n"));
  assert.ok(!lines.some((line) => line.includes(command)), lines.join("\n"));
  assert.match(viewer.getSelectedKey() ?? "", /tool-command:/u);

  // Shell 复用既有展开按键；展开后命令正文逐行带引导线。
  assert.equal(viewer.handleInput("\r"), "changed");
  lines = viewer.render(160).slice(1, -1);
  assert.ok(lines.includes("▾ ↻ bash · timeout 5"), lines.join("\n"));
  assert.ok(lines.includes(`│ ${command}`), lines.join("\n"));

  // 结束原地更新：标题状态变化，命令保持展开且内容不重排。
  viewer.syncFrom([start, toolEnd("t1", "bash", false, "pi_native", INCARNATION_ID, {
    tool: "bash", command, timeout: 5,
  })]);
  lines = viewer.render(160).slice(1, -1);
  const summaryIndex = lines.findIndex((line) => line.includes("bash"));
  assert.equal(lines[summaryIndex], "▾ ✓ bash · timeout 5");
  assert.equal(lines[summaryIndex + 1], `│ ${command}`);
  assert.equal(lines.filter((line) => line.includes(command)).length, 1, lines.join("\n"));
});

test("bash 与 powershell 多行命令逐项折叠，展开后完整显示", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t1", "bash", false, "pi_native", INCARNATION_ID, {
      tool: "bash", command: "npm run build\nnpm test -- --watch=false\nnpm run typecheck",
    }),
    toolEnd("t2", "powershell", false, "pi_native", INCARNATION_ID, {
      tool: "powershell", command: "Get-ChildItem src",
    }),
  ], { viewport_height: 20 });
  let lines = viewer.render(160).slice(1, -1);
  assert.ok(lines.includes("▸ ✓ bash"), lines.join("\n"));
  assert.ok(lines.includes("▸ ✓ powershell"), lines.join("\n"));
  assert.doesNotMatch(lines.join("\n"), /npm run build|Get-ChildItem/u);

  // 初始选择最新 powershell，随后 Tab 回到 bash；两项可同时保持展开。
  assert.equal(viewer.handleInput("\r"), "changed");
  assert.equal(viewer.handleInput("\t"), "changed");
  assert.equal(viewer.handleInput("\r"), "changed");
  lines = viewer.render(160).slice(1, -1);
  assert.ok(lines.includes("│ npm run build"), lines.join("\n"));
  assert.ok(lines.includes("│ npm test -- --watch=false"), lines.join("\n"));
  assert.ok(lines.includes("│ npm run typecheck"), lines.join("\n"));
  assert.ok(lines.includes("│ Get-ChildItem src"), lines.join("\n"));
});

test("codemode 折叠态显示脚本行数与嵌套调用数，展开体显示脚本正文", () => {
  const code = "const text = await tools.read({ path: \"a.ts\" });\nreturn text.length;";
  const start = toolStart("t1", "codemode", "pi_extension", INCARNATION_ID, {
    tool: "codemode", code, codeLines: 2,
  });
  const end = toolEnd("t1", "codemode", false, "pi_extension", INCARNATION_ID, {
    tool: "codemode", code, codeLines: 2, isError: false, nestedCalls: 3,
  });
  const viewer = new AgentActivityViewerModel(viewerAgent(), [start, end], { viewport_height: 20 });
  let lines = viewer.render(160).slice(1, -1);
  assert.ok(lines.includes("▸ ✓ codemode · 2 lines · 3 nested calls"), lines.join("\n"));
  // 折叠态不显示脚本正文；条目保持单一。
  assert.doesNotMatch(lines.join("\n"), /return text\.length/u);
  assert.equal(lines.filter((line) => line.includes("codemode")).length, 1, lines.join("\n"));
  assert.match(viewer.getSelectedKey() ?? "", /tool-code:/u);

  // 展开：脚本作为预格式化正文逐行带引导线，保留原始换行。
  assert.equal(viewer.handleInput("\r"), "changed");
  lines = viewer.render(160).slice(1, -1);
  assert.ok(lines.includes("▾ ✓ codemode · 2 lines · 3 nested calls"), lines.join("\n"));
  assert.ok(lines.includes('│ const text = await tools.read({ path: "a.ts" });'), lines.join("\n"));
  assert.ok(lines.includes("│ return text.length;"), lines.join("\n"));
});

test("codemode 结束事实原地更新后展开状态与脚本内容保持", () => {
  const code = "await tools.read({ path: \"a.ts\" });";
  const start = toolStart("t1", "codemode", "pi_extension", INCARNATION_ID, {
    tool: "codemode", code, codeLines: 1,
  });
  const viewer = new AgentActivityViewerModel(viewerAgent(), [start], { viewport_height: 20 });
  assert.equal(viewer.handleInput("\r"), "changed");
  assert.ok(viewer.render(160).some((line) => line.startsWith("│ await tools.read")));

  viewer.syncFrom([start, toolEnd("t1", "codemode", false, "pi_extension", INCARNATION_ID, {
    tool: "codemode", code, codeLines: 1, isError: false, nestedCalls: 4,
  })]);
  const lines = viewer.render(160).slice(1, -1);
  assert.ok(lines.includes("▾ ✓ codemode · 1 lines · 4 nested calls"), lines.join("\n"));
  assert.ok(lines.includes('│ await tools.read({ path: "a.ts" });'), lines.join("\n"));
  assert.equal(lines.filter((line) => line.includes("codemode")).length, 1, lines.join("\n"));
});

test("codemode 结束摘要缺少脚本正文时不提供展开入口，仍显示嵌套调用数", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t1", "codemode", false, "pi_extension", INCARNATION_ID, {
      tool: "codemode", isError: false, nestedCalls: 0,
    }),
  ], { viewport_height: 20 });
  const lines = viewer.render(160).slice(1, -1);
  assert.ok(lines.includes("✓ codemode · 0 nested calls"), lines.join("\n"));
  assert.equal(viewer.getSelectedKey(), undefined);
});

test("codemode 失败条目状态图标为失败，脚本错误正文不进入面板", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t1", "codemode", true, "pi_extension", INCARNATION_ID, {
      tool: "codemode", code: "throw new Error(\"boom\");", codeLines: 1,
      isError: true, nestedCalls: 0,
    }),
  ], { viewport_height: 20 });
  let lines = viewer.render(160).slice(1, -1);
  assert.ok(lines.includes("▸ × codemode · 1 lines · 0 nested calls"), lines.join("\n"));
  assert.doesNotMatch(lines.join("\n"), /Script error|Error: boom/u);
  assert.equal(viewer.handleInput("\r"), "changed");
  lines = viewer.render(160).slice(1, -1);
  assert.ok(lines.includes('│ throw new Error("boom");'), lines.join("\n"));
});

test("嵌套条目带 codemode-> 前缀，自身摘要不回归", () => {
  const code = "await tools.read({ path: \"a.ts\" });";
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolStart("call_1", "codemode", "pi_extension", INCARNATION_ID, {
      tool: "codemode", code, codeLines: 1,
    }),
    toolStart("call_1/1", "read", "pi_native", INCARNATION_ID, {
      tool: "read", path: "src/a.ts",
    }, undefined, undefined, "call_1"),
    toolEnd("call_1/1", "read", false, "pi_native", INCARNATION_ID, {
      tool: "read", path: "src/a.ts",
    }, undefined, undefined, undefined, undefined, "call_1"),
    toolEnd("call_1", "codemode", false, "pi_extension", INCARNATION_ID, {
      tool: "codemode", code, codeLines: 1, isError: false, nestedCalls: 1,
    }),
  ], { viewport_height: 20 });
  const lines = viewer.render(160).slice(1, -1);
  // 顶层 codemode 条目不带前缀，行为与 02 一致。
  assert.ok(lines.includes("▸ ✓ codemode · 1 lines · 1 nested calls"), lines.join("\n"));
  // 嵌套条目：前缀只加在工具名前，自身摘要（path）原样保留。
  assert.ok(lines.includes("✓ codemode->read · src/a.ts"), lines.join("\n"));
  assert.equal(lines.filter((line) => line.includes("codemode->read")).length, 1, lines.join("\n"));
  // 前缀不参与摘要：嵌套条目本身没有可展开正文，也不影响顶层展开入口。
  assert.doesNotMatch(lines.join("\n"), /src\/a\.ts.*src\/a\.ts/u);
});

test("多级嵌套链按完整调用链拼接，超过 3 层省略中间", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolStart("call_1", "codemode", "pi_extension", INCARNATION_ID, {
      tool: "codemode", code: "return 1;", codeLines: 1,
    }),
    toolStart("call_1/1", "A", "unknown", INCARNATION_ID, undefined, undefined, undefined, "call_1"),
    toolStart("call_1/1/1", "B", "unknown", INCARNATION_ID, undefined, undefined, undefined, "call_1/1"),
    toolStart("call_1/1/1/1", "D", "unknown", INCARNATION_ID, undefined, undefined, undefined, "call_1/1/1"),
    // 父条目未被观察到时仍标记嵌套来源，前缀退化为根标记。
    toolStart("call_2/1", "orphan", "unknown", INCARNATION_ID, undefined, undefined, undefined, "call_2"),
  ], { viewport_height: 20 });
  const lines = viewer.render(160).slice(1, -1);
  assert.ok(lines.includes("↻ codemode->A"), lines.join("\n"));
  assert.ok(lines.includes("↻ codemode->A->B"), lines.join("\n"));
  assert.ok(lines.includes("↻ codemode->…->D"), lines.join("\n"));
  assert.ok(lines.includes("↻ codemode->orphan"), lines.join("\n"));
});

test("嵌套条目保持自身折叠与选中能力，不改变生命周期", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolStart("call_1", "codemode", "pi_extension", INCARNATION_ID, {
      tool: "codemode", code: "await tools.bash({ command: \"npm test\" });", codeLines: 1,
    }),
    toolEnd("call_1/1", "bash", false, "pi_native", INCARNATION_ID, {
      tool: "bash", command: "npm test",
    }, undefined, undefined, undefined, undefined, "call_1"),
    toolEnd("call_1/2", "mcp__docs__search", true, "mcp", INCARNATION_ID, {
      tool: "mcp__docs__search", server: "docs", mcpTool: "search", isError: true, annotations: { readOnlyHint: true },
    }, undefined, undefined, undefined, undefined, "call_1"),
  ], { viewport_height: 20 });
  const lines = viewer.render(160).slice(1, -1);
  assert.ok(lines.includes("▸ ✓ codemode->bash"), lines.join("\n"));
  assert.ok(lines.includes("× codemode->mcp__docs__search · read-only"), lines.join("\n"));
  // 选中最新嵌套条目并沿用既有展开按键；展开体只显示命令正文。
  assert.match(viewer.getSelectedKey() ?? "", /tool-command:/u);
  assert.equal(viewer.handleInput("\r"), "changed");
  const expanded = viewer.render(160).slice(1, -1);
  assert.ok(expanded.includes("▾ ✓ codemode->bash"), expanded.join("\n"));
  assert.ok(expanded.includes("│ npm test"), expanded.join("\n"));
  // 嵌套条目只是活动事实：不改变生命周期状态。
  assert.equal(viewer.getPublicState().lifecycle_state, "working");
});

test("单次调用超过 256 条嵌套记录时聚合显示其余数量", () => {
  const total = 300;
  const nested: CanonicalAgentActivityEntry[] = [];
  for (let index = 1; index <= total; index += 1) {
    nested.push(toolEnd(`call_1/${index}`, "read", false, "pi_native", INCARNATION_ID, {
      tool: "read", path: `src/f${index}.ts`,
    }, undefined, undefined, undefined, undefined, "call_1"));
  }
  const entries: CanonicalAgentActivityEntry[] = [
    toolStart("call_1", "codemode", "pi_extension", INCARNATION_ID, {
      tool: "codemode", code: "return 1;", codeLines: 1,
    }),
    ...nested,
    // 另一次调用不受前一次超量影响，仍逐条显示。
    toolStart("call_2", "codemode", "pi_extension", INCARNATION_ID, {
      tool: "codemode", code: "return 2;", codeLines: 1,
    }),
    toolEnd("call_2/1", "grep", false, "pi_native", INCARNATION_ID, {
      tool: "grep", pattern: "x", path: "src",
    }, undefined, undefined, undefined, undefined, "call_2"),
  ];
  const viewer = new AgentActivityViewerModel(viewerAgent(), entries, { viewport_height: 400 });
  const lines = viewer.render(160).slice(1, -1);
  assert.equal(
    lines.filter((line) => line.includes("codemode->read")).length,
    NESTED_ACTIVITY_DISPLAY_LIMIT,
    lines.join("\n"),
  );
  // 超量部分只聚合为一行，紧跟在逐条显示的末尾。
  assert.equal(lines.filter((line) => line.includes("其余")).length, 1, lines.join("\n"));
  assert.ok(lines.includes(`其余 ${total - NESTED_ACTIVITY_DISPLAY_LIMIT} 条省略`), lines.join("\n"));
  const omittedIndex = lines.findIndex((line) => line.includes("其余"));
  assert.ok(lines[omittedIndex - 1]?.includes("codemode->read"), lines.join("\n"));
  // 另一次调用的嵌套条目仍逐条显示。
  assert.ok(lines.includes("✓ codemode->grep · /x/ · src"), lines.join("\n"));
  assert.ok(lines.indexOf("✓ codemode->grep · /x/ · src") > omittedIndex, lines.join("\n"));

  // 增量到达时聚合数量原地增长，不新增聚合行。
  const grown = [
    ...entries,
    toolEnd("call_1/301", "read", false, "pi_native", INCARNATION_ID, {
      tool: "read", path: "src/f301.ts",
    }, undefined, undefined, undefined, undefined, "call_1"),
  ];
  viewer.syncFrom(grown);
  const grownLines = viewer.render(160).slice(1, -1);
  assert.equal(grownLines.filter((line) => line.includes("其余")).length, 1, grownLines.join("\n"));
  assert.ok(grownLines.includes(`其余 ${total + 1 - NESTED_ACTIVITY_DISPLAY_LIMIT} 条省略`), grownLines.join("\n"));
  assert.equal(grownLines.filter((line) => line.includes("codemode->read")).length, NESTED_ACTIVITY_DISPLAY_LIMIT);
});

test("tool_search 折叠态显示查询词与加载工具数量", () => {
  const start = toolStart("t1", "tool_search", "pi_extension", INCARNATION_ID, {
    tool: "tool_search", query: "mcp resource",
  });
  const end = toolEnd("t1", "tool_search", false, "pi_extension", INCARNATION_ID, {
    tool: "tool_search",
    query: "mcp resource",
    isError: false,
    loaded: ["read", "grep", "mcp__docs__search"],
    loadedTotal: 3,
  });
  const viewer = new AgentActivityViewerModel(viewerAgent(), [start, end], { viewport_height: 20 });
  const lines = viewer.render(160).slice(1, -1);
  assert.ok(
    lines.includes('✓ tool_search · "mcp resource" · read, grep, mcp__docs__search · 3 tools'),
    lines.join("\n"),
  );
  // tool_search 没有独立展开体：不提供展开入口。
  assert.equal(viewer.getSelectedKey(), undefined);
});

test("tool_search 加载列表超过 20 个时折叠态显示截断数量", () => {
  const loaded = Array.from({ length: 20 }, (_, index) => `tool_${index}`);
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t1", "tool_search", false, "pi_extension", INCARNATION_ID, {
      tool: "tool_search", query: "docs", isError: false, loaded, loadedTotal: 25,
    }),
  ], { viewport_height: 20 });
  const lines = viewer.render(200).slice(1, -1);
  assert.ok(lines.join("\n").includes("20/25 tools"), lines.join("\n"));
});

test("tool_search 失败条目显示失败状态与查询词，无匹配时显示零总数", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t1", "tool_search", false, "pi_extension", INCARNATION_ID, {
      tool: "tool_search", query: "不存在", isError: false, loaded: [], loadedTotal: 0,
    }),
    toolEnd("t2", "tool_search", true, "pi_extension", INCARNATION_ID, {
      tool: "tool_search", query: "bad", isError: true,
    }),
  ], { viewport_height: 20 });
  const lines = viewer.render(160).slice(1, -1);
  assert.ok(lines.includes('✓ tool_search · "不存在" · 0 tools'), lines.join("\n"));
  assert.ok(lines.includes('× tool_search · "bad"'), lines.join("\n"));
});

test("MCP 工具折叠态显示工具名与实际存在的风险注解", () => {
  const toolName = "mcp__docs__search";
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t1", toolName, true, "mcp", INCARNATION_ID, {
      tool: toolName,
      server: "docs",
      mcpTool: "search",
      isError: true,
      annotations: { readOnlyHint: true, destructiveHint: true },
    }),
    toolEnd("t2", "mcp__docs__list", false, "mcp", INCARNATION_ID, {
      tool: "mcp__docs__list", server: "docs", mcpTool: "list", isError: false,
    }),
  ], { viewport_height: 20 });
  const lines = viewer.render(160).slice(1, -1);
  assert.ok(lines.includes("× mcp__docs__search · read-only · destructive"), lines.join("\n"));
  // 缺省 annotations 不产生标签，也不提供展开入口。
  assert.ok(lines.includes("✓ mcp__docs__list"), lines.join("\n"));
  assert.equal(viewer.getSelectedKey(), undefined);
});

test("MCP 工具带哈希后缀时折叠态显示完整工具名", () => {
  const toolName = "mcp__very_long_server__very_long_tool_name_a1b2c3d4";
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolStart("t1", toolName, "mcp", INCARNATION_ID, {
      tool: toolName, server: "very_long_server", mcpTool: "very_long_tool_name_a1b2c3d4",
    }),
  ], { viewport_height: 20 });
  const lines = viewer.render(160).slice(1, -1);
  assert.ok(lines.some((line) => line.includes(toolName)), lines.join("\n"));
});

test("MCP 资源工具折叠态显示服务器与资源 URI", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t1", "read_mcp_resource", false, "mcp", INCARNATION_ID, {
      tool: "read_mcp_resource", server: "docs", uri: "file:///spec.md", isError: false,
    }),
    toolEnd("t2", "list_mcp_resources", true, "mcp", INCARNATION_ID, {
      tool: "list_mcp_resources", server: "docs", isError: true,
    }),
  ], { viewport_height: 20 });
  const lines = viewer.render(160).slice(1, -1);
  assert.ok(lines.includes("✓ read_mcp_resource · docs · file:///spec.md"), lines.join("\n"));
  assert.ok(lines.includes("× list_mcp_resources · docs"), lines.join("\n"));
});

test("端到端：tool_search 原始事件经产生端规范化后在面板显示查询与加载结果", () => {
  const normalized = normalizeOwnToolActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_search",
    toolName: "tool_search",
    isError: false,
    result: {
      content: [{ type: "text", text: "Loaded 2 tools. 工具描述正文不得上屏" }],
      details: { loaded: ["read", "mcp__docs__search"] },
    },
  }, "pi_extension", { query: "resource" });
  assert.equal(normalized.kind, "event");
  if (normalized.kind !== "event") return;
  const entry: CanonicalAgentActivityEntry = Object.freeze({
    contract_version: CANONICAL_ACTIVITY_CONTRACT_VERSION,
    agent_id: AGENT_ID,
    incarnation_id: INCARNATION_ID,
    entry_id: randomUUID(),
    body: normalized.event,
  });
  const viewer = new AgentActivityViewerModel(viewerAgent(), [entry], { viewport_height: 20 });
  const lines = viewer.render(160).slice(1, -1);
  assert.ok(
    lines.includes('✓ tool_search · "resource" · read, mcp__docs__search · 2 tools'),
    lines.join("\n"),
  );
  assert.doesNotMatch(lines.join("\n"), /工具描述正文不得上屏/u);
});

test("端到端：MCP 工具失败事件经产生端规范化后面板显示失败且无外部正文", () => {
  const normalized = normalizeOwnToolActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_mcp",
    toolName: "mcp__docs__search",
    isError: true,
    result: {
      content: [{ type: "text", text: "MCP 错误正文不得上屏" }],
      structuredContent: { secret: "结构化正文不得上屏" },
      details: { server: "docs", tool: "search" },
    },
  }, "mcp", undefined, undefined, undefined, () => ({ readOnlyHint: true }));
  assert.equal(normalized.kind, "event");
  if (normalized.kind !== "event") return;
  const entry: CanonicalAgentActivityEntry = Object.freeze({
    contract_version: CANONICAL_ACTIVITY_CONTRACT_VERSION,
    agent_id: AGENT_ID,
    incarnation_id: INCARNATION_ID,
    entry_id: randomUUID(),
    body: normalized.event,
  });
  const viewer = new AgentActivityViewerModel(viewerAgent(), [entry], { viewport_height: 20 });
  const lines = viewer.render(160).slice(1, -1);
  assert.ok(lines.includes("× mcp__docs__search · read-only"), lines.join("\n"));
  assert.doesNotMatch(lines.join("\n"), /错误正文不得上屏|结构化正文不得上屏/u);
});

test("端到端：codemode 嵌套调用原始事件经产生端规范化后面板显示前缀条目与超量聚合", () => {
  const entryOf = (normalized: ReturnType<typeof normalizeOwnToolActivityEvent>): CanonicalAgentActivityEntry => {
    assert.equal(normalized.kind, "event");
    if (normalized.kind !== "event") throw new Error("unreachable");
    return Object.freeze({
      contract_version: CANONICAL_ACTIVITY_CONTRACT_VERSION,
      agent_id: AGENT_ID,
      incarnation_id: INCARNATION_ID,
      entry_id: randomUUID(),
      body: normalized.event,
    });
  };
  const entries: CanonicalAgentActivityEntry[] = [
    entryOf(normalizeOwnToolActivityEvent({
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "codemode",
      args: { code: "await tools.read({ path: \"a.ts\" });" },
    }, "pi_extension")),
    entryOf(normalizeOwnToolActivityEvent({
      type: "tool_execution_end",
      toolCallId: "call_1/1",
      toolName: "read",
      parentToolCallId: "call_1",
      result: { content: [{ type: "text", text: "文件正文不得上屏" }] },
      isError: false,
    }, "pi_native", { path: "a.ts" })),
    // 多级链：脚本内工具再发起嵌套调用。
    entryOf(normalizeOwnToolActivityEvent({
      type: "tool_execution_end",
      toolCallId: "call_1/2",
      toolName: "grep",
      parentToolCallId: "call_1",
      result: { content: [{ type: "text", text: "匹配正文不得上屏" }] },
      isError: false,
    }, "pi_native", { pattern: "x", path: "src" })),
    entryOf(normalizeOwnToolActivityEvent({
      type: "tool_execution_end",
      toolCallId: "call_1/2/1",
      toolName: "mcp__docs__search",
      parentToolCallId: "call_1/2",
      result: { content: [{ type: "text", text: "MCP 正文不得上屏" }] },
      isError: true,
    }, "mcp")),
  ];
  // 超量：单次调用超过 256 条嵌套记录只聚合为一行。
  for (let index = 1; index <= NESTED_ACTIVITY_DISPLAY_LIMIT + 1; index += 1) {
    entries.push(entryOf(normalizeOwnToolActivityEvent({
      type: "tool_execution_end",
      toolCallId: `call_1/3/${index}`,
      toolName: "ls",
      parentToolCallId: "call_1/3",
      result: { content: [] },
      isError: false,
    }, "pi_native", { path: "." })));
  }
  entries.push(entryOf(normalizeOwnToolActivityEvent({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "codemode",
    result: { content: [{ type: "text", text: "Script completed" }], details: { calls: [] } },
    isError: false,
  }, "pi_extension", { code: "await tools.read({ path: \"a.ts\" });" })));

  const viewer = new AgentActivityViewerModel(viewerAgent(), entries, { viewport_height: 500 });
  const lines = viewer.render(200).slice(1, -1);
  assert.ok(lines.includes("✓ codemode->read · a.ts"), lines.join("\n"));
  assert.ok(lines.includes("× codemode->grep->mcp__docs__search"), lines.join("\n"));
  assert.ok(lines.includes("✓ codemode->grep · /x/ · src"), lines.join("\n"));
  assert.equal(lines.filter((line) => line.includes("其余")).length, 1, lines.join("\n"));
  assert.ok(lines.includes("其余 1 条省略"), lines.join("\n"));
  // 外部正文与结果正文都不上屏。
  assert.doesNotMatch(lines.join("\n"), /文件正文不得上屏|MCP 正文不得上屏|匹配正文不得上屏|Script completed/u);
});

test("结束事实补齐开始事实缺失的父引用后显示前缀", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolStart("call_1", "codemode", "pi_extension", INCARNATION_ID, {
      tool: "codemode", code: "return 1;", codeLines: 1,
    }),
    toolStart("call_1/1", "read", "pi_native", INCARNATION_ID, {
      tool: "read", path: "a.ts",
    }),
    toolEnd("call_1/1", "read", false, "pi_native", INCARNATION_ID, {
      tool: "read", path: "a.ts",
    }, undefined, undefined, undefined, undefined, "call_1"),
  ], { viewport_height: 20 });
  const lines = viewer.render(160).slice(1, -1);
  assert.ok(lines.includes("✓ codemode->read · a.ts"), lines.join("\n"));
});

test("不同运行实例复用同一活动 ID 时嵌套超量计数不串联", () => {
  const incarnationB = "3f1c2f44-9a1b-4c3d-8e5f-6a7b8c9d0e1f";
  const entries: CanonicalAgentActivityEntry[] = [
    toolStart("call_1", "codemode", "pi_extension", INCARNATION_ID, {
      tool: "codemode", code: "return 1;", codeLines: 1,
    }),
  ];
  for (let index = 1; index <= NESTED_ACTIVITY_DISPLAY_LIMIT; index += 1) {
    entries.push(toolEnd(`call_1/${index}`, "read", false, "pi_native", INCARNATION_ID, {
      tool: "read", path: `a${index}.ts`,
    }, undefined, undefined, undefined, undefined, "call_1"));
  }
  entries.push(
    toolStart("call_1", "codemode", "pi_extension", incarnationB, {
      tool: "codemode", code: "return 2;", codeLines: 1,
    }),
    toolEnd("call_1/1", "read", false, "pi_native", incarnationB, {
      tool: "read", path: "b.ts",
    }, undefined, undefined, undefined, undefined, "call_1"),
  );
  const viewer = new AgentActivityViewerModel(viewerAgent(), entries, { viewport_height: 400 });
  const lines = viewer.render(160).slice(1, -1);
  // 第二个运行实例的同名根调用不受第一个实例已达上限的计数影响。
  assert.ok(lines.includes("✓ codemode->read · b.ts"), lines.join("\n"));
  assert.equal(lines.filter((line) => line.includes("其余")).length, 0, lines.join("\n"));
});

test("端到端：活动缓存到面板的嵌套超量记录聚合显示", () => {
  const cache = new AgentActivityCache();
  const entryOf = (body: SafeAgentActivityEvent): CanonicalAgentActivityEntry => Object.freeze({
    contract_version: CANONICAL_ACTIVITY_CONTRACT_VERSION,
    agent_id: AGENT_ID,
    incarnation_id: INCARNATION_ID,
    entry_id: randomUUID(),
    body,
  });
  const codemode = normalizeOwnToolActivityEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "codemode",
    args: { code: "return 1;" },
  }, "pi_extension");
  assert.equal(codemode.kind, "event");
  if (codemode.kind !== "event") return;
  cache.record(AGENT_ID, entryOf(codemode.event));
  // 运行中的嵌套调用不受活动窗口裁剪，全部进入权威快照。
  for (let index = 1; index <= NESTED_ACTIVITY_DISPLAY_LIMIT + 1; index += 1) {
    const nested = normalizeOwnToolActivityEvent({
      type: "tool_execution_start",
      toolCallId: `call_1/${index}`,
      toolName: "read",
      parentToolCallId: "call_1",
      args: { path: `f${index}.ts` },
    }, "pi_native");
    assert.equal(nested.kind, "event");
    if (nested.kind !== "event") return;
    cache.record(AGENT_ID, entryOf(nested.event));
  }
  const snapshot = cache.readSnapshot(AGENT_ID);
  assert.equal(snapshot.entries.length, NESTED_ACTIVITY_DISPLAY_LIMIT + 2);
  const viewer = new AgentActivityViewerModel(viewerAgent(), snapshot, { viewport_height: 400 });
  const lines = viewer.render(160).slice(1, -1);
  assert.equal(
    lines.filter((line) => line.includes("codemode->read")).length,
    NESTED_ACTIVITY_DISPLAY_LIMIT,
    lines.join("\n"),
  );
  assert.ok(lines.includes("其余 1 条省略"), lines.join("\n"));
});

test("bash 失败只显示状态与完整 command，不显示 stdout、stderr 或退出码", () => {
  const theme = {
    fg: (color: string, text: string): string => `<fg:${color}>${text}</fg:${color}>`,
    bg: (color: string, text: string): string => `<bg:${color}>${text}</bg:${color}>`,
    bold: (text: string): string => `<bold>${text}</bold>`,
  };
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd(
      "t1",
      "bash",
      true,
      "pi_native",
      INCARNATION_ID,
      { tool: "bash", command: "exit 1", timeout: 5 },
      "stdout: leaked\nstderr: leaked\nCommand exited with code 1",
    ),
  ], { viewport_height: 20 });
  let lines = viewer.render(160).slice(1, -1);
  assert.ok(lines.includes("▸ × bash · timeout 5"), lines.join("\n"));
  assert.doesNotMatch(lines.join("\n"), /exit 1|stdout|stderr|exited with code/u);

  assert.equal(viewer.handleInput("\r"), "changed");
  lines = viewer.render(160).slice(1, -1);
  assert.ok(lines.includes("▾ × bash · timeout 5"), lines.join("\n"));
  assert.ok(lines.includes("│ exit 1"), lines.join("\n"));
  assert.doesNotMatch(lines.join("\n"), /stdout|stderr|exited with code/u);
  const surface = renderAgentActivityViewerSurface(viewer, 120, theme).join("\n");
  assert.match(surface, /<fg:error>×<\/fg:error>/u);
});

test("展开的命令正文按可用宽度软换行且不截断字符", () => {
  const command = "C".repeat(150);
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t1", "bash", false, "pi_native", INCARNATION_ID, { tool: "bash", command }),
  ], { viewport_height: 20 });
  assert.equal(viewer.handleInput("\r"), "changed");
  const width = 60;
  const lines = viewer.render(width).slice(1, -1);
  const commandLines = lines.filter((line) => line.includes("C"));
  assert.ok(commandLines.length > 1, lines.join("\n"));
  assert.ok(commandLines.every((line) => line.startsWith("│ ") && displayWidth(line) <= width), lines.join("\n"));
  // 软换行不丢失字符。
  assert.equal(commandLines.join("").split("C").length - 1, 150);
});

test("未知来源 bash 走安全兜底，不显示命令展开入口", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t1", "bash", false, "unknown"),
  ], { viewport_height: 20 });
  const lines = viewer.render(160).slice(1, -1);
  assert.ok(lines.some((line) => line === "✓ bash"), lines.join("\n"));
  assert.equal(lines.filter((line) => line.includes("bash")).length, 1);
  assert.equal(viewer.getSelectedKey(), undefined);
});

test("展开命令正文的控制字符在查看器渲染中不可见", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t1", "bash", false, "pi_native", INCARNATION_ID, {
      tool: "bash",
      command: "echo safe\u001b[31m-red\u001b[0m\n\u202etail",
    }),
  ], { viewport_height: 20 });
  assert.equal(viewer.handleInput("\r"), "changed");
  const body = viewer.render(120).slice(1, -1).join("\n");
  assert.doesNotMatch(body, /\u001b|\u202e/u);
  assert.match(body, /│ echo safe-red/u);
});

const CHILD_SPAWN_ID = "1b3f2a7c-9d4e-4f5a-8b6c-7d8e9f0a1b2c";

function parentMessageEntry(text: string): CanonicalAgentActivityEntry {
  return Object.freeze({
    contract_version: CANONICAL_ACTIVITY_CONTRACT_VERSION,
    agent_id: AGENT_ID,
    incarnation_id: randomUUID(),
    entry_id: randomUUID(),
    body: Object.freeze({
      type: "parent_message",
      content: Object.freeze([Object.freeze({ type: "text", text })]),
    }),
  });
}

test("五种插件工具的运行中摘要只显示白名单参数", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolStart("t1", "get_agent_templates", "plugin", INCARNATION_ID, { tool: "get_agent_templates" }),
    toolStart("t2", "spawn_agent", "plugin", INCARNATION_ID, {
      tool: "spawn_agent", name: "worker-a", template_id: "worker",
    }),
    toolStart("t3", "send_message", "plugin", INCARNATION_ID, {
      tool: "send_message", agent_id: CHILD_SPAWN_ID, message: "任务正文", name: "worker-b",
    }),
    toolStart("t4", "normal_reply", "plugin", INCARNATION_ID, {
      tool: "normal_reply", message: "中间回复正文",
    }),
    toolStart("t5", "final_report", "plugin", INCARNATION_ID, {
      tool: "final_report", message: "最终报告正文",
    }),
  ], { viewport_height: 20 });
  const body = viewer.render(160).slice(1, -1).join("\n");

  // 无载荷摘要行没有任何尾随字段。
  assert.match(body, /↻ get_agent_templates\n/u);
  // spawn_agent：name 与 template ID，无 depth、无初始 state、无 agent_id。
  assert.match(body, /↻ spawn_agent · worker-a · worker\n/u);
  assert.doesNotMatch(body, /depth|initial|state:/u);
  // send_message：目标名称与固定八位短 ID，无 accepted；正文默认折叠。
  assert.match(body, /▸ ↻ send_message · worker-b · 1b3f2a7c/u);
  assert.doesNotMatch(body, /accepted/u);
  assert.doesNotMatch(body, /任务正文/u);
  assert.match(body, /▸/u);
  // 消息类摘要只显示工具名；完整正文默认折叠。
  assert.match(body, /▸ ↻ normal_reply\n/u);
  assert.match(body, /▸ ↻ final_report\n/u);
  assert.doesNotMatch(body, /中间回复正文|最终报告正文/u);
});

test("插件工具成功摘要显示模板数量与固定八位短 ID，不显示完整 UUID", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t1", "get_agent_templates", false, "plugin", INCARNATION_ID, {
      tool: "get_agent_templates", count: 7,
    }),
    toolEnd("t2", "spawn_agent", false, "plugin", INCARNATION_ID, {
      tool: "spawn_agent", name: "worker-a", template_id: "worker", agent_id: CHILD_SPAWN_ID,
    }),
    toolEnd("t3", "send_message", false, "plugin", INCARNATION_ID, {
      tool: "send_message", agent_id: CHILD_SPAWN_ID, message: "你好", name: "worker-b",
    }),
  ], { viewport_height: 20 });
  const body = viewer.render(160).slice(1, -1).join("\n");

  assert.match(body, /✓ get_agent_templates · 7 templates/u);
  // 模板 ID、描述等配置不出现。
  assert.doesNotMatch(body, /template_|描述|description/u);
  assert.match(body, /✓ spawn_agent · worker-a · worker · 1b3f2a7c/u);
  assert.doesNotMatch(body, /1b3f2a7c-9d4e/u);
  // send_message 成功也不显示 accepted；正文仍默认折叠可展开。
  assert.match(body, /▸ ✓ send_message · worker-b · 1b3f2a7c/u);
  assert.doesNotMatch(body, /accepted/u);
  assert.doesNotMatch(body, /你好/u);
});

test("插件工具失败标题显示稳定错误码，前置状态为错误色", () => {
  const theme = {
    fg: (color: string, text: string): string => `<fg:${color}>${text}</fg:${color}>`,
    bg: (color: string, text: string): string => `<bg:${color}>${text}</bg:${color}>`,
    bold: (text: string): string => `<bold>${text}</bold>`,
  };
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t1", "get_agent_templates", true, "plugin", INCARNATION_ID, {
      tool: "get_agent_templates",
    }, undefined, "internal_error"),
    toolEnd("t2", "spawn_agent", true, "plugin", INCARNATION_ID, {
      tool: "spawn_agent", name: "worker-a", template_id: "worker",
    }, undefined, "spawn_failed"),
    toolEnd("t3", "send_message", true, "plugin", INCARNATION_ID, {
      tool: "send_message", agent_id: CHILD_SPAWN_ID, message: "投递正文", name: "worker-b",
    }, undefined, "agent_unavailable"),
    toolEnd("t4", "normal_reply", true, "plugin", INCARNATION_ID, {
      tool: "normal_reply", message: "过长回复正文",
    }, undefined, "reply_too_large"),
  ], { viewport_height: 20 });
  const body = viewer.render(160).slice(1, -1).join("\n");

  assert.match(body, /× get_agent_templates · internal_error/u);
  // 失败摘要不携带模板数量事实。
  assert.doesNotMatch(body, /\d+ templates/u);
  // 失败 spawn 摘要没有 agent_id：行尾只有稳定错误码。
  assert.match(body, /× spawn_agent · worker-a · worker · spawn_failed\n/u);
  // 失败正文保留：标题含稳定错误码，前置状态标红，正文默认折叠。
  assert.match(body, /▸ × send_message · worker-b · 1b3f2a7c · agent_unavailable/u);
  assert.doesNotMatch(body, /投递正文/u);
  assert.match(body, /▸ × normal_reply · reply_too_large/u);
  assert.doesNotMatch(body, /过长回复正文/u);

  const surface = renderAgentActivityViewerSurface(viewer, 160, theme).join("\n");
  assert.match(surface, /<fg:error>×<\/fg:error>/u);
});

test("消息工具展开为带引导线的 Markdown，状态变化不折叠正文", () => {
  const startEntry = toolStart("t1", "send_message", "plugin", INCARNATION_ID, {
    tool: "send_message", agent_id: CHILD_SPAWN_ID, message: "第一行\n**加粗正文**", name: "worker-b",
  });
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    startEntry,
  ], { viewport_height: 20 });

  // 默认折叠：正文不可见，有折叠标记。
  let body = viewer.render(160).slice(1, -1);
  assert.doesNotMatch(body.join("\n"), /加粗正文/u);
  assert.match(body.join("\n"), /▸/u);

  // 选中并展开：正文带引导线显示为 Markdown，标题行保留。
  assert.equal(viewer.handleInput("\t"), "changed");
  assert.match(viewer.getSelectedKey() ?? "", /tool-message:/u);
  assert.equal(viewer.handleInput("\r"), "changed");
  body = viewer.render(160).slice(1, -1);
  assert.match(body.join("\n"), /▾/u);
  assert.ok(body.includes("│ 第一行"), body.join("\n"));
  assert.ok(body.includes("│ 加粗正文"), body.join("\n"));

  // 状态变化（成功结束）不折叠正文：展开状态保持。
  viewer.syncFrom([startEntry, toolEnd("t1", "send_message", false, "plugin", INCARNATION_ID, {
    tool: "send_message", agent_id: CHILD_SPAWN_ID, message: "第一行\n**加粗正文**", name: "worker-b",
  })]);
  body = viewer.render(160).slice(1, -1);
  assert.match(body.join("\n"), /▾ ✓ send_message · worker-b · 1b3f2a7c/u);
  assert.ok(body.includes("│ 第一行"), body.join("\n"));

  // 失败结束：正文继续可查看，行尾出现稳定错误码。
  const failStart = toolStart("t2", "send_message", "plugin", INCARNATION_ID, {
    tool: "send_message", agent_id: CHILD_SPAWN_ID, message: "第一行\n**加粗正文**", name: "worker-b",
  });
  const failViewer = new AgentActivityViewerModel(viewerAgent(), [failStart], { viewport_height: 20 });
  failViewer.handleInput("\t");
  failViewer.handleInput("\r");
  failViewer.syncFrom([failStart, toolEnd("t2", "send_message", true, "plugin", INCARNATION_ID, {
    tool: "send_message", agent_id: CHILD_SPAWN_ID, message: "第一行\n**加粗正文**", name: "worker-b",
  }, undefined, "message_delivery_failed")]);
  const failBody = failViewer.render(160).slice(1, -1);
  assert.match(failBody.join("\n"), /▾ × send_message · worker-b · 1b3f2a7c · message_delivery_failed/u);
  assert.ok(failBody.includes("│ 第一行"), failBody.join("\n"));
});

test("final_report 失败正文保留并可展开为 Markdown", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t1", "final_report", true, "plugin", INCARNATION_ID, {
      tool: "final_report", message: "报告标题\n结论正文",
    }, undefined, "agent_unavailable"),
  ], { viewport_height: 20 });
  const collapsed = viewer.render(160).slice(1, -1).join("\n");
  assert.match(collapsed, /▸ × final_report · agent_unavailable/u);
  assert.doesNotMatch(collapsed, /结论正文/u);

  viewer.handleInput("\t");
  viewer.handleInput("\r");
  const expanded = viewer.render(160).slice(1, -1);
  assert.ok(expanded.includes("│ 报告标题"), expanded.join("\n"));
  assert.ok(expanded.includes("│ 结论正文"), expanded.join("\n"));
});

test("Parent message 条目统一标题、默认折叠、可展开且重复正文不去重", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    parentMessageEntry("第一条任务指令"),
    parentMessageEntry("第一条任务指令"),
  ], { viewport_height: 20 });

  // 完全相同正文不去重：两条独立条目；标题不携带父代理身份。
  const collapsed = viewer.render(160).slice(1, -1);
  const titles = collapsed.filter((line) => line === "▸ Parent message");
  assert.equal(titles.length, 2, collapsed.join("\n"));
  assert.doesNotMatch(collapsed.join("\n"), /任务指令|父代理|parent-a/u);

  // 逐条独立展开：Tab+Enter 两次展开两条。
  assert.equal(viewer.handleInput("\t"), "changed");
  assert.match(viewer.getSelectedKey() ?? "", /parent-message:/u);
  assert.equal(viewer.handleInput("\r"), "changed");
  assert.equal(viewer.handleInput("\t"), "changed");
  assert.equal(viewer.handleInput("\r"), "changed");
  const expanded = viewer.render(160).slice(1, -1);
  const bodies = expanded.filter((line) => line === "│ 第一条任务指令");
  assert.equal(bodies.length, 2, expanded.join("\n"));
  // 标题在展开后保留并统一改用向下箭头。
  assert.equal(expanded.filter((line) => line === "▾ Parent message").length, 2);
});

test("未知来源的插件工具名走安全兜底，不显示插件摘要与错误码", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t1", "spawn_agent", false, "unknown"),
    toolEnd("t2", "send_message", true, "unknown"),
    toolEnd("t3", "final_report", true, "plugin"),
  ], { viewport_height: 20 });
  const lines = viewer.render(160).slice(1, -1);

  // 兜底条目只显示工具名与状态。
  assert.ok(lines.some((line) => line === "✓ spawn_agent"), lines.join("\n"));
  assert.ok(lines.some((line) => line === "× send_message"), lines.join("\n"));
  // plugin 来源缺必需摘要时同样兜底：无错误码可显示。
  assert.ok(lines.some((line) => line === "× final_report"), lines.join("\n"));
  assert.doesNotMatch(lines.join("\n"), /·|worker|1b3f2a7c|agent_unavailable/u);
});

const WAIT_RELEASER_ID = "22c4d1e8-3a5b-4c6d-8e9f-0a1b2c3d4e5f";
const CONTROL_CHILD_ID = "33d5e2f9-4b6c-4d7e-9f0a-1b2c3d4e5f6a";

test("等待与控制工具的运行中摘要只显示目标事实", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolStart("t1", "wait_agent", "plugin", INCARNATION_ID, {
      tool: "wait_agent", agent_id: CHILD_SPAWN_ID, name: "worker-b",
    }),
    toolStart("t2", "wait_agent", "plugin", INCARNATION_ID, {
      tool: "wait_agent", target_count: 3,
    }),
    toolStart("t3", "interrupt_agent", "plugin", INCARNATION_ID, {
      tool: "interrupt_agent", agent_id: CONTROL_CHILD_ID, name: "worker-c",
    }),
    toolStart("t4", "terminate_agent", "plugin", INCARNATION_ID, {
      tool: "terminate_agent", agent_id: CONTROL_CHILD_ID,
    }),
    toolStart("t5", "get_agent_status", "plugin", INCARNATION_ID, {
      tool: "get_agent_status", agent_id: CONTROL_CHILD_ID, name: "worker-c",
    }),
    toolStart("t6", "get_agent_tree", "plugin", INCARNATION_ID, {
      tool: "get_agent_tree",
    }),
  ], { viewport_height: 20 });
  const body = viewer.render(160).slice(1, -1).join("\n");

  // 单目标显示名称与固定八位短 ID；timeout_ms 等调用约束不显示。
  assert.match(body, /↻ wait_agent · worker-b · 1b3f2a7c\n/u);
  // 多目标只显示数量。
  assert.match(body, /↻ wait_agent · 3 targets\n/u);
  assert.doesNotMatch(body, /timeout_ms|agent_ids|300000/u);
  // 控制工具显示目标；查询与回收目标同样使用固定八位短 ID。
  assert.match(body, /↻ interrupt_agent · worker-c · 33d5e2f9\n/u);
  assert.match(body, /↻ terminate_agent · 33d5e2f9\n/u);
  assert.match(body, /↻ get_agent_status · worker-c · 33d5e2f9\n/u);
  assert.match(body, /↻ get_agent_tree\n/u);
});

test("wait_agent 成功摘要显示实际 outcome 与 batch release 事实", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t1", "wait_agent", false, "plugin", INCARNATION_ID, {
      tool: "wait_agent", agent_id: CHILD_SPAWN_ID, name: "worker-b", outcome: "reply",
    }),
    toolEnd("t2", "wait_agent", false, "plugin", INCARNATION_ID, {
      tool: "wait_agent", agent_id: CHILD_SPAWN_ID, name: "worker-b", outcome: "final_report",
    }),
    toolEnd("t3", "wait_agent", false, "plugin", INCARNATION_ID, {
      tool: "wait_agent", agent_id: CHILD_SPAWN_ID, outcome: "idle",
    }),
    toolEnd("t4", "wait_agent", false, "plugin", INCARNATION_ID, {
      tool: "wait_agent", agent_id: CHILD_SPAWN_ID, outcome: "terminal",
    }),
    toolEnd("t5", "wait_agent", false, "plugin", INCARNATION_ID, {
      tool: "wait_agent", agent_id: CHILD_SPAWN_ID, outcome: "timeout",
    }),
    toolEnd("t6", "wait_agent", false, "plugin", INCARNATION_ID, {
      tool: "wait_agent", target_count: 3, outcome: "timeout",
    }),
    toolEnd("t7", "wait_agent", false, "plugin", INCARNATION_ID, {
      tool: "wait_agent", target_count: 3, outcome: "batch_released",
      released_by: WAIT_RELEASER_ID, released_by_name: "worker-a", released_outcome: "reply",
    }),
  ], { viewport_height: 20 });
  const body = viewer.render(160).slice(1, -1).join("\n");

  // 所有成功返回的 outcome 都使用成功符号。
  assert.match(body, /✓ wait_agent · worker-b · 1b3f2a7c · reply\n/u);
  assert.match(body, /✓ wait_agent · worker-b · 1b3f2a7c · final_report\n/u);
  assert.match(body, /✓ wait_agent · 1b3f2a7c · idle\n/u);
  assert.match(body, /✓ wait_agent · 1b3f2a7c · terminal\n/u);
  assert.match(body, /✓ wait_agent · 1b3f2a7c · timeout\n/u);
  assert.match(body, /✓ wait_agent · 3 targets · timeout\n/u);
  // batch release：数量、释放者与释放 outcome。
  assert.match(body, /✓ wait_agent · 3 targets · batch_released · worker-a · 22c4d1e8 · reply\n/u);
  // 原始结果结构、报告正文与 revision 不进入摘要。
  assert.doesNotMatch(body, /revision|task_result|accepted/u);
  assert.doesNotMatch(body, /22c4d1e8-3a5b/u);
});

test("wait_agent woken 摘要展示目标数量与实际 outcome", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t1", "wait_agent", false, "plugin", INCARNATION_ID, {
      tool: "wait_agent", target_count: 2, outcome: "woken",
    }),
  ], { viewport_height: 20 });
  const body = viewer.render(160).slice(1, -1).join("\n");

  // 父输入唤醒是成功返回的工具调用：展示实际 outcome，不展示固定 wake_reason。
  assert.match(body, /✓ wait_agent · 2 targets · woken\n/u);
});

test("wait_agent 目标 failed 与调用失败都使用前置错误状态", () => {
  const theme = {
    fg: (color: string, text: string): string => `<fg:${color}>${text}</fg:${color}>`,
    bg: (color: string, text: string): string => `<bg:${color}>${text}</bg:${color}>`,
    bold: (text: string): string => `<bold>${text}</bold>`,
  };
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t1", "wait_agent", false, "plugin", INCARNATION_ID, {
      tool: "wait_agent", agent_id: CHILD_SPAWN_ID, name: "worker-b",
      outcome: "terminal", state: "failed", error_code: "model_unavailable",
    }),
    toolEnd("t2", "wait_agent", true, "plugin", INCARNATION_ID, {
      tool: "wait_agent", agent_id: CHILD_SPAWN_ID, name: "worker-b",
    }, undefined, "agent_not_found"),
  ], { viewport_height: 20 });
  const body = viewer.render(160).slice(1, -1).join("\n");

  // 目标 state failed：红色失败与白名单安全错误码；调用本身成功。
  assert.match(body, /× wait_agent · worker-b · 1b3f2a7c · terminal · failed · model_unavailable\n/u);
  // 调用本身失败：标题保留稳定错误码，前置状态为失败。
  assert.match(body, /× wait_agent · worker-b · 1b3f2a7c · agent_not_found\n/u);

  const surface = renderAgentActivityViewerSurface(viewer, 160, theme).join("\n");
  assert.match(surface, /<fg:error>×<\/fg:error>/u);
});

test("interrupt_agent 区分进入中断、unchanged 与压缩阻塞", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t1", "interrupt_agent", false, "plugin", INCARNATION_ID, {
      tool: "interrupt_agent", agent_id: CHILD_SPAWN_ID, name: "worker-b", changed: true,
    }),
    toolEnd("t2", "interrupt_agent", false, "plugin", INCARNATION_ID, {
      tool: "interrupt_agent", agent_id: CHILD_SPAWN_ID, name: "worker-b", changed: false,
    }),
    toolEnd("t3", "interrupt_agent", false, "plugin", INCARNATION_ID, {
      tool: "interrupt_agent", agent_id: CHILD_SPAWN_ID, changed: false,
      blocked_reason: "compaction_active",
    }),
    toolEnd("t4", "interrupt_agent", true, "plugin", INCARNATION_ID, {
      tool: "interrupt_agent", agent_id: CHILD_SPAWN_ID, name: "worker-b",
    }, undefined, "agent_not_found"),
  ], { viewport_height: 20 });
  const body = viewer.render(160).slice(1, -1).join("\n");

  // 进入 interrupting：成功且无额外事实。
  assert.match(body, /✓ interrupt_agent · worker-b · 1b3f2a7c\n/u);
  // unchanged 与压缩阻塞：中性事实位于标题中。
  assert.match(body, /✓ interrupt_agent · worker-b · 1b3f2a7c · unchanged\n/u);
  assert.match(body, /✓ interrupt_agent · 1b3f2a7c · compaction_active\n/u);
  // 稳定调用错误：前置失败状态。
  assert.match(body, /× interrupt_agent · worker-b · 1b3f2a7c · agent_not_found\n/u);
});

test("terminate_agent 显示回收数量、幂等与强制回收警告", () => {
  const theme = {
    fg: (color: string, text: string): string => `<fg:${color}>${text}</fg:${color}>`,
    bg: (color: string, text: string): string => `<bg:${color}>${text}</bg:${color}>`,
    bold: (text: string): string => `<bold>${text}</bold>`,
  };
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t1", "terminate_agent", false, "plugin", INCARNATION_ID, {
      tool: "terminate_agent", agent_id: CHILD_SPAWN_ID, name: "worker-b",
      changed: true, terminated_count: 2,
    }),
    toolEnd("t2", "terminate_agent", false, "plugin", INCARNATION_ID, {
      tool: "terminate_agent", agent_id: CHILD_SPAWN_ID, name: "worker-b",
      changed: false, terminated_count: 0,
    }),
    toolEnd("t3", "terminate_agent", true, "plugin", INCARNATION_ID, {
      tool: "terminate_agent", agent_id: CHILD_SPAWN_ID, name: "worker-b",
    }, undefined, "termination_incomplete"),
  ], { viewport_height: 20 });
  const body = viewer.render(160).slice(1, -1).join("\n");

  // 正常回收：成功符号加回收数量。
  assert.match(body, /✓ terminate_agent · worker-b · 1b3f2a7c · 2 reclaimed\n/u);
  // already terminated：中性幂等事实。
  assert.match(body, /✓ terminate_agent · worker-b · 1b3f2a7c · already terminated\n/u);
  // 清理不完整：前置失败状态。
  assert.match(body, /× terminate_agent · worker-b · 1b3f2a7c · termination_incomplete\n/u);

  // 强制回收成功：警告而非失败，成功结果与风险事实同时保留。
  const forcedViewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t4", "terminate_agent", false, "plugin", INCARNATION_ID, {
      tool: "terminate_agent", agent_id: CHILD_SPAWN_ID, name: "worker-b",
      changed: true, forced: true, terminated_count: 3,
    }),
  ], { viewport_height: 20 });
  const forcedBody = forcedViewer.render(160).slice(1, -1).join("\n");
  assert.match(forcedBody, /⚠ terminate_agent · worker-b · 1b3f2a7c · 3 reclaimed · forced\n/u);
  const forcedSurface = renderAgentActivityViewerSurface(forcedViewer, 160, theme).join("\n");
  assert.match(forcedSurface, /<fg:warning>⚠<\/fg:warning>/u);
});

test("get_agent_status 只将 failed 与错误码片段标红，查询成功始终成功符号", () => {
  const theme = {
    fg: (color: string, text: string): string => `<fg:${color}>${text}</fg:${color}>`,
    bg: (color: string, text: string): string => `<bg:${color}>${text}</bg:${color}>`,
    bold: (text: string): string => `<bold>${text}</bold>`,
  };
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t1", "get_agent_status", false, "plugin", INCARNATION_ID, {
      tool: "get_agent_status", agent_id: CHILD_SPAWN_ID, name: "worker-b",
      state: "working", phase: "tool_calls",
    }),
    toolEnd("t2", "get_agent_status", false, "plugin", INCARNATION_ID, {
      tool: "get_agent_status", agent_id: CHILD_SPAWN_ID, state: "idle",
    }),
    toolEnd("t3", "get_agent_status", false, "plugin", INCARNATION_ID, {
      tool: "get_agent_status", agent_id: CHILD_SPAWN_ID, state: "terminated",
      termination_result: "completed",
    }),
    toolEnd("t4", "get_agent_status", false, "plugin", INCARNATION_ID, {
      tool: "get_agent_status", agent_id: CHILD_SPAWN_ID, name: "worker-b",
      state: "failed", error_code: "provider_unavailable",
    }),
    toolEnd("t5", "get_agent_status", true, "plugin", INCARNATION_ID, {
      tool: "get_agent_status", agent_id: CHILD_SPAWN_ID, name: "worker-b",
    }, undefined, "not_direct_child"),
  ], { viewport_height: 20 });
  const body = viewer.render(160).slice(1, -1).join("\n");

  // working/interrupting 可显示 activity phase；terminated 显示终止结果。
  assert.match(body, /✓ get_agent_status · worker-b · 1b3f2a7c · working · tool_calls\n/u);
  assert.match(body, /✓ get_agent_status · 1b3f2a7c · idle\n/u);
  assert.match(body, /✓ get_agent_status · 1b3f2a7c · terminated · completed\n/u);
  // 目标 failed：failed 与错误码片段并列，查询成功状态仍位于最左侧。
  assert.match(body, /✓ get_agent_status · worker-b · 1b3f2a7c · failed · provider_unavailable\n/u);
  // 查询调用失败：前置失败状态。
  assert.match(body, /× get_agent_status · worker-b · 1b3f2a7c · not_direct_child\n/u);
  // revision、时间与上下文占用不进入显示。
  assert.doesNotMatch(body, /revision|created_at|elapsed|context_usage|88/u);

  const surface = renderAgentActivityViewerSurface(viewer, 160, theme).join("\n");
  // 局部标红：标题保持粗体强调，failed 与错误码片段使用错误色，状态为 dim。
  assert.match(
    surface,
    /<fg:dim>✓<\/fg:dim> <fg:dim><bold>get_agent_status · worker-b · 1b3f2a7c · <\/bold><\/fg:dim><fg:error><bold>failed · provider_unavailable<\/bold><\/fg:error>/u,
  );
  // 成功查询的前置状态不使用错误色。
  assert.doesNotMatch(surface, /<fg:error>✓<\/fg:error>/u);
  // 调用失败使用前置错误状态。
  assert.match(surface, /<fg:error>×<\/fg:error>/u);
});

test("get_agent_tree 成功只显示工具名与成功状态", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t1", "get_agent_tree", false, "plugin", INCARNATION_ID, {
      tool: "get_agent_tree",
    }),
    toolEnd("t2", "get_agent_tree", true, "plugin", INCARNATION_ID, {
      tool: "get_agent_tree",
    }, undefined, "agent_unavailable"),
  ], { viewport_height: 20 });
  const body = viewer.render(160).slice(1, -1).join("\n");

  assert.match(body, /✓ get_agent_tree\n/u);
  assert.match(body, /× get_agent_tree · agent_unavailable\n/u);
  // revision、scope、节点列表与状态统计不进入显示。
  assert.doesNotMatch(body, /revision|scope|nodes|stats|worker/u);
});

test("未知来源的等待与控制工具走安全兜底", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    toolEnd("t1", "wait_agent", false, "unknown"),
    toolEnd("t2", "get_agent_status", true, "unknown"),
  ], { viewport_height: 20 });
  const lines = viewer.render(160).slice(1, -1);

  assert.ok(lines.some((line) => line === "✓ wait_agent"), lines.join("\n"));
  assert.ok(lines.some((line) => line === "× get_agent_status"), lines.join("\n"));
  assert.doesNotMatch(lines.join("\n"), /·|1b3f2a7c|worker/u);
});

test("setViewportHeight 响应式扩展或收缩视口，保持跟随与滚动夹紧", () => {
  const entries = Array.from({ length: 30 }, (_, index) => textMessage(`行 ${index}`));
  const viewer = new AgentActivityViewerModel(viewerAgent(), entries, { viewport_height: 5 });
  assert.equal(viewer.getPublicState().scroll_offset, 25);

  // 扩展视口：跟随保持对齐最新条目，正文行数随视口扩展。
  viewer.setViewportHeight(10);
  assert.equal(viewer.getPublicState().scroll_offset, 20);
  const grownBody = viewer.render(80).slice(1, -1);
  assert.equal(grownBody.length, 10);
  assert.match(grownBody.at(-1) ?? "", /行 29/u);

  // 收缩视口：跟随保持对齐最新条目，滚动偏移重新夹紧。
  viewer.setViewportHeight(3);
  assert.equal(viewer.getPublicState().scroll_offset, 27);
  assert.equal(viewer.getViewportHeight(), 3);
  const shrunkBody = viewer.render(80).slice(1, -1);
  assert.equal(shrunkBody.length, 3);
  assert.match(shrunkBody.at(-1) ?? "", /行 29/u);

  // 非法输入忽略，不重置当前视口。
  viewer.setViewportHeight(0);
  assert.equal(viewer.getViewportHeight(), 3);
});

/* ---------------------------------- 鼠标支持 ---------------------------------- */

/** 全字段填齐的 TuiMouseEvent 构造器；未覆盖字段使用中性默认值。 */
function mkMouseEvent(
  overrides: Partial<TuiMouseEvent> & Pick<TuiMouseEvent, "type">,
): TuiMouseEvent {
  return {
    button: "none",
    x: 0,
    y: 0,
    screenX: 0,
    screenY: 0,
    width: 80,
    height: 24,
    shift: false,
    alt: false,
    ctrl: false,
    ...overrides,
  };
}

test("鼠标滚轮滚动正文，超界夹紧且 wheelDelta 为 0 时忽略", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    messageEntry([{ type: "thinking", thinking: "目标思考" }]),
    textMessage("a\nb\nc\nd\ne"),
  ], { viewport_height: 3 });
  // 1 行 thinking + 5 行正文，视口 3 行；跟随底部时 offset=3。
  assert.equal(viewer.render(160).length, 5);
  assert.equal(viewer.getPublicState().scroll_offset, 3);

  // 向下滚动超界：offset 夹紧到最大值，滚轮事件一律吞掉。
  assert.deepEqual(
    viewer.handleMouse(mkMouseEvent({ type: "wheel", wheelDelta: 10, y: 4 }), true),
    { handled: true },
  );
  assert.equal(viewer.getPublicState().scroll_offset, 3);

  // 向上滚动按 delta 移动。
  assert.deepEqual(
    viewer.handleMouse(mkMouseEvent({ type: "wheel", wheelDelta: -1, y: 4 }), true),
    { handled: true },
  );
  assert.equal(viewer.getPublicState().scroll_offset, 2);

  // 再向上超界：夹紧到 0。
  assert.deepEqual(
    viewer.handleMouse(mkMouseEvent({ type: "wheel", wheelDelta: -10, y: 4 }), true),
    { handled: true },
  );
  assert.equal(viewer.getPublicState().scroll_offset, 0);

  // wheelDelta 为 0 的事件被忽略且不改变位置。
  assert.equal(
    viewer.handleMouse(mkMouseEvent({ type: "wheel", wheelDelta: 0, y: 4 }), true),
    undefined,
  );
  assert.equal(viewer.getPublicState().scroll_offset, 0);
});

test("鼠标滚轮向下滚到底恢复 follow，向上滚暂停", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    messageEntry([{ type: "thinking", thinking: "目标思考" }]),
    textMessage("a\nb\nc\nd\ne"),
  ], { viewport_height: 3 });
  assert.equal(viewer.render(160).length, 5);
  assert.equal(viewer.getPublicState().follow_enabled, true);

  // 向上滚动：暂停 follow。
  viewer.handleMouse(mkMouseEvent({ type: "wheel", wheelDelta: -2, y: 4 }), true);
  assert.equal(viewer.getPublicState().follow_enabled, false);
  assert.equal(viewer.getPublicState().scroll_offset, 1);

  // 向下滚到底：与键盘 ↓ 语义一致，恢复 follow。
  viewer.handleMouse(mkMouseEvent({ type: "wheel", wheelDelta: 3, y: 4 }), true);
  assert.equal(viewer.getPublicState().follow_enabled, true);
  assert.equal(
    viewer.getPublicState().scroll_offset,
    viewer.getPublicState().max_scroll_offset,
  );

  // 未到底的向下移动不恢复 follow。
  viewer.handleMouse(mkMouseEvent({ type: "wheel", wheelDelta: -1, y: 4 }), true);
  assert.equal(viewer.getPublicState().follow_enabled, false);
  viewer.handleMouse(mkMouseEvent({ type: "wheel", wheelDelta: 1, y: 4 }), true);
  assert.equal(viewer.getPublicState().follow_enabled, true);
  viewer.handleMouse(mkMouseEvent({ type: "wheel", wheelDelta: -1, y: 4 }), true);
  assert.equal(viewer.getPublicState().follow_enabled, false);
  assert.equal(viewer.getPublicState().scroll_offset, 2);
});

test("鼠标左键点击可展开行切换折叠，framed 与 narrow 正文偏移都生效", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    messageEntry([{ type: "thinking", thinking: "思考" }]),
    textMessage("正文"),
  ], { viewport_height: 8 });
  assert.equal(viewer.render(160).length, 10);
  assert.equal(viewer.getExpandedKeys().length, 0);

  // framed：正文从 y=3 开始；点击第一行（Thinking 标题）展开。
  assert.deepEqual(
    viewer.handleMouse(mkMouseEvent({ type: "click", button: "left", y: 3 }), true),
    { handled: true },
  );
  assert.equal(viewer.getExpandedKeys().length, 1);
  assert.match(viewer.render(160).join("\n"), /▾ Thinking/u);

  // 再次点击同一行折叠还原。
  assert.deepEqual(
    viewer.handleMouse(mkMouseEvent({ type: "click", button: "left", y: 3 }), true),
    { handled: true },
  );
  assert.equal(viewer.getExpandedKeys().length, 0);

  // narrow：正文从 y=1 开始。
  assert.deepEqual(
    viewer.handleMouse(mkMouseEvent({ type: "click", button: "left", y: 1 }), false),
    { handled: true },
  );
  assert.equal(viewer.getExpandedKeys().length, 1);
  viewer.handleMouse(mkMouseEvent({ type: "click", button: "left", y: 1 }), false);
  assert.equal(viewer.getExpandedKeys().length, 0);
});

test("鼠标点击普通正文行吞事件但不改变展开或选择状态", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    messageEntry([{ type: "thinking", thinking: "思考" }]),
    textMessage("正文"),
  ], { viewport_height: 8 });
  assert.equal(viewer.render(160).length, 10);
  const selectedBefore = viewer.getSelectedKey();

  // 正文行没有可展开身份：只吞事件，不产生状态变化。
  assert.deepEqual(
    viewer.handleMouse(mkMouseEvent({ type: "click", button: "left", y: 4 }), true),
    { handled: true },
  );
  assert.equal(viewer.getExpandedKeys().length, 0);
  assert.equal(viewer.getSelectedKey(), selectedBefore);
});

test("鼠标点击 header、footer 与边框行吞事件但无状态变化", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    messageEntry([{ type: "thinking", thinking: "思考" }]),
    textMessage("正文"),
  ], { viewport_height: 8 });
  assert.equal(viewer.render(160).length, 10);
  const selectedBefore = viewer.getSelectedKey();

  // framed：顶边框、header、分隔线、分隔线、footer、底边框都在正文区之外。
  for (const y of [0, 1, 2, 11, 12, 13]) {
    assert.deepEqual(
      viewer.handleMouse(mkMouseEvent({ type: "click", button: "left", y }), true),
      { handled: true },
    );
  }
  assert.equal(viewer.getExpandedKeys().length, 0);
  assert.equal(viewer.getSelectedKey(), selectedBefore);

  // narrow：header 与 footer 同样只吞事件。
  for (const y of [0, 9]) {
    assert.deepEqual(
      viewer.handleMouse(mkMouseEvent({ type: "click", button: "left", y }), false),
      { handled: true },
    );
  }
  assert.equal(viewer.getExpandedKeys().length, 0);
  assert.equal(viewer.getSelectedKey(), selectedBefore);
});

test("非滚轮与非左键点击的鼠标事件返回 undefined", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), [
    messageEntry([{ type: "thinking", thinking: "思考" }]),
    textMessage("正文"),
  ], { viewport_height: 8 });
  assert.equal(viewer.render(160).length, 10);

  for (const type of ["press", "release", "move", "drag"] as const) {
    assert.equal(
      viewer.handleMouse(mkMouseEvent({ type, button: "left", y: 3 }), true),
      undefined,
    );
  }
  // 右键点击同样不处理。
  assert.equal(
    viewer.handleMouse(mkMouseEvent({ type: "click", button: "right", y: 3 }), true),
    undefined,
  );
  assert.equal(viewer.getExpandedKeys().length, 0);
});

/* --------------------------------- Home/End 跳转 --------------------------------- */

test("Home/End 跳转首尾并切换 follow，重复按键忽略且 footer 提示更新", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), replayFixture(), {
    viewport_height: VIEWPORT,
  });
  // 初始跟随底部：按 End 已在尾部且跟随，返回 ignored。
  assert.equal(viewer.getPublicState().follow_enabled, true);
  assert.equal(viewer.handleInput("\x1b[F"), "ignored");

  // Home 跳到首部：回看历史，暂停 follow。
  assert.equal(viewer.handleInput("\x1b[H"), "changed");
  let state = viewer.getPublicState();
  assert.equal(state.scroll_offset, 0);
  assert.equal(state.follow_enabled, false);
  // 已在首部且非跟随：再次 Home 忽略。
  assert.equal(viewer.handleInput("\x1b[H"), "ignored");

  // End 跳到尾部：恢复 follow。
  assert.equal(viewer.handleInput("\x1b[F"), "changed");
  state = viewer.getPublicState();
  assert.equal(state.scroll_offset, state.max_scroll_offset);
  assert.equal(state.follow_enabled, true);
  // 已在尾部且跟随：再次 End 忽略。
  assert.equal(viewer.handleInput("\x1b[F"), "ignored");

  // footer 提示新快捷键。
  assert.ok(
    (viewer.render(160).at(-1) ?? "").includes("Home/End jump"),
    viewer.render(160).join("\n"),
  );
});

test("End 跳到尾部恢复 follow，后续追加条目视口继续跟随", () => {
  const viewer = new AgentActivityViewerModel(viewerAgent(), replayFixture(), {
    viewport_height: VIEWPORT,
  });
  assert.equal(viewer.handleInput("\x1b[H"), "changed");
  assert.equal(viewer.getPublicState().follow_enabled, false);

  assert.equal(viewer.handleInput("\x1b[F"), "changed");
  assert.equal(viewer.getPublicState().follow_enabled, true);

  // 追加新条目：跟随语义保持，视口对齐最新底部。
  viewer.syncFrom([...replayFixture(), toolStart("t2", "run_cmd")]);
  const state = viewer.getPublicState();
  assert.equal(state.follow_enabled, true);
  assert.equal(state.scroll_offset, state.max_scroll_offset);
});
