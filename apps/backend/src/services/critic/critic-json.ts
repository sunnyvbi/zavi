
const ELLIPSIS = "…";

export function stripFences(raw: string): string {
  return raw.replace(/```(?:json)?\s*|\s*```/g, "").trim();
}

export function extractFirstJsonObject(s: string): string {
  try {
    JSON.parse(s);
    return s;
  } catch {
  }
  const start = s.indexOf("{");
  if (start === -1) return s;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return s.slice(start, i + 1);
      }
    }
  }
  return s;
}

export function coerceCriticRaw(raw: string): string {
  return extractFirstJsonObject(stripFences(raw));
}

export function clampStringField(
  obj: Record<string, unknown>,
  key: string,
  max: number,
): boolean {
  const v = obj[key];
  if (typeof v !== "string" || v.length <= max) return false;
  obj[key] = clampString(v, max);
  return true;
}

export function clampString(v: string, max: number): string {
  if (v.length <= max) return v;
  if (max <= ELLIPSIS.length) return v.slice(0, max);
  return v.slice(0, max - ELLIPSIS.length) + ELLIPSIS;
}
