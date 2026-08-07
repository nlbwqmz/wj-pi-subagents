import assert from "node:assert/strict";
import test from "node:test";
import {
  RemoteTreeAuthorityPort,
  SupervisorControlClient,
  SupervisorControlServer,
  createForwardControlHandler,
  createRootAuthorityControlHandler,
  type SupervisorControlLink,
} from "../src/authority-control-router.ts";
import { RootTreeAuthority } from "../src/tree-authority.ts";
import {
  ROOT_TREE_ACTOR,
  TreeController,
  type ControlResult,
} from "../src/tree-controller.ts";
import type {
  SupervisorControlRequest,
  SupervisorControlResponse,
} from "../src/supervisor-channel.ts";
import type {
  TemplateDefinition,
  TemplateDiscoverySnapshot,
} from "../src/template-discovery-snapshot.ts";

const A_ID = "20000000-0000-4000-8000-000000000001";
const B_ID = "20000000-0000-4000-8000-000000000002";
const C_ID = "20000000-0000-4000-8000-000000000003";

class MemoryControlLink implements SupervisorControlLink {
  peer: MemoryControlLink | undefined;
  protocolFaults = 0;
  private readonly requests = new Set<(request: SupervisorControlRequest) => void>();
  private readonly responses = new Set<(response: SupervisorControlResponse) => void>();

  async publishControlRequest(request: SupervisorControlRequest): Promise<void> {
    if (this.peer === undefined) throw new Error("没有监督对端");
    for (const listener of this.peer.requests) listener(request);
  }

  async publishControlResponse(response: SupervisorControlResponse): Promise<void> {
    if (this.peer === undefined) throw new Error("没有监督对端");
    for (const listener of this.peer.responses) listener(response);
  }

  onControlRequest(listener: (request: SupervisorControlRequest) => void): () => void {
    this.requests.add(listener);
    return () => this.requests.delete(listener);
  }

  onControlResponse(listener: (response: SupervisorControlResponse) => void): () => void {
    this.responses.add(listener);
    return () => this.responses.delete(listener);
  }

  failProtocol(): void {
    this.protocolFaults += 1;
  }
}

function linkPair(): { readonly parent: MemoryControlLink; readonly child: MemoryControlLink } {
  const parent = new MemoryControlLink();
  const child = new MemoryControlLink();
  parent.peer = child;
  child.peer = parent;
  return { parent, child };
}

function template(): TemplateDefinition {
  return Object.freeze({
    templateId: "worker",
    source: "project" as const,
    tools: Object.freeze(["read"]),
    description: "受控模板",
    subagents: "inherit" as const,
    contextFiles: "disabled" as const,
    systemPromptMode: "replace" as const,
    model: "provider/model",
    thinking: "high" as const,
    body: "只通过受认证控制请求传输的模板正文",
  });
}

function templateSnapshot(): TemplateDiscoverySnapshot {
  const item = template();
  return Object.freeze({
    templates: Object.freeze([item]),
    invalidCandidates: Object.freeze([]),
    sourceDiagnostics: Object.freeze([]),
    resolveTemplate: (templateId: string) => templateId === item.templateId
      ? Object.freeze({ kind: "valid" as const, template: item })
      : Object.freeze({ kind: "not_found" as const }),
    toJSON: () => ({}),
  });
}

function expectSuccess<T>(result: ControlResult<T>): T {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("预期控制成功");
  return result.data;
}

async function createAuthority(): Promise<{
  readonly tree: TreeController;
  readonly authority: RootTreeAuthority;
}> {
  const ids = [A_ID, B_ID, C_ID];
  const tree = new TreeController({
    config: { maxDepth: 3, maxChildrenPerAgent: 3, maxAgentsPerTree: 3, waitTimeoutMs: 10_000 },
    idFactory: () => ids.shift() ?? C_ID,
  });
  const authority = new RootTreeAuthority({ tree, templateSnapshot: templateSnapshot() });
  const resolved = expectSuccess(await authority.resolveTemplate(ROOT_TREE_ACTOR, "worker"));
  const parent = expectSuccess(await authority.reserveChild(ROOT_TREE_ACTOR, {
    template_id: "worker",
    template_revision: resolved.template_revision,
    name: "A",
  }));
  expectSuccess(tree.applyLifecycleEvent(parent.node.agent_id, {
    type: "startup_ready",
    expected_generation: parent.lifecycle_generation,
  }));
  return { tree, authority };
}

