import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** 根会话启动时固定的数量配置字段。 */
export const RUNTIME_CONFIG_FIELDS = [
  "maxDepth",
  "maxChildrenPerAgent",
  "maxAgentsPerTree",
  "waitTimeoutMs",
] as const;

export type RuntimeConfigField = (typeof RUNTIME_CONFIG_FIELDS)[number];

export interface RuntimeConfig {
  readonly maxDepth: number;
  readonly maxChildrenPerAgent: number;
  readonly maxAgentsPerTree: number;
  readonly waitTimeoutMs: number;
}

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = Object.freeze({
  maxDepth: 2,
  maxChildrenPerAgent: 4,
  maxAgentsPerTree: 16,
  waitTimeoutMs: 60_000,
});

export interface RuntimeConfigLimit {
  readonly min: number;
  readonly max: number;
}

export const RUNTIME_CONFIG_LIMITS: Readonly<Record<RuntimeConfigField, RuntimeConfigLimit>> = Object.freeze({
  maxDepth: Object.freeze({ min: 1, max: 8 }),
  maxChildrenPerAgent: Object.freeze({ min: 1, max: 16 }),
  maxAgentsPerTree: Object.freeze({ min: 1, max: 64 }),
  waitTimeoutMs: Object.freeze({ min: 10_000, max: 600_000 }),
});

export const RUNTIME_INTERNAL_ENV_KEYS = Object.freeze({
  rootId: "PI_SUBAGENT_ROOT_ID",
  parentAgentId: "PI_SUBAGENT_PARENT_AGENT_ID",
  agentId: "PI_SUBAGENT_AGENT_ID",
  depth: "PI_SUBAGENT_DEPTH",
  maxDepth: "PI_SUBAGENT_MAX_DEPTH",
  protocolVersion: "PI_SUBAGENT_PROTOCOL_VERSION",
});

type RuntimeMetadataField = keyof typeof RUNTIME_INTERNAL_ENV_KEYS;
const RUNTIME_METADATA_FIELDS = Object.freeze(
  Object.keys(RUNTIME_INTERNAL_ENV_KEYS) as RuntimeMetadataField[],
);

export type RuntimeConfigSource =
  | "root_argument"
  | "project"
  | "user"
  | "builtin_default"
  | "builtin_default_after_invalid_layer";

export type RuntimeConfigDiagnosticReason =
  | "file_unreadable"
  | "invalid_json"
  | "invalid_shape"
  | "invalid_value"
  | "unknown_field";

/** 配置诊断只保存逻辑来源和安全摘要，不保存路径、正文或底层异常。 */
export interface RuntimeConfigDiagnostic {
  readonly code: "runtime_config_diagnostic";
  readonly source: "project" | "user";
  readonly field: string;
  readonly reason: RuntimeConfigDiagnosticReason;
  readonly adoptedValue: number | "ignored";
}

export interface RuntimeConfigResolution {
  readonly config: RuntimeConfig;
  readonly sources: Readonly<Record<RuntimeConfigField, RuntimeConfigSource>>;
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
}

export type EnvironmentInput =
  | NodeJS.ProcessEnv
  | Readonly<Record<string, string | number | undefined>>
  | undefined;

/** 只在测试或宿主适配时替换读取实现；配置路径始终由本模块固定计算。 */
export interface RuntimeConfigFileReader {
  readonly readFile: (path: string) => Uint8Array;
}

/** 仅根控制器可提供的树级运行元数据。 */
export interface RootRuntimeControllerMetadata {
  readonly rootId?: string;
  readonly protocolVersion?: string;
}

/** 仅控制器在创建一个节点时填写的节点身份。 */
export interface ChildRuntimeIdentity {
  readonly parentAgentId: string;
  readonly agentId: string;
  readonly depth: number;
}

export interface ChildRuntimeMetadata extends ChildRuntimeIdentity {
  readonly rootId?: string;
  readonly maxDepth: number;
  readonly protocolVersion?: string;
}

export interface ChildRuntimeContext {
  readonly cwd: string;
  readonly projectTrust: boolean;
  readonly environment: Readonly<Record<string, string>>;
  readonly config: RuntimeConfig;
  readonly metadata: Readonly<ChildRuntimeMetadata>;
  readonly resolvePath: (path: string) => string;
  readonly createChildRuntimeContext: (identity: ChildRuntimeIdentity) => ChildRuntimeContext;
}

