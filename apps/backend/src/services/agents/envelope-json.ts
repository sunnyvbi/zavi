
export type EnvelopeParseKind =
  | "strict"
  | "repaired"
  | "items_salvaged"
  | "markdown_fallback"
  | "failed";

export type EnvelopeParseResult =
  | { kind: "strict"; value: unknown }
  | { kind: "repaired"; value: unknown; original_error: string }
  | {
      kind: "items_salvaged";
      value: { rendered_markdown: string } & Record<string, unknown>;
      original_error: string;
    }
  | {
      kind: "markdown_fallback";
      value: { rendered_markdown: string };
      original_error: string;
    }
  | { kind: "failed"; error: string };

function valueStartsAt(input: string, k: number, container: string | undefined): boolean {
  const c = input[k];
  if (c === undefined || c === "}" || c === "]") return true;
  if (container === "{") return c === '"';
  if (c === '"' || c === "{" || c === "[" || c === "-" || (c >= "0" && c <= "9")) return true;
  for (const word of ["true", "false", "null"]) {
    if (input.startsWith(word, k) && !/[A-Za-z]/.test(input[k + word.length] ?? "")) return true;
  }
  return false;
}

export function repairEnvelopeJson(input: string): string {
  let out = "";
  let inString = false;
  let escapeNext = false;
  const stack: string[] = [];
  let lastStructural = "";
  let stringIsKey = false;
  let lastClosedWasKey = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (escapeNext) {
      out += ch;
      escapeNext = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      escapeNext = true;
      continue;
    }
    if (inString) {
      if (ch === '"') {
        let j = i + 1;
        while (j < input.length && (input[j] === " " || input[j] === "\t")) j++;
        const next = input[j];
        let closes: boolean;
        if (stringIsKey) {
          closes = next === ":" || next === undefined;
        } else if (next === ",") {
          let k = j + 1;
          while (
            k < input.length &&
            (input[k] === " " || input[k] === "\t" || input[k] === "\n" || input[k] === "\r")
          )
            k++;
          closes = valueStartsAt(input, k, stack[stack.length - 1]);
        } else {
          closes =
            next === "}" ||
            next === "]" ||
            next === "\n" ||
            next === "\r" ||
            next === undefined;
        }
        if (closes) {
          out += ch;
          inString = false;
          lastStructural = '"';
          lastClosedWasKey = stringIsKey;
        } else {
          out += '\\"';
        }
        continue;
      }
      if (ch === "\n") {
        out += "\\n";
        continue;
      }
      if (ch === "\r") {
        out += "\\r";
        continue;
      }
      if (ch === "\t") {
        out += "\\t";
        continue;
      }
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        out += "\\u" + code.toString(16).padStart(4, "0");
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (
        j < input.length &&
        (input[j] === " " || input[j] === "\t" || input[j] === "\n" || input[j] === "\r")
      )
        j++;
      if (input[j] === "}" || input[j] === "]") {
        continue;
      }
    }
    if (
      (ch === '"' || ch === "{" || ch === "[") &&
      (lastStructural === "}" ||
        lastStructural === "]" ||
        /[0-9eltn]/.test(lastStructural) ||
        (lastStructural === '"' && !lastClosedWasKey))
    ) {
      out += ",";
      lastStructural = ",";
    }
    if (ch === '"') {
      inString = true;
      const container = stack[stack.length - 1];
      stringIsKey = container === "{" && (lastStructural === "{" || lastStructural === ",");
    } else if (ch === "{" || ch === "[") {
      stack.push(ch);
    } else if (ch === "}" || ch === "]") {
      stack.pop();
    }
    if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r" && ch !== '"') {
      lastStructural = ch;
    }
    out += ch;
  }
  return out;
}

export function extractRenderedMarkdown(payload: string): string | null {
  const marker = /"rendered_markdown"\s*:\s*"/.exec(payload);
  if (!marker) return null;
  const start = marker.index + marker[0].length;
  let out = "";
  let escapeNext = false;
  for (let i = start; i < payload.length; i++) {
    const ch = payload[i];
    if (escapeNext) {
      if (ch === "n") out += "\n";
      else if (ch === "r") out += "\r";
      else if (ch === "t") out += "\t";
      else if (ch === '"') out += '"';
      else if (ch === "\\") out += "\\";
      else out += ch;
      escapeNext = false;
      continue;
    }
    if (ch === "\\") {
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < payload.length && (payload[j] === " " || payload[j] === "\t" || payload[j] === "\n" || payload[j] === "\r")) j++;
      const next = payload[j];
      if (next === "," || next === "}" || next === undefined) {
        return out;
      }
      out += '"';
      continue;
    }
    out += ch;
  }
  return out.length > 0 ? out : null;
}

