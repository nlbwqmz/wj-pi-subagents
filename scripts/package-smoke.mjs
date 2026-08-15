import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const smokeRoot = join(repositoryRoot, "package-smoke");

function readPackageMetadata() {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
    throw new Error("package.json 缺少有效的 name 或 version");
  }
  const archivePackageName = manifest.name.startsWith("@")
    ? manifest.name.slice(1).replaceAll("/", "-")
    : manifest.name;
  if (!/^[A-Za-z0-9._-]+$/.test(archivePackageName) || !/^[A-Za-z0-9._+-]+$/.test(manifest.version)) {
    throw new Error("package.json 的包名或版本不能用于生成 tarball 文件名");
  }
  return Object.freeze({
    archiveName: `${archivePackageName}-${manifest.version}.tgz`,
    packageName: manifest.name,
  });
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
  const packageMetadata = readPackageMetadata();
  const archivePath = join(smokeRoot, packageMetadata.archiveName);
  const installedPackagePath = join(smokeRoot, "node_modules", packageMetadata.packageName);
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
  const installedManifestPath = join(installedPackagePath, "package.json");
  if (!existsSync(installedManifestPath)) {
    throw new Error("Smoke 测试包未安装到清单声明的包目录");
  }
  const installedManifest = JSON.parse(readFileSync(installedManifestPath, "utf8"));
  if (installedManifest.license !== "MIT") {
    throw new Error("Smoke 测试包未声明 MIT 许可证");
  }
  if (installedManifest.pi?.extensions?.[0] !== "./index.ts") {
    throw new Error("Smoke 测试包未声明 ./index.ts 扩展入口");
  }
  for (const file of ["index.ts", "LICENSE"]) {
    if (!existsSync(join(installedPackagePath, file))) {
      throw new Error(`Smoke 测试包缺少 ${file}`);
    }
  }
  if (existsSync(join(installedPackagePath, "extensions", "wj-pi-subagents.ts"))) {
    throw new Error("Smoke 测试包仍包含旧扩展入口");
  }
  console.log(`Smoke 测试包已安装：${installedPackagePath}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Smoke 打包失败：${message}`);
  process.exitCode = 1;
}
