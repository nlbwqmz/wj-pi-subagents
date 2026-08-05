// THROWAWAY PROTOTYPE：只用于验证代理树可观测性，不是生产实现。

const TERMINAL = new Set(["terminated"]);
const LIVE = new Set([
  "starting",
  "idle",
  "working",
  "interrupting",
  "failed",
  "terminating",
]);

const model = {
  clock: 0,
  treeRevision: 0,
  nodes: new Map(),
  expanded: new Set(),
  notifications: [],
};

const DEMO_IDS = Object.freeze({
  refactor: "550e8400-e29b-41d4-a716-446655440000",
  explore: "550e8400-e29b-41d4-a716-446655440001",
  longTask: "550e8400-e29b-41d4-a716-446655440002",
  grep: "550e8400-e29b-41d4-a716-446655440003",
  tests: "550e8400-e29b-41d4-a716-446655440004",
  read: "550e8400-e29b-41d4-a716-446655440005",
  workerOne: "550e8400-e29b-41d4-a716-446655440006",
  workerTwo: "550e8400-e29b-41d4-a716-446655440007",
  workerThree: "550e8400-e29b-41d4-a716-446655440008",
});

function childrenOf(parentId) {
  return [...model.nodes.values()]
    .filter((node) => node.parentId === parentId)
    .sort((left, right) => left.creationOrder - right.creationOrder);
}

function getNode(agentId) {
  return model.nodes.get(agentId);
}

function spawn({ agentId, parentId, templateId, name }) {
  model.clock += 1;
  model.treeRevision += 1;

  // 原型把这个时刻视为 RPC 握手完成、spawn_agent 成功返回的时刻。
  model.nodes.set(agentId, {
    agentId,
    parentId,
    templateId,
    name,
    creationOrder: model.nodes.size + 1,
    createdAt: model.clock,
    state: "idle",
    activity: "",
    pending: 0,
    error: null,
    stateSince: model.clock,
  });
}

function update(agentId, next) {
  const node = getNode(agentId);
  if (!node) throw new Error(`未知节点 ${agentId}`);

  model.clock += 1;
  model.treeRevision += 1;
  Object.assign(node, next, { stateSince: model.clock });

  if (node.state === "failed" && next.error) {
    model.notifications.push({
      revision: model.treeRevision,
      type: "warning",
      message: `${node.templateId} ${node.name}: ${next.error}`,
    });
  }
}

function elapsed(node) {
  const end = TERMINAL.has(node.state) || node.state === "failed"
    ? node.stateSince
    : model.clock;
  return `${Math.max(0, end - node.createdAt)}s`;
}

function descendantsOf(agentId) {
  const result = [];
  const queue = [...childrenOf(agentId)];

  while (queue.length > 0) {
    const node = queue.shift();
    result.push(node);
    queue.push(...childrenOf(node.agentId));
  }

  return result;
}

function aggregate(nodes) {
  const counts = {
    live: 0,
    working: 0,
    idle: 0,
    failed: 0,
    pending: 0,
    finished: 0,
  };

  for (const node of nodes) {
    if (node.state === "terminated") {
      counts.finished += 1;
      continue;
    }
    if (LIVE.has(node.state)) counts.live += 1;
    if (node.state === "working") counts.working += 1;
    if (node.state === "idle") counts.idle += 1;
    if (node.state === "failed") counts.failed += 1;
    counts.pending += node.pending;
  }

  return counts;
}

function summaryText(counts) {
  return [
    `live ${counts.live}`,
    `working ${counts.working}`,
    `idle ${counts.idle}`,
    `failed ${counts.failed}`,
    `pending ${counts.pending}`,
    `finished ${counts.finished}`,
  ].join(" · ");
}

function stateText(node) {
  const activity = node.activity ? ` · ${node.activity}` : "";
  const pending = node.pending > 0 ? ` · pending ${node.pending}` : "";
  const error = node.error ? ` · ${node.error}` : "";
  return `${node.state}${activity} · ${elapsed(node)}${pending}${error}`;
}

function renderDirectWidget(parentId) {
  const direct = childrenOf(parentId);
  const visible = direct.filter((node) => !TERMINAL.has(node.state));
  const counts = aggregate(direct);
  const lines = [`Agents · ${summaryText(counts)}`];

  for (const node of visible) {
    lines.push(`├─ ${node.templateId}  ${node.name}  ${stateText(node)}`);
  }

  if (visible.length === 0) lines.push("└─ no live direct children");
  return lines.join("\n");
}

function branchCounts(node) {
  return aggregate([node, ...descendantsOf(node.agentId)]);
}

function renderNodeRow(node, depth, branch = "├─") {
  return `${"  ".repeat(depth)}${branch} ${node.templateId}  ${node.name}  ${stateText(node)}`;
}

function renderCollapsedRow(node, depth) {
  const counts = branchCounts(node);
  const descendants = descendantsOf(node.agentId).filter(
    (candidate) => !TERMINAL.has(candidate.state),
  );
  return `${"  ".repeat(depth + 1)}└─ +${descendants.length} descendants · ${summaryText(counts)}`;
}