function trimStrayClosers(input: string, message: string): string | null {
  const at = /after JSON at position (\d+)/.exec(message);
  if (!at) return null;
  const cut = Number(at[1]);
  if (!Number.isInteger(cut) || cut <= 0 || cut >= input.length) return null;
  if (!/^(?:[\s}\]]|<\/(?:parameter|invoke|function_calls|tool_call|tool_use)>)+$/.test(input.slice(cut))) return null;
  return input.slice(0, cut);
}

export function closeEscapedQuoteBeforeClosers(payload: string): string {
  return payload.replace(/\\"(\}+\s*(?:,\s*\{\s*"|\]))/g, '\\""$1');
}

function objectEndFrom(input: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = start; i < input.length; i++) {
    const ch = input[i];
    if (inString) {
      if (escapeNext) escapeNext = false;
      else if (ch === "\\") escapeNext = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return ch === "}" ? i + 1 : -1;
    }
  }
  return -1;
}

export function salvageArrayItems(rawPayload: string): Record<string, unknown[]> {
  const payload = closeEscapedQuoteBeforeClosers(rawPayload);
  const out: Record<string, unknown[]> = {};
  const keyRe = /"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*\[\s*\{/g;
  const claimed: Array<[number, number]> = [];
  const inClaimed = (i: number) => claimed.some(([a, b]) => i >= a && i < b);
  for (const m of payload.matchAll(keyRe)) {
    const key = m[1];
    const at = (m.index ?? 0) + m[0].length - 1;
    if (inClaimed(at) || out[key]) continue;
    const items: unknown[] = [];
    let i = at;
    let lastEnd = -1;
    while (i < payload.length) {
      const open = payload.indexOf("{", i);
      if (open < 0) break;
      let k = open - 1;
      while (k >= 0 && /\s/.test(payload[k])) k--;
      const before = payload[k];
      if (before === ":" || before === '"') {
        i = open + 1;
        continue;
      }
      if (before === "[" && open !== at) break;
      if (lastEnd >= 0 && payload.slice(lastEnd, open).includes("]")) break;
      const end = objectEndFrom(payload, open);
      if (end < 0) {
        i = open + 1;
        continue;
      }
      const text = payload.slice(open, end);
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        if (/\}\s*[,\uFF0C]\s*\{\s*"/.test(text)) {
          value = undefined;
        } else {
          try {
            value = JSON.parse(repairEnvelopeJson(text));
          } catch {
            value = undefined;
          }
        }
      }
      if (value && typeof value === "object" && !Array.isArray(value)) {
        items.push(value);
        claimed.push([open, end]);
        lastEnd = end;
        i = end;
      } else {
        i = open + 1;
      }
    }
    if (items.length > 0) out[key] = items;
  }
  return out;
}

function preferSalvagedItems(value: unknown, payload: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const obj = value as Record<string, unknown>;
  const salvaged = salvageArrayItems(payload);
  for (const [key, items] of Object.entries(salvaged)) {
    const current = obj[key];
    if (Array.isArray(current) && items.length > current.length) obj[key] = items;
  }
  return obj;
}

export function tryParseEnvelopePayload(
  payload: string,
  options: { envelope_name: string },
): EnvelopeParseResult {
  void options;
  try {
    return { kind: "strict", value: JSON.parse(payload) };
  } catch (strictErr) {
    const strictMessage = (strictErr as Error).message;
    const trimmed = trimStrayClosers(payload, strictMessage);
    if (trimmed !== null) {
      try {
        return {
          kind: "repaired",
          value: JSON.parse(trimmed),
          original_error: strictMessage,
        };
      } catch {
      }
    }
    try {
      const repaired = repairEnvelopeJson(closeEscapedQuoteBeforeClosers(payload));
      return {
        kind: "repaired",
        value: preferSalvagedItems(JSON.parse(repaired), payload),
        original_error: strictMessage,
      };
    } catch {
      const md = extractRenderedMarkdown(payload);
      if (md && md.trim().length > 0) {
        const arrays = salvageArrayItems(payload);
        if (Object.keys(arrays).length > 0) {
          return {
            kind: "items_salvaged",
            value: { ...arrays, rendered_markdown: md },
            original_error: strictMessage,
          };
        }
        return {
          kind: "markdown_fallback",
          value: { rendered_markdown: md },
          original_error: strictMessage,
        };
      }
      return { kind: "failed", error: strictMessage };
    }
  }
}
