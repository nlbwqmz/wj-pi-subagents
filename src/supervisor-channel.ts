import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  AGENT_LIFECYCLE_STATES,
  isCanonicalUuid,
  type AgentFault,
  type AgentLifecycleState,
  type AgentSnapshot,
} from "./tree-controller.ts";

/** 父子监督通道与 Pi 任务 RPC 完全隔离的固定协议版本。 */
export const SUPERVISOR_PROTOCOL_VERSION = "pi-subagent/1";

export const SUPERVISOR_FRAME_KINDS = Object.freeze([
  "hello",
  "hello_ack",
  "event",
  "snapshot_request",
  "snapshot",
  "reply",
  "ack",
  "close",
] as const);

export type SupervisorFrameKind = (typeof SUPERVISOR_FRAME_KINDS)[number];

/**
 * 这些边界是实现常量而不是用户配额。它们限制单条本地控制流的内存，
 * 不能改变树的公开配额、等待或模型行为。
 */
export const SUPERVISOR_CHANNEL_LIMITS = Object.freeze({
  maxFrameBytes: 64 * 1024,
  maxStringBytes: 16 * 1024,
  maxJsonDepth: 16,
  maxJsonEntries: 512,
  maxNodes: 64,
  maxReplyWindow: 32,
  maxPendingSnapshots: 1,
  maxRecentRequestIds: 128,
  maxRetiredStreams: 4,
  maxImagesPerReply: 8,
  maxImageBytes: 24 * 1024,
  maxDepth: 8,
} as const);

export interface SupervisorChannelLimits {
  readonly maxFrameBytes: number;
  readonly maxStringBytes: number;
  readonly maxJsonDepth: number;
  readonly maxJsonEntries: number;
  readonly maxNodes: number;
  readonly maxReplyWindow: number;
  readonly maxPendingSnapshots: number;
  readonly maxRecentRequestIds: number;
  readonly maxRetiredStreams: number;
  readonly maxImagesPerReply: number;
  readonly maxImageBytes: number;
  readonly maxDepth: number;
}

export interface SupervisorFrame<Payload = Record<string, unknown>> {
  readonly protocol: typeof SUPERVISOR_PROTOCOL_VERSION;
  readonly kind: SupervisorFrameKind;
  readonly stream_id: string;
  /** 根会话发送帧时为保留空字符串，根从不伪装成一个代理节点。 */
  readonly sender_agent_id: string;
  /** 指向直接对端；根会话作为目标时使用 null。 */
  readonly target_agent_id: string | null;
  readonly seq: number;
  readonly request_id?: string;
  readonly payload: Payload;
}

export interface SupervisorSnapshot {
  readonly scope_agent_id: string;
  readonly subtree_revision: number;
  readonly nodes: readonly AgentSnapshot[];
}

export interface SupervisorReplyImage {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

export interface SupervisorReply {
  readonly reply_seq: number;
  readonly text: string;
  readonly images?: readonly SupervisorReplyImage[];
}

export type SupervisorChannelState =
  | "new"
  | "hello_sent"
  | "awaiting_snapshot"
  | "ready"
  | "resyncing"
  | "closing"
  | "closed"
  | "faulted";

export type SupervisorProtocolErrorCode =
  | "frame_too_large"
  | "invalid_utf8"
  | "invalid_json"
  | "invalid_frame"
  | "protocol_mismatch"
  | "identity_mismatch"
  | "credential_mismatch"
  | "sequence_violation"
  | "snapshot_invalid"
  | "reply_invalid"
  | "reply_window_full"
  | "request_reused"
  | "eof"
  | "closed";

/**
 * 错误只暴露稳定分类；绝不把帧正文、凭据、端点或底层异常附加到 message。
 */
export class SupervisorProtocolError extends Error {
  readonly code: SupervisorProtocolErrorCode;

  constructor(code: SupervisorProtocolErrorCode) {
    super("监督通道协议错误");
    this.name = "SupervisorProtocolError";
    this.code = code;
  }
}

export interface SupervisorChannelFault {
  readonly code: "internal_error";
}

export interface SupervisorChannelPublicState {
  readonly state: SupervisorChannelState;
  readonly tree_revision: number;
  readonly subtree_revision: number;
  readonly snapshot_node_count: number;
  readonly pending_reply_count: number;
  readonly fault?: SupervisorChannelFault;
}

export interface SupervisorReceiveAccepted {
  readonly kind: "accepted";
  readonly ack: number;
  readonly applied: boolean;
  readonly tree_revision: number;
  readonly outbound: readonly SupervisorFrame[];
  readonly replies: readonly SupervisorReply[];
}

export interface SupervisorReceiveDuplicate {
  readonly kind: "duplicate";
  readonly ack: number;
  readonly outbound: readonly SupervisorFrame[];
}

export interface SupervisorReceiveGap {
  readonly kind: "gap";
  readonly ack: number;
  readonly request_id: string;
  readonly outbound: readonly SupervisorFrame[];
}

export interface SupervisorReceiveDiscarded {
  readonly kind: "discarded";
  readonly reason: "old_stream" | "termination_barrier" | "closed";
}

export interface SupervisorReceiveFault {
  readonly kind: "protocol_fault";
  readonly error: SupervisorProtocolErrorCode;
}

export interface SupervisorReceiveEof {
  readonly kind: "eof";
}

export type SupervisorReceiveResult =
  | SupervisorReceiveAccepted
  | SupervisorReceiveDuplicate
  | SupervisorReceiveGap
  | SupervisorReceiveDiscarded
  | SupervisorReceiveFault
  | SupervisorReceiveEof;

export type SupervisorChannelRole = "parent" | "child";

export interface SupervisorChannelOptions {
  readonly role: SupervisorChannelRole;
  /** 运行中根会话的不可变关联值；它不是公开代理标识。 */
  readonly rootId: string;
  /** 本端是根时为 null，普通父/子控制器必须填写 canonical UUID。 */
  readonly localAgentId: string | null;
  /** 直接对端。根对端保留空字符串；其他对端必须为 canonical UUID。 */
  readonly peerAgentId: string;
  /** 子控制器在 hello 和快照根节点中声明的直接父身份。 */
  readonly parentAgentId: string | null;
  /** 子控制器的全局树深度。 */
  readonly depth: number;
  /** 一次性本地连接凭据；仅 hello 传输，永不出现在公开状态。 */
  readonly credential: string | Uint8Array;
  readonly limits?: Partial<SupervisorChannelLimits>;
  readonly streamIdFactory?: () => string;
  readonly requestIdFactory?: () => string;
  /** 父端在普通回复可安全注入会话后调用；返回 false 时不确认该回复。 */
  readonly onReply?: (reply: SupervisorReply) => boolean;
}

interface InternalFrame extends SupervisorFrame<Record<string, unknown>> {}

interface PendingSnapshotRequest {
  readonly requestId: string;
}

interface StoredReply {
  readonly frame: SupervisorFrame;
  readonly reply: SupervisorReply;
}

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_STREAM_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_MIME_PATTERN = /^[a-z]+\/[a-z0-9.+-]+$/;
const RFC3339_MILLIS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const EMPTY_FAULT: SupervisorChannelFault = Object.freeze({ code: "internal_error" });
const EMPTY_NODES: readonly AgentSnapshot[] = Object.freeze([]);
const EMPTY_FRAMES: readonly SupervisorFrame[] = Object.freeze([]);
const EMPTY_REPLIES: readonly SupervisorReply[] = Object.freeze([]);

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function cloneBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

function mergeLimits(input: Partial<SupervisorChannelLimits> | undefined): SupervisorChannelLimits {
  const result: Record<keyof SupervisorChannelLimits, number> = {
    ...SUPERVISOR_CHANNEL_LIMITS,
  };
  if (input !== undefined) {
    for (const key of Object.keys(SUPERVISOR_CHANNEL_LIMITS) as (keyof SupervisorChannelLimits)[]) {
      const candidate = input[key];
      if (candidate === undefined) continue;
      if (!Number.isSafeInteger(candidate) || candidate <= 0) {
        throw new SupervisorProtocolError("invalid_frame");
      }
      result[key] = candidate;
    }
  }
  return Object.freeze(result);
}

function validBoundedString(value: unknown, limits: SupervisorChannelLimits): value is string {
  return typeof value === "string" && utf8Length(value) <= limits.maxStringBytes;
}

function validOpaqueId(value: unknown, limits: SupervisorChannelLimits): value is string {
  return validBoundedString(value, limits) && SAFE_ID_PATTERN.test(value);
}

function validStreamId(value: unknown, limits: SupervisorChannelLimits): value is string {
  return validBoundedString(value, limits) && SAFE_STREAM_PATTERN.test(value);
}

function validPeerAgentId(value: string): boolean {
  return value === "" || isCanonicalUuid(value);
}

function freezePlain<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => freezePlain(item))) as T;
  }
  if (typeof value === "object" && value !== null) {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) output[key] = freezePlain(item);
    return Object.freeze(output) as T;
  }
  return value;
}

function cloneJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (typeof value === "object" && value !== null) {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) output[key] = cloneJson(item);
    return output;
  }
  return value;
}

function frameError(code: SupervisorProtocolErrorCode): never {
  throw new SupervisorProtocolError(code);
}

function assertJsonBounds(
  value: unknown,
  limits: SupervisorChannelLimits,
  depth = 0,
  counter: { entries: number } = { entries: 0 },
): void {
  if (depth > limits.maxJsonDepth) frameError("invalid_frame");
  if (typeof value === "string") {
    if (!validBoundedString(value, limits)) frameError("frame_too_large");
    return;
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) return;
  if (Array.isArray(value)) {
    counter.entries += value.length;
    if (counter.entries > limits.maxJsonEntries) frameError("frame_too_large");
    for (const item of value) assertJsonBounds(item, limits, depth + 1, counter);
    return;
  }
  if (typeof value !== "object") frameError("invalid_frame");
  const object = value as Record<string, unknown>;
  const entries = Object.entries(object);
  counter.entries += entries.length;
  if (counter.entries > limits.maxJsonEntries) frameError("frame_too_large");
  for (const [key, item] of entries) {
    if (!validBoundedString(key, limits)) frameError("frame_too_large");
    assertJsonBounds(item, limits, depth + 1, counter);
  }
}

function parseFrameObject(value: unknown, limits: SupervisorChannelLimits): InternalFrame {
  if (typeof value !== "object" || value === null || Array.isArray(value)) frameError("invalid_frame");
  const candidate = value as Record<string, unknown>;
  if (candidate.protocol !== SUPERVISOR_PROTOCOL_VERSION) {
    if (typeof candidate.protocol === "string") frameError("protocol_mismatch");
    frameError("invalid_frame");
  }
  if (typeof candidate.kind !== "string" || !(SUPERVISOR_FRAME_KINDS as readonly string[]).includes(candidate.kind)) {
    frameError("invalid_frame");
  }
  if (!validStreamId(candidate.stream_id, limits)) frameError("invalid_frame");
  if (typeof candidate.sender_agent_id !== "string" || !validPeerAgentId(candidate.sender_agent_id)) {
    frameError("invalid_frame");
  }
  if (candidate.target_agent_id !== null && !isCanonicalUuid(candidate.target_agent_id)) {
    frameError("invalid_frame");
  }
  if (!Number.isSafeInteger(candidate.seq) || (candidate.seq as number) < 1) frameError("invalid_frame");
  if (hasOwn(candidate, "request_id") && candidate.request_id !== undefined && !validOpaqueId(candidate.request_id, limits)) {
    frameError("invalid_frame");
  }
  if (typeof candidate.payload !== "object" || candidate.payload === null || Array.isArray(candidate.payload)) {
    frameError("invalid_frame");
  }
  assertJsonBounds(candidate, limits);
  return Object.freeze({
    protocol: SUPERVISOR_PROTOCOL_VERSION,
    kind: candidate.kind as SupervisorFrameKind,
    stream_id: candidate.stream_id as string,
    sender_agent_id: candidate.sender_agent_id as string,
    target_agent_id: candidate.target_agent_id as string | null,
    seq: candidate.seq as number,
    ...(candidate.request_id === undefined ? {} : { request_id: candidate.request_id as string }),
    payload: freezePlain(cloneJson(candidate.payload) as Record<string, unknown>),
  });
}

/** 将控制帧编码为四字节大端长度前缀加 UTF-8 JSON。 */
export function encodeSupervisorFrame(
  frame: SupervisorFrame | unknown,
  suppliedLimits?: Partial<SupervisorChannelLimits>,
): Uint8Array {
  const limits = mergeLimits(suppliedLimits);
  const parsed = parseFrameObject(frame, limits);
  let body: Uint8Array;
  try {
    body = new TextEncoder().encode(JSON.stringify(parsed));
  } catch {
    frameError("invalid_json");
  }
  if (body.byteLength > limits.maxFrameBytes) frameError("frame_too_large");
  const encoded = new Uint8Array(body.byteLength + 4);
  new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength).setUint32(0, body.byteLength, false);
  encoded.set(body, 4);
  return encoded;
}

/** 解码一条完整的长度边界监督帧，不接受拼接或截断字节。 */
export function decodeSupervisorFrame(
  input: Uint8Array,
  suppliedLimits?: Partial<SupervisorChannelLimits>,
): SupervisorFrame {
  const limits = mergeLimits(suppliedLimits);
  if (!(input instanceof Uint8Array) || input.byteLength < 4) frameError("invalid_frame");
  const expected = new DataView(input.buffer, input.byteOffset, input.byteLength).getUint32(0, false);
  if (expected > limits.maxFrameBytes) frameError("frame_too_large");
  if (input.byteLength !== expected + 4) frameError("invalid_frame");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(input.subarray(4));
  } catch {
    frameError("invalid_utf8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    frameError("invalid_json");
  }
  return parseFrameObject(parsed, limits);
}

/** 支持可靠字节流任意分块送达的有界帧解码器。 */
export class SupervisorFrameDecoder {
  private readonly limits: SupervisorChannelLimits;
  private buffer = new Uint8Array(0);

  constructor(limits?: Partial<SupervisorChannelLimits>) {
    this.limits = mergeLimits(limits);
  }

