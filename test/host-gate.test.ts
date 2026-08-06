import assert from "node:assert/strict";
import test from "node:test";
import {
  HOST_CAPABILITY_DIAGNOSTIC_CODE,
  MIN_NODE_VERSION,
  MIN_PI_VERSION,
  SUPPORTED_PLATFORMS,
  checkHostCapabilities,
  createPiSubagentExtension,
  type ExtensionApiSurface,
  type HostProbeOverrides,
  type SupportedPlatform,
} from "../src/host-gate.ts";
import type { ProcessTreeAdapter } from "../src/process-tree-capability.ts";

const readyApi = (): ExtensionApiSurface => ({
  on: () => {},
  registerTool: () => {},
  registerCommand: () => {},
  getActiveTools: () => [],
  getAllTools: () => [],
  setActiveTools: () => {},
  exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  events: { emit: () => {}, on: () => () => {} },
});

class ReadyRpcClient {
  start() {}
  stop() {}
  onEvent() {}
  getStderr() {}
  prompt() {}
  steer() {}
  abort() {}
  getState() {}
  waitForIdle() {}
}

const readyOverrides = (overrides: HostProbeOverrides = {}): HostProbeOverrides => ({
  nodeVersion: MIN_NODE_VERSION,
  platform: "linux",
  loadPiModule: async () => ({ VERSION: MIN_PI_VERSION, RpcClient: ReadyRpcClient }),
  loadProcessTreeAdapter: async (platform) => {
    if (!(SUPPORTED_PLATFORMS as readonly string[]).includes(platform)) return undefined;
    return readyProcessTreeAdapter(platform as SupportedPlatform);
  },
  loadRuntimeDependency: async () => import("semver"),
  ...overrides,
});

const readyProcessTreeAdapter = (platform: SupportedPlatform): ProcessTreeAdapter => ({
  platform,
  strategy: platform === "win32" ? "job_object" : "process_group_or_session",
  attach: async () => ({}),
  requestGracefulClose: async () => {},
  forceTerminate: async () => {},
  waitForExit: async () => ({ state: "exited" }),
  inspect: async () => ({ state: "released" }),
  release: async () => {},
});

test("支持的宿主通过全部探针并可以空操作激活", async () => {
  const result = await checkHostCapabilities({
    extensionApi: readyApi(),
    ...readyOverrides(),
  });

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.nodeVersion, MIN_NODE_VERSION);
});

