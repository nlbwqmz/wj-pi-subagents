import assert from "node:assert/strict";
import test from "node:test";
import {
  ChildReplyCoordinator,
  type ChildReplyPort,
} from "../src/child-reply-coordinator.ts";
import { displayWidth } from "../src/agent-tree-ui.ts";
import { SUPERVISOR_CHANNEL_LIMITS } from "../src/supervisor-channel.ts";
import {
  ParentReplyInbox,
  createVisibleEnvelope,
  registerParentReplyMessageRenderers,
  type ParentReplyMessageRenderer,
} from "../src/parent-reply-inbox.ts";

class RecordingPort implements ChildReplyPort {
  readonly replies: Array<Record<string, unknown>> = [];
  private pending: Array<() => void> = [];

  publishReplyAndWaitForAck(reply: Record<string, unknown>): Promise<void> {
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

test("过程 assistant 输出只缓存最终候选，显式回复和 settled final 分类有序", async () => {
  const port = new RecordingPort();
  const coordinator = new ChildReplyCoordinator({ port });
  coordinator.observeAgentStart();
  coordinator.observeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "toolUse",
      content: [{ type: "text", text: "我先检查文件" }, { type: "toolCall", id: "1", name: "read" }],
    },
  });
  const progress = coordinator.replyToParent({ message: "正在读取文件，完成后继续。" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(port.replies, [{ kind: "message", text: "正在读取文件，完成后继续。" }]);
  port.acknowledgeAll();
  assert.deepEqual(await progress, { ok: true, data: { accepted: true } });

  coordinator.observeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "最终结果" }],
    },
  });
  const settled = coordinator.settle();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(port.replies[1], { kind: "final", text: "最终结果" });
  port.acknowledgeAll();
  await settled;
  await coordinator.settle();
  assert.equal(port.replies.length, 2);
});

test("同一最终消息的多个文本块以换行连接", async () => {
  const port = new RecordingPort();
  const coordinator = new ChildReplyCoordinator({ port });
  coordinator.observeAgentStart();
  coordinator.observeAssistantMessageEnd({
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

  const settled = coordinator.settle();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(port.replies, [{ kind: "final", text: "第一部分\n第二部分" }]);
  port.acknowledgeAll();
  await settled;
});

test("后续工具调用和空 assistant 消息不清除本轮已有安全候选", async () => {
  const port = new RecordingPort();
  const coordinator = new ChildReplyCoordinator({ port });
  coordinator.observeAgentStart();
  coordinator.observeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "已整理出的可用结果" }],
    },
  });
  coordinator.observeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "toolUse",
      content: [
        { type: "text", text: "我再检查一次" },
        { type: "toolCall", id: "1", name: "read", arguments: {} },
      ],
    },
  });
  coordinator.observeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "   " }],
    },
  });

  const settled = coordinator.settle();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(port.replies, [{ kind: "final", text: "已整理出的可用结果" }]);
  port.acknowledgeAll();
  await settled;
});

test("最后一轮出错时把已有候选标为保留内容并提示继续沟通", async () => {
  const port = new RecordingPort();
  const coordinator = new ChildReplyCoordinator({ port });
  coordinator.observeAgentStart();
  coordinator.observeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "已完成的部分结论" }],
    },
  });
  coordinator.observeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "error",
      errorMessage: "PROVIDER_SECRET_ERROR",
      content: [{ type: "text", text: "不得作为最终答复" }],
    },
  });

  const settled = coordinator.settle();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(port.replies, [{
    kind: "final",
    text: "子代理本轮未能正常完成，以下为已保留的部分内容。如有必要，可以尝试继续与该子代理沟通。\n\n已完成的部分结论",
  }]);
  assert.doesNotMatch(JSON.stringify(port.replies), /PROVIDER_SECRET_ERROR|不得作为最终答复/);
  port.acknowledgeAll();
  await settled;
});

test("失败提示超出 reply 边界时省略过长部分内容", async () => {
  const port = new RecordingPort();
  const coordinator = new ChildReplyCoordinator({ port });
  coordinator.observeAgentStart();
  coordinator.observeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "x".repeat(SUPERVISOR_CHANNEL_LIMITS.maxStringBytes) }],
    },
  });
  coordinator.observeAssistantMessageEnd({
    type: "message_end",
    message: { role: "assistant", stopReason: "error", content: [] },
  });

  const settled = coordinator.settle();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(port.replies, [{
    kind: "final",
    text: "子代理本轮未能正常完成，以下为已保留的部分内容。如有必要，可以尝试继续与该子代理沟通。",
  }]);
  port.acknowledgeAll();
  await settled;
});

test("错误后续恢复为正常回答时使用恢复后的新结果", async () => {
  const port = new RecordingPort();
  const coordinator = new ChildReplyCoordinator({ port });
  coordinator.observeAgentStart();
  coordinator.observeAssistantMessageEnd({
    type: "message_end",
    message: { role: "assistant", stopReason: "error", content: [] },
  });
  coordinator.observeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "恢复后的结果" }],
    },
  });

  const settled = coordinator.settle();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(port.replies, [{ kind: "final", text: "恢复后的结果" }]);
  port.acknowledgeAll();
  await settled;
});

