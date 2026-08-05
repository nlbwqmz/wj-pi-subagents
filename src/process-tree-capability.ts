import type { SupportedPlatform } from "./host-gate.ts";

export type ProcessTreeStrategy = "job_object" | "process_group_or_session";

export interface ProcessTreeAdapterCapability {
  readonly platform: SupportedPlatform;
  readonly strategy: ProcessTreeStrategy;
  readonly available: true;
}

const STRATEGIES: Record<SupportedPlatform, ProcessTreeStrategy> = {
  win32: "job_object",
  darwin: "process_group_or_session",
  linux: "process_group_or_session",
};

/**
 * 返回当前票据的无副作用平台能力令牌；真正的树句柄操作由后续适配器票据注入。
 */
export function getProcessTreeAdapterCapability(
  platform: NodeJS.Platform,
): ProcessTreeAdapterCapability | undefined {
  if (!Object.prototype.hasOwnProperty.call(STRATEGIES, platform)) return undefined;
  const supportedPlatform = platform as SupportedPlatform;
  return {
    platform: supportedPlatform,
    strategy: STRATEGIES[supportedPlatform],
    available: true,
  };
}
