import assert from "node:assert/strict";
import { once } from "node:events";
import { stat } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { dirname } from "node:path";
import test from "node:test";
import {
  InMemoryLocalSupervisorTransportAdapter,
  LOCAL_SUPERVISOR_CONTROL_PROTOCOL,
  LOCAL_SUPERVISOR_MAX_PREAMBLE_BYTES,
  NativeLocalSupervisorTransportAdapter,
} from "../src/local-supervisor-transport.ts";

const AGENT_ID = "550e8400-e29b-41d4-a716-446655440000";
const CREDENTIAL = "local_supervisor_transport_credential_1234";

test("内存适配器认证后提供双向监督字节流", async () => {
  const adapter = new InMemoryLocalSupervisorTransportAdapter();
  const listener = await adapter.listen({ agentId: AGENT_ID, credential: CREDENTIAL });

  try {
    const accepted = listener.waitForConnection();
    const child = await adapter.connect({
      endpoint: listener.endpoint,
      agentId: AGENT_ID,
      credential: CREDENTIAL,
    });
    const parent = await accepted;

    child.stdin.write("child-to-parent");
    const [parentChunk] = await once(parent.stdout, "data");
    assert.equal(parentChunk.toString("utf8"), "child-to-parent");

    parent.stdin.write("parent-to-child");
    const [childChunk] = await once(child.stdout, "data");
    assert.equal(childChunk.toString("utf8"), "parent-to-child");
  } finally {
    await listener.close();
  }
});

test("内存适配器严格校验身份凭据且失败认证不消耗连接", async () => {
  const adapter = new InMemoryLocalSupervisorTransportAdapter();
  const uppercaseAgentId = AGENT_ID.toUpperCase();
  const shortCredential = "short-secret";

  await assert.rejects(
    adapter.listen({ agentId: uppercaseAgentId, credential: CREDENTIAL }),
    (error: unknown) => assertSafeError(error, "本地监督传输认证失败", uppercaseAgentId),
  );
  await assert.rejects(
    adapter.listen({ agentId: AGENT_ID, credential: shortCredential }),
    (error: unknown) => assertSafeError(error, "本地监督传输认证失败", shortCredential),
  );

  const listener = await adapter.listen({ agentId: AGENT_ID, credential: CREDENTIAL });
  try {
    const wrongCredential = `${CREDENTIAL}x`;
    await assert.rejects(
      adapter.connect({
        endpoint: listener.endpoint,
        agentId: AGENT_ID,
        credential: wrongCredential,
      }),
      (error: unknown) => assertSafeError(error, "本地监督传输认证失败", listener.endpoint, wrongCredential),
    );
    await assert.rejects(
      adapter.connect({
        endpoint: listener.endpoint,
        agentId: uppercaseAgentId,
        credential: CREDENTIAL,
      }),
      (error: unknown) => assertSafeError(error, "本地监督传输认证失败", listener.endpoint, CREDENTIAL),
    );

    const accepted = listener.waitForConnection();
    const child = await adapter.connect({
      endpoint: listener.endpoint,
      agentId: AGENT_ID,
      credential: CREDENTIAL,
    });
    const parent = await accepted;
    child.stdin.write("still-available");
    const [chunk] = await once(parent.stdout, "data");
    assert.equal(chunk.toString("utf8"), "still-available");
  } finally {
    await listener.close();
  }
});

