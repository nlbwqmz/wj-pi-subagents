import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import type { ChildReplyEnvelope } from "./child-reply-envelope.ts";
import type { AgentSnapshot } from "./tree-controller.ts";
import { SUPERVISOR_CHANNEL_LIMITS } from "./supervisor-channel.ts";
import { LengthPrefixedFrameDecoder } from "./length-prefixed-frame-decoder.ts";
import {
  isManagedProcessTreeAdapter,
  type ExitObservation,
  type ManagedProcessTransport,
  type ProcessLaunchSpec,
  type ProcessTreeAdapter,
  type ProcessTreeHandle,
  type ResourceObservation,
} from "./process-tree-capability.ts";

export type ManagedRpcReply = ChildReplyEnvelope;

export type ManagedRpcTransportFault = "eof" | "protocol_fault" | "process_exit";

export const MANAGED_RPC_BRIDGE_PROTOCOL = "wj-pi-subagents/managed-rpc/3" as const;
/** 只用于节点启动事务的一次性本地认证，不进入公开控制面。 */
export const MANAGED_RPC_BRIDGE_CREDENTIAL_ENV = "WJ_PI_SUBAGENTS_MANAGED_RPC_CREDENTIAL" as const;
/** 外层桥接 JSON 正文的硬边界。 */
export const MANAGED_RPC_BRIDGE_MAX_FRAME_BYTES = 64 * 1024;
/** 单个高层命令的重组边界，覆盖长模板配置和监督启动快照。 */
export const MANAGED_RPC_BRIDGE_MAX_COMMAND_PAYLOAD_BYTES = 512 * 1024;
/** Base64URL 分片为外层桥接 JSON 保留协议字段空间。 */
export const MANAGED_RPC_BRIDGE_COMMAND_CHUNK_BYTES = 45 * 1024;
/**
 * 监督字节进入外层桥接前的传输分片上限。46 KiB 经 Base64URL 后仍能放入
 * 64 KiB 外层帧；它不是完整 SupervisorChannel 帧的上限。
 */
export const MANAGED_RPC_SUPERVISOR_MAX_FRAME_BYTES = 46 * 1024;
/** SupervisorChannel 的完整 JSON 正文边界。 */
export const MANAGED_RPC_SUPERVISOR_MAX_BODY_BYTES = SUPERVISOR_CHANNEL_LIMITS.maxFrameBytes;
/** 完整监督帧包含四字节长度头，桥接会将它拆成多个 tunnel chunk。 */
export const MANAGED_RPC_SUPERVISOR_MAX_ENCODED_FRAME_BYTES = MANAGED_RPC_SUPERVISOR_MAX_BODY_BYTES + 4;

/** 节点身份只在预留成功后传给桥接进程，用于建立独立监督通道。 */
export interface ManagedRpcSupervisorInit {
  readonly root_id: string;
  readonly local_agent_id: string;
  readonly peer_agent_id: string;
  readonly parent_agent_id: string | null;
  readonly depth: number;
  readonly credential: string;
  readonly initial_snapshot: readonly AgentSnapshot[];
  readonly initial_subtree_revision: number;
}

export interface ManagedRpcNodeStartContext {
  readonly supervisor?: ManagedRpcSupervisorInit;
  /** 身份预留后由根运行时快照派生，不能覆盖桥接一次性凭据。 */
  readonly environment?: Readonly<Record<string, string>>;
}

/** 桥接进程只暴露高层命令，不暴露 Pi JSONL 流。 */
export interface ManagedRpcBridge {
  start(signal?: AbortSignal, context?: ManagedRpcNodeStartContext): Promise<void>;
  prompt(message: string): Promise<void>;
  steer(message: string): Promise<void>;
  abort(): Promise<void>;
  getState(): Promise<unknown>;
  requestClose(signal: AbortSignal): Promise<void>;
  onEvent(listener: (event: unknown) => void): () => void;
  onTransportFault(listener: (fault: ManagedRpcTransportFault) => void): () => void;
  /** 与任务 RPC 复用同一读取者的父子监督帧转发。 */
  sendSupervisorFrame(frame: Uint8Array): Promise<void>;
  onSupervisorFrame(listener: (frame: Uint8Array) => void): () => void;
  release?(): Promise<void>;
}

export interface ManagedRpcBridgeFactoryOptions {
  /** 仅父端桥接客户端使用；不得写入日志、回复或树快照。 */
  readonly credential?: string;
  /** 仅通过首个有界 start 命令交给 bridge，不进入任何进程命令行。 */
  readonly rpcOptions?: Readonly<Record<string, unknown>>;
}

export type ManagedRpcBridgeFactory = (
  transport: ManagedProcessTransport,
  options?: ManagedRpcBridgeFactoryOptions,
) => ManagedRpcBridge;

export interface ManagedRpcNodeLaunchOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ManagedRpcNodeOptions {
  readonly processTreeAdapter: ProcessTreeAdapter;
  readonly launch: ManagedRpcNodeLaunchOptions;
  /** 首个 bridge start 命令携带的 Pi RpcClient 配置，不进入 OS 命令行。 */
  readonly rpcOptions?: Readonly<Record<string, unknown>>;
  /** 测试可注入 bridge；生产默认使用有界本地帧桥。 */
  readonly bridgeFactory?: ManagedRpcBridgeFactory;
}

