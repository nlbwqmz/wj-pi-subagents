import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  captureRootRuntimeContext,
  createChildRuntimeContext,
  formatRuntimeConfigDiagnostics,
  notifyRuntimeConfigDiagnostics,
  resolveRuntimeConfig,
  InvalidRootRuntimeConfigError,
  RootRuntimeContextStore,
  RUNTIME_EPHEMERAL_ENV_KEYS,
  RUNTIME_INTERNAL_ENV_KEYS,
  type RuntimeConfigFileReader,
  type RootRuntimeContext,
} from "../src/root-runtime-context.ts";

type ConfigFileContent = string | Uint8Array | Error;

function missingConfigFile(): Error {
  const error = new Error("缺少配置文件");
  Object.assign(error, { code: "ENOENT" });
  return error;
}

function configFilePaths(cwd: string): { project: string; user: string } {
  return {
    project: join(resolve(cwd), ".pi", "wj-pi-subagents.json"),
    user: join(homedir(), ".pi", "agent", "wj-pi-subagents.json"),
  };
}

function configReader(
  files: ReadonlyMap<string, ConfigFileContent>,
  observedPaths?: string[],
): RuntimeConfigFileReader {
  return {
    readFile(path): Uint8Array {
      observedPaths?.push(path);
      const value = files.get(path);
      if (value === undefined) throw missingConfigFile();
      if (value instanceof Error) throw value;
      return typeof value === "string" ? Buffer.from(value, "utf8") : value;
    },
  };
}

test("运行时环境变量统一使用 WJ_PI_SUBAGENTS_ 前缀", () => {
  const keys = [
    ...Object.values(RUNTIME_INTERNAL_ENV_KEYS),
    ...Object.values(RUNTIME_EPHEMERAL_ENV_KEYS),
  ];

  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.every((key) => key.startsWith("WJ_PI_SUBAGENTS_")));
});

test("根上下文只捕获一次 cwd、信任和环境，并让子代理沿用快照", () => {
  const root = captureRootRuntimeContext({
    cwd: "C:\\workspace\\project",
    projectTrust: true,
    environment: {
      PI_SECRET_CANARY: "top-secret",
      STABLE_VALUE: "root",
    },
  });

  const requestedChildIdentity = {
    parentAgentId: "root",
    agentId: "child",
    depth: 1,
    cwd: "C:\\other-project",
    projectTrust: false,
    environment: {
      STABLE_VALUE: "overridden",
      EXPANDED_VALUE: "should-not-appear",
    },
  };
  const child = createChildRuntimeContext(root, requestedChildIdentity);

  assert.equal(root.cwd, "C:\\workspace\\project");
  assert.equal(child.cwd, root.cwd);
  assert.equal(child.projectTrust, true);
  assert.equal(child.environment.PI_SECRET_CANARY, "top-secret");
  assert.equal(child.environment.STABLE_VALUE, "root");
  assert.equal(child.environment.EXPANDED_VALUE, undefined);

  assert.equal(root.environment.STABLE_VALUE, "root");
  assert.equal(root.environment.EXPANDED_VALUE, undefined);
});

test("子代理只追加受控内部元数据，不把模板环境覆盖带入启动环境", () => {
  const controllerMetadata = { rootId: "fixed-root", protocolVersion: "1" };
  const root = captureRootRuntimeContext({
    cwd: ".",
    projectTrust: false,
    environment: {
      EXISTING: "value",
      WJ_PI_SUBAGENTS_AGENT_ID: "forged-agent",
      WJ_PI_SUBAGENTS_PROTOCOL_VERSION: "forged-version",
    },
    controllerMetadata,
  });
  controllerMetadata.rootId = "mutated-root";
  controllerMetadata.protocolVersion = "mutated-version";

  const requestedChildIdentity = {
    agentId: "child-id",
    parentAgentId: "parent-id",
    depth: 1,
    rootId: "attempted-override",
    protocolVersion: "attempted-override",
    environment: {
      EXISTING: "bad",
      LEAKED: "bad",
    },
  };
  const child = createChildRuntimeContext(root, requestedChildIdentity);

  assert.equal(child.environment.EXISTING, "value");
  assert.equal(child.environment.LEAKED, undefined);
  assert.equal(child.metadata.agentId, "child-id");
  assert.equal(child.metadata.parentAgentId, "parent-id");
  assert.equal(child.metadata.depth, 1);
  assert.equal(child.metadata.maxDepth, 2);
  assert.equal(child.metadata.rootId, "fixed-root");
  assert.equal(child.metadata.protocolVersion, "1");
  assert.equal(child.environment.WJ_PI_SUBAGENTS_AGENT_ID, "child-id");
  assert.equal(child.environment.WJ_PI_SUBAGENTS_PROTOCOL_VERSION, "1");
  assert.notEqual(child.environment, root.environment);
  assert.doesNotMatch(JSON.stringify(child), /top-secret|PI_SECRET_CANARY/);
});

