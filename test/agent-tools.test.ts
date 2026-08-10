import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_TOOL_NAMES,
  CHILD_REPLY_TOOL_NAME,
  registerAgentTools,
  registerReplyToParentTool,
  SubagentToolError,
} from "../src/agent-tools.ts";
import { displayWidth } from "../src/agent-tree-ui.ts";
import { controlFailure } from "../src/tree-controller.ts";

const RENDER_THEME = Object.freeze({
  fg: (_color: string, text: string): string => text,
  bold: (text: string): string => text,
});

type ToolCallRenderer = (
  args: unknown,
  theme: typeof RENDER_THEME,
  context: { readonly expanded?: boolean; readonly lastComponent?: unknown },
) => {
  render(width: number): string[];
  invalidate(): void;
};

type ToolResultRenderer = (
  result: {
    readonly content: readonly { readonly type: string; readonly text?: string }[];
    readonly details?: unknown;
  },
  options: { readonly expanded: boolean; readonly isPartial?: boolean },
  theme: typeof RENDER_THEME,
  context: {
    readonly args?: unknown;
    readonly isError?: boolean;
    readonly lastComponent?: unknown;
  },
) => {
  render(width: number): string[];
  invalidate(): void;
};

function toolCallRenderer(
  registrations: readonly Record<string, unknown>[],
  name: string,
): ToolCallRenderer {
  const tool = registrations.find((candidate) => candidate.name === name);
  assert.ok(tool, `未注册工具 ${name}`);
  assert.equal(typeof tool.renderCall, "function");
  return tool.renderCall as ToolCallRenderer;
}

function toolResultRenderer(
  registrations: readonly Record<string, unknown>[],
  name: string,
): ToolResultRenderer {
  const tool = registrations.find((candidate) => candidate.name === name);
  assert.ok(tool, `未注册工具 ${name}`);
  assert.equal(typeof tool.renderResult, "function");
  return tool.renderResult as ToolResultRenderer;
}

test("管理工具系统提示把重复调查与独立验证纳入任务所有权硬约束", () => {
  const registrations: Array<Record<string, unknown>> = [];
  registerAgentTools(
    { registerTool: (tool) => registrations.push(tool as Record<string, unknown>) },
    async () => ({} as never),
  );
  const readGuidelines = (name: string): unknown =>
    registrations.find((tool) => tool.name === name)?.promptGuidelines;

  assert.deepEqual(readGuidelines("send_message"), [
    "任务所有权硬约束：send_message 返回 accepted: true 后，已下发任务范围由目标直接子代理负责，直到该子代理给出最终答复或进入终态。同一任务包括为同一问题、工单或结论执行的调查、实现、测试、复现、验证、评审及其子范围；父会话不得亲自实施或再次委派这些工作。读取或搜索同一源码与文档、运行同一测试、只读分析和独立验证都属于重复实施；‘只读’‘无写冲突’‘交叉验证’不是例外。父会话只能使用 wait_agent 等待、查询状态、向同一子代理发送 steering，或处理派发前已明确拆分、产出独立、无数据依赖且无共享写资源的其他工作。",
    "send_message 返回 accepted: true 只表示消息已被接受，不表示任务完成；若返回 message_delivery_failed，交付状态可能无法确认，不要盲目重发，先查询状态并结合已有回复判断。",
    "收到 output_state: absent 的最终答复，或判断 present 正文仍不可用时，必须向同一 agent_id 尝试追问：只总结上一轮已完成工作并给出最终答复，不要重新执行任务；协议不自动重跑任务或切换模型。",
  ]);
  assert.deepEqual(readGuidelines("wait_agent"), [
    "wait_agent 返回 outcome: reply 时，子代理仍在处理；直接父会话继续等待或使用 send_message 引导同一子代理。wait_agent 返回 outcome: timeout 只结束本次等待，不改变子代理生命周期，也不把任务交回直接父会话。",
    "收到 output_state: absent 的最终答复，或判断 present 正文仍不可用时，必须向同一 agent_id 尝试追问：只总结上一轮已完成工作并给出最终答复，不要重新执行任务；协议不自动重跑任务或切换模型。",
  ]);
  assert.deepEqual(readGuidelines("interrupt_agent"), [
    "直接父会话需要接管已下发任务时，先使用 interrupt_agent，再使用 wait_agent 确认子代理已结束当前处理；确认后再实施相同任务或修改相同资源。",
  ]);
  for (const name of AGENT_TOOL_NAMES) {
    if (name === "send_message" || name === "wait_agent" || name === "interrupt_agent") continue;
    assert.equal(readGuidelines(name), undefined, `${name} 不应重复携带委派规则`);
  }

  const readDescription = (name: string): string =>
    String(registrations.find((tool) => tool.name === name)?.description ?? "");
  assert.match(readDescription("send_message"), /accepted: true/);
  assert.match(readDescription("send_message"), /message_delivery_failed/);
  assert.match(readDescription("wait_agent"), /timeout/);
  assert.match(readDescription("interrupt_agent"), /wait_agent/);
  assert.match(readDescription("terminate_agent"), /永久/);
});

