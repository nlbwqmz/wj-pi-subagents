import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
  AgentTreeFailureNotifier,
  AgentTreePanelModel,
  bindAgentTreeUi,
  displayWidth,
  renderAgentTreePanelSurface,
  renderAgentsWidget,
} from "../src/agent-tree-ui.ts";
import type {
  AgentSnapshot,
  ScopedAgentTreeSnapshot,
} from "../src/tree-controller.ts";

const PARENT_ID = "71000000-0000-4000-8000-000000000001";
const CHILD_ID = "71000000-0000-4000-8000-000000000002";
const GRANDCHILD_ID = "71000000-0000-4000-8000-000000000003";
const FINISHED_ID = "71000000-0000-4000-8000-000000000004";
const ACTIVE_PARENT_ID = "71000000-0000-4000-8000-000000000005";
const DEEP_BRANCH_ID = "71000000-0000-4000-8000-000000000006";
const WORKING_ID = "71000000-0000-4000-8000-000000000007";
const FAILED_ID = "71000000-0000-4000-8000-000000000008";
const INCOMPLETE_ID = "71000000-0000-4000-8000-000000000009";
const FINISHED_FAILED_ID = "71000000-0000-4000-8000-000000000012";
const FINISHED_INCOMPLETE_ID = "71000000-0000-4000-8000-000000000013";

const PANEL_THEME = Object.freeze({
  fg(color: string, text: string): string {
    const code = color === "borderAccent" ? 51 : color === "accent" ? 45 : color === "error" ? 196 : 252;
    return `\x1b[38;5;${code}m${text}\x1b[39m`;
  },
  bg(color: string, text: string): string {
    const code = color === "selectedBg" ? 60 : 236;
    return `\x1b[48;5;${code}m${text}\x1b[49m`;
  },
  bold(text: string): string {
    return `\x1b[1m${text}\x1b[22m`;
  },
});

function node(overrides: Partial<AgentSnapshot> & Pick<AgentSnapshot, "agent_id" | "parent_agent_id">): AgentSnapshot {
  const {
    agent_id,
    parent_agent_id,
    state = "idle",
    activity,
    ...rest
  } = overrides;
  const normalizedActivity = state === "working" || state === "interrupting"
    ? activity ?? Object.freeze({ phase: "processing" as const })
    : state === "suspended"
      ? activity ?? Object.freeze({ phase: "maintenance_failed" as const })
      : undefined;
  return Object.freeze({
    agent_id,
    parent_agent_id,
    template_id: "researcher",
    name: "资料代理",
    depth: parent_agent_id === null ? 1 : 2,
    state,
    mailbox_pending_count: 0,
    host_pending_count: 0,
    reply_outbox_pending_count: 0,
    revision: 1,
    created_at: "2026-08-06T07:59:00.000Z",
    lifecycle_elapsed_ms: 60_000,
    ...rest,
    ...(normalizedActivity === undefined ? {} : { activity: normalizedActivity }),
  });
}

function subtreeSnapshot(nodes: readonly AgentSnapshot[], revision = 1): ScopedAgentTreeSnapshot {
  return Object.freeze({
    scope: Object.freeze({ kind: "subtree" as const, agent_id: PARENT_ID }),
    tree_revision: revision,
    nodes: Object.freeze([...nodes]),
  });
}

test("常驻 Agents widget 在没有直接子代理时不显示", () => {
  const snapshot = subtreeSnapshot([
    node({ agent_id: PARENT_ID, parent_agent_id: null, template_id: "parent", name: "当前会话" }),
  ]);

  assert.deepEqual(renderAgentsWidget(snapshot, 120), []);
});