test("最后一轮被中断时发送简短提示且不复用旧候选", async () => {
  const port = new RecordingPort();
  const coordinator = new ChildReplyCoordinator({ port });
  coordinator.observeAgentStart();
  coordinator.observeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "中断前内容" }],
    },
  });
  coordinator.observeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "aborted",
      content: [],
    },
  });

  const settled = coordinator.settle();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(port.replies, [{
    kind: "final",
    text: "子代理本轮处理已中断。如有必要，可以尝试继续与该子代理沟通。",
  }]);
  port.acknowledgeAll();
  await settled;
});

test("没有安全最终候选时发送说明性 final，确认失败只通知运行时一次", async () => {
  const port = new RecordingPort();
  const coordinator = new ChildReplyCoordinator({ port });
  coordinator.observeAgentStart();
  coordinator.observeAssistantMessageEnd({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "toolUse",
      content: [
        { type: "thinking", thinking: "不得上行" },
        { type: "text", text: "工具前说明不得成为 final" },
        { type: "toolCall", id: "1", name: "read", arguments: {} },
      ],
    },
  });
  const settled = coordinator.settle();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(port.replies, [{
    kind: "final",
    text: "子代理本轮已结束，但未产生可用的最终答复。若仍需结果，请在该子代理进入 idle 后，使用 send_message 向同一 agent_id 追问一次：“请仅总结上一轮已完成的工作并给出最终答复，不要重新执行任务；若没有可用结果，请说明原因。”若再次没有最终答复，请停止追问并报告无可用结果。",
  }]);
  port.acknowledgeAll();
  await settled;

  const rejectingPort = new RejectingPort();
  let failures = 0;
  const rejecting = new ChildReplyCoordinator({
    port: rejectingPort,
    onFinalFailure: () => { failures += 1; },
  });
  rejecting.observeAgentStart();
  await assert.rejects(rejecting.settle(), /子代理最终回复未获父会话确认/);
  await rejecting.settle();
  assert.equal(rejectingPort.calls, 1);
  assert.equal(failures, 1);
});

const RENDER_THEME = Object.freeze({
  fg: (_color: string, text: string): string => text,
  bg: (_color: string, text: string): string => text,
  bold: (text: string): string => text,
});

test("父回复 renderer 只在安全名称元数据存在时增强 Sender 行", () => {
  const sent: Array<{ message: unknown; options: unknown }> = [];
  const agentId = "550e8400-e29b-41d4-a716-446655440000";
  const imageData = "BASE64_REPLY_CANARY";
  const inbox = new ParentReplyInbox({
    readApi: () => ({ sendMessage: (message, options) => sent.push({ message, options }) }),
    notifyMessage: () => {},
    readSenderName: (candidate) => candidate === agentId ? "鉴权调查" : undefined,
  });
  assert.equal(inbox.accept(agentId, {
    kind: "message",
    text: "正在核对第二个实现分支。",
    images: [{ type: "image", data: imageData, mimeType: "image/png" }],
  }), true);
  assert.equal(inbox.accept(agentId, { kind: "final", text: "最终答复" }), true);
  assert.deepEqual((sent[0]!.message as { details: unknown }).details, {
    agent_id: agentId,
    kind: "message",
    sender_name: "鉴权调查",
  });
  assert.equal(
    (sent[0]!.message as { content: Array<{ text: string }> }).content[0]!.text,
    createVisibleEnvelope(agentId, "message", "正在核对第二个实现分支。"),
  );

  const renderers = new Map<string, ParentReplyMessageRenderer>();
  registerParentReplyMessageRenderers({
    registerMessageRenderer: (type, renderer) => { renderers.set(type, renderer); },
  });
  assert.deepEqual([...renderers.keys()], ["pi-subagent-message", "pi-subagent-final"]);
  for (const [index, type] of ["pi-subagent-message", "pi-subagent-final"].entries()) {
    const message = sent[index]!.message as Record<string, unknown>;
    const component = renderers.get(type)!(message, { expanded: true, outputPad: 0 }, RENDER_THEME);
    const lines = component.render(120);
    assert.match(lines.join("\n"), /Message Type: (AGENT_MESSAGE|FINAL_ANSWER)/);
    assert.match(lines.join("\n"), new RegExp(`Sender: 鉴权调查 · ${agentId}`));
    assert.match(lines.join("\n"), /Payload:/);
    assert.doesNotMatch(lines.join("\n"), new RegExp(imageData));
    assert.ok(lines.every((line) => displayWidth(line) <= 120));
  }

  const unknownMessage = {
    customType: "pi-subagent-message",
    content: [{ type: "text", text: createVisibleEnvelope(
      "650e8400-e29b-41d4-a716-446655440000",
      "message",
      "未知发送者",
    ) }],
    details: { agent_id: "650e8400-e29b-41d4-a716-446655440000", kind: "message" },
  };
  const fallback = renderers.get("pi-subagent-message")!(unknownMessage, { expanded: false, outputPad: 0 }, RENDER_THEME);
  assert.match(fallback.render(80).join("\n"), /Sender: 650e8400-e29b-41d4-a716-446655440000/);
  assert.doesNotMatch(fallback.render(80).join("\n"), /Sender: .*·/);

  const lineBreakingName = renderers.get("pi-subagent-message")!({
    customType: "pi-subagent-message",
    content: [{ type: "text", text: createVisibleEnvelope(agentId, "message", "第一行\n第二行") }],
    details: { agent_id: agentId, kind: "message", sender_name: "鉴权\n调查" },
  }, { expanded: false, outputPad: 0 }, RENDER_THEME).render(120);
  assert.equal(lineBreakingName.filter((line) => line.startsWith("Sender:")).length, 1);
  assert.match(lineBreakingName.join("\n"), new RegExp(`Sender: 鉴权 调查 · ${agentId}`));
  assert.ok(lineBreakingName.some((line) => line.includes("第一行")));
  assert.ok(lineBreakingName.some((line) => line.includes("第二行")));

  const malformed = renderers.get("pi-subagent-message")!({
    customType: "pi-subagent-message",
    content: [{ type: "text", text: "Message Type: AGENT_MESSAGE\nSender: 550e8400-e29b-41d4-a716-446655440000\nPayload:\n\u001b[31m危险\u202e" }],
    details: { agent_id: agentId, kind: "message", sender_name: "过期名称" },
  }, { expanded: true, outputPad: 0 }, RENDER_THEME);
  const malformedDisplay = malformed.render(24).join("\n");
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
    content: [{ type: "text", text: createVisibleEnvelope(
      "550e8400-e29b-41d4-a716-446655440000",
      "message",
      "工作中发现",
    ) }],
    details: {
      agent_id: "550e8400-e29b-41d4-a716-446655440000",
      kind: "message",
    },
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
    ...message,
    customType: "pi-subagent-final",
    content: [{ type: "text", text: createVisibleEnvelope(
      "550e8400-e29b-41d4-a716-446655440000",
      "final",
      "最终结果",
    ) }],
    details: {
      agent_id: "550e8400-e29b-41d4-a716-446655440000",
      kind: "final",
    },
  };
  renderers.get("pi-subagent-final")!(final, { expanded: true, outputPad: 1 }, theme).render(40);
  assert.ok(foregrounds.includes("success"));
  assert.ok(foregrounds.includes("customMessageText"));
  assert.ok(backgrounds.every((entry) =>
    entry.color === "customMessageBg" && displayWidth(entry.text) === 40));
});

