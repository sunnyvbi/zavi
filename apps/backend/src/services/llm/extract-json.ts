
export function extractJsonObject(raw: string): unknown | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
  }

  if (!trimmed.startsWith("{")) {
    try {
      return JSON.parse("{" + trimmed);
    } catch {
    }
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced && fenced[1]) {
    const inner = fenced[1].trim();
    try {
      return JSON.parse(inner);
    } catch {
      if (!inner.startsWith("{")) {
        try {
          return JSON.parse("{" + inner);
        } catch {
        }
      }
    }
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
    }
  }

  return null;
}
