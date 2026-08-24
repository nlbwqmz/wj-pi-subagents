import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isMap, isScalar, isSeq, LineCounter, parseDocument } from "yaml";
import type { RuntimeUiContext } from "./root-runtime-context.ts";

export type TemplateSource = "user" | "project";

/** 递归控制通道和 bridge 启动配置共同支持的模板正文 UTF-8 上限。 */
export const MAX_TEMPLATE_BODY_BYTES = 64 * 1024;

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

export interface TemplateExtension {
  /** YAML 解析后的原始 source，交由运行时按 Pi 的规则解释。 */
  readonly source: string;
  /** 面向目录和 UI 的规范化 source，不泄露模板目录。 */
  readonly displaySource: string;
}

export interface TemplateDefinition {
  readonly templateId: string;
  readonly source: TemplateSource;
  /** 仅供运行时将相对 extension source 解析到模板所属目录。 */
  readonly templateDirectory: string;
  readonly description: string;
  /** undefined 表示 frontmatter 未声明，[] 表示显式空工具集。 */
  readonly tools: readonly string[] | undefined;
  /** undefined 表示 frontmatter 未声明，[] 表示显式未加载扩展。 */
  readonly extensions: readonly TemplateExtension[] | undefined;
  readonly allowSubagents: boolean;
  readonly contextFiles: boolean;
  readonly systemPromptMode: "append" | "replace";
  readonly model?: string;
  readonly thinking?: TemplateThinkingLevel;
  readonly body: string;
}

/** 模型可见的有效模板目录条目；不暴露正文、来源、目录、模型或其他运行配置。 */
export interface AgentTemplateListItem {
  readonly template_id: string;
  readonly description: string;
  readonly tools?: readonly string[];
  readonly extensions?: readonly string[];
}

export type TemplateCandidateDiagnosticReason =
  | "file_unreadable"
  | "invalid_utf8"
  | "frontmatter_missing"
  | "frontmatter_invalid"
  | "frontmatter_non_string_key"
  | "frontmatter_merge_key"
  | "unknown_field"
  | "description_missing"
  | "description_invalid"
  | "description_too_long"
  | "tools_invalid"
  | "reserved_tool"
  | "extensions_invalid"
  | "allow_subagents_invalid"
  | "context_files_invalid"
  | "system_prompt_mode_invalid"
  | "model_invalid"
  | "thinking_invalid"
  | "body_too_large";

/** 候选诊断不保存底层路径、模板正文、异常文本或堆栈。 */
export interface TemplateCandidateDiagnostic {
  readonly source: TemplateSource;
  readonly templateId: string;
  readonly fileName: string;
  readonly reason: TemplateCandidateDiagnosticReason;
  /** UI 可用的 frontmatter 定位信息，不进入模型目录。 */
  readonly field?: string;
  readonly line?: number;
  readonly column?: number;
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
  readonly fileSystem?: TemplateDiscoveryFileSystem;
}

export type TemplateSnapshotControllerOptions = TemplateDiscoveryOptions;

interface FrontmatterLocation {
  readonly line?: number;
  readonly column?: number;
}

interface ParsedFrontmatterField extends FrontmatterLocation {
  readonly value: unknown;
}

interface ParsedFrontmatter {
  readonly fields: ReadonlyMap<string, ParsedFrontmatterField>;
  readonly body: string;
}

type FrontmatterParseIssueReason =
  | "frontmatter_invalid"
  | "frontmatter_non_string_key"
  | "frontmatter_merge_key"
  | "unknown_field";

interface FrontmatterParseIssue extends FrontmatterLocation {
  readonly reason: FrontmatterParseIssueReason;
  readonly field?: string;
}

type FrontmatterParseResult =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid"; readonly issue: FrontmatterParseIssue }
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

const TEMPLATE_FRONTMATTER_FIELDS = new Set<string>([
  "description",
  "extensions",
  "tools",
  "allowSubagents",
  "contextFiles",
  "systemPromptMode",
  "model",
  "thinking",
]);

const RESERVED_SYSTEM_TOOL_NAMES = new Set<string>([
  "get_agent_templates",
  "spawn_agent",
  "send_message",
  "wait_agent",
  "interrupt_agent",
  "terminate_agent",
  "get_agent_status",
  "get_agent_tree",
  "normal_reply",
]);

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

