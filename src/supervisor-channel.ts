import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { parseAgentSnapshot as parseSafeAgentSnapshot } from "./agent-snapshot-codec.ts";
import {
  AGENT_LIFECYCLE_EVENT_TYPES,
  AGENT_LIFECYCLE_STATES,
  PUBLIC_ERROR_CODES,
  controlFailure,
  isCanonicalUuid,
  type AgentFault,
  type AgentLifecycleEventType,
  type AgentSnapshot,
  type PublicControlError,
  type PublicErrorCode,
} from "./tree-controller.ts";

/** 父子监督通道与 Pi 任务 RPC 完全隔离的固定协议版本。 */
export const SUPERVISOR_PROTOCOL_VERSION = "pi-subagent/2";

export const SUPERVISOR_FRAME_KINDS = Object.freeze([
  "hello",
  "hello_ack",
  "event",
  "snapshot_request",
  "snapshot",
  "reply",
  "control_request",
  "control_response",
  "ack",
  "close",
] as const);

export type SupervisorFrameKind = (typeof SUPERVISOR_FRAME_KINDS)[number];

const SUPERVISOR_FRAME_KEYS = new Set([
  "protocol",
  "kind",
  "stream_id",
  "sender_agent_id",
  "target_agent_id",
  "seq",
  "request_id",
  "payload",
]);

/**
 * 这些边界是实现常量而不是用户配额。它们限制单条本地控制流的内存，
 * 不能改变树的公开配额、等待或模型行为。
 */
export const SUPERVISOR_CHANNEL_LIMITS = Object.freeze({
  /** 可承载 8 张最大合法图片、最终文本及 JSON 转义后的完整监督帧。 */
  maxFrameBytes: 512 * 1024,
  maxStringBytes: 16 * 1024,
  /** 根权威向递归子控制器交付模板正文时使用的独立有界字符串预算。 */
  maxControlStringBytes: 64 * 1024,
  maxJsonDepth: 16,
  maxJsonEntries: 512,
  maxNodes: 64,
  maxReplyWindow: 32,
  maxRetiredStreams: 4,
  maxImagesPerReply: 8,
  /** 单张 Base64 图片解码后的字节上限。 */
  maxImageBytes: 24 * 1024,
  maxDepth: 8,
} as const);

export interface SupervisorChannelLimits {
  readonly maxFrameBytes: number;
  readonly maxStringBytes: number;
  readonly maxControlStringBytes: number;
  readonly maxJsonDepth: number;
  readonly maxJsonEntries: number;
  readonly maxNodes: number;
  readonly maxReplyWindow: number;
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

export type SupervisorReplyKind = "message" | "final";

export interface SupervisorReply {
  readonly reply_seq: number;
  readonly kind: SupervisorReplyKind;
  readonly text: string;
  readonly images?: readonly SupervisorReplyImage[];
}

/**
 * 公开发送入口仍兼容包内旧替身省略 kind 的调用；线上帧始终由
 * `parseReply()` 补齐并严格携带 kind。旧调用按最终回复处理。
 */
export type SupervisorReplyInput = Omit<SupervisorReply, "reply_seq" | "kind"> & {
  readonly kind?: SupervisorReplyKind;
};

/** 监督控制正文只允许可复制、可深冻结的纯 JSON 值。 */
export type SupervisorJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly SupervisorJsonValue[]
  | { readonly [key: string]: SupervisorJsonValue };

/** 子树控制请求允许进入父级路由器的内部操作闭集。 */
export const SUPERVISOR_CONTROL_OPERATIONS = Object.freeze([
  "list_templates",
  "resolve_template",
  "reserve_child",
  "admit_control",
  "begin_termination",
  "confirm_resources",
] as const);

export type SupervisorControlOperation = (typeof SUPERVISOR_CONTROL_OPERATIONS)[number];

/** child 沿唯一祖先方向上行的内部控制请求。 */
export interface SupervisorControlRequest {
  readonly operation_id: string;
  readonly operation: SupervisorControlOperation;
  readonly route: readonly string[];
  readonly body: SupervisorJsonValue;
}

/** parent 下行的内部控制结果不重复携带已由请求验证的 route。 */
export type SupervisorControlResponse =
  | {
      readonly operation_id: string;
      readonly ok: true;
      readonly data: SupervisorJsonValue;
    }
  | {
      readonly operation_id: string;
      readonly ok: false;
      readonly error: PublicControlError;
    };

/** 监督器向直接父/子控制器传播的脱敏生命周期事实。 */
export interface SupervisorEvent {
  readonly root_id: string;
  readonly agent_id: string;
  readonly type: AgentLifecycleEventType;
  readonly expected_generation?: number;
  readonly error_code?: AgentFault["code"];
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
  /** child 端本次收到的累计 reply ACK；仅用于传输适配器完成本地等待。 */
  readonly reply_ack?: number;
  /** 仅供本地监督器递交给 TreeController 的脱敏生命周期事实。 */
  readonly event?: SupervisorEvent;
  /** 本次接收原子替换的完整快照；调用方可直接交给树控制器。 */
  readonly snapshot?: SupervisorSnapshot;
  /** 本次通过身份、分支和正文边界校验的上行内部控制请求。 */
  readonly control_request?: SupervisorControlRequest;
  /** 本次通过公开结果外壳校验的下行内部控制响应。 */
  readonly control_response?: SupervisorControlResponse;
  /** 对端请求本端完成后代清理；传输层在清理完成前不得关闭字节流。 */
  readonly close_requested?: true;
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
  /** 同一活动根会话的全部监督通道必须共享这一分配器。 */
  readonly requestIdRegistry: SupervisorRequestIdRegistry;
  /** 父端在普通回复可安全注入会话后调用；返回 false 时不确认该回复。 */
  readonly onReply?: (reply: SupervisorReply) => boolean;
  /** EOF/断序后允许对端完成完整快照重同步的内部期限。 */
  readonly resyncTimeoutMs?: number;
  /** 重同步期限耗尽时的本地通知；不携带帧或底层错误。 */
  readonly onProtocolFault?: () => void;
}

interface InternalFrame extends SupervisorFrame<Record<string, unknown>> {}

interface PendingSnapshotRequest {
  readonly requestId: string;
}

interface StoredReply {
  readonly reply: SupervisorReply;
}

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_STREAM_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_MIME_PATTERN = /^image\/[a-z0-9.+-]+$/;
const RFC3339_MILLIS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const EMPTY_FAULT: SupervisorChannelFault = Object.freeze({ code: "internal_error" });
const EMPTY_NODES: readonly AgentSnapshot[] = Object.freeze([]);
const EMPTY_FRAMES: readonly SupervisorFrame[] = Object.freeze([]);
const EMPTY_REPLIES: readonly SupervisorReply[] = Object.freeze([]);
const PUBLIC_ERROR_CODE_SET: ReadonlySet<string> = new Set(PUBLIC_ERROR_CODES);
const CONTROL_SENSITIVE_FIELD_TOKENS = new Set([
  "prompt",
  "reply",
  "path",
  "filepath",
  "env",
  "environment",
  "endpoint",
  "credential",
  "credentials",
  "stack",
]);
const CONTROL_RESERVED_FIELD_NAMES = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "request_id",
]);

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function maxEncodedBase64Bytes(decodedBytes: number): number {
  return Math.ceil(decodedBytes / 3) * 4;
}

