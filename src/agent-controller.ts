import { randomUUID } from "node:crypto";
import {
  controlFailure,
  isCanonicalUuid,
  ROOT_TREE_ACTOR,
  type AgentSnapshot,
  type ControlResult,
  type ReserveStartingChildInput,
  type ScopedAgentTreeSnapshot,
  type TreeActor,
  type TreeController,
} from "./tree-controller.ts";
import type { TemplateDefinition, TemplateDiscoverySnapshot } from "./template-discovery-snapshot.ts";
import {
  type RpcSupervisorCommandResult,
  type RpcSupervisorEvent,
  type RpcSupervisorImage,
  type RpcSupervisorInterruptResult,
  type RpcSupervisorStartupResult,
  type RpcSupervisorTerminationResult,
} from "./rpc-supervisor.ts";

export const WAIT_AGENT_MIN_TIMEOUT_MS = 10_000;
export const WAIT_AGENT_MAX_TIMEOUT_MS = 600_000;
export const WAIT_AGENT_DEFAULT_TIMEOUT_MS = 60_000;

export interface SpawnAgentInput {
  readonly template_id: string;
  readonly name: string;
}

export interface SendMessageInput {
  readonly agent_id: string;
  readonly message: string;
  readonly images?: readonly RpcSupervisorImage[];
}

export interface WaitAgentInput {
  readonly agent_id: string;
  readonly timeout_ms?: number;
}

export interface AgentSupervisorFactoryInput {
  readonly actor: TreeActor;
  readonly reservation: ReserveStartingChildInput;
  readonly template?: TemplateDefinition;
}

/** 控制器只依赖单节点监督器的公开命令面，不接触其进程树或传输实现。 */
export interface AgentSupervisor {
  start(): Promise<RpcSupervisorStartupResult>;
  prompt(
    message: string,
    images?: readonly RpcSupervisorImage[],
  ): Promise<RpcSupervisorCommandResult>;
  steer(
    message: string,
    images?: readonly RpcSupervisorImage[],
  ): Promise<RpcSupervisorCommandResult>;
  interrupt(): Promise<RpcSupervisorInterruptResult>;
  terminate(): Promise<RpcSupervisorTerminationResult>;
  onEvent(listener: (event: RpcSupervisorEvent) => void): () => void;
  wasForcedTerminationUsed(): boolean;
}

export type AgentSupervisorFactory = (
  input: AgentSupervisorFactoryInput,
) => AgentSupervisor;

export interface AgentControllerOptions {
  readonly tree: TreeController;
  readonly actor?: TreeActor;
  readonly createSupervisor: AgentSupervisorFactory;
  readonly templateSnapshot?: TemplateDiscoverySnapshot;
  /** 仅旧 fake 测试可显式开启；生产装配必须传入发现快照。 */
  readonly allowUnvalidatedTemplates?: boolean;
  readonly activeTools?: () => readonly string[];
  readonly validateTemplate?: (
    template: TemplateDefinition,
    actor: TreeActor,
  ) => ControlResult<unknown>;
  readonly waitTimeoutMs?: number;
  readonly onReply?: (
    agentId: string,
    reply: Extract<RpcSupervisorEvent, { kind: "reply" }>['reply'],
  ) => void;
}

interface ManagedAgentEntry {
  readonly supervisor: AgentSupervisor;
  readonly templateId: string;
  readonly name: string;
  readonly unsubscribe: () => void;
}

