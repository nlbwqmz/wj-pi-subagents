import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  parseAgentActivityEvent,
  parseCanonicalAgentActivityEvent,
} from "../src/rpc-bridge-event.ts";
import {
  CANONICAL_ACTIVITY_CONTRACT_VERSION,
  CANONICAL_ACTIVITY_CHUNK_TOTAL_LIMIT,
  chunkCanonicalAgentActivityEntry,
  parseCanonicalAgentActivityChunk,
  parseCanonicalAgentActivityEntry,
  reassembleCanonicalAgentActivityChunks,
  type CanonicalAgentActivityChunk,
  type CanonicalAgentActivityEntry,
} from "../src/canonical-activity.ts";

const AGENT_ID = "550e8400-e29b-41d4-a716-446655440000";

function messageEntry(text: string): CanonicalAgentActivityEntry {
  return Object.freeze({
    contract_version: CANONICAL_ACTIVITY_CONTRACT_VERSION,
    agent_id: AGENT_ID,
    incarnation_id: randomUUID(),
    entry_id: randomUUID(),
    body: Object.freeze({
      type: "message",
      content: Object.freeze([Object.freeze({ type: "text", text })]),
    }),
  });
}

function validEntry(overrides: Partial<CanonicalAgentActivityEntry> = {}): CanonicalAgentActivityEntry {
  return Object.freeze({
    contract_version: CANONICAL_ACTIVITY_CONTRACT_VERSION,
    agent_id: AGENT_ID,
    incarnation_id: randomUUID(),
    entry_id: randomUUID(),
    body: Object.freeze({
      type: "message",
      content: Object.freeze([Object.freeze({ type: "text", text: "回复正文" })]),
    }),
    ...overrides,
  } as CanonicalAgentActivityEntry);
}

test("规范条目契约版本是固定字符串，解析器只接受当前版本", () => {
  assert.equal(CANONICAL_ACTIVITY_CONTRACT_VERSION, "wj-pi-subagents.activity/13");
  assert.equal(parseCanonicalAgentActivityEntry(validEntry()).kind, "entry");

  const legacy = Object.freeze({ ...validEntry(), contract_version: "wj-pi-subagents.activity/7" });
  assert.equal(parseCanonicalAgentActivityEntry(legacy).kind, "invalid");
});

test("/9 canonical wire 与本地兼容规范化的工具代次边界分离", () => {
  const localLegacy = {
    type: "tool_execution_start",
    toolCallId: "call_legacy",
    toolName: "read",
    origin: "pi_native",
  };
  // 本地 Pi 原始输入允许旧形状，canonical wire 则必须明示代次。
  assert.equal(parseAgentActivityEvent(localLegacy).kind, "event");
  assert.equal(parseCanonicalAgentActivityEvent(localLegacy).kind, "invalid");
  assert.equal(parseCanonicalAgentActivityEntry(validEntry({ body: localLegacy as never })).kind, "invalid");

  assert.equal(parseCanonicalAgentActivityEvent({
    ...localLegacy,
    executionGeneration: 1,
  }).kind, "event");
  assert.equal(parseCanonicalAgentActivityEvent({
    ...localLegacy,
    executionGeneration: 0,
  }).kind, "invalid");
  assert.equal(parseCanonicalAgentActivityEvent({
    ...localLegacy,
    executionGeneration: 1.5,
  }).kind, "invalid");
});

test("/9 canonical wire 严格拒绝 message 与 parent_message 的附加字段", () => {
  assert.equal(parseCanonicalAgentActivityEvent({
    type: "message",
    content: [{ type: "text", text: "完整正文", unexpected: true }],
  }).kind, "invalid");
  assert.equal(parseCanonicalAgentActivityEvent({
    type: "message",
    content: [{ type: "text", text: "完整正文" }],
    extra: true,
  }).kind, "invalid");
  assert.equal(parseCanonicalAgentActivityEvent({
    type: "message",
    content: [{ type: "text", text: "完整正文" }],
    streamId: undefined,
  }).kind, "invalid");
  assert.equal(parseCanonicalAgentActivityEvent({
    type: "parent_message",
    content: [{ type: "text", text: "父消息" }],
    streamId: "forbidden",
  }).kind, "invalid");
  assert.equal(parseCanonicalAgentActivityEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "read",
    origin: "pi_native",
    executionGeneration: 1,
    summary: undefined,
  }).kind, "invalid");
  assert.equal(parseCanonicalAgentActivityEvent({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "read",
    origin: "pi_native",
    executionGeneration: 1,
    isError: false,
  }).kind, "invalid");
});

