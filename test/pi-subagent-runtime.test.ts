import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { AgentController } from "../src/agent-controller.ts";
import {
  CHILD_REPLY_SCHEMA,
  CHILD_REPLY_VERSION,
  parseChildReplyEnvelope,
  type ChildFinalEnvelope,
  type ChildReplyEnvelope,
} from "../src/child-reply-envelope.ts";
import {
  AGENT_TOOL_NAMES,
  CHILD_REPLY_GUIDELINE,
  CHILD_REPLY_TOOL_NAME,
  PARENT_COORDINATION_GUIDELINES,
  SubagentToolError,
} from "../src/agent-tools.ts";
import {
  FakeManagedRpcNode,
  type ManagedRpcNodeStartContext,
  type ManagedRpcReply,
} from "../src/managed-rpc-node.ts";
import {
  createPiSubagentRuntimeActivator,
  readChildRuntimeBootstrap,
} from "../src/pi-subagent-runtime.ts";
import {
  InMemoryLocalSupervisorTransportAdapter,
  type LocalSupervisorConnectOptions,
  type LocalSupervisorListenOptions,
  type LocalSupervisorTransportAdapter,
  type LocalSupervisorTransportListener,
} from "../src/local-supervisor-transport.ts";
import {
  RUNTIME_EPHEMERAL_ENV_KEYS,
  RUNTIME_INTERNAL_ENV_KEYS,
} from "../src/root-runtime-context.ts";
import { StreamSupervisorChannel, type SupervisorByteTransport } from "../src/stream-supervisor-channel.ts";
import {
  SUPERVISOR_PROTOCOL_VERSION,
  SupervisorRequestIdRegistry,
} from "../src/supervisor-channel.ts";
import type { TemplateDiscoveryFileSystem } from "../src/template-discovery-snapshot.ts";

const AGENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DESCENDANT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TURN_1 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TURN_2 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const TASK_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMMIT_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const COMMIT_2 = "99999999-9999-4999-8999-999999999999";

function finalReply(
  agentId: string,
  text: string,
  turnId = TURN_1,
  taskId = TASK_ID,
  commitId = COMMIT_ID,
): ChildFinalEnvelope {
  return {
    schema: CHILD_REPLY_SCHEMA,
    version: CHILD_REPLY_VERSION,
    kind: "final",
    agent_id: agentId,
    task_id: taskId,
    turn_id: turnId,
    commit_id: commitId,
    run_state: "settled",
    output_state: "present",
    text,
  };
}

function readSentReply(entry: { readonly message: unknown }): ChildReplyEnvelope {
  const content = (entry.message as { content?: Array<{ type?: string; text?: string }> }).content;
  const text = content?.find((item) => item.type === "text")?.text;
  if (typeof text !== "string") throw new Error("父会话消息缺少结构化文本");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("父会话消息不是 JSON");
  }
  const envelope = parseChildReplyEnvelope(value);
  if (envelope === undefined) throw new Error("父会话消息不是合法 reply envelope");
  return envelope;
}

class RuntimeLinkedNode extends FakeManagedRpcNode {
  private channel: StreamSupervisorChannel | undefined;
  private parentToChild: PassThrough | undefined;
  startContext: ManagedRpcNodeStartContext | undefined;

  override async start(signal?: AbortSignal, context?: ManagedRpcNodeStartContext): Promise<void> {
    this.startContext = context;
    const init = context?.supervisor;
    if (init === undefined) throw new Error("缺少监督初始化上下文");
    const childToParent = new PassThrough();
    const parentToChild = new PassThrough();
    childToParent.on("data", (chunk: Uint8Array) => this.emitSupervisorFrame(new Uint8Array(chunk)));
    let childEnded = false;
    const onChildEnd = (): void => {
      if (childEnded) return;
      childEnded = true;
      this.emitTransportFault("eof");
    };
    childToParent.once("end", onChildEnd);
    childToParent.once("close", onChildEnd);
    this.parentToChild = parentToChild;
    this.channel = new StreamSupervisorChannel({
      role: "child",
      rootId: init.root_id,
      localAgentId: init.local_agent_id,
      peerAgentId: init.peer_agent_id,
      parentAgentId: init.parent_agent_id,
      depth: init.depth,
      credential: init.credential,
      requestIdRegistry: new SupervisorRequestIdRegistry(),
      transport: { stdin: childToParent, stdout: parentToChild },
      initialSnapshot: init.initial_snapshot,
      initialSubtreeRevision: init.initial_subtree_revision,
      // 真正 child runtime 只有在后代清理确认后才关闭监督流；此替身没有后代，
      // 因而收到父端 close 时可以立即确认，避免把监督关闭期限误当成 lease 期限。
      onCloseRequested: () => true,
    });
    await super.start(signal, context);
    const startupSignal = signal ?? new AbortController().signal;
    await this.channel.bind(startupSignal);
  }

  override async sendSupervisorFrame(frame: Uint8Array): Promise<void> {
    this.parentToChild?.write(frame);
  }

  async publishReply(reply: ManagedRpcReply): Promise<void> {
    await this.channel?.publishReply(reply);
  }

  pendingReplyCount(): number {
    return this.channel?.getPublicState().pending_reply_count ?? 0;
  }

  override async requestGracefulClose(): Promise<void> {
    await super.requestGracefulClose();
    await this.channel?.release();
    this.emitTransportFault("eof");
  }
}

class RuntimeBridgeNode extends FakeManagedRpcNode {
  private readonly adapter: LocalSupervisorTransportAdapter;
  private readonly operationWaiters = new Map<string, Set<() => void>>();
  private listener: LocalSupervisorTransportListener | undefined;
  private transport: SupervisorByteTransport | undefined;
  private streaming = false;
  startContext: ManagedRpcNodeStartContext | undefined;

  constructor(adapter: LocalSupervisorTransportAdapter) {
    let notifyOperation: ((operation: string) => void) | undefined;
    super({ onOperation: (operation) => notifyOperation?.(operation) });
    this.adapter = adapter;
    notifyOperation = (operation) => {
      const waiters = this.operationWaiters.get(operation);
      if (waiters === undefined) return;
      this.operationWaiters.delete(operation);
      for (const resolve of waiters) resolve();
    };
  }

  waitForNextOperation(operation: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const waiters = this.operationWaiters.get(operation) ?? new Set<() => void>();
      waiters.add(resolve);
      this.operationWaiters.set(operation, waiters);
    });
  }

  override async start(signal?: AbortSignal, context?: ManagedRpcNodeStartContext): Promise<void> {
    const init = context?.supervisor;
    if (init === undefined) throw new Error("缺少监督初始化上下文");
    const localCredential = `local_${"x".repeat(38)}`;
    this.listener = await this.adapter.listen({
      agentId: init.local_agent_id,
      credential: localCredential,
    });
    this.startContext = Object.freeze({
      ...context,
      environment: Object.freeze({
        ...(context?.environment ?? {}),
        [RUNTIME_EPHEMERAL_ENV_KEYS.supervisorEndpoint]: this.listener.endpoint,
        [RUNTIME_EPHEMERAL_ENV_KEYS.localSupervisorCredential]: localCredential,
        [RUNTIME_EPHEMERAL_ENV_KEYS.supervisorCredential]: init.credential,
      }),
    });
    await super.start(signal, this.startContext);
    this.transport = await this.listener.waitForConnection(signal);
    this.transport.stdout.on("data", (chunk: Uint8Array | string) => {
      this.emitSupervisorFrame(
        typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk),
      );
    });
    const onEnd = (): void => {
      this.emitTransportFault("eof");
      void this.listener?.close();
    };
    this.transport.stdout.once("end", onEnd);
    this.transport.stdout.once("close", onEnd);
  }

  override async sendSupervisorFrame(frame: Uint8Array): Promise<void> {
    const transport = this.transport;
    if (transport === undefined) throw new Error("本地监督传输尚未连接");
    await new Promise<void>((resolve, reject) => {
      transport.stdin.write(frame, (error?: Error | null) => {
        if (error === undefined || error === null) resolve();
        else reject(error);
      });
    });
  }

  override async getState(): Promise<unknown> {
    await super.getState();
    return { isStreaming: this.streaming, isCompacting: false, pendingMessageCount: 0 };
  }

  setStreaming(value: boolean): void {
    this.streaming = value;
  }

  override async requestGracefulClose(): Promise<void> {
    await super.requestGracefulClose();
  }

  override async forceTerminate(): Promise<void> {
    await super.forceTerminate();
    await this.listener?.close();
    this.emitTransportFault("eof");
  }

  override async release(): Promise<void> {
    await this.listener?.close();
    await super.release();
  }
}

class CountingLocalSupervisorTransportAdapter implements LocalSupervisorTransportAdapter {
  readonly delegate = new InMemoryLocalSupervisorTransportAdapter();
  listenCalls = 0;
  connectCalls = 0;

  async listen(options: LocalSupervisorListenOptions): Promise<LocalSupervisorTransportListener> {
    this.listenCalls += 1;
    return this.delegate.listen(options);
  }

  async connect(options: LocalSupervisorConnectOptions): Promise<SupervisorByteTransport> {
    this.connectCalls += 1;
    return this.delegate.connect(options);
  }
}

async function waitForBootstrap(node: RuntimeBridgeNode): Promise<ManagedRpcNodeStartContext> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (node.startContext !== undefined) return node.startContext;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("未观察到 child bootstrap");
}

