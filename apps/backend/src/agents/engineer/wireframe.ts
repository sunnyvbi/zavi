
export type WireframeFile = {
  path: string;
  action: "create" | "modify" | "delete";
  diff?: string;
  content?: string;
};

const PR_BODY_MAX_CHARS = 8000;
const WIREFRAME_MAX_CHARS = 2200;
const MIN_WIREFRAME_BUDGET = 500;
const MAX_WIREFRAME_FILES = 4;
const MAX_SNIPPETS_PER_KIND = 5;
const FRAME_WIDTH = 74;

const UI_EXTENSION_RE = /\.(tsx|jsx|vue|svelte|html|css|scss|sass|less)$/i;
const UI_PATH_RE = /(^|\/)(app|pages|components|screens|views|ui|web|mobile)(\/|$)/i;
const NON_REVIEW_UI_RE =
  /(^|\/)(__tests__|test|tests|e2e|fixtures|snapshots|dist|build)(\/|$)|\.(test|spec|stories)\.[^.]+$/i;

const ATTR_TEXT_RE =
  /\b(?:aria-label|title|placeholder|alt|label|value)\s*=\s*["']([^"']{2,90})["']/g;
const JSX_TEXT_RE = />\s*([^<>{}\n][^<>{}\n]{1,90})\s*</g;
const QUOTED_TEXT_RE = /["'`]([^"'`{}<>]{3,90})["'`]/g;
const CSS_PROP_RE =
  /^\s*([a-z-]{3,40})\s*:\s*([^;{}]{1,60});?\s*$/i;

export function isUiReviewFile(path: string): boolean {
  const p = normalizePath(path);
  if (!UI_EXTENSION_RE.test(p)) return false;
  if (NON_REVIEW_UI_RE.test(p)) return false;
  return UI_PATH_RE.test(p) || UI_EXTENSION_RE.test(p);
}

export function buildUiWireframe(files: readonly WireframeFile[]): string | null {
  const uiFiles = files
    .filter((f) => isUiReviewFile(f.path))
    .slice(0, MAX_WIREFRAME_FILES);

  if (uiFiles.length === 0) return null;

  const blocks = uiFiles
    .map((file) => renderFileWireframe(file))
    .filter((block): block is string => block.length > 0);
  if (blocks.length === 0) return null;

  const omittedCount = files.filter((f) => isUiReviewFile(f.path)).length - uiFiles.length;
  const omitted =
    omittedCount > 0
      ? `\n\n_${omittedCount} additional UI file${omittedCount === 1 ? "" : "s"} omitted from this compact wireframe._`
      : "";

  return [
    "### Wireframe",
    "",
    "Agent-generated review aid, not pixel-perfect. Derived from changed UI files in this PR.",
    "",
    "```text",
    blocks.join("\n\n"),
    "```",
    omitted,
  ].join("\n").trimEnd();
}

export function appendUiWireframeToPrBody(
  body: unknown,
  files: readonly WireframeFile[],
): string {
  const base = typeof body === "string" ? body.trimEnd() : "";
  const clampedBase = base.slice(0, PR_BODY_MAX_CHARS);
  if (/^###\s+Wireframe\b/im.test(clampedBase)) return clampedBase;

  const wireframe = buildUiWireframe(files);
  if (!wireframe) return clampedBase;

  const separator = clampedBase.length > 0 ? "\n\n" : "";
  const budget = PR_BODY_MAX_CHARS - clampedBase.length - separator.length;
  if (budget < MIN_WIREFRAME_BUDGET) return clampedBase;

  const sectionBudget = Math.min(budget, WIREFRAME_MAX_CHARS);
  const section =
    wireframe.length > sectionBudget
      ? truncateWireframe(wireframe, sectionBudget)
      : wireframe;

  return `${clampedBase}${separator}${section}`.slice(0, PR_BODY_MAX_CHARS);
}

function renderFileWireframe(file: WireframeFile): string {
  const addedLines = changedLines(file, "+");
  const removedLines = changedLines(file, "-");
  const addedText = extractVisibleSnippets(addedLines);
  const removedText = extractVisibleSnippets(removedLines);
  const actionText = extractActionSnippets(addedLines);
  const styleText = extractStyleSnippets(addedLines);

  const rows: string[] = [`file: ${file.path}`];
  if (file.action === "delete") {
    rows.push("state: removed UI surface");
  }
  if (removedText.length > 0) {
    rows.push(`before: ${quoteList(removedText)}`);
  }
  if (addedText.length > 0) {
    rows.push(`after : ${quoteList(addedText)}`);
  }
  if (actionText.length > 0) {
    rows.push(`action: ${actionText.map((s) => `[${s}]`).join(" ")}`);
  }
  if (styleText.length > 0) {
    rows.push(`style : ${styleText.join("; ")}`);
  }
  if (rows.length === 1) {
    rows.push("change: layout/style updated; no visible copy detected");
  }

  return frame(componentLabel(file.path), rows);
}

function changedLines(file: WireframeFile, sign: "+" | "-"): string[] {
  const diff = typeof file.diff === "string" ? file.diff : "";
  if (!diff && sign === "+" && file.action === "create" && file.content) {
    return file.content.split("\n");
  }
  if (!diff) return [];

  const out: string[] = [];
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    if (raw.startsWith(sign)) out.push(raw.slice(1));
  }
  return out;
}