test("内存监听等待可取消且关闭会幂等解除未认证等待", { timeout: 1_000 }, async () => {
  const adapter = new InMemoryLocalSupervisorTransportAdapter();
  const listener = await adapter.listen({ agentId: AGENT_ID, credential: CREDENTIAL });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    listener.waitForConnection(controller.signal),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "AbortError");
      return assertSafeError(error, "本地监督传输已取消", listener.endpoint, CREDENTIAL);
    },
  );

  const waiting = listener.waitForConnection();
  const firstClose = listener.close();
  const secondClose = listener.close();
  assert.strictEqual(secondClose, firstClose);
  await assert.rejects(
    adapter.connect({ endpoint: listener.endpoint, agentId: AGENT_ID, credential: CREDENTIAL }),
    (error: unknown) => assertSafeError(error, "本地监督传输不可用", listener.endpoint, CREDENTIAL),
  );
  await Promise.all([firstClose, secondClose]);
  await assert.rejects(
    waiting,
    (error: unknown) => assertSafeError(error, "本地监督传输不可用", listener.endpoint, CREDENTIAL),
  );
});

test("原生监听返回时已就绪并无损交接认证后的双向字节", async () => {
  const adapter = new NativeLocalSupervisorTransportAdapter();
  const listener = await adapter.listen({ agentId: AGENT_ID, credential: CREDENTIAL });

  try {
    if (process.platform === "win32") {
      assert.equal(listener.endpoint.startsWith("\\\\.\\pipe\\wj-pi-subagents-local-"), true);
    }

    const accepted = listener.waitForConnection();
    const childConnecting = adapter.connect({
      endpoint: listener.endpoint,
      agentId: AGENT_ID,
      credential: CREDENTIAL,
    });
    const parent = await accepted;

    // 父端在 child connect 交付前写入，确认认证 ACK 后的首批业务字节不会丢失。
    parent.stdin.write("parent-early-byte");
    const child = await childConnecting;
    const [childChunk] = await once(child.stdout, "data");
    assert.equal(childChunk.toString("utf8"), "parent-early-byte");

    child.stdin.write("child-byte");
    const [parentChunk] = await once(parent.stdout, "data");
    assert.equal(parentChunk.toString("utf8"), "child-byte");
  } finally {
    await listener.close();
  }
});

test("原生前导支持拆分写入并保留同包到达的首批监督字节", async () => {
  const adapter = new NativeLocalSupervisorTransportAdapter();
  const listener = await adapter.listen({ agentId: AGENT_ID, credential: CREDENTIAL });
  let socket: Socket | undefined;

  try {
    socket = await openRawSocket(listener.endpoint);
    const accepted = listener.waitForConnection();
    const frame = encodeTestFrame({
      protocol: LOCAL_SUPERVISOR_CONTROL_PROTOCOL,
      credential: CREDENTIAL,
      agent_id: AGENT_ID,
    });
    await writeRaw(socket, frame.subarray(0, 2));
    await writeRaw(socket, frame.subarray(2, 9));
    await writeRaw(socket, Buffer.concat([
      frame.subarray(9),
      Buffer.from("raw-child-early", "utf8"),
    ]));

    const parent = await accepted;
    assert.deepEqual(await readRawJsonFrame(socket), {
      protocol: LOCAL_SUPERVISOR_CONTROL_PROTOCOL,
      accepted: true,
    });
    const [parentChunk] = await once(parent.stdout, "data");
    assert.equal(parentChunk.toString("utf8"), "raw-child-early");

    parent.stdin.write("raw-parent-byte");
    const [socketChunk] = await once(socket, "data");
    assert.equal(socketChunk.toString("utf8"), "raw-parent-byte");
  } finally {
    socket?.destroy();
    await listener.close();
  }
});

