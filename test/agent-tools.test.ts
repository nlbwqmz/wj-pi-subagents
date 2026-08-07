import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_TOOL_NAMES, registerAgentTools, SubagentToolError } from "../src/agent-tools.ts";

test("公开注册入口一次注册完整八工具集合并说明模板选择契约", () => {
  const registrations: Array<Record<string, unknown>> = [];
  const names = registerAgentTools({ registerTool: (tool) => registrations.push(tool as Record<string, unknown>) }, async () => ({
    getAgentTree: () => ({ ok: true, data: { nodes: [] } }),
  } as never));

  assert.deepEqual(names, AGENT_TOOL_NAMES);
  assert.deepEqual(registrations.map((tool) => tool.name), [...AGENT_TOOL_NAMES]);
  for (const tool of registrations) {
    assert.equal(tool.executionMode, "sequential");
    assert.equal(typeof tool.execute, "function");
    assert.equal(typeof tool.parameters, "object");
  }

  const spawnTool = registrations.find((tool) => tool.name === "spawn_agent");
  assert.ok(spawnTool);
  assert.match(String(spawnTool.description), /get_agent_templates/);
  assert.match(String(spawnTool.description), /区分大小写/);
  assert.match(String(spawnTool.description), /\[\]/);
  assert.match(String(spawnTool.description), /不能调用|不得调用/);

  const parameters = spawnTool.parameters as {
    readonly properties?: { readonly template_id?: { readonly description?: string } };
  };
  assert.match(parameters.properties?.template_id?.description ?? "", /get_agent_templates/);
  assert.match(parameters.properties?.template_id?.description ?? "", /完全一致|精确/);
});

test("get_agent_templates 直接返回安全模板数组并保留空数组", async () => {
  const registrations: Array<Record<string, unknown>> = [];
  const populated = Object.freeze([Object.freeze({
    template_id: "Explore",
    description: "Fast codebase exploration agent (read-only)",
    tools: Object.freeze(["read", "bash", "grep", "find", "ls"]),
  })]);
  let current: readonly unknown[] = populated;
  registerAgentTools({ registerTool: (tool) => registrations.push(tool as Record<string, unknown>) }, async () => ({
    getAgentTemplates: async () => ({ ok: true, data: current }),
  } as never));
  const templatesTool = registrations.find((tool) => tool.name === "get_agent_templates");
  assert.ok(templatesTool);
  const execute = templatesTool.execute as (...args: unknown[]) => Promise<{
    readonly content: readonly { readonly type: string; readonly text: string }[];
    readonly details: unknown;
  }>;

  const listed = await execute("call", {}, undefined, undefined, {});
  assert.equal(listed.content[0]?.text, JSON.stringify(populated));
  assert.deepEqual(listed.details, populated);
  assert.doesNotMatch(listed.content[0]?.text ?? "", /body|source|model|thinking/i);

  current = Object.freeze([]);
  const empty = await execute("call-empty", {}, undefined, undefined, {});
  assert.equal(empty.content[0]?.text, "[]");
  assert.deepEqual(empty.details, []);

  await assert.rejects(
    execute("call-invalid", { scope: "all" }, undefined, undefined, {}),
    (error: unknown) => error instanceof SubagentToolError && error.code === "invalid_argument",
  );
});

test("控制器失败映射为稳定 SubagentToolError 而不暴露异常", async () => {
  const registrations: Array<Record<string, unknown>> = [];
  registerAgentTools({ registerTool: (tool) => registrations.push(tool as Record<string, unknown>) }, async () => ({
    getAgentTree: () => ({ ok: false, error: {
      code: "agent_not_found",
      message: "代理标识未注册",
      retryable: false,
      details: {},
    } }),
  } as never));
  const treeTool = registrations.find((tool) => tool.name === "get_agent_tree");
  assert.ok(treeTool);
  const execute = treeTool?.execute as (...args: unknown[]) => Promise<unknown>;
  await assert.rejects(
    execute("call", {}, undefined, undefined, {}),
    (error: unknown) => error instanceof SubagentToolError
      && error.code === "agent_not_found"
      && !String(error).includes("stack"),
  );
});

test("get_agent_tree 在执行层拒绝任何调用方指定的范围", async () => {
  const registrations: Array<Record<string, unknown>> = [];
  registerAgentTools({ registerTool: (tool) => registrations.push(tool as Record<string, unknown>) }, async () => ({
    getAgentTree: () => ({ ok: true, data: { scope: { kind: "root" }, nodes: [] } }),
  } as never));
  const treeTool = registrations.find((tool) => tool.name === "get_agent_tree");
  assert.ok(treeTool);
  const execute = treeTool?.execute as (...args: unknown[]) => Promise<unknown>;
  await assert.rejects(
    execute("call", { agent_id: "550e8400-e29b-41d4-a716-446655440000" }, undefined, undefined, {}),
    (error: unknown) => error instanceof SubagentToolError
      && error.code === "invalid_argument"
      && String(error).includes('"details":{}'),
  );
});
