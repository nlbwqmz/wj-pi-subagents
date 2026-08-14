import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { SupervisorByteTransport } from "./stream-supervisor-channel.ts";

export const LOCAL_SUPERVISOR_CONTROL_PROTOCOL = "wj-pi-subagents/local-control/1" as const;

export const LOCAL_SUPERVISOR_MAX_PREAMBLE_BYTES = 4 * 1024;

const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TRANSPORT_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const UNIX_SOCKET_DIRECTORY_PREFIX = "wj-pi-subagents-local-";
const UNIX_SOCKET_FILENAME = "control.sock";
const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\wj-pi-subagents-local-";

export interface LocalSupervisorListenOptions {
  readonly agentId: string;
  readonly credential: string;
}

export interface LocalSupervisorConnectOptions {
  readonly endpoint: string;
  readonly agentId: string;
  readonly credential: string;
  readonly signal?: AbortSignal;
}

export interface LocalSupervisorTransportListener {
  readonly endpoint: string;

  waitForConnection(signal?: AbortSignal): Promise<SupervisorByteTransport>;

  close(): Promise<void>;
}

export interface LocalSupervisorTransportAdapter {
  listen(options: LocalSupervisorListenOptions): Promise<LocalSupervisorTransportListener>;

  connect(options: LocalSupervisorConnectOptions): Promise<SupervisorByteTransport>;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: Error) => void;
  let done = false;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  // 监听器可以在调用方开始等待前关闭；内部兜底避免产生未处理拒绝。
  void promise.catch(() => {});
  return {
    promise,
    resolve: (value) => {
      if (done) return;
      done = true;
      resolvePromise(value);
    },
    reject: (error) => {
      if (done) return;
      done = true;
      rejectPromise(error);
    },
  };
}

interface SocketTransportResource {
  readonly transport: SupervisorByteTransport;
  destroy(): void;
}

interface PreambleReadResult {
  readonly body: Uint8Array;
  readonly remainder: Uint8Array;
}

/** 使用操作系统本地 IPC：Windows 命名管道，Unix 权限收紧目录内的 socket。 */
export class NativeLocalSupervisorTransportAdapter implements LocalSupervisorTransportAdapter {
  async listen(options: LocalSupervisorListenOptions): Promise<LocalSupervisorTransportListener> {
    assertAuthenticationInput(options.agentId, options.credential);
    let directory: string | undefined;
    let listener: NativeLocalSupervisorTransportListener | undefined;

    try {
      const endpoint = process.platform === "win32"
        ? `${WINDOWS_PIPE_PREFIX}${randomUUID()}`
        : await createUnixSocketEndpoint((value) => {
          directory = value;
        });
      const server = createServer();
      listener = new NativeLocalSupervisorTransportListener(
        endpoint,
        server,
        options.agentId,
        options.credential,
        directory,
      );
      const activeListener = listener;
      server.on("connection", (socket) => activeListener.accept(socket));
      server.on("error", () => activeListener.handleServerFault());
      await startServer(server, endpoint);
      if (directory !== undefined) await chmod(endpoint, 0o600);
      return listener;
    } catch {
      if (listener !== undefined) {
        try {
          await listener.close();
        } catch {
          // 对外只保留稳定错误；关闭过程已尽力清理精确临时目录。
        }
      } else if (directory !== undefined) {
        await removeUnixSocketDirectory(directory);
      }
      throw unavailableError();
    }
  }

  async connect(options: LocalSupervisorConnectOptions): Promise<SupervisorByteTransport> {
    if (options.signal?.aborted === true) throw abortError();
    assertAuthenticationInput(options.agentId, options.credential);
    if (typeof options.endpoint !== "string" || options.endpoint.length === 0) {
      throw unavailableError();
    }

    let socket: Socket | undefined;
    let connected = false;
    try {
      socket = await openSocket(options.endpoint, options.signal);
      connected = true;
      await writeSocket(socket, encodePreamble({
        protocol: LOCAL_SUPERVISOR_CONTROL_PROTOCOL,
        credential: options.credential,
        agent_id: options.agentId,
      }), options.signal);
      const result = await readPreamble(socket, options.signal);
      const acknowledgement = decodeJson(result.body);
      if (!isAcceptedPreamble(acknowledgement)) throw authenticationError();
      return createSocketTransport(socket, result.remainder).transport;
    } catch (error) {
      socket?.destroy();
      if (isAbortError(error)) throw abortError();
      throw connected ? authenticationError() : unavailableError();
    }
  }
}

class NativeLocalSupervisorTransportListener implements LocalSupervisorTransportListener {
  readonly endpoint: string;
  private readonly server: Server;
  private readonly expectedAgentId: string;
  private readonly expectedCredential: string;
  private readonly directory: string | undefined;
  private readonly accepted = deferred<SupervisorByteTransport>();
  private authenticatingSocket: Socket | undefined;
  private acceptedResource: SocketTransportResource | undefined;
  private serverClosePromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private closed = false;

