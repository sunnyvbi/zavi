export const SITE_PREVIEW_COOKIE_KEY = "zavi.sitePreviewCookie";
export const SITE_PREVIEW_END_PATH = "/__zavi_preview_end";
const PREVIEW_ENTRY_PREFIX = "/__zavi_preview/";

type Marks = Record<string, number>;

function read(now: number): Marks {
  try {
    const raw = window.localStorage.getItem(SITE_PREVIEW_COOKIE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    const marks: Marks = {};
    if (parsed && typeof parsed === "object") {
      for (const [host, until] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof until === "number" && until > now) marks[host] = until;
      }
    }
    return marks;
  } catch {
    return {};
  }
}

function write(marks: Marks): void {
  try {
    if (Object.keys(marks).length === 0) window.localStorage.removeItem(SITE_PREVIEW_COOKIE_KEY);
    else window.localStorage.setItem(SITE_PREVIEW_COOKIE_KEY, JSON.stringify(marks));
  } catch {
    return;
  }
}

function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u.host.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function noteSitePreviewCookie(url: string, expiresAt: number, now: number = Date.now()): void {
  const host = hostOf(url);
  if (!host || !new URL(url).pathname.startsWith(PREVIEW_ENTRY_PREFIX) || !(expiresAt > now)) return;
  const marks = read(now);
  marks[host] = Math.max(marks[host] ?? 0, expiresAt);
  write(marks);
}

export function liveFrameSrc(url: string, now: number = Date.now()): string {
  const host = hostOf(url);
  if (!host) return url;
  const u = new URL(url);
  if (u.pathname.startsWith(PREVIEW_ENTRY_PREFIX) || u.pathname === SITE_PREVIEW_END_PATH) return url;
  const marks = read(now);
  write(marks);
  if (!marks[host]) return url;
  return `${u.origin}${SITE_PREVIEW_END_PATH}?next=${encodeURIComponent(`${u.pathname}${u.search}`)}`;
}
