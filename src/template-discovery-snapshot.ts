import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isMap, isScalar, parseDocument } from "yaml";
import type { RuntimeUiContext } from "./root-runtime-context.ts";

export type TemplateSource = "user" | "project";

export const TEMPLATE_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type TemplateThinkingLevel = (typeof TEMPLATE_THINKING_LEVELS)[number];

export interface TemplateDirectoryEntry {
  readonly name: string;
  readonly kind: "file" | "symbolic_link" | "directory" | "other";
}

/** 文件系统是发现边界；生产实现只从固定的两个目录读取。 */
export interface TemplateDiscoveryFileSystem {
  readonly readDirectory: (path: string) => readonly TemplateDirectoryEntry[];
  readonly readFile: (path: string) => Uint8Array;
}

export interface TemplateDefinition {
  readonly templateId: string;
  readonly source: TemplateSource;
  readonly tools: readonly string[];
  readonly description?: string;
  readonly subagents: "inherit" | "disabled";
  readonly contextFiles: "enabled" | "disabled";
  readonly systemPromptMode: "append" | "replace";
  readonly model?: string;
  readonly thinking?: TemplateThinkingLevel;
  readonly body: string;
}

export type TemplateCandidateDiagnosticReason =
  | "file_unreadable"
  | "invalid_utf8"
  | "frontmatter_missing"
  | "frontmatter_invalid"
  | "tools_invalid"
  | "unknown_tool"
  | "description_invalid"
  | "subagents_invalid"
  | "context_files_invalid"
  | "system_prompt_mode_invalid"
  | "model_invalid"
  | "thinking_invalid";

/** 候选诊断不保存底层路径、模板正文、异常文本或堆栈。 */
export interface TemplateCandidateDiagnostic {
  readonly source: TemplateSource;
  readonly templateId: string;
  readonly fileName: string;
  readonly reason: TemplateCandidateDiagnosticReason;
}

export interface TemplateSourceDiagnostic {
  readonly source: TemplateSource;
  readonly reason: "directory_unreadable";
}

export type TemplateResolution =
  | { readonly kind: "valid"; readonly template: TemplateDefinition }
  | { readonly kind: "invalid"; readonly diagnostic: TemplateCandidateDiagnostic }
  | { readonly kind: "not_found" };

export interface TemplateDiscoverySnapshot {
  readonly templates: readonly TemplateDefinition[];
  readonly invalidCandidates: readonly TemplateCandidateDiagnostic[];
  readonly sourceDiagnostics: readonly TemplateSourceDiagnostic[];
  readonly resolveTemplate: (templateId: string) => TemplateResolution;
  readonly toJSON: () => Record<string, unknown>;
}

export interface TemplateDiscoveryOptions {
  readonly root: {
    readonly cwd: string;
    readonly projectTrust: boolean;
  };
  /** 当前 Pi 已注册的业务工具集合；发现时未知工具属于模板格式错误。 */
  readonly knownTools: ReadonlySet<string>;
  readonly fileSystem?: TemplateDiscoveryFileSystem;
}

export type TemplateSnapshotControllerOptions = TemplateDiscoveryOptions;

interface ParsedFrontmatter {
  readonly values: ReadonlyMap<unknown, unknown>;
  readonly emptyToolsIsDoubleQuoted: boolean;
  readonly body: string;
}

type FrontmatterParseResult =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "valid"; readonly frontmatter: ParsedFrontmatter };

interface ValidCandidate {
  readonly kind: "valid";
  readonly template: TemplateDefinition;
}

interface InvalidCandidate {
  readonly kind: "invalid";
  readonly diagnostic: TemplateCandidateDiagnostic;
}

type Candidate = ValidCandidate | InvalidCandidate;

const nativeFileSystem: TemplateDiscoveryFileSystem = {
  readDirectory(path): readonly TemplateDirectoryEntry[] {
    return readdirSync(path, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      kind: entry.isFile()
        ? "file"
        : entry.isSymbolicLink()
          ? "symbolic_link"
          : entry.isDirectory()
            ? "directory"
            : "other",
    }));
  },
  readFile(path): Uint8Array {
    return readFileSync(path);
  },
};

