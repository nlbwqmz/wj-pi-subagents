import assert from "node:assert/strict";
import test from "node:test";
import { AgentActivityCache } from "../src/agent-activity-cache.ts";
import { AgentActivityViewerModel } from "../src/agent-activity-viewer.ts";
import type { AgentController } from "../src/agent-controller.ts";
import type {
  AvailableHostCapabilities,
  ExtensionApiSurface,
} from "../src/host-gate.ts";
import { InMemoryLocalSupervisorTransportAdapter } from "../src/local-supervisor-transport.ts";
import {
  RUNTIME_EPHEMERAL_ENV_KEYS,
  RUNTIME_INTERNAL_ENV_KEYS,
} from "../src/root-runtime-context.ts";
import { StreamSupervisorChannel } from "../src/stream-supervisor-channel.ts";
import {
  SUPERVISOR_PROTOCOL_VERSION,
  SupervisorRequestIdRegistry,
  type SupervisorActivityDelivery,
  type SupervisorDisplayDelivery,
} from "../src/supervisor-channel.ts";
import { createWjPiSubagentsRuntimeActivator } from "../src/wj-pi-subagents-runtime.ts";

const CHILD_ID = "550e8400-e29b-41d4-a716-446655440000";
const ROOT_ID = "activity-aggregation-root";
const LOCAL_CREDENTIAL = "local-activity-aggregation-credential-0001";
const SUPERVISOR_CREDENTIAL = "supervisor-activity-aggregation-credential-0001";

class FakeReloadEventBus {
  private readonly handlers = new Map<string, Set<(data: unknown) => void>>();

  emit(channel: string, data: unknown): void {
    for (const handler of this.handlers.get(channel) ?? []) handler(data);
  }

  on(channel: string, handler: (data: unknown) => void): () => void {
    const handlers = this.handlers.get(channel) ?? new Set<(data: unknown) => void>();
    handlers.add(handler);
    this.handlers.set(channel, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.handlers.delete(channel);
    };
  }
}

class FakeExtensionApi {
  readonly events: FakeReloadEventBus;
  private readonly handlers = new Map<string, Array<(event: unknown, context: unknown) => unknown>>();
  private readonly tools: unknown[] = [];
  private activeTools: string[] = ["read"];

  constructor(events = new FakeReloadEventBus()) {
    this.events = events;
  }

  on(event: string, handler: (event: unknown, context: unknown) => unknown): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  registerTool(tool: unknown): void {
    this.tools.push(tool);
  }

  registerCommand(_name: string, _options: unknown): void {}

  registerMessageRenderer(_customType: string, _renderer: unknown): void {}

  getActiveTools(): string[] {
    return [...this.activeTools];
  }

  getAllTools(): unknown[] {
    return [...this.tools];
  }

  setActiveTools(tools: readonly string[]): void {
    this.activeTools = [...tools];
  }

  sendMessage(_message: unknown, _options?: unknown): void {}

  async emit(event: string, value: unknown, context: unknown): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) {
      await handler(value, context);
    }
  }
}

function childEnvironment(endpoint: string): Record<string, string> {
  return {
    [RUNTIME_INTERNAL_ENV_KEYS.rootId]: ROOT_ID,
    [RUNTIME_INTERNAL_ENV_KEYS.parentAgentId]: "",
    [RUNTIME_INTERNAL_ENV_KEYS.agentId]: CHILD_ID,
    [RUNTIME_INTERNAL_ENV_KEYS.depth]: "1",
    [RUNTIME_INTERNAL_ENV_KEYS.maxDepth]: "3",
    [RUNTIME_INTERNAL_ENV_KEYS.maxChildrenPerAgent]: "4",
    [RUNTIME_INTERNAL_ENV_KEYS.maxAgentsPerTree]: "8",
    [RUNTIME_INTERNAL_ENV_KEYS.waitTimeoutMs]: "10000",
    [RUNTIME_INTERNAL_ENV_KEYS.managementEnabled]: "true",
    [RUNTIME_INTERNAL_ENV_KEYS.protocolVersion]: SUPERVISOR_PROTOCOL_VERSION,
    [RUNTIME_EPHEMERAL_ENV_KEYS.supervisorEndpoint]: endpoint,
    [RUNTIME_EPHEMERAL_ENV_KEYS.localSupervisorCredential]: LOCAL_CREDENTIAL,
    [RUNTIME_EPHEMERAL_ENV_KEYS.supervisorCredential]: SUPERVISOR_CREDENTIAL,
  };
}

