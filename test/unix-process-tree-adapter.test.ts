import assert from "node:assert/strict";
import test from "node:test";
import {
  UnixProcessTreeAdapter,
  UnixProcessTreeLaunchError,
  type UnixProcessTreeLaunch,
} from "../src/unix-process-tree-adapter.ts";
import { classifyProcessTreeResources } from "../src/process-tree-resource-boundary.ts";

const isUnix = process.platform === "darwin" || process.platform === "linux";
const nativeTestOptions = { skip: !isUnix };

function deadlineAfter(milliseconds: number): number {
  return Date.now() + milliseconds;
}

async function waitForResources(
  adapter: UnixProcessTreeAdapter,
  launch: UnixProcessTreeLaunch,
  expected: "released" | "present" | "unknown",
): Promise<void> {
  const deadline = deadlineAfter(5_000);
  while (Date.now() < deadline) {
    if ((await adapter.inspect(launch.tree)).state === expected) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`等待资源状态 ${expected} 超时`);
}

async function forceRelease(
  adapter: UnixProcessTreeAdapter,
  launch: UnixProcessTreeLaunch,
): Promise<void> {
  try {
    await adapter.forceTerminate(launch.tree);
  } finally {
    await adapter.release(launch.tree);
  }
}

function nodeLaunch(code: string): Parameters<UnixProcessTreeAdapter["launch"]>[0] {
  return {
    command: process.execPath,
    args: ["-e", code],
  };
}

test("Unix process group 在启动时归属直接子进程，并在优雅 EOF 后确认回收", nativeTestOptions, async () => {
  const adapter = new UnixProcessTreeAdapter();
  const launch = await adapter.launch(nodeLaunch(`
    process.stdin.resume();
    process.stdin.on("end", () => process.exit(0));
  `));

  try {
    assert.equal(adapter.strategy, "process_group_or_session");
    assert.deepEqual(await adapter.inspect(launch.tree), { state: "present" });

    await adapter.requestGracefulClose(launch.tree, new AbortController().signal);
    assert.deepEqual(await adapter.waitForExit(launch.tree, deadlineAfter(5_000)), {
      state: "exited",
    });
    await waitForResources(adapter, launch, "released");

    assert.deepEqual(
      classifyProcessTreeResources({
        exit: await adapter.waitForExit(launch.tree, deadlineAfter(1_000)),
        resources: await adapter.inspect(launch.tree),
      }),
      { state: "confirmed_exited" },
    );
  } finally {
    await forceRelease(adapter, launch);
  }
});

test("直接子进程退出但同组孙进程残留时保持 present，强制阶段回收整组", nativeTestOptions, async () => {
  const adapter = new UnixProcessTreeAdapter();
  let launch: UnixProcessTreeLaunch | undefined;
  try {
    launch = await adapter.launch(nodeLaunch(`
      const { spawn } = require("node:child_process");
      spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], { stdio: "ignore" });
      process.exit(0);
    `));

    assert.deepEqual(await adapter.waitForExit(launch.tree, deadlineAfter(5_000)), {
      state: "exited",
    });
    await waitForResources(adapter, launch, "present");

    await adapter.forceTerminate(launch.tree);
    await waitForResources(adapter, launch, "released");
  } finally {
    if (launch !== undefined) await forceRelease(adapter, launch);
  }
});

test("优雅期限超时后保持 present，重复强制回收最终确认 released", nativeTestOptions, async () => {
  const adapter = new UnixProcessTreeAdapter();
  const launch = await adapter.launch(nodeLaunch("setInterval(() => {}, 1_000);"));

  try {
    await adapter.requestGracefulClose(launch.tree, new AbortController().signal);
    assert.deepEqual(await adapter.waitForExit(launch.tree, deadlineAfter(100)), {
      state: "present",
    });
    assert.deepEqual(await adapter.inspect(launch.tree), { state: "present" });

    await adapter.forceTerminate(launch.tree);
    await adapter.forceTerminate(launch.tree);
    await waitForResources(adapter, launch, "released");
  } finally {
    await forceRelease(adapter, launch);
  }
});

test("释放未确认的活动句柄时保持 unknown 且重复释放幂等", nativeTestOptions, async () => {
  const adapter = new UnixProcessTreeAdapter();
  const launch = await adapter.launch(nodeLaunch("setInterval(() => {}, 1_000);"));

  await adapter.release(launch.tree);
  await assert.doesNotReject(() => adapter.release(launch.tree));
  assert.deepEqual(await adapter.inspect(launch.tree), { state: "unknown" });
  assert.deepEqual(await adapter.waitForExit(launch.tree, deadlineAfter(5_000)), {
    state: "unknown",
  });
});

test("Unix 适配器拒绝无效启动并处理取消的优雅关闭", nativeTestOptions, async () => {
  const adapter = new UnixProcessTreeAdapter();
  await assert.rejects(
    adapter.launch({ command: `wj-pi-subagents-missing-${Date.now()}` }),
    (error: unknown) => {
      assert.ok(error instanceof UnixProcessTreeLaunchError);
      assert.equal(error.cleanup, "released");
      assert.equal(error.tree, undefined);
      return true;
    },
  );
  const launch = await adapter.launch(nodeLaunch("setInterval(() => {}, 1_000);"));
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      adapter.requestGracefulClose(launch.tree, controller.signal),
      /优雅关闭请求已取消/,
    );
  } finally {
    await forceRelease(adapter, launch);
  }
});

test("非 Unix 宿主上的 Unix 适配器不通过能力门禁", { skip: isUnix }, () => {
  const adapter = new UnixProcessTreeAdapter({ platform: "linux" });
  assert.equal(adapter.available, false);
});
