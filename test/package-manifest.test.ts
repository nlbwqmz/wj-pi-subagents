import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse as parseYaml } from "yaml";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("package manifest 不注册额外 Pi 资源", () => {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
    pi?: Record<string, unknown>;
  };

  assert.equal(manifest.pi?.skills, undefined);
  assert.equal(manifest.pi?.prompts, undefined);
  assert.equal(manifest.pi?.themes, undefined);
});

test("manifest 入口存在且只导出一个 Pi factory", async () => {
  assert.equal(existsSync(join(repositoryRoot, "index.ts")), true);
  assert.equal(existsSync(join(repositoryRoot, "extensions", "wj-pi-subagents.ts")), false);
  const entryModule = await import("../index.ts");

  assert.equal(typeof entryModule.default, "function");
  assert.deepEqual(Object.keys(entryModule), ["default"]);
});

test("npm test 先干净重建 bridge，避免源码协议与旧 dist 进程不一致", () => {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, unknown>;
  };

  assert.equal(manifest.scripts?.pretest, "npm run build:bridge");
  assert.equal(manifest.scripts?.["build:bridge"], "node scripts/build-bridge.mjs");
  assert.equal(existsSync(join(repositoryRoot, "scripts", "build-bridge.mjs")), true);
});

test("package manifest、lock 和 CI 固定 Pi 0.84.4 clean-break 基线", () => {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
    peerDependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
    wjPiSubagents?: { readonly requiresPi?: unknown };
  };
  const lock = JSON.parse(readFileSync(join(repositoryRoot, "package-lock.json"), "utf8")) as {
    packages?: Record<string, Record<string, unknown>>;
  };

  assert.equal(manifest.wjPiSubagents?.requiresPi, ">=0.84.4");
  assert.equal(manifest.peerDependencies?.["@earendil-works/pi-coding-agent"], ">=0.84.4");
  assert.equal(manifest.peerDependencies?.["@earendil-works/pi-tui"], ">=0.84.4");
  assert.equal(manifest.devDependencies?.["@earendil-works/pi-coding-agent"], "0.84.4");
  assert.equal(manifest.devDependencies?.["@earendil-works/pi-tui"], "0.84.4");
  assert.equal(lock.packages?.["node_modules/@earendil-works/pi-coding-agent"]?.version, "0.84.4");
  assert.equal(lock.packages?.["node_modules/@earendil-works/pi-tui"]?.version, "0.84.4");

  const workflow = parseYaml(readFileSync(join(repositoryRoot, ".github", "workflows", "ci.yml"), "utf8")) as {
    jobs?: { test?: { steps?: readonly { readonly name?: unknown; readonly run?: unknown }[] } };
  };
  const installPi = workflow.jobs?.test?.steps?.find((step) => step.name === "Install Pi");
  assert.equal(
    installPi?.run,
    "npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.4",
  );
});

test("package manifest 声明 MIT 许可证并包含许可证文件", () => {
  const licenseText = readFileSync(join(repositoryRoot, "LICENSE"), "utf8");

  assert.match(licenseText, /^MIT License\r?\n/);
  assert.match(licenseText, /Copyright \(c\) 2026 WJ/);
});
