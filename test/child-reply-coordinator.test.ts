import assert from "node:assert/strict";
import test from "node:test";
import { displayWidth } from "../src/agent-tree-ui.ts";
import {
  CHILD_REPLY_SCHEMA,
  CHILD_REPLY_VERSION,
  CHILD_TERMINAL_SCHEMA,
  type ChildFinalEnvelope,
  type ChildMessageEnvelope,
  type ChildReplyEnvelope,
  type TerminalNotice,
} from "../src/child-reply-envelope.ts";
import {
  ChildReplyCoordinator,
  type ChildReplyPort,
} from "../src/child-reply-coordinator.ts";
import {
  ParentReplyInbox,
  createVisibleEnvelope,
  registerParentReplyMessageRenderers,
  type ParentReplyMessageRenderer,
} from "../src/parent-reply-inbox.ts";

const AGENT_ID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_AGENT_ID = "650e8400-e29b-41d4-a716-446655440000";
const TURN_1 = "550e8400-e29b-41d4-a716-446655440001";
const TURN_2 = "550e8400-e29b-41d4-a716-446655440002";
const UUID_V1 = "550e8400-e29b-11d4-a716-446655440001";

class RecordingPort implements ChildReplyPort {
  readonly replies: ChildReplyEnvelope[] = [];
  private pending: Array<() => void> = [];

  publishReplyAndWaitForAck(reply: ChildReplyEnvelope): Promise<void> {
    this.replies.push(reply);
    return new Promise<void>((resolve) => this.pending.push(resolve));
  }

  acknowledgeAll(): void {
    for (const resolve of this.pending.splice(0)) resolve();
  }
}

class RejectingPort implements ChildReplyPort {
  calls = 0;

  async publishReplyAndWaitForAck(): Promise<void> {
    this.calls += 1;
    throw new Error("父端未确认");
  }
}

function coordinator(port: ChildReplyPort, turns = [TURN_1, TURN_2]): ChildReplyCoordinator {
  let index = 0;
  return new ChildReplyCoordinator({
    agentId: AGENT_ID,
    port,
    turnIdFactory: () => turns[index++]!,
  });
}

function messageEnvelope(
  text: string,
  requiresResponse = false,
  turnId = TURN_1,
): ChildMessageEnvelope {
  return {
    schema: CHILD_REPLY_SCHEMA,
    version: CHILD_REPLY_VERSION,
    kind: "message",
    agent_id: AGENT_ID,
    turn_id: turnId,
    requires_response: requiresResponse,
    text,
  };
}

function finalEnvelope(
  text: string | undefined,
  overrides: Partial<Omit<ChildFinalEnvelope, "text" | "reason_code">> & {
    readonly reason_code?: ChildFinalEnvelope["reason_code"] | undefined;
  } = {},
): ChildFinalEnvelope {
  const value = {
    schema: CHILD_REPLY_SCHEMA,
    version: CHILD_REPLY_VERSION,
    kind: "final" as const,
    agent_id: AGENT_ID,
    turn_id: TURN_1,
    run_state: "settled" as const,
    output_state: text === undefined ? "absent" as const : "present" as const,
    ...(text === undefined ? { reason_code: "no_output" as const } : { text }),
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as unknown as ChildFinalEnvelope;
}

async function nextTask(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("工作中消息与 settled final 共享运行时轮次并按 ACK 顺序发布", async () => {
  const port = new RecordingPort();
  const value = coordinator(port);
  value.observeAgentStart();
  value.observeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "toolUse",
      content: [{ type: "text", text: "我先检查文件" }, { type: "toolCall", id: "1", name: "read" }],
    },
  });
  const progress = value.replyToParent({
    message: "正在读取文件，完成后继续。",
    requires_response: true,
  });
  await nextTask();
  assert.deepEqual(port.replies, [messageEnvelope("正在读取文件，完成后继续。", true)]);
  port.acknowledgeAll();
  assert.deepEqual(await progress, { ok: true, data: { accepted: true } });

  value.observeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "最终结果" }],
    },
  });
  const settled = value.settle();
  await nextTask();
  assert.deepEqual(port.replies[1], finalEnvelope("最终结果"));
  port.acknowledgeAll();
  await settled;
  await value.settle();
  assert.equal(port.replies.length, 2);
});