  push(chunk: Uint8Array): readonly SupervisorFrame[] {
    if (!(chunk instanceof Uint8Array)) frameError("invalid_frame");
    if (chunk.byteLength + this.buffer.byteLength > this.limits.maxFrameBytes + 4) {
      frameError("frame_too_large");
    }
    const combined = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
    combined.set(this.buffer);
    combined.set(chunk, this.buffer.byteLength);
    this.buffer = combined;
    const frames: SupervisorFrame[] = [];
    let offset = 0;
    while (this.buffer.byteLength - offset >= 4) {
      const length = new DataView(this.buffer.buffer, this.buffer.byteOffset + offset, 4).getUint32(0, false);
      if (length > this.limits.maxFrameBytes) frameError("frame_too_large");
      if (this.buffer.byteLength - offset < length + 4) break;
      frames.push(decodeSupervisorFrame(this.buffer.subarray(offset, offset + length + 4), this.limits));
      offset += length + 4;
    }
    this.buffer = cloneBytes(this.buffer.subarray(offset));
    return Object.freeze(frames);
  }

  finish(): void {
    if (this.buffer.byteLength !== 0) frameError("invalid_frame");
  }
}

function normalizeCredential(value: string | Uint8Array): Uint8Array {
  if (typeof value === "string") {
    if (value.length === 0 || utf8Length(value) > SUPERVISOR_CHANNEL_LIMITS.maxStringBytes) {
      throw new SupervisorProtocolError("credential_mismatch");
    }
    return new TextEncoder().encode(value);
  }
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > SUPERVISOR_CHANNEL_LIMITS.maxStringBytes) {
    throw new SupervisorProtocolError("credential_mismatch");
  }
  return cloneBytes(value);
}

function credentialWireValue(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function credentialMatches(actual: unknown, expected: Uint8Array): boolean {
  if (typeof actual !== "string") return false;
  let received: Uint8Array;
  try {
    received = new Uint8Array(Buffer.from(actual, "base64url"));
  } catch {
    return false;
  }
  return received.byteLength === expected.byteLength && timingSafeEqual(received, expected);
}

function expectedTarget(localAgentId: string | null): string | null {
  return localAgentId;
}

function assertChannelOptions(options: SupervisorChannelOptions, limits: SupervisorChannelLimits): void {
  if (options.role !== "parent" && options.role !== "child") throw new SupervisorProtocolError("invalid_frame");
  if (!validOpaqueId(options.rootId, limits)) throw new SupervisorProtocolError("invalid_frame");
  if (options.localAgentId !== null && !isCanonicalUuid(options.localAgentId)) {
    throw new SupervisorProtocolError("identity_mismatch");
  }
  if (!validPeerAgentId(options.peerAgentId)) throw new SupervisorProtocolError("identity_mismatch");
  if (options.parentAgentId !== null && !isCanonicalUuid(options.parentAgentId)) {
    throw new SupervisorProtocolError("identity_mismatch");
  }
  if (!Number.isSafeInteger(options.depth) || options.depth < 1 || options.depth > limits.maxDepth) {
    throw new SupervisorProtocolError("identity_mismatch");
  }
  if (options.role === "child" && options.localAgentId === null) {
    throw new SupervisorProtocolError("identity_mismatch");
  }
}

function parseSnapshotNode(
  input: unknown,
  limits: SupervisorChannelLimits,
): AgentSnapshot {
  if (typeof input !== "object" || input === null || Array.isArray(input)) frameError("snapshot_invalid");
  const node = input as Record<string, unknown>;
  if (!isCanonicalUuid(node.agent_id)) frameError("snapshot_invalid");
  if (node.parent_agent_id !== null && !isCanonicalUuid(node.parent_agent_id)) frameError("snapshot_invalid");
  if (!validBoundedString(node.template_id, limits) || !validBoundedString(node.name, limits)) {
    frameError("snapshot_invalid");
  }
  if (!Number.isSafeInteger(node.depth) || (node.depth as number) < 1 || (node.depth as number) > limits.maxDepth) {
    frameError("snapshot_invalid");
  }
  if (typeof node.state !== "string" || !(AGENT_LIFECYCLE_STATES as readonly string[]).includes(node.state)) {
    frameError("snapshot_invalid");
  }
  if (!Number.isSafeInteger(node.pending_message_count) || (node.pending_message_count as number) < 0) {
    frameError("snapshot_invalid");
  }
  if (!Number.isSafeInteger(node.revision) || (node.revision as number) < 1) frameError("snapshot_invalid");
  if (typeof node.observed_at !== "string" || !RFC3339_MILLIS_PATTERN.test(node.observed_at)) {
    frameError("snapshot_invalid");
  }
  if (node.created_at !== undefined && (typeof node.created_at !== "string" || !RFC3339_MILLIS_PATTERN.test(node.created_at))) {
    frameError("snapshot_invalid");
  }
  if (node.lifecycle_elapsed_ms !== undefined && (
    !Number.isSafeInteger(node.lifecycle_elapsed_ms) || (node.lifecycle_elapsed_ms as number) < 0
  )) frameError("snapshot_invalid");
  const error = parseSafeFault(node.error, limits);
  const allowed = new Set([
    "agent_id",
    "parent_agent_id",
    "template_id",
    "name",
    "depth",
    "state",
    "pending_message_count",
    "revision",
    "observed_at",
    "created_at",
    "lifecycle_elapsed_ms",
    "error",
  ]);
  for (const key of Object.keys(node)) {
    // 快照只接收公开树字段，阻断正文、路径、端点、凭据和原始异常进入缓存。
    if (!allowed.has(key)) frameError("snapshot_invalid");
  }
  return Object.freeze({
    agent_id: node.agent_id,
    parent_agent_id: node.parent_agent_id,
    template_id: node.template_id,
    name: node.name,
    depth: node.depth as number,
    state: node.state as AgentLifecycleState,
    pending_message_count: node.pending_message_count as number,
    revision: node.revision as number,
    observed_at: node.observed_at as string,
    ...(node.created_at === undefined ? {} : { created_at: node.created_at as string }),
    ...(node.lifecycle_elapsed_ms === undefined ? {} : { lifecycle_elapsed_ms: node.lifecycle_elapsed_ms as number }),
    ...(error === undefined ? {} : { error }),
  });
}

function parseSafeFault(input: unknown, limits: SupervisorChannelLimits): AgentFault | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "object" || input === null || Array.isArray(input)) frameError("snapshot_invalid");
  const error = input as Record<string, unknown>;
  if (
    typeof error.code !== "string" ||
    !["spawn_failed", "spawn_timeout", "message_delivery_failed", "termination_incomplete", "internal_error"].includes(error.code) ||
    typeof error.message !== "string" ||
    !validBoundedString(error.message, limits) ||
    typeof error.retryable !== "boolean" ||
    typeof error.observed_at !== "string" ||
    !RFC3339_MILLIS_PATTERN.test(error.observed_at)
  ) frameError("snapshot_invalid");
  if (Object.keys(error).some((key) => !["code", "message", "retryable", "observed_at"].includes(key))) {
    frameError("snapshot_invalid");
  }
  return Object.freeze({
    code: error.code as AgentFault["code"],
    message: error.message,
    retryable: error.retryable,
    observed_at: error.observed_at,
  });
}