test("常驻 Agents widget 只按稳定字段顺序显示作用域直接子代理并安全截断", () => {
  const snapshot = subtreeSnapshot([
    node({ agent_id: PARENT_ID, parent_agent_id: null, template_id: "parent", name: "当前会话" }),
    node({
      agent_id: CHILD_ID,
      parent_agent_id: PARENT_ID,
      template_id: "研🙂e\u0301究员",
      name: "直接子代理",
      state: "failed",
      lifecycle_elapsed_ms: 65_000,
      mailbox_pending_count: 0,
      error: Object.freeze({
        code: "internal_error",
        message: "控制器内部错误",
        retryable: false,
      }),
    }),
    node({
      agent_id: GRANDCHILD_ID,
      parent_agent_id: CHILD_ID,
      template_id: "deep-secret-canary",
      name: "越级后代",
      depth: 3,
    }),
    node({
      agent_id: FINISHED_ID,
      parent_agent_id: PARENT_ID,
      template_id: "finished-secret-canary",
      name: "已结束",
      state: "terminated",
      mailbox_pending_count: 0,
      termination_result: "completed",
    }),
  ]);

  assert.deepEqual(renderAgentsWidget(snapshot, 120), [
    "Agents",
    "  研🙂e\u0301究员 · 直接子代理 · failed · 1m 05s · internal_error",
  ]);
  assert.deepEqual(renderAgentsWidget(snapshot, 8), ["Agents", "  研🙂e\u0301…"]);
  assert.doesNotMatch(renderAgentsWidget(snapshot, 120).join("\n"), /secret-canary|terminate|interrupt|reload/i);
});

test("常驻 Agents widget 隐藏活动类别计数但代理树面板保留", () => {
  const snapshot = subtreeSnapshot([
    node({ agent_id: PARENT_ID, parent_agent_id: null, template_id: "parent", name: "当前会话" }),
    node({
      agent_id: WORKING_ID,
      parent_agent_id: PARENT_ID,
      template_id: "worker",
      name: "活动子代理",
      state: "working",
      activity: Object.freeze({
        phase: "executing_tools",
        category: "reading",
        active_count: 2,
      }),
    }),
  ], 2);

  const widget = renderAgentsWidget(snapshot, 120);
  assert.deepEqual(widget, [
    "Agents",
    "  worker · 活动子代理 · working · executing_tools · 1m 00s",
  ]);
  assert.doesNotMatch(widget.join("\n"), /reading 2/);
  assert.match(
    new AgentTreePanelModel(snapshot).render(120).join("\n"),
    /worker · 活动子代理 · working · executing_tools · reading 2 · 1m 00s/,
  );
});

test("所有 UI 文本出口净化模板与名称中的终端控制字符", () => {
  const maliciousTemplate = "worker\u001b[31m\n伪造行";
  const maliciousName = "代理\u009b2J\r\nAgents";
  const baseline = subtreeSnapshot([
    node({ agent_id: PARENT_ID, parent_agent_id: null, template_id: "parent", name: "当前会话" }),
    node({
      agent_id: CHILD_ID,
      parent_agent_id: PARENT_ID,
      template_id: maliciousTemplate,
      name: maliciousName,
    }),
  ], 1);
  const failed = subtreeSnapshot(baseline.nodes.map((item) => item.agent_id === CHILD_ID
    ? node({
        ...item,
        agent_id: item.agent_id,
        parent_agent_id: item.parent_agent_id,
        state: "failed",
        revision: item.revision + 1,
        error: Object.freeze({
          code: "internal_error",
          message: "控制器内部错误",
          retryable: false,
        }),
      })
    : item), 2);
  const notifications: string[] = [];
  const notifier = new AgentTreeFailureNotifier(baseline, (message) => notifications.push(message));

  assert.equal(notifier.update(failed), "changed");
  const widget = renderAgentsWidget(failed, 160);
  const panel = new AgentTreePanelModel(failed).render(160);
  const visibleText = [...widget, ...panel, ...notifications];

  assert.equal(widget.length, 2);
  assert.equal(notifications.length, 1);
  for (const line of visibleText) assert.doesNotMatch(line, /[\u0000-\u001f\u007f-\u009f]/u);
  assert.doesNotMatch(visibleText.join("\n"), /\u001b|\u009b/);
});