function freezeRecord<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

/** 模板正文只供创建流程使用；序列化快照时不能进入 UI、日志或模型上下文。 */
function templateJsonView(template: TemplateDefinition): Record<string, unknown> {
  return {
    templateId: template.templateId,
    source: template.source,
    tools: [...template.tools],
    ...(template.description === undefined ? {} : { description: template.description }),
    subagents: template.subagents,
    contextFiles: template.contextFiles,
    systemPromptMode: template.systemPromptMode,
    ...(template.model === undefined ? {} : { model: template.model }),
    ...(template.thinking === undefined ? {} : { thinking: template.thinking }),
  };
}

function createTemplateDefinition(template: TemplateDefinition): TemplateDefinition {
  const value = { ...template } as TemplateDefinition & { toJSON?: () => Record<string, unknown> };
  Object.defineProperty(value, "toJSON", {
    configurable: false,
    enumerable: false,
    value: () => templateJsonView(value),
    writable: false,
  });
  return freezeRecord(value);
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isMissing(error: unknown): boolean {
  try {
    return typeof error === "object" && error !== null && "code" in error
      && (error as { readonly code?: unknown }).code === "ENOENT";
  } catch {
    return false;
  }
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    return undefined;
  }
}

function parseFrontmatter(markdown: string): FrontmatterParseResult {
  const opening = /^(?:---)[ \t]*(?:\r?\n)/.exec(markdown);
  if (opening === null) return { kind: "missing" };

  const closing = /^---[ \t]*(?:\r?\n|$)/gm;
  closing.lastIndex = opening[0].length;
  const delimiter = closing.exec(markdown);
  if (delimiter === null) return { kind: "invalid" };

  const frontmatter = markdown.slice(opening[0].length, delimiter.index);
  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(frontmatter, {
      prettyErrors: false,
      strict: true,
      uniqueKeys: true,
    });
  } catch {
    return { kind: "invalid" };
  }
  if (document.errors.length !== 0 || document.warnings.length !== 0) return { kind: "invalid" };

  let parsed: unknown;
  try {
    parsed = document.toJS({ mapAsMap: true });
  } catch {
    return { kind: "invalid" };
  }
  if (!(parsed instanceof Map)) return { kind: "invalid" };
  let emptyToolsIsDoubleQuoted = false;
  if (isMap(document.contents)) {
    const toolsPair = document.contents.items.find((pair) => (
      isScalar(pair.key) && pair.key.value === "tools"
    ));
    emptyToolsIsDoubleQuoted = toolsPair !== undefined
      && isScalar(toolsPair.value)
      && toolsPair.value.value === ""
      && toolsPair.value.type === "QUOTE_DOUBLE";
  }
  return {
    kind: "valid",
    frontmatter: {
      values: parsed,
      emptyToolsIsDoubleQuoted,
      body: markdown.slice(delimiter.index + delimiter[0].length),
    },
  };
}

function normalizeTools(value: unknown, emptyToolsIsDoubleQuoted: boolean): readonly string[] | undefined {
  if (typeof value !== "string") return undefined;
  if (value === "") return emptyToolsIsDoubleQuoted ? Object.freeze([]) : undefined;

  const tools: string[] = [];
  for (const part of value.split(",")) {
    const tool = part.trim();
    if (tool !== "" && !tools.includes(tool)) tools.push(tool);
  }
  return tools.length === 0 ? undefined : Object.freeze(tools);
}

function isThinkingLevel(value: unknown): value is TemplateThinkingLevel {
  return typeof value === "string" && (TEMPLATE_THINKING_LEVELS as readonly string[]).includes(value);
}

function isProviderModel(value: unknown): value is string {
  return typeof value === "string" && /^[^\s/]+\/[^\s/][^\s]*$/.test(value);
}

function invalidCandidate(
  source: TemplateSource,
  fileName: string,
  reason: TemplateCandidateDiagnosticReason,
): InvalidCandidate {
  return {
    kind: "invalid",
    diagnostic: freezeRecord({
      source,
      templateId: fileName.slice(0, -".md".length),
      fileName,
      reason,
    }),
  };
}

