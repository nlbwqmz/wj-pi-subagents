import assert from "node:assert/strict";
import test from "node:test";
import { decideProcessTreeTermination } from "../src/process-tree-resource-boundary.ts";

test("直接进程退出但整树资源仍存在时保持 terminating 和名额", () => {
  const decision = decideProcessTreeTermination({
    exit: { state: "exited" },
    resources: { state: "present" },
  });

  assert.deepEqual(decision, {
    resourceState: "present",
    lifecycle: "terminating",
    releaseQuotaSlots: false,
  });
});

test("进程退出和整树资源释放都确认后才进入 terminated", () => {
  const decision = decideProcessTreeTermination({
    exit: { state: "exited" },
    resources: { state: "released" },
  });

  assert.deepEqual(decision, {
    resourceState: "confirmed_exited",
    lifecycle: "terminated",
    releaseQuotaSlots: true,
  });
});

test("退出观察仍为 present 时不能被资源释放观察单独提升", () => {
  const decision = decideProcessTreeTermination({
    exit: { state: "present" },
    resources: { state: "released" },
  });

  assert.deepEqual(decision, {
    resourceState: "present",
    lifecycle: "terminating",
    releaseQuotaSlots: false,
  });
});
