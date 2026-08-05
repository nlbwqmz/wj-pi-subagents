import assert from "node:assert/strict";
import test from "node:test";
import { classifyProcessTreeResources } from "../src/process-tree-resource-boundary.ts";

test("直接进程退出但整树资源仍存在时只报告 present", () => {
  const assessment = classifyProcessTreeResources({
    exit: { state: "exited" },
    resources: { state: "present" },
  });

  assert.deepEqual(assessment, { state: "present" });
});

test("进程退出和整树资源释放都确认后只报告进程树确认", () => {
  const assessment = classifyProcessTreeResources({
    exit: { state: "exited" },
    resources: { state: "released" },
  });

  assert.deepEqual(assessment, { state: "confirmed_exited" });
  assert.equal("lifecycle" in assessment, false);
  assert.equal("releaseQuotaSlots" in assessment, false);
});

test("退出观察仍为 present 时不能被资源释放观察单独提升", () => {
  const assessment = classifyProcessTreeResources({
    exit: { state: "present" },
    resources: { state: "released" },
  });

  assert.deepEqual(assessment, { state: "present" });
});
