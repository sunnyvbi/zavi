import { isPublicPath } from "@/lib/publicPaths";

export type InAppBrowser = {
  app: string | null;
};

const NAMED: Array<[RegExp, string]> = [
  [/Twitter for iPhone|Twitter for iPad|TwitterAndroid/, "X"],
  [/Instagram/, "Instagram"],
  [/FBAN|FBAV/, "Facebook"],
  [/LinkedInApp/, "LinkedIn"],
  [/musical_ly|BytedanceWebview/, "TikTok"],
];

export function detectInAppBrowser(userAgent: string | null | undefined): InAppBrowser | null {
  if (!userAgent) return null;
  for (const [re, app] of NAMED) {
    if (re.test(userAgent)) return { app };
  }
  if (/Android/.test(userAgent) && /; wv\)/.test(userAgent)) return { app: null };
  if (/iPhone|iPad/.test(userAgent) && /Mobile\//.test(userAgent) && !/Safari\//.test(userAgent)) return { app: null };
  return null;
}

export function withoutAuthErrors(pageUrl: string): string {
  try {
    const url = new URL(pageUrl);
    url.searchParams.delete("error");
    url.searchParams.delete("error_description");
    url.searchParams.delete("error_code");
    return url.toString();
  } catch {
    return pageUrl;
  }
}

export type ExternalBrowserLink = { href: string; label: string };

export function externalBrowserLink(pageUrl: string, userAgent: string | null | undefined): ExternalBrowserLink | null {
  if (!detectInAppBrowser(userAgent)) return null;
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const rest = `${url.host}${url.pathname}${url.search}`;
  if (/iPhone|iPad|iPod/.test(userAgent ?? "")) {
    return { href: `x-safari-https://${rest}`, label: "Open in Safari" };
  }
  if (/Android/.test(userAgent ?? "")) {
    const fallback = encodeURIComponent(url.toString());
    return {
      href: `intent://${rest}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${fallback};end`,
      label: "Open in Chrome",
    };
  }
  return null;
}

export function watchOpenAttempt(onStillHere: () => void, waitMs = 1500): () => void {
  let left = false;
  const markLeft = () => {
    if (document.visibilityState === "hidden") left = true;
  };
  const onPageHide = () => {
    left = true;
  };
  document.addEventListener("visibilitychange", markLeft);
  window.addEventListener("pagehide", onPageHide);
  const timer = window.setTimeout(() => {
    stop();
    if (!left && document.visibilityState === "visible") onStillHere();
  }, waitMs);
  function stop() {
    window.clearTimeout(timer);
    document.removeEventListener("visibilitychange", markLeft);
    window.removeEventListener("pagehide", onPageHide);
  }
  return stop;
}

export const HANDOFF_MARK = "iab";
export const HANDOFF_TEST_PARAM = "iab_handoff";
export const HANDOFF_SESSION_KEY = "zavi_iab_handoff";

const HANDOFF_SKIP_PATH = /^\/(?:api|auth|connectors|invite|login|loginas|oauth|onboarding|reset-password|start|workspace)(?:\/|$)/;
const HANDOFF_SKIP_PARAMS = ["code", "token", "token_hash", "access_token", "refresh_token", "key", "error", "error_code", "error_description"];

export function handoffTarget(
  pageUrl: string,
  userAgent: string | null | undefined,
  enabled: boolean,
): ExternalBrowserLink | null {
  if (detectInAppBrowser(userAgent)?.app !== "X") return null;
  if (!/Android/.test(userAgent ?? "") && iosMajor(userAgent) < SAFARI_SCHEME_MIN_IOS) return null;
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return null;
  }
  if (!enabled && url.searchParams.get(HANDOFF_TEST_PARAM) !== "1") return null;
  if (url.searchParams.has(HANDOFF_MARK)) return null;
  if (url.hash.length > 1) return null;
  if (!isPublicPath(url.pathname) || HANDOFF_SKIP_PATH.test(url.pathname)) return null;
  if (HANDOFF_SKIP_PARAMS.some((name) => url.searchParams.has(name))) return null;
  url.searchParams.delete(HANDOFF_TEST_PARAM);
  url.searchParams.set(HANDOFF_MARK, "x");
  if (!url.searchParams.get("utm_source")) url.searchParams.set("utm_source", "x");
  return externalBrowserLink(url.toString(), userAgent);
}

const SAFARI_SCHEME_MIN_IOS = 17;

function iosMajor(userAgent: string | null | undefined): number {
  const found = /(?:iPhone OS|CPU OS) (\d+)_/.exec(userAgent ?? "");
  return found ? Number(found[1]) : 0;
}

export function handoffEnabled(setting: string | null | undefined): boolean {
  return !["off", "no", "false", "0"].includes((setting ?? "").trim().toLowerCase());
}

export function handoffPage(landedHref: string | null, currentHref: string): string {
  if (!landedHref) return currentHref;
  try {
    return new URL(landedHref).pathname === new URL(currentHref).pathname ? landedHref : currentHref;
  } catch {
    return currentHref;
  }
}

export function leaveTo(href: string): void {
  window.location.href = href;
}
