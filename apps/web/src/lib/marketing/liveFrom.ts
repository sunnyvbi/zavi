
import { UTM_KEYS, channelFromParam, missingFirstTouchStatus, type FirstTouch, type UtmKey } from "@/lib/analytics/first-touch";
import { isOnboardingNext } from "@/lib/onboardingRoutes";
import { plainNext } from "@/lib/safe-next";

export const LIVE_FROM_RE = /^live-[a-z0-9-]{1,40}$/;

export { channelFromParam } from "@/lib/analytics/first-touch";

export function liveFromParam(raw: string | null | undefined): string | null {
  return raw && LIVE_FROM_RE.test(raw) ? raw : null;
}

export function liveStartHref(slug: string, site: string): string {
  const from = liveFromParam(`live-${slug}`);
  const q = new URLSearchParams();
  const s = site.trim();
  if (s) {
    q.set("step", "website");
    q.set("website", s);
  }
  if (from) q.set("from", from);
  const qs = q.toString();
  return qs ? `/start?${qs}` : "/start";
}

export function liveFromInNext(next: string | null | undefined): string | null {
  if (!isOnboardingNext(next)) return null;
  const i = next.indexOf("?");
  if (i < 0) return null;
  return liveFromParam(new URLSearchParams(next.slice(i + 1)).get("from"));
}

export type UrlAttribution = Partial<Record<UtmKey, string>> & { from?: string };

type SearchLike = URLSearchParams | string | Record<string, string | string[] | undefined>;

function toParams(search: SearchLike): URLSearchParams {
  if (typeof search === "string" || search instanceof URLSearchParams) return new URLSearchParams(search);
  return new URLSearchParams(Object.entries(search).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : [])));
}

export function urlAttribution(search: SearchLike): UrlAttribution {
  const q = toParams(search);
  const out: UrlAttribution = {};
  for (const k of UTM_KEYS) {
    const v = q.get(k)?.trim();
    if (v) out[k] = v.slice(0, 100);
  }
  const from = channelFromParam(q.get("from"));
  if (from) out.from = from;
  return out;
}

export function withUrlAttribution(path: string, a: UrlAttribution): string {
  const hashAt = path.indexOf("#");
  const hash = hashAt < 0 ? "" : path.slice(hashAt);
  const base = hashAt < 0 ? path : path.slice(0, hashAt);
  const queryAt = base.indexOf("?");
  const pathname = queryAt < 0 ? base : base.slice(0, queryAt);
  const q = new URLSearchParams(queryAt < 0 ? "" : base.slice(queryAt + 1));
  const existing = urlAttribution(q);
  const hasCampaign = UTM_KEYS.some((key) => existing[key]);
  for (const [key, value] of Object.entries(urlAttribution(a))) {
    if (key === "from" ? !existing.from : !hasCampaign) q.set(key, value);
  }
  const qs = q.toString();
  return `${pathname}${qs ? `?${qs}` : ""}${hash}`;
}

export function onboardingAttributionHref(path: string, a: UrlAttribution): string {
  const safe = plainNext(path);
  const pathname = safe?.split(/[?#]/)[0];
  return pathname === "/start" || pathname === "/onboarding/past-work"
    ? withUrlAttribution(safe!, a)
    : path;
}

export type SignupAttributionBody = Partial<FirstTouch> & { capture_status?: ReturnType<typeof missingFirstTouchStatus> };

export function signupAttribution(ft: FirstTouch | undefined, a: UrlAttribution): SignupAttributionBody | undefined {
  const out: SignupAttributionBody = { ...ft };
  if (!UTM_KEYS.some((key) => ft?.[key])) {
    for (const key of UTM_KEYS) if (a[key]) out[key] = a[key];
  }
  if (a.from) out.from = a.from;
  return Object.keys(out).length ? out : { capture_status: missingFirstTouchStatus() };
}
