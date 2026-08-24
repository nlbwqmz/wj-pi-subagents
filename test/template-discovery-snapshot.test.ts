import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  discoverTemplateSnapshot,
  listAgentTemplates,
  MAX_TEMPLATE_BODY_BYTES,
  TemplateSnapshotController,
  type TemplateDirectoryEntry,
  type TemplateDiscoveryFileSystem,
} from "../src/template-discovery-snapshot.ts";

type MemoryDirectoryContent = readonly TemplateDirectoryEntry[] | Error;
type MemoryFileContent = string | Uint8Array | Error;

class MemoryTemplateFileSystem implements TemplateDiscoveryFileSystem {
  private readonly directories: ReadonlyMap<string, MemoryDirectoryContent>;
  private readonly files: ReadonlyMap<string, MemoryFileContent>;

  constructor(
    directories: ReadonlyMap<string, MemoryDirectoryContent>,
    files: ReadonlyMap<string, MemoryFileContent>,
  ) {
    this.directories = directories;
    this.files = files;
  }

  readDirectory(path: string) {
    const entries = this.directories.get(path);
    if (entries === undefined) {
      const error = new Error("目录不存在");
      Object.assign(error, { code: "ENOENT" });
      throw error;
    }
    if (entries instanceof Error) throw entries;
    return entries;
  }

  readFile(path: string): Uint8Array {
    const content = this.files.get(path);
    if (content === undefined) throw new Error("模板不可读");
    if (content instanceof Error) throw content;
    return typeof content === "string" ? Buffer.from(content, "utf8") : content;
  }
}

function errorWithCode(code: string, message: string): Error {
  const error = new Error(message);
  Object.assign(error, { code });
  return error;
}

function userDirectory(): string {
  return join(homedir(), ".pi", "agent", "agents");
}

function discoverUserTemplates(files: ReadonlyMap<string, MemoryFileContent>) {
  const directory = userDirectory();
  return discoverTemplateSnapshot({
    root: { cwd: "C:\\workspace\\project", projectTrust: false },
    fileSystem: new MemoryTemplateFileSystem(
      new Map([[
        directory,
        [...files.keys()].map((name) => ({ name, kind: "file" as const })),
      ]]),
      new Map([...files].map(([name, content]) => [join(directory, name), content])),
    ),
  });
}

function diagnosticReasons(snapshot: ReturnType<typeof discoverTemplateSnapshot>): Record<string, string> {
  return Object.fromEntries(snapshot.invalidCandidates.map((diagnostic) => [
    diagnostic.fileName,
    diagnostic.reason,
  ]));
}

test("发现完整 schema，保留 extension source 与模板目录并只向目录公开显示值", () => {
  const directory = userDirectory();
  const snapshot = discoverUserTemplates(new Map([[
    "researcher.md",
    [
      "---",
      "description: '  核对资料  '",
      "tools:",
      "  - ' read '",
      "  - grep",
      "extensions:",
      "  - '  ./extensions/research.ts  '",
      "  - 'npm:@scope/research@1'",
      "  - '  source accepted without grammar validation  '",
      "allowSubagents: false",
      "contextFiles: false",
      "systemPromptMode: replace",
      "model: openai/gpt-5",
      "thinking: xhigh",
      "---",
      "优先核对来源。",
    ].join("\n"),
  ]]));

  assert.deepEqual(snapshot.templates, [{
    templateId: "researcher",
    source: "user",
    templateDirectory: directory,
    description: "核对资料",
    tools: ["read", "grep"],
    extensions: [
      { source: "  ./extensions/research.ts  ", displaySource: "./extensions/research.ts" },
      { source: "npm:@scope/research@1", displaySource: "npm:@scope/research@1" },
      {
        source: "  source accepted without grammar validation  ",
        displaySource: "source accepted without grammar validation",
      },
    ],
    allowSubagents: false,
    contextFiles: false,
    systemPromptMode: "replace",
    model: "openai/gpt-5",
    thinking: "xhigh",
    body: "优先核对来源。",
  }]);
  assert.deepEqual(snapshot.invalidCandidates, []);

  const listed = listAgentTemplates(snapshot);
  assert.deepEqual(listed, [{
    template_id: "researcher",
    description: "核对资料",
    tools: ["read", "grep"],
    extensions: [
      "./extensions/research.ts",
      "npm:@scope/research@1",
      "source accepted without grammar validation",
    ],
  }]);
  assert.equal(Object.isFrozen(listed), true);
  assert.equal(Object.isFrozen(listed[0]), true);
  assert.equal(Object.isFrozen(listed[0]?.tools), true);
  assert.equal(Object.isFrozen(listed[0]?.extensions), true);
  assert.equal(Object.isFrozen(snapshot.templates[0]?.extensions), true);
  assert.equal(Object.isFrozen(snapshot.templates[0]?.extensions?.[0]), true);
  assert.doesNotMatch(
    JSON.stringify(listed),
    /"(?:templateDirectory|source|body|model|thinking|allowSubagents|contextFiles)"\s*:/,
  );
  assert.doesNotMatch(JSON.stringify(snapshot), /templateDirectory|优先核对来源/);
});

