import {
  controlFailure,
  type AgentSnapshot,
  type ControlResult,
  type LifecycleEventOutcome,
  type PublicErrorCode,
  type ReserveStartingChildInput,
  type TerminationBarrierOutcome,
  type TreeActor,
  type TreeController,
} from "./tree-controller.ts";
import type {
  AgentTemplateListItem,
  TemplateDefinition,
  TemplateDiscoverySnapshot,
} from "./template-discovery-snapshot.ts";
import { listAgentTemplates } from "./template-discovery-snapshot.ts";

/** 根权威返回的模板副本；正文只允许在受认证的创建控制请求中传输。 */
export interface ResolvedTemplateGrant {
  readonly template: TemplateDefinition;
  readonly template_revision: number;
}

/** 根权威完成身份与两类配额预留后签发的不可变创建事实。 */
export interface SpawnGrant {
  readonly node: AgentSnapshot;
  readonly lifecycle_generation: number;
  readonly tree_revision: number;
  readonly template_revision: number;
  readonly management_enabled: boolean;
}

export interface ReserveAuthorizedChildInput {
  readonly template_id: string;
  readonly template_revision: number;
  readonly name: string;
}

/** 普通控制动作仍只能作用于调用者的直接子代理。 */
export const AUTHORITY_CONTROL_ACTIONS = Object.freeze([
  "send_message",
  "wait_agent",
  "interrupt_agent",
  "terminate_agent",
  "get_agent_status",
] as const);

export type AuthorityControlAction = (typeof AUTHORITY_CONTROL_ACTIONS)[number];

export interface ControlAdmission {
  readonly action: AuthorityControlAction;
  readonly node: AgentSnapshot;
  readonly tree_revision: number;
}

/**
 * AgentController 只依赖这个窄端口。根实现直接进入唯一顺序域；子运行时实现
 * 则把同一调用沿受认证的直接父子监督链逐跳转发。
 */
export interface TreeAuthorityPort {
  listTemplates(
    actor: TreeActor,
  ): Promise<ControlResult<readonly AgentTemplateListItem[]>>;
  resolveTemplate(
    actor: TreeActor,
    templateId: string,
  ): Promise<ControlResult<ResolvedTemplateGrant>>;
  reserveChild(
    actor: TreeActor,
    input: ReserveAuthorizedChildInput,
  ): Promise<ControlResult<SpawnGrant>>;
  admitControl(
    actor: TreeActor,
    agentId: string,
    action: AuthorityControlAction,
  ): Promise<ControlResult<ControlAdmission>>;
  beginTermination(
    actor: TreeActor,
    agentId: string,
  ): Promise<ControlResult<TerminationBarrierOutcome>>;
  confirmResources(
    actor: TreeActor,
    agentId: string,
  ): Promise<ControlResult<LifecycleEventOutcome>>;
}

export interface RootTreeAuthorityOptions {
  readonly tree: TreeController;
  readonly templateSnapshot: TemplateDiscoverySnapshot;
  readonly initialTemplateRevision?: number;
}

/**
 * 一棵代理树唯一的身份、配额、模板修订、屏障和资源确认顺序域。
 *
 * 本类型不拥有任何 RPC/IPC 资源；传输路由器只能调用这里的公开裁决方法，
 * 不能在中间进程重新分配 UUID、重新计算全树配额或自行确认资源。
 */
export class RootTreeAuthority implements TreeAuthorityPort {
  private readonly tree: TreeController;
  private templateSnapshot: TemplateDiscoverySnapshot;
  private templateRevision: number;

  constructor(options: RootTreeAuthorityOptions) {
    const initialRevision = options.initialTemplateRevision ?? 1;
    if (!Number.isSafeInteger(initialRevision) || initialRevision < 1) {
      throw new TypeError("模板修订初值无效");
    }
    this.tree = options.tree;
    this.templateSnapshot = options.templateSnapshot;
    this.templateRevision = initialRevision;
  }

  /** 根 reload 完整建立新目录后调用；既有 grant 与节点事实不回溯改变。 */
  updateTemplateSnapshot(snapshot: TemplateDiscoverySnapshot): number {
    this.templateSnapshot = snapshot;
    if (this.templateRevision >= Number.MAX_SAFE_INTEGER) {
      throw new Error("模板修订已耗尽");
    }
    this.templateRevision += 1;
    return this.templateRevision;
  }

  getTemplateRevision(): number {
    return this.templateRevision;
  }

  async listTemplates(
    actor: TreeActor,
  ): Promise<ControlResult<readonly AgentTemplateListItem[]>> {
    const capability = this.tree.getManagementCapability(actor);
    if (!capability.ok) return capability;
    if (!capability.data.enabled) return controlFailure("template_capability_unavailable");
    return success(listAgentTemplates(this.templateSnapshot));
  }

  async resolveTemplate(
    actor: TreeActor,
    templateId: string,
  ): Promise<ControlResult<ResolvedTemplateGrant>> {
    if (typeof templateId !== "string") return controlFailure("invalid_argument");
    const capability = this.tree.getManagementCapability(actor);
    if (!capability.ok) return capability;
    if (!capability.data.enabled) return controlFailure("template_capability_unavailable");
    const resolved = this.templateSnapshot.resolveTemplate(templateId);
    if (resolved.kind === "not_found") return controlFailure("template_not_found");
    if (resolved.kind === "invalid") return controlFailure("template_invalid");
    return success(Object.freeze({
      template: cloneTemplate(resolved.template),
      template_revision: this.templateRevision,
    }));
  }

