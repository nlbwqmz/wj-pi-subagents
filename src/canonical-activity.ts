import {
  parseCanonicalAgentActivityEvent,
  type SafeAgentActivityEvent,
} from "./rpc-bridge-event.ts";
import { createHash } from "node:crypto";
import { isCanonicalUuid } from "./tree-controller.ts";

/**
 * 规范活动条目契约版本。版本字符串随原子正文、身份语义或 wire 字段
 * 闭集/预算的不兼容变化递增；旧版本条目不得与当前运行实例混用，接收端
 * 按协议故障处理。
 */
export const CANONICAL_ACTIVITY_CONTRACT_VERSION = "wj-pi-subagents.activity/13";

/**
 * 工具活动条目身份的派生命名空间。工具开始与结束是同一条目的状态事实，
 * 产生端用固定命名空间从运行实例身份、工具活动 ID 与执行代次确定性派生
 * 同一条目身份，使两者在缓存、回放与去重中聚合为同一原子。
 */
export const TOOL_ACTIVITY_ENTRY_NAMESPACE = "9f6d2c14-8a47-4b8e-9d31-2c5a7f0b4e68";

/**
 * RFC 4122 命名空间 UUIDv5 派生：同名输入产生稳定一致的规范 UUID，用于
 * 把同一条目的状态事实聚合到相同条目身份。
 */