test("final 提交后迟到的 message_end 不能重新打开同一轮工作中回复", async () => {
  const replies: ChildReplyEnvelope[] = [];
  const value = coordinator({
    async publishReplyAndWaitForAck(reply) {
      replies.push(reply);
    },
  });
  value.observeAgentStart();
  value.observeAssistantMessageEnd({
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "已完成" }] },
  });
  await value.settle();

  value.observeAssistantMessageEnd({
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "迟到内容" }] },
  });
  const lateReply = await value.replyToParent({
    message: "不应出站",
    requires_response: false,
  });
  assert.equal(lateReply.ok, false);
  if (!lateReply.ok) assert.equal(lateReply.error.code, "message_delivery_failed");
  assert.deepEqual(replies, [finalEnvelope("已完成")]);
});

test("工作中回复可以携带经 codec 校验的图片", async () => {
  const port = new RecordingPort();
  const value = coordinator(port);
  value.observeAgentStart();
  const progress = value.replyToParent({
    message: "附带截图的进度",
    requires_response: false,
    images: [{ type: "image", data: "YWJj", mimeType: "image/png" }],
  });
  await nextTask();
  assert.deepEqual(port.replies[0], {
    ...messageEnvelope("附带截图的进度", false),
    images: [{ type: "image", data: "YWJj", mimeType: "image/png" }],
  });
  port.acknowledgeAll();
  assert.deepEqual(await progress, { ok: true, data: { accepted: true } });
});

test("每次 agent_start 生成新轮次且不会覆盖上一轮 final", async () => {
  const port = new RecordingPort();
  const value = coordinator(port);
  value.observeAgentStart();
  value.observeAssistantMessageEnd({
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "第一轮" }] },
  });
  const first = value.settle();
  await nextTask();
  port.acknowledgeAll();
  await first;

  value.observeAgentStart();
  assert.equal(value.getCurrentTurnId(), TURN_2);
  value.observeAssistantMessageEnd({
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "第二轮" }] },
  });
  const second = value.settle();
  await nextTask();
  assert.equal(port.replies[0]?.turn_id, TURN_1);
  assert.equal(port.replies[1]?.turn_id, TURN_2);
  port.acknowledgeAll();
  await second;
});

test("轮次分配拒绝 UUID v1，重试重复值，并在耗尽后废止旧轮次", async () => {
  const port = new RecordingPort();
  let invalidFailures = 0;
  const invalid = new ChildReplyCoordinator({
    agentId: AGENT_ID,
    port,
    turnIdFactory: () => UUID_V1,
    onFinalFailure: () => { invalidFailures += 1; },
  });
  assert.throws(() => invalid.observeAgentStart(), /invalid_child_turn_id/);
  assert.equal(invalid.getCurrentTurnId(), undefined);
  await nextTask();
  assert.equal(invalidFailures, 1);

  const retried = coordinator(port, [TURN_1, TURN_1, TURN_2]);
  retried.observeAgentStart();
  retried.observeAgentStart();
  assert.equal(retried.getCurrentTurnId(), TURN_2);

  const exhaustedPort = new RecordingPort();
  let exhaustedFailures = 0;
  const exhausted = new ChildReplyCoordinator({
    agentId: AGENT_ID,
    port: exhaustedPort,
    turnIdFactory: () => TURN_1,
    onFinalFailure: () => { exhaustedFailures += 1; },
  });
  exhausted.observeAgentStart();
  exhausted.observeAssistantMessageEnd({
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "第一轮" }] },
  });
  const first = exhausted.settle();
  await nextTask();
  exhaustedPort.acknowledgeAll();
  await first;

  assert.throws(() => exhausted.observeAgentStart(), /invalid_child_turn_id/);
  assert.equal(exhausted.getCurrentTurnId(), undefined);
  await nextTask();
  assert.equal(exhaustedFailures, 1);
  exhausted.observeAssistantMessageEnd({
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "不得出站的第二轮" }] },
  });
  await exhausted.settle();
  assert.equal(exhaustedPort.replies.length, 1);
  assert.equal(exhausted.getFinalCandidate(), undefined);
});