function maxFrameStringBytes(limits: SupervisorChannelLimits): number {
  return Math.max(
    limits.maxStringBytes,
    limits.maxControlStringBytes,
    maxEncodedBase64Bytes(limits.maxImageBytes),
  );
}

function validBase64(value: string): boolean {
  if (value.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if (padding > 0 && value.length % 4 !== 0) return false;
  if ((value.length - padding) % 4 === 1) return false;
  try {
    const normalized = padding > 0 ? value : value + "=".repeat((4 - (value.length % 4)) % 4);
    return Buffer.from(normalized, "base64").toString("base64").replace(/=+$/, "")
      === normalized.replace(/=+$/, "");
  } catch {
    return false;
  }
}

function decodedBase64Length(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.floor(value.length * 3 / 4) - padding;
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

function definePlainValue(output: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(output, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function freezePlain<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => freezePlain(item))) as T;
  }
  if (typeof value === "object" && value !== null) {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) definePlainValue(output, key, freezePlain(item));
    return Object.freeze(output) as T;
  }
  return value;
}

function cloneJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (typeof value === "object" && value !== null) {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) definePlainValue(output, key, cloneJson(item));
    return output;
  }
  return value;
}

function sameSnapshotNodes(left: readonly AgentSnapshot[], right: readonly AgentSnapshot[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function frameError(code: SupervisorProtocolErrorCode): never {
  throw new SupervisorProtocolError(code);
}

function plainJsonEntries(value: unknown): readonly (readonly [string, unknown])[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) frameError("invalid_frame");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) frameError("invalid_frame");
  const entries: Array<readonly [string, unknown]> = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") frameError("invalid_frame");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !hasOwn(descriptor, "value")) {
      frameError("invalid_frame");
    }
    entries.push(Object.freeze([key, descriptor.value] as const));
  }
  return entries;
}

function asPlainJsonRecord(value: unknown): Record<string, unknown> {
  plainJsonEntries(value);
  return value as Record<string, unknown>;
}

function assertJsonBounds(
  value: unknown,
  limits: SupervisorChannelLimits,
  maxStringBytes = limits.maxStringBytes,
  depth = 0,
  counter: { entries: number } = { entries: 0 },
  ancestors: Set<object> = new Set(),
): void {
  if (depth > limits.maxJsonDepth) frameError("invalid_frame");
  if (typeof value === "string") {
    if (utf8Length(value) > maxStringBytes) frameError("frame_too_large");
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
    if (ancestors.has(value)) frameError("invalid_frame");
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.some((key) => typeof key !== "string") ||
      ownKeys.length !== value.length + 1 ||
      !ownKeys.includes("length")
    ) frameError("invalid_frame");
    ancestors.add(value);
    try {
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !descriptor.enumerable || !hasOwn(descriptor, "value")) {
          frameError("invalid_frame");
        }
        assertJsonBounds(descriptor.value, limits, maxStringBytes, depth + 1, counter, ancestors);
      }
    } finally {
      ancestors.delete(value);
    }
    return;
  }
  const object = value as object;
  if (ancestors.has(object)) frameError("invalid_frame");
  const entries = plainJsonEntries(object);
  counter.entries += entries.length;
  if (counter.entries > limits.maxJsonEntries) frameError("frame_too_large");
  ancestors.add(object);
  try {
    for (const [key, item] of entries) {
      if (!validBoundedString(key, limits)) frameError("frame_too_large");
      assertJsonBounds(item, limits, maxStringBytes, depth + 1, counter, ancestors);
    }
  } finally {
    ancestors.delete(object);
  }
}

function hasExactObjectKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
}

function isForbiddenControlFieldName(key: string): boolean {
  const lower = key.toLowerCase();
  if (CONTROL_RESERVED_FIELD_NAMES.has(lower)) return true;
  const snakeCase = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  const normalized = snakeCase.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (CONTROL_RESERVED_FIELD_NAMES.has(normalized)) return true;
  return normalized.split("_").some((token) => CONTROL_SENSITIVE_FIELD_TOKENS.has(token));
}

function assertNoSensitiveControlFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoSensitiveControlFields(item);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, item] of plainJsonEntries(value)) {
    if (isForbiddenControlFieldName(key)) frameError("invalid_frame");
    assertNoSensitiveControlFields(item);
  }
}

function parseControlJson(value: unknown, limits: SupervisorChannelLimits): SupervisorJsonValue {
  assertJsonBounds(value, limits, limits.maxControlStringBytes);
  assertNoSensitiveControlFields(value);
  return freezePlain(cloneJson(value)) as SupervisorJsonValue;
}

function parseControlRoute(
  value: unknown,
  expectedRouteRoot: string,
  snapshot: readonly AgentSnapshot[],
  limits: SupervisorChannelLimits,
): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > limits.maxDepth) frameError("invalid_frame");
  assertJsonBounds(value, limits);
  const route = value.map((agentId) => {
    if (!isCanonicalUuid(agentId)) frameError("invalid_frame");
    return agentId;
  });
  if (route[0] !== expectedRouteRoot) frameError("identity_mismatch");
  const nodesById = new Map(snapshot.map((node) => [node.agent_id, node] as const));
  for (let index = 1; index < route.length; index += 1) {
    const node = nodesById.get(route[index]!);
    if (node === undefined || node.parent_agent_id !== route[index - 1]) frameError("identity_mismatch");
  }
  return Object.freeze(route);
}

function parseControlRequest(
  value: unknown,
  expectedRouteRoot: string,
  snapshot: readonly AgentSnapshot[],
  limits: SupervisorChannelLimits,
): SupervisorControlRequest {
  const request = asPlainJsonRecord(value);
  if (!hasExactObjectKeys(request, ["operation_id", "operation", "route", "body"])) {
    frameError("invalid_frame");
  }
  if (!validOpaqueId(request.operation_id, limits)) frameError("invalid_frame");
  if (
    typeof request.operation !== "string" ||
    !(SUPERVISOR_CONTROL_OPERATIONS as readonly string[]).includes(request.operation)
  ) frameError("invalid_frame");
  const route = parseControlRoute(request.route, expectedRouteRoot, snapshot, limits);
  const body = parseControlJson(request.body, limits);
  return Object.freeze({
    operation_id: request.operation_id,
    operation: request.operation as SupervisorControlOperation,
    route,
    body,
  });
}

function parsePublicControlError(value: unknown, limits: SupervisorChannelLimits): PublicControlError {
  const error = asPlainJsonRecord(value);
  if (!hasExactObjectKeys(error, ["code", "message", "retryable", "details"])) frameError("invalid_frame");
  if (
    typeof error.code !== "string" ||
    !PUBLIC_ERROR_CODE_SET.has(error.code) ||
    !validBoundedString(error.message, limits) ||
    typeof error.retryable !== "boolean"
  ) frameError("invalid_frame");
  const details = asPlainJsonRecord(error.details);
  if (Object.keys(details).length !== 0) frameError("invalid_frame");
  return Object.freeze({
    code: error.code as PublicErrorCode,
    message: error.message,
    retryable: error.retryable,
    details: Object.freeze({}),
  });
}

function parseControlResponse(value: unknown, limits: SupervisorChannelLimits): SupervisorControlResponse {
  const response = asPlainJsonRecord(value);
  if (!validOpaqueId(response.operation_id, limits)) frameError("invalid_frame");
  if (response.ok === true) {
    if (!hasExactObjectKeys(response, ["operation_id", "ok", "data"])) frameError("invalid_frame");
    return Object.freeze({
      operation_id: response.operation_id,
      ok: true,
      data: parseControlJson(response.data, limits),
    });
  }
  if (response.ok !== false || !hasExactObjectKeys(response, ["operation_id", "ok", "error"])) {
    frameError("invalid_frame");
  }
  return Object.freeze({
    operation_id: response.operation_id,
    ok: false,
    error: parsePublicControlError(response.error, limits),
  });
}

function parseFrameObject(value: unknown, limits: SupervisorChannelLimits): InternalFrame {
  if (typeof value !== "object" || value === null || Array.isArray(value)) frameError("invalid_frame");
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => !SUPERVISOR_FRAME_KEYS.has(key))) frameError("invalid_frame");
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
  assertJsonBounds(candidate, limits, maxFrameStringBytes(limits));
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
    const frames: SupervisorFrame[] = [];
    let offset = 0;
    while (offset < chunk.byteLength || this.buffer.byteLength !== 0) {
      if (this.buffer.byteLength !== 0) {
        if (this.buffer.byteLength < 4) {
          const headerBytes = Math.min(4 - this.buffer.byteLength, chunk.byteLength - offset);
          if (headerBytes === 0) break;
          this.appendBufferedBytes(chunk.subarray(offset, offset + headerBytes));
          offset += headerBytes;
          if (this.buffer.byteLength < 4) break;
        }
        const length = new DataView(this.buffer.buffer, this.buffer.byteOffset, 4).getUint32(0, false);
        if (length > this.limits.maxFrameBytes) frameError("frame_too_large");
        const frameBytes = length + 4;
        const bodyBytes = Math.min(frameBytes - this.buffer.byteLength, chunk.byteLength - offset);
        if (bodyBytes > 0) {
          this.appendBufferedBytes(chunk.subarray(offset, offset + bodyBytes));
          offset += bodyBytes;
        }
        if (this.buffer.byteLength < frameBytes) break;
        frames.push(decodeSupervisorFrame(this.buffer, this.limits));
        this.buffer = new Uint8Array(0);
        continue;
      }

      if (chunk.byteLength - offset < 4) {
        this.buffer = cloneBytes(chunk.subarray(offset));
        break;
      }
      const length = new DataView(chunk.buffer, chunk.byteOffset + offset, 4).getUint32(0, false);
      if (length > this.limits.maxFrameBytes) frameError("frame_too_large");
      const frameBytes = length + 4;
      if (chunk.byteLength - offset < frameBytes) {
        this.buffer = cloneBytes(chunk.subarray(offset));
        break;
      }
      frames.push(decodeSupervisorFrame(chunk.subarray(offset, offset + frameBytes), this.limits));
      offset += frameBytes;
    }
    return Object.freeze(frames);
  }

  finish(): void {
    if (this.buffer.byteLength !== 0) frameError("invalid_frame");
  }

  /** buffer 只保存一条尚未完整的帧，避免大 read chunk 造成额外聚合上限。 */
  private appendBufferedBytes(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    const combined = new Uint8Array(this.buffer.byteLength + bytes.byteLength);
    combined.set(this.buffer);
    combined.set(bytes, this.buffer.byteLength);
    this.buffer = combined;
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
  if (!(options.requestIdRegistry instanceof SupervisorRequestIdRegistry)) {
    throw new SupervisorProtocolError("invalid_frame");
  }
}

