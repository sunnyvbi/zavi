
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { aliasDomain, deriveAlias, isAliasEmail, maskEmail, normalizeEmail } from "./alias";
import { GoTrueEmailThrottled, SiteAuthError } from "./errors";
import type {
  GoTrueSession,
  IdentityRow,
  MemberRow,
  ShardHandle,
  SiteAuthDirectory,
  SiteMailer,
  SiteRecord,
  SiteRequestContext,
  SiteSession,
  VerifyType,
} from "./types";

export const FLOOR_ENUMERATION_MS = 1200;
export const FLOOR_LOGIN_MS = 1000;
export const REAUTH_WINDOW_S = 10 * 60;
export const EMAIL_CHANGE_TTL_S = 60 * 60;
export const SIGNUP_TTL_S = 24 * 60 * 60;
export const SIGNUP_COOLDOWN_S = 60;
export const SIGNUP_MAX_LIVE = 3;
export const CONFIRM_LEASE_S = 30;
export const OUTBOX_LIMITED_RETRY_S = 15 * 60;
const VERIFY_TYPES: ReadonlySet<string> = new Set(["magiclink", "recovery", "invite", "email"]);
const ROLE_RE = /^[a-z][a-z0-9_]{0,31}$/;

export const LIMITS = {
  signupIp: [3600, 20],
  signupEmail: [3600, 5],
  loginIp: [600, 30],
  loginEmail: [600, 10],
  linkIp: [3600, 10],
  linkEmail: [3600, 5],
  linkThrottledEmail: [300, 1],
  callbackIp: [600, 30],
  refreshIp: [600, 120],
  userSensitive: [3600, 10],
  emailChangeTarget: [3600, 3],
  memberAdmin: [600, 120],
  memberInvite: [3600, 50],
} as const satisfies Record<string, readonly [number, number]>;

export interface BrokerDeps {
  directory: SiteAuthDirectory;
  mailer: SiteMailer;
  aliasKey: () => string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  newId?: () => string;
  newToken?: () => string;
  schedule?: (fn: () => void, ms: number) => void;
  turnstileSecret?: (siteId: string) => Promise<string | null>;
  fetch?: typeof fetch;
  background?: (p: Promise<unknown>) => void;
  log?: (msg: string) => void;
}

