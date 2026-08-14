import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import type { Readable, Writable } from "node:stream";
import type {
  ExitObservation,
  ProcessTreeAdapter,
  ProcessTreeHandle,
  ResourceObservation,
} from "./process-tree-capability.ts";

const DEFAULT_READY_TIMEOUT_MS = 5_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
function defaultWindowsJobHelperPath(): string {
  const colocated = fileURLToPath(new URL("./windows-job-object-helper.ps1", import.meta.url));
  if (existsSync(colocated)) return colocated;
  // 编译适配器位于 dist/src；发布包仍保留 extension 所需的 src helper。
  return fileURLToPath(new URL("../../src/windows-job-object-helper.ps1", import.meta.url));
}

const WINDOWS_JOB_HELPER_PATH = defaultWindowsJobHelperPath();

export interface WindowsJobObjectLaunchOptions {
  /** 要在专用 Job Object 内启动的可执行文件，不能是已运行的进程。 */
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** 子进程协议传输面，不暴露 PID、Job Object 或其他平台句柄。 */
export interface WindowsJobObjectTransport {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
}

export interface WindowsJobObjectLaunch {
  readonly tree: ProcessTreeHandle;
  readonly transport: WindowsJobObjectTransport;
}

export interface WindowsJobObjectAdapterOptions {
  /** 测试或受限宿主可覆盖 PowerShell 可执行文件位置。 */
  readonly powerShellPath?: string;
  /** 测试或打包加载可覆盖随包分发的 native helper 脚本位置。 */
  readonly helperScriptPath?: string;
  readonly readyTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
}

interface TreeToken {
  readonly owner: symbol;
}

type ControlResult = "accepted" | ResourceObservation["state"] | "unknown";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: Error): void;
  settled(): boolean;
}

interface TreeState {
  readonly token: TreeToken;
  readonly helper: ChildProcessWithoutNullStreams;
  readonly controlServer: Server;
  readonly eventServer: Server;
  readonly ready: Deferred<void>;
  readonly exitObserved: Deferred<void>;
  readonly responses: Map<number, Deferred<ControlResult>>;
  controlSocket: Socket | undefined;
  eventSocket: Socket | undefined;
  nextCommandId: number;
  exit: ExitObservation["state"];
  resources: ResourceObservation["state"];
  handleReleased: boolean;
  helperEnded: boolean;
  readyReceived: boolean;
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

function closeServer(server: Server): void {
  try {
    server.close();
  } catch {
    // 已关闭或正在关闭的 named pipe 不影响资源观察结论。
  }
}

function listenNamedPipe(
  pipeName: string,
  onConnection: (socket: Socket) => void,
): Promise<Server> {
  return new Promise<Server>((resolve, reject) => {
    const server = createServer(onConnection);
    const onError = (error: Error) => {
      server.close();
      reject(error);
    };
    server.once("error", onError);
    server.listen(pipeName, () => {
      server.off("error", onError);
      resolve(server);
    });
  });
}

function isLaunchOptions(value: unknown): value is WindowsJobObjectLaunchOptions {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.command !== "string" || candidate.command.length === 0) return false;
  if (candidate.args !== undefined) {
    if (!Array.isArray(candidate.args) || candidate.args.some((argument) => typeof argument !== "string")) {
      return false;
    }
  }
  return candidate.cwd === undefined || typeof candidate.cwd === "string";
}

function deadlineDelay(deadline: number | Date): number {
  const absolute = deadline instanceof Date ? deadline.getTime() : deadline;
  return Math.max(0, absolute - Date.now());
}

function isResourceState(value: string | undefined): value is ResourceObservation["state"] {
  return value === "released" || value === "present" || value === "unknown";
}

/**
 * Windows 的真实进程树适配器。
 *
 * helper 使用 CreateProcessW 的 CREATE_SUSPENDED 标志创建目标进程，先分配到
 * 节点专用 Job Object，再恢复线程。因此目标进程及其后代从运行起就不会脱离监督树。
 */
export class WindowsJobObjectAdapter implements ProcessTreeAdapter {
  readonly platform = "win32" as const;
  readonly strategy = "job_object" as const;

  private readonly helperScriptPath: string;
  private readonly powerShellPath: string;
  private readonly readyTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private readonly states = new WeakMap<object, TreeState>();
  private readonly owner = Symbol("windows-job-object-adapter");

  constructor(options: WindowsJobObjectAdapterOptions = {}) {
    this.helperScriptPath = options.helperScriptPath ?? WINDOWS_JOB_HELPER_PATH;
    this.powerShellPath = options.powerShellPath ?? "powershell.exe";
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  }

