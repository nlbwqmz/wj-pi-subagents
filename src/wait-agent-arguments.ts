import {
  CANONICAL_AGENT_UUID_PATTERN_SOURCE,
  isCanonicalAgentUuid,
} from "./agent-snapshot-codec.ts";

export const WAIT_AGENT_MIN_TIMEOUT_MS = 10_000;
export const WAIT_AGENT_MAX_TIMEOUT_MS = 600_000;
export const WAIT_AGENT_DEFAULT_TIMEOUT_MS = 60_000;
export const WAIT_AGENT_MAX_TARGETS = 64;
export const WAIT_AGENT_UUID_PATTERN_SOURCE = CANONICAL_AGENT_UUID_PATTERN_SOURCE;

export interface WaitAgentInput {
  readonly agent_ids: readonly string[];
  readonly timeout_ms?: number;
}

export type WaitAgentArgumentIssue =
  | Readonly<{ field: "arguments"; reason: "not_object" | "unknown_field" }>
  | Readonly<{ field: "agent_ids"; reason: "required" }>
  | Readonly<{ field: "agent_ids"; reason: "wrong_type" }>
  | Readonly<{
      field: "agent_ids";
      reason: "count_out_of_range";
      min: 1;
      max: typeof WAIT_AGENT_MAX_TARGETS;
      received: number;
    }>
  | Readonly<{ field: "agent_ids"; reason: "invalid_uuid"; index: number }>
  | Readonly<{ field: "timeout_ms"; reason: "not_integer" }>
  | Readonly<{
      field: "timeout_ms";
      reason: "out_of_range";
      min: typeof WAIT_AGENT_MIN_TIMEOUT_MS;
      max: typeof WAIT_AGENT_MAX_TIMEOUT_MS;
      received: number;
    }>;

export type WaitAgentInputResult =
  | Readonly<{ ok: true; value: WaitAgentInput }>
  | Readonly<{ ok: false; issue: WaitAgentArgumentIssue }>;

const ALLOWED_WAIT_AGENT_KEYS = new Set(["agent_ids", "timeout_ms"]);

export function isValidWaitAgentTimeout(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= WAIT_AGENT_MIN_TIMEOUT_MS
    && (value as number) <= WAIT_AGENT_MAX_TIMEOUT_MS;
}

export function parseWaitAgentInput(value: unknown): WaitAgentInputResult {
  try {
    const candidate = plainDataRecord(value);
    if (candidate === undefined) {
      return issue({ field: "arguments", reason: "not_object" });
    }
    for (const key of Reflect.ownKeys(candidate)) {
      if (typeof key !== "string") return issue({ field: "arguments", reason: "unknown_field" });
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (
        descriptor === undefined
        || !descriptor.enumerable
        || !("value" in descriptor)
        || !ALLOWED_WAIT_AGENT_KEYS.has(key)
      ) return issue({ field: "arguments", reason: "unknown_field" });
    }
    if (!Object.hasOwn(candidate, "agent_ids")) {
      return issue({ field: "agent_ids", reason: "required" });
    }
    const agentIds = candidate.agent_ids;
    if (!Array.isArray(agentIds)) {
      return issue({ field: "agent_ids", reason: "wrong_type" });
    }
    if (agentIds.length < 1 || agentIds.length > WAIT_AGENT_MAX_TARGETS) {
      return issue({
        field: "agent_ids",
        reason: "count_out_of_range",
        min: 1,
        max: WAIT_AGENT_MAX_TARGETS,
        received: agentIds.length,
      });
    }
    for (let index = 0; index < agentIds.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(agentIds, String(index));
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        return issue({ field: "agent_ids", reason: "invalid_uuid", index });
      }
      if (!isCanonicalAgentUuid(descriptor.value)) {
        return issue({ field: "agent_ids", reason: "invalid_uuid", index });
      }
    }

    const timeout = Object.hasOwn(candidate, "timeout_ms")
      ? candidate.timeout_ms
      : undefined;
    if (timeout !== undefined) {
      if (!Number.isSafeInteger(timeout)) {
        return issue({ field: "timeout_ms", reason: "not_integer" });
      }
      if (!isValidWaitAgentTimeout(timeout)) {
        return issue({
          field: "timeout_ms",
          reason: "out_of_range",
          min: WAIT_AGENT_MIN_TIMEOUT_MS,
          max: WAIT_AGENT_MAX_TIMEOUT_MS,
          received: timeout as number,
        });
      }
    }

    return Object.freeze({
      ok: true,
      value: Object.freeze({
        agent_ids: Object.freeze([...new Set(agentIds as string[])]),
        ...(timeout === undefined ? {} : { timeout_ms: timeout as number }),
      }),
    });
  } catch {
    return issue({ field: "arguments", reason: "not_object" });
  }
}

export function parseWaitAgentToolInput(value: unknown): WaitAgentInputResult {
  try {
    return parseWaitAgentInput(coerceWaitAgentToolInput(value));
  } catch {
    return issue({ field: "arguments", reason: "not_object" });
  }
}

