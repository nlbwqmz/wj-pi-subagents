import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_TOOL_NAMES, registerAgentTools, SubagentToolError } from "../src/agent-tools.ts";

test("公开注册入口一次注册完整七工具集合并使用固定参数 schema", () => {
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
