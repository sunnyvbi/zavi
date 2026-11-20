
export const CONSENT_COOKIE = "zavi_consent_v1";

export const CONSENT_VERSION = 3;

export const CONSENT_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;

const PARENT_DOMAIN = "zaviagent.com";

export const OPEN_PREFERENCES_EVENT = "zavi:open-cookie-prefs";

function onOurSite(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === PARENT_DOMAIN || host.endsWith(`.${PARENT_DOMAIN}`);
}

export type ConsentPrefs = { analytics: boolean };

export type ConsentState =
  | { status: "unset" }
  | { status: "set"; prefs: ConsentPrefs; ts: string };

const UNSET: ConsentState = { status: "unset" };

export function parseConsent(cookieString: string): ConsentState {
  if (!cookieString) return UNSET;
  const prefix = `${CONSENT_COOKIE}=`;
  for (const part of cookieString.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(prefix)) continue;
    try {
      const raw = JSON.parse(decodeURIComponent(trimmed.slice(prefix.length)));
      if (
        !raw ||
        typeof raw !== "object" ||
        typeof raw.v !== "number" ||
        typeof raw.analytics !== "boolean" ||
        typeof raw.ts !== "string"
      ) {
        return UNSET;
      }
      if (raw.v !== CONSENT_VERSION && raw.analytics) return UNSET;
      return { status: "set", prefs: { analytics: raw.analytics }, ts: raw.ts };
    } catch {
      return UNSET;
    }
  }
  return UNSET;
}

export function serializeConsent(prefs: ConsentPrefs, ts: string): string {
  return encodeURIComponent(
    JSON.stringify({ v: CONSENT_VERSION, analytics: prefs.analytics, ts }),
  );
}

export function cookieAttributes(hostname: string, protocol: string): string {
  let out = `; Max-Age=${CONSENT_MAX_AGE_SECONDS}; Path=/; SameSite=Lax`;
  if (onOurSite(hostname)) out += `; Domain=.${PARENT_DOMAIN}`;
  if (protocol === "https:") out += "; Secure";
  return out;
}

const ANALYTICS_KEY_RE = /^(ph_|__ph_opt_in_out_|mp_|__mp_opt_in_out_|__mpced_|zft_|zavi_affiliate_click$|_ga$|_ga_|_gid$|_gat($|_))/;

export function isAnalyticsStorageKey(key: string): boolean {
  return ANALYTICS_KEY_RE.test(key);
}

function cookieString(): string {
  try {
    return typeof document === "undefined" ? "" : document.cookie;
  } catch {
    return "";
  }
}

export function readConsent(): ConsentState {
  return parseConsent(cookieString());
}

export function allowsAnalytics(s: ConsentState): boolean {
  return s.status === "set" ? s.prefs.analytics : !signalsRejection();
}

export function hasAnalyticsConsent(): boolean {
  return allowsAnalytics(readConsent());
}

export function signalsRejection(): boolean {
  try {
    return (
      typeof navigator !== "undefined" &&
      (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true
    );
  } catch {
    return false;
  }
}

const listeners = new Set<(s: ConsentState) => void>();
let wired = false;

function notify(state: ConsentState): void {
  for (const fn of listeners) {
    try {
      fn(state);
    } catch {
    }
  }
}

function wire(): void {
  if (wired || typeof window === "undefined") return;
  wired = true;
  if (!hasAnalyticsConsent()) purgeAnalyticsStorage();
}

export function subscribe(fn: (s: ConsentState) => void): () => void {
  wire();
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function writeConsent(prefs: ConsentPrefs): void {
  const ts = new Date().toISOString();
  try {
    document.cookie =
      `${CONSENT_COOKIE}=${serializeConsent(prefs, ts)}` +
      cookieAttributes(window.location.hostname, window.location.protocol);
  } catch {
  }
  const state: ConsentState = { status: "set", prefs, ts };
  notify(state);
}

function expireCookie(name: string): void {
  try {
    document.cookie = `${name}=; Max-Age=0; Path=/`;
    if (onOurSite(window.location.hostname)) {
      document.cookie = `${name}=; Max-Age=0; Path=/; Domain=.${PARENT_DOMAIN}`;
    }
  } catch {
  }
}

export function purgeAnalyticsStorage(): void {
  for (const part of cookieString().split(";")) {
    const name = part.trim().split("=")[0];
    if (name && isAnalyticsStorageKey(name)) expireCookie(name);
  }
  for (const store of ["localStorage", "sessionStorage"] as const) {
    try {
      const s = window[store];
      const doomed: string[] = [];
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k && isAnalyticsStorageKey(k)) doomed.push(k);
      }
      for (const k of doomed) s.removeItem(k);
    } catch {
    }
  }
}

export function withdrawAnalyticsConsent(): void {
  writeConsent({ analytics: false });
  purgeAnalyticsStorage();
}

export function openPreferences(): void {
  try {
    window.dispatchEvent(new CustomEvent(OPEN_PREFERENCES_EVENT));
  } catch {
  }
}