async function waitForCount(values: readonly unknown[], count: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (values.length < count && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForMatch<T>(
  values: readonly T[],
  matches: (value: T) => boolean,
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!values.some(matches) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(values.some(matches));
}

test("子模式扩展把本进程完整活动规范化上行且不在本层缓存", async () => {
  const transportAdapter = new InMemoryLocalSupervisorTransportAdapter();
  const listener = await transportAdapter.listen({
    agentId: CHILD_ID,
    credential: LOCAL_CREDENTIAL,
  });
  const api = new FakeExtensionApi();
  const context = {
    cwd: process.cwd(),
    mode: "print",
    hasUI: false,
    isProjectTrusted: () => true,
  };
  let controller: AgentController | undefined;
  let parentChannel: StreamSupervisorChannel | undefined;
  const delivered: SupervisorActivityDelivery[] = [];
  const activator = createWjPiSubagentsRuntimeActivator({
    environment: childEnvironment(listener.endpoint),
    localSupervisorTransportAdapter: transportAdapter,
    templateFileSystem: {
      readDirectory: () => [],
      readFile: () => {
        throw new Error("unexpected template read");
      },
    },
    onController: (value) => {
      controller = value;
    },
  });

  const parentReady = (async () => {
    const transport = await listener.waitForConnection(AbortSignal.timeout(2_000));
    const channel = new StreamSupervisorChannel({
      role: "parent",
      rootId: ROOT_ID,
      localAgentId: null,
      peerAgentId: CHILD_ID,
      parentAgentId: null,
      depth: 1,
      credential: SUPERVISOR_CREDENTIAL,
      requestIdRegistry: new SupervisorRequestIdRegistry(),
      transport,
      onReply: () => true,
    });
    parentChannel = channel;
    channel.onActivity((activity) => delivered.push(activity));
    const signal = AbortSignal.timeout(2_000);
    await channel.bind(signal);
    await channel.waitForReady(signal);
  })();

  try {
    await activator(api as unknown as ExtensionApiSurface, {
      ok: true,
      nodeVersion: process.versions.node,
      piVersion: "1.2.0",
      platform: process.platform,
      processTreeAdapter: {} as never,
    } as AvailableHostCapabilities);
    await Promise.all([
      api.emit("session_start", { type: "session_start", reason: "startup" }, context),
      parentReady,
    ]);

    await api.emit("message_end", {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "先检查输入" },
          { type: "text", text: "开始处理" },
        ],
      },
    }, context);
    await api.emit("tool_execution_start", {
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "read",
      args: { path: "src/a.ts" },
    }, context);
    await api.emit("tool_execution_end", {
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "read",
      result: { lines: ["const a = 1;"] },
      isError: false,
    }, context);
    await waitForCount(delivered, 3);

    // 交付是规范条目：正文闭集保持，但身份由运行实例分配。
    assert.equal(delivered.length, 3);
    assert.deepEqual(delivered.map((delivery) => delivery.agent_id), [CHILD_ID, CHILD_ID, CHILD_ID]);
    assert.deepEqual(delivered[0]?.entry.body, {
      type: "message",
      content: [
        { type: "thinking", thinking: "先检查输入" },
        { type: "text", text: "开始处理" },
      ],
    });
    assert.equal(delivered[0]?.entry.agent_id, CHILD_ID);
    assert.match(delivered[0]?.entry.incarnation_id ?? "", /^[0-9a-f-]{36}$/u);
    assert.deepEqual(delivered[1]?.entry.body, {
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "read",
      origin: "unknown",
      executionGeneration: 1,
    });
    assert.deepEqual(delivered[2]?.entry.body, {
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "read",
      origin: "unknown",
      executionGeneration: 1,
      isError: false,
    });
    // 中间运行时不保存历史：本层回放为空。
    assert.deepEqual(controller?.getActivityReplay(CHILD_ID), []);
    assert.equal(controller?.getActivityRevision(CHILD_ID), 0);
  } finally {
    await api.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, context).catch(() => {});
    await parentChannel?.release().catch(() => {});
    await listener.close().catch(() => {});
  }
});

