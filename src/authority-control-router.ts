import { randomUUID } from "node:crypto";
import { parseAgentSnapshot as parseSafeAgentSnapshot } from "./agent-snapshot-codec.ts";
import {
  controlFailure,
  isCanonicalUuid,
  type AgentSnapshot,
  type ControlResult,
  type LifecycleEventOutcome,
  type TerminationBarrierOutcome,
  type TreeActor,
} from "./tree-controller.ts";
import type {
  AuthorityControlAction,
  ControlAdmission,
  ReserveAuthorizedChildInput,
  ResolvedTemplateGrant,
  RootTreeAuthority,
  SpawnGrant,
  TreeAuthorityPort,
} from "./tree-authority.ts";
import type {
  TemplateDefinition,
  TemplateThinkingLevel,
} from "./template-discovery-snapshot.ts";
import type {
  SupervisorControlRequest,
  SupervisorControlResponse,
  SupervisorJsonValue,
} from "./supervisor-channel.ts";

const DEFAULT_CONTROL_TIMEOUT_MS = 30_000;
const MAX_CONTROL_OPERATIONS = 128;

/** 监督通道包装器提供的最小内部控制面。 */
export interface SupervisorControlLink {
  publishControlRequest(request: SupervisorControlRequest): Promise<void>;
  publishControlResponse(response: SupervisorControlResponse): Promise<void>;
  onControlRequest(listener: (request: SupervisorControlRequest) => void): () => void;
  onControlResponse(listener: (response: SupervisorControlResponse) => void): () => void;
  failProtocol(): void;
}

interface PendingControlRequest {
  readonly resolve: (response: SupervisorControlResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** child 端有界请求相关器；operation_id 与监督 request_id 保持独立。 */
export class SupervisorControlClient {
  private readonly link: SupervisorControlLink;
  private readonly timeoutMs: number;
  private readonly pending = new Map<string, PendingControlRequest>();
  private readonly retired = new Set<string>();
  private readonly unsubscribe: () => void;
  private closed = false;

  constructor(link: SupervisorControlLink, timeoutMs = DEFAULT_CONTROL_TIMEOUT_MS) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError("控制请求期限无效");
    this.link = link;
    this.timeoutMs = timeoutMs;
    this.unsubscribe = link.onControlResponse((response) => this.receive(response));
  }

  request(request: SupervisorControlRequest): Promise<SupervisorControlResponse> {
    if (this.closed) return Promise.reject(new Error("监督控制请求器已关闭"));
    if (this.pending.size >= MAX_CONTROL_OPERATIONS || this.pending.has(request.operation_id)) {
      this.link.failProtocol();
      return Promise.reject(new Error("监督控制请求相关性无效"));
    }
    return new Promise<SupervisorControlResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        const current = this.pending.get(request.operation_id);
        if (current === undefined) return;
        this.pending.delete(request.operation_id);
        this.rememberRetired(request.operation_id);
        reject(new Error("监督控制请求超时"));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(request.operation_id, { resolve, reject, timer });
      void this.link.publishControlRequest(request).catch(() => {
        const current = this.pending.get(request.operation_id);
        if (current === undefined) return;
        clearTimeout(current.timer);
        this.pending.delete(request.operation_id);
        this.rememberRetired(request.operation_id);
        reject(new Error("监督控制请求发送失败"));
      });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("监督控制请求器已关闭"));
    }
    this.pending.clear();
    this.retired.clear();
  }

  private receive(response: SupervisorControlResponse): void {
    const pending = this.pending.get(response.operation_id);
    if (pending === undefined) {
      if (this.retired.has(response.operation_id)) return;
      this.link.failProtocol();
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(response.operation_id);
    this.rememberRetired(response.operation_id);
    pending.resolve(response);
  }

  private rememberRetired(operationId: string): void {
    this.retired.add(operationId);
    while (this.retired.size > MAX_CONTROL_OPERATIONS) {
      const oldest = this.retired.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.retired.delete(oldest);
    }
  }
}

export type SupervisorControlHandler = (
  request: SupervisorControlRequest,
) => Promise<SupervisorControlResponse>;

