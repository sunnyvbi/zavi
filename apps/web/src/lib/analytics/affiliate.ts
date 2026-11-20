import { hasAnalyticsConsent } from "@/lib/consent";
import { apiFetch } from "@/lib/api";

export const AFFILIATE_KEY = "zavi_affiliate_click";
const CODE_RE = /^[a-km-np-z2-9]{8}$/;
const WINDOW_MS = 60 * 86_400_000;

type Stored = { click_id: string; at: number };

export function viaCode(href: string): string | null {
  try {
    const v = new URL(href).searchParams.get("via")?.trim().toLowerCase() ?? "";
    return CODE_RE.test(v) ? v : null;
  } catch {
    return null;
  }
}

export function withoutVia(href: string): string {
  const u = new URL(href);
  u.searchParams.delete("via");
  return u.pathname + (u.search ? u.search : "") + u.hash;
}

export function affiliateClick(now = Date.now()): string | null {
  try {
    if (!hasAnalyticsConsent()) return null;
    const raw = window.localStorage.getItem(AFFILIATE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Stored;
    if (typeof s.click_id !== "string" || now - Number(s.at) > WINDOW_MS) return null;
    return s.click_id;
  } catch {
    return null;
  }
}

export function withAffiliateClick<T extends Record<string, unknown>>(body: T): T & { affiliate_click?: string } {
  const c = affiliateClick();
  return c ? { ...body, affiliate_click: c } : body;
}

export async function captureAffiliateClick(): Promise<void> {
  try {
    const code = viaCode(window.location.href);
    if (!code) return;
    if (!hasAnalyticsConsent()) return;
    window.history.replaceState(window.history.state, "", withoutVia(window.location.href));
    const res = await apiFetch("/api/public/affiliate/click", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const j = (await res.json().catch(() => null)) as { click_id?: string | null } | null;
    if (j?.click_id) window.localStorage.setItem(AFFILIATE_KEY, JSON.stringify({ click_id: j.click_id, at: Date.now() } satisfies Stored));
  } catch {
  }
}