test("远程端口经请求相关器调用根权威并保留完整模板语义", async () => {
  const { tree, authority } = await createAuthority();
  const links = linkPair();
  const server = new SupervisorControlServer(links.parent, createRootAuthorityControlHandler(authority));
  const client = new SupervisorControlClient(links.child, 1_000);
  const remote = new RemoteTreeAuthorityPort(A_ID, client);
  const actor = Object.freeze({ kind: "agent" as const, agent_id: A_ID });

  const templates = expectSuccess(await remote.listTemplates(actor));
  assert.deepEqual(templates, [{
    template_id: "worker",
    description: "受控模板",
    tools: ["read"],
  }]);
  assert.doesNotMatch(JSON.stringify(templates), /source|body|model|thinking|context_files|subagents/);
  const resolved = expectSuccess(await remote.resolveTemplate(actor, "worker"));
  assert.equal(resolved.template.systemPromptMode, "replace");
  assert.equal(resolved.template.contextFiles, "disabled");
  assert.equal(resolved.template.body, "只通过受认证控制请求传输的模板正文");
  const grant = expectSuccess(await remote.reserveChild(actor, {
    template_id: "worker",
    template_revision: resolved.template_revision,
    name: "B",
  }));
  assert.equal(grant.node.agent_id, B_ID);
  assert.equal(grant.node.parent_agent_id, A_ID);
  assert.equal(expectSuccess(tree.getStatus(B_ID)).state, "starting");
  expectSuccess(tree.applyLifecycleEvent(B_ID, {
    type: "startup_ready",
    expected_generation: grant.lifecycle_generation,
  }));
  expectSuccess(tree.updateActivity(B_ID, { category: "researching", active_count: 1 }));
  const admission = expectSuccess(await remote.admitControl(actor, B_ID, "get_agent_status"));
  assert.equal(admission.node.agent_id, B_ID);
  assert.deepEqual(admission.node.activity, { category: "researching", active_count: 1 });
  assert.equal(links.parent.protocolFaults, 0);
  assert.equal(links.child.protocolFaults, 0);

  client.close();
  server.close();
});

test("远程端口拒绝夹带未声明节点字段的权威响应", async () => {
  const links = linkPair();
  const server = new SupervisorControlServer(links.parent, async (request) => Object.freeze({
    operation_id: request.operation_id,
    ok: true as const,
    data: Object.freeze({
      action: "get_agent_status",
      node: Object.freeze({
        agent_id: B_ID,
        parent_agent_id: A_ID,
        template_id: "worker",
        name: "B",
        depth: 2,
        state: "working",
        pending_message_count: 0,
        revision: 1,
        created_at: "2026-08-06T07:59:59.000Z",
        lifecycle_elapsed_ms: 1_000,
        activity: Object.freeze({ category: "reading", active_count: 1 }),
        metadata: "不属于安全快照闭集",
      }),
      tree_revision: 1,
    }),
  }));
  const client = new SupervisorControlClient(links.child, 1_000);
  const remote = new RemoteTreeAuthorityPort(A_ID, client);
  const actor = Object.freeze({ kind: "agent" as const, agent_id: A_ID });

  const result = await remote.admitControl(actor, B_ID, "get_agent_status");

  assert.equal(result.ok, false);
  if (result.ok) throw new Error("预期拒绝越界权威响应");
  assert.equal(result.error.code, "internal_error");
  assert.equal(links.parent.protocolFaults, 0);
  assert.equal(links.child.protocolFaults, 0);
  client.close();
  server.close();
});