test("原生监听拒绝越界或非白名单前导且不消耗合法连接", async () => {
  const adapter = new NativeLocalSupervisorTransportAdapter();
  const listener = await adapter.listen({ agentId: AGENT_ID, credential: CREDENTIAL });
  const oversizedHeader = Buffer.alloc(4);
  oversizedHeader.writeUInt32BE(LOCAL_SUPERVISOR_MAX_PREAMBLE_BYTES + 1, 0);
  const invalidFrames = [
    Buffer.alloc(4),
    oversizedHeader,
    encodeTestBody(Uint8Array.from([0xc3, 0x28])),
    encodeTestBody(Buffer.from("{", "utf8")),
    encodeTestFrame({
      protocol: "wj-pi-subagents/local-control/999",
      credential: CREDENTIAL,
      agent_id: AGENT_ID,
    }),
    encodeTestFrame({
      protocol: LOCAL_SUPERVISOR_CONTROL_PROTOCOL,
      credential: CREDENTIAL,
      agent_id: AGENT_ID,
      unexpected: true,
    }),
    encodeTestFrame({
      protocol: LOCAL_SUPERVISOR_CONTROL_PROTOCOL,
      credential: CREDENTIAL,
      agent_id: AGENT_ID.toUpperCase(),
    }),
    encodeTestFrame({
      protocol: LOCAL_SUPERVISOR_CONTROL_PROTOCOL,
      credential: `${CREDENTIAL}x`,
      agent_id: AGENT_ID,
    }),
  ];

  try {
    for (const frame of invalidFrames) await sendRejectedRawFrame(listener.endpoint, frame);

    const accepted = listener.waitForConnection();
    const child = await adapter.connect({
      endpoint: listener.endpoint,
      agentId: AGENT_ID,
      credential: CREDENTIAL,
    });
    const parent = await accepted;
    child.stdin.write("valid-after-invalid");
    const [chunk] = await once(parent.stdout, "data");
    assert.equal(chunk.toString("utf8"), "valid-after-invalid");
  } finally {
    await listener.close();
  }
});

test("原生监听关闭幂等解除等待并清理平台端点", async () => {
  const adapter = new NativeLocalSupervisorTransportAdapter();
  const listener = await adapter.listen({ agentId: AGENT_ID, credential: CREDENTIAL });
  const directory = process.platform === "win32" ? undefined : dirname(listener.endpoint);

  if (directory !== undefined) {
    const [directoryInfo, socketInfo] = await Promise.all([
      stat(directory),
      stat(listener.endpoint),
    ]);
    assert.equal(directoryInfo.mode & 0o777, 0o700);
    assert.equal(socketInfo.mode & 0o777, 0o600);
  }

  const waiting = listener.waitForConnection();
  const firstClose = listener.close();
  const secondClose = listener.close();
  assert.strictEqual(secondClose, firstClose);
  await firstClose;
  await assert.rejects(
    waiting,
    (error: unknown) => assertSafeError(error, "本地监督传输不可用", listener.endpoint, CREDENTIAL),
  );
  await assert.rejects(
    adapter.connect({ endpoint: listener.endpoint, agentId: AGENT_ID, credential: CREDENTIAL }),
    (error: unknown) => assertSafeError(error, "本地监督传输不可用", listener.endpoint, CREDENTIAL),
  );

  if (directory !== undefined) {
    await assertMissing(listener.endpoint);
    await assertMissing(directory);
  }
});

test("原生凭据只消费一次且认证与重连错误保持脱敏", { timeout: 2_000 }, async () => {
  const adapter = new NativeLocalSupervisorTransportAdapter();
  const listener = await adapter.listen({ agentId: AGENT_ID, credential: CREDENTIAL });
  const wrongCredential = "wrong_local_supervisor_transport_credential_9999";

  try {
    await assert.rejects(
      adapter.connect({
        endpoint: listener.endpoint,
        agentId: AGENT_ID,
        credential: wrongCredential,
      }),
      (error: unknown) => assertSafeError(
        error,
        "本地监督传输认证失败",
        listener.endpoint,
        CREDENTIAL,
        wrongCredential,
      ),
    );

    const accepted = listener.waitForConnection();
    await adapter.connect({
      endpoint: listener.endpoint,
      agentId: AGENT_ID,
      credential: CREDENTIAL,
    });
    const parent = await accepted;
    assert.strictEqual(await listener.waitForConnection(), parent);

    await assert.rejects(
      adapter.connect({
        endpoint: listener.endpoint,
        agentId: AGENT_ID,
        credential: CREDENTIAL,
      }),
      (error: unknown) => assertSafeErrorOneOf(
        error,
        ["本地监督传输不可用", "本地监督传输认证失败"],
        listener.endpoint,
        CREDENTIAL,
      ),
    );
  } finally {
    await listener.close();
  }
});