test("可选 tools 和 extensions 保留 undefined，显式空数组保留在模板目录", () => {
  const snapshot = discoverUserTemplates(new Map([
    ["empty.md", "---\ndescription: 显式空配置\ntools: []\nextensions: []\n---\n"],
    ["omitted.md", "---\ndescription: 缺省配置\n---\n"],
  ]));

  const empty = snapshot.templates.find((template) => template.templateId === "empty");
  const omitted = snapshot.templates.find((template) => template.templateId === "omitted");
  assert.deepEqual(empty?.tools, []);
  assert.deepEqual(empty?.extensions, []);
  assert.equal(omitted?.tools, undefined);
  assert.equal(omitted?.extensions, undefined);
  assert.equal(Object.hasOwn(omitted ?? {}, "tools"), true);
  assert.equal(Object.hasOwn(omitted ?? {}, "extensions"), true);
  assert.deepEqual(listAgentTemplates(snapshot), [
    {
      template_id: "empty",
      description: "显式空配置",
      tools: [],
      extensions: [],
    },
    {
      template_id: "omitted",
      description: "缺省配置",
    },
  ]);
});

test("未注册业务工具可用，九个系统保留工具均被拒绝", () => {
  const reservedTools = [
    "get_agent_templates",
    "spawn_agent",
    "send_message",
    "wait_agent",
    "interrupt_agent",
    "terminate_agent",
    "get_agent_status",
    "get_agent_tree",
    "normal_reply",
  ];
  const snapshot = discoverUserTemplates(new Map([
    ["business.md", "---\ndescription: 业务工具\ntools: [future_business_tool]\n---\n"],
    ...reservedTools.map((tool) => [
      `${tool}.md`,
      `---\ndescription: ${tool}\ntools: [${tool}]\n---\n`,
    ] as const),
  ]));

  assert.deepEqual(snapshot.templates.map((template) => [template.templateId, template.tools]), [
    ["business", ["future_business_tool"]],
  ]);
  assert.equal(snapshot.invalidCandidates.length, reservedTools.length);
  assert.equal(snapshot.invalidCandidates.every((diagnostic) => diagnostic.reason === "reserved_tool"), true);
  assert.equal(snapshot.invalidCandidates.every((diagnostic) => diagnostic.field === "tools"), true);
});