class FakeEventBus {
  private readonly handlers = new Map<string, Set<(value: unknown) => void>>();

  emit(channel: string, value: unknown): void {
    for (const handler of this.handlers.get(channel) ?? []) handler(value);
  }

  on(channel: string, handler: (value: unknown) => void): () => void {
    const handlers = this.handlers.get(channel) ?? new Set<(value: unknown) => void>();
    handlers.add(handler);
    this.handlers.set(channel, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.handlers.delete(channel);
    };
  }
}

interface RegisteredTool {
  readonly name: string;
  readonly execute: (...args: unknown[]) => Promise<unknown>;
}

interface RegisteredCommand {
  readonly description: string;
  readonly handler: (args: string, context: unknown) => unknown;
}

type RegisteredMessageRenderer = (
  message: unknown,
  options: { readonly expanded?: boolean; readonly outputPad?: number },
  theme: {
    fg(color: string, text: string): string;
    bg(color: string, text: string): string;
    bold(text: string): string;
  },
) => { render(width: number): string[]; invalidate(): void };

const MESSAGE_RENDER_THEME = Object.freeze({
  fg: (_color: string, text: string): string => text,
  bg: (_color: string, text: string): string => text,
  bold: (text: string): string => text,
});

class FakeExtensionApi {
  readonly handlers = new Map<string, Array<(event: unknown, context: unknown) => unknown>>();
  readonly tools = new Map<string, RegisteredTool>();
  readonly commands = new Map<string, RegisteredCommand>();
  readonly messageRenderers = new Map<string, RegisteredMessageRenderer>();
  readonly sentMessages: Array<{ message: unknown; options: unknown }> = [];
  readonly activeToolHistory: string[][] = [];
  activeTools = ["read", "grep"];
  sendMessageBlocked = false;
  readonly events: Pick<FakeEventBus, "emit" | "on">;
  private readonly eventUnsubscribers = new Set<() => void>();
  private valid = true;

  constructor(eventBus = new FakeEventBus()) {
    this.events = {
      emit: (channel, value) => eventBus.emit(channel, value),
      on: (channel, handler) => {
        const unsubscribe = eventBus.on(channel, handler);
        const tracked = (): void => {
          if (!this.eventUnsubscribers.delete(tracked)) return;
          unsubscribe();
        };
        this.eventUnsubscribers.add(tracked);
        return tracked;
      },
    };
  }

  invalidate(): void {
    this.valid = false;
    for (const unsubscribe of [...this.eventUnsubscribers]) unsubscribe();
  }

  on(event: string, handler: (event: unknown, context: unknown) => unknown): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  registerTool(tool: unknown): void {
    const candidate = tool as RegisteredTool;
    this.tools.set(candidate.name, candidate);
  }

  registerMessageRenderer(customType: string, renderer: RegisteredMessageRenderer): void {
    this.messageRenderers.set(customType, renderer);
  }

  registerCommand(name: string, command: RegisteredCommand): void {
    this.commands.set(name, command);
  }
  getActiveTools(): string[] { return [...this.activeTools, ...this.tools.keys()]; }
  getAllTools(): Array<{ name: string }> {
    return [
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
      ...this.tools.keys(),
    ].map((name) => ({ name }));
  }
  setActiveTools(tools: readonly string[]): void {
    this.activeTools = [...tools];
    this.activeToolHistory.push([...tools]);
  }
  sendMessage(message: unknown, options: unknown): void {
    if (!this.valid || this.sendMessageBlocked) throw new Error("扩展 API 已失效");
    this.sentMessages.push({ message, options });
  }
  exec(): void {}
  async emit(event: string, value: unknown, context: unknown): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) await handler(value, context);
  }
}

