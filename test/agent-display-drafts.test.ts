import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  AgentDisplayDraftRegistry,
  MAX_DISPLAY_DRAFT_FUTURE_FRAMES,
  type AgentDisplayDraftView,
} from "../src/agent-display-drafts.ts";
import {
  parseAgentActivityDisplayEvent,
  type AgentDisplayStreamUpdate,
  type SafeAgentActivityDisplayEvent,
} from "../src/rpc-bridge-event.ts";
import { OwnDisplayStreamTracker } from "../src/wj-pi-subagents-runtime.ts";
import {
  AgentActivityViewerModel,
  renderAgentActivityViewerSurface,
} from "../src/agent-activity-viewer.ts";
import {
  StreamSupervisorChannel,
  type SupervisorByteTransport,
} from "../src/stream-supervisor-channel.ts";
import type { SupervisorDisplayDelivery } from "../src/supervisor-channel.ts";
import {
  SUPERVISOR_FRAME_KINDS,
  SUPERVISOR_PROTOCOL_VERSION,
  SupervisorRequestIdRegistry,
} from "../src/supervisor-channel.ts";

const AGENT_ID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_AGENT_ID = "660e8400-e29b-41d4-a716-446655440001";
const INCARNATION_ID = "7f9c24e8-5b3d-4f6a-8c1e-9d2b7a4f6e81";
const RESTARTED_INCARNATION_ID = "8a0d35f9-6c4e-5a7b-9d2f-8e3c8b5a7f92";
const DISPLAY_EPOCH = "128c3f70-2d40-4e21-a8b4-1c9d8e7f6a50";
const RESTARTED_DISPLAY_EPOCH = "2d9e4f61-7c30-4a8b-b5d1-8e6f2c9a4b70";

function defaultStreamOrdinal(streamId: string): number {
  const match = /-(\d+)$/u.exec(streamId);
  const ordinal = match === null ? 1 : Number(match[1]);
  return Number.isSafeInteger(ordinal) && ordinal >= 1 ? ordinal : 1;
}

function defaultDisplayEpoch(displaySourceGeneration: number): string {
  return displaySourceGeneration === 1 ? DISPLAY_EPOCH : RESTARTED_DISPLAY_EPOCH;
}

function delta(
  streamId: string,
  sequence: number,
  contentIndex: number,
  contentType: "text" | "thinking",
  value: string,
  agentId: string = AGENT_ID,
  incarnationId: string = INCARNATION_ID,
  displaySourceGeneration: number = incarnationId === RESTARTED_INCARNATION_ID ? 2 : 1,
  streamOrdinal: number = defaultStreamOrdinal(streamId),
  displayEpoch: string = defaultDisplayEpoch(displaySourceGeneration),
): SafeAgentActivityDisplayEvent {
  return Object.freeze({
    type: "message_delta",
    streamId,
    sequence,
    contentIndex,
    contentType,
    delta: value,
    displayEpoch,
    displaySourceGeneration,
    streamOrdinal,
    agentId,
    incarnationId,
  });
}

function complete(
  streamId: string,
  sequence: number,
  agentId: string = AGENT_ID,
  incarnationId: string = INCARNATION_ID,
  displaySourceGeneration: number = incarnationId === RESTARTED_INCARNATION_ID ? 2 : 1,
  streamOrdinal: number = defaultStreamOrdinal(streamId),
  displayEpoch: string = defaultDisplayEpoch(displaySourceGeneration),
): SafeAgentActivityDisplayEvent {
  return Object.freeze({
    type: "message_complete",
    streamId,
    sequence,
    displayEpoch,
    displaySourceGeneration,
    streamOrdinal,
    agentId,
    incarnationId,
  });
}

function displayStreamRef(
  streamId: string,
  incarnationId: string = INCARNATION_ID,
  displaySourceGeneration: number = incarnationId === RESTARTED_INCARNATION_ID ? 2 : 1,
  streamOrdinal: number = defaultStreamOrdinal(streamId),
  displayEpoch: string = defaultDisplayEpoch(displaySourceGeneration),
) {
  return Object.freeze({
    streamId,
    displayEpoch,
    displaySourceGeneration,
    streamOrdinal,
  });
}

function textValues(views: readonly AgentDisplayDraftView[]): readonly string[] {
  return views[0]?.blocks.map((block) => block.value) ?? [];
}