test("最终候选连接文本块并支持图片-only present", async () => {
  const port = new RecordingPort();
  const value = coordinator(port);
  value.observeAgentStart();
  value.observeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [
        { type: "text", text: "第一部分" },
        { type: "text", text: "第二部分" },
      ],
    },
  });
  value.observeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "image", data: "YWJj", mimeType: "image/png" }],
    },
  });
  const settled = value.settle();
  await nextTask();
  assert.deepEqual(port.replies, [finalEnvelope(undefined, {
    output_state: "present",
    reason_code: undefined,
    images: [{ type: "image", data: "YWJj", mimeType: "image/png" }],
  })]);
  port.acknowledgeAll();
  await settled;
});

test("最终候选图片必须通过统一 codec 边界", async () => {
  const port = new RecordingPort();
  const value = coordinator(port);
  value.observeAgentStart();
  value.observeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{
        type: "image",
        data: "YWJj",
        mimeType: `image/${"x".repeat(123)}`,
      }],
    },
  });

  const settled = value.settle();
  await nextTask();
  assert.deepEqual(port.replies, [finalEnvelope(undefined)]);
  port.acknowledgeAll();
  await settled;
});

test("provider error 保留上一安全候选并仅通过状态标记部分输出", async () => {
  const port = new RecordingPort();
  const value = coordinator(port);
  value.observeAgentStart();
  value.observeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "已完成的部分结论" }],
    },
  });
  value.observeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "error",
      errorMessage: "PROVIDER_SECRET_ERROR",
      content: [{ type: "text", text: "不得作为最终答复" }],
    },
  });

  const settled = value.settle();
  await nextTask();
  assert.deepEqual(port.replies, [finalEnvelope("已完成的部分结论", {
    run_state: "failed",
    reason_code: "provider_error",
  })]);
  assert.doesNotMatch(JSON.stringify(port.replies), /PROVIDER_SECRET_ERROR|不得作为最终答复|继续沟通/);
  port.acknowledgeAll();
  await settled;
});

test("协作式中断保留安全候选且不生成说明性业务正文", async () => {
  const port = new RecordingPort();
  const value = coordinator(port);
  value.observeAgentStart();
  value.observeAssistantMessageEnd({
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "中断前内容" }] },
  });
  value.observeAssistantMessageEnd({
    type: "message_end",
    message: { role: "assistant", stopReason: "aborted", content: [] },
  });
  const settled = value.settle();
  await nextTask();
  assert.deepEqual(port.replies, [finalEnvelope("中断前内容", {
    run_state: "interrupted",
    reason_code: undefined,
  })]);
  port.acknowledgeAll();
  await settled;
});

test("正常无输出与运行时故障均发送无正文结构化 final", async () => {
  const normalPort = new RecordingPort();
  const normal = coordinator(normalPort);
  normal.observeAgentStart();
  const normalSettle = normal.settle();
  await nextTask();
  assert.deepEqual(normalPort.replies, [finalEnvelope(undefined)]);
  normalPort.acknowledgeAll();
  await normalSettle;

  const failedPort = new RecordingPort();
  const failed = coordinator(failedPort);
  failed.observeAgentStart();
  failed.observeAssistantMessageEnd({ type: "message_end", message: null });
  const failedSettle = failed.settle();
  await nextTask();
  assert.deepEqual(failedPort.replies, [finalEnvelope(undefined, {
    run_state: "failed",
    reason_code: "runtime_fault",
  })]);
  failedPort.acknowledgeAll();
  await failedSettle;
});

test("requires_response 必须显式提供，final 确认失败只通知一次", async () => {
  const port = new RecordingPort();
  const value = coordinator(port);
  value.observeAgentStart();
  const invalid = await value.replyToParent({ message: "缺少布尔值" });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.error.code, "invalid_argument");

  const rejectingPort = new RejectingPort();
  let failures = 0;
  const rejecting = new ChildReplyCoordinator({
    agentId: AGENT_ID,
    port: rejectingPort,
    turnIdFactory: () => TURN_1,
    onFinalFailure: () => { failures += 1; },
  });
  rejecting.observeAgentStart();
  await assert.rejects(rejecting.settle(), /子代理最终回复未获父会话确认/);
  await rejecting.settle();
  await nextTask();
  assert.equal(rejectingPort.calls, 1);
  assert.equal(failures, 1);
});

