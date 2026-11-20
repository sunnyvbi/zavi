export const PLATFORM_LINK_HOSTS = /(^|\.)(fb\.me|fb\.com|facebook\.com|m\.me|messenger\.com|instagram\.com|wa\.me|whatsapp\.com)$/i;

export function isWebsiteLink(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    return (u.protocol === "https:" || u.protocol === "http:") && u.hostname.includes(".") && !PLATFORM_LINK_HOSTS.test(u.hostname);
  } catch {
    return false;
  }
}
