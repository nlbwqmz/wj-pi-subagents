import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const validatorPath = join(repositoryRoot, "scripts", "validate-release-tag.mjs");
const workflowPath = join(repositoryRoot, ".github", "workflows", "release.yml");

function runValidator(tag: string) {
  return spawnSync(process.execPath, [validatorPath, tag], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}

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
  const buildIndex = publishRuns.findIndex((run) => run.includes("npm run build:bridge"));
  const publishIndex = publishRuns.findIndex(
    (run) => run.includes("npm publish --ignore-scripts --access public --provenance"),
  );
  assert.ok(validateIndex >= 0);
  assert.ok(notesIndex > validateIndex, "发布说明文件应在 npm 发布前校验");
  assert.ok(checkIndex > notesIndex);
  assert.ok(buildIndex > checkIndex);
  assert.ok(publishIndex > buildIndex);

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