export interface RootRuntimeContext {
  readonly cwd: string;
  readonly projectTrust: boolean;
  readonly environment: Readonly<Record<string, string>>;
  readonly config: RuntimeConfig;
  readonly configSources: Readonly<Record<RuntimeConfigField, RuntimeConfigSource>>;
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
  readonly resolvePath: (path: string) => string;
  readonly createChildRuntimeContext: (identity: ChildRuntimeIdentity) => ChildRuntimeContext;
  readonly notifyDiagnostics: (context: RuntimeUiContext | null | undefined) => boolean;
  readonly toJSON: () => Record<string, unknown>;
}

export interface RootRuntimeContextOptions {
  readonly cwd?: string;
  readonly projectTrust?: boolean;
  readonly environment?: EnvironmentInput;
  /** 显式根启动参数；存在的字段会严格校验。 */
  readonly rootArguments?: unknown;
  readonly controllerMetadata?: RootRuntimeControllerMetadata;
  readonly uiContext?: RuntimeUiContext | null;
}

export interface RuntimeUiContext {
  readonly hasUI?: unknown;
  readonly ui?: { readonly notify?: unknown };
}

export class InvalidRootRuntimeConfigError extends Error {
  readonly code = "invalid_root_runtime_config" as const;
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`根启动参数 ${safeFieldName(field)} 无效：${reason}`);
    this.name = "InvalidRootRuntimeConfigError";
    this.field = field;
  }
}

function safeFieldName(field: string): string {
  if (/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(field)) return field;
  return "<unknown>";
}

function own(object: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function freezeRecord<T extends object>(record: T): Readonly<T> {
  return Object.freeze(record);
}

function snapshotEnvironment(input: EnvironmentInput): Readonly<Record<string, string>> {
  const source = input ?? process.env;
  const snapshot: Record<string, string> = {};
  try {
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined) {
        Object.defineProperty(snapshot, key, {
          configurable: true,
          enumerable: true,
          value: String(value),
          writable: true,
        });
      }
    }
  } catch {
    // 不把环境对象或底层异常带出根上下文边界。
    throw new Error("根环境快照不可用");
  }
  return freezeRecord(snapshot);
}

function safePath(base: string, target: string): string {
  return isAbsolute(target) ? resolve(target) : resolve(base, target);
}

function safeDiagnosticField(field: string): string {
  return safeFieldName(field);
}

function snapshotControllerMetadata(
  metadata: RootRuntimeControllerMetadata | undefined,
): Readonly<RootRuntimeControllerMetadata> {
  if (metadata === undefined) return freezeRecord({});
  const snapshot: RootRuntimeControllerMetadata = {
    ...(metadata.rootId === undefined ? {} : { rootId: metadata.rootId }),
    ...(metadata.protocolVersion === undefined ? {} : { protocolVersion: metadata.protocolVersion }),
  };
  return freezeRecord(snapshot);
}

function appendInternalEnvironmentMetadata(
  target: Record<string, string>,
  metadata: ChildRuntimeMetadata,
): void {
  const caseInsensitive = process.platform === "win32";
  const internalKeys = Object.values(RUNTIME_INTERNAL_ENV_KEYS);
  for (const existingKey of Object.keys(target)) {
    if (internalKeys.some((key) => caseInsensitive
      ? key.toLowerCase() === existingKey.toLowerCase()
      : key === existingKey)) {
      delete target[existingKey];
    }
  }
  for (const field of RUNTIME_METADATA_FIELDS) {
    const value = metadata[field];
    if (value === undefined) continue;
    const key = RUNTIME_INTERNAL_ENV_KEYS[field];
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      value: String(value),
      writable: true,
    });
  }
}

function isRuntimeConfigField(value: string): value is RuntimeConfigField {
  return (RUNTIME_CONFIG_FIELDS as readonly string[]).includes(value);
}

function isValidRuntimeConfigValue(field: RuntimeConfigField, value: unknown): value is number {
  const limits = RUNTIME_CONFIG_LIMITS[field];
  return typeof value === "number" && Number.isInteger(value) && value >= limits.min && value <= limits.max;
}