  constructor(
    endpoint: string,
    server: Server,
    expectedAgentId: string,
    expectedCredential: string,
    directory: string | undefined,
  ) {
    this.endpoint = endpoint;
    this.server = server;
    this.expectedAgentId = expectedAgentId;
    this.expectedCredential = expectedCredential;
    this.directory = directory;
  }

  waitForConnection(signal?: AbortSignal): Promise<SupervisorByteTransport> {
    if (this.closed) return Promise.reject(unavailableError());
    return raceAbort(this.accepted.promise, signal);
  }

  accept(socket: Socket): void {
    socket.on("error", ignoreSocketError);
    if (this.closed || this.acceptedResource !== undefined || this.authenticatingSocket !== undefined) {
      socket.destroy();
      return;
    }
    this.authenticatingSocket = socket;
    void this.authenticate(socket);
  }

  handleServerFault(): void {
    if (this.closed) return;
    this.accepted.reject(unavailableError());
    void this.close().catch(() => {});
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closePromise = this.performClose().catch(() => {
      throw unavailableError();
    });
    return this.closePromise;
  }

  private async authenticate(socket: Socket): Promise<void> {
    try {
      const result = await readPreamble(socket);
      const candidate = decodeJson(result.body);
      if (!isAuthenticationPreamble(candidate)) throw authenticationError();
      const credentialAccepted = credentialMatches(candidate.credential, this.expectedCredential);
      if (
        !isTransportCredential(candidate.credential)
        || !isCanonicalAgentId(candidate.agent_id)
        || candidate.agent_id !== this.expectedAgentId
        || !credentialAccepted
      ) {
        throw authenticationError();
      }

      await writeSocket(socket, encodePreamble({
        protocol: LOCAL_SUPERVISOR_CONTROL_PROTOCOL,
        accepted: true,
      }));
      if (this.closed || this.authenticatingSocket !== socket) throw unavailableError();

      const resource = createSocketTransport(socket, result.remainder);
      this.authenticatingSocket = undefined;
      this.acceptedResource = resource;
      this.accepted.resolve(resource.transport);
    } catch {
      if (this.authenticatingSocket === socket) this.authenticatingSocket = undefined;
      socket.destroy();
    }
  }

  private async performClose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.accepted.reject(unavailableError());
    const stopping = this.stopServer();
    this.authenticatingSocket?.destroy();
    this.authenticatingSocket = undefined;
    this.acceptedResource?.destroy();
    this.acceptedResource = undefined;
    await stopping;
    if (this.directory !== undefined) await removeUnixSocketDirectory(this.directory);
  }

  private stopServer(): Promise<void> {
    if (this.serverClosePromise !== undefined) return this.serverClosePromise;
    this.serverClosePromise = new Promise<void>((resolve) => {
      if (!this.server.listening) {
        resolve();
        return;
      }
      try {
        this.server.close(() => resolve());
      } catch {
        resolve();
      }
    });
    return this.serverClosePromise;
  }
}

export const nativeLocalSupervisorTransportAdapter = new NativeLocalSupervisorTransportAdapter();

/** 进程内测试适配器，保持与本地套接字适配器相同的公开生命周期。 */
export class InMemoryLocalSupervisorTransportAdapter implements LocalSupervisorTransportAdapter {
  private readonly listeners = new Map<string, InMemoryLocalSupervisorTransportListener>();

  async listen(options: LocalSupervisorListenOptions): Promise<LocalSupervisorTransportListener> {
    assertAuthenticationInput(options.agentId, options.credential);
    const endpoint = `memory_${randomUUID()}`;
    const listener = new InMemoryLocalSupervisorTransportListener(
      endpoint,
      options.agentId,
      options.credential,
      () => this.listeners.delete(endpoint),
    );
    this.listeners.set(endpoint, listener);
    return listener;
  }

  async connect(options: LocalSupervisorConnectOptions): Promise<SupervisorByteTransport> {
    if (options.signal?.aborted === true) throw abortError();
    const listener = this.listeners.get(options.endpoint);
    if (listener === undefined) throw unavailableError();
    return listener.connect(options);
  }
}

class InMemoryLocalSupervisorTransportListener implements LocalSupervisorTransportListener {
  readonly endpoint: string;
  private readonly expectedAgentId: string;
  private readonly expectedCredential: string;
  private readonly accepted = deferred<SupervisorByteTransport>();
  private readonly unregister: () => void;
  private readonly transports = new Set<SupervisorByteTransport>();
  private connected = false;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(
    endpoint: string,
    expectedAgentId: string,
    expectedCredential: string,
    unregister: () => void,
  ) {
    this.endpoint = endpoint;
    this.expectedAgentId = expectedAgentId;
    this.expectedCredential = expectedCredential;
    this.unregister = unregister;
  }