test("模板查询与创建通过注册渲染接口提供语义化调用和结果", async () => {
  const registrations: Array<Record<string, unknown>> = [];
  const agentId = "550e8400-e29b-41d4-a716-446655440000";
  let templates: readonly unknown[] = Object.freeze([
    Object.freeze({
      template_id: "Explore",
      description: "快速探索",
      tools: Object.freeze(["read", "bash"]),
    }),
    Object.freeze({ template_id: "review", tools: Object.freeze([]) }),
  ]);
  registerAgentTools({ registerTool: (tool) => registrations.push(tool as Record<string, unknown>) }, async () => ({
    getAgentTemplates: async () => ({ ok: true, data: templates }),
    spawnAgent: async () => ({ ok: true, data: {
      agent_id: agentId,
      name: "鉴权调查",
      template_id: "Explore",
      depth: 1,
      state: "idle",
    } }),
  } as never));

  assert.deepEqual(
    toolCallRenderer(registrations, "get_agent_templates")({}, RENDER_THEME, {}).render(80),
    ["get_agent_templates"],
  );
  assert.deepEqual(
    toolCallRenderer(registrations, "spawn_agent")(
      { name: "鉴权调查", template_id: "Explore" },
      RENDER_THEME,
      {},
    ).render(80),
    ["spawn_agent", "Explore · 鉴权调查"],
  );

  const templatesTool = registrations.find((tool) => tool.name === "get_agent_templates");
  const spawnTool = registrations.find((tool) => tool.name === "spawn_agent");
  assert.ok(templatesTool && spawnTool);
  const executeTemplates = templatesTool.execute as (...args: unknown[]) => Promise<{
    readonly content: readonly { readonly type: string; readonly text: string }[];
    readonly details: unknown;
  }>;
  const executeSpawn = spawnTool.execute as (...args: unknown[]) => Promise<{
    readonly content: readonly { readonly type: string; readonly text: string }[];
    readonly details: unknown;
  }>;
  const templateResult = await executeTemplates("templates", {}, undefined, undefined, {});
  const renderTemplates = toolResultRenderer(registrations, "get_agent_templates");
  assert.deepEqual(
    renderTemplates(templateResult, { expanded: false }, RENDER_THEME, { args: {} }).render(80),
    ["可用模板 2 · Explore · review"],
  );
  assert.deepEqual(
    renderTemplates(templateResult, { expanded: true }, RENDER_THEME, { args: {} }).render(80),
    [
      "可用模板 2",
      "template_id: Explore",
      "description: 快速探索",
      "tools: read, bash",
      "template_id: review",
      "tools: 无",
    ],
  );

  templates = Object.freeze([]);
  const emptyResult = await executeTemplates("empty", {}, undefined, undefined, {});
  assert.deepEqual(
    renderTemplates(emptyResult, { expanded: false }, RENDER_THEME, { args: {} }).render(80),
    ["无可用模板"],
  );

  const spawnResult = await executeSpawn(
    "spawn",
    { template_id: "Explore", name: "鉴权调查" },
    undefined,
    undefined,
    {},
  );
  const spawnDisplay = toolResultRenderer(registrations, "spawn_agent")(
    spawnResult,
    { expanded: false },
    RENDER_THEME,
    { args: { template_id: "Explore", name: "鉴权调查" } },
  ).render(80).join("\n");
  assert.equal(spawnDisplay, `${agentId} · depth 1`);
  assert.doesNotMatch(spawnDisplay, /Explore|鉴权调查|idle/);
});