test("父端 inbox 拒绝空 final，名称解析失败时仍保留 UUID", () => {
  const sent: Array<{ message: unknown; options: unknown }> = [];
  const agentId = "750e8400-e29b-41d4-a716-446655440000";
  const inbox = new ParentReplyInbox({
    readApi: () => ({ sendMessage: (message, options) => sent.push({ message, options }) }),
    notifyMessage: () => {},
    readSenderName: () => undefined,
  });
  assert.equal(inbox.accept(agentId, { kind: "final", text: "" }), false);
  assert.equal(inbox.accept(agentId, { kind: "message", text: "\u001b[31m阶段" }), true);
  assert.equal(sent.length, 1);
  const text = (sent[0]!.message as { content: Array<{ text: string }> }).content[0]!.text;
  assert.equal(text, createVisibleEnvelope(agentId, "message", "\u001b[31m阶段"));
  assert.deepEqual((sent[0]!.message as { details: unknown }).details, {
    agent_id: agentId,
    kind: "message",
  });
});

test("父端 inbox 把类别写入模型可见信封，并只让工作中消息唤醒 wait", () => {
  const sent: Array<{ message: unknown; options: unknown }> = [];
  const notified: string[] = [];
  const inbox = new ParentReplyInbox({
    readApi: () => ({ sendMessage: (message, options) => sent.push({ message, options }) }),
    notifyMessage: (agentId) => notified.push(agentId),
  });
  const agentId = "550e8400-e29b-41d4-a716-446655440000";
  assert.equal(inbox.accept(agentId, { kind: "message", text: "阶段发现" }), true);
  assert.equal(inbox.accept(agentId, { kind: "final", text: "完整结果" }), true);
  assert.equal(inbox.accept(agentId, { kind: "final", text: "" }), false);
  assert.equal(inbox.accept(agentId, {
    kind: "final",
    text: "",
    images: [{ type: "image", data: "YWJj", mimeType: "image/png" }],
  }), true);
  assert.equal(sent.length, 3);
  assert.equal((sent[0]!.message as { content: Array<{ text: string }> }).content[0]!.text,
    createVisibleEnvelope(agentId, "message", "阶段发现"));
  assert.deepEqual(sent.map((entry) => entry.options), [
    { triggerTurn: false, deliverAs: "steer" },
    { triggerTurn: true, deliverAs: "steer" },
    { triggerTurn: true, deliverAs: "steer" },
  ]);
  assert.deepEqual(notified, [agentId]);
});
