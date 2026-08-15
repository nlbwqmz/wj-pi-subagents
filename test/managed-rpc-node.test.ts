import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  CHILD_REPLY_SCHEMA,
  CHILD_REPLY_VERSION,
  type ChildFinalEnvelope,
} from "../src/child-reply-envelope.ts";
import { BridgeSupervisorEndpoint } from "./helpers/bridge-supervisor-endpoint.ts";
import {
  FakeManagedRpcNode,
  MANAGED_RPC_BRIDGE_PROTOCOL,
  MANAGED_RPC_SUPERVISOR_MAX_ENCODED_FRAME_BYTES,
  MANAGED_RPC_SUPERVISOR_MAX_FRAME_BYTES,
  ManagedRpcBridgeClient,
  ManagedRpcNode,
  createManagedRpcNodeLaunchSpec,
  resolveManagedRpcBridgeScriptPath,
  type ManagedRpcBridge,
  type ManagedRpcBridgeFactory,
  type ManagedRpcNodeStartContext,
  type ManagedRpcReply,
} from "../src/managed-rpc-node.ts";
import type {
  SupervisorCompactionComplete,
  SupervisorCompactionPrepared,
  SupervisorCompactionCompleted,
} from "../src/supervisor-channel.ts";
import { ManagedRpcSupervisorChannel } from "../src/managed-rpc-supervisor-channel.ts";
import {
  RpcSupervisor,
  type RpcSupervisorChannel,
  type RpcSupervisorChannelCloseState,
} from "../src/rpc-supervisor.ts";
import {
  ROOT_TREE_ACTOR,
  TreeController,
} from "../src/tree-controller.ts";
import type {
  ManagedProcessTransport,
  ProcessLaunchSpec,
  ProcessTreeAdapter,
  ProcessTreeHandle,
} from "../src/process-tree-capability.ts";
import {
  SUPERVISOR_PROTOCOL_VERSION,
  SupervisorChannel,
  SupervisorRequestIdRegistry,
  type SupervisorCapabilityManifest,
  type SupervisorFrame,
} from "../src/supervisor-channel.ts";

const TREE = Object.freeze({ kind: "tree" });
const TURN_ID = "77777777-7777-4777-8777-777777777777";
const TASK_ID = "77777777-7777-4777-8777-777777777778";
const COMMIT_ID = "77777777-7777-4777-8777-777777777779";

function finalReply(
  agentId: string,
  text: string,
): ChildFinalEnvelope {
  return {
    schema: CHILD_REPLY_SCHEMA,
    version: CHILD_REPLY_VERSION,
    kind: "final",
    agent_id: agentId,
    task_id: TASK_ID,
    turn_id: TURN_ID,
    commit_id: COMMIT_ID,
    run_state: "settled",
    output_state: "present",
    text,
  };
}

function capabilityManifest(): SupervisorCapabilityManifest {
  return {
    protocol_version: SUPERVISOR_PROTOCOL_VERSION,
    business_active_tools: ["bash", "read"],
    system_active_tools: ["reply_to_parent"],
    system_tool_sources: { reply_to_parent: "extension:wj-pi-subagents" },
    provider: "openai",
    model: "gpt-5.2-codex",
    thinking: "high",
    self_extension_path: "C:\\pi\\index.ts",
  };
}

test("编译后的受管节点优先解析同目录 bridge，源码节点仍解析 dist bridge", () => {
  const compiledModuleUrl = "file:///D:/package/dist/src/managed-rpc-node.js";
  const colocatedCompiled = fileURLToPath(new URL("./rpc-bridge-process.js", compiledModuleUrl));
  assert.equal(
    resolveManagedRpcBridgeScriptPath(compiledModuleUrl, (path) => path === colocatedCompiled),
    colocatedCompiled,
  );

  const sourceModuleUrl = "file:///D:/package/src/managed-rpc-node.ts";
  const sourceCompiled = fileURLToPath(new URL("../dist/src/rpc-bridge-process.js", sourceModuleUrl));
  assert.equal(
    resolveManagedRpcBridgeScriptPath(sourceModuleUrl, (path) => path === sourceCompiled),
    sourceCompiled,
  );
});

test("受管节点只为源码 bridge 启用 TypeScript stripping，配置不进入命令行", () => {
  const compiled = createManagedRpcNodeLaunchSpec({
    bridgeScriptPath: "C:/wj-pi-subagents/dist/src/rpc-bridge-process.js",
  });
  assert.deepEqual(compiled.args, ["C:/wj-pi-subagents/dist/src/rpc-bridge-process.js"]);

  const source = createManagedRpcNodeLaunchSpec({
    bridgeScriptPath: "C:/wj-pi-subagents/src/rpc-bridge-process.ts",
  });
  assert.deepEqual(source.args, [
    "--experimental-strip-types",
    "C:/wj-pi-subagents/src/rpc-bridge-process.ts",
  ]);
});