export interface ManagedRpcNodeAssemblyOptions {
  readonly processTreeAdapter: ProcessTreeAdapter;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly rpcOptions?: Readonly<Record<string, unknown>>;
  /** 测试/打包时可指定已编译的桥接入口。 */
  readonly bridgeScriptPath?: string;
  readonly bridgeFactory?: ManagedRpcBridgeFactory;
}

/** 生成平台适配器在启动前接收的桥接进程说明。 */
export function createManagedRpcNodeLaunchSpec(
  options: Pick<ManagedRpcNodeAssemblyOptions, "cwd" | "env" | "bridgeScriptPath">,
): ManagedRpcNodeLaunchOptions {
  const scriptPath = options.bridgeScriptPath
    ?? defaultBridgeScriptPath();
  return Object.freeze({
    command: process.execPath,
    args: Object.freeze([
      ...(scriptPath.endsWith(".ts") ? ["--experimental-strip-types"] : []),
      scriptPath,
    ]),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: Object.freeze({ ...options.env }) }),
  });
}

/**
 * Node 原生 type stripping 不允许执行 node_modules 内的 .ts 文件。发布包提供
 * 编译 bridge 时优先运行它；源码目录未构建时仍保留本地开发的 .ts 回退路径。
 */
export function resolveManagedRpcBridgeScriptPath(
  moduleUrl: string = import.meta.url,
  fileExists: (path: string) => boolean = existsSync,
): string {
  // 编译后的模块本身位于 dist/src，优先使用同目录 bridge；源码模块则继续查找 dist。
  const colocatedCompiled = fileURLToPath(new URL("./rpc-bridge-process.js", moduleUrl));
  if (fileExists(colocatedCompiled)) return colocatedCompiled;
  const compiled = fileURLToPath(new URL("../dist/src/rpc-bridge-process.js", moduleUrl));
  if (fileExists(compiled)) return compiled;
  return fileURLToPath(new URL("./rpc-bridge-process.ts", moduleUrl));
}

function defaultBridgeScriptPath(): string {
  return resolveManagedRpcBridgeScriptPath();
}

/** 生产装配便捷入口；返回值仍是单一 `ManagedRpcNode` 深模块。 */
export function createManagedRpcNode(options: ManagedRpcNodeAssemblyOptions): ManagedRpcNode {
  return new ManagedRpcNode({
    processTreeAdapter: options.processTreeAdapter,
    launch: createManagedRpcNodeLaunchSpec(options),
    ...(options.rpcOptions === undefined ? {} : { rpcOptions: options.rpcOptions }),
    ...(options.bridgeFactory === undefined ? {} : { bridgeFactory: options.bridgeFactory }),
  });
}

export interface ManagedRpcNodeLike {
  readonly process_binding: "managed";
  start(signal?: AbortSignal, context?: ManagedRpcNodeStartContext): Promise<void>;
  prompt(message: string): Promise<void>;
  steer(message: string): Promise<void>;
  abort(): Promise<void>;
  getState(): Promise<unknown>;
  onEvent(listener: (event: unknown) => void): () => void;
  onTransportFault(listener: (fault: ManagedRpcTransportFault) => void): () => void;
  sendSupervisorFrame(frame: Uint8Array): Promise<void>;
  onSupervisorFrame(listener: (frame: Uint8Array) => void): () => void;
  requestGracefulClose(signal: AbortSignal): Promise<void>;
  forceTerminate(): Promise<void>;
  waitForExit(deadline: number | Date): Promise<ExitObservation>;
  inspect(): Promise<ResourceObservation>;
  release(): Promise<void>;
}

type NodePhase = "new" | "starting" | "ready" | "failed" | "released";

/**
 * 受管 RPC 节点。平台适配器返回的树句柄和标准流在此处成对保存，监督器
 * 只能通过本类型的高层命令与资源观察接口访问它们。
 */
export class ManagedRpcNode implements ManagedRpcNodeLike {
  readonly process_binding = "managed" as const;

  private readonly adapter: ProcessTreeAdapter & {
    readonly launch: NonNullable<ProcessTreeAdapter["launch"]>;
  };
  private readonly launchSpec: ManagedRpcNodeLaunchOptions;
  private readonly rpcOptions: Readonly<Record<string, unknown>> | undefined;
  private readonly bridgeFactory: ManagedRpcBridgeFactory;
  private phase: NodePhase = "new";
  private binding: {
    readonly tree: ProcessTreeHandle;
    readonly transport?: ManagedProcessTransport;
  } | undefined;
  private bridge: ManagedRpcBridge | undefined;
  private startPromise: Promise<void> | undefined;
  private readonly bindingSettled: Promise<void>;
  private resolveBindingSettled!: () => void;
  private bindingSettlementRecorded = false;
  private gracefulCloseRequested = false;
  private forceTerminationRequested = false;
  private releaseRequested = false;
  private releasePromise: Promise<void> | undefined;
  private unsubscribeBridgeEvent: (() => void) | undefined;
  private unsubscribeBridgeFault: (() => void) | undefined;
  private unsubscribeBridgeSupervisorFrame: (() => void) | undefined;