  /**
   * 以启动前说明创建进程树，并返回与 Pi RPC 可直接连接的标准流。
   * 这是满足 Job Object 绑定时序的唯一公开启动路径。
   */
  async launch(options: WindowsJobObjectLaunchOptions): Promise<WindowsJobObjectLaunch> {
    if (process.platform !== "win32") {
      throw safeError("Windows Job Object 仅可在 Windows 宿主启动");
    }
    if (!isLaunchOptions(options)) {
      throw safeError("Windows Job Object 启动说明无效");
    }

    const pipeId = randomUUID();
    const controlPipeName = `\\\\.\\pipe\\wj-pi-subagents-job-control-${pipeId}`;
    const eventPipeName = `\\\\.\\pipe\\wj-pi-subagents-job-event-${pipeId}`;
    let connectState: TreeState | undefined;
    const controlServer = await listenNamedPipe(controlPipeName, (socket) => {
      if (connectState === undefined || connectState.controlSocket !== undefined) {
        socket.destroy();
        return;
      }
      connectState.controlSocket = socket;
      this.bindCommandSocket(connectState, socket);
    });
    let eventServer: Server;
    try {
      eventServer = await listenNamedPipe(eventPipeName, (socket) => {
        if (connectState === undefined || connectState.eventSocket !== undefined) {
          socket.destroy();
          return;
        }
        connectState.eventSocket = socket;
        this.bindEventSocket(connectState, socket);
      });
    } catch (error) {
      closeServer(controlServer);
      throw error;
    }

    const helperArgs = [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      this.helperScriptPath,
      "-ControlPipe",
      controlPipeName,
      "-EventPipe",
      eventPipeName,
      "-CommandBase64",
      Buffer.from(options.command, "utf8").toString("base64"),
      "-ArgumentsBase64",
      (options.args ?? []).map((argument) => Buffer.from(argument, "utf8").toString("base64")).join(","),
    ];
    const stdio: ["pipe", "pipe", "pipe"] = ["pipe", "pipe", "pipe"];
    const spawnOptions: {
      windowsHide: boolean;
      stdio: ["pipe", "pipe", "pipe"];
      cwd?: string;
      env?: NodeJS.ProcessEnv;
    } = {
      windowsHide: true,
      stdio,
    };
    if (options.cwd !== undefined) spawnOptions.cwd = options.cwd;
    if (options.env !== undefined) spawnOptions.env = options.env;
    const helper = spawn(
      this.powerShellPath,
      helperArgs,
      spawnOptions,
    ) as unknown as ChildProcessWithoutNullStreams;
    const token: TreeToken = Object.freeze({ owner: this.owner });
    const state: TreeState = {
      token,
      helper,
      controlServer,
      eventServer,
      ready: deferred<void>(),
      exitObserved: deferred<void>(),
      responses: new Map(),
      controlSocket: undefined,
      eventSocket: undefined,
      nextCommandId: 1,
      exit: "present",
      resources: "unknown",
      handleReleased: false,
      helperEnded: false,
      readyReceived: false,
    };
    connectState = state;
    this.states.set(token, state);
    this.bindHelperLifecycle(state);

    try {
      await waitFor(state.ready.promise, this.readyTimeoutMs, "Windows Job Object helper 启动超时");
    } catch {
      await this.cleanupFailedLaunch(state);
      throw safeError("Windows Job Object helper 未就绪");
    }

    return Object.freeze({
      tree: token,
      transport: Object.freeze({
        stdin: helper.stdin,
        stdout: helper.stdout,
        stderr: helper.stderr,
      }),
    });
  }

  async requestGracefulClose(tree: ProcessTreeHandle, signal: AbortSignal): Promise<void> {
    const state = this.readState(tree);
    if (state.handleReleased) return;
    if (signal.aborted) throw safeError("优雅关闭请求已取消");
    if (!state.helper.stdin.writableEnded) state.helper.stdin.end();
  }

  async forceTerminate(tree: ProcessTreeHandle): Promise<void> {
    const state = this.readState(tree);
    if (state.handleReleased || state.resources === "released") return;
    try {
      await this.sendCommand(state, "force");
    } catch {
      state.resources = "unknown";
    }
  }

  async waitForExit(tree: ProcessTreeHandle, deadline: number | Date): Promise<ExitObservation> {
    const state = this.readState(tree);
    if (state.exit === "present" && state.resources === "released") state.exit = "exited";
    if (state.exit === "present") {
      const delay = deadlineDelay(deadline);
      if (delay > 0) {
        try {
          await waitFor(state.exitObserved.promise, delay, "等待进程退出期限到达");
        } catch {
          // 期限到达时仍保持 present；不能把超时解释为退出。
        }
      }
    }
    return { state: state.exit };
  }

  async inspect(tree: ProcessTreeHandle): Promise<ResourceObservation> {
    const state = this.readState(tree);
    if (state.handleReleased) return { state: "unknown" };
    if (state.resources === "released") return { state: "released" };
    if (state.helperEnded) return { state: "unknown" };
    try {
      const result = await this.sendCommand(state, "inspect");
      if (isResourceState(result)) state.resources = result;
    } catch {
      state.resources = "unknown";
    }
    return { state: state.resources };
  }

  async release(tree: ProcessTreeHandle): Promise<void> {
    const state = this.readState(tree);
    if (state.handleReleased) return;
    // 即使资源已确认释放，也必须显式通知 helper 退出。helper 会保留事件管道，
    // 直到该命令到达，避免最终 released 事件与管道 EOF 竞争。
    if (!state.helperEnded) {
      try {
        await this.sendCommand(state, "release");
      } catch {
        // 释放后不再有可靠句柄；即使内核随后回收，也不能伪造确认结果。
      }
    }
    state.handleReleased = true;
    state.resources = "unknown";
    this.closePipeServers(state);
  }

