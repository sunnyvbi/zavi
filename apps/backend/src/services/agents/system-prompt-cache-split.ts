
export function splitSystemPromptForCache(
  full: string,
  stablePrefix: string,
  boundary: string,
): string | string[] {
  if (!stablePrefix || !full.startsWith(stablePrefix) || full.length === stablePrefix.length) return full;
  return [stablePrefix, boundary, full.slice(stablePrefix.length)];
}
