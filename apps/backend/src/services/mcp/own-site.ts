
function hostOf(s: string): string | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    return u.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

export function sameSite(url: string, site: string): boolean {
  const a = hostOf(url);
  const b = hostOf(site);
  if (!a || !b) return false;
  return a === b || a.endsWith(`.${b}`);
}