test("模型调用失败沿桥接归一化、监督通道、活动缓存贯通到面板折叠行", async () => {
  const transportAdapter = new InMemoryLocalSupervisorTransportAdapter();
  const listener = await transportAdapter.listen({
    agentId: CHILD_ID,
    credential: LOCAL_CREDENTIAL,
  });
  const api = new FakeExtensionApi();
  const context = {
    cwd: process.cwd(),
    mode: "print",
    hasUI: false,
    isProjectTrusted: () => true,
  };
  let parentChannel: StreamSupervisorChannel | undefined;
  const delivered: SupervisorActivityDelivery[] = [];
  const lifecycleEvents: unknown[] = [];
  const replies: unknown[] = [];
  const faults: unknown[] = [];
  const activator = createWjPiSubagentsRuntimeActivator({
    environment: childEnvironment(listener.endpoint),
    localSupervisorTransportAdapter: transportAdapter,
    templateFileSystem: {
      readDirectory: () => [],
      readFile: () => {
        throw new Error("unexpected template read");
      },
    },
  });

  const parentReady = (async () => {
    const transport = await listener.waitForConnection(AbortSignal.timeout(2_000));
    const channel = new StreamSupervisorChannel({
      role: "parent",
      rootId: ROOT_ID,
      localAgentId: null,
      peerAgentId: CHILD_ID,
      parentAgentId: null,
      depth: 1,
      credential: SUPERVISOR_CREDENTIAL,
      requestIdRegistry: new SupervisorRequestIdRegistry(),
      transport,
      onReply: (reply) => {
        replies.push(reply);
        return true;
      },
    });
    parentChannel = channel;
    channel.onActivity((activity) => delivered.push(activity));
    channel.onEvent((event) => lifecycleEvents.push(event));
    channel.onFault((fault) => faults.push(fault));
    const signal = AbortSignal.timeout(2_000);
    await channel.bind(signal);
    await channel.waitForReady(signal);
  })();

  try {
    await activator(api as unknown as ExtensionApiSurface, {
      ok: true,
      nodeVersion: process.versions.node,
      piVersion: "1.2.0",
      platform: process.platform,
      processTreeAdapter: {} as never,
    } as AvailableHostCapabilities);
    await Promise.all([
      api.emit("session_start", { type: "session_start", reason: "startup" }, context),
      parentReady,
    ]);
    const lifecycleBefore = lifecycleEvents.length;

    // 正文为空且以错误收尾的收尾消息：失败事实在桥接层采集并上行。
    await api.emit("message_end", {
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        stopReason: "error",
        errorMessage: "401 unauthorized\nx-request-id: abc",
      },
    }, context);
    await waitForCount(delivered, 1);

    assert.equal(delivered.length, 1);
    const delivery = delivered[0]!;
    assert.equal(delivery.agent_id, CHILD_ID);
    assert.match(delivery.entry.incarnation_id, /^[0-9a-f-]{36}$/u);
    // 条目一次定死四个字段：收尾原因、错误文本、provider 与 model。
    assert.deepEqual(delivery.entry.body, {
      type: "model_call_failure",
      failure: "error",
      message: "401 unauthorized\nx-request-id: abc",
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
    });

    // 顶层活动缓存 → 活动面板：折叠行显示错误文本首行。
    const cache = new AgentActivityCache();
    const recorded = cache.record(delivery.agent_id, delivery.entry);
    assert.equal(recorded.accepted, true);
    const viewer = new AgentActivityViewerModel({
      agent_id: CHILD_ID,
      template_id: "worker",
      name: "worker-a",
      state: "working",
    }, cache.replay(CHILD_ID), { viewport_height: 20 });
    assert.deepEqual(
      viewer.render(160).slice(1, -1).filter((line) => line.length > 0),
      ["▸ × Error: 401 unauthorized"],
    );
    // 展开体：首行 provider · model，其后为逐字保留换行的错误原文。
    assert.equal(viewer.handleInput("\r"), "changed");
    assert.deepEqual(
      viewer.render(160).slice(1, -1).filter((line) => line.length > 0),
      [
        "▾ × Error: 401 unauthorized",
        "│ anthropic · claude-sonnet-4-20250514",
        "│ 401 unauthorized",
        "│ x-request-id: abc",
      ],
    );

    // 采集面边界：已中止与错误同形；错误文本缺失用兜底文案；正文非空的
    // 失败消息产生正文与失败两条；同一回合多次失败各自成条；静默上下文
    // 溢出（长度收尾且零输出）与自动重试事件不产生任何条目。
    const assistantEnd = (
      message: Record<string, unknown>,
    ): Promise<void> => api.emit("message_end", { type: "message_end", message }, context);
    const providerAndModel = {
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
    };
    // 已中止收尾且无错误文本：同样登记，文本落到 Pi 的兜底文案。
    await assistantEnd({ role: "assistant", content: [], ...providerAndModel, stopReason: "aborted" });
    // 正文非空的失败消息：正文条目在前、失败条目在后。
    await assistantEnd({
      role: "assistant",
      content: [{ type: "text", text: "半句输出" }],
      ...providerAndModel,
      stopReason: "error",
      errorMessage: "429 too many requests",
    });
    // 无错误文本的静默溢出与自动重试事件都不登记。
    await assistantEnd({ role: "assistant", content: [], ...providerAndModel, stopReason: "length" });
    await api.emit("auto_retry_start", {
      type: "auto_retry_start",
      attempt: 2,
      maxAttempts: 3,
      delayMs: 1_000,
      errorMessage: "rate limited",
    }, context);
    // 同一回合的第二次失败：重试后被救回的失败尝试仍留在面板上。
    await assistantEnd({
      role: "assistant",
      content: [],
      ...providerAndModel,
      stopReason: "error",
      errorMessage: "503 service unavailable",
    });
    await assistantEnd({
      role: "assistant",
      content: [{ type: "text", text: "最终回复" }],
      ...providerAndModel,
      stopReason: "stop",
    });
    await waitForCount(delivered, 6);

    assert.deepEqual(delivered.map((item) => item.entry.body), [
      {
        type: "model_call_failure",
        failure: "error",
        message: "401 unauthorized\nx-request-id: abc",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
      },
      {
        type: "model_call_failure",
        failure: "aborted",
        message: "Unknown error",
        ...providerAndModel,
      },
      { type: "message", content: [{ type: "text", text: "半句输出" }] },
      {
        type: "model_call_failure",
        failure: "error",
        message: "429 too many requests",
        ...providerAndModel,
      },
      {
        type: "model_call_failure",
        failure: "error",
        message: "503 service unavailable",
        ...providerAndModel,
      },
      { type: "message", content: [{ type: "text", text: "最终回复" }] },
    ]);
    assert.equal(new Set(delivered.map((item) => item.entry.entry_id)).size, delivered.length);

    // 全部条目按到达顺序进入同一面板：三次失败各自成条，兜底文案可见。
    const allCache = new AgentActivityCache();
    for (const item of delivered) allCache.record(item.agent_id, item.entry);
    const allViewer = new AgentActivityViewerModel({
      agent_id: CHILD_ID,
      template_id: "worker",
      name: "worker-a",
      state: "working",
    }, allCache.replay(CHILD_ID), { viewport_height: 20 });
    const rendered = allViewer.render(160).slice(1, -1).filter((line) => line.length > 0);
    assert.deepEqual(
      rendered.filter((line) => line.includes("Error:")),
      [
        "▸ × Error: 401 unauthorized",
        "▸ × Error: Unknown error",
        "▸ × Error: 429 too many requests",
        "▸ × Error: 503 service unavailable",
      ],
    );

    // 版本一致时活动链路不被判为无效帧，也不触发生命周期转换。
    assert.deepEqual(faults, []);
    assert.equal(lifecycleEvents.length, lifecycleBefore);
    // 失败条目只走活动流：不产生任何发往父代理的回复或报告事件。
    assert.deepEqual(replies, []);
  } finally {
    await api.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, context).catch(() => {});
    await parentChannel?.release().catch(() => {});
    await listener.close().catch(() => {});
  }
});

