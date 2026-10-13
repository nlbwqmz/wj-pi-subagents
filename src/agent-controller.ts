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
import {
  CANONICAL_ACTIVITY_CONTRACT_VERSION,
  TOOL_ACTIVITY_ENTRY_NAMESPACE,
  deriveNamespaceUuid,
  parseCanonicalAgentActivityEntry,
  type CanonicalAgentActivityEntry,
} from "./canonical-activity.ts";
import { randomUUID } from "node:crypto";
import {
  AgentActivityCache,
  type AgentActivityRecordResult,
  type AgentActivitySettlementState,
  type AgentActivitySnapshot,
} from "./agent-activity-cache.ts";
import {
  AgentDisplayDraftRegistry,
  type AgentDisplayDraftView,
} from "./agent-display-drafts.ts";
import {
  parseCanonicalAgentActivityDisplayEvent,
  sanitizeSafeActivityText,
  DEFAULT_TOOL_EXECUTION_GENERATION,
  isValidToolExecutionGeneration,
  type AgentDisplayStreamUpdate,
  type DisplayStreamRef,
  type SafeAgentActivityDisplayEvent,
  type SafeAgentActivityEvent,
} from "./rpc-bridge-event.ts";
import type {
  SupervisorActivityDelivery,
  SupervisorDisplayDelivery,
} from "./supervisor-channel.ts";

import {
  WAIT_AGENT_DEFAULT_TIMEOUT_MS,
  isValidWaitAgentTimeout,
  parseWaitAgentInput,
  type WaitAgentInput,
} from "./wait-agent-arguments.ts";

export {
  WAIT_AGENT_DEFAULT_TIMEOUT_MS,
  WAIT_AGENT_MAX_TARGETS,
  WAIT_AGENT_MAX_TIMEOUT_MS,
  WAIT_AGENT_MIN_TIMEOUT_MS,
  normalizeWaitAgentInput,
} from "./wait-agent-arguments.ts";
export type { WaitAgentInput } from "./wait-agent-arguments.ts";

export interface SpawnAgentInput {
  readonly template_id: string;
  readonly name: string;
}

export interface SendMessageInput {
  readonly agent_id: string;
  readonly message: string;
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
  /** 消息直接调用接收侧 Pi；成功只表示 Pi 已同步接纳。 */
  sendMessage(message: string): Promise<RpcSupervisorCommandResult>;
  /** 读取接收侧 Pi 的真实状态并校准生命周期；旧替身可省略。 */
  synchronizeState?(): Promise<boolean>;
  interrupt(): Promise<RpcSupervisorInterruptResult>;
  terminate(): Promise<RpcSupervisorTerminationResult>;
  /** 故障节点的平台进程树边界回收；节点记录本身继续保持 failed。 */
  reapOrphanedDescendants?(): Promise<{ readonly confirmed: boolean; readonly forced: boolean }>;
  /** reload 时让既有监督通道进入快照重同步窗口，丢弃边界前的展示帧。 */
  resetActivityDelivery?(): void;
  onEvent(listener: (event: RpcSupervisorEvent) => void): () => void;
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
  /** 故障后代已由受管监督器回收、根权威 confirm 前刷新本地上行生命周期事实。 */
  readonly flushUpstreamLifecycle?: () => Promise<void>;
  /** 生产 inbox 已在父扩展消息提交点登记 reply；避免监督事件再次登记同一通知。 */
  readonly replyNotificationsHandledByInbox?: boolean;
  /** 生产运行时必须提供根权威端口；省略仅保留旧单节点测试 seam。 */
  readonly authority?: TreeAuthorityPort;
  /**
   * 子模式运行时提供的上游活动流转发端口；fire-and-forget，无确认或屏障。
   * 根会话不提供，活动流终止于本地缓存。
   */
  readonly publishUpstreamActivity?: (delivery: SupervisorActivityDelivery) => void;
  /**
   * 子模式运行时提供的上游实时显示流转发端口；fire-and-forget。根会话不
   * 提供，显示草稿终止于本地登记表。
   */
  readonly publishUpstreamDisplayActivity?: (delivery: SupervisorDisplayDelivery) => void;
}

interface ManagedAgentEntry {
  readonly supervisor: AgentSupervisor;
  readonly templateId: string;
  readonly name: string;
  unsubscribe: () => void;
}

interface OwnToolExecutionState {
  readonly generation: number;
  readonly toolName: string;
  readonly origin: string;
  readonly open: boolean;
}

