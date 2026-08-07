/**
 * 受管 RPC 桥接进程入口。
 *
 * 该文件由 `ProcessTreeAdapter.launch()` 启动。它是 Pi `RpcClient` 的唯一
 * 拥有者，stdin/stdout 只承载本模块定义的有界高层帧；Pi JSONL 永远不会被
 * 转发给父监督器。
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  MANAGED_RPC_BRIDGE_CREDENTIAL_ENV,
  MANAGED_RPC_BRIDGE_COMMAND_CHUNK_BYTES,
  MANAGED_RPC_BRIDGE_MAX_COMMAND_PAYLOAD_BYTES,
  MANAGED_RPC_BRIDGE_MAX_FRAME_BYTES,
  MANAGED_RPC_BRIDGE_PROTOCOL,
  MANAGED_RPC_SUPERVISOR_MAX_FRAME_BYTES,
  type ManagedRpcSupervisorInit,
} from "./managed-rpc-node.ts";
import { LengthPrefixedFrameDecoder } from "./length-prefixed-frame-decoder.ts";
import {
  nativeLocalSupervisorTransportAdapter,
  type LocalSupervisorTransportListener,
} from "./local-supervisor-transport.ts";
import { normalizeRpcBridgeEvent } from "./rpc-bridge-event.ts";
import { RUNTIME_EPHEMERAL_ENV_KEYS } from "./root-runtime-context.ts";
import type { SupervisorByteTransport } from "./stream-supervisor-channel.ts";

const MAX_FRAME_BYTES = MANAGED_RPC_BRIDGE_MAX_FRAME_BYTES;
const PROTOCOL = MANAGED_RPC_BRIDGE_PROTOCOL;
const CREDENTIAL_ENV = MANAGED_RPC_BRIDGE_CREDENTIAL_ENV;
const MAX_MESSAGE_BYTES = 16 * 1024;
const MAX_IMAGE_BYTES = 24 * 1024;

interface BridgeClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  prompt(message: string, images?: readonly ManagedImage[]): Promise<void>;
  steer(message: string, images?: readonly ManagedImage[]): Promise<void>;
  abort(): Promise<void>;
  getState(): Promise<unknown>;
  onEvent(listener: (event: unknown) => void): () => void;
}

interface ManagedImage {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

interface BridgeCommand {
  readonly kind: "command";
  readonly id: number;
  readonly command: string;
  readonly payload?: unknown;
}

interface PendingChunkedCommand {
  readonly id: number;
  readonly command: string;
  readonly chunkCount: number;
  readonly chunks: Uint8Array[];
  byteLength: number;
  nextChunkIndex: number;
}

interface TemplatePromptConfig {
  readonly mode: "append" | "replace";
  readonly body: string;
}

const decoder = new LengthPrefixedFrameDecoder(MAX_FRAME_BYTES);
let client: BridgeClient | undefined;
let stopping = false;
let protocolFailed = false;
let faultSent = false;
let authenticated = false;
let started = false;
let lastCommandId = 0;
let commandQueue: Promise<void> = Promise.resolve();
let outputQueue: Promise<void> = Promise.resolve();
let exitScheduled = false;
let config: Record<string, unknown> = {};
let pendingChunkedCommand: PendingChunkedCommand | undefined;
let templatePromptDirectory: string | undefined;
let supervisorListener: LocalSupervisorTransportListener | undefined;
let supervisorTransport: SupervisorByteTransport | undefined;
let supervisorWriteQueue: Promise<void> = Promise.resolve();
let supervisorTransportEnded = false;
let childSupervisorEnvironment: Record<string, string> | undefined;
const configuredCredential = process.env[CREDENTIAL_ENV];
// 凭据只用于桥接首帧认证；Pi RpcClient 不应继承它。
try {
  delete process.env[CREDENTIAL_ENV];
} catch {
  // 某些受限宿主可能禁止修改 process.env；此时仍不把值写入协议载荷。
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function writeFrame(value: unknown): void {
  const body = new TextEncoder().encode(JSON.stringify(value));
  if (body.byteLength > MAX_FRAME_BYTES) throw new Error("桥接帧超限");
  const frame = new Uint8Array(body.byteLength + 4);
  new DataView(frame.buffer).setUint32(0, body.byteLength, false);
  frame.set(body, 4);
  outputQueue = outputQueue.then(
    () => writeOutput(frame),
    () => writeOutput(frame),
  );
}

function writeOutput(frame: Uint8Array): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      process.stdout.removeListener("close", finish);
      process.stdout.removeListener("error", finish);
      resolve();
    };
    process.stdout.once("close", finish);
    process.stdout.once("error", finish);
    try {
      process.stdout.write(frame, finish);
    } catch {
      finish();
    }
  });
}

function response(id: number, ok: boolean, data?: unknown): void {
  if (protocolFailed) return;
  writeFrame({
    protocol: PROTOCOL,
    kind: "response",
    id,
    ok,
    ...(data === undefined ? {} : { data }),
  });
}

function fault(faultCode: "protocol_fault" | "process_exit" | "eof"): void {
  if (faultSent) return;
  faultSent = true;
  try {
    writeFrame({ protocol: PROTOCOL, kind: "fault", fault: faultCode });
  } catch {
    // stdout 已关闭时无法再上报，进程退出仍由平台树观察确认。
  }
}

function failAndExit(faultCode: "protocol_fault" | "process_exit"): void {
  if (exitScheduled) return;
  exitScheduled = true;
  stopping = true;
  protocolFailed = true;
  decoder.reset();
  pendingChunkedCommand = undefined;
  cleanupTemplatePromptFile();
  process.stdin.pause();
  fault(faultCode);
  void Promise.allSettled([
    flushOutput(),
    closeLocalSupervisor(),
    client?.stop() ?? Promise.resolve(),
  ]).finally(() => process.exit(1));
}

function emitEvent(event: unknown): void {
  if (stopping) return;
  try {
    writeFrame({ protocol: PROTOCOL, kind: "event", event });
  } catch {
    failAndExit("protocol_fault");
  }
}

function emitSupervisorFrame(frame: Uint8Array): void {
  if (stopping || protocolFailed) return;
  if (frame.byteLength === 0 || frame.byteLength > MANAGED_RPC_SUPERVISOR_MAX_FRAME_BYTES) {
    failAndExit("protocol_fault");
    return;
  }
  try {
    writeFrame({
      protocol: PROTOCOL,
      kind: "supervisor_frame",
      frame: Buffer.from(frame).toString("base64url"),
    });
  } catch {
    failAndExit("protocol_fault");
  }
}

function emitSupervisorBytes(bytes: Uint8Array): void {
  if (bytes.byteLength === 0) return;
  for (let offset = 0; offset < bytes.byteLength; offset += MANAGED_RPC_SUPERVISOR_MAX_FRAME_BYTES) {
    emitSupervisorFrame(bytes.subarray(
      offset,
      Math.min(bytes.byteLength, offset + MANAGED_RPC_SUPERVISOR_MAX_FRAME_BYTES),
    ));
  }
}

function bindSupervisorTransport(transport: SupervisorByteTransport): void {
  if (supervisorTransport !== undefined) throw new Error("本地监督传输已绑定");
  supervisorTransport = transport;
  transport.stdout.on("data", (chunk: Uint8Array | string) => {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
    emitSupervisorBytes(bytes);
  });
  const onEnd = (): void => {
    if (supervisorTransportEnded) return;
    supervisorTransportEnded = true;
    if (!stopping) failAndExit("process_exit");
  };
  transport.stdout.on("end", onEnd);
  transport.stdout.on("close", onEnd);
  transport.stdout.on("error", () => {
    if (!stopping) failAndExit("protocol_fault");
  });
  transport.stdin.on("error", () => {
    if (!stopping) failAndExit("protocol_fault");
  });
}

function forwardSupervisorBytes(bytes: Uint8Array): void {
  const transport = supervisorTransport;
  if (transport === undefined || supervisorTransportEnded) {
    failAndExit("protocol_fault");
    return;
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const write = supervisorWriteQueue.catch(() => {}).then(() => new Promise<void>((resolve, reject) => {
    try {
      transport.stdin.write(copy, (error?: Error | null) => {
        if (error === undefined || error === null) resolve();
        else reject(error);
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error("本地监督写入失败"));
    }
  }));
  supervisorWriteQueue = write.catch(() => {});
  void write.catch(() => failAndExit("protocol_fault"));
}

function installChildSupervisorEnvironment(
  endpoint: string,
  localCredential: string,
  supervisorCredential: string,
): void {
  const values = {
    [RUNTIME_EPHEMERAL_ENV_KEYS.supervisorEndpoint]: endpoint,
    [RUNTIME_EPHEMERAL_ENV_KEYS.localSupervisorCredential]: localCredential,
    [RUNTIME_EPHEMERAL_ENV_KEYS.supervisorCredential]: supervisorCredential,
  };
  childSupervisorEnvironment = values;
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
}

function clearBridgeSupervisorEnvironment(): void {
  childSupervisorEnvironment = undefined;
  for (const key of Object.values(RUNTIME_EPHEMERAL_ENV_KEYS)) {
    try {
      delete process.env[key];
    } catch {
      // 受限宿主可能禁止删除；RpcClient 已经完成唯一一次 spawn。
    }
  }
}

function createTemplatePromptFile(prompt: TemplatePromptConfig): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-subagent-prompt-"));
  const filePath = join(directory, "system-prompt.txt");
  try {
    writeFileSync(filePath, prompt.body, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    } catch {
      // 原始写入错误是唯一可归类的启动失败原因。
    }
    throw error;
  }
  templatePromptDirectory = directory;
  return filePath;
}

function cleanupTemplatePromptFile(): void {
  const directory = templatePromptDirectory;
  templatePromptDirectory = undefined;
  if (directory === undefined) return;
  try {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  } catch {
    // 临时文件无法删除不能改变子进程或监督协议状态；退出后由系统回收。
  }
}

async function closeLocalSupervisor(): Promise<void> {
  const listener = supervisorListener;
  supervisorListener = undefined;
  supervisorTransport = undefined;
  supervisorTransportEnded = true;
  clearBridgeSupervisorEnvironment();
  if (listener !== undefined) await listener.close();
}

function parseArgs(): void {
  // 兼容旧 bridge 入口；生产节点已改为在首个有界 start 命令中传递配置，
  // 防止模板正文因 Windows 命令行编码膨胀而无法启动。
  const index = process.argv.indexOf("--config");
  const encoded = index >= 0 ? process.argv[index + 1] : undefined;
  if (encoded === undefined) return;
  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(decoded);
    if (isRecord(parsed)) config = parsed;
  } catch {
    config = {};
  }
}

function normalizeBridgeConfig(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["rpc"]) || !isRecord(value.rpc)) return undefined;
  return Object.freeze({ rpc: Object.freeze({ ...value.rpc }) });
}

function normalizeTemplatePrompt(value: unknown): TemplatePromptConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !hasOnlyKeys(value, ["mode", "body"])) return undefined;
  if ((value.mode !== "append" && value.mode !== "replace") || typeof value.body !== "string") {
    return undefined;
  }
  return Object.freeze({ mode: value.mode, body: value.body });
}

function normalizeSupervisorInit(value: unknown): ManagedRpcSupervisorInit | undefined {
  if (!isRecord(value)) return undefined;
  const allowed = new Set([
    "root_id",
    "local_agent_id",
    "peer_agent_id",
    "parent_agent_id",
    "depth",
    "credential",
    "initial_snapshot",
    "initial_subtree_revision",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  if (
    typeof value.root_id !== "string"
    || !/^[A-Za-z0-9_-]{1,128}$/.test(value.root_id)
    || typeof value.local_agent_id !== "string"
    || !isCanonicalUuid(value.local_agent_id)
    || typeof value.peer_agent_id !== "string"
    || (value.peer_agent_id !== "" && !isCanonicalUuid(value.peer_agent_id))
    || (value.parent_agent_id !== null && !isCanonicalUuid(value.parent_agent_id))
    || !Number.isSafeInteger(value.depth)
    || (value.depth as number) < 1
    || (value.depth as number) > 8
    || typeof value.credential !== "string"
    || !/^[A-Za-z0-9_-]{32,128}$/.test(value.credential)
    || !Array.isArray(value.initial_snapshot)
    || value.initial_snapshot.length === 0
    || value.initial_snapshot.length > 64
    || !Number.isSafeInteger(value.initial_subtree_revision)
    || (value.initial_subtree_revision as number) < 0
  ) return undefined;
  try {
    return Object.freeze({
      root_id: value.root_id,
      local_agent_id: value.local_agent_id,
      peer_agent_id: value.peer_agent_id,
      parent_agent_id: value.parent_agent_id as string | null,
      depth: value.depth as number,
      credential: value.credential,
      initial_snapshot: Object.freeze(value.initial_snapshot.map((node) => {
        if (!isRecord(node)) throw new Error("快照节点无效");
        return Object.freeze({ ...node }) as never;
      })),
      initial_subtree_revision: value.initial_subtree_revision as number,
    });
  } catch {
    return undefined;
  }
}

function normalizeImages(value: unknown): ManagedImage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const images: ManagedImage[] = [];
  for (const item of value) {
    if (!isRecord(item) || item.type !== "image" || typeof item.data !== "string" || typeof item.mimeType !== "string") {
      return undefined;
    }
    if (
      images.length >= 8
      || !validBase64(item.data)
      || decodedBase64Length(item.data) > MAX_IMAGE_BYTES
      || !/^image\/[a-z0-9.+-]+$/.test(item.mimeType)
    ) {
      return undefined;
    }
    if (!Object.keys(item).every((key) => key === "type" || key === "data" || key === "mimeType")) {
      return undefined;
    }
    images.push({ type: "image", data: item.data, mimeType: item.mimeType });
  }
  return images;
}

async function ensureClient(): Promise<BridgeClient> {
  if (client !== undefined) return client;
  const options = isRecord(config.rpc) ? config.rpc : {};
  const configuredCliPath = typeof options.cliPath === "string" && options.cliPath.length > 0
    ? options.cliPath
    : undefined;
  const cliPath = configuredCliPath ?? defaultPiCliPath();
  const configuredModulePath = typeof options.piModulePath === "string" && options.piModulePath.length > 0
    ? options.piModulePath
    : undefined;
  const moduleSpecifier = configuredModulePath === undefined
    ? (configuredCliPath === undefined || cliPath === undefined
      ? undefined
      : pathToFileURL(join(dirname(cliPath), "index.js")).href)
    : toModuleSpecifier(configuredModulePath);
  const piModule = moduleSpecifier === undefined
    ? await import("@earendil-works/pi-coding-agent")
    : await import(moduleSpecifier);
  const { RpcClient } = piModule;
  const {
    piModulePath: _piModulePath,
    templatePrompt: rawTemplatePrompt,
    args: rawArgs,
    ...clientRpcOptions
  } = options;
  const templatePrompt = normalizeTemplatePrompt(rawTemplatePrompt);
  if (rawTemplatePrompt !== undefined && templatePrompt === undefined) {
    throw new Error("模板提示配置无效");
  }
  if (rawArgs !== undefined && (!Array.isArray(rawArgs) || rawArgs.some((arg) => typeof arg !== "string"))) {
    throw new Error("Pi RPC 参数无效");
  }
  const args = rawArgs === undefined ? [] : [...rawArgs];
  if (templatePrompt !== undefined) {
    args.push(
      templatePrompt.mode === "replace" ? "--system-prompt" : "--append-system-prompt",
      createTemplatePromptFile(templatePrompt),
    );
  }
  const configuredEnvironment = isRecord(options.env)
    ? Object.fromEntries(Object.entries(options.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ))
    : {};
  const clientOptions = {
    ...clientRpcOptions,
    ...(args.length === 0 ? {} : { args }),
    ...(cliPath === undefined ? {} : { cliPath }),
    env: {
      ...configuredEnvironment,
      ...(childSupervisorEnvironment ?? {}),
    },
  };
  try {
    client = new RpcClient(clientOptions as never) as unknown as BridgeClient;
  } catch (error) {
    cleanupTemplatePromptFile();
    throw error;
  }
  client.onEvent((event) => {
    const normalized = normalizeRpcBridgeEvent(event);
    if (normalized.kind === "invalid") {
      failAndExit("protocol_fault");
      return;
    }
    if (normalized.kind === "event") emitEvent(normalized.event);
  });
  return client;
}

function toModuleSpecifier(value: string): string {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return value;
  return pathToFileURL(value).href;
}

function defaultPiCliPath(): string | undefined {
  try {
    const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
    return fileURLToPath(new URL("./cli.js", entry));
  } catch {
    return undefined;
  }
}

async function handleCommand(command: BridgeCommand): Promise<void> {
  if (
    !Number.isSafeInteger(command.id)
    || command.id <= 0
    || command.id <= lastCommandId
    || typeof command.command !== "string"
    || !["start", "prompt", "steer", "abort", "get_state", "close"].includes(command.command)
  ) {
    failAndExit("protocol_fault");
    return;
  }
  lastCommandId = command.id;
  try {
    if (command.command === "start") {
      if (started || authenticated || configuredCredential === undefined) {
        failAndExit("protocol_fault");
        return;
      }
      if (!isRecord(command.payload) || typeof command.payload.credential !== "string"
        || command.payload.credential.length < 32
        || command.payload.credential !== configuredCredential
        || Object.keys(command.payload).some((key) => (
          key !== "credential" && key !== "supervisor" && key !== "config"
        ))) {
        failAndExit("protocol_fault");
        return;
      }
      const supervisorInit = command.payload.supervisor === undefined
        ? undefined
        : normalizeSupervisorInit(command.payload.supervisor);
      const bridgeConfig = command.payload.config === undefined
        ? undefined
        : normalizeBridgeConfig(command.payload.config);
      if (
        (command.payload.supervisor !== undefined && supervisorInit === undefined)
        || (command.payload.config !== undefined && bridgeConfig === undefined)
      ) {
        failAndExit("protocol_fault");
        return;
      }
      if (bridgeConfig !== undefined) config = bridgeConfig;
      authenticated = true;
      started = true;
      if (supervisorInit !== undefined) {
        const localCredential = randomBytes(32).toString("base64url");
        supervisorListener = await nativeLocalSupervisorTransportAdapter.listen({
          agentId: supervisorInit.local_agent_id,
          credential: localCredential,
        });
        installChildSupervisorEnvironment(
          supervisorListener.endpoint,
          localCredential,
          supervisorInit.credential,
        );
      }
      const current = await ensureClient();
      const connection = supervisorListener?.waitForConnection();
      try {
        await current.start();
        if (connection !== undefined) bindSupervisorTransport(await connection);
        // RpcClient.start() 仅确认子进程已经存活；等待一次只读 RPC 响应，
        // 确保 Pi 已完成资源读取后再删除短生命周期的模板提示文件。
        if (templatePromptDirectory !== undefined) await current.getState();
      } finally {
        cleanupTemplatePromptFile();
        clearBridgeSupervisorEnvironment();
      }
      response(command.id, true);
      return;
    }
    if (!authenticated || !started || stopping) {
      response(command.id, false);
      return;
    }
    const current = await ensureClient();
    if (command.command === "prompt" || command.command === "steer") {
      if (!isRecord(command.payload) || typeof command.payload.message !== "string"
        || command.payload.message.length === 0
        || new TextEncoder().encode(command.payload.message).byteLength > MAX_MESSAGE_BYTES) {
        response(command.id, false);
        return;
      }
      const images = command.payload.images === undefined ? undefined : normalizeImages(command.payload.images);
      if (command.payload.images !== undefined && images === undefined) {
        response(command.id, false);
        return;
      }
      if (command.command === "prompt") await current.prompt(command.payload.message, images);
      else await current.steer(command.payload.message, images);
      response(command.id, true);
      return;
    }
    if (command.command === "abort") {
      await current.abort();
      response(command.id, true);
      return;
    }
    if (command.command === "get_state") {
      response(command.id, true, await current.getState());
      return;
    }
    if (command.command === "close") {
      stopping = true;
      await current.stop();
      cleanupTemplatePromptFile();
      await closeLocalSupervisor();
      response(command.id, true);
      await flushOutput();
      exitScheduled = true;
      process.exit(0);
      return;
    }
    response(command.id, false);
  } catch {
    if (command.command === "start") {
      cleanupTemplatePromptFile();
      try {
        await closeLocalSupervisor();
      } catch {
        // 启动失败仍只返回固定桥接失败，不泄露本地端点。
      }
    }
    response(command.id, false);
  }
}

function enqueueCommand(command: BridgeCommand): void {
  commandQueue = commandQueue
    .then(() => handleCommand(command))
    .catch(() => failAndExit("process_exit"));
}

function acceptCommandChunk(value: Record<string, unknown>): boolean {
  if (
    !hasOnlyKeys(value, ["protocol", "kind", "id", "command", "chunk_index", "chunk_count", "chunk"])
    || !Number.isSafeInteger(value.id)
    || (value.id as number) <= 0
    || typeof value.command !== "string"
    || !["start", "prompt", "steer", "abort", "get_state", "close"].includes(value.command)
    || !Number.isSafeInteger(value.chunk_index)
    || (value.chunk_index as number) < 0
    || !Number.isSafeInteger(value.chunk_count)
    || (value.chunk_count as number) < 1
    || (value.chunk_count as number) > Math.ceil(
      MANAGED_RPC_BRIDGE_MAX_COMMAND_PAYLOAD_BYTES / MANAGED_RPC_BRIDGE_COMMAND_CHUNK_BYTES,
    )
    || typeof value.chunk !== "string"
  ) return false;
  const chunk = decodeBase64Url(value.chunk);
  if (
    chunk === undefined
    || chunk.byteLength === 0
    || chunk.byteLength > MANAGED_RPC_BRIDGE_COMMAND_CHUNK_BYTES
  ) return false;
  const chunkIndex = value.chunk_index as number;
  const chunkCount = value.chunk_count as number;
  let pending = pendingChunkedCommand;
  if (pending === undefined) {
    if (chunkIndex !== 0) return false;
    pending = {
      id: value.id as number,
      command: value.command,
      chunkCount,
      chunks: [],
      byteLength: 0,
      nextChunkIndex: 0,
    };
    pendingChunkedCommand = pending;
  }
  if (
    pending.id !== value.id
    || pending.command !== value.command
    || pending.chunkCount !== chunkCount
    || pending.nextChunkIndex !== chunkIndex
    || pending.byteLength + chunk.byteLength > MANAGED_RPC_BRIDGE_MAX_COMMAND_PAYLOAD_BYTES
  ) return false;
  pending.chunks.push(chunk);
  pending.byteLength += chunk.byteLength;
  pending.nextChunkIndex += 1;
  if (pending.nextChunkIndex < pending.chunkCount) return true;

  pendingChunkedCommand = undefined;
  const payloadBytes = new Uint8Array(pending.byteLength);
  let offset = 0;
  for (const current of pending.chunks) {
    payloadBytes.set(current, offset);
    offset += current.byteLength;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes));
  } catch {
    return false;
  }
  enqueueCommand(Object.freeze({
    kind: "command",
    id: pending.id,
    command: pending.command,
    payload,
  }));
  return true;
}

function consume(bytes: Uint8Array): void {
  if (stopping || protocolFailed || bytes.byteLength === 0) return;
  try {
    decoder.push(bytes, (frame) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame));
      } catch {
        failAndExit("protocol_fault");
        return false;
      }
      if (!isRecord(parsed) || parsed.protocol !== PROTOCOL || typeof parsed.kind !== "string") {
        failAndExit("protocol_fault");
        return false;
      }
      if (parsed.kind === "command_chunk") {
        if (!acceptCommandChunk(parsed)) {
          failAndExit("protocol_fault");
          return false;
        }
        return !protocolFailed;
      }
      if (parsed.kind === "supervisor_frame") {
        const supervisorFrame = typeof parsed.frame === "string"
          ? decodeBase64Url(parsed.frame)
          : undefined;
        if (
          !authenticated
          || supervisorTransport === undefined
          || supervisorFrame === undefined
          || supervisorFrame.byteLength === 0
          || supervisorFrame.byteLength > MANAGED_RPC_SUPERVISOR_MAX_FRAME_BYTES
          || Object.keys(parsed).some((key) => !["protocol", "kind", "frame"].includes(key))
        ) {
          failAndExit("protocol_fault");
          return false;
        }
        forwardSupervisorBytes(supervisorFrame);
        return !protocolFailed;
      }
      if (
        pendingChunkedCommand !== undefined
        || parsed.kind !== "command"
        || !hasOnlyKeys(parsed, ["protocol", "kind", "id", "command", "payload"])
      ) {
        failAndExit("protocol_fault");
        return false;
      }
      const command = parsed as unknown as BridgeCommand;
      enqueueCommand(command);
      return !protocolFailed;
    });
  } catch {
    failAndExit("protocol_fault");
  }
}

function flushOutput(): Promise<void> {
  return outputQueue;
}

parseArgs();
process.stdin.on("data", (chunk: Uint8Array | string) => {
  consume(typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk));
});
process.stdin.on("end", () => {
  if (stopping) return;
  if (decoder.hasPendingBytes() || pendingChunkedCommand !== undefined) {
    failAndExit("protocol_fault");
    return;
  }
  fault("eof");
  stopping = true;
  void commandQueue
    .then(() => client?.stop())
    .then(() => {
      cleanupTemplatePromptFile();
      return closeLocalSupervisor();
    })
    .then(() => flushOutput())
    .then(() => {
      if (exitScheduled) return;
      exitScheduled = true;
      process.exit(0);
    })
    .catch(() => failAndExit("process_exit"));
});
process.stdin.on("error", () => {
  if (!stopping) failAndExit("protocol_fault");
});
process.on("uncaughtException", () => {
  failAndExit("process_exit");
});
process.on("unhandledRejection", () => {
  failAndExit("process_exit");
});

function validBase64(value: string): boolean {
  if (value.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if (padding > 0 && value.length % 4 !== 0) return false;
  if ((value.length - padding) % 4 === 1) return false;
  try {
    const normalized = padding > 0 ? value : value + "=".repeat((4 - (value.length % 4)) % 4);
    return Buffer.from(normalized, "base64").toString("base64").replace(/=+$/, "")
      === normalized.replace(/=+$/, "");
  } catch {
    return false;
  }
}

function decodedBase64Length(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.floor(value.length * 3 / 4) - padding;
}

function decodeBase64Url(value: string): Uint8Array | undefined {
  if (value.length === 0 || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return undefined;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if (padding > 0 && value.length % 4 !== 0) return undefined;
  if ((value.length - padding) % 4 === 1) return undefined;
  try {
    const bytes = Buffer.from(value, "base64url");
    return bytes.toString("base64url") === value.replace(/=+$/, "")
      ? new Uint8Array(bytes)
      : undefined;
  } catch {
    return undefined;
  }
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}