export function normalizeWaitAgentInput(value: unknown): WaitAgentInput | undefined {
  const parsed = parseWaitAgentInput(value);
  return parsed.ok ? parsed.value : undefined;
}

export function coerceWaitAgentTimeoutValue(value: unknown): unknown {
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : value;
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

export function normalizeWaitAgentArgumentIssue(value: unknown): WaitAgentArgumentIssue | undefined {
  try {
    const record = plainDataRecord(value);
    if (record === undefined) return undefined;
    const field = readOwnDataValue(record, "field");
    const reason = readOwnDataValue(record, "reason");
    if (field === "arguments" && (reason === "not_object" || reason === "unknown_field")) {
      return hasExactOwnDataKeys(record, ["field", "reason"])
        ? Object.freeze({ field, reason })
        : undefined;
    }
    if (field === "agent_ids" && (reason === "required" || reason === "wrong_type")) {
      return hasExactOwnDataKeys(record, ["field", "reason"])
        ? Object.freeze({ field, reason })
        : undefined;
    }
    if (field === "agent_ids" && reason === "count_out_of_range") {
      const min = readOwnDataValue(record, "min");
      const max = readOwnDataValue(record, "max");
      const received = readOwnDataValue(record, "received");
      return hasExactOwnDataKeys(record, ["field", "reason", "min", "max", "received"])
        && min === 1
        && max === WAIT_AGENT_MAX_TARGETS
        && Number.isSafeInteger(received)
        && ((received as number) < 1 || (received as number) > WAIT_AGENT_MAX_TARGETS)
        ? Object.freeze({ field, reason, min, max, received: received as number })
        : undefined;
    }
    if (field === "agent_ids" && reason === "invalid_uuid") {
      const index = readOwnDataValue(record, "index");
      return hasExactOwnDataKeys(record, ["field", "reason", "index"])
        && Number.isSafeInteger(index)
        && (index as number) >= 0
        && (index as number) < WAIT_AGENT_MAX_TARGETS
        ? Object.freeze({ field, reason, index: index as number })
        : undefined;
    }
    if (field === "timeout_ms" && reason === "not_integer") {
      return hasExactOwnDataKeys(record, ["field", "reason"])
        ? Object.freeze({ field, reason })
        : undefined;
    }
    if (field === "timeout_ms" && reason === "out_of_range") {
      const min = readOwnDataValue(record, "min");
      const max = readOwnDataValue(record, "max");
      const received = readOwnDataValue(record, "received");
      return hasExactOwnDataKeys(record, ["field", "reason", "min", "max", "received"])
        && min === WAIT_AGENT_MIN_TIMEOUT_MS
        && max === WAIT_AGENT_MAX_TIMEOUT_MS
        && Number.isSafeInteger(received)
        && ((received as number) < WAIT_AGENT_MIN_TIMEOUT_MS || (received as number) > WAIT_AGENT_MAX_TIMEOUT_MS)
        ? Object.freeze({ field, reason, min, max, received: received as number })
        : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function isWaitAgentArgumentIssue(value: unknown): value is WaitAgentArgumentIssue {
  return normalizeWaitAgentArgumentIssue(value) !== undefined;
}

export function waitAgentArgumentIssueMessage(issue: WaitAgentArgumentIssue): string {
  if (issue.field === "arguments") {
    return issue.reason === "not_object"
      ? "wait_agent arguments must be an object"
      : "wait_agent accepts only agent_ids and timeout_ms";
  }
  if (issue.field === "agent_ids") {
    if (issue.reason === "required") return "wait_agent.agent_ids is required";
    if (issue.reason === "wrong_type") return "wait_agent.agent_ids must be an array";
    if (issue.reason === "count_out_of_range") {
      return `wait_agent.agent_ids must contain between ${issue.min} and ${issue.max} UUIDs`;
    }
    return `wait_agent.agent_ids[${issue.index}] must be a lowercase canonical UUID`;
  }
  return `wait_agent.timeout_ms must be an integer between ${WAIT_AGENT_MIN_TIMEOUT_MS} and ${WAIT_AGENT_MAX_TIMEOUT_MS}`;
}

function coerceWaitAgentToolInput(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const candidate = value as Record<string, unknown>;
  if (!Object.hasOwn(candidate, "timeout_ms")) return value;
  const timeout = candidate.timeout_ms;
  // Pi tool calls historically use null as the omitted optional field; keep that
  // compatibility only at the tool boundary, while controller input stays strict.
  if (timeout === null) {
    const { timeout_ms: _omitted, ...withoutTimeout } = candidate;
    return withoutTimeout;
  }
  const coerced = coerceWaitAgentTimeoutValue(timeout);
  if (coerced === timeout) return value;
  return { ...candidate, timeout_ms: coerced };
}

function issue(value: WaitAgentArgumentIssue): WaitAgentInputResult {
  return Object.freeze({ ok: false, issue: Object.freeze(value) });
}

function plainDataRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown>
    : undefined;
}

function readOwnDataValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function hasExactOwnDataKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === expected.length
    && expected.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      return descriptor !== undefined && "value" in descriptor;
    });
}