function collectOverlayRows(scopeRootId) {
  const rows = [];

  function visit(parentId, depth) {
    for (const node of childrenOf(parentId)) {
      if (TERMINAL.has(node.state)) continue;
      rows.push({ kind: "node", node, depth });

      const descendants = descendantsOf(node.agentId).filter(
        (candidate) => !TERMINAL.has(candidate.state),
      );
      if (descendants.length === 0) continue;

      if (!model.expanded.has(node.agentId)) {
        rows.push({ kind: "collapsed", node, depth });
        continue;
      }

      visit(node.agentId, depth + 1);
    }
  }

  visit(scopeRootId, 0);
  return rows;
}

function renderOverlay(scopeRootId, { height = 8, scroll = 0 } = {}) {
  const rows = collectOverlayRows(scopeRootId);
  const counts = aggregate(
    [...model.nodes.values()].filter((node) => node.parentId === scopeRootId || descendantsOf(scopeRootId).includes(node)),
  );
  const visible = rows.slice(scroll, scroll + height);
  const lines = [
    `Agents tree · revision ${model.treeRevision} · ${summaryText(counts)}`,
    ...visible.map((row) =>
      row.kind === "node"
        ? renderNodeRow(row.node, row.depth)
        : renderCollapsedRow(row.node, row.depth),
    ),
    `viewport ${Math.min(scroll + 1, Math.max(1, rows.length))}-${Math.min(scroll + visible.length, rows.length)} / ${rows.length}`,
  ];

  return lines.join("\n");
}

function print(label, content) {
  console.log(`\n=== ${label} ===`);
  console.log(content);
  console.log(`treeRevision=${model.treeRevision}, clock=${model.clock}`);
  if (model.notifications.length > 0) {
    console.log(`notifications=${JSON.stringify(model.notifications)}`);
  }
}

// 构造一棵超过常驻 widget 视野、但仍由遮罩面板完整查看的代理树。
spawn({ agentId: DEMO_IDS.refactor, parentId: "root", templateId: "refactor", name: "Refactor auth module" });
spawn({ agentId: DEMO_IDS.explore, parentId: "root", templateId: "explore", name: "Find auth files" });
spawn({ agentId: DEMO_IDS.longTask, parentId: "root", templateId: "long-task", name: "Long-running task" });
spawn({ agentId: DEMO_IDS.grep, parentId: DEMO_IDS.refactor, templateId: "grep", name: "Search imports" });
spawn({ agentId: DEMO_IDS.tests, parentId: DEMO_IDS.refactor, templateId: "test", name: "Run auth tests" });
spawn({ agentId: DEMO_IDS.read, parentId: DEMO_IDS.grep, templateId: "read", name: "Read package files" });
spawn({ agentId: DEMO_IDS.workerOne, parentId: DEMO_IDS.longTask, templateId: "worker", name: "Process batch" });
spawn({ agentId: DEMO_IDS.workerTwo, parentId: DEMO_IDS.longTask, templateId: "worker", name: "Process second batch" });
spawn({ agentId: DEMO_IDS.workerThree, parentId: DEMO_IDS.longTask, templateId: "worker", name: "Process third batch" });

update(DEMO_IDS.refactor, { state: "working", activity: "editing 2 files" });
update(DEMO_IDS.explore, { state: "idle" });
update(DEMO_IDS.longTask, { state: "working", activity: "reading" });
update(DEMO_IDS.grep, { state: "working", activity: "searching" });
update(DEMO_IDS.tests, { state: "working", activity: "running tests", pending: 1 });
update(DEMO_IDS.read, { state: "working", activity: "reading" });
update(DEMO_IDS.workerOne, { state: "working", activity: "processing" });
update(DEMO_IDS.workerTwo, { state: "failed", error: "rpc_unavailable" });
update(DEMO_IDS.workerThree, { state: "working", activity: "processing", pending: 2 });

print("常驻 widget（root 直接子代理）", renderDirectWidget("root"));

model.expanded.add(DEMO_IDS.refactor);
model.expanded.add(DEMO_IDS.longTask);
print("/agent 遮罩面板（默认展开直接子代理，viewport=5）", renderOverlay("root", { height: 5 }));

model.expanded.add(DEMO_IDS.grep);
print("展开 a1 后滚动面板", renderOverlay("root", { height: 5, scroll: 2 }));

update(DEMO_IDS.longTask, { state: "terminating", activity: "" });
update(DEMO_IDS.workerOne, { state: "terminating", activity: "" });
update(DEMO_IDS.workerTwo, { state: "terminating", activity: "", error: null });
update(DEMO_IDS.workerThree, { state: "terminating", activity: "" });
print("级联终止中的面板", renderOverlay("root", { height: 8 }));

update(DEMO_IDS.workerOne, { state: "terminated", activity: "" });
update(DEMO_IDS.workerTwo, { state: "terminated", activity: "" });
update(DEMO_IDS.workerThree, { state: "terminated", activity: "" });
update(DEMO_IDS.longTask, { state: "terminated", activity: "" });
print("终止记录移入 finished 汇总", renderDirectWidget("root"));