  constructor(options: ManagedRpcNodeOptions) {
    if (!isManagedProcessTreeAdapter(options.processTreeAdapter, options.processTreeAdapter.platform)) {
      throw new TypeError("受管 RPC 节点需要支持 launch() 的进程树适配器");
    }
    if (!isLaunchSpec(options.launch)) throw new TypeError("受管 RPC 节点启动说明无效");
    this.adapter = options.processTreeAdapter as typeof this.adapter;
    this.launchSpec = Object.freeze({
      command: options.launch.command,
      ...(options.launch.args === undefined ? {} : { args: Object.freeze([...options.launch.args]) }),
      ...(options.launch.cwd === undefined ? {} : { cwd: options.launch.cwd }),
      ...(options.launch.env === undefined ? {} : { env: Object.freeze({ ...options.launch.env }) }),
    });
    this.rpcOptions = options.rpcOptions === undefined
      ? undefined
      : copyRpcOptions(options.rpcOptions);
    this.bridgeFactory = options.bridgeFactory ?? ((transport, bridgeOptions) =>
      new ManagedRpcBridgeClient(transport, bridgeOptions));
    this.bindingSettled = new Promise<void>((resolve) => {
      this.resolveBindingSettled = resolve;
    });
  }

  start(signal?: AbortSignal, context?: ManagedRpcNodeStartContext): Promise<void> {
    this.startPromise ??= this.runStart(signal, context);
    return this.startPromise;
  }

  async prompt(message: string): Promise<void> {
    return this.requireBridge().prompt(message);
  }

  async steer(message: string): Promise<void> {
    return this.requireBridge().steer(message);
  }

  async abort(): Promise<void> {
    return this.requireBridge().abort();
  }

  async getState(): Promise<unknown> {
    return this.requireBridge().getState();
  }