  waitForConnection(signal?: AbortSignal): Promise<SupervisorByteTransport> {
    if (this.closed) return Promise.reject(unavailableError());
    return raceAbort(this.accepted.promise, signal);
  }

  connect(options: LocalSupervisorConnectOptions): SupervisorByteTransport {
    if (options.signal?.aborted === true) throw abortError();
    const credentialAccepted = credentialMatches(options.credential, this.expectedCredential);
    if (
      this.closed
      || this.connected
      || !isCanonicalAgentId(options.agentId)
      || options.agentId !== this.expectedAgentId
      || !isTransportCredential(options.credential)
      || !credentialAccepted
    ) {
      throw authenticationError();
    }

    const childToParent = new PassThrough();
    const parentToChild = new PassThrough();
    const child = Object.freeze({ stdin: childToParent, stdout: parentToChild });
    const parent = Object.freeze({ stdin: parentToChild, stdout: childToParent });
    this.transports.add(child);
    this.transports.add(parent);
    this.connected = true;
    this.unregister();
    this.accepted.resolve(parent);
    return child;
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closePromise = Promise.resolve();
    this.performClose();
    return this.closePromise;
  }

  private performClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.unregister();
    this.accepted.reject(unavailableError());
    for (const transport of this.transports) {
      transport.stdin.destroy();
      transport.stdout.destroy();
    }
    this.transports.clear();
  }
}

async function createUnixSocketEndpoint(registerDirectory: (directory: string) => void): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), UNIX_SOCKET_DIRECTORY_PREFIX));
  registerDirectory(directory);
  await chmod(directory, 0o700);
  return join(directory, UNIX_SOCKET_FILENAME);
}

async function removeUnixSocketDirectory(directory: string): Promise<void> {
  try {
    // directory 只可能来自本模块刚完成的 mkdtemp，清理范围不会扩张到系统临时目录。
    await rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 10 });
  } catch {
    throw unavailableError();
  }
}

async function startServer(server: Server, endpoint: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      server.removeListener("listening", onListening);
      server.removeListener("error", onError);
    };
    const onListening = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onError = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(unavailableError());
    };
    server.once("listening", onListening);
    server.once("error", onError);
    try {
      server.listen(endpoint);
    } catch {
      onError();
    }
  });
}

async function openSocket(endpoint: string, signal?: AbortSignal): Promise<Socket> {
  if (signal?.aborted === true) throw abortError();
  return new Promise<Socket>((resolve, reject) => {
    let socket: Socket;
    try {
      socket = createConnection(endpoint);
    } catch {
      reject(unavailableError());
      return;
    }
    socket.on("error", ignoreSocketError);
    let settled = false;
    const cleanup = (): void => {
      socket.removeListener("connect", onConnect);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    const succeed = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onConnect = (): void => succeed();
    const onError = (): void => fail(unavailableError());
    const onClose = (): void => fail(unavailableError());
    const onAbort = (): void => fail(abortError());
    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.once("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
  });
}

async function writeSocket(socket: Socket, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) throw abortError();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    const succeed = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onError = (): void => fail(unavailableError());
    const onClose = (): void => fail(unavailableError());
    const onAbort = (): void => fail(abortError());
    socket.once("error", onError);
    socket.once("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    try {
      socket.write(bytes, (error?: Error | null) => {
        if (error === undefined || error === null) succeed();
        else fail(unavailableError());
      });
    } catch {
      fail(unavailableError());
    }
  });
}

async function readPreamble(socket: Socket, signal?: AbortSignal): Promise<PreambleReadResult> {
  if (signal?.aborted === true) throw abortError();
  return new Promise<PreambleReadResult>((resolve, reject) => {
    const header = new Uint8Array(4);
    let headerBytes = 0;
    let body: Uint8Array | undefined;
    let bodyBytes = 0;
    let settled = false;

    const cleanup = (): void => {
      socket.removeListener("data", onData);
      socket.removeListener("end", onUnavailable);
      socket.removeListener("close", onUnavailable);
      socket.removeListener("error", onUnavailable);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      socket.pause();
      cleanup();
      reject(error);
    };
    const succeed = (frame: Uint8Array, remainder: Uint8Array): void => {
      if (settled) return;
      settled = true;
      socket.pause();
      cleanup();
      resolve(Object.freeze({
        body: frame,
        remainder: new Uint8Array(remainder),
      }));
    };
    const onUnavailable = (): void => fail(preambleError());
    const onAbort = (): void => fail(abortError());
    const onData = (chunk: Buffer): void => {
      try {
        const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        let offset = 0;
        while (offset < bytes.byteLength) {
          if (body === undefined) {
            const headerCount = Math.min(4 - headerBytes, bytes.byteLength - offset);
            header.set(bytes.subarray(offset, offset + headerCount), headerBytes);
            headerBytes += headerCount;
            offset += headerCount;
            if (headerBytes < 4) continue;

            const bodyLength = new DataView(header.buffer).getUint32(0, false);
            if (bodyLength === 0 || bodyLength > LOCAL_SUPERVISOR_MAX_PREAMBLE_BYTES) {
              fail(preambleError());
              return;
            }
            body = new Uint8Array(bodyLength);
          }

          const frame = body;
          const bodyCount = Math.min(frame.byteLength - bodyBytes, bytes.byteLength - offset);
          frame.set(bytes.subarray(offset, offset + bodyCount), bodyBytes);
          bodyBytes += bodyCount;
          offset += bodyCount;
          if (bodyBytes === frame.byteLength) {
            succeed(frame, bytes.subarray(offset));
            return;
          }
        }
      } catch {
        fail(preambleError());
      }
    };

    socket.on("data", onData);
    socket.once("end", onUnavailable);
    socket.once("close", onUnavailable);
    socket.once("error", onUnavailable);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    socket.resume();
  });
}