export function deriveNamespaceUuid(namespace: string, name: string): string {
  const hash = createHash("sha1")
    .update(Buffer.from(namespace.replace(/-/gu, ""), "hex"))
    .update(name, "utf8")
    .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** 规范活动条目的原子正文闭集：assistant 消息、父消息、工具活动与模型调用失败事实。 */
export type CanonicalActivityBody = SafeAgentActivityEvent;

/**
 * 一条规范活动条目。条目是活动的最小权威单元：代理身份、运行实例身份与
 * 条目身份共同承担跨进程、跨层转发时的关联、幂等与回填职责；显示用短 ID
 * 不参与协议身份。一条完整 assistant 消息是一个条目，工具开始与结束共享
 * 同一条目身份（由产生端按运行实例、toolCallId 与执行代次分配）。
 */
export interface CanonicalAgentActivityEntry {
  readonly contract_version: typeof CANONICAL_ACTIVITY_CONTRACT_VERSION;
  readonly agent_id: string;
  readonly incarnation_id: string;
  readonly entry_id: string;
  readonly body: CanonicalActivityBody;
}

/**
 * 大正文条目的传输分块帧。payload 是条目 JSON 序列化文本的 UTF-8 切片；
 * 只有同一条目全部分块按序收齐并通过闭集校验后才重组为权威条目。
 */
export interface CanonicalAgentActivityChunk {
  readonly contract_version: typeof CANONICAL_ACTIVITY_CONTRACT_VERSION;
  readonly agent_id: string;
  readonly incarnation_id: string;
  readonly entry_id: string;
  readonly chunk_index: number;
  readonly chunk_total: number;
  readonly payload: string;
}

function asChunk(value: Omit<CanonicalAgentActivityChunk, "contract_version">): CanonicalAgentActivityChunk {
  return Object.freeze({
    contract_version: CANONICAL_ACTIVITY_CONTRACT_VERSION,
    ...value,
  });
}

/** 单个条目允许的最大分块数。这是聚合缓冲的协议边界，不是正文预算。 */
export const CANONICAL_ACTIVITY_CHUNK_TOTAL_LIMIT = 1024;

/**
 * 条目内联传输或单个分块 payload 的 UTF-8 字节预算。它保证分块帧再经
 * JSON 转义后仍安全落入监督帧预算（最坏膨胀下也不越过 64KiB 字符串边界）。
 */
export const CANONICAL_ACTIVITY_CHUNK_PAYLOAD_BYTES = 32 * 1024;

const ENTRY_KEYS = Object.freeze([
  "contract_version",
  "agent_id",
  "incarnation_id",
  "entry_id",
  "body",
] as const);

const CHUNK_KEYS = Object.freeze([
  "contract_version",
  "agent_id",
  "incarnation_id",
  "entry_id",
  "chunk_index",
  "chunk_total",
  "payload",
] as const);

export type CanonicalActivityEntryNormalization =
  | { readonly kind: "entry"; readonly entry: CanonicalAgentActivityEntry }
  | { readonly kind: "invalid" };

export type CanonicalActivityChunkNormalization =
  | { readonly kind: "chunk"; readonly chunk: CanonicalAgentActivityChunk }
  | { readonly kind: "invalid" };

/**
 * 严格闭集校验一条规范活动条目：固定字段集合、固定契约版本、规范 UUID
 * 身份，以及经既有活动事件闭集校验的原子正文。
 */
export function parseCanonicalAgentActivityEntry(value: unknown): CanonicalActivityEntryNormalization {
  if (!isRecord(value) || !hasExactKeys(value, ENTRY_KEYS)) return INVALID_ENTRY;
  if (value.contract_version !== CANONICAL_ACTIVITY_CONTRACT_VERSION) return INVALID_ENTRY;
  if (!isCanonicalUuid(value.agent_id)) return INVALID_ENTRY;
  if (!isCanonicalUuid(value.incarnation_id)) return INVALID_ENTRY;
  if (!isCanonicalUuid(value.entry_id)) return INVALID_ENTRY;
  const body = parseCanonicalAgentActivityEvent(value.body);
  if (body.kind !== "event") return INVALID_ENTRY;
  const agentId = value.agent_id;
  const incarnationId = value.incarnation_id;
  const entryId = value.entry_id;
  return Object.freeze({
    kind: "entry",
    entry: Object.freeze({
      contract_version: CANONICAL_ACTIVITY_CONTRACT_VERSION,
      agent_id: agentId,
      incarnation_id: incarnationId,
      entry_id: entryId,
      body: body.event,
    }),
  });
}

/** 严格闭集校验一个传输分块帧的结构字段；正文重组与校验在收齐后进行。 */
export function parseCanonicalAgentActivityChunk(value: unknown): CanonicalActivityChunkNormalization {
  if (!isRecord(value) || !hasExactKeys(value, CHUNK_KEYS)) return INVALID_CHUNK;
  if (value.contract_version !== CANONICAL_ACTIVITY_CONTRACT_VERSION) return INVALID_CHUNK;
  if (!isCanonicalUuid(value.agent_id)) return INVALID_CHUNK;
  if (!isCanonicalUuid(value.incarnation_id)) return INVALID_CHUNK;
  if (!isCanonicalUuid(value.entry_id)) return INVALID_CHUNK;
  if (typeof value.payload !== "string" || value.payload.length === 0) return INVALID_CHUNK;
  const chunkIndex = value.chunk_index;
  const chunkTotal = value.chunk_total;
  if (
    typeof chunkIndex !== "number" || !Number.isSafeInteger(chunkIndex) || chunkIndex < 0
    || typeof chunkTotal !== "number" || !Number.isSafeInteger(chunkTotal) || chunkTotal < 1
    || chunkTotal > CANONICAL_ACTIVITY_CHUNK_TOTAL_LIMIT
    || chunkIndex >= chunkTotal
  ) return INVALID_CHUNK;
  return Object.freeze({
    kind: "chunk",
    chunk: asChunk({
      agent_id: value.agent_id,
      incarnation_id: value.incarnation_id,
      entry_id: value.entry_id,
      chunk_index: chunkIndex,
      chunk_total: chunkTotal,
      payload: value.payload,
    }),
  });
}

/**
 * 产生端传输编码：条目 JSON 超过单帧预算时按 UTF-8 字符边界切成多个分块
 * 帧；否则原样内联为单帧。返回的帧携带一致的身份与总数声明。
 */
export function chunkCanonicalAgentActivityEntry(
  entry: CanonicalAgentActivityEntry,
  maxChunkPayloadBytes: number,
): readonly (CanonicalAgentActivityEntry | CanonicalAgentActivityChunk)[] {
  const parsed = parseCanonicalAgentActivityEntry(entry);
  if (parsed.kind !== "entry") return Object.freeze([]);
  const serialized = JSON.stringify(parsed.entry);
  const bytes = new TextEncoder().encode(serialized);
  if (bytes.byteLength <= maxChunkPayloadBytes) return Object.freeze([parsed.entry]);
  const payloads: string[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    let end = Math.min(offset + maxChunkPayloadBytes, bytes.byteLength);
    if (end < bytes.byteLength) {
      // 回退到 UTF-8 字符边界，避免切断多字节字符。
      while (end > offset + 1 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    }
    const payload = Buffer.from(bytes.subarray(offset, end)).toString("utf8");
    if (payload.length === 0) return Object.freeze([]);
    payloads.push(payload);
    offset = end;
  }
  if (payloads.length > CANONICAL_ACTIVITY_CHUNK_TOTAL_LIMIT) return Object.freeze([]);
  const chunkTotal = payloads.length;
  return Object.freeze(payloads.map((payload, chunkIndex) => asChunk({
    agent_id: parsed.entry.agent_id,
    incarnation_id: parsed.entry.incarnation_id,
    entry_id: parsed.entry.entry_id,
    chunk_index: chunkIndex,
    chunk_total: chunkTotal,
    payload,
  })));
}

/**
 * 接收端重组：分块按索引排序、重复分块幂等合并；任何总数不一致、缺块或
 * 正文违约都返回 undefined，绝不产出部分权威条目。
 */
export function reassembleCanonicalAgentActivityChunks(
  frames: readonly CanonicalAgentActivityChunk[],
): CanonicalAgentActivityEntry | undefined {
  if (frames.length === 0) return undefined;
  const first = frames[0]!;
  const identity = {
    contract_version: first.contract_version,
    agent_id: first.agent_id,
    incarnation_id: first.incarnation_id,
    entry_id: first.entry_id,
  };
  const parsed: CanonicalAgentActivityChunk[] = [];
  for (const frame of frames) {
    const normalized = parseCanonicalAgentActivityChunk(frame);
    if (normalized.kind !== "chunk") return undefined;
    const chunk = normalized.chunk;
    if (
      chunk.contract_version !== identity.contract_version
      || chunk.agent_id !== identity.agent_id
      || chunk.incarnation_id !== identity.incarnation_id
      || chunk.entry_id !== identity.entry_id
    ) return undefined;
    parsed.push(chunk);
  }
  const total = parsed[0]!.chunk_total;
  const byIndex = new Map<number, CanonicalAgentActivityChunk>();
  for (const chunk of parsed) {
    if (chunk.chunk_total !== total) return undefined;
    const existing = byIndex.get(chunk.chunk_index);
    if (existing === undefined) {
      byIndex.set(chunk.chunk_index, chunk);
      continue;
    }
    // 重复分块内容一致时幂等；不一致属于传输违约，丢弃整条聚合。
    if (existing.payload !== chunk.payload) return undefined;
  }
  if (byIndex.size !== total) return undefined;
  const ordered = [...byIndex.values()].sort((left, right) => left.chunk_index - right.chunk_index);
  const encoded = ordered.map((chunk) => Buffer.from(chunk.payload, "utf8"));
  const text = Buffer.concat(encoded).toString("utf8");
  let candidate: unknown;
  try {
    candidate = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsedEntry = parseCanonicalAgentActivityEntry(candidate);
  if (parsedEntry.kind !== "entry") return undefined;
  // 分块声明身份必须与条目自描述身份一致，防止篡改或串流。
  const entry = parsedEntry.entry;
  if (
    entry.contract_version !== identity.contract_version
    || entry.agent_id !== identity.agent_id
    || entry.incarnation_id !== identity.incarnation_id
    || entry.entry_id !== identity.entry_id
  ) return undefined;
  return entry;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  if (Object.keys(value).length !== keys.length) return false;
  return keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const INVALID_ENTRY: CanonicalActivityEntryNormalization = Object.freeze({ kind: "invalid" });
const INVALID_CHUNK: CanonicalActivityChunkNormalization = Object.freeze({ kind: "invalid" });