test("序号 9 先于 8 到达时暂存，8 到达后按 8、9 连续显示", () => {
  const registry = new AgentDisplayDraftRegistry();
  let notificationCount = 0;
  registry.onChange(() => notificationCount += 1);
  // 先建立连续前缀 1..7；9 属于未来帧。
  for (let sequence = 1; sequence <= 7; sequence += 1) {
    assert.equal(registry.applyEvent(AGENT_ID, delta("message-1", sequence, 0, "text", "字")), true);
  }
  assert.equal(notificationCount, 7);
  assert.equal(registry.applyEvent(AGENT_ID, delta("message-1", 9, 0, "text", "九")), false);
  // 缺口未补齐前只显示连续前缀；9 已接纳但不改变快照，也不通知 UI。
  assert.deepEqual(
    textValues(registry.drafts(AGENT_ID)),
    ["字字字字字字字"],
  );
  assert.equal(notificationCount, 7);

  assert.equal(registry.applyEvent(AGENT_ID, delta("message-1", 8, 0, "text", "八")), true);
  assert.deepEqual(textValues(registry.drafts(AGENT_ID)), ["字字字字字字字八九"]);
  assert.equal(notificationCount, 8);
});

test("重复 future 幂等保留首帧，等价 delta 推进序号但不通知", () => {
  const registry = new AgentDisplayDraftRegistry();
  const snapshots: (readonly AgentDisplayDraftView[])[] = [];
  registry.onChange((agentId) => snapshots.push(registry.drafts(agentId)));

  assert.equal(registry.applyEvent(AGENT_ID, delta("message-1", 1, 0, "text", "一")), true);
  assert.equal(registry.applyEvent(AGENT_ID, delta("message-1", 3, 0, "text", "原始三")), false);
  // 相同 sequence 即使载荷不同也不覆盖先到帧。
  assert.equal(registry.applyEvent(AGENT_ID, delta("message-1", 3, 0, "text", "覆盖三")), false);
  assert.equal(snapshots.length, 1);
  assert.deepEqual(textValues(registry.drafts(AGENT_ID)), ["一"]);

  assert.equal(registry.applyEvent(AGENT_ID, delta("message-1", 2, 0, "text", "二")), true);
  assert.deepEqual(textValues(registry.drafts(AGENT_ID)), ["一二原始三"]);
  assert.equal(snapshots.length, 2);

  // 空 delta 已接纳并推进 sequence，但投影等价，所以不通知。
  assert.equal(registry.applyEvent(AGENT_ID, delta("message-1", 4, 0, "text", "")), false);
  assert.equal(snapshots.length, 2);
  assert.deepEqual(textValues(registry.drafts(AGENT_ID)), ["一二原始三"]);

  // future complete 本身不通知；等价 delta 补齐缺口时仍须通知 complete 状态变化。
  assert.equal(registry.applyEvent(AGENT_ID, complete("message-1", 6)), false);
  assert.equal(snapshots.length, 2);
  assert.equal(registry.applyEvent(AGENT_ID, delta("message-1", 5, 0, "text", "")), true);
  assert.equal(snapshots.length, 3);
  assert.equal(snapshots.at(-1)?.[0]?.state, "complete");
});

test("多个连续未来帧一次补齐并保持块序，无超时且先到高序号不清空前缀", () => {
  const registry = new AgentDisplayDraftRegistry();
  registry.applyEvent(AGENT_ID, delta("message-1", 1, 0, "thinking", "想一"));
  registry.applyEvent(AGENT_ID, delta("message-1", 2, 1, "text", "正"));
  // 未来帧跨越多个块与序号，全部按 sequence 暂存。
  registry.applyEvent(AGENT_ID, delta("message-1", 5, 2, "text", "尾"));
  registry.applyEvent(AGENT_ID, delta("message-1", 4, 1, "text", "文"));
  registry.applyEvent(AGENT_ID, delta("message-1", 3, 0, "thinking", "想二"));

  const view = registry.drafts(AGENT_ID)[0];
  assert.deepEqual(view?.blocks.map((block) => [block.contentIndex, block.value]), [
    [0, "想一想二"],
    [1, "正文"],
    [2, "尾"],
  ]);

  // 缺帧不设时间超时：状态保持等待，不因流逝而清空（无定时器参与）。
  assert.equal(view?.state, "streaming");
  // 重复与旧帧幂等忽略。
  assert.equal(registry.applyEvent(AGENT_ID, delta("message-1", 3, 0, "thinking", "想二")), false);
  assert.equal(registry.applyEvent(AGENT_ID, delta("message-1", 1, 0, "thinking", "想一")), false);
  assert.deepEqual(textValues(registry.drafts(AGENT_ID)), ["想一想二", "正文", "尾"]);
});