test("压缩自身失败沿产生端订阅登记为无身份失败条目，压缩重试事件不产生任何条目", async () => {
  const transportAdapter = new InMemoryLocalSupervisorTransportAdapter();
  const listener = await transportAdapter.listen({
    agentId: CHILD_ID,
    credential: LOCAL_CREDENTIAL,
  });
  const api = new FakeExtensionApi();
  const context = {
    cwd: process.cwd(),
    mode: "print",
    hasUI: false,
    isProjectTrusted: () => true,
  };
  let parentChannel: StreamSupervisorChannel | undefined;
  const delivered: SupervisorActivityDelivery[] = [];
  const lifecycleEvents: unknown[] = [];
  const replies: unknown[] = [];
  const faults: unknown[] = [];
  const activator = createWjPiSubagentsRuntimeActivator({
    environment: childEnvironment(listener.endpoint),
    localSupervisorTransportAdapter: transportAdapter,
    templateFileSystem: {
      readDirectory: () => [],
      readFile: () => {
        throw new Error("unexpected template read");
      },
    },
  });

  const parentReady = (async () => {
    const transport = await listener.waitForConnection(AbortSignal.timeout(2_000));
    const channel = new StreamSupervisorChannel({
      role: "parent",
      rootId: ROOT_ID,
      localAgentId: null,
      peerAgentId: CHILD_ID,
      parentAgentId: null,
      depth: 1,
      credential: SUPERVISOR_CREDENTIAL,
      requestIdRegistry: new SupervisorRequestIdRegistry(),
      transport,
      onReply: (reply) => {
        replies.push(reply);
        return true;
      },
    });
    parentChannel = channel;
    channel.onActivity((activity) => delivered.push(activity));
    channel.onEvent((event) => lifecycleEvents.push(event));
    channel.onFault((fault) => faults.push(fault));
    const signal = AbortSignal.timeout(2_000);
    await channel.bind(signal);
    await channel.waitForReady(signal);
  })();

  try {
    await activator(api as unknown as ExtensionApiSurface, {
      ok: true,
      nodeVersion: process.versions.node,
      piVersion: "1.2.0",
      platform: process.platform,
      processTreeAdapter: {} as never,
    } as AvailableHostCapabilities);
    await Promise.all([
      api.emit("session_start", { type: "session_start", reason: "startup" }, context),
      parentReady,
    ]);
    const lifecycleBefore = lifecycleEvents.length;

    // 压缩自身（summarization 调用）失败：事实只在产生端可见，不携带发起它的
    // provider/model。压缩重试事件与自动重试事件一样不订阅也不采集。
    await api.emit("session_compact_failed", {
      type: "session_compact_failed",
      reason: "overflow",
      errorMessage: "summarization request failed\nline2",
      aborted: false,
      willRetry: true,
      fromExtension: false,
    }, context);
    await api.emit("summarization_retry_scheduled", {
      type: "summarization_retry_scheduled",
      attempt: 2,
      maxAttempts: 3,
      delayMs: 1_000,
    }, context);
    await api.emit("summarization_retry_attempt_start", {
      type: "summarization_retry_attempt_start",
      attempt: 2,
    }, context);
    await api.emit("summarization_retry_finished", {
      type: "summarization_retry_finished",
      attempt: 2,
      success: false,
    }, context);
    await api.emit("auto_retry_start", {
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 2,
      delayMs: 100,
      errorMessage: "rate limited",
    }, context);
    await waitForCount(delivered, 1);

    assert.equal(delivered.length, 1);
    const delivery = delivered[0]!;
    assert.equal(delivery.agent_id, CHILD_ID);
    // 条目仍完整成立：收尾原因与错误文本在场，身份整个缺失。
    assert.deepEqual(delivery.entry.body, {
      type: "model_call_failure",
      failure: "error",
      message: "summarization request failed\nline2",
    });

    // 顶层活动缓存 → 活动面板：折叠行不变，展开体直接以错误原文开头。
    const cache = new AgentActivityCache();
    const recorded = cache.record(delivery.agent_id, delivery.entry);
    assert.equal(recorded.accepted, true);
    const viewer = new AgentActivityViewerModel({
      agent_id: CHILD_ID,
      template_id: "worker",
      name: "worker-a",
      state: "working",
    }, cache.replay(CHILD_ID), { viewport_height: 20 });
    assert.deepEqual(
      viewer.render(160).slice(1, -1).filter((line) => line.length > 0),
      ["▸ × Error: summarization request failed"],
    );
    assert.equal(viewer.handleInput("\r"), "changed");
    assert.deepEqual(
      viewer.render(160).slice(1, -1).filter((line) => line.length > 0).map((line) => line.trimEnd()),
      [
        "▾ × Error: summarization request failed",
        "│ summarization request failed",
        "│ line2",
      ],
    );

    // 被中止的压缩失败同形登记，只有收尾原因如实不同；文本缺失用兜底文案。
    await api.emit("session_compact_failed", {
      type: "session_compact_failed",
      reason: "threshold",
      aborted: true,
      willRetry: false,
      fromExtension: false,
    }, context);
    await waitForCount(delivered, 2);
    assert.deepEqual(delivered[1]?.entry.body, {
      type: "model_call_failure",
      failure: "aborted",
      message: "Unknown error",
    });
    assert.equal(new Set(delivered.map((item) => item.entry.entry_id)).size, delivered.length);

    // 版本一致时活动链路不被判为无效帧，也不触发生命周期转换或父代理回复。
    assert.deepEqual(faults, []);
    assert.equal(lifecycleEvents.length, lifecycleBefore);
    assert.deepEqual(replies, []);
  } finally {
    await api.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, context).catch(() => {});
    await parentChannel?.release().catch(() => {});
    await listener.close().catch(() => {});
  }
});