function templateFileSystem(
  cwd: string,
  thinking?: string,
  templateIds: readonly string[] = ["researcher"],
  templateTools = "",
): TemplateDiscoveryFileSystem {
  const userDirectory = join(homedir(), ".pi", "agent", "agents");
  const projectDirectory = join(cwd, ".pi", "agents");
  const files = new Set(templateIds.map((templateId) => join(userDirectory, `${templateId}.md`)));
  return {
    readDirectory(path) {
      if (path === userDirectory) {
        return templateIds.map((templateId) => ({ name: `${templateId}.md`, kind: "file" as const }));
      }
      if (path === projectDirectory) {
        const error = new Error("目录不存在");
        Object.assign(error, { code: "ENOENT" });
        throw error;
      }
      throw new Error("意外目录");
    },
    readFile(path) {
      if (!files.has(path)) throw new Error("意外文件");
      const toolsFrontmatter = templateTools.length === 0 ? 'tools: ""' : `tools: ${templateTools}`;
      return Buffer.from([
        "---",
        toolsFrontmatter,
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

class FakeRuntimeUi {
  readonly widgetCalls: Array<{ readonly key: string; readonly content: unknown; readonly options: unknown }> = [];
  readonly notifications: Array<{ readonly message: string; readonly type: string | undefined }> = [];
  overlay: {
    render(width: number): string[];
    handleInput?(data: string): void;
    invalidate(): void;
    dispose?(): void;
  } | undefined;
  overlayOptions: unknown;
  renderRequests = 0;

  setWidget(key: string, content: unknown, options?: unknown): void {
    this.widgetCalls.push({ key, content, options });
  }

  notify(message: string, type?: string): void {
    this.notifications.push({ message, type });
  }

  custom<T>(
    factory: (
      tui: { requestRender(): void },
      theme: unknown,
      keybindings: unknown,
      done: (result: T) => void,
    ) => {
      render(width: number): string[];
      handleInput?(data: string): void;
      invalidate(): void;
      dispose?(): void;
    },
    options?: unknown,
  ): Promise<T> {
    this.overlayOptions = options;
    return new Promise<T>((resolve) => {
      this.overlay = factory({ requestRender: () => { this.renderRequests += 1; } }, {}, {}, resolve);
    });
  }
}

function tuiExtensionContext(cwd: string, ui: FakeRuntimeUi): Record<string, unknown> {
  return {
    ...extensionContext(cwd),
    hasUI: true,
    mode: "tui",
    ui,
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

function childBootstrapEnvironment(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const environment: Record<string, string> = {
    [RUNTIME_INTERNAL_ENV_KEYS.rootId]: "root-bootstrap",
    [RUNTIME_INTERNAL_ENV_KEYS.parentAgentId]: "",
    [RUNTIME_INTERNAL_ENV_KEYS.agentId]: AGENT_ID,
    [RUNTIME_INTERNAL_ENV_KEYS.depth]: "1",
    [RUNTIME_INTERNAL_ENV_KEYS.maxDepth]: "2",
    [RUNTIME_INTERNAL_ENV_KEYS.maxChildrenPerAgent]: "4",
    [RUNTIME_INTERNAL_ENV_KEYS.maxAgentsPerTree]: "8",
    [RUNTIME_INTERNAL_ENV_KEYS.waitTimeoutMs]: "10000",
    [RUNTIME_INTERNAL_ENV_KEYS.managementEnabled]: "true",
    [RUNTIME_INTERNAL_ENV_KEYS.protocolVersion]: SUPERVISOR_PROTOCOL_VERSION,
    [RUNTIME_EPHEMERAL_ENV_KEYS.supervisorEndpoint]: "memory_bootstrap",
    [RUNTIME_EPHEMERAL_ENV_KEYS.localSupervisorCredential]: `local_${"x".repeat(32)}`,
    [RUNTIME_EPHEMERAL_ENV_KEYS.supervisorCredential]: `supervisor_${"y".repeat(32)}`,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }
  return environment;
}

test("child bootstrap 严格要求完整临时监督字段并区分根直接子与深层父标识", async () => {
  assert.deepEqual(readChildRuntimeBootstrap({ ORDINARY: "value" }), { kind: "root" });

  const direct = readChildRuntimeBootstrap(childBootstrapEnvironment());
  assert.equal(direct.kind, "child");
  if (direct.kind === "child") {
    assert.equal(direct.bootstrap.parentAgentId, null);
    assert.equal(direct.bootstrap.depth, 1);
  }

  for (const key of Object.values(RUNTIME_EPHEMERAL_ENV_KEYS)) {
    assert.deepEqual(readChildRuntimeBootstrap(childBootstrapEnvironment({ [key]: undefined })), {
      kind: "invalid",
    });
  }

  const parentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const deep = readChildRuntimeBootstrap(childBootstrapEnvironment({
    [RUNTIME_INTERNAL_ENV_KEYS.parentAgentId]: parentId,
    [RUNTIME_INTERNAL_ENV_KEYS.depth]: "2",
  }));
  assert.equal(deep.kind, "child");
  if (deep.kind === "child") assert.equal(deep.bootstrap.parentAgentId, parentId);

  assert.deepEqual(readChildRuntimeBootstrap(childBootstrapEnvironment({
    [RUNTIME_INTERNAL_ENV_KEYS.depth]: "2",
  })), { kind: "invalid" });
  assert.deepEqual(readChildRuntimeBootstrap(childBootstrapEnvironment({
    [RUNTIME_INTERNAL_ENV_KEYS.parentAgentId]: parentId,
  })), { kind: "invalid" });
  assert.deepEqual(readChildRuntimeBootstrap(childBootstrapEnvironment({
    [RUNTIME_INTERNAL_ENV_KEYS.parentAgentId]: "NOT-CANONICAL",
    [RUNTIME_INTERNAL_ENV_KEYS.depth]: "2",
  })), { kind: "invalid" });

  const secretCanary = `secret_canary_${"z".repeat(32)}`;
  const invalidEnvironment = childBootstrapEnvironment({
    [RUNTIME_EPHEMERAL_ENV_KEYS.supervisorEndpoint]: undefined,
    [RUNTIME_EPHEMERAL_ENV_KEYS.localSupervisorCredential]: secretCanary,
  });
  const api = new FakeExtensionApi();
  const activate = createPiSubagentRuntimeActivator({ environment: invalidEnvironment });
  await activate(api as never, {
    ok: true,
    nodeVersion: process.versions.node,
    piVersion: "0.83.0",
    platform: "win32",
    processTreeAdapter: {} as never,
  });
  await assert.rejects(
    api.emit("session_start", { type: "session_start", reason: "startup" }, extensionContext("C:\\workspace\\invalid-bootstrap")),
    (error: unknown) => {
      assert.match(String(error), /子运行时身份元数据无效/);
      assert.doesNotMatch(String(error), /secret_canary|PI_SUBAGENT|memory_bootstrap/);
      return true;
    },
  );
});

test("final ACK 失败不阻塞 runtime settled handler，并由独立监督流收敛", async () => {
  const cwd = "C:\\workspace\\final-ack-failure";
  const transportAdapter = new InMemoryLocalSupervisorTransportAdapter();
  const localCredential = `local_${"l".repeat(32)}`;
  const supervisorCredential = `supervisor_${"s".repeat(32)}`;
  const listener = await transportAdapter.listen({
    agentId: AGENT_ID,
    credential: localCredential,
  });
  const api = new FakeExtensionApi();
  let controller: AgentController | undefined;
  const activate = createPiSubagentRuntimeActivator({
    environment: childBootstrapEnvironment({
      [RUNTIME_EPHEMERAL_ENV_KEYS.supervisorEndpoint]: listener.endpoint,
      [RUNTIME_EPHEMERAL_ENV_KEYS.localSupervisorCredential]: localCredential,
      [RUNTIME_EPHEMERAL_ENV_KEYS.supervisorCredential]: supervisorCredential,
    }),
    agentIdFactory: () => DESCENDANT_ID,
    localSupervisorTransportAdapter: transportAdapter,
    templateFileSystem: templateFileSystem(cwd),
    onController: (value) => { controller = value; },
  });
  await activate(api as never, {
    ok: true,
    nodeVersion: process.versions.node,
    piVersion: "0.83.0",
    platform: "win32",
    processTreeAdapter: {} as never,
  });
  const context = extensionContext(cwd);
  const sessionStart = api.emit("session_start", { type: "session_start", reason: "startup" }, context);
  const transport = await listener.waitForConnection();
  const parentChannel = new StreamSupervisorChannel({
    role: "parent",
    rootId: "root-bootstrap",
    localAgentId: null,
    peerAgentId: AGENT_ID,
    parentAgentId: null,
    depth: 1,
    credential: supervisorCredential,
    requestIdRegistry: new SupervisorRequestIdRegistry(),
    transport,
    onReply: () => false,
  });
  const bindingAbort = new AbortController();
  await parentChannel.bind(bindingAbort.signal);
  await Promise.all([parentChannel.waitForReady(bindingAbort.signal), sessionStart]);
  assert.ok(controller);

  await api.emit("agent_start", { type: "agent_start" }, context);
  await api.emit("agent_end", { type: "agent_end" }, context);
  const settling = api.emit("agent_settled", { type: "agent_settled" }, context);
  await settling;
  await new Promise<void>((resolve) => setImmediate(resolve));

  await listener.close();
  await parentChannel.release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(api.sentMessages.length, 0);

  assert.equal(await controller.shutdown(), true);
  api.invalidate();
  await listener.close();
});

test("前置 settled handler 延迟期间启动的新轮不会被旧 settle 提前提交 final", async () => {
  const cwd = "C:\\workspace\\preceding-settle-overlap";
  const transportAdapter = new InMemoryLocalSupervisorTransportAdapter();
  const localCredential = `local_${"l".repeat(32)}`;
  const supervisorCredential = `supervisor_${"s".repeat(32)}`;
  const listener = await transportAdapter.listen({
    agentId: AGENT_ID,
    credential: localCredential,
  });
  const api = new FakeExtensionApi();
  let precedingDelay: Promise<void> | undefined;
  let releasePreceding!: () => void;
  api.on("agent_settled", () => precedingDelay);
  const activate = createPiSubagentRuntimeActivator({
    environment: childBootstrapEnvironment({
      [RUNTIME_EPHEMERAL_ENV_KEYS.supervisorEndpoint]: listener.endpoint,
      [RUNTIME_EPHEMERAL_ENV_KEYS.localSupervisorCredential]: localCredential,
      [RUNTIME_EPHEMERAL_ENV_KEYS.supervisorCredential]: supervisorCredential,
    }),
    agentIdFactory: () => DESCENDANT_ID,
    localSupervisorTransportAdapter: transportAdapter,
    templateFileSystem: templateFileSystem(cwd),
  });
  await activate(api as never, {
    ok: true,
    nodeVersion: process.versions.node,
    piVersion: "0.83.0",
    platform: "win32",
    processTreeAdapter: {} as never,
  });
  const context = extensionContext(cwd);
  let idle = true;
  context.isIdle = () => idle;
  const sessionStart = api.emit("session_start", { type: "session_start", reason: "startup" }, context);
  const transport = await listener.waitForConnection();
  const delivered: ChildReplyEnvelope[] = [];
  const parentChannel = new StreamSupervisorChannel({
    role: "parent",
    rootId: "root-bootstrap",
    localAgentId: null,
    peerAgentId: AGENT_ID,
    parentAgentId: null,
    depth: 1,
    credential: supervisorCredential,
    requestIdRegistry: new SupervisorRequestIdRegistry(),
    transport,
    onReply: (reply) => {
      delivered.push(reply.envelope);
      return true;
    },
  });
  const bindingAbort = new AbortController();
  await parentChannel.bind(bindingAbort.signal);
  await Promise.all([parentChannel.waitForReady(bindingAbort.signal), sessionStart]);

  await api.emit("agent_start", { type: "agent_start" }, context);
  await api.emit("message_end", {
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "旧轮结果" }] },
  }, context);
  await api.emit("agent_end", { type: "agent_end" }, context);
  precedingDelay = new Promise<void>((resolve) => { releasePreceding = resolve; });
  const oldSettlement = api.emit("agent_settled", { type: "agent_settled" }, context);
  await new Promise<void>((resolve) => setImmediate(resolve));

  idle = false;
  await api.emit("agent_start", { type: "agent_start" }, context);
  await api.emit("message_end", {
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "新轮结果" }] },
  }, context);
  releasePreceding();
  precedingDelay = undefined;
  await oldSettlement;
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(delivered.length, 0);

  await api.emit("agent_end", { type: "agent_end" }, context);
  idle = true;
  await api.emit("agent_settled", { type: "agent_settled" }, context);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.kind, "final");
  if (delivered[0]?.kind === "final") assert.equal(delivered[0].text, "新轮结果");

  await api.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, context);
  await parentChannel.release();
  await listener.close();
});

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
  assert.deepEqual([...api.messageRenderers.keys()], [
    "pi-subagent-message",
    "pi-subagent-final",
    "pi-subagent-terminal",
  ]);
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
  assert.equal(typeof firstMessage.details?.task_id, "string");

  node.emitEvent({ type: "agent_settled" });
  const directReply = finalReply(
    AGENT_ID,
    "直接回复",
    TURN_1,
    String(firstMessage.details?.task_id),
  );
  await node.publishReply(directReply);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(api.sentMessages, [{
    message: {
      customType: "pi-subagent-final",
      content: [
        {
          type: "text",
          text: JSON.stringify(directReply),
        },
      ],
      display: true,
      details: {
        agent_id: AGENT_ID,
        kind: "final",
        run_state: "settled",
        output_state: "present",
        sender_name: "运行时子代理",
      },
    },
    options: { triggerTurn: true, deliverAs: "steer" },
  }]);

  const finalRenderer = api.messageRenderers.get("pi-subagent-final");
  assert.ok(finalRenderer);
  const finalDisplay = finalRenderer(
    api.sentMessages[0]!.message,
    { expanded: true, outputPad: 0 },
    MESSAGE_RENDER_THEME,
  ).render(120).join("\n");
  assert.match(finalDisplay, new RegExp(`Sender: 运行时子代理 · ${AGENT_ID}`));
  assert.match(finalDisplay, /Payload[^\r\n]*\r?\n[^\r\n]*直接回复/);
  assert.doesNotMatch(finalDisplay, /图片|aGVsbG8=/);

  const waited = await execute(api, "wait_agent", { agent_ids: [AGENT_ID] }, context) as {
    details?: Record<string, unknown>;
  };
  assert.equal(waited.details?.outcome, "task_completed");
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
  const terminatedDisplay = finalRenderer(
    api.sentMessages[0]!.message,
    { expanded: true, outputPad: 0 },
    MESSAGE_RENDER_THEME,
  ).render(120).join("\n");
  assert.match(terminatedDisplay, new RegExp(`Sender: ${AGENT_ID}`));
  assert.doesNotMatch(terminatedDisplay, /运行时子代理/);
});

