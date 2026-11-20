export function sameOriginTarget(raw: unknown, origin: string): string {
  const fallback = "/workspace?tab=settings";
  if (typeof raw !== "string") return fallback;
  try {
    const url = new URL(raw, origin);
    return url.origin === origin ? `${url.pathname}${url.search}${url.hash}` : fallback;
  } catch {
    return fallback;
  }
}
