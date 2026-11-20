export type AudienceRow = { key: string; value: string };
export type Audience = { n: string; who: string; rows: AudienceRow[]; notes: string[]; text: string };

const HEADER = /^\s*AUDIENCE\s+(\d+|[A-Z](?![A-Za-z]))\s*[:.-]\s*(.*)$/i;
const KEY = /^([A-Z][A-Za-z0-9 ()/&'-]{0,40}):\s*(.*)$/;
const NEXT_KEY = /\s{2,}(?=[A-Z][A-Za-z0-9 ()/&'-]{0,40}:\s)/;

function pairs(line: string): AudienceRow[] | null {
  const head = KEY.exec(line.trim());
  if (!head) return null;
  const [first, ...more] = head[2].split(NEXT_KEY);
  const rows: AudienceRow[] = [{ key: head[1].trim(), value: first.trim() }];
  for (const part of more) {
    const next = pairs(part);
    if (next) rows.push(...next);
    else rows[rows.length - 1].value = `${rows[rows.length - 1].value} ${part.trim()}`.trim();
  }
  return rows;
}

export function audienceSheet(content: string): { intro: string[]; audiences: Audience[] } | null {
  const lines = content.split(/\r?\n/);
  const intro: string[] = [];
  const audiences: Array<Audience & { raw: string[] }> = [];
  let current: (Audience & { raw: string[] }) | null = null;
  for (const line of lines) {
    const header = HEADER.exec(line);
    if (header) {
      current = { n: header[1], who: header[2].trim(), rows: [], notes: [], text: "", raw: [line] };
      audiences.push(current);
      continue;
    }
    if (!current) {
      if (line.trim()) intro.push(line.trim());
      continue;
    }
    current.raw.push(line);
    if (!line.trim()) continue;
    const found = pairs(line);
    if (found) current.rows.push(...found);
    else current.notes.push(line.trim());
  }
  if (!audiences.length || audiences.some((a) => a.rows.length < 2)) return null;
  return {
    intro,
    audiences: audiences.map(({ raw, ...a }) => ({ ...a, text: raw.join("\n").trim() })),
  };
}

export type ValuePart = { kind: "text"; text: string } | { kind: "blank"; text: string; raw: string } | { kind: "toggle"; on: boolean };

const BLANK = /\[([^\]\n]{1,200})\]/g;

export function valueParts(value: string): ValuePart[][] {
  const items = value.split(/\s+\|\s+|;\s+/).map((s) => s.trim()).filter(Boolean);
  return items.map((item) => {
    if (/^(off|on)$/i.test(item)) return [{ kind: "toggle", on: /^on$/i.test(item) }];
    const out: ValuePart[] = [];
    let at = 0;
    for (const m of item.matchAll(BLANK)) {
      const before = item.slice(at, m.index).trim();
      if (before) out.push({ kind: "text", text: before });
      out.push({ kind: "blank", text: m[1].replace(/^(fill in|confirm):\s*/i, "").trim(), raw: m[0] });
      at = (m.index ?? 0) + m[0].length;
    }
    const tail = item.slice(at).trim();
    if (tail) out.push({ kind: "text", text: tail });
    return out;
  });
}

export function splitWho(who: string): { title: string; aside: string | null } {
  const m = /^(.*\S)\s*\(([^()]+)\)\s*$/.exec(who.trim());
  return m ? { title: m[1], aside: m[2].trim() } : { title: who.trim(), aside: null };
}

export function isToggleRow(row: AudienceRow): boolean {
  return /^(off|on)$/i.test(row.value.trim());
}

export function sentenceCase(text: string): string {
  return /^[a-z]/.test(text) && !/^[a-z0-9-]+\.[a-z]{2,}/i.test(text) ? text[0].toUpperCase() + text.slice(1) : text;
}

export function blankContexts(text: string, blanks: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (const blank of blanks) {
    const sections = new Set<string>();
    let key: string | null = null;
    let section = "";
    for (const line of lines) {
      const header = HEADER.exec(line);
      if (header) section = header[1];
      const at = line.indexOf(blank);
      if (at < 0) continue;
      sections.add(section);
      if (key) continue;
      const before = line.slice(0, at);
      const cut = before.split(/\s{2,}/);
      const tail = cut[cut.length - 1].trim() || (cut.length > 1 ? cut[cut.length - 2].trim() : "");
      const named = /([A-Z][A-Za-z0-9 ()/&'-]{0,40}):\s*$/.exec(before.trim()) ?? /^([A-Z][A-Za-z0-9 ()/&'-]{0,40}):/.exec(tail) ?? /^([A-Z][A-Za-z0-9 ()/&'-]{0,40}):/.exec(line.trim());
      if (named) key = named[1].trim();
    }
    if (!key) continue;
    const named = [...sections].filter(Boolean);
    out[blank] = named.length > 1 ? `${key} · audiences ${named.join(" and ")}` : named.length === 1 ? `${key} · audience ${named[0]}` : key;
  }
  return out;
}
