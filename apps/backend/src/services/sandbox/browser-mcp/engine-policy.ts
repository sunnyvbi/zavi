
export type BrowserEngine = "sandbox" | "anchor" | "extension";

export const HOSTILE_ORIGIN_SUFFIXES: readonly string[] = [
  "instagram.com",
  "linkedin.com",
  "tiktok.com",
] as const;

function hostOf(originOrUrl: string): string | null {
  try {
    return new URL(originOrUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isHostileHost(
  host: string,
  extraSuffixes: readonly string[] = [],
): boolean {
  const h = host.toLowerCase();
  const all = [
    ...HOSTILE_ORIGIN_SUFFIXES,
    ...extraSuffixes.map((s) => s.toLowerCase()),
  ];
  return all.some((suffix) => h === suffix || h.endsWith("." + suffix));
}

export function isHostileOrigin(
  originOrUrl: string | undefined,
  extraSuffixes: readonly string[] = [],
): boolean {
  if (!originOrUrl) return false;
  const host = hostOf(originOrUrl);
  if (!host) return false;
  return isHostileHost(host, extraSuffixes);
}

export function resolveEngine(
  targetOrigin: string | undefined,
  tenantHostileSuffixes: readonly string[] = [],
): BrowserEngine {
  return isHostileOrigin(targetOrigin, tenantHostileSuffixes)
    ? "anchor"
    : "sandbox";
}

export function pinnedEngine(ctx: { extension?: unknown }): "extension" | null {
  return ctx.extension ? "extension" : null;
}