test("运行时以单数 agent 命令交付只读 TUI，并在会话关闭时清理 UI", async () => {
  const cwd = "C:\\workspace\\agent-tree-ui";
  const api = new FakeExtensionApi();
  const ui = new FakeRuntimeUi();
  const context = tuiExtensionContext(cwd, ui);
  const node = new RuntimeLinkedNode();
  const activate = createPiSubagentRuntimeActivator({
    rootIdFactory: () => "root-agent-tree-ui",
    agentIdFactory: () => AGENT_ID,
    rootArguments: {
      maxDepth: 2,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 8,
      waitTimeoutMs: 10_000,
    },
    templateFileSystem: templateFileSystem(cwd),
    nodeFactory: () => node,
  });
  await activate(api as never, {
    ok: true,
    nodeVersion: process.versions.node,
    piVersion: "0.83.0",
    platform: "win32",
    processTreeAdapter: {} as never,
  });
  assert.deepEqual([...api.commands.keys()], ["agent"]);
  await api.emit("session_start", { type: "session_start", reason: "startup" }, context);
  const firstWidget = ui.widgetCalls.at(-1);
  assert.equal(firstWidget?.key, "pi-subagent-agents");
  assert.equal(typeof firstWidget?.content, "function");
  const tui = { requestRender: () => {} };
  const widget = (firstWidget?.content as (
    widgetTui: { requestRender(): void },
  ) => { render(width: number): string[] })(tui);
  assert.deepEqual(widget.render(80), []);

  await execute(api, "spawn_agent", { template_id: "researcher", name: "TUI 子代理" }, context);
  assert.deepEqual(widget.render(80), [
    "Agents",
    "  researcher · TUI 子代理 · idle · 0s",
  ]);
  const command = api.commands.get("agent");
  assert.ok(command);
  const opened = command.handler("", context) as Promise<void>;
  assert.deepEqual(ui.overlayOptions, {
    overlay: true,
    overlayOptions: { width: 96, anchor: "center", margin: 1 },
  });
  assert.match(ui.overlay?.render(80).join("\n") ?? "", /AGENT TREE\s+REV/);
  ui.overlay?.handleInput?.("\x1b");
  await opened;

  node.emitTransportFault("eof");
  assert.deepEqual(ui.notifications, [{
    message: "代理故障：researcher ×1；internal_error ×1",
    type: "warning",
  }]);
  assert.equal(api.sentMessages.length, 1);
  assert.deepEqual(api.sentMessages[0], {
    message: {
      customType: "pi-subagent-terminal",
      content: [{
        type: "text",
        text: JSON.stringify({
          schema: "pi-subagent.terminal",
          version: CHILD_REPLY_VERSION,
          kind: "terminal",
          agent_id: AGENT_ID,
          node_state: "failed",
          reason_code: "runtime_fault",
        }),
      }],
      display: true,
      details: {
        agent_id: AGENT_ID,
        kind: "terminal",
        node_state: "failed",
        sender_name: "TUI 子代理",
      },
    },
    options: { triggerTurn: true, deliverAs: "steer" },
  });
  await api.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, context);
  assert.deepEqual(ui.widgetCalls.at(-1), {
    key: "pi-subagent-agents",
    content: undefined,
    options: { placement: "aboveEditor" },
  });
});