test("255/256/257 不同 future 边界：重复不冻结，第 257 个不同帧才冻结", () => {
  const registry = new AgentDisplayDraftRegistry();
  let notificationCount = 0;
  registry.onChange(() => notificationCount += 1);
  registry.applyEvent(AGENT_ID, delta("message-1", 1, 0, "text", "前缀"));
  // 帧 3..258 共 256 个不同 future：已接纳但投影不变，也不通知。
  for (let sequence = 3; sequence <= MAX_DISPLAY_DRAFT_FUTURE_FRAMES + 2; sequence += 1) {
    assert.equal(registry.applyEvent(AGENT_ID, delta("message-1", sequence, 0, "text", "x")), false);
  }
  assert.equal(registry.drafts(AGENT_ID)[0]?.state, "streaming");
  assert.equal(notificationCount, 1);

  // 满容量时重复已有 future 不覆盖、不冻结，也不通知。
  assert.equal(registry.applyEvent(AGENT_ID, delta("message-1", 258, 0, "text", "替换")), false);
  assert.equal(registry.drafts(AGENT_ID)[0]?.state, "streaming");
  assert.equal(notificationCount, 1);

  // 第 257 个不同 future：保留已验证前缀、丢弃 buffer、冻结并通知状态变化。
  assert.equal(registry.applyEvent(AGENT_ID, delta("message-1", 259, 0, "text", "y")), true);
  const frozen = registry.drafts(AGENT_ID)[0];
  assert.equal(frozen?.state, "frozen");
  assert.deepEqual(textValues(registry.drafts(AGENT_ID)), ["前缀"]);
  assert.equal(notificationCount, 2);
});

test("冻结后不继续应用 token，等待权威完整消息替换", () => {
  const registry = new AgentDisplayDraftRegistry();
  registry.applyEvent(AGENT_ID, delta("message-1", 1, 0, "text", "前缀"));
  for (let sequence = 3; sequence <= 259; sequence += 1) {
    registry.applyEvent(AGENT_ID, delta("message-1", sequence, 0, "text", "x"));
  }
  assert.equal(registry.drafts(AGENT_ID)[0]?.state, "frozen");

  // 冻结后任何 delta（包括缺失帧）与 complete 都被忽略。
  assert.equal(registry.applyEvent(AGENT_ID, delta("message-1", 2, 0, "text", "缺帧")), false);
  assert.equal(registry.applyEvent(AGENT_ID, complete("message-1", 260)), false);
  assert.deepEqual(textValues(registry.drafts(AGENT_ID)), ["前缀"]);

  // 权威完整消息携带可精确关联的身份：到达后原地替换并清除对应草稿。
  assert.equal(registry.replaceDraft(
    AGENT_ID,
    INCARNATION_ID,
    displayStreamRef("message-1"),
  ), true);
  assert.deepEqual(registry.drafts(AGENT_ID), []);
});

test("message_complete 只收束显示流：连续草稿在 complete 后继续显示", () => {
  const registry = new AgentDisplayDraftRegistry();
  registry.applyEvent(AGENT_ID, delta("message-1", 1, 0, "text", "草稿"));
  assert.equal(registry.applyEvent(AGENT_ID, complete("message-1", 2)), true);
  const view = registry.drafts(AGENT_ID)[0];
  assert.equal(view?.state, "complete");
  assert.deepEqual(textValues(registry.drafts(AGENT_ID)), ["草稿"]);

  // complete 后迟到的 delta 被忽略。
  assert.equal(registry.applyEvent(AGENT_ID, delta("message-1", 3, 0, "text", "迟到")), false);
  assert.deepEqual(textValues(registry.drafts(AGENT_ID)), ["草稿"]);
});