function parseCandidate(
  source: TemplateSource,
  fileName: string,
  directory: string,
  fileSystem: TemplateDiscoveryFileSystem,
  knownTools: ReadonlySet<string>,
): Candidate {
  let bytes: Uint8Array;
  try {
    bytes = fileSystem.readFile(join(directory, fileName));
  } catch {
    return invalidCandidate(source, fileName, "file_unreadable");
  }

  const markdown = decodeUtf8(bytes);
  if (markdown === undefined) return invalidCandidate(source, fileName, "invalid_utf8");

  const parsedFrontmatter = parseFrontmatter(markdown);
  if (parsedFrontmatter.kind === "missing") {
    return invalidCandidate(source, fileName, "frontmatter_missing");
  }
  if (parsedFrontmatter.kind === "invalid") {
    return invalidCandidate(source, fileName, "frontmatter_invalid");
  }
  const frontmatter = parsedFrontmatter.frontmatter;

  const tools = normalizeTools(
    frontmatter.values.get("tools"),
    frontmatter.emptyToolsIsDoubleQuoted,
  );
  if (tools === undefined) return invalidCandidate(source, fileName, "tools_invalid");
  if (tools.some((tool) => !knownTools.has(tool))) {
    return invalidCandidate(source, fileName, "unknown_tool");
  }

  let description: string | undefined;
  if (frontmatter.values.has("description")) {
    const descriptionValue = frontmatter.values.get("description");
    if (typeof descriptionValue !== "string") {
      return invalidCandidate(source, fileName, "description_invalid");
    }
    const normalizedDescription = descriptionValue.trim();
    description = normalizedDescription === "" ? undefined : normalizedDescription;
  }

  let subagents: TemplateDefinition["subagents"] = "inherit";
  if (frontmatter.values.has("subagents")) {
    const subagentsValue = frontmatter.values.get("subagents");
    if (subagentsValue !== "inherit" && subagentsValue !== "disabled") {
      return invalidCandidate(source, fileName, "subagents_invalid");
    }
    subagents = subagentsValue;
  }

  let contextFiles: TemplateDefinition["contextFiles"] = "enabled";
  if (frontmatter.values.has("contextFiles")) {
    const contextFilesValue = frontmatter.values.get("contextFiles");
    if (contextFilesValue !== "enabled" && contextFilesValue !== "disabled") {
      return invalidCandidate(source, fileName, "context_files_invalid");
    }
    contextFiles = contextFilesValue;
  }

  let systemPromptMode: TemplateDefinition["systemPromptMode"] = "append";
  if (frontmatter.values.has("systemPromptMode")) {
    const systemPromptModeValue = frontmatter.values.get("systemPromptMode");
    if (systemPromptModeValue !== "append" && systemPromptModeValue !== "replace") {
      return invalidCandidate(source, fileName, "system_prompt_mode_invalid");
    }
    systemPromptMode = systemPromptModeValue;
  }

  let model: string | undefined;
  if (frontmatter.values.has("model")) {
    const modelValue = frontmatter.values.get("model");
    if (!isProviderModel(modelValue)) return invalidCandidate(source, fileName, "model_invalid");
    model = modelValue;
  }

  let thinking: TemplateThinkingLevel | undefined;
  if (frontmatter.values.has("thinking")) {
    const thinkingValue = frontmatter.values.get("thinking");
    if (!isThinkingLevel(thinkingValue)) {
      return invalidCandidate(source, fileName, "thinking_invalid");
    }
    thinking = thinkingValue;
  }
  return {
    kind: "valid",
    template: createTemplateDefinition({
      templateId: fileName.slice(0, -".md".length),
      source,
      tools,
      ...(description === undefined ? {} : { description }),
      subagents,
      contextFiles,
      systemPromptMode,
      ...(model === undefined ? {} : { model }),
      ...(thinking === undefined ? {} : { thinking }),
      body: frontmatter.body,
    }),
  };
}