test("根会话 new、resume、fork 与 quit 都按同一有界关闭语义清理整树", async () => {
  for (const reason of ["new", "resume", "fork", "quit"] as const) {
    const cwd = `C:\\workspace\\root-close-${reason}`;
    const api = new FakeExtensionApi();
    const node = new RuntimeLinkedNode();
    const activate = createPiSubagentRuntimeActivator({
      rootIdFactory: () => `root-close-${reason}`,
      agentIdFactory: () => AGENT_ID,
      rootArguments: {
        maxDepth: 2,
        maxChildrenPerAgent: 4,
        maxAgentsPerTree: 8,
        waitTimeoutMs: 10_000,
      },
      templateFileSystem: templateFileSystem(cwd),
      nodeFactory: () => node,
    });
    await activate(api as never, {
      ok: true,
      nodeVersion: process.versions.node,
      piVersion: "0.83.0",
      platform: "win32",
      processTreeAdapter: {} as never,
    });
    const context = extensionContext(cwd);
    await api.emit("session_start", { type: "session_start", reason: "startup" }, context);
    await execute(api, "spawn_agent", {
      template_id: "researcher",
      name: `${reason} 前节点`,
    }, context);

    await api.emit("session_shutdown", { type: "session_shutdown", reason }, context);
    assert.equal(node.operations().includes("release"), true, `${reason}: ${node.operations().join(",")}`);
    assert.equal(node.operations().includes("force_terminate"), false, `${reason}: ${node.operations().join(",")}`);
  }
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

test("根会话 max 场景允许模板请求父活动工具之外的已注册业务工具", async () => {
  const cwd = "C:\\workspace\\active-tool-preflight";
  const api = new FakeExtensionApi();
  api.activeTools = ["read"];
  let nodeCreations = 0;
  let createdTools: readonly string[] | undefined;
  const activate = createPiSubagentRuntimeActivator({
    rootIdFactory: () => "root-active-tool-preflight",
    agentIdFactory: () => AGENT_ID,
    templateFileSystem: templateFileSystem(
      cwd,
      undefined,
      ["Explore"],
      "edit",
    ),
    nodeFactory: (template) => {
      nodeCreations += 1;
      createdTools = template.tools;
      return new RuntimeLinkedNode();
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
  context.thinkingLevel = "max";
  await api.emit("session_start", { type: "session_start", reason: "startup" }, context);

  const spawned = await execute(api, "spawn_agent", { template_id: "Explore", name: "允许启动" }, context) as {
    details?: { template_id?: string; state?: string };
  };
  assert.equal(spawned.details?.template_id, "Explore");
  assert.equal(spawned.details?.state, "idle");
  assert.deepEqual(createdTools, ["edit"]);
  assert.equal(nodeCreations, 1);
  await api.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, context);
});

test("递归 child runtime 继承冻结树权威、作用域 actor 和逐级管理能力", async () => {
  const cwd = "C:\\workspace\\recursive-runtime";
  const transportAdapter = new InMemoryLocalSupervisorTransportAdapter();
  const rootApi = new FakeExtensionApi();
  const childApi = new FakeExtensionApi();
  let precedingSettleDelay: Promise<void> | undefined;
  childApi.on("agent_settled", () => precedingSettleDelay);
  const parentNode = new RuntimeBridgeNode(transportAdapter);
  const grandchildNode = new RuntimeBridgeNode(transportAdapter);
  let rootController: AgentController | undefined;
  let childController: AgentController | undefined;
  const hostCapabilities = {
    ok: true as const,
    nodeVersion: process.versions.node,
    piVersion: "0.83.0",
    platform: "win32" as const,
    processTreeAdapter: {} as never,
  };
  const rootContext = extensionContext(cwd);
  const allocatedIds = [
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  ];
  const rootActivate = createPiSubagentRuntimeActivator({
    rootIdFactory: () => "root-recursive",
    agentIdFactory: () => allocatedIds.shift() ?? "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    environment: { ROOT_STABLE: "yes" },
    rootArguments: {
      maxDepth: 2,
      maxChildrenPerAgent: 1,
      maxAgentsPerTree: 2,
      waitTimeoutMs: 10_000,
    },
    templateFileSystem: templateFileSystem(cwd),
    nodeFactory: () => parentNode,
    onController: (controller) => { rootController = controller; },
  });
  await rootActivate(rootApi as never, hostCapabilities);
  await rootApi.emit("session_start", { type: "session_start", reason: "startup" }, rootContext);
  assert.ok(rootController);
  const rootPromptHandler = rootApi.handlers.get("before_agent_start")?.[0];
  assert.ok(rootPromptHandler);
  const parentCoordinationGuidance = [
    "父子任务协作要求：",
    `- ${PARENT_COORDINATION_GUIDELINES.taskOwnership}`,
    `- ${PARENT_COORDINATION_GUIDELINES.sendMessage}`,
    `- ${PARENT_COORDINATION_GUIDELINES.waitAgent}`,
    `- ${PARENT_COORDINATION_GUIDELINES.slowProgress}`,
    `- ${PARENT_COORDINATION_GUIDELINES.taskRecovery}`,
    `- ${PARENT_COORDINATION_GUIDELINES.retryPolicy}`,
    `- ${PARENT_COORDINATION_GUIDELINES.interruptAgent}`,
  ].join("\n");
  const childFinalReplyGuidance = [
    "子代理任务与最终答复要求：",
    `- ${CHILD_REPLY_GUIDELINE}`,
    "- 压缩或自动续轮后继续同一逻辑任务，不重复已经完成的副作用。",
    "- 任务结束前必须输出一条非空且可用的最终 assistant 答复；运行时会以该文本准备 final。",
    "- 如果产物已经写入文件，仍要说明完成内容、关键结果和产物路径。",
    "- 不要以工具调用、工具结果、reply_to_parent 或空白 assistant 消息结束任务。",
    "- 如果没有可用结果，请简短说明原因。",
  ].join("\n");
  assert.equal(await rootPromptHandler({ systemPrompt: "根会话提示" }, rootContext), undefined);
  const rootCustomPromptResult = await rootPromptHandler({
    systemPrompt: "自定义根会话提示",
    systemPromptOptions: { customPrompt: "自定义根会话提示" },
  }, rootContext) as { readonly systemPrompt?: unknown };
  assert.equal(rootCustomPromptResult.systemPrompt, [
    "自定义根会话提示",
    "",
    parentCoordinationGuidance,
  ].join("\n"));
  assert.match(String(rootCustomPromptResult.systemPrompt), /只读分析和独立验证都属于重复实施/);
  assert.match(String(rootCustomPromptResult.systemPrompt), /‘无写冲突’/);
  assert.match(String(rootCustomPromptResult.systemPrompt), /运行缓慢/);
  assert.match(String(rootCustomPromptResult.systemPrompt), /默认重试 3 次/);
  assert.match(String(rootCustomPromptResult.systemPrompt), /最多 5 次/);
  assert.match(String(rootCustomPromptResult.systemPrompt), /spawn_failed 和 internal_error/);
  assert.match(String(rootCustomPromptResult.systemPrompt), /不要只总结当前探索内容/);

  const rootTemplates = await execute(rootApi, "get_agent_templates", {}, rootContext) as {
    details?: Array<{ template_id: string; tools: string[] }>;
  };
  assert.deepEqual(rootTemplates.details, [{ template_id: "researcher", tools: [] }]);

  const parentSpawn = execute(rootApi, "spawn_agent", {
    template_id: "researcher",
    name: "递归父代理",
  }, rootContext) as Promise<{ details?: Record<string, unknown> }>;
  const parentBootstrap = await waitForBootstrap(parentNode);

  const childActivate = createPiSubagentRuntimeActivator({
    // 故意给 child 一个更宽松的候选配置；bootstrap 不应读取它。
    rootIdFactory: () => "wrong-child-root",
    rootArguments: {
      maxDepth: 8,
      maxChildrenPerAgent: 16,
      maxAgentsPerTree: 64,
      waitTimeoutMs: 600_000,
    },
    environment: parentBootstrap.environment,
    localSupervisorTransportAdapter: transportAdapter,
    templateFileSystem: templateFileSystem(cwd),
    nodeFactory: () => grandchildNode,
    onController: (controller) => { childController = controller; },
  });
  await childActivate(childApi as never, hostCapabilities);
  let followingSettleDelay: Promise<void> | undefined;
  childApi.on("agent_settled", () => followingSettleDelay);
  const childContext = extensionContext(cwd);
  await childApi.emit("session_start", { type: "session_start", reason: "startup" }, childContext);
  const childPromptHandler = childApi.handlers.get("before_agent_start")?.[0];
  assert.ok(childPromptHandler);
  const childPromptResult = await childPromptHandler({ systemPrompt: "模板与项目提示" }, childContext) as {
    readonly systemPrompt?: unknown;
  };
  assert.equal(childPromptResult.systemPrompt, [
    "模板与项目提示",
    "",
    childFinalReplyGuidance,
  ].join("\n"));
  const childCustomPromptResult = await childPromptHandler({
    systemPrompt: "自定义模板与项目提示",
    systemPromptOptions: { customPrompt: "自定义模板与项目提示" },
  }, childContext) as { readonly systemPrompt?: unknown };
  assert.equal(childCustomPromptResult.systemPrompt, [
    "自定义模板与项目提示",
    "",
    parentCoordinationGuidance,
    "",
    childFinalReplyGuidance,
  ].join("\n"));
  const spawnedParent = await parentSpawn;
  const parentId = String(spawnedParent.details?.agent_id);
  assert.equal(parentId, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  assert.ok(childController);
  assert.deepEqual(childController.actor, { kind: "agent", agent_id: parentId });
  assert.equal(childController.getAgentTree().ok, true);
  const childTemplates = await execute(childApi, "get_agent_templates", {}, childContext) as {
    details?: Array<{ template_id: string; tools: string[] }>;
  };
  assert.deepEqual(childTemplates.details, rootTemplates.details);

  await childApi.emit("agent_start", { type: "agent_start" }, childContext);
  await childApi.emit("message_end", {
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "toolUse",
      content: [
        { type: "thinking", thinking: "SECRET_CHILD_THINKING" },
        { type: "text", text: "过程文本不应上行" },
        { type: "toolCall", id: "SECRET_CALL", name: "read", arguments: { secret: true } },
      ],
    },
  }, childContext);
  assert.equal(rootApi.sentMessages.length, 0);

  const progressReply = await execute(childApi, CHILD_REPLY_TOOL_NAME, {
    message: "正在继续工作",
  }, childContext) as { details?: Record<string, unknown> };
  assert.equal(progressReply.details?.accepted, true);
  assert.equal(rootApi.sentMessages.length, 1);
  const progressEnvelope = readSentReply(rootApi.sentMessages[0]!);
  assert.equal(progressEnvelope.kind, "message");
  if (progressEnvelope.kind === "message") {
    assert.equal(progressEnvelope.agent_id, parentId);
    assert.equal(progressEnvelope.text, "正在继续工作");
  }
  assert.deepEqual((rootApi.sentMessages[0]!.message as { details: unknown }).details, {
    agent_id: parentId,
    kind: "message",
    sender_name: "递归父代理",
  });
  assert.deepEqual(rootApi.sentMessages[0]!.options, { triggerTurn: true, deliverAs: "steer" });

  const progressRenderer = rootApi.messageRenderers.get("pi-subagent-message");
  assert.ok(progressRenderer);
  assert.match(
    progressRenderer(rootApi.sentMessages[0]!.message, { expanded: true, outputPad: 0 }, MESSAGE_RENDER_THEME)
      .render(120).join("\n"),
    new RegExp(`Sender: 递归父代理 · ${parentId}`),
  );

  await childApi.emit("message_end", {
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "thinking", thinking: "SECRET_CHILD_THINKING" }, { type: "text", text: "真正 child 最终回复" }],
    },
  }, childContext);
  await childApi.emit("agent_settled", { type: "agent_settled" }, childContext);
  parentNode.emitEvent({ type: "agent_settled" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(rootApi.sentMessages.length, 2);
  const parentFinalEnvelope = readSentReply(rootApi.sentMessages[1]!);
  assert.equal(parentFinalEnvelope.kind, "final");
  if (parentFinalEnvelope.kind === "final") {
    assert.equal(parentFinalEnvelope.agent_id, parentId);
    assert.equal(parentFinalEnvelope.turn_id, progressEnvelope.turn_id);
    assert.equal(parentFinalEnvelope.run_state, "settled");
    assert.equal(parentFinalEnvelope.output_state, "present");
    assert.equal(parentFinalEnvelope.text, "真正 child 最终回复");
  }
  assert.deepEqual((rootApi.sentMessages[1]!.message as { details: unknown }).details, {
    agent_id: parentId,
    kind: "final",
    run_state: "settled",
    output_state: "present",
    sender_name: "递归父代理",
  });
  assert.deepEqual(rootApi.sentMessages[1]!.options, { triggerTurn: true, deliverAs: "steer" });
  const recursiveFinalRenderer = rootApi.messageRenderers.get("pi-subagent-final");
  assert.ok(recursiveFinalRenderer);
  assert.match(
    recursiveFinalRenderer(rootApi.sentMessages[1]!.message, { expanded: true, outputPad: 0 }, MESSAGE_RENDER_THEME)
      .render(120).join("\n"),
    new RegExp(`Sender: 递归父代理 · ${parentId}`),
  );
  assert.doesNotMatch(JSON.stringify(rootApi.sentMessages), /SECRET_CHILD_THINKING|SECRET_CALL/);

  const grandchildSpawn = execute(childApi, "spawn_agent", {
    template_id: "researcher",
    name: "递归孙代理",
  }, childContext) as Promise<{ details?: Record<string, unknown> }>;
  const grandchildBootstrap = await waitForBootstrap(grandchildNode);

  const leafApi = new FakeExtensionApi();
  const leafActivate = createPiSubagentRuntimeActivator({
    environment: grandchildBootstrap.environment,
    localSupervisorTransportAdapter: transportAdapter,
    templateFileSystem: templateFileSystem(cwd),
  });
  await leafActivate(leafApi as never, hostCapabilities);
  const leafContext = extensionContext(cwd);
  await leafApi.emit("session_start", { type: "session_start", reason: "startup" }, leafContext);
  const leafPromptHandler = leafApi.handlers.get("before_agent_start")?.[0];
  assert.ok(leafPromptHandler);
  const leafCustomPromptResult = await leafPromptHandler({
    systemPrompt: "叶节点自定义提示",
    systemPromptOptions: { customPrompt: "叶节点自定义提示" },
  }, leafContext) as { readonly systemPrompt?: unknown };
  assert.equal(leafCustomPromptResult.systemPrompt, [
    "叶节点自定义提示",
    "",
    childFinalReplyGuidance,
  ].join("\n"));
  const spawnedGrandchild = await grandchildSpawn;
  const grandchildId = String(spawnedGrandchild.details?.agent_id);
  assert.equal(grandchildId, "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  assert.equal(grandchildBootstrap.environment?.PI_SUBAGENT_MANAGEMENT_ENABLED, "false");
  const childActiveTools = childApi.activeToolHistory.at(-1) ?? [];
  const leafActiveTools = leafApi.activeToolHistory.at(-1) ?? [];
  assert.equal(AGENT_TOOL_NAMES.every((name) => childActiveTools.includes(name)), true);
  assert.equal(childActiveTools.includes(CHILD_REPLY_TOOL_NAME), true);
  assert.equal(AGENT_TOOL_NAMES.some((name) => leafActiveTools.includes(name)), false);
  assert.equal(leafActiveTools.includes(CHILD_REPLY_TOOL_NAME), true);

  await childApi.emit("agent_start", { type: "agent_start" }, childContext);
  parentNode.emitEvent({ type: "agent_start" });
  await childApi.emit("message_end", {
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "中间代理旧轮结果" }],
    },
  }, childContext);
  await childApi.emit("agent_end", { type: "agent_end" }, childContext);
  rootApi.sendMessageBlocked = true;
  let releasePrecedingSettle!: () => void;
  let releaseFollowingSettle!: () => void;
  precedingSettleDelay = new Promise<void>((resolve) => {
    releasePrecedingSettle = resolve;
  });
  followingSettleDelay = new Promise<void>((resolve) => {
    releaseFollowingSettle = resolve;
  });
  let parentSettlementFinished = false;
  const parentSettlement = childApi.emit("agent_settled", { type: "agent_settled" }, childContext).then(() => {
    parentSettlementFinished = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(parentSettlementFinished, false);

  await leafApi.emit("agent_start", { type: "agent_start" }, leafContext);
  await leafApi.emit("message_end", {
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "叶节点只回复直接父会话" }],
    },
  }, leafContext);
  await leafApi.emit("agent_end", { type: "agent_end" }, leafContext);
  let leafSettlementFinished = false;
  const leafSettlement = leafApi.emit("agent_settled", { type: "agent_settled" }, leafContext).then(() => {
    leafSettlementFinished = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  // raw settled 不等待 final ACK；回复仍被父任务的 trigger 栅栏保留在后台 outbox。
  assert.equal(leafSettlementFinished, true);
  assert.equal(childApi.sentMessages.length, 0);
  assert.equal(rootApi.sentMessages.length, 2);

  releasePrecedingSettle();
  precedingSettleDelay = undefined;
  let preparedParentFinal = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = rootController.getAgentStatus(parentId);
    if (status.ok && status.data.reply_outbox_pending_count === 1) {
      preparedParentFinal = true;
      break;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(preparedParentFinal, true);
  rootApi.sendMessageBlocked = false;
  parentNode.emitEvent({ type: "agent_settled" });
  await rootController.retryPendingReplies();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(rootApi.sentMessages.length, 3);
  const delayedParentFinal = readSentReply(rootApi.sentMessages[2]!);
  assert.equal(delayedParentFinal.kind, "final");
  if (delayedParentFinal.kind === "final") assert.equal(delayedParentFinal.text, "中间代理旧轮结果");

  // 本扩展之后的第三方 settled handler 仍未返回，但成功路径已经尝试放行。
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(parentSettlementFinished, false);
  grandchildNode.emitEvent({ type: "agent_settled" });
  await childController.retryPendingReplies();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await leafSettlement;

  assert.equal(childApi.sentMessages.length, 1);
  const leafFinalEnvelope = readSentReply(childApi.sentMessages[0]!);
  assert.equal(leafFinalEnvelope.kind, "final");
  if (leafFinalEnvelope.kind === "final") {
    assert.equal(leafFinalEnvelope.agent_id, grandchildId);
    assert.equal(leafFinalEnvelope.run_state, "settled");
    assert.equal(leafFinalEnvelope.output_state, "present");
    assert.equal(leafFinalEnvelope.text, "叶节点只回复直接父会话");
  }
  assert.deepEqual((childApi.sentMessages[0]!.message as { details: unknown }).details, {
    agent_id: grandchildId,
    kind: "final",
    run_state: "settled",
    output_state: "present",
    sender_name: "递归孙代理",
  });
  assert.deepEqual(childApi.sentMessages[0]!.options, { triggerTurn: true, deliverAs: "steer" });

  // fake Pi 不会因 sendMessage 自动启动 loop，这里按生产事件顺序公开重叠新轮。
  parentNode.setStreaming(true);
  await childApi.emit("agent_start", { type: "agent_start" }, childContext);
  parentNode.emitEvent({ type: "agent_start" });
  let parentStatus = rootController.getAgentStatus(parentId);
  assert.equal(parentStatus.ok, true);
  if (parentStatus.ok) assert.equal(parentStatus.data.state, "working");

  releaseFollowingSettle();
  followingSettleDelay = undefined;
  await parentSettlement;
  // 新 loop 已 streaming 后到达的重复/迟到 settle 必须被宿主状态复核压住。
  parentNode.emitEvent({ type: "agent_settled" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  parentStatus = rootController.getAgentStatus(parentId);
  assert.equal(parentStatus.ok, true);
  if (parentStatus.ok) assert.equal(parentStatus.data.state, "working");

  const queuedProgress = await execute(rootApi, "wait_agent", {
    agent_ids: [parentId],
    timeout_ms: 10_000,
  }, rootContext) as { details?: Record<string, unknown> };
  assert.equal(queuedProgress.details?.outcome, "reply");

  let waitFinished = false;
  const waitingForNewTurn = execute(rootApi, "wait_agent", {
    agent_ids: [parentId],
    timeout_ms: 10_000,
  }, rootContext).then((result) => {
    waitFinished = true;
    return result as { details?: Record<string, unknown> };
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(waitFinished, false);
  const steerObserved = parentNode.waitForNextOperation("steer");
  const steered = await execute(rootApi, "send_message", {
    agent_id: parentId,
    message: "继续整理叶节点结果",
  }, rootContext) as { details?: Record<string, unknown> };
  assert.equal(steered.details?.accepted, true);
  await steerObserved;
  const interruptedNewTurn = await execute(rootApi, "interrupt_agent", {
    agent_id: parentId,
  }, rootContext) as { details?: Record<string, unknown> };
  assert.equal(interruptedNewTurn.details?.changed, true);
  assert.equal(parentNode.operations().at(-1), "abort");

  await childApi.emit("message_end", {
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "aborted",
      content: [{ type: "text", text: "未完成内容不得伪装为成功" }],
    },
  }, childContext);
  await childApi.emit("agent_end", { type: "agent_end" }, childContext);
  await childApi.emit("agent_settled", { type: "agent_settled" }, childContext);
  parentNode.setStreaming(false);
  parentNode.emitEvent({ type: "agent_settled" });
  const waitedNewTurn = await waitingForNewTurn;
  assert.equal(waitedNewTurn.details?.outcome, "task_interrupted");
  assert.equal(waitedNewTurn.details?.state, "idle");
  assert.equal(rootApi.sentMessages.length, 4);
  const interruptedFinal = readSentReply(rootApi.sentMessages[3]!);
  assert.equal(interruptedFinal.kind, "final");
  if (interruptedFinal.kind === "final") {
    assert.equal(interruptedFinal.run_state, "interrupted");
    assert.equal(interruptedFinal.output_state, "absent");
  }

  await new Promise<void>((resolve) => setImmediate(resolve));

  const rootTree = rootController.getAgentTree();
  assert.equal(rootTree.ok, true);
  if (rootTree.ok) {
    assert.deepEqual(rootTree.data.nodes.map((node) => [
      node.agent_id,
      node.depth,
      node.parent_agent_id,
      node.state,
    ]), [
      [parentId, 1, null, "idle"],
      [grandchildId, 2, parentId, "idle"],
    ]);
  }
  const childTree = childController.getAgentTree();
  assert.equal(childTree.ok, true);
  if (childTree.ok) assert.deepEqual(childTree.data.nodes.map((node) => node.agent_id), [parentId, grandchildId]);

  const terminated = await execute(rootApi, "terminate_agent", {
    agent_id: parentId,
  }, rootContext) as { details?: Record<string, unknown> };
  assert.deepEqual(terminated.details, {
    agent_id: parentId,
    state: "terminated",
    changed: true,
    forced: false,
    terminated_count: 2,
  });
  assert.equal(parentNode.operations().includes("release"), true);
  assert.equal(grandchildNode.operations().includes("release"), true);

  await rootApi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, rootContext);
  await childApi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, childContext);
  await leafApi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, extensionContext(cwd));
});

test("跨扩展实例 reload 以 lease 交接树，并把既有监督器回复绑定到新 API", async () => {
  const cwd = "C:\\workspace\\reload-handoff";
  const moduleNonce = `${Date.now()}-${Math.random()}`;
  const oldModuleUrl = new URL("../src/pi-subagent-runtime.ts", import.meta.url);
  const newModuleUrl = new URL("../src/pi-subagent-runtime.ts", import.meta.url);
  oldModuleUrl.searchParams.set("reload-old", moduleNonce);
  newModuleUrl.searchParams.set("reload-new", moduleNonce);
  const [oldRuntimeModule, newRuntimeModule] = await Promise.all([
    import(oldModuleUrl.href),
    import(newModuleUrl.href),
  ]);
  assert.notStrictEqual(
    oldRuntimeModule.createPiSubagentRuntimeActivator,
    newRuntimeModule.createPiSubagentRuntimeActivator,
  );
  const eventBus = new FakeEventBus();
  const oldApi = new FakeExtensionApi(eventBus);
  const newApi = new FakeExtensionApi(eventBus);
  const firstNode = new RuntimeLinkedNode();
  const secondNode = new RuntimeLinkedNode();
  const nodes = [firstNode, secondNode];
  const allocatedIds = [
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  ];
  const capabilities = {
    ok: true as const,
    nodeVersion: process.versions.node,
    piVersion: "0.83.0",
    platform: "win32" as const,
    processTreeAdapter: {} as never,
  };
  const oldUi = new FakeRuntimeUi();
  const newUi = new FakeRuntimeUi();
  const oldContext = tuiExtensionContext(cwd, oldUi);
  const newContext = tuiExtensionContext(cwd, newUi);
  let oldController: AgentController | undefined;
  let newController: AgentController | undefined;
  const oldActivate = oldRuntimeModule.createPiSubagentRuntimeActivator({
    rootIdFactory: () => "root-reload-handoff",
    agentIdFactory: () => allocatedIds.shift() ?? "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    rootArguments: {
      maxDepth: 2,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 8,
      waitTimeoutMs: 10_000,
    },
    templateFileSystem: templateFileSystem(cwd),
    nodeFactory: () => nodes.shift() ?? new RuntimeLinkedNode(),
    onController: (controller: AgentController) => { oldController = controller; },
  });
  await oldActivate(oldApi as never, capabilities);
  await oldApi.emit("session_start", { type: "session_start", reason: "startup" }, oldContext);
  const first = await execute(oldApi, "spawn_agent", {
    template_id: "researcher",
    name: "交接前节点",
  }, oldContext) as { details?: Record<string, unknown> };
  const firstId = String(first.details?.agent_id);
  assert.equal(firstId, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  const assigned = await execute(oldApi, "send_message", {
    agent_id: firstId,
    message: "交接任务",
  }, oldContext) as { details?: Record<string, unknown> };
  const assignedTaskId = String(assigned.details?.task_id);

  await oldApi.emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, oldContext);
  oldApi.invalidate();
  assert.equal(oldUi.widgetCalls.at(-1)?.content, undefined);
  assert.deepEqual(
    firstNode.operations().filter((operation) => [
      "graceful_close",
      "force_terminate",
      "release",
    ].includes(operation)),
    [],
  );

  firstNode.emitEvent({ type: "agent_settled" });
  const handoffReply = finalReply(firstId, "交接窗口内的回复", TURN_1, assignedTaskId);
  await firstNode.publishReply(handoffReply);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(oldApi.sentMessages.length, 0);
  assert.equal(firstNode.pendingReplyCount(), 1);

  let replacementRootIdCalls = 0;
  const newActivate = newRuntimeModule.createPiSubagentRuntimeActivator({
    rootIdFactory: () => {
      replacementRootIdCalls += 1;
      return "unexpected-new-root";
    },
    templateFileSystem: templateFileSystem(cwd, undefined, ["researcher", "reviewer"]),
    onController: (controller: AgentController) => { newController = controller; },
  });
  await newActivate(newApi as never, capabilities);
  await newApi.emit("session_start", { type: "session_start", reason: "reload" }, newContext);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(typeof newUi.widgetCalls.at(-1)?.content, "function");
  assert.equal(replacementRootIdCalls, 0);
  assert.strictEqual(newController, oldController);
  assert.equal(firstNode.pendingReplyCount(), 0);
  assert.equal(newApi.sentMessages.length, 1);
  assert.deepEqual(newApi.sentMessages[0], {
    message: {
      customType: "pi-subagent-final",
      content: [{
        type: "text",
        text: JSON.stringify(handoffReply),
      }],
      display: true,
      details: {
        agent_id: firstId,
        kind: "final",
        run_state: "settled",
        output_state: "present",
      },
    },
    options: { triggerTurn: true, deliverAs: "steer" },
  });
  const reloadedFinalRenderer = newApi.messageRenderers.get("pi-subagent-final");
  assert.ok(reloadedFinalRenderer);
  assert.match(
    reloadedFinalRenderer(newApi.sentMessages[0]!.message, { expanded: true, outputPad: 0 }, MESSAGE_RENDER_THEME)
      .render(120).join("\n"),
    new RegExp(`Sender: 交接前节点 · ${firstId}`),
  );
  assert.deepEqual(
    firstNode.operations().filter((operation) => [
      "graceful_close",
      "force_terminate",
      "release",
    ].includes(operation)),
    [],
  );

  const retained = await execute(newApi, "get_agent_tree", {}, newContext) as {
    details?: { nodes?: Array<{ agent_id: string }> };
  };
  assert.deepEqual(retained.details?.nodes?.map((node) => node.agent_id), [firstId]);

  const reloadedTemplate = await execute(newApi, "spawn_agent", {
    template_id: "reviewer",
    name: "reload 新模板节点",
  }, newContext) as { details?: Record<string, unknown> };
  assert.equal(reloadedTemplate.details?.agent_id, "cccccccc-cccc-4ccc-8ccc-cccccccccccc");

  const secondAssignment = await execute(newApi, "send_message", {
    agent_id: firstId,
    message: "交接后任务",
  }, newContext) as { details?: Record<string, unknown> };
  firstNode.emitEvent({ type: "agent_settled" });
  await firstNode.publishReply(finalReply(
    firstId,
    "交接后的回复",
    TURN_2,
    String(secondAssignment.details?.task_id),
    COMMIT_2,
  ));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(oldApi.sentMessages.length, 0);
  assert.equal(newApi.sentMessages.length, 2);

  await newApi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, newContext);
  assert.equal(firstNode.operations().includes("release"), true);
  assert.equal(secondNode.operations().includes("release"), true);
});

test("根与 child 跨实例 reload 保留同一监督连接，并让既有 child 使用新模板创建后代", async () => {
  const cwd = "C:\\workspace\\recursive-reload";
  const moduleNonce = `${Date.now()}-${Math.random()}`;
  const moduleUrl = (role: string): URL => {
    const url = new URL("../src/pi-subagent-runtime.ts", import.meta.url);
    url.searchParams.set(role, moduleNonce);
    return url;
  };
  const [oldRootModule, newRootModule, oldChildModule, newChildModule] = await Promise.all([
    import(moduleUrl("recursive-root-old").href),
    import(moduleUrl("recursive-root-new").href),
    import(moduleUrl("recursive-child-old").href),
    import(moduleUrl("recursive-child-new").href),
  ]);
  const transportAdapter = new CountingLocalSupervisorTransportAdapter();
  const rootEvents = new FakeEventBus();
  const childEvents = new FakeEventBus();
  const oldRootApi = new FakeExtensionApi(rootEvents);
  const newRootApi = new FakeExtensionApi(rootEvents);
  const oldChildApi = new FakeExtensionApi(childEvents);
  const newChildApi = new FakeExtensionApi(childEvents);
  const leafApi = new FakeExtensionApi();
  const parentNode = new RuntimeBridgeNode(transportAdapter);
  const grandchildNode = new RuntimeBridgeNode(transportAdapter);
  let newRootController: AgentController | undefined;
  const allocatedIds = [
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  ];
  const capabilities = {
    ok: true as const,
    nodeVersion: process.versions.node,
    piVersion: "0.83.0",
    platform: "win32" as const,
    processTreeAdapter: {} as never,
  };
  const context = extensionContext(cwd);

  const oldRootActivate = oldRootModule.createPiSubagentRuntimeActivator({
    rootIdFactory: () => "root-recursive-reload",
    agentIdFactory: () => allocatedIds.shift() ?? "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    rootArguments: {
      maxDepth: 2,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 8,
      waitTimeoutMs: 10_000,
    },
    templateFileSystem: templateFileSystem(cwd),
    nodeFactory: () => parentNode,
  });
  await oldRootActivate(oldRootApi as never, capabilities);
  await oldRootApi.emit("session_start", { type: "session_start", reason: "startup" }, context);
  const parentSpawn = execute(oldRootApi, "spawn_agent", {
    template_id: "researcher",
    name: "跨 reload 父代理",
  }, context) as Promise<{ details?: Record<string, unknown> }>;
  const parentBootstrap = await waitForBootstrap(parentNode);

  const oldChildActivate = oldChildModule.createPiSubagentRuntimeActivator({
    environment: parentBootstrap.environment,
    localSupervisorTransportAdapter: transportAdapter,
    templateFileSystem: templateFileSystem(cwd),
    nodeFactory: () => grandchildNode,
  });
  await oldChildActivate(oldChildApi as never, capabilities);
  await oldChildApi.emit("session_start", { type: "session_start", reason: "startup" }, context);
  const parent = await parentSpawn;
  const parentId = String(parent.details?.agent_id);
  assert.equal(parentId, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  assert.equal(transportAdapter.listenCalls, 1);
  assert.equal(transportAdapter.connectCalls, 1);

  await oldChildApi.emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, context);
  oldChildApi.invalidate();
  const newChildActivate = newChildModule.createPiSubagentRuntimeActivator({
    environment: parentBootstrap.environment,
    localSupervisorTransportAdapter: transportAdapter,
    templateFileSystem: templateFileSystem(cwd),
  });
  await newChildActivate(newChildApi as never, capabilities);
  await newChildApi.emit("session_start", { type: "session_start", reason: "reload" }, context);
  assert.equal(transportAdapter.connectCalls, 1);

  await oldRootApi.emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, context);
  oldRootApi.invalidate();
  const newRootActivate = newRootModule.createPiSubagentRuntimeActivator({
    templateFileSystem: templateFileSystem(cwd, undefined, ["researcher", "reviewer"]),
    onController: (controller: AgentController) => { newRootController = controller; },
  });
  await newRootActivate(newRootApi as never, capabilities);
  await newRootApi.emit("session_start", { type: "session_start", reason: "reload" }, context);
  assert.equal(transportAdapter.listenCalls, 1);
  assert.equal(transportAdapter.connectCalls, 1);

  const reloadedTemplates = await execute(newChildApi, "get_agent_templates", {}, context) as {
    details?: Array<{ template_id: string; tools: string[] }>;
  };
  assert.deepEqual(reloadedTemplates.details, [
    { template_id: "researcher", tools: [] },
    { template_id: "reviewer", tools: [] },
  ]);

  await newChildApi.emit("agent_start", { type: "agent_start" }, context);
  await newChildApi.emit("message_end", {
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "双方 reload 后回复" }],
    },
  }, context);
  await newChildApi.emit("agent_settled", { type: "agent_settled" }, context);
  parentNode.emitEvent({ type: "agent_settled" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(oldRootApi.sentMessages.length, 0);
  assert.equal(newRootApi.sentMessages.length, 1);
  const reloadFinalEnvelope = readSentReply(newRootApi.sentMessages[0]!);
  assert.equal(reloadFinalEnvelope.kind, "final");
  if (reloadFinalEnvelope.kind === "final") {
    assert.equal(reloadFinalEnvelope.agent_id, parentId);
    assert.equal(reloadFinalEnvelope.run_state, "settled");
    assert.equal(reloadFinalEnvelope.output_state, "present");
    assert.equal(reloadFinalEnvelope.text, "双方 reload 后回复");
  }
  assert.deepEqual((newRootApi.sentMessages[0]!.message as { details: unknown }).details, {
    agent_id: parentId,
    kind: "final",
    run_state: "settled",
    output_state: "present",
  });
  assert.deepEqual(newRootApi.sentMessages[0]!.options, { triggerTurn: true, deliverAs: "steer" });
  const recursiveReloadRenderer = newRootApi.messageRenderers.get("pi-subagent-final");
  assert.ok(recursiveReloadRenderer);
  assert.match(
    recursiveReloadRenderer(newRootApi.sentMessages[0]!.message, { expanded: true, outputPad: 0 }, MESSAGE_RENDER_THEME)
      .render(120).join("\n"),
    new RegExp(`Sender: 跨 reload 父代理 · ${parentId}`),
  );

  const grandchildSpawn = execute(newChildApi, "spawn_agent", {
    template_id: "reviewer",
    name: "使用 reload 新模板的后代",
  }, context) as Promise<{ details?: Record<string, unknown> }>;
  const grandchildBootstrap = await waitForBootstrap(grandchildNode);
  const leafActivate = createPiSubagentRuntimeActivator({
    environment: grandchildBootstrap.environment,
    localSupervisorTransportAdapter: transportAdapter,
    templateFileSystem: templateFileSystem(cwd, undefined, ["researcher", "reviewer"]),
  });
  await leafActivate(leafApi as never, capabilities);
  await leafApi.emit("session_start", { type: "session_start", reason: "startup" }, context);
  const grandchild = await grandchildSpawn;
  const grandchildId = String(grandchild.details?.agent_id);
  assert.equal(grandchildId, "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  assert.equal(transportAdapter.listenCalls, 2);
  assert.equal(transportAdapter.connectCalls, 2);

  const retained = await execute(newRootApi, "get_agent_tree", {}, context) as {
    details?: { nodes?: Array<{ agent_id: string; template_id: string; parent_agent_id: string | null }> };
  };
  assert.deepEqual(retained.details?.nodes?.map((node) => [
    node.agent_id,
    node.template_id,
    node.parent_agent_id,
  ]), [
    [parentId, "researcher", null],
    [grandchildId, "reviewer", parentId],
  ]);

  await newRootApi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, context);
  assert.equal(parentNode.operations().includes("force_terminate"), false);
  assert.equal(grandchildNode.operations().includes("force_terminate"), false);
  assert.equal(parentNode.operations().includes("release"), true);
  assert.equal(grandchildNode.operations().includes("release"), true);
  const closedTree = newRootController?.getAgentTree();
  assert.equal(closedTree?.ok, true);
  if (closedTree?.ok) assert.deepEqual(closedTree.data.nodes, []);
  await newChildApi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, context);
  await leafApi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, context);
});

