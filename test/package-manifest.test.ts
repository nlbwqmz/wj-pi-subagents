import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

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

test("package manifest 声明 MIT 许可证并包含许可证文件", () => {
  const licenseText = readFileSync(join(repositoryRoot, "LICENSE"), "utf8");

  assert.match(licenseText, /^MIT License\r?\n/);
  assert.match(licenseText, /Copyright \(c\) 2026 WJ/);
});