  onEvent(listener: (event: unknown) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onTransportFault(listener: (fault: ManagedRpcTransportFault) => void): () => void {
    this.transportListeners.add(listener);
    return () => this.transportListeners.delete(listener);
  }

  async sendSupervisorFrame(frame: Uint8Array): Promise<void> {
    await this.requireSupervisorBridge().sendSupervisorFrame(cloneBytes(frame));
  }

  onSupervisorFrame(listener: (frame: Uint8Array) => void): () => void {
    this.supervisorFrameListeners.add(listener);
    return () => this.supervisorFrameListeners.delete(listener);
  }

  async requestGracefulClose(signal: AbortSignal): Promise<void> {
    this.gracefulCloseRequested = true;
    await this.waitForBindingSettlement();
    const bridge = this.bridge;
    const tree = this.binding?.tree;
    const operations: Promise<void>[] = [];
    if (bridge !== undefined) operations.push(bridge.requestClose(signal));
    if (tree !== undefined) operations.push(this.adapter.requestGracefulClose(tree, signal));
    await settleAll(operations);
  }

  async forceTerminate(): Promise<void> {
    this.forceTerminationRequested = true;
    await this.waitForBindingSettlement();
    const tree = this.binding?.tree;
    if (tree !== undefined) await this.adapter.forceTerminate(tree);
  }

  async waitForExit(deadline: number | Date): Promise<ExitObservation> {
    const tree = this.binding?.tree;
    if (tree !== undefined) return this.adapter.waitForExit(tree, deadline);
    return this.phase === "starting" ? { state: "unknown" } : { state: "exited" };
  }

  async inspect(): Promise<ResourceObservation> {
    const tree = this.binding?.tree;
    if (tree !== undefined) return this.adapter.inspect(tree);
    return this.phase === "starting" ? { state: "unknown" } : { state: "released" };
  }

  release(): Promise<void> {
    this.releaseRequested = true;
    if (this.phase === "released") return Promise.resolve();
    if (this.releasePromise !== undefined) return this.releasePromise;
    const attempt = this.runRelease();
    this.releasePromise = attempt;
    const clearFailedAttempt = (): void => {
      if (this.releasePromise === attempt && this.phase !== "released") {
        this.releasePromise = undefined;
      }
    };
    void attempt.then(() => {}, clearFailedAttempt);
    return attempt;
  }

  private async runRelease(): Promise<void> {
    await this.waitForBindingSettlement();
    if (this.phase === "released") return;
    const startWasInFlight = this.phase === "starting";
    const tree = this.binding?.tree;
    const operations: Promise<void>[] = [];
    if (this.bridge?.release !== undefined) operations.push(this.bridge.release());
    if (tree !== undefined) operations.push(this.adapter.release(tree));
    await settleAll(operations);
    if (startWasInFlight && this.startPromise !== undefined) {
      await this.startPromise.then(() => {}, () => {});
      if (this.bridge?.release !== undefined) await this.bridge.release();
    }
    this.unsubscribeBridgeEvent?.();
    this.unsubscribeBridgeFault?.();
    this.unsubscribeBridgeSupervisorFrame?.();
    this.unsubscribeBridgeEvent = undefined;
    this.unsubscribeBridgeFault = undefined;
    this.unsubscribeBridgeSupervisorFrame = undefined;
    this.phase = "released";
  }

  private async runStart(signal?: AbortSignal, context?: ManagedRpcNodeStartContext): Promise<void> {
    if (this.phase !== "new") throw new Error("受管 RPC 节点已启动");
    this.phase = "starting";
    try {
      if (signal?.aborted || this.cleanupRequested()) throw abortError();
      const credential = randomBytes(32).toString("base64url");
      const launchSpec = withBridgeCredential(this.launchSpec, credential, context?.environment);
      let launched: unknown;
      try {
        launched = await this.adapter.launch(launchSpec);
      } catch (error: unknown) {
        const lateTree = treeFromLaunchError(error);
        if (lateTree !== undefined) this.binding = Object.freeze({ tree: lateTree });
        throw error;
      }
      if (launched === null || typeof launched !== "object" || !("tree" in launched)) {
        throw new Error("进程树启动结果无效");
      }
      const candidate = launched as Record<string, unknown>;
      if (candidate.tree === undefined) throw new Error("进程树启动结果无效");
      if (!("transport" in candidate) || !isManagedTransport(candidate.transport)) {
        // 即使 transport 违约，也必须保留已返回的树句柄供启动回滚。
        this.binding = Object.freeze({ tree: candidate.tree });
        throw new Error("进程树启动结果无效");
      }
      const binding = Object.freeze({
        tree: candidate.tree,
        transport: candidate.transport,
      });
      this.binding = Object.freeze({ tree: binding.tree, transport: binding.transport });
      this.recordBindingSettlement();
      if (signal?.aborted || this.cleanupRequested()) throw abortError();
      const bridge = this.bridgeFactory(binding.transport, Object.freeze({
        credential,
        ...(this.rpcOptions === undefined ? {} : { rpcOptions: this.rpcOptions }),
      }));
      this.bridge = bridge;
      this.unsubscribeBridgeEvent = bridge.onEvent((event) => this.emitEvent(event));
      this.unsubscribeBridgeFault = bridge.onTransportFault((fault) => this.emitTransportFault(fault));
      this.unsubscribeBridgeSupervisorFrame = bridge.onSupervisorFrame(
        (frame) => this.emitSupervisorFrame(frame),
      );
      if (signal?.aborted || this.cleanupRequested()) throw abortError();
      await bridge.start(signal, context);
      if (signal?.aborted || this.cleanupRequested() || this.hasReleased()) throw abortError();
      this.phase = "ready";
    } catch (error) {
      this.recordBindingSettlement();
      if (!this.hasReleased()) this.phase = "failed";
      throw error;
    }
  }

  private cleanupRequested(): boolean {
    return this.gracefulCloseRequested || this.forceTerminationRequested || this.releaseRequested;
  }

  private hasReleased(): boolean {
    return this.phase === "released";
  }

  private recordBindingSettlement(): void {
    if (this.bindingSettlementRecorded) return;
    this.bindingSettlementRecorded = true;
    this.resolveBindingSettled();
  }

  private async waitForBindingSettlement(): Promise<void> {
    if (this.phase === "starting" && !this.bindingSettlementRecorded) {
      await this.bindingSettled;
    }
  }

  private requireBridge(): ManagedRpcBridge {
    if (this.phase !== "ready" || this.bridge === undefined) {
      throw new Error("受管 RPC 节点尚未就绪");
    }
    return this.bridge;
  }

  private requireSupervisorBridge(): ManagedRpcBridge {
    if ((this.phase !== "starting" && this.phase !== "ready") || this.bridge === undefined) {
      throw new Error("受管 RPC 节点尚未就绪");
    }
    return this.bridge;
  }

  private emitEvent(event: unknown): void {
    // 事件已经由桥接协议限制为高层对象；节点不解释 Pi JSONL。
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // 观察者异常不能影响桥接传输。
      }
    }
  }

  private emitTransportFault(fault: ManagedRpcTransportFault): void {
    for (const listener of this.transportListeners) {
      try {
        listener(fault);
      } catch {
        // 故障观察者异常不能改变资源绑定。
      }
    }
  }

  private emitSupervisorFrame(frame: Uint8Array): void {
    const copy = cloneBytes(frame);
    for (const listener of this.supervisorFrameListeners) {
      try {
        listener(cloneBytes(copy));
      } catch {
        // 监督帧观察者异常不能影响桥接读取者。
      }
    }
  }

  private readonly eventListeners = new Set<(event: unknown) => void>();
  private readonly transportListeners = new Set<(fault: ManagedRpcTransportFault) => void>();
  private readonly supervisorFrameListeners = new Set<(frame: Uint8Array) => void>();
}

function isLaunchSpec(value: unknown): value is ManagedRpcNodeLaunchOptions {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.command !== "string" || candidate.command.length === 0) return false;
  if (candidate.args !== undefined && (
    !Array.isArray(candidate.args) || candidate.args.some((item) => typeof item !== "string")
  )) return false;
  return candidate.cwd === undefined || typeof candidate.cwd === "string";
}

function isManagedTransport(value: unknown): value is ManagedProcessTransport {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.stdin === "object" && candidate.stdin !== null
    && typeof candidate.stdout === "object" && candidate.stdout !== null
    && typeof candidate.stderr === "object" && candidate.stderr !== null;
}