interface PendingWaiter {
  readonly resolve: (result: WaitAgentResult) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export type WaitAgentOutcome = "settled" | "terminal" | "timeout";

export interface WaitAgentData {
  readonly agent_id: string;
  readonly outcome: WaitAgentOutcome;
  readonly state: AgentSnapshot["state"];
  readonly revision: number;
  readonly observed_at: string;
  readonly error?: AgentSnapshot["error"];
}

export type WaitAgentResult = ControlResult<WaitAgentData>;

export interface InterruptAgentData {
  readonly agent_id: string;
  readonly accepted: true;
  readonly changed: boolean;
  readonly state: AgentSnapshot["state"];
  readonly error?: AgentSnapshot["error"];
}

export interface TerminateAgentData {
  readonly agent_id: string;
  readonly state: "terminated";
  readonly changed: boolean;
  readonly forced: boolean;
  readonly terminated_count: number;
}

export interface AgentMessageData {
  readonly message_id: string;
  readonly accepted: true;
}

export interface SpawnAgentData {
  readonly agent_id: string;
  readonly name: string;
  readonly template_id: string;
  readonly depth: number;
  readonly state: "idle";
}

/**
 * 直接父会话控制器。它只保存直接子代理的监督器，树身份和公开快照仍由
 * `TreeController` 负责；回复通过可选观察回调上行，不越级调用祖先。
 */
export class AgentController {
  readonly actor: TreeActor;

  private readonly tree: TreeController;
  private readonly createSupervisor: AgentSupervisorFactory;
  private templateSnapshot: TemplateDiscoverySnapshot | undefined;
  private readonly allowUnvalidatedTemplates: boolean;
  private readonly activeTools: (() => readonly string[]) | undefined;
  private readonly validateTemplate: AgentControllerOptions["validateTemplate"];
  private readonly waitTimeoutMs: number;
  private readonly onReply: AgentControllerOptions["onReply"];
  private readonly agents = new Map<string, ManagedAgentEntry>();
  /** start 抛出前无法取得公开身份的节点仍需保留内部回收能力。 */
  private readonly unassignedSupervisors = new Map<AgentSupervisor, () => void>();
  private readonly waiters = new Map<string, Set<PendingWaiter>>();
  private readonly messageIds = new Set<string>();
  private unsubscribeTreeChange: (() => void) | undefined;

  constructor(options: AgentControllerOptions) {
    this.tree = options.tree;
    this.actor = options.actor ?? ROOT_TREE_ACTOR;
    this.createSupervisor = options.createSupervisor;
    this.templateSnapshot = options.templateSnapshot;
    this.allowUnvalidatedTemplates = options.allowUnvalidatedTemplates === true;
    this.activeTools = options.activeTools;
    this.validateTemplate = options.validateTemplate;
    this.waitTimeoutMs = options.waitTimeoutMs ?? WAIT_AGENT_DEFAULT_TIMEOUT_MS;
    this.onReply = options.onReply;
    if (!validWaitTimeout(this.waitTimeoutMs)) throw new TypeError("默认等待期限无效");
    this.unsubscribeTreeChange = this.tree.onChange(() => this.resolveAllReadyWaiters());
  }

