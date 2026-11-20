
import psl from "psl";

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export function registrableSite(url: string | null | undefined): string | null {
  if (typeof url !== "string" || url.length === 0) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return null;
  if (host.startsWith("[") || IPV4.test(host)) return host;
  const site = psl.get(host);
  return site ? site.toLowerCase() : host;
}
