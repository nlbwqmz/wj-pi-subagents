import assert from "node:assert/strict";
import test from "node:test";
import { FakeProcessTreeAdapter } from "../src/fake-process-tree-adapter.ts";
import { isProcessTreeAdapter } from "../src/process-tree-capability.ts";
import { classifyProcessTreeResources } from "../src/process-tree-resource-boundary.ts";

async function launchTree(adapter: FakeProcessTreeAdapter): Promise<unknown> {
  return (await adapter.launch({ command: "fake-managed-bridge" })).tree;
}

test("FakeProcessTreeAdapter 可确定重现优雅关闭超时后的强制升级", async () => {
  const adapter = new FakeProcessTreeAdapter({
    scenarios: [
      {
        afterGracefulClose: { exit: "present", resources: "present" },
        afterForceTerminate: [{ exit: "exited", resources: "released" }],
      },
    ],
  });
  const tree = await launchTree(adapter);

  await adapter.requestGracefulClose(tree, new AbortController().signal);

  assert.deepEqual(await adapter.waitForExit(tree, 100), { state: "present" });
  assert.deepEqual(await adapter.inspect(tree), { state: "present" });

  await adapter.forceTerminate(tree);
  assert.deepEqual(await adapter.waitForExit(tree, 100), { state: "exited" });
  assert.deepEqual(await adapter.inspect(tree), { state: "released" });
});

test("直接进程退出不掩盖孙进程残留", async () => {
  const adapter = new FakeProcessTreeAdapter({
    scenarios: [
      {
        afterGracefulClose: { exit: "exited", resources: "present" },
      },
    ],
  });
  const tree = await launchTree(adapter);

  await adapter.requestGracefulClose(tree, new AbortController().signal);

  const exit = await adapter.waitForExit(tree, new Date(100));
  const resources = await adapter.inspect(tree);
  assert.deepEqual(classifyProcessTreeResources({ exit, resources }), { state: "present" });
});

test("部分回收保持 present，重试后才得到进程树确认", async () => {
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
  const tree = await launchTree(adapter);

  await adapter.requestGracefulClose(tree, new AbortController().signal);
  await adapter.forceTerminate(tree);
  assert.deepEqual(
    classifyProcessTreeResources({
      exit: await adapter.waitForExit(tree, 100),
      resources: await adapter.inspect(tree),
    }),
    { state: "present" },
  );

  await adapter.forceTerminate(tree);
  assert.deepEqual(
    classifyProcessTreeResources({
      exit: await adapter.waitForExit(tree, 100),
      resources: await adapter.inspect(tree),
    }),
    { state: "confirmed_exited" },
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
  const tree = await launchTree(adapter);

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
  const tree = await launchTree(adapter);

  await adapter.requestGracefulClose(tree, new AbortController().signal);
  const assessment = classifyProcessTreeResources({
    exit: await adapter.waitForExit(tree, 100),
    resources: await adapter.inspect(tree),
  });

  assert.deepEqual(assessment, { state: "unknown" });
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