test("tools 和 extensions 只接受原生字符串数组，并拒绝空项和 trim 后重复项", () => {
  const snapshot = discoverUserTemplates(new Map([
    ["alias.md", [
      "---",
      "description: alias",
      "tools: &toolList [read]",
      "extensions: *toolList",
      "---",
      "",
    ].join("\n")],
    ["duplicate-extension.md", "---\ndescription: 重复扩展\nextensions: [./a.ts, ' ./a.ts ']\n---\n"],
    ["duplicate-tool.md", "---\ndescription: 重复工具\ntools: [read, ' read ']\n---\n"],
    ["empty-extension.md", "---\ndescription: 空扩展\nextensions: [' ']\n---\n"],
    ["empty-tool.md", "---\ndescription: 空工具\ntools: ['']\n---\n"],
    ["extension-scalar.md", "---\ndescription: 标量扩展\nextensions: ./extension.ts\n---\n"],
    ["extension-value.md", "---\ndescription: 非字符串扩展\nextensions: [1]\n---\n"],
    ["tool-scalar.md", "---\ndescription: 标量工具\ntools: read\n---\n"],
    ["tool-value.md", "---\ndescription: 非字符串工具\ntools: [true]\n---\n"],
  ]));

  assert.deepEqual(snapshot.templates, []);
  assert.deepEqual(diagnosticReasons(snapshot), {
    "alias.md": "extensions_invalid",
    "duplicate-extension.md": "extensions_invalid",
    "duplicate-tool.md": "tools_invalid",
    "empty-extension.md": "extensions_invalid",
    "empty-tool.md": "tools_invalid",
    "extension-scalar.md": "extensions_invalid",
    "extension-value.md": "extensions_invalid",
    "tool-scalar.md": "tools_invalid",
    "tool-value.md": "tools_invalid",
  });
});

test("description 必填，按 trim 后 Unicode code point 数校验", () => {
  const withinLimit = "😀".repeat(512);
  const beyondLimit = "😀".repeat(513);
  const snapshot = discoverUserTemplates(new Map([
    ["blank.md", "---\ndescription: '   '\n---\n"],
    ["missing.md", "---\ntools: []\n---\n"],
    ["number.md", "---\ndescription: 1\n---\n"],
    ["within-limit.md", `---\ndescription: ${withinLimit}\n---\n`],
    ["beyond-limit.md", `---\ndescription: ${beyondLimit}\n---\n`],
  ]));

  assert.deepEqual(snapshot.templates.map((template) => [template.templateId, template.description]), [
    ["within-limit", withinLimit],
  ]);
  assert.deepEqual(diagnosticReasons(snapshot), {
    "beyond-limit.md": "description_too_long",
    "blank.md": "description_invalid",
    "missing.md": "description_missing",
    "number.md": "description_invalid",
  });
  const missing = snapshot.invalidCandidates.find((candidate) => candidate.fileName === "missing.md");
  assert.equal(missing?.field, "description");
});

test("严格拒绝未知字段、YAML merge 和非字符串顶层键，并保留安全定位信息", () => {
  const snapshot = discoverUserTemplates(new Map([
    ["merge.md", [
      "---",
      "description: 合并",
      "<<: { contextFiles: false }",
      "---",
      "",
    ].join("\n")],
    ["non-string-key.md", [
      "---",
      "? [description]",
      ": 不能作为键",
      "description: 正常描述",
      "---",
      "",
    ].join("\n")],
    ["unknown.md", [
      "---",
      "description: 未知字段",
      "env: TOP_SECRET",
      "---",
      "",
    ].join("\n")],
  ]));

  assert.deepEqual(snapshot.templates, []);
  assert.deepEqual(diagnosticReasons(snapshot), {
    "merge.md": "frontmatter_merge_key",
    "non-string-key.md": "frontmatter_non_string_key",
    "unknown.md": "unknown_field",
  });
  const unknown = snapshot.invalidCandidates.find((candidate) => candidate.fileName === "unknown.md");
  assert.deepEqual(
    { field: unknown?.field, line: unknown?.line, column: unknown?.column },
    { field: "env", line: 3, column: 1 },
  );
  assert.doesNotMatch(JSON.stringify(listAgentTemplates(snapshot)), /TOP_SECRET|env/);
});