  private bindCommandSocket(state: TreeState, socket: Socket): void {
    if (state.readyReceived) state.ready.resolve();
    socket.on("error", () => this.markCommandUnavailable(state));
    socket.on("close", () => this.markCommandUnavailable(state));
  }

  private bindEventSocket(state: TreeState, socket: Socket): void {
    socket.setEncoding("utf8");
    let buffered = "";
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline).replace(/\r$/, "");
        buffered = buffered.slice(newline + 1);
        this.receiveControlLine(state, line);
        newline = buffered.indexOf("\n");
      }
    });
    socket.on("error", () => this.markEventUnavailable(state));
    socket.on("close", () => this.markEventUnavailable(state));
  }

  private receiveControlLine(state: TreeState, line: string): void {
    const parts = line.split(" ");
    if (parts[0] === "ready") {
      state.resources = "present";
      state.readyReceived = true;
      if (state.controlSocket !== undefined) state.ready.resolve();
      return;
    }
    if (parts[0] === "event" && parts[1] === "exit" && parts[2] === "exited") {
      state.exit = "exited";
      state.exitObserved.resolve();
      return;
    }
    if (parts[0] === "event" && parts[1] === "resources" && isResourceState(parts[2])) {
      state.resources = parts[2];
      if (parts[2] === "released" && state.exit === "present") {
        state.exit = "exited";
        state.exitObserved.resolve();
      }
      return;
    }
    if (parts[0] === "response" && parts.length === 3) {
      const commandId = Number(parts[1]);
      const response = parts[2] as ControlResult;
      const waiter = state.responses.get(commandId);
      if (waiter !== undefined) {
        state.responses.delete(commandId);
        waiter.resolve(response);
      }
      return;
    }
    if (parts[0] === "error") {
      this.markEventUnavailable(state);
    }
  }

  private bindHelperLifecycle(state: TreeState): void {
    const unavailable = () => this.markHelperUnavailable(state);
    state.helper.once("error", unavailable);
    state.helper.once("exit", () => {
      state.helperEnded = true;
      if (!state.ready.settled()) state.ready.reject(safeError("Windows Job Object helper 已退出"));
      closeServer(state.controlServer);
      if (state.eventSocket === undefined) this.markEventUnavailable(state);
    });
  }

  private markHelperUnavailable(state: TreeState): void {
    state.helperEnded = true;
    if (!state.ready.settled()) state.ready.reject(safeError("Windows Job Object helper 不可用"));
    this.closePipeServers(state);
    this.markEventUnavailable(state);
  }

  private markCommandUnavailable(state: TreeState): void {
    this.rejectPendingResponses(state);
  }

  private markEventUnavailable(state: TreeState): void {
    if (state.resources !== "released") state.resources = "unknown";
    if (state.exit === "present") state.exit = "unknown";
    state.exitObserved.resolve();
    this.rejectPendingResponses(state);
    closeServer(state.eventServer);
  }

  private rejectPendingResponses(state: TreeState): void {
    for (const waiter of state.responses.values()) {
      waiter.reject(safeError("Windows Job Object 控制通道不可用"));
    }
    state.responses.clear();
  }

  private async sendCommand(state: TreeState, command: "force" | "inspect" | "release"): Promise<ControlResult> {
    if (state.controlSocket === undefined || state.controlSocket.destroyed || state.helperEnded) {
      throw safeError("Windows Job Object 控制通道不可用");
    }
    const commandId = state.nextCommandId;
    state.nextCommandId += 1;
    const response = deferred<ControlResult>();
    state.responses.set(commandId, response);
    try {
      await new Promise<void>((resolve, reject) => {
        state.controlSocket?.write(`command ${commandId} ${command}\n`, (error) => {
          if (error == null) resolve();
          else reject(error);
        });
      });
      return await waitFor(
        response.promise,
        this.commandTimeoutMs,
        "Windows Job Object helper 控制响应超时",
      );
    } finally {
      state.responses.delete(commandId);
    }
  }

  private async cleanupFailedLaunch(state: TreeState): Promise<void> {
    try {
      await this.sendCommand(state, "force");
    } catch {
      try {
        state.helper.kill();
      } catch {
        // helper 已不可用时，关闭它持有的 Job Object 会由内核回收成员。
      }
    }
    state.resources = "unknown";
    this.closePipeServers(state);
  }

  private closePipeServers(state: TreeState): void {
    closeServer(state.controlServer);
    closeServer(state.eventServer);
  }

  private readState(tree: ProcessTreeHandle): TreeState {
    if (typeof tree !== "object" || tree === null) {
      throw new TypeError("invalid Windows Job Object handle");
    }
    const token = tree as TreeToken;
    if (token.owner !== this.owner) throw new TypeError("foreign Windows Job Object handle");
    const state = this.states.get(token);
    if (state === undefined) throw new TypeError("unknown Windows Job Object handle");
    return state;
  }
}