function invalidRootReason(field: RuntimeConfigField): string {
  const limits = RUNTIME_CONFIG_LIMITS[field];
  return `必须是 ${limits.min}..${limits.max} 的整数`;
}

interface ConfigLayer {
  readonly kind: "absent" | "valid" | "invalid";
  readonly values?: Readonly<Record<string, unknown>>;
  readonly reason?: Exclude<RuntimeConfigDiagnosticReason, "unknown_field" | "invalid_value">;
  readonly unknownFields: readonly string[];
}

function invalidLayer(
  reason: Exclude<RuntimeConfigDiagnosticReason, "unknown_field" | "invalid_value">,
): ConfigLayer {
  return { kind: "invalid", reason, unknownFields: [] };
}

function absentLayer(): ConfigLayer {
  return { kind: "absent", unknownFields: [] };
}

function parseConfigObject(value: unknown): ConfigLayer {
  if (value === undefined) return absentLayer();
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidLayer("invalid_shape");
  }

  const object = value as Record<string, unknown>;
  let keys: string[];
  try {
    keys = Object.keys(object);
  } catch {
    return invalidLayer("invalid_shape");
  }
  const unknownFields = keys.filter((key) => !isRuntimeConfigField(key));
  return {
    kind: "valid",
    values: object,
    unknownFields,
  };
}

function decodeUtf8(value: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new Error("无效 UTF-8");
  }
}

function readConfigLayer(
  filePath: string,
  fileReader: RuntimeConfigFileReader | undefined,
): ConfigLayer {
  // 内置读取保留原始字节，随后以 fatal UTF-8 解码，避免替换字符掩盖编码错误。
  const reader = fileReader?.readFile ?? ((path: string) => readFileSync(path));
  let raw: Uint8Array;
  try {
    raw = reader(filePath);
  } catch (error) {
    let code: unknown;
    try {
      code = typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    } catch {
      code = undefined;
    }
    if (code === "ENOENT") return absentLayer();
    return invalidLayer("file_unreadable");
  }

  let text: string;
  try {
    text = decodeUtf8(raw);
  } catch {
    return invalidLayer("invalid_json");
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return invalidLayer("invalid_json");
  }
  return parseConfigObject(parsed);
}

function validateExplicitRootArguments(
  options: RootRuntimeContextOptions,
): Readonly<Record<string, unknown>> | undefined {
  if (!own(options, "rootArguments")) return undefined;
  const value = options.rootArguments;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidRootRuntimeConfigError("config", "必须是对象");
  }

  const object = value as Record<string, unknown>;
  for (const field of RUNTIME_CONFIG_FIELDS) {
    if (!own(object, field)) continue;
    const candidate = object[field];
    if (!isValidRuntimeConfigValue(field, candidate)) {
      throw new InvalidRootRuntimeConfigError(field, invalidRootReason(field));
    }
  }
  return object;
}

function diagnosticForInvalidLayer(
  source: "project" | "user",
  layer: ConfigLayer,
  field: RuntimeConfigField,
): RuntimeConfigDiagnostic {
  return Object.freeze({
    code: "runtime_config_diagnostic",
    source,
    field,
    reason: layer.reason ?? "invalid_shape",
    adoptedValue: DEFAULT_RUNTIME_CONFIG[field],
  });
}

function diagnosticForInvalidValue(
  source: "project" | "user",
  field: RuntimeConfigField,
): RuntimeConfigDiagnostic {
  return Object.freeze({
    code: "runtime_config_diagnostic",
    source,
    field,
    reason: "invalid_value",
    adoptedValue: DEFAULT_RUNTIME_CONFIG[field],
  });
}

function diagnosticForUnknownField(source: "project" | "user", field: string): RuntimeConfigDiagnostic {
  return Object.freeze({
    code: "runtime_config_diagnostic",
    source,
    field: safeDiagnosticField(field),
    reason: "unknown_field",
    adoptedValue: "ignored",
  });
}

interface CapturedRuntimeConfigInputs {
  readonly cwd: string;
  readonly projectTrust: boolean;
  readonly explicit: Readonly<Record<string, unknown>> | undefined;
}

