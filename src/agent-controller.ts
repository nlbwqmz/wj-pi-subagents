import {
  controlFailure,
  isCanonicalUuid,
  ROOT_TREE_ACTOR,
  type AgentSnapshot,
  type ControlResult,
  type ReserveStartingChildInput,
  type ScopedAgentTreeSnapshot,
  type TerminationBarrierOutcome,
  type TreeActor,
  type TreeController,
} from "./tree-controller.ts";
import {
  listAgentTemplates,
  type AgentTemplateListItem,
  type TemplateDefinition,
  type TemplateDiscoverySnapshot,
} from "./template-discovery-snapshot.ts";
import type {
  AuthorityControlAction,
  SpawnGrant,
  TreeAuthorityPort,
} from "./tree-authority.ts";
import {
  type RpcSupervisorCommandResult,
  type RpcSupervisorEvent,
  type RpcSupervisorInterruptResult,
  type RpcSupervisorStartupResult,
  type RpcSupervisorTerminationResult,
} from "./rpc-supervisor.ts";

export const WAIT_AGENT_MIN_TIMEOUT_MS = 10_000;
export const WAIT_AGENT_MAX_TIMEOUT_MS = 600_000;
export const WAIT_AGENT_DEFAULT_TIMEOUT_MS = 60_000;
export const WAIT_AGENT_MAX_TARGETS = 64;

export interface SpawnAgentInput {
  readonly template_id: string;
  readonly name: string;
}

export interface SendMessageInput {
  readonly agent_id: string;
  readonly message: string;
}

export interface WaitAgentInput {
  readonly agent_ids: readonly string[];
  readonly timeout_ms?: number;
}

export interface AgentSupervisorFactoryInput {
  readonly actor: TreeActor;
  readonly reservation: ReserveStartingChildInput;
  readonly template?: TemplateDefinition;
  readonly grant?: SpawnGrant;
}

/** 控制器只依赖单节点监督器的公开命令面，不接触其进程树或传输实现。 */
export interface AgentSupervisor {
  start(): Promise<RpcSupervisorStartupResult>;
  /** 消息先进入监督器 mailbox；prompt/steer 由 reducer 与宿主适配器决定。 */
  submit(message: string): Promise<RpcSupervisorCommandResult>;
  prompt(message: string): Promise<RpcSupervisorCommandResult>;
  steer(message: string): Promise<RpcSupervisorCommandResult>;
  interrupt(): Promise<RpcSupervisorInterruptResult>;
  terminate(): Promise<RpcSupervisorTerminationResult>;
  /** 故障节点的平台进程树边界回收；节点记录本身继续保持 failed。 */
  reapOrphanedDescendants?(): Promise<{ readonly confirmed: boolean; readonly forced: boolean }>;
  onEvent(listener: (event: RpcSupervisorEvent) => void): () => void;
  /** reload 后让直接子监督器重试尚未进入父会话的回复。 */
  retryPendingReplies?(): Promise<void>;
  wasForcedTerminationUsed(): boolean;
}

export type AgentSupervisorFactory = ((
  input: AgentSupervisorFactoryInput,
) => AgentSupervisor) & {
  /** 根 reload 后替换未来创建使用的模板目录；旧监督器不受影响。 */
  updateTemplateSnapshot?: (snapshot: TemplateDiscoverySnapshot) => void;
};

export interface AgentControllerOptions {
  readonly tree: TreeController;
  readonly actor?: TreeActor;
  readonly createSupervisor: AgentSupervisorFactory;
  readonly templateSnapshot?: TemplateDiscoverySnapshot;
  /** 仅旧 fake 测试可显式开启；生产装配必须传入发现快照。 */
  readonly allowUnvalidatedTemplates?: boolean;
  /** 已保留以兼容旧装配；模板业务工具不再与父会话活动工具做子集校验。 */
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
  /** 节点故障通知必须在 terminal waiter 解除前同步进入父会话；false 表示稍后重试。 */
  readonly onTerminal?: (agentId: string) => boolean | void;
  /** 生产 inbox 已在消息接纳点登记 reply；避免监督事件再次登记同一通知。 */
  readonly replyNotificationsHandledByInbox?: boolean;
  /** 生产运行时必须提供根权威端口；省略仅保留旧单节点测试 seam。 */
  readonly authority?: TreeAuthorityPort;
}

interface ManagedAgentEntry {
  readonly supervisor: AgentSupervisor;
  readonly templateId: string;
  readonly name: string;
  readonly unsubscribe: () => void;
}

interface PendingWaiter {
  readonly agentIds: readonly string[];
  readonly resolve: (result: WaitAgentResult) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal?: AbortSignal;
  readonly abortListener?: () => void;
}

interface PendingReplyNotification {
  readonly taskId?: string;
  readonly turnId?: string;
  deliveredToWaiter: boolean;
}

const MAX_PENDING_REPLY_NOTIFICATIONS = 32;

