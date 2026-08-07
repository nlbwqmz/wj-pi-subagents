import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const smokeRoot = join(repositoryRoot, ".scratch", "package-smoke");

function readPackageArchiveName() {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
    throw new Error("package.json 缺少有效的 name 或 version");
  }
  const packageName = manifest.name.startsWith("@")
    ? manifest.name.slice(1).replaceAll("/", "-")
    : manifest.name;
  if (!/^[A-Za-z0-9._-]+$/.test(packageName) || !/^[A-Za-z0-9._+-]+$/.test(manifest.version)) {
    throw new Error("package.json 的包名或版本不能用于生成 tarball 文件名");
  }
  return `${packageName}-${manifest.version}.tgz`;
}

function runNpm(args) {
  const npmCliPath = process.env.npm_execpath;
  const command = npmCliPath === undefined ? "npm" : process.execPath;
  const commandArgs = npmCliPath === undefined ? args : [npmCliPath, ...args];
  const result = spawnSync(command, commandArgs, {
    cwd: repositoryRoot,
    stdio: "inherit",
    shell: npmCliPath === undefined && process.platform === "win32",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args[0]} 执行失败`);
}

try {
  mkdirSync(smokeRoot, { recursive: true });
  const archivePath = join(smokeRoot, readPackageArchiveName());
  runNpm(["pack", "--pack-destination", smokeRoot]);
  if (!existsSync(archivePath)) throw new Error("npm pack 未生成预期 tarball");
  runNpm([
    "install",
    "--prefix",
    smokeRoot,
    "--omit=dev",
    "--legacy-peer-deps",
    "--package-lock=false",
    "--no-save",
    archivePath,
  ]);
  console.log(`Smoke 测试包已安装：${join(smokeRoot, "node_modules", "pi-subagent")}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Smoke 打包失败：${message}`);
  process.exitCode = 1;
}
