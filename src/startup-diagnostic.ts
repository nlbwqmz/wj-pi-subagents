/** bridge 可以向父端公开的脱敏启动诊断闭集。 */
export const MANAGED_RPC_STARTUP_ERROR_CODES = Object.freeze([
  "provider_unavailable",
  "model_unavailable",
  "extension_load_failed",
] as const);

export type ManagedRpcStartupErrorCode = (typeof MANAGED_RPC_STARTUP_ERROR_CODES)[number];

/**
 * 公开诊断只允许这些字段。所有值都是不可执行、无路径分隔符的标识或标签，
 * 且每个边界都会重新创建冻结副本，绝不保留调用方对象引用。
 */
export interface StartupDiagnosticDetails {
  readonly provider?: string;
  readonly model?: string;
  readonly extension?: string;
}

/** 与既有 Managed RPC API 保持兼容的名称。 */
export type ManagedRpcStartupErrorDetails = StartupDiagnosticDetails;

export interface ManagedRpcStartupDiagnostic {
  readonly code: ManagedRpcStartupErrorCode;
  readonly details: ManagedRpcStartupErrorDetails;
}

export interface PiStartupDiagnosticContext {
  readonly provider?: unknown;
  readonly model?: unknown;
  readonly args?: unknown;
}

export const EMPTY_STARTUP_DIAGNOSTIC_DETAILS: StartupDiagnosticDetails = Object.freeze({});

const MAX_ERROR_TEXT_BYTES = 64 * 1024;
const MAX_EXTENSION_SOURCE_BYTES = 16 * 1024;
const SAFE_PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const SAFE_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,511}$/;
const SAFE_EXTENSION_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/gu;
const URI_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const WINDOWS_PATH_PATTERN = /^[A-Za-z]:[\\/]/u;
const NPM_PACKAGE_PATTERN = /^(?:[a-z0-9][a-z0-9._-]{0,127}|@[a-z0-9][a-z0-9._-]{0,127}\/[a-z0-9][a-z0-9._-]{0,127})$/u;

/** 判断错误码是否支持启动诊断 details。 */
export function isStartupDiagnosticCode(value: unknown): value is ManagedRpcStartupErrorCode {
  return typeof value === "string"
    && (MANAGED_RPC_STARTUP_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * 将不可信 details 投影为公开闭集。无效字段、额外字段和不支持的错误码都会被
 * 丢弃；返回值始终是新的冻结数据或共享的冻结空对象。
 */
export function normalizeStartupDiagnosticDetails(
  code: unknown,
  value: unknown,
): StartupDiagnosticDetails {
  try {
    if (!isStartupDiagnosticCode(code)) return EMPTY_STARTUP_DIAGNOSTIC_DETAILS;
    const record = plainDataRecord(value);
    if (record === undefined) return EMPTY_STARTUP_DIAGNOSTIC_DETAILS;
    const provider = safeProvider(readOwnDataValue(record, "provider"));
    const model = safeModel(readOwnDataValue(record, "model"));
    const extension = safeExtensionLabel(readOwnDataValue(record, "extension"));
    if (code === "provider_unavailable") {
      return provider === undefined ? EMPTY_STARTUP_DIAGNOSTIC_DETAILS : freezeDetails({ provider });
    }
    if (code === "model_unavailable") {
      return provider === undefined && model === undefined
        ? EMPTY_STARTUP_DIAGNOSTIC_DETAILS
        : freezeDetails({
            ...(provider === undefined ? {} : { provider }),
            ...(model === undefined ? {} : { model }),
          });
    }
    return extension === undefined
      ? EMPTY_STARTUP_DIAGNOSTIC_DETAILS
      : freezeDetails({ extension });
  } catch {
    return EMPTY_STARTUP_DIAGNOSTIC_DETAILS;
  }
}

/**
 * 检查输入是否已经是当前协议要求的精确 canonical details。该函数用于 wire 和
 * snapshot parser；控制面创建结果时应使用 normalizeStartupDiagnosticDetails()。
 */
export function isCanonicalStartupDiagnosticDetails(code: unknown, value: unknown): boolean {
  try {
    if (!isStartupDiagnosticCode(code)) return false;
    const record = plainDataRecord(value);
    if (record === undefined) return false;
    const canonical = normalizeStartupDiagnosticDetails(code, record);
    const keys = Object.keys(record);
    const canonicalKeys = Object.keys(canonical);
    return keys.length === canonicalKeys.length
      && keys.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        return descriptor !== undefined
          && "value" in descriptor
          && descriptor.value === (canonical as Record<string, unknown>)[key];
      });
  } catch {
    return false;
  }
}

/** 公开 details 是否包含至少一个已验证的诊断字段。 */
export function hasStartupDiagnosticDetails(value: StartupDiagnosticDetails): boolean {
  return Object.keys(value).length > 0;
}

/** 只识别有稳定 Pi 文案依据的错误，不把任意 stderr 内容带入协议。 */
export function classifyPiStartupError(
  error: unknown,
  context: PiStartupDiagnosticContext = {},
): ManagedRpcStartupDiagnostic | undefined {
  const text = boundedErrorText(error).replace(ANSI_ESCAPE_PATTERN, "");
  if (
    text.includes("Failed to load extension")
    || text.includes("Extension does not export a valid factory function")
  ) {
    const extension = findFailedExtension(text, context.args);
    return makeStartupDiagnostic("extension_load_failed", {
      ...(extension === undefined ? {} : { extension }),
    });
  }
  if (/Unknown provider "[^"\r\n]+"\./u.test(text)) {
    // 上游 stderr 仅作为分类依据。实际公开的 provider 必须来自配置并经校验，
    // 因而伪造 stderr 无法替换或注入可见标识。
    const provider = safeProvider(context.provider);
    return makeStartupDiagnostic("provider_unavailable", {
      ...(provider === undefined ? {} : { provider }),
    });
  }
  if (/Model "[^"\r\n]+" not found(?:\.|\s)/u.test(text) || text.includes("No models available.")) {
    const provider = safeProvider(context.provider);
    const model = safeModel(context.model);
    return makeStartupDiagnostic("model_unavailable", {
      ...(provider === undefined ? {} : { provider }),
      ...(model === undefined ? {} : { model }),
    });
  }
  return undefined;
}

