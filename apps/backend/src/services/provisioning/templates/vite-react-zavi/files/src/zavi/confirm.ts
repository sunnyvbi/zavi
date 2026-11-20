
import type { Zavi } from "./client";

export type ConfirmOutcome =
  | { kind: "navigate"; url: string }
  | { kind: "signed_in"; type: string | null; next: string }
  | { kind: "email_changed" }
  | { kind: "signup_confirmed" }
  | { kind: "error"; code: string; message: string };

export const CONFIRM_MESSAGES: Record<string, string> = {
  invalid_link: "This link is not valid or was already used. Request a new one.",
  link_expired: "This link has expired. Request a new one.",
  rate_limited: "Too many attempts. Wait a minute and try again.",
  site_unavailable: "This site is not available right now.",
  unauthorized: "Please sign in again.",
  unavailable: "Something went wrong on our side. Open the link again in a minute.",
};
const FALLBACK = "This link could not be used. Request a new one.";
const TYPES = new Set(["signup", "magiclink", "recovery", "invite", "email", "email_change"]);
const TOKEN_HASH = /^[A-Za-z0-9_\-.=]{8,512}$/;
const CODE = /^[a-z_]{1,40}$/;

export const PENDING_KEY = "zavi.confirm.pending.v1";
const PENDING_TTL_MS = 10 * 60 * 1000;

export type ConfirmDeps = {
  pending: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void } | null;
  now?: () => number;
  replaceUrl: (url: string) => void;
  navigate: (url: string) => void;
};

export async function runConfirm(zavi: Zavi, href: string, deps: ConfirmDeps): Promise<ConfirmOutcome> {
  const u = new URL(href);
  const frag = new URLSearchParams(u.hash.replace(/^#/, ""));
  if (u.hash) deps.replaceUrl(u.pathname + u.search);
  const now = deps.now ?? (() => Date.now());
  const fail = (code: string): ConfirmOutcome => ({ kind: "error", code, message: CONFIRM_MESSAGES[code] ?? FALLBACK });

  const err = frag.get("error");
  if (err !== null) return fail(CODE.test(err) ? err : "invalid_link");

  const type = frag.get("type");
  const tokenHash = frag.get("token_hash");
  if (tokenHash !== null) {
    if (!type || !TYPES.has(type) || !TOKEN_HASH.test(tokenHash)) return fail("invalid_link");
    const url = `/api/auth/callback?type=${encodeURIComponent(type)}&token_hash=${encodeURIComponent(tokenHash)}&confirm=1`;
    try { deps.pending?.setItem(PENDING_KEY, String(now())); } catch {  }
    deps.navigate(url);
    return { kind: "navigate", url };
  }

  let started: number | null = null;
  try {
    const raw = deps.pending?.getItem(PENDING_KEY) ?? null;
    deps.pending?.removeItem(PENDING_KEY);
    started = raw !== null && /^[0-9]{1,16}$/.test(raw) ? Number(raw) : null;
  } catch { started = null; }
  const fresh = started !== null && now() - started >= 0 && now() - started <= PENDING_TTL_MS;
  if (type === "signup") {
    try { await zavi.auth.ready(); } catch { return fail("site_unavailable"); }
    const signedUpAs = zavi.auth.takeSignupMarker();
    if (!frag.get("access_token")) return { kind: "signup_confirmed" };
    const s = signedUpAs ? await zavi.auth.adoptSignupSession(Object.fromEntries(frag.entries()), signedUpAs) : null;
    if (!s) return { kind: "signup_confirmed" };
    zavi.auth.takeNext();
    return { kind: "signed_in", type, next: "/account?welcome=1" };
  }

  if (frag.get("access_token")) {
    if (!fresh) return fail("invalid_link");
    const s = await zavi.auth.adoptSession(Object.fromEntries(frag.entries()));
    if (!s) return fail("invalid_link");
    const remembered = zavi.auth.takeNext();
    const next = type === "recovery" ? "/account?reset=1"
      : type === "signup" ? "/account?welcome=1"
      : remembered ?? (zavi.auth.user()?.role === "admin" ? "/admin" : "/");
    return { kind: "signed_in", type, next };
  }

  if (type === "email_change" && frag.get("email_changed") === "1") return { kind: "email_changed" };
  return fail("invalid_link");
}
