export type CallField = { key: string; value: string; truncated?: boolean };

const HIDDEN_KEYS = new Set(["ok"]);

function show(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

function decodeJsonString(body: string): string {
  try {
    return JSON.parse(`"${body}"`) as string;
  } catch {
    return body.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
}

function readString(text: string, start: number): { body: string; end: number; closed: boolean } {
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"') return { body: text.slice(start + 1, i), end: i + 1, closed: true };
    i += 1;
  }
  return { body: text.slice(start + 1), end: text.length, closed: false };
}

function skipNested(text: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const str = readString(text, i);
      if (!str.closed) return -1;
      i = str.end;
      continue;
    }
    if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return -1;
}

function skipSpace(text: string, from: number): number {
  let i = from;
  while (i < text.length && /[\s,]/.test(text[i]!)) i += 1;
  return i;
}

function scanTopLevel(text: string): CallField[] {
  const fields: CallField[] = [];
  const seen = new Set<string>();
  let i = 1;
  while (i < text.length) {
    i = skipSpace(text, i);
    if (text[i] !== '"') break;
    const keyToken = readString(text, i);
    if (!keyToken.closed) break;
    i = keyToken.end;
    while (i < text.length && /\s/.test(text[i]!)) i += 1;
    if (text[i] !== ":") break;
    i += 1;
    while (i < text.length && /\s/.test(text[i]!)) i += 1;
    if (i >= text.length) break;
    const key = keyToken.body;
    const ch = text[i];
    let entry: CallField | null = null;
    if (ch === '"') {
      const str = readString(text, i);
      i = str.end;
      const value = decodeJsonString(str.closed ? str.body : str.body.replace(/\\$/, ""));
      if (value.trim()) entry = { key, value, ...(str.closed ? {} : { truncated: true }) };
    } else if (ch === "{" || ch === "[") {
      const end = skipNested(text, i);
      if (end < 0) break;
      i = end;
    } else {
      let j = i;
      while (j < text.length && text[j] !== "," && text[j] !== "}") j += 1;
      const bare = text.slice(i, j).trim();
      i = j;
      if (bare) entry = { key, value: bare };
    }
    if (entry && !HIDDEN_KEYS.has(key) && !seen.has(key)) {
      seen.add(key);
      fields.push(entry);
    }
  }
  return fields;
}

export function readCallFields(raw: string): CallField[] | null {
  const text = raw.trim();
  if (!text.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const fields = Object.entries(parsed as Record<string, unknown>)
      .filter(([key, value]) => !HIDDEN_KEYS.has(key) && show(value).trim() !== "")
      .map(([key, value]) => ({ key, value: show(value) }));
    return fields.length > 0 ? fields : null;
  } catch {
    const fields = scanTopLevel(text);
    return fields.length > 0 ? fields : null;
  }
}

export function fieldLabel(key: string): string {
  const words = key.replace(/_slug$/, "").replace(/_/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : key;
}
