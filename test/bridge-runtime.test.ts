import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BRIDGE_RUNTIME_ENV,
  BridgeRuntimeUnavailableError,
  createManagedRpcNode,
  createManagedRpcNodeLaunchSpec,
  resolveBridgeRuntime,
} from "../src/managed-rpc-node.ts";
import { FakeProcessTreeAdapter } from "../src/fake-process-tree-adapter.ts";

function fakeBin(dir: string, name: string): string {
  const full = join(dir, name);
  writeFileSync(full, "#!/bin/sh\nexec /bin/true \"$@\"\n");
  chmodSync(full, 0o755);
  return full;
}

/** 宿主平台上的运行时文件名：Windows 查找只接受 .exe。 */
function fakeRuntime(dir: string, name: string): string {
  return fakeBin(dir, process.platform === "win32" ? `${name}.exe` : name);
}

describe("bridge runtime resolution", () => {
  let savedRuntimeEnv: string | undefined;

  beforeEach(() => {
    savedRuntimeEnv = process.env[BRIDGE_RUNTIME_ENV];
    delete process.env[BRIDGE_RUNTIME_ENV];
  });

  afterEach(() => {
    if (savedRuntimeEnv === undefined) delete process.env[BRIDGE_RUNTIME_ENV];
    else process.env[BRIDGE_RUNTIME_ENV] = savedRuntimeEnv;
  });

  it("keeps node/bun hosts as-is", () => {
    assert.equal(resolveBridgeRuntime("/usr/bin/node", ""), "/usr/bin/node");
    assert.equal(resolveBridgeRuntime("/usr/bin/nodejs", ""), "/usr/bin/nodejs");
    assert.equal(resolveBridgeRuntime("/opt/bun", ""), "/opt/bun");
    assert.equal(resolveBridgeRuntime(process.execPath, ""), process.execPath);
  });

  it("recognizes windows node.exe hosts", { skip: process.platform !== "win32" }, () => {
    assert.equal(resolveBridgeRuntime("C:\\node\\node.exe", ""), "C:\\node\\node.exe");
  });

  it("falls back to node on PATH for compiled single-binary hosts", () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-rt-"));
    const node = fakeRuntime(dir, "node");
    assert.equal(resolveBridgeRuntime("/opt/pi-local/pi", dir), node);
  });

  it("prefers node over bun and reports no runtime when nothing is found", () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-rt-"));
    fakeRuntime(dir, "bun");
    const node = fakeRuntime(dir, "node");
    assert.equal(resolveBridgeRuntime("/opt/pi-local/pi", dir), node);
    assert.equal(resolveBridgeRuntime("/opt/pi-local/pi", ""), undefined);
  });

  it("windows candidates accept only .exe so bun fallback is not blocked", () => {
    const mixed = mkdtempSync(join(tmpdir(), "bridge-rt-"));
    fakeBin(mixed, "node.cmd");
    const bun = fakeBin(mixed, "bun.exe");
    assert.equal(resolveBridgeRuntime("C:\\pi\\pi.exe", mixed, "win32"), bun);

    const onlyCmd = mkdtempSync(join(tmpdir(), "bridge-rt-"));
    fakeBin(onlyCmd, "node.cmd");
    assert.equal(resolveBridgeRuntime("C:\\pi\\pi.exe", onlyCmd, "win32"), undefined);

    const exeDir = mkdtempSync(join(tmpdir(), "bridge-rt-"));
    const nodeExe = fakeBin(exeDir, "node.exe");
    assert.equal(resolveBridgeRuntime("C:\\pi\\pi.exe", exeDir, "win32"), nodeExe);
  });

  it("launch spec uses resolved runtime and keeps strip-types for node .ts", () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-rt-"));
    const node = fakeBin(dir, "node");
    const spec = createManagedRpcNodeLaunchSpec({
      bridgeScriptPath: "/pkg/bridge.ts",
      bridgeRuntimePath: node,
    });
    assert.equal(spec.command, node);
    const compiled = createManagedRpcNodeLaunchSpec({
      bridgeScriptPath: "/pkg/dist/bridge.js",
      bridgeRuntimePath: "/usr/bin/node",
    });
    assert.equal(compiled.command, "/usr/bin/node");
    assert.deepEqual([...(compiled.args ?? [])], ["/pkg/dist/bridge.js"]);
    const bunCompiled = createManagedRpcNodeLaunchSpec({
      bridgeScriptPath: "/pkg/bridge.ts",
      bridgeRuntimePath: "/opt/bun",
    });
    assert.deepEqual([...(bunCompiled.args ?? [])], ["/pkg/bridge.ts"]);
  });

  it("resolves the default launch spec for compiled hosts via hostExecPath", () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-rt-"));
    const node = fakeRuntime(dir, "node");
    const spec = createManagedRpcNodeLaunchSpec({
      bridgeScriptPath: "/pkg/dist/bridge.js",
      hostExecPath: "/opt/pi-local/pi",
      bridgeRuntimePathEnv: dir,
    });
    assert.equal(spec.command, node);
    assert.deepEqual([...(spec.args ?? [])], ["/pkg/dist/bridge.js"]);
  });

  it("lets the environment variable override host resolution and keeps option precedence", () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-rt-"));
    const node = fakeRuntime(dir, "node");
    const envRuntime = fakeBin(dir, "env-runtime");
    const optionRuntime = fakeBin(dir, "option-runtime");

    process.env[BRIDGE_RUNTIME_ENV] = envRuntime;
    const viaEnv = createManagedRpcNodeLaunchSpec({
      bridgeScriptPath: "/pkg/dist/bridge.js",
      hostExecPath: "/opt/pi-local/pi",
      bridgeRuntimePathEnv: dir,
    });
    assert.equal(viaEnv.command, envRuntime);
    const viaOption = createManagedRpcNodeLaunchSpec({
      bridgeScriptPath: "/pkg/dist/bridge.js",
      bridgeRuntimePath: optionRuntime,
    });
    assert.equal(viaOption.command, optionRuntime);

    process.env[BRIDGE_RUNTIME_ENV] = "";
    const emptyEnv = createManagedRpcNodeLaunchSpec({
      bridgeScriptPath: "/pkg/dist/bridge.js",
      hostExecPath: "/opt/pi-local/pi",
      bridgeRuntimePathEnv: dir,
    });
    assert.equal(emptyEnv.command, node);
  });

  it("fails the launch spec when no runtime is available", () => {
    assert.throws(
      () => createManagedRpcNodeLaunchSpec({
        bridgeScriptPath: "/pkg/dist/bridge.js",
        hostExecPath: "/opt/pi-local/pi",
        bridgeRuntimePathEnv: "",
      }),
      BridgeRuntimeUnavailableError,
    );
  });

  it("blocks node startup before touching the process tree when no runtime is available", async () => {
    const node = createManagedRpcNode({
      processTreeAdapter: new FakeProcessTreeAdapter(),
      hostExecPath: "/opt/pi-local/pi",
      bridgeRuntimePathEnv: "",
    });
    await assert.rejects(() => node.start(), BridgeRuntimeUnavailableError);
    await node.release();
  });
});
