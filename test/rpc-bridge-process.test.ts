import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  MANAGED_RPC_BRIDGE_CREDENTIAL_ENV,
  MANAGED_RPC_BRIDGE_MAX_FRAME_BYTES,
  MANAGED_RPC_BRIDGE_PROTOCOL,
} from "../src/managed-rpc-node.ts";

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