function parseSnapshot(
  payload: Record<string, unknown>,
  peerAgentId: string,
  parentAgentId: string | null,
  depth: number,
  limits: SupervisorChannelLimits,
): { readonly snapshot: SupervisorSnapshot; readonly reset: boolean } {
  if (!isCanonicalUuid(payload.scope_agent_id)) frameError("snapshot_invalid");
  if (payload.scope_agent_id !== peerAgentId) frameError("identity_mismatch");
  if (!Number.isSafeInteger(payload.subtree_revision) || (payload.subtree_revision as number) < 0) {
    frameError("snapshot_invalid");
  }
  if (!Array.isArray(payload.nodes) || payload.nodes.length === 0 || payload.nodes.length > limits.maxNodes) {
    frameError("snapshot_invalid");
  }
  if (payload.reset !== undefined && typeof payload.reset !== "boolean") frameError("snapshot_invalid");
  const allowed = new Set(["scope_agent_id", "subtree_revision", "nodes", "reset"]);
  if (Object.keys(payload).some((key) => !allowed.has(key))) frameError("snapshot_invalid");
  const nodes = payload.nodes.map((node) => parseSnapshotNode(node, limits));
  const ids = new Set<string>();
  const byId = new Map<string, AgentSnapshot>();
  for (const node of nodes) {
    if (ids.has(node.agent_id)) frameError("snapshot_invalid");
    ids.add(node.agent_id);
    byId.set(node.agent_id, node);
  }
  const scope = nodes[0];
  if (
    scope === undefined ||
    scope.agent_id !== peerAgentId ||
    scope.parent_agent_id !== parentAgentId ||
    scope.depth !== depth
  ) frameError("identity_mismatch");
  for (let index = 1; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    if (node.parent_agent_id === null) frameError("snapshot_invalid");
    const parent = byId.get(node.parent_agent_id);
    if (parent === undefined || node.depth !== parent.depth + 1) frameError("snapshot_invalid");
    // 父先顺序使同一安全快照的树关系可线性验证，也防止循环/孤儿节点。
    const parentIndex = nodes.findIndex((candidate) => candidate.agent_id === node.parent_agent_id);
    if (parentIndex < 0 || parentIndex >= index) frameError("snapshot_invalid");
  }
  return Object.freeze({
    snapshot: Object.freeze({
      scope_agent_id: peerAgentId,
      subtree_revision: payload.subtree_revision as number,
      nodes: Object.freeze(nodes),
    }),
    reset: payload.reset === true,
  });
}

function parseReply(payload: Record<string, unknown>, limits: SupervisorChannelLimits): SupervisorReply {
  if (!Number.isSafeInteger(payload.reply_seq) || (payload.reply_seq as number) < 1) frameError("reply_invalid");
  if (!validBoundedString(payload.text, limits)) frameError("reply_invalid");
  if (payload.images !== undefined && !Array.isArray(payload.images)) frameError("reply_invalid");
  const images = payload.images as unknown[] | undefined;
  if (images !== undefined && images.length > limits.maxImagesPerReply) frameError("reply_invalid");
  const parsedImages: SupervisorReplyImage[] = [];
  for (const image of images ?? []) {
    if (typeof image !== "object" || image === null || Array.isArray(image)) frameError("reply_invalid");
    const candidate = image as Record<string, unknown>;
    if (
      candidate.type !== "image" ||
      typeof candidate.data !== "string" ||
      typeof candidate.mimeType !== "string" ||
      !SAFE_MIME_PATTERN.test(candidate.mimeType) ||
      utf8Length(candidate.data) > limits.maxImageBytes ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(candidate.data) ||
      Object.keys(candidate).some((key) => key !== "type" && key !== "data" && key !== "mimeType")
    ) frameError("reply_invalid");
    parsedImages.push(Object.freeze({ type: "image", data: candidate.data, mimeType: candidate.mimeType }));
  }
  if (Object.keys(payload).some((key) => key !== "reply_seq" && key !== "text" && key !== "images")) {
    frameError("reply_invalid");
  }
  return Object.freeze({
    reply_seq: payload.reply_seq as number,
    text: payload.text as string,
    ...(parsedImages.length === 0 ? {} : { images: Object.freeze(parsedImages) }),
  });
}

function randomStreamId(): string {
  return `stream_${randomUUID().replaceAll("-", "")}`;
}

function randomRequestId(): string {
  return `req_${randomUUID().replaceAll("-", "")}`;
}

/**
 * 独立父子监督通道的协议端点。它只处理控制帧和安全快照；不拥有 RPC、
 * 模型上下文、UI、进程句柄或会话消息注入。
 */
export class SupervisorChannel {
  readonly role: SupervisorChannelRole;

  private readonly limits: SupervisorChannelLimits;
  private readonly rootId: string;
  private readonly localAgentId: string | null;
  private readonly peerAgentId: string;
  private readonly parentAgentId: string | null;
  private readonly depth: number;
  private readonly credential: Uint8Array;
  private readonly streamIdFactory: () => string;
  private readonly requestIdFactory: () => string;
  private readonly onReply: ((reply: SupervisorReply) => boolean) | undefined;
  private readonly outgoingStreamId: string;
  private readonly issuedRequestIds = new Set<string>();
  private readonly issuedRequestOrder: string[] = [];
  private readonly seenIncomingRequestIds = new Set<string>();
  private readonly seenIncomingRequestOrder: string[] = [];
  private readonly retiredIncomingStreams = new Set<string>();
  private readonly retiredIncomingOrder: string[] = [];
  private readonly outboundReplies = new Map<number, StoredReply>();
  private readonly bufferedReplies = new Map<number, SupervisorReply>();

  private state: SupervisorChannelState = "new";
  private sendSeq = 0;
  private incomingStreamId: string | undefined;
  private incomingLastSeq = 0;
  private pendingSnapshotRequest: PendingSnapshotRequest | undefined;
  private localSubtreeRevision = 0;
  private acceptedSubtreeRevision = -1;
  private treeRevision = 0;
  private latestSnapshot: readonly AgentSnapshot[] = EMPTY_NODES;
  private localLatestSnapshot: readonly AgentSnapshot[] = EMPTY_NODES;
  private nextReplySeq = 1;
  private nextExpectedReplySeq = 1;
  private highestReplyAck = 0;
  private terminationBarrier = false;

  constructor(options: SupervisorChannelOptions) {
    this.limits = mergeLimits(options.limits);
    assertChannelOptions(options, this.limits);
    this.role = options.role;
    this.rootId = options.rootId;
    this.localAgentId = options.localAgentId;
    this.peerAgentId = options.peerAgentId;
    this.parentAgentId = options.parentAgentId;
    this.depth = options.depth;
    this.credential = normalizeCredential(options.credential);
    this.streamIdFactory = options.streamIdFactory ?? randomStreamId;
    this.requestIdFactory = options.requestIdFactory ?? randomRequestId;
    this.onReply = options.onReply;
    const streamId = this.streamIdFactory();
    if (!validStreamId(streamId, this.limits)) throw new SupervisorProtocolError("invalid_frame");
    this.outgoingStreamId = streamId;
  }