test("/9 canonical wire 遵循 JSON 图语义并拒绝非 JSON 附加状态", () => {
  const sharedBlock = { type: "text", text: "可共享的正文块" };
  // JSON.stringify 会将同一引用在两个位置分别展开；它不是循环。
  assert.equal(parseCanonicalAgentActivityEvent({
    type: "message",
    content: [sharedBlock, sharedBlock],
  }).kind, "event");

  const arrayWithNamedProperty = [{ type: "text", text: "正文" }] as Array<Record<string, unknown>> & {
    unexpected?: undefined;
  };
  arrayWithNamedProperty.unexpected = undefined;
  assert.equal(parseCanonicalAgentActivityEvent({
    type: "message",
    content: arrayWithNamedProperty,
  }).kind, "invalid");

  const cyclicBlock: Record<string, unknown> = { type: "text", text: "正文" };
  cyclicBlock.self = cyclicBlock;
  assert.equal(parseCanonicalAgentActivityEvent({
    type: "message",
    content: [cyclicBlock],
  }).kind, "invalid");
});

test("assistant 消息的 canonical 关联必须携带完整有序 displayStream", () => {
  const displayEpoch = randomUUID();
  const correlated = parseCanonicalAgentActivityEntry(validEntry({
    body: Object.freeze({
      type: "message",
      content: Object.freeze([Object.freeze({ type: "text", text: "回复正文" })]),
      displayStream: Object.freeze({
        streamId: "message-1",
        displayEpoch,
        displaySourceGeneration: 1,
        streamOrdinal: 1,
      }),
    }),
  }));
  assert.equal(correlated.kind, "entry");
  if (correlated.kind === "entry" && correlated.entry.body.type === "message") {
    assert.equal(correlated.entry.body.displayStream?.streamId, "message-1");
  }

  // bare streamId 仍可由本地 raw-Pi 兼容 normalizer 接收，但不能跨 canonical wire。
  const legacy = {
    type: "message" as const,
    content: [{ type: "text" as const, text: "回复正文" }],
    streamId: "message-1",
  };
  assert.equal(parseAgentActivityEvent(legacy).kind, "event");
  assert.equal(parseCanonicalAgentActivityEvent(legacy).kind, "invalid");
  assert.equal(parseCanonicalAgentActivityEntry(validEntry({ body: legacy as never })).kind, "invalid");

  assert.equal(parseCanonicalAgentActivityEntry(validEntry({
    body: Object.freeze({
      type: "message",
      content: Object.freeze([Object.freeze({ type: "text", text: "回复正文" })]),
      displayStream: Object.freeze({
        streamId: "message-1",
        displayEpoch,
        displaySourceGeneration: 0,
        streamOrdinal: 1,
      }),
    }),
  })).kind, "invalid");
});

test("/12 canonical wire 接受模型调用失败条目并保留四个字段", () => {
  const body = Object.freeze({
    type: "model_call_failure" as const,
    failure: "error" as const,
    message: "401 unauthorized",
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
  });
  const parsed = parseCanonicalAgentActivityEntry(validEntry({ body }));
  assert.equal(parsed.kind, "entry");
  if (parsed.kind === "entry") {
    assert.equal(parsed.entry.contract_version, CANONICAL_ACTIVITY_CONTRACT_VERSION);
    assert.deepEqual(parsed.entry.body, {
      type: "model_call_failure",
      failure: "error",
      message: "401 unauthorized",
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
    });
  }
  // 已中止收尾在契约层同样合法（采集面由采集边界工单补齐）。
  assert.equal(
    parseCanonicalAgentActivityEntry(validEntry({ body: { ...body, failure: "aborted" } as never })).kind,
    "entry",
  );
});

