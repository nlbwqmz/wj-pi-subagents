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

test("release workflow 对所有 tag 执行校验，npm 成功后才创建 GitHub Release", () => {
  const workflow = asRecord(parse(readFileSync(workflowPath, "utf8")));
  const push = asRecord(asRecord(workflow.on).push);
  assert.deepEqual(push.tags, ["**"]);

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
  const checkIndex = publishRuns.findIndex((run) => run.includes("npm run check"));
  const buildIndex = publishRuns.findIndex((run) => run.includes("npm run build:bridge"));
  const publishIndex = publishRuns.findIndex(
    (run) => run.includes("npm publish --ignore-scripts --access public --provenance"),
  );
  assert.ok(validateIndex >= 0);
  assert.ok(checkIndex > validateIndex);
  assert.ok(buildIndex > checkIndex);
  assert.ok(publishIndex > buildIndex);

  const release = asRecord(jobs.create_github_release);
  assert.equal(release.needs, "publish_npm");
  assert.equal(asRecord(release.permissions).contents, "write");
  const releaseRuns = asArray(release.steps)
    .map(asRecord)
    .map((step) => step.run)
    .filter((run): run is string => typeof run === "string");
  assert.ok(releaseRuns.some((run) => run.includes("gh release create")));
  assert.ok(releaseRuns.some((run) => run.includes("--verify-tag") && run.includes("--generate-notes")));
});