function parseSnapshotNode(
  input: unknown,
  limits: SupervisorChannelLimits,
): AgentSnapshot {
  const parsed = parseSafeAgentSnapshot(input, {
    maxDepth: limits.maxDepth,
    maxStringBytes: limits.maxStringBytes,
  });
  if (parsed === undefined) frameError("snapshot_invalid");
  return parsed;
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
  if (payload.kind !== "message" && payload.kind !== "final") frameError("reply_invalid");
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
      !validBase64(candidate.data) ||
      decodedBase64Length(candidate.data) > limits.maxImageBytes ||
      Object.keys(candidate).some((key) => key !== "type" && key !== "data" && key !== "mimeType")
    ) frameError("reply_invalid");
    parsedImages.push(Object.freeze({ type: "image", data: candidate.data, mimeType: candidate.mimeType }));
  }
  if (payload.kind === "message" && (payload.text as string).trim().length === 0 && parsedImages.length === 0) {
    frameError("reply_invalid");
  }
  if (Object.keys(payload).some((key) => key !== "reply_seq" && key !== "kind" && key !== "text" && key !== "images")) {
    frameError("reply_invalid");
  }
  return Object.freeze({
    reply_seq: payload.reply_seq as number,
    kind: payload.kind as SupervisorReplyKind,
    text: payload.text as string,
    ...(parsedImages.length === 0 ? {} : { images: Object.freeze(parsedImages) }),
  });
}

function randomStreamId(): string {
  return `stream_${randomUUID().replaceAll("-", "")}`;
}

/**
 * 根控制器为其活动根会话创建且只创建一个此分配器，再交给全部直接父子通道。
 * 随机会话前缀不暴露树关系，单调尾号使整个根内无需保存历史集合也绝不复用。
 */
export class SupervisorRequestIdRegistry {
  private readonly sessionPrefix = `r${randomUUID().replaceAll("-", "")}`;
  private nextOrdinal = 1;

  allocate(): string {
    if (this.nextOrdinal > Number.MAX_SAFE_INTEGER) throw new SupervisorProtocolError("request_reused");
    const requestId = `req_${this.sessionPrefix}_${this.nextOrdinal.toString(36)}`;
    this.nextOrdinal += 1;
    return requestId;
  }
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
  private readonly requestIdRegistry: SupervisorRequestIdRegistry;
  private readonly onReply: ((reply: SupervisorReply) => boolean) | undefined;
  private readonly resyncTimeoutMs: number;
  private readonly onProtocolFault: (() => void) | undefined;
  private resyncTimer: ReturnType<typeof setTimeout> | undefined;
  private outgoingStreamId: string;
  private readonly retiredIncomingStreams = new Set<string>();
  private readonly retiredIncomingOrder: string[] = [];
  private readonly outboundReplies = new Map<number, StoredReply>();
  private readonly bufferedReplies = new Map<number, SupervisorReply>();

