export function websiteHost(value: string): string | null {
  const raw = value.trim();
  if (!raw || /\s/.test(raw)) return null;

  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const labels = host.split(".");
    if (host.length > 253 || labels.length < 2) return null;
    if (!labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
    if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/.test(labels[labels.length - 1])) return null;
    return host;
  } catch {
    return null;
  }
}