test("消息、等待与父回复通过语义化渲染隐藏内部确认字段", async () => {
  const registrations: Array<Record<string, unknown>> = [];
  const agentId = "550e8400-e29b-41d4-a716-446655440000";
  let outcome: "reply" | "settled" | "timeout" | "terminal" = "reply";
  registerAgentTools(
    { registerTool: (tool) => registrations.push(tool as Record<string, unknown>) },
    async () => ({
      sendMessage: async () => ({ ok: true, data: { message_id: "msg-secret", accepted: true } }),
      waitAgent: async () => ({ ok: true, data: {
        agent_id: agentId,
        outcome,
        state: outcome === "settled" ? "idle" : outcome === "terminal" ? "failed" : "working",
        revision: 42,
        ...(outcome === "terminal" ? {
          error: { code: "internal_error", message: "控制器内部错误", retryable: false },
        } : {}),
      } }),
    } as never),
    {
      resolveAgentName: (candidate: string) => candidate === agentId ? "鉴权调查" : undefined,
      readWaitTimeoutMs: () => 45_000,
    },
  );

  assert.deepEqual(
    toolCallRenderer(registrations, "send_message")({
      agent_id: agentId,
      message: "核对鉴权入口",
      images: [
        { type: "image", data: "BASE64_CANARY_A", mimeType: "image/png" },
        { type: "image", data: "BASE64_CANARY_B", mimeType: "image/jpeg" },
      ],
    }, RENDER_THEME, {}).render(100),
    [
      `send_message · ${agentId}`,
      "核对鉴权入口",
      "图片 2 · image/png ×1 · image/jpeg ×1",
    ],
  );
  assert.deepEqual(
    toolCallRenderer(registrations, "wait_agent")({ agent_id: agentId }, RENDER_THEME, {}).render(100),
    [`wait_agent · ${agentId} · timeout_ms 45000`],
  );

  const sendTool = registrations.find((tool) => tool.name === "send_message");
  const waitTool = registrations.find((tool) => tool.name === "wait_agent");
  assert.ok(sendTool && waitTool);
  const executeSend = sendTool.execute as (...args: unknown[]) => Promise<{
    readonly content: readonly { readonly type: string; readonly text: string }[];
    readonly details: unknown;
  }>;
  const executeWait = waitTool.execute as (...args: unknown[]) => Promise<{
    readonly content: readonly { readonly type: string; readonly text: string }[];
    readonly details: unknown;
  }>;
  const sendResult = await executeSend("send", {
    agent_id: agentId,
    message: "核对鉴权入口",
  }, undefined, undefined, {});
  const sendDisplay = toolResultRenderer(registrations, "send_message")(
    sendResult,
    { expanded: false },
    RENDER_THEME,
    { args: { agent_id: agentId, message: "核对鉴权入口" } },
  ).render(80).join("\n");
  assert.equal(sendDisplay, "已发送给 鉴权调查");
  assert.doesNotMatch(sendDisplay, /msg-secret|550e8400|核对鉴权入口/);

  for (const expected of ["reply", "settled", "timeout", "terminal"] as const) {
    outcome = expected;
    const waitResult = await executeWait("wait", { agent_id: agentId }, undefined, undefined, {});
    const waitDisplay = toolResultRenderer(registrations, "wait_agent")(
      waitResult,
      { expanded: false },
      RENDER_THEME,
      { args: { agent_id: agentId } },
    ).render(80).join("\n");
    assert.equal(
      waitDisplay,
      expected === "terminal"
        ? "鉴权调查 · terminal · internal_error"
        : `鉴权调查 · ${expected}`,
    );
    assert.doesNotMatch(waitDisplay, /revision|working|idle|failed|42/);
  }

  const replyRegistrations: Array<Record<string, unknown>> = [];
  registerReplyToParentTool(
    { registerTool: (tool) => replyRegistrations.push(tool as Record<string, unknown>) },
    async () => ({
      replyToParent: async () => ({ ok: true, data: { accepted: true } }),
    } as never),
  );
  assert.deepEqual(
    toolCallRenderer(replyRegistrations, CHILD_REPLY_TOOL_NAME)(
      { message: "正在核对第二个实现分支。" },
      RENDER_THEME,
      {},
    ).render(80),
    [CHILD_REPLY_TOOL_NAME, "正在核对第二个实现分支。"],
  );
  const replyTool = replyRegistrations[0];
  assert.ok(replyTool);
  const replyResult = await (replyTool.execute as (...args: unknown[]) => Promise<{
    readonly content: readonly { readonly type: string; readonly text: string }[];
    readonly details: unknown;
  }>)("reply", { message: "正在核对第二个实现分支。" }, undefined, undefined, {});
  assert.deepEqual(
    toolResultRenderer(replyRegistrations, CHILD_REPLY_TOOL_NAME)(
      replyResult,
      { expanded: false },
      RENDER_THEME,
      { args: { message: "正在核对第二个实现分支。" } },
    ).render(80),
    ["父会话已接收"],
  );
});

