
import type { TableBlock } from "@zavi/shared";

const MAX_COLUMNS = 8;
const MAX_ROWS = 50;
const MAX_CELL = 200;
const MAX_LABEL = 80;
const MAX_TITLE = 120;
const MAX_NOTE = 300;

function lastNonEmpty(lines: string[]): number {
  for (let k = lines.length - 1; k >= 0; k--) if (lines[k].trim()) return k;
  return -1;
}

export interface LiftedTables {
  body: string;
  tables: Omit<TableBlock, "kind">[];
}

function cells(line: string): string[] {
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return t.split("|").map((c) => c.trim());
}

function isSeparator(line: string): boolean {
  const cs = cells(line);
  return cs.length > 0 && cs.every((c) => /^:?-{3,}:?$/.test(c));
}

function isRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line);
}

function plain(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1").trim();
}

function nameFromColumns(columns: string[]): string {
  if (columns.length < 2) return columns[0] ?? "Table";
  const measures = columns.slice(1);
  const list =
    measures.length === 1
      ? measures[0]
      : `${measures.slice(0, -1).join(", ")} and ${measures[measures.length - 1]}`;
  return `${list} by ${columns[0].toLowerCase()}`;
}

function titleFrom(prev: string | undefined, columns: string[]): string {
  const p = (prev ?? "").trim();
  const heading = p.match(/^#{1,6}\s+(.+)$/)?.[1] ?? p.match(/^\*\*(.+?)\*\*:?$/)?.[1];
  const title = heading ? plain(heading) : nameFromColumns(columns);
  return title.slice(0, MAX_TITLE) || "Table";
}

export function liftMarkdownTables(text: string): LiftedTables {
  const lines = text.split("\n");
  const out: string[] = [];
  const tables: LiftedTables["tables"] = [];
  let fence: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
    if (f) {
      if (!fence) fence = f;
      else if (f[0] === fence[0] && f.length >= fence.length) fence = null;
      out.push(line);
      continue;
    }
    if (fence || !isRow(line) || !lines[i + 1] || !isSeparator(lines[i + 1])) {
      out.push(line);
      continue;
    }
    const columns = cells(line).map(plain);
    let j = i + 2;
    const rows: string[][] = [];
    let ragged = false;
    while (j < lines.length && isRow(lines[j])) {
      const r = cells(lines[j]).map(plain);
      if (r.length !== columns.length) ragged = true;
      rows.push(r);
      j++;
    }
    const fits =
      !ragged &&
      columns.length >= 1 &&
      columns.length <= MAX_COLUMNS &&
      columns.every((c) => c.length > 0 && c.length <= MAX_LABEL) &&
      rows.length >= 1 &&
      rows.length <= MAX_ROWS &&
      rows.every((r) => r.every((c) => c.length <= MAX_CELL)) &&
      !lines.slice(i, j).some((l) => l.includes("\\|") || /\]\(/.test(l));
    if (!fits) {
      out.push(...lines.slice(i, j));
      i = j - 1;
      continue;
    }
    const prev = out[out.length - 1];
    const title = titleFrom(prev, columns);
    const generated = nameFromColumns(columns).slice(0, MAX_TITLE) || "Table";
    if (prev !== undefined && title !== generated && title.length > 0) {
      out.pop();
    } else {
      const k = lastNonEmpty(out);
      if (k >= 0 && out[k].trim().length <= MAX_LABEL && /:\s*$/.test(out[k])) {
        out[k] = out[k].replace(/:\s*$/, ".");
      }
    }
    let k = j;
    while (k < lines.length && lines[k].trim() === "") k++;
    const notes: string[] = [];
    while (k < lines.length && /^\s*\*(?!\*)\S/.test(lines[k])) {
      notes.push(lines[k].trim());
      k++;
    }
    const note = notes.join(" ");
    const keepNote = note.length > 0 && note.length <= MAX_NOTE;
    tables.push(keepNote ? { title, columns, rows, note } : { title, columns, rows });
    i = (keepNote ? k : j) - 1;
  }

  const body = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { body, tables };
}
