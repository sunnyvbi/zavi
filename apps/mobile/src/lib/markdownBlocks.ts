
export type MarkdownBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "bullet"; text: string }
  | { kind: "rule" }
  | { kind: "paragraph"; text: string }
  | { kind: "table"; header: string[]; rows: string[][] };

const HEADING = /^(#{1,3})\s+(.+)$/;
const BULLET = /^\s*[-*]\s+(.+)$/;
const RULE = /^\s*-{3,}\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

export function tableCells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "\\" && inner[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (inner[i] === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += inner[i];
    }
  }
  cells.push(cell.trim());
  return cells;
}

export function parseMarkdown(body: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = body.split("\n");
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "paragraph", text: para.join("\n") });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      flush();
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      flush();
      const header = tableCells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        const cells = tableCells(lines[i]);
        rows.push(header.map((_, c) => cells[c] ?? ""));
        i++;
      }
      i--;
      blocks.push({ kind: "table", header, rows });
      continue;
    }
    if (RULE.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      blocks.push({ kind: "heading", level: h[1].length, text: h[2] });
      continue;
    }
    const b = BULLET.exec(line);
    if (b) {
      flush();
      blocks.push({ kind: "bullet", text: b[1] });
      continue;
    }
    para.push(line);
  }
  flush();
  return blocks;
}

export function columnWidth(cells: string[]): number {
  const longest = Math.max(0, ...cells.map((c) => c.replace(/\*\*|\[|\]\([^)]*\)/g, "").length));
  return Math.min(260, Math.max(96, longest * 8 + 24));
}