test("相邻 streaming thinking 实时合并，complete 后同一标题变为 Thinking", () => {
  const registry = new AgentDisplayDraftRegistry();
  registry.applyEvent(AGENT_ID, delta("message-1", 1, 0, "thinking", "第一段"));
  const viewer = new AgentActivityViewerModel({
    agent_id: AGENT_ID,
    template_id: "worker",
    name: "worker-a",
    state: "working",
  }, [], { drafts: registry.drafts(AGENT_ID), viewport_height: 20 });
  assert.equal(viewer.handleInput("\r"), "changed");
  const expandedKey = viewer.getSelectedKey();

  registry.applyEvent(AGENT_ID, delta("message-1", 2, 1, "thinking", "第二段"));
  const mergedDrafts = registry.drafts(AGENT_ID);
  assert.deepEqual(mergedDrafts[0]?.blocks, [{
    contentIndex: 0,
    contentType: "thinking",
    value: "第一段\n\n第二段",
  }]);
  viewer.setLiveDrafts(mergedDrafts);
  let body = viewer.render(160).slice(1, -1);
  assert.deepEqual(body.filter((line) => line.includes("Thinking")), ["▾ Thinking · streaming"]);
  assert.ok(body.includes("│ 第一段"), body.join("\n"));
  assert.ok(body.includes("│ 第二段"), body.join("\n"));
  assert.equal(viewer.getSelectedKey(), expandedKey);

  assert.equal(registry.applyEvent(AGENT_ID, complete("message-1", 3)), true);
  viewer.setLiveDrafts(registry.drafts(AGENT_ID));
  body = viewer.render(160).slice(1, -1);
  assert.deepEqual(body.filter((line) => line.includes("Thinking")), ["▾ Thinking"]);
  assert.doesNotMatch(body.join("\n"), /streaming/u);
  assert.ok(body.includes("│ 第一段") && body.includes("│ 第二段"), body.join("\n"));

  const separated = new AgentDisplayDraftRegistry();
  separated.applyEvent(AGENT_ID, delta("message-2", 1, 0, "thinking", "前"));
  separated.applyEvent(AGENT_ID, delta("message-2", 2, 1, "text", "中"));
  separated.applyEvent(AGENT_ID, delta("message-2", 3, 2, "thinking", "后"));
  assert.deepEqual(
    separated.drafts(AGENT_ID)[0]?.blocks.map((block) => block.contentType),
    ["thinking", "text", "thinking"],
  );
});

test("分块累积保持公开 delta 输出等价且连续 thinking 只插入既有分隔", () => {
  const registry = new AgentDisplayDraftRegistry();
  let sequence = 1;
  const textChunks = Array.from(
    { length: 2_048 },
    (_, index) => `chunk-${index.toString().padStart(4, "0")}|`,
  );
  for (const chunk of textChunks) {
    registry.applyEvent(AGENT_ID, delta("message-1", sequence, 0, "text", chunk));
    sequence += 1;
  }

  const thinkingBlocks = Array.from(
    { length: 64 },
    (_, index) => [`thought-${index}-`, "done"] as const,
  );
  for (const [index, chunks] of thinkingBlocks.entries()) {
    for (const chunk of chunks) {
      registry.applyEvent(AGENT_ID, delta("message-1", sequence, index + 1, "thinking", chunk));
      sequence += 1;
    }
  }

  assert.deepEqual(registry.drafts(AGENT_ID)[0]?.blocks, [
    {
      contentIndex: 0,
      contentType: "text",
      value: textChunks.join(""),
    },
    {
      contentIndex: 1,
      contentType: "thinking",
      value: thinkingBlocks.map((chunks) => chunks.join("")).join("\n\n"),
    },
  ]);
});

test("权威消息先到时封存对应 ordinal：后续该流迟到的 delta 与 complete 被忽略", () => {
  const registry = new AgentDisplayDraftRegistry();
  assert.equal(registry.replaceDraft(
    AGENT_ID,
    INCARNATION_ID,
    displayStreamRef("message-1"),
  ), false);
  assert.equal(registry.applyEvent(AGENT_ID, delta("message-1", 1, 0, "text", "旧流")), false);
  assert.equal(registry.applyEvent(AGENT_ID, complete("message-1", 2)), false);
  assert.deepEqual(registry.drafts(AGENT_ID), []);
});

test("较高 ordinal 的权威消息清除较低 provisional 草稿并封存整个前缀", () => {
  const registry = new AgentDisplayDraftRegistry();
  assert.equal(registry.applyEvent(
    AGENT_ID,
    delta("message-1", 1, 0, "text", "旧草稿", AGENT_ID, INCARNATION_ID, 1, 1),
  ), true);
  assert.equal(registry.replaceDraft(
    AGENT_ID,
    INCARNATION_ID,
    displayStreamRef("message-2", INCARNATION_ID, 1, 2),
  ), true);
  assert.deepEqual(registry.drafts(AGENT_ID), []);
  assert.equal(registry.applyEvent(
    AGENT_ID,
    delta("message-1", 2, 0, "text", "迟到旧流", AGENT_ID, INCARNATION_ID, 1, 1),
  ), false);
  assert.equal(registry.applyEvent(
    AGENT_ID,
    delta("message-2", 1, 0, "text", "权威后迟到", AGENT_ID, INCARNATION_ID, 1, 2),
  ), false);
  assert.equal(registry.applyEvent(
    AGENT_ID,
    delta("message-3", 1, 0, "text", "下一条", AGENT_ID, INCARNATION_ID, 1, 3),
  ), true);
  assert.deepEqual(textValues(registry.drafts(AGENT_ID)), ["下一条"]);
});