function treeFromLaunchError(error: unknown): ProcessTreeHandle | undefined {
  if (typeof error !== "object" || error === null || !("tree" in error)) return undefined;
  const tree = (error as { readonly tree?: unknown }).tree;
  return tree === undefined ? undefined : tree;
}

function copyRpcOptions(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.freeze({
    ...value,
    ...(Array.isArray(value.args) ? { args: Object.freeze([...value.args]) } : {}),
  });
}

function cloneBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

function copySupervisorInit(value: ManagedRpcSupervisorInit): ManagedRpcSupervisorInit {
  return Object.freeze({
    root_id: value.root_id,
    local_agent_id: value.local_agent_id,
    peer_agent_id: value.peer_agent_id,
    parent_agent_id: value.parent_agent_id,
    depth: value.depth,
    credential: value.credential,
    initial_snapshot: Object.freeze(value.initial_snapshot.map((node) => Object.freeze({ ...node }))),
    initial_subtree_revision: value.initial_subtree_revision,
  });
}

async function settleAll(operations: readonly Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(operations);
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure !== undefined) throw failure.reason instanceof Error ? failure.reason : new Error("受管节点操作失败");
}

function abortError(): Error {
  const error = new Error("受管 RPC 节点阶段已取消");
  error.name = "AbortError";
  return error;
}

const MAX_BRIDGE_FRAME_BYTES = MANAGED_RPC_BRIDGE_MAX_FRAME_BYTES;

interface BridgeResponse {
  readonly protocol?: typeof MANAGED_RPC_BRIDGE_PROTOCOL;
  readonly kind: "response";
  readonly id: number;
  readonly ok: boolean;
  readonly data?: unknown;
}

interface BridgeEventFrame {
  readonly protocol?: typeof MANAGED_RPC_BRIDGE_PROTOCOL;
  readonly kind: "event";
  readonly event: unknown;
}

interface BridgeFaultFrame {
  readonly protocol?: typeof MANAGED_RPC_BRIDGE_PROTOCOL;
  readonly kind: "fault";
  readonly fault: ManagedRpcTransportFault;
}

interface BridgeSupervisorFrame {
  readonly protocol?: typeof MANAGED_RPC_BRIDGE_PROTOCOL;
  readonly kind: "supervisor_frame";
  readonly frame: string;
}

type BridgeFrame = BridgeResponse | BridgeEventFrame | BridgeFaultFrame | BridgeSupervisorFrame;

interface PendingBridgeRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
}

/**
 * 受管桥接进程的父端客户端。帧以四字节大端长度前缀分隔，父端只看到高层
 * 命令和安全事件；Pi JSONL 由桥接进程内部独占。
 */
export interface ManagedRpcBridgeClientOptions {
  readonly credential?: string;
  /** bridge 在启动子 Pi 前应用的私有 RpcClient 配置。 */
  readonly rpcOptions?: Readonly<Record<string, unknown>>;
}

