import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  FakeManagedRpcNode,
  MANAGED_RPC_BRIDGE_CREDENTIAL_ENV,
  ManagedRpcBridgeClient,
  ManagedRpcCommandRejectedError,
  ManagedRpcStartupError,
  type ManagedRpcNodeLike,
  type ManagedRpcNodeStartContext,
  type ManagedRpcStartupDiagnostic,
} from "../src/managed-rpc-node.ts";
import { ManagedRpcSupervisorChannel } from "../src/managed-rpc-supervisor-channel.ts";
import {
  RpcSupervisor,
  type RpcSupervisorChannel,
  type RpcSupervisorChannelCloseState,
  type RpcSupervisorChannelFault,
} from "../src/rpc-supervisor.ts";
import {
  controlFailure,
  ROOT_TREE_ACTOR,
  TreeController,
} from "../src/tree-controller.ts";
import {
  SupervisorRequestIdRegistry,
  type SupervisorReply,
} from "../src/supervisor-channel.ts";
import { RUNTIME_INTERNAL_ENV_KEYS } from "../src/root-runtime-context.ts";
import {
  classifyPiStartupError,
  extensionDiagnosticLabelFromSource,
} from "../src/startup-diagnostic.ts";
import { parseAgentSnapshot } from "../src/agent-snapshot-codec.ts";
import { SubagentToolError } from "../src/agent-tools.ts";

const BRIDGE_CREDENTIAL = "startup-diagnostic-test-credential-0001";
const SUPERVISOR_CREDENTIAL = "startup-supervisor-test-credential-0001";
const AGENT_ID = "550e8400-e29b-41d4-a716-446655440000";
const ROOT_ID = "startup-diagnostic-root";

class StartupFailureNode extends FakeManagedRpcNode {
  override async start(): Promise<void> {
    throw new ManagedRpcStartupError({
      code: "provider_unavailable",
      details: { provider: "wj-provider" },
    });
  }
}

class GenericStartupFailureNode extends FakeManagedRpcNode {
  override async start(): Promise<void> {
    throw new Error("未分类启动失败");
  }
}

class HangingStateNode extends FakeManagedRpcNode {
  override getState(): Promise<unknown> {
    return new Promise<unknown>(() => {});
  }
}

class StartupTestChannel implements RpcSupervisorChannel {
  private readonly startupFault: RpcSupervisorChannelFault | undefined;
  private faultListener: ((fault: RpcSupervisorChannelFault) => void) | undefined;

  constructor(startupFault?: RpcSupervisorChannelFault) {
    this.startupFault = startupFault;
  }

  async bind(): Promise<void> {}
  async waitForReady(): Promise<void> { if (this.startupFault !== undefined) this.faultListener?.(this.startupFault); }
  isReady(): boolean { return true; }
  async publishReply(_reply: SupervisorReply): Promise<void> {}
  establishTerminationBarrier(): void {}
  async requestClose(): Promise<void> {}
  async waitForClose(): Promise<RpcSupervisorChannelCloseState> { return "released"; }
  async release(): Promise<void> {}
  onFault(listener: (fault: RpcSupervisorChannelFault) => void): () => void {
    this.faultListener = listener;
    return () => { if (this.faultListener === listener) this.faultListener = undefined; };
  }
}

