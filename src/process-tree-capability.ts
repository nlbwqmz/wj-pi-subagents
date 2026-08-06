import type { Readable, Writable } from "node:stream";
import type { SupportedPlatform } from "./host-gate.ts";

export type ProcessTreeStrategy = "job_object" | "process_group_or_session";

/**
 * 适配器持有的平台树句柄。门禁只把它当作不透明值传递，控制器不能读取 PID。
 */
export type ProcessTreeHandle = unknown;

/**
 * 受管桥接进程的标准控制传输。传输属于 `launch()` 返回值，不能从另一个
 * 模块重新拼接到树句柄上；平台适配器不解析其中的 RPC 内容。
 */
export interface ManagedProcessTransport {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
}

/** 启动前说明。它描述包内桥接进程，而不是一个已经存在的 PID。 */
export interface ProcessLaunchSpec {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** 平台树与桥接传输的同事务绑定结果。 */
export interface ProcessTreeLaunch {
  readonly tree: ProcessTreeHandle;
  readonly transport: ManagedProcessTransport;
}

export type ExitObservationState = "exited" | "present" | "unknown";

/**
 * 退出观察只表示平台能够确认的退出事实，不代表整棵树资源已经释放。
 */
export interface ExitObservation {
  readonly state: ExitObservationState;
}

export type ResourceObservationState = "released" | "present" | "unknown";

/**
 * `released` 仅表示适配器确认树内资源已回收；发送信号、EOF 或局部退出都不足以得到该值。
 */
export interface ResourceObservation {
  readonly state: ResourceObservationState;
}

/**
 * 平台进程树适配器的完整职责契约。
 *
 * Windows 使用 Job Object，Unix 类系统使用 process group/session；适配器内部
 * 负责平台句柄和整树回收，宿主门禁只验证契约是否可加载。
 */
export interface ProcessTreeAdapter {
  readonly platform: SupportedPlatform;
  readonly strategy: ProcessTreeStrategy;
  /**
   * 生产与测试受管节点的唯一启动入口；树句柄和桥接传输必须由同一事务返回。
   */
  launch(spec: ProcessLaunchSpec): Promise<ProcessTreeLaunch>;
  requestGracefulClose(tree: ProcessTreeHandle, signal: AbortSignal): Promise<void>;
  forceTerminate(tree: ProcessTreeHandle): Promise<void>;
  waitForExit(tree: ProcessTreeHandle, deadline: number | Date): Promise<ExitObservation>;
  inspect(tree: ProcessTreeHandle): Promise<ResourceObservation>;
  release(tree: ProcessTreeHandle): Promise<void>;
}

const STRATEGIES: Record<SupportedPlatform, ProcessTreeStrategy> = {
  win32: "job_object",
  darwin: "process_group_or_session",
  linux: "process_group_or_session",
};

export function processTreeStrategyFor(platform: SupportedPlatform): ProcessTreeStrategy {
  return STRATEGIES[platform];
}

const REQUIRED_PROCESS_TREE_ADAPTER_METHODS = [
  "requestGracefulClose",
  "forceTerminate",
  "waitForExit",
  "inspect",
  "release",
] as const;

/**
 * 验证适配器是否提供全部平台树职责，并且声明了与当前平台匹配的策略。
 */
export function isProcessTreeAdapter(
  candidate: unknown,
  platform: SupportedPlatform,
): candidate is ProcessTreeAdapter {
  if (typeof candidate !== "object" || candidate === null) return false;
  const adapter = candidate as Record<string, unknown>;
  if (
    adapter.platform !== platform ||
    adapter.strategy !== processTreeStrategyFor(platform)
  ) return false;
  if ("available" in adapter && adapter.available !== true) return false;
  return typeof adapter.launch === "function" && REQUIRED_PROCESS_TREE_ADAPTER_METHODS.every(
    (method) => typeof adapter[method] === "function",
  );
}

/** 严格的受管节点门禁；只接受提供同事务 `launch()` 的适配器。 */
export function isManagedProcessTreeAdapter(
  candidate: unknown,
  platform: SupportedPlatform,
): candidate is ProcessTreeAdapter & {
  readonly launch: (spec: ProcessLaunchSpec) => Promise<ProcessTreeLaunch>;
} {
  return isProcessTreeAdapter(candidate, platform);
}