interface PendingWaiter {
  readonly agentIds: readonly string[];
  readonly resolve: (result: WaitAgentResult) => void;
  readonly reject: (reason: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal?: AbortSignal;
  readonly abortListener?: () => void;
}

interface PendingReplyNotification {
  readonly event: "reply" | "final_report" | "idle" | "terminal";
  readonly sequence: number;
  deliveredToWaiter: boolean;
}

export type WaitAgentEventOutcome =
  | "reply"
  | "final_report"
  | "idle"
  | "terminal"
  ;

export type WaitAgentOutcome = WaitAgentEventOutcome | "timeout" | "woken";

export interface WaitAgentData {
  readonly agent_id: string;
  readonly outcome: WaitAgentEventOutcome;
  readonly state: AgentSnapshot["state"];
  readonly revision: number;
  /** 目标最近一次 settle 是否由中断触发；事实不可得时缺省。 */
  readonly aborted?: boolean;
  readonly error?: AgentSnapshot["error"];
}

export interface WaitAgentTimeoutData {
  readonly agent_ids: readonly string[];
  readonly outcome: "timeout";
}

/** 父代理消息唤醒：目标列表事实与 timeout 同构，另带固定唤醒原因。 */
export interface WaitAgentWokenData {
  readonly agent_ids: readonly string[];
  readonly outcome: "woken";
  readonly wake_reason: "parent_input";
}

export type WaitAgentResult = ControlResult<WaitAgentData | WaitAgentTimeoutData | WaitAgentWokenData>;

export interface InterruptAgentData {
  readonly agent_id: string;
  readonly accepted: true;
  readonly changed: boolean;
  readonly state: AgentSnapshot["state"];
  readonly blocked_reason?: "compaction_active";
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
  private readonly flushUpstreamLifecycle: AgentControllerOptions["flushUpstreamLifecycle"];
  private readonly replyNotificationsHandledByInbox: boolean;
  private readonly authority: TreeAuthorityPort | undefined;
  private readonly publishUpstreamActivity: AgentControllerOptions["publishUpstreamActivity"];
  private readonly publishUpstreamDisplayActivity: AgentControllerOptions["publishUpstreamDisplayActivity"];
  private readonly activityCache = new AgentActivityCache();
  /**
   * 顶层实时显示草稿登记表：即使详情未打开也按代理持续组装连续前缀。
   * 中间运行时只逐层转发显示事实，不缓存草稿。
   */
  private readonly displayDrafts = new AgentDisplayDraftRegistry();
  /** 本控制器运行实例身份：reload 后切换，避免新旧活动条目串流。 */
  private activityIncarnationId = randomUUID();
  /** 旧订阅回调若在 reload 后才执行，只允许继续处理非展示事件。 */
  private activityDeliveryGeneration = 0;
  /** 产生端 legacy 调用未携带代次时，由控制器补足并保持 start/end 关联。 */
  private readonly ownToolExecutionStates = new Map<string, OwnToolExecutionState>();
  private readonly agents = new Map<string, ManagedAgentEntry>();
  /** start 抛出前无法取得公开身份的节点仍需保留内部回收能力。 */
  private readonly unassignedSupervisors = new Map<AgentSupervisor, () => void>();
  private readonly waiters = new Map<string, Set<PendingWaiter>>();
  private readonly pendingWaiters = new Set<PendingWaiter>();
  /** 已提交但尚未被父模型上下文观察的会话通知。 */
  private readonly pendingReplyNotifications = new Map<string, Map<string, PendingReplyNotification>>();
  private replyNotificationSequence = 0;
  /** 当前父 Pi 回合开始前已经进入父会话的通知水位。 */
  private parentTurnNotificationWatermark = 0;
  private readyWaitersResolutionScheduled = false;
  /** 终止事实只允许产生一次 terminal 事件，即使资源确认和故障观察重复抵达。 */
  private readonly observedTerminalEvents = new Set<string>();
  private readonly terminalNotifications = new Set<string>();
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
    this.flushUpstreamLifecycle = options.flushUpstreamLifecycle;
    this.replyNotificationsHandledByInbox = options.replyNotificationsHandledByInbox === true;
    this.authority = options.authority;
    this.publishUpstreamActivity = options.publishUpstreamActivity;
    this.publishUpstreamDisplayActivity = options.publishUpstreamDisplayActivity;
    if (!isValidWaitAgentTimeout(this.waitTimeoutMs)) throw new TypeError("默认等待期限无效");
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
    const earlyEvents: Array<{ readonly event: RpcSupervisorEvent; readonly deliveryGeneration: number }> = [];
    const subscriptionGeneration = this.activityDeliveryGeneration;
    const unsubscribe = supervisor.onEvent((event) => {
      if (assignedAgentId === undefined) earlyEvents.push({ event, deliveryGeneration: subscriptionGeneration });
      else this.handleSupervisorEvent(assignedAgentId, event, subscriptionGeneration);
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
      return controlFailure(started.code, started.details);
    }
    if (!started.ok) {
      unsubscribe();
      return controlFailure(started.code, started.details);
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

    // 权威快照可能在续跑期间先收到旧 settled 事实；发送前让接收侧
    // 用 Pi 的 get_state 校准一次，再依据最新本地状态决定是否接单。
    try {
      await entry.supervisor.synchronizeState?.();
    } catch {
      // 无法确认时保留现有生命周期裁决；监督器内部不会伪造 idle。
    }
    const refreshed = this.tree.getStatus(input.agent_id);
    if (!refreshed.ok) return refreshed;
    if (refreshed.data.state === "starting") return controlFailure("agent_unavailable");
    if (refreshed.data.state === "interrupting") return controlFailure("message_delivery_failed");
    if (refreshed.data.state === "failed" || refreshed.data.state === "terminating" || refreshed.data.state === "terminated") {
      return controlFailure("agent_unavailable");
    }
    let result: RpcSupervisorCommandResult;
    try {
      result = await entry.supervisor.sendMessage(input.message);
    } catch {
      return controlFailure("message_delivery_failed");
    }
    if (!result.ok || result.accepted !== true) {
      return controlFailure(result.ok === false && result.code === "compaction_active"
        ? "compaction_active"
        : "message_delivery_failed");
    }
    // 只有接收侧同步接纳后才写入接收者活动历史；未接纳输入不产生条目。
    this.recordParentMessage(input.agent_id, input.message);
    return Object.freeze({
      ok: true,
      data: Object.freeze({
        accepted: true,
      }) as unknown as AgentMessageData,
    });
  }

  async waitAgents(input: WaitAgentInput | unknown, signal?: AbortSignal): Promise<WaitAgentResult> {
    const parsedResult = parseWaitAgentInput(input);
    if (!parsedResult.ok) return controlFailure("invalid_argument", parsedResult.issue);
    const parsed = parsedResult.value;
    for (const agentId of parsed.agent_ids) {
      const target = await this.admittedDirectChild(agentId, "wait_agent");
      if (!target.ok) return target;
      const entry = this.agents.get(agentId);
      try {
        await entry?.supervisor.synchronizeState?.();
      } catch {
        // 状态探针失败时等待器保留最近一次安全快照，不伪造 terminal 或 idle。
      }
    }
    if (signal?.aborted === true) throw operationAbortedError();

    const immediate = this.readyWaitResult(parsed.agent_ids);
    if (immediate !== undefined) return immediate;
    const timeout = parsed.timeout_ms ?? this.waitTimeoutMs;

    return new Promise<WaitAgentResult>((resolve, reject) => {
      let waiter!: PendingWaiter;
      const timer = setTimeout(() => {
        this.finishWaiter(waiter, Object.freeze({
          ok: true,
          data: makeWaitTimeoutData(parsed.agent_ids),
        }));
      }, timeout);
      const abortListener = signal === undefined
        ? undefined
        : () => this.abortWaiter(waiter);
      waiter = {
        agentIds: parsed.agent_ids,
        resolve,
        reject,
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
      if (signal?.aborted === true) {
        this.abortWaiter(waiter);
        return;
      }
      const ready = this.readyWaitResult(parsed.agent_ids);
      if (ready !== undefined) this.finishWaiter(waiter, ready);
    });
  }

  /**
   * 父代理消息到达时释放当前所有活跃 wait waiter，作为与 timeout 同级的
   * 独立结束原因：它只表示父输入已抵达，不表示被等待的目标已产生事件。
   * 已就绪的真实事件（快照或未投递通知）仍优先返回；本入口不登记任何会话
   * 事件、不改写回合水位，也不重置计时；无活跃 waiter 时是纯 no-op。
   */
  wakeWaitersForParentInput(): void {
    if (this.pendingWaiters.size === 0) return;
    for (const waiter of [...this.pendingWaiters]) {
      const ready = this.readyWaitResult(waiter.agentIds);
      if (ready !== undefined) {
        this.finishWaiter(waiter, ready);
        continue;
      }
      this.finishWaiter(waiter, Object.freeze({
        ok: true,
        data: makeWaitWokenData(waiter.agentIds),
      }));
    }
  }

  getWaitTimeoutMs(): number {
    return this.waitTimeoutMs;
  }

  /**
   * 记录父 Pi 新回合的通知观察边界。回合开始前已经提交给扩展消息 API 的
   * 消息属于当前回合输入，不应在本回合或后续回合再次作为 wait_agent 事件返回；
   * 回合开始后新到达的消息仍保留给当前回合内的等待。
   */
  beginParentTurn(): void {
    this.parentTurnNotificationWatermark = this.replyNotificationSequence;
    this.discardObservedReplyNotifications();
  }

  /** 会话通知登记入口；reply/final_report 只在当前活动状态下接受。 */
  notifySessionEvent(
    agentId: unknown,
    event: "reply" | "final_report" | "idle" | "terminal",
  ): boolean {
    if (!isCanonicalUuid(agentId)) return false;
    if (event !== "reply" && event !== "final_report" && event !== "idle" && event !== "terminal") {
      return false;
    }
    const status = this.tree.getStatus(agentId);
    if (!status.ok) return false;
    if (
      (event === "reply" || event === "final_report")
      && status.data.state !== "working"
      && status.data.state !== "interrupting"
    ) return false;
    if (event === "idle" && status.data.state !== "idle") return false;
    if (event === "terminal" && status.data.state !== "failed" && status.data.state !== "terminated") {
      return false;
    }
    return this.recordSessionNotification(agentId, event, status.data);
  }

  /**
   * 父端 fire-and-forget 扩展 API 已接受 child 消息提交后的内部事实入口。
   * 提交结果与生命周期事件由不同传输帧承载，故 settled 可能先到；此入口
   * 保留已提交消息，不把 idle 快照误当成消息失败。它只接受普通回复和显式
   * 报告，且拒绝终止屏障后的帧。
   */
  recordDispatchedSessionEvent(
    agentId: unknown,
    event: "reply" | "final_report",
  ): boolean {
    if (!isCanonicalUuid(agentId)) return false;
    const status = this.tree.getStatus(agentId);
    if (!status.ok) return false;
    if (
      status.data.state !== "idle"
      && status.data.state !== "working"
      && status.data.state !== "interrupting"
    ) return false;
    return this.recordSessionNotification(agentId, event, status.data);
  }

  private recordSessionNotification(
    agentId: string,
    event: "reply" | "final_report" | "idle" | "terminal",
    status: AgentSnapshot,
  ): boolean {
    if (event === "terminal") {
      // 同一生命周期只能有一个终止事实；故障通知和资源确认可能从不同
      // 观察路径抵达，但不能把一个终止拆成多个 waiter 事件。
      if (this.observedTerminalEvents.has(agentId)) return true;
      this.observedTerminalEvents.add(agentId);
    }
    const sequence = this.replyNotificationSequence + 1;
    this.replyNotificationSequence = sequence;
    const id = `reply-${sequence}`;
    let notifications = this.pendingReplyNotifications.get(agentId);
    if (notifications === undefined) {
      notifications = new Map<string, PendingReplyNotification>();
      this.pendingReplyNotifications.set(agentId, notifications);
    }
    let notification = notifications.get(id);
    if (notification === undefined) {
      notification = {
        event,
        sequence,
        deliveredToWaiter: false,
      };
      notifications.set(id, notification);
    }
    if (notification.deliveredToWaiter) return true;
    const set = this.waiters.get(agentId);
    if (set !== undefined && set.size > 0) {
      notification.deliveredToWaiter = true;
      const result = Object.freeze({ ok: true as const, data: makeWaitData(status, notification.event) });
      for (const waiter of [...set]) this.finishWaiter(waiter, result);
      notifications.delete(id);
      if (notifications.size === 0) this.pendingReplyNotifications.delete(agentId);
    }
    return true;
  }

  async interruptAgent(agentId: unknown): Promise<ControlResult<InterruptAgentData>> {
    const target = await this.admittedDirectChild(agentId, "interrupt_agent");
    if (!target.ok) return target;
    const entry = this.agents.get(target.data.agent_id);
    if (entry === undefined) return controlFailure("agent_unavailable");
    try {
      await entry.supervisor.synchronizeState?.();
    } catch {
      // 状态探针失败时不猜测当前回合是否仍在运行。
    }
    const current = this.tree.getStatus(target.data.agent_id);
    if (!current.ok) return current;
    if (current.data.state === "starting") return controlFailure("agent_unavailable");
    if (current.data.state === "idle" || current.data.state === "interrupting" || current.data.state === "failed" || current.data.state === "terminating" || current.data.state === "terminated") {
      return Object.freeze({ ok: true, data: interruptData(current.data, false) });
    }
    let result: RpcSupervisorInterruptResult;
    try {
      result = await entry.supervisor.interrupt();
    } catch {
      return controlFailure("agent_unavailable");
    }
    if (!result.ok) return controlFailure(result.code);
    // 只有实际改变监督器状态的接纳才建立 interrupting 屏障；回到 idle
    // 只能由后续真实 agent_settled 事实触发。
    if (result.changed && result.blocked_reason === undefined) {
      const generation = this.tree.getLifecycleGeneration(target.data.agent_id);
      if (generation.ok && current.data.state === "working") {
        this.tree.applyLifecycleEvent(target.data.agent_id, {
          type: "interrupt_accepted",
          expected_generation: generation.data,
        });
      }
    }
    const latest = this.tree.getStatus(target.data.agent_id);
    if (!latest.ok) return controlFailure("agent_not_found");
    return Object.freeze({ ok: true, data: interruptData(latest.data, result.changed, result.blocked_reason) });
  }

  async terminateAgent(agentId: unknown): Promise<ControlResult<TerminateAgentData>> {
    const target = this.directChild(agentId);
    if (!target.ok) return target;
    if (this.confirmedWithoutOwnership.has(target.data.agent_id)) {
      return controlFailure("agent_unavailable");
    }
    if (target.data.state === "terminated") {
      // 幂等终止也必须补做活动收束：外部生命周期可能先把树投影为
      // terminated，但没有经过本控制器的正常 resources_confirmed 回调。
      this.settleActivityForAgents([target.data.agent_id], "terminated");
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
    // authority.confirmResources 可能已先把整棵屏障投影为 terminal，导致
    // confirmTreeResources 走幂等短路；无论哪条路径完成确认，都直接收束
    // 顶层活动缓存与实时草稿。
    this.settleActivityForAgents(barrier.agent_ids, "terminated");
    // 资源确认可能由父权威一次性提交整棵屏障，而不是由 child supervisor
    // 单独产生 resources_confirmed 事件；此处补登记 target 的 terminal 事实。
    this.notifySessionEvent(agentId, "terminal");
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

  private settleActivityForAgents(
    agentIds: readonly string[],
    state: AgentActivitySettlementState,
  ): void {
    for (const memberId of agentIds) {
      // 子控制器本身不保留历史，调用仍保持幂等；根控制器负责清除顶层
      // 草稿并让 running 工具立即退出 pin 状态。
      this.displayDrafts.settleAgent(memberId);
      this.activityCache.settleAgent(memberId, state);
    }
  }

  private confirmTreeResources(agentId: string): boolean {
    const status = this.tree.getStatus(agentId);
    if (!status.ok || status.data.state === "terminated") return false;
    const barrier = this.tree.getTerminationBarrier(agentId);
    if (barrier.ok && barrier.data.agent_id === agentId) {
      const confirmation = this.tree.confirmTerminationBarrierResources(agentId);
      if (!confirmation.ok || confirmation.data.node.state !== "terminated") return false;
      this.settleActivityForAgents(barrier.data.agent_ids, "terminated");
      return true;
    }
    const generation = this.tree.getLifecycleGeneration(agentId);
    if (!generation.ok) return false;
    const result = this.tree.applyLifecycleEvent(agentId, {
      type: "resources_confirmed",
      expected_generation: generation.data,
    });
    if (!result.ok || !result.data.applied || result.data.node.state !== "terminated") return false;
    this.settleActivityForAgents([agentId], "terminated");
    return true;
  }

  private markTerminationIncomplete(agentId: string): void {
    // 清理未完成是资源观察诊断，不是新的生命周期事实；节点继续保持
    // terminating/failed，后续重试仍由同一终止屏障裁决。
    this.tree.markTerminationBarrierIncomplete(agentId);
  }

  private confirmSupervisorCleanup(agentId: string): void {
    const barrier = this.tree.beginTerminationBarrier(this.actor, agentId);
    if (!barrier.ok) return;
    const generation = this.tree.getLifecycleGeneration(agentId);
    if (generation.ok) {
      const result = this.tree.applyLifecycleEvent(agentId, {
        type: "resources_confirmed",
        expected_generation: generation.data,
      });
      if (result.ok && result.data.applied && result.data.node.state === "terminated") {
        this.settleActivityForAgents(barrier.data.agent_ids, "terminated");
        this.notifySessionEvent(agentId, "terminal");
      }
    }
  }

  private releaseOwnedSupervisor(agentId: string, expected: ManagedAgentEntry): void {
    const current = this.agents.get(agentId);
    if (current !== expected) return;
    current.unsubscribe();
    this.agents.delete(agentId);
    this.terminalNotifications.delete(agentId);
  }

  getAgentStatus(agentId: unknown): ControlResult<AgentSnapshot> {
    const target = this.directChild(agentId);
    return target;
  }

  async synchronizeAgentStatus(agentId: unknown): Promise<ControlResult<AgentSnapshot>> {
    const target = await this.admittedDirectChild(agentId, "get_agent_status");
    if (!target.ok) return target;
    const entry = this.agents.get(target.data.agent_id);
    try {
      await entry?.supervisor.synchronizeState?.();
    } catch {
      // 返回最近一次本地安全快照，不把一次探针故障升级为节点故障。
    }
    return this.directChild(target.data.agent_id);
  }

  getAgentTree(): ControlResult<ScopedAgentTreeSnapshot> {
    return this.tree.getTreeSnapshotFor(this.actor);
  }

  private ownToolEntryIdentity(
    event: Extract<SafeAgentActivityEvent, {
      readonly type: "tool_execution_start" | "tool_execution_end";
    }>,
  ): {
    readonly entryId: string;
    readonly executionGeneration: number;
    readonly nextState: OwnToolExecutionState | undefined;
  } | undefined {
    const suppliedGeneration = event.executionGeneration;
    if (
      suppliedGeneration !== undefined
      && !isValidToolExecutionGeneration(suppliedGeneration)
    ) return undefined;
    const previous = this.ownToolExecutionStates.get(event.toolCallId);
    let generation: number;
    let nextState: OwnToolExecutionState | undefined;
    if (suppliedGeneration !== undefined) {
      generation = suppliedGeneration;
      const stale = previous !== undefined && generation < previous.generation;
      const lateStartForClosedGeneration = event.type === "tool_execution_start"
        && previous !== undefined
        && generation === previous.generation
        && previous.open === false;
      // 迟到旧代次仍可形成其自身 entry 身份，但绝不回退账本或重开
      // 最新已完成 invocation。
      if (!stale && !lateStartForClosedGeneration) {
        nextState = {
          generation,
          toolName: event.toolName,
          origin: event.origin,
          open: event.type === "tool_execution_start",
        };
      }
    } else if (
      event.type === "tool_execution_start"
      && previous !== undefined
      && previous.open
      && previous.toolName === event.toolName
      && previous.origin === event.origin
    ) {
      generation = previous.generation;
      nextState = {
        generation,
        toolName: event.toolName,
        origin: event.origin,
        open: true,
      };
    } else {
      generation = event.type === "tool_execution_end"
        ? previous?.generation ?? DEFAULT_TOOL_EXECUTION_GENERATION
        : (previous?.generation ?? 0) + 1;
      nextState = {
        generation,
        toolName: event.toolName,
        origin: event.origin,
        open: event.type === "tool_execution_start",
      };
    }
    return {
      entryId: deriveNamespaceUuid(
        TOOL_ACTIVITY_ENTRY_NAMESPACE,
        `${this.activityIncarnationId}:${event.toolCallId}:${generation}`,
      ),
      executionGeneration: generation,
      nextState,
    };
  }

  /**
   * 子模式运行时把当前 Pi 节点自身的完整活动封装为规范条目并沿上游端口
   * 转发；中间运行时不保存历史。根没有可上行的代理身份，返回 false。
   *
   * 工具开始与结束是同一条目的状态事实：条目身份由运行实例、工具活动 ID
   * 与执行代次确定性派生，两者在缓存、回放与去重中聚合为同一原子条目；
   * assistant 消息仍是每条独立身份的原子条目，且可携带与实时显示流的
   * 精确有序关联身份（displayStream），供顶层原地替换对应草稿。
   */
  recordOwnActivity(event: SafeAgentActivityEvent, displayStream?: DisplayStreamRef): boolean {
    if (this.actor.kind !== "agent") return false;
    let body: SafeAgentActivityEvent;
    let entryId: string;
    let nextToolExecutionState: { readonly toolCallId: string; readonly state: OwnToolExecutionState } | undefined;
    if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
      const identity = this.ownToolEntryIdentity(event);
      if (identity === undefined) return false;
      body = Object.freeze({ ...event, executionGeneration: identity.executionGeneration });
      entryId = identity.entryId;
      if (identity.nextState !== undefined) {
        nextToolExecutionState = {
          toolCallId: event.toolCallId,
          state: identity.nextState,
        };
      }
    } else {
      const fullDisplayStream = event.type === "message"
        ? displayStream ?? event.displayStream
        : undefined;
      if (event.type === "message" && fullDisplayStream !== undefined) {
        const { streamId: _legacyStreamId, displayStream: _eventDisplayStream, ...message } = event;
        body = Object.freeze({ ...message, displayStream: fullDisplayStream });
      } else {
        body = event;
      }
      entryId = randomUUID();
    }
    const candidate: CanonicalAgentActivityEntry = Object.freeze({
      contract_version: CANONICAL_ACTIVITY_CONTRACT_VERSION,
      agent_id: this.actor.agent_id,
      incarnation_id: this.activityIncarnationId,
      entry_id: entryId,
      body,
    });
    const parsed = parseCanonicalAgentActivityEntry(candidate);
    if (parsed.kind !== "entry") return false;
    if (nextToolExecutionState !== undefined) {
      // 仅在 canonical 结构通过后提交账本；非法 host 事实不应消耗代次。
      this.ownToolExecutionStates.set(
        nextToolExecutionState.toolCallId,
        nextToolExecutionState.state,
      );
    }
    try {
      this.publishUpstreamActivity?.(Object.freeze({ agent_id: this.actor.agent_id, entry: parsed.entry }));
    } catch {
      // 上行转发失败静默缺失，不改变节点生命周期。
    }
    return true;
  }

  /**
   * 子模式运行时把自身产生的实时显示事实沿上游端口逐层转发；fire-and-forget，
   * 失败静默缺失且不改变节点生命周期。产生端更新在这里登记完整流身份：
   * agentId 取当前代理，incarnationId 取本运行实例身份，使 delta 与 complete
   * 携带同一身份，且与权威消息的关联身份一致。
   */
  recordOwnDisplayEvent(
    update: AgentDisplayStreamUpdate | SafeAgentActivityDisplayEvent,
  ): boolean {
    if (this.actor.kind !== "agent") return false;
    const candidate = Object.freeze({
      ...update,
      agentId: this.actor.agent_id,
      incarnationId: this.activityIncarnationId,
    });
    const parsed = parseCanonicalAgentActivityDisplayEvent(candidate);
    if (parsed.kind !== "event") return false;
    try {
      this.publishUpstreamDisplayActivity?.(
        Object.freeze({ agent_id: this.actor.agent_id, event: parsed.event }),
      );
    } catch {
      // 上行转发失败静默缺失；实时预览最终以权威完整消息为准。
    }
    return true;
  }

  /** 该代理的全量活动流回放（按到达序）；未知代理为空。 */
  getActivityReplay(agentId: unknown): readonly CanonicalAgentActivityEntry[] {
    if (!isCanonicalUuid(agentId)) return Object.freeze([]);
    return this.activityCache.replay(agentId);
  }

  /** 该代理的活动流修订号；未知代理为 0。 */
  getActivityRevision(agentId: unknown): number {
    if (!isCanonicalUuid(agentId)) return 0;
    return this.activityCache.revision(agentId);
  }

  /**
   * 读取带淘汰事实的活动快照。旧的 getActivityReplay 继续只返回 entries；
   * reload 会通过 resetActivityForReload() 把该快照与 omission 标记一并归零。
   */
  getActivitySnapshot(agentId: unknown): AgentActivitySnapshot {
    return this.activityCache.snapshot(agentId);
  }

  /** 活动历史是否曾发生过容量淘汰；仅在当前 reload 观察代际内成立。 */
  hasOlderActivityOmitted(agentId: unknown): boolean {
    return isCanonicalUuid(agentId)
      && this.activityCache.hasOlderActivityOmitted(agentId);
  }

  /** 注册活动流变更观察者；回调携带发生变更的代理身份。 */
  onActivityChange(listener: (agentId: string) => void): () => void {
    return this.activityCache.onChange(listener);
  }

  /**
   * 该代理的实时草稿快照（从 sequence 1 开始的连续前缀）。草稿只存在于
   * 顶层登记表，不进入回放、修订号或持久历史。
   */
  getDisplayDrafts(agentId: unknown): readonly AgentDisplayDraftView[] {
    if (!isCanonicalUuid(agentId)) return Object.freeze([]);
    return this.displayDrafts.drafts(agentId);
  }

  /**
   * reload 开始新的活动观察代际：历史、工具条目、淘汰事实、实时草稿和本地
   * 工具账本全部丢弃。旧回调先由 delivery generation 隔离；重新订阅时暂缓
   * 接纳 activity/display，直到对应通道已同步切入既有 snapshot 重同步窗口。
   * 因此边界前尚在传输或回调队列中的帧不能复活，同时不会丢失同步返回的
   * reset snapshot 后新帧。
   */
  resetActivityForReload(): boolean {
    this.activityDeliveryGeneration += 1;
    const deliveryGeneration = this.activityDeliveryGeneration;
    this.activityIncarnationId = randomUUID();
    this.ownToolExecutionStates.clear();
    const historyCleared = this.activityCache.clear();
    const draftsCleared = this.displayDrafts.clear();
    const resetDeliveries: Array<() => void> = [];

    // 已被异步源捕获的旧回调保留旧 generation；即使取消订阅后才执行，也
    // 只会被 handleSupervisorEvent 静默丢弃其 activity/display 事实。新的
    // 订阅若同步重放旧数据，则在 resetActivityDelivery 建立 resync 前同样丢弃。
    for (const [agentId, entry] of this.agents) {
      try {
        entry.unsubscribe();
      } catch {
        // 退订异常不恢复旧活动可见性。
      }
      let acceptsActivityDelivery = false;
      try {
        entry.unsubscribe = entry.supervisor.onEvent((event) => {
          if (
            !acceptsActivityDelivery
            && (
              event.kind === "activity"
              || event.kind === "activity_stream"
              || event.kind === "activity_display"
            )
          ) return;
          this.handleSupervisorEvent(agentId, event, deliveryGeneration);
        });
      } catch {
        entry.unsubscribe = () => {};
      }
      resetDeliveries.push(() => {
        // 生产通道在 requestSnapshot() 中先同步进入 resyncing，再开始传输；
        // 因而此后同步抵达的活动帧已属于 reset snapshot 之后的新观察代际。
        acceptsActivityDelivery = true;
        entry.supervisor.resetActivityDelivery?.();
      });
    }

    for (const resetDelivery of resetDeliveries) {
      try {
        resetDelivery();
      } catch {
        // 旧 fake 或已经关闭的监督器不能阻断本地清空。
      }
    }

    return historyCleared || draftsCleared;
  }

  /** reload 只清除实时草稿；新语义需要丢弃完整历史时使用 resetActivityForReload。 */
  clearDisplayDrafts(): boolean {
    return this.displayDrafts.clear();
  }

  /** 语义别名：产生端切换 display epoch，不影响活动缓存。 */
  resetDisplayDrafts(
    displayEpoch?: string,
    displaySourceGeneration?: number,
  ): boolean {
    const cleared = this.clearDisplayDrafts();
    if (displayEpoch === undefined && displaySourceGeneration === undefined) return cleared;
    if (
      !isCanonicalUuid(displayEpoch)
      || typeof displaySourceGeneration !== "number"
      || !Number.isSafeInteger(displaySourceGeneration)
      || displaySourceGeneration < 1
    ) return cleared;
    if (this.actor.kind !== "agent") return cleared;
    const candidate = Object.freeze({
      type: "display_reset" as const,
      agentId: this.actor.agent_id,
      incarnationId: this.activityIncarnationId,
      displayEpoch,
      displaySourceGeneration,
    });
    const parsed = parseCanonicalAgentActivityDisplayEvent(candidate);
    if (parsed.kind !== "event" || parsed.event.type !== "display_reset") return cleared;
    try {
      // 这是无状态控制事实：只提交一次，不等待 ACK、不建立重试或历史副本。
      this.publishUpstreamDisplayActivity?.(
        Object.freeze({ agent_id: this.actor.agent_id, event: parsed.event }),
      );
    } catch {
      // reset barrier 与普通显示事实一样是尽力而为；权威消息仍可替换草稿。
    }
    return true;
  }

  /**
   * 注册实时显示草稿变更观察者。该通道没有 replay、修订号或持久化；观察者
   * 收到通知后应重新拉取对应代理的草稿快照。
   */
  onActivityDisplayChange(
    listener: (agentId: string) => void,
  ): () => void {
    return this.displayDrafts.onChange(listener);
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
    if (!status.ok) return;
    if (status.data.state === "terminated") {
      this.settleActivityForAgents([agentId], "terminated");
      return;
    }
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
    this.observedTerminalEvents.clear();
    this.terminalNotifications.clear();
    for (const entry of this.agents.values()) entry.unsubscribe();
    this.agents.clear();
    for (const unsubscribe of this.unassignedSupervisors.values()) unsubscribe();
    this.unassignedSupervisors.clear();
    this.terminationFlows.clear();
    this.orphanCleanupFlows.clear();
    this.ownToolExecutionStates.clear();
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
    const outcome = this.tree.applyLifecycleEvent(agentId, {
      type: "resources_confirmed",
      expected_generation: generation.data,
    });
    if (outcome.ok && outcome.data.applied && outcome.data.node.state === "terminated") {
      this.settleActivityForAgents([agentId], "terminated");
    }
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
    earlyEvents: readonly { readonly event: RpcSupervisorEvent; readonly deliveryGeneration: number }[],
  ): void {
    this.agents.set(agentId, {
      supervisor,
      templateId: input.template_id,
      name: input.name,
      unsubscribe,
    });
    for (const pending of earlyEvents) {
      this.handleSupervisorEvent(agentId, pending.event, pending.deliveryGeneration);
    }
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

  private handleSupervisorEvent(
    agentId: string | undefined,
    event: RpcSupervisorEvent,
    deliveryGeneration: number = this.activityDeliveryGeneration,
  ): void {
    if (
      deliveryGeneration !== this.activityDeliveryGeneration
      && (
        event.kind === "activity"
        || event.kind === "activity_stream"
        || event.kind === "activity_display"
      )
    ) return;
    // 生命周期事实的真实 agent_id 优先于“该监督器所属的直接子”；后代事实
    // 可以更新共享树，但不能被错误投影成直接子的会话通知或清理动作。
    const lifecycleAgentId = event.kind === "lifecycle"
      ? event.agent_id ?? agentId
      : agentId;
    const directLifecycleAgentId = lifecycleAgentId !== undefined
      && this.directChild(lifecycleAgentId).ok
      ? lifecycleAgentId
      : undefined;
    const lifecycleApplied = directLifecycleAgentId !== undefined
      && event.kind === "lifecycle"
      && this.wasLifecycleEventApplied(directLifecycleAgentId, event.event);
    const activityLifecycleApplied = lifecycleAgentId !== undefined
      && event.kind === "lifecycle"
      && this.wasLifecycleEventApplied(lifecycleAgentId, event.event);

    if (event.kind === "reply" && this.onReply !== undefined && agentId !== undefined) {
      try {
        this.onReply(agentId, event.reply);
      } catch {
        // 父会话注入失败只影响上行观察者，不破坏节点等待和生命周期。
      }
    }
    // 生产运行时由 ParentReplyInbox 在扩展消息同步提交后登记通知；独立
    // 控制器装配仍从监督事件登记，避免同一消息在两层各计数一次。
    if (
      event.kind === "reply"
      && event.reply.kind === "message"
      && agentId !== undefined
      && this.replyNotificationsHandledByInbox === false
    ) {
      this.notifySessionEvent(agentId, "reply");
    } else if (
      event.kind === "reply"
      && event.reply.kind === "final_report"
      && agentId !== undefined
      && this.replyNotificationsHandledByInbox === false
    ) {
      this.notifySessionEvent(agentId, "final_report");
    }
    // 活动流转发是纯展示数据通道：任何失败只表现为面板条目缺失，不得沿
    // onEvent 回调传播影响节点生命周期（与 reply 观察者同一语义）。
    if (event.kind === "activity" && agentId !== undefined) {
      try {
        this.tree.updateActivity(agentId, event.activity);
      } catch {
        // 活动缓存更新失败静默缺失。
      }
    }
    if (event.kind === "activity_stream" && agentId !== undefined) {
      try {
        this.recordActivity(event.agent_id ?? agentId, event.entry);
      } catch {
        // 转发失败静默缺失，不改变节点生命周期。
      }
    }
    if (event.kind === "activity_display" && agentId !== undefined) {
      try {
        this.handleDisplayEvent(event.agent_id ?? agentId, event.event);
      } catch {
        // 草稿转发失败静默缺失，不改变节点生命周期。
      }
    }
    // 实时草稿只服务显示层：代理进入 idle、failed 或 terminated 时清除该代理
    // 仍未被权威消息替换的草稿。收束不改变生命周期或缓存行为；之后同一运行
    // 实例迟到的合法权威消息仍可写入历史。
    if (
      event.kind === "lifecycle"
      && this.actor.kind === "root"
      && lifecycleAgentId !== undefined
      && activityLifecycleApplied
    ) {
      const settledType = event.event.type;
      if (
        settledType === "agent_settled"
        || settledType === "runtime_failed"
        || settledType === "resources_confirmed"
      ) this.displayDrafts.settleAgent(lifecycleAgentId);
    }
    if (event.kind === "fault" && this.actor.kind === "root" && agentId !== undefined) {
      this.displayDrafts.settleAgent(agentId);
      this.activityCache.settleAgent(agentId, "failed");
    }
    // activity 阶段属于安全树快照；工具正文、名称和参数仍只留在监督器本地。
    const activitySettlementState: AgentActivitySettlementState | undefined = event.kind !== "lifecycle"
      ? undefined
      : event.event.type === "agent_settled"
        ? "idle"
        : event.event.type === "runtime_failed"
          ? "failed"
          : event.event.type === "resources_confirmed"
            ? "terminated"
            : undefined;
    // 只有真实代际事件才收束缓存中的 running 工具；这不会建立活动拒绝
    // 屏障，后续同一运行实例的迟到活动和 end 仍可写入或回填。
    if (
      this.actor.kind === "root"
      && lifecycleAgentId !== undefined
      && activitySettlementState !== undefined
      && activityLifecycleApplied
    ) {
      this.activityCache.settleAgent(lifecycleAgentId, activitySettlementState);
    }
    let runtimeFailedAgentId: string | undefined;
    if (
      directLifecycleAgentId !== undefined
      && (
        event.kind === "fault"
        || (lifecycleApplied && event.kind === "lifecycle" && event.event.type === "runtime_failed")
      )
    ) {
      const status = this.tree.getStatus(directLifecycleAgentId);
      if (status.ok && status.data.state === "failed") runtimeFailedAgentId = directLifecycleAgentId;
    }
    if (
      runtimeFailedAgentId !== undefined
      && !this.terminalNotifications.has(runtimeFailedAgentId)
    ) {
      this.terminalNotifications.add(runtimeFailedAgentId);
      void this.deliverTerminalNotification(runtimeFailedAgentId);
      this.notifySessionEvent(runtimeFailedAgentId, "terminal");
    }
    if (runtimeFailedAgentId !== undefined) this.startOrphanTermination(runtimeFailedAgentId);
    if (
      directLifecycleAgentId !== undefined
      && lifecycleApplied
      && event.kind === "lifecycle"
      && event.event.type === "resources_confirmed"
    ) {
      this.notifySessionEvent(directLifecycleAgentId, "terminal");
      this.releaseTerminatedSupervisor(directLifecycleAgentId);
    }
    if (
      directLifecycleAgentId !== undefined
      && lifecycleApplied
      && event.kind === "lifecycle"
      && event.event.type === "agent_settled"
    ) {
      this.notifySessionEvent(directLifecycleAgentId, "idle");
    }
    // 先登记真实生命周期事件，再用稳定状态兜底；否则 tree.onChange 可能
    // 在事件登记前把同一事实当成 idle/terminal 快照并留下重复通知。
    if (directLifecycleAgentId !== undefined) this.resolveWaiters(directLifecycleAgentId);
    this.resolveAllReadyWaiters();
  }

  /**
   * 实时显示事实的处置：中间运行时只逐层 fire-and-forget 转发，不缓存草稿；
   * 顶层应用到登记表，即使详情未打开也持续组装按代理隔离的连续前缀。草稿
   * 不进入持久历史、条目计数或父模型上下文。
   */
  private handleDisplayEvent(agentId: string, event: SafeAgentActivityDisplayEvent): void {
    const parsed = parseCanonicalAgentActivityDisplayEvent(event);
    if (parsed.kind !== "event") return;
    const canonicalEvent = parsed.event;
    if (this.actor.kind === "agent") {
      try {
        this.publishUpstreamDisplayActivity?.(Object.freeze({ agent_id: agentId, event: canonicalEvent }));
      } catch {
        // 上行转发失败静默缺失，不改变节点生命周期。
      }
      return;
    }
    this.displayDrafts.applyEvent(agentId, canonicalEvent);
  }

  /**
   * 构建并校验规范活动条目候选：统一注入契约版本、代理身份、运行实例身份
   * 与条目身份；契约校验失败返回 undefined。
   */
  private buildActivityEntry(
    agentId: string,
    body: SafeAgentActivityEvent,
    entryId: string,
  ): CanonicalAgentActivityEntry | undefined {
    const candidate: CanonicalAgentActivityEntry = Object.freeze({
      contract_version: CANONICAL_ACTIVITY_CONTRACT_VERSION,
      agent_id: agentId,
      incarnation_id: this.activityIncarnationId,
      entry_id: entryId,
      body,
    });
    const parsed = parseCanonicalAgentActivityEntry(candidate);
    return parsed.kind === "entry" ? parsed.entry : undefined;
  }

  private recordActivity(agentId: string, entry: CanonicalAgentActivityEntry): boolean {
    // 中间运行时只逐层尽力转发，不保存历史副本；只有顶层运行时缓存回放。
    if (this.actor.kind === "agent") {
      try {
        this.publishUpstreamActivity?.(Object.freeze({ agent_id: agentId, entry }));
      } catch {
        // 上行转发不回滚任何状态，也不改变节点生命周期；缺口静默。
      }
      return false;
    }
    const result: AgentActivityRecordResult = this.activityCache.record(agentId, entry);
    // 权威完整消息的 draft 清理与历史是否发生可见变更是两个独立事实：
    // 合法重复消息也必须收束匹配草稿，但只有 result.changed 才触发历史通知。
    if (
      result.accepted
      && entry.body.type === "message"
      && entry.body.displayStream !== undefined
    ) {
      this.displayDrafts.replaceDraft(agentId, entry.incarnation_id, entry.body.displayStream);
    } else if (
      result.accepted
      && entry.body.type === "message"
      && typeof entry.body.streamId === "string"
    ) {
      // 仅本地兼容路径可能出现旧 streamId；它永不跨 canonical wire。
      this.displayDrafts.replaceDraft(agentId, entry.incarnation_id, entry.body.streamId);
    }
    return result.changed;
  }

  /**
   * 接收侧同步接纳后写入接收者活动历史的父代理输入条目。统一摘要为
   * Parent message，不区分首条与后续消息；逐条独立身份，完全相同正文
   * 不去重。记录只追加活动缓存，不改变子代理生命周期状态，也不把接纳
   * 解释为已读、已处理、完成或会话终止。
   */
  private recordParentMessage(agentId: string, message: string): void {
    const body: SafeAgentActivityEvent = Object.freeze({
      type: "parent_message",
      content: Object.freeze([
        Object.freeze({ type: "text", text: sanitizeSafeActivityText(message) }),
      ]),
    });
    const entry = this.buildActivityEntry(agentId, body, randomUUID());
    if (entry === undefined) return;
    this.recordActivity(agentId, entry);
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
      if (this.flushUpstreamLifecycle !== undefined) {
        try {
          await this.flushUpstreamLifecycle();
        } catch {
          // 上行事实未确认前不能提交根资源确认；后续终止可重试该边界。
          this.tree.markTerminationBarrierIncomplete(agentId, true);
          return;
        }
      }
      const rootConfirmation = await this.authority.confirmResources(this.actor, agentId);
      if (!rootConfirmation.ok) {
        this.tree.markTerminationBarrierIncomplete(agentId, true);
        return;
      }
    }
    // reapOrphanedDescendants 已确认平台资源释放；即使故障目标本身保留
    // failed（preserveFailedTarget），其屏障成员的 running 工具也必须退出
    // pin，且非权威草稿不能继续存活。不要依赖随后是否产生 lifecycle 帧。
    this.settleActivityForAgents(barrier.agent_ids, "terminated");
    const confirmation = this.tree.confirmTerminationBarrierResources(agentId, true);
    const status = this.tree.getStatus(agentId);
    if (
      (confirmation.ok && confirmation.data.node.state === "terminated")
      || (status.ok && status.data.state === "terminated")
    ) {
      // Orphan reaping may confirm the entire barrier without emitting the normal
      // resources_confirmed lifecycle event, or the authority may have already
      // applied the same idempotent transition locally. Settlement above is
      // intentionally independent of this local projection result.
      this.settleActivityForAgents(barrier.agent_ids, "terminated");
    }
  }

  private releaseTerminatedSupervisor(agentId: string): void {
    const status = this.tree.getStatus(agentId);
    if (!status.ok || status.data.state !== "terminated") return;
    this.settleActivityForAgents([agentId], "terminated");
    const entry = this.agents.get(agentId);
    if (entry === undefined) return;
    entry.unsubscribe();
    this.agents.delete(agentId);
    this.terminalNotifications.delete(agentId);
  }

  /**
   * supervisor 事件是在树控制器成功提交后才允许登记 waiter 事实。
   * expected_generation + 1 是唯一可证明该事件实际推进状态的代际关系；
   * 仅凭当前 state 会把重复或迟到事件误认成新的 idle/terminal。
   */
  private wasLifecycleEventApplied(
    agentId: string,
    event: Extract<RpcSupervisorEvent, { kind: "lifecycle" }>['event'],
  ): boolean {
    const status = this.tree.getStatus(agentId);
    const generation = this.tree.getLifecycleGeneration(agentId);
    if (!status.ok || !generation.ok || generation.data !== event.expected_generation + 1) return false;
    switch (event.type) {
      case "agent_settled": return status.data.state === "idle";
      case "resources_confirmed": return status.data.state === "terminated";
      case "runtime_failed": return status.data.state === "failed";
      default: return true;
    }
  }

  private resolveAllReadyWaiters(): void {
    if (this.readyWaitersResolutionScheduled) return;
    this.readyWaitersResolutionScheduled = true;
    queueMicrotask(() => {
      this.readyWaitersResolutionScheduled = false;
      if (this.disposed) return;
      for (const agentId of [...this.waiters.keys()]) this.resolveWaiters(agentId);
    });
  }

  private resolveWaiters(agentId: string): void {
    const status = this.tree.getStatus(agentId);
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
    if (!this.removeWaiter(waiter)) return;
    waiter.resolve(result);
  }

  private abortWaiter(waiter: PendingWaiter): void {
    if (!this.removeWaiter(waiter)) return;
    waiter.reject(operationAbortedError());
  }

  private removeWaiter(waiter: PendingWaiter): boolean {
    if (!this.pendingWaiters.delete(waiter)) return false;
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
    return true;
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
    // 稳定状态不会自行产生后续会话事件；等待时直接返回当前快照，避免
    // idle/failed/terminated 节点在没有外部控制操作时一直等待到超时。
    if (status.state === "idle") return makeWaitData(status, "idle");
    if (status.state === "failed" || status.state === "terminated") {
      return makeWaitData(status, "terminal");
    }
    return undefined;
  }

  private takeReplyNotification(agentId: string, status: AgentSnapshot): WaitAgentData | undefined {
    const notifications = this.pendingReplyNotifications.get(agentId);
    if (notifications === undefined) return undefined;
    for (const [notificationId, notification] of notifications) {
      if (notification.sequence <= this.parentTurnNotificationWatermark) {
        notifications.delete(notificationId);
        continue;
      }
      if (notification.deliveredToWaiter) continue;
      notification.deliveredToWaiter = true;
      notifications.delete(notificationId);
      if (notifications.size === 0) this.pendingReplyNotifications.delete(agentId);
      return makeWaitData(status, notification.event);
    }
    if (notifications.size === 0) this.pendingReplyNotifications.delete(agentId);
    return undefined;
  }

  private discardObservedReplyNotifications(): void {
    for (const [agentId, notifications] of this.pendingReplyNotifications) {
      for (const [notificationId, notification] of notifications) {
        if (notification.sequence <= this.parentTurnNotificationWatermark) {
          notifications.delete(notificationId);
        }
      }
      if (notifications.size === 0) this.pendingReplyNotifications.delete(agentId);
    }
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
  return isCanonicalUuid(candidate.agent_id)
    && typeof candidate.message === "string"
    && candidate.message.length > 0
    && utf8Length(candidate.message) <= 16 * 1024
    && Object.keys(candidate).every((key) => key === "agent_id" || key === "message");
}

function operationAbortedError(): Error {
  return new Error("Operation aborted");
}

function makeWaitData(status: AgentSnapshot, outcome: WaitAgentEventOutcome): WaitAgentData {
  return Object.freeze({
    agent_id: status.agent_id,
    outcome,
    state: status.state,
    revision: status.revision,
    ...(status.aborted === undefined ? {} : { aborted: status.aborted }),
    ...(status.error === undefined ? {} : { error: status.error }),
  });
}

function makeWaitTimeoutData(agentIds: readonly string[]): WaitAgentTimeoutData {
  return Object.freeze({
    agent_ids: Object.freeze([...agentIds]),
    outcome: "timeout",
  });
}

/** 父输入唤醒只携带该次 wait 的完整目标列表，不携带状态、修订或错误。 */
function makeWaitWokenData(agentIds: readonly string[]): WaitAgentWokenData {
  return Object.freeze({
    agent_ids: Object.freeze([...agentIds]),
    outcome: "woken",
    wake_reason: "parent_input",
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

function interruptData(
  status: AgentSnapshot,
  changed: boolean,
  blockedReason?: "compaction_active",
): InterruptAgentData {
  return Object.freeze({
    agent_id: status.agent_id,
    accepted: true,
    changed,
    state: status.state,
    ...(blockedReason === undefined ? {} : { blocked_reason: blockedReason }),
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