function createSocketTransport(socket: Socket, remainder: Uint8Array): SocketTransportResource {
  const outgoing = new PassThrough();
  const incoming = new PassThrough();
  let destroyed = false;
  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    outgoing.unpipe(socket);
    socket.unpipe(incoming);
    if (!socket.destroyed) socket.destroy();
    if (!outgoing.destroyed) outgoing.destroy();
    if (!incoming.destroyed) incoming.destroy();
  };
  socket.on("error", destroy);
  socket.on("close", destroy);
  outgoing.on("error", destroy);
  outgoing.on("close", destroy);
  incoming.on("error", destroy);
  incoming.on("close", destroy);
  if (remainder.byteLength !== 0) incoming.write(remainder);
  outgoing.pipe(socket);
  socket.pipe(incoming);
  socket.resume();
  return Object.freeze({
    transport: Object.freeze({ stdin: outgoing, stdout: incoming }),
    destroy,
  });
}

function encodePreamble(value: Readonly<Record<string, unknown>>): Uint8Array {
  let body: Buffer;
  try {
    body = Buffer.from(JSON.stringify(value), "utf8");
  } catch {
    throw preambleError();
  }
  if (body.byteLength === 0 || body.byteLength > LOCAL_SUPERVISOR_MAX_PREAMBLE_BYTES) {
    throw preambleError();
  }
  const frame = Buffer.allocUnsafe(4 + body.byteLength);
  frame.writeUInt32BE(body.byteLength, 0);
  body.copy(frame, 4);
  return frame;
}

function decodeJson(body: Uint8Array): unknown {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    return JSON.parse(text) as unknown;
  } catch {
    throw preambleError();
  }
}

function isAuthenticationPreamble(value: unknown): value is {
  readonly protocol: typeof LOCAL_SUPERVISOR_CONTROL_PROTOCOL;
  readonly credential: string;
  readonly agent_id: string;
} {
  return isRecord(value)
    && hasExactKeys(value, ["protocol", "credential", "agent_id"])
    && value.protocol === LOCAL_SUPERVISOR_CONTROL_PROTOCOL
    && typeof value.credential === "string"
    && typeof value.agent_id === "string";
}

function isAcceptedPreamble(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ["protocol", "accepted"])
    && value.protocol === LOCAL_SUPERVISOR_CONTROL_PROTOCOL
    && value.accepted === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function assertAuthenticationInput(agentId: unknown, credential: unknown): void {
  if (!isCanonicalAgentId(agentId) || !isTransportCredential(credential)) {
    throw authenticationError();
  }
}

function isCanonicalAgentId(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_UUID_PATTERN.test(value);
}

function isTransportCredential(value: unknown): value is string {
  return typeof value === "string" && TRANSPORT_CREDENTIAL_PATTERN.test(value);
}

/** 先摘要为固定长度，再以常量时间原语比较，长度差异也不会绕开安全比较。 */
function credentialMatches(actual: unknown, expected: string): boolean {
  const candidate = typeof actual === "string" ? actual : "";
  const actualDigest = createHash("sha256").update(candidate, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  const matched = timingSafeEqual(actualDigest, expectedDigest);
  return typeof actual === "string" && matched;
}

function authenticationError(): Error {
  return new Error("本地监督传输认证失败");
}

function unavailableError(): Error {
  return new Error("本地监督传输不可用");
}

function preambleError(): Error {
  return new Error("本地监督前导无效");
}

function abortError(): Error {
  const error = new Error("本地监督传输已取消");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function ignoreSocketError(): void {
  // 原始套接字错误可能包含端点，永不把该对象暴露到公开传输或异常。
}

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : unavailableError());
      },
    );
  });
}
