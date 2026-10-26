const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const COMBINING_MARK_PATTERN = /^\p{Mark}$/u;
const EXTENDED_PICTOGRAPHIC_PATTERN = /\p{Extended_Pictographic}/u;
const REGIONAL_INDICATOR_PATTERN = /\p{Regional_Indicator}/u;
const TERMINAL_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/gu;
const DISPLAY_WIDTH_CACHE_LIMIT = 512;
const CODE_POINT_WIDTH_CACHE_LIMIT = 4_096;

/**
 * 宿主每帧都会重新渲染整棵组件树，同一批整行会被反复求宽；有界 LRU 缓存
 * 把重复测量压成一次查表，超出上限时逐个淘汰最久未使用的项。
 */
const displayWidthCache = new Map<string, number>();
/** 码点宽度只依赖码点本身；中文正文几十万次调用通常只有几千个不同码点。 */
const codePointWidthCache = new Map<number, number>();

export type UiPanelLineStyle = "header" | "body" | "terminal" | "error" | "footer" | "accent" | "warning";

interface UiPanelTheme {
  fg?(color: string, text: string): string;
  bg?(color: string, text: string): string;
  bold?(text: string): string;
}

/** 计算无 ANSI 文本的终端列宽，避免按 UTF-16 单元切断 Unicode 字符。 */
export function displayWidth(value: string): number {
  const cached = displayWidthCache.get(value);
  if (cached !== undefined) {
    // 命中即刷新顺序，保证容量满时淘汰的是最久未使用的键。
    displayWidthCache.delete(value);
    displayWidthCache.set(value, cached);
    return cached;
  }
  let width = 0;
  for (const { segment } of SEGMENTER.segment(value)) width += graphemeWidth(segment);
  rememberDisplayWidth(value, width);
  return width;
}

function rememberDisplayWidth(value: string, width: number): void {
  evictOldestEntry(displayWidthCache, DISPLAY_WIDTH_CACHE_LIMIT);
  displayWidthCache.set(value, width);
}

function evictOldestEntry<K, V>(cache: Map<K, V>, limit: number): void {
  if (cache.size < limit) return;
  const oldest = cache.keys().next();
  if (oldest.done !== true) cache.delete(oldest.value);
}

/** 超宽时保留一个省略号，并始终在字素簇边界截断。 */
export function truncateToDisplayWidth(value: string, width: number): string {
  if (!Number.isSafeInteger(width) || width <= 0) return "";
  if (displayWidth(value) <= width) return value;
  if (width === 1) return "…";
  const available = width - 1;
  let used = 0;
  let output = "";
  for (const { segment } of SEGMENTER.segment(value)) {
    const next = graphemeWidth(segment);
    if (used + next > available) break;
    output += segment;
    used += next;
  }
  return `${output}…`;
}

/** 将外部可命名事实约束为单行纯文本，阻断 ANSI、换行与方向控制注入。 */
export function safeUiFact(value: string): string {
  return value.replace(TERMINAL_CONTROL_PATTERN, " ").replace(/ {2,}/g, " ").trim();
}

export function themeFg(theme: unknown, color: string, text: string): string {
  if (typeof theme !== "object" || theme === null) return text;
  const candidate = theme as UiPanelTheme;
  if (typeof candidate.fg !== "function") return text;
  try {
    const styled = candidate.fg.call(candidate, color, text);
    return typeof styled === "string" ? styled : text;
  } catch {
    return text;
  }
}

export function themeBg(theme: unknown, color: string, text: string): string {
  if (typeof theme !== "object" || theme === null) return text;
  const candidate = theme as UiPanelTheme;
  if (typeof candidate.bg !== "function") return text;
  try {
    const styled = candidate.bg.call(candidate, color, text);
    return typeof styled === "string" ? styled : text;
  } catch {
    return text;
  }
}

export function themeBold(theme: unknown, text: string): string {
  if (typeof theme !== "object" || theme === null) return text;
  const candidate = theme as UiPanelTheme;
  if (typeof candidate.bold !== "function") return text;
  try {
    const styled = candidate.bold.call(candidate, text);
    return typeof styled === "string" ? styled : text;
  } catch {
    return text;
  }
}

export function padToDisplayWidth(value: string, width: number): string {
  const truncated = truncateToDisplayWidth(value, width);
  return `${truncated}${" ".repeat(Math.max(0, width - displayWidth(truncated)))}`;
}