  /** 发起方 child 的首帧。父端收到后自动产生 hello_ack。 */
  startHandshake(): SupervisorFrame {
    if (this.role !== "child" || this.state !== "new" || this.terminationBarrier) {
      throw new SupervisorProtocolError("closed");
    }
    const frame = this.createFrame("hello", {
      root_id: this.rootId,
      parent_agent_id: this.parentAgentId,
      depth: this.depth,
      credential: credentialWireValue(this.credential),
      subtree_revision: this.localSubtreeRevision,
    });
    this.state = "hello_sent";
    return frame;
  }

  /** 兼容更直观的调用名。 */
  hello(): SupervisorFrame {
    return this.startHandshake();
  }

  /**
   * child 只发布当前完整作用域快照。状态变化可覆盖尚未确认的旧快照，
   * 因为父端仅按 subtree_revision 原子替换缓存。
   */
  publishSnapshot(
    nodes: readonly AgentSnapshot[] | unknown,
    subtreeRevision?: number,
    options: { readonly reset?: boolean; readonly requestId?: string } = {},
  ): SupervisorFrame {
    if (this.role !== "child" || this.terminationBarrier || this.state === "closed" || this.state === "faulted") {
      throw new SupervisorProtocolError("closed");
    }
    const nextRevision = subtreeRevision ?? this.localSubtreeRevision + 1;
    if (!Number.isSafeInteger(nextRevision) || nextRevision < this.localSubtreeRevision) {
      throw new SupervisorProtocolError("snapshot_invalid");
    }
    const parsed = parseSnapshot({
      scope_agent_id: this.localAgentId,
      subtree_revision: nextRevision,
      nodes,
      ...(options.reset === undefined ? {} : { reset: options.reset }),
    }, this.localAgentId ?? "", this.parentAgentId, this.depth, this.limits);
    this.localSubtreeRevision = parsed.snapshot.subtree_revision;
    this.localLatestSnapshot = Object.freeze(parsed.snapshot.nodes.map((node) => freezePlain(cloneJson(node) as AgentSnapshot)));
    return this.createFrame("snapshot", {
      scope_agent_id: parsed.snapshot.scope_agent_id,
      subtree_revision: parsed.snapshot.subtree_revision,
      nodes: parsed.snapshot.nodes,
      ...(options.reset === true ? { reset: true } : {}),
    }, options.requestId);
  }

  snapshot(
    nodes: readonly AgentSnapshot[] | unknown,
    subtreeRevision?: number,
    options?: { readonly reset?: boolean; readonly requestId?: string },
  ): SupervisorFrame {
    return this.publishSnapshot(nodes, subtreeRevision, options);
  }

  /** child 仅能上行普通对话回复，不能夹带工具参数、结果或任意事件。 */
  publishReply(reply: Omit<SupervisorReply, "reply_seq"> | SupervisorReply): SupervisorFrame {
    if (this.role !== "child" || this.terminationBarrier || this.state !== "ready") {
      throw new SupervisorProtocolError("closed");
    }
    if (this.outboundReplies.size >= this.limits.maxReplyWindow) {
      throw new SupervisorProtocolError("reply_window_full");
    }
    const candidate = reply as Record<string, unknown>;
    const replySeq = candidate.reply_seq === undefined ? this.nextReplySeq : candidate.reply_seq;
    const parsed = parseReply({
      ...candidate,
      reply_seq: replySeq,
    }, this.limits);
    if (parsed.reply_seq !== this.nextReplySeq) throw new SupervisorProtocolError("reply_invalid");
    const frame = this.createFrame("reply", parsed as unknown as Record<string, unknown>);
    this.outboundReplies.set(parsed.reply_seq, { frame, reply: parsed });
    this.nextReplySeq += 1;
    return frame;
  }

  reply(reply: Omit<SupervisorReply, "reply_seq"> | SupervisorReply): SupervisorFrame {
    return this.publishReply(reply);
  }

  /** 显式建立终止屏障后，旧流和普通控制帧只会被丢弃。 */
  establishTerminationBarrier(): void {
    this.terminationBarrier = true;
    if (this.state !== "closed" && this.state !== "faulted") this.state = "closing";
  }

  /** 发送关闭通知前先由调用方建立本地终止屏障。 */
  createCloseFrame(): SupervisorFrame {
    if (!this.terminationBarrier || this.state === "closed" || this.state === "faulted") {
      throw new SupervisorProtocolError("closed");
    }
    return this.createFrame("close", { root_id: this.rootId });
  }

  /** 接收完整帧或其长度边界编码。所有失败只返回稳定分类。 */
  receive(input: SupervisorFrame | Uint8Array | unknown): SupervisorReceiveResult {
    if (input instanceof Uint8Array) {
      try {
        return this.receiveFrame(decodeSupervisorFrame(input, this.limits));
      } catch (error) {
        return this.protocolFault(error);
      }
    }
    try {
      return this.receiveFrame(parseFrameObject(input, this.limits));
    } catch (error) {
      return this.protocolFault(error);
    }
  }

  accept(input: SupervisorFrame | Uint8Array | unknown): SupervisorReceiveResult {
    return this.receive(input);
  }

  /** EOF 是通道事实，不携带底层 socket/pipe 错误。 */
  receiveEof(): SupervisorReceiveEof {
    if (this.state !== "faulted") this.state = "closed";
    return Object.freeze({ kind: "eof" });
  }

  eof(): SupervisorReceiveEof {
    return this.receiveEof();
  }

  /** 仅公开安全快照，不泄露凭据、端点、流 ID、序号或原始异常。 */
  getPublicState(): SupervisorChannelPublicState {
    return Object.freeze({
      state: this.state,
      tree_revision: this.treeRevision,
      subtree_revision: Math.max(0, this.acceptedSubtreeRevision),
      snapshot_node_count: this.latestSnapshot.length,
      pending_reply_count: this.outboundReplies.size + this.bufferedReplies.size,
      ...(this.state === "faulted" ? { fault: EMPTY_FAULT } : {}),
    });
  }

  /** 父端最近一次通过完整校验的子树；返回副本避免调用方改写缓存。 */
  getLatestSnapshot(): SupervisorSnapshot | undefined {
    if (this.latestSnapshot.length === 0 || this.acceptedSubtreeRevision < 0) return undefined;
    return Object.freeze({
      scope_agent_id: this.peerAgentId,
      subtree_revision: this.acceptedSubtreeRevision,
      nodes: Object.freeze(this.latestSnapshot.map((node) => freezePlain(cloneJson(node) as AgentSnapshot))),
    });
  }

  /** 供 TreeController 以单一临界区取得已合并的安全子树数据。 */
  getTreeSnapshot(): { readonly tree_revision: number; readonly nodes: readonly AgentSnapshot[] } {
    return Object.freeze({
      tree_revision: this.treeRevision,
      nodes: Object.freeze(this.latestSnapshot.map((node) => freezePlain(cloneJson(node) as AgentSnapshot))),
    });
  }

  /** 生产传输层可以调用此方法把帧写成长度边界字节。 */
  encode(frame: SupervisorFrame): Uint8Array {
    return encodeSupervisorFrame(frame, this.limits);
  }

