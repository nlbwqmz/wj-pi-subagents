import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultNotesDir = join(repositoryRoot, "release-notes");
const defaultOutPath = join(repositoryRoot, "CHANGELOG.md");
const titlePattern = /^#\s+v?(\d+\.\d+\.\d+)\s*$/;
const noteFileNamePattern = /^(v?)(\d+\.\d+\.\d+)\.md$/;
const versionPattern = /^(\d+)\.(\d+)\.(\d+)$/;

function parseArgs(argv) {
  let notesDir = defaultNotesDir;
  let outPath = defaultOutPath;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const separator = argument.indexOf("=");
    const hasInlineValue = argument.startsWith("--") && separator > 2;
    const flag = hasInlineValue ? argument.slice(0, separator) : argument;
    let value = hasInlineValue ? argument.slice(separator + 1) : undefined;

    if (flag !== "--out" && flag !== "--notes-dir") {
      throw new Error(`未知参数 ${argument}；仅支持 --out <path> 与 --notes-dir <dir>`);
    }
    if (!hasInlineValue) {
      value = argv[index + 1];
      index += 1;
    }
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${flag} 需要非空路径参数`);
    }
    if (flag === "--out") outPath = resolve(process.cwd(), value);
    else notesDir = resolve(process.cwd(), value);
  }

  return Object.freeze({ notesDir, outPath });
}

function readUtf8(filePath, label) {
  let bytes;
  try {
    bytes = readFileSync(filePath);
  } catch {
    throw new Error(`${label} 无法读取`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} 不是有效的 UTF-8 文本`);
  }
}

function parseVersion(text) {
  const match = versionPattern.exec(text);
  if (match === null) throw new Error(`版本号 ${text} 不是 X.Y.Z 形状`);
  return Object.freeze({
    text,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  });
}

function compareVersions(left, right) {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

function trimBlankLines(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start += 1;
  while (end > start && lines[end - 1].trim() === "") end -= 1;
  return lines.slice(start, end);
}

function demoteHeadings(lines) {
  const result = [];
  let openFence;

  for (const line of lines) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (openFence !== undefined) {
      result.push(line);
      if (
        fence !== null &&
        fence[1][0] === openFence.character &&
        fence[1].length >= openFence.length &&
        fence[2].trim() === ""
      ) {
        openFence = undefined;
      }
      continue;
    }
    if (fence !== null) {
      openFence = Object.freeze({ character: fence[1][0], length: fence[1].length });
      result.push(line);
      continue;
    }
    const heading = /^ {0,3}(#{1,6})([ \t]+.*)$/.exec(line);
    if (heading === null || heading[1].length >= 6) {
      result.push(line);
      continue;
    }
    result.push(`${heading[1]}#${heading[2]}`);
  }

  return result;
}

function readManifest(errors) {
  let raw;
  try {
    raw = readUtf8(join(repositoryRoot, "package.json"), "package.json");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return undefined;
  }

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    errors.push("package.json 不是有效的 JSON");
    return undefined;
  }
  if (typeof manifest?.version !== "string" || versionPattern.exec(manifest.version) === null) {
    errors.push("package.json 缺少有效的 X.Y.Z 版本号");
    return undefined;
  }
  return Object.freeze({ version: parseVersion(manifest.version) });
}

function collectNotes(notesDir, errors) {
  if (!existsSync(notesDir)) {
    errors.push(`发布说明目录不存在：${notesDir}`);
    return [];
  }

  let fileNames;
  try {
    fileNames = readdirSync(notesDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase() !== "readme.md")
      .map((entry) => entry.name)
      .sort();
  } catch {
    errors.push(`发布说明目录无法读取：${notesDir}`);
    return [];
  }

  const notes = [];
  const seen = new Map();

  for (const fileName of fileNames) {
    const nameMatch = noteFileNamePattern.exec(fileName);
    if (nameMatch === null) continue;

    const hasPrefix = nameMatch[1] === "v";
    const fileVersion = nameMatch[2];
    const label = `发布说明 ${fileName}`;

    if (!hasPrefix) {
      errors.push(`${label} 文件名必须以 v 开头，应为 v${fileVersion}.md`);
    }
    if (seen.has(fileVersion)) {
      errors.push(`版本 ${fileVersion} 重复：${seen.get(fileVersion)} 与 ${fileName}`);
      continue;
    }
    seen.set(fileVersion, fileName);

    let text;
    try {
      text = readUtf8(join(notesDir, fileName), label);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      continue;
    }

    const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);
    const titleMatch = titlePattern.exec(lines[0] ?? "");
    if (titleMatch === null) {
      errors.push(`${label} 第一行必须是 "# vX.Y.Z" 形式的版本标题`);
      continue;
    }
    if (titleMatch[1] !== fileVersion) {
      errors.push(`${label} 标题版本 ${titleMatch[1]} 与文件名版本 ${fileVersion} 不一致`);
      continue;
    }

    const bodyLines = trimBlankLines(lines.slice(1));
    if (bodyLines.length === 0) {
      errors.push(`${label} 的正文为空`);
      continue;
    }

    notes.push(Object.freeze({ version: parseVersion(fileVersion), bodyLines }));
  }

  if (notes.length === 0) {
    errors.push(`目录 ${notesDir} 中没有可用的 vX.Y.Z.md 发布说明文件`);
  }

  notes.sort((left, right) => compareVersions(right.version, left.version));
  return notes;
}

function renderChangelog(notes) {
  const sections = notes.map((note) => {
    const body = demoteHeadings(note.bodyLines).join("\n");
    return `## [${note.version.text}]\n\n${body}`;
  });
  return `${sections.join("\n\n")}\n`;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error("CHANGELOG 生成失败：");
    console.error(`- ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  const errors = [];
  const notes = collectNotes(options.notesDir, errors);
  const manifest = readManifest(errors);

  if (manifest !== undefined && notes.length > 0) {
    const newest = notes[0].version;
    if (compareVersions(newest, manifest.version) !== 0) {
      errors.push(
        `发布说明最大版本 ${newest.text} 与 package.json 版本 ${manifest.version.text} 不一致`,
      );
    }
  }

  if (errors.length > 0) {
    console.error("CHANGELOG 生成失败：");
    for (const message of errors) console.error(`- ${message}`);
    process.exitCode = 1;
    return;
  }

  const content = renderChangelog(notes);
  try {
    mkdirSync(dirname(options.outPath), { recursive: true });
    writeFileSync(options.outPath, content, "utf8");
  } catch (error) {
    console.error("CHANGELOG 生成失败：");
    console.error(`- 无法写入 ${options.outPath}：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  console.log(`CHANGELOG 已生成：${options.outPath}（${notes.length} 个版本）`);
}

main();