test("生命周期收束清除未替换草稿并阻断旧流复活；重启实例与复用 stream ID 不串流", () => {
  const registry = new AgentDisplayDraftRegistry();
  registry.applyEvent(AGENT_ID, delta("message-1", 1, 0, "text", "第一轮"));
  assert.equal(registry.settleAgent(AGENT_ID), true);
  assert.deepEqual(registry.drafts(AGENT_ID), []);

  // 重启实例产生新的运行实例身份：即使复用 stream ID 也关联不到旧草稿。
  registry.applyEvent(AGENT_ID, delta("message-1", 1, 0, "text", "重启后", AGENT_ID, RESTARTED_INCARNATION_ID));
  assert.deepEqual(textValues(registry.drafts(AGENT_ID)), ["重启后"]);
  // 旧实例的迟到帧不进入新实例的草稿。
  assert.equal(registry.applyEvent(AGENT_ID, delta("message-1", 2, 0, "text", "旧实例")), false);
  assert.deepEqual(textValues(registry.drafts(AGENT_ID)), ["重启后"]);

  // 不同代理的草稿按 agent_id 隔离。
  registry.applyEvent(OTHER_AGENT_ID, delta("message-1", 1, 0, "text", "其他代理", OTHER_AGENT_ID));
  assert.deepEqual(textValues(registry.drafts(OTHER_AGENT_ID)), ["其他代理"]);
  assert.deepEqual(textValues(registry.drafts(AGENT_ID)), ["重启后"]);
  assert.equal(registry.applyEvent(AGENT_ID, delta("message-1", 1, 0, "text", "串流")), false);
});

test("reload clear 关闭当前 source，旧帧不能复活且更高 generation 可见", () => {
  const registry = new AgentDisplayDraftRegistry();
  registry.applyEvent(AGENT_ID, delta("message-1", 1, 0, "text", "旧草稿"));
  assert.equal(registry.clear(), true);
  assert.deepEqual(registry.drafts(AGENT_ID), []);
  assert.equal(registry.applyEvent(AGENT_ID, delta("message-1", 2, 0, "text", "迟到旧帧")), false);
  assert.equal(registry.applyEvent(AGENT_ID, complete("message-1", 2)), false);

  // 新 activator 必须提高 source generation；同一 incarnation 可复用 stream ID。
  assert.equal(registry.applyEvent(
    AGENT_ID,
    delta("message-reload-1", 1, 0, "text", "新草稿", AGENT_ID, INCARNATION_ID, 2, 1),
  ), true);
  assert.deepEqual(textValues(registry.drafts(AGENT_ID)), ["新草稿"]);
});

test("有序 cursor 在大量流后只接受更高 ordinal，并拒绝封存的旧流", () => {
  const registry = new AgentDisplayDraftRegistry();
  for (let ordinal = 1; ordinal <= 1_000; ordinal += 1) {
    const streamId = `stream-${ordinal}`;
    assert.equal(registry.applyEvent(
      AGENT_ID,
      delta(streamId, 1, 0, "text", `draft-${ordinal}`, AGENT_ID, INCARNATION_ID, 1, ordinal),
    ), true);
  }
  assert.deepEqual(textValues(registry.drafts(AGENT_ID)), ["draft-1000"]);
  // 任意已被较高 ordinal 覆盖的 frame 都由 sealed cursor 拒绝，而非查找 tombstone。
  assert.equal(registry.applyEvent(
    AGENT_ID,
    delta("stream-1", 2, 0, "text", "迟到旧流", AGENT_ID, INCARNATION_ID, 1, 1),
  ), false);
  assert.deepEqual(textValues(registry.drafts(AGENT_ID)), ["draft-1000"]);

  assert.equal(registry.replaceDraft(
    AGENT_ID,
    INCARNATION_ID,
    displayStreamRef("stream-1000", INCARNATION_ID, 1, 1_000),
  ), true);
  assert.deepEqual(registry.drafts(AGENT_ID), []);
});
test("查看器关闭期间持续组装：重新打开立即显示当前连续前缀", () => {
  const registry = new AgentDisplayDraftRegistry();
  registry.applyEvent(AGENT_ID, delta("message-1", 1, 0, "text", "第一段 "));
  registry.applyEvent(AGENT_ID, delta("message-1", 2, 1, "thinking", "草稿思考"));

  // 关闭期间到达的未来帧在打开前补齐。
  registry.applyEvent(AGENT_ID, delta("message-1", 4, 1, "thinking", "补齐"));
  registry.applyEvent(AGENT_ID, delta("message-1", 3, 1, "thinking", "中段 "));

  const viewer = new AgentActivityViewerModel({
    agent_id: AGENT_ID,
    template_id: "worker",
    name: "worker-a",
    state: "working",
  }, [], { drafts: registry.drafts(AGENT_ID) });
  const lines = viewer.render(160);
  assert.match(lines.join("\n"), /第一段/u);
  // thinking 默认折叠：只显示流式标题，正文在展开后才可见。
  assert.match(lines.join("\n"), /Thinking · streaming/u);
  assert.doesNotMatch(lines.join("\n"), /草稿思考/u);
});

