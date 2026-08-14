import { readFileSync } from "node:fs";

const RELEASE_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function readJson(relativePath, label) {
  try {
    const bytes = readFileSync(new URL(relativePath, import.meta.url));
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} 不是有效的 UTF-8 JSON`);
  }
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} 缺少有效字符串`);
  }
  return value;
}

function validateReleaseTag(tag) {
  if (typeof tag !== "string" || !RELEASE_TAG_PATTERN.test(tag)) {
    throw new Error("发布 tag 必须严格符合 vX.X.X，例如 v1.2.3");
  }

  const manifest = readJson("../package.json", "package.json");
  const lockfile = readJson("../package-lock.json", "package-lock.json");
  const packageName = requireNonEmptyString(manifest.name, "package.json name");
  const packageVersion = requireNonEmptyString(manifest.version, "package.json version");
  const tagVersion = tag.slice(1);

  if (packageVersion !== tagVersion) {
    throw new Error(`tag 版本 ${tagVersion} 与 package.json 版本 ${packageVersion} 不一致`);
  }
  if (lockfile.name !== packageName || lockfile.version !== packageVersion) {
    throw new Error("package-lock.json 顶层名称或版本与 package.json 不一致");
  }
  const rootPackage = lockfile.packages?.[""];
  if (rootPackage?.name !== packageName || rootPackage?.version !== packageVersion) {
    throw new Error("package-lock.json 根包名称或版本与 package.json 不一致");
  }

  return Object.freeze({ packageName, packageVersion, tag });
}

try {
  const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
  const result = validateReleaseTag(tag);
  console.log(`发布标记校验通过：${result.tag} -> ${result.packageName}@${result.packageVersion}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`发布标记校验失败：${message}`);
  process.exitCode = 1;
}
