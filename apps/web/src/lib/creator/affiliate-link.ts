export const AFFILIATE_BASE = "https://www.zaviagent.com/?via=";

export function affiliateBaseForOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.origin === "https://latest.zaviagent.com" ||
      (local && (url.protocol === "http:" || url.protocol === "https:"))) {
      return `${url.origin}/?via=`;
    }
  } catch {  }
  return AFFILIATE_BASE;
}