test("多层后代始终从根环境派生，不继承中间父代理的内部环境", () => {
  const root = captureRootRuntimeContext({
    environment: { ROOT_VALUE: "stable" },
    controllerMetadata: { rootId: "root-id", protocolVersion: "1" },
  });
  const child = createChildRuntimeContext(root, {
    agentId: "child",
    parentAgentId: "root",
    depth: 1,
  });
  const grandchild = createChildRuntimeContext(child, {
    agentId: "grandchild",
    parentAgentId: "child",
    depth: 2,
  });

  assert.equal(grandchild.environment.ROOT_VALUE, "stable");
  assert.equal(grandchild.environment.WJ_PI_SUBAGENTS_AGENT_ID, "grandchild");
  assert.equal(grandchild.environment.WJ_PI_SUBAGENTS_PARENT_AGENT_ID, "child");
  assert.equal(grandchild.environment.WJ_PI_SUBAGENTS_ROOT_ID, "root-id");
  assert.equal(grandchild.environment.WJ_PI_SUBAGENTS_MAX_DEPTH, "2");
  assert.equal(grandchild.environment.WJ_PI_SUBAGENTS_PROTOCOL_VERSION, "1");
});

test("固定 cwd 只作为相对路径基点，不形成 cwd 沙箱", () => {
  const root = captureRootRuntimeContext({ cwd: "C:\\workspace\\project" });

  assert.equal(root.resolvePath("notes\\todo.md"), "C:\\workspace\\project\\notes\\todo.md");
  assert.equal(root.resolvePath("..\\outside.txt"), "C:\\workspace\\outside.txt");
  assert.equal(root.resolvePath("D:\\outside.txt"), "D:\\outside.txt");
});

test("根上下文的 JSON 表示不泄露环境秘密", () => {
  const root: RootRuntimeContext = captureRootRuntimeContext({
    environment: { API_KEY: "secret-value" },
  });

  assert.doesNotMatch(JSON.stringify(root), /secret-value/);
  assert.doesNotMatch(JSON.stringify(root), /API_KEY/);
});

test("根参数、可信项目、用户配置按字段优先级解析并冻结结果", () => {
  const cwd = "C:\\workspace\\priority";
  const paths = configFilePaths(cwd);
  const result = resolveRuntimeConfig({
    cwd,
    rootArguments: { maxDepth: 3 },
    projectTrust: true,
  }, configReader(new Map([
    [paths.project, JSON.stringify({ maxDepth: 5, maxChildrenPerAgent: 7 })],
    [paths.user, JSON.stringify({
      maxDepth: 6,
      maxChildrenPerAgent: 8,
      maxAgentsPerTree: 20,
      waitTimeoutMs: 120_000,
    })],
  ])));

  assert.deepEqual(result.config, {
    maxDepth: 3,
    maxChildrenPerAgent: 7,
    maxAgentsPerTree: 20,
    waitTimeoutMs: 120_000,
  });
  assert.deepEqual(result.sources, {
    maxDepth: "root_argument",
    maxChildrenPerAgent: "project",
    maxAgentsPerTree: "user",
    waitTimeoutMs: "user",
  });
  assert.deepEqual(result.diagnostics, []);
  assert.throws(() => Object.assign(result.config, { maxDepth: 8 }), TypeError);
});

test("所有字段都有显式根参数时不读取低优先级配置", () => {
  let reads = 0;
  const result = resolveRuntimeConfig({
    rootArguments: {
      maxDepth: 3,
      maxChildrenPerAgent: 5,
      maxAgentsPerTree: 20,
      waitTimeoutMs: 20_000,
    },
    projectTrust: true,
  }, {
    readFile: () => {
      reads += 1;
      return Buffer.from("{broken}", "utf8");
    },
  });

  assert.equal(reads, 0);
  assert.deepEqual(result.diagnostics, []);
});