test("allowSubagents 和 contextFiles 只接受原生 boolean，其他保留字段继续严格校验", () => {
  const snapshot = discoverUserTemplates(new Map([
    ["bad-allow.md", "---\ndescription: 错误 allow\nallowSubagents: 'false'\n---\n"],
    ["bad-context.md", "---\ndescription: 错误 context\ncontextFiles: disabled\n---\n"],
    ["bad-mode.md", "---\ndescription: 错误模式\nsystemPromptMode: merge\n---\n"],
    ["bad-model.md", "---\ndescription: 错误模型\nmodel: openai/\n---\n"],
    ["bad-thinking.md", "---\ndescription: 错误思考\nthinking: extreme\n---\n"],
    ["defaults.md", "---\ndescription: 默认行为\n---\n"],
  ]));

  assert.deepEqual(snapshot.templates.map((template) => ({
    templateId: template.templateId,
    allowSubagents: template.allowSubagents,
    contextFiles: template.contextFiles,
    systemPromptMode: template.systemPromptMode,
  })), [{
    templateId: "defaults",
    allowSubagents: true,
    contextFiles: true,
    systemPromptMode: "append",
  }]);
  assert.deepEqual(diagnosticReasons(snapshot), {
    "bad-allow.md": "allow_subagents_invalid",
    "bad-context.md": "context_files_invalid",
    "bad-mode.md": "system_prompt_mode_invalid",
    "bad-model.md": "model_invalid",
    "bad-thinking.md": "thinking_invalid",
  });
});

test("模板正文以 UTF-8 64 KiB 边界参与发现", () => {
  const snapshot = discoverUserTemplates(new Map([
    [
      "boundary.md",
      `---\ndescription: 边界\n---\n${"x".repeat(MAX_TEMPLATE_BODY_BYTES)}`,
    ],
    [
      "oversized.md",
      `---\ndescription: 超出\n---\n${"x".repeat(MAX_TEMPLATE_BODY_BYTES + 1)}`,
    ],
  ]));

  assert.deepEqual(snapshot.templates.map((template) => template.templateId), ["boundary"]);
  assert.deepEqual(diagnosticReasons(snapshot), { "oversized.md": "body_too_large" });
});

test("template_id 保留原始文件名，并严格拒绝旧字段", () => {
  const decomposedFileName = "cafe\u0301.md";
  const composedFileName = "caf\u00e9.md";
  const fileNames = [
    ".md",
    "plan.md.md",
    "  spaced  .md",
    decomposedFileName,
    composedFileName,
  ];
  const snapshot = discoverUserTemplates(new Map(fileNames.map((fileName) => [
    fileName,
    fileName === ".md"
      ? "---\ndescription: 标识\nname: frontmatter-must-not-define-identity\n---\n"
      : "---\ndescription: 标识\n---\n",
  ])));

  assert.deepEqual(snapshot.templates.map((template) => template.templateId), [
    "  spaced  ",
    "cafe\u0301",
    "caf\u00e9",
    "plan.md",
  ]);
  assert.deepEqual(diagnosticReasons(snapshot), { ".md": "unknown_field" });
  assert.equal(snapshot.resolveTemplate("cafe\u0301").kind, "valid");
  assert.equal(snapshot.resolveTemplate("caf\u00e9").kind, "valid");
  assert.equal(snapshot.resolveTemplate("frontmatter-must-not-define-identity").kind, "not_found");
});

test("项目候选在有效性判断前遮蔽同名用户模板，并保持标识精确匹配", () => {
  const cwd = "C:\\workspace\\project";
  const userTemplates = userDirectory();
  const projectDirectory = join(cwd, ".pi", "agents");
  const fileSystem = new MemoryTemplateFileSystem(
    new Map([
      [userTemplates, [
        { name: "analyst.md", kind: "file" as const },
        { name: "Case.md", kind: "file" as const },
      ]],
      [projectDirectory, [
        { name: "analyst.md", kind: "file" as const },
        { name: "case.md", kind: "file" as const },
      ]],
    ]),
    new Map([
      [join(userTemplates, "analyst.md"), "---\ndescription: 用户分析\ntools: [read]\n---\n用户版本"],
      [join(userTemplates, "Case.md"), "---\ndescription: 大写用户\n---\n大写用户版本"],
      [join(projectDirectory, "analyst.md"), "---\ntools: []\n---\n"],
      [join(projectDirectory, "case.md"), "---\ndescription: 小写项目\n---\n小写项目版本"],
    ]),
  );

  const snapshot = discoverTemplateSnapshot({
    root: { cwd, projectTrust: true },
    fileSystem,
  });

  assert.deepEqual(snapshot.templates.map((template) => [
    template.templateId,
    template.source,
    template.body,
  ]), [
    ["Case", "user", "大写用户版本"],
    ["case", "project", "小写项目版本"],
  ]);
  assert.deepEqual(snapshot.resolveTemplate("analyst"), {
    kind: "invalid",
    diagnostic: {
      source: "project",
      templateId: "analyst",
      fileName: "analyst.md",
      reason: "description_missing",
      field: "description",
    },
  });
  assert.equal(snapshot.resolveTemplate("Case").kind, "valid");
  assert.equal(snapshot.resolveTemplate("CASE").kind, "not_found");
});