  async spawnAgent(input: SpawnAgentInput | unknown): Promise<ControlResult<SpawnAgentData>> {
    if (!isSpawnInput(input)) return controlFailure("invalid_argument");
    const preflight = this.preflightTemplate(input.template_id);
    if (!preflight.ok) return preflight;
    if (this.activeTools !== undefined && preflight.data !== undefined) {
      let available: Set<string>;
      try {
        available = new Set(this.activeTools());
      } catch {
        return controlFailure("template_capability_unavailable");
      }
      const missing = preflight.data.tools.filter((tool) => !available.has(tool));
      if (missing.length > 0) return controlFailure("template_capability_unavailable");
    }
    if (preflight.data !== undefined && this.validateTemplate !== undefined) {
      try {
        const validated = this.validateTemplate(preflight.data, this.actor);
        if (!validated.ok) return validated;
      } catch {
        return controlFailure("internal_error");
      }
    }

    const reservation: ReserveStartingChildInput = Object.freeze({
      templateId: input.template_id,
      name: input.name,
      ...(preflight.data === undefined ? {} : { subagents: preflight.data.subagents }),
    });
    let supervisor: AgentSupervisor;
    try {
      supervisor = this.createSupervisor({
        actor: this.actor,
        reservation,
        ...(preflight.data === undefined ? {} : { template: preflight.data }),
      });
    } catch {
      return controlFailure("internal_error");
    }
    let assignedAgentId: string | undefined;
    const earlyEvents: RpcSupervisorEvent[] = [];
    const unsubscribe = supervisor.onEvent((event) => {
      if (assignedAgentId === undefined) earlyEvents.push(event);
      else this.handleSupervisorEvent(assignedAgentId, event);
    });
    let started: RpcSupervisorStartupResult;
    try {
      started = await supervisor.start();
    } catch {
      const cleanup = await this.tryTerminateSupervisor(supervisor);
      if (cleanup === "confirmed") unsubscribe();
      else this.unassignedSupervisors.set(supervisor, unsubscribe);
      return controlFailure(cleanup === "confirmed" ? "internal_error" : "termination_incomplete");
    }
    assignedAgentId = started.agent_id;
    if (!started.ok && started.agent_id !== undefined) {
      if (started.cleanup === "confirmed") {
        unsubscribe();
      } else {
        // 只有资源未确认时才保留活动监督器，供后续 terminate_agent 重试。
        this.retainSupervisor(started.agent_id, supervisor, input, unsubscribe, earlyEvents);
      }
      return controlFailure(started.code);
    }
    if (!started.ok) {
      unsubscribe();
      return controlFailure(started.code);
    }
    const status = this.tree.getStatus(started.agent_id);
    if (!status.ok || status.data.state !== "idle") {
      const cleanup = await this.tryTerminateSupervisor(supervisor);
      if (cleanup === "confirmed") {
        unsubscribe();
      } else {
        this.retainSupervisor(started.agent_id, supervisor, input, unsubscribe, earlyEvents);
      }
      return controlFailure(cleanup === "confirmed" ? "internal_error" : "termination_incomplete");
    }
    this.retainSupervisor(started.agent_id, supervisor, input, unsubscribe, earlyEvents);
    return Object.freeze({ ok: true, data: spawnData(status.data) });
  }

  async sendMessage(input: SendMessageInput | unknown): Promise<ControlResult<AgentMessageData>> {
    if (!isSendMessageInput(input)) return controlFailure("invalid_argument");
    const target = this.directChild(input.agent_id);
    if (!target.ok) return target;
    const entry = this.agents.get(input.agent_id);
    if (entry === undefined) return controlFailure("agent_unavailable");
    if (target.data.state === "failed" || target.data.state === "terminating" || target.data.state === "terminated") {
      return controlFailure("agent_unavailable");
    }
    const messageId = this.allocateMessageId();
    let result: RpcSupervisorCommandResult;
    try {
      // Pi 0.83.0 的公共 RpcClient 未暴露 prompt.streamingBehavior；REQ-026
      // 采用控制器已确认状态的空闲 prompt / 工作 steering 兼容路由，避免访问私有 JSONL。
      result = target.data.state === "idle"
        ? await entry.supervisor.prompt(input.message, input.images)
        : await entry.supervisor.steer(input.message, input.images);
    } catch {
      return controlFailure("message_delivery_failed");
    }
    if (!result.ok) return controlFailure(result.code);
    return Object.freeze({ ok: true, data: Object.freeze({ message_id: messageId, accepted: true }) });
  }

  async waitAgent(input: WaitAgentInput | unknown): Promise<WaitAgentResult> {
    if (!isWaitInput(input)) return controlFailure("invalid_argument");
    const target = this.directChild(input.agent_id);
    if (!target.ok) return target;
    const timeout = input.timeout_ms ?? this.waitTimeoutMs;
    const immediate = this.waitOutcome(input.agent_id, target.data);
    if (immediate !== undefined) return Object.freeze({ ok: true, data: immediate });

    return new Promise<WaitAgentResult>((resolve) => {
      const timer = setTimeout(() => {
        const set = this.waiters.get(input.agent_id);
        if (set !== undefined) {
          for (const waiter of set) {
            if (waiter.resolve === resolve) set.delete(waiter);
          }
          if (set.size === 0) this.waiters.delete(input.agent_id);
        }
        const latest = this.tree.getStatus(input.agent_id);
        if (!latest.ok) resolve(latest);
        else resolve(Object.freeze({ ok: true, data: makeWaitData(latest.data, "timeout") }));
      }, timeout);
      const waiter: PendingWaiter = { resolve, timer };
      const set = this.waiters.get(input.agent_id) ?? new Set<PendingWaiter>();
      set.add(waiter);
      this.waiters.set(input.agent_id, set);
      // 原子检查、登记、再次检查，避免事件恰好落在登记边界丢失。
      const latest = this.tree.getStatus(input.agent_id);
      if (latest.ok) {
        const outcome = this.waitOutcome(input.agent_id, latest.data);
        if (outcome !== undefined) this.finishWaiter(input.agent_id, waiter, Object.freeze({ ok: true, data: outcome }));
      }
    });
  }