export class ManagedRpcBridgeClient implements ManagedRpcBridge {
  private readonly stdin: Writable;
  private readonly stdout: Readable;
  private readonly stderr: Readable;
  private readonly pending = new Map<number, PendingBridgeRequest>();
  private readonly eventListeners = new Set<(event: unknown) => void>();
  private readonly faultListeners = new Set<(fault: ManagedRpcTransportFault) => void>();
  private readonly supervisorFrameListeners = new Set<(frame: Uint8Array) => void>();
  private readonly credential: string | undefined;
  private readonly rpcOptions: Readonly<Record<string, unknown>> | undefined;
  private readonly decoder = new LengthPrefixedFrameDecoder(MAX_BRIDGE_FRAME_BYTES);
  private nextRequestId = 1;
  private closed = false;
  private started = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    transport: ManagedProcessTransport,
    options: ManagedRpcBridgeClientOptions | string = {},
  ) {
    this.credential = typeof options === "string" ? options : options.credential;
    this.rpcOptions = typeof options === "string" || options.rpcOptions === undefined
      ? undefined
      : copyRpcOptions(options.rpcOptions);
    this.stdin = transport.stdin;
    this.stdout = transport.stdout;
    this.stderr = transport.stderr;
    // bridge 会把 Pi 子进程 stderr 转发到自身 stderr；父端必须持续消费，
    // 否则 Windows 管道反压会冻结 bridge 的事件循环和监督 ACK。
    drainStderr(transport.stderr);
    this.stdout.on("data", (chunk: Uint8Array | string) => this.receiveBytes(
      typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk),
    ));
    this.stdout.on("end", () => this.handleTransportEnd());
    this.stdout.on("close", () => this.handleTransportEnd());
    this.stdout.on("error", () => this.failTransport("protocol_fault"));
    this.stdin.on("error", () => this.failTransport("protocol_fault"));
  }

  async start(signal?: AbortSignal, context?: ManagedRpcNodeStartContext): Promise<void> {
    await this.request(
      "start",
      context?.supervisor === undefined && this.rpcOptions === undefined
        ? undefined
        : {
          ...(context?.supervisor === undefined
            ? {}
            : { supervisor: copySupervisorInit(context.supervisor) }),
          ...(this.rpcOptions === undefined ? {} : { config: { rpc: this.rpcOptions } }),
        },
      signal,
    );
    this.started = true;
  }

  async prompt(message: string): Promise<void> {
    await this.request("prompt", { message });
  }

  async steer(message: string): Promise<void> {
    await this.request("steer", { message });
  }

  async abort(): Promise<void> {
    await this.request("abort", undefined);
  }

  async getState(): Promise<unknown> {
    return this.request("get_state", undefined);
  }

  async requestClose(signal: AbortSignal): Promise<void> {
    await this.request("close", undefined, signal);
  }

  onEvent(listener: (event: unknown) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onTransportFault(listener: (fault: ManagedRpcTransportFault) => void): () => void {
    this.faultListeners.add(listener);
    return () => this.faultListeners.delete(listener);
  }

  async sendSupervisorFrame(frame: Uint8Array): Promise<void> {
    if (this.closed) throw new Error("桥接传输不可用");
    if (
      !(frame instanceof Uint8Array)
      || frame.byteLength === 0
      || frame.byteLength > MANAGED_RPC_SUPERVISOR_MAX_ENCODED_FRAME_BYTES
    ) {
      throw new Error("监督帧无效");
    }
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < frame.byteLength; offset += MANAGED_RPC_SUPERVISOR_MAX_FRAME_BYTES) {
      const slice = frame.subarray(offset, Math.min(frame.byteLength, offset + MANAGED_RPC_SUPERVISOR_MAX_FRAME_BYTES));
      chunks.push(encodeBridgeFrame({
        protocol: MANAGED_RPC_BRIDGE_PROTOCOL,
        kind: "supervisor_frame",
        frame: Buffer.from(slice).toString("base64url"),
      }));
    }
    await this.enqueueWrites(chunks);
  }

  onSupervisorFrame(listener: (frame: Uint8Array) => void): () => void {
    this.supervisorFrameListeners.add(listener);
    return () => this.supervisorFrameListeners.delete(listener);
  }

  async release(): Promise<void> {
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(new Error("桥接传输已释放"));
    this.pending.clear();
    if (!this.stdin.destroyed) this.stdin.destroy();
    if (!this.stdout.destroyed) this.stdout.destroy();
    if (!this.stderr.destroyed) this.stderr.destroy();
  }

  private request(command: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("桥接传输不可用"));
    if (!this.started && command !== "start") return Promise.reject(new Error("桥接进程尚未启动"));
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    if (!isBridgeCommandName(command)) return Promise.reject(new Error("桥接命令无效"));
    const requestPayload = command === "start" && this.credential !== undefined
      ? { credential: this.credential, ...(isRecord(payload) ? payload : {}) }
      : payload;
    const request = Object.freeze({
      protocol: MANAGED_RPC_BRIDGE_PROTOCOL,
      kind: "command",
      id,
      command,
      ...(requestPayload === undefined ? {} : { payload: requestPayload }),
    });
    let frames: readonly Uint8Array[];
    try {
      frames = encodeBridgeCommandFrames(request);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error("桥接命令负载无效"));
    }
    return new Promise<unknown>((resolve, reject) => {
      const onAbort = (): void => {
        this.pending.delete(id);
        reject(abortError());
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      });
      void this.enqueueWrites(frames).catch((error: unknown) => {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error("桥接写入失败"));
      });
    });
  }

  private receiveBytes(bytes: Uint8Array): void {
    if (this.closed || bytes.byteLength === 0) return;
    try {
      this.decoder.push(bytes, (frameBytes) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frameBytes));
        } catch {
          this.failTransport("protocol_fault");
          return false;
        }
        this.receiveFrame(parsed);
        return !this.closed;
      });
    } catch {
      this.failTransport("protocol_fault");
    }
  }

  private receiveFrame(value: unknown): void {
    if (!isRecord(value) || value.protocol !== MANAGED_RPC_BRIDGE_PROTOCOL || typeof value.kind !== "string") {
      this.failTransport("protocol_fault");
      return;
    }
    if (value.kind === "response") {
      if (
        !hasOnlyKeys(value, ["protocol", "kind", "id", "ok", "data"])
        || !Number.isSafeInteger(value.id)
        || (value.id as number) <= 0
        || typeof value.ok !== "boolean"
        || (value.ok === false && Object.hasOwn(value, "data"))
      ) {
        this.failTransport("protocol_fault");
        return;
      }
      const responseId = value.id as number;
      const pending = this.pending.get(responseId);
      if (pending === undefined) return;
      this.pending.delete(responseId);
      if (value.ok) pending.resolve(value.data);
      else pending.reject(new Error("桥接命令失败"));
      return;
    }
    if (value.kind === "event") {
      if (!hasOnlyKeys(value, ["protocol", "kind", "event"]) || !isSafeBridgeEvent(value.event)) {
        this.failTransport("protocol_fault");
        return;
      }
      for (const listener of this.eventListeners) {
        try {
          listener(value.event);
        } catch {
          // 观察者属于上层业务；其异常不能破坏唯一桥接读者。
        }
      }
      return;
    }
    if (value.kind === "supervisor_frame") {
      if (!hasOnlyKeys(value, ["protocol", "kind", "frame"]) || typeof value.frame !== "string") {
        this.failTransport("protocol_fault");
        return;
      }
      const frame = decodeBase64Bytes(value.frame);
      if (
        frame === undefined
        || frame.byteLength === 0
        || frame.byteLength > MANAGED_RPC_SUPERVISOR_MAX_FRAME_BYTES
      ) {
        this.failTransport("protocol_fault");
        return;
      }
      for (const listener of this.supervisorFrameListeners) {
        try {
          listener(cloneBytes(frame));
        } catch {
          // 观察者异常不能破坏唯一传输读取者。
        }
      }
      return;
    }
    if (
      value.kind === "fault"
      && hasOnlyKeys(value, ["protocol", "kind", "fault"])
      && (value.fault === "eof" || value.fault === "protocol_fault" || value.fault === "process_exit")
    ) {
      this.failTransport(value.fault as ManagedRpcTransportFault);
      return;
    }
    this.failTransport("protocol_fault");
  }

  private failTransport(fault: ManagedRpcTransportFault): void {
    if (this.closed) return;
    this.closed = true;
    this.decoder.reset();
    for (const pending of this.pending.values()) pending.reject(new Error("桥接传输故障"));
    this.pending.clear();
    for (const listener of this.faultListeners) {
      try {
        listener(fault);
      } catch {
        // 故障观察者异常不能再次进入桥接故障路径。
      }
    }
  }

  private handleTransportEnd(): void {
    this.failTransport(this.decoder.hasPendingBytes() ? "protocol_fault" : "eof");
  }

  private enqueueWrites(frames: readonly Uint8Array[]): Promise<void> {
    const operation = this.writeQueue.catch(() => {}).then(async () => {
      for (const frame of frames) await writeChunk(this.stdin, frame);
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }
}

function encodeBridgeCommandFrames(request: Readonly<Record<string, unknown>>): readonly Uint8Array[] {
  try {
    return Object.freeze([encodeBridgeFrame(request)]);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "桥接帧超限") throw error;
  }
  if (!Object.hasOwn(request, "payload")) throw new Error("桥接命令负载无效");
  if (
    !Number.isSafeInteger(request.id)
    || (request.id as number) <= 0
    || typeof request.command !== "string"
    || !isBridgeCommandName(request.command)
  ) throw new Error("桥接命令无效");
  const payload = encodeBridgeJson(request.payload);
  if (payload.byteLength === 0 || payload.byteLength > MANAGED_RPC_BRIDGE_MAX_COMMAND_PAYLOAD_BYTES) {
    throw new Error("桥接命令负载超限");
  }
  const chunkCount = Math.ceil(payload.byteLength / MANAGED_RPC_BRIDGE_COMMAND_CHUNK_BYTES);
  const frames: Uint8Array[] = [];
  for (let offset = 0, index = 0; offset < payload.byteLength; offset += MANAGED_RPC_BRIDGE_COMMAND_CHUNK_BYTES, index += 1) {
    const chunk = payload.subarray(offset, Math.min(payload.byteLength, offset + MANAGED_RPC_BRIDGE_COMMAND_CHUNK_BYTES));
    frames.push(encodeBridgeFrame({
      protocol: MANAGED_RPC_BRIDGE_PROTOCOL,
      kind: "command_chunk",
      id: request.id,
      command: request.command,
      chunk_index: index,
      chunk_count: chunkCount,
      chunk: Buffer.from(chunk).toString("base64url"),
    }));
  }
  return Object.freeze(frames);
}