function startBridge(
  model: string,
  args: readonly string[] = [],
  piModulePath = new URL("./helpers/failing-pi-rpc-client.mjs", import.meta.url).href,
): {
  readonly process: ChildProcessWithoutNullStreams;
  readonly client: ManagedRpcBridgeClient;
} {
  const bridge = spawn(process.execPath, [
    "--experimental-strip-types",
    fileURLToPath(new URL("../src/rpc-bridge-process.ts", import.meta.url)),
  ], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      [MANAGED_RPC_BRIDGE_CREDENTIAL_ENV]: BRIDGE_CREDENTIAL,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = new ManagedRpcBridgeClient({
    stdin: bridge.stdin,
    stdout: bridge.stdout,
    stderr: bridge.stderr,
  }, {
    credential: BRIDGE_CREDENTIAL,
    rpcOptions: {
      piModulePath,
      provider: "wj-provider",
      model,
      args,
    },
  });
  return { process: bridge, client };
}

function startSupervisedBridge(): {
  readonly process: ChildProcessWithoutNullStreams;
  readonly client: ManagedRpcBridgeClient;
  readonly context: ManagedRpcNodeStartContext;
} {
  const bridge = spawn(process.execPath, [
    "--experimental-strip-types",
    fileURLToPath(new URL("../src/rpc-bridge-process.ts", import.meta.url)),
  ], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      [MANAGED_RPC_BRIDGE_CREDENTIAL_ENV]: BRIDGE_CREDENTIAL,
      [RUNTIME_INTERNAL_ENV_KEYS.rootId]: ROOT_ID,
      [RUNTIME_INTERNAL_ENV_KEYS.parentAgentId]: "",
      [RUNTIME_INTERNAL_ENV_KEYS.agentId]: AGENT_ID,
      [RUNTIME_INTERNAL_ENV_KEYS.depth]: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = new ManagedRpcBridgeClient({
    stdin: bridge.stdin,
    stdout: bridge.stdout,
    stderr: bridge.stderr,
  }, {
    credential: BRIDGE_CREDENTIAL,
    rpcOptions: {
      piModulePath: new URL("./helpers/fake-pi-rpc-client.mjs", import.meta.url).href,
    },
  });
  const context: ManagedRpcNodeStartContext = Object.freeze({
    supervisor: Object.freeze({
      root_id: ROOT_ID,
      local_agent_id: AGENT_ID,
      peer_agent_id: "",
      parent_agent_id: null,
      depth: 1,
      credential: SUPERVISOR_CREDENTIAL,
      initial_snapshot: Object.freeze([Object.freeze({
        agent_id: AGENT_ID,
        parent_agent_id: null,
        template_id: "researcher",
        name: "生产桥接 fake 子端点",
        depth: 1,
        state: "starting" as const,
        revision: 1,
      })]),
      initial_subtree_revision: 1,
    }),
  });
  return { process: bridge, client, context };
}

async function closeBridge(
  bridge: ChildProcessWithoutNullStreams,
  client: ManagedRpcBridgeClient,
): Promise<void> {
  try {
    if (bridge.exitCode === null) {
      const abort = AbortSignal.timeout(2_000);
      await client.requestClose(abort).catch(() => {});
    }
  } finally {
    await client.release().catch(() => {});
    if (bridge.exitCode === null) bridge.kill();
  }
}

test("bridge 保留 prompt 和 abort 错误响应中的 compaction_active 原因", async () => {
  const { process: bridge, client } = startBridge(
    "unused",
    [],
    new URL("./helpers/rejecting-pi-rpc-client.mjs", import.meta.url).href,
  );
  try {
    await client.start();
    await assert.rejects(
      client.prompt("压缩期间 prompt"),
      (error: unknown) => error instanceof ManagedRpcCommandRejectedError
        && error.reason === "compaction_active",
    );
    await assert.rejects(
      client.abort(),
      (error: unknown) => error instanceof ManagedRpcCommandRejectedError
        && error.reason === "compaction_active",
    );
  } finally {
    await closeBridge(bridge, client);
  }
});

test("正常子端的状态探针不会与监督握手互相等待", async () => {
  const { process: bridge, client, context } = startSupervisedBridge();
  const channel = new ManagedRpcSupervisorChannel({
    node: client as unknown as ManagedRpcNodeLike,
    rootId: ROOT_ID,
    localAgentId: null,
    peerAgentId: AGENT_ID,
    parentAgentId: null,
    depth: 1,
    credential: SUPERVISOR_CREDENTIAL,
    requestIdRegistry: new SupervisorRequestIdRegistry(),
  });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 1_000);
  try {
    await channel.bind(abort.signal);
    await Promise.all([
      client.start(abort.signal, context),
      channel.waitForReady(abort.signal),
    ]);
    assert.equal(channel.isReady(), true);
    const state = await client.getState() as { readonly supervisor?: { readonly state?: string } };
    assert.equal(state.supervisor?.state, "ready");
  } finally {
    clearTimeout(timer);
    await channel.release().catch(() => {});
    await closeBridge(bridge, client);
  }
});

test("未知 provider 在 bridge 启动阶段立即返回安全诊断", async () => {
  const { process: bridge, client } = startBridge("provider-failure");
  try {
    await assert.rejects(
      client.start(),
      (error: unknown) => {
        if (!(error instanceof Error)) return false;
        const candidate = error as Error & {
          readonly code?: string;
          readonly details?: Readonly<Record<string, string>>;
        };
        assert.equal(candidate.name, "ManagedRpcStartupError");
        assert.equal(candidate.code, "provider_unavailable");
        assert.deepEqual(candidate.details, { provider: "wj-provider" });
        assert.equal(candidate.message.includes("Unknown provider"), false);
        return true;
      },
    );
  } finally {
    await closeBridge(bridge, client);
  }
});

test("不可用 model 在 bridge 启动阶段返回 provider 和 model 诊断", async () => {
  const { process: bridge, client } = startBridge("model-failure");
  try {
    await assert.rejects(
      client.start(),
      (error: unknown) => {
        if (!(error instanceof Error)) return false;
        const candidate = error as Error & {
          readonly code?: string;
          readonly details?: Readonly<Record<string, string>>;
        };
        assert.equal(candidate.name, "ManagedRpcStartupError");
        assert.equal(candidate.code, "model_unavailable");
        assert.deepEqual(candidate.details, {
          provider: "wj-provider",
          model: "model-failure",
        });
        assert.equal(candidate.message.includes("missing-model"), false);
        return true;
      },
    );
  } finally {
    await closeBridge(bridge, client);
  }
});

test("扩展加载失败只返回安全扩展标签，不泄露路径或原始 stderr", async () => {
  const extensionPath = "C:\\Users\\robot\\private\\bad-extension.ts";
  const { process: bridge, client } = startBridge("extension-failure", ["-e", extensionPath]);
  try {
    await assert.rejects(
      client.start(),
      (error: unknown) => {
        if (!(error instanceof Error)) return false;
        const candidate = error as Error & {
          readonly code?: string;
          readonly details?: Readonly<Record<string, string>>;
        };
        assert.equal(candidate.name, "ManagedRpcStartupError");
        assert.equal(candidate.code, "extension_load_failed");
        assert.deepEqual(candidate.details, { extension: "bad-extension.ts" });
        assert.equal(JSON.stringify(candidate).includes("Users"), false);
        assert.equal(candidate.message.includes("TOP_SECRET_EXTENSION_DETAIL"), false);
        return true;
      },
    );
  } finally {
    await closeBridge(bridge, client);
  }
});

test("监督器保留已分类启动错误并完成资源回滚", async () => {
  const tree = new TreeController({
    config: {
      maxDepth: 2,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 8,
      waitTimeoutMs: 10_000,
    },
    idFactory: () => AGENT_ID,
  });
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "browser", name: "启动诊断" },
    managedNode: new StartupFailureNode(),
    channel: new StartupTestChannel(),
    startupTimeoutMs: 1_000,
    gracefulShutdownMs: 50,
  });

  const result = await supervisor.start();
  assert.deepEqual(result, {
    ok: false,
    agent_id: AGENT_ID,
    code: "provider_unavailable",
    details: { provider: "wj-provider" },
    cleanup: "confirmed",
  });
  const status = tree.getStatus(AGENT_ID);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal(status.data.state, "failed");
    assert.deepEqual(status.data.error?.details, { provider: "wj-provider" });
  }
});