test("原生等待与连接取消不关闭监听或消费凭据", async () => {
  const adapter = new NativeLocalSupervisorTransportAdapter();
  const listener = await adapter.listen({ agentId: AGENT_ID, credential: CREDENTIAL });

  try {
    const waitingController = new AbortController();
    const cancelledWaiting = listener.waitForConnection(waitingController.signal);
    waitingController.abort();
    await assert.rejects(
      cancelledWaiting,
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, "AbortError");
        return assertSafeError(error, "本地监督传输已取消", listener.endpoint, CREDENTIAL);
      },
    );

    const connectController = new AbortController();
    connectController.abort();
    await assert.rejects(
      adapter.connect({
        endpoint: listener.endpoint,
        agentId: AGENT_ID,
        credential: CREDENTIAL,
        signal: connectController.signal,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, "AbortError");
        return assertSafeError(error, "本地监督传输已取消", listener.endpoint, CREDENTIAL);
      },
    );

    const accepted = listener.waitForConnection();
    await adapter.connect({
      endpoint: listener.endpoint,
      agentId: AGENT_ID,
      credential: CREDENTIAL,
    });
    await accepted;
  } finally {
    await listener.close();
  }
});

function assertSafeError(error: unknown, message: string, ...secrets: readonly string[]): boolean {
  assert.ok(error instanceof Error);
  assert.equal(error.message, message);
  const exposed = `${error.name}\n${error.message}\n${error.stack ?? ""}`;
  for (const secret of secrets) assert.equal(exposed.includes(secret), false);
  return true;
}

function assertSafeErrorOneOf(
  error: unknown,
  messages: readonly string[],
  ...secrets: readonly string[]
): boolean {
  assert.ok(error instanceof Error);
  assert.equal(messages.includes(error.message), true);
  const exposed = `${error.name}\n${error.message}\n${error.stack ?? ""}`;
  for (const secret of secrets) assert.equal(exposed.includes(secret), false);
  return true;
}

async function openRawSocket(endpoint: string): Promise<Socket> {
  const socket = createConnection(endpoint);
  socket.on("error", () => {});
  await once(socket, "connect");
  return socket;
}

function encodeTestFrame(value: Readonly<Record<string, unknown>>): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  return encodeTestBody(body);
}

function encodeTestBody(body: Uint8Array): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.byteLength, 0);
  return Buffer.concat([header, body]);
}

async function sendRejectedRawFrame(endpoint: string, frame: Uint8Array): Promise<void> {
  const socket = await openRawSocket(endpoint);
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  try {
    await writeRaw(socket, frame);
  } catch {
    // 服务端可在本地写回调前完成拒绝；候选连接关闭才是公开结果。
  }
  await closed;
}

async function writeRaw(socket: Socket, bytes: Uint8Array): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.write(bytes, (error?: Error | null) => {
      if (error === undefined || error === null) resolve();
      else reject(error);
    });
  });
}

async function readRawJsonFrame(socket: Socket): Promise<unknown> {
  let buffered = Buffer.alloc(0);
  while (buffered.byteLength < 4) {
    const [chunk] = await once(socket, "data");
    buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
  }
  const bodyLength = buffered.readUInt32BE(0);
  while (buffered.byteLength < bodyLength + 4) {
    const [chunk] = await once(socket, "data");
    buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
  }
  return JSON.parse(buffered.subarray(4, bodyLength + 4).toString("utf8")) as unknown;
}

async function assertMissing(path: string): Promise<void> {
  await assert.rejects(
    stat(path),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT",
  );
}
