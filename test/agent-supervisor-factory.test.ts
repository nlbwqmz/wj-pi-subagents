import assert from "node:assert/strict";
import test from "node:test";
import {
  CHILD_REPLY_SCHEMA,
  CHILD_REPLY_VERSION,
  type ChildFinalEnvelope,
} from "../src/child-reply-envelope.ts";
import { createAgentSupervisorFactory, buildManagedRpcOptions } from "../src/agent-supervisor-factory.ts";
import { BridgeSupervisorEndpoint } from "./helpers/bridge-supervisor-endpoint.ts";
import {
  FakeManagedRpcNode,
  type ManagedRpcNodeStartContext,
  type ManagedRpcReply,
} from "../src/managed-rpc-node.ts";
import { captureRootRuntimeContext } from "../src/root-runtime-context.ts";
import type {
  TemplateDefinition,
  TemplateDiscoverySnapshot,
} from "../src/template-discovery-snapshot.ts";
import { ROOT_TREE_ACTOR, TreeController } from "../src/tree-controller.ts";

const AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TURN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TASK_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const COMMIT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function finalReply(text: string, taskId: string): ChildFinalEnvelope {
  return {
    schema: CHILD_REPLY_SCHEMA,
    version: CHILD_REPLY_VERSION,
    kind: "final",
    agent_id: AGENT_ID,
    task_id: taskId,
    turn_id: TURN_ID,
    commit_id: COMMIT_ID,
    run_state: "settled",
    output_state: "present",
    text,
  };
}

class LinkedFactoryNode extends FakeManagedRpcNode {
  private startContext: ManagedRpcNodeStartContext | undefined;
  private endpoint: BridgeSupervisorEndpoint | undefined;

  override async start(signal?: AbortSignal, context?: ManagedRpcNodeStartContext): Promise<void> {
    const init = context?.supervisor;
    if (init === undefined) throw new Error("缺少监督初始化上下文");
    this.startContext = context;
    this.endpoint = new BridgeSupervisorEndpoint({
      init,
      send: (frame) => this.emitSupervisorFrame(frame),
    });
    await super.start(signal, context);
    this.endpoint.start();
  }

  override async sendSupervisorFrame(frame: Uint8Array): Promise<void> {
    this.endpoint?.receive(frame);
  }

  async publishTaskStarted(taskId: string): Promise<void> {
    await this.endpoint?.publishTaskStarted({ task_id: taskId, turn_id: TURN_ID });
  }

  async publishReply(reply: ManagedRpcReply): Promise<void> {
    this.endpoint?.publishReply(reply);
  }

  pendingReplies(): number | undefined {
    return this.endpoint?.getPublicState().pending_reply_count;
  }

  capturedStartContext(): ManagedRpcNodeStartContext | undefined {
    return this.startContext;
  }
}

function template(overrides: Partial<TemplateDefinition> = {}): TemplateDefinition {
  return Object.freeze({
    templateId: "researcher",
    source: "user",
    templateDirectory: "C:/wj-pi-subagents/.pi/agents",
    description: "研究任务",
    tools: undefined,
    extensions: undefined,
    allowSubagents: true,
    contextFiles: false,
    systemPromptMode: "append",
    body: "",
    ...overrides,
  });
}

function snapshot(value: TemplateDefinition): TemplateDiscoverySnapshot {
  return Object.freeze({
    templates: Object.freeze([value]),
    invalidCandidates: Object.freeze([]),
    sourceDiagnostics: Object.freeze([]),
    resolveTemplate: (templateId: string) => templateId === value.templateId
      ? Object.freeze({ kind: "valid" as const, template: value })
      : Object.freeze({ kind: "not_found" as const }),
    toJSON: () => ({ templates: [{ templateId: value.templateId }] }),
  });
}

function factoryHarness(deliverReply?: (agentId: string, reply: ManagedRpcReply) => boolean): {
  readonly node: LinkedFactoryNode;
  readonly tree: TreeController;
  readonly createSupervisor: ReturnType<typeof createAgentSupervisorFactory>;
} {
  const node = new LinkedFactoryNode();
  const tree = new TreeController({
    config: { maxDepth: 2, maxChildrenPerAgent: 4, maxAgentsPerTree: 16, waitTimeoutMs: 60_000 },
    idFactory: () => AGENT_ID,
  });
  const rootRuntime = captureRootRuntimeContext({
    cwd: ".",
    projectTrust: true,
    environment: { ROOT_VALUE: "stable" },
    rootArguments: { maxDepth: 2 },
    controllerMetadata: {
      rootId: "root-factory",
      protocolVersion: "wj-pi-subagents/13",
    },
  });
  const options = {
    tree,
    actor: ROOT_TREE_ACTOR,
    processTreeAdapter: {} as never,
    rootRuntime,
    templateSnapshot: snapshot(template()),
    rootId: "root-factory",
    nodeFactory: () => node,
    startupTimeoutMs: 100,
    gracefulShutdownMs: 10,
    ...(deliverReply === undefined ? {} : { deliverReply }),
  };
  return {
    node,
    tree,
    createSupervisor: createAgentSupervisorFactory(options),
  };
}

