
import { hasAnalyticsConsent } from "@/lib/consent";

export const FIRST_TOUCH_KEY = "zft_first_touch";

export const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;
export type UtmKey = (typeof UTM_KEYS)[number];
const CLICK_IDS = ["gclid", "gbraid", "wbraid", "fbclid", "msclkid", "ttclid", "li_fat_id", "twclid"];

export type FirstTouch = Partial<Record<UtmKey, string>> & {
  click_id?: string;
  referrer_host?: string;
  landing_path?: string;
  first_seen_at: string;
  from?: string;
};

export function channelFromParam(raw: string | null | undefined): string | null {
  return typeof raw === "string" && /^[a-z0-9][a-z0-9-]{0,49}$/.test(raw) ? raw : null;
}

function isOurHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "zaviagent.com" || h.endsWith(".zaviagent.com") || h === "localhost";
}

export function buildFirstTouch(href: string, referrer: string, nowIso: string): FirstTouch {
  const out: FirstTouch = { first_seen_at: nowIso };
  let url: URL | null = null;
  try {
    url = new URL(href);
  } catch {
  }
  if (url) {
    const from = channelFromParam(url.searchParams.get("from"));
    if (from) out.from = from;
    for (const k of UTM_KEYS) {
      const v = url.searchParams.get(k)?.trim();
      if (v) out[k] = v.slice(0, 100);
    }
    const click = CLICK_IDS.find((k) => url!.searchParams.has(k));
    if (click) out.click_id = click;
    out.landing_path = url.pathname.slice(0, 200);
  }
  if (referrer) {
    try {
      const host = new URL(referrer).hostname;
      if (host && !isOurHost(host)) out.referrer_host = host.slice(0, 200);
    } catch {
    }
  }
  return out;
}

export function readFirstTouch(): FirstTouch | null {
  try {
    const raw = window.localStorage.getItem(FIRST_TOUCH_KEY);
    return raw ? (JSON.parse(raw) as FirstTouch) : null;
  } catch {
    return null;
  }
}

export function captureFirstTouch(): void {
  try {
    if (!hasAnalyticsConsent()) return;
    const stored = readFirstTouch();
    const ft = buildFirstTouch(window.location.href, document.referrer, new Date().toISOString());
    if (stored) {
      if (ft.from && !channelFromParam(stored.from)) {
        window.localStorage.setItem(FIRST_TOUCH_KEY, JSON.stringify({ ...stored, from: ft.from }));
      }
      return;
    }
    window.localStorage.setItem(FIRST_TOUCH_KEY, JSON.stringify(ft));
  } catch {
  }
}

export function firstTouchForSignup(): FirstTouch | undefined {
  try {
    if (!hasAnalyticsConsent()) return undefined;
  } catch {
    return undefined;
  }
  return readFirstTouch() ?? undefined;
}

export function missingFirstTouchStatus(): "analytics_disabled" | "storage_unavailable" | "not_captured" {
  if (typeof window === "undefined") return "not_captured";
  try {
    if (!hasAnalyticsConsent()) return "analytics_disabled";
    const raw = window.localStorage.getItem(FIRST_TOUCH_KEY);
    if (raw) JSON.parse(raw);
    return "not_captured";
  } catch {
    return "storage_unavailable";
  }
}
