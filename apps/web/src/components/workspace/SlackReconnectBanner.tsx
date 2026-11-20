
export function classifyMissing(missing: readonly string[]): "info" | "high" {
  for (const s of missing) {
    if (s.startsWith("im:") || s.startsWith("mpim:")) return "high";
  }
  return "info";
}

export function describeMissing(missing: readonly string[]): string {
  if (missing.length === 0) return "";
  if (missing.length === 1) return `Missing scope: ${missing[0]}.`;
  return `Missing ${missing.length} scopes: ${missing.join(", ")}.`;
}
