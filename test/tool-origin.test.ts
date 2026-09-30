import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyRegisteredToolOrigin,
  createMcpToolAnnotationsResolver,
  createToolOriginResolver,
  PI_NATIVE_TOOL_NAMES,
} from "../src/wj-pi-subagents-runtime.ts";

const PLUGIN_PATH = "D:/code/wj-pi-subagents/index.ts";

function builtinSource(name: string): Record<string, unknown> {
  return Object.freeze({ path: `<builtin:${name}>`, source: "builtin", scope: "temporary" });
}

test("Pi 原生工具名闭集是规范声明的固定集合", () => {
  assert.deepEqual([...PI_NATIVE_TOOL_NAMES].sort(), [
    "bash", "edit", "find", "grep", "ls", "powershell", "read", "write",
  ]);
});

test("来源验证确认 Pi 内置实现的工具携带 pi_native 身份", () => {
  assert.equal(
    classifyRegisteredToolOrigin("read", builtinSource("read"), PLUGIN_PATH),
    "pi_native",
  );
  assert.equal(
    classifyRegisteredToolOrigin("powershell", builtinSource("powershell"), PLUGIN_PATH),
    "pi_native",
  );
});

test("内置来源但名字不在 Pi 原生闭集时安全兜底", () => {
  assert.equal(
    classifyRegisteredToolOrigin("custom_builtin", builtinSource("custom_builtin"), PLUGIN_PATH),
    "unknown",
  );
});

test("内置 codemode 扩展注册的工具携带 pi_extension 身份", () => {
  // 真实注册来源是 `builtin:codemode`（内置扩展名），与内置基础工具的
  // `builtin:<toolName>` 同形；判定按来源路径而非工具名。
  assert.equal(
    classifyRegisteredToolOrigin(
      "codemode",
      { path: "builtin:codemode", source: "builtin", scope: "temporary" },
      PLUGIN_PATH,
    ),
    "pi_extension",
  );
});

test("第三方 replaceable 替换内置 codemode 后同名工具回落 unknown", () => {
  assert.equal(
    classifyRegisteredToolOrigin(
      "codemode",
      { path: "D:/extensions/other/codemode.ts", source: "package" },
      PLUGIN_PATH,
    ),
    "unknown",
  );
});

test("内置 tool-search 扩展注册的工具携带 pi_extension 身份", () => {
  // 真实注册来源是 `builtin:tool-search`（内置扩展名）；判定按来源路径。
  assert.equal(
    classifyRegisteredToolOrigin(
      "tool_search",
      { path: "builtin:tool-search", source: "builtin", scope: "temporary" },
      PLUGIN_PATH,
    ),
    "pi_extension",
  );
});

test("内置 mcp 扩展注册的工具与资源工具携带 mcp 身份", () => {
  // 工具名带哈希后缀时来源判定不受影响：判定只看注册来源路径。
  for (const name of [
    "mcp__docs__search",
    "mcp__very_long_server_name__very_long_tool_name_a1b2c3d4",
    "list_mcp_resources",
    "list_mcp_resource_templates",
    "read_mcp_resource",
  ]) {
    assert.equal(
      classifyRegisteredToolOrigin(
        name,
        { path: "builtin:mcp", source: "builtin", scope: "temporary" },
        PLUGIN_PATH,
      ),
      "mcp",
      name,
    );
  }
});

test("第三方 replaceable 替换内置 tool-search 或 mcp 后同名工具回落 unknown", () => {
  assert.equal(
    classifyRegisteredToolOrigin(
      "tool_search",
      { path: "D:/extensions/other/tool-search.ts", source: "package" },
      PLUGIN_PATH,
    ),
    "unknown",
  );
  assert.equal(
    classifyRegisteredToolOrigin(
      "read_mcp_resource",
      { path: "D:/extensions/other/mcp.ts", source: "package" },
      PLUGIN_PATH,
    ),
    "unknown",
  );
});

test("本插件注册实现的管理与回复工具携带 plugin 身份", () => {
  for (const name of [
    "get_agent_templates",
    "spawn_agent",
    "send_message",
    "wait_agent",
    "interrupt_agent",
    "terminate_agent",
    "get_agent_status",
    "get_agent_tree",
    "normal_reply",
    "final_report",
  ]) {
    assert.equal(
      classifyRegisteredToolOrigin(
        name,
        { path: PLUGIN_PATH, source: "package", scope: "project" },
        PLUGIN_PATH,
      ),
      "plugin",
      name,
    );
  }
});

