import packageManifest from "../package.json" with { type: "json" };
import {
  isManagedProcessTreeAdapter,
  type ProcessTreeAdapter,
} from "./process-tree-capability.ts";
import { holdRuntimeReloadLeaseDuringActivation } from "./runtime-reload-coordinator.ts";

interface PackageManifestRequirements {
  engines?: { node?: unknown };
  piSubagent?: { requiresPi?: unknown };
}

const manifestRequirements = packageManifest as PackageManifestRequirements;

function requiredVersionRange(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid ${field} in package manifest`);
  }
  return value;
}

function minimumVersion(range: string, field: string): string {
  const match = /^>=(\d+\.\d+\.\d+)$/.exec(range);
  if (match === null) throw new Error(`Invalid ${field} in package manifest`);
  return match[1]!;
}

export const NODE_VERSION_RANGE = requiredVersionRange(manifestRequirements.engines?.node, "engines.node");
export const PI_VERSION_RANGE = requiredVersionRange(
  manifestRequirements.piSubagent?.requiresPi,
  "piSubagent.requiresPi",
);
export const MIN_NODE_VERSION = minimumVersion(NODE_VERSION_RANGE, "engines.node");
export const MIN_PI_VERSION = minimumVersion(PI_VERSION_RANGE, "piSubagent.requiresPi");
export const HOST_CAPABILITY_DIAGNOSTIC_CODE = "host_capability_unavailable";
export const SUPPORTED_PLATFORMS = ["win32", "darwin", "linux"] as const;

export type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number];

export interface ExtensionApiSurface {
  on?: unknown;
  registerTool?: unknown;
  registerMessageRenderer?: unknown;
  registerCommand?: unknown;
  getActiveTools?: unknown;
  getAllTools?: unknown;
  setActiveTools?: unknown;
  sendMessage?: unknown;
  exec?: unknown;
  events?: unknown;
}

export type MaybePromise<T> = T | Promise<T>;

export interface HostProbeOverrides {
  nodeVersion?: string;
  platform?: NodeJS.Platform;
  loadPiModule?: () => MaybePromise<unknown>;
  loadProcessTreeAdapter?: (platform: NodeJS.Platform) => MaybePromise<unknown>;
  loadRuntimeDependency?: () => MaybePromise<unknown>;
}

export interface HostProbeInput extends HostProbeOverrides {
  extensionApi: ExtensionApiSurface;
}

export type HostCapabilityFailureReason =
  | "node_version_unparseable"
  | "node_version_unsupported"
  | "pi_module_unavailable"
  | "pi_version_unparseable"
  | "pi_version_unsupported"
  | "platform_unsupported"
  | "process_tree_adapter_unavailable"
  | "host_api_unavailable"
  | "runtime_dependency_unavailable";

export interface HostCapabilityDiagnostic {
  code: typeof HOST_CAPABILITY_DIAGNOSTIC_CODE;
  reason: HostCapabilityFailureReason;
  missingApi?: string[];
}

export type HostCapabilityResult =
  | {
      ok: true;
      nodeVersion: string;
      piVersion: string;
      platform: SupportedPlatform;
      processTreeAdapter: ProcessTreeAdapter;
    }
  | {
      ok: false;
      diagnostic: HostCapabilityDiagnostic;
    };

export type AvailableHostCapabilities = Extract<HostCapabilityResult, { ok: true }>;

export interface PiSubagentExtensionOptions {
  probe?: HostProbeOverrides;
  activate?: (
    extensionApi: ExtensionApiSurface,
    capabilities: AvailableHostCapabilities,
  ) => void | Promise<void>;
}

export type PiSubagentExtensionFactory = (
  extensionApi: ExtensionApiSurface,
) => void | Promise<void>;

interface DiagnosticContext {
  hasUI?: unknown;
  ui?: {
    notify?: unknown;
  };
}

type DiagnosticHandler = (
  event: unknown,
  context: DiagnosticContext | null | undefined,
) => void;

interface SemverApi {
  valid(version: string): string | null;
  satisfies(version: string, range: string): boolean;
}

function unavailable(reason: HostCapabilityFailureReason, missingApi?: string[]): HostCapabilityResult {
  return {
    ok: false,
    diagnostic: {
      code: HOST_CAPABILITY_DIAGNOSTIC_CODE,
      reason,
      ...(missingApi === undefined ? {} : { missingApi }),
    },
  };
}

function readSemverApi(module: unknown): SemverApi | undefined {
  const candidate =
    typeof module === "object" && module !== null && "default" in module ? module.default : module;
  if (typeof candidate !== "object" || candidate === null) return undefined;
  if (!("valid" in candidate) || typeof candidate.valid !== "function") return undefined;
  if (!("satisfies" in candidate) || typeof candidate.satisfies !== "function") return undefined;
  return {
    valid: candidate.valid.bind(candidate) as SemverApi["valid"],
    satisfies: candidate.satisfies.bind(candidate) as SemverApi["satisfies"],
  };
}

function readModuleExport(module: unknown, name: string): unknown {
  if (typeof module !== "object" || module === null) return undefined;
  if (name in module) return module[name as keyof typeof module];
  if ("default" in module && typeof module.default === "object" && module.default !== null && name in module.default) {
    return module.default[name as keyof typeof module.default];
  }
  return undefined;
}

function readPiVersion(module: unknown): string {
  const version = readModuleExport(module, "VERSION");
  return typeof version === "string" ? version : "";
}

const REQUIRED_EXTENSION_API_METHODS = [
  "on",
  "registerTool",
  "registerMessageRenderer",
  "registerCommand",
  "getActiveTools",
  "getAllTools",
  "setActiveTools",
  "sendMessage",
  "exec",
] as const;

const REQUIRED_RPC_CLIENT_METHODS = [
  "start",
  "stop",
  "onEvent",
  "getStderr",
  "prompt",
  "steer",
  "send",
  "abort",
  "getState",
  "waitForIdle",
] as const;

function findMissingHostApi(extensionApi: ExtensionApiSurface, piModule: unknown): string[] {
  const missingApi = REQUIRED_EXTENSION_API_METHODS.filter(
    (name) => typeof extensionApi[name] !== "function",
  );
  const result: string[] = [...missingApi];
  const events = extensionApi.events;
  if (typeof events !== "object" || events === null) {
    result.push("events.emit", "events.on");
  } else {
    const eventBus = events as Record<string, unknown>;
    if (typeof eventBus.emit !== "function") result.push("events.emit");
    if (typeof eventBus.on !== "function") result.push("events.on");
  }
  const rpcClient = readModuleExport(piModule, "RpcClient");
  if (typeof rpcClient !== "function") {
    result.push("RpcClient");
  } else {
    const prototype = rpcClient.prototype as Record<string, unknown> | undefined;
    for (const method of REQUIRED_RPC_CLIENT_METHODS) {
      if (typeof prototype?.[method] !== "function") result.push(`RpcClient.${method}`);
    }
  }
  return result;
}

function isSupportedPlatform(platform: NodeJS.Platform): platform is SupportedPlatform {
  return (SUPPORTED_PLATFORMS as readonly string[]).includes(platform);
}

/** 按宿主平台加载已交付的生产进程树适配器；未验证平台保持失败关闭。 */
async function loadDefaultProcessTreeAdapter(platform: NodeJS.Platform): Promise<unknown> {
  if (platform === "win32") {
    const { WindowsJobObjectAdapter } = await import("./windows-job-object-adapter.ts");
    return new WindowsJobObjectAdapter();
  }
  if (platform === "darwin" || platform === "linux") {
    const { UnixProcessTreeAdapter } = await import("./unix-process-tree-adapter.ts");
    return new UnixProcessTreeAdapter({ platform });
  }
  return undefined;
}

function formatHostCapabilityDiagnostic(diagnostic: HostCapabilityDiagnostic): string {
  const missingApi = diagnostic.missingApi?.join(",");
  const detail = missingApi === undefined ? diagnostic.reason : `${diagnostic.reason}:${missingApi}`;
  return `${diagnostic.code}: Pi 子代理扩展未激活 (${detail})`;
}

function registerUnavailableDiagnostic(
  extensionApi: ExtensionApiSurface,
  diagnostic: HostCapabilityDiagnostic,
): void {
  const on = extensionApi.on as
    | ((event: string, handler: DiagnosticHandler) => void)
    | undefined;
  if (typeof on !== "function") return;

  // 这是唯一允许在门禁失败后保留的生命周期桥，仅负责一次 UI-only 诊断。
  let notified = false;
  try {
    on("session_start", (_event, context) => {
      try {
        if (
          notified ||
          typeof context !== "object" ||
          context === null ||
          context.hasUI !== true ||
          typeof context.ui !== "object" ||
          context.ui === null ||
          typeof context.ui.notify !== "function"
        ) {
          return;
        }
        notified = true;
        context.ui.notify(formatHostCapabilityDiagnostic(diagnostic), "warning");
      } catch {
        // UI 通知失败不得改变宿主会话或启用扩展。
      }
    });
  } catch {
    // 诊断桥不可用时保持静默失活。
  }
}

export async function checkHostCapabilities(input: HostProbeInput): Promise<HostCapabilityResult> {
  const nodeVersion = input.nodeVersion ?? process.versions.node;
  const platform = input.platform ?? process.platform;
  const loadPiModule = input.loadPiModule ?? (() => import("@earendil-works/pi-coding-agent"));
  const loadRuntimeDependency = input.loadRuntimeDependency ?? (() => import("semver"));
  const loadProcessTreeAdapter = input.loadProcessTreeAdapter ?? loadDefaultProcessTreeAdapter;

  let runtimeDependency: unknown;
  try {
    runtimeDependency = await loadRuntimeDependency();
  } catch {
    return unavailable("runtime_dependency_unavailable");
  }
  const semver = readSemverApi(runtimeDependency);
  if (semver === undefined) {
    return unavailable("runtime_dependency_unavailable");
  }
  try {
    if (semver.valid(nodeVersion) === null) {
      return unavailable("node_version_unparseable");
    }
    if (!semver.satisfies(nodeVersion, NODE_VERSION_RANGE)) {
      return unavailable("node_version_unsupported");
    }
  } catch {
    return unavailable("runtime_dependency_unavailable");
  }

  let piModule: unknown;
  try {
    piModule = await loadPiModule();
  } catch {
    return unavailable("pi_module_unavailable");
  }
  const piVersion = readPiVersion(piModule);
  try {
    if (semver.valid(piVersion) === null) {
      return unavailable("pi_version_unparseable");
    }
    if (!semver.satisfies(piVersion, PI_VERSION_RANGE)) {
      return unavailable("pi_version_unsupported");
    }
  } catch {
    return unavailable("runtime_dependency_unavailable");
  }

  const missingApi = findMissingHostApi(input.extensionApi, piModule);
  if (missingApi.length > 0) {
    return unavailable("host_api_unavailable", missingApi);
  }
  if (!isSupportedPlatform(platform)) {
    return unavailable("platform_unsupported");
  }
  let processTreeAdapter: unknown;
  try {
    processTreeAdapter = await loadProcessTreeAdapter(platform);
  } catch {
    return unavailable("process_tree_adapter_unavailable");
  }
  // 生产启动必须证明树句柄和桥接传输来自同一次 launch() 事务；仅有旧
  // 只有同事务 launch() 的适配器才能通过宿主门禁。
  if (!isManagedProcessTreeAdapter(processTreeAdapter, platform)) {
    return unavailable("process_tree_adapter_unavailable");
  }

  return {
    ok: true,
    nodeVersion,
    piVersion,
    platform,
    processTreeAdapter,
  };
}

export function createPiSubagentExtension(
  options: PiSubagentExtensionOptions = {},
): PiSubagentExtensionFactory {
  return async (extensionApi) => {
    const reloadHold = holdRuntimeReloadLeaseDuringActivation();
    try {
      const capabilities = await checkHostCapabilities({
        ...options.probe,
        extensionApi,
      });
      if (!capabilities.ok) {
        registerUnavailableDiagnostic(extensionApi, capabilities.diagnostic);
        return;
      }
      await options.activate?.(extensionApi, capabilities);
    } finally {
      await reloadHold.release();
    }
  };
}
