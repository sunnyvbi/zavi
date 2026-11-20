
export function faviconUrlFromDomain(domain: string): string | null {
  const raw = domain.trim();
  if (!raw) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!u.hostname.includes(".")) return null;
    return `https://${u.hostname}/favicon.ico`;
  } catch {
    return null;
  }
}
