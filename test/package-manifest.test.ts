import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED_NODE_RANGE = ">=22.19.0";
const REQUIRED_PI_RANGE = ">=0.84.1";

test("package manifest 只暴露一个显式 Pi 扩展入口", () => {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
    name?: string;
    private?: boolean;
    files?: string[];
    engines?: { node?: string };
    scripts?: { "pack:smoke"?: string };
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    dependencies?: Record<string, string>;
    pi?: Record<string, unknown>;
    wjPiSubagents?: { requiresPi?: string };
  };

  assert.equal(manifest.name, "wj-pi-subagents");
  assert.equal(manifest.private, undefined);
  assert.deepEqual(manifest.files, ["dist", "extensions", "src"]);
  assert.equal(manifest.engines?.node, REQUIRED_NODE_RANGE);
  assert.equal(manifest.scripts?.["pack:smoke"], "node scripts/package-smoke.mjs");
  assert.equal(manifest.peerDependencies?.["@earendil-works/pi-coding-agent"], "*");
  assert.equal(manifest.peerDependencies?.["@earendil-works/pi-tui"], "*");
  assert.equal(manifest.devDependencies?.["@earendil-works/pi-tui"], "0.84.1");
  assert.ok(manifest.dependencies?.semver, "生产安装必须能够解析 semver");
  assert.deepEqual(manifest.pi, {
    extensions: ["./extensions/wj-pi-subagents.ts"],
  });
  assert.equal(manifest.wjPiSubagents?.requiresPi, REQUIRED_PI_RANGE);
});

test("package manifest 不注册额外 Pi 资源", () => {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
    pi?: Record<string, unknown>;
  };

  assert.equal(manifest.pi?.skills, undefined);
  assert.equal(manifest.pi?.prompts, undefined);
  assert.equal(manifest.pi?.themes, undefined);
});

test("manifest 入口存在且只导出一个 Pi factory", async () => {
  assert.equal(existsSync(join(repositoryRoot, "extensions", "wj-pi-subagents.ts")), true);
  const entryModule = await import("../extensions/wj-pi-subagents.ts");

  assert.equal(typeof entryModule.default, "function");
  assert.deepEqual(Object.keys(entryModule), ["default"]);
});