test("未信任项目不读取项目配置，并使用用户层", () => {
  let projectReads = 0;
  const cwd = "D:\\private\\project";
  const paths = configFilePaths(cwd);
  const result = resolveRuntimeConfig({
    cwd,
    projectTrust: false,
  }, {
    readFile: (path) => {
      if (path === paths.project) projectReads += 1;
      if (path === paths.user) return Buffer.from(JSON.stringify({ maxDepth: 4 }), "utf8");
      return Buffer.from(JSON.stringify({ maxDepth: 9 }), "utf8");
    },
  });

  assert.equal(projectReads, 0);
  assert.equal(result.config.maxDepth, 4);
  assert.equal(result.sources.maxDepth, "user");
});

test("项目层字段非法时直接采用默认值，不回退用户层", () => {
  const cwd = "C:\\workspace\\invalid-field";
  const paths = configFilePaths(cwd);
  const result = resolveRuntimeConfig({
    cwd,
    projectTrust: true,
  }, configReader(new Map([
    [paths.project, JSON.stringify({ maxDepth: 99, maxChildrenPerAgent: 6 })],
    [paths.user, JSON.stringify({ maxDepth: 5, maxChildrenPerAgent: 8, maxAgentsPerTree: 24 })],
  ])));

  assert.equal(result.config.maxDepth, 2);
  assert.equal(result.sources.maxDepth, "builtin_default_after_invalid_layer");
  assert.equal(result.config.maxChildrenPerAgent, 6);
  assert.equal(result.config.maxAgentsPerTree, 24);
  assert.equal(result.diagnostics.some((item) => item.field === "maxDepth" && item.reason === "invalid_value"), true);
});

test("配置文件不可读时受影响字段采用默认值且不暴露底层异常", () => {
  const cwd = "D:\\private\\project";
  const paths = configFilePaths(cwd);
  const result = resolveRuntimeConfig({
    cwd,
    projectTrust: true,
  }, {
    readFile: (path) => {
      if (path === paths.project) {
        const error = new Error("D:\\secret\\config-token");
        Object.assign(error, { code: "EACCES" });
        throw error;
      }
      return Buffer.from(JSON.stringify({ maxDepth: 7 }), "utf8");
    },
  });

  assert.equal(result.config.maxDepth, 2);
  assert.equal(result.config.maxAgentsPerTree, 16);
  assert.equal(result.diagnostics.length, 4);
  const serialized = JSON.stringify(result.diagnostics);
  assert.doesNotMatch(serialized, /private|secret|config-token|EACCES/);
});