function scanSource(
  source: TemplateSource,
  directory: string,
  fileSystem: TemplateDiscoveryFileSystem,
  knownTools: ReadonlySet<string>,
  sourceDiagnostics: TemplateSourceDiagnostic[],
): readonly Candidate[] {
  let entries: readonly TemplateDirectoryEntry[];
  try {
    entries = fileSystem.readDirectory(directory);
  } catch (error) {
    if (!isMissing(error)) {
      sourceDiagnostics.push(freezeRecord({ source, reason: "directory_unreadable" }));
    }
    return Object.freeze([]);
  }

  const candidates: Candidate[] = [];
  for (const entry of [...entries].sort((left, right) => compareText(left.name, right.name))) {
    if (!entry.name.endsWith(".md") || (entry.kind !== "file" && entry.kind !== "symbolic_link")) {
      continue;
    }
    candidates.push(parseCandidate(source, entry.name, directory, fileSystem, knownTools));
  }
  return Object.freeze(candidates);
}

function sourceDirectory(source: TemplateSource, root: TemplateDiscoveryOptions["root"]): string {
  return source === "user"
    ? join(homedir(), ".pi", "agent", "agents")
    : join(root.cwd, ".pi", "agents");
}

/**
 * 扫描固定来源并一次性构造快照。项目候选在有效性判断前遮蔽同名用户候选。
 */
export function discoverTemplateSnapshot(
  options: TemplateDiscoveryOptions,
): TemplateDiscoverySnapshot {
  const fileSystem = options.fileSystem ?? nativeFileSystem;
  const sourceDiagnostics: TemplateSourceDiagnostic[] = [];
  const userCandidates = scanSource(
    "user",
    sourceDirectory("user", options.root),
    fileSystem,
    options.knownTools,
    sourceDiagnostics,
  );
  const projectCandidates = options.root.projectTrust
    ? scanSource(
      "project",
      sourceDirectory("project", options.root),
      fileSystem,
      options.knownTools,
      sourceDiagnostics,
    )
    : Object.freeze([] as Candidate[]);

  const projectTemplateIds = new Set(projectCandidates.map((candidate) => candidate.kind === "valid"
    ? candidate.template.templateId
    : candidate.diagnostic.templateId));
  const selectedCandidates = [
    ...userCandidates.filter((candidate) => !projectTemplateIds.has(candidate.kind === "valid"
      ? candidate.template.templateId
      : candidate.diagnostic.templateId)),
    ...projectCandidates,
  ];
  const templates = selectedCandidates
    .flatMap((candidate) => candidate.kind === "valid" ? [candidate.template] : [])
    .sort((left, right) => compareText(left.templateId, right.templateId));
  const invalidCandidates = [...userCandidates, ...projectCandidates]
    .flatMap((candidate) => candidate.kind === "invalid" ? [candidate.diagnostic] : [])
    .sort((left, right) => {
      const bySource = compareText(left.source, right.source);
      return bySource === 0 ? compareText(left.fileName, right.fileName) : bySource;
    });

  const resolutions = new Map<string, TemplateResolution>();
  for (const candidate of selectedCandidates) {
    const templateId = candidate.kind === "valid" ? candidate.template.templateId : candidate.diagnostic.templateId;
    resolutions.set(templateId, candidate.kind === "valid"
      ? freezeRecord({ kind: "valid" as const, template: candidate.template })
      : freezeRecord({ kind: "invalid" as const, diagnostic: candidate.diagnostic }));
  }
  const notFound = freezeRecord({ kind: "not_found" as const });
  const frozenTemplates = Object.freeze(templates);
  const frozenInvalidCandidates = Object.freeze(invalidCandidates);
  const frozenSourceDiagnostics = Object.freeze(sourceDiagnostics);

  return freezeRecord({
    templates: frozenTemplates,
    invalidCandidates: frozenInvalidCandidates,
    sourceDiagnostics: frozenSourceDiagnostics,
    resolveTemplate: (templateId: string): TemplateResolution => resolutions.get(templateId) ?? notFound,
    toJSON: (): Record<string, unknown> => ({
      templates: frozenTemplates.map(templateJsonView),
      invalidCandidates: frozenInvalidCandidates.map((diagnostic) => ({
        source: diagnostic.source,
        templateId: diagnostic.templateId,
        fileName: diagnostic.fileName,
        reason: diagnostic.reason,
      })),
      sourceDiagnostics: frozenSourceDiagnostics.map((diagnostic) => ({
        source: diagnostic.source,
        reason: diagnostic.reason,
      })),
    }),
  });
}