function encodeBridgeFrame(value: unknown): Uint8Array {
  const body = encodeBridgeJson(value);
  if (body.byteLength > MAX_BRIDGE_FRAME_BYTES) throw new Error("桥接帧超限");
  const frame = new Uint8Array(body.byteLength + 4);
  new DataView(frame.buffer).setUint32(0, body.byteLength, false);
  frame.set(body, 4);
  return frame;
}

function encodeBridgeJson(value: unknown): Uint8Array {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    throw new Error("桥接帧无效");
  }
  if (typeof text !== "string") throw new Error("桥接帧无效");
  return new TextEncoder().encode(text);
}

function drainStderr(stream: Readable): void {
  stream.on("data", () => {});
  stream.on("error", () => {});
  stream.resume();
}

function writeChunk(stream: Writable, bytes: Uint8Array): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    try {
      stream.write(bytes, (error?: Error | null) => error === null || error === undefined ? resolve() : reject(error));
    } catch (error) {
      reject(error instanceof Error ? error : new Error("桥接写入失败"));
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

const BRIDGE_COMMAND_NAMES = new Set([
  "start",
  "prompt",
  "steer",
  "abort",
  "get_state",
  "close",
]);

function isBridgeCommandName(value: string): boolean {
  return BRIDGE_COMMAND_NAMES.has(value);
}

function isSafeBridgeEvent(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "agent_start":
    case "agent_settled":
      return Object.keys(value).length === 1;
    case "compaction_start":
      return (value.reason === "manual" || value.reason === "threshold" || value.reason === "overflow")
        && Object.keys(value).every((key) => key === "type" || key === "reason");
    case "compaction_end":
      return (value.reason === "manual" || value.reason === "threshold" || value.reason === "overflow")
        && typeof value.aborted === "boolean"
        && typeof value.willRetry === "boolean"
        && typeof value.failed === "boolean"
        && Object.keys(value).every((key) => [
          "type",
          "reason",
          "aborted",
          "willRetry",
          "failed",
        ].includes(key));
    case "queue_update":
      return Number.isSafeInteger(value.pendingMessageCount)
        && (value.pendingMessageCount as number) >= 0
        && Object.keys(value).every((key) => key === "type" || key === "pendingMessageCount");
    case "tool_execution_start":
    case "tool_execution_end":
      return typeof value.toolCallId === "string"
        && value.toolCallId.length > 0
        && value.toolCallId.length <= 256
        && typeof value.toolName === "string"
        && value.toolName.length > 0
        && value.toolName.length <= 256
        && Object.keys(value).every((key) => key === "type" || key === "toolCallId" || key === "toolName");
    case "extension_error":
      return Object.keys(value).length === 1;
    default:
      return false;
  }
}

