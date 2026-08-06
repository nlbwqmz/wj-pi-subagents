import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type {
  ExitObservation,
  ProcessTreeAdapter,
  ProcessTreeHandle,
  ResourceObservation,
} from "./process-tree-capability.ts";

const DEFAULT_READY_TIMEOUT_MS = 5_000;

export type UnixProcessTreePlatform = Extract<"darwin" | "linux", NodeJS.Platform>;

export interface UnixProcessTreeLaunchOptions {
  /** 要在专用 process group/session 中启动的可执行文件。 */
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** 子进程协议传输面，不暴露进程号或 process group/session 标识。 */
export interface UnixProcessTreeTransport {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
}

export interface UnixProcessTreeLaunch {
  readonly tree: ProcessTreeHandle;
  readonly transport: UnixProcessTreeTransport;
}

export interface UnixProcessTreeAdapterOptions {
  /** 测试或宿主探针可指定要验证的平台；生产入口传入当前平台。 */
  readonly platform?: UnixProcessTreePlatform;
  readonly readyTimeoutMs?: number;
}

/** 启动回滚未确认时携带可重试的不透明树句柄，不暴露 PID 或底层错误。 */
export class UnixProcessTreeLaunchError extends Error {
  readonly cleanup: ResourceObservation["state"];
  readonly tree: ProcessTreeHandle | undefined;

  constructor(
    message: string,
    cleanup: ResourceObservation["state"],
    tree: ProcessTreeHandle | undefined,
  ) {
    super(message);
    this.name = "UnixProcessTreeLaunchError";
    this.cleanup = cleanup;
    this.tree = tree;
  }
}

interface TreeToken {
  readonly owner: symbol;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: Error): void;
  settled(): boolean;
}

interface TreeState {
  readonly child: ChildProcessWithoutNullStreams;
  readonly ready: Deferred<void>;
  readonly exitObserved: Deferred<void>;
  pid: number | undefined;
  exit: ExitObservation["state"];
  resources: ResourceObservation["state"];
  handleReleased: boolean;
  spawnError: boolean;
  gracefulCloseRequested: boolean;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: Error) => void;
  let isSettled = false;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = (value) => {
      if (isSettled) return;
      isSettled = true;
      resolve(value);
    };
    rejectPromise = (reason) => {
      if (isSettled) return;
      isSettled = true;
      reject(reason);
    };
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
    settled: () => isSettled,
  };
}

function safeError(message: string): Error {
  return new Error(message);
}

function waitFor<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(safeError(message)), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function hostUnixPlatform(): UnixProcessTreePlatform | undefined {
  if (process.platform === "darwin" || process.platform === "linux") return process.platform;
  return undefined;
}

function isLaunchOptions(value: unknown): value is UnixProcessTreeLaunchOptions {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.command !== "string" || candidate.command.length === 0) return false;
  if (candidate.args !== undefined) {
    if (!Array.isArray(candidate.args) || candidate.args.some((argument) => typeof argument !== "string")) {
      return false;
    }
  }
  if (candidate.cwd !== undefined && typeof candidate.cwd !== "string") return false;
  return candidate.env === undefined || (typeof candidate.env === "object" && candidate.env !== null);
}