/** 父 bridge 客户端对不可信子进程帧执行严格解析。 */
export function parseManagedRpcStartupDiagnostic(
  value: unknown,
): ManagedRpcStartupDiagnostic | undefined {
  try {
    const record = plainDataRecord(value);
    if (
      record === undefined
      || !hasExactOwnDataKeys(record, ["code", "details"])
      || !isStartupDiagnosticCode(readOwnDataValue(record, "code"))
    ) return undefined;
    const code = readOwnDataValue(record, "code") as ManagedRpcStartupErrorCode;
    const details = readOwnDataValue(record, "details");
    if (!isCanonicalStartupDiagnosticDetails(code, details)) return undefined;
    return makeStartupDiagnostic(code, details);
  } catch {
    return undefined;
  }
}

/** 启动失败异常只携带已通过闭集校验、复制并冻结的诊断。 */
export class ManagedRpcStartupError extends Error {
  readonly code: ManagedRpcStartupErrorCode;
  readonly details: ManagedRpcStartupErrorDetails;

  constructor(diagnostic: ManagedRpcStartupDiagnostic) {
    super("受管 RPC 子进程启动失败");
    this.name = "ManagedRpcStartupError";
    const canonical = parseManagedRpcStartupDiagnostic(diagnostic);
    if (canonical === undefined) throw new TypeError("受管 RPC 启动诊断无效");
    this.code = canonical.code;
    this.details = canonical.details;
    Object.freeze(this);
  }
}

/** 从启动配置来源派生不可逆、安全的扩展标签，绝不返回源字符串本身。 */
export function extensionDiagnosticLabelFromSource(source: unknown): string | undefined {
  if (typeof source !== "string" || utf8Length(source) > MAX_EXTENSION_SOURCE_BYTES) return undefined;
  if (source.startsWith("npm:")) return npmPackageLabel(source.slice("npm:".length));
  if (/^git(?:\+[^:]+)?:/iu.test(source) || /^git@/iu.test(source)) return "git-extension";
  if (/^file:/iu.test(source)) return fileUrlExtensionLabel(source);
  if (URI_SCHEME_PATTERN.test(source) && !WINDOWS_PATH_PATTERN.test(source)) return "remote-extension";
  return localExtensionLabel(source);
}

function makeStartupDiagnostic(
  code: ManagedRpcStartupErrorCode,
  details: unknown,
): ManagedRpcStartupDiagnostic {
  return Object.freeze({
    code,
    details: normalizeStartupDiagnosticDetails(code, details),
  });
}

function boundedErrorText(error: unknown): string {
  let text = "";
  try {
    text = error instanceof Error ? error.message : String(error);
  } catch {
    return "";
  }
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= MAX_ERROR_TEXT_BYTES) return text;
  return new TextDecoder().decode(bytes.subarray(bytes.byteLength - MAX_ERROR_TEXT_BYTES));
}

function safeProvider(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_PROVIDER_PATTERN.test(value) ? value : undefined;
}

function safeModel(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_MODEL_PATTERN.test(value) ? value : undefined;
}

function safeExtensionLabel(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_EXTENSION_LABEL_PATTERN.test(value) ? value : undefined;
}

function findFailedExtension(text: string, args: unknown): string | undefined {
  if (!Array.isArray(args) || args.some((item) => typeof item !== "string")) return undefined;
  const candidates: string[] = [];
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === "-e" || args[index] === "--extension") candidates.push(args[index + 1] as string);
  }
  const normalizedText = text.replaceAll("\\", "/").toLowerCase();
  const source = candidates.find((candidate) => {
    if (candidate.length === 0 || utf8Length(candidate) > MAX_EXTENSION_SOURCE_BYTES) return false;
    return normalizedText.includes(candidate.replaceAll("\\", "/").toLowerCase());
  });
  return source === undefined ? undefined : extensionDiagnosticLabelFromSource(source);
}

function npmPackageLabel(value: string): string | undefined {
  if (!NPM_PACKAGE_PATTERN.test(value)) return undefined;
  if (!value.startsWith("@")) return safeExtensionLabel(value);
  const [scope, packageName] = value.slice(1).split("/");
  if (scope === undefined || packageName === undefined) return undefined;
  // 连字符连接是故意有损的，不能据此恢复原始 scoped source。
  return safeExtensionLabel(`${scope}-${packageName}`);
}

function fileUrlExtensionLabel(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "file:"
      || url.username !== ""
      || url.password !== ""
      || url.host !== ""
      || url.search !== ""
      || url.hash !== ""
    ) return undefined;
    const encodedName = url.pathname.split("/").at(-1);
    if (encodedName === undefined || encodedName.length === 0) return undefined;
    return safeExtensionLabel(decodeURIComponent(encodedName));
  } catch {
    return undefined;
  }
}

function localExtensionLabel(value: string): string | undefined {
  const name = value.replaceAll("\\", "/").split("/").at(-1);
  return name === undefined ? undefined : safeExtensionLabel(name);
}

function freezeDetails(value: StartupDiagnosticDetails): StartupDiagnosticDetails {
  return Object.freeze({ ...value });
}

function plainDataRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) return undefined;
  }
  return record;
}

function readOwnDataValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function hasExactOwnDataKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