test("来源扫描只接受直属 Markdown 文件，并隔离读取、编码与 YAML 故障", () => {
  const cwd = "C:\\workspace\\project";
  const userTemplates = userDirectory();
  const projectDirectory = join(cwd, ".pi", "agents");
  const fileSystem = new MemoryTemplateFileSystem(
    new Map([
      [userTemplates, [
        { name: "valid.md", kind: "file" as const },
        { name: "link.md", kind: "symbolic_link" as const },
        { name: "broken-link.md", kind: "symbolic_link" as const },
        { name: "bad-utf8.md", kind: "file" as const },
        { name: "missing-frontmatter.md", kind: "file" as const },
        { name: "bad-yaml.md", kind: "file" as const },
        { name: "nested", kind: "directory" as const },
        { name: "ignored.MD", kind: "file" as const },
      ]],
      [projectDirectory, [{ name: "project.md", kind: "file" as const }]],
    ]),
    new Map<string, MemoryFileContent>([
      [join(userTemplates, "valid.md"), "---\ndescription: 有效\n---\n"],
      [join(userTemplates, "link.md"), "---\ndescription: 链接\n---\n"],
      [join(userTemplates, "broken-link.md"), errorWithCode("ELOOP", "D:\\secret\\linked-target")],
      [join(userTemplates, "bad-utf8.md"), Buffer.from([0xff, 0xfe])],
      [join(userTemplates, "missing-frontmatter.md"), "没有 frontmatter"],
      [join(userTemplates, "bad-yaml.md"), "---\ndescription: [\n---\n"],
      [join(projectDirectory, "project.md"), "---\ndescription: 项目\n---\n"],
    ]),
  );

  const snapshot = discoverTemplateSnapshot({
    root: { cwd, projectTrust: true },
    fileSystem,
  });

  assert.deepEqual(snapshot.templates.map((template) => template.templateId), ["link", "project", "valid"]);
  assert.deepEqual(diagnosticReasons(snapshot), {
    "bad-utf8.md": "invalid_utf8",
    "bad-yaml.md": "frontmatter_invalid",
    "broken-link.md": "file_unreadable",
    "missing-frontmatter.md": "frontmatter_missing",
  });
  assert.deepEqual(snapshot.sourceDiagnostics, []);
  assert.doesNotMatch(JSON.stringify(snapshot.invalidCandidates), /secret|linked-target/i);
});

test("未获信任的项目目录不参与发现，缺失目录是正常空来源", () => {
  const cwd = "C:\\workspace\\untrusted";
  const userTemplates = userDirectory();
  const projectDirectory = join(cwd, ".pi", "agents");
  const observedDirectories: string[] = [];
  const fileSystem: TemplateDiscoveryFileSystem = {
    readDirectory(path) {
      observedDirectories.push(path);
      if (path === userTemplates) return [{ name: "user.md", kind: "file" }];
      if (path === projectDirectory) throw new Error("不应枚举未信任项目目录");
      throw errorWithCode("ENOENT", "目录不存在");
    },
    readFile(path) {
      if (path === join(userTemplates, "user.md")) return Buffer.from("---\ndescription: 用户\n---\n", "utf8");
      throw errorWithCode("ENOENT", "缺少模板");
    },
  };

  const untrustedSnapshot = discoverTemplateSnapshot({
    root: { cwd, projectTrust: false },
    fileSystem,
  });
  assert.deepEqual(untrustedSnapshot.templates.map((template) => template.templateId), ["user"]);
  assert.deepEqual(observedDirectories, [userTemplates]);
  assert.deepEqual(untrustedSnapshot.sourceDiagnostics, []);

  const missingSnapshot = discoverTemplateSnapshot({
    root: { cwd, projectTrust: true },
    fileSystem: {
      readDirectory: () => {
        throw errorWithCode("ENOENT", "目录不存在");
      },
      readFile: () => {
        throw new Error("缺失目录不应读取文件");
      },
    },
  });
  assert.deepEqual(missingSnapshot.templates, []);
  assert.deepEqual(missingSnapshot.invalidCandidates, []);
  assert.deepEqual(missingSnapshot.sourceDiagnostics, []);
});

