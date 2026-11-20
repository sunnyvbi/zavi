
export const CAMPAIGN_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "gclid",
  "gbraid",
  "wbraid",
  "fbclid",
  "msclkid",
  "ttclid",
  "li_fat_id",
  "twclid",
];

const TOKEN_PATH_PREFIXES = ["/reset-password/", "/auth/"];

export function analyticsPath(pathname: string): string {
  for (const prefix of TOKEN_PATH_PREFIXES) {
    if (pathname.startsWith(prefix)) return prefix.slice(0, -1);
  }
  return pathname;
}

export function analyticsUrl(href: string): string {
  try {
    const url = new URL(href);
    const kept = new URLSearchParams();
    for (const key of CAMPAIGN_PARAMS) {
      const v = url.searchParams.get(key);
      if (v) kept.set(key, v);
    }
    const qs = kept.toString();
    return `${url.origin}${analyticsPath(url.pathname)}${qs ? `?${qs}` : ""}`;
  } catch {
    return "";
  }
}

const PATH_KEYS = new Set(["$pathname", "$initial_pathname"]);
const URL_KEYS = new Set([
  "$current_url",
  "$initial_current_url",
  "$referrer",
  "$initial_referrer",
  "$session_entry_url",
  "$session_entry_referrer",
]);

export function scrubUrlProps<T extends Record<string, unknown> | undefined>(props: T): T {
  if (!props) return props;
  const out: Record<string, unknown> = { ...props };
  for (const [k, v] of Object.entries(out)) {
    if (typeof v !== "string") continue;
    if (PATH_KEYS.has(k)) out[k] = analyticsPath(v);
    else if (URL_KEYS.has(k) && /^https?:\/\//.test(v)) out[k] = analyticsUrl(v);
  }
  return out as T;
}
