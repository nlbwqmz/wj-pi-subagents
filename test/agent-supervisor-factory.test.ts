import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { buildManagedRpcOptions } from "../src/agent-supervisor-factory.ts";
import type { TemplateDefinition } from "../src/template-discovery-snapshot.ts";

/** 模板目录只用于把相对 extension source 解析为绝对路径。 */
const TEMPLATE_DIRECTORY = resolve("agent-supervisor-factory-fixtures", "templates");

function createTemplate(overrides: Partial<TemplateDefinition> = {}): TemplateDefinition {
  return {
    templateId: "demo",
    source: "user",
    templateDirectory: TEMPLATE_DIRECTORY,
    description: "测试模板",
    tools: undefined,
    extensions: undefined,
    allowSubagents: true,
    contextFiles: true,
    systemPromptMode: "append",
    body: "测试正文",
    ...overrides,
  };
}

test("builtin: 扩展来源原样传给子 Pi，不解析到模板目录", () => {
  const options = buildManagedRpcOptions(createTemplate({
    extensions: [{ source: "builtin:mcp", displaySource: "builtin:mcp" }],
  }));

  assert.deepEqual(options.args, ["--no-session", "--no-extensions", "-e", "builtin:mcp"]);
});

test("相对路径扩展来源仍解析到模板目录", () => {
  const options = buildManagedRpcOptions(createTemplate({
    extensions: [{ source: "./extensions/research.ts", displaySource: "./extensions/research.ts" }],
  }));

  assert.deepEqual(options.args, [
    "--no-session",
    "--no-extensions",
    "-e",
    resolve(TEMPLATE_DIRECTORY, "./extensions/research.ts"),
  ]);
});

test("builtin: 与相对路径混用时分别处理", () => {
  const options = buildManagedRpcOptions(createTemplate({
    extensions: [
      { source: "./extensions/research.ts", displaySource: "./extensions/research.ts" },
      { source: "builtin:mcp", displaySource: "builtin:mcp" },
    ],
  }));

  assert.deepEqual(options.args, [
    "--no-session",
    "--no-extensions",
    "-e",
    resolve(TEMPLATE_DIRECTORY, "./extensions/research.ts"),
    "-e",
    "builtin:mcp",
  ]);
});

test("npm:、git:、URL 与 git@ 扩展来源原样传递", () => {
  const sources = [
    "npm:@scope/research@1",
    "git:github.com/user/repo",
    "https://example.com/extensions/research.ts",
    "git@github.com:user/repo.git",
  ] as const;
  const options = buildManagedRpcOptions(createTemplate({
    extensions: sources.map((source) => ({ source, displaySource: source })),
  }));

  assert.deepEqual(options.args, [
    "--no-session",
    "--no-extensions",
    ...sources.flatMap((source) => ["-e", source]),
  ]);
});

test("排除字段按声明顺序作为排除参数传给子 Pi", () => {
  const options = buildManagedRpcOptions(createTemplate({
    excludeTools: ["mcp_*", "future_business_tool"],
  }));

  assert.deepEqual(options.args, [
    "--no-session",
    "--exclude-tools",
    "mcp_*,future_business_tool",
  ]);
});

test("排除字段缺省或为空数组时不产生排除参数，tools 缺省仍不产生白名单参数", () => {
  assert.deepEqual(buildManagedRpcOptions(createTemplate()).args, ["--no-session"]);
  assert.deepEqual(
    buildManagedRpcOptions(createTemplate({ excludeTools: [] })).args,
    ["--no-session"],
  );
});

test("白名单与排除参数同时出现时各自保留声明顺序", () => {
  const options = buildManagedRpcOptions(createTemplate({
    tools: ["read", "grep"],
    excludeTools: ["mcp_*"],
  }), {
    childReplyTools: ["normal_reply"],
    managementTools: ["spawn_agent"],
  });

  assert.deepEqual(options.args, [
    "--no-session",
    "--tools",
    "read,grep,normal_reply,spawn_agent",
    "--exclude-tools",
    "mcp_*",
  ]);
});