test("final 失败先向 handler 返回 rejection，再发出独立监督流关闭信号", async () => {
  const order: string[] = [];
  const value = new ChildReplyCoordinator({
    agentId: AGENT_ID,
    port: new RejectingPort(),
    turnIdFactory: () => TURN_1,
    onFinalFailure: () => { order.push("close"); },
  });
  value.observeAgentStart();

  const settlement = value.settle().catch((error: unknown) => {
    order.push("rejection");
    throw error;
  });
  await assert.rejects(settlement, /子代理最终回复未获父会话确认/);
  await nextTask();
  assert.deepEqual(order, ["rejection", "close"]);
});

test("final 失败后协调器永久废止轮次且不能签发下一轮", async () => {
  const port = new RejectingPort();
  let turnIndex = 0;
  let failures = 0;
  const value = new ChildReplyCoordinator({
    agentId: AGENT_ID,
    port,
    turnIdFactory: () => [TURN_1, TURN_2][turnIndex++]!,
    onFinalFailure: () => { failures += 1; },
  });
  value.observeAgentStart();
  await assert.rejects(value.settle(), /子代理最终回复未获父会话确认/);

  assert.throws(() => value.observeAgentStart());
  assert.equal(value.getCurrentTurnId(), undefined);
  await nextTask();
  assert.equal(failures, 1);
  assert.equal(port.calls, 1);
});

const RENDER_THEME = Object.freeze({
  fg: (_color: string, text: string): string => text,
  bg: (_color: string, text: string): string => text,
  bold: (text: string): string => text,
});

test("父端 inbox 注入模型可见 JSON、图片和完整唤醒矩阵", () => {
  const sent: Array<{ message: unknown; options: unknown }> = [];
  const notified: string[] = [];
  const imageData = "YWJj";
  const inbox = new ParentReplyInbox({
    readApi: () => ({ sendMessage: (message, options) => sent.push({ message, options }) }),
    notifyMessage: (agentId) => notified.push(agentId),
  });
  const informational = messageEnvelope("只记录", false);
  const question = messageEnvelope("需要回答", true);
  const final = finalEnvelope(undefined);
  const imageFinal = finalEnvelope(undefined, {
    output_state: "present",
    reason_code: undefined,
    images: [{ type: "image", data: imageData, mimeType: "image/png" }],
  });
  assert.equal(inbox.accept(AGENT_ID, informational), true);
  assert.equal(inbox.accept(AGENT_ID, question), true);
  assert.equal(inbox.accept(AGENT_ID, final), true);
  assert.equal(inbox.accept(AGENT_ID, imageFinal), true);
  assert.equal(inbox.accept(OTHER_AGENT_ID, informational), false);
  assert.equal(inbox.acceptTerminal(AGENT_ID, TURN_1), true);

  assert.deepEqual(sent.map((entry) => entry.options), [
    { triggerTurn: false, deliverAs: "steer" },
    { triggerTurn: true, deliverAs: "steer" },
    { triggerTurn: true, deliverAs: "steer" },
    { triggerTurn: true, deliverAs: "steer" },
    { triggerTurn: true, deliverAs: "steer" },
  ]);
  assert.deepEqual(notified, [AGENT_ID, AGENT_ID]);
  const firstText = (sent[0]!.message as { content: Array<{ text: string }> }).content[0]!.text;
  assert.deepEqual(JSON.parse(firstText), informational);
  const imageContent = (sent[3]!.message as { content: unknown[] }).content;
  assert.equal(imageContent.length, 2);
  const terminal = JSON.parse(
    (sent[4]!.message as { content: Array<{ text: string }> }).content[0]!.text,
  ) as TerminalNotice;
  assert.deepEqual(terminal, {
    schema: CHILD_TERMINAL_SCHEMA,
    version: CHILD_REPLY_VERSION,
    kind: "terminal",
    agent_id: AGENT_ID,
    turn_id: TURN_1,
    node_state: "failed",
    reason_code: "runtime_fault",
  });
});