test("reload lease 未被新实例提交时在有界期限后清理旧树", async () => {
  const cwd = "C:\\workspace\\reload-timeout";
  const api = new FakeExtensionApi(new FakeEventBus());
  const node = new RuntimeLinkedNode();
  const context = extensionContext(cwd);
  const activate = createPiSubagentRuntimeActivator({
    rootIdFactory: () => "root-reload-timeout",
    agentIdFactory: () => AGENT_ID,
    reloadLeaseTimeoutMs: 20,
    rootArguments: {
      maxDepth: 2,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 8,
      waitTimeoutMs: 10_000,
    },
    templateFileSystem: templateFileSystem(cwd),
    nodeFactory: () => node,
  });
  await activate(api as never, {
    ok: true,
    nodeVersion: process.versions.node,
    piVersion: "0.83.0",
    platform: "win32",
    processTreeAdapter: {} as never,
  });
  await api.emit("session_start", { type: "session_start", reason: "startup" }, context);
  await execute(api, "spawn_agent", { template_id: "researcher", name: "等待租约" }, context);
  await api.emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, context);
  api.invalidate();
  assert.equal(node.operations().includes("release"), false);
  await new Promise<void>((resolve) => setTimeout(resolve, 80));
  assert.equal(node.operations().includes("release"), true);
});

