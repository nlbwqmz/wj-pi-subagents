import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const validatorPath = join(repositoryRoot, "scripts", "validate-release-tag.mjs");
const generatorPath = join(repositoryRoot, "scripts", "generate-changelog.mjs");
const manifestPath = join(repositoryRoot, "package.json");
const workflowPath = join(repositoryRoot, ".github", "workflows", "release.yml");

function runValidator(tag: string) {
  return spawnSync(process.execPath, [validatorPath, tag], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}

function readPackageVersion(): string {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version: string };
  return manifest.version;
}

function nextPatchVersion(version: string): string {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

function compareSemver(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

interface NotesFixture {
  readonly root: string;
  readonly notesDir: string;
  readonly outPath: string;
}

function createNotesFixture(files: readonly (readonly [string, string])[]): NotesFixture {
  const root = mkdtempSync(join(tmpdir(), "wj-changelog-"));
  const notesDir = join(root, "notes");
  mkdirSync(notesDir, { recursive: true });
  for (const [name, content] of files) writeFileSync(join(notesDir, name), content, "utf8");
  return { root, notesDir, outPath: join(root, "out", "CHANGELOG.md") };
}

function runGenerator(fixture: NotesFixture) {
  return spawnSync(
    process.execPath,
    [generatorPath, "--notes-dir", fixture.notesDir, "--out", fixture.outPath],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
}

function releaseNote(version: string, body: readonly string[]): string {
  return ["# v" + version, "", ...body].join("\n");
}

test("CHANGELOG 生成器把发布说明按 semver 降序拼成包内 CHANGELOG.md", () => {
  const manifestVersion = readPackageVersion();
  const versions = [...new Set(["0.1.0", "0.2.0", manifestVersion])];
  const richBody = [
    "## 新增",
    "",
    "- 支持 `--notes-dir` 与 `--out` 选项，行内代码 `## 保持原样`。",
    "",
    "### 细节",
    "",
    "#### 更深的标题",
    "",
    "```text",
    "## 围栏里的标题不降级",
    "### 围栏里的子标题也不降级",
    "```",
    "",
    "~~~markdown",
    "## 波浪号围栏里的标题也不降级",
    "~~~",
    "",
    "- 列表与空行保持原样。",
  ];
  const fixture = createNotesFixture(
    versions.map((version): readonly [string, string] => [
      `v${version}.md`,
      releaseNote(version, version === "0.2.0" ? richBody : ["## 优化", "", `- ${version} 的变更。`]),
    ]),
  );

  try {
    const result = runGenerator(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(fixture.outPath), true);

    const changelog = readFileSync(fixture.outPath, "utf8");
    const headers = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]$/gm)].map(
      (match) => match[1] ?? "",
    );
    assert.deepEqual(headers, [...versions].sort(compareSemver).reverse());
    assert.ok(headers.includes("0.2.0"), "段头必须形如 ## [0.2.0]");
    assert.equal(headers[0], manifestVersion);

    assert.match(changelog, /^### 新增$/m, "正文标题必须降一级");
    assert.match(changelog, /^#### 细节$/m, "正文标题必须逐级下降");
    assert.match(changelog, /^##### 更深的标题$/m);
    assert.equal(/^## 新增$/m.test(changelog), false);
    assert.equal(/^### 细节$/m.test(changelog), false);
    assert.match(changelog, /^## 围栏里的标题不降级$/m, "代码围栏内的标题不降级");
    assert.match(changelog, /^### 围栏里的子标题也不降级$/m);
    assert.match(changelog, /^## 波浪号围栏里的标题也不降级$/m);
    assert.match(changelog, /^- 支持 `--notes-dir` 与 `--out` 选项，行内代码 `## 保持原样`。$/m);

    assert.equal(changelog.includes("\n\n\n"), false, "段与段之间恰好一个空行");
    assert.match(changelog, /\n$/, "文件末尾必须换行");
    assert.equal(/\n\n$/.test(changelog), false, "文件末尾只能有单个换行");
    assert.equal(/^# /m.test(changelog), false, "输出不得包含顶级标题");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function expectGeneratorFailure(
  files: readonly (readonly [string, string])[],
  expectedMessage: RegExp,
): void {
  const fixture = createNotesFixture(files);
  try {
    const result = runGenerator(fixture);
    assert.notEqual(result.status, 0, `应生成失败：${expectedMessage.source}`);
    assert.match(result.stderr, expectedMessage);
    assert.equal(existsSync(fixture.outPath), false, "校验失败时不得写出目标文件");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

test("CHANGELOG 生成器校验失败即退出且不写盘", () => {
  const manifestVersion = readPackageVersion();
  const body = ["## 优化", "", "- 变更。"];

  expectGeneratorFailure(
    [
      ["v0.2.0.md", releaseNote("0.2.0", body)],
      ["0.2.0.md", releaseNote("0.2.0", body)],
    ],
    /版本 0\.2\.0 重复/,
  );

  expectGeneratorFailure(
    [["v0.2.0.md", releaseNote("0.2.1", body)]],
    /标题版本 0\.2\.1 与文件名版本 0\.2\.0 不一致/,
  );

  expectGeneratorFailure([["v0.2.0.md", releaseNote("0.2.0", ["", "  "])]], /正文为空/);

  expectGeneratorFailure([["README.md", "# 发布说明目录\n"]], /没有可用的 vX\.Y\.Z\.md/);

  const newerVersion = nextPatchVersion(manifestVersion);
  expectGeneratorFailure(
    [
      ["v0.2.0.md", releaseNote("0.2.0", body)],
      [`v${newerVersion}.md`, releaseNote(newerVersion, body)],
    ],
    new RegExp(
      `发布说明最大版本 ${newerVersion.replaceAll(".", "\\.")} 与 package\\.json 版本 ${manifestVersion.replaceAll(".", "\\.")} 不一致`,
    ),
  );
});

function asRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

test("发布 tag 必须是与 package.json 一致的稳定 vX.X.X 版本", () => {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
    version: string;
  };
  const valid = runValidator(`v${manifest.version}`);

  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /发布标记校验通过/);

  for (const tag of [
    "1.0.0",
    "v1.0",
    "v1.0.0-beta.1",
    "v1.0.0+build.1",
    "v01.0.0",
    "v1.0.0.0",
    "vx.y.z",
  ]) {
    const invalid = runValidator(tag);
    assert.notEqual(invalid.status, 0, `${tag} 不应通过发布校验`);
    assert.match(invalid.stderr, /必须严格符合 vX\.X\.X/);
  }

  const mismatch = runValidator("v999.0.0");
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /与 package\.json 版本 .* 不一致/);
});

test("release workflow 只监听版本形状 tag，npm 成功后才创建 GitHub Release", () => {
  const workflow = asRecord(parse(readFileSync(workflowPath, "utf8")));
  const push = asRecord(asRecord(workflow.on).push);
  assert.deepEqual(push.tags, ["v*.*.*"]);

  const jobs = asRecord(workflow.jobs);
  const publish = asRecord(jobs.publish_npm);
  const publishPermissions = asRecord(publish.permissions);
  assert.equal(publishPermissions.contents, "read");
  assert.equal(publishPermissions["id-token"], "write");

  const publishRuns = asArray(publish.steps)
    .map(asRecord)
    .map((step) => step.run)
    .filter((run): run is string => typeof run === "string");
  const validateIndex = publishRuns.findIndex((run) => run.includes("release:validate"));
  const notesIndex = publishRuns.findIndex((run) => run.includes("release-notes/"));
  const checkIndex = publishRuns.findIndex((run) => run.includes("npm run check"));
  const buildIndex = publishRuns.findIndex((run) => run.includes("npm run build:package"));
  const publishIndex = publishRuns.findIndex(
    (run) => run.includes("npm publish --ignore-scripts --access public --provenance"),
  );
  assert.ok(validateIndex >= 0);
  assert.ok(notesIndex > validateIndex, "发布说明文件应在 npm 发布前校验");
  assert.ok(checkIndex > notesIndex);
  assert.ok(buildIndex > checkIndex);
  assert.ok(publishIndex > buildIndex);
  assert.equal(
    publishRuns.some(
      (run) => run.includes("npm run build:bridge") || run.includes("changelog:generate"),
    ),
    false,
    "发布 job 只能调用单一产物入口 build:package，不得内联子步骤（--ignore-scripts 会跳过 prepack）",
  );

  const release = asRecord(jobs.create_github_release);
  assert.equal(release.needs, "publish_npm");
  assert.equal(asRecord(release.permissions).contents, "write");
  const releaseSteps = asArray(release.steps).map(asRecord);
  assert.ok(
    releaseSteps.some((step) => step.uses === "actions/checkout@v6"),
    "读取发布说明文件前必须检出 tag 对应提交",
  );
  const releaseRuns = releaseSteps
    .map((step) => step.run)
    .filter((run): run is string => typeof run === "string");
  assert.ok(releaseRuns.some((run) => run.includes("gh release create")));
  const createRun = releaseRuns.find((run) => run.includes("gh release create"));
  assert.ok(createRun !== undefined);
  assert.ok(createRun.includes("--verify-tag"));
  assert.ok(createRun.includes("--notes-file \"release-notes/${GITHUB_REF_NAME}.md\""));
  assert.equal(createRun.includes("--generate-notes"), false);
});

test("release workflow 发布前先通过三平台测试矩阵", () => {
  const workflow = asRecord(parse(readFileSync(workflowPath, "utf8")));
  const jobs = asRecord(workflow.jobs);
  const testJob = asRecord(jobs.test);
  assert.equal(testJob.if, "github.event.deleted == false");
  const matrix = asRecord(asRecord(testJob.strategy).matrix);
  assert.deepEqual(matrix.os, ["windows-latest", "ubuntu-latest", "macos-latest"]);
  const testRuns = asArray(testJob.steps)
    .map(asRecord)
    .map((step) => step.run)
    .filter((run): run is string => typeof run === "string");
  assert.ok(testRuns.some((run) => run.includes("npm run check")));
  assert.ok(testRuns.some((run) => run.includes("npm run compat:pi")));
  assert.equal(asRecord(jobs.publish_npm).needs, "test");
});