test("流式 text 按 Markdown 实时重渲染，不增加流式标签、角色标签或消息分隔线", () => {
  const registry = new AgentDisplayDraftRegistry();
  registry.applyEvent(AGENT_ID, delta("message-1", 1, 0, "text", "# 标题\n\n- 列"));
  registry.applyEvent(AGENT_ID, delta("message-1", 2, 0, "text", "表项"));
  const viewer = new AgentActivityViewerModel({
    agent_id: AGENT_ID,
    template_id: "worker",
    name: "worker-a",
    state: "working",
  }, [], { drafts: registry.drafts(AGENT_ID) });
  const lines = viewer.render(160).join("\n");
  // Markdown 结构渲染（标题不再带 #、列表项带项目符号），且没有流式/角色标签。
  assert.match(lines, /标题/u);
  assert.match(lines, /列表项/u);
  assert.doesNotMatch(lines, /# 标题/u);
  assert.doesNotMatch(lines, /Assistant|streaming tag|\u2500{4,}/u);
});

function readyChannelPair(): {
  readonly parent: StreamSupervisorChannel;
  readonly child: StreamSupervisorChannel;
  cleanup(): void;
} {
  const parentToChild = new PassThrough();
  const childToParent = new PassThrough();
  const transportForParent: SupervisorByteTransport = {
    stdin: parentToChild,
    stdout: childToParent,
  };
  const transportForChild: SupervisorByteTransport = {
    stdin: childToParent,
    stdout: parentToChild,
  };
  const requestIdRegistry = new SupervisorRequestIdRegistry();
  const snapshot = [{
    agent_id: AGENT_ID,
    parent_agent_id: null,
    template_id: "worker",
    name: "worker-a",
    depth: 1,
    state: "idle",
    revision: 1,
  }];
  const parent = new StreamSupervisorChannel({
    role: "parent",
    rootId: "display-drafts-root",
    localAgentId: null,
    peerAgentId: AGENT_ID,
    parentAgentId: null,
    depth: 1,
    credential: "display-drafts-credential",
    requestIdRegistry,
    transport: transportForParent,
    streamIdFactory: () => "test-stream",
  });
  const child = new StreamSupervisorChannel({
    role: "child",
    rootId: "display-drafts-root",
    localAgentId: AGENT_ID,
    peerAgentId: "",
    parentAgentId: null,
    depth: 1,
    credential: "display-drafts-credential",
    requestIdRegistry,
    transport: transportForChild,
    initialSnapshot: snapshot,
    initialSubtreeRevision: 1,
    streamIdFactory: () => "test-stream",
  });
  const cleanup = (): void => {
    parentToChild.destroy();
    childToParent.destroy();
  };
  return { parent, child, cleanup };
}

test("监督通道 display 帧端到端交付，事件身份与外层身份绑定", async () => {
  const { parent, child, cleanup } = readyChannelPair();
  const deliveries: SupervisorDisplayDelivery[] = [];
  parent.onDisplay((delivery) => deliveries.push(delivery));
  try {
    void parent.bind(new AbortController().signal).catch(() => {});
    await child.bind(new AbortController().signal);
    await child.waitForReady(new AbortController().signal);
    assert.equal(child.getPublicState().state, "ready");

    const event = delta("message-1", 1, 0, "text", "经通道", AGENT_ID, INCARNATION_ID);
    await child.publishDisplayActivity({ agent_id: AGENT_ID, event });
    assert.deepEqual(deliveries, [{ agent_id: AGENT_ID, event }]);

    // 事件身份与外层代理身份不一致：发布端直接拒绝，不产生可发送帧。
    const spoofed = delta("message-1", 2, 0, "text", "越权", OTHER_AGENT_ID, INCARNATION_ID);
    await assert.rejects(
      child.publishDisplayActivity({ agent_id: AGENT_ID, event: spoofed }),
      (error: unknown) => (error as { code?: string }).code === "identity_mismatch",
    );
    assert.equal(deliveries.length, 1);

    // 接收端同样校验事件身份与外层代理身份的一致性：违约升级为协议故障。
    // hello(1) → snapshot(2) → display(3) 之后，下一合法 seq 恰为 4。
    const forged = { ...event, sequence: 4, agentId: OTHER_AGENT_ID };
    // 绕过流适配器的私有包装，直接驱动底层协议端点接收手工构造的帧。
    const protocolReceive = (parent as unknown as {
      receive(frame: unknown): unknown;
    }).receive.bind(parent);
    protocolReceive({
      protocol: SUPERVISOR_PROTOCOL_VERSION,
      kind: "display",
      stream_id: "test-stream",
      sender_agent_id: AGENT_ID,
      target_agent_id: null,
      seq: 4,
      payload: { agent_id: AGENT_ID, event: forged },
    });
    assert.equal(parent.getPublicState().state, "faulted");
    assert.equal(deliveries.length, 1);
  } finally {
    cleanup();
  }
});

test("display 帧属于固定协议版本与帧 kind 闭集", () => {
  assert.equal(SUPERVISOR_PROTOCOL_VERSION, "wj-pi-subagents/31");
  assert.equal((SUPERVISOR_FRAME_KINDS as readonly string[]).includes("display"), true);
  // 闭集校验：身份不完整的显示事件在通道边界前即被拒绝。
  assert.equal(
    parseAgentActivityDisplayEvent({ type: "message_complete", streamId: "message-1", sequence: 1 }).kind,
    "invalid",
  );
});

test("产生端跟踪器按真实 Pi 事件形状轮换 streamId 并收束每条消息的流", () => {
  const tracker = new OwnDisplayStreamTracker();
  // Pi 的 agent 循环只为增量发出 message_update；start 与 end 是独立事件。
  const start = (): unknown => ({ type: "message_start", message: { role: "assistant", content: [] } });
  const assistantEnd = (): unknown => ({ type: "message_end", message: { role: "assistant", content: [] } });
  const userEnd = (): unknown => ({ type: "message_end", message: { role: "user", content: [] } });
  const textDelta = (index: number, delta: string): unknown => ({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: index, delta },
  });

  const outputs: AgentDisplayStreamUpdate[] = [];
  for (const event of [start(), textDelta(0, "Hel"), textDelta(0, "lo"), assistantEnd()]) {
    outputs.push(...tracker.observe(event));
  }
  // 第一条消息：delta 序号 1、2，message_end 收束为序号 3 的 complete。
  assert.deepEqual(outputs.map((update) => [update.type, update.sequence]), [
    ["message_delta", 1],
    ["message_delta", 2],
    ["message_complete", 3],
  ]);
  // message_end 之后权威条目携带刚收束的流身份。
  assert.equal(tracker.latestStreamId, "message-1");

  // 第二条消息轮换 streamId：不同消息不会关联到同一草稿身份。
  outputs.length = 0;
  for (const event of [start(), textDelta(0, "二"), assistantEnd()]) {
    outputs.push(...tracker.observe(event));
  }
  assert.equal(outputs[0]?.type === "message_delta" ? outputs[0].streamId : undefined, "message-2");
  assert.equal(tracker.latestStreamId, "message-2");

  // 非 assistant 的 message_end 不产生事件，也不收束 assistant 流。
  outputs.length = 0;
  for (const event of [start(), textDelta(0, "三"), userEnd(), assistantEnd()]) {
    outputs.push(...tracker.observe(event));
  }
  assert.deepEqual(outputs.map((update) => update.type), ["message_delta", "message_complete"]);
});