test("工具失败结果只显示稳定错误码与安全中文原因", async () => {
  const registrations: Array<Record<string, unknown>> = [];
  registerAgentTools({ registerTool: (tool) => registrations.push(tool as Record<string, unknown>) }, async () => ({
    sendMessage: async () => ({ ok: false, error: {
      code: "message_delivery_failed",
      message: "消息未获确认接收",
      retryable: false,
      details: {},
    } }),
  } as never));
  const sendTool = registrations.find((tool) => tool.name === "send_message");
  assert.ok(sendTool);
  let caught: unknown;
  try {
    await (sendTool.execute as (...args: unknown[]) => Promise<unknown>)(
      "send-error",
      { agent_id: "550e8400-e29b-41d4-a716-446655440000", message: "任务" },
      undefined,
      undefined,
      {},
    );
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof SubagentToolError);
  const display = toolResultRenderer(registrations, "send_message")(
    { content: [{ type: "text", text: caught.message }], details: {} },
    { expanded: false },
    RENDER_THEME,
    {
      args: { agent_id: "550e8400-e29b-41d4-a716-446655440000", message: "任务" },
      isError: true,
    },
  ).render(80).join("\n");
  assert.equal(display, "message_delivery_failed: 消息未获确认接收");
  assert.doesNotMatch(display, /retryable|details|stack|[{}]/);
});

test("九个工具失败结果统一使用稳定错误外壳并适配窄终端", () => {
  const registrations: Array<Record<string, unknown>> = [];
  registerAgentTools({ registerTool: (tool) => registrations.push(tool as Record<string, unknown>) }, async () => ({} as never));
  registerReplyToParentTool(
    { registerTool: (tool) => registrations.push(tool as Record<string, unknown>) },
    async () => ({} as never),
  );
  const failure = controlFailure("termination_incomplete");
  assert.equal(failure.ok, false);
  if (failure.ok) throw new Error("termination_incomplete 应为失败结果");
  const error = new SubagentToolError(failure.error);

  for (const name of [...AGENT_TOOL_NAMES, CHILD_REPLY_TOOL_NAME]) {
    const renderer = toolResultRenderer(registrations, name);
    const result = {
      content: [{ type: "text", text: error.message }],
      details: {},
    };
    assert.equal(
      renderer(result, { expanded: false }, RENDER_THEME, { isError: true }).render(120).join("\n"),
      "termination_incomplete: 代理资源尚未完全回收",
      `${name} 未使用统一错误展示`,
    );
    const narrowLines = renderer(result, { expanded: false }, RENDER_THEME, { isError: true }).render(16);
    assert.ok(
      narrowLines.every((line) => displayWidth(line) <= 16),
      `${name} 失败结果超出窄终端宽度`,
    );
  }
});

