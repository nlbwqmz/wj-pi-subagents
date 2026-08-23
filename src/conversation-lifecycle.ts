/**
 * 父子持续会话的最小领域模型。
 *
 * 该模块故意不保存任务、回合、提交或消息身份。生命周期事实和会话事件
 * 分别归约，调用方可以安全地把一次消息接纳失败与运行时故障区分开来。
 */

export const LIFECYCLE_STATES = Object.freeze([
  "starting",
  "idle",
  "working",
  "interrupting",
  "terminating",
  "terminated",
  "failed",
] as const);

export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export const SESSION_EVENT_TYPES = Object.freeze([
  "reply",
  "final_report",
  "idle",
  "terminal",
] as const);

export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number];

export interface LifecycleSnapshot {
  readonly agent_id: string;
  readonly state: LifecycleState;
  readonly revision: number;
  readonly lifecycle_generation: number;
  readonly error_code?: string;
}

export interface LifecycleFact {
  readonly agent_id: string;
  readonly expected_generation: number;
  readonly type:
    | "startup_ready"
    | "startup_failed"
    | "agent_start"
    | "agent_settled"
    | "interrupt_accepted"
    | "terminate_accepted"
    | "resources_confirmed"
    | "runtime_failed";
  readonly error_code?: string;
}

export interface LifecycleReduction {
  readonly applied: boolean;
  readonly snapshot: LifecycleSnapshot;
  readonly event?: SessionEventType;
  readonly diagnostic?: "stale_generation" | "invalid_transition";
}

/** 会话事件不携带正文，正文只通过父 Pi 已接纳的 custom message 展示。 */
export interface SessionEvent {
  readonly agent_id: string;
  readonly type: SessionEventType;
  readonly revision: number;
}

const FAILURE_FACTS = new Set<LifecycleFact["type"]>(["startup_failed", "runtime_failed"]);

const TRANSITIONS = Object.freeze({
  starting: Object.freeze(["idle", "failed", "terminating"]),
  idle: Object.freeze(["working", "terminating", "failed"]),
  working: Object.freeze(["idle", "interrupting", "terminating", "failed"]),
  interrupting: Object.freeze(["idle", "terminating", "failed"]),
  terminating: Object.freeze(["terminated"]),
  terminated: Object.freeze([]),
  failed: Object.freeze(["terminating"]),
} satisfies Record<LifecycleState, readonly LifecycleState[]>);

/** 返回合法状态转换，不把消息接纳或压缩结果解释成生命周期事实。 */
export function canTransition(from: LifecycleState, to: LifecycleState): boolean {
  return (TRANSITIONS[from] as readonly LifecycleState[]).includes(to);
}

/** 受监督事实驱动的生命周期归约器。它是公开快照的唯一写入边界。 */
export class LifecycleAuthority {
  private readonly snapshots = new Map<string, LifecycleSnapshot>();
  private readonly events = new Map<string, SessionEvent[]>();

  register(snapshot: LifecycleSnapshot): void {
    if (!isLifecycleSnapshot(snapshot)) throw new TypeError("invalid_lifecycle_snapshot");
    this.snapshots.set(snapshot.agent_id, Object.freeze({ ...snapshot }));
  }

  get(agentId: string): LifecycleSnapshot | undefined {
    const snapshot = this.snapshots.get(agentId);
    return snapshot === undefined ? undefined : Object.freeze({ ...snapshot });
  }

  apply(fact: LifecycleFact): LifecycleReduction {
    const current = this.snapshots.get(fact.agent_id);
    if (current === undefined || !validFact(fact)) {
      throw new TypeError("invalid_lifecycle_fact");
    }
    if (fact.expected_generation !== current.lifecycle_generation) {
      return Object.freeze({
        applied: false,
        snapshot: Object.freeze({ ...current }),
        diagnostic: "stale_generation",
      });
    }
    const target = targetState(current.state, fact.type);
    if (target === undefined || !canTransition(current.state, target)) {
      return Object.freeze({
        applied: false,
        snapshot: Object.freeze({ ...current }),
        diagnostic: "invalid_transition",
      });
    }
    const next: LifecycleSnapshot = Object.freeze({
      agent_id: current.agent_id,
      state: target,
      revision: current.revision + 1,
      lifecycle_generation: current.lifecycle_generation + 1,
      ...(FAILURE_FACTS.has(fact.type) && fact.error_code === undefined
        ? { error_code: "runtime_fault" }
        : fact.error_code === undefined
          ? current.error_code === undefined ? {} : { error_code: current.error_code }
          : { error_code: fact.error_code }),
    });
    this.snapshots.set(fact.agent_id, next);
    const event = eventForFact(current.state, target, fact.type);
    if (event !== undefined) this.recordEvent({ agent_id: fact.agent_id, type: event, revision: next.revision });
    return Object.freeze({ applied: true, snapshot: next, ...(event === undefined ? {} : { event }) });
  }

