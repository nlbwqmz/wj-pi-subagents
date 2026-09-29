import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  MANAGED_RPC_BRIDGE_CREDENTIAL_ENV,
  ManagedRpcBridgeClient,
} from "../src/managed-rpc-node.ts";

const BRIDGE_CREDENTIAL = "bridge-activity-credential-0123456789abcdef";
const AGENT_ID = "550e8400-e29b-41d4-a716-446655440000";

interface BridgeSession {
  readonly process: ChildProcessWithoutNullStreams;
  readonly client: ManagedRpcBridgeClient;
  close(): Promise<void>;
}

function startBridge(events: readonly unknown[]): BridgeSession {
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
      piModulePath: new URL("./helpers/scripted-pi-rpc-client.mjs", import.meta.url).href,
      events,
    },
  });
  const close = async (): Promise<void> => {
    await client.requestClose(AbortSignal.timeout(2_000)).catch(() => {});
    await client.release();
    if (bridge.exitCode === null) bridge.kill();
  };
  return { process: bridge, client, close };
}

test("真实桥接进程把加宽的活动事件闭集传给父端，大正文不再被拒绝", async () => {
  const oversized = { text: "x".repeat(64 * 1024) };
  const session = startBridge([
    { type: "agent_start" },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "先读文件", signature: "不得透传" },
          { type: "text", text: "开始处理" },
        ],
      },
    },
    {
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "read",
      args: { path: "src/a.ts" },
    },
    {
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "read",
      result: { lines: ["const a = 1;"], truncated: false },
      isError: false,
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "thinking", thinking: "跳过的空块" },
        ],
      },
    },
    {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: oversized.text }] },
    },
    { type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "结果" }] } },
    { type: "agent_settled" },
  ]);
  try {
    const received: unknown[] = [];
    const unsubscribe = session.client.onEvent((event) => received.push(event));
    const abort = AbortSignal.timeout(2_000);
    const started = await session.client.start(abort);
    assert.equal(started, undefined);
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    unsubscribe();

    assert.deepEqual(received, [
      { type: "agent_start" },
      {
        type: "message",
        content: [
          { type: "thinking", thinking: "先读文件" },
          { type: "text", text: "开始处理" },
        ],
      },
      {
        type: "tool_execution_start",
        toolCallId: "call_1",
        toolName: "read",
        origin: "unknown",
      },
      {
        type: "tool_execution_end",
        toolCallId: "call_1",
        toolName: "read",
        origin: "unknown",
        isError: false,
      },
      // 空 text 块被跳过，非空 thinking 块保留。
      {
        type: "message",
        content: [{ type: "thinking", thinking: "跳过的空块" }],
      },
      // 超过桥接帧预算的完整正文不经 RPC 桥路径发送（静默缺失）；
      // 权威传输由监督通道分块上行。
      { type: "agent_settled" },
    ]);
  } finally {
    await session.close();
  }
});

test("真实桥接进程按到达顺序转发失败与半句输出条目且不使通道进故障", async () => {
  const session = startBridge([
    // 正文为空且以错误收尾的收尾消息：失败事实不再在桥接层被整条丢弃。
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        stopReason: "error",
        errorMessage: "401 unauthorized\nx-request-id: abc",
        usage: { input: 12, output: 0 },
        diagnostics: [{ type: "provider" }],
        rawStopReason: "invalid_request_error",
      },
    },
    // 正文非空的失败消息：正文与失败两条独立条目，正文在前。
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "半句输出" }],
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        stopReason: "error",
        errorMessage: "401 unauthorized",
      },
    },
    // 已中止且无错误文本：同样登记失败条目，文本落到兜底文案。
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        stopReason: "aborted",
      },
    },
  ]);
  const faults: unknown[] = [];
  const unsubscribeFault = session.client.onTransportFault((fault) => faults.push(fault));
  try {
    const received: unknown[] = [];
    const unsubscribe = session.client.onEvent((event) => received.push(event));
    await session.client.start(AbortSignal.timeout(2_000));
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    unsubscribe();

    assert.deepEqual(received, [
      {
        type: "model_call_failure",
        failure: "error",
        message: "401 unauthorized\nx-request-id: abc",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
      },
      { type: "message", content: [{ type: "text", text: "半句输出" }] },
      {
        type: "model_call_failure",
        failure: "error",
        message: "401 unauthorized",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
      },
      {
        type: "model_call_failure",
        failure: "aborted",
        message: "Unknown error",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
      },
    ]);
    assert.deepEqual(faults, []);
  } finally {
    unsubscribeFault();
    await session.close();
  }
});

test("真实桥接进程不再观察流式增量：display 草稿由子代理运行时扩展沿监督通道上行", async () => {
  const session = startBridge([
    {
      type: "message_start",
      message: { role: "assistant", content: [] },
    },
    {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" },
    },
    {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "plan" },
    },
    {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "" },
    },
    {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(20_000) },
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Hello" },
          { type: "thinking", thinking: "plan" },
        ],
      },
    },
  ]);
  try {
    const received: unknown[] = [];
    const unsubscribe = session.client.onEvent((event) => received.push(event));
    await session.client.start(AbortSignal.timeout(2_000));
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    unsubscribe();

    // 流式增量（包括空 delta 与超预算 delta）都不再产生桥接显示事件；
    // 完整消息闭集独立输出，权威传输由监督通道分块上行。
    assert.deepEqual(received, [
      {
        type: "message",
        content: [
          { type: "text", text: "Hello" },
          { type: "thinking", thinking: "plan" },
        ],
      },
    ]);
  } finally {
    await session.close();
  }
});

test("真实桥接进程忽略禁用块与未知块，仅在结构违约时关闭传输", async () => {
  // 禁用与未知块逐块忽略：不跨进程、也不中断会话。
  const ignored = startBridge([
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "future_secret_block", secret: "不得静默丢弃" },
          { type: "image", source: "不得跨进程" },
          { type: "text", text: "可见正文" },
        ],
      },
    },
  ]);
  try {
    const received: unknown[] = [];
    const unsubscribe = ignored.client.onEvent((event) => received.push(event));
    await ignored.client.start(AbortSignal.timeout(2_000));
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    unsubscribe();
    assert.deepEqual(received, [
      { type: "message", content: [{ type: "text", text: "可见正文" }] },
    ]);
  } finally {
    await ignored.close();
  }

  // 真正的结构违约（content 非数组）仍按既有语义关闭传输。
  const faulted = startBridge([
    {
      type: "message_end",
      message: { role: "assistant", content: "not-an-array" },
    },
  ]);
  const faults: unknown[] = [];
  const unsubscribeFault = faulted.client.onTransportFault((fault) => faults.push(fault));
  try {
    const abort = AbortSignal.timeout(2_000);
    await faulted.client.start(abort).catch(() => {});
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(faults, ["protocol_fault"]);
  } finally {
    unsubscribeFault();
    await faulted.close();
  }
});

test("真实桥接进程拒绝超过 64 KiB 的 prompt/steer 命令正文", async () => {
  const session = startBridge([]);
  try {
    await session.client.start(AbortSignal.timeout(2_000));
    const exact = "x".repeat(64 * 1024);
    await session.client.prompt(exact);
    await assert.rejects(() => session.client.prompt(`${exact}x`), /桥接命令失败/u);
    await assert.rejects(() => session.client.steer(`${exact}x`), /桥接命令失败/u);
  } finally {
    await session.close();
  }
});

void AGENT_ID;