test("中断、终止、状态和树结果只投影必要的安全字段", () => {
  const registrations: Array<Record<string, unknown>> = [];
  const agentId = "550e8400-e29b-41d4-a716-446655440000";
  const childId = "650e8400-e29b-41d4-a716-446655440000";
  const finishedId = "750e8400-e29b-41d4-a716-446655440000";
  const snapshot = {
    agent_id: agentId,
    parent_agent_id: null,
    template_id: "Explore",
    name: "鉴权调查",
    depth: 1,
    state: "working",
    pending_message_count: 0,
    revision: 7,
    created_at: "2026-01-02T03:04:05.006Z",
    lifecycle_elapsed_ms: 1234,
    activity: { category: "reading", active_count: 1 },
  } as const;
  const child = {
    agent_id: childId,
    parent_agent_id: agentId,
    template_id: "review",
    name: "复核分支",
    depth: 2,
    state: "idle",
    pending_message_count: 2,
    revision: 8,
    created_at: "2026-01-02T03:04:06.006Z",
    lifecycle_elapsed_ms: 2345,
  } as const;
  const finished = {
    agent_id: finishedId,
    parent_agent_id: agentId,
    template_id: "cleanup",
    name: "已回收分支",
    depth: 2,
    state: "terminated",
    pending_message_count: 0,
    revision: 9,
    created_at: "2026-01-02T03:04:07.006Z",
    lifecycle_elapsed_ms: 3456,
    termination_result: "completed",
  } as const;
  registerAgentTools(
    { registerTool: (tool) => registrations.push(tool as Record<string, unknown>) },
    async () => ({
      interruptAgent: async () => ({ ok: true, data: {
        agent_id: agentId, accepted: true, changed: true, state: "idle",
      } }),
      terminateAgent: async () => ({ ok: true, data: {
        agent_id: agentId, state: "terminated", changed: true, forced: true, terminated_count: 3,
      } }),
      getAgentStatus: () => ({ ok: true, data: snapshot }),
      getAgentTree: () => ({ ok: true, data: {
        scope: { kind: "root" }, tree_revision: 12, nodes: [snapshot, child, finished],
      } }),
    } as never),
    { resolveAgentName: (candidate: string) => candidate === agentId ? "鉴权调查" : undefined },
  );

  assert.deepEqual(
    toolCallRenderer(registrations, "interrupt_agent")({ agent_id: agentId }, RENDER_THEME, {}).render(100),
    [`interrupt_agent · ${agentId}`],
  );
  assert.deepEqual(
    toolCallRenderer(registrations, "terminate_agent")({ agent_id: agentId }, RENDER_THEME, {}).render(100),
    [`terminate_agent · ${agentId}`],
  );
  assert.deepEqual(
    toolCallRenderer(registrations, "get_agent_status")({ agent_id: agentId }, RENDER_THEME, {}).render(100),
    [`get_agent_status · ${agentId}`],
  );
  assert.deepEqual(
    toolCallRenderer(registrations, "get_agent_tree")({}, RENDER_THEME, {}).render(100),
    ["get_agent_tree"],
  );

  const readExecute = (name: string) => {
    const tool = registrations.find((candidate) => candidate.name === name);
    assert.ok(tool);
    return tool.execute as (...args: unknown[]) => Promise<{
      readonly content: readonly { readonly type: string; readonly text: string }[];
      readonly details: unknown;
    }>;
  };
  const interruptResult = readExecute("interrupt_agent")("interrupt", { agent_id: agentId }, undefined, undefined, {});
  const terminateResult = readExecute("terminate_agent")("terminate", { agent_id: agentId }, undefined, undefined, {});
  const statusResult = readExecute("get_agent_status")("status", { agent_id: agentId }, undefined, undefined, {});
  const treeResult = readExecute("get_agent_tree")("tree", {}, undefined, undefined, {});

  return Promise.all([interruptResult, terminateResult, statusResult, treeResult]).then(([interrupt, terminate, status, tree]) => {
    const interruptDisplay = toolResultRenderer(registrations, "interrupt_agent")(
      interrupt, { expanded: false }, RENDER_THEME, { args: { agent_id: agentId } },
    ).render(100).join("\n");
    assert.equal(interruptDisplay, "鉴权调查 · changed · idle");
    assert.doesNotMatch(interruptDisplay, /accepted|550e8400/);

    const unchanged = toolResultRenderer(registrations, "interrupt_agent")(
      { content: [{ type: "text", text: "unused" }], details: {
        agent_id: agentId, accepted: true, changed: false, state: "working",
      } },
      { expanded: false }, RENDER_THEME, { args: { agent_id: agentId } },
    ).render(100).join("\n");
    assert.equal(unchanged, "鉴权调查 · unchanged · working");

    const failedStatus = toolResultRenderer(registrations, "get_agent_status")(
      { content: [{ type: "text", text: "unused" }], details: {
        agent_id: agentId,
        parent_agent_id: null,
        template_id: "Explore",
        name: "鉴权调查",
        depth: 1,
        state: "failed",
        pending_message_count: 0,
        revision: 10,
        created_at: "2026-01-02T03:04:08.006Z",
        lifecycle_elapsed_ms: 4567,
        error: { code: "internal_error", message: "控制器内部错误", retryable: false },
      } },
      { expanded: true }, RENDER_THEME, { args: { agent_id: agentId } },
    ).render(100).join("\n");
    assert.match(failedStatus, /error\.code: internal_error/);
    assert.match(failedStatus, /error\.message: 控制器内部错误/);
    assert.match(failedStatus, /error\.retryable: false/);

    const terminateDisplay = toolResultRenderer(registrations, "terminate_agent")(
      terminate, { expanded: false }, RENDER_THEME, { args: { agent_id: agentId } },
    ).render(100).join("\n");
    assert.equal(terminateDisplay, "鉴权调查 · 新回收 3 个节点 · forced");
    assert.doesNotMatch(terminateDisplay, /terminated|changed/);

    const idempotent = toolResultRenderer(registrations, "terminate_agent")(
      { content: [{ type: "text", text: "unused" }], details: {
        agent_id: agentId, state: "terminated", changed: false, forced: false, terminated_count: 0,
      } },
      { expanded: false }, RENDER_THEME, { args: { agent_id: agentId } },
    ).render(100).join("\n");
    assert.equal(idempotent, "鉴权调查 · 幂等，无新增回收");

    const statusCollapsed = toolResultRenderer(registrations, "get_agent_status")(
      status, { expanded: false }, RENDER_THEME, { args: { agent_id: agentId } },
    ).render(100).join("\n");
    assert.match(statusCollapsed, /template_id: Explore/);
    assert.match(statusCollapsed, /name: 鉴权调查/);
    assert.match(statusCollapsed, /activity\.category: reading/);
    assert.doesNotMatch(statusCollapsed, /agent_id:|parent_agent_id:|revision: 7|created_at:/);

    const statusExpanded = toolResultRenderer(registrations, "get_agent_status")(
      status, { expanded: true }, RENDER_THEME, { args: { agent_id: agentId } },
    ).render(100).join("\n");
    assert.match(statusExpanded, /agent_id: 550e8400-e29b-41d4-a716-446655440000/);
    assert.match(statusExpanded, /parent_agent_id: null/);
    assert.match(statusExpanded, /revision: 7/);
    assert.match(statusExpanded, /lifecycle_elapsed_ms: 1234/);

    const treeCollapsed = toolResultRenderer(registrations, "get_agent_tree")(
      tree, { expanded: false }, RENDER_THEME, { args: {} },
    ).render(160).join("\n");
    assert.equal(treeCollapsed, "scope: root · active 2 · working 1 · failed 0 · completed 1 · pending 2");
    assert.doesNotMatch(treeCollapsed, /鉴权调查|复核分支|550e8400/);

    const emptyTree = toolResultRenderer(registrations, "get_agent_tree")(
      { content: [{ type: "text", text: "unused" }], details: {
        scope: { kind: "root" }, tree_revision: 0, nodes: [],
      } },
      { expanded: false }, RENDER_THEME, { args: {} },
    ).render(160).join("\n");
    assert.equal(emptyTree, "scope: root · active 0 · working 0 · failed 0 · completed 0 · pending 0");

    const treeExpandedLines = toolResultRenderer(registrations, "get_agent_tree")(
      tree, { expanded: true }, RENDER_THEME, { args: {} },
    ).render(160);
    const treeExpanded = treeExpandedLines.join("\n");
    assert.match(treeExpanded, /tree_revision: 12/);
    assert.match(treeExpanded, /Explore · 鉴权调查 · working · 550e8400/);
    assert.match(treeExpanded, /  - review · 复核分支 · idle · 650e8400/);
    assert.match(treeExpanded, /finished · completed 1/);
    assert.ok(treeExpandedLines.every((line) => displayWidth(line) <= 160));
  });
});

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
    assert.equal(typeof tool.renderCall, "function");
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