test("子模式扩展跨实例 reload 后恢复 display source generation 并轮换活动身份", async () => {
  const transportAdapter = new InMemoryLocalSupervisorTransportAdapter();
  const listener = await transportAdapter.listen({
    agentId: CHILD_ID,
    credential: LOCAL_CREDENTIAL,
  });
  const reloadEventBus = new FakeReloadEventBus();
  const api = new FakeExtensionApi(reloadEventBus);
  let activeApi = api;
  const context = {
    cwd: process.cwd(),
    mode: "print",
    hasUI: false,
    isProjectTrusted: () => true,
  };
  const hostCapabilities = {
    ok: true,
    nodeVersion: process.versions.node,
    piVersion: "1.2.0",
    platform: process.platform,
    processTreeAdapter: {} as never,
  } as AvailableHostCapabilities;
  let parentChannel: StreamSupervisorChannel | undefined;
  const delivered: SupervisorActivityDelivery[] = [];
  const displays: SupervisorDisplayDelivery[] = [];
  const activator = createWjPiSubagentsRuntimeActivator({
    environment: childEnvironment(listener.endpoint),
    localSupervisorTransportAdapter: transportAdapter,
    templateFileSystem: {
      readDirectory: () => [],
      readFile: () => {
        throw new Error("unexpected template read");
      },
    },
  });
  const parentReady = (async () => {
    const transport = await listener.waitForConnection(AbortSignal.timeout(2_000));
    const channel = new StreamSupervisorChannel({
      role: "parent",
      rootId: ROOT_ID,
      localAgentId: null,
      peerAgentId: CHILD_ID,
      parentAgentId: null,
      depth: 1,
      credential: SUPERVISOR_CREDENTIAL,
      requestIdRegistry: new SupervisorRequestIdRegistry(),
      transport,
      onReply: () => true,
    });
    parentChannel = channel;
    channel.onActivity((activity) => delivered.push(activity));
    channel.onDisplay((display) => displays.push(display));
    const signal = AbortSignal.timeout(2_000);
    await channel.bind(signal);
    await channel.waitForReady(signal);
  })();

  try {
    await activator(api as unknown as ExtensionApiSurface, hostCapabilities);
    await Promise.all([
      api.emit("session_start", { type: "session_start", reason: "startup" }, context),
      parentReady,
    ]);

    await api.emit("message_start", {
      type: "message_start",
      message: { role: "assistant", content: [] },
    }, context);
    await api.emit("message_update", {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "reload 前草稿" },
    }, context);
    await waitForMatch(displays, (display) =>
      display.event.type === "message_delta" && display.event.delta === "reload 前草稿");
    const beforeDisplay = displays.find((display) =>
      display.event.type === "message_delta" && display.event.delta === "reload 前草稿");
    assert.equal(beforeDisplay?.event.type === "message_delta"
      ? beforeDisplay.event.displaySourceGeneration
      : undefined, 1);

    await api.emit("tool_execution_start", {
      type: "tool_execution_start",
      toolCallId: "reused-call",
      toolName: "read",
      args: { path: "before-reload.ts" },
    }, context);
    await waitForCount(delivered, 1);
    const before = delivered[0]?.entry;
    assert.ok(before);

    await api.emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, context);
    const reloadedApi = new FakeExtensionApi(reloadEventBus);
    await activator(reloadedApi as unknown as ExtensionApiSurface, hostCapabilities);
    activeApi = reloadedApi;
    await reloadedApi.emit("session_start", { type: "session_start", reason: "reload" }, context);
    await waitForMatch(displays, (display) =>
      display.event.type === "display_reset" && display.event.displaySourceGeneration === 2);
    await reloadedApi.emit("message_start", {
      type: "message_start",
      message: { role: "assistant", content: [] },
    }, context);
    await reloadedApi.emit("message_update", {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "reload 后草稿" },
    }, context);
    await waitForMatch(displays, (display) =>
      display.event.type === "message_delta" && display.event.delta === "reload 后草稿");
    const afterDisplay = displays.find((display) =>
      display.event.type === "message_delta" && display.event.delta === "reload 后草稿");
    assert.equal(afterDisplay?.event.type === "message_delta"
      ? afterDisplay.event.displaySourceGeneration
      : undefined, 2);
    assert.equal(afterDisplay?.event.type === "message_delta"
      ? afterDisplay.event.streamOrdinal
      : undefined, 1);

    await reloadedApi.emit("tool_execution_start", {
      type: "tool_execution_start",
      toolCallId: "reused-call",
      toolName: "read",
      args: { path: "after-reload.ts" },
    }, context);
    await waitForCount(delivered, 2);
    const after = delivered[1]?.entry;
    assert.ok(after);

    assert.notEqual(after.incarnation_id, before.incarnation_id);
    assert.deepEqual(before.body, {
      type: "tool_execution_start",
      toolCallId: "reused-call",
      toolName: "read",
      origin: "unknown",
      executionGeneration: 1,
    });
    assert.deepEqual(after.body, {
      type: "tool_execution_start",
      toolCallId: "reused-call",
      toolName: "read",
      origin: "unknown",
      executionGeneration: 1,
    });
  } finally {
    await activeApi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, context).catch(() => {});
    await parentChannel?.release().catch(() => {});
    await listener.close().catch(() => {});
  }
});

