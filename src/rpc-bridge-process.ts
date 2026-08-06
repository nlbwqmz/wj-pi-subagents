/**
 * 受管 RPC 桥接进程入口。
 *
 * 该文件由 `ProcessTreeAdapter.launch()` 启动。它是 Pi `RpcClient` 的唯一
 * 拥有者，stdin/stdout 只承载本模块定义的有界高层帧；Pi JSONL 永远不会被
 * 转发给父监督器。
 */
import { fileURLToPath } from "node:url";
import { BridgeSupervisorEndpoint } from "./bridge-supervisor-endpoint.ts";
import {
  MANAGED_RPC_BRIDGE_CREDENTIAL_ENV,
  MANAGED_RPC_BRIDGE_MAX_FRAME_BYTES,
  MANAGED_RPC_BRIDGE_PROTOCOL,
  MANAGED_RPC_SUPERVISOR_MAX_FRAME_BYTES,
  type ManagedRpcSupervisorInit,
} from "./managed-rpc-node.ts";
import { LengthPrefixedFrameDecoder } from "./length-prefixed-frame-decoder.ts";
import { normalizeRpcBridgeEvent } from "./rpc-bridge-event.ts";

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
let supervisorEndpoint: BridgeSupervisorEndpoint | undefined;
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
  process.stdin.pause();
  fault(faultCode);
  void flushOutput().finally(() => process.exit(1));
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

function parseArgs(): void {
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
  const { RpcClient } = await import("@earendil-works/pi-coding-agent");
  const cliPath = typeof options.cliPath === "string" && options.cliPath.length > 0
    ? options.cliPath
    : defaultPiCliPath();
  const clientOptions = cliPath === undefined ? options : { ...options, cliPath };
  client = new RpcClient(clientOptions as never) as unknown as BridgeClient;
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
    || !["start", "prompt", "steer", "abort", "get_state", "supervisor_reply", "close"].includes(command.command)
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
        || Object.keys(command.payload).some((key) => key !== "credential" && key !== "supervisor")) {
        failAndExit("protocol_fault");
        return;
      }
      const supervisorInit = command.payload.supervisor === undefined
        ? undefined
        : normalizeSupervisorInit(command.payload.supervisor);
      if (command.payload.supervisor !== undefined && supervisorInit === undefined) {
        failAndExit("protocol_fault");
        return;
      }
      authenticated = true;
      started = true;
      if (supervisorInit !== undefined) {
        supervisorEndpoint = new BridgeSupervisorEndpoint({
          init: supervisorInit,
          send: emitSupervisorFrame,
          onFault: () => failAndExit("protocol_fault"),
        });
        supervisorEndpoint.start();
      }
      const current = await ensureClient();
      await current.start();
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
    if (command.command === "supervisor_reply") {
      if (supervisorEndpoint === undefined || !isRecord(command.payload)
        || typeof command.payload.text !== "string"
        || new TextEncoder().encode(command.payload.text).byteLength > MAX_MESSAGE_BYTES
        || Object.keys(command.payload).some((key) => key !== "text" && key !== "images")) {
        response(command.id, false);
        return;
      }
      const images = command.payload.images === undefined ? undefined : normalizeImages(command.payload.images);
      if (command.payload.images !== undefined && images === undefined) {
        response(command.id, false);
        return;
      }
      supervisorEndpoint.publishReply({
        text: command.payload.text,
        ...(images === undefined ? {} : { images }),
      });
      response(command.id, true);
      return;
    }
    if (command.command === "close") {
      stopping = true;
      await current.stop();
      response(command.id, true);
      await flushOutput();
      exitScheduled = true;
      process.exit(0);
      return;
    }
    response(command.id, false);
  } catch {
    response(command.id, false);
  }
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
      if (parsed.kind === "supervisor_frame") {
        const supervisorFrame = typeof parsed.frame === "string"
          ? decodeBase64Url(parsed.frame)
          : undefined;
        if (
          !authenticated
          || supervisorEndpoint === undefined
          || supervisorFrame === undefined
          || supervisorFrame.byteLength === 0
          || supervisorFrame.byteLength > MANAGED_RPC_SUPERVISOR_MAX_FRAME_BYTES
          || Object.keys(parsed).some((key) => !["protocol", "kind", "frame"].includes(key))
        ) {
          failAndExit("protocol_fault");
          return false;
        }
        supervisorEndpoint.receive(supervisorFrame);
        return !protocolFailed;
      }
      if (
        parsed.kind !== "command"
        || !hasOnlyKeys(parsed, ["protocol", "kind", "id", "command", "payload"])
      ) {
        failAndExit("protocol_fault");
        return false;
      }
      const command = parsed as unknown as BridgeCommand;
      commandQueue = commandQueue
        .then(() => handleCommand(command))
        .catch(() => failAndExit("process_exit"));
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
  if (decoder.hasPendingBytes()) {
    failAndExit("protocol_fault");
    return;
  }
  fault("eof");
  stopping = true;
  void commandQueue
    .then(() => client?.stop())
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