test("代理工具调用行显示入参，并安全折叠长消息和图片 payload", () => {
  const registrations: Array<Record<string, unknown>> = [];
  registerAgentTools({ registerTool: (tool) => registrations.push(tool as Record<string, unknown>) }, async () => ({} as never));
  const agentId = "550e8400-e29b-41d4-a716-446655440000";

  const waitLines = toolCallRenderer(registrations, "wait_agent")(
    { agent_id: agentId, timeout_ms: 600_000 },
    RENDER_THEME,
    {},
  ).render(80);
  const waitDisplay = waitLines.join("\n");
  assert.match(waitDisplay, /wait_agent/);
  assert.match(waitDisplay, new RegExp(agentId));
  assert.match(waitDisplay, /600000/);

  const base64Canary = "DO_NOT_RENDER_BASE64";
  const messageTail = "完整消息尾部";
  const message = `开头\u001b[31m\u202e${"消息内容".repeat(40)}${messageTail}`;
  const sendRenderer = toolCallRenderer(registrations, "send_message");
  const collapsedLines = sendRenderer({
    agent_id: agentId,
    message,
    images: [{ type: "image", data: base64Canary, mimeType: "image/png" }],
  }, RENDER_THEME, {}).render(36);
  const collapsedDisplay = collapsedLines.join("\n");
  assert.match(collapsedDisplay, /send_message/);
  assert.ok(collapsedDisplay.replaceAll(/\s/gu, "").includes(agentId));
  assert.match(collapsedDisplay, /展开查看完整正文/);
  assert.doesNotMatch(collapsedDisplay, /Ctrl\+O/);
  assert.doesNotMatch(collapsedDisplay, new RegExp(base64Canary));
  assert.equal(collapsedDisplay.includes("\u001b"), false);
  assert.equal(collapsedDisplay.includes("\u202e"), false);
  assert.ok(collapsedLines.length <= 7);

  const expandedLines = sendRenderer({
    agent_id: agentId,
    message,
    images: [{ type: "image", data: base64Canary, mimeType: "image/png" }],
  }, RENDER_THEME, { expanded: true }).render(36);
  const expandedDisplay = expandedLines.join("\n");
  assert.match(expandedDisplay, new RegExp(messageTail));
  assert.match(expandedDisplay, /图片 1 · image\/png ×1/);
  assert.doesNotMatch(expandedDisplay, new RegExp(base64Canary));
  assert.equal(expandedDisplay.includes("\u001b"), false);
  assert.equal(expandedDisplay.includes("\u202e"), false);

  for (const line of waitLines) {
    assert.ok(displayWidth(line) <= 80, `工具调用行超出终端宽度：${line}`);
  }
  const lineBreakingSpawn = toolCallRenderer(registrations, "spawn_agent")({
    template_id: "Explore\nforged",
    name: "鉴权\n调查",
  }, RENDER_THEME, {}).render(80);
  assert.deepEqual(lineBreakingSpawn, ["spawn_agent", "Explore forged · 鉴权 调查"]);

  for (const line of [...collapsedLines, ...expandedLines]) {
    assert.ok(displayWidth(line) <= 36, `工具调用行超出终端宽度：${line}`);
  }
});

test("reply_to_parent 也使用相同的入参渲染", () => {
  const registrations: Array<Record<string, unknown>> = [];
  registerReplyToParentTool({ registerTool: (tool) => registrations.push(tool as Record<string, unknown>) }, async () => undefined);
  const lines = toolCallRenderer(registrations, CHILD_REPLY_TOOL_NAME)(
    {
      message: "正在检查调用参数展示",
      requires_response: false,
      images: [{ type: "image", data: "DO_NOT_RENDER_REPLY_IMAGE", mimeType: "image/png" }],
    },
    RENDER_THEME,
    { expanded: true },
  ).render(80);

  assert.match(lines.join("\n"), /reply_to_parent/);
  assert.match(lines.join("\n"), /正在检查调用参数展示/);
  assert.match(lines.join("\n"), /图片 1/);
  assert.doesNotMatch(lines.join("\n"), /DO_NOT_RENDER_REPLY_IMAGE/);
  const parameters = registrations[0]?.parameters as {
    readonly required?: readonly string[];
    readonly properties?: Readonly<Record<string, unknown>>;
  } | undefined;
  assert.deepEqual(parameters?.required, ["message", "requires_response"]);
  assert.ok(parameters?.properties?.images);
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