function transport(): ManagedProcessTransport {
  return Object.freeze({
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
}

class RecordingBridge implements ManagedRpcBridge {
  readonly operations: string[] = [];
  readonly supervisorFrames: Uint8Array[] = [];
  private readonly eventListeners = new Set<(event: unknown) => void>();
  private readonly faultListeners = new Set<(fault: "eof" | "protocol_fault" | "process_exit") => void>();

  async start(): Promise<void> {
    this.operations.push("bridge:start");
  }

  async prompt(): Promise<void> {
    this.operations.push("bridge:prompt");
  }

  async steer(): Promise<void> {
    this.operations.push("bridge:steer");
  }


  async abort(): Promise<void> {
    this.operations.push("bridge:abort");
  }

  async getState(): Promise<unknown> {
    this.operations.push("bridge:get_state");
    return { isStreaming: false };
  }

  async requestClose(): Promise<void> {
    this.operations.push("bridge:close");
  }

  onEvent(listener: (event: unknown) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onTransportFault(listener: (fault: "eof" | "protocol_fault" | "process_exit") => void): () => void {
    this.faultListeners.add(listener);
    return () => this.faultListeners.delete(listener);
  }

  async sendSupervisorFrame(frame: Uint8Array): Promise<void> {
    this.supervisorFrames.push(new Uint8Array(frame));
  }

  onSupervisorFrame(): () => void {
    return () => {};
  }

  release(): Promise<void> {
    this.operations.push("bridge:release");
    return Promise.resolve();
  }

  emitEvent(event: unknown): void {
    for (const listener of this.eventListeners) listener(event);
  }
}

class RecordingAdapter implements ProcessTreeAdapter {
  readonly platform = "win32" as const;
  readonly strategy = "job_object" as const;
  readonly operations: string[] = [];
  tree: ProcessTreeHandle | undefined;
  launchSpec: ProcessLaunchSpec | undefined;

  async launch(spec: ProcessLaunchSpec): Promise<{ tree: ProcessTreeHandle; transport: ManagedProcessTransport }> {
    this.launchSpec = spec;
    this.operations.push(`launch:${spec.command}`);
    this.tree = TREE;
    return Object.freeze({ tree: TREE, transport: transport() });
  }

  async requestGracefulClose(tree: ProcessTreeHandle): Promise<void> {
    assert.equal(tree, this.tree);
    this.operations.push("graceful");
  }

  async forceTerminate(tree: ProcessTreeHandle): Promise<void> {
    assert.equal(tree, this.tree);
    this.operations.push("force");
  }

  async waitForExit(tree: ProcessTreeHandle): Promise<{ state: "exited" }> {
    assert.equal(tree, this.tree);
    this.operations.push("wait");
    return { state: "exited" };
  }

  async inspect(tree: ProcessTreeHandle): Promise<{ state: "released" }> {
    assert.equal(tree, this.tree);
    this.operations.push("inspect");
    return { state: "released" };
  }

  async release(tree: ProcessTreeHandle): Promise<void> {
    assert.equal(tree, this.tree);
    this.operations.push("release");
  }
}

class DelayedStartBridge extends RecordingBridge {
  readonly startEntered: Promise<void>;
  private signalStartEntered!: () => void;
  private readonly startGate: Promise<void>;
  private completeStartGate!: () => void;

  constructor() {
    super();
    this.startEntered = new Promise<void>((resolve) => {
      this.signalStartEntered = resolve;
    });
    this.startGate = new Promise<void>((resolve) => {
      this.completeStartGate = resolve;
    });
  }

  override async start(): Promise<void> {
    this.operations.push("bridge:start");
    this.signalStartEntered();
    await this.startGate;
  }

  completeStart(): void {
    this.completeStartGate();
  }
}

class ListenerInstallingBridge extends RecordingBridge {
  readonly startEntered: Promise<void>;
  readonly releaseEntered: Promise<void>;
  private signalStartEntered!: () => void;
  private signalReleaseEntered!: () => void;
  private readonly startGate: Promise<void>;
  private completeStartGate!: () => void;
  private readonly source: EventEmitter;
  private readonly listener: () => void;

  constructor(source: EventEmitter, listener: () => void) {
    super();
    this.source = source;
    this.listener = listener;
    this.startEntered = new Promise<void>((resolve) => {
      this.signalStartEntered = resolve;
    });
    this.releaseEntered = new Promise<void>((resolve) => {
      this.signalReleaseEntered = resolve;
    });
    this.startGate = new Promise<void>((resolve) => {
      this.completeStartGate = resolve;
    });
  }

  override async start(): Promise<void> {
    this.operations.push("bridge:start");
    this.signalStartEntered();
    await this.startGate;
    this.source.on("resource", this.listener);
  }

  override release(): Promise<void> {
    this.operations.push("bridge:release");
    this.source.off("resource", this.listener);
    this.signalReleaseEntered();
    return Promise.resolve();
  }

  completeStart(): void {
    this.completeStartGate();
  }
}

class DelayedLaunchAdapter extends RecordingAdapter {
  readonly launchStarted: Promise<void>;
  private signalLaunchStarted!: () => void;
  private readonly launchGate: Promise<void>;
  private completeLaunchGate!: () => void;

  constructor() {
    super();
    this.launchStarted = new Promise<void>((resolve) => {
      this.signalLaunchStarted = resolve;
    });
    this.launchGate = new Promise<void>((resolve) => {
      this.completeLaunchGate = resolve;
    });
  }

  override async launch(spec: ProcessLaunchSpec): Promise<{
    tree: ProcessTreeHandle;
    transport: ManagedProcessTransport;
  }> {
    this.signalLaunchStarted();
    await this.launchGate;
    return super.launch(spec);
  }

  completeLaunch(): void {
    this.completeLaunchGate();
  }
}

test("ManagedRpcNode 以单一启动事务绑定 launch 返回的树和桥接，并委托高层命令", async () => {
  const adapter = new RecordingAdapter();
  let bridge: RecordingBridge | undefined;
  let bridgeCredential: string | undefined;
  let bridgeRpcOptions: Readonly<Record<string, unknown>> | undefined;
  const bridgeFactory: ManagedRpcBridgeFactory = (_transport, options) => {
    bridgeCredential = options?.credential;
    bridgeRpcOptions = options?.rpcOptions;
    bridge = new RecordingBridge();
    return bridge;
  };
  const node = new ManagedRpcNode({
    processTreeAdapter: adapter,
    launch: { command: "bridge.exe", args: ["--managed"] },
    rpcOptions: { args: ["--no-session"], templatePrompt: { mode: "append", body: "不进入命令行" } },
    bridgeFactory,
  });
  const observed: unknown[] = [];
  node.onEvent((event) => observed.push(event));

  await node.start();
  const credential = adapter.launchSpec?.env?.WJ_PI_SUBAGENTS_MANAGED_RPC_CREDENTIAL;
  assert.equal(typeof credential, "string");
  assert.equal(credential?.length, 43);
  assert.deepEqual(bridgeRpcOptions, {
    args: ["--no-session"],
    templatePrompt: { mode: "append", body: "不进入命令行" },
  });
  bridge?.emitEvent({ type: "agent_settled" });
  assert.deepEqual(observed, [{ type: "agent_settled" }]);
  await node.prompt("hello");
  await node.steer("next");
  await node.steer("steering");
  await node.abort();
  assert.deepEqual(await node.getState(), { isStreaming: false });
  await node.requestGracefulClose(new AbortController().signal);
  await node.forceTerminate();
  assert.deepEqual(await node.waitForExit(Date.now()), { state: "exited" });
  assert.deepEqual(await node.inspect(), { state: "released" });
  await node.release();

  assert.deepEqual(adapter.operations, ["launch:bridge.exe", "graceful", "force", "wait", "inspect", "release"]);
  assert.deepEqual(bridge?.operations, [
    "bridge:start",
    "bridge:prompt",
    "bridge:steer",
    "bridge:steer",
    "bridge:abort",
    "bridge:get_state",
    "bridge:close",
    "bridge:release",
  ]);
  assert.equal(bridgeCredential, credential);
});

test("ManagedRpcNode 在 bridge 启动握手完成前允许监督帧双向应答", async () => {
  const adapter = new RecordingAdapter();
  const bridge = new DelayedStartBridge();
  const node = new ManagedRpcNode({
    processTreeAdapter: adapter,
    launch: { command: "bridge.exe" },
    bridgeFactory: () => bridge,
  });

  const startup = node.start();
  await bridge.startEntered;
  await node.sendSupervisorFrame(new Uint8Array([1, 2, 3]));
  assert.deepEqual(bridge.supervisorFrames, [new Uint8Array([1, 2, 3])]);

  bridge.completeStart();
  await startup;
  await node.release();
});

test("ManagedRpcNode 启动超时期间不伪造资源确认，并在迟到 launch 后完成挂起回滚", async () => {
  const id = "22222222-2222-4222-8222-222222222222";
  const tree = new TreeController({
    config: { maxDepth: 2, maxChildrenPerAgent: 4, maxAgentsPerTree: 16, waitTimeoutMs: 60_000 },
    idFactory: () => id,
  });
  const adapter = new DelayedLaunchAdapter();
  let bridgeCreations = 0;
  const node = new ManagedRpcNode({
    processTreeAdapter: adapter,
    launch: { command: "bridge.exe" },
    bridgeFactory: () => {
      bridgeCreations += 1;
      return new RecordingBridge();
    },
  });
  const supervisor = new RpcSupervisor({
    controller: tree,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "迟到受管绑定" },
    managedNode: node,
    channel: new ReadyChannel(),
    startupTimeoutMs: 5,
    gracefulShutdownMs: 5,
  });

  const startup = supervisor.start();
  await adapter.launchStarted;
  const failed = await startup;

  assert.deepEqual(failed, {
    ok: false,
    agent_id: id,
    code: "termination_incomplete",
    cleanup: "incomplete",
  });
  assert.deepEqual(await node.waitForExit(Date.now()), { state: "unknown" });
  assert.deepEqual(await node.inspect(), { state: "unknown" });
  let status = tree.getStatus(id);
  assert.equal(status.ok, true);
  if (status.ok) assert.equal(status.data.state, "terminating");

  adapter.completeLaunch();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  status = tree.getStatus(id);
  assert.equal(status.ok, true);
  if (status.ok) assert.equal(status.data.state, "terminated");
  assert.equal(adapter.operations.includes("force"), true);
  assert.equal(adapter.operations.includes("release"), true);
  assert.equal(bridgeCreations, 0);
});

test("ManagedRpcNode release 等待启动中的 bridge 收尾且不泄漏迟到监听器", async () => {
  const adapter = new DelayedLaunchAdapter();
  const source = new EventEmitter();
  let observed = 0;
  const bridge = new ListenerInstallingBridge(source, () => {
    observed += 1;
  });
  const node = new ManagedRpcNode({
    processTreeAdapter: adapter,
    launch: { command: "bridge.exe" },
    bridgeFactory: () => bridge,
  });

  const startup = node.start();
  await adapter.launchStarted;
  adapter.completeLaunch();
  await bridge.startEntered;

  const releasing = node.release();
  await bridge.releaseEntered;
  bridge.completeStart();

  await assert.rejects(
    startup,
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  await releasing;
  source.emit("resource");
  assert.equal(observed, 0);
});

test("FakeManagedRpcNode 提供可控事件、故障和资源观察", async () => {
  const node = new FakeManagedRpcNode();
  const events: unknown[] = [];
  const faults: string[] = [];
  node.onEvent((event) => events.push(event));
  node.onTransportFault((fault) => faults.push(fault));
  await node.start();
  node.emitEvent({ type: "agent_settled" });
  node.emitTransportFault("eof");
  assert.deepEqual(events, [{ type: "agent_settled" }]);
  assert.deepEqual(faults, ["eof"]);
  assert.equal(node.process_binding, "managed");
});

test("ManagedRpcBridgeClient 使用固定版本与长度边界传递高层命令和故障", async () => {
  const parentInput = new PassThrough();
  const parentOutput = new PassThrough();
  const transport = Object.freeze({ stdin: parentInput, stdout: parentOutput, stderr: new PassThrough() });
  const client = new ManagedRpcBridgeClient(transport);
  const requests: Array<{ id: number; command: string }> = [];
  parentInput.on("data", (chunk: Uint8Array) => {
    const bytes = new Uint8Array(chunk);
    const length = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
    const frame = JSON.parse(new TextDecoder().decode(bytes.slice(4, 4 + length))) as {
      protocol: string;
      id: number;
      command: string;
    };
    assert.equal(frame.protocol, MANAGED_RPC_BRIDGE_PROTOCOL);
    requests.push({ id: frame.id, command: frame.command });
    const response = encodeFrame({ protocol: MANAGED_RPC_BRIDGE_PROTOCOL, kind: "response", id: frame.id, ok: true, data: frame.command === "get_state" ? { isStreaming: false } : undefined });
    parentOutput.write(response);
  });
  const events: unknown[] = [];
  const faults: string[] = [];
  client.onEvent((event) => events.push(event));
  client.onTransportFault((fault) => faults.push(fault));

  await client.start();
  await client.prompt("hello");
  await client.steer("steering");
  assert.deepEqual(await client.getState(), { isStreaming: false });
  parentOutput.write(encodeFrame({ protocol: MANAGED_RPC_BRIDGE_PROTOCOL, kind: "event", event: { type: "agent_start" } }));
  parentOutput.write(encodeFrame({ protocol: MANAGED_RPC_BRIDGE_PROTOCOL, kind: "event", event: { type: "agent_settled" } }));
  assert.deepEqual(events, [{ type: "agent_start" }, { type: "agent_settled" }]);
  parentOutput.end();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(faults, ["eof"]);
  assert.deepEqual(requests.map((request) => request.command), ["start", "prompt", "steer", "get_state"]);
  await client.release();
});

test("桥接客户端分片传递长启动配置", async () => {
  const parentInput = new PassThrough();
  const parentOutput = new PassThrough();
  const longConfig = "x".repeat(128 * 1024);
  const client = new ManagedRpcBridgeClient({
    stdin: parentInput,
    stdout: parentOutput,
    stderr: new PassThrough(),
  }, { rpcOptions: { longConfig } });
  const chunks: Array<Record<string, unknown>> = [];
  let buffered = new Uint8Array(0);
  parentInput.on("data", (chunk: Uint8Array) => {
    const combined = new Uint8Array(buffered.byteLength + chunk.byteLength);
    combined.set(buffered);
    combined.set(chunk, buffered.byteLength);
    buffered = combined;
    while (buffered.byteLength >= 4) {
      const length = new DataView(buffered.buffer, buffered.byteOffset, 4).getUint32(0, false);
      if (buffered.byteLength < length + 4) return;
      const frame = JSON.parse(new TextDecoder().decode(buffered.subarray(4, length + 4))) as Record<string, unknown>;
      buffered = buffered.subarray(length + 4);
      if (frame.kind === "command_chunk") {
        chunks.push(frame);
        if (frame.chunk_index === (frame.chunk_count as number) - 1) {
          parentOutput.write(encodeFrame({
            protocol: MANAGED_RPC_BRIDGE_PROTOCOL,
            kind: "response",
            id: frame.id,
            ok: true,
          }));
        }
      } else {
        parentOutput.write(encodeFrame({
          protocol: MANAGED_RPC_BRIDGE_PROTOCOL,
          kind: "response",
          id: frame.id,
          ok: true,
        }));
      }
    }
  });

  await client.start();

  assert.ok(chunks.length > 1);
  const payloadBytes = Buffer.concat(chunks.map((frame) => Buffer.from(String(frame.chunk), "base64url")));
  const payload = JSON.parse(payloadBytes.toString("utf8")) as {
    config: { rpc: { longConfig: string } };
  };
  assert.equal(payload.config.rpc.longConfig, longConfig);
  await client.release();
});

test("桥接事件观察者抛错不会破坏后续事件或把传输误判为故障", async () => {
  const parentInput = new PassThrough();
  const parentOutput = new PassThrough();
  const client = new ManagedRpcBridgeClient({ stdin: parentInput, stdout: parentOutput, stderr: new PassThrough() });
  const seen: unknown[] = [];
  const faults: string[] = [];
  client.onEvent(() => { throw new Error("observer"); });
  client.onEvent((event) => seen.push(event));
  client.onTransportFault((fault) => faults.push(fault));
  parentInput.on("data", (chunk: Uint8Array) => {
    const bytes = new Uint8Array(chunk);
    const length = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
    const frame = JSON.parse(new TextDecoder().decode(bytes.slice(4, 4 + length))) as { id: number };
    parentOutput.write(encodeFrame({ protocol: MANAGED_RPC_BRIDGE_PROTOCOL, kind: "response", id: frame.id, ok: true }));
  });
  await client.start();
  parentOutput.write(encodeFrame({ protocol: MANAGED_RPC_BRIDGE_PROTOCOL, kind: "event", event: { type: "agent_settled" } }));
  parentOutput.write(encodeFrame({ protocol: MANAGED_RPC_BRIDGE_PROTOCOL, kind: "event", event: { type: "agent_settled" } }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, [{ type: "agent_settled" }, { type: "agent_settled" }]);
  assert.deepEqual(faults, []);
  await client.release();
});

test("桥接客户端把带有截断帧的 EOF 归一化为协议故障", async () => {
  const parentOutput = new PassThrough();
  const client = new ManagedRpcBridgeClient({
    stdin: new PassThrough(),
    stdout: parentOutput,
    stderr: new PassThrough(),
  });
  const faults: string[] = [];
  client.onTransportFault((fault) => faults.push(fault));

  parentOutput.write(new Uint8Array([0, 0, 0, 8, 0x7b]));
  parentOutput.end();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(faults, ["protocol_fault"]);
  await client.release();
});

test("桥接客户端拒绝带未知字段的外层响应帧", async () => {
  const parentInput = new PassThrough();
  const parentOutput = new PassThrough();
  const client = new ManagedRpcBridgeClient({
    stdin: parentInput,
    stdout: parentOutput,
    stderr: new PassThrough(),
  });
  const faults: string[] = [];
  client.onTransportFault((fault) => faults.push(fault));
  parentInput.once("data", (chunk: Uint8Array) => {
    const bytes = new Uint8Array(chunk);
    const length = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
    const request = JSON.parse(new TextDecoder().decode(bytes.slice(4, 4 + length))) as { id: number };
    parentOutput.write(encodeFrame({
      protocol: MANAGED_RPC_BRIDGE_PROTOCOL,
      kind: "response",
      id: request.id,
      ok: true,
      unexpected: "不得透传",
    }));
  });

  await assert.rejects(() => client.start(), /桥接传输故障/);
  assert.deepEqual(faults, ["protocol_fault"]);
  await client.release();
});

test("桥接客户端拒绝任何伪造的任务 RPC assistant 回复事件", async () => {
  const parentInput = new PassThrough();
  const parentOutput = new PassThrough();
  const client = new ManagedRpcBridgeClient({
    stdin: parentInput,
    stdout: parentOutput,
    stderr: new PassThrough(),
  });
  const faults: string[] = [];
  client.onTransportFault((fault) => faults.push(fault));
  parentInput.once("data", (chunk: Uint8Array) => {
    const bytes = new Uint8Array(chunk);
    const length = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
    const request = JSON.parse(new TextDecoder().decode(bytes.slice(4, 4 + length))) as { id: number };
    parentOutput.write(encodeFrame({
      protocol: MANAGED_RPC_BRIDGE_PROTOCOL,
      kind: "response",
      id: request.id,
      ok: true,
    }));
  });
  await client.start();

  parentOutput.write(encodeFrame({
    protocol: MANAGED_RPC_BRIDGE_PROTOCOL,
    kind: "event",
    event: {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "即使字段完全合法也不得从 bridge 上行" }],
      },
    },
  }));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(faults, ["protocol_fault"]);
  await client.release();
});

test("桥接客户端在唯一读写流上复用有界监督帧并传递启动身份", async () => {
  const parentInput = new PassThrough();
  const parentOutput = new PassThrough();
  const client = new ManagedRpcBridgeClient(
    { stdin: parentInput, stdout: parentOutput, stderr: new PassThrough() },
    { credential: "bridge-credential-01234567890123456789" },
  );
  const commands: Array<Record<string, unknown>> = [];
  const supervisorWrites: Uint8Array[] = [];
  parentInput.on("data", (chunk: Uint8Array) => {
    const bytes = new Uint8Array(chunk);
    const length = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
    const frame = JSON.parse(new TextDecoder().decode(bytes.slice(4, 4 + length))) as Record<string, unknown>;
    if (frame.kind === "supervisor_frame") {
      supervisorWrites.push(new Uint8Array(Buffer.from(frame.frame as string, "base64url")));
      return;
    }
    commands.push(frame);
    parentOutput.write(encodeFrame({
      protocol: MANAGED_RPC_BRIDGE_PROTOCOL,
      kind: "response",
      id: frame.id,
      ok: true,
    }));
  });
  const observed: Uint8Array[] = [];
  client.onSupervisorFrame((frame) => observed.push(frame));
  const init = {
    root_id: "root-test",
    local_agent_id: "77777777-7777-4777-8777-777777777777",
    peer_agent_id: "",
    parent_agent_id: null,
    depth: 1,
    credential: "supervisor-credential-0123456789012345",
    initial_snapshot: [{
      agent_id: "77777777-7777-4777-8777-777777777777",
      parent_agent_id: null,
      template_id: "researcher",
      name: "受管",
      depth: 1,
      state: "starting" as const,
      mailbox_pending_count: 0,
      host_pending_count: 0,
      reply_outbox_pending_count: 0,
      revision: 1,
    }],
    initial_subtree_revision: 1,
  } as const;
  await client.start(undefined, { supervisor: init });
  await client.sendSupervisorFrame(new Uint8Array([1, 2, 3]));
  parentOutput.write(encodeFrame({
    protocol: MANAGED_RPC_BRIDGE_PROTOCOL,
    kind: "supervisor_frame",
    frame: Buffer.from([4, 5, 6]).toString("base64url"),
  }));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(supervisorWrites, [new Uint8Array([1, 2, 3])]);
  assert.deepEqual(observed, [new Uint8Array([4, 5, 6])]);
  assert.equal((commands[0]?.payload as Record<string, unknown>).credential, "bridge-credential-01234567890123456789");
  assert.deepEqual((commands[0]?.payload as Record<string, unknown>).supervisor, init);
  await client.release();
});

test("桥接监督隧道把完整监督帧分片为可容纳的 Base64URL 外层帧", async () => {
  const parentInput = new PassThrough();
  const client = new ManagedRpcBridgeClient({
    stdin: parentInput,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  const written: Uint8Array[] = [];
  parentInput.on("data", (chunk: Uint8Array) => written.push(new Uint8Array(chunk)));

  const fullFrame = new Uint8Array(MANAGED_RPC_SUPERVISOR_MAX_FRAME_BYTES + 1);
  for (let index = 0; index < fullFrame.byteLength; index += 1) fullFrame[index] = index % 251;
  await client.sendSupervisorFrame(fullFrame);
  await assert.rejects(
    () => client.sendSupervisorFrame(new Uint8Array(MANAGED_RPC_SUPERVISOR_MAX_ENCODED_FRAME_BYTES + 1)),
    /监督帧无效/,
  );

  assert.equal(written.length, 2);
  const chunks = written.map((outer) => {
    const bodyLength = new DataView(outer.buffer, outer.byteOffset, 4).getUint32(0, false);
    assert.ok(bodyLength <= 64 * 1024);
    assert.equal(outer.byteLength, bodyLength + 4);
    const parsed = JSON.parse(new TextDecoder().decode(outer.subarray(4))) as { frame: string };
    return new Uint8Array(Buffer.from(parsed.frame, "base64url"));
  });
  const reassembled = new Uint8Array(fullFrame.byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    reassembled.set(chunk, offset);
    offset += chunk.byteLength;
  }
  assert.deepEqual(reassembled, fullFrame);
  await client.release();
});

test("桥接 child 监督端点完成 hello、首快照与双端 ready", () => {
  const childId = "88888888-8888-4888-8888-888888888888";
  const credential = "supervisor-credential-0123456789012345";
  const parent = new SupervisorChannel({
    role: "parent",
    rootId: "root-test",
    localAgentId: null,
    peerAgentId: childId,
    parentAgentId: null,
    depth: 1,
    credential,
    requestIdRegistry: new SupervisorRequestIdRegistry(),
  });
  const childFrames: Uint8Array[] = [];
  const endpoint = new BridgeSupervisorEndpoint({
    init: {
      root_id: "root-test",
      local_agent_id: childId,
      peer_agent_id: "",
      parent_agent_id: null,
      depth: 1,
      credential,
      initial_snapshot: [{
        agent_id: childId,
        parent_agent_id: null,
        template_id: "researcher",
        name: "桥接端点",
        depth: 1,
        state: "starting",
        mailbox_pending_count: 0,
        host_pending_count: 0,
        reply_outbox_pending_count: 0,
        revision: 1,
      }],
      initial_subtree_revision: 1,
    },
    send: (frame) => childFrames.push(frame),
  });
  endpoint.start();
  for (let count = 0; count < 16 && (!parent.getPublicState().state.includes("ready") || !endpoint.getPublicState().state.includes("ready")); count += 1) {
    const childFrame = childFrames.shift();
    if (childFrame === undefined) break;
    const result = parent.receive(childFrame);
    if (result.kind === "accepted" || result.kind === "duplicate" || result.kind === "gap") {
      for (const outbound of result.outbound) endpoint.receive(parent.encode(outbound));
    }
  }
  assert.equal(parent.getPublicState().state, "ready");
  assert.equal(endpoint.getPublicState().state, "ready");
  assert.equal(parent.getPublicState().snapshot_node_count, 1);
});

class CapabilityLinkedManagedNode extends FakeManagedRpcNode {
  private childProtocol: SupervisorChannel | undefined;
  private initialSnapshot: readonly unknown[] = [];
  private initialSubtreeRevision = 0;
  private snapshotSent = false;

  override async start(signal?: AbortSignal, context?: ManagedRpcNodeStartContext): Promise<void> {
    const init = context?.supervisor;
    if (init === undefined) throw new Error("缺少监督初始化上下文");
    this.childProtocol = new SupervisorChannel({
      role: "child",
      rootId: init.root_id,
      localAgentId: init.local_agent_id,
      peerAgentId: init.peer_agent_id,
      parentAgentId: init.parent_agent_id,
      depth: init.depth,
      credential: init.credential,
      requestIdRegistry: new SupervisorRequestIdRegistry(),
    });
    this.initialSnapshot = init.initial_snapshot;
    this.initialSubtreeRevision = init.initial_subtree_revision;
    await super.start(signal, context);
    this.forwardFromChild(this.childProtocol.startHandshake());
  }

  override async sendSupervisorFrame(frame: Uint8Array): Promise<void> {
    const protocol = this.childProtocol;
    if (protocol === undefined) throw new Error("测试 child 端点未启动");
    const result = protocol.receive(frame);
    if (result.kind === "protocol_fault" || result.kind === "eof") {
      this.emitTransportFault("protocol_fault");
      return;
    }
    if (result.kind === "accepted" || result.kind === "duplicate" || result.kind === "gap") {
      for (const outbound of result.outbound) this.forwardFromChild(outbound);
    }
    if (!this.snapshotSent && protocol.getPublicState().state === "awaiting_snapshot") {
      this.snapshotSent = true;
      this.forwardFromChild(protocol.publishSnapshot(this.initialSnapshot, this.initialSubtreeRevision));
    }
  }

  publishCapability(manifest: SupervisorCapabilityManifest): void {
    const protocol = this.childProtocol;
    if (protocol === undefined) throw new Error("测试 child 端点未启动");
    this.forwardFromChild(protocol.publishCapability(manifest));
  }

  private forwardFromChild(frame: SupervisorFrame): void {
    const protocol = this.childProtocol;
    if (protocol === undefined) throw new Error("测试 child 端点未启动");
    this.emitSupervisorFrame(protocol.encode(frame));
  }
}

class LinkedManagedNode extends FakeManagedRpcNode {
  private endpoint: BridgeSupervisorEndpoint | undefined;
  publishedReplies = 0;
  supervisorState(): string | undefined { return this.endpoint?.getPublicState().state; }

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

  async publishReply(reply: ManagedRpcReply): Promise<void> {
    this.publishedReplies += 1;
    this.endpoint?.publishReply(reply);
  }

  onCompactionPrepare(listener: (transactionId: string) => void): () => void {
    return this.endpoint?.onCompactionPrepare((request) => listener(request.transaction_id)) ?? (() => {});
  }

  onCompactionComplete(
    listener: (transactionId: string, outcome: SupervisorCompactionComplete["outcome"]) => void,
  ): () => void {
    return this.endpoint?.onCompactionComplete((request) => listener(request.transaction_id, request.outcome))
      ?? (() => {});
  }

  requestCompactionPrepare(transactionId: string): Promise<boolean> {
    if (this.endpoint === undefined) throw new Error("测试 child 端点未启动");
    return this.endpoint.requestCompactionPrepare(transactionId);
  }

  respondCompactionPrepared(response: SupervisorCompactionPrepared): void {
    this.endpoint?.respondCompactionPrepared(response);
  }

  requestCompactionComplete(
    transactionId: string,
    outcome: SupervisorCompactionComplete["outcome"],
  ): Promise<boolean> {
    if (this.endpoint === undefined) throw new Error("测试 child 端点未启动");
    return this.endpoint.requestCompactionComplete(transactionId, outcome);
  }

  respondCompactionCompleted(response: SupervisorCompactionCompleted): void {
    this.endpoint?.respondCompactionCompleted(response);
  }
}

test("RpcSupervisor 通过真正 child 端点完成双握手和回复 ACK", async () => {
  const id = "99999999-9999-4999-8999-999999999999";
  const controller = new TreeController({
    config: { maxDepth: 2, maxChildrenPerAgent: 4, maxAgentsPerTree: 16, waitTimeoutMs: 60_000 },
    idFactory: () => id,
  });
  const node = new LinkedManagedNode();
  const delivered: string[] = [];
  const supervisor = new RpcSupervisor({
    controller,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "双握手" },
    managedNode: node,
    channelFactory: (context) => {
      const credential = "supervisor-credential-0123456789012345";
      return {
        channel: new ManagedRpcSupervisorChannel({
          node,
          rootId: "root-test",
          localAgentId: null,
          peerAgentId: context.agent_id,
          parentAgentId: context.parent_agent_id,
          depth: context.depth,
          credential,
          requestIdRegistry: new SupervisorRequestIdRegistry(),
          onReply: (reply) => {
            delivered.push(reply.envelope.text ?? "");
            return true;
          },
        }),
        nodeStartContext: {
          supervisor: {
            root_id: "root-test",
            local_agent_id: context.agent_id,
            peer_agent_id: "",
            parent_agent_id: context.parent_agent_id,
            depth: context.depth,
            credential,
            initial_snapshot: context.initial_snapshot,
            initial_subtree_revision: 1,
          },
        },
      };
    },
    startupTimeoutMs: 100,
    gracefulShutdownMs: 10,
  });
  const events: unknown[] = [];
  supervisor.onEvent((event) => events.push(event));
  assert.deepEqual(await supervisor.start(), { ok: true, agent_id: id, state: "idle" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(node.supervisorState(), "ready");
  const submission = await supervisor.prompt("触发回复");
  assert.equal(submission.ok, true);
  if (submission.ok) {
    assert.equal(submission.accepted, true);
    assert.match(submission.message_id, /^msg_/);
    assert.match(submission.task_id, /^[0-9a-f-]{36}$/);
  }
  await node.publishReply(finalReply(id, "桥接回复"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(node.publishedReplies, 1);
  assert.equal(node.supervisorState(), "ready");
  assert.deepEqual(delivered, ["桥接回复"]);
  assert.equal(events.some((event) => (
    typeof event === "object" && event !== null && (event as { kind?: unknown }).kind === "reply"
  )), false);
});

test("Managed RPC supervisor transport 转发并缓存 child capability manifest", async () => {
  const id = "97979797-9797-4979-8979-979797979797";
  const credential = "supervisor-credential-0123456789012345";
  const node = new CapabilityLinkedManagedNode();
  const optionObserved: SupervisorCapabilityManifest[] = [];
  const channel = new ManagedRpcSupervisorChannel({
    node,
    rootId: "root-managed-capability",
    localAgentId: null,
    peerAgentId: id,
    parentAgentId: null,
    depth: 1,
    credential,
    requestIdRegistry: new SupervisorRequestIdRegistry(),
    onCapability: (capability) => optionObserved.push(capability),
  });
  const signal = new AbortController().signal;
  await channel.bind(signal);
  await node.start(signal, {
    supervisor: {
      root_id: "root-managed-capability",
      local_agent_id: id,
      peer_agent_id: "",
      parent_agent_id: null,
      depth: 1,
      credential,
      initial_snapshot: [{
        agent_id: id,
        parent_agent_id: null,
        template_id: "researcher",
        name: "受管能力",
        depth: 1,
        state: "idle",
        mailbox_pending_count: 0,
        host_pending_count: 0,
        reply_outbox_pending_count: 0,
        revision: 1,
      }],
      initial_subtree_revision: 1,
    },
  });
  await channel.waitForReady(signal);
  assert.equal(channel.getCapability(), undefined);

  const observed: SupervisorCapabilityManifest[] = [];
  channel.onCapability((capability) => observed.push(capability));
  node.publishCapability(capabilityManifest());
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(optionObserved, [capabilityManifest()]);
  assert.deepEqual(observed, [capabilityManifest()]);
  assert.deepEqual(channel.getCapability(), capabilityManifest());

  const replayed: SupervisorCapabilityManifest[] = [];
  channel.onCapability((capability) => replayed.push(capability));
  assert.deepEqual(replayed, [capabilityManifest()]);
  await channel.release();
  await node.release();
});

test("Managed RPC bridge 透明承载 child 请求和 parent 压缩业务 ACK", async () => {
  const id = "98989898-9898-4989-8989-989898989898";
  const node = new LinkedManagedNode();
  const credential = "supervisor-credential-0123456789012345";
  const channel = new ManagedRpcSupervisorChannel({
    node,
    rootId: "root-managed-compaction",
    localAgentId: null,
    peerAgentId: id,
    parentAgentId: null,
    depth: 1,
    credential,
    requestIdRegistry: new SupervisorRequestIdRegistry(),
  });
  const signal = new AbortController().signal;
  await channel.bind(signal);
  await node.start(signal, {
    supervisor: {
      root_id: "root-managed-compaction",
      local_agent_id: id,
      peer_agent_id: "",
      parent_agent_id: null,
      depth: 1,
      credential,
      initial_snapshot: [{
        agent_id: id,
        parent_agent_id: null,
        template_id: "researcher",
        name: "受管压缩",
        depth: 1,
        state: "idle",
        mailbox_pending_count: 0,
        host_pending_count: 0,
        reply_outbox_pending_count: 0,
        revision: 1,
      }],
      initial_subtree_revision: 1,
    },
  });
  await channel.waitForReady(signal);

  let parentPrepareRequest: string | undefined;
  channel.onCompactionPrepare((request) => { parentPrepareRequest = request.transaction_id; });
  const childPrepare = node.requestCompactionPrepare("compact-managed-child");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(parentPrepareRequest, "compact-managed-child");
  let childPrepareSettled = false;
  void childPrepare.then(() => { childPrepareSettled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(childPrepareSettled, false);
  await channel.respondCompactionPrepared({ transaction_id: "compact-managed-child", accepted: true });
  assert.equal(await childPrepare, true);

  let parentCompleteRequest: { transactionId: string; outcome: string } | undefined;
  channel.onCompactionComplete((request) => {
    parentCompleteRequest = {
      transactionId: request.transaction_id,
      outcome: request.outcome,
    };
  });
  const childComplete = node.requestCompactionComplete("compact-managed-child", "cancelled");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(parentCompleteRequest, {
    transactionId: "compact-managed-child",
    outcome: "cancelled",
  });
  let childCompleteSettled = false;
  void childComplete.then(() => { childCompleteSettled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(childCompleteSettled, false);
  await channel.respondCompactionCompleted({ transaction_id: "compact-managed-child", accepted: false });
  assert.equal(await childComplete, false);

  await assert.rejects(channel.requestCompactionPrepare("invalid-parent-request"));
  await assert.rejects(channel.requestCompactionComplete("invalid-parent-request", "failed"));

  await channel.release();
  await node.release();
});

test("监督通道在 waitForReady 尚未开始时遇到 EOF 不产生未处理拒绝", async () => {
  const node = new FakeManagedRpcNode();
  const channel = new ManagedRpcSupervisorChannel({
    node,
    rootId: "root-test",
    localAgentId: null,
    peerAgentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    parentAgentId: null,
    depth: 1,
    credential: "supervisor-credential-0123456789012345",
    requestIdRegistry: new SupervisorRequestIdRegistry(),
  });
  const unhandled: unknown[] = [];
  const onUnhandledRejection = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    await channel.bind(new AbortController().signal);
    node.emitTransportFault("eof");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    await assert.rejects(
      channel.waitForReady(new AbortController().signal),
      /监督通道不可用/,
    );
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
    await channel.release();
  }
});

function encodeFrame(value: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(value));
  const frame = new Uint8Array(body.byteLength + 4);
  new DataView(frame.buffer).setUint32(0, body.byteLength, false);
  frame.set(body, 4);
  return frame;
}

class ReadyChannel implements RpcSupervisorChannel {
  private readonly faults = new Set<(fault: "eof" | "protocol_fault") => void>();
  private ready = true;

  async bind(): Promise<void> {}
  async waitForReady(): Promise<void> {}
  isReady(): boolean { return this.ready; }
  async publishReply(): Promise<void> {}
  async publishTaskAssignmentAndWaitForAck(): Promise<void> {}
  establishTerminationBarrier(): void {}
  async requestClose(): Promise<void> { this.ready = false; }
  async waitForClose(): Promise<RpcSupervisorChannelCloseState> { return "released"; }
  async release(): Promise<void> {}
  onFault(listener: (fault: "eof" | "protocol_fault") => void): () => void {
    this.faults.add(listener);
    return () => this.faults.delete(listener);
  }
}

test("RpcSupervisor 使用 managedNode 启动并清理，不读取独立客户端或树句柄", async () => {
  const id = "33333333-3333-4333-8333-333333333333";
  const controller = new TreeController({
    config: { maxDepth: 2, maxChildrenPerAgent: 4, maxAgentsPerTree: 16, waitTimeoutMs: 60_000 },
    idFactory: () => id,
  });
  const node = new FakeManagedRpcNode();
  const supervisor = new RpcSupervisor({
    controller,
    actor: ROOT_TREE_ACTOR,
    reservation: { templateId: "researcher", name: "受管" },
    managedNode: node,
    channel: new ReadyChannel(),
    startupTimeoutMs: 100,
    gracefulShutdownMs: 10,
  });

  assert.deepEqual(await supervisor.start(), { ok: true, agent_id: id, state: "idle" });
  const submission = await supervisor.prompt("hello");
  assert.equal(submission.ok, true);
  if (submission.ok) assert.equal(submission.accepted, true);
  node.emitEvent({ type: "agent_settled" });
  const terminated = await supervisor.terminate();
  assert.equal(terminated.ok, true);
  assert.deepEqual(node.operations(), [
    "start",
    "get_state",
    "prompt",
    "abort",
    "graceful_close",
    "wait_for_exit",
    "inspect",
    "release",
  ]);
});
