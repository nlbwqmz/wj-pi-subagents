import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { parseAgentSnapshot as parseSafeAgentSnapshot } from "./agent-snapshot-codec.ts";
import {
  parseChildReplyEnvelope,
  type ChildReplyEnvelope,
} from "./child-reply-envelope.ts";
import { REPLY_MAX_TEXT_BYTES } from "./child-reply-limits.ts";
import {
  hasStartupDiagnosticDetails,
  isCanonicalStartupDiagnosticDetails,
  normalizeStartupDiagnosticDetails,
  type StartupDiagnosticDetails,
} from "./startup-diagnostic.ts";
import {
  AGENT_FAULT_CODES,
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
export const SUPERVISOR_PROTOCOL_VERSION = "wj-pi-subagents/18";

export const SUPERVISOR_FRAME_KINDS = Object.freeze([
  "hello",
  "hello_ack",
  "event",
  "snapshot_request",
  "snapshot",
  "capability",
  "reply",
  "control_request",
  "control_response",
  "close",
] as const);

/** 旧 kind 仅供清理旧实例的内部 switch，公共 parser 不接受。 */
export type SupervisorFrameKind = (typeof SUPERVISOR_FRAME_KINDS)[number];

const LEGACY_SUPERVISOR_FRAME_KINDS = new Set([
  "task_assignment",
  "task_started",
  "ack",
]);

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
  /** 覆盖最大控制正文、完整快照及 JSON 转义后的监督帧。 */
  maxFrameBytes: 512 * 1024,
  /** 身份、快照等普通监督字段沿用原有字符串预算。 */
  maxStringBytes: 16 * 1024,
  /** 根权威向递归子控制器交付模板正文时使用的独立有界字符串预算。 */
  maxControlStringBytes: 64 * 1024,
  maxJsonDepth: 16,
  maxJsonEntries: 512,
  maxNodes: 64,
  maxRetiredStreams: 4,
  maxDepth: 8,
} as const);

export interface SupervisorChannelLimits {
  readonly maxFrameBytes: number;
  readonly maxStringBytes: number;
  readonly maxControlStringBytes: number;
  readonly maxJsonDepth: number;
  readonly maxJsonEntries: number;
  readonly maxNodes: number;
  readonly maxRetiredStreams: number;
  readonly maxDepth: number;
}

/** capability manifest 的独立边界，避免工具目录占用通用控制帧预算。 */
export const SUPERVISOR_CAPABILITY_LIMITS = Object.freeze({
  maxToolsPerCategory: 128,
  maxSystemToolSources: 128,
  maxToolNameBytes: 128,
  maxSourceBytes: 512,
  maxProviderBytes: 128,
  maxModelBytes: 512,
  maxThinkingBytes: 32,
  maxSelfExtensionPathBytes: 4 * 1024,
} as const);

/** child 在普通 ready 后至多一次上报的内部运行时能力快照。 */
export interface SupervisorCapabilityManifest {
  readonly protocol_version: typeof SUPERVISOR_PROTOCOL_VERSION;
  readonly business_active_tools: readonly string[];
  readonly system_active_tools: readonly string[];
  readonly system_tool_sources: Readonly<Record<string, string>>;
  readonly provider?: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly self_extension_path?: string;
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

export type SupervisorReplyKind = ChildReplyEnvelope["kind"];

/** 新 wire reply 只携带一个会话信封；底层帧 `seq` 不属于消息语义。 */
export type SupervisorReply = ChildReplyEnvelope;

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
  /** 失败生命周期事件的严格、可复制诊断闭集。 */
  readonly error_details?: StartupDiagnosticDetails;
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
  readonly fault?: SupervisorChannelFault;
}

export interface SupervisorReceiveAccepted {
  readonly kind: "accepted";
  readonly applied: boolean;
  readonly tree_revision: number;
  readonly outbound: readonly SupervisorFrame[];
  readonly replies: readonly SupervisorReply[];
  /** parent 端原子缓存的 child capability manifest；不进入公开状态。 */
  readonly capability?: SupervisorCapabilityManifest;
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
  readonly outbound: readonly SupervisorFrame[];
}