  private receiveFrame(frame: InternalFrame): SupervisorReceiveResult {
    if (this.terminationBarrier) {
      return Object.freeze({ kind: "discarded", reason: "termination_barrier" });
    }
    if (this.state === "closed" || this.state === "faulted") {
      return Object.freeze({ kind: "discarded", reason: "closed" });
    }
    try {
      this.assertIdentity(frame);
      const streamResult = this.acceptSequence(frame);
      if (streamResult !== undefined) return streamResult;
      const result = this.applyFrame(frame);
      return result;
    } catch (error) {
      return this.protocolFault(error);
    }
  }

  private assertIdentity(frame: InternalFrame): void {
    if (frame.sender_agent_id !== this.peerAgentId || frame.target_agent_id !== expectedTarget(this.localAgentId)) {
      frameError("identity_mismatch");
    }
  }

  private acceptSequence(frame: InternalFrame): SupervisorReceiveResult | undefined {
    if (this.incomingStreamId === undefined) {
      const firstKind = this.role === "parent" ? "hello" : "hello_ack";
      if (frame.kind !== firstKind || frame.seq !== 1) frameError("sequence_violation");
      this.incomingStreamId = frame.stream_id;
      this.incomingLastSeq = 0;
    } else if (frame.stream_id !== this.incomingStreamId) {
      // 新流仅能在启动/有限重同步期且由新的握手建立；任何已退役流不回 ACK。
      if (this.retiredIncomingStreams.has(frame.stream_id) || this.state === "ready" || this.state === "resyncing") {
        return Object.freeze({ kind: "discarded", reason: "old_stream" });
      }
      if ((this.role === "parent" ? frame.kind !== "hello" : frame.kind !== "hello_ack") || frame.seq !== 1) {
        return Object.freeze({ kind: "discarded", reason: "old_stream" });
      }
      this.retireIncomingStream(this.incomingStreamId);
      this.incomingStreamId = frame.stream_id;
      this.incomingLastSeq = 0;
    }

    if (frame.seq <= this.incomingLastSeq) {
      return Object.freeze({
        kind: "duplicate",
        ack: this.incomingLastSeq,
        outbound: Object.freeze([this.createAckFrame(this.incomingLastSeq)]),
      });
    }
    if (
      this.pendingSnapshotRequest !== undefined &&
      frame.kind === "snapshot" &&
      frame.request_id === this.pendingSnapshotRequest.requestId
    ) {
      const parsed = parseSnapshot(frame.payload, this.peerAgentId, this.parentAgentId, this.depth, this.limits);
      if (parsed.reset !== true || frame.seq <= this.incomingLastSeq) frameError("sequence_violation");
      this.incomingLastSeq = frame.seq;
      // 保留挂起请求直到 applySnapshotFrame 完成原子替换；这样重置帧不会绕过
      // 普通快照的作用域、修订和缓存校验。
      return undefined;
    }
    if (frame.seq > this.incomingLastSeq + 1) {
      if (this.pendingSnapshotRequest !== undefined) {
        return Object.freeze({
          kind: "gap",
          ack: this.incomingLastSeq,
          request_id: this.pendingSnapshotRequest.requestId,
          outbound: EMPTY_FRAMES,
        });
      }
      const requestId = this.allocateRequestId();
      this.pendingSnapshotRequest = Object.freeze({ requestId });
      this.state = "resyncing";
      const request = this.createFrame("snapshot_request", {
        root_id: this.rootId,
        reset: true,
      }, requestId);
      return Object.freeze({
        kind: "gap",
        ack: this.incomingLastSeq,
        request_id: requestId,
        outbound: Object.freeze([request]),
      });
    }
    this.incomingLastSeq = frame.seq;
    return undefined;
  }

  private applyFrame(frame: InternalFrame): SupervisorReceiveResult {
    if (frame.request_id !== undefined) this.rememberIncomingRequestId(frame.request_id);
    let applied = false;
    let replies: readonly SupervisorReply[] = EMPTY_REPLIES;
    const outbound: SupervisorFrame[] = [];
    switch (frame.kind) {
      case "hello":
        this.applyHello(frame);
        outbound.push(this.createHelloAck());
        this.state = "awaiting_snapshot";
        break;
      case "hello_ack":
        this.applyHelloAck(frame);
        this.state = "awaiting_snapshot";
        break;
      case "snapshot":
        applied = this.applySnapshotFrame(frame);
        break;
      case "snapshot_request":
        outbound.push(this.applySnapshotRequest(frame));
        break;
      case "reply": {
        const result = this.applyReplyFrame(frame);
        replies = result.replies;
        if (result.ackReplySeq > 0) outbound.push(this.createReplyAck(result.ackReplySeq));
        break;
      }
      case "ack":
        this.applyAck(frame);
        break;
      case "event":
        this.applyEvent(frame);
        break;
      case "close":
        this.applyClose(frame);
        break;
    }
    // ACK 本身不再产生 ACK，避免双向确认形成无界回声；其他帧均确认最高连续序号。
    if (frame.kind !== "ack") outbound.push(this.createAckFrame(this.incomingLastSeq));
    return Object.freeze({
      kind: "accepted",
      ack: this.incomingLastSeq,
      applied,
      tree_revision: this.treeRevision,
      outbound: Object.freeze(outbound),
      replies,
    });
  }

  private applyHello(frame: InternalFrame): void {
    if (this.role !== "parent" || this.state !== "new") frameError("sequence_violation");
    const payload = frame.payload;
    if (!credentialMatches(payload.credential, this.credential)) frameError("credential_mismatch");
    if (
      payload.root_id !== this.rootId ||
      payload.parent_agent_id !== this.parentAgentId ||
      payload.depth !== this.depth ||
      !Number.isSafeInteger(payload.subtree_revision) ||
      (payload.subtree_revision as number) < 0
    ) frameError("identity_mismatch");
    const allowed = new Set(["root_id", "parent_agent_id", "depth", "credential", "subtree_revision"]);
    if (Object.keys(payload).some((key) => !allowed.has(key))) frameError("invalid_frame");
  }

  private createHelloAck(): SupervisorFrame {
    return this.createFrame("hello_ack", {
      root_id: this.rootId,
      agent_id: this.peerAgentId,
      parent_agent_id: this.parentAgentId,
      depth: this.depth,
      request_snapshot: true,
    });
  }

  private applyHelloAck(frame: InternalFrame): void {
    if (this.role !== "child" || this.state !== "hello_sent") frameError("sequence_violation");
    const payload = frame.payload;
    if (
      payload.root_id !== this.rootId ||
      payload.agent_id !== this.localAgentId ||
      payload.parent_agent_id !== this.parentAgentId ||
      payload.depth !== this.depth ||
      payload.request_snapshot !== true
    ) frameError("identity_mismatch");
    const allowed = new Set(["root_id", "agent_id", "parent_agent_id", "depth", "request_snapshot"]);
    if (Object.keys(payload).some((key) => !allowed.has(key))) frameError("invalid_frame");
  }