function candidateReasonLabel(reason: TemplateCandidateDiagnosticReason): string {
  switch (reason) {
    case "file_unreadable":
      return "文件不可读";
    case "invalid_utf8":
      return "不是有效 UTF-8";
    case "frontmatter_missing":
      return "缺少 frontmatter";
    case "frontmatter_invalid":
      return "frontmatter 无法解析";
    case "tools_invalid":
      return "tools 配置无效";
    case "unknown_tool":
      return "包含未知业务工具";
    case "description_invalid":
      return "description 配置无效";
    case "subagents_invalid":
      return "subagents 配置无效";
    case "context_files_invalid":
      return "contextFiles 配置无效";
    case "system_prompt_mode_invalid":
      return "systemPromptMode 配置无效";
    case "model_invalid":
      return "model 配置无效";
    case "thinking_invalid":
      return "thinking 配置无效";
  }
}

/** 诊断文本只含逻辑来源、直属文件名和固定原因，不含正文、路径或异常。 */
export function formatTemplateDiscoveryDiagnostics(snapshot: TemplateDiscoverySnapshot): string {
  const parts = [
    ...snapshot.invalidCandidates.map((diagnostic) => (
      `${diagnostic.source}:${diagnostic.fileName}：${candidateReasonLabel(diagnostic.reason)}`
    )),
    ...snapshot.sourceDiagnostics.map((diagnostic) => (
      `${diagnostic.source} 模板目录：不可枚举`
    )),
  ];
  return parts.length === 0 ? "" : `发现 ${String(parts.length)} 个代理模板问题：${parts.join("；")}`;
}

/** 无 UI 或 UI 通知失败时保持静默，不创建消息、会话条目或替代输出。 */
export function notifyTemplateDiscoveryDiagnostics(
  snapshot: TemplateDiscoverySnapshot,
  context: RuntimeUiContext | null | undefined,
): boolean {
  if (
    (snapshot.invalidCandidates.length === 0 && snapshot.sourceDiagnostics.length === 0)
    || context?.hasUI !== true
    || typeof context.ui?.notify !== "function"
  ) {
    return false;
  }
  try {
    (context.ui.notify as (message: string, type: string) => void)(
      formatTemplateDiscoveryDiagnostics(snapshot),
      "warning",
    );
    return true;
  } catch {
    return false;
  }
}

/** 根控制器拥有的发布器：首次发现固定一次，根 reload 以完整新快照替换旧快照。 */
export class TemplateSnapshotController {
  private snapshot: TemplateDiscoverySnapshot | undefined;
  private options: TemplateDiscoveryOptions;

  constructor(options: TemplateSnapshotControllerOptions) {
    const root = freezeRecord({
      cwd: options.root.cwd,
      projectTrust: options.root.projectTrust,
    });
    this.options = freezeRecord({
      root,
      knownTools: options.knownTools,
      ...(options.fileSystem === undefined ? {} : { fileSystem: options.fileSystem }),
    });
  }

  initialize(context: RuntimeUiContext | null | undefined = undefined): TemplateDiscoverySnapshot {
    if (this.snapshot !== undefined) return this.snapshot;
    return this.publish(context);
  }

  reload(
    context: RuntimeUiContext | null | undefined = undefined,
    knownTools?: ReadonlySet<string>,
  ): TemplateDiscoverySnapshot {
    if (knownTools !== undefined) {
      this.options = freezeRecord({
        ...this.options,
        knownTools,
      });
    }
    return this.publish(context);
  }

  getSnapshot(): TemplateDiscoverySnapshot | undefined {
    return this.snapshot;
  }

  private publish(context: RuntimeUiContext | null | undefined): TemplateDiscoverySnapshot {
    // 先完成整轮发现，再替换引用，避免 reload 期间暴露半成品目录。
    const next = discoverTemplateSnapshot(this.options);
    this.snapshot = next;
    notifyTemplateDiscoveryDiagnostics(next, context);
    return next;
  }
}