interface InboundOperation {
  readonly fingerprint: string;
  readonly response: Promise<SupervisorControlResponse>;
  completed: boolean;
}

/** parent 端有界、可重放的控制服务；同 ID 不同正文立即裁决为协议故障。 */
export class SupervisorControlServer {
  private readonly link: SupervisorControlLink;
  private readonly handler: SupervisorControlHandler;
  private readonly operations = new Map<string, InboundOperation>();
  private readonly unsubscribe: () => void;
  private closed = false;

  constructor(link: SupervisorControlLink, handler: SupervisorControlHandler) {
    this.link = link;
    this.handler = handler;
    this.unsubscribe = link.onControlRequest((request) => this.receive(request));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    this.operations.clear();
  }

  private receive(request: SupervisorControlRequest): void {
    if (this.closed) return;
    const fingerprint = stableJson(request);
    const existing = this.operations.get(request.operation_id);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        this.link.failProtocol();
        return;
      }
      void existing.response.then((response) => this.send(response));
      return;
    }
    this.evictCompletedOperations();
    if (this.operations.size >= MAX_CONTROL_OPERATIONS) {
      this.link.failProtocol();
      return;
    }
    const response = Promise.resolve()
      .then(() => this.handler(request))
      .then((result) => result.operation_id === request.operation_id
        ? result
        : failureResponse(request.operation_id, "internal_error"))
      .catch(() => failureResponse(request.operation_id, "internal_error"));
    const operation: InboundOperation = { fingerprint, response, completed: false };
    this.operations.set(request.operation_id, operation);
    void response.then((result) => {
      operation.completed = true;
      this.send(result);
      this.evictCompletedOperations();
    });
  }

  private send(response: SupervisorControlResponse): void {
    if (this.closed) return;
    void this.link.publishControlResponse(response).catch(() => {
      // 传输故障由监督通道自身稳定上报；这里不泄露底层写入异常。
    });
  }

  private evictCompletedOperations(): void {
    if (this.operations.size < MAX_CONTROL_OPERATIONS) return;
    for (const [operationId, operation] of this.operations) {
      if (!operation.completed) continue;
      this.operations.delete(operationId);
      if (this.operations.size < MAX_CONTROL_OPERATIONS) return;
    }
  }
}

/** 中间父控制器只扩展已认证 route 并逐跳转发，不解释或裁决正文。 */
export function createForwardControlHandler(
  localAgentId: string,
  upstream: SupervisorControlClient,
): SupervisorControlHandler {
  if (!isCanonicalUuid(localAgentId)) throw new TypeError("本地代理标识无效");
  return async (request) => upstream.request(Object.freeze({
    operation_id: request.operation_id,
    operation: request.operation,
    route: Object.freeze([localAgentId, ...request.route]),
    body: request.body,
  }));
}

/** 根端把安全 JSON 控制请求映射到唯一 TreeAuthority。 */
export function createRootAuthorityControlHandler(
  authority: RootTreeAuthority,
): SupervisorControlHandler {
  return async (request) => {
    const actorId = request.route.at(-1);
    if (!isCanonicalUuid(actorId)) return failureResponse(request.operation_id, "invalid_argument");
    const actor = Object.freeze({ kind: "agent" as const, agent_id: actorId });
    switch (request.operation) {
      case "resolve_template": {
        const body = exactRecord(request.body, ["template_id"]);
        if (body === undefined || typeof body.template_id !== "string") {
          return failureResponse(request.operation_id, "invalid_argument");
        }
        return resultResponse(request.operation_id, await authority.resolveTemplate(actor, body.template_id),
          (data) => resolvedTemplateToJson(data));
      }
      case "reserve_child": {
        const body = exactRecord(request.body, ["template_id", "template_revision", "name"]);
        if (
          body === undefined
          || typeof body.template_id !== "string"
          || !Number.isSafeInteger(body.template_revision)
          || typeof body.name !== "string"
        ) return failureResponse(request.operation_id, "invalid_argument");
        return resultResponse(request.operation_id, await authority.reserveChild(actor, {
          template_id: body.template_id,
          template_revision: body.template_revision as number,
          name: body.name,
        }), spawnGrantToJson);
      }
      case "admit_control": {
        const body = exactRecord(request.body, ["agent_id", "action"]);
        if (body === undefined || !isCanonicalUuid(body.agent_id) || !isControlAction(body.action)) {
          return failureResponse(request.operation_id, "invalid_argument");
        }
        return resultResponse(request.operation_id, await authority.admitControl(
          actor,
          body.agent_id,
          body.action,
        ), controlAdmissionToJson);
      }
      case "begin_termination": {
        const agentId = agentIdBody(request.body);
        if (agentId === undefined) return failureResponse(request.operation_id, "invalid_argument");
        return resultResponse(request.operation_id, await authority.beginTermination(actor, agentId),
          terminationBarrierToJson);
      }
      case "confirm_resources": {
        const agentId = agentIdBody(request.body);
        if (agentId === undefined) return failureResponse(request.operation_id, "invalid_argument");
        return resultResponse(request.operation_id, await authority.confirmResources(actor, agentId),
          lifecycleOutcomeToJson);
      }
    }
  };
}

