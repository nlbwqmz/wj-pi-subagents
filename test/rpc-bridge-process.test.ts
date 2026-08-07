import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  ManagedRpcBridgeClient,
  MANAGED_RPC_BRIDGE_CREDENTIAL_ENV,
  MANAGED_RPC_BRIDGE_MAX_FRAME_BYTES,
  MANAGED_RPC_BRIDGE_PROTOCOL,
  type ManagedRpcNodeLike,
  type ManagedRpcNodeStartContext,
  type ManagedRpcTransportFault,
} from "../src/managed-rpc-node.ts";
import { ManagedRpcSupervisorChannel } from "../src/managed-rpc-supervisor-channel.ts";
import { nativeLocalSupervisorTransportAdapter } from "../src/local-supervisor-transport.ts";
import { RUNTIME_INTERNAL_ENV_KEYS } from "../src/root-runtime-context.ts";
import { SupervisorRequestIdRegistry } from "../src/supervisor-channel.ts";

test("桥接进程把截断 EOF 刷新为单次协议故障并以失败码退出", async () => {
  const result = await runBridge(new Uint8Array([0, 0, 0, 8, 0x7b]));

  assert.equal(result.signal, null);
  assert.equal(result.code, 1, result.stderr);
  assert.deepEqual(result.frames, [protocolFaultFrame()]);
});

test("桥接进程拒绝未知外层字段，刷新单次故障后以失败码退出", async () => {
  const result = await runBridge(encodeFrame({
    protocol: MANAGED_RPC_BRIDGE_PROTOCOL,
    kind: "command",
    id: 1,
    command: "start",
    payload: { credential: "bridge-credential-01234567890123456789" },
    unexpected: "不得透传",
  }));

  assert.equal(result.signal, null);
  assert.equal(result.code, 1, result.stderr);
  assert.deepEqual(result.frames, [protocolFaultFrame()]);
});

test("桥接进程在只收到超长声明时立即拒绝且不会重复发送故障", async () => {
  const oversizedHeader = new Uint8Array(4);
  new DataView(oversizedHeader.buffer).setUint32(0, MANAGED_RPC_BRIDGE_MAX_FRAME_BYTES + 1, false);
  const secondInvalidFrame = encodeFrame({ protocol: "wrong", kind: "command" });
  const input = new Uint8Array(oversizedHeader.byteLength + secondInvalidFrame.byteLength);
  input.set(oversizedHeader);
  input.set(secondInvalidFrame, oversizedHeader.byteLength);

  const result = await runBridge(input);

  assert.equal(result.signal, null);
  assert.equal(result.code, 1, result.stderr);
  assert.deepEqual(result.frames, [protocolFaultFrame()]);
});