function extractVisibleSnippets(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || isCodeOnlyLine(line)) continue;

    collectMatches(line, ATTR_TEXT_RE, out);
    collectMatches(line, JSX_TEXT_RE, out);

    if (!/\b(className|class|style|id|data-testid|data-test|href|src)\s*=/.test(line)) {
      collectMatches(line, QUOTED_TEXT_RE, out);
    }

    const bare = line
      .replace(/<[^>]+>/g, " ")
      .replace(/\{[^}]*\}/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (isHumanText(bare)) out.push(bare);
  }
  return uniqueSnippets(out).slice(0, MAX_SNIPPETS_PER_KIND);
}

function extractActionSnippets(lines: readonly string[]): string[] {
  const actionLines = lines.filter((line) =>
    /<\s*(button|Button|Link|a)\b|onClick\b|role\s*=\s*["']button["']|type\s*=\s*["']submit["']/i.test(
      line,
    ),
  );
  return extractVisibleSnippets(actionLines).slice(0, 3);
}

function extractStyleSnippets(lines: readonly string[]): string[] {
  const snippets: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    const match = CSS_PROP_RE.exec(line);
    if (!match) continue;
    const prop = match[1].toLowerCase();
    if (
      !/^(display|position|grid|grid-template|grid-template-columns|flex|gap|padding|margin|width|height|min-height|max-width|color|background|border|border-radius|font-size|line-height|align-items|justify-content)$/.test(
        prop,
      )
    ) {
      continue;
    }
    snippets.push(`${prop}: ${match[2].trim()}`);
  }
  return uniqueSnippets(snippets).slice(0, 3);
}

function collectMatches(
  line: string,
  regex: RegExp,
  out: string[],
): void {
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(line)) !== null) {
    if (isHumanText(match[1])) out.push(match[1].trim());
  }
}

function uniqueSnippets(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = cleanSnippet(value);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function isHumanText(value: string): boolean {
  const s = cleanSnippet(value);
  if (s.length < 2 || s.length > 90) return false;
  if (!/[A-Za-z]/.test(s)) return false;
  if (/[{};<>]/.test(s)) return false;
  if (/^(use client|use server|true|false|null|undefined|noopener|noreferrer)$/i.test(s)) {
    return false;
  }
  if (/^[a-z0-9_-]{12,}$/i.test(s) && !/\s/.test(s)) return false;
  if (/^(https?:|\/|#)/i.test(s)) return false;
  return true;
}

function isCodeOnlyLine(line: string): boolean {
  return /^(import|export|const|let|var|type|interface|function|return|if|for|while)\b/.test(
    line,
  );
}

function cleanSnippet(value: string): string {
  return value
    .replace(/[`|]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
}

function quoteList(values: readonly string[]): string {
  return values.map((value) => `"${value}"`).join(", ");
}

function componentLabel(path: string): string {
  const normalized = normalizePath(path);
  const file = normalized.split("/").pop() ?? normalized;
  const stem = file.replace(/\.[^.]+$/, "");
  if (stem === "page" || stem === "index") {
    const parent = normalized.split("/").slice(-2, -1)[0] ?? stem;
    return `${toTitle(parent)} ${toTitle(stem)}`;
  }
  return toTitle(stem);
}

function toTitle(value: string): string {
  const words = value
    .replace(/\[[^\]]+\]/g, "")
    .replace(/[()]/g, "")
    .split(/[-_\s.]+/)
    .filter(Boolean);
  const title = words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
  return title || "UI Change";
}

function frame(title: string, rows: readonly string[]): string {
  const top = `+${"-".repeat(FRAME_WIDTH - 2)}+`;
  const bodyRows = [`${title}`, ...rows].flatMap((row) => wrapRow(row));
  return [top, ...bodyRows, top].join("\n");
}

function wrapRow(value: string): string[] {
  const innerWidth = FRAME_WIDTH - 4;
  const safe = cleanFrameText(value);
  const chunks: string[] = [];
  let remaining = safe;
  while (remaining.length > innerWidth) {
    let splitAt = remaining.lastIndexOf(" ", innerWidth);
    if (splitAt < innerWidth * 0.5) splitAt = innerWidth;
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  chunks.push(remaining);
  return chunks.map((chunk) => `| ${chunk.padEnd(innerWidth, " ")} |`);
}

function cleanFrameText(value: string): string {
  return value.replace(/[`|]/g, "'").replace(/\s+/g, " ").trim();
}

function truncateWireframe(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const suffix = "\n```";
  const note = "\n[wireframe truncated to fit PR body limit]";
  const budget = Math.max(0, maxChars - suffix.length - note.length);
  const closingFence = value.lastIndexOf("\n```");
  const withoutFence = closingFence >= 0 ? value.slice(0, closingFence) : value;
  return `${withoutFence.slice(0, budget).trimEnd()}${note}${suffix}`;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}