test("坏 JSON、不可读文件和未知字段只产生脱敏 UI 诊断", () => {
  const paths: string[] = [];
  const cwd = "C:\\secret\\project";
  const configPaths = configFilePaths(cwd);
  const result = resolveRuntimeConfig({
    cwd,
    projectTrust: true,
  }, {
    readFile: (path) => {
      paths.push(path);
      if (path === configPaths.project) return Buffer.from("{broken-json", "utf8");
      return Buffer.from(JSON.stringify({ maxAgentsPerTree: 30, ignored: "SECRET-123" }), "utf8");
    },
  });

  assert.deepEqual(result.config, {
    maxDepth: 2,
    maxChildrenPerAgent: 4,
    maxAgentsPerTree: 16,
    waitTimeoutMs: 60_000,
  });
  assert.equal(result.diagnostics.length, 4);
  const text = formatRuntimeConfigDiagnostics(result.diagnostics);
  assert.doesNotMatch(text, /secret|SECRET-123|broken-json|C:\\secret/);
  assert.equal(paths.length, 1);
  assert.equal(paths[0], configPaths.project);

  const unknownPaths = configFilePaths("C:\\workspace\\unknown");
  const unknown = resolveRuntimeConfig({
    cwd: "C:\\workspace\\unknown",
    projectTrust: true,
  }, configReader(new Map([
    [unknownPaths.project, JSON.stringify({ maxDepth: 3, ignored: "SECRET-123" })],
    [unknownPaths.user, JSON.stringify({})],
  ])));
  assert.equal(unknown.config.maxDepth, 3);
  assert.equal(unknown.diagnostics.length, 1);
  assert.equal(unknown.diagnostics[0]?.adoptedValue, "ignored");
  assert.match(formatRuntimeConfigDiagnostics(unknown.diagnostics), /ignored/);
  assert.match(formatRuntimeConfigDiagnostics(unknown.diagnostics), /采用值 忽略/);
  assert.doesNotMatch(formatRuntimeConfigDiagnostics(unknown.diagnostics), /SECRET-123/);

  const invalidShapePaths = configFilePaths("C:\\workspace\\invalid-shape");
  const invalidShape = resolveRuntimeConfig({
    cwd: "C:\\workspace\\invalid-shape",
    projectTrust: true,
  }, configReader(new Map([
    [invalidShapePaths.project, JSON.stringify([])],
    [invalidShapePaths.user, JSON.stringify({ maxDepth: 8 })],
  ])));
  assert.equal(invalidShape.config.maxDepth, 2);
  assert.equal(invalidShape.diagnostics.every((item) => item.reason === "invalid_shape"), true);

  const notifications: Array<{ message: string; type: string }> = [];
  assert.equal(
    notifyRuntimeConfigDiagnostics(result.diagnostics, {
      hasUI: true,
      ui: { notify: (message: string, type: string) => notifications.push({ message, type }) },
    }),
    true,
  );
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.type, "warning");
  assert.equal(notifications[0]?.message, text);
  assert.equal(notifyRuntimeConfigDiagnostics(result.diagnostics, { hasUI: false }), false);
});

test("显式根参数类型、整数性和边界错误拒绝启动", () => {
  for (const [field, value] of [
    ["maxDepth", 0],
    ["maxChildrenPerAgent", 1.5],
    ["maxAgentsPerTree", "16"],
    ["waitTimeoutMs", 600_001],
  ] as const) {
    assert.throws(
      () => resolveRuntimeConfig({ rootArguments: { [field]: value } }),
      (error: unknown) => error instanceof InvalidRootRuntimeConfigError
        && error.code === "invalid_root_runtime_config"
        && error.field === field,
    );
  }

  assert.throws(
    () => captureRootRuntimeContext({ rootArguments: { maxDepth: "SECRET-CANARY" } }),
    (error: unknown) => error instanceof InvalidRootRuntimeConfigError
      && !String(error).includes("SECRET-CANARY"),
  );

  assert.throws(
    () => resolveRuntimeConfig({ rootArguments: undefined }),
    (error: unknown) => error instanceof InvalidRootRuntimeConfigError
      && error.field === "config",
  );
});

test("四个配额字段接受规范规定的边界值", () => {
  const result = resolveRuntimeConfig({
    rootArguments: {
      maxDepth: 1,
      maxChildrenPerAgent: 16,
      maxAgentsPerTree: 64,
      waitTimeoutMs: 600_000,
    },
  });
  assert.deepEqual(result.config, {
    maxDepth: 1,
    maxChildrenPerAgent: 16,
    maxAgentsPerTree: 64,
    waitTimeoutMs: 600_000,
  });
});

test("配置文件只从固定项目和用户位置读取 UTF-8 JSON", () => {
  const cwd = "C:\\workspace\\fixed-config";
  const paths = configFilePaths(cwd);
  const observedPaths: string[] = [];
  const options = {
    cwd,
    projectTrust: true,
    projectConfigPath: "D:\\attempted-override\\project.json",
    userConfigPath: "D:\\attempted-override\\user.json",
    homeDir: "D:\\attempted-override",
  };
  const result = resolveRuntimeConfig(options, configReader(new Map([
    [paths.project, `\ufeff${JSON.stringify({ maxDepth: 4, maxChildrenPerAgent: 9 })}`],
    [paths.user, JSON.stringify({ maxDepth: 5, maxAgentsPerTree: 32, waitTimeoutMs: 90_000 })],
  ]), observedPaths));

  assert.deepEqual(result.config, {
    maxDepth: 4,
    maxChildrenPerAgent: 9,
    maxAgentsPerTree: 32,
    waitTimeoutMs: 90_000,
  });
  assert.deepEqual(observedPaths, [paths.project, paths.user]);
});

