import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  WindowsJobObjectAdapter,
  type WindowsJobObjectLaunch,
} from "../src/windows-job-object-adapter.ts";
import { classifyProcessTreeResources } from "../src/process-tree-resource-boundary.ts";

const isWindows = process.platform === "win32";
const nativeTestOptions = { skip: !isWindows };

function deadlineAfter(milliseconds: number): number {
  return Date.now() + milliseconds;
}

async function waitForResources(
  adapter: WindowsJobObjectAdapter,
  launch: WindowsJobObjectLaunch,
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
  adapter: WindowsJobObjectAdapter,
  launch: WindowsJobObjectLaunch,
): Promise<void> {
  try {
    await adapter.forceTerminate(launch.tree);
  } finally {
    await adapter.release(launch.tree);
  }
}

function nodeLaunch(code: string): Parameters<WindowsJobObjectAdapter["launch"]>[0] {
  return {
    command: process.execPath,
    args: ["-e", code],
  };
}

test("Windows Job Object 在启动前绑定直接子进程，并在优雅 EOF 后确认回收", nativeTestOptions, async () => {
  const adapter = new WindowsJobObjectAdapter();
  const launch = await adapter.launch(nodeLaunch(`
    process.stdin.resume();
    process.stdin.on("end", () => process.exit(0));
  `));

  try {
    assert.equal(adapter.platform, "win32");
    assert.equal(adapter.strategy, "job_object");
    assert.deepEqual(await adapter.inspect(launch.tree), { state: "present" });

    await adapter.requestGracefulClose(launch.tree, new AbortController().signal);
    assert.deepEqual(await adapter.waitForExit(launch.tree, deadlineAfter(5_000)), {
      state: "exited",
    });
    await waitForResources(adapter, launch, "released");
  } finally {
    await forceRelease(adapter, launch);
  }
});

test("Windows Job Object 启动失败时完成 helper 回滚", nativeTestOptions, async () => {
  const adapter = new WindowsJobObjectAdapter();

  await assert.rejects(
    adapter.launch({ command: `C:\\pi-subagent-missing-${randomUUID()}.exe` }),
    /Windows Job Object helper 未就绪/,
  );
});

test("Windows Job Object 保留孙进程存在事实，并能一次强制回收整棵树", nativeTestOptions, async () => {
  const adapter = new WindowsJobObjectAdapter();
  let launch: WindowsJobObjectLaunch | undefined;
  try {
    launch = await adapter.launch(nodeLaunch(`
      const { spawn } = require("node:child_process");
      const grandchild = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1_000)"],
        { detached: true, stdio: "ignore" },
      );
      grandchild.unref();
      process.exit(0);
    `));

    assert.deepEqual(await adapter.waitForExit(launch.tree, deadlineAfter(5_000)), {
      state: "exited",
    });
    await waitForResources(adapter, launch, "present");

    await adapter.forceTerminate(launch.tree);
    await waitForResources(adapter, launch, "released");
  } finally {
    if (launch !== undefined) {
      await forceRelease(adapter, launch);
    }
  }
});

test("Windows Job Object 在优雅期限超时后保持 present，强制阶段才确认回收", nativeTestOptions, async () => {
  const adapter = new WindowsJobObjectAdapter();
  const launch = await adapter.launch(nodeLaunch("setInterval(() => {}, 1_000);"));

  try {
    await adapter.requestGracefulClose(launch.tree, new AbortController().signal);
    assert.deepEqual(await adapter.waitForExit(launch.tree, deadlineAfter(100)), {
      state: "present",
    });
    assert.deepEqual(await adapter.inspect(launch.tree), { state: "present" });

    await adapter.forceTerminate(launch.tree);
    await waitForResources(adapter, launch, "released");
  } finally {
    await forceRelease(adapter, launch);
  }
});

test("Windows Job Object 释放未确认的活动句柄时不伪造 terminated", nativeTestOptions, async () => {
  const adapter = new WindowsJobObjectAdapter();
  const launch = await adapter.launch(nodeLaunch("setInterval(() => {}, 1_000);"));

  await adapter.release(launch.tree);
  assert.deepEqual(await adapter.inspect(launch.tree), { state: "unknown" });

  const assessment = classifyProcessTreeResources({
    exit: await adapter.waitForExit(launch.tree, deadlineAfter(5_000)),
    resources: await adapter.inspect(launch.tree),
  });
  assert.notDeepEqual(assessment, { state: "confirmed_exited" });
});