export interface SupervisorReceiveGap {
  readonly kind: "gap";
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
  /** 父端把普通回复同步提交给 Pi 扩展消息 API 后返回结果。 */
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

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_STREAM_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_CAPABILITY_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+/-]*$/;
const SAFE_CAPABILITY_SYNTHETIC_SOURCE_PATTERN = /^<[A-Za-z0-9][A-Za-z0-9._:@+/-]*>$/;
const SAFE_CAPABILITY_PATH_PATTERN = /^(?:[A-Za-z]:)?[A-Za-z0-9._:@+~/\\-]+$/;
const CAPABILITY_THINKING_LEVELS: ReadonlySet<string> = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const CAPABILITY_RESERVED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
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

function maxFrameStringBytes(limits: SupervisorChannelLimits): number {
  return Math.max(
    limits.maxStringBytes,
    REPLY_MAX_TEXT_BYTES,
    limits.maxControlStringBytes,
  );
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

function validCapabilityToken(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string"
    && utf8Length(value) <= maxBytes
    && SAFE_CAPABILITY_TOKEN_PATTERN.test(value)
    && !CAPABILITY_RESERVED_TOOL_NAMES.has(value)
  );
}

function validCapabilityPath(
  value: unknown,
  maxBytes = SUPERVISOR_CAPABILITY_LIMITS.maxSelfExtensionPathBytes,
): value is string {
  if (
    typeof value !== "string"
    || utf8Length(value) > maxBytes
    || !SAFE_CAPABILITY_PATH_PATTERN.test(value)
    || value.startsWith("//")
    || value.startsWith("\\\\")
  ) return false;
  return !value.split(/[\\/]+/).some((segment) => segment === "." || segment === "..");
}

function validCapabilitySource(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.includes("/") || value.includes("\\")) {
    return validCapabilityPath(value, SUPERVISOR_CAPABILITY_LIMITS.maxSourceBytes);
  }
  return (
    validCapabilityToken(value, SUPERVISOR_CAPABILITY_LIMITS.maxSourceBytes)
    || (
      utf8Length(value) <= SUPERVISOR_CAPABILITY_LIMITS.maxSourceBytes
      && SAFE_CAPABILITY_SYNTHETIC_SOURCE_PATTERN.test(value)
    )
  );
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
  const code = error.code as PublicErrorCode;
  const canonical = controlFailure(code, details).error;
  const canonicalDetails = canonical.details as Readonly<Record<string, unknown>>;
  const detailKeys = Object.keys(details);
  const canonicalDetailKeys = Object.keys(canonicalDetails);
  if (
    detailKeys.length !== canonicalDetailKeys.length
    || detailKeys.some((key) => details[key] !== canonicalDetails[key])
  ) frameError("invalid_frame");
  // 只接受当前协议的规范字段；不兼容旧描述、伪造 retryable 或越界诊断字段。
  if (error.message !== canonical.message || error.retryable !== canonical.retryable) frameError("invalid_frame");
  return canonical;
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
  if (typeof candidate.kind !== "string") {
    frameError("invalid_frame");
  }
  if (LEGACY_SUPERVISOR_FRAME_KINDS.has(candidate.kind)) frameError("protocol_mismatch");
  if (!(SUPERVISOR_FRAME_KINDS as readonly string[]).includes(candidate.kind)) frameError("invalid_frame");
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

function parseReply(payload: Record<string, unknown>): SupervisorReply {
  // clean-break：reply payload 就是信封本身。reply_seq、envelope 包装和任何
  // 未知字段都由信封闭集解析拒绝，不再建立应用序号或确认窗口。
  const envelope = parseChildReplyEnvelope(payload, {
    maxTextBytes: REPLY_MAX_TEXT_BYTES,
  });
  if (envelope === undefined) {
    // 旧任务/回合/提交信封必须明确归类为 clean-break 协议不匹配，
    // 普通新协议字段错误仍保持 reply_invalid，便于区分输入损坏。
    if (
      payload.schema === "wj-pi-subagents.reply"
      || payload.kind === "final"
      || hasOwn(payload, "task_id")
      || hasOwn(payload, "turn_id")
      || hasOwn(payload, "commit_id")
      || hasOwn(payload, "reply_seq")
      || hasOwn(payload, "envelope")
    ) frameError("protocol_mismatch");
    frameError("reply_invalid");
  }
  return envelope;
}