test("/12 canonical wire 对模型调用失败条目执行固定字段闭集校验", () => {
  const body = {
    type: "model_call_failure",
    failure: "error",
    message: "boom",
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
  };
  assert.equal(parseCanonicalAgentActivityEvent(body).kind, "event");
  assert.equal(parseAgentActivityEvent(body).kind, "event");
  // 四字段一次定死：额外键、缺键、值域外收尾原因与空字符串都违约。
  assert.equal(parseCanonicalAgentActivityEvent({ ...body, extra: true }).kind, "invalid");
  assert.equal(parseCanonicalAgentActivityEvent({ ...body, displayStream: undefined }).kind, "invalid");
  const { model: _model, ...missingModel } = body;
  assert.equal(parseCanonicalAgentActivityEvent(missingModel).kind, "invalid");
  assert.equal(parseCanonicalAgentActivityEvent({ ...body, failure: "cancelled" }).kind, "invalid");
  assert.equal(parseCanonicalAgentActivityEvent({ ...body, failure: undefined }).kind, "invalid");
  assert.equal(parseCanonicalAgentActivityEvent({ ...body, message: "" }).kind, "invalid");
  assert.equal(parseCanonicalAgentActivityEvent({ ...body, provider: "" }).kind, "invalid");
  assert.equal(parseCanonicalAgentActivityEvent({ ...body, model: "" }).kind, "invalid");
  assert.equal(parseCanonicalAgentActivityEvent({ ...body, provider: 42 }).kind, "invalid");
  assert.equal(parseCanonicalAgentActivityEvent({ ...body, message: 42 }).kind, "invalid");
});

test("/12 canonical wire 接受缺身份的模型调用失败条目（压缩自身失败不带 provider/model）", () => {
  const body = {
    type: "model_call_failure" as const,
    failure: "error" as const,
    message: "compaction summarization failed",
  };
  const parsed = parseCanonicalAgentActivityEntry(validEntry({ body: body as never }));
  assert.equal(parsed.kind, "entry");
  if (parsed.kind === "entry") {
    // 缺身份时条目仍完整成立：只有收尾原因与错误文本两个必填字段。
    assert.deepEqual(parsed.entry.body, {
      type: "model_call_failure",
      failure: "error",
      message: "compaction summarization failed",
    });
  }
  assert.equal(parseCanonicalAgentActivityEvent(body).kind, "event");
  assert.equal(parseAgentActivityEvent(body).kind, "event");
  // provider 与 model 同进同出：单边身份、空串与超长仍然违约。
  assert.equal(parseCanonicalAgentActivityEvent({ ...body, provider: "anthropic" }).kind, "invalid");
  assert.equal(parseCanonicalAgentActivityEvent({ ...body, model: "gpt-5" }).kind, "invalid");
  assert.equal(
    parseCanonicalAgentActivityEvent({ ...body, provider: "anthropic", model: "" }).kind,
    "invalid",
  );
  assert.equal(
    parseCanonicalAgentActivityEvent({ ...body, provider: "anthropic", model: "gpt-5" }).kind,
    "event",
  );
});

test("/12 长错误文本的失败条目仍按身份分块并可完整重组", () => {
  const text = "provider payload\n".repeat(6_000);
  const entry = validEntry({
    body: Object.freeze({
      type: "model_call_failure" as const,
      failure: "error" as const,
      message: text,
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
    }),
  });
  const frames = chunkCanonicalAgentActivityEntry(entry, 32 * 1024) as CanonicalAgentActivityChunk[];
  assert.ok(frames.length > 1, `期望多帧，实际 ${frames.length}`);
  const reassembled = reassembleCanonicalAgentActivityChunks(frames);
  assert.ok(reassembled);
  assert.deepEqual(reassembled.body, entry.body);
});