test("启动阶段协议故障归为 protocol_mismatch，而不是通用 spawn_failed", async () => {
  const tree = new TreeController({
    config: {
      maxDepth: 2,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 8,
      waitTimeoutMs: 10_000,
    },
    idFactory: () => AGENT_ID,
  });
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "browser", name: "协议故障" },
    managedNode: new FakeManagedRpcNode(),
    channel: new StartupTestChannel("protocol_fault"),
    startupTimeoutMs: 1_000,
    gracefulShutdownMs: 50,
  });

  const result = await supervisor.start();
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "protocol_mismatch");
});

test("工具错误保留规范启动 details，忽略伪造消息和敏感附加字段", () => {
  const failure = controlFailure("provider_unavailable", {
    provider: "wj-provider",
    path: "C:\\Users\\robot\\private\\provider.ts",
  });
  const error = new SubagentToolError({
    ...failure.error,
    message: "TOP_SECRET_FORGED_MESSAGE",
  });
  const parsed = JSON.parse(error.message) as {
    readonly error: {
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
      readonly details: Readonly<Record<string, string>>;
    };
  };

  assert.deepEqual(parsed, {
    ok: false,
    error: {
      code: "provider_unavailable",
      message: "Subagent model provider is unavailable",
      retryable: false,
      details: { provider: "wj-provider" },
    },
  });
  assert.equal(error.message.includes("TOP_SECRET"), false);
  assert.equal(error.message.includes("Users"), false);
});