function parseCapabilityTools(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > SUPERVISOR_CAPABILITY_LIMITS.maxToolsPerCategory) {
    frameError("invalid_frame");
  }
  const tools: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!validCapabilityToken(item, SUPERVISOR_CAPABILITY_LIMITS.maxToolNameBytes)) {
      frameError("invalid_frame");
    }
    if (seen.has(item)) continue;
    seen.add(item);
    tools.push(item);
  }
  return Object.freeze(tools);
}

function parseCapabilityManifest(
  value: unknown,
  limits: SupervisorChannelLimits,
): SupervisorCapabilityManifest {
  assertJsonBounds(value, limits);
  const manifest = asPlainJsonRecord(value);
  const allowed = new Set([
    "protocol_version",
    "business_active_tools",
    "system_active_tools",
    "system_tool_sources",
    "provider",
    "model",
    "thinking",
    "self_extension_path",
  ]);
  if (
    Object.keys(manifest).some((key) => !allowed.has(key))
    || !hasOwn(manifest, "protocol_version")
    || !hasOwn(manifest, "business_active_tools")
    || !hasOwn(manifest, "system_active_tools")
    || !hasOwn(manifest, "system_tool_sources")
  ) frameError("invalid_frame");
  if (manifest.protocol_version !== SUPERVISOR_PROTOCOL_VERSION) frameError("protocol_mismatch");

  const businessActiveTools = parseCapabilityTools(manifest.business_active_tools);
  const systemActiveTools = parseCapabilityTools(manifest.system_active_tools);
  const systemToolSet = new Set(systemActiveTools);
  if (businessActiveTools.some((tool) => systemToolSet.has(tool))) frameError("invalid_frame");

  const sourceRecord = asPlainJsonRecord(manifest.system_tool_sources);
  const sourceEntries = plainJsonEntries(sourceRecord);
  if (sourceEntries.length > SUPERVISOR_CAPABILITY_LIMITS.maxSystemToolSources) {
    frameError("invalid_frame");
  }
  const systemToolSources: Record<string, string> = {};
  for (const [tool, source] of sourceEntries) {
    if (
      !validCapabilityToken(tool, SUPERVISOR_CAPABILITY_LIMITS.maxToolNameBytes)
      || !systemToolSet.has(tool)
      || !validCapabilitySource(source)
    ) frameError("invalid_frame");
    definePlainValue(systemToolSources, tool, source);
  }

  if (
    (manifest.provider !== undefined
      && !validCapabilityToken(manifest.provider, SUPERVISOR_CAPABILITY_LIMITS.maxProviderBytes))
    || (manifest.model !== undefined
      && !validCapabilityToken(manifest.model, SUPERVISOR_CAPABILITY_LIMITS.maxModelBytes))
    || (manifest.thinking !== undefined
      && (
        typeof manifest.thinking !== "string"
        || utf8Length(manifest.thinking) > SUPERVISOR_CAPABILITY_LIMITS.maxThinkingBytes
        || !CAPABILITY_THINKING_LEVELS.has(manifest.thinking)
      ))
    || (manifest.self_extension_path !== undefined && !validCapabilityPath(manifest.self_extension_path))
  ) frameError("invalid_frame");

  return freezePlain({
    protocol_version: SUPERVISOR_PROTOCOL_VERSION,
    business_active_tools: businessActiveTools,
    system_active_tools: systemActiveTools,
    system_tool_sources: Object.freeze(systemToolSources),
    ...(manifest.provider === undefined ? {} : { provider: manifest.provider }),
    ...(manifest.model === undefined ? {} : { model: manifest.model }),
    ...(manifest.thinking === undefined ? {} : { thinking: manifest.thinking }),
    ...(manifest.self_extension_path === undefined
      ? {}
      : { self_extension_path: manifest.self_extension_path }),
  }) as SupervisorCapabilityManifest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  // 新协议不保存应用消息正文、序号、窗口或去重集合；每帧在接收临界区
  // 同步交给 onReply，返回即表示该层已完成提交裁决。

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
  private capabilityPublished = false;
  private capability: SupervisorCapabilityManifest | undefined;
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
    // 快照写入本地发送队列即完成握手，不等待 transport/app ACK。
    if (this.state === "awaiting_snapshot") this.state = "ready";
    return frame;
  }

  /** child 仅能上行经过统一 codec 校验的结构化回复信封。 */
  publishReply(reply: SupervisorReply): SupervisorFrame {
    if (this.role !== "child" || this.terminationBarrier || this.state !== "ready") {
      throw new SupervisorProtocolError("closed");
    }
    const envelope = parseChildReplyEnvelope(reply, {
      maxTextBytes: REPLY_MAX_TEXT_BYTES,
    });
    if (envelope === undefined) throw new SupervisorProtocolError("reply_invalid");
    if (envelope.agent_id !== this.localAgentId) {
      throw new SupervisorProtocolError("identity_mismatch");
    }
    // request_id 只用于父端同步返回扩展消息提交结果，不进入消息信封，也不承担
    // 应用去重、排序、窗口或重放语义。
    return this.createFrame(
      "reply",
      envelope as unknown as Record<string, unknown>,
      this.allocateRequestId(),
    );
  }

  /** child 仅在普通 ready 后发布一次固定的内部能力快照。 */
  publishCapability(manifest: SupervisorCapabilityManifest): SupervisorFrame {
    if (
      this.role !== "child"
      || this.terminationBarrier
      || this.state !== "ready"
      || this.capabilityPublished
    ) throw new SupervisorProtocolError("closed");
    const parsed = parseCapabilityManifest(manifest, this.limits);
    this.capabilityPublished = true;
    return this.createFrame("capability", parsed as unknown as Record<string, unknown>);
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
      ...(candidate.error_details === undefined ? {} : { error_details: candidate.error_details }),
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

  /** parent 最近一次通过严格校验的 capability manifest；返回副本避免改写缓存。 */
  getCapability(): SupervisorCapabilityManifest | undefined {
    if (this.capability === undefined) return undefined;
    return freezePlain(cloneJson(this.capability)) as SupervisorCapabilityManifest;
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
        outbound: EMPTY_FRAMES,
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
          request_id: this.pendingSnapshotRequest.requestId,
          outbound: EMPTY_FRAMES,
        });
      }
      const request = this.beginSnapshotRequest();
      const requestId = request.request_id;
      if (requestId === undefined) frameError("invalid_frame");
      return Object.freeze({
        kind: "gap",
        request_id: requestId,
        outbound: Object.freeze([request]),
      });
    }
    this.incomingLastSeq = frame.seq;
    return undefined;
  }

  private applyFrame(frame: InternalFrame): SupervisorReceiveResult {
    if (
      frame.kind !== "snapshot"
      && frame.kind !== "snapshot_request"
      && frame.kind !== "reply"
      && frame.request_id !== undefined
    ) {
      frameError("invalid_frame");
    }
    let applied = false;
    let replies: readonly SupervisorReply[] = EMPTY_REPLIES;
    let capability: SupervisorCapabilityManifest | undefined;
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
      case "capability":
        if (this.role !== "parent" || this.state !== "ready" || this.capability !== undefined) {
          frameError("sequence_violation");
        }
        capability = parseCapabilityManifest(frame.payload, this.limits);
        this.capability = capability;
        applied = true;
        break;
      case "reply": {
        const replyResult = this.applyReplyFrame(frame);
        replies = replyResult.accepted
          ? Object.freeze([replyResult.reply])
          : EMPTY_REPLIES;
        if (frame.request_id !== undefined) {
          outbound.push(this.createReplyDispatchResponse(frame.request_id, replyResult.accepted));
        }
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
      case "event":
        event = this.applyEvent(frame);
        break;
      case "close":
        this.applyClose(frame);
        closeRequested = true;
        break;
    }
    // 不发送 transport/application ACK；帧 seq 仅用于本地断序检测。
    const acceptedSnapshot = frame.kind === "snapshot" && applied ? this.getLatestSnapshot() : undefined;
    return Object.freeze({
      kind: "accepted",
      applied,
      tree_revision: this.treeRevision,
      outbound: Object.freeze(outbound),
      replies,
      ...(capability === undefined ? {} : { capability }),
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

  private applyReplyFrame(frame: InternalFrame): {
    readonly reply: SupervisorReply;
    readonly accepted: boolean;
  } {
    if (this.role !== "parent" || this.state !== "ready") frameError("sequence_violation");
    const reply = parseReply(frame.payload);
    if (reply.agent_id !== this.peerAgentId) frameError("identity_mismatch");
    let accepted = true;
    // 生产装配会提供 ParentReplyInbox 回调。回调缺失时，协议端点只能确认
    // 该帧已通过传输边界；回调存在时则确认 fire-and-forget API 已同步调用。
    try {
      accepted = this.onReply === undefined || this.onReply(reply) === true;
    } catch {
      accepted = false;
    }
    return Object.freeze({ reply, accepted });
  }

  /**
   * 用控制响应返回一次父扩展消息提交结果。它不携带正文、消息身份、序号、
   * ACK 或重放状态；operation_id 只是本次控制调用的传输相关性值。
   */
  private createReplyDispatchResponse(
    operationId: string,
    accepted: boolean,
  ): SupervisorFrame {
    return this.createFrame("control_response", {
      operation_id: operationId,
      ok: true,
      data: {
        kind: "reply_dispatch",
        accepted,
      },
    });
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
      !hasOwn(payload, "expected_generation")
      || !Number.isSafeInteger(payload.expected_generation)
      || (payload.expected_generation as number) < 0
    ) frameError("invalid_frame");
    if (!this.eventAgentIsInScope(payload.agent_id as string)) frameError("identity_mismatch");
    const type = payload.type as AgentLifecycleEventType;
    const failureEvent = type === "startup_failed" || type === "runtime_failed";
    const allowedKeys = [
      "root_id",
      "agent_id",
      "type",
      "expected_generation",
      ...(failureEvent ? ["error_code", "error_details"] : []),
    ];
    if (Object.keys(payload).some((key) => !allowedKeys.includes(key))) frameError("invalid_frame");
    if (
      hasOwn(payload, "error_code")
      && (payload.error_code === undefined || !(AGENT_FAULT_CODES as readonly string[]).includes(payload.error_code as string))
    ) frameError("invalid_frame");
    const hasDetails = hasOwn(payload, "error_details");
    if (hasDetails) {
      if (
        !isCanonicalStartupDiagnosticDetails(payload.error_code, payload.error_details)
        || !hasStartupDiagnosticDetails(
          normalizeStartupDiagnosticDetails(payload.error_code, payload.error_details),
        )
      ) frameError("invalid_frame");
    }
    const details = hasDetails
      ? normalizeStartupDiagnosticDetails(payload.error_code, payload.error_details)
      : undefined;
    return Object.freeze({
      root_id: this.rootId,
      agent_id: payload.agent_id as string,
      type,
      expected_generation: payload.expected_generation as number,
      ...(payload.error_code === undefined
        ? {}
        : { error_code: payload.error_code as AgentFault["code"] }),
      ...(details === undefined ? {} : { error_details: details }),
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

  private beginReconnect(): void {
    if (this.incomingStreamId !== undefined && !this.retireIncomingStream(this.incomingStreamId)) {
      // 旧流集合不淘汰，达到固定窗口后不再接受任何可能被回放的流。
      this.state = "closed";
      return;
    }
    this.incomingStreamId = undefined;
    this.incomingLastSeq = 0;
    this.pendingSnapshotRequest = undefined;
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