test("新实例认领 lease 后可等待迟到的 reload start，不沿用 outgoing watchdog", async () => {
  const cwd = "C:\\workspace\\reload-claimed-timeout";
  const moduleNonce = `${Date.now()}-${Math.random()}`;
  const oldModuleUrl = new URL("../src/pi-subagent-runtime.ts", import.meta.url);
  const newModuleUrl = new URL("../src/pi-subagent-runtime.ts", import.meta.url);
  oldModuleUrl.searchParams.set("claimed-timeout-old", moduleNonce);
  newModuleUrl.searchParams.set("claimed-timeout-new", moduleNonce);
  const [oldRuntimeModule, newRuntimeModule] = await Promise.all([
    import(oldModuleUrl.href),
    import(newModuleUrl.href),
  ]);
  const eventBus = new FakeEventBus();
  const oldApi = new FakeExtensionApi(eventBus);
  const newApi = new FakeExtensionApi(eventBus);
  const node = new RuntimeLinkedNode();
  const context = extensionContext(cwd);
  const capabilities = {
    ok: true as const,
    nodeVersion: process.versions.node,
    piVersion: "0.83.0",
    platform: "win32" as const,
    processTreeAdapter: {} as never,
  };
  const oldActivate = oldRuntimeModule.createPiSubagentRuntimeActivator({
    rootIdFactory: () => "root-reload-claimed-timeout",
    agentIdFactory: () => AGENT_ID,
    reloadLeaseTimeoutMs: 20,
    rootArguments: {
      maxDepth: 2,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 8,
      waitTimeoutMs: 10_000,
    },
    templateFileSystem: templateFileSystem(cwd),
    nodeFactory: () => node,
  });
  await oldActivate(oldApi as never, capabilities);
  await oldApi.emit("session_start", { type: "session_start", reason: "startup" }, context);
  await execute(oldApi, "spawn_agent", { template_id: "researcher", name: "等待新实例启动" }, context);
  await oldApi.emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, context);
  oldApi.invalidate();

  const newActivate = newRuntimeModule.createPiSubagentRuntimeActivator({
    reloadLeaseTimeoutMs: 20,
    templateFileSystem: templateFileSystem(cwd),
  });
  await newActivate(newApi as never, capabilities);
  await new Promise<void>((resolve) => setTimeout(resolve, 80));
  assert.equal(node.operations().includes("release"), false);
  await newApi.emit("session_start", { type: "session_start", reason: "reload" }, context);
  assert.equal(node.operations().includes("release"), false);
  await newApi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, context);
  assert.equal(node.operations().includes("release"), true);
});

