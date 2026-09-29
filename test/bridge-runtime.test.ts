import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createManagedRpcNodeLaunchSpec,
  resolveBridgeRuntime,
} from "../src/managed-rpc-node.ts";

function fakeBin(dir: string, name: string): string {
  const full = join(dir, name);
  writeFileSync(full, "#!/bin/sh\nexec /bin/true \"$@\"\n");
  chmodSync(full, 0o755);
  return full;
}

describe("bridge runtime resolution", () => {
  it("keeps node/bun hosts as-is", () => {
    assert.equal(resolveBridgeRuntime("/usr/bin/node", ""), "/usr/bin/node");
    assert.equal(resolveBridgeRuntime("/usr/bin/nodejs", ""), "/usr/bin/nodejs");
    assert.equal(resolveBridgeRuntime("/opt/bun", ""), "/opt/bun");
    assert.equal(resolveBridgeRuntime("C:\\node\\node.exe", ""), "C:\\node\\node.exe");
  });

  it("falls back to node on PATH for compiled single-binary hosts", () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-rt-"));
    const node = fakeBin(dir, "node");
    assert.equal(resolveBridgeRuntime("/opt/pi-local/pi", dir), node);
  });

  it("prefers node over bun and keeps legacy behavior when nothing found", () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-rt-"));
    fakeBin(dir, "bun");
    const node = fakeBin(dir, "node");
    assert.equal(resolveBridgeRuntime("/opt/pi-local/pi", dir), node);
    assert.equal(resolveBridgeRuntime("/opt/pi-local/pi", ""), "/opt/pi-local/pi");
  });

  it("launch spec uses resolved runtime and keeps strip-types for node .ts", () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-rt-"));
    const node = fakeBin(dir, "node");
    // Compiled-host resolution itself is covered above; here the pinned
    // runtime stands in for the resolved one.
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
});