test("生产桥接配合 fake RpcClient 完成真实本地监督握手、回复 ACK 与清理", async (context) => {
  const script = fileURLToPath(new URL("../src/rpc-bridge-process.ts", import.meta.url));
  const loader = new URL("./helpers/pi-rpc-client-loader.mjs", import.meta.url).href;
  const childId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const bridgeCredential = "bridge-credential-01234567890123456789";
  const supervisorCredential = "supervisor-credential-0123456789012345";
  const child = spawn(process.execPath, [
    "--experimental-strip-types",
    "--experimental-loader",
    loader,
    script,
  ], {
    env: {
      ...process.env,
      [MANAGED_RPC_BRIDGE_CREDENTIAL_ENV]: bridgeCredential,
      [RUNTIME_INTERNAL_ENV_KEYS.rootId]: "root-production-bridge-test",
      [RUNTIME_INTERNAL_ENV_KEYS.parentAgentId]: "",
      [RUNTIME_INTERNAL_ENV_KEYS.agentId]: childId,
      [RUNTIME_INTERNAL_ENV_KEYS.depth]: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const stderr: Uint8Array[] = [];
  child.stderr.on("data", (chunk: Uint8Array) => stderr.push(new Uint8Array(chunk)));
  let closed = false;
  child.once("close", () => {
    closed = true;
  });
  const bridge = new ManagedRpcBridgeClient({
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
  }, { credential: bridgeCredential });
  const node = bridgeBackedNode(bridge);
  const replies: string[] = [];
  const bridgeEvents: unknown[] = [];
  const transportFaults: string[] = [];
  bridge.onEvent((event) => bridgeEvents.push(event));
  bridge.onTransportFault((fault) => transportFaults.push(fault));
  const channel = new ManagedRpcSupervisorChannel({
    node,
    rootId: "root-production-bridge-test",
    localAgentId: null,
    peerAgentId: childId,
    parentAgentId: null,
    depth: 1,
    credential: supervisorCredential,
    requestIdRegistry: new SupervisorRequestIdRegistry(),
    onReply: (reply) => {
      replies.push(reply.text);
      return true;
    },
  });
  context.after(async () => {
    await channel.release();
    await bridge.release();
    if (!closed) child.kill();
  });
  const signal = new AbortController().signal;
  await channel.bind(signal);
  try {
    await node.start(signal, { supervisor: supervisorInit(childId, supervisorCredential) });
  } catch (error) {
    const diagnostic = Buffer.concat(stderr).toString("utf8");
    throw new Error(`生产 bridge fake 启动失败：${diagnostic}`, { cause: error });
  }
  await channel.waitForReady(signal);

  assert.equal(channel.isReady(), true);
  await node.prompt("触发监督回复");
  const fakeState = await waitForReplyAcknowledgement(bridge);
  assert.deepEqual(replies, ["真正 child 监督回复"]);
  assert.deepEqual(bridgeEvents, [], "任务 RPC message_end 不得成为 bridge 事件");
  assert.deepEqual(transportFaults, []);

  const closeObservation = once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>;
  await bridge.requestClose(signal);
  const [code, exitSignal] = await closeObservation;
  assert.equal(code, 0, Buffer.concat(stderr).toString("utf8"));
  assert.equal(exitSignal, null);
  await assert.rejects(
    () => nativeLocalSupervisorTransportAdapter.connect({
      endpoint: fakeState.endpoint,
      agentId: fakeState.agentId,
      credential: fakeState.localCredential,
    }),
    /本地监督传输不可用/,
  );
  await channel.release();
  await bridge.release();
});

test("桥接可从配置的 Pi 模块路径加载 RpcClient", async (context) => {
  const script = fileURLToPath(new URL("../src/rpc-bridge-process.ts", import.meta.url));
  const loader = new URL("./helpers/reject-bare-pi-module-loader.mjs", import.meta.url).href;
  const piModulePath = new URL("./helpers/minimal-pi-rpc-client.mjs", import.meta.url).href;
  const config = Buffer.from(JSON.stringify({
    rpc: { piModulePath },
  }), "utf8").toString("base64url");
  const bridgeCredential = "bridge-credential-01234567890123456789";
  const child = spawn(process.execPath, [
    "--experimental-strip-types",
    "--experimental-loader",
    loader,
    script,
    "--config",
    config,
  ], {
    env: {
      ...process.env,
      [MANAGED_RPC_BRIDGE_CREDENTIAL_ENV]: bridgeCredential,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const stderr: Uint8Array[] = [];
  child.stderr.on("data", (chunk: Uint8Array) => stderr.push(new Uint8Array(chunk)));
  const bridge = new ManagedRpcBridgeClient({
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
  }, { credential: bridgeCredential });
  context.after(async () => {
    await bridge.release();
    if (!child.killed && child.exitCode === null) child.kill();
  });

  await bridge.start();
  const closeObservation = once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>;
  await bridge.requestClose(new AbortController().signal);
  const [code, signal] = await closeObservation;
  assert.equal(code, 0, Buffer.concat(stderr).toString("utf8"));
  assert.equal(signal, null);
  await bridge.release();
});

async function runBridge(input: Uint8Array): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly frames: readonly unknown[];
  readonly stderr: string;
}> {
  const script = fileURLToPath(new URL("../src/rpc-bridge-process.ts", import.meta.url));
  const child = spawn(process.execPath, ["--experimental-strip-types", script], {
    env: {
      ...process.env,
      [MANAGED_RPC_BRIDGE_CREDENTIAL_ENV]: "bridge-credential-01234567890123456789",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  child.stdout.on("data", (chunk: Uint8Array) => stdout.push(new Uint8Array(chunk)));
  child.stderr.on("data", (chunk: Uint8Array) => stderr.push(new Uint8Array(chunk)));

  child.stdin.end(input);
  const [code, signal] = await once(child, "close") as [number | null, NodeJS.Signals | null];

  return Object.freeze({
    code,
    signal,
    frames: Object.freeze(decodeFrames(Buffer.concat(stdout))),
    stderr: Buffer.concat(stderr).toString("utf8"),
  });
}

function protocolFaultFrame(): unknown {
  return {
    protocol: MANAGED_RPC_BRIDGE_PROTOCOL,
    kind: "fault",
    fault: "protocol_fault",
  };
}

function supervisorInit(childId: string, credential: string): NonNullable<ManagedRpcNodeStartContext["supervisor"]> {
  return Object.freeze({
    root_id: "root-production-bridge-test",
    local_agent_id: childId,
    peer_agent_id: "",
    parent_agent_id: null,
    depth: 1,
    credential,
    initial_snapshot: Object.freeze([Object.freeze({
      agent_id: childId,
      parent_agent_id: null,
      template_id: "researcher",
      name: "生产桥接 fake 子端点",
      depth: 1,
      state: "starting" as const,
      pending_message_count: 0,
      revision: 1,
      observed_at: "2026-08-06T00:00:00.000Z",
    })]),
    initial_subtree_revision: 1,
  });
}

function bridgeBackedNode(bridge: ManagedRpcBridgeClient): ManagedRpcNodeLike {
  return Object.freeze({
    process_binding: "managed" as const,
    start: (signal?: AbortSignal, startContext?: ManagedRpcNodeStartContext) => bridge.start(signal, startContext),
    prompt: (message: string) => bridge.prompt(message),
    steer: (message: string) => bridge.steer(message),
    abort: () => bridge.abort(),
    getState: () => bridge.getState(),
    onEvent: (listener: (event: unknown) => void) => bridge.onEvent(listener),
    onTransportFault: (listener: (fault: ManagedRpcTransportFault) => void) => bridge.onTransportFault(listener),
    sendSupervisorFrame: (frame: Uint8Array) => bridge.sendSupervisorFrame(frame),
    onSupervisorFrame: (listener: (frame: Uint8Array) => void) => bridge.onSupervisorFrame(listener),
    requestGracefulClose: (signal: AbortSignal) => bridge.requestClose(signal),
    forceTerminate: async () => {},
    waitForExit: async () => ({ state: "exited" as const }),
    inspect: async () => ({ state: "released" as const }),
    release: () => bridge.release(),
  });
}

interface FakeRpcState {
  readonly supervisor: {
    readonly state: string;
    readonly pending_reply_count: number;
  };
  readonly endpoint: string;
  readonly localCredential: string;
  readonly agentId: string;
}

async function waitForReplyAcknowledgement(bridge: ManagedRpcBridgeClient): Promise<FakeRpcState> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const state = await bridge.getState();
    if (isFakeRpcState(state)
      && state.supervisor.state === "ready"
      && state.supervisor.pending_reply_count === 0) {
      return state;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("监督回复未在期限内收到 ACK");
}

function isFakeRpcState(value: unknown): value is FakeRpcState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  if (typeof state.supervisor !== "object" || state.supervisor === null || Array.isArray(state.supervisor)) {
    return false;
  }
  const supervisor = state.supervisor as Record<string, unknown>;
  return typeof supervisor.state === "string"
    && Number.isSafeInteger(supervisor.pending_reply_count)
    && typeof state.endpoint === "string"
    && typeof state.localCredential === "string"
    && typeof state.agentId === "string";
}

function encodeFrame(value: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(value));
  const frame = new Uint8Array(body.byteLength + 4);
  new DataView(frame.buffer).setUint32(0, body.byteLength, false);
  frame.set(body, 4);
  return frame;
}

function decodeFrames(bytes: Uint8Array): unknown[] {
  const frames: unknown[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    assert.ok(bytes.byteLength - offset >= 4, "桥接输出不得留下截断长度头");
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
    assert.ok(bytes.byteLength - offset >= length + 4, "桥接输出不得留下截断正文");
    frames.push(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.slice(offset + 4, offset + 4 + length),
    )));
    offset += length + 4;
  }
  return frames;
}
