import assert from "node:assert/strict";
import test from "node:test";
import {
  HOST_CAPABILITY_DIAGNOSTIC_CODE,
  MIN_NODE_VERSION,
  MIN_PI_VERSION,
  checkHostCapabilities,
  createPiSubagentExtension,
  type ExtensionApiSurface,
  type HostProbeOverrides,
} from "../src/host-gate.ts";

const readyApi = (): ExtensionApiSurface => ({
  on: () => {},
  registerTool: () => {},
  registerCommand: () => {},
  getActiveTools: () => [],
  getAllTools: () => [],
  setActiveTools: () => {},
  exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  events: {},
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
  loadProcessTreeAdapter: async (platform) => ({ platform, available: true }),
  loadRuntimeDependency: async () => import("semver"),
  ...overrides,
});

test("支持的宿主通过全部探针并可以空操作激活", async () => {
  const result = await checkHostCapabilities({
    extensionApi: readyApi(),
    ...readyOverrides(),
  });

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.nodeVersion, MIN_NODE_VERSION);
});

test("默认平台能力令牌覆盖 Windows、macOS 和 Linux", async () => {
  const strategies = new Map<string, string>();
  for (const platform of ["win32", "darwin", "linux"] as const) {
    const overrides = readyOverrides({ platform });
    delete overrides.loadProcessTreeAdapter;
    const result = await checkHostCapabilities({ extensionApi: readyApi(), ...overrides });
    assert.equal(result.ok, true);
    if (result.ok) {
      const adapter = result.processTreeAdapter as { strategy: string };
      strategies.set(platform, adapter.strategy);
    }
  }

  assert.deepEqual([...strategies.entries()], [
    ["win32", "job_object"],
    ["darwin", "process_group_or_session"],
    ["linux", "process_group_or_session"],
  ]);
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

test("门禁失败不注册公开面，并只提供脱敏 UI-only 诊断", async () => {
  const handlers: Array<(event: unknown, context: unknown) => void> = [];
  const publicRegistrations: string[] = [];
  const lifecycleRegistrations: string[] = [];
  const forbiddenSideEffects: string[] = [];
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

  const notifications: Array<{ message: string; type: string }> = [];
  handlers[0]?.(
    { type: "session_start", reason: "startup" },
    {
      hasUI: true,
      ui: { notify: (message: string, type: string) => notifications.push({ message, type }) },
    },
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
  const notifications: string[] = [];
  handlers[0]?.(
    { type: "session_start", reason: "startup" },
    {
      hasUI: false,
      ui: { notify: (message: string) => notifications.push(message) },
    },
  );

  assert.deepEqual(notifications, []);
  assert.deepEqual(forbiddenSideEffects, []);
});