test("子运行时 input handler 只在 rpc steer 上唤醒且绝不抛错", async () => {
  const transportAdapter = new InMemoryLocalSupervisorTransportAdapter();
  const listener = await transportAdapter.listen({
    agentId: CHILD_ID,
    credential: LOCAL_CREDENTIAL,
  });
  const api = new FakeExtensionApi();
  const context = {
    cwd: process.cwd(),
    mode: "print",
    hasUI: false,
    isProjectTrusted: () => true,
  };
  const hostCapabilities = {
    ok: true,
    nodeVersion: process.versions.node,
    piVersion: "1.2.0",
    platform: process.platform,
    processTreeAdapter: {} as never,
  } as AvailableHostCapabilities;
  let controller: AgentController | undefined;
  let parentChannel: StreamSupervisorChannel | undefined;
  const activator = createWjPiSubagentsRuntimeActivator({
    environment: childEnvironment(listener.endpoint),
    localSupervisorTransportAdapter: transportAdapter,
    templateFileSystem: {
      readDirectory: () => [],
      readFile: () => {
        throw new Error("unexpected template read");
      },
    },
    onController: (value) => {
      controller = value;
    },
  });
  const parentReady = (async () => {
    const transport = await listener.waitForConnection(AbortSignal.timeout(2_000));
    const channel = new StreamSupervisorChannel({
      role: "parent",
      rootId: ROOT_ID,
      localAgentId: null,
      peerAgentId: CHILD_ID,
      parentAgentId: null,
      depth: 1,
      credential: SUPERVISOR_CREDENTIAL,
      requestIdRegistry: new SupervisorRequestIdRegistry(),
      transport,
      onReply: () => true,
    });
    parentChannel = channel;
    const signal = AbortSignal.timeout(2_000);
    await channel.bind(signal);
    await channel.waitForReady(signal);
  })();

  try {
    await activator(api as unknown as ExtensionApiSurface, hostCapabilities);
    // session_start 之前 controller 未就绪：input 必须静默 no-op。
    await api.emit("input", { type: "input", source: "rpc", streamingBehavior: "steer" }, context);
    await Promise.all([
      api.emit("session_start", { type: "session_start", reason: "startup" }, context),
      parentReady,
    ]);
    assert.ok(controller);

    let wakeCount = 0;
    const live = controller;
    live.wakeWaitersForParentInput = () => {
      wakeCount += 1;
    };

    for (const event of [
      { type: "input", source: "interactive", streamingBehavior: "steer" },
      { type: "input", source: "rpc" },
      { type: "input", source: "rpc", streamingBehavior: "follow_up" },
      { type: "input", source: "extension", streamingBehavior: "steer" },
    ]) {
      await api.emit("input", event, context);
    }
    assert.equal(wakeCount, 0);

    await api.emit("input", { type: "input", source: "rpc", streamingBehavior: "steer" }, context);
    assert.equal(wakeCount, 1);

    // 唤醒异常必须被整体吞掉：handler 不冒泡，也不影响后续事件。
    live.wakeWaitersForParentInput = () => {
      throw new Error("wake failed");
    };
    await api.emit("input", { type: "input", source: "rpc", streamingBehavior: "steer" }, context);
    await api.emit("turn_start", { type: "turn_start" }, context);
  } finally {
    await api.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, context).catch(() => {});
    await parentChannel?.release().catch(() => {});
    await listener.close().catch(() => {});
  }
});