test("根控制器首次发现和 reload 原子替换快照，并只通过 UI 汇总安全诊断", () => {
  const cwd = "C:\\workspace\\project";
  const userTemplates = userDirectory();
  let round = 0;
  const fileSystem: TemplateDiscoveryFileSystem = {
    readDirectory(path) {
      if (path !== userTemplates) throw errorWithCode("ENOENT", "目录不存在");
      if (round === 2) throw errorWithCode("EACCES", "D:\\secret\\unreadable-directory");
      return round === 0
        ? [
          { name: "old.md", kind: "file" as const },
          { name: "broken.md", kind: "file" as const },
        ]
        : [{ name: "new.md", kind: "file" as const }];
    },
    readFile(path) {
      if (path === join(userTemplates, "old.md")) {
        return Buffer.from("---\ndescription: 旧模板\n---\nOLD-BODY-CANARY", "utf8");
      }
      if (path === join(userTemplates, "broken.md")) {
        throw errorWithCode("EACCES", "D:\\secret\\broken-template");
      }
      if (path === join(userTemplates, "new.md")) {
        return Buffer.from("---\ndescription: 新模板\n---\nNEW-BODY-CANARY", "utf8");
      }
      throw errorWithCode("ENOENT", "缺少模板");
    },
  };
  const notifications: Array<{ message: string; type: string }> = [];
  const sideEffects: string[] = [];
  const uiContext = {
    hasUI: true,
    ui: { notify: (message: string, type: string) => notifications.push({ message, type }) },
    sendMessage: () => sideEffects.push("message"),
    sendUserMessage: () => sideEffects.push("user-message"),
  };
  const controller = new TemplateSnapshotController({
    root: { cwd, projectTrust: false },
    fileSystem,
  });

  const first = controller.initialize(uiContext);
  assert.equal(controller.initialize(uiContext), first);
  assert.deepEqual(first.templates.map((template) => template.templateId), ["old"]);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.type, "warning");
  assert.match(notifications[0]?.message ?? "", /user:broken\.md/);
  assert.doesNotMatch(notifications[0]?.message ?? "", /secret|OLD-BODY-CANARY|broken-template/i);
  assert.doesNotMatch(JSON.stringify(first), /OLD-BODY-CANARY|secret|templateDirectory/i);

  round = 1;
  const second = controller.reload(uiContext);
  assert.notEqual(second, first);
  assert.deepEqual(second.templates.map((template) => template.templateId), ["new"]);
  assert.deepEqual(first.templates.map((template) => template.templateId), ["old"]);
  assert.equal(notifications.length, 1);

  round = 2;
  const third = controller.reload(uiContext);
  assert.deepEqual(third.templates, []);
  assert.deepEqual(third.sourceDiagnostics, [{ source: "user", reason: "directory_unreadable" }]);
  assert.equal(notifications.length, 2);
  assert.match(notifications[1]?.message ?? "", /user template directory/);
  assert.doesNotMatch(notifications[1]?.message ?? "", /secret|unreadable-directory/i);
  assert.equal(sideEffects.length, 0);

  round = 0;
  const silentController = new TemplateSnapshotController({
    root: { cwd, projectTrust: false },
    fileSystem,
  });
  silentController.initialize({
    hasUI: false,
    ui: { notify: () => sideEffects.push("notify") },
  });
  assert.equal(sideEffects.length, 0);
});