test("注入完整进程树适配器契约后覆盖 Windows、macOS 和 Linux", async () => {
  const strategies = new Map<string, string>();
  for (const platform of ["win32", "darwin", "linux"] as const) {
    const result = await checkHostCapabilities({
      extensionApi: readyApi(),
      ...readyOverrides({ platform }),
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      strategies.set(platform, result.processTreeAdapter.strategy);
    }
  }

  assert.deepEqual([...strategies.entries()], [
    ["win32", "job_object"],
    ["darwin", "process_group_or_session"],
    ["linux", "process_group_or_session"],
  ]);
});

test("进程树适配器缺少任一树职责时拒绝激活", async () => {
  const incompleteAdapter = { ...readyProcessTreeAdapter("linux") } as Record<string, unknown>;
  delete incompleteAdapter.forceTerminate;
  const result = await checkHostCapabilities({
    extensionApi: readyApi(),
    ...readyOverrides({ loadProcessTreeAdapter: async () => incompleteAdapter }),
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.diagnostic.reason, "process_tree_adapter_unavailable");
});

test("进程树适配器平台策略不匹配时拒绝激活", async () => {
  const result = await checkHostCapabilities({
    extensionApi: readyApi(),
    ...readyOverrides({
      platform: "win32",
      loadProcessTreeAdapter: async () => readyProcessTreeAdapter("linux"),
    }),
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.diagnostic.reason, "process_tree_adapter_unavailable");
});

test("Node 低于最低版本时拒绝激活", async () => {
  const result = await checkHostCapabilities({
    extensionApi: readyApi(),
    ...readyOverrides({ nodeVersion: "22.18.9" }),
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.diagnostic.reason, "node_version_unsupported");
});

test("不可解析的 Node 版本时拒绝激活", async () => {
  const result = await checkHostCapabilities({
    extensionApi: readyApi(),
    ...readyOverrides({ nodeVersion: "node-version" }),
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.diagnostic.reason, "node_version_unparseable");
});

test("Pi 低于最低版本时拒绝激活", async () => {
  const result = await checkHostCapabilities({
    extensionApi: readyApi(),
    ...readyOverrides({
      loadPiModule: async () => ({ VERSION: "0.82.9", RpcClient: class RpcClient {} }),
    }),
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.diagnostic.reason, "pi_version_unsupported");
});

test("Pi 版本不可解析时拒绝激活", async () => {
  const result = await checkHostCapabilities({
    extensionApi: readyApi(),
    ...readyOverrides({
      loadPiModule: async () => ({ VERSION: "unknown", RpcClient: class RpcClient {} }),
    }),
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.diagnostic.reason, "pi_version_unparseable");
});

test("缺失必需宿主 API 时拒绝激活", async () => {
  const api = readyApi();
  delete api.registerCommand;
  const result = await checkHostCapabilities({
    extensionApi: api,
    ...readyOverrides(),
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.diagnostic.reason, "host_api_unavailable");
    assert.deepEqual(result.diagnostic.missingApi, ["registerCommand"]);
  }
});

test("RpcClient 缺失监督方法时拒绝激活", async () => {
  class IncompleteRpcClient {
    start() {}
  }
  const result = await checkHostCapabilities({
    extensionApi: readyApi(),
    ...readyOverrides({
      loadPiModule: async () => ({ VERSION: MIN_PI_VERSION, RpcClient: IncompleteRpcClient }),
    }),
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.diagnostic.reason, "host_api_unavailable");
    assert.ok(result.diagnostic.missingApi?.includes("RpcClient.prompt"));
  }
});

test("缺失 EventBus 方法时拒绝激活", async () => {
  const api = readyApi();
  api.events = { emit: () => {} };
  const result = await checkHostCapabilities({
    extensionApi: api,
    ...readyOverrides(),
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.diagnostic.reason, "host_api_unavailable");
    assert.deepEqual(result.diagnostic.missingApi, ["events.on"]);
  }
});

test("不支持的平台在加载适配器前拒绝激活", async () => {
  let adapterProbed = false;
  const result = await checkHostCapabilities({
    extensionApi: readyApi(),
    ...readyOverrides({
      platform: "freebsd",
      loadProcessTreeAdapter: async () => {
        adapterProbed = true;
        return {};
      },
    }),
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.diagnostic.reason, "platform_unsupported");
  assert.equal(adapterProbed, false);
});

test("受支持平台缺失进程树适配器时拒绝激活", async () => {
  const result = await checkHostCapabilities({
    extensionApi: readyApi(),
    ...readyOverrides({ loadProcessTreeAdapter: async () => undefined }),
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.diagnostic.reason, "process_tree_adapter_unavailable");
  }
});

test("Unix 标准入口按宿主能力加载 process group/session 适配器", async () => {
  const platform = process.platform === "darwin" || process.platform === "linux"
    ? process.platform
    : "linux";
  const probe = readyOverrides({ platform });
  delete probe.loadProcessTreeAdapter;
  const result = await checkHostCapabilities({
    extensionApi: readyApi(),
    ...probe,
  });

  const available = process.platform === "darwin" || process.platform === "linux";
  assert.equal(result.ok, available);
  if (result.ok) {
    assert.equal(result.processTreeAdapter.platform, platform);
    assert.equal(result.processTreeAdapter.strategy, "process_group_or_session");
  } else {
    assert.equal(result.diagnostic.reason, "process_tree_adapter_unavailable");
  }
});

test("Windows 标准入口加载 Job Object 适配器", async () => {
  const probe = readyOverrides({ platform: "win32" });
  delete probe.loadProcessTreeAdapter;
  const result = await checkHostCapabilities({
    extensionApi: readyApi(),
    ...probe,
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.processTreeAdapter.platform, "win32");
    assert.equal(result.processTreeAdapter.strategy, "job_object");
  }
});

test("运行依赖不可加载时拒绝激活且不泄露底层错误", async () => {
  const result = await checkHostCapabilities({
    extensionApi: readyApi(),
    ...readyOverrides({
      loadRuntimeDependency: async () => {
        throw new Error("D:\\secret\\dependency-path");
      },
    }),
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.diagnostic.reason, "runtime_dependency_unavailable");
    assert.doesNotMatch(JSON.stringify(result.diagnostic), /secret/);
  }
});

test("宿主 Pi 模块不可加载时安全失活", async () => {
  const result = await checkHostCapabilities({
    extensionApi: readyApi(),
    ...readyOverrides({
      loadPiModule: async () => {
        throw new Error("D:\\secret\\pi-module");
      },
    }),
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.diagnostic.reason, "pi_module_unavailable");
    assert.doesNotMatch(JSON.stringify(result.diagnostic), /secret/);
  }
});

test("进程树适配器加载失败时安全失活", async () => {
  const result = await checkHostCapabilities({
    extensionApi: readyApi(),
    ...readyOverrides({
      loadProcessTreeAdapter: async () => {
        throw new Error("D:\\secret\\native-adapter");
      },
    }),
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.diagnostic.reason, "process_tree_adapter_unavailable");
    assert.doesNotMatch(JSON.stringify(result.diagnostic), /secret/);
  }
});

test("通过门禁后只执行一次空操作激活", async () => {
  let activationCount = 0;
  const extension = createPiSubagentExtension({
    probe: readyOverrides(),
    activate: () => {
      activationCount += 1;
    },
  });

  await extension(readyApi());

  assert.equal(activationCount, 1);
});

test("门禁失败只注册一次诊断桥，不注册公开面或运行副作用", async () => {
  const diagnosticHandlers: Array<(event: unknown, context: unknown) => void> = [];
  const publicRegistrations: string[] = [];
  const lifecycleRegistrations: string[] = [];
  const forbiddenSideEffects: string[] = [];
  const notifications: Array<{ message: string; type: string }> = [];
  const api: ExtensionApiSurface = {
    ...readyApi(),
    on: ((event: string, handler: (event: unknown, context: unknown) => void) => {
      lifecycleRegistrations.push(event);
      diagnosticHandlers.push(handler);
    }) as NonNullable<ExtensionApiSurface["on"]>,
    registerTool: (() => publicRegistrations.push("tool")) as NonNullable<
      ExtensionApiSurface["registerTool"]
    >,
    registerCommand: (() => publicRegistrations.push("command")) as NonNullable<
      ExtensionApiSurface["registerCommand"]
    >,
    exec: (() => {
      forbiddenSideEffects.push("process");
    }) as NonNullable<ExtensionApiSurface["exec"]>,
  };
  Object.assign(api, {
    sendMessage: () => forbiddenSideEffects.push("message"),
    sendUserMessage: () => forbiddenSideEffects.push("user-message"),
    appendEntry: () => forbiddenSideEffects.push("session-entry"),
  });
  let activationCount = 0;
  const extension = createPiSubagentExtension({
    probe: readyOverrides({ nodeVersion: "22.18.9" }),
    activate: () => {
      activationCount += 1;
    },
  });

  await extension(api);

  assert.equal(activationCount, 0);
  assert.deepEqual(publicRegistrations, []);
  assert.deepEqual(lifecycleRegistrations, ["session_start"]);
  assert.equal(diagnosticHandlers.length, 1);
  diagnosticHandlers[0]?.(
    { type: "session_start", reason: "startup" },
    { hasUI: true, ui: { notify: (message: string, type: string) => notifications.push({ message, type }) } },
  );
  diagnosticHandlers[0]?.(
    { type: "session_start", reason: "reload" },
    { hasUI: true, ui: { notify: (message: string, type: string) => notifications.push({ message, type }) } },
  );
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.type, "warning");
  assert.match(notifications[0]?.message ?? "", new RegExp(HOST_CAPABILITY_DIAGNOSTIC_CODE));
  assert.doesNotMatch(notifications[0]?.message ?? "", /22\.18\.9/);
  assert.deepEqual(forbiddenSideEffects, []);
});

test("无 UI 宿主保持静默且诊断不回退到模型上下文", async () => {
  const handlers: Array<(event: unknown, context: unknown) => void> = [];
  const forbiddenSideEffects: string[] = [];
  const api: ExtensionApiSurface = {
    ...readyApi(),
    on: ((_event: string, handler: (event: unknown, context: unknown) => void) => {
      handlers.push(handler);
    }) as NonNullable<ExtensionApiSurface["on"]>,
  };
  Object.assign(api, {
    sendMessage: () => forbiddenSideEffects.push("message"),
    sendUserMessage: () => forbiddenSideEffects.push("user-message"),
    appendEntry: () => forbiddenSideEffects.push("session-entry"),
  });
  const extension = createPiSubagentExtension({
    probe: readyOverrides({ platform: "aix" }),
  });

  await extension(api);
  assert.deepEqual(handlers.length, 1);
  handlers[0]?.(
    { type: "session_start", reason: "startup" },
    { hasUI: false, ui: { notify: () => forbiddenSideEffects.push("notify") } },
  );
  assert.deepEqual(forbiddenSideEffects, []);
});

test("诊断桥面对异常上下文和通知异常保持静默", async () => {
  const handlers: Array<(event: unknown, context: unknown) => void> = [];
  const api: ExtensionApiSurface = {
    ...readyApi(),
    on: ((_event: string, handler: (event: unknown, context: unknown) => void) => {
      handlers.push(handler);
    }) as NonNullable<ExtensionApiSurface["on"]>,
  };
  const extension = createPiSubagentExtension({
    probe: readyOverrides({ nodeVersion: "22.18.9" }),
  });

  await extension(api);
  assert.equal(handlers.length, 1);
  assert.doesNotThrow(() => handlers[0]?.({ type: "session_start" }, undefined));

  let notifyAttempts = 0;
  assert.doesNotThrow(() =>
    handlers[0]?.(
      { type: "session_start" },
      {
        hasUI: true,
        ui: {
          notify: () => {
            notifyAttempts += 1;
            throw new Error("ui unavailable");
          },
        },
      },
    ),
  );
  assert.doesNotThrow(() =>
    handlers[0]?.(
      { type: "session_start" },
      { hasUI: true, ui: { notify: () => notifyAttempts += 1 } },
    ),
  );
  assert.equal(notifyAttempts, 1);
});

test("兼容负向组合统一保持完全失活", async () => {
  const cases: Array<{
    name: string;
    probe: HostProbeOverrides;
    removeApi?: keyof ExtensionApiSurface;
  }> = [
    { name: "低 Node", probe: readyOverrides({ nodeVersion: "22.18.9" }) },
    { name: "不可解析 Node", probe: readyOverrides({ nodeVersion: "node-version" }) },
    {
      name: "低 Pi",
      probe: readyOverrides({ loadPiModule: async () => ({ VERSION: "0.82.9", RpcClient: ReadyRpcClient }) }),
    },
    {
      name: "不可解析 Pi",
      probe: readyOverrides({ loadPiModule: async () => ({ VERSION: "unknown", RpcClient: ReadyRpcClient }) }),
    },
    { name: "缺失 API", probe: readyOverrides(), removeApi: "registerCommand" },
    { name: "不支持平台", probe: readyOverrides({ platform: "freebsd" }) },
    { name: "缺失进程树适配器", probe: readyOverrides({ loadProcessTreeAdapter: async () => undefined }) },
  ];

  for (const scenario of cases) {
    const lifecycleRegistrations: string[] = [];
    const publicRegistrations: string[] = [];
    const forbiddenSideEffects: string[] = [];
    const handlers: Array<(event: unknown, context: unknown) => void> = [];
    const notifications: string[] = [];
    const api: ExtensionApiSurface = {
      ...readyApi(),
      on: ((event: string, handler: (event: unknown, context: unknown) => void) => {
        lifecycleRegistrations.push(event);
        handlers.push(handler);
      }) as NonNullable<ExtensionApiSurface["on"]>,
      registerTool: (() => publicRegistrations.push("tool")) as NonNullable<
        ExtensionApiSurface["registerTool"]
      >,
      registerCommand: (() => publicRegistrations.push("command")) as NonNullable<
        ExtensionApiSurface["registerCommand"]
      >,
      setActiveTools: (() => forbiddenSideEffects.push("active-tools")) as NonNullable<
        ExtensionApiSurface["setActiveTools"]
      >,
      exec: (() => forbiddenSideEffects.push("exec")) as NonNullable<ExtensionApiSurface["exec"]>,
      events: {
        emit: () => forbiddenSideEffects.push("event"),
        on: () => {
          forbiddenSideEffects.push("event-handler");
          return () => {};
        },
      },
    };
    Object.assign(api, {
      sendMessage: () => forbiddenSideEffects.push("message"),
      sendUserMessage: () => forbiddenSideEffects.push("user-message"),
      appendEntry: () => forbiddenSideEffects.push("session-entry"),
    });
    if (scenario.removeApi !== undefined) delete api[scenario.removeApi];
    const extension = createPiSubagentExtension({ probe: scenario.probe });

    await extension(api);

    if (scenario.removeApi === "on") {
      assert.deepEqual(lifecycleRegistrations, [], scenario.name);
    } else {
      assert.deepEqual(lifecycleRegistrations, ["session_start"], scenario.name);
      assert.equal(handlers.length, 1, scenario.name);
      handlers[0]?.(
        { type: "session_start", reason: "startup" },
        { hasUI: true, ui: { notify: (message: string) => notifications.push(message) } },
      );
      handlers[0]?.(
        { type: "session_start", reason: "reload" },
        { hasUI: true, ui: { notify: (message: string) => notifications.push(message) } },
      );
      assert.equal(notifications.length, 1, scenario.name);
      assert.match(notifications[0] ?? "", new RegExp(HOST_CAPABILITY_DIAGNOSTIC_CODE), scenario.name);
    }
    assert.deepEqual(publicRegistrations, [], scenario.name);
    assert.deepEqual(forbiddenSideEffects, [], scenario.name);
  }
});
