import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("package manifest 只暴露一个显式 Pi 扩展入口", () => {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
    private?: boolean;
    files?: string[];
    engines?: { node?: string };
    peerDependencies?: Record<string, string>;
    dependencies?: Record<string, string>;
    pi?: Record<string, unknown>;
    piSubagent?: { requiresPi?: string };
  };

  assert.equal(manifest.private, undefined);
  assert.deepEqual(manifest.files, ["extensions", "src"]);
  assert.equal(manifest.engines?.node, ">=22.19.0");
  assert.equal(manifest.peerDependencies?.["@earendil-works/pi-coding-agent"], "*");
  assert.ok(manifest.dependencies?.semver, "生产安装必须能够解析 semver");
  assert.deepEqual(manifest.pi, {
    extensions: ["./extensions/pi-subagent.ts"],
  });
  assert.equal(manifest.piSubagent?.requiresPi, ">=0.83.0");
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
  const entryModule = await import("../extensions/pi-subagent.ts");

  assert.equal(typeof entryModule.default, "function");
  assert.deepEqual(Object.keys(entryModule), ["default"]);
});