export type WaitAgentEventOutcome =
  | "reply"
  | "task_completed"
  | "task_failed"
  | "task_interrupted"
  | "suspended"
  | "terminal";

export type WaitAgentOutcome = WaitAgentEventOutcome | "timeout";

export interface WaitAgentData {
  readonly agent_id: string;
  readonly outcome: WaitAgentEventOutcome;
  readonly state: AgentSnapshot["state"];
  readonly revision: number;
  readonly error?: AgentSnapshot["error"];
  readonly last_task?: AgentSnapshot["last_task"];
}

export interface WaitAgentTimeoutData {
  readonly agent_ids: readonly string[];
  readonly outcome: "timeout";
}

export type WaitAgentResult = ControlResult<WaitAgentData | WaitAgentTimeoutData>;

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
  readonly task_id: string;
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
  private readonly validateTemplate: AgentControllerOptions["validateTemplate"];
  private readonly waitTimeoutMs: number;
  private readonly onReply: AgentControllerOptions["onReply"];
  private readonly onTerminal: AgentControllerOptions["onTerminal"];
  private readonly replyNotificationsHandledByInbox: boolean;
  private readonly authority: TreeAuthorityPort | undefined;
  private readonly agents = new Map<string, ManagedAgentEntry>();
  /** start 抛出前无法取得公开身份的节点仍需保留内部回收能力。 */
  private readonly unassignedSupervisors = new Map<AgentSupervisor, () => void>();
  private readonly waiters = new Map<string, Set<PendingWaiter>>();
  private readonly pendingWaiters = new Set<PendingWaiter>();
  /** 已注入但尚未被父模型上下文观察的工作中 reply。 */
  private readonly pendingReplyNotifications = new Map<string, Map<string, PendingReplyNotification>>();
  private legacyReplyNotificationSequence = 0;
  private readonly terminalNotifications = new Set<string>();
  private readonly pendingTerminalNotifications = new Set<string>();
  private unsubscribeTreeChange: (() => void) | undefined;
  private readonly confirmedWithoutOwnership = new Set<string>();
  private readonly terminationFlows = new Map<string, Promise<ControlResult<TerminateAgentData>>>();
  private readonly orphanCleanupFlows = new Map<string, Promise<void>>();
  private readonly spawnFlows = new Set<Promise<void>>();
  private shutdownFlow: Promise<boolean> | undefined;
  private shutdownRequested = false;
  private disposed = false;

  constructor(options: AgentControllerOptions) {
    this.tree = options.tree;
    this.actor = options.actor ?? ROOT_TREE_ACTOR;
    this.createSupervisor = options.createSupervisor;
    this.templateSnapshot = options.templateSnapshot;
    this.allowUnvalidatedTemplates = options.allowUnvalidatedTemplates === true;
    this.validateTemplate = options.validateTemplate;
    this.waitTimeoutMs = options.waitTimeoutMs ?? WAIT_AGENT_DEFAULT_TIMEOUT_MS;
    this.onReply = options.onReply;
    this.onTerminal = options.onTerminal;
    this.replyNotificationsHandledByInbox = options.replyNotificationsHandledByInbox === true;
    this.authority = options.authority;
    if (!validWaitTimeout(this.waitTimeoutMs)) throw new TypeError("默认等待期限无效");
    this.unsubscribeTreeChange = this.tree.onChange(() => this.resolveAllReadyWaiters());
  }

  async spawnAgent(input: SpawnAgentInput | unknown): Promise<ControlResult<SpawnAgentData>> {
    if (this.shutdownRequested || this.disposed) return controlFailure("agent_unavailable");
    let finish!: () => void;
    const tracked = new Promise<void>((resolve) => { finish = resolve; });
    this.spawnFlows.add(tracked);
    try {
      return await this.performSpawnAgent(input);
    } finally {
      finish();
      this.spawnFlows.delete(tracked);
    }
  }

  private async performSpawnAgent(input: SpawnAgentInput | unknown): Promise<ControlResult<SpawnAgentData>> {
    if (!isSpawnInput(input)) return controlFailure("invalid_argument");
    let template: TemplateDefinition | undefined;
    let templateRevision: number | undefined;
    if (this.authority !== undefined) {
      const resolved = await this.authority.resolveTemplate(this.actor, input.template_id);
      if (!resolved.ok) return resolved;
      template = resolved.data.template;
      templateRevision = resolved.data.template_revision;
    } else {
      const preflight = this.preflightTemplate(input.template_id);
      if (!preflight.ok) return preflight;
      template = preflight.data;
    }
    // 模板专属 extension 可以注册父会话未知的工具或 provider；只有 child
    // 完成 extension bind 后的 capability manifest 才能裁决实际可用性。
    const reservation: ReserveStartingChildInput = Object.freeze({
      templateId: input.template_id,
      name: input.name,
      ...(template === undefined ? {} : { allowSubagents: template.allowSubagents }),
    });
    let grant: SpawnGrant | undefined;
    if (this.authority !== undefined) {
      if (templateRevision === undefined) return controlFailure("internal_error");
      const reserved = await this.authority.reserveChild(this.actor, {
        template_id: input.template_id,
        template_revision: templateRevision,
        name: input.name,
      });
      if (!reserved.ok) return reserved;
      grant = reserved.data;
      const adopted = this.tree.adoptSpawnGrant(this.actor, {
        node: grant.node,
        lifecycle_generation: grant.lifecycle_generation,
        management_enabled: grant.management_enabled,
      });
      if (!adopted.ok) {
        await this.rollbackUnusedGrant(grant);
        return controlFailure("internal_error");
      }
    }
    let supervisor: AgentSupervisor;
    try {
      supervisor = this.createSupervisor({
        actor: this.actor,
        reservation,
        ...(template === undefined ? {} : { template }),
        ...(grant === undefined ? {} : { grant }),
      });
    } catch {
      if (grant !== undefined) await this.rollbackUnusedGrant(grant);
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
        this.confirmSupervisorCleanup(started.agent_id);
        this.confirmedWithoutOwnership.add(started.agent_id);
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
        this.confirmedWithoutOwnership.add(started.agent_id);
        this.confirmSupervisorCleanup(started.agent_id);
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
    const target = await this.admittedDirectChild(input.agent_id, "send_message");
    if (!target.ok) return target;
    const entry = this.agents.get(input.agent_id);
    if (entry === undefined) return controlFailure("agent_unavailable");
    if (target.data.state === "failed" || target.data.state === "terminating" || target.data.state === "terminated") {
      return controlFailure("agent_unavailable");
    }
    let result: RpcSupervisorCommandResult;
    try {
      result = await entry.supervisor.submit(input.message);
    } catch {
      return controlFailure("message_delivery_failed");
    }
    if (!result.ok) return controlFailure(result.code);
    this.discardReplyNotificationsForOtherTasks(input.agent_id, result.task_id);
    return Object.freeze({
      ok: true,
      data: Object.freeze({
        message_id: result.message_id,
        task_id: result.task_id,
        accepted: true,
      }),
    });
  }

  async waitAgents(input: WaitAgentInput | unknown, signal?: AbortSignal): Promise<WaitAgentResult> {
    const parsed = normalizeWaitAgentInput(input);
    if (parsed === undefined) return controlFailure("invalid_argument");
    for (const agentId of parsed.agent_ids) {
      const target = await this.admittedDirectChild(agentId, "wait_agent");
      if (!target.ok) return target;
    }
    if (signal?.aborted === true) return controlFailure("agent_unavailable");

    const immediate = this.readyWaitResult(parsed.agent_ids);
    if (immediate !== undefined) return immediate;
    const timeout = parsed.timeout_ms ?? this.waitTimeoutMs;

    return new Promise<WaitAgentResult>((resolve) => {
      let waiter!: PendingWaiter;
      const timer = setTimeout(() => {
        this.finishWaiter(waiter, Object.freeze({
          ok: true,
          data: makeWaitTimeoutData(parsed.agent_ids),
        }));
      }, timeout);
      const abortListener = signal === undefined
        ? undefined
        : () => this.finishWaiter(waiter, controlFailure("agent_unavailable"));
      waiter = {
        agentIds: parsed.agent_ids,
        resolve,
        timer,
        ...(signal === undefined ? {} : { signal }),
        ...(abortListener === undefined ? {} : { abortListener }),
      };
      this.pendingWaiters.add(waiter);
      for (const agentId of parsed.agent_ids) {
        const set = this.waiters.get(agentId) ?? new Set<PendingWaiter>();
        set.add(waiter);
        this.waiters.set(agentId, set);
      }
      if (signal !== undefined && abortListener !== undefined) {
        signal.addEventListener("abort", abortListener, { once: true });
      }
      // 原子检查、登记、再次检查，避免事件恰好落在登记边界丢失。
      const ready = signal?.aborted === true
        ? controlFailure("agent_unavailable")
        : this.readyWaitResult(parsed.agent_ids);
      if (ready !== undefined) this.finishWaiter(waiter, ready);
    });
  }

  getWaitTimeoutMs(): number {
    return this.waitTimeoutMs;
  }

  /** 父端 reply inbox 在工作中消息被 Pi 会话接纳后调用。 */
  notifyAgentReply(
    agentId: unknown,
    notificationId?: unknown,
    taskId?: unknown,
    turnId?: unknown,
  ): boolean {
    if (!isCanonicalUuid(agentId) || !this.agents.has(agentId)) return false;
    const status = this.tree.getStatus(agentId);
    if (!status.ok || !canReceiveReplyNotifications(status.data.state)) return false;
    const id = validReplyNotificationId(notificationId)
      ? notificationId
      : this.createLegacyReplyNotificationId();
    let notifications = this.pendingReplyNotifications.get(agentId);
    if (notifications === undefined) {
      notifications = new Map<string, PendingReplyNotification>();
      this.pendingReplyNotifications.set(agentId, notifications);
    }
    let notification = notifications.get(id);
    if (notification === undefined) {
      if (notifications.size >= MAX_PENDING_REPLY_NOTIFICATIONS) {
        const evictable = [...notifications.entries()].find(([, candidate]) => candidate.deliveredToWaiter);
        if (evictable === undefined) {
          const set = this.waiters.get(agentId);
          if (set !== undefined && set.size > 0) {
            const result = Object.freeze({ ok: true as const, data: makeWaitData(status.data, "reply") });
            for (const waiter of [...set]) this.finishWaiter(waiter, result);
          }
          return true;
        }
        notifications.delete(evictable[0]);
      }
      notification = {
        ...(typeof taskId === "string" ? { taskId } : {}),
        ...(typeof turnId === "string" ? { turnId } : {}),
        deliveredToWaiter: false,
      };
      notifications.set(id, notification);
    }
    if (notification.deliveredToWaiter) return true;
    const set = this.waiters.get(agentId);
    if (set !== undefined && set.size > 0) {
      notification.deliveredToWaiter = true;
      const result = Object.freeze({ ok: true as const, data: makeWaitData(status.data, "reply") });
      for (const waiter of [...set]) this.finishWaiter(waiter, result);
    }
    return true;
  }

  /** 父模型上下文已经包含该 custom message 后确认对应通知。 */
  acknowledgeAgentReply(agentId: unknown, notificationId: unknown): boolean {
    if (!isCanonicalUuid(agentId) || !validReplyNotificationId(notificationId)) return false;
    const notifications = this.pendingReplyNotifications.get(agentId);
    if (notifications === undefined || !notifications.delete(notificationId)) return false;
    if (notifications.size === 0) this.pendingReplyNotifications.delete(agentId);
    return true;
  }

  async interruptAgent(agentId: unknown): Promise<ControlResult<InterruptAgentData>> {
    const target = await this.admittedDirectChild(agentId, "interrupt_agent");
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
    if (this.confirmedWithoutOwnership.has(target.data.agent_id)) {
      return controlFailure("agent_unavailable");
    }
    if (target.data.state === "terminated") {
      return Object.freeze({ ok: true, data: {
        agent_id: target.data.agent_id,
        state: "terminated" as const,
        changed: false,
        forced: false,
        terminated_count: 0,
      } });
    }
    const existing = this.terminationFlows.get(target.data.agent_id);
    if (existing !== undefined) return existing;
    const flow = this.runDirectTermination(target.data.agent_id, true);
    this.terminationFlows.set(target.data.agent_id, flow);
    try {
      return await flow;
    } finally {
      if (this.terminationFlows.get(target.data.agent_id) === flow) {
        this.terminationFlows.delete(target.data.agent_id);
      }
    }
  }

  /**
   * 直接父只关闭自己拥有的一个受管节点。该 child 收到 close 后先递归清理其
   * 直接子树；根屏障和逐跳资源确认保证祖先不会越过未确认后代。
   */
  private async runDirectTermination(
    agentId: string,
    useAuthority: boolean,
  ): Promise<ControlResult<TerminateAgentData>> {
    let barrier: TerminationBarrierOutcome;
    if (!useAuthority || this.authority === undefined) {
      const local = this.tree.beginTerminationBarrier(this.actor, agentId);
      if (!local.ok) return local;
      barrier = local.data;
    } else {
      const authorized = await this.authority.beginTermination(this.actor, agentId);
      if (!authorized.ok) return authorized;
      barrier = authorized.data;
      // 投影也建立同一不可逆屏障，停止本地迟到命令与快照发布。
      this.tree.beginTerminationBarrier(this.actor, agentId);
    }
    const terminatedBefore = barrier.agent_ids.filter((memberId) => {
      const member = this.tree.getStatus(memberId);
      return member.ok && member.data.state === "terminated";
    }).length;

    const entry = this.agents.get(agentId);
    if (entry === undefined) {
      this.markTerminationIncomplete(agentId);
      return controlFailure("termination_incomplete");
    }
    let result: RpcSupervisorTerminationResult;
    try {
      result = await entry.supervisor.terminate();
    } catch {
      this.markTerminationIncomplete(agentId);
      return controlFailure("termination_incomplete");
    }
    if (!result.ok) {
      this.markTerminationIncomplete(agentId);
      return controlFailure("termination_incomplete");
    }

    if (useAuthority && this.authority !== undefined) {
      const confirmed = await this.authority.confirmResources(this.actor, agentId);
      if (!confirmed.ok || confirmed.data.node.state !== "terminated") {
        this.markTerminationIncomplete(agentId);
        return controlFailure("termination_incomplete");
      }
    }
    this.confirmTreeResources(agentId);
    const status = this.tree.getStatus(agentId);
    if (!status.ok || status.data.state !== "terminated") {
      this.markTerminationIncomplete(agentId);
      return controlFailure("termination_incomplete");
    }
    this.releaseOwnedSupervisor(agentId, entry);
    const terminatedAfter = barrier.agent_ids.filter((memberId) => {
      const member = this.tree.getStatus(memberId);
      return member.ok && member.data.state === "terminated";
    }).length;
    const terminatedCount = Math.max(0, terminatedAfter - terminatedBefore);
    return Object.freeze({ ok: true, data: Object.freeze({
      agent_id: agentId,
      state: "terminated" as const,
      changed: terminatedCount > 0,
      forced: safeForced(entry.supervisor),
      terminated_count: terminatedCount,
    }) });
  }

  private confirmTreeResources(agentId: string): boolean {
    const status = this.tree.getStatus(agentId);
    if (!status.ok || status.data.state === "terminated") return false;
    const barrier = this.tree.getTerminationBarrier(agentId);
    if (barrier.ok && barrier.data.agent_id === agentId) {
      const confirmation = this.tree.confirmTerminationBarrierResources(agentId);
      return confirmation.ok && confirmation.data.node.state === "terminated";
    }
    const generation = this.tree.getLifecycleGeneration(agentId);
    if (!generation.ok) return false;
    const result = this.tree.applyLifecycleEvent(agentId, {
      type: "resources_confirmed",
      expected_generation: generation.data,
    });
    return result.ok && result.data.applied && result.data.node.state === "terminated";
  }

  private markTerminationIncomplete(agentId: string): void {
    const generation = this.tree.getLifecycleGeneration(agentId);
    if (!generation.ok) return;
    this.tree.applyLifecycleEvent(agentId, {
      type: "termination_incomplete",
      expected_generation: generation.data,
    });
  }

  private confirmSupervisorCleanup(agentId: string): void {
    const barrier = this.tree.beginTerminationBarrier(this.actor, agentId);
    if (!barrier.ok) return;
    const generation = this.tree.getLifecycleGeneration(agentId);
    if (generation.ok) {
      this.tree.applyLifecycleEvent(agentId, {
        type: "resources_confirmed",
        expected_generation: generation.data,
      });
    }
  }

  private releaseOwnedSupervisor(agentId: string, expected: ManagedAgentEntry): void {
    const current = this.agents.get(agentId);
    if (current !== expected) return;
    current.unsubscribe();
    this.agents.delete(agentId);
    this.pendingReplyNotifications.delete(agentId);
    this.terminalNotifications.delete(agentId);
  }

  getAgentStatus(agentId: unknown): ControlResult<AgentSnapshot> {
    const target = this.directChild(agentId);
    return target;
  }

  getAgentTree(): ControlResult<ScopedAgentTreeSnapshot> {
    return this.tree.getTreeSnapshotFor(this.actor);
  }

  async getAgentTemplates(): Promise<ControlResult<readonly AgentTemplateListItem[]>> {
    if (this.authority !== undefined) return this.authority.listTemplates(this.actor);
    return Object.freeze({
      ok: true,
      data: this.templateSnapshot === undefined
        ? Object.freeze([] as AgentTemplateListItem[])
        : listAgentTemplates(this.templateSnapshot),
    });
  }

  /** 根 reload 原子替换未来创建使用的目录，不回溯改变既有节点。 */
  updateTemplateSnapshot(snapshot: TemplateDiscoverySnapshot): void {
    this.templateSnapshot = snapshot;
    this.createSupervisor.updateTemplateSnapshot?.(snapshot);
  }

  /** 新 Pi API 已绑定后，逐个重试未确认的 child reply 与节点故障通知。 */
  async retryPendingReplies(): Promise<void> {
    await Promise.allSettled([...this.agents.values()].map(async ({ supervisor }) => {
      await supervisor.retryPendingReplies?.();
    }));
    for (const agentId of [...this.pendingTerminalNotifications]) {
      if (!this.deliverTerminalNotification(agentId)) continue;
      this.pendingTerminalNotifications.delete(agentId);
      this.terminalNotifications.add(agentId);
      this.resolveWaiters(agentId);
    }
  }

  /**
   * 会话关闭时终止当前控制器拥有的全部节点；不同节点可并行清理。
   *
   * 返回值表示控制器是否已经确认并释放全部资源。未确认时保留监督器
   * 所有权，调用者可以安全地在后续生命周期事件中再次重试。
   */
  async shutdown(): Promise<boolean> {
    return this.beginShutdown(false);
  }

  /** 父监督 close 已在根建立整棵屏障，后代清理不能再依赖已关闭的上游控制流。 */
  async shutdownFromParentBarrier(): Promise<boolean> {
    return this.beginShutdown(true);
  }

  private async beginShutdown(parentBarrierEstablished: boolean): Promise<boolean> {
    if (this.disposed) return true;
    this.shutdownRequested = true;
    const existing = this.shutdownFlow;
    if (existing !== undefined) return existing;
    const flow = this.performShutdown(parentBarrierEstablished);
    this.shutdownFlow = flow;
    try {
      return await flow;
    } finally {
      if (this.shutdownFlow === flow) this.shutdownFlow = undefined;
    }
  }

  private async performShutdown(parentBarrierEstablished: boolean): Promise<boolean> {
    await Promise.allSettled([...this.spawnFlows]);
    const assignedIds = [...this.agents.keys()];
    const unassigned = [...this.unassignedSupervisors.entries()];
    await Promise.allSettled(assignedIds.map((agentId) => parentBarrierEstablished
      ? this.terminateAfterParentBarrier(agentId)
      : this.terminateAgent(agentId)));
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
    const complete = this.agents.size === 0 && this.unassignedSupervisors.size === 0;
    if (complete) this.dispose();
    return complete;
  }

  private async terminateAfterParentBarrier(agentId: string): Promise<void> {
    const status = this.directChild(agentId);
    if (!status.ok || status.data.state === "terminated") return;
    const key = `parent:${agentId}`;
    const existing = this.terminationFlows.get(key);
    const flow = existing ?? this.runDirectTermination(agentId, false);
    if (existing === undefined) this.terminationFlows.set(key, flow);
    try {
      await flow;
    } finally {
      if (this.terminationFlows.get(key) === flow) this.terminationFlows.delete(key);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.shutdownRequested = true;
    this.disposed = true;
    this.unsubscribeTreeChange?.();
    this.unsubscribeTreeChange = undefined;
    for (const waiter of [...this.pendingWaiters]) {
      this.finishWaiter(waiter, controlFailure("agent_unavailable"));
    }
    this.waiters.clear();
    this.pendingWaiters.clear();
    this.pendingReplyNotifications.clear();
    this.terminalNotifications.clear();
    this.pendingTerminalNotifications.clear();
    for (const entry of this.agents.values()) entry.unsubscribe();
    this.agents.clear();
    for (const unsubscribe of this.unassignedSupervisors.values()) unsubscribe();
    this.unassignedSupervisors.clear();
    this.terminationFlows.clear();
    this.orphanCleanupFlows.clear();
  }

  /** grant 已签发但监督器尚未拥有任何资源时，仍按不可逆终止事实关闭身份。 */
  private async rollbackUnusedGrant(grant: SpawnGrant): Promise<void> {
    const agentId = grant.node.agent_id;
    try {
      await this.authority?.beginTermination(this.actor, agentId);
      await this.authority?.confirmResources(this.actor, agentId);
    } catch {
      // 根权威故障时不能伪造已确认；本地投影继续保留 terminating 事实。
    }
    const barrier = this.tree.beginTerminationBarrier(this.actor, agentId);
    if (!barrier.ok) return;
    const generation = this.tree.getLifecycleGeneration(agentId);
    if (!generation.ok) return;
    this.tree.applyLifecycleEvent(agentId, {
      type: "resources_confirmed",
      expected_generation: generation.data,
    });
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

  private async admittedDirectChild(
    agentId: unknown,
    action: AuthorityControlAction,
  ): Promise<ControlResult<AgentSnapshot>> {
    const local = this.directChild(agentId);
    if (!local.ok || this.authority === undefined) return local;
    const admitted = await this.authority.admitControl(this.actor, local.data.agent_id, action);
    if (!admitted.ok) return admitted;
    if (admitted.data.node.agent_id !== local.data.agent_id) return controlFailure("internal_error");
    return local;
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
    // 生产运行时由 ParentReplyInbox 在 custom message 被接纳后登记通知；独立
    // 控制器装配仍从监督事件登记，避免同一消息在两层各计数一次。
    if (
      event.kind === "reply"
      && event.reply.kind === "message"
      && agentId !== undefined
      && this.replyNotificationsHandledByInbox === false
    ) {
      this.notifyAgentReply(agentId, undefined, event.reply.task_id, event.reply.turn_id);
    }
    if (agentId !== undefined && event.kind === "activity") {
      this.tree.updateActivity(agentId, {
        category: event.activity.category,
        active_count: event.activity.active_count,
      });
    }
    let runtimeFailedAgentId: string | undefined;
    if (
      agentId !== undefined
      && (
        event.kind === "fault"
        || (event.kind === "lifecycle" && event.event.type === "runtime_failed")
      )
    ) {
      const status = this.tree.getStatus(agentId);
      if (status.ok && status.data.state === "failed") runtimeFailedAgentId = agentId;
    }
    if (
      runtimeFailedAgentId !== undefined
      && !this.terminalNotifications.has(runtimeFailedAgentId)
      && !this.pendingTerminalNotifications.has(runtimeFailedAgentId)
    ) {
      if (this.deliverTerminalNotification(runtimeFailedAgentId)) {
        this.terminalNotifications.add(runtimeFailedAgentId);
      } else {
        this.pendingTerminalNotifications.add(runtimeFailedAgentId);
      }
    }
    if (agentId !== undefined) this.resolveWaiters(agentId);
    if (runtimeFailedAgentId !== undefined) this.startOrphanTermination(runtimeFailedAgentId);
    if (
      agentId !== undefined
      && event.kind === "lifecycle"
      && event.event.type === "resources_confirmed"
    ) {
      this.releaseTerminatedSupervisor(agentId);
    }
    this.resolveAllReadyWaiters();
  }

  private deliverTerminalNotification(agentId: string): boolean {
    if (this.onTerminal === undefined) return true;
    try {
      return this.onTerminal(agentId) !== false;
    } catch {
      return false;
    }
  }

  /** 运行故障只自动回收后代；故障父节点保持 failed，等待直接父显式终止。 */
  private startOrphanTermination(agentId: string): void {
    const barrier = this.tree.getTerminationBarrier(agentId);
    if (!barrier.ok || barrier.data.agent_id !== agentId || barrier.data.agent_ids.length <= 1) return;
    if (this.orphanCleanupFlows.has(agentId)) return;
    const flow = this.runOrphanTermination(agentId, barrier.data);
    this.orphanCleanupFlows.set(agentId, flow);
    void flow.finally(() => {
      if (this.orphanCleanupFlows.get(agentId) === flow) this.orphanCleanupFlows.delete(agentId);
    }).catch(() => {
      // 后代继续保留 termination_incomplete，显式终止仍可重试平台边界。
    });
  }

  private async runOrphanTermination(
    agentId: string,
    barrier: TerminationBarrierOutcome,
  ): Promise<void> {
    const entry = this.agents.get(agentId);
    const cleanup = entry?.supervisor.reapOrphanedDescendants;
    if (entry === undefined || cleanup === undefined) {
      this.tree.markTerminationBarrierIncomplete(agentId, true);
      return;
    }
    let confirmed = false;
    try {
      confirmed = (await cleanup.call(entry.supervisor)).confirmed;
    } catch {
      confirmed = false;
    }
    if (!confirmed) {
      this.tree.markTerminationBarrierIncomplete(agentId, true);
      return;
    }
    if (this.authority !== undefined) {
      const rootConfirmation = await this.authority.confirmResources(this.actor, agentId);
      if (!rootConfirmation.ok) {
        this.tree.markTerminationBarrierIncomplete(agentId, true);
        return;
      }
    }
    this.tree.confirmTerminationBarrierResources(agentId, true);
  }

  private releaseTerminatedSupervisor(agentId: string): void {
    const status = this.tree.getStatus(agentId);
    if (!status.ok || status.data.state !== "terminated") return;
    const entry = this.agents.get(agentId);
    if (entry === undefined) return;
    entry.unsubscribe();
    this.agents.delete(agentId);
    this.pendingReplyNotifications.delete(agentId);
    this.terminalNotifications.delete(agentId);
  }

  private resolveAllReadyWaiters(): void {
    for (const agentId of [...this.waiters.keys()]) this.resolveWaiters(agentId);
  }

  private resolveWaiters(agentId: string): void {
    const status = this.tree.getStatus(agentId);
    if (status.ok && !canReceiveReplyNotifications(status.data.state)) {
      this.pendingReplyNotifications.delete(agentId);
    }
    const set = this.waiters.get(agentId);
    if (set === undefined) return;
    if (!status.ok) {
      for (const waiter of [...set]) this.finishWaiter(waiter, status);
      return;
    }
    const outcome = this.waitOutcome(agentId, status.data);
    if (outcome === undefined) return;
    for (const waiter of [...set]) this.finishWaiter(waiter, Object.freeze({ ok: true, data: outcome }));
  }

  private finishWaiter(waiter: PendingWaiter, result: WaitAgentResult): void {
    if (!this.pendingWaiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    if (waiter.signal !== undefined && waiter.abortListener !== undefined) {
      waiter.signal.removeEventListener("abort", waiter.abortListener);
    }
    for (const agentId of waiter.agentIds) {
      const set = this.waiters.get(agentId);
      if (set === undefined) continue;
      set.delete(waiter);
      if (set.size === 0) this.waiters.delete(agentId);
    }
    waiter.resolve(result);
  }

  private readyWaitResult(agentIds: readonly string[]): WaitAgentResult | undefined {
    const statuses = new Map<string, AgentSnapshot>();
    for (const agentId of agentIds) {
      const status = this.tree.getStatus(agentId);
      if (!status.ok) return status;
      statuses.set(agentId, status.data);
    }
    for (const agentId of agentIds) {
      const status = statuses.get(agentId)!;
      const pendingReply = this.takeReplyNotification(agentId, status);
      if (pendingReply !== undefined) {
        return Object.freeze({ ok: true, data: pendingReply });
      }
    }
    for (const agentId of agentIds) {
      const outcome = this.waitOutcome(agentId, statuses.get(agentId)!);
      if (outcome !== undefined) return Object.freeze({ ok: true, data: outcome });
    }
    return undefined;
  }

  private waitOutcome(agentId: string, status: AgentSnapshot): WaitAgentData | undefined {
    if (status.state === "suspended") return makeWaitData(status, "suspended");
    if (status.state === "idle") {
      if (status.last_task?.outcome === "failed") return makeWaitData(status, "task_failed");
      if (status.last_task?.outcome === "interrupted") return makeWaitData(status, "task_interrupted");
      return makeWaitData(status, "task_completed");
    }
    if (status.state === "failed") {
      return this.terminalNotifications.has(agentId) ? makeWaitData(status, "terminal") : undefined;
    }
    if (status.state === "terminated" && !this.pendingTerminalNotifications.has(agentId)) {
      return makeWaitData(status, "terminal");
    }
    return undefined;
  }

  private takeReplyNotification(agentId: string, status: AgentSnapshot): WaitAgentData | undefined {
    if (!canReceiveReplyNotifications(status.state)) {
      this.pendingReplyNotifications.delete(agentId);
      return undefined;
    }
    const notifications = this.pendingReplyNotifications.get(agentId);
    if (notifications === undefined) return undefined;
    for (const notification of notifications.values()) {
      if (notification.deliveredToWaiter) continue;
      notification.deliveredToWaiter = true;
      return makeWaitData(status, "reply");
    }
    return undefined;
  }

  private discardReplyNotificationsForOtherTasks(agentId: string, taskId: string): void {
    const notifications = this.pendingReplyNotifications.get(agentId);
    if (notifications === undefined) return;
    for (const [notificationId, notification] of notifications) {
      if (notification.taskId !== undefined && notification.taskId !== taskId) {
        notifications.delete(notificationId);
      }
    }
    if (notifications.size === 0) this.pendingReplyNotifications.delete(agentId);
  }

  private createLegacyReplyNotificationId(): string {
    this.legacyReplyNotificationSequence += 1;
    return `legacy-${this.legacyReplyNotificationSequence}`;
  }
}

function validReplyNotificationId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
}

function canReceiveReplyNotifications(state: AgentSnapshot["state"]): boolean {
  return state === "working" || state === "interrupting";
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
  return isCanonicalUuid(candidate.agent_id)
    && typeof candidate.message === "string"
    && candidate.message.length > 0
    && utf8Length(candidate.message) <= 16 * 1024
    && Object.keys(candidate).every((key) => key === "agent_id" || key === "message");
}

export function normalizeWaitAgentInput(value: unknown): WaitAgentInput | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.agent_ids)) return undefined;
  if (candidate.agent_ids.length < 1 || candidate.agent_ids.length > WAIT_AGENT_MAX_TARGETS) return undefined;
  if (!candidate.agent_ids.every(isCanonicalUuid)) return undefined;
  if (candidate.timeout_ms !== undefined && !validWaitTimeout(candidate.timeout_ms as number)) return undefined;
  if (!Object.keys(candidate).every((key) => key === "agent_ids" || key === "timeout_ms")) return undefined;
  return Object.freeze({
    agent_ids: Object.freeze([...new Set(candidate.agent_ids as string[])]),
    ...(candidate.timeout_ms === undefined ? {} : { timeout_ms: candidate.timeout_ms as number }),
  });
}

function validWaitTimeout(value: number): boolean {
  return Number.isSafeInteger(value) && value >= WAIT_AGENT_MIN_TIMEOUT_MS && value <= WAIT_AGENT_MAX_TIMEOUT_MS;
}

function makeWaitData(status: AgentSnapshot, outcome: WaitAgentEventOutcome): WaitAgentData {
  return Object.freeze({
    agent_id: status.agent_id,
    outcome,
    state: status.state,
    revision: status.revision,
    ...(status.error === undefined ? {} : { error: status.error }),
    ...(status.last_task === undefined ? {} : { last_task: status.last_task }),
  });
}

function makeWaitTimeoutData(agentIds: readonly string[]): WaitAgentTimeoutData {
  return Object.freeze({
    agent_ids: Object.freeze([...agentIds]),
    outcome: "timeout",
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

function interruptData(status: AgentSnapshot, changed: boolean): InterruptAgentData {
  return Object.freeze({
    agent_id: status.agent_id,
    accepted: true,
    changed,
    state: status.state,
    ...(status.error === undefined ? {} : { error: status.error }),
  });
}

function safeForced(supervisor: AgentSupervisor): boolean {
  try {
    return supervisor.wasForcedTerminationUsed() === true;
  } catch {
    return false;
  }
}