interface Resolved {
  site: SiteRecord;
  shard: ShardHandle;
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function bg(deps: BrokerDeps, p: Promise<unknown>, what: string): void {
  const guarded = p.catch((e) => deps.log?.(`[site-auth] ${what}: ${(e as Error).message}`));
  if (deps.background) deps.background(guarded);
  else void guarded;
}

async function resolve(deps: BrokerDeps, ctx: SiteRequestContext): Promise<Resolved> {
  const site = await deps.directory.site(ctx.siteId);
  if (!site || !site.active || site.siteId !== ctx.siteId) throw new SiteAuthError("site_unavailable");
  if (ctx.shardId !== undefined && ctx.shardId !== site.shardId) throw new SiteAuthError("site_unavailable");
  const shard = await deps.directory.shard(site.shardId);
  if (!shard) throw new SiteAuthError("unavailable");
  return { site, shard };
}

async function limit(r: Resolved, name: keyof typeof LIMITS, parts: string[]): Promise<void> {
  const [win, max] = LIMITS[name];
  const key = `rl:${name}:${sha256Hex([r.site.siteId, ...parts].join("|")).slice(0, 40)}`;
  if (!(await r.shard.store.rateTake(key, win, max))) throw new SiteAuthError("rate_limited");
}

async function withFloor<T>(deps: BrokerDeps, ms: number, fn: () => Promise<T>): Promise<T> {
  const start = deps.now();
  try {
    return await fn();
  } finally {
    const left = ms - (deps.now() - start);
    if (left > 0) await deps.sleep(left);
  }
}

function validatePassword(p: unknown): string {
  if (typeof p !== "string") throw new SiteAuthError("weak_password");
  const bytes = Buffer.byteLength(p, "utf8");
  if (p.length < 8 || bytes > 72) throw new SiteAuthError("weak_password");
  return p;
}

function claimsOf(token: string): Record<string, unknown> | null {
  try {
    return decodeJwt(token) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function toSession(s: GoTrueSession, email?: string | null): SiteSession {
  const out: SiteSession = {
    access_token: s.access_token,
    refresh_token: s.refresh_token,
    expires_at: s.expires_at,
    expires_in: s.expires_in,
    token_type: s.token_type,
  };
  if (email && !isAliasEmail(email, aliasDomain())) out.email = email;
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const randomSecret = () => randomBytes(32).toString("base64url");

export function sessionTokenFits(token: string, siteId: string, userId?: string): boolean {
  try {
    const h = decodeProtectedHeader(token);
    const c = decodeJwt(token) as Record<string, unknown>;
    return (
      h.alg === "ES256" && typeof h.kid === "string" && h.kid.length > 0 &&
      c.role === "authenticated" && typeof c.sub === "string" && UUID_RE.test(c.sub) &&
      c.site_id === siteId && typeof c.session_started_at === "number" &&
      (userId === undefined || c.sub === userId)
    );
  } catch {
    return false;
  }
}

async function assertSessionSite(deps: BrokerDeps, r: Resolved, s: GoTrueSession): Promise<void> {
  if (sessionTokenFits(s.access_token, r.site.siteId, s.user_id)) return;
  deps.log?.(`[site-auth] session for another site refused (site ${r.site.siteId})`);
  await r.shard.gotrue.signOut(s.access_token, "local").catch(() => {});
  throw new SiteAuthError("invalid_link");
}

export function confirmLink(hostname: string, type: string, token: string): string {
  return `https://${hostname}/api/auth/callback?type=${encodeURIComponent(type)}&token_hash=${encodeURIComponent(token)}`;
}

export function signupToken(aliasKey: string, challengeId: string): string {
  return createHmac("sha256", aliasKey).update(`zavi-signup-challenge-v1:${challengeId}`).digest("base64url");
}

function bearer(header: unknown): string {
  const h = typeof header === "string" ? header : "";
  const m = /^Bearer ([A-Za-z0-9._-]{20,4096})$/.exec(h.trim());
  if (!m) throw new SiteAuthError("unauthorized");
  return m[1];
}

interface AuthedUser {
  uid: string;
  identity: IdentityRow;
  token: string;
  claims: Record<string, unknown>;
}

async function authUser(r: Resolved, authorization: unknown): Promise<AuthedUser> {
  const token = bearer(authorization);
  const claims = claimsOf(token);
  if (!claims || claims.site_id !== r.site.siteId || typeof claims.session_started_at !== "number") {
    throw new SiteAuthError("unauthorized");
  }
  const user = await r.shard.gotrue.getUser(token);
  if (!user || user.id !== claims.sub) throw new SiteAuthError("unauthorized");
  const identity = await r.shard.store.identityByUser(user.id);
  if (
    !identity ||
    identity.siteId !== r.site.siteId ||
    !(identity.state === "active" || identity.state === "email_change_pending") ||
    identity.memberStatus !== "active" ||
    (identity.sessionsValidAfter !== null && (claims.session_started_at as number) < identity.sessionsValidAfter)
  ) {
    throw new SiteAuthError("unauthorized");
  }
  return { uid: user.id, identity, token, claims };
}

async function requireReauth(deps: BrokerDeps, r: Resolved, u: AuthedUser, currentPassword: unknown): Promise<void> {
  if (typeof currentPassword === "string" && currentPassword.length > 0) {
    const s = await r.shard.gotrue.signInWithPassword(u.identity.alias, currentPassword);
    if (!s || s.user_id !== u.uid) throw new SiteAuthError("reauth_required");
    await r.shard.gotrue.signOut(s.access_token, "local").catch(() => {});
    return;
  }
  const amr = Array.isArray(u.claims.amr) ? (u.claims.amr as Array<{ timestamp?: unknown }>) : [];
  const last = Math.max(0, ...amr.map((a) => (typeof a?.timestamp === "number" ? a.timestamp : 0)));
  if (deps.now() / 1000 - last > REAUTH_WINDOW_S) throw new SiteAuthError("reauth_required");
}

function emailOrThrow(raw: unknown, code: "bad_request" | "invalid_credentials" = "bad_request"): string {
  const e = normalizeEmail(raw);
  if (!e) throw new SiteAuthError(code);
  return e;
}

function newToken(deps: BrokerDeps): string {
  return deps.newToken ? deps.newToken() : randomBytes(32).toString("base64url");
}

function newId(deps: BrokerDeps): string {
  return deps.newId ? deps.newId() : randomUUID();
}

const CHECK_EMAIL = { status: "check_email" } as const;

export async function ensureAuthUser(shard: ShardHandle, id: string, alias: string): Promise<void> {
  try {
    await shard.gotrue.createUser({ id, email: alias, password: randomSecret(), emailConfirm: true });
    return;
  } catch (e) {
    const u = await shard.gotrue.getUserById(id);
    if (!u || u.id !== id || u.email !== alias) throw e;
    await shard.gotrue.updateUserById(id, { password: randomSecret(), ...(u.emailConfirmedAt ? {} : { emailConfirm: true }) });
  }
}

async function mintSession(r: Resolved, alias: string): Promise<GoTrueSession | null> {
  const hash = await r.shard.gotrue.magicLinkTokenHash(alias);
  return r.shard.gotrue.verifyOtp(hash, "magiclink");
}

export async function signup(deps: BrokerDeps, ctx: SiteRequestContext, body: any): Promise<typeof CHECK_EMAIL> {
  const email = emailOrThrow(body?.email);
  const r = await resolve(deps, ctx);
  await limit(r, "signupIp", [ctx.ip]);
  await limit(r, "signupEmail", [email]);
  return withFloor(deps, FLOOR_ENUMERATION_MS, async () => {
    const alias = deriveAlias(deps.aliasKey(), r.site.siteId, email);
    const challengeId = newId(deps);
    const token = signupToken(deps.aliasKey(), challengeId);
    await r.shard.store.signupRequest({
      siteId: r.site.siteId, email, alias, uid: newId(deps), challengeId, tokenSha256: sha256Hex(token),
      ttlSeconds: SIGNUP_TTL_S, cooldownSeconds: SIGNUP_COOLDOWN_S, maxLive: SIGNUP_MAX_LIVE,
    });
    bg(deps, drainOutbox(deps, r.shard), "outbox drain");
    return CHECK_EMAIL;
  });
}

export async function drainOutbox(deps: BrokerDeps, shard: ShardHandle, max = 20): Promise<number> {
  let sent = 0;
  for (const row of await shard.store.outboxClaim(max, 60)) {
    const site = await deps.directory.site(row.siteId);
    if (!site || !site.active || site.shardId !== shard.shardId) {
      await shard.store.outboxDone(row.id);
      continue;
    }
    try {
      let res: "sent" | "limited" | "suppressed" = "sent";
      if (row.kind === "verify_signup" && row.challengeId) {
        const link = confirmLink(site.hostname, "signup", signupToken(deps.aliasKey(), row.challengeId));
        res = await deps.mailer.send(shard.store, { site, to: row.to, kind: "verify_signup", link });
      } else if (row.kind === "account_exists") {
        res = await deps.mailer.send(shard.store, { site, to: row.to, kind: "account_exists", link: `https://${site.hostname}/auth/sign-in` });
      }
      if (res === "limited") {
        await shard.store.outboxDefer(row.id, OUTBOX_LIMITED_RETRY_S);
        continue;
      }
      await shard.store.outboxDone(row.id);
      sent++;
    } catch (e) {
      deps.log?.(`[site-auth] outbox send failed: ${(e as Error).message}`);
    }
  }
  return sent;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export const INTERSTITIAL_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "strict-origin",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
};

export function signupInterstitial(tokenHash: unknown): string {
  const ok = typeof tokenHash === "string" && /^[A-Za-z0-9_\-.=]{8,512}$/.test(tokenHash);
  const body = ok
    ? `<h1>Confirm your email</h1><p>Press the button to finish creating your account.</p>
<form method="post" action="/api/auth/confirm"><input type="hidden" name="type" value="signup"><input type="hidden" name="token_hash" value="${esc(tokenHash as string)}"><button type="submit">Confirm my email</button></form>`
    : `<h1>This link is not valid</h1><p>Request a new one from the sign-up page.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="strict-origin"><title>Confirm your email</title><style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#111;line-height:1.5}button{font:inherit;padding:.6rem 1.2rem;border-radius:.4rem;border:0;background:#111;color:#fff;cursor:pointer}</style></head><body>${body}</body></html>`;
}

export async function confirmSignup(
  deps: BrokerDeps,
  ctx: SiteRequestContext,
  body: any,
): Promise<{ type: "signup"; session?: SiteSession; confirmed?: true }> {
  const tokenHash = typeof body?.token_hash === "string" ? body.token_hash : "";
  if (body?.type !== "signup" || !/^[A-Za-z0-9_\-.=]{8,512}$/.test(tokenHash)) throw new SiteAuthError("invalid_link");
  const r = await resolve(deps, ctx);
  await limit(r, "callbackIp", [ctx.ip]);
  const sha = sha256Hex(tokenHash);
  const { store, gotrue } = r.shard;
  const b = await store.signupConfirmBegin(r.site.siteId, sha, CONFIRM_LEASE_S);
  if (b.outcome === "expired") throw new SiteAuthError("link_expired");
  if (b.outcome === "busy") throw new SiteAuthError("unavailable");
  if (b.outcome === "done") return { type: "signup", confirmed: true };
  if (b.outcome !== "ok") throw new SiteAuthError("invalid_link");

  try {
    await gotrue.createUser({ id: b.authUserId, email: b.alias, password: randomSecret(), emailConfirm: true });
  } catch (e) {
    const u = await gotrue.getUserById(b.authUserId).catch(() => undefined);
    if (u === undefined) throw new SiteAuthError("unavailable");
    if (u === null) {
      await store.signupConfirmRelease(r.site.siteId, sha).catch(() => {});
      deps.log?.(`[site-auth] signup create failed: ${(e as Error).message}`);
      throw new SiteAuthError("unavailable");
    }
    if (u.id !== b.authUserId || u.email !== b.alias) {
      await store.signupQuarantine(r.site.siteId, sha).catch(() => {});
      deps.log?.(`[site-auth] signup quarantined: preallocated auth user does not match (site ${r.site.siteId})`);
      throw new SiteAuthError("invalid_link");
    }
    await gotrue.updateUserById(b.authUserId, { password: randomSecret(), ...(u.emailConfirmedAt ? {} : { emailConfirm: true }) });
  }

  const fin = await store.signupConfirmFinish(r.site.siteId, sha);
  if (fin === "conflict") {
    await gotrue.deleteUser(b.authUserId).catch((e) => deps.log?.(`[site-auth] conflict cleanup: ${e.message}`));
    throw new SiteAuthError("invalid_link");
  }
  if (fin === "done") return { type: "signup", confirmed: true };
  if (fin !== "ok") throw new SiteAuthError("invalid_link");
  return signedUp(deps, r, b.alias, b.email);
}

async function signedUp(deps: BrokerDeps, r: Resolved, alias: string, email: string): Promise<{ type: "signup"; session?: SiteSession; confirmed?: true }> {
  try {
    const s = await mintSession(r, alias);
    if (s) {
      await assertSessionSite(deps, r, s);
      return { type: "signup", session: toSession(s, email) };
    }
  } catch (e) {
    deps.log?.(`[site-auth] signup session mint failed: ${(e as Error).message}`);
  }
  return { type: "signup", confirmed: true };
}

export async function login(deps: BrokerDeps, ctx: SiteRequestContext, body: any): Promise<{ session: SiteSession }> {
  const email = emailOrThrow(body?.email, "invalid_credentials");
  if (typeof body?.password !== "string" || body.password.length === 0 || body.password.length > 1024) {
    throw new SiteAuthError("invalid_credentials");
  }
  const r = await resolve(deps, ctx);
  await limit(r, "loginIp", [ctx.ip]);
  await limit(r, "loginEmail", [email]);
  return withFloor(deps, FLOOR_LOGIN_MS, async () => {
    const alias = deriveAlias(deps.aliasKey(), r.site.siteId, email);
    const s = await r.shard.gotrue.signInWithPassword(alias, body.password);
    if (!s) throw new SiteAuthError("invalid_credentials");
    await assertSessionSite(deps, r, s);
    return { session: toSession(s, email) };
  });
}

type LinkKind = "magiclink" | "recovery";

async function sendLinkFlow(deps: BrokerDeps, ctx: SiteRequestContext, body: any, kind: LinkKind): Promise<typeof CHECK_EMAIL> {
  const email = emailOrThrow(body?.email);
  const r = await resolve(deps, ctx);
  await limit(r, "linkIp", [ctx.ip]);
  await limit(r, "linkEmail", [email]);
  return withFloor(deps, FLOOR_ENUMERATION_MS, async () => {
    const id = await r.shard.store.identityByEmail(r.site.siteId, email);
    if (id && (id.state === "active" || id.state === "email_change_pending") && id.memberStatus === "active") {
      bg(deps, sendLink(deps, r, id, kind), "link mail");
    }
    return CHECK_EMAIL;
  });
}

async function sendLink(deps: BrokerDeps, r: Resolved, id: IdentityRow, kind: LinkKind): Promise<void> {
  try {
    if (kind === "magiclink") await r.shard.gotrue.sendMagicLink(id.alias);
    else await r.shard.gotrue.sendRecovery(id.alias);
    return;
  } catch (e) {
    if (!(e instanceof GoTrueEmailThrottled)) throw e;
  }
  const [win, max] = LIMITS.linkThrottledEmail;
  const key = `rl:linkThrottledEmail:${sha256Hex([r.site.siteId, id.emailNorm].join("|")).slice(0, 40)}`;
  if (!(await r.shard.store.rateTake(key, win, max))) {
    deps.log?.(`[site-auth] ${kind} not mailed: the auth service's per-user window, and the broker already sent one (site ${r.site.siteId})`);
    return;
  }
  const hash = kind === "magiclink"
    ? await r.shard.gotrue.magicLinkTokenHash(id.alias)
    : await r.shard.gotrue.recoveryTokenHash(id.alias);
  const sent = await deps.mailer.send(r.shard.store, {
    site: r.site, to: id.emailNorm, kind: kind === "magiclink" ? "magic_link" : "recovery", link: confirmLink(r.site.hostname, kind, hash),
  });
  deps.log?.(`[site-auth] ${kind} mailed by the broker after the auth service throttled it (site ${r.site.siteId}): ${sent}`);
}

export function magicLink(deps: BrokerDeps, ctx: SiteRequestContext, body: any) {
  return sendLinkFlow(deps, ctx, body, "magiclink");
}

export function recover(deps: BrokerDeps, ctx: SiteRequestContext, body: any) {
  return sendLinkFlow(deps, ctx, body, "recovery");
}

export function callbackLanding(query: { type?: unknown; token_hash?: unknown }): string {
  const type = typeof query.type === "string" ? query.type : "";
  const tokenHash = typeof query.token_hash === "string" ? query.token_hash : "";
  if (!(type === "email_change" || VERIFY_TYPES.has(type)) || !/^[A-Za-z0-9_\-.=]{8,512}$/.test(tokenHash)) {
    return "/auth/confirm#error=invalid_link";
  }
  return `/auth/confirm#type=${encodeURIComponent(type)}&token_hash=${encodeURIComponent(tokenHash)}`;
}

export function callbackResultFragment(r: { type: string; session?: SiteSession; email_changed?: true; confirmed?: true }): string {
  const p = new URLSearchParams({ type: r.type });
  if (r.email_changed) p.set("email_changed", "1");
  if (r.confirmed) p.set("confirmed", "1");
  if (r.session) {
    for (const [k, v] of Object.entries(r.session)) p.set(k, String(v));
  }
  return `/auth/confirm#${p.toString()}`;
}

export async function admitGatewayRequest(
  deps: BrokerDeps,
  v: { siteId: string; shardId: string; requestId: string; ts: number },
  ttlSeconds: number,
): Promise<void> {
  const site = await deps.directory.site(v.siteId);
  if (!site || site.shardId !== v.shardId) throw new SiteAuthError("unauthorized");
  const shard = await deps.directory.shard(site.shardId);
  if (!shard) throw new SiteAuthError("unavailable");
  if (!(await shard.store.claimNonce(`gw:${v.siteId}:${v.requestId}:${v.ts}`, ttlSeconds))) {
    throw new SiteAuthError("unauthorized");
  }
  sweepShard(deps, shard);
}

export async function callback(
  deps: BrokerDeps,
  ctx: SiteRequestContext,
  body: any,
): Promise<{ type: string; session?: SiteSession; email_changed?: true }> {
  const type = typeof body?.type === "string" ? body.type : "";
  const tokenHash = typeof body?.token_hash === "string" ? body.token_hash : "";
  if (!tokenHash || tokenHash.length > 512 || !/^[A-Za-z0-9_\-.=]+$/.test(tokenHash)) throw new SiteAuthError("invalid_link");
  const r = await resolve(deps, ctx);
  await limit(r, "callbackIp", [ctx.ip]);
  if (type === "email_change") return confirmEmailChange(deps, r, tokenHash);
  if (!VERIFY_TYPES.has(type)) throw new SiteAuthError("invalid_link");

  const s = await r.shard.gotrue.verifyOtp(tokenHash, type as VerifyType);
  if (!s) throw new SiteAuthError("invalid_link");
  const identity = await r.shard.store.identityByUser(s.user_id);
  if (!identity || identity.siteId !== r.site.siteId) {
    await r.shard.gotrue.signOut(s.access_token, "local").catch(() => {});
    throw new SiteAuthError("invalid_link");
  }
  await assertSessionSite(deps, r, s);
  return { type, session: toSession(s, identity.emailNorm) };
}

export async function refresh(deps: BrokerDeps, ctx: SiteRequestContext, body: any): Promise<{ session: SiteSession }> {
  const rt = typeof body?.refresh_token === "string" ? body.refresh_token : "";
  if (!rt || rt.length > 512) throw new SiteAuthError("unauthorized");
  const r = await resolve(deps, ctx);
  await limit(r, "refreshIp", [ctx.ip]);
  const s = await r.shard.gotrue.refresh(rt);
  if (!s) throw new SiteAuthError("unauthorized");
  if (!sessionTokenFits(s.access_token, r.site.siteId, s.user_id)) {
    await r.shard.gotrue.signOut(s.access_token, "local").catch(() => {});
    throw new SiteAuthError("unauthorized");
  }
  const identity = await r.shard.store.identityByUser(s.user_id).catch(() => null);
  return { session: toSession(s, identity && identity.siteId === r.site.siteId ? identity.emailNorm : null) };
}

export async function logout(deps: BrokerDeps, ctx: SiteRequestContext, body: any, authorization: unknown) {
  const r = await resolve(deps, ctx);
  const u = await authUser(r, authorization);
  if (body?.scope === "global") {
    await r.shard.store.revokeSessions(r.site.siteId, u.uid);
    await r.shard.gotrue.signOut(u.token, "global").catch(() => {});
  } else {
    await r.shard.gotrue.signOut(u.token, "local");
  }
  return { signed_out: true as const };
}

export async function changePassword(deps: BrokerDeps, ctx: SiteRequestContext, body: any, authorization: unknown) {
  const password = validatePassword(body?.password);
  const r = await resolve(deps, ctx);
  const u = await authUser(r, authorization);
  await limit(r, "userSensitive", ["password", u.uid]);
  await requireReauth(deps, r, u, body?.current_password);
  await r.shard.store.revokeSessions(r.site.siteId, u.uid);
  await r.shard.gotrue.signOut(u.token, "global").catch(() => {});
  await r.shard.gotrue.updateUserById(u.uid, { password });
  const s = await r.shard.gotrue.signInWithPassword(u.identity.alias, password).catch(() => null);
  if (s && sessionTokenFits(s.access_token, r.site.siteId, u.uid)) {
    return { updated: true as const, session: toSession(s, u.identity.emailNorm) };
  }
  return { updated: true as const };
}

export async function requestEmailChange(deps: BrokerDeps, ctx: SiteRequestContext, body: any, authorization: unknown) {
  const newEmail = emailOrThrow(body?.new_email);
  const r = await resolve(deps, ctx);
  const u = await authUser(r, authorization);
  await limit(r, "userSensitive", ["email", u.uid]);
  await limit(r, "emailChangeTarget", [newEmail]);
  await requireReauth(deps, r, u, body?.current_password);
  return withFloor(deps, FLOOR_ENUMERATION_MS, async () => {
    const token = newToken(deps);
    const newAlias = deriveAlias(deps.aliasKey(), r.site.siteId, newEmail);
    const out = await r.shard.store.beginEmailChange(
      r.site.siteId, u.uid, newEmail, newAlias, sha256Hex(token), EMAIL_CHANGE_TTL_S,
    );
    if (out === "same") throw new SiteAuthError("bad_request", "That is already your email.");
    if (out === "invalid") throw new SiteAuthError("unauthorized");
    if (out === "reserved") {
      bg(deps, deps.mailer.send(r.shard.store, {
        site: r.site, to: newEmail, kind: "email_change_confirm", link: confirmLink(r.site.hostname, "email_change", token),
      }), "change mail");
    }
    return CHECK_EMAIL;
  });
}

async function confirmEmailChange(deps: BrokerDeps, r: Resolved, token: string) {
  const c = await r.shard.store.claimEmailChange(r.site.siteId, sha256Hex(token));
  if (c.outcome === "expired") throw new SiteAuthError("link_expired");
  if (c.outcome !== "ok") throw new SiteAuthError("invalid_link");
  try {
    await r.shard.gotrue.updateUserById(c.authUserId, { email: c.newAlias, emailConfirm: true });
  } catch (e) {
    deps.log?.(`[site-auth] email change auth update failed: ${(e as Error).message}`);
    throw new SiteAuthError("unavailable");
  }
  let committed: { oldEmail: string; newEmail: string };
  try {
    committed = await r.shard.store.commitEmailChange(c.id);
  } catch (e) {
    deps.log?.(`[site-auth] email change commit failed, reverting: ${(e as Error).message}`);
    const oldAlias = deriveAlias(deps.aliasKey(), r.site.siteId, c.oldEmail);
    await r.shard.gotrue.updateUserById(c.authUserId, { email: oldAlias, emailConfirm: true });
    await r.shard.store.failEmailChange(c.id);
    throw new SiteAuthError("invalid_link");
  }
  bg(deps, deps.mailer.send(r.shard.store, {
    site: r.site, to: committed.oldEmail, kind: "email_changed_notice", detail: maskEmail(committed.newEmail),
  }), "notice mail");
  const s = await mintSession(r, c.newAlias).catch(() => null);
  if (s && sessionTokenFits(s.access_token, r.site.siteId, c.authUserId)) {
    return { type: "email_change", email_changed: true as const, session: toSession(s, committed.newEmail) };
  }
  return { type: "email_change", email_changed: true as const };
}

export async function deleteAccount(deps: BrokerDeps, ctx: SiteRequestContext, body: any, authorization: unknown) {
  const r = await resolve(deps, ctx);
  const u = await authUser(r, authorization);
  await limit(r, "userSensitive", ["delete", u.uid]);
  await requireReauth(deps, r, u, body?.current_password);
  if (!(await r.shard.store.beginDeletion(r.site.siteId, u.uid))) throw new SiteAuthError("unauthorized");
  return finishRemoval(deps, r.shard, r.site.siteId, u.uid, { deleted: true as const });
}

async function finishRemoval<T extends object>(deps: BrokerDeps, shard: ShardHandle, siteId: string, uid: string, ok: T) {
  try {
    await runDeletion(shard, siteId, uid);
    return ok;
  } catch (e) {
    deps.log?.(`[site-auth] deletion of ${uid} interrupted: ${(e as Error).message}`);
    scheduleDeletionRetry(deps, shard, siteId, uid);
    return { ...ok, completing: true as const };
  }
}

const RETRY_DELAYS_MS = [30_000, 120_000, 600_000];

function scheduleDeletionRetry(deps: BrokerDeps, shard: ShardHandle, siteId: string, uid: string, attempt = 0): void {
  if (attempt >= RETRY_DELAYS_MS.length) return;
  const schedule = deps.schedule ?? ((fn: () => void, ms: number) => void setTimeout(fn, ms).unref?.());
  schedule(() => {
    runDeletion(shard, siteId, uid).catch((e) => {
      deps.log?.(`[site-auth] deletion retry ${attempt + 1} of ${uid} failed: ${(e as Error).message}`);
      scheduleDeletionRetry(deps, shard, siteId, uid, attempt + 1);
    });
  }, RETRY_DELAYS_MS[attempt]);
}

const lastSweep = new WeakMap<ShardHandle, number>();
export const SWEEP_EVERY_MS = 10 * 60 * 1000;

export function sweepShard(deps: BrokerDeps, shard: ShardHandle): void {
  const now = deps.now();
  if (now - (lastSweep.get(shard) ?? -Infinity) < SWEEP_EVERY_MS) return;
  lastSweep.set(shard, now);
  bg(deps, resumeDeletions(shard, 5, deps.log), "deletion sweep");
  bg(deps, drainOutbox(deps, shard), "outbox sweep");
  bg(deps, purgeSignups(shard, deps.log), "signup purge");
}
export const sweepDeletions = sweepShard;

export async function purgeSignups(shard: ShardHandle, log?: (m: string) => void, max = 100): Promise<number> {
  let n = 0;
  for (const s of await shard.store.signupPurge(max)) {
    try {
      const u = await shard.gotrue.getUserById(s.authUserId);
      if (u && u.email === s.alias && !(await shard.store.identityByUser(s.authUserId))) {
        await shard.gotrue.deleteUser(s.authUserId);
        n++;
      }
    } catch (e) {
      log?.(`[site-auth] signup purge ${s.authUserId}: ${(e as Error).message}`);
    }
  }
  return n;
}

export async function runDeletion(
  shard: ShardHandle, siteId: string, uid: string, counts: { records: number; files: number } = { records: 0, files: 0 },
): Promise<void> {
  if (!(await shard.store.beginDeletion(siteId, uid))) throw new SiteAuthError("unauthorized");
  for (let i = 0; i < 1000; i++) {
    const names = await shard.store.userObjectNames(siteId, uid, 1000);
    if (names.length === 0) break;
    await shard.gotrue.removeObjects(names);
    counts.files += names.length;
  }
  counts.records += await shard.store.deleteAccountData(siteId, uid);
  await shard.gotrue.deleteUser(uid);
  await shard.store.finishDeletion(uid);
}

export async function resumeDeletions(shard: ShardHandle, max = 100, log?: (m: string) => void): Promise<number> {
  let done = 0;
  for (const d of await shard.store.pendingDeletions(max)) {
    try {
      await runDeletion(shard, d.siteId, d.authUserId);
      done++;
    } catch (e) {
      log?.(`[site-auth] resume deletion ${d.authUserId} failed: ${(e as Error).message}`);
    }
  }
  return done;
}

export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export async function turnstileVerify(deps: BrokerDeps, ctx: SiteRequestContext, body: any): Promise<{ success: boolean }> {
  const token = typeof body?.token === "string" ? body.token : "";
  if (!token || token.length > 2048) return { success: false };
  const r = await resolve(deps, ctx);
  const secret = deps.turnstileSecret ? await deps.turnstileSecret(r.site.siteId) : null;
  if (!secret) throw new SiteAuthError("unavailable");
  const form = new URLSearchParams({ secret, response: token });
  if (typeof body?.ip === "string" && /^[0-9a-f.:]{2,45}$/i.test(body.ip)) form.set("remoteip", body.ip);
  try {
    const res = await (deps.fetch ?? fetch)(TURNSTILE_VERIFY_URL, { method: "POST", body: form });
    const out = (await res.json()) as { success?: unknown; hostname?: unknown };
    return { success: res.ok && out?.success === true && out.hostname === r.site.hostname };
  } catch {
    throw new SiteAuthError("unavailable");
  }
}

function roleOrThrow(raw: unknown): string {
  if (typeof raw !== "string" || !ROLE_RE.test(raw)) throw new SiteAuthError("invalid_role");
  return raw;
}

function userIdOrThrow(raw: unknown): string {
  if (typeof raw !== "string" || !UUID_RE.test(raw)) throw new SiteAuthError("bad_request");
  return raw;
}

async function memberActor(deps: BrokerDeps, ctx: SiteRequestContext, authorization: unknown) {
  const r = await resolve(deps, ctx);
  const u = await authUser(r, authorization);
  await limit(r, "memberAdmin", [u.uid]);
  return { r, u };
}

export interface InviteResult {
  email: string;
  role: string;
  status: "invited";
}

export async function memberInvite(deps: BrokerDeps, ctx: SiteRequestContext, body: any, authorization: unknown): Promise<InviteResult> {
  const email = emailOrThrow(body?.email);
  const role = roleOrThrow(body?.role);
  const { r, u } = await memberActor(deps, ctx, authorization);
  await limit(r, "memberInvite", [u.uid]);
  return withFloor(deps, FLOOR_ENUMERATION_MS, async () => {
    const alias = deriveAlias(deps.aliasKey(), r.site.siteId, email);
    const res = await r.shard.store.memberInviteReserve(r.site.siteId, u.uid, email, alias, newId(deps), role);
    bg(deps, completeInvite(deps, r, u.uid, res, email, alias), "invite completion");
    return { email, role, status: "invited" };
  });
}

async function completeInvite(
  deps: BrokerDeps,
  r: Resolved,
  actor: string,
  res: { outcome: "create" | "exists" | "held"; authUserId: string | null },
  email: string,
  alias: string,
): Promise<void> {
  if (res.outcome === "held" || !res.authUserId) return;
  if (res.outcome === "exists") {
    await deps.mailer.send(r.shard.store, { site: r.site, to: email, kind: "invite", link: `https://${r.site.hostname}/auth/sign-in` });
    return;
  }
  await ensureAuthUser(r.shard, res.authUserId, alias);
  if (!(await r.shard.store.memberInviteFinish(r.site.siteId, actor, res.authUserId))) return;
  const hash = await r.shard.gotrue.magicLinkTokenHash(alias);
  await deps.mailer.send(r.shard.store, { site: r.site, to: email, kind: "invite", link: confirmLink(r.site.hostname, "magiclink", hash) });
}

export async function memberList(deps: BrokerDeps, ctx: SiteRequestContext, query: any, authorization: unknown) {
  const rawLimit = query?.limit;
  const lim = rawLimit === undefined ? 50 : Number(rawLimit);
  if (!Number.isInteger(lim) || lim < 1 || lim > 100) throw new SiteAuthError("bad_request");
  const cursor = query?.cursor === undefined ? null : userIdOrThrow(query.cursor);
  const { r, u } = await memberActor(deps, ctx, authorization);
  const items: MemberRow[] = await r.shard.store.memberList(r.site.siteId, u.uid, cursor, lim);
  return { items, next_cursor: items.length === lim ? items[items.length - 1].user_id : null };
}

export async function memberSetRole(deps: BrokerDeps, ctx: SiteRequestContext, body: any, authorization: unknown): Promise<MemberRow> {
  const target = userIdOrThrow(body?.user_id);
  const role = roleOrThrow(body?.role);
  const { r, u } = await memberActor(deps, ctx, authorization);
  return r.shard.store.memberSetRole(r.site.siteId, u.uid, target, role);
}

export async function memberDisable(deps: BrokerDeps, ctx: SiteRequestContext, body: any, authorization: unknown): Promise<MemberRow> {
  const target = userIdOrThrow(body?.user_id);
  const { r, u } = await memberActor(deps, ctx, authorization);
  return r.shard.store.memberDisable(r.site.siteId, u.uid, target);
}

export async function memberRemove(deps: BrokerDeps, ctx: SiteRequestContext, body: any, authorization: unknown) {
  const target = userIdOrThrow(body?.user_id);
  const { r, u } = await memberActor(deps, ctx, authorization);
  if (!(await r.shard.store.memberRemoveBegin(r.site.siteId, u.uid, target))) throw new SiteAuthError("member_not_found");
  return { user_id: target, removed: true as const };
}

export async function memberReenable(deps: BrokerDeps, ctx: SiteRequestContext, body: any, authorization: unknown): Promise<MemberRow> {
  const target = userIdOrThrow(body?.user_id);
  const { r, u } = await memberActor(deps, ctx, authorization);
  return r.shard.store.memberEnable(r.site.siteId, u.uid, target);
}

export async function memberReassignOwner(deps: BrokerDeps, ctx: SiteRequestContext, body: any, authorization: unknown) {
  const collection = body?.collection;
  if (typeof collection !== "string" || !/^[a-z][a-z0-9_]{0,62}$/.test(collection)) throw new SiteAuthError("bad_request");
  const id = userIdOrThrow(body?.id);
  const to = userIdOrThrow(body?.to_user_id);
  const { r, u } = await memberActor(deps, ctx, authorization);
  return r.shard.store.memberReassignRecord(r.site.siteId, u.uid, collection, id, to);
}

export async function memberDeleteData(deps: BrokerDeps, ctx: SiteRequestContext, body: any, authorization: unknown) {
  const target = userIdOrThrow(body?.user_id);
  const { r, u } = await memberActor(deps, ctx, authorization);
  await r.shard.store.memberDeleteDataBegin(r.site.siteId, u.uid, target, body?.confirm === true);
  const counts = { records: 0, files: 0 };
  try {
    await runDeletion(r.shard, r.site.siteId, target, counts);
    return { user_id: target, ...counts };
  } catch (e) {
    deps.log?.(`[site-auth] deletion of ${target} interrupted: ${(e as Error).message}`);
    scheduleDeletionRetry(deps, r.shard, r.site.siteId, target);
    return { user_id: target, ...counts, completing: true as const };
  }
}