test("中断的消息由下一条 message_start 收束，streamId 仍逐消息轮换", () => {
  const tracker = new OwnDisplayStreamTracker();
  const start = (): unknown => ({ type: "message_start", message: { role: "assistant", content: [] } });
  const textDelta = (index: number, delta: string): unknown => ({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: index, delta },
  });

  // 第一条消息流式中断：没有 message_end。
  tracker.observe(start());
  tracker.observe(textDelta(0, "部分"));
  // 下一条 assistant 消息的 message_start 收束上一条流（complete 序号 2）。
  const outputs = [...tracker.observe(start())];
  assert.deepEqual(outputs.map((update) => [update.type, update.sequence]), [["message_complete", 2]]);
  assert.equal(tracker.latestStreamId, "message-2");

  // 超预算 delta：收束当前流并丢弃该消息的后续增量。
  tracker.observe(textDelta(0, "x".repeat(20_000)));
  const rejected = [...tracker.observe(textDelta(0, "suffix"))];
  assert.deepEqual(rejected, []);
  // 下一条消息重置丢弃状态，序号从 1 重新开始。
  outputs.length = 0;
  for (const event of [start(), textDelta(0, "新")]) outputs.push(...tracker.observe(event));
  assert.equal(outputs[0]?.type === "message_delta" ? outputs[0].streamId : undefined, "message-3");
  assert.deepEqual(outputs.map((update) => [update.type, update.sequence]), [["message_delta", 1]]);
});