test("根运行时 input handler 不因 rpc steer 唤醒父消息 waiter", async () => {
  const api = new FakeExtensionApi();
  const context = {
    cwd: process.cwd(),
    mode: "print",
    hasUI: false,
    isProjectTrusted: () => true,
  };
  const hostCapabilities = {
    ok: true,
    nodeVersion: process.versions.node,
    piVersion: "1.2.0",
    platform: process.platform,
    processTreeAdapter: {} as never,
  } as AvailableHostCapabilities;
  let controller: AgentController | undefined;
  const activator = createWjPiSubagentsRuntimeActivator({
    environment: {},
    rootIdFactory: () => "root-input-handler-scope",
    templateFileSystem: {
      readDirectory: () => [],
      readFile: () => {
        throw new Error("unexpected template read");
      },
    },
    onController: (value) => {
      controller = value;
    },
  });

  try {
    await activator(api as unknown as ExtensionApiSurface, hostCapabilities);
    await api.emit("session_start", { type: "session_start", reason: "startup" }, context);
    assert.ok(controller);

    let wakeCount = 0;
    const live = controller;
    live.wakeWaitersForParentInput = () => {
      wakeCount += 1;
    };

    // 根会话没有父代理：即使命中 rpc steer，也不得产生 parent_input 唤醒。
    await api.emit("input", { type: "input", source: "rpc", streamingBehavior: "steer" }, context);
    assert.equal(wakeCount, 0);
  } finally {
    await api.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, context).catch(() => {});
  }
});