  private state: SupervisorChannelState = "new";
  private sendSeq = 0;
  private incomingStreamId: string | undefined;
  private incomingLastSeq = 0;
  private pendingSnapshotRequest: PendingSnapshotRequest | undefined;
  private awaitingInitialSnapshotAckSeq: number | undefined;
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
    this.requestIdRegistry = options.requestIdRegistry;
    this.onReply = options.onReply;
    this.resyncTimeoutMs = Number.isSafeInteger(options.resyncTimeoutMs) && (options.resyncTimeoutMs as number) > 0
      ? options.resyncTimeoutMs as number
      : 5_000;
    this.onProtocolFault = options.onProtocolFault;
    this.outgoingStreamId = this.allocateStreamId();
  }

  /** 发起方 child 的首帧。父端收到后自动产生 hello_ack。 */
  startHandshake(): SupervisorFrame {
    if (
      this.role !== "child" ||
      (this.state !== "new" && this.state !== "resyncing") ||
      this.terminationBarrier
    ) {
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

  /**
   * child 只发布当前完整作用域快照。状态变化可覆盖尚未确认的旧快照，
   * 因为父端仅按 subtree_revision 原子替换缓存。
   */
  publishSnapshot(
    nodes: readonly AgentSnapshot[] | unknown,
    subtreeRevision?: number,
  ): SupervisorFrame {
    return this.createSnapshotFrame(nodes, subtreeRevision);
  }

  private createSnapshotFrame(
    nodes: readonly AgentSnapshot[] | unknown,
    subtreeRevision: number | undefined,
    resetRequestId?: string,
  ): SupervisorFrame {
    if (
      this.role !== "child" ||
      this.terminationBarrier ||
      (this.state !== "awaiting_snapshot" && this.state !== "ready")
    ) throw new SupervisorProtocolError("closed");
    const nextRevision = subtreeRevision ?? this.localSubtreeRevision + 1;
    if (!Number.isSafeInteger(nextRevision) || nextRevision < this.localSubtreeRevision) {
      throw new SupervisorProtocolError("snapshot_invalid");
    }
    const parsed = parseSnapshot({
      scope_agent_id: this.localAgentId,
      subtree_revision: nextRevision,
      nodes,
      ...(resetRequestId === undefined ? {} : { reset: true }),
    }, this.localAgentId ?? "", this.parentAgentId, this.depth, this.limits);
    if (
      nextRevision === this.localSubtreeRevision
      && resetRequestId === undefined
      && (this.state !== "awaiting_snapshot" || !sameSnapshotNodes(parsed.snapshot.nodes, this.localLatestSnapshot))
    ) throw new SupervisorProtocolError("snapshot_invalid");
    this.localSubtreeRevision = parsed.snapshot.subtree_revision;
    this.localLatestSnapshot = Object.freeze(parsed.snapshot.nodes.map((node) => freezePlain(cloneJson(node) as AgentSnapshot)));
    const frame = this.createFrame("snapshot", {
      scope_agent_id: parsed.snapshot.scope_agent_id,
      subtree_revision: parsed.snapshot.subtree_revision,
      nodes: parsed.snapshot.nodes,
      ...(resetRequestId === undefined ? {} : { reset: true }),
    }, resetRequestId);
    if (this.state === "awaiting_snapshot") this.awaitingInitialSnapshotAckSeq = frame.seq;
    return frame;
  }

  /** child 仅能上行分类对话回复，不能夹带工具参数、结果或任意事件。 */
  publishReply(reply: SupervisorReplyInput | SupervisorReply): SupervisorFrame {
    if (this.role !== "child" || this.terminationBarrier || this.state !== "ready") {
      throw new SupervisorProtocolError("closed");
    }
    const candidate = reply as Record<string, unknown>;
    const replySeq = candidate.reply_seq === undefined ? this.nextReplySeq : candidate.reply_seq;
    const kind = candidate.kind === undefined ? "final" : candidate.kind;
    const messageWindow = Math.max(0, this.limits.maxReplyWindow - 1);
    if (kind === "message" && this.outboundReplies.size >= messageWindow) {
      throw new SupervisorProtocolError("reply_window_full");
    }
    if (kind === "final" && this.outboundReplies.size >= this.limits.maxReplyWindow) {
      throw new SupervisorProtocolError("reply_window_full");
    }
    const parsed = parseReply({
      ...candidate,
      kind,
      reply_seq: replySeq,
    }, this.limits);
    if (parsed.reply_seq !== this.nextReplySeq) throw new SupervisorProtocolError("reply_invalid");
    const frame = this.createFrame("reply", parsed as unknown as Record<string, unknown>);
    this.outboundReplies.set(parsed.reply_seq, { reply: parsed });
    this.nextReplySeq += 1;
    return frame;
  }

  /** child 发布已绑定自身分支的内部控制请求；operation_id 不占用监督 request_id。 */
  publishControlRequest(request: SupervisorControlRequest): SupervisorFrame {
    if (
      this.role !== "child" ||
      this.localAgentId === null ||
      this.terminationBarrier ||
      this.state !== "ready"
    ) throw new SupervisorProtocolError("closed");
    const parsed = parseControlRequest(request, this.localAgentId, this.localLatestSnapshot, this.limits);
    return this.createFrame("control_request", parsed as unknown as Record<string, unknown>);
  }

  /** parent 发布固定成功/失败外壳；响应不携带 route 或监督 request_id。 */
  publishControlResponse(response: SupervisorControlResponse): SupervisorFrame {
    if (this.role !== "parent" || this.terminationBarrier || this.state !== "ready") {
      throw new SupervisorProtocolError("closed");
    }
    const parsed = parseControlResponse(response, this.limits);
    return this.createFrame("control_response", parsed as unknown as Record<string, unknown>);
  }

  /**
   * 发布经过归一化的生命周期事实。正文、工具参数/结果和底层异常没有对应
   * 字段，因而无法通过该 API 进入监督通道。
   */
  publishEvent(event: Omit<SupervisorEvent, "root_id" | "agent_id"> & {
    readonly agent_id?: string;
  } | SupervisorEvent): SupervisorFrame {
    if (this.terminationBarrier || this.state === "closed" || this.state === "faulted") {
      throw new SupervisorProtocolError("closed");
    }
    const candidate = event as Record<string, unknown>;
    const agentId = candidate.agent_id ?? this.localAgentId;
    if (!isCanonicalUuid(agentId)) throw new SupervisorProtocolError("identity_mismatch");
    const payload: Record<string, unknown> = {
      root_id: this.rootId,
      agent_id: agentId,
      type: candidate.type,
      ...(candidate.expected_generation === undefined ? {} : { expected_generation: candidate.expected_generation }),
      ...(candidate.error_code === undefined ? {} : { error_code: candidate.error_code }),
    };
    this.parseEventPayload(payload);
    return this.createFrame("event", payload);
  }

  /** 主动请求对端发送当前完整快照；正常断序由 receive 自动调用同一语义。 */
  requestSnapshot(): SupervisorFrame {
    if (this.role !== "parent" || this.terminationBarrier || this.state !== "ready") {
      throw new SupervisorProtocolError("closed");
    }
    return this.beginSnapshotRequest();
  }

  /**
   * 父会话重新可用后重试尚未注入的连续回复。只有本轮确实推进 reply_seq
   * 才返回新的累计 ACK；回复正文始终保留在有界窗口内直至接纳成功。
   */
  retryPendingReplies(): SupervisorFrame | undefined {
    if (this.role !== "parent" || this.terminationBarrier || this.state !== "ready") {
      throw new SupervisorProtocolError("closed");
    }
    const previousAck = this.highestReplyAck;
    const result = this.deliverBufferedReplies();
    return result.ackReplySeq === previousAck
      ? undefined
      : this.createReplyAck(result.ackReplySeq);
  }

  /** 显式建立终止屏障后，旧流和普通控制帧只会被丢弃。 */
  establishTerminationBarrier(): void {
    this.terminationBarrier = true;
    this.clearResyncTimeout();
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

  /**
   * EOF 不携带底层 socket/pipe 错误。未被上层裁决为失败时保留一个有限的
   * 重连窗口；新流必须重新握手并发送完整快照，终止和协议故障则不可恢复。
   */
  receiveEof(): SupervisorReceiveEof {
    if (this.terminationBarrier) {
      this.clearResyncTimeout();
      this.state = "closed";
    } else if (this.state !== "faulted" && this.state !== "closed") {
      this.beginReconnect();
    }
    return Object.freeze({ kind: "eof" });
  }

  /** 传输解码器在收到截断/损坏字节时使用；不携带底层错误正文。 */
  markProtocolFault(): void {
    if (this.state !== "closed") {
      this.clearResyncTimeout();
      this.state = "faulted";
      this.notifyProtocolFault();
    }
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
      if (this.retiredIncomingStreams.has(frame.stream_id)) {
        return Object.freeze({ kind: "discarded", reason: "old_stream" });
      }
      const firstKind = this.role === "parent" ? "hello" : "hello_ack";
      const acceptsNewStream = this.role === "parent"
        ? this.state === "new" || this.state === "resyncing"
        : this.state === "hello_sent";
      if (!acceptsNewStream || frame.kind !== firstKind || frame.seq !== 1) frameError("sequence_violation");
      this.incomingStreamId = frame.stream_id;
      this.incomingLastSeq = 0;
    } else if (frame.stream_id !== this.incomingStreamId) {
      // 只有 EOF 明确开启有限重连窗口后才会清空当前流；活跃连接中的新流
      // 不能越过终止屏障或当前快照重同步，直接当作旧流丢弃。
      return Object.freeze({ kind: "discarded", reason: "old_stream" });
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
      const request = this.beginSnapshotRequest();
      const requestId = request.request_id;
      if (requestId === undefined) frameError("invalid_frame");
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
    if (frame.kind !== "snapshot" && frame.kind !== "snapshot_request" && frame.request_id !== undefined) {
      frameError("invalid_frame");
    }
    let applied = false;
    let replies: readonly SupervisorReply[] = EMPTY_REPLIES;
    let replyAck: number | undefined;
    let event: SupervisorEvent | undefined;
    let controlRequest: SupervisorControlRequest | undefined;
    let controlResponse: SupervisorControlResponse | undefined;
    let closeRequested = false;
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
      case "control_request":
        if (this.role !== "parent" || this.state !== "ready") frameError("sequence_violation");
        controlRequest = parseControlRequest(frame.payload, this.peerAgentId, this.latestSnapshot, this.limits);
        break;
      case "control_response":
        if (this.role !== "child" || this.state !== "ready") frameError("sequence_violation");
        controlResponse = parseControlResponse(frame.payload, this.limits);
        break;
      case "ack":
        {
          const result = this.applyAck(frame);
          outbound.push(...result.outbound);
          replyAck = result.replyAck;
        }
        break;
      case "event":
        event = this.applyEvent(frame);
        break;
      case "close":
        this.applyClose(frame);
        closeRequested = true;
        break;
    }
    // close 由接收端完成后代清理并关闭字节流作为受控确认，不能提前 ACK。
    if (frame.kind !== "ack" && frame.kind !== "close") {
      outbound.push(this.createAckFrame(this.incomingLastSeq));
    }
    const acceptedSnapshot = frame.kind === "snapshot" && applied ? this.getLatestSnapshot() : undefined;
    return Object.freeze({
      kind: "accepted",
      ack: this.incomingLastSeq,
      applied,
      tree_revision: this.treeRevision,
      outbound: Object.freeze(outbound),
      replies,
      ...(replyAck === undefined ? {} : { reply_ack: replyAck }),
      ...(event === undefined ? {} : { event }),
      ...(acceptedSnapshot === undefined ? {} : { snapshot: acceptedSnapshot }),
      ...(controlRequest === undefined ? {} : { control_request: controlRequest }),
      ...(controlResponse === undefined ? {} : { control_response: controlResponse }),
      ...(closeRequested ? { close_requested: true as const } : {}),
    });
  }

  private applyHello(frame: InternalFrame): void {
    if (this.role !== "parent" || (this.state !== "new" && this.state !== "resyncing")) {
      frameError("sequence_violation");
    }
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
    } else if (parsed.reset === true || frame.request_id !== undefined) {
      frameError("sequence_violation");
    }
    if (parsed.snapshot.subtree_revision <= this.acceptedSubtreeRevision) {
      this.state = "ready";
      this.clearResyncTimeout();
      return false;
    }
    // 先完整验证，再一次性替换缓存并分配根侧 tree_revision。
    this.latestSnapshot = Object.freeze(parsed.snapshot.nodes.map((node) => freezePlain(cloneJson(node) as AgentSnapshot)));
    this.acceptedSubtreeRevision = parsed.snapshot.subtree_revision;
    this.treeRevision += 1;
    this.state = "ready";
    this.clearResyncTimeout();
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
    return this.createSnapshotFrame(this.localLatestSnapshot, this.localSubtreeRevision, frame.request_id);
  }

  private applyReplyFrame(frame: InternalFrame): { readonly replies: readonly SupervisorReply[]; readonly ackReplySeq: number } {
    if (this.role !== "parent" || this.state !== "ready") frameError("sequence_violation");
    const reply = parseReply(frame.payload, this.limits);
    if (reply.reply_seq < this.nextExpectedReplySeq) {
      return Object.freeze({ replies: EMPTY_REPLIES, ackReplySeq: this.highestReplyAck });
    }
    if (!this.bufferedReplies.has(reply.reply_seq) && this.bufferedReplies.size >= this.limits.maxReplyWindow) {
      frameError("reply_window_full");
    }
    this.bufferedReplies.set(reply.reply_seq, reply);
    return this.deliverBufferedReplies();
  }

  private deliverBufferedReplies(): { readonly replies: readonly SupervisorReply[]; readonly ackReplySeq: number } {
    const delivered: SupervisorReply[] = [];
    let current = this.bufferedReplies.get(this.nextExpectedReplySeq);
    while (current !== undefined) {
      let accepted = true;
      try {
        accepted = this.onReply?.(current) ?? true;
      } catch {
        accepted = false;
      }
      // 注入失败时保留当前 reply；传输 ACK 仍可推进，但 reply ACK 必须等待
      // 当前或 reload 后的新父会话真正接纳正文。
      if (!accepted) break;
      this.bufferedReplies.delete(current.reply_seq);
      delivered.push(current);
      this.highestReplyAck = current.reply_seq;
      this.nextExpectedReplySeq += 1;
      current = this.bufferedReplies.get(this.nextExpectedReplySeq);
    }
    return Object.freeze({ replies: Object.freeze(delivered), ackReplySeq: this.highestReplyAck });
  }

  private applyAck(frame: InternalFrame): {
    readonly outbound: readonly SupervisorFrame[];
    readonly replyAck?: number;
  } {
    const payload = frame.payload;
    const kind = payload.kind;
    if (kind === "transport") {
      if (!Number.isSafeInteger(payload.seq) || (payload.seq as number) < 0) frameError("invalid_frame");
      if (Object.keys(payload).some((key) => key !== "kind" && key !== "seq")) frameError("invalid_frame");
      const acknowledged = payload.seq as number;
      if (acknowledged > this.sendSeq) frameError("sequence_violation");
      if (
        this.role === "child" &&
        this.state === "awaiting_snapshot" &&
        this.awaitingInitialSnapshotAckSeq !== undefined &&
        acknowledged >= this.awaitingInitialSnapshotAckSeq
      ) {
        this.awaitingInitialSnapshotAckSeq = undefined;
        this.state = "ready";
        return Object.freeze({ outbound: this.replayUnacknowledgedReplies() });
      }
      return Object.freeze({ outbound: EMPTY_FRAMES });
    }
    if (kind !== "reply" || !Number.isSafeInteger(payload.reply_seq) || (payload.reply_seq as number) < 0) {
      frameError("invalid_frame");
    }
    if (Object.keys(payload).some((key) => key !== "kind" && key !== "reply_seq")) frameError("invalid_frame");
    if (this.role !== "child") frameError("sequence_violation");
    const acknowledged = payload.reply_seq as number;
    if (acknowledged > this.nextReplySeq - 1) frameError("reply_invalid");
    for (const replySeq of this.outboundReplies.keys()) {
      if (replySeq <= acknowledged) this.outboundReplies.delete(replySeq);
    }
    return Object.freeze({ outbound: EMPTY_FRAMES, replyAck: acknowledged });
  }

  private applyEvent(frame: InternalFrame): SupervisorEvent {
    // 生命周期事件仅允许稳定代码，不允许把 RPC 细节、正文或参数混入快照。
    return this.parseEventPayload(frame.payload);
  }

  private parseEventPayload(payload: Record<string, unknown>): SupervisorEvent {
    if (
      payload.root_id !== this.rootId ||
      !isCanonicalUuid(payload.agent_id) ||
      typeof payload.type !== "string" ||
      !(AGENT_LIFECYCLE_EVENT_TYPES as readonly string[]).includes(payload.type)
    ) frameError("invalid_frame");
    if (
      payload.expected_generation !== undefined &&
      (!Number.isSafeInteger(payload.expected_generation) || (payload.expected_generation as number) < 0)
    ) frameError("invalid_frame");
    if (!this.eventAgentIsInScope(payload.agent_id as string)) frameError("identity_mismatch");
    if (Object.keys(payload).some((key) => !["root_id", "agent_id", "type", "expected_generation", "error_code"].includes(key))) {
      frameError("invalid_frame");
    }
    if (payload.error_code !== undefined && ![
      "spawn_failed",
      "spawn_timeout",
      "message_delivery_failed",
      "termination_incomplete",
      "internal_error",
    ].includes(payload.error_code as string)) frameError("invalid_frame");
    return Object.freeze({
      root_id: this.rootId,
      agent_id: payload.agent_id as string,
      type: payload.type as AgentLifecycleEventType,
      ...(payload.expected_generation === undefined
        ? {}
        : { expected_generation: payload.expected_generation as number }),
      ...(payload.error_code === undefined
        ? {}
        : { error_code: payload.error_code as AgentFault["code"] }),
    });
  }

  private eventAgentIsInScope(agentId: string): boolean {
    if (this.role === "parent") {
      if (agentId === this.peerAgentId) return true;
      return this.latestSnapshot.some((node) => node.agent_id === agentId);
    }
    if (agentId === this.localAgentId) return true;
    return this.localLatestSnapshot.some((node) => node.agent_id === agentId);
  }

  private applyClose(frame: InternalFrame): void {
    if (frame.payload.root_id !== this.rootId || Object.keys(frame.payload).some((key) => key !== "root_id")) {
      frameError("identity_mismatch");
    }
    this.state = "closing";
    this.terminationBarrier = true;
    this.clearResyncTimeout();
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

  private beginSnapshotRequest(): SupervisorFrame {
    if (this.role !== "parent" || this.pendingSnapshotRequest !== undefined) {
      throw new SupervisorProtocolError("sequence_violation");
    }
    const requestId = this.allocateRequestId();
    this.pendingSnapshotRequest = Object.freeze({ requestId });
    this.state = "resyncing";
    this.scheduleResyncTimeout();
    return this.createFrame("snapshot_request", {
      root_id: this.rootId,
      reset: true,
    }, requestId);
  }

  private allocateRequestId(): string {
    const requestId = this.requestIdRegistry.allocate();
    if (!validOpaqueId(requestId, this.limits)) throw new SupervisorProtocolError("request_reused");
    return requestId;
  }

  private allocateStreamId(): string {
    const streamId = this.streamIdFactory();
    if (!validStreamId(streamId, this.limits)) throw new SupervisorProtocolError("invalid_frame");
    return streamId;
  }

  private replayUnacknowledgedReplies(): readonly SupervisorFrame[] {
    const replayed = Array.from(this.outboundReplies.values(), ({ reply }) => {
      return this.createFrame("reply", reply as unknown as Record<string, unknown>);
    });
    return Object.freeze(replayed);
  }

  private beginReconnect(): void {
    if (this.incomingStreamId !== undefined && !this.retireIncomingStream(this.incomingStreamId)) {
      // 旧流集合不淘汰，达到固定窗口后不再接受任何可能被回放的流。
      this.state = "closed";
      return;
    }
    this.incomingStreamId = undefined;
    this.incomingLastSeq = 0;
    this.pendingSnapshotRequest = undefined;
    this.awaitingInitialSnapshotAckSeq = undefined;
    this.sendSeq = 0;
    this.outgoingStreamId = this.allocateStreamId();
    this.state = "resyncing";
    this.scheduleResyncTimeout();
  }

  private scheduleResyncTimeout(): void {
    if (this.resyncTimer !== undefined) clearTimeout(this.resyncTimer);
    const timer = setTimeout(() => {
      this.resyncTimer = undefined;
      if (this.state === "resyncing" || this.state === "awaiting_snapshot") {
        this.state = "faulted";
        this.notifyProtocolFault();
      }
    }, this.resyncTimeoutMs);
    timer.unref?.();
    this.resyncTimer = timer;
  }

  private clearResyncTimeout(): void {
    if (this.resyncTimer === undefined) return;
    clearTimeout(this.resyncTimer);
    this.resyncTimer = undefined;
  }

  private retireIncomingStream(streamId: string): boolean {
    if (this.retiredIncomingStreams.has(streamId)) return true;
    if (this.retiredIncomingOrder.length >= this.limits.maxRetiredStreams) return false;
    this.retiredIncomingStreams.add(streamId);
    this.retiredIncomingOrder.push(streamId);
    return true;
  }

  private protocolFault(error: unknown): SupervisorReceiveFault {
    const code = error instanceof SupervisorProtocolError ? error.code : "invalid_frame";
    // 运行期协议故障不尝试恢复为 ready；调用方据此映射节点 failed/terminating。
    this.clearResyncTimeout();
    this.state = "faulted";
    this.notifyProtocolFault();
    return Object.freeze({ kind: "protocol_fault", error: code });
  }

  private notifyProtocolFault(): void {
    try {
      this.onProtocolFault?.();
    } catch {
      // 协议观察者不能改变已完成的故障裁决。
    }
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
  ): SupervisorFrame {
    const frame = this.publishSnapshot(nodes, subtreeRevision);
    this.send(frame);
    return frame;
  }

  sendReply(reply: SupervisorReplyInput | SupervisorReply): SupervisorFrame {
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
    this.outbox.length = 0;
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
  readonly requestIdRegistry?: SupervisorRequestIdRegistry;
  readonly onReply?: (reply: SupervisorReply) => boolean;
  readonly autoDeliver?: boolean;
}

/** 生成共享一次性凭据的父/子 fake 对，便于测试完整握手和乱序恢复。 */
export function createFakeSupervisorChannelPair(options: FakeSupervisorChannelPairOptions): FakeSupervisorChannelPair {
  const rootId = options.rootId ?? `root_${randomUUID().replaceAll("-", "")}`;
  const credential = options.credential ?? randomBytes(32);
  const requestIdRegistry = options.requestIdRegistry ?? new SupervisorRequestIdRegistry();
  const parent = new FakeSupervisorChannel({
    role: "parent",
    rootId,
    localAgentId: options.parentAgentId ?? null,
    peerAgentId: options.childAgentId,
    parentAgentId: options.parentAgentId ?? null,
    depth: options.depth ?? 1,
    credential,
    requestIdRegistry,
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
    requestIdRegistry,
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