export function stylePanelText(value: string, style: UiPanelLineStyle, theme: unknown): string {
  switch (style) {
    case "header":
      return themeFg(theme, "accent", themeBold(theme, value));
    case "body":
      return themeFg(theme, "customMessageText", value);
    case "error":
      return themeFg(theme, "error", value);
    case "accent":
      return themeFg(theme, "accent", value);
    case "warning":
      return themeFg(theme, "warning", value);
    case "footer":
    case "terminal":
      return themeFg(theme, "dim", value);
  }
}

export function renderPanelRule(
  width: number,
  position: "top" | "divider" | "bottom",
  theme: unknown,
): string {
  const [left, fill, right] = position === "top"
    ? ["┏", "━", "┓"]
    : position === "bottom"
      ? ["┗", "━", "┛"]
      : ["┣", "━", "┫"];
  const color = position === "divider" ? "border" : "borderAccent";
  const rule = `${left}${fill.repeat(Math.max(0, width - 2))}${right}`;
  return themeBg(theme, "customMessageBg", themeFg(theme, color, rule));
}

export function renderFramedPanelLine(
  value: string,
  contentWidth: number,
  style: UiPanelLineStyle,
  selected: boolean,
  theme: unknown,
  errorTail?: string,
): string {
  const segmented = renderSegmentedText(value, contentWidth, style, theme, errorTail);
  if (segmented !== undefined) {
    const borderColor = style === "header" || selected ? "borderAccent" : "border";
    const pad = " ".repeat(Math.max(0, contentWidth - displayWidth(value)));
    const line = `${themeFg(theme, borderColor, "┃")} ${segmented}${pad} ${themeFg(theme, borderColor, "┃")}`;
    return themeBg(theme, selected ? "selectedBg" : "customMessageBg", line);
  }
  const padded = padToDisplayWidth(value, contentWidth);
  const borderColor = style === "header" || selected ? "borderAccent" : "border";
  const line = `${themeFg(theme, borderColor, "┃")} ${stylePanelText(padded, style, theme)} ${themeFg(theme, borderColor, "┃")}`;
  return themeBg(theme, selected ? "selectedBg" : "customMessageBg", line);
}

export function renderNarrowPanelLine(
  value: string,
  width: number,
  style: UiPanelLineStyle,
  selected: boolean,
  theme: unknown,
  errorTail?: string,
): string {
  const segmented = renderSegmentedText(value, width, style, theme, errorTail);
  if (segmented !== undefined) {
    const pad = " ".repeat(Math.max(0, width - displayWidth(value)));
    return themeBg(
      theme,
      selected ? "selectedBg" : "customMessageBg",
      `${segmented}${pad}`,
    );
  }
  const padded = padToDisplayWidth(value, width);
  return themeBg(
    theme,
    selected ? "selectedBg" : "customMessageBg",
    stylePanelText(padded, style, theme),
  );
}

/**
 * 行尾局部错误片段：value 以 errorTail 结尾且整体不超宽时，前段保持行样式、
 * 行尾片段使用错误色；否则返回 undefined，由调用方按整行样式渲染。
 */
function renderSegmentedText(
  value: string,
  width: number,
  style: UiPanelLineStyle,
  theme: unknown,
  errorTail: string | undefined,
): string | undefined {
  if (errorTail === undefined || errorTail.length === 0 || !value.endsWith(errorTail)) {
    return undefined;
  }
  const head = value.slice(0, value.length - errorTail.length);
  if (displayWidth(head) + displayWidth(errorTail) > width) return undefined;
  return `${stylePanelText(head, style, theme)}${stylePanelText(errorTail, "error", theme)}`;
}

export function graphemeWidth(grapheme: string): number {
  if (EXTENDED_PICTOGRAPHIC_PATTERN.test(grapheme) || REGIONAL_INDICATOR_PATTERN.test(grapheme)) return 2;
  let width = 0;
  for (const character of grapheme) width += codePointWidth(character);
  return width;
}

function codePointWidth(character: string): number {
  const codePoint = character.codePointAt(0) ?? 0;
  const cached = codePointWidthCache.get(codePoint);
  if (cached !== undefined) return cached;
  const width = measureCodePointWidth(codePoint, character);
  evictOldestEntry(codePointWidthCache, CODE_POINT_WIDTH_CACHE_LIMIT);
  codePointWidthCache.set(codePoint, width);
  return width;
}

function measureCodePointWidth(codePoint: number, character: string): number {
  if (
    codePoint === 0
    || codePoint < 32
    || (codePoint >= 0x7f && codePoint < 0xa0)
    || codePoint === 0x200d
    || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
    || (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
    || COMBINING_MARK_PATTERN.test(character)
  ) return 0;
  return isWideCodePoint(codePoint) ? 2 : 1;
}

function isWideCodePoint(codePoint: number): boolean {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}