test("handoff pending 期间 rpc steer 输入不唤醒 waiter", async () => {
  const transportAdapter = new InMemoryLocalSupervisorTransportAdapter();
  const listener = await transportAdapter.listen({
    agentId: CHILD_ID,
    credential: LOCAL_CREDENTIAL,
  });
  // reload 交接只在存在 EventBus 时建立；同一扩展实例随后可在 reload 后接管旧树。
  const reloadEventBus = new FakeReloadEventBus();
  const api = new FakeExtensionApi(reloadEventBus);
  const context = {
    cwd: process.cwd(),
    mode: "print",
    hasUI: false,
    isProjectTrusted: () => true,
  };
  const hostCapabilities = {
    ok: true,
    nodeVersion: process.versions.node,
    piVersion: "1.2.0",
    platform: process.platform,
    processTreeAdapter: {} as never,
  } as AvailableHostCapabilities;
  let controller: AgentController | undefined;
  let parentChannel: StreamSupervisorChannel | undefined;
  const activator = createWjPiSubagentsRuntimeActivator({
    environment: childEnvironment(listener.endpoint),
    localSupervisorTransportAdapter: transportAdapter,
    templateFileSystem: {
      readDirectory: () => [],
      readFile: () => {
        throw new Error("unexpected template read");
      },
    },
    onController: (value) => {
      controller = value;
    },
  });
  const parentReady = (async () => {
    const transport = await listener.waitForConnection(AbortSignal.timeout(2_000));
    const channel = new StreamSupervisorChannel({
      role: "parent",
      rootId: ROOT_ID,
      localAgentId: null,
      peerAgentId: CHILD_ID,
      parentAgentId: null,
      depth: 1,
      credential: SUPERVISOR_CREDENTIAL,
      requestIdRegistry: new SupervisorRequestIdRegistry(),
      transport,
      onReply: () => true,
    });
    parentChannel = channel;
    const signal = AbortSignal.timeout(2_000);
    await channel.bind(signal);
    await channel.waitForReady(signal);
  })();

  try {
    await activator(api as unknown as ExtensionApiSurface, hostCapabilities);
    await Promise.all([
      api.emit("session_start", { type: "session_start", reason: "startup" }, context),
      parentReady,
    ]);
    assert.ok(controller);

    let wakeCount = 0;
    const live = controller;
    live.wakeWaitersForParentInput = () => {
      wakeCount += 1;
    };

    // 对照：正常状态下 rpc steer 会唤醒。
    await api.emit("input", { type: "input", source: "rpc", streamingBehavior: "steer" }, context);
    assert.equal(wakeCount, 1);

    await api.emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, context);
    // handoff 交接走工具隐藏而非正常清树；这个事实同时证明 handoffPending 已置位。
    assert.equal(api.getActiveTools().includes("wait_agent"), false);

    await api.emit("input", { type: "input", source: "rpc", streamingBehavior: "steer" }, context);
    assert.equal(wakeCount, 1);
  } finally {
    // quit 会 cancelHandoff，避免 reload lease 泄漏。
    await api.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, context).catch(() => {});
    await parentChannel?.release().catch(() => {});
    await listener.close().catch(() => {});
  }
});

test("子运行时协议版本与代码常量不一致时 session_start 被拒", async () => {
  const api = new FakeExtensionApi();
  const context = {
    cwd: process.cwd(),
    mode: "print",
    hasUI: false,
    isProjectTrusted: () => true,
  };
  const hostCapabilities = {
    ok: true,
    nodeVersion: process.versions.node,
    piVersion: "1.2.0",
    platform: process.platform,
    processTreeAdapter: {} as never,
  } as AvailableHostCapabilities;
  const environment = {
    ...childEnvironment("unused-endpoint"),
    [RUNTIME_INTERNAL_ENV_KEYS.protocolVersion]: "wj-pi-subagents/0",
  };
  const activator = createWjPiSubagentsRuntimeActivator({
    environment,
    templateFileSystem: {
      readDirectory: () => [],
      readFile: () => {
        throw new Error("unexpected template read");
      },
    },
  });

  await activator(api as unknown as ExtensionApiSurface, hostCapabilities);
  // 身份元数据不完整不能被静默降级成根会话：必须稳定拒绝启动。
  await assert.rejects(
    api.emit("session_start", { type: "session_start", reason: "startup" }, context),
    { message: "子运行时身份元数据无效" },
  );
});