  private applySnapshotFrame(frame: InternalFrame): boolean {
    if (this.role !== "parent" || (this.state !== "awaiting_snapshot" && this.state !== "ready" && this.state !== "resyncing")) {
      frameError("sequence_violation");
    }
    const parsed = parseSnapshot(frame.payload, this.peerAgentId, this.parentAgentId, this.depth, this.limits);
    if (this.pendingSnapshotRequest !== undefined) {
      if (frame.request_id !== this.pendingSnapshotRequest.requestId || parsed.reset !== true) {
        frameError("sequence_violation");
      }
      this.pendingSnapshotRequest = undefined;
    } else if (parsed.reset === true && this.state !== "awaiting_snapshot") {
      frameError("sequence_violation");
    }
    if (parsed.snapshot.subtree_revision <= this.acceptedSubtreeRevision) {
      this.state = "ready";
      return false;
    }
    // 先完整验证，再一次性替换缓存并分配根侧 tree_revision。
    this.latestSnapshot = Object.freeze(parsed.snapshot.nodes.map((node) => freezePlain(cloneJson(node) as AgentSnapshot)));
    this.acceptedSubtreeRevision = parsed.snapshot.subtree_revision;
    this.treeRevision += 1;
    this.state = "ready";
    return true;
  }

  private applySnapshotRequest(frame: InternalFrame): SupervisorFrame {
    if (this.role !== "child" || typeof frame.request_id !== "string") frameError("sequence_violation");
    const payload = frame.payload;
    if (payload.root_id !== this.rootId || payload.reset !== true || Object.keys(payload).some((key) => key !== "root_id" && key !== "reset")) {
      frameError("identity_mismatch");
    }
    if (this.state === "closed" || this.state === "faulted" || this.terminationBarrier) frameError("closed");
    // 最新完整快照是唯一可重放状态；这里不会保留或重放事件历史。
    if (this.localSubtreeRevision < 0 || this.localLatestSnapshot.length === 0) frameError("snapshot_invalid");
    return this.publishSnapshot(this.localLatestSnapshot, this.localSubtreeRevision, {
      reset: true,
      requestId: frame.request_id,
    });
  }

  private applyReplyFrame(frame: InternalFrame): { readonly replies: readonly SupervisorReply[]; readonly ackReplySeq: number } {
    if (this.role !== "parent" || this.state !== "ready") frameError("sequence_violation");
    const reply = parseReply(frame.payload, this.limits);
    if (reply.reply_seq < this.nextExpectedReplySeq) {
      return Object.freeze({ replies: EMPTY_REPLIES, ackReplySeq: this.highestReplyAck });
    }
    if (reply.reply_seq > this.nextExpectedReplySeq) {
      if (this.bufferedReplies.size >= this.limits.maxReplyWindow || this.bufferedReplies.has(reply.reply_seq)) {
        frameError("reply_window_full");
      }
      this.bufferedReplies.set(reply.reply_seq, reply);
      return Object.freeze({ replies: EMPTY_REPLIES, ackReplySeq: this.highestReplyAck });
    }
    const delivered: SupervisorReply[] = [];
    let current: SupervisorReply | undefined = reply;
    while (current !== undefined) {
      let accepted = true;
      try {
        accepted = this.onReply?.(current) ?? true;
      } catch {
        accepted = false;
      }
      if (!accepted) frameError("reply_invalid");
      delivered.push(current);
      this.highestReplyAck = current.reply_seq;
      this.nextExpectedReplySeq += 1;
      current = this.bufferedReplies.get(this.nextExpectedReplySeq);
      if (current !== undefined) this.bufferedReplies.delete(this.nextExpectedReplySeq);
    }
    return Object.freeze({ replies: Object.freeze(delivered), ackReplySeq: this.highestReplyAck });
  }

  private applyAck(frame: InternalFrame): void {
    const payload = frame.payload;
    const kind = payload.kind;
    if (kind === "transport") {
      if (!Number.isSafeInteger(payload.seq) || (payload.seq as number) < 0) frameError("invalid_frame");
      if (Object.keys(payload).some((key) => key !== "kind" && key !== "seq")) frameError("invalid_frame");
      if (this.role === "child" && this.state === "awaiting_snapshot") this.state = "ready";
      return;
    }
    if (kind !== "reply" || !Number.isSafeInteger(payload.reply_seq) || (payload.reply_seq as number) < 0) {
      frameError("invalid_frame");
    }
    if (Object.keys(payload).some((key) => key !== "kind" && key !== "reply_seq")) frameError("invalid_frame");
    const acknowledged = payload.reply_seq as number;
    for (const replySeq of this.outboundReplies.keys()) {
      if (replySeq <= acknowledged) this.outboundReplies.delete(replySeq);
    }
  }

  private applyEvent(frame: InternalFrame): void {
    // 生命周期事件仅允许稳定代码，不允许把 RPC 细节、正文或参数混入快照。
    const payload = frame.payload;
    if (payload.root_id !== this.rootId || typeof payload.type !== "string" || !SAFE_ID_PATTERN.test(payload.type)) {
      frameError("invalid_frame");
    }
    if (Object.keys(payload).some((key) => key !== "root_id" && key !== "type" && key !== "error_code")) {
      frameError("invalid_frame");
    }
    if (payload.error_code !== undefined && ![
      "spawn_failed",
      "spawn_timeout",
      "message_delivery_failed",
      "termination_incomplete",
      "internal_error",
    ].includes(payload.error_code as string)) frameError("invalid_frame");
  }

  private applyClose(frame: InternalFrame): void {
    if (frame.payload.root_id !== this.rootId || Object.keys(frame.payload).some((key) => key !== "root_id")) {
      frameError("identity_mismatch");
    }
    this.state = "closing";
    this.terminationBarrier = true;
  }

  private createFrame(
    kind: SupervisorFrameKind,
    payload: Record<string, unknown>,
    requestId?: string,
  ): SupervisorFrame {
    if (this.sendSeq >= Number.MAX_SAFE_INTEGER) throw new SupervisorProtocolError("sequence_violation");
    const frame = parseFrameObject({
      protocol: SUPERVISOR_PROTOCOL_VERSION,
      kind,
      stream_id: this.outgoingStreamId,
      sender_agent_id: this.localAgentId ?? "",
      target_agent_id: this.peerAgentId === "" ? null : this.peerAgentId,
      seq: this.sendSeq + 1,
      ...(requestId === undefined ? {} : { request_id: requestId }),
      payload,
    }, this.limits);
    this.sendSeq += 1;
    return frame;
  }

  private createAckFrame(acknowledgedSeq: number): SupervisorFrame {
    return this.createFrame("ack", { kind: "transport", seq: acknowledgedSeq });
  }

  private createReplyAck(replySeq: number): SupervisorFrame {
    return this.createFrame("ack", { kind: "reply", reply_seq: replySeq });
  }

