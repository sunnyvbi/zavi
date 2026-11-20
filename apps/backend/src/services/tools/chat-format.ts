
import { rewriteActionLinks } from "./slack/mrkdwn";

const CELL_MAX = 40;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function isRuleRow(line: string): boolean {
  if (!line.includes("|")) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c));
}

function isTableRow(line: string): boolean {
  return line.includes("|");
}

function renderTable(lines: string[], fence: boolean): string {
  const rows = lines.map(splitRow);
  const hasRule = lines.length > 1 && isRuleRow(lines[1]);
  const header = rows[0];
  const body = rows.slice(hasRule ? 2 : 1);
  const width = Math.max(header.length, ...body.map((r) => r.length));
  const norm = (r: string[]) =>
    Array.from({ length: width }, (_, i) => (r[i] ?? "").slice(0, CELL_MAX));
  const all = [norm(header), ...body.map(norm)];
  const colW = Array.from({ length: width }, (_, i) =>
    Math.max(...all.map((r) => r[i].length)),
  );
  const fmt = (r: string[]) =>
    r
      .map((c, i) => (i === width - 1 ? c : c.padEnd(colW[i])))
      .join("  ")
      .trimEnd();
  const out = [fmt(all[0]), colW.map((w) => "-".repeat(w)).join("  ")];
  for (const r of all.slice(1)) out.push(fmt(r));
  const text = out.join("\n");
  return fence ? "```\n" + text + "\n```" : text;
}

export function flattenMarkdownTables(text: string, opts: { fence: boolean }): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (i + 1 < lines.length && isTableRow(lines[i]) && isRuleRow(lines[i + 1])) {
      const block: string[] = [lines[i], lines[i + 1]];
      let j = i + 2;
      while (j < lines.length && isTableRow(lines[j]) && lines[j].trim() !== "") {
        block.push(lines[j]);
        j++;
      }
      out.push(renderTable(block, opts.fence));
      i = j;
      continue;
    }
    out.push(lines[i]);
    i++;
  }
  return out.join("\n");
}

export function stripInlineMarkdown(text: string): string {
  return (
    text
      .replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, "$1")
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 ($2)")
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/(^|[^_\w])__(?!\s)([^_\n]+?)__(?!\w)/g, "$1$2")
      .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, "$1$2")
      .replace(/(^|[^_\w])_(?!\s)([^_\n]+?)_(?!\w)/g, "$1$2")
      .replace(/`([^`\n]+)`/g, "$1")
      .replace(/^(\s*)[-*]\s+/gm, "$1• ")
  );
}

export function formatForDiscord(text: string): string {
  return flattenMarkdownTables(text, { fence: true });
}

export function formatForTelegram(text: string): string {
  return flattenMarkdownTables(stripInlineMarkdown(rewriteActionLinks(text)), { fence: false });
}

export const formatForIMessage = formatForTelegram;

export function formatForWhatsApp(text: string): string {
  const translated = rewriteActionLinks(text)
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*$/gm, "*$1*")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 ($2)")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/(^|[^_\w])__(?!\s)([^_\n]+?)__(?!\w)/g, "$1*$2*")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^(\s*)[-*]\s+/gm, "$1• ");
  return flattenMarkdownTables(translated, { fence: true });
}