  async reserveChild(
    actor: TreeActor,
    input: ReserveAuthorizedChildInput,
  ): Promise<ControlResult<SpawnGrant>> {
    if (!isReserveAuthorizedChildInput(input)) return controlFailure("invalid_argument");
    // resolve 与 reserve 之间发生 reload 时必须重新解析，不能把旧模板正文与新
    // 目录的身份预留拼接为一次创建事务。
    if (input.template_revision !== this.templateRevision) return controlFailure("template_invalid");
    const resolved = this.templateSnapshot.resolveTemplate(input.template_id);
    if (resolved.kind === "not_found") return controlFailure("template_not_found");
    if (resolved.kind === "invalid") return controlFailure("template_invalid");

    const reservation: ReserveStartingChildInput = Object.freeze({
      templateId: input.template_id,
      name: input.name,
      subagents: resolved.template.subagents,
    });
    const reserved = this.tree.reserveStartingChild(actor, reservation);
    if (!reserved.ok) return reserved;
    const capability = this.tree.getManagementBootstrapCapability(reserved.data.node.agent_id);
    if (!capability.ok) return controlFailure("internal_error");
    return success(Object.freeze({
      node: reserved.data.node,
      lifecycle_generation: reserved.data.lifecycle_generation,
      tree_revision: reserved.data.tree_revision,
      template_revision: this.templateRevision,
      management_enabled: capability.data.enabled,
    }));
  }

  async admitControl(
    actor: TreeActor,
    agentId: string,
    action: AuthorityControlAction,
  ): Promise<ControlResult<ControlAdmission>> {
    if (!isAuthorityControlAction(action)) return controlFailure("invalid_argument");
    const target = this.tree.assertDirectChild(actor, agentId);
    if (!target.ok) return target;
    const unavailable = controlUnavailableCode(action, target.data);
    if (unavailable !== undefined) return controlFailure(unavailable);
    const snapshot = this.tree.getTreeSnapshot();
    if (!snapshot.ok) return controlFailure("internal_error");
    return success(Object.freeze({
      action,
      node: target.data,
      tree_revision: snapshot.data.tree_revision,
    }));
  }

  async beginTermination(
    actor: TreeActor,
    agentId: string,
  ): Promise<ControlResult<TerminationBarrierOutcome>> {
    return this.tree.beginTerminationBarrier(actor, agentId);
  }

  async confirmResources(
    actor: TreeActor,
    agentId: string,
  ): Promise<ControlResult<LifecycleEventOutcome>> {
    const target = this.tree.assertDirectChild(actor, agentId);
    if (!target.ok) return target;
    const barrier = this.tree.getTerminationBarrier(agentId);
    if (!barrier.ok || barrier.data.agent_id !== agentId) {
      return controlFailure("agent_unavailable");
    }

    // 直接父确认的是目标节点的平台进程树边界；该边界已覆盖屏障内后代，
    // 因此可按屏障固定的叶到根顺序提交残留资源。故障父本身仍保持 failed，
    // 只释放已经由同一平台边界确认的后代。
    const preserveFailedTarget = target.data.state === "failed";
    if (!preserveFailedTarget && target.data.state !== "terminating" && target.data.state !== "terminated") {
      return controlFailure("agent_unavailable");
    }
    return this.tree.confirmTerminationBarrierResources(agentId, preserveFailedTarget);
  }

  private currentLifecycleOutcome(agentId: string): ControlResult<LifecycleEventOutcome> {
    const status = this.tree.getStatus(agentId);
    const generation = this.tree.getLifecycleGeneration(agentId);
    const snapshot = this.tree.getTreeSnapshot();
    if (!status.ok || !generation.ok || !snapshot.ok) return controlFailure("internal_error");
    return success(Object.freeze({
      applied: false,
      node: status.data,
      lifecycle_generation: generation.data,
      tree_revision: snapshot.data.tree_revision,
    }));
  }
}

function success<T>(data: T): ControlResult<T> {
  return Object.freeze({ ok: true as const, data });
}

function cloneTemplate(template: TemplateDefinition): TemplateDefinition {
  return Object.freeze({
    templateId: template.templateId,
    source: template.source,
    tools: Object.freeze([...template.tools]),
    ...(template.description === undefined ? {} : { description: template.description }),
    subagents: template.subagents,
    contextFiles: template.contextFiles,
    systemPromptMode: template.systemPromptMode,
    ...(template.model === undefined ? {} : { model: template.model }),
    ...(template.thinking === undefined ? {} : { thinking: template.thinking }),
    body: template.body,
  });
}

function isReserveAuthorizedChildInput(value: unknown): value is ReserveAuthorizedChildInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Object.keys(candidate).every((key) => ["template_id", "template_revision", "name"].includes(key))
    && typeof candidate.template_id === "string"
    && Number.isSafeInteger(candidate.template_revision)
    && (candidate.template_revision as number) >= 1
    && typeof candidate.name === "string";
}

function isAuthorityControlAction(value: unknown): value is AuthorityControlAction {
  return typeof value === "string"
    && (AUTHORITY_CONTROL_ACTIONS as readonly string[]).includes(value);
}

function controlUnavailableCode(
  action: AuthorityControlAction,
  node: AgentSnapshot,
): PublicErrorCode | undefined {
  if (action === "get_agent_status" || action === "terminate_agent") return undefined;
  if (action === "wait_agent") return undefined;
  if (action === "interrupt_agent") {
    return node.state === "starting" ? "agent_unavailable" : undefined;
  }
  return node.state === "idle" || node.state === "working" || node.state === "interrupting"
    ? undefined
    : "agent_unavailable";
}