test("规范条目校验代理身份、运行实例身份、条目身份与原子正文闭集", () => {
  assert.equal(parseCanonicalAgentActivityEntry(validEntry({ agent_id: "not-a-uuid" })).kind, "invalid");
  assert.equal(parseCanonicalAgentActivityEntry(validEntry({ incarnation_id: "incarnation" })).kind, "invalid");
  assert.equal(parseCanonicalAgentActivityEntry(validEntry({ entry_id: "" })).kind, "invalid");
  assert.equal(parseCanonicalAgentActivityEntry(validEntry({ body: { type: "agent_start" } as never })).kind, "invalid");
  assert.equal(parseCanonicalAgentActivityEntry({ type: "message" }).kind, "invalid");
  assert.equal(parseCanonicalAgentActivityEntry(undefined).kind, "invalid");

  const parsed = parseCanonicalAgentActivityEntry(validEntry());
  assert.equal(parsed.kind, "entry");
  if (parsed.kind === "entry") {
    assert.equal(parsed.entry.contract_version, CANONICAL_ACTIVITY_CONTRACT_VERSION);
    assert.deepEqual(parsed.entry.body, {
      type: "message",
      content: [{ type: "text", text: "回复正文" }],
    });
  }
});

test("规范条目拒绝额外字段与缺失字段", () => {
  const padded = { ...validEntry(), extra: true } as Record<string, unknown>;
  assert.equal(parseCanonicalAgentActivityEntry(padded).kind, "invalid");

  const missing = validEntry();
  const { contract_version: _dropped, ...rest } = missing;
  assert.equal(parseCanonicalAgentActivityEntry(rest).kind, "invalid");
});

test("分块把超过单帧预算的完整正文切成身份一致的帧序列", () => {
  const entry = messageEntry("x".repeat(200 * 1024));
  const frames = chunkCanonicalAgentActivityEntry(entry, 64 * 1024);

  assert.ok(frames.length > 1, `期望多帧，实际 ${frames.length}`);
  for (const frame of frames) {
    assert.equal(frame.contract_version, CANONICAL_ACTIVITY_CONTRACT_VERSION);
    assert.equal(frame.agent_id, entry.agent_id);
    assert.equal(frame.incarnation_id, entry.incarnation_id);
    assert.equal(frame.entry_id, entry.entry_id);
    assert.equal("chunk_total" in frame ? frame.chunk_total : frames.length, frames.length);
    assert.ok(typeof (frame as CanonicalAgentActivityChunk).payload === "string");
  }
  assert.equal((frames[0] as CanonicalAgentActivityChunk).chunk_index, 0);
  assert.equal((frames.at(-1) as CanonicalAgentActivityChunk).chunk_index, frames.length - 1);
});

test("小条目直接内联传输，不产生分块帧", () => {
  const entry = validEntry();
  const frames = chunkCanonicalAgentActivityEntry(entry, 64 * 1024);
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], entry);
});

test("分块帧序列重组后得到完整规范条目", () => {
  const text = "标题\n\n" + "段落内容。".repeat(30_000);
  const entry = validEntry({
    body: Object.freeze({
      type: "message",
      content: Object.freeze([
        Object.freeze({ type: "thinking", thinking: "先想一下" }),
        Object.freeze({ type: "text", text }),
      ]),
    }),
  } as Partial<CanonicalAgentActivityEntry>);
  const frames = chunkCanonicalAgentActivityEntry(entry, 32 * 1024) as CanonicalAgentActivityChunk[];
  assert.ok(frames.length > 4);

  const reassembled = reassembleCanonicalAgentActivityChunks(frames);
  assert.ok(reassembled);
  assert.deepEqual(reassembled.body, entry.body);
  assert.equal(reassembled.agent_id, entry.agent_id);
  assert.equal(reassembled.incarnation_id, entry.incarnation_id);
  assert.equal(reassembled.entry_id, entry.entry_id);
  assert.equal(reassembled.contract_version, CANONICAL_ACTIVITY_CONTRACT_VERSION);
});