  async interruptAgent(agentId: unknown): Promise<ControlResult<InterruptAgentData>> {
    const target = this.directChild(agentId);
    if (!target.ok) return target;
    const entry = this.agents.get(target.data.agent_id);
    if (entry === undefined) return controlFailure("agent_unavailable");
    if (target.data.state === "starting") return controlFailure("agent_unavailable");
    if (target.data.state === "idle" || target.data.state === "interrupting" || target.data.state === "failed" || target.data.state === "terminating" || target.data.state === "terminated") {
      return Object.freeze({ ok: true, data: interruptData(target.data, false) });
    }
    let result: RpcSupervisorInterruptResult;
    try {
      result = await entry.supervisor.interrupt();
    } catch {
      return controlFailure("agent_unavailable");
    }
    if (!result.ok) return controlFailure(result.code);
    const latest = this.tree.getStatus(target.data.agent_id);
    if (!latest.ok) return controlFailure("agent_not_found");
    return Object.freeze({ ok: true, data: interruptData(latest.data, result.changed) });
  }

  async terminateAgent(agentId: unknown): Promise<ControlResult<TerminateAgentData>> {
    const target = this.directChild(agentId);
    if (!target.ok) return target;
    if (target.data.state === "terminated") {
      return Object.freeze({ ok: true, data: {
        agent_id: target.data.agent_id,
        state: "terminated" as const,
        changed: false,
        forced: false,
        terminated_count: 0,
      } });
    }
    const entry = this.agents.get(target.data.agent_id);
    if (entry === undefined) return controlFailure("agent_unavailable");
    let result: RpcSupervisorTerminationResult;
    try {
      result = await entry.supervisor.terminate();
    } catch {
      return controlFailure("termination_incomplete");
    }
    if (!result.ok) return controlFailure(result.code);
    entry.unsubscribe();
    this.agents.delete(target.data.agent_id);
    return Object.freeze({ ok: true, data: {
      agent_id: target.data.agent_id,
      state: "terminated" as const,
      changed: true,
      forced: entry.supervisor.wasForcedTerminationUsed(),
      terminated_count: 1,
    } });
  }

  getAgentStatus(agentId: unknown): ControlResult<AgentSnapshot> {
    const target = this.directChild(agentId);
    return target;
  }

  getAgentTree(): ControlResult<ScopedAgentTreeSnapshot> {
    return this.tree.getTreeSnapshotFor(this.actor);
  }

  /** 根 reload 原子替换未来创建使用的目录，不回溯改变既有节点。 */
  updateTemplateSnapshot(snapshot: TemplateDiscoverySnapshot): void {
    this.templateSnapshot = snapshot;
  }

  /** 会话关闭时终止当前控制器拥有的全部节点；不同节点可并行清理。 */
  async shutdown(): Promise<void> {
    const assigned = [...this.agents.entries()];
    const unassigned = [...this.unassignedSupervisors.entries()];
    await Promise.allSettled(assigned.map(async ([agentId, entry]) => {
      try {
        const result = await entry.supervisor.terminate();
        if (!result.ok) return;
        if (this.agents.get(agentId) !== entry) return;
        entry.unsubscribe();
        this.agents.delete(agentId);
      } catch {
        // 未确认资源必须保留监督器，供下一次关闭或显式终止重试。
      }
    }));
    await Promise.allSettled(unassigned.map(async ([supervisor, unsubscribe]) => {
      try {
        const result = await supervisor.terminate();
        if (!result.ok) return;
        if (this.unassignedSupervisors.get(supervisor) !== unsubscribe) return;
        unsubscribe();
        this.unassignedSupervisors.delete(supervisor);
      } catch {
        // 身份未知不等于资源已回收；继续保留内部控制面。
      }
    }));
    if (this.agents.size === 0 && this.unassignedSupervisors.size === 0) this.dispose();
  }