/** 模板正文、目录和 extension 原始 source 只供创建流程使用，不能进入模型目录。 */
function templateJsonView(template: TemplateDefinition): Record<string, unknown> {
  return {
    templateId: template.templateId,
    source: template.source,
    description: template.description,
    ...(template.tools === undefined ? {} : { tools: [...template.tools] }),
    ...(template.extensions === undefined
      ? {}
      : { extensions: template.extensions.map((extension) => extension.displaySource) }),
    allowSubagents: template.allowSubagents,
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

/** 从已校验快照生成安全目录，调用方无需再次理解模板过滤规则。 */
export function listAgentTemplates(
  snapshot: TemplateDiscoverySnapshot,
): readonly AgentTemplateListItem[] {
  return Object.freeze(snapshot.templates.map((template) => freezeRecord({
    template_id: template.templateId,
    description: template.description,
    ...(template.tools === undefined ? {} : { tools: Object.freeze([...template.tools]) }),
    ...(template.extensions === undefined
      ? {}
      : { extensions: Object.freeze(template.extensions.map((extension) => extension.displaySource)) }),
  })));
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

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    return undefined;
  }
}

function scalarLocation(
  lineCounter: LineCounter,
  scalar: { readonly range?: readonly number[] | null },
): FrontmatterLocation {
  const offset = scalar.range?.[0];
  if (offset === undefined) return {};
  const position = lineCounter.linePos(offset);
  // frontmatter 从 Markdown 的第二行开始。
  return { line: position.line + 1, column: position.col };
}

function parseFrontmatter(markdown: string): FrontmatterParseResult {
  const opening = /^(?:---)[ \t]*(?:\r?\n)/.exec(markdown);
  if (opening === null) return { kind: "missing" };

  const closing = /^---[ \t]*(?:\r?\n|$)/gm;
  closing.lastIndex = opening[0].length;
  const delimiter = closing.exec(markdown);
  if (delimiter === null) return { kind: "invalid", issue: { reason: "frontmatter_invalid" } };

  const frontmatter = markdown.slice(opening[0].length, delimiter.index);
  const lineCounter = new LineCounter();
  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(frontmatter, {
      lineCounter,
      prettyErrors: false,
      strict: true,
      uniqueKeys: true,
    });
  } catch {
    return { kind: "invalid", issue: { reason: "frontmatter_invalid" } };
  }
  if (document.errors.length !== 0 || document.warnings.length !== 0) {
    return { kind: "invalid", issue: { reason: "frontmatter_invalid" } };
  }
  if (!isMap(document.contents)) {
    return { kind: "invalid", issue: { reason: "frontmatter_invalid" } };
  }

  const fields = new Map<string, ParsedFrontmatterField>();
  for (const pair of document.contents.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
      return {
        kind: "invalid",
        issue: {
          reason: "frontmatter_non_string_key",
          ...(isScalar(pair.key) ? scalarLocation(lineCounter, pair.key) : {}),
        },
      };
    }
    const field = pair.key.value;
    const location = scalarLocation(lineCounter, pair.key);
    if (
      field === "<<"
      || pair.key.tag === "tag:yaml.org,2002:merge"
      || pair.key.addToJSMap !== undefined
    ) {
      return {
        kind: "invalid",
        issue: { reason: "frontmatter_merge_key", field, ...location },
      };
    }
    if (!TEMPLATE_FRONTMATTER_FIELDS.has(field)) {
      return {
        kind: "invalid",
        issue: { reason: "unknown_field", field, ...location },
      };
    }
    fields.set(field, { value: pair.value, ...location });
  }
  return {
    kind: "valid",
    frontmatter: {
      fields,
      body: markdown.slice(delimiter.index + delimiter[0].length),
    },
  };
}

interface ParsedStringArrayValue {
  readonly source: string;
  readonly displayValue: string;
}

type StringArrayParseResult =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | { readonly kind: "valid"; readonly values: readonly ParsedStringArrayValue[] };

function parseStringArray(field: ParsedFrontmatterField | undefined): StringArrayParseResult {
  if (field === undefined) return { kind: "absent" };
  if (!isSeq(field.value)) return { kind: "invalid" };

  const values: ParsedStringArrayValue[] = [];
  const seen = new Set<string>();
  for (const item of field.value.items) {
    if (!isScalar(item) || typeof item.value !== "string") return { kind: "invalid" };
    const displayValue = item.value.trim();
    if (displayValue === "" || seen.has(displayValue)) return { kind: "invalid" };
    seen.add(displayValue);
    values.push({ source: item.value, displayValue });
  }
  return { kind: "valid", values: Object.freeze(values) };
}

function stringScalarValue(field: ParsedFrontmatterField): string | undefined {
  return isScalar(field.value) && typeof field.value.value === "string"
    ? field.value.value
    : undefined;
}

function booleanScalarValue(field: ParsedFrontmatterField): boolean | undefined {
  return isScalar(field.value) && typeof field.value.value === "boolean"
    ? field.value.value
    : undefined;
}

function unicodeCodePointLength(value: string): number {
  return Array.from(value).length;
}