  private allocateRequestId(): string {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const id = this.requestIdFactory();
      if (!validOpaqueId(id, this.limits) || this.issuedRequestIds.has(id)) continue;
      this.rememberRequestId(this.issuedRequestIds, this.issuedRequestOrder, id);
      return id;
    }
    throw new SupervisorProtocolError("request_reused");
  }

  private rememberIncomingRequestId(requestId: string): void {
    if (this.seenIncomingRequestIds.has(requestId)) frameError("request_reused");
    this.rememberRequestId(this.seenIncomingRequestIds, this.seenIncomingRequestOrder, requestId);
  }

  private rememberRequestId(set: Set<string>, order: string[], requestId: string): void {
    set.add(requestId);
    order.push(requestId);
    while (order.length > this.limits.maxRecentRequestIds) {
      const oldest = order.shift();
      if (oldest !== undefined) set.delete(oldest);
    }
  }

  private retireIncomingStream(streamId: string): void {
    this.retiredIncomingStreams.add(streamId);
    this.retiredIncomingOrder.push(streamId);
    while (this.retiredIncomingOrder.length > this.limits.maxRetiredStreams) {
      const oldest = this.retiredIncomingOrder.shift();
      if (oldest !== undefined) this.retiredIncomingStreams.delete(oldest);
    }
  }

  private protocolFault(error: unknown): SupervisorReceiveFault {
    const code = error instanceof SupervisorProtocolError ? error.code : "invalid_frame";
    // 运行期协议故障不尝试恢复为 ready；调用方据此映射节点 failed/terminating。
    this.state = "faulted";
    return Object.freeze({ kind: "protocol_fault", error: code });
  }
}

export interface FakeSupervisorChannelOptions extends SupervisorChannelOptions {
  /** 允许测试以手工 pump 观察重复、乱序和损坏载荷。 */
  readonly autoDeliver?: boolean;
}

/**
 * 确定性内存替身。它模拟独立双向可靠字节流，不接触 Pi RPC、进程、socket、
 * 会话条目或模型上下文；测试可手工丢弃、重排或篡改单帧。
 */
export class FakeSupervisorChannel extends SupervisorChannel {
  private peer: FakeSupervisorChannel | undefined;
  private readonly outbox: Uint8Array[] = [];
  private readonly delivered: SupervisorReceiveResult[] = [];
  private readonly autoDeliver: boolean;

  constructor(options: FakeSupervisorChannelOptions) {
    super(options);
    this.autoDeliver = options.autoDeliver === true;
  }

  connect(peer: FakeSupervisorChannel): void {
    this.peer = peer;
  }

  send(frame: SupervisorFrame): void {
    this.outbox.push(this.encode(frame));
    if (this.autoDeliver) this.flush();
  }

  sendHello(): SupervisorFrame {
    const frame = this.startHandshake();
    this.send(frame);
    return frame;
  }

  sendSnapshot(
    nodes: readonly AgentSnapshot[] | unknown,
    subtreeRevision?: number,
    options?: { readonly reset?: boolean; readonly requestId?: string },
  ): SupervisorFrame {
    const frame = this.publishSnapshot(nodes, subtreeRevision, options);
    this.send(frame);
    return frame;
  }

  sendReply(reply: Omit<SupervisorReply, "reply_seq"> | SupervisorReply): SupervisorFrame {
    const frame = this.publishReply(reply);
    this.send(frame);
    return frame;
  }

  /** 交付一帧；接收方自动产生的 ACK/hello_ack/重同步响应会进入其 outbox。 */
  deliverNext(): SupervisorReceiveResult | undefined {
    const bytes = this.outbox.shift();
    if (bytes === undefined || this.peer === undefined) return undefined;
    const result = this.peer.receive(bytes);
    this.delivered.push(result);
    for (const frame of outboundFrames(result)) this.peer.send(frame);
    return result;
  }

  /** 连续 pump 到两端都没有待交付帧，固定上限避免错误协议造成无限循环。 */
  flush(maxFrames = 256): readonly SupervisorReceiveResult[] {
    const results: SupervisorReceiveResult[] = [];
    for (let count = 0; count < maxFrames; count += 1) {
      const result = this.deliverNext();
      if (result !== undefined) {
        results.push(result);
        continue;
      }
      const peer = this.peer;
      if (peer !== undefined && peer.outbox.length !== 0) {
        const peerResult = peer.deliverNext();
        if (peerResult !== undefined) {
          results.push(peerResult);
          continue;
        }
      }
      return Object.freeze(results);
    }
    throw new SupervisorProtocolError("sequence_violation");
  }

  pendingFrameCount(): number {
    return this.outbox.length;
  }

  takeNextFrame(): Uint8Array | undefined {
    const frame = this.outbox.shift();
    return frame === undefined ? undefined : cloneBytes(frame);
  }

  /** 直接注入字节，用于损坏 UTF-8、错误长度或身份篡改测试。 */
  inject(bytes: Uint8Array): SupervisorReceiveResult {
    const result = this.receive(bytes);
    this.delivered.push(result);
    for (const frame of outboundFrames(result)) this.send(frame);
    return result;
  }

  injectEof(): SupervisorReceiveEof {
    return this.receiveEof();
  }

  deliveredResults(): readonly SupervisorReceiveResult[] {
    return Object.freeze([...this.delivered]);
  }
}

function outboundFrames(result: SupervisorReceiveResult): readonly SupervisorFrame[] {
  if (result.kind === "accepted" || result.kind === "duplicate" || result.kind === "gap") return result.outbound;
  return EMPTY_FRAMES;
}

export interface FakeSupervisorChannelPair {
  readonly parent: FakeSupervisorChannel;
  readonly child: FakeSupervisorChannel;
  flush(maxFrames?: number): readonly SupervisorReceiveResult[];
}

export interface FakeSupervisorChannelPairOptions {
  readonly rootId?: string;
  readonly parentAgentId?: string | null;
  readonly childAgentId: string;
  readonly depth?: number;
  readonly credential?: string | Uint8Array;
  readonly limits?: Partial<SupervisorChannelLimits>;
  readonly onReply?: (reply: SupervisorReply) => boolean;
  readonly autoDeliver?: boolean;
}

/** 生成共享一次性凭据的父/子 fake 对，便于测试完整握手和乱序恢复。 */
export function createFakeSupervisorChannelPair(options: FakeSupervisorChannelPairOptions): FakeSupervisorChannelPair {
  const rootId = options.rootId ?? `root_${randomUUID().replaceAll("-", "")}`;
  const credential = options.credential ?? randomBytes(32);
  const parent = new FakeSupervisorChannel({
    role: "parent",
    rootId,
    localAgentId: options.parentAgentId ?? null,
    peerAgentId: options.childAgentId,
    parentAgentId: options.parentAgentId ?? null,
    depth: options.depth ?? 1,
    credential,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.autoDeliver === undefined ? {} : { autoDeliver: options.autoDeliver }),
    ...(options.onReply === undefined ? {} : { onReply: options.onReply }),
  });
  const child = new FakeSupervisorChannel({
    role: "child",
    rootId,
    localAgentId: options.childAgentId,
    peerAgentId: options.parentAgentId ?? "",
    parentAgentId: options.parentAgentId ?? null,
    depth: options.depth ?? 1,
    credential,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.autoDeliver === undefined ? {} : { autoDeliver: options.autoDeliver }),
  });
  parent.connect(child);
  child.connect(parent);
  return Object.freeze({
    parent,
    child,
    flush: (maxFrames?: number) => {
      const first = child.flush(maxFrames);
      const second = parent.flush(maxFrames);
      return Object.freeze([...first, ...second]);
    },
  });
}

/** 便于后续 RpcSupervisor 使用的同义工厂名。 */
export const createSupervisorChannelPair = createFakeSupervisorChannelPair;