  recordSessionEvent(agentId: string, type: Exclude<SessionEventType, "idle" | "terminal">): SessionEvent {
    const snapshot = this.snapshots.get(agentId);
    if (snapshot === undefined) throw new Error("agent_not_found");
    if (type !== "reply" && type !== "final_report") {
      throw new TypeError("invalid_session_event");
    }
    if (snapshot.state !== "working" && snapshot.state !== "interrupting") {
      throw new Error("invalid_transition");
    }
    const event = Object.freeze({ agent_id: agentId, type, revision: snapshot.revision });
    this.recordEvent(event);
    return event;
  }

  takeEvents(agentId: string): readonly SessionEvent[] {
    const events = this.events.get(agentId) ?? [];
    this.events.delete(agentId);
    return Object.freeze(events.map((event) => Object.freeze({ ...event })));
  }

  peekEvents(agentId: string): readonly SessionEvent[] {
    return Object.freeze((this.events.get(agentId) ?? []).map((event) => Object.freeze({ ...event })));
  }

  private recordEvent(event: SessionEvent): void {
    const queue = this.events.get(event.agent_id) ?? [];
    queue.push(Object.freeze({ ...event }));
    this.events.set(event.agent_id, queue);
  }
}

function targetState(
  state: LifecycleState,
  type: LifecycleFact["type"],
): LifecycleState | undefined {
  switch (type) {
    case "startup_ready": return state === "starting" ? "idle" : undefined;
    case "startup_failed": return state === "starting" ? "failed" : undefined;
    case "agent_start": return state === "idle" ? "working" : undefined;
    case "agent_settled": return state === "working" || state === "interrupting" ? "idle" : undefined;
    case "interrupt_accepted": return state === "working" ? "interrupting" : undefined;
    case "terminate_accepted": return state === "terminated" ? undefined : "terminating";
    case "resources_confirmed": return state === "terminating" ? "terminated" : undefined;
    case "runtime_failed": return state === "starting" || state === "idle" || state === "working" || state === "interrupting"
      ? "failed"
      : undefined;
  }
}

function eventForFact(
  from: LifecycleState,
  to: LifecycleState,
  type: LifecycleFact["type"],
): SessionEventType | undefined {
  if ((from === "working" || from === "interrupting") && to === "idle" && type === "agent_settled") return "idle";
  if (to === "terminated" || to === "failed") return "terminal";
  return undefined;
}

function validFact(value: unknown): value is LifecycleFact {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const type = candidate.type;
  const allowsErrorCode = type === "startup_failed" || type === "runtime_failed";
  return typeof candidate.agent_id === "string"
    && Number.isSafeInteger(candidate.expected_generation)
    && (candidate.expected_generation as number) >= 0
    && typeof candidate.type === "string"
    && [
      "startup_ready", "startup_failed", "agent_start", "agent_settled",
      "interrupt_accepted", "terminate_accepted", "resources_confirmed", "runtime_failed",
    ].includes(candidate.type)
    && Object.keys(candidate).every((key) =>
      ["agent_id", "expected_generation", "type", ...(allowsErrorCode ? ["error_code"] : [])].includes(key)
    )
    && (candidate.error_code === undefined || typeof candidate.error_code === "string");
}

function isLifecycleSnapshot(value: unknown): value is LifecycleSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.agent_id === "string"
    && LIFECYCLE_STATES.includes(candidate.state as LifecycleState)
    && Number.isSafeInteger(candidate.revision)
    && (candidate.revision as number) >= 0
    && Number.isSafeInteger(candidate.lifecycle_generation)
    && (candidate.lifecycle_generation as number) >= 0
    && Object.keys(candidate).every((key) => [
      "agent_id", "state", "revision", "lifecycle_generation", "error_code",
    ].includes(key))
    && (candidate.error_code === undefined || typeof candidate.error_code === "string");
}