test("同一 activator 的 reload 也提交自身 lease，不会被 watchdog 误清理", async () => {
  const cwd = "C:\\workspace\\reload-same-instance";
  const api = new FakeExtensionApi(new FakeEventBus());
  const node = new RuntimeLinkedNode();
  const context = extensionContext(cwd);
  const activate = createPiSubagentRuntimeActivator({
    rootIdFactory: () => "root-reload-same-instance",
    agentIdFactory: () => AGENT_ID,
    reloadLeaseTimeoutMs: 25,
    rootArguments: {
      maxDepth: 2,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 8,
      waitTimeoutMs: 10_000,
    },
    templateFileSystem: templateFileSystem(cwd),
    nodeFactory: () => node,
  });
  await activate(api as never, {
    ok: true,
    nodeVersion: process.versions.node,
    piVersion: "0.83.0",
    platform: "win32",
    processTreeAdapter: {} as never,
  });
  await api.emit("session_start", { type: "session_start", reason: "startup" }, context);
  await execute(api, "spawn_agent", { template_id: "researcher", name: "同实例" }, context);
  await api.emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, context);
  await api.emit("session_start", { type: "session_start", reason: "reload" }, context);
  await new Promise<void>((resolve) => setTimeout(resolve, 60));
  assert.equal(node.operations().includes("release"), false);
  await api.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, context);
  assert.equal(node.operations().includes("release"), true);
});
