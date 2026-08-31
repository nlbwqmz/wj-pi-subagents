import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const compilerPath = join(repositoryRoot, "node_modules", "typescript", "bin", "tsc");

rmSync(join(repositoryRoot, "dist"), { recursive: true, force: true });
const result = spawnSync(process.execPath, [compilerPath, "-p", "tsconfig.bridge.json"], {
  cwd: repositoryRoot,
  stdio: "inherit",
});
if (result.error !== undefined) throw result.error;
if (result.status !== 0) process.exitCode = result.status ?? 1;