test("代理树面板默认展开直接子代理、折叠深层分支并优先显示活动或故障分支", () => {
  const snapshot = subtreeSnapshot([
    node({ agent_id: PARENT_ID, parent_agent_id: null, template_id: "parent", name: "当前会话" }),
    node({ agent_id: CHILD_ID, parent_agent_id: PARENT_ID, template_id: "idle", name: "纯空闲分支" }),
    node({
      agent_id: ACTIVE_PARENT_ID,
      parent_agent_id: PARENT_ID,
      template_id: "worker",
      name: "活跃分支",
    }),
    node({
      agent_id: DEEP_BRANCH_ID,
      parent_agent_id: ACTIVE_PARENT_ID,
      template_id: "deep",
      name: "深层分支",
      depth: 3,
    }),
    node({
      agent_id: WORKING_ID,
      parent_agent_id: DEEP_BRANCH_ID,
      template_id: "runner",
      name: "工作后代",
      depth: 4,
      state: "working",
      mailbox_pending_count: 2,
    }),
    node({
      agent_id: FAILED_ID,
      parent_agent_id: DEEP_BRANCH_ID,
      template_id: "broken",
      name: "故障后代",
      depth: 4,
      state: "failed",
      error: Object.freeze({
        code: "internal_error",
        message: "控制器内部错误",
        retryable: false,
      }),
    }),
    node({
      agent_id: INCOMPLETE_ID,
      parent_agent_id: DEEP_BRANCH_ID,
      template_id: "cleanup",
      name: "待清理后代",
      depth: 4,
      state: "terminating",
      mailbox_pending_count: 1,
      error: Object.freeze({
        code: "termination_incomplete",
        message: "代理资源尚未完全回收",
        retryable: true,
      }),
    }),
    node({
      agent_id: FINISHED_ID,
      parent_agent_id: PARENT_ID,
      template_id: "done",
      name: "已结束",
      state: "terminated",
      mailbox_pending_count: 0,
      termination_result: "completed",
    }),
    node({
      agent_id: FINISHED_FAILED_ID,
      parent_agent_id: PARENT_ID,
      template_id: "failed-done",
      name: "故障后终止",
      state: "terminated",
      mailbox_pending_count: 0,
      termination_result: "failed",
    }),
    node({
      agent_id: FINISHED_INCOMPLETE_ID,
      parent_agent_id: PARENT_ID,
      template_id: "cleanup-done",
      name: "重试后终止",
      state: "terminated",
      mailbox_pending_count: 0,
      termination_result: "incomplete",
    }),
  ], 7);

  const model = new AgentTreePanelModel(snapshot, { viewport_height: 10 });
  assert.deepEqual(model.render(120), [
    "Agent tree · revision 7",
    "› ▾ worker · 活跃分支 · idle · 1m 00s",
    "    ▸ deep · 深层分支 · idle · 1m 00s · descendants 3 · working 1 · failed 1 · pending 3",
    "  · idle · 纯空闲分支 · idle · 1m 00s",
    "  ▸ finished · completed 1 · failed 1 · incomplete 1",
    "↑↓ scroll · ←→ fold · Esc close",
  ]);
  assert.doesNotMatch(model.render(120).join("\n"), /工作后代|故障后代|待清理后代|已结束/);
  model.handleInput("\x1b[B");
  model.handleInput("\x1b[B");
  model.handleInput("\x1b[B");
  model.handleInput("\x1b[C");
  assert.match(model.render(120).join("\n"), /done · 已结束 · completed/);
  assert.match(model.render(120).join("\n"), /failed-done · 故障后终止 · failed/);
  assert.match(model.render(120).join("\n"), /cleanup-done · 重试后终止 · incomplete/);
  assert.doesNotMatch(model.render(120).join("\n"), /broken · 故障后代|cleanup · 待清理后代/);
});

