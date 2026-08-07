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

class MemoryTemplateFileSystem implements TemplateDiscoveryFileSystem {
  private readonly directories: ReadonlyMap<string, MemoryDirectoryContent>;
  private readonly files: ReadonlyMap<string, string | Uint8Array | Error>;

  constructor(
    directories: ReadonlyMap<string, MemoryDirectoryContent>,
    files: ReadonlyMap<string, string | Uint8Array | Error>,
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

test("发现用户直属合法模板并以文件名发布稳定 template_id", () => {
  const userDirectory = join(homedir(), ".pi", "agent", "agents");
  const fileSystem = new MemoryTemplateFileSystem(
    new Map([[userDirectory, [{ name: "researcher.md", kind: "file" }]]]),
    new Map([[
      join(userDirectory, "researcher.md"),
      "---\ntools: read, grep, read\ndescription: \"核对资料\"\n---\n",
    ]]),
  );

  const snapshot = discoverTemplateSnapshot({
    root: { cwd: "C:\\workspace\\project", projectTrust: false },
    knownTools: new Set(["read", "grep"]),
    fileSystem,
  });

  assert.deepEqual(snapshot.templates, [{
    templateId: "researcher",
    source: "user",
    tools: ["read", "grep"],
    description: "核对资料",
    subagents: "inherit",
    contextFiles: "enabled",
    systemPromptMode: "append",
    body: "",
  }]);
  assert.deepEqual(snapshot.invalidCandidates, []);
  assert.deepEqual(snapshot.sourceDiagnostics, []);
  const listed = listAgentTemplates(snapshot);
  assert.deepEqual(listed, [{
    template_id: "researcher",
    description: "核对资料",
    tools: ["read", "grep"],
  }]);
  assert.equal(Object.isFrozen(listed), true);
  assert.equal(Object.isFrozen(listed[0]), true);
  assert.equal(Object.isFrozen(listed[0]?.tools), true);
  assert.doesNotMatch(JSON.stringify(listed), /source|body|model|thinking|contextFiles|subagents/);
});

test("严格解析完整 frontmatter，保留正文并静默忽略未知字段", () => {
  const userDirectory = join(homedir(), ".pi", "agent", "agents");
  const fileSystem = new MemoryTemplateFileSystem(
    new Map([[userDirectory, [{ name: "planner.md", kind: "file" }]]]),
    new Map([[
      join(userDirectory, "planner.md"),
      [
        "---",
        "tools: read, , grep, read",
        "description: '  规划任务  '",
        "subagents: disabled",
        "contextFiles: disabled",
        "systemPromptMode: replace",
        "model: openai/gpt-5",
        "thinking: xhigh",
        "env: SHOULD_NOT_APPEAR",
        "---",
        "先制定执行计划。",
      ].join("\n"),
    ]]),
  );

  const snapshot = discoverTemplateSnapshot({
    root: { cwd: "C:\\workspace\\project", projectTrust: false },
    knownTools: new Set(["read", "grep"]),
    fileSystem,
  });

  assert.deepEqual(snapshot.templates, [{
    templateId: "planner",
    source: "user",
    tools: ["read", "grep"],
    description: "规划任务",
    subagents: "disabled",
    contextFiles: "disabled",
    systemPromptMode: "replace",
    model: "openai/gpt-5",
    thinking: "xhigh",
    body: "先制定执行计划。",
  }]);
  assert.doesNotMatch(JSON.stringify(snapshot.templates), /SHOULD_NOT_APPEAR/);
});

test("模板正文以 UTF-8 64 KiB 边界参与发现，供直接和递归创建共同使用", () => {
  const userDirectory = join(homedir(), ".pi", "agent", "agents");
  const fileSystem = new MemoryTemplateFileSystem(
    new Map([[userDirectory, [
      { name: "boundary.md", kind: "file" as const },
      { name: "oversized.md", kind: "file" as const },
    ]]]),
    new Map([
      [
        join(userDirectory, "boundary.md"),
        `---\ntools: read\n---\n${"x".repeat(MAX_TEMPLATE_BODY_BYTES)}`,
      ],
      [
        join(userDirectory, "oversized.md"),
        `---\ntools: read\n---\n${"x".repeat(MAX_TEMPLATE_BODY_BYTES + 1)}`,
      ],
    ]),
  );

  const snapshot = discoverTemplateSnapshot({
    root: { cwd: "C:\\workspace\\project", projectTrust: false },
    knownTools: new Set(["read"]),
    fileSystem,
  });

  assert.deepEqual(snapshot.templates.map((template) => template.templateId), ["boundary"]);
  assert.deepEqual(snapshot.invalidCandidates.map((candidate) => [candidate.fileName, candidate.reason]), [
    ["oversized.md", "body_too_large"],
  ]);
});

test("接受 Pi 精确模型引用中包含斜杠的模型标识", () => {
  const userDirectory = join(homedir(), ".pi", "agent", "agents");
  const fileSystem = new MemoryTemplateFileSystem(
    new Map([[userDirectory, [{ name: "router-model.md", kind: "file" }]]]),
    new Map([[
      join(userDirectory, "router-model.md"),
      "---\ntools: read\nmodel: openrouter/meta-llama/llama-3.3-70b-instruct\n---\n",
    ]]),
  );

  const snapshot = discoverTemplateSnapshot({
    root: { cwd: "C:\\workspace\\project", projectTrust: false },
    knownTools: new Set(["read"]),
    fileSystem,
  });

  assert.deepEqual(snapshot.templates.map((template) => [template.templateId, template.model]), [
    ["router-model", "openrouter/meta-llama/llama-3.3-70b-instruct"],
  ]);
  assert.deepEqual(snapshot.invalidCandidates, []);
});

test("template_id 保留原始文件名并忽略 frontmatter name", () => {
  const userDirectory = join(homedir(), ".pi", "agent", "agents");
  const decomposedFileName = "cafe\u0301.md";
  const composedFileName = "caf\u00e9.md";
  const fileNames = [
    ".md",
    "plan.md.md",
    "  spaced  .md",
    decomposedFileName,
    composedFileName,
  ];
  const fileSystem = new MemoryTemplateFileSystem(
    new Map([[userDirectory, fileNames.map((name) => ({ name, kind: "file" as const }))]]),
    new Map(fileNames.map((fileName) => [
      join(userDirectory, fileName),
      fileName === ".md"
        ? "---\ntools: read\nname: frontmatter-must-not-define-identity\n---\n"
        : "---\ntools: read\n---\n",
    ])),
  );

  const snapshot = discoverTemplateSnapshot({
    root: { cwd: "C:\\workspace\\project", projectTrust: false },
    knownTools: new Set(["read"]),
    fileSystem,
  });

  assert.deepEqual(snapshot.templates.map((template) => template.templateId), [
    "",
    "  spaced  ",
    "cafe\u0301",
    "caf\u00e9",
    "plan.md",
  ]);
  assert.equal(snapshot.resolveTemplate("cafe\u0301").kind, "valid");
  assert.equal(snapshot.resolveTemplate("caf\u00e9").kind, "valid");
  assert.equal(snapshot.resolveTemplate("frontmatter-must-not-define-identity").kind, "not_found");
});

test("已知字段与业务工具错误只隔离为安全的无效候选诊断", () => {
  const userDirectory = join(homedir(), ".pi", "agent", "agents");
  const fileNames = [
    "empty.md",
    "bad-description.md",
    "bad-subagents.md",
    "bad-context.md",
    "bad-mode.md",
    "bad-model.md",
    "bad-url-model.md",
    "bad-thinking.md",
    "bad-tools.md",
    "tagged-tools.md",
    "unknown-tool.md",
  ];
  const fileSystem = new MemoryTemplateFileSystem(
    new Map([[userDirectory, fileNames.map((name) => ({ name, kind: "file" as const }))]]),
    new Map([
      [join(userDirectory, "empty.md"), "---\ntools: \"\"\n---\n"],
      [join(userDirectory, "bad-description.md"), "---\ntools: read\ndescription: 1\n---\n"],
      [join(userDirectory, "bad-subagents.md"), "---\ntools: read\nsubagents: enabled\n---\n"],
      [join(userDirectory, "bad-context.md"), "---\ntools: read\ncontextFiles: inherit\n---\n"],
      [join(userDirectory, "bad-mode.md"), "---\ntools: read\nsystemPromptMode: merge\n---\n"],
      [join(userDirectory, "bad-model.md"), "---\ntools: read\nmodel: openai/\n---\n"],
      [join(userDirectory, "bad-url-model.md"), "---\ntools: read\nmodel: https://models.example.test/gpt\n---\n"],
      [join(userDirectory, "bad-thinking.md"), "---\ntools: read\nthinking: extreme\n---\n"],
      [join(userDirectory, "bad-tools.md"), "---\ntools: ' , '\n---\n"],
      [join(userDirectory, "tagged-tools.md"), "---\ntools: !secret read\n---\n"],
      [join(userDirectory, "unknown-tool.md"), "---\ntools: read, unregistered\n---\n"],
    ]),
  );

  const snapshot = discoverTemplateSnapshot({
    root: { cwd: "C:\\workspace\\project", projectTrust: false },
    knownTools: new Set(["read"]),
    fileSystem,
  });

  assert.deepEqual(snapshot.templates, [{
    templateId: "empty",
    source: "user",
    tools: [],
    subagents: "inherit",
    contextFiles: "enabled",
    systemPromptMode: "append",
    body: "",
  }]);
  assert.deepEqual(snapshot.invalidCandidates.map((diagnostic) => [
    diagnostic.fileName,
    diagnostic.reason,
  ]), [
    ["bad-context.md", "context_files_invalid"],
    ["bad-description.md", "description_invalid"],
    ["bad-mode.md", "system_prompt_mode_invalid"],
    ["bad-model.md", "model_invalid"],
    ["bad-subagents.md", "subagents_invalid"],
    ["bad-thinking.md", "thinking_invalid"],
    ["bad-tools.md", "tools_invalid"],
    ["bad-url-model.md", "model_invalid"],
    ["tagged-tools.md", "frontmatter_invalid"],
    ["unknown-tool.md", "unknown_tool"],
  ]);
});

test("空工具集只接受双引号 YAML 字符串 tools: \"\"", () => {
  const userDirectory = join(homedir(), ".pi", "agent", "agents");
  const fileSystem = new MemoryTemplateFileSystem(
    new Map([[userDirectory, [
      { name: "double.md", kind: "file" as const },
      { name: "single.md", kind: "file" as const },
      { name: "null.md", kind: "file" as const },
    ]]]),
    new Map([
      [join(userDirectory, "double.md"), "---\ntools: \"\"\n---\n"],
      [join(userDirectory, "single.md"), "---\ntools: ''\n---\n"],
      [join(userDirectory, "null.md"), "---\ntools:\n---\n"],
    ]),
  );

  const snapshot = discoverTemplateSnapshot({
    root: { cwd: "C:\\workspace\\project", projectTrust: false },
    knownTools: new Set(["read"]),
    fileSystem,
  });

  assert.deepEqual(snapshot.templates.map((template) => [template.templateId, template.tools]), [
    ["double", []],
  ]);
  assert.deepEqual(snapshot.invalidCandidates.map((diagnostic) => [
    diagnostic.fileName,
    diagnostic.reason,
  ]), [
    ["null.md", "tools_invalid"],
    ["single.md", "tools_invalid"],
  ]);
});

test("项目候选在有效性判断前遮蔽同名用户模板，并保持标识精确匹配", () => {
  const cwd = "C:\\workspace\\project";
  const userDirectory = join(homedir(), ".pi", "agent", "agents");
  const projectDirectory = join(cwd, ".pi", "agents");
  const fileSystem = new MemoryTemplateFileSystem(
    new Map([
      [userDirectory, [
        { name: "analyst.md", kind: "file" as const },
        { name: "Case.md", kind: "file" as const },
      ]],
      [projectDirectory, [
        { name: "analyst.md", kind: "file" as const },
        { name: "case.md", kind: "file" as const },
      ]],
    ]),
    new Map([
      [join(userDirectory, "analyst.md"), "---\ntools: read\n---\n用户版本"],
      [join(userDirectory, "Case.md"), "---\ntools: read\n---\n大写用户版本"],
      [join(projectDirectory, "analyst.md"), "---\ntools: [read]\n---\n"],
      [join(projectDirectory, "case.md"), "---\ntools: read\n---\n小写项目版本"],
    ]),
  );

  const snapshot = discoverTemplateSnapshot({
    root: { cwd, projectTrust: true },
    knownTools: new Set(["read"]),
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
      reason: "tools_invalid",
    },
  });
  assert.equal(snapshot.resolveTemplate("Case").kind, "valid");
  assert.equal(snapshot.resolveTemplate("CASE").kind, "not_found");
  assert.equal(snapshot.resolveTemplate("missing").kind, "not_found");
});

test("来源扫描只接受直属 Markdown 文件，并隔离读取、编码与 YAML 故障", () => {
  const cwd = "C:\\workspace\\project";
  const userDirectory = join(homedir(), ".pi", "agent", "agents");
  const projectDirectory = join(cwd, ".pi", "agents");
  const fileSystem = new MemoryTemplateFileSystem(
    new Map([
      [userDirectory, [
        { name: "valid.md", kind: "file" as const },
        { name: "link.md", kind: "symbolic_link" as const },
        { name: "broken-link.md", kind: "symbolic_link" as const },
        { name: "bad-utf8.md", kind: "file" as const },
        { name: "missing-frontmatter.md", kind: "file" as const },
        { name: "bad-yaml.md", kind: "file" as const },
        { name: "nested", kind: "directory" as const },
        { name: "ignored.MD", kind: "file" as const },
      ]],
      [projectDirectory, [
        { name: "project.md", kind: "file" as const },
      ]],
    ]),
    new Map<string, string | Uint8Array | Error>([
      [join(userDirectory, "valid.md"), "---\ntools: read\n---\n"],
      [join(userDirectory, "link.md"), "---\ntools: read\n---\n"],
      [join(userDirectory, "broken-link.md"), errorWithCode("ELOOP", "D:\\secret\\linked-target")],
      [join(userDirectory, "bad-utf8.md"), Buffer.from([0xff, 0xfe])],
      [join(userDirectory, "missing-frontmatter.md"), "没有 frontmatter"],
      [join(userDirectory, "bad-yaml.md"), "---\ntools: [\n---\n"],
      [join(projectDirectory, "project.md"), "---\ntools: read\n---\n"],
    ]),
  );

  const snapshot = discoverTemplateSnapshot({
    root: { cwd, projectTrust: true },
    knownTools: new Set(["read"]),
    fileSystem,
  });

  assert.deepEqual(snapshot.templates.map((template) => template.templateId), ["link", "project", "valid"]);
  assert.deepEqual(snapshot.invalidCandidates.map((diagnostic) => [
    diagnostic.fileName,
    diagnostic.reason,
  ]), [
    ["bad-utf8.md", "invalid_utf8"],
    ["bad-yaml.md", "frontmatter_invalid"],
    ["broken-link.md", "file_unreadable"],
    ["missing-frontmatter.md", "frontmatter_missing"],
  ]);
  assert.deepEqual(snapshot.sourceDiagnostics, []);
  assert.doesNotMatch(JSON.stringify(snapshot.invalidCandidates), /secret|linked-target/i);
});

test("未获信任的项目目录不参与发现，缺失目录是正常空来源", () => {
  const cwd = "C:\\workspace\\untrusted";
  const userDirectory = join(homedir(), ".pi", "agent", "agents");
  const projectDirectory = join(cwd, ".pi", "agents");
  const observedDirectories: string[] = [];
  const fileSystem: TemplateDiscoveryFileSystem = {
    readDirectory(path) {
      observedDirectories.push(path);
      if (path === userDirectory) return [{ name: "user.md", kind: "file" }];
      if (path === projectDirectory) throw new Error("不应枚举未信任项目目录");
      throw errorWithCode("ENOENT", "目录不存在");
    },
    readFile(path) {
      if (path === join(userDirectory, "user.md")) return Buffer.from("---\ntools: read\n---\n", "utf8");
      throw errorWithCode("ENOENT", "缺少模板");
    },
  };

  const untrustedSnapshot = discoverTemplateSnapshot({
    root: { cwd, projectTrust: false },
    knownTools: new Set(["read"]),
    fileSystem,
  });
  assert.deepEqual(untrustedSnapshot.templates.map((template) => template.templateId), ["user"]);
  assert.deepEqual(observedDirectories, [userDirectory]);
  assert.deepEqual(untrustedSnapshot.sourceDiagnostics, []);

  const missingSnapshot = discoverTemplateSnapshot({
    root: { cwd, projectTrust: true },
    knownTools: new Set(["read"]),
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
  const userDirectory = join(homedir(), ".pi", "agent", "agents");
  let round = 0;
  const fileSystem: TemplateDiscoveryFileSystem = {
    readDirectory(path) {
      if (path !== userDirectory) throw errorWithCode("ENOENT", "目录不存在");
      if (round === 2) throw errorWithCode("EACCES", "D:\\secret\\unreadable-directory");
      return round === 0
        ? [
          { name: "old.md", kind: "file" as const },
          { name: "broken.md", kind: "file" as const },
        ]
        : [{ name: "new.md", kind: "file" as const }];
    },
    readFile(path) {
      if (path === join(userDirectory, "old.md")) {
        return Buffer.from("---\ntools: read\n---\nOLD-BODY-CANARY", "utf8");
      }
      if (path === join(userDirectory, "broken.md")) {
        throw errorWithCode("EACCES", "D:\\secret\\broken-template");
      }
      if (path === join(userDirectory, "new.md")) {
        return Buffer.from("---\ntools: read\n---\nNEW-BODY-CANARY", "utf8");
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
    knownTools: new Set(["read"]),
    fileSystem,
  });

  const first = controller.initialize(uiContext);
  assert.equal(controller.initialize(uiContext), first);
  assert.deepEqual(first.templates.map((template) => template.templateId), ["old"]);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.type, "warning");
  assert.match(notifications[0]?.message ?? "", /user:broken\.md/);
  assert.doesNotMatch(notifications[0]?.message ?? "", /secret|OLD-BODY-CANARY|broken-template/i);
  assert.doesNotMatch(JSON.stringify(first), /OLD-BODY-CANARY|secret/i);

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
  assert.match(notifications[1]?.message ?? "", /user 模板目录/);
  assert.doesNotMatch(notifications[1]?.message ?? "", /secret|unreadable-directory/i);
  assert.equal(sideEffects.length, 0);

  round = 0;
  const silentController = new TemplateSnapshotController({
    root: { cwd, projectTrust: false },
    knownTools: new Set(["read"]),
    fileSystem,
  });
  silentController.initialize({
    hasUI: false,
    ui: { notify: () => sideEffects.push("notify") },
  });
  assert.equal(sideEffects.length, 0);
});