function captureRuntimeConfigInputs(options: RootRuntimeContextOptions): CapturedRuntimeConfigInputs {
  const explicit = validateExplicitRootArguments(options);
  return Object.freeze({
    cwd: resolve(options.cwd ?? process.cwd()),
    projectTrust: options.projectTrust === true,
    explicit,
  });
}

/**
 * 按字段解析根配额。配置层一旦在某字段上出错，直接使用该字段默认值，
 * 不回退到更低优先级；其余字段仍可独立继续解析。
 */
function resolveRuntimeConfigInternal(
  inputs: CapturedRuntimeConfigInputs,
  fileReader: RuntimeConfigFileReader | undefined,
): RuntimeConfigResolution {
  const { cwd, explicit, projectTrust } = inputs;
  const projectPath = join(cwd, ".pi", "subagent.json");
  const userPath = join(homedir(), ".pi", "agent", "subagent.json");
  const needsFileConfig = RUNTIME_CONFIG_FIELDS.some(
    (field) => explicit === undefined || !own(explicit, field),
  );
  const projectLayer = !needsFileConfig || !projectTrust
    ? absentLayer()
    : readConfigLayer(projectPath, fileReader);
  const unresolvedAfterProject = needsFileConfig && (
    projectLayer.kind === "absent" ||
    (projectLayer.kind === "valid" && RUNTIME_CONFIG_FIELDS.some((field) => {
      if (explicit !== undefined && own(explicit, field)) return false;
      return projectLayer.values === undefined || !own(projectLayer.values, field);
    }))
  );
  const userLayer = !unresolvedAfterProject
    ? absentLayer()
    : readConfigLayer(userPath, fileReader);

  const diagnostics: RuntimeConfigDiagnostic[] = [];
  for (const [source, layer] of [["project", projectLayer], ["user", userLayer]] as const) {
    for (const field of layer.unknownFields) diagnostics.push(diagnosticForUnknownField(source, field));
  }

  const values: Record<RuntimeConfigField, number> = { ...DEFAULT_RUNTIME_CONFIG };
  const sources: Record<RuntimeConfigField, RuntimeConfigSource> = {
    maxDepth: "builtin_default",
    maxChildrenPerAgent: "builtin_default",
    maxAgentsPerTree: "builtin_default",
    waitTimeoutMs: "builtin_default",
  };

  for (const field of RUNTIME_CONFIG_FIELDS) {
    if (explicit !== undefined && own(explicit, field)) {
      values[field] = explicit[field] as number;
      sources[field] = "root_argument";
      continue;
    }

    let selected: RuntimeConfigSource = "builtin_default";
    let selectedValue: number | undefined;
    for (const [source, layer] of [["project", projectLayer], ["user", userLayer]] as const) {
      if (layer.kind === "absent") continue;
      if (layer.kind === "invalid") {
        diagnostics.push(diagnosticForInvalidLayer(source, layer, field));
        selected = "builtin_default_after_invalid_layer";
        selectedValue = DEFAULT_RUNTIME_CONFIG[field];
        break;
      }
      const layerValues = layer.values;
      if (layerValues === undefined || !own(layerValues, field)) continue;
      let candidate: unknown;
      try {
        candidate = layerValues[field];
      } catch {
        diagnostics.push(diagnosticForInvalidValue(source, field));
        selected = "builtin_default_after_invalid_layer";
        selectedValue = DEFAULT_RUNTIME_CONFIG[field];
        break;
      }
      if (!isValidRuntimeConfigValue(field, candidate)) {
        diagnostics.push(diagnosticForInvalidValue(source, field));
        selected = "builtin_default_after_invalid_layer";
        selectedValue = DEFAULT_RUNTIME_CONFIG[field];
        break;
      }
      selected = source;
      selectedValue = candidate;
      break;
    }
    values[field] = selectedValue ?? DEFAULT_RUNTIME_CONFIG[field];
    sources[field] = selected;
  }

  return {
    config: freezeRecord(values),
    sources: freezeRecord(sources),
    diagnostics: Object.freeze(diagnostics),
  };
}

