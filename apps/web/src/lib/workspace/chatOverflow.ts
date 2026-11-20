
export function readScrubbedOverflow(meta: unknown): string | undefined {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
  const m = meta as Record<string, unknown>;
  if (m.overflow_scrubbed !== true) return undefined;
  const full = m.full_reply_markdown;
  return typeof full === "string" && full.length > 0 ? full : undefined;
}