test("受管 RPC 选项按模板覆盖或在创建瞬间继承模型与 thinking", () => {
  let currentModel = "openai/gpt-current";
  let currentThinking = "medium";
  const inherited = buildManagedRpcOptions(template(), {
    currentModel: () => currentModel,
    currentThinking: () => currentThinking,
  });
  assert.deepEqual(inherited, {
    provider: "openai",
    model: "gpt-current",
    args: ["--no-session", "--no-context-files", "--thinking", "medium"],
  });

  currentModel = "anthropic/claude-latest";
  currentThinking = "high";
  const refreshed = buildManagedRpcOptions(template(), {
    currentModel: () => currentModel,
    currentThinking: () => currentThinking,
  });
  assert.equal(refreshed.provider, "anthropic");
  assert.equal(refreshed.model, "claude-latest");
  assert.deepEqual(refreshed.args, [
    "--no-session",
    "--no-context-files",
    "--thinking",
    "high",
  ]);

  const explicit = buildManagedRpcOptions(template({
    contextFiles: true,
    systemPromptMode: "replace",
    body: "固定提示",
    tools: Object.freeze(["read", "grep"]),
    model: "google/gemini-exp",
    thinking: "xhigh",
  }), {
    currentModel: "ignored/model",
    currentThinking: "off",
  });
  assert.deepEqual(explicit, {
    provider: "google",
    model: "gemini-exp",
    templatePrompt: { mode: "replace", body: "固定提示" },
    args: [
      "--no-session",
      "--thinking",
      "xhigh",
      "--tools",
      "read,grep",
    ],
  });

  const withManagement = buildManagedRpcOptions(template(), {
    managementTools: ["spawn_agent", "send_message"],
  });
  assert.deepEqual(withManagement.args, [
    "--no-session",
    "--no-context-files",
  ]);

  const withExtension = buildManagedRpcOptions(template(), {
    extensionPath: "C:/wj-pi-subagents/index.ts",
    cliPath: "C:/pi/dist/cli.js",
    piModulePath: "C:/pi/dist/index.js",
  });
  assert.deepEqual(withExtension.args, [
    "--no-session",
    "-e",
    "C:/wj-pi-subagents/index.ts",
    "--no-context-files",
  ]);
  assert.equal(withExtension.cliPath, "C:/pi/dist/cli.js");
  assert.equal(withExtension.piModulePath, "C:/pi/dist/index.js");

  const trusted = buildManagedRpcOptions(template(), { projectTrust: true });
  const untrusted = buildManagedRpcOptions(template(), { projectTrust: false });
  assert.deepEqual(trusted.args, ["--no-session", "--approve", "--no-context-files"]);
  assert.deepEqual(untrusted.args, ["--no-session", "--no-approve", "--no-context-files"]);
});

test("身份预留后才建立监督上下文并追加最终子代理环境", async () => {
  const { node, createSupervisor } = factoryHarness(() => true);
  const supervisor = createSupervisor({
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "工厂节点" },
    template: template(),
  });
  assert.equal(node.capturedStartContext(), undefined);

  assert.deepEqual(await supervisor.start(), { ok: true, agent_id: AGENT_ID, state: "idle" });
  const context = node.capturedStartContext();
  assert.ok(context?.supervisor);
  assert.equal(context.supervisor.local_agent_id, AGENT_ID);
  assert.equal(context.supervisor.parent_agent_id, null);
  assert.equal(context.supervisor.root_id, "root-factory");
  assert.equal(context.environment?.ROOT_VALUE, "stable");
  assert.equal(context.environment?.WJ_PI_SUBAGENTS_ROOT_ID, "root-factory");
  assert.equal(context.environment?.WJ_PI_SUBAGENTS_PARENT_AGENT_ID, "");
  assert.equal(context.environment?.WJ_PI_SUBAGENTS_AGENT_ID, AGENT_ID);
  assert.equal(context.environment?.WJ_PI_SUBAGENTS_DEPTH, "1");
  assert.equal(context.environment?.WJ_PI_SUBAGENTS_MAX_DEPTH, "2");
  assert.equal(context.environment?.WJ_PI_SUBAGENTS_PROTOCOL_VERSION, "wj-pi-subagents/13");
  await supervisor.terminate();
});

test("没有安全回复投递器时父端不发送 ACK", async () => {
  const { node, createSupervisor } = factoryHarness();
  const supervisor = createSupervisor({
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "回复节点" },
    template: template(),
  });
  assert.equal((await supervisor.start()).ok, true);
  const submission = await supervisor.submit("测试任务");
  assert.equal(submission.ok, true);
  if (!submission.ok) return;
  await new Promise<void>((resolve) => setImmediate(resolve));
  node.emitEvent({ type: "agent_start" });
  await node.publishTaskStarted(submission.task_id);
  node.emitEvent({ type: "agent_settled" });

  await node.publishReply(finalReply("未投递回复", submission.task_id));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(node.pendingReplies(), 1);
  await supervisor.terminate();
});

test("安全回复投递成功后才通过监督通道确认", async () => {
  const delivered: Array<{ agentId: string; text: string }> = [];
  const { node, createSupervisor } = factoryHarness((agentId, reply) => {
    delivered.push({ agentId, text: reply.text ?? "" });
    return true;
  });
  const supervisor = createSupervisor({
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "回复节点" },
    template: template(),
  });
  assert.equal((await supervisor.start()).ok, true);
  const submission = await supervisor.submit("测试任务");
  assert.equal(submission.ok, true);
  if (!submission.ok) return;
  await new Promise<void>((resolve) => setImmediate(resolve));
  node.emitEvent({ type: "agent_start" });
  await node.publishTaskStarted(submission.task_id);
  node.emitEvent({ type: "agent_settled" });

  await node.publishReply(finalReply("已投递回复", submission.task_id));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(delivered, [{ agentId: AGENT_ID, text: "已投递回复" }]);
  assert.equal(node.pendingReplies(), 0);
  await supervisor.terminate();
});
