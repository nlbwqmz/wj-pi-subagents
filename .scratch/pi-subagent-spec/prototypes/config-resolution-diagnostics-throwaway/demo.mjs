const DEFAULT_MAX_DEPTH = 2;
const MAX_MAX_DEPTH = 8;

const scenarios = [
  {
    name: "项目值超范围遮蔽用户有效值",
    rootArgument: undefined,
    project: { maxDepth: 99 },
    user: { maxDepth: 4 },
  },
  {
    name: "项目 JSON 解析失败遮蔽用户有效值",
    rootArgument: undefined,
    project: { parseError: true },
    user: { maxDepth: 4 },
  },
  {
    name: "用户值非法时采用默认值",
    rootArgument: undefined,
    project: undefined,
    user: { maxDepth: "two" },
  },
  {
    name: "未知字段只警告并忽略",
    rootArgument: undefined,
    project: { maxDepth: 3, experimentalLimit: 10 },
    user: { maxDepth: 4 },
  },
  {
    name: "非法显式根参数拒绝启动",
    rootArgument: 9,
    project: { maxDepth: 3 },
    user: { maxDepth: 4 },
  },
];

function validateMaxDepth(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_MAX_DEPTH;
}

function evaluateLayer(source, config) {
  if (!config) {
    return { kind: "absent" };
  }

  if (config.readError) {
    return { kind: "invalid", reason: "配置文件不可读" };
  }

  if (config.parseError) {
    return { kind: "invalid", reason: "JSON 无法解析" };
  }

  const warnings = Object.keys(config)
    .filter((key) => key !== "maxDepth")
    .map((key) => `${source} 配置中的未知字段 ${key} 已忽略`);

  if (!Object.hasOwn(config, "maxDepth")) {
    return { kind: "absent", warnings };
  }

  if (!validateMaxDepth(config.maxDepth)) {
    return {
      kind: "invalid",
      reason: `maxDepth 必须是 1..${MAX_MAX_DEPTH} 的整数`,
      warnings,
    };
  }

  return { kind: "valid", value: config.maxDepth, warnings };
}

function resolveMaxDepth(scenario) {
  if (scenario.rootArgument !== undefined) {
    if (!validateMaxDepth(scenario.rootArgument)) {
      return {
        starts: false,
        startupError: `根启动参数 maxDepth 必须是 1..${MAX_MAX_DEPTH} 的整数`,
        uiWarnings: [],
        modelContextEntries: [],
      };
    }

    return {
      starts: true,
      effectiveMaxDepth: scenario.rootArgument,
      source: "root_argument",
      uiWarnings: [],
      modelContextEntries: [],
    };
  }

  const uiWarnings = [];

  for (const [source, config] of [
    ["project", scenario.project],
    ["user", scenario.user],
  ]) {
    const result = evaluateLayer(source, config);
    uiWarnings.push(...(result.warnings ?? []));

    if (result.kind === "valid") {
      return {
        starts: true,
        effectiveMaxDepth: result.value,
        source,
        uiWarnings,
        modelContextEntries: [],
      };
    }

    if (result.kind === "invalid") {
      uiWarnings.push(`${source} 配置${result.reason}；使用默认值 ${DEFAULT_MAX_DEPTH}`);
      return {
        starts: true,
        effectiveMaxDepth: DEFAULT_MAX_DEPTH,
        source: "builtin_default_after_invalid_layer",
        uiWarnings,
        modelContextEntries: [],
      };
    }
  }

  return {
    starts: true,
    effectiveMaxDepth: DEFAULT_MAX_DEPTH,
    source: "builtin_default",
    uiWarnings,
    modelContextEntries: [],
  };
}

for (const scenario of scenarios) {
  console.log(`\n${scenario.name}`);
  console.log(JSON.stringify(resolveMaxDepth(scenario), null, 2));
}