test("路径表示差异不破坏本插件实现的同一性判定", () => {
  assert.equal(
    classifyRegisteredToolOrigin(
      "spawn_agent",
      { path: "D:\\code\\wj-pi-subagents\\Index.ts", source: "package" },
      PLUGIN_PATH,
    ),
    "plugin",
  );
});

test("POSIX 风格路径的同一性判定与平台无关且保持大小写敏感", () => {
  assert.equal(
    classifyRegisteredToolOrigin(
      "spawn_agent",
      { path: "/opt/wj-pi-subagents/index.ts", source: "package" },
      "/opt/wj-pi-subagents/index.ts",
    ),
    "plugin",
  );
  assert.equal(
    classifyRegisteredToolOrigin(
      "spawn_agent",
      { path: "/opt/WJ-PI-SUBAGENTS/index.ts", source: "package" },
      "/opt/wj-pi-subagents/index.ts",
    ),
    "unknown",
  );
});

test("同名覆盖的扩展实现失去专用身份，一律安全兜底", () => {
  // 第三方扩展覆盖 Pi 原生 read。
  assert.equal(
    classifyRegisteredToolOrigin(
      "read",
      { path: "D:/extensions/evil/read.ts", source: "package" },
      PLUGIN_PATH,
    ),
    "unknown",
  );
  // 第三方扩展覆盖本插件 spawn_agent。
  assert.equal(
    classifyRegisteredToolOrigin(
      "spawn_agent",
      { path: "D:/extensions/other/index.ts", source: "package" },
      PLUGIN_PATH,
    ),
    "unknown",
  );
});

test("MCP 与来源不明工具使用安全兜底", () => {
  assert.equal(
    classifyRegisteredToolOrigin(
      "query",
      { path: "<mcp:weather>", source: "mcp" },
      PLUGIN_PATH,
    ),
    "unknown",
  );
  assert.equal(
    classifyRegisteredToolOrigin("query", { source: "sdk" }, PLUGIN_PATH),
    "unknown",
  );
  assert.equal(classifyRegisteredToolOrigin("query", undefined, PLUGIN_PATH), "unknown");
  assert.equal(
    classifyRegisteredToolOrigin("query", { path: 42, source: "builtin" }, PLUGIN_PATH),
    "unknown",
  );
});

test("来源解析器按当前注册表实时判定，查询失败全部兜底", () => {
  const tools = [
    // 同名覆盖后注册表中同名工具只剩覆盖实现。
    { name: "read", sourceInfo: { path: "D:/extensions/override/read.ts", source: "package" } },
    { name: "spawn_agent", sourceInfo: { path: PLUGIN_PATH, source: "package" } },
    { name: "future_tool", sourceInfo: { path: "D:/ext/x.ts", source: "package" } },
  ];
  const resolver = createToolOriginResolver({ getAllTools: () => tools }, PLUGIN_PATH);
  // 同名覆盖后注册表中的实现是覆盖者：read 不再是 Pi 原生实现。
  assert.equal(resolver("read"), "unknown");
  assert.equal(resolver("spawn_agent"), "plugin");
  assert.equal(resolver("future_tool"), "unknown");
  assert.equal(resolver("unregistered"), "unknown");

  const failing = createToolOriginResolver({
    getAllTools: () => {
      throw new Error("宿主不可用");
    },
  }, PLUGIN_PATH);
  assert.equal(failing("read"), "unknown");
  const malformed = createToolOriginResolver({ getAllTools: () => "not-an-array" }, PLUGIN_PATH);
  assert.equal(malformed("read"), "unknown");
});

test("MCP annotations 解析器按注册表返回原始 annotations，查询失败兜底", () => {
  const raw = { readOnlyHint: true, destructiveHint: false, unknownHint: true };
  const resolver = createMcpToolAnnotationsResolver({
    getAllTools: () => [
      { name: "mcp__docs__search", annotations: raw },
      { name: "mcp__docs__list" },
    ],
  });
  assert.deepEqual(resolver("mcp__docs__search"), raw);
  assert.equal(resolver("mcp__docs__list"), undefined);
  assert.equal(resolver("unregistered"), undefined);

  const failing = createMcpToolAnnotationsResolver({
    getAllTools: () => {
      throw new Error("宿主不可用");
    },
  });
  assert.equal(failing("mcp__docs__search"), undefined);
  const malformed = createMcpToolAnnotationsResolver({ getAllTools: () => "not-an-array" });
  assert.equal(malformed("mcp__docs__search"), undefined);
});