test("未分类的启动异常保持 spawn_failed", async () => {
  const tree = new TreeController({
    config: {
      maxDepth: 2,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 8,
      waitTimeoutMs: 10_000,
    },
    idFactory: () => AGENT_ID,
  });
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "browser", name: "未分类故障" },
    managedNode: new GenericStartupFailureNode(),
    channel: new StartupTestChannel(),
    startupTimeoutMs: 1_000,
    gracefulShutdownMs: 50,
  });

  const result = await supervisor.start();
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "spawn_failed");
});

test("启动阶段没有故障而持续无响应时保持 spawn_timeout", async () => {
  const tree = new TreeController({
    config: {
      maxDepth: 2,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 8,
      waitTimeoutMs: 10_000,
    },
    idFactory: () => AGENT_ID,
  });
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "browser", name: "启动超时" },
    managedNode: new HangingStateNode(),
    channel: new StartupTestChannel(),
    startupTimeoutMs: 20,
    gracefulShutdownMs: 50,
  });

  const result = await supervisor.start();
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "spawn_timeout");
});

test("启动诊断标签不会公开 Git、URI、凭据或原始扩展来源", () => {
  const sources = [
    ["C:\\Users\\robot\\private\\bad-extension.ts", "bad-extension.ts"],
    ["file:///C:/Users/robot/private/bad-extension.ts", "bad-extension.ts"],
    ["npm:pi-mcp-adapter", "pi-mcp-adapter"],
    ["npm:@scope/private-extension", "scope-private-extension"],
    ["git:https://user:TOP_SECRET@git.example/private/repository.git?token=TOP_SECRET", "git-extension"],
    ["https://TOP_SECRET@example.test/private-extension.ts?token=TOP_SECRET", "remote-extension"],
  ] as const;
  for (const [source, expected] of sources) {
    const label = extensionDiagnosticLabelFromSource(source);
    assert.equal(label, expected);
    assert.equal(label?.includes("TOP_SECRET"), false);
    assert.equal(label?.includes("/"), false);
    assert.equal(label?.includes("\\"), false);
    assert.equal(label?.includes("?"), false);
    assert.equal(label?.includes("@"), false);
  }
  assert.equal(extensionDiagnosticLabelFromSource("npm://TOP_SECRET@example.test/private"), undefined);

  const diagnostic = classifyPiStartupError(
    new Error('Failed to load extension "git:https://user:TOP_SECRET@git.example/private/repository.git?token=TOP_SECRET"'),
    { args: ["-e", "git:https://user:TOP_SECRET@git.example/private/repository.git?token=TOP_SECRET"] },
  );
  assert.deepEqual(diagnostic, {
    code: "extension_load_failed",
    details: { extension: "git-extension" },
  });
  assert.equal(JSON.stringify(diagnostic).includes("TOP_SECRET"), false);
});

test("启动异常和 stderr 诊断在跨 seam 后保持冻结的规范副本", () => {
  const input = {
    code: "provider_unavailable" as const,
    details: { provider: "wj-provider" },
  };
  const error = new ManagedRpcStartupError(input);
  input.details.provider = "changed-provider";
  assert.equal(error.code, "provider_unavailable");
  assert.deepEqual(error.details, { provider: "wj-provider" });
  assert.equal(Object.isFrozen(error), true);
  assert.equal(Object.isFrozen(error.details), true);
  assert.throws(() => {
    (error.details as { provider?: string }).provider = "forged";
  }, TypeError);
  assert.equal(error.details.provider, "wj-provider");
  assert.throws(() => new ManagedRpcStartupError({
    code: "provider_unavailable",
    details: { provider: "wj-provider", stderr: "TOP_SECRET" },
  } as unknown as ManagedRpcStartupDiagnostic), /启动诊断无效/);
  let accessorRead = false;
  const accessorDetails = {};
  Object.defineProperty(accessorDetails, "provider", {
    enumerable: true,
    get: () => {
      accessorRead = true;
      return "wj-provider";
    },
  });
  assert.throws(() => new ManagedRpcStartupError({
    code: "provider_unavailable",
    details: accessorDetails,
  }), /启动诊断无效/);
  assert.equal(accessorRead, false);

  const truncated = classifyPiStartupError(
    new Error(`${"TOP_SECRET ".repeat(8_000)}Unknown provider "forged-provider".`),
    { provider: "wj-provider" },
  );
  assert.deepEqual(truncated, {
    code: "provider_unavailable",
    details: { provider: "wj-provider" },
  });
  assert.equal(JSON.stringify(truncated).includes("TOP_SECRET"), false);
  assert.equal(JSON.stringify(truncated).includes("forged-provider"), false);
});