function decodeBase64Bytes(value: string): Uint8Array | undefined {
  if (value.length === 0 || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return undefined;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if (padding > 0 && value.length % 4 !== 0) return undefined;
  if ((value.length - padding) % 4 === 1) return undefined;
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = padding > 0 ? normalized : normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const bytes = Buffer.from(padded, "base64");
    if (bytes.toString("base64url") !== value.replace(/=+$/, "")) return undefined;
    return new Uint8Array(bytes);
  } catch {
    return undefined;
  }
}

function withBridgeCredential(
  spec: ManagedRpcNodeLaunchOptions,
  credential: string,
  runtimeEnvironment?: Readonly<Record<string, string>>,
): ManagedRpcNodeLaunchOptions {
  return Object.freeze({
    ...spec,
    env: Object.freeze({
      ...process.env,
      ...(spec.env ?? {}),
      ...(runtimeEnvironment ?? {}),
      [MANAGED_RPC_BRIDGE_CREDENTIAL_ENV]: credential,
    }),
  });
}

export interface FakeManagedRpcNodeOptions {
  readonly onOperation?: (operation: string) => void;
  readonly state?: unknown;
}

/** 供监督器与旅程测试使用的确定性受管节点替身。 */
export class FakeManagedRpcNode implements ManagedRpcNodeLike {
  readonly process_binding = "managed" as const;
  private readonly options: FakeManagedRpcNodeOptions;
  private readonly eventListeners = new Set<(event: unknown) => void>();
  private readonly faultListeners = new Set<(fault: ManagedRpcTransportFault) => void>();
  private readonly supervisorFrameListeners = new Set<(frame: Uint8Array) => void>();
  private readonly operationLog: string[] = [];
  private phase: "new" | "ready" | "released" = "new";

  constructor(options: FakeManagedRpcNodeOptions = {}) {
    this.options = options;
  }

  async start(_signal?: AbortSignal, _context?: ManagedRpcNodeStartContext): Promise<void> {
    this.record("start");
    this.phase = "ready";
  }

  async prompt(): Promise<void> { this.record("prompt"); }
  async steer(): Promise<void> { this.record("steer"); }
  async abort(): Promise<void> { this.record("abort"); }
  async getState(): Promise<unknown> {
    this.record("get_state");
    return this.options.state ?? {
      isStreaming: false,
      isCompacting: false,
      pendingMessageCount: 0,
    };
  }
  onEvent(listener: (event: unknown) => void): () => void { this.eventListeners.add(listener); return () => this.eventListeners.delete(listener); }
  onTransportFault(listener: (fault: ManagedRpcTransportFault) => void): () => void { this.faultListeners.add(listener); return () => this.faultListeners.delete(listener); }
  async sendSupervisorFrame(_frame: Uint8Array): Promise<void> { this.record("supervisor_frame"); }
  onSupervisorFrame(listener: (frame: Uint8Array) => void): () => void { this.supervisorFrameListeners.add(listener); return () => this.supervisorFrameListeners.delete(listener); }
  async requestGracefulClose(): Promise<void> { this.record("graceful_close"); }
  async forceTerminate(): Promise<void> { this.record("force_terminate"); }
  async waitForExit(): Promise<ExitObservation> { this.record("wait_for_exit"); return { state: "exited" }; }
  async inspect(): Promise<ResourceObservation> { this.record("inspect"); return { state: "released" }; }
  async release(): Promise<void> { this.record("release"); this.phase = "released"; }

  emitEvent(event: unknown): void { for (const listener of this.eventListeners) listener(event); }
  emitTransportFault(fault: ManagedRpcTransportFault): void { for (const listener of this.faultListeners) listener(fault); }
  emitSupervisorFrame(frame: Uint8Array): void { for (const listener of this.supervisorFrameListeners) listener(cloneBytes(frame)); }
  operations(): readonly string[] { return Object.freeze([...this.operationLog]); }

  private record(operation: string): void {
    this.operationLog.push(operation);
    this.options.onOperation?.(operation);
  }
}