/** 子运行时把 AgentController 的权威调用编码为逐跳控制请求。 */
export class RemoteTreeAuthorityPort implements TreeAuthorityPort {
  private readonly localAgentId: string;
  private readonly client: SupervisorControlClient;

  constructor(localAgentId: string, client: SupervisorControlClient) {
    if (!isCanonicalUuid(localAgentId)) throw new TypeError("本地代理标识无效");
    this.localAgentId = localAgentId;
    this.client = client;
  }

  async resolveTemplate(actor: TreeActor, templateId: string): Promise<ControlResult<ResolvedTemplateGrant>> {
    if (!this.sameActor(actor)) return controlFailure("agent_unavailable");
    return this.call("resolve_template", { template_id: templateId }, parseResolvedTemplateGrant);
  }

  async reserveChild(actor: TreeActor, input: ReserveAuthorizedChildInput): Promise<ControlResult<SpawnGrant>> {
    if (!this.sameActor(actor)) return controlFailure("agent_unavailable");
    return this.call("reserve_child", {
      template_id: input.template_id,
      template_revision: input.template_revision,
      name: input.name,
    }, parseSpawnGrant);
  }

  async admitControl(
    actor: TreeActor,
    agentId: string,
    action: AuthorityControlAction,
  ): Promise<ControlResult<ControlAdmission>> {
    if (!this.sameActor(actor)) return controlFailure("agent_unavailable");
    return this.call("admit_control", { agent_id: agentId, action }, parseControlAdmission);
  }

  async beginTermination(
    actor: TreeActor,
    agentId: string,
  ): Promise<ControlResult<TerminationBarrierOutcome>> {
    if (!this.sameActor(actor)) return controlFailure("agent_unavailable");
    return this.call("begin_termination", { agent_id: agentId }, parseTerminationBarrier);
  }

  async confirmResources(
    actor: TreeActor,
    agentId: string,
  ): Promise<ControlResult<LifecycleEventOutcome>> {
    if (!this.sameActor(actor)) return controlFailure("agent_unavailable");
    return this.call("confirm_resources", { agent_id: agentId }, parseLifecycleOutcome);
  }

  private sameActor(actor: TreeActor): boolean {
    return actor.kind === "agent" && actor.agent_id === this.localAgentId;
  }

  private async call<T>(
    operation: SupervisorControlRequest["operation"],
    body: SupervisorJsonValue,
    parse: (value: SupervisorJsonValue) => T | undefined,
  ): Promise<ControlResult<T>> {
    let response: SupervisorControlResponse;
    try {
      response = await this.client.request(Object.freeze({
        operation_id: randomUUID(),
        operation,
        route: Object.freeze([this.localAgentId]),
        body,
      }));
    } catch {
      return controlFailure("internal_error");
    }
    if (!response.ok) return Object.freeze({ ok: false, error: response.error });
    const parsed = parse(response.data);
    return parsed === undefined
      ? controlFailure("internal_error")
      : Object.freeze({ ok: true, data: parsed });
  }
}

