import { NATIVE_DESCRIPTOR_TO_COMPOSIO, railFor } from "@zavi/shared";

const TWINS = Object.values(NATIVE_DESCRIPTOR_TO_COMPOSIO).flat();
export const NATIVE_ONLY_TOOLKITS: ReadonlySet<string> = new Set(TWINS.filter((s) => railFor(s) === "native"));
export const TILE_TOOLKITS: ReadonlySet<string> = new Set(TWINS.filter((s) => railFor(s) === "composio"));
export const NATIVELY_SERVED_TOOLKITS: ReadonlySet<string> = new Set([
  "google_analytics",
  "google_search_console",
]);

export const composioRailSlugs = (slugs: readonly string[]): string[] =>
  slugs
    .filter((s) => s.startsWith("composio."))
    .map((s) => s.slice(9))
    .filter((k) => railFor(k) === "composio" && !NATIVELY_SERVED_TOOLKITS.has(k))
    .sort();
