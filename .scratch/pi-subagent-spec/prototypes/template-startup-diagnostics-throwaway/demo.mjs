const initialCandidates = [
  {
    source: "user",
    file: "researcher.md",
    templateId: "researcher",
    valid: true,
  },
  {
    source: "project",
    file: "researcher.md",
    templateId: "researcher",
    valid: false,
    reason: "tools 必须是逗号分隔字符串",
  },
  {
    source: "user",
    file: "empty-tools.md",
    templateId: "empty-tools",
    valid: false,
    reason: "tools 缺失；无业务工具应写为 tools: \"\"",
  },
  {
    source: "user",
    file: "broken-link.md",
    templateId: "broken-link",
    valid: false,
    reason: "无法读取模板文件",
  },
  {
    source: "project",
    file: "reviewer.md",
    templateId: "reviewer",
    valid: false,
    reason: "tools 必须是逗号分隔字符串",
  },
  {
    source: "project",
    file: "writer.md",
    templateId: "writer",
    valid: true,
  },
  {
    source: "user",
    file: "writer.md",
    templateId: "writer",
    valid: false,
    reason: "description 必须是字符串",
  },
];

const sourcePriority = { user: 0, project: 1 };
const existingAgents = [
  {
    agentId: "550e8400-e29b-41d4-a716-446655440000",
    templateId: "writer",
    state: "working",
  },
];

function discover(candidates, sourceDiagnostics = []) {
  const selectedByTemplateId = new Map();

  for (const candidate of candidates) {
    const selected = selectedByTemplateId.get(candidate.templateId);

    if (
      !selected ||
      sourcePriority[candidate.source] > sourcePriority[selected.source]
    ) {
      selectedByTemplateId.set(candidate.templateId, candidate);
    }
  }

  const selectedCandidates = [...selectedByTemplateId.values()];
  const invalidCandidates = candidates.filter((candidate) => !candidate.valid);
  const catalog = selectedCandidates
    .filter((candidate) => candidate.valid)
    .map(({ source, file, templateId }) => ({ source, file, templateId }));

  return { invalidCandidates, catalog, sourceDiagnostics };
}

function renderDiscovery(label, candidates, sourceDiagnostics) {
  const discovery = discover(candidates, sourceDiagnostics);
  const diagnostics = [
    ...discovery.invalidCandidates.map(
      ({ source, file, reason }) => `- ${source}:${file}：${reason}`,
    ),
    ...discovery.sourceDiagnostics.map(
      ({ source, reason }) => `- ${source} 模板目录：${reason}`,
    ),
  ];

  console.log(`\n${label}`);

  if (diagnostics.length > 0) {
    console.log(
      `[warning] ${diagnostics.length} 项代理模板发现诊断：\n${diagnostics.join("\n")}`,
    );
  }

  console.log("有效模板目录：");
  console.log(JSON.stringify(discovery.catalog, null, 2));
}

renderDiscovery("根会话首次发现", initialCandidates);

if (process.argv.includes("--reload")) {
  const reloadedCandidates = initialCandidates.map((candidate) => {
    if (candidate.source === "project" && candidate.file === "researcher.md") {
      return { ...candidate, valid: true, reason: undefined };
    }

    return candidate;
  });

  renderDiscovery("根会话 /reload 后", reloadedCandidates);
  console.log("既有节点快照（不回溯更新）：");
  console.log(JSON.stringify(existingAgents, null, 2));
}

if (process.argv.includes("--directory-error")) {
  const projectCandidates = initialCandidates.filter(
    (candidate) => candidate.source === "project",
  );

  renderDiscovery("根会话 /reload 时用户级目录无法扫描", projectCandidates, [
    { source: "user", reason: "无法扫描模板目录" },
  ]);
}
