import type { SupportedPlatform } from "./host-gate.ts";

export type ProcessTreeStrategy = "job_object" | "process_group_or_session";

/**
 * 适配器持有的平台树句柄。门禁只把它当作不透明值传递，控制器不能读取 PID。
 */
export type ProcessTreeHandle = unknown;

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
  attach(processHandle: unknown): Promise<ProcessTreeHandle>;
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
  "attach",
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
  return REQUIRED_PROCESS_TREE_ADAPTER_METHODS.every((method) => typeof adapter[method] === "function");
}