function isThinkingLevel(value: unknown): value is TemplateThinkingLevel {
  return typeof value === "string" && (TEMPLATE_THINKING_LEVELS as readonly string[]).includes(value);
}

function isProviderModel(value: unknown): value is string {
  return typeof value === "string" && /^[^\s/]+\/[^\s/][^\s]*$/.test(value);
}

interface CandidateDiagnosticDetails {
  readonly field?: string;
  readonly line?: number;
  readonly column?: number;
}

function fieldDiagnosticDetails(
  fieldName: string,
  field: ParsedFrontmatterField | undefined,
): CandidateDiagnosticDetails {
  return {
    field: fieldName,
    ...(field?.line === undefined ? {} : { line: field.line }),
    ...(field?.column === undefined ? {} : { column: field.column }),
  };
}

function invalidCandidate(
  source: TemplateSource,
  fileName: string,
  reason: TemplateCandidateDiagnosticReason,
  details: CandidateDiagnosticDetails = {},
): InvalidCandidate {
  return {
    kind: "invalid",
    diagnostic: freezeRecord({
      source,
      templateId: fileName.slice(0, -".md".length),
      fileName,
      reason,
      ...(details.field === undefined ? {} : { field: details.field }),
      ...(details.line === undefined ? {} : { line: details.line }),
      ...(details.column === undefined ? {} : { column: details.column }),
    }),
  };
}

