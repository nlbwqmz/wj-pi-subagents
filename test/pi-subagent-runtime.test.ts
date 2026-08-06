import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentController } from "../src/agent-controller.ts";
import { AGENT_TOOL_NAMES, SubagentToolError } from "../src/agent-tools.ts";
import { BridgeSupervisorEndpoint } from "../src/bridge-supervisor-endpoint.ts";
import {
  FakeManagedRpcNode,
  type ManagedRpcNodeStartContext,
  type ManagedRpcReply,
} from "../src/managed-rpc-node.ts";
import { createPiSubagentRuntimeActivator } from "../src/pi-subagent-runtime.ts";
import type { TemplateDiscoveryFileSystem } from "../src/template-discovery-snapshot.ts";

const AGENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

class RuntimeLinkedNode extends FakeManagedRpcNode {
  private endpoint: BridgeSupervisorEndpoint | undefined;

  override async start(signal?: AbortSignal, context?: ManagedRpcNodeStartContext): Promise<void> {
    const init = context?.supervisor;
    if (init === undefined) throw new Error("缺少监督初始化上下文");
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

  override async publishSupervisorReply(reply: ManagedRpcReply): Promise<void> {
    this.endpoint?.publishReply(reply);
  }

  override async requestGracefulClose(): Promise<void> {
    await super.requestGracefulClose();
    this.emitTransportFault("eof");
  }
}

interface RegisteredTool {
  readonly name: string;
  readonly execute: (...args: unknown[]) => Promise<unknown>;
}

class FakeExtensionApi {
  readonly handlers = new Map<string, Array<(event: unknown, context: unknown) => unknown>>();
  readonly tools = new Map<string, RegisteredTool>();
  readonly sentMessages: Array<{ message: unknown; options: unknown }> = [];
  activeTools = ["read", "grep"];

  on(event: string, handler: (event: unknown, context: unknown) => unknown): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  registerTool(tool: unknown): void {
    const candidate = tool as RegisteredTool;
    this.tools.set(candidate.name, candidate);
  }

  registerCommand(): void {}
  getActiveTools(): string[] { return [...this.activeTools, ...this.tools.keys()]; }
  getAllTools(): Array<{ name: string }> {
    return [
      { name: "read" },
      { name: "grep" },
      ...[...this.tools.keys()].map((name) => ({ name })),
    ];
  }
  setActiveTools(): void {}
  sendMessage(message: unknown, options: unknown): void {
    this.sentMessages.push({ message, options });
  }
  exec(): void {}
  events = { emit(): void {}, on(): void {} };

  async emit(event: string, value: unknown, context: unknown): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) await handler(value, context);
  }
}

function templateFileSystem(cwd: string, thinking?: string): TemplateDiscoveryFileSystem {
  const userDirectory = join(homedir(), ".pi", "agent", "agents");
  const projectDirectory = join(cwd, ".pi", "agents");
  const file = join(userDirectory, "researcher.md");
  return {
    readDirectory(path) {
      if (path === userDirectory) return [{ name: "researcher.md", kind: "file" }];
      if (path === projectDirectory) {
        const error = new Error("目录不存在");
        Object.assign(error, { code: "ENOENT" });
        throw error;
      }
      throw new Error("意外目录");
    },
    readFile(path) {
      if (path !== file) throw new Error("意外文件");
      return Buffer.from([
        "---",
        'tools: ""',
        ...(thinking === undefined ? [] : [`thinking: ${thinking}`]),
        "subagents: inherit",
        "contextFiles: disabled",
        "---",
        "保持回复简洁。",
      ].join("\n"), "utf8");
    },
  };
}

function extensionContext(cwd: string): Record<string, unknown> {
  const model = {
    provider: "openai",
    id: "gpt-test",
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
  };
  return {
    cwd,
    hasUI: false,
    ui: {},
    model,
    thinkingLevel: "medium",
    scopedModels: [],
    modelRegistry: {
      find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
    },
    isProjectTrusted: () => false,
    isIdle: () => true,
  };
}

async function execute(
  api: FakeExtensionApi,
  name: string,
  params: unknown,
  context: unknown,
): Promise<unknown> {
  const tool = api.tools.get(name);
  assert.ok(tool, `缺少工具 ${name}`);
  return tool.execute(`call-${name}`, params, undefined, undefined, context);
}