test("产生端跟踪器 reset 切换 stream epoch 与 source generation，避免复用旧有序身份", () => {
  const tracker = new OwnDisplayStreamTracker("message-old", DISPLAY_EPOCH, 7);
  const start = { type: "message_start", message: { role: "assistant", content: [] } };
  const assistantEnd = { type: "message_end", message: { role: "assistant", content: [] } };
  const textDelta = {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "正文" },
  };
  const done = { type: "message_update", assistantMessageEvent: { type: "done" } };
  const first = tracker.observe(start);
  assert.equal(first.length, 0);
  assert.deepEqual(tracker.latestDisplayStream, {
    streamId: "message-old-1",
    displayEpoch: DISPLAY_EPOCH,
    displaySourceGeneration: 7,
    streamOrdinal: 1,
  });
  tracker.observe(textDelta);
  // done 先收束草稿时，随后的 message_end 仍要把同一完整 identity 附给权威正文。
  assert.equal(tracker.observe(done)[0]?.type, "message_complete");
  tracker.observe(assistantEnd);
  assert.deepEqual(tracker.latestDisplayStream, {
    streamId: "message-old-1",
    displayEpoch: DISPLAY_EPOCH,
    displaySourceGeneration: 7,
    streamOrdinal: 1,
  });
  // 没有对应 message_start 的另一条 end 不得错误复用上一条 identity。
  tracker.observe(assistantEnd);
  assert.equal(tracker.latestDisplayStream, undefined);

  tracker.reset("message-new", RESTARTED_DISPLAY_EPOCH, 8);
  const second = tracker.observe(start);
  assert.equal(second.length, 0);
  assert.deepEqual(tracker.latestDisplayStream, {
    streamId: "message-new-1",
    displayEpoch: RESTARTED_DISPLAY_EPOCH,
    displaySourceGeneration: 8,
    streamOrdinal: 1,
  });
});


test("查看器投影直接消费草稿视图：流式与冻结标题随状态切换", () => {
  const viewer = new AgentActivityViewerModel({
    agent_id: AGENT_ID,
    template_id: "worker",
    name: "worker-a",
    state: "working",
  }, [], {
    drafts: [{
      key: `${INCARNATION_ID}|message-1`,
      state: "streaming",
      blocks: [Object.freeze({ contentIndex: 0, contentType: "thinking" as const, value: "流式" })],
    }],
  });
  assert.match(viewer.render(160).join("\n"), /▸ Thinking · streaming/u);

  const frozenViewer = new AgentActivityViewerModel({
    agent_id: AGENT_ID,
    template_id: "worker",
    name: "worker-a",
    state: "working",
  }, [], {
    drafts: [{
      key: `${INCARNATION_ID}|message-1`,
      state: "frozen",
      blocks: [Object.freeze({ contentIndex: 0, contentType: "thinking" as const, value: "冻结" })],
    }],
  });
  assert.match(frozenViewer.render(160).join("\n"), /▸ Thinking · streaming incomplete/u);

  const surface = renderAgentActivityViewerSurface(frozenViewer, 160, undefined);
  assert.ok(surface.length > 0);
  assert.ok(surface.every((line) => line.length > 0));
});