export function resolveRuntimeConfig(
  options: RootRuntimeContextOptions = {},
  fileReader?: RuntimeConfigFileReader,
): RuntimeConfigResolution {
  return resolveRuntimeConfigInternal(captureRuntimeConfigInputs(options), fileReader);
}

function createChildMetadata(
  identity: ChildRuntimeIdentity,
  controllerMetadata: Readonly<RootRuntimeControllerMetadata>,
  maxDepth: number,
): Readonly<ChildRuntimeMetadata> {
  return freezeRecord({
    ...(controllerMetadata?.rootId === undefined ? {} : { rootId: controllerMetadata.rootId }),
    parentAgentId: identity.parentAgentId,
    agentId: identity.agentId,
    depth: identity.depth,
    maxDepth,
    ...(controllerMetadata?.protocolVersion === undefined
      ? {}
      : { protocolVersion: controllerMetadata.protocolVersion }),
  });
}

class ChildRuntimeContextImpl implements ChildRuntimeContext {
  readonly cwd: string;
  readonly projectTrust: boolean;
  readonly environment: Readonly<Record<string, string>>;
  readonly config: RuntimeConfig;
  readonly metadata: Readonly<ChildRuntimeMetadata>;
  readonly resolvePath: (path: string) => string;
  readonly createChildRuntimeContext: (identity: ChildRuntimeIdentity) => ChildRuntimeContext;

  constructor(
    cwd: string,
    projectTrust: boolean,
    environment: Readonly<Record<string, string>>,
    config: RuntimeConfig,
    metadata: Readonly<ChildRuntimeMetadata>,
    createChild: (identity: ChildRuntimeIdentity) => ChildRuntimeContext,
  ) {
    this.cwd = cwd;
    this.projectTrust = projectTrust;
    this.environment = environment;
    this.config = config;
    this.metadata = metadata;
    this.resolvePath = (path: string) => safePath(this.cwd, path);
    this.createChildRuntimeContext = createChild;
    Object.freeze(this);
  }

  toJSON(): Record<string, unknown> {
    return {
      projectTrust: this.projectTrust,
      config: this.config,
      metadata: this.metadata,
    };
  }
}

class RootRuntimeContextImpl implements RootRuntimeContext {
  readonly cwd: string;
  readonly projectTrust: boolean;
  readonly environment: Readonly<Record<string, string>>;
  readonly config: RuntimeConfig;
  readonly configSources: Readonly<Record<RuntimeConfigField, RuntimeConfigSource>>;
  readonly diagnostics: readonly RuntimeConfigDiagnostic[];
  readonly resolvePath: (path: string) => string;
  readonly createChildRuntimeContext: (identity: ChildRuntimeIdentity) => ChildRuntimeContext;
  readonly notifyDiagnostics: (context: RuntimeUiContext | null | undefined) => boolean;

  constructor(
    cwd: string,
    projectTrust: boolean,
    environment: Readonly<Record<string, string>>,
    resolution: RuntimeConfigResolution,
    controllerMetadata: Readonly<RootRuntimeControllerMetadata>,
  ) {
    this.cwd = cwd;
    this.projectTrust = projectTrust;
    this.environment = environment;
    this.config = resolution.config;
    this.configSources = resolution.sources;
    this.diagnostics = resolution.diagnostics;
    this.resolvePath = (path: string) => safePath(this.cwd, path);
    let diagnosticsNotified = false;
    const createChild = (identity: ChildRuntimeIdentity): ChildRuntimeContext => {
      const metadata = createChildMetadata(identity, controllerMetadata, this.config.maxDepth);
      const childEnvironment: Record<string, string> = { ...this.environment };
      // 启动环境始终回到根快照，再由控制器追加当前节点元数据。
      appendInternalEnvironmentMetadata(childEnvironment, metadata);
      return new ChildRuntimeContextImpl(
        this.cwd,
        this.projectTrust,
        freezeRecord(childEnvironment),
        this.config,
        metadata,
        createChild,
      );
    };
    this.createChildRuntimeContext = createChild;
    this.notifyDiagnostics = (context: RuntimeUiContext | null | undefined) => {
      if (diagnosticsNotified) return false;
      if (
        this.diagnostics.length === 0 ||
        context?.hasUI !== true ||
        typeof context.ui?.notify !== "function"
      ) {
        return false;
      }
      diagnosticsNotified = true;
      return notifyRuntimeConfigDiagnostics(this.diagnostics, context);
    };
    Object.freeze(this);
  }