test("settling gate 暂缓 final、需响应消息和 TerminalNotice，但不阻塞纯记录消息", () => {
  const sent: Array<{ message: unknown; options: unknown }> = [];
  const inbox = new ParentReplyInbox({
    readApi: () => ({ sendMessage: (message, options) => sent.push({ message, options }) }),
    notifyMessage: () => {},
  });
  inbox.blockTurnTriggers();
  inbox.blockTurnTriggers();

  assert.equal(inbox.accept(AGENT_ID, messageEnvelope("只记录", false)), true);
  assert.equal(inbox.accept(AGENT_ID, messageEnvelope("需要回答", true)), false);
  assert.equal(inbox.accept(AGENT_ID, finalEnvelope("阶段结果")), false);
  assert.equal(inbox.acceptTerminal(AGENT_ID, TURN_1), false);
  assert.equal(sent.length, 1);

  assert.equal(inbox.releaseTurnTriggers(), true);
  assert.equal(inbox.releaseTurnTriggers(), false);
  assert.equal(inbox.accept(AGENT_ID, messageEnvelope("需要回答", true)), true);
  assert.equal(inbox.accept(AGENT_ID, finalEnvelope("阶段结果")), true);
  assert.equal(inbox.acceptTerminal(AGENT_ID, TURN_1), true);
  assert.deepEqual(sent.slice(1).map((entry) => entry.options), [
    { triggerTurn: true, deliverAs: "steer" },
    { triggerTurn: true, deliverAs: "steer" },
    { triggerTurn: true, deliverAs: "steer" },
  ]);
});

test("旧轮延迟放行不能解除新轮 settling gate", () => {
  const sent: unknown[] = [];
  const inbox = new ParentReplyInbox({
    readApi: () => ({ sendMessage: (message) => sent.push(message) }),
    notifyMessage: () => {},
  });

  const oldGeneration = inbox.blockTurnTriggers();
  assert.equal(inbox.releaseTurnTriggers(), true);
  const currentGeneration = inbox.blockTurnTriggers();
  assert.notEqual(currentGeneration, oldGeneration);
  assert.equal(inbox.releaseTurnTriggers(oldGeneration), false);
  assert.equal(inbox.accept(AGENT_ID, finalEnvelope("新轮收尾期间不得投递")), false);
  assert.equal(inbox.releaseTurnTriggers(currentGeneration), true);
  assert.equal(inbox.accept(AGENT_ID, finalEnvelope("新轮已放行")), true);
  assert.equal(sent.length, 1);
});

test("final 失败后 settling gate 不可由后续 agent_start 重新放行", () => {
  const sent: unknown[] = [];
  const inbox = new ParentReplyInbox({
    readApi: () => ({ sendMessage: (message) => sent.push(message) }),
    notifyMessage: () => {},
  });
  inbox.blockTurnTriggers();
  inbox.failTurnTriggers();
  assert.equal(inbox.releaseTurnTriggers(), false);
  assert.equal(inbox.accept(AGENT_ID, finalEnvelope("不得投递")), false);
  assert.equal(inbox.accept(AGENT_ID, messageEnvelope("不得唤醒", true)), false);
  assert.equal(inbox.acceptTerminal(AGENT_ID), false);
  assert.deepEqual(sent, []);
});

test("父回复 renderer 隐藏原始 JSON 与协议字段并展示发送者、状态和正文", () => {
  const sent: Array<{ message: unknown; options: unknown }> = [];
  const inbox = new ParentReplyInbox({
    readApi: () => ({ sendMessage: (message, options) => sent.push({ message, options }) }),
    notifyMessage: () => {},
    readSenderName: (candidate) => candidate === AGENT_ID ? "鉴权调查" : undefined,
  });
  assert.equal(inbox.accept(AGENT_ID, messageEnvelope("正在核对第二个实现分支。")), true);
  assert.equal(inbox.accept(AGENT_ID, finalEnvelope(undefined)), true);
  assert.equal(inbox.acceptTerminal(AGENT_ID), true);

  const renderers = new Map<string, ParentReplyMessageRenderer>();
  registerParentReplyMessageRenderers({
    registerMessageRenderer: (type, renderer) => { renderers.set(type, renderer); },
  });
  assert.deepEqual([...renderers.keys()], [
    "pi-subagent-message",
    "pi-subagent-final",
    "pi-subagent-terminal",
  ]);
  for (const [index, type] of [...renderers.keys()].entries()) {
    const message = sent[index]!.message as Record<string, unknown>;
    const lines = renderers.get(type)!(message, { expanded: true, outputPad: 0 }, RENDER_THEME).render(120);
    const rendered = lines.join("\n");
    assert.match(rendered, new RegExp(`Sender: 鉴权调查 · ${AGENT_ID}`));
    assert.match(rendered, /Status:/);
    assert.match(rendered, /Payload:/);
    assert.doesNotMatch(rendered, /pi-subagent\.reply|pi-subagent\.terminal|turn_id|schema|550e8400-e29b-41d4-a716-446655440001/);
    assert.ok(lines.every((line) => displayWidth(line) <= 120));
  }
  const terminalText = (sent[2]!.message as { content: Array<{ text: string }> }).content[0]!.text;
  assert.equal("turn_id" in (JSON.parse(terminalText) as Record<string, unknown>), false);
  const finalRendered = renderers.get("pi-subagent-final")!(
    sent[1]!.message,
    { expanded: true, outputPad: 0 },
    RENDER_THEME,
  ).render(120).join("\n");
  assert.match(finalRendered, /settled \/ absent \/ no_output/);
  assert.match(finalRendered, /无可用业务输出/);
});