  dispose(): void {
    this.unsubscribeTreeChange?.();
    this.unsubscribeTreeChange = undefined;
    for (const [agentId, set] of this.waiters) {
      for (const waiter of [...set]) {
        this.finishWaiter(agentId, waiter, controlFailure("agent_unavailable"));
      }
    }
    this.waiters.clear();
    for (const entry of this.agents.values()) entry.unsubscribe();
    this.agents.clear();
    for (const unsubscribe of this.unassignedSupervisors.values()) unsubscribe();
    this.unassignedSupervisors.clear();
  }

  private preflightTemplate(templateId: string): ControlResult<TemplateDefinition | undefined> {
    if (this.templateSnapshot === undefined) {
      return this.allowUnvalidatedTemplates
        ? Object.freeze({ ok: true, data: undefined })
        : controlFailure("template_not_found");
    }
    const resolution = this.templateSnapshot.resolveTemplate(templateId);
    if (resolution.kind === "not_found") return controlFailure("template_not_found");
    if (resolution.kind === "invalid") return controlFailure("template_invalid");
    return Object.freeze({ ok: true, data: resolution.template });
  }

  private directChild(agentId: unknown): ControlResult<AgentSnapshot> {
    return this.tree.assertDirectChild(this.actor, agentId);
  }

  private retainSupervisor(
    agentId: string,
    supervisor: AgentSupervisor,
    input: SpawnAgentInput,
    unsubscribe: () => void,
    earlyEvents: readonly RpcSupervisorEvent[],
  ): void {
    this.agents.set(agentId, {
      supervisor,
      templateId: input.template_id,
      name: input.name,
      unsubscribe,
    });
    for (const event of earlyEvents) this.handleSupervisorEvent(agentId, event);
    this.resolveWaiters(agentId);
    this.releaseTerminatedSupervisor(agentId);
  }

  private async tryTerminateSupervisor(
    supervisor: AgentSupervisor,
  ): Promise<"confirmed" | "incomplete"> {
    try {
      const result = await supervisor.terminate();
      if (result.ok) return "confirmed";
      return "incomplete";
    } catch {
      return "incomplete";
    }
  }

  private handleSupervisorEvent(agentId: string | undefined, event: RpcSupervisorEvent): void {
    if (event.kind === "reply" && this.onReply !== undefined && agentId !== undefined) {
      try {
        this.onReply(agentId, event.reply);
      } catch {
        // 父会话注入失败只影响上行观察者，不破坏节点等待和生命周期。
      }
    }
    if (agentId !== undefined) this.resolveWaiters(agentId);
    if (
      agentId !== undefined
      && event.kind === "lifecycle"
      && event.event.type === "resources_confirmed"
    ) {
      this.releaseTerminatedSupervisor(agentId);
    }
    this.resolveAllReadyWaiters();
  }

  private releaseTerminatedSupervisor(agentId: string): void {
    const status = this.tree.getStatus(agentId);
    if (!status.ok || status.data.state !== "terminated") return;
    const entry = this.agents.get(agentId);
    if (entry === undefined) return;
    entry.unsubscribe();
    this.agents.delete(agentId);
  }

  private resolveAllReadyWaiters(): void {
    for (const agentId of [...this.waiters.keys()]) this.resolveWaiters(agentId);
  }