test("代理树遮罩面板使用完整主题表面并让选中行独立高亮", () => {
  const snapshot = subtreeSnapshot([
    node({ agent_id: PARENT_ID, parent_agent_id: null, template_id: "parent", name: "当前会话" }),
    node({ agent_id: CHILD_ID, parent_agent_id: PARENT_ID, template_id: "worker", name: "直接子代理" }),
  ], 4);
  const lines = renderAgentTreePanelSurface(new AgentTreePanelModel(snapshot), 72, PANEL_THEME);
  const plainLines = lines.map((line) => stripVTControlCharacters(line));

  assert.equal(lines.length, 18);
  for (const line of plainLines) assert.equal(displayWidth(line), 72);
  assert.equal(plainLines[0], `┏${"━".repeat(70)}┓`);
  assert.match(plainLines[1]!, /┃ AGENT TREE\s+REV 4 ┃/);
  assert.match(lines[3]!, /\x1b\[48;5;60m/);
  assert.match(lines[4]!, /\x1b\[48;5;236m/);
  assert.equal(plainLines.at(-1), `┗${"━".repeat(70)}┛`);

  for (const width of [1, 2, 5, 6, 20]) {
    const narrowLines = renderAgentTreePanelSurface(new AgentTreePanelModel(snapshot), width, PANEL_THEME);
    assert.equal(
      narrowLines.every((line) => displayWidth(stripVTControlCharacters(line)) === width),
      true,
      `面板在 ${width} 列下必须保持稳定行宽`,
    );
  }
});

test("代理树面板支持上下滚动、左右展开折叠和 Esc 关闭", () => {
  const snapshot = subtreeSnapshot([
    node({ agent_id: PARENT_ID, parent_agent_id: null, template_id: "parent", name: "当前会话" }),
    node({ agent_id: ACTIVE_PARENT_ID, parent_agent_id: PARENT_ID, template_id: "worker", name: "直接子代理" }),
    node({
      agent_id: DEEP_BRANCH_ID,
      parent_agent_id: ACTIVE_PARENT_ID,
      template_id: "deep",
      name: "深层分支",
      depth: 3,
    }),
    node({
      agent_id: WORKING_ID,
      parent_agent_id: DEEP_BRANCH_ID,
      template_id: "runner",
      name: "工作后代",
      depth: 4,
      state: "working",
    }),
  ], 8);
  const model = new AgentTreePanelModel(snapshot, { viewport_height: 2 });

  assert.equal(model.handleInput("\x1b[B"), "changed");
  assert.equal(model.getPublicState().selected_key, DEEP_BRANCH_ID);
  assert.equal(model.handleInput("\x1b[C"), "changed");
  assert.deepEqual(model.getPublicState().expanded_agent_ids, [ACTIVE_PARENT_ID, DEEP_BRANCH_ID]);
  assert.equal(model.handleInput("\x1b[B"), "changed");
  assert.deepEqual(model.getPublicState(), {
    status: "ready",
    tree_revision: 8,
    selected_key: WORKING_ID,
    scroll_offset: 1,
    expanded_agent_ids: [ACTIVE_PARENT_ID, DEEP_BRANCH_ID],
    finished_expanded: false,
  });
  assert.deepEqual(model.render(80), [
    "Agent tree · revision 8",
    "    ▾ deep · 深层分支 · idle · 1m 00s",
    "›     · runner · 工作后代 · working · processing · 1m 00s",
    "↑↓ scroll · ←→ fold · Esc close",
  ]);

  assert.equal(model.handleInput("\x1b[D"), "changed");
  assert.equal(model.getPublicState().selected_key, DEEP_BRANCH_ID);
  assert.equal(model.handleInput("\x1b[D"), "changed");
  assert.deepEqual(model.getPublicState().expanded_agent_ids, [ACTIVE_PARENT_ID]);
  assert.equal(model.handleInput("\x1b"), "close");
});

test("新树修订原子刷新全部事实并保留展开集合与滚动位置", () => {
  const initial = subtreeSnapshot([
    node({ agent_id: PARENT_ID, parent_agent_id: null, template_id: "parent", name: "当前会话" }),
    node({ agent_id: ACTIVE_PARENT_ID, parent_agent_id: PARENT_ID, template_id: "worker", name: "直接子代理" }),
    node({
      agent_id: DEEP_BRANCH_ID,
      parent_agent_id: ACTIVE_PARENT_ID,
      template_id: "deep",
      name: "深层分支",
      depth: 3,
    }),
    node({
      agent_id: WORKING_ID,
      parent_agent_id: DEEP_BRANCH_ID,
      template_id: "runner",
      name: "工作后代",
      depth: 4,
      state: "working",
    }),
  ], 8);
  const model = new AgentTreePanelModel(initial, { viewport_height: 2 });
  model.handleInput("\x1b[B");
  model.handleInput("\x1b[C");
  model.handleInput("\x1b[B");
  assert.equal(model.getPublicState().scroll_offset, 1);

  const updated = subtreeSnapshot(initial.nodes.map((item) => {
    if (item.agent_id === WORKING_ID) return node({
      ...item,
      agent_id: item.agent_id,
      parent_agent_id: item.parent_agent_id,
      state: "working",
      activity: Object.freeze({ phase: "reconciling" }),
      mailbox_pending_count: 4,
      lifecycle_elapsed_ms: 125_000,
      revision: item.revision + 1,
    });
    return item;
  }).concat(node({
    agent_id: FINISHED_ID,
    parent_agent_id: PARENT_ID,
    template_id: "done",
    name: "已结束",
    state: "terminated",
    mailbox_pending_count: 0,
    termination_result: "completed",
  })), 9);

  assert.equal(model.update(updated), "changed");
  assert.deepEqual(model.getPublicState(), {
    status: "ready",
    tree_revision: 9,
    selected_key: WORKING_ID,
    scroll_offset: 1,
    expanded_agent_ids: [ACTIVE_PARENT_ID, DEEP_BRANCH_ID],
    finished_expanded: false,
  });
  assert.match(model.render(100).join("\n"), /runner · 工作后代 · working · reconciling · 2m 05s · queues 4\/0\/0/);
  assert.equal(model.handleInput("\x1b[B"), "changed");
  assert.match(model.render(100).join("\n"), /finished · completed 1/);
  assert.equal(model.update(initial), "ignored");
  assert.equal(model.getPublicState().tree_revision, 9);
});

test("同一树修订只刷新控制器确认的生命周期时长", () => {
  const initial = subtreeSnapshot([
    node({ agent_id: PARENT_ID, parent_agent_id: null, template_id: "parent", name: "当前会话" }),
    node({
      agent_id: CHILD_ID,
      parent_agent_id: PARENT_ID,
      template_id: "worker",
      name: "计时代理",
      lifecycle_elapsed_ms: 60_000,
    }),
  ], 5);
  const model = new AgentTreePanelModel(initial);
  const elapsed = subtreeSnapshot(initial.nodes.map((item) => item.agent_id === CHILD_ID
    ? node({
        ...item,
        agent_id: item.agent_id,
        parent_agent_id: item.parent_agent_id,
        lifecycle_elapsed_ms: 65_000,
      })
    : item), 5);
  assert.equal(model.refreshElapsed(elapsed), "changed");
  assert.match(model.render(80).join("\n"), /1m 05s/);

  const forged = subtreeSnapshot(elapsed.nodes.map((item) => item.agent_id === CHILD_ID
    ? node({
        ...item,
        agent_id: item.agent_id,
        parent_agent_id: item.parent_agent_id,
        state: "working",
        mailbox_pending_count: 99,
      })
    : item), 5);
  assert.equal(model.refreshElapsed(forged), "error");
  assert.deepEqual(model.render(80), ["Agent tree", "代理树暂时不可用", "Esc close"]);
});

test("非法修订显示固定安全错误，作用域根失效时请求关闭面板", () => {
  const initial = subtreeSnapshot([
    node({ agent_id: PARENT_ID, parent_agent_id: null, template_id: "parent", name: "当前会话" }),
    node({ agent_id: CHILD_ID, parent_agent_id: PARENT_ID, template_id: "worker", name: "直接子代理" }),
  ], 3);
  const model = new AgentTreePanelModel(initial);
  const invalid = {
    ...initial,
    tree_revision: 4,
    nodes: [{
      ...initial.nodes[1],
      parent_agent_id: "D:\\private\\secret-canary.txt",
      stack: "TOP_SECRET_STACK",
    }],
  };

  assert.equal(model.update(invalid as never), "error");
  assert.deepEqual(model.getPublicState(), {
    status: "error",
    tree_revision: 3,
    scroll_offset: 0,
    expanded_agent_ids: [CHILD_ID],
    finished_expanded: false,
  });
  assert.deepEqual(model.render(80), [
    "Agent tree",
    "代理树暂时不可用",
    "Esc close",
  ]);
  assert.doesNotMatch(model.render(80).join("\n"), /secret-canary|TOP_SECRET|直接子代理/);
  assert.equal(model.handleInput("\x1b[A"), "ignored");
  assert.equal(model.handleInput("\x1b"), "close");

  const closing = new AgentTreePanelModel(initial);
  assert.equal(closing.update(subtreeSnapshot([
    node({ agent_id: CHILD_ID, parent_agent_id: null, template_id: "worker", name: "作用域已失效" }),
  ], 4)), "close");
});

test("面板拒绝控制器不可能产生的生命周期组合与非父先拓扑", () => {
  const initial = subtreeSnapshot([
    node({ agent_id: PARENT_ID, parent_agent_id: null, template_id: "parent", name: "当前会话" }),
    node({ agent_id: CHILD_ID, parent_agent_id: PARENT_ID, template_id: "worker", name: "直接子代理" }),
  ], 3);
  const impossibleNodes: readonly (readonly AgentSnapshot[])[] = [
    initial.nodes.map((item) => item.agent_id === CHILD_ID
      ? node({
          ...item,
          agent_id: item.agent_id,
          parent_agent_id: item.parent_agent_id,
          state: "failed",
        })
      : item),
    initial.nodes.map((item) => item.agent_id === CHILD_ID
      ? node({
          ...item,
          agent_id: item.agent_id,
          parent_agent_id: item.parent_agent_id,
          state: "terminated",
          mailbox_pending_count: 1,
          termination_result: "completed",
        })
      : item),
    initial.nodes.map((item) => item.agent_id === CHILD_ID
      ? node({
          ...item,
          agent_id: item.agent_id,
          parent_agent_id: item.parent_agent_id,
          state: "starting",
        })
      : item),
    Object.freeze([
      initial.nodes[0]!,
      node({
        agent_id: GRANDCHILD_ID,
        parent_agent_id: CHILD_ID,
        template_id: "deep",
        name: "乱序后代",
        depth: 3,
      }),
      initial.nodes[1]!,
    ]),
  ];

  for (const nodes of impossibleNodes) {
    const model = new AgentTreePanelModel(initial);
    assert.equal(model.update(subtreeSnapshot(nodes, 4)), "error");
    assert.deepEqual(model.render(80), ["Agent tree", "代理树暂时不可用", "Esc close"]);
  }
});

test("新故障按同一可见修订聚合为脱敏 UI-only 通知", () => {
  const baseline = subtreeSnapshot([
    node({ agent_id: PARENT_ID, parent_agent_id: null, template_id: "parent", name: "当前会话" }),
    node({ agent_id: CHILD_ID, parent_agent_id: PARENT_ID, template_id: "worker", name: "已有正常节点" }),
    node({
      agent_id: FAILED_ID,
      parent_agent_id: PARENT_ID,
      template_id: "legacy",
      name: "reload 前已有故障",
      state: "failed",
      error: Object.freeze({
        code: "internal_error",
        message: "控制器内部错误",
        retryable: false,
      }),
    }),
  ], 10);
  const notifications: Array<{ readonly message: string; readonly type: string }> = [];
  const notifier = new AgentTreeFailureNotifier(baseline, (message, type) => {
    notifications.push({ message, type });
  });
  assert.deepEqual(notifications, []);

  const failedSecondId = "71000000-0000-4000-8000-000000000010";
  const incompleteSecondId = "71000000-0000-4000-8000-000000000011";
  const revision = subtreeSnapshot(baseline.nodes.map((item) => item.agent_id === CHILD_ID
    ? node({
        ...item,
        agent_id: item.agent_id,
        parent_agent_id: item.parent_agent_id,
        state: "failed",
        error: Object.freeze({
          code: "internal_error",
          message: "控制器内部错误",
          retryable: false,
        }),
      })
    : item).concat(
      node({
        agent_id: failedSecondId,
        parent_agent_id: PARENT_ID,
        template_id: "worker",
        name: "第二故障节点",
        state: "failed",
        error: Object.freeze({
          code: "internal_error",
          message: "控制器内部错误",
          retryable: false,
        }),
      }),
      node({
        agent_id: INCOMPLETE_ID,
        parent_agent_id: PARENT_ID,
        template_id: "cleanup",
        name: "清理节点",
        state: "terminating",
        error: Object.freeze({
          code: "termination_incomplete",
          message: "代理资源尚未完全回收",
          retryable: true,
        }),
      }),
      node({
        agent_id: incompleteSecondId,
        parent_agent_id: PARENT_ID,
        template_id: "cleanup",
        name: "第二清理节点",
        state: "terminating",
        error: Object.freeze({
          code: "termination_incomplete",
          message: "代理资源尚未完全回收",
          retryable: true,
        }),
      }),
    ), 11);

  assert.equal(notifier.update(revision), "changed");
  assert.deepEqual(notifications, [
    { message: "代理故障：worker ×2；internal_error ×2", type: "warning" },
    { message: "代理清理不完整：cleanup ×2；termination_incomplete ×2", type: "error" },
  ]);
  assert.equal(notifier.update(revision), "ignored");
  assert.equal(notifier.update(baseline), "ignored");
  assert.doesNotMatch(JSON.stringify(notifications), /secret|private|endpoint|handle|stack|已有正常节点/i);
});

test("伪造故障消息和秘密 canary 在 UI 缓存前被拒绝", () => {
  const baseline = subtreeSnapshot([
    node({ agent_id: PARENT_ID, parent_agent_id: null, template_id: "parent", name: "当前会话" }),
    node({ agent_id: CHILD_ID, parent_agent_id: PARENT_ID, template_id: "worker", name: "正常节点" }),
  ], 10);
  const invalid = subtreeSnapshot(baseline.nodes.map((item) => item.agent_id === CHILD_ID
    ? node({
        ...item,
        agent_id: item.agent_id,
        parent_agent_id: item.parent_agent_id,
        state: "failed",
        error: Object.freeze({
          code: "internal_error",
          message: "D:\\private\\secret-canary.txt",
          retryable: false,
        }),
      })
    : item), 11);
  const notifications: Array<{ readonly message: string; readonly type: string }> = [];
  const notifier = new AgentTreeFailureNotifier(baseline, (message, type) => {
    notifications.push({ message, type });
  });
  const model = new AgentTreePanelModel(baseline);

  assert.equal(notifier.update(invalid), "error");
  assert.deepEqual(notifications, []);
  assert.equal(model.update(invalid), "error");
  assert.deepEqual(model.render(80), ["Agent tree", "代理树暂时不可用", "Esc close"]);
});

test("UI 绑定通过 widget、overlay 和 notify 跟随树修订并完整清理", async () => {
  let current = subtreeSnapshot([
    node({ agent_id: PARENT_ID, parent_agent_id: null, template_id: "parent", name: "当前会话" }),
    node({ agent_id: CHILD_ID, parent_agent_id: PARENT_ID, template_id: "worker", name: "直接子代理" }),
  ], 1);
  const listeners = new Set<() => void>();
  let widgetContent: unknown;
  const widgetCalls: unknown[][] = [];
  let overlayComponent: {
    render(width: number): readonly string[];
    handleInput?(data: string): void;
    dispose?(): void;
  } | undefined;
  let overlayOptions: unknown;
  let renders = 0;
  const notifications: Array<{ readonly message: string; readonly type: string }> = [];
  const tui = { requestRender: () => { renders += 1; } };
  type TestTui = { requestRender(): void };
  type TestComponent = {
    render(width: number): string[];
    handleInput?(data: string): void;
    invalidate(): void;
    dispose?(): void;
  };
  const ui = {
    setWidget(key: string, content: unknown, options?: unknown): void {
      widgetContent = content;
      widgetCalls.push([key, content, options]);
    },
    custom<T>(
      factory: (
        tui: TestTui,
        theme: unknown,
        keybindings: unknown,
        done: (result: T) => void,
      ) => TestComponent | Promise<TestComponent>,
      options?: {
        readonly overlay?: boolean;
        readonly overlayOptions?: unknown;
      },
    ): Promise<T> {
      overlayOptions = options;
      return new Promise<T>((resolve) => {
        overlayComponent = factory(tui, PANEL_THEME, {}, resolve) as typeof overlayComponent;
      });
    },
    notify(message: string, type?: "info" | "warning" | "error"): void {
      notifications.push({ message, type: type ?? "info" });
    },
  };
  const binding = bindAgentTreeUi({
    read: () => ({ ok: true as const, data: current }),
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  }, { hasUI: true, mode: "tui", ui });

  assert.equal(typeof widgetContent, "function");
  const widget = (widgetContent as (widgetTui: TestTui) => {
    render(width: number): readonly string[];
    dispose?(): void;
  })(tui);
  assert.deepEqual(widget.render(80), [
    "Agents",
    "  worker · 直接子代理 · idle · 1m 00s",
  ]);
  const opened = binding.openPanel({ hasUI: true, mode: "tui", ui });
  assert.deepEqual(overlayOptions, {
    overlay: true,
    overlayOptions: { width: 96, anchor: "center", margin: 1 },
  });
  const initialPanel = overlayComponent?.render(80) ?? [];
  assert.match(initialPanel.map((line) => stripVTControlCharacters(line)).join("\n"), /AGENT TREE\s+REV 1/);
  assert.equal(initialPanel.every((line) => displayWidth(stripVTControlCharacters(line)) === 80), true);
  assert.match(initialPanel[0] ?? "", /\x1b\[48;5;236m/);

  current = subtreeSnapshot(current.nodes.map((item) => item.agent_id === CHILD_ID
    ? node({
        ...item,
        agent_id: item.agent_id,
        parent_agent_id: item.parent_agent_id,
        state: "failed",
        error: Object.freeze({
          code: "internal_error",
          message: "控制器内部错误",
          retryable: false,
        }),
      })
    : item), 2);
  for (const listener of listeners) listener();
  assert.equal(renders >= 2, true);
  assert.match(
    (overlayComponent?.render(80) ?? []).map((line) => stripVTControlCharacters(line)).join("\n"),
    /REV 2/,
  );
  assert.deepEqual(notifications, [
    { message: "代理故障：worker ×1；internal_error ×1", type: "warning" },
  ]);
  assert.doesNotMatch(JSON.stringify(notifications), /binding-secret|private/i);

  overlayComponent?.handleInput?.("\x1b");
  await opened;
  binding.dispose();
  assert.equal(listeners.size, 0);
  assert.deepEqual(widgetCalls.at(-1), ["wj-pi-subagents-agents", undefined, { placement: "aboveEditor" }]);
});

test("首次树读取失败时 agent 面板仍显示固定安全错误并可关闭", async () => {
  let overlayComponent: {
    render(width: number): readonly string[];
    handleInput?(data: string): void;
  } | undefined;
  const tui = { requestRender: () => {} };
  const ui = {
    setWidget(): void {},
    custom<T>(
      factory: (
        tuiValue: typeof tui,
        theme: unknown,
        keybindings: unknown,
        done: (result: T) => void,
      ) => {
        render(width: number): string[];
        handleInput?(data: string): void;
        invalidate(): void;
      },
      _options?: {
        readonly overlay?: boolean;
        readonly overlayOptions?: unknown;
      },
    ): Promise<T> {
      return new Promise<T>((resolve) => {
        overlayComponent = factory(tui, PANEL_THEME, {}, resolve);
      });
    },
  };
  const binding = bindAgentTreeUi({
    read: () => ({
      ok: false as const,
      error: Object.freeze({
        code: "internal_error" as const,
        message: "D:\\private\\secret-canary.txt",
        retryable: false,
        details: Object.freeze({}),
      }),
    }),
    onChange: () => () => {},
  }, { hasUI: true, mode: "tui", ui });

  const opened = binding.openPanel();
  const rendered = overlayComponent?.render(80) ?? [];
  const plainRendered = rendered.map((line) => stripVTControlCharacters(line));
  assert.equal(rendered.length, 18);
  assert.equal(plainRendered.every((line) => displayWidth(line) === 80), true);
  assert.match(plainRendered.join("\n"), /AGENT TREE/);
  assert.match(plainRendered.join("\n"), /代理树暂时不可用/);
  assert.doesNotMatch(plainRendered.join("\n"), /private|secret-canary/i);
  overlayComponent?.handleInput?.("\x1b");
  await opened;
  binding.dispose();
});