test("renderer 清理不可信名称和无效结构化正文并保持宽度", () => {
  const renderers = new Map<string, ParentReplyMessageRenderer>();
  registerParentReplyMessageRenderers({
    registerMessageRenderer: (type, renderer) => { renderers.set(type, renderer); },
  });
  const valid = messageEnvelope("第一行\n第二行");
  const lines = renderers.get("pi-subagent-message")!({
    customType: "pi-subagent-message",
    content: [{ type: "text", text: createVisibleEnvelope(valid) }],
    details: { agent_id: AGENT_ID, kind: "message", sender_name: "鉴权\n调查" },
  }, { expanded: false, outputPad: 0 }, RENDER_THEME).render(120);
  assert.match(lines.join("\n"), new RegExp(`Sender: 鉴权 调查 · ${AGENT_ID}`));
  assert.ok(lines.some((line) => line.includes("第一行")));
  assert.ok(lines.some((line) => line.includes("第二行")));

  const malformed = renderers.get("pi-subagent-message")!({
    customType: "pi-subagent-message",
    content: [{ type: "text", text: "{\"schema\":\"\u001b[31m危险\u202e\"}" }],
    details: { agent_id: AGENT_ID, kind: "message", sender_name: "过期名称" },
  }, { expanded: true, outputPad: 0 }, RENDER_THEME);
  const malformedDisplay = malformed.render(24).join("\n");
  assert.match(malformedDisplay, /无法解析结构化回复/);
  assert.doesNotMatch(malformedDisplay, /\u001b|\u202e/);
  assert.ok(malformed.render(24).every((line) => displayWidth(line) <= 24));
});

test("父回复 renderer 使用整行背景和分类颜色", () => {
  const foregrounds: string[] = [];
  const backgrounds: Array<{ color: string; text: string }> = [];
  const theme = {
    fg: (color: string, text: string): string => {
      foregrounds.push(color);
      return text;
    },
    bg: (color: string, text: string): string => {
      backgrounds.push({ color, text });
      return text;
    },
    bold: (text: string): string => text,
  };
  const renderers = new Map<string, ParentReplyMessageRenderer>();
  registerParentReplyMessageRenderers({
    registerMessageRenderer: (type, renderer) => { renderers.set(type, renderer); },
  });
  const message = {
    customType: "pi-subagent-message",
    content: [{ type: "text", text: createVisibleEnvelope(messageEnvelope("工作中发现")) }],
    details: { agent_id: AGENT_ID, kind: "message" },
  };
  const messageLines = renderers.get("pi-subagent-message")!(
    message,
    { expanded: true, outputPad: 1 },
    theme,
  ).render(40);
  assert.ok(foregrounds.includes("customMessageLabel"));
  assert.ok(foregrounds.includes("customMessageText"));
  assert.ok(backgrounds.length > 0);
  assert.ok(backgrounds.every((entry) =>
    entry.color === "customMessageBg" && displayWidth(entry.text) === 40));
  assert.equal(messageLines.length >= 5, true);

  foregrounds.length = 0;
  backgrounds.length = 0;
  const final = {
    customType: "pi-subagent-final",
    content: [{ type: "text", text: createVisibleEnvelope(finalEnvelope("最终结果")) }],
    details: { agent_id: AGENT_ID, kind: "final" },
  };
  renderers.get("pi-subagent-final")!(final, { expanded: true, outputPad: 1 }, theme).render(40);
  assert.ok(foregrounds.includes("success"));
  assert.ok(foregrounds.includes("customMessageText"));
  assert.ok(backgrounds.every((entry) =>
    entry.color === "customMessageBg" && displayWidth(entry.text) === 40));
});