function deadlineDelay(deadline: number | Date): number {
  const absolute = deadline instanceof Date ? deadline.getTime() : deadline;
  return Math.max(0, absolute - Date.now());
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function validPid(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** 使用 process group 的 kill(2) 探测整棵树，而不是只观察直接子进程。 */
function observeProcessGroup(pid: number): ResourceObservation["state"] {
  try {
    if (!process.kill(-pid, 0)) return "unknown";
    return "present";
  } catch (error: unknown) {
    const code = errnoCode(error);
    if (code === "ESRCH") return "released";
    if (code === "EPERM") return "present";
    return "unknown";
  }
}

/** 向整组发送信号；成功发送本身不等同于树资源已经回收。 */
function signalProcessGroup(pid: number, signal: NodeJS.Signals): "accepted" | ResourceObservation["state"] {
  try {
    if (!process.kill(-pid, signal)) return "unknown";
    return "accepted";
  } catch (error: unknown) {
    const code = errnoCode(error);
    if (code === "ESRCH") return "released";
    if (code === "EPERM") return "present";
    return "unknown";
  }
}

/** 仅用于 process group 尚未建立的启动回滚；不能据此确认整树已经回收。 */
function signalDirectProcessForStartupRollback(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // 后续退出与 process group 观察负责区分 released、present 和 unknown。
  }
}

/**
 * macOS/Linux 的真实进程树适配器。
 *
 * Node 在 POSIX 平台上以 detached 选项创建新的 session/process group；子进程
 * 及未主动创建新 session 的后代共享该组。强制阶段使用负 PID 的组信号，资源
 * 观察使用 kill(-pgid, 0)，因此不会退化为只终止直接子进程。
 */
export class UnixProcessTreeAdapter implements ProcessTreeAdapter {
  readonly platform: UnixProcessTreePlatform;
  readonly strategy = "process_group_or_session" as const;
  /** 宿主不是声明的平台或缺少 kill(2) 时，兼容门禁拒绝该适配器。 */
  readonly available: boolean;

  private readonly readyTimeoutMs: number;
  private readonly states = new WeakMap<object, TreeState>();
  private readonly owner = Symbol("unix-process-tree-adapter");

  constructor(options: UnixProcessTreeAdapterOptions = {}) {
    const hostPlatform = hostUnixPlatform();
    this.platform = options.platform ?? hostPlatform ?? "linux";
    this.available = hostPlatform === this.platform && typeof process.kill === "function";
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  }

  /**
   * 在子进程真正运行前创建专用 process group/session，并返回 Pi RPC 所需的标准流。
   */
  async launch(options: UnixProcessTreeLaunchOptions): Promise<UnixProcessTreeLaunch> {
    if (!this.available) {
      throw safeError("Unix process group/session 在当前宿主不可用");
    }
    if (!isLaunchOptions(options)) {
      throw safeError("Unix process group 启动说明无效");
    }

    const spawnOptions: {
      detached: true;
      stdio: ["pipe", "pipe", "pipe"];
      cwd?: string;
      env?: NodeJS.ProcessEnv;
    } = {
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    };
    if (options.cwd !== undefined) spawnOptions.cwd = options.cwd;
    if (options.env !== undefined) spawnOptions.env = options.env;

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(options.command, options.args ?? [], spawnOptions) as unknown as ChildProcessWithoutNullStreams;
    } catch {
      throw safeError("Unix process group 子进程启动失败");
    }

    const token: TreeToken = Object.freeze({ owner: this.owner });
    const state: TreeState = {
      child,
      ready: deferred<void>(),
      exitObserved: deferred<void>(),
      pid: validPid(child.pid),
      exit: "present",
      resources: "unknown",
      handleReleased: false,
      spawnError: false,
      gracefulCloseRequested: false,
    };
    this.states.set(token, state);
    this.bindChildLifecycle(state);

    try {
      await waitFor(state.ready.promise, this.readyTimeoutMs, "Unix process group 子进程启动超时");
    } catch {
      const cleanup = await this.cleanupFailedLaunch(state);
      throw new UnixProcessTreeLaunchError(
        "Unix process group 子进程启动失败",
        cleanup,
        cleanup === "released" ? undefined : token,
      );
    }

    return Object.freeze({
      tree: token,
      transport: Object.freeze({
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
      }),
    });
  }

  async requestGracefulClose(tree: ProcessTreeHandle, signal: AbortSignal): Promise<void> {
    const state = this.readState(tree);
    if (state.handleReleased || state.gracefulCloseRequested) return;
    if (signal.aborted) throw safeError("优雅关闭请求已取消");
    state.gracefulCloseRequested = true;
    if (!state.child.stdin.writableEnded && !state.child.stdin.destroyed) state.child.stdin.end();
  }

  async forceTerminate(tree: ProcessTreeHandle): Promise<void> {
    const state = this.readState(tree);
    if (state.handleReleased || state.resources === "released") return;
    const pid = state.pid;
    if (pid === undefined) {
      state.resources = "unknown";
      return;
    }

    const signalResult = signalProcessGroup(pid, "SIGKILL");
    if (signalResult === "released") {
      state.resources = "released";
      if (state.exit === "present") {
        state.exit = "exited";
        state.exitObserved.resolve();
      }
      return;
    }
    state.resources = signalResult === "accepted" ? observeProcessGroup(pid) : signalResult;
  }

  async waitForExit(tree: ProcessTreeHandle, deadline: number | Date): Promise<ExitObservation> {
    const state = this.readState(tree);
    if (state.handleReleased) return { state: "unknown" };
    if (state.exit === "present") {
      const delay = deadlineDelay(deadline);
      if (delay > 0) {
        try {
          await waitFor(state.exitObserved.promise, delay, "等待 Unix 进程退出期限到达");
        } catch {
          // 期限到达时仍保持 present；超时不能伪造退出确认。
        }
      }
    }
    return { state: state.exit };
  }

  async inspect(tree: ProcessTreeHandle): Promise<ResourceObservation> {
    const state = this.readState(tree);
    if (state.handleReleased) return { state: "unknown" };
    if (state.resources === "released") return { state: "released" };
    const pid = state.pid;
    if (pid === undefined) {
      state.resources = "unknown";
      return { state: state.resources };
    }

    state.resources = observeProcessGroup(pid);
    if (state.resources === "released" && state.exit === "present") {
      state.exit = "exited";
      state.exitObserved.resolve();
    }
    return { state: state.resources };
  }

  async release(tree: ProcessTreeHandle): Promise<void> {
    const state = this.readState(tree);
    if (state.handleReleased) return;

    // POSIX 没有可关闭的 group 句柄；未确认时先发整组 SIGKILL，随后丢弃观察能力。
    // 即使信号成功，也必须把结果报告为 unknown，不能在句柄释放后伪造确认。
    if (state.resources !== "released" && state.pid !== undefined) {
      signalProcessGroup(state.pid, "SIGKILL");
    }
    state.handleReleased = true;
    state.resources = "unknown";
    this.closeTransport(state.child);
  }

  private bindChildLifecycle(state: TreeState): void {
    state.child.once("spawn", () => {
      const pid = validPid(state.child.pid);
      if (pid === undefined || (state.pid !== undefined && state.pid !== pid)) {
        state.spawnError = true;
        state.ready.reject(safeError("Unix process group 未返回有效进程标识"));
        return;
      }
      state.pid = pid;
      state.resources = "present";
      state.ready.resolve();
    });
    state.child.on("error", () => {
      state.spawnError = true;
      state.resources = "unknown";
      if (!state.ready.settled()) state.ready.reject(safeError("Unix process group 子进程不可用"));
      if (state.exit === "present") state.exit = "unknown";
      state.exitObserved.resolve();
    });
    state.child.once("exit", () => {
      state.exit = state.spawnError ? "unknown" : "exited";
      state.exitObserved.resolve();
    });
  }

  private async cleanupFailedLaunch(state: TreeState): Promise<ResourceObservation["state"]> {
    const pid = state.pid;
    if (pid === undefined) {
      state.handleReleased = true;
      state.resources = state.spawnError ? "released" : "unknown";
      this.closeTransport(state.child);
      return state.resources;
    }

    const signalResult = signalProcessGroup(pid, "SIGKILL");
    if (signalResult !== "accepted") signalDirectProcessForStartupRollback(pid);

    const deadline = Date.now() + Math.max(100, Math.min(this.readyTimeoutMs, 1_000));
    while (Date.now() < deadline) {
      state.resources = observeProcessGroup(pid);
      if (state.resources === "released" && state.exit !== "present") break;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }

    if (state.resources === "released" && state.exit !== "present") {
      state.handleReleased = true;
    } else if (state.resources === "released") {
      state.resources = "unknown";
    }
    this.closeTransport(state.child);
    return state.resources;
  }

  private closeTransport(child: ChildProcessWithoutNullStreams): void {
    if (!child.stdin.destroyed) child.stdin.destroy();
    if (!child.stdout.destroyed) child.stdout.destroy();
    if (!child.stderr.destroyed) child.stderr.destroy();
  }

  private readState(tree: ProcessTreeHandle): TreeState {
    if (typeof tree !== "object" || tree === null) {
      throw new TypeError("invalid Unix process tree handle");
    }
    const token = tree as TreeToken;
    if (token.owner !== this.owner) throw new TypeError("foreign Unix process tree handle");
    const state = this.states.get(token);
    if (state === undefined) throw new TypeError("unknown Unix process tree handle");
    return state;
  }
}