test("中间父只扩展 route，深层创建仍由同一个根权威分配身份和全树名额", async () => {
  const { tree, authority } = await createAuthority();
  const revision = (expectSuccess(await authority.resolveTemplate(
    Object.freeze({ kind: "agent" as const, agent_id: A_ID }),
    "worker",
  ))).template_revision;
  const b = expectSuccess(await authority.reserveChild(
    Object.freeze({ kind: "agent" as const, agent_id: A_ID }),
    { template_id: "worker", template_revision: revision, name: "B" },
  ));
  expectSuccess(tree.applyLifecycleEvent(B_ID, {
    type: "startup_ready",
    expected_generation: b.lifecycle_generation,
  }));

  const rootLinks = linkPair();
  const rootServer = new SupervisorControlServer(
    rootLinks.parent,
    createRootAuthorityControlHandler(authority),
  );
  const upstream = new SupervisorControlClient(rootLinks.child, 1_000);
  const childLinks = linkPair();
  const forwarder = new SupervisorControlServer(
    childLinks.parent,
    createForwardControlHandler(A_ID, upstream),
  );
  const deepClient = new SupervisorControlClient(childLinks.child, 1_000);
  const remote = new RemoteTreeAuthorityPort(B_ID, deepClient);
  const actor = Object.freeze({ kind: "agent" as const, agent_id: B_ID });
  assert.deepEqual(expectSuccess(await remote.listTemplates(actor)), [{
    template_id: "worker",
    description: "受控模板",
    tools: ["read"],
  }]);
  const resolved = expectSuccess(await remote.resolveTemplate(actor, "worker"));
  const c = expectSuccess(await remote.reserveChild(actor, {
    template_id: "worker",
    template_revision: resolved.template_revision,
    name: "C",
  }));

  assert.equal(c.node.agent_id, C_ID);
  assert.equal(c.node.parent_agent_id, B_ID);
  assert.deepEqual(expectSuccess(tree.getTreeSnapshot()).nodes.map((node) => node.agent_id), [A_ID, B_ID, C_ID]);

  deepClient.close();
  forwarder.close();
  upstream.close();
  rootServer.close();
});

test("远程模板目录解析拒绝额外配置字段", async () => {
  const links = linkPair();
  const server = new SupervisorControlServer(links.parent, async (request) => Object.freeze({
    operation_id: request.operation_id,
    ok: true as const,
    data: Object.freeze([Object.freeze({
      template_id: "worker",
      tools: Object.freeze(["read"]),
      body: "不得进入模型可见目录",
    })]),
  }));
  const client = new SupervisorControlClient(links.child, 1_000);
  const remote = new RemoteTreeAuthorityPort(A_ID, client);
  const result = await remote.listTemplates(Object.freeze({ kind: "agent" as const, agent_id: A_ID }));

  assert.equal(result.ok, false);
  if (result.ok) throw new Error("预期拒绝越界模板目录");
  assert.equal(result.error.code, "internal_error");
  client.close();
  server.close();
});

test("同一 operation_id 使用不同正文时父端固定为协议故障", async () => {
  const links = linkPair();
  const server = new SupervisorControlServer(links.parent, async (request) => Object.freeze({
    operation_id: request.operation_id,
    ok: true as const,
    data: Object.freeze({ accepted: true }),
  }));
  const first: SupervisorControlRequest = Object.freeze({
    operation_id: "duplicate_operation",
    operation: "resolve_template",
    route: Object.freeze([A_ID]),
    body: Object.freeze({ template_id: "worker" }),
  });
  await links.child.publishControlRequest(first);
  await Promise.resolve();
  await links.child.publishControlRequest(Object.freeze({
    ...first,
    body: Object.freeze({ template_id: "different" }),
  }));
  assert.equal(links.parent.protocolFaults, 1);
  server.close();
});