test("启动失败详情经生命周期、状态和树快照传播且拒绝伪造字段", () => {
  const tree = new TreeController({
    config: {
      maxDepth: 2,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 8,
      waitTimeoutMs: 10_000,
    },
    idFactory: () => AGENT_ID,
  });
  const reserved = tree.reserveStartingChild(ROOT_TREE_ACTOR, {
    templateId: "browser",
    name: "诊断传播",
  });
  assert.equal(reserved.ok, true);
  if (!reserved.ok) return;

  const mutableDetails = { provider: "wj-provider" };
  const failed = tree.applyLifecycleEvent(AGENT_ID, {
    type: "startup_failed",
    expected_generation: reserved.data.lifecycle_generation,
    error_code: "provider_unavailable",
    error_details: mutableDetails,
  });
  assert.equal(failed.ok, true);
  if (!failed.ok) return;
  assert.equal(failed.data.applied, true);
  mutableDetails.provider = "forged-provider";

  const status = tree.getStatus(AGENT_ID);
  const snapshot = tree.getTreeSnapshot();
  assert.equal(status.ok, true);
  assert.equal(snapshot.ok, true);
  if (!status.ok || !snapshot.ok) return;
  assert.deepEqual(status.data.error?.details, { provider: "wj-provider" });
  assert.deepEqual(snapshot.data.nodes[0]?.error?.details, { provider: "wj-provider" });
  assert.equal(Object.isFrozen(status.data.error?.details), true);
  assert.notEqual(status.data.error?.details, mutableDetails);
  assert.notEqual(snapshot.data.nodes[0]?.error?.details, status.data.error?.details);

  const forgedSnapshot = {
    ...status.data,
    error: {
      ...status.data.error,
      details: { provider: "wj-provider", path: "C:\\Users\\robot\\TOP_SECRET" },
    },
  };
  assert.equal(parseAgentSnapshot(forgedSnapshot), undefined);

  const secondTree = new TreeController({
    config: {
      maxDepth: 2,
      maxChildrenPerAgent: 4,
      maxAgentsPerTree: 8,
      waitTimeoutMs: 10_000,
    },
    idFactory: () => AGENT_ID,
  });
  const secondReservation = secondTree.reserveStartingChild(ROOT_TREE_ACTOR, {
    templateId: "browser",
    name: "伪造诊断",
  });
  assert.equal(secondReservation.ok, true);
  if (!secondReservation.ok) return;
  const rejected = secondTree.applyLifecycleEvent(AGENT_ID, {
    type: "startup_failed",
    expected_generation: secondReservation.data.lifecycle_generation,
    error_code: "provider_unavailable",
    error_details: { provider: "wj-provider", path: "C:\\Users\\robot\\TOP_SECRET" },
  } as unknown);
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.code, "invalid_argument");

  const inheritedEvent = Object.create({
    error_code: "provider_unavailable",
    error_details: { provider: "wj-provider" },
  }) as Record<string, unknown>;
  inheritedEvent.type = "startup_failed";
  inheritedEvent.expected_generation = secondReservation.data.lifecycle_generation;
  const inheritedRejected = secondTree.applyLifecycleEvent(AGENT_ID, inheritedEvent);
  assert.equal(inheritedRejected.ok, false);
  if (!inheritedRejected.ok) assert.equal(inheritedRejected.error.code, "invalid_argument");
});