test("分块在多字节字符边界切割，重组不损坏宽字符正文", () => {
  const text = "代理活动正文🌍".repeat(9000);
  const entry = messageEntry(text);
  const frames = chunkCanonicalAgentActivityEntry(entry, 7 * 1024) as CanonicalAgentActivityChunk[];
  const reassembled = reassembleCanonicalAgentActivityChunks(frames);
  assert.ok(reassembled);
  const content = reassembled.body as Extract<CanonicalAgentActivityEntry["body"], { type: "message" }>;
  const block = content.content[0];
  assert.ok(block && block.type === "text");
  assert.equal(block.text, text);
});

test("乱序到达的分块仍可重组，重复分块幂等", () => {
  const entry = messageEntry("y".repeat(150 * 1024));
  const frames = [...chunkCanonicalAgentActivityEntry(entry, 32 * 1024)] as CanonicalAgentActivityChunk[];
  assert.ok(frames.length > 3);
  const shuffled = [frames[2]!, frames[0]!, frames[1]!, ...frames.slice(3)];
  const reassembled = reassembleCanonicalAgentActivityChunks(shuffled);
  assert.ok(reassembled);
  assert.deepEqual(reassembled.body, entry.body);

  const withDuplicate = [...shuffled, frames[1]!];
  const deduped = reassembleCanonicalAgentActivityChunks(withDuplicate);
  assert.ok(deduped);
  assert.deepEqual(deduped.body, entry.body);
});

test("缺块不产生部分权威正文", () => {
  const entry = messageEntry("z".repeat(100 * 1024));
  const frames = chunkCanonicalAgentActivityEntry(entry, 32 * 1024) as CanonicalAgentActivityChunk[];
  assert.ok(frames.length > 2);

  assert.equal(reassembleCanonicalAgentActivityChunks(frames.slice(0, -1)), undefined);

  const missingMiddle = frames.filter((frame) => frame.chunk_index !== 1);
  assert.equal(reassembleCanonicalAgentActivityChunks(missingMiddle), undefined);
});

test("分块总数越界或声明不一致的分块无效", () => {
  const base = {
    contract_version: CANONICAL_ACTIVITY_CONTRACT_VERSION,
    agent_id: AGENT_ID,
    incarnation_id: randomUUID(),
    entry_id: randomUUID(),
    chunk_index: 0,
    chunk_total: 2,
    payload: "abc",
  };
  assert.equal(parseCanonicalAgentActivityChunk(base).kind, "chunk");
  assert.equal(
    parseCanonicalAgentActivityChunk({ ...base, chunk_total: CANONICAL_ACTIVITY_CHUNK_TOTAL_LIMIT + 1 }).kind,
    "invalid",
  );
  assert.equal(parseCanonicalAgentActivityChunk({ ...base, chunk_index: 2 }).kind, "invalid");
  assert.equal(parseCanonicalAgentActivityChunk({ ...base, payload: "" }).kind, "invalid");
  assert.equal(parseCanonicalAgentActivityChunk({ ...base, contract_version: "old" }).kind, "invalid");

  const entry = messageEntry("w".repeat(70 * 1024));
  const frames = chunkCanonicalAgentActivityEntry(entry, 32 * 1024) as CanonicalAgentActivityChunk[];
  assert.ok(frames.length > 1);
  const tampered = frames.map((frame, index) =>
    index === 0 ? { ...frame, chunk_total: frame.chunk_total + 1 } : frame
  );
  assert.equal(reassembleCanonicalAgentActivityChunks(tampered), undefined);
});

test("损坏的分块正文无法重组出条目", () => {
  const chunks: CanonicalAgentActivityChunk[] = [];
  const total = 2;
  for (let index = 0; index < total; index += 1) {
    chunks.push(Object.freeze({
      contract_version: CANONICAL_ACTIVITY_CONTRACT_VERSION,
      agent_id: AGENT_ID,
      incarnation_id: randomUUID(),
      entry_id: randomUUID(),
      chunk_index: index,
      chunk_total: total,
      payload: index === 0 ? '{"type":"message","content":' : "}{ broken",
    }));
  }
  assert.equal(reassembleCanonicalAgentActivityChunks(chunks), undefined);
});
