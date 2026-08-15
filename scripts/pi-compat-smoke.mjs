import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
const requiredPiVersion = manifest.wjPiSubagents?.requiresPi;
const extensionEntry = join(repositoryRoot, "index.ts");
const piCommand = process.env.PI_BIN ?? "pi";
const timeoutMs = 15_000;

function parseVersion(value) {
  const match = /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:[-+][^\s]+)?(?:\s|$)/.exec(value);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function requiredVersionTuple(range) {
  const match = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(range ?? "");
  if (match === null) throw new Error("package.json 的 wjPiSubagents.requiresPi 必须是 >=X.Y.Z");
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function runProcess(args, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(piCommand, args, {
      cwd: repositoryRoot,
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Pi 命令超过 ${timeoutMs} ms 未结束`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

function parseJsonLines(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter((value) => value !== undefined);
}

try {
  const versionResult = await runProcess(["--version"]);
  if (versionResult.code !== 0) {
    throw new Error(`无法读取 Pi 版本：${versionResult.stderr.trim() || `退出码 ${versionResult.code}`}`);
  }
  const versionText = `${versionResult.stdout}\n${versionResult.stderr}`;
  const actualVersion = parseVersion(versionText);
  const minimumVersion = requiredVersionTuple(requiredPiVersion);
  if (actualVersion === undefined || compareVersions(actualVersion, minimumVersion) < 0) {
    throw new Error(`Pi 版本不满足 ${requiredPiVersion}：${versionText.trim()}`);
  }

  const rpcResult = await runProcess(
    ["--mode", "rpc", "--no-session", "--offline", "--no-extensions", "-e", extensionEntry],
    `${JSON.stringify({ type: "get_state" })}\n`,
  );
  const messages = parseJsonLines(rpcResult.stdout);
  const stateResponse = messages.find((message) => message?.type === "response" && message.command === "get_state");
  const widgetRequest = messages.find(
    (message) => message?.type === "extension_ui_request"
      && message.method === "setWidget"
      && message.widgetKey === "wj-pi-subagents-agents",
  );
  if (rpcResult.code !== 0) {
    throw new Error(`Pi RPC 退出码 ${rpcResult.code ?? "unknown"}：${rpcResult.stderr.trim()}`);
  }
  if (stateResponse?.success !== true || typeof stateResponse.data?.pendingMessageCount !== "number") {
    throw new Error("Pi RPC 未返回有效的 get_state 响应");
  }
  if (widgetRequest === undefined) {
    throw new Error("扩展未向 Pi 注册 wj-pi-subagents-agents widget");
  }

  console.log(`Pi ${actualVersion.join(".")} 兼容性 smoke 通过：扩展入口、TUI widget、RPC get_state 均正常`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Pi 兼容性 smoke 失败：${message}`);
  process.exitCode = 1;
}
