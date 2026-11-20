
import { assertSafeUrl, SsrfBlockedError } from "@/services/onboarding/enrichment/url-guard";
import { isPlatformHost } from "@/services/onboarding/enrichment/domain-match";

export type SiteInput = { url: string; domain: string };

export type NormalizeError = "missing_url" | "url_too_long" | "invalid_url" | "unsupported_scheme";

const MAX_URL_CHARS = 2048;
const HOST_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function normalizeSiteInput(raw: unknown): { ok: true; value: SiteInput } | { ok: false; error: NormalizeError } {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, error: "missing_url" };
  let s = raw.trim();
  if (s.length > MAX_URL_CHARS) return { ok: false, error: "url_too_long" };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: "invalid_url" };
  }
  if (u.protocol === "http:") u.protocol = "https:";
  if (u.protocol !== "https:") return { ok: false, error: "unsupported_scheme" };
  if (u.username || u.password) return { ok: false, error: "invalid_url" };
  if (u.port && u.port !== "443") return { ok: false, error: "invalid_url" };
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") || !HOST_RE.test(host)) return { ok: false, error: "invalid_url" };
  const domain = host.replace(/^www\./, "");
  if (!HOST_RE.test(domain)) return { ok: false, error: "invalid_url" };
  if (isPlatformHost(domain)) return { ok: false, error: "invalid_url" };
  return { ok: true, value: { url: `https://${domain}/`, domain } };
}

export async function checkSiteReachable(site: SiteInput): Promise<null | "unsafe_url" | "unreachable"> {
  try {
    await assertSafeUrl(site.url);
    return null;
  } catch (e) {
    if (e instanceof SsrfBlockedError) return e.code === "ssrf_dns_failed" ? "unreachable" : "unsafe_url";
    return "unreachable";
  }
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,253}\.[a-z]{2,63}$/i;

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const e = raw.trim().toLowerCase();
  return e.length <= 320 && EMAIL_RE.test(e) ? e : null;
}