test("生产运行时闭合直接父子的创建、消息、回复、等待、中断与关闭", async () => {
  const cwd = "C:\\workspace\\runtime";
  const api = new FakeExtensionApi();
  const node = new RuntimeLinkedNode();
  let controller: AgentController | undefined;
  const activate = createPiSubagentRuntimeActivator({
    rootIdFactory: () => "root-runtime",
    agentIdFactory: () => AGENT_ID,
    environment: { ROOT_STABLE: "yes" },
    rootArguments: {
      maxDepth: 2,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 16,
      waitTimeoutMs: 10_000,
    },
    templateFileSystem: templateFileSystem(cwd),
    nodeFactory: () => node,
    onController: (value) => { controller = value; },
  });
  await activate(api as never, {
    ok: true,
    nodeVersion: process.versions.node,
    piVersion: "0.83.0",
    platform: "win32",
    processTreeAdapter: {} as never,
  });

  assert.deepEqual([...api.tools.keys()], [...AGENT_TOOL_NAMES]);
  assert.equal(api.handlers.get("session_start")?.length, 1);
  assert.equal(api.handlers.get("session_shutdown")?.length, 1);

  const context = extensionContext(cwd);
  await api.emit("session_start", { type: "session_start", reason: "startup" }, context);
  assert.ok(controller);

  const spawnResult = await execute(api, "spawn_agent", {
    template_id: "researcher",
    name: "运行时子代理",
  }, context) as { details?: Record<string, unknown> };
  assert.equal(spawnResult.details?.agent_id, AGENT_ID);
  assert.equal(spawnResult.details?.state, "idle");

  const firstMessage = await execute(api, "send_message", {
    agent_id: AGENT_ID,
    message: "第一段任务",
  }, context) as { details?: Record<string, unknown> };
  assert.equal(firstMessage.details?.accepted, true);
  assert.equal(typeof firstMessage.details?.message_id, "string");

  node.emitEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "直接回复" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ],
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(api.sentMessages, [{
    message: {
      customType: "pi-subagent-reply",
      content: [
        { type: "text", text: "直接回复" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ],
      display: true,
      details: { agent_id: AGENT_ID },
    },
    options: { triggerTurn: true, deliverAs: "steer" },
  }]);

  node.emitEvent({ type: "agent_settled" });
  const waited = await execute(api, "wait_agent", { agent_id: AGENT_ID }, context) as {
    details?: Record<string, unknown>;
  };
  assert.equal(waited.details?.outcome, "settled");
  assert.equal(waited.details?.state, "idle");

  await execute(api, "send_message", {
    agent_id: AGENT_ID,
    message: "第二段任务",
  }, context);
  const interrupted = await execute(api, "interrupt_agent", { agent_id: AGENT_ID }, context) as {
    details?: Record<string, unknown>;
  };
  assert.equal(interrupted.details?.accepted, true);
  assert.equal(interrupted.details?.changed, true);
  assert.equal(interrupted.details?.state, "interrupting");
  node.emitEvent({ type: "agent_settled" });

  await api.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, context);
  assert.equal(node.operations().includes("release"), true, node.operations().join(","));
});

test("预检遵循 Pi thinking 支持集合并拒绝被模型显式禁用的 off", async () => {
  const cwd = "C:\\workspace\\thinking-preflight";
  const api = new FakeExtensionApi();
  let nodeCreations = 0;
  const activate = createPiSubagentRuntimeActivator({
    rootIdFactory: () => "root-thinking",
    agentIdFactory: () => AGENT_ID,
    templateFileSystem: templateFileSystem(cwd, "off"),
    nodeFactory: () => {
      nodeCreations += 1;
      return new FakeManagedRpcNode();
    },
  });
  await activate(api as never, {
    ok: true,
    nodeVersion: process.versions.node,
    piVersion: "0.83.0",
    platform: "win32",
    processTreeAdapter: {} as never,
  });

  const context = extensionContext(cwd);
  const model = {
    provider: "openai",
    id: "gpt-test",
    reasoning: true,
    thinkingLevelMap: { off: null },
  };
  context.model = model;
  context.thinkingLevel = "off";
  context.modelRegistry = {
    find: (provider: string, id: string) => provider === model.provider && id === model.id
      ? model
      : undefined,
  };
  await api.emit("session_start", { type: "session_start", reason: "startup" }, context);

  await assert.rejects(
    execute(api, "spawn_agent", { template_id: "researcher", name: "不应启动" }, context),
    (error: unknown) => {
      assert.ok(error instanceof SubagentToolError);
      assert.equal(error.code, "template_capability_unavailable");
      return true;
    },
  );
  assert.equal(nodeCreations, 0);
  await api.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, context);
});