function failureResponse(
  operationId: string,
  code: Parameters<typeof controlFailure>[0],
): SupervisorControlResponse {
  const failure = controlFailure(code);
  return Object.freeze({ operation_id: operationId, ok: false, error: failure.error });
}

function resultResponse<T>(
  operationId: string,
  result: ControlResult<T>,
  serialize: (data: T) => SupervisorJsonValue,
): SupervisorControlResponse {
  return result.ok
    ? Object.freeze({ operation_id: operationId, ok: true, data: serialize(result.data) })
    : Object.freeze({ operation_id: operationId, ok: false, error: result.error });
}

function resolvedTemplateToJson(value: ResolvedTemplateGrant): SupervisorJsonValue {
  return Object.freeze({
    template: templateToJson(value.template),
    template_revision: value.template_revision,
  });
}

function templateToJson(value: TemplateDefinition): SupervisorJsonValue {
  return Object.freeze({
    template_id: value.templateId,
    source: value.source,
    tools: Object.freeze([...value.tools]),
    ...(value.description === undefined ? {} : { description: value.description }),
    subagents: value.subagents,
    context_files: value.contextFiles,
    system_mode: value.systemPromptMode,
    ...(value.model === undefined ? {} : { model: value.model }),
    ...(value.thinking === undefined ? {} : { thinking: value.thinking }),
    body: value.body,
  });
}

function spawnGrantToJson(value: SpawnGrant): SupervisorJsonValue {
  return Object.freeze({
    node: snapshotToJson(value.node),
    lifecycle_generation: value.lifecycle_generation,
    tree_revision: value.tree_revision,
    template_revision: value.template_revision,
    management_enabled: value.management_enabled,
  });
}

function controlAdmissionToJson(value: ControlAdmission): SupervisorJsonValue {
  return Object.freeze({
    action: value.action,
    node: snapshotToJson(value.node),
    tree_revision: value.tree_revision,
  });
}

function terminationBarrierToJson(value: TerminationBarrierOutcome): SupervisorJsonValue {
  return Object.freeze({
    barrier_id: value.barrier_id,
    agent_id: value.agent_id,
    agent_ids: Object.freeze([...value.agent_ids]),
    changed: value.changed,
    tree_revision: value.tree_revision,
  });
}

function lifecycleOutcomeToJson(value: LifecycleEventOutcome): SupervisorJsonValue {
  return Object.freeze({
    applied: value.applied,
    node: snapshotToJson(value.node),
    lifecycle_generation: value.lifecycle_generation,
    tree_revision: value.tree_revision,
  });
}

function snapshotToJson(value: AgentSnapshot): SupervisorJsonValue {
  return Object.freeze(JSON.parse(JSON.stringify(value)) as SupervisorJsonValue);
}

function parseResolvedTemplateGrant(value: SupervisorJsonValue): ResolvedTemplateGrant | undefined {
  const record = exactRecord(value, ["template", "template_revision"]);
  if (record === undefined || !positiveSafeInteger(record.template_revision)) return undefined;
  const parsedTemplate = parseTemplate(record.template);
  return parsedTemplate === undefined ? undefined : Object.freeze({
    template: parsedTemplate,
    template_revision: record.template_revision as number,
  });
}

function parseTemplate(value: unknown): TemplateDefinition | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const allowed = [
    "template_id", "source", "tools", "description", "subagents", "context_files",
    "system_mode", "model", "thinking", "body",
  ];
  if (Object.keys(record).some((key) => !allowed.includes(key))) return undefined;
  if (
    typeof record.template_id !== "string"
    || (record.source !== "user" && record.source !== "project")
    || !Array.isArray(record.tools)
    || record.tools.some((tool) => typeof tool !== "string")
    || (record.description !== undefined && typeof record.description !== "string")
    || (record.subagents !== "inherit" && record.subagents !== "disabled")
    || (record.context_files !== "enabled" && record.context_files !== "disabled")
    || (record.system_mode !== "append" && record.system_mode !== "replace")
    || (record.model !== undefined && typeof record.model !== "string")
    || (record.thinking !== undefined && ![
      "off", "minimal", "low", "medium", "high", "xhigh", "max",
    ].includes(String(record.thinking)))
    || typeof record.body !== "string"
  ) return undefined;
  const model = record.model as string | undefined;
  const thinking = record.thinking as TemplateThinkingLevel | undefined;
  return Object.freeze({
    templateId: record.template_id,
    source: record.source,
    tools: Object.freeze([...(record.tools as string[])]),
    ...(record.description === undefined ? {} : { description: record.description }),
    subagents: record.subagents,
    contextFiles: record.context_files,
    systemPromptMode: record.system_mode,
    ...(model === undefined ? {} : { model }),
    ...(thinking === undefined ? {} : { thinking }),
    body: record.body,
  });
}

