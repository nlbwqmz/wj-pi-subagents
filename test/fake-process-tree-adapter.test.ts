import assert from "node:assert/strict";
import test from "node:test";
import { FakeProcessTreeAdapter } from "../src/fake-process-tree-adapter.ts";
import { isProcessTreeAdapter } from "../src/process-tree-capability.ts";
import { decideProcessTreeTermination } from "../src/process-tree-resource-boundary.ts";

test("FakeProcessTreeAdapter 可确定重现优雅关闭超时", async () => {
  const adapter = new FakeProcessTreeAdapter({
    scenarios: [
      {
        afterGracefulClose: { exit: "present", resources: "present" },
        afterForceTerminate: [{ exit: "exited", resources: "released" }],
      },
    ],
  });
  const tree = await adapter.attach({ kind: "fake-process" });

  await adapter.requestGracefulClose(tree, new AbortController().signal);

  assert.deepEqual(await adapter.waitForExit(tree, 100), { state: "present" });
  assert.deepEqual(await adapter.inspect(tree), { state: "present" });
});

test("直接进程退出不掩盖孙进程残留", async () => {
  const adapter = new FakeProcessTreeAdapter({
    scenarios: [
      {
        afterGracefulClose: { exit: "exited", resources: "present" },
      },
    ],
  });
  const tree = await adapter.attach({ kind: "fake-process" });

  await adapter.requestGracefulClose(tree, new AbortController().signal);

  const exit = await adapter.waitForExit(tree, new Date(100));
  const resources = await adapter.inspect(tree);
  assert.deepEqual(decideProcessTreeTermination({ exit, resources }), {
    resourceState: "present",
    lifecycle: "terminating",
    releaseQuotaSlots: false,
  });
});

test("部分回收保持 terminating，重试确认后才释放名额", async () => {
  const adapter = new FakeProcessTreeAdapter({
    scenarios: [
      {
        afterGracefulClose: { exit: "present", resources: "present" },
        afterForceTerminate: [
          { exit: "exited", resources: "present" },
          { exit: "exited", resources: "released" },
        ],
      },
    ],
  });
  const tree = await adapter.attach({ kind: "fake-process" });

  await adapter.requestGracefulClose(tree, new AbortController().signal);
  await adapter.forceTerminate(tree);
  assert.deepEqual(
    decideProcessTreeTermination({
      exit: await adapter.waitForExit(tree, 100),
      resources: await adapter.inspect(tree),
    }),
    {
      resourceState: "present",
      lifecycle: "terminating",
      releaseQuotaSlots: false,
    },
  );

  await adapter.forceTerminate(tree);
  assert.deepEqual(
    decideProcessTreeTermination({
      exit: await adapter.waitForExit(tree, 100),
      resources: await adapter.inspect(tree),
    }),
    {
      resourceState: "confirmed_exited",
      lifecycle: "terminated",
      releaseQuotaSlots: true,
    },
  );
});

test("重复强制回收和句柄释放保持幂等且可观察", async () => {
  const adapter = new FakeProcessTreeAdapter({
    scenarios: [
      {
        afterGracefulClose: { exit: "present", resources: "present" },
        afterForceTerminate: [{ exit: "exited", resources: "released" }],
      },
    ],
  });
  const tree = await adapter.attach({ kind: "fake-process" });

  await adapter.forceTerminate(tree);
  const firstObservation = {
    exit: await adapter.waitForExit(tree, 100),
    resources: await adapter.inspect(tree),
  };
  await adapter.forceTerminate(tree);
  const repeatedObservation = {
    exit: await adapter.waitForExit(tree, 100),
    resources: await adapter.inspect(tree),
  };
  assert.deepEqual(repeatedObservation, firstObservation);

  await adapter.release(tree);
  await assert.doesNotReject(() => adapter.release(tree));
  assert.deepEqual(await adapter.inspect(tree), { state: "unknown" });
  assert.deepEqual(await adapter.waitForExit(tree, 100), { state: "unknown" });
});

test("资源观察无法确认时保持 unknown 而不提前终止", async () => {
  const adapter = new FakeProcessTreeAdapter({
    scenarios: [
      {
        afterGracefulClose: { exit: "exited", resources: "unknown" },
      },
    ],
  });
  const tree = await adapter.attach({ kind: "fake-process" });

  await adapter.requestGracefulClose(tree, new AbortController().signal);
  const decision = decideProcessTreeTermination({
    exit: await adapter.waitForExit(tree, 100),
    resources: await adapter.inspect(tree),
  });

  assert.deepEqual(decision, {
    resourceState: "unknown",
    lifecycle: "terminating",
    releaseQuotaSlots: false,
  });
});

test("fake 在三种受支持平台上都满足对应进程树契约", () => {
  const cases = [
    ["win32", "job_object"],
    ["darwin", "process_group_or_session"],
    ["linux", "process_group_or_session"],
  ] as const;

  for (const [platform, strategy] of cases) {
    const adapter = new FakeProcessTreeAdapter({ platform });
    assert.equal(adapter.strategy, strategy);
    assert.equal(isProcessTreeAdapter(adapter, platform), true);
  }
});