function parseCandidate(
  source: TemplateSource,
  fileName: string,
  directory: string,
  fileSystem: TemplateDiscoveryFileSystem,
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
    return invalidCandidate(
      source,
      fileName,
      parsedFrontmatter.issue.reason,
      parsedFrontmatter.issue,
    );
  }
  const frontmatter = parsedFrontmatter.frontmatter;

  const descriptionField = frontmatter.fields.get("description");
  if (descriptionField === undefined) {
    return invalidCandidate(source, fileName, "description_missing", { field: "description" });
  }
  const descriptionValue = stringScalarValue(descriptionField);
  if (descriptionValue === undefined) {
    return invalidCandidate(
      source,
      fileName,
      "description_invalid",
      fieldDiagnosticDetails("description", descriptionField),
    );
  }
  const description = descriptionValue.trim();
  if (description === "") {
    return invalidCandidate(
      source,
      fileName,
      "description_invalid",
      fieldDiagnosticDetails("description", descriptionField),
    );
  }
  if (unicodeCodePointLength(description) > 512) {
    return invalidCandidate(
      source,
      fileName,
      "description_too_long",
      fieldDiagnosticDetails("description", descriptionField),
    );
  }

  const toolsField = frontmatter.fields.get("tools");
  const parsedTools = parseStringArray(toolsField);
  if (parsedTools.kind === "invalid") {
    return invalidCandidate(
      source,
      fileName,
      "tools_invalid",
      fieldDiagnosticDetails("tools", toolsField),
    );
  }
  const tools = parsedTools.kind === "absent"
    ? undefined
    : Object.freeze(parsedTools.values.map((tool) => tool.displayValue));
  if (tools?.some((tool) => RESERVED_SYSTEM_TOOL_NAMES.has(tool)) === true) {
    return invalidCandidate(
      source,
      fileName,
      "reserved_tool",
      fieldDiagnosticDetails("tools", toolsField),
    );
  }

  const extensionsField = frontmatter.fields.get("extensions");
  const parsedExtensions = parseStringArray(extensionsField);
  if (parsedExtensions.kind === "invalid") {
    return invalidCandidate(
      source,
      fileName,
      "extensions_invalid",
      fieldDiagnosticDetails("extensions", extensionsField),
    );
  }
  const extensions = parsedExtensions.kind === "absent"
    ? undefined
    : Object.freeze(parsedExtensions.values.map((extension) => freezeRecord({
      source: extension.source,
      displaySource: extension.displayValue,
    })));

  let allowSubagents = true;
  const allowSubagentsField = frontmatter.fields.get("allowSubagents");
  if (allowSubagentsField !== undefined) {
    const value = booleanScalarValue(allowSubagentsField);
    if (value === undefined) {
      return invalidCandidate(
        source,
        fileName,
        "allow_subagents_invalid",
        fieldDiagnosticDetails("allowSubagents", allowSubagentsField),
      );
    }
    allowSubagents = value;
  }

  let contextFiles = true;
  const contextFilesField = frontmatter.fields.get("contextFiles");
  if (contextFilesField !== undefined) {
    const value = booleanScalarValue(contextFilesField);
    if (value === undefined) {
      return invalidCandidate(
        source,
        fileName,
        "context_files_invalid",
        fieldDiagnosticDetails("contextFiles", contextFilesField),
      );
    }
    contextFiles = value;
  }

  let systemPromptMode: TemplateDefinition["systemPromptMode"] = "append";
  const systemPromptModeField = frontmatter.fields.get("systemPromptMode");
  if (systemPromptModeField !== undefined) {
    const value = stringScalarValue(systemPromptModeField);
    if (value !== "append" && value !== "replace") {
      return invalidCandidate(
        source,
        fileName,
        "system_prompt_mode_invalid",
        fieldDiagnosticDetails("systemPromptMode", systemPromptModeField),
      );
    }
    systemPromptMode = value;
  }

  let model: string | undefined;
  const modelField = frontmatter.fields.get("model");
  if (modelField !== undefined) {
    const value = stringScalarValue(modelField);
    if (!isProviderModel(value)) {
      return invalidCandidate(
        source,
        fileName,
        "model_invalid",
        fieldDiagnosticDetails("model", modelField),
      );
    }
    model = value;
  }

  let thinking: TemplateThinkingLevel | undefined;
  const thinkingField = frontmatter.fields.get("thinking");
  if (thinkingField !== undefined) {
    const value = stringScalarValue(thinkingField);
    if (!isThinkingLevel(value)) {
      return invalidCandidate(
        source,
        fileName,
        "thinking_invalid",
        fieldDiagnosticDetails("thinking", thinkingField),
      );
    }
    thinking = value;
  }
  if (utf8Length(frontmatter.body) > MAX_TEMPLATE_BODY_BYTES) {
    return invalidCandidate(source, fileName, "body_too_large");
  }
  return {
    kind: "valid",
    template: createTemplateDefinition({
      templateId: fileName.slice(0, -".md".length),
      source,
      templateDirectory: directory,
      description,
      tools,
      extensions,
      allowSubagents,
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
    candidates.push(parseCandidate(source, entry.name, directory, fileSystem));
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
    sourceDiagnostics,
  );
  const projectCandidates = options.root.projectTrust
    ? scanSource(
      "project",
      sourceDirectory("project", options.root),
      fileSystem,
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
        ...(diagnostic.field === undefined ? {} : { field: diagnostic.field }),
        ...(diagnostic.line === undefined ? {} : { line: diagnostic.line }),
        ...(diagnostic.column === undefined ? {} : { column: diagnostic.column }),
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
      return "File is unreadable";
    case "invalid_utf8":
      return "Invalid UTF-8";
    case "frontmatter_missing":
      return "Missing frontmatter";
    case "frontmatter_invalid":
      return "Frontmatter cannot be parsed";
    case "frontmatter_non_string_key":
      return "Frontmatter keys must be strings";
    case "frontmatter_merge_key":
      return "YAML merge keys are not allowed";
    case "unknown_field":
      return "Contains an unknown field";
    case "description_missing":
      return "Missing description";
    case "description_invalid":
      return "Invalid description configuration";
    case "description_too_long":
      return "Description exceeds 512 Unicode code points";
    case "tools_invalid":
      return "Invalid tools configuration";
    case "reserved_tool":
      return "Tools contains a reserved system tool";
    case "extensions_invalid":
      return "Invalid extensions configuration";
    case "allow_subagents_invalid":
      return "Invalid allowSubagents configuration";
    case "context_files_invalid":
      return "Invalid contextFiles configuration";
    case "system_prompt_mode_invalid":
      return "Invalid systemPromptMode configuration";
    case "model_invalid":
      return "Invalid model configuration";
    case "thinking_invalid":
      return "Invalid thinking configuration";
    case "body_too_large":
      return "Body exceeds 64 KiB";
  }
}

/** 诊断文本只含逻辑来源、直属文件名和固定原因，不含正文、路径或异常。 */
export function formatTemplateDiscoveryDiagnostics(snapshot: TemplateDiscoverySnapshot): string {
  const parts = [
    ...snapshot.invalidCandidates.map((diagnostic) => (
      `${diagnostic.source}:${diagnostic.fileName}: ${candidateReasonLabel(diagnostic.reason)}`
    )),
    ...snapshot.sourceDiagnostics.map((diagnostic) => (
      `${diagnostic.source} template directory: cannot be listed`
    )),
  ];
  if (parts.length === 0) return "";
  const issueLabel = parts.length === 1 ? "issue" : "issues";
  return `Found ${String(parts.length)} agent template ${issueLabel}: ${parts.join("; ")}`;
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
      ...(options.fileSystem === undefined ? {} : { fileSystem: options.fileSystem }),
    });
  }

  initialize(context: RuntimeUiContext | null | undefined = undefined): TemplateDiscoverySnapshot {
    if (this.snapshot !== undefined) return this.snapshot;
    return this.publish(context);
  }

  reload(
    context: RuntimeUiContext | null | undefined = undefined,
  ): TemplateDiscoverySnapshot {
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
