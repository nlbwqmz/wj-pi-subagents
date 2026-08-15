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
    description?: string;
    homepage?: string;
    bugs?: { url?: string };
    repository?: { type?: string; url?: string };
    private?: boolean;
    license?: string;
    files?: string[];
    publishConfig?: { access?: string; registry?: string };
    engines?: { node?: string };
    scripts?: {
      "pack:smoke"?: string;
      "release:validate"?: string;
      prepublishOnly?: string;
    };
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    dependencies?: Record<string, string>;
    pi?: Record<string, unknown>;
    wjPiSubagents?: { requiresPi?: string };
  };

  assert.equal(manifest.name, "wj-pi-subagents");
  assert.equal(manifest.description, "wj-pi-subagents：Pi 递归子代理扩展包");
  assert.equal(manifest.homepage, "https://github.com/nlbwqmz/wj-pi-subagents#readme");
  assert.deepEqual(manifest.bugs, {
    url: "https://github.com/nlbwqmz/wj-pi-subagents/issues",
  });
  assert.deepEqual(manifest.repository, {
    type: "git",
    url: "git+https://github.com/nlbwqmz/wj-pi-subagents.git",
  });
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.license, "MIT");
  assert.deepEqual(manifest.files, ["LICENSE", "dist", "index.ts", "src"]);
  assert.deepEqual(manifest.publishConfig, {
    access: "public",
    registry: "https://registry.npmjs.org/",
  });
  assert.equal(manifest.engines?.node, REQUIRED_NODE_RANGE);
  assert.equal(manifest.scripts?.["pack:smoke"], "node scripts/package-smoke.mjs");
  assert.equal(manifest.scripts?.["release:validate"], "node scripts/validate-release-tag.mjs");
  assert.equal(manifest.scripts?.prepublishOnly, "npm run check");
  assert.equal(manifest.peerDependencies?.["@earendil-works/pi-coding-agent"], "*");
  assert.equal(manifest.peerDependencies?.["@earendil-works/pi-tui"], "*");
  assert.equal(manifest.devDependencies?.["@earendil-works/pi-tui"], "0.84.1");
  assert.ok(manifest.dependencies?.semver, "生产安装必须能够解析 semver");
  assert.deepEqual(manifest.pi, {
    extensions: ["./index.ts"],
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