  toJSON(): Record<string, unknown> {
    // 环境快照供启动器内部使用，但不会随着上下文/树状态序列化。
    return {
      projectTrust: this.projectTrust,
      config: this.config,
      configSources: this.configSources,
      diagnostics: this.diagnostics,
    };
  }
}

/** 捕获根会话的固定工作基础；调用一次后返回的对象不会重新读取环境或配置。 */
export function captureRootRuntimeContext(
  options: RootRuntimeContextOptions = {},
  fileReader?: RuntimeConfigFileReader,
): RootRuntimeContext {
  // 先校验显式根参数，非法时不读取配置或环境，也不建立运行中的诊断。
  const inputs = captureRuntimeConfigInputs(options);
  const environment = snapshotEnvironment(options.environment);
  const controllerMetadata = snapshotControllerMetadata(options.controllerMetadata);
  // 将已捕获的工作目录和信任结果传入解析器，避免解析阶段再次读取可变宿主状态。
  const resolution = resolveRuntimeConfigInternal(inputs, fileReader);
  const context = new RootRuntimeContextImpl(
    inputs.cwd,
    inputs.projectTrust,
    environment,
    resolution,
    controllerMetadata,
  );
  context.notifyDiagnostics(options.uiContext);
  return context;
}

/**
 * 根控制器使用的单次捕获容器。它不会因为子代理创建或父进程环境变化而重新解析。
 */
export class RootRuntimeContextStore {
  private context: RootRuntimeContext | undefined;

  capture(
    options: RootRuntimeContextOptions = {},
    fileReader?: RuntimeConfigFileReader,
  ): RootRuntimeContext {
    if (this.context !== undefined) return this.context;
    this.context = captureRootRuntimeContext(options, fileReader);
    return this.context;
  }

  get(): RootRuntimeContext | undefined {
    return this.context;
  }
}

export function createChildRuntimeContext(
  root: Pick<RootRuntimeContext, "createChildRuntimeContext">,
  identity: ChildRuntimeIdentity,
): ChildRuntimeContext {
  return root.createChildRuntimeContext(identity);
}

export function formatRuntimeConfigDiagnostic(diagnostic: RuntimeConfigDiagnostic): string {
  const source = diagnostic.source === "project" ? "项目" : "用户";
  const field = safeDiagnosticField(diagnostic.field);
  switch (diagnostic.reason) {
    case "unknown_field":
      return `${source}配置中的未知字段 ${field} 已忽略；采用值 忽略`;
    case "file_unreadable":
      return `${source}配置不可读；字段 ${field} 使用默认值 ${String(diagnostic.adoptedValue)}`;
    case "invalid_json":
      return `${source}配置 JSON 无法解析；字段 ${field} 使用默认值 ${String(diagnostic.adoptedValue)}`;
    case "invalid_shape":
      return `${source}配置结构无效；字段 ${field} 使用默认值 ${String(diagnostic.adoptedValue)}`;
    case "invalid_value":
      return `${source}配置字段 ${field} 的值无效；使用默认值 ${String(diagnostic.adoptedValue)}`;
  }
}

export function formatRuntimeConfigDiagnostics(
  diagnostics: readonly RuntimeConfigDiagnostic[],
): string {
  if (diagnostics.length === 0) return "";
  return diagnostics.map(formatRuntimeConfigDiagnostic).join("；");
}

/** 只通过 UI notify 汇总一次诊断；无 UI 或通知失败时保持静默。 */
export function notifyRuntimeConfigDiagnostics(
  diagnostics: readonly RuntimeConfigDiagnostic[],
  context: RuntimeUiContext | null | undefined,
): boolean {
  if (diagnostics.length === 0 || context?.hasUI !== true || typeof context.ui?.notify !== "function") {
    return false;
  }
  try {
    (context.ui.notify as (message: string, type: string) => void)(
      formatRuntimeConfigDiagnostics(diagnostics),
      "warning",
    );
    return true;
  } catch {
    return false;
  }
}
