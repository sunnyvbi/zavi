const REFUSAL_CODES = new Set([40001, 40100, 40102, 40105, 40133]);

export function tiktokResponseError(toolSlug: string, data: unknown): { error: string; outcome_unknown: boolean } | null {
  if (!toolSlug.startsWith("TIKTOK_ADS_")) return null;
  const outer = data && typeof data === "object" ? data as Record<string, unknown> : {};
  for (const candidate of [outer, outer.data]) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const envelope = candidate as Record<string, unknown>;
    if (typeof envelope.code !== "number" || !Number.isFinite(envelope.code) || envelope.code === 0) continue;
    const message = typeof envelope.message === "string" && envelope.message.trim()
      ? envelope.message.trim()
      : "Request failed without an error message";
    return {
      error: `TikTok API ${envelope.code}: ${message}`,
      outcome_unknown: !REFUSAL_CODES.has(envelope.code),
    };
  }
  return null;
}