test("无效 UTF-8 配置不会被替换字符悄悄接受", () => {
  const cwd = "C:\\workspace\\invalid-utf8";
  const paths = configFilePaths(cwd);
  const result = resolveRuntimeConfig({ cwd, projectTrust: true }, configReader(new Map<string, ConfigFileContent>([
    [paths.project, Buffer.from([0x7b, 0xff, 0x7d])],
    [paths.user, JSON.stringify({ maxDepth: 8 })],
  ])));
  assert.equal(result.config.maxDepth, 2);
  assert.equal(result.sources.maxDepth, "builtin_default_after_invalid_layer");
  assert.equal(result.diagnostics.every((item) => item.reason === "invalid_json"), true);
});

test("根上下文存储只捕获一次，配置诊断在根 UI 最多通知一次", () => {
  const store = new RootRuntimeContextStore();
  const paths = configFilePaths(".");
  const first = store.capture({
    cwd: ".",
    environment: { STABLE: "first" },
  }, configReader(new Map([[paths.user, JSON.stringify({ maxDepth: 0 })]])));
  const second = store.capture({
    cwd: "..",
    environment: { STABLE: "second" },
  });
  const notifications: string[] = [];
  const ui = {
    hasUI: true,
    ui: { notify: (message: string) => notifications.push(message) },
  };

  assert.equal(second, first);
  assert.equal(second.environment.STABLE, "first");
  assert.equal(second.config.maxDepth, 2);
  assert.equal(first.notifyDiagnostics(ui), true);
  assert.equal(first.notifyDiagnostics(ui), false);
  assert.equal(notifications.length, 1);
  assert.equal(Object.isFrozen(first), true);
});

test("根捕获不会在配置解析阶段再次读取 cwd 或 trust", () => {
  let cwdReads = 0;
  let trustReads = 0;
  const options = {
    get cwd(): string {
      cwdReads += 1;
      return "C:\\workspace\\fixed";
    },
    get projectTrust(): boolean {
      trustReads += 1;
      return true;
    },
  };

  const root = captureRootRuntimeContext(options, configReader(new Map()));
  assert.equal(root.cwd, "C:\\workspace\\fixed");
  assert.equal(root.projectTrust, true);
  assert.equal(cwdReads, 1);
  assert.equal(trustReads, 1);
});

test("根捕获可选地发送一次 UI-only 配置诊断，不触碰消息接口", () => {
  const sideEffects: string[] = [];
  const notifications: string[] = [];
  const uiContext = {
    hasUI: true,
    ui: {
      notify: (message: string) => notifications.push(message),
    },
    sendMessage: () => sideEffects.push("message"),
    sendUserMessage: () => sideEffects.push("user-message"),
  };
  const cwd = "C:\\workspace\\ui-diagnostics";
  const paths = configFilePaths(cwd);
  const root = captureRootRuntimeContext({
    cwd,
    uiContext,
  }, configReader(new Map([[paths.user, JSON.stringify({ unknownSecretField: "do-not-show" })]])));

  assert.equal(notifications.length, 1);
  assert.match(notifications[0] ?? "", /unknownSecretField/);
  assert.doesNotMatch(notifications[0] ?? "", /do-not-show/);
  assert.equal(
    root.notifyDiagnostics({
      hasUI: true,
      ui: { notify: (_message: string, _type: string): void => { sideEffects.push("again"); } },
    }),
    false,
  );
  assert.deepEqual(sideEffects, []);
});

test("UI 通知抛错时也不重复尝试或泄露配置异常", () => {
  const attempts: string[] = [];
  const cwd = "C:\\workspace\\ui-error";
  const paths = configFilePaths(cwd);
  const root = captureRootRuntimeContext({
    cwd,
  }, configReader(new Map([[paths.user, JSON.stringify({ maxDepth: 0 })]])));
  const first = root.notifyDiagnostics({
    hasUI: true,
    ui: {
      notify: () => {
        attempts.push("first");
        throw new Error("D:\\secret\\ui-path");
      },
    },
  });
  const second = root.notifyDiagnostics({
    hasUI: true,
    ui: { notify: () => attempts.push("second") },
  });

  assert.equal(first, false);
  assert.equal(second, false);
  assert.deepEqual(attempts, ["first"]);
});