function parseSpawnGrant(value: SupervisorJsonValue): SpawnGrant | undefined {
  const record = exactRecord(value, [
    "node", "lifecycle_generation", "tree_revision", "template_revision", "management_enabled",
  ]);
  if (
    record === undefined
    || !nonNegativeSafeInteger(record.lifecycle_generation)
    || !nonNegativeSafeInteger(record.tree_revision)
    || !positiveSafeInteger(record.template_revision)
    || typeof record.management_enabled !== "boolean"
  ) return undefined;
  const node = parseAgentSnapshot(record.node);
  return node === undefined ? undefined : Object.freeze({
    node,
    lifecycle_generation: record.lifecycle_generation as number,
    tree_revision: record.tree_revision as number,
    template_revision: record.template_revision as number,
    management_enabled: record.management_enabled,
  });
}

function parseControlAdmission(value: SupervisorJsonValue): ControlAdmission | undefined {
  const record = exactRecord(value, ["action", "node", "tree_revision"]);
  if (record === undefined || !isControlAction(record.action) || !nonNegativeSafeInteger(record.tree_revision)) {
    return undefined;
  }
  const node = parseAgentSnapshot(record.node);
  return node === undefined ? undefined : Object.freeze({
    action: record.action,
    node,
    tree_revision: record.tree_revision as number,
  });
}

function parseTerminationBarrier(value: SupervisorJsonValue): TerminationBarrierOutcome | undefined {
  const record = exactRecord(value, ["barrier_id", "agent_id", "agent_ids", "changed", "tree_revision"]);
  if (
    record === undefined
    || typeof record.barrier_id !== "string"
    || !isCanonicalUuid(record.agent_id)
    || !Array.isArray(record.agent_ids)
    || record.agent_ids.some((id) => !isCanonicalUuid(id))
    || typeof record.changed !== "boolean"
    || !nonNegativeSafeInteger(record.tree_revision)
  ) return undefined;
  return Object.freeze({
    barrier_id: record.barrier_id,
    agent_id: record.agent_id,
    agent_ids: Object.freeze([...(record.agent_ids as string[])]),
    changed: record.changed,
    tree_revision: record.tree_revision as number,
  });
}

function parseLifecycleOutcome(value: SupervisorJsonValue): LifecycleEventOutcome | undefined {
  const record = exactRecord(value, ["applied", "node", "lifecycle_generation", "tree_revision"]);
  if (
    record === undefined
    || typeof record.applied !== "boolean"
    || !nonNegativeSafeInteger(record.lifecycle_generation)
    || !nonNegativeSafeInteger(record.tree_revision)
  ) return undefined;
  const node = parseAgentSnapshot(record.node);
  return node === undefined ? undefined : Object.freeze({
    applied: record.applied,
    node,
    lifecycle_generation: record.lifecycle_generation as number,
    tree_revision: record.tree_revision as number,
  });
}

function parseAgentSnapshot(value: unknown): AgentSnapshot | undefined {
  return parseSafeAgentSnapshot(value);
}

function agentIdBody(value: SupervisorJsonValue): string | undefined {
  const body = exactRecord(value, ["agent_id"]);
  return body !== undefined && isCanonicalUuid(body.agent_id) ? body.agent_id : undefined;
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  return actual.length === keys.length && actual.every((key) => keys.includes(key)) ? record : undefined;
}

function isControlAction(value: unknown): value is AuthorityControlAction {
  return typeof value === "string" && [
    "send_message", "wait_agent", "interrupt_agent", "terminate_agent", "get_agent_status",
  ].includes(value);
}

function positiveSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonNegativeSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