  private resolveWaiters(agentId: string): void {
    const set = this.waiters.get(agentId);
    if (set === undefined) return;
    const status = this.tree.getStatus(agentId);
    if (!status.ok) {
      for (const waiter of [...set]) this.finishWaiter(agentId, waiter, status);
      return;
    }
    const outcome = this.waitOutcome(agentId, status.data);
    if (outcome === undefined) return;
    for (const waiter of [...set]) this.finishWaiter(agentId, waiter, Object.freeze({ ok: true, data: outcome }));
  }

  private finishWaiter(agentId: string, waiter: PendingWaiter, result: WaitAgentResult): void {
    const set = this.waiters.get(agentId);
    if (set === undefined || !set.delete(waiter)) return;
    clearTimeout(waiter.timer);
    if (set.size === 0) this.waiters.delete(agentId);
    waiter.resolve(result);
  }

  private waitOutcome(agentId: string, status: AgentSnapshot): WaitAgentData | undefined {
    if (status.state === "idle") return makeWaitData(status, "settled");
    if (status.state === "failed" || status.state === "terminated") return makeWaitData(status, "terminal");
    return undefined;
  }

  private allocateMessageId(): string {
    let candidate = `msg_${randomUUID()}`;
    while (this.messageIds.has(candidate)) candidate = `msg_${randomUUID()}`;
    this.messageIds.add(candidate);
    return candidate;
  }
}

function isSpawnInput(value: unknown): value is SpawnAgentInput {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.template_id === "string" && candidate.template_id.length > 0
    && utf8Length(candidate.template_id) <= 256
    && typeof candidate.name === "string" && candidate.name.length > 0
    && utf8Length(candidate.name) <= 256
    && Object.keys(candidate).every((key) => key === "template_id" || key === "name");
}

function isSendMessageInput(value: unknown): value is SendMessageInput {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (
    !isCanonicalUuid(candidate.agent_id)
    || typeof candidate.message !== "string"
    || candidate.message.length === 0
    || utf8Length(candidate.message) > 16 * 1024
  ) return false;
  if (candidate.images === undefined) return true;
  if (!Array.isArray(candidate.images) || candidate.images.length > 8) return false;
  return candidate.images.every((image) => {
    if (typeof image !== "object" || image === null) return false;
    const item = image as Record<string, unknown>;
    return item.type === "image"
      && typeof item.data === "string"
      && validBase64(item.data)
      && decodedBase64Length(item.data) <= 24 * 1024
      && typeof item.mimeType === "string"
      && /^image\/[a-z0-9.+-]+$/.test(item.mimeType)
      && Object.keys(item).every((key) => key === "type" || key === "data" || key === "mimeType");
  });
}

function isWaitInput(value: unknown): value is WaitAgentInput {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (!isCanonicalUuid(candidate.agent_id)) return false;
  if (candidate.timeout_ms !== undefined && !validWaitTimeout(candidate.timeout_ms as number)) return false;
  return Object.keys(candidate).every((key) => key === "agent_id" || key === "timeout_ms");
}

function validWaitTimeout(value: number): boolean {
  return Number.isSafeInteger(value) && value >= WAIT_AGENT_MIN_TIMEOUT_MS && value <= WAIT_AGENT_MAX_TIMEOUT_MS;
}

function makeWaitData(status: AgentSnapshot, outcome: WaitAgentOutcome): WaitAgentData {
  return Object.freeze({
    agent_id: status.agent_id,
    outcome,
    state: status.state,
    revision: status.revision,
    observed_at: status.observed_at,
    ...(status.error === undefined ? {} : { error: status.error }),
  });
}

function spawnData(status: AgentSnapshot): SpawnAgentData {
  // 创建工具只公开规格冻结的最小字段；后续状态查询再提供 revision/pending 等诊断。
  return Object.freeze({
    agent_id: status.agent_id,
    name: status.name,
    template_id: status.template_id,
    depth: status.depth,
    state: "idle" as const,
  });
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
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

function interruptData(status: AgentSnapshot, changed: boolean): InterruptAgentData {
  return Object.freeze({
    agent_id: status.agent_id,
    accepted: true,
    changed,
    state: status.state,
    ...(status.error === undefined ? {} : { error: status.error }),
  });
}
