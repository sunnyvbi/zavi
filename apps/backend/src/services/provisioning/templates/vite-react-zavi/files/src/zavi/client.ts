
import { ZaviError, codeForReason, codeForStatus } from "./errors";

export type Session = { access_token: string; refresh_token: string; expires_at: number; expires_in?: number; token_type: string; email?: string };
export type User = { id: string; email: string | null; role: string | null };

export type ZaviRecord<T = Record<string, unknown>> = {
  id: string;
  data: T;
  mine: boolean;
  created_at: string;
  updated_at: string;
};
export type Page<T> = { items: ZaviRecord<T>[]; next_cursor: string | null };

export type Scalar = string | number | boolean;
export type FilterOps = { eq?: Scalar; in?: Scalar[]; gt?: Scalar; gte?: Scalar; lt?: Scalar; lte?: Scalar; prefix?: string };
export type Filter = Record<string, Scalar | FilterOps>;
export type Order = string;
export type ListOptions = { filter?: Filter; order?: Order; limit?: number; cursor?: string | null };

export type ActionRequest = { targetId: string; data?: Record<string, unknown> } | { recordId: string };
export type ActionResult = { action: string; target_id: string; record_id: string; counter: number; replayed: boolean };
export type Transition = { id: string; from: string; to: string; transitioned: boolean };
export type Member = { user_id?: string; email: string | null; role: string; status: "active" | "disabled" | "invited"; created_at?: string };
export type MemberPage = { items: Member[]; next_cursor: string | null };

export type ResponseLike = { status: number; headers: { get(name: string): string | null }; text(): Promise<string> };
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string | Blob | ArrayBuffer | Uint8Array },
) => Promise<ResponseLike>;
export type KeyValueStorage = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
export type LockManagerLike = { request<T>(name: string, fn: () => Promise<T>): Promise<T> };

export type ZaviConfig = {
  fetch: FetchLike;
  origin: string;
  siteId?: () => Promise<string>;
  storage?: KeyValueStorage | null;
  locks?: LockManagerLike | null;
  watchStorage?: (onKey: (key: string | null) => void) => () => void;
  now?: () => number;
  randomBytes?: (n: number) => Uint8Array;
  captchaSiteKey?: () => Promise<string | null>;
};

const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const FN_NAME = /^[a-z][a-z0-9-]{0,47}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const IDEM_KEY = /^[A-Za-z0-9_-]{16,128}$/;
const ROLE = /^[a-z][a-z0-9_]{0,31}$/;
const STATE = /^[^\u0000]{1,100}$/;
const REFRESH_EARLY_S = 30;
const SIGNUP_MARKER_MS = 24 * 60 * 60 * 1000;
export const CAPTCHA_HEADER = "x-zavi-turnstile-token";
export type CaptchaOption = { captchaToken?: string };

export const sessionStorageKey = (siteId: string) => `zavi.auth.v1:${siteId}`;

function decodeClaims(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const json = decodeURIComponent(
      Array.from(atob(b64), (c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`).join(""),
    );
    const v = JSON.parse(json) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function asSession(v: unknown): Session | null {
  const o = v && typeof v === "object" && "session" in (v as object) ? (v as { session: unknown }).session : v;
  if (!o || typeof o !== "object") return null;
  const s = o as Record<string, unknown>;
  const expires = typeof s.expires_at === "string" ? Number(s.expires_at) : s.expires_at;
  if (typeof s.access_token !== "string" || !s.access_token) return null;
  if (typeof s.refresh_token !== "string" || !s.refresh_token) return null;
  if (typeof expires !== "number" || !Number.isFinite(expires)) return null;
  const expiresIn = typeof s.expires_in === "string" ? Number(s.expires_in) : s.expires_in;
  const out: Session = { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: expires, token_type: typeof s.token_type === "string" ? s.token_type : "bearer" };
  if (typeof expiresIn === "number" && Number.isFinite(expiresIn)) out.expires_in = expiresIn;
  if (typeof s.email === "string" && s.email.length <= 254 && /^[^@\s]+@[^@\s]+$/.test(s.email)) out.email = s.email;
  return out;
}

const ALIAS = /^u[a-z2-7]{32}@([a-z0-9-]+\.)*sites-auth\./i;
function isSignInAlias(email: string): boolean {
  return ALIAS.test(email);
}

function check(cond: boolean, reason: string, message: string): void {
  if (!cond) throw new ZaviError("validation", message, { reason });
}

export type Zavi = ReturnType<typeof createZavi>;

export function createZavi(config: ZaviConfig) {
  const now = config.now ?? (() => Date.now());
  const storage = config.storage ?? null;
  const locks = config.locks ?? null;
  const listeners = new Set<(s: Session | null) => void>();
  let session: Session | null = null;
  let siteId: string | null = null;
  let readyPromise: Promise<Session | null> | null = null;
  let refreshing: Promise<Session | null> | null = null;
  let localLock: Promise<unknown> = Promise.resolve();

  const captcha = (opts: CaptchaOption | undefined): Record<string, string> => {
    const t = opts?.captchaToken;
    if (t === undefined || t === "") return {};
    check(typeof t === "string" && t.length <= 2048 && !/[\r\n]/.test(t), "invalid_captcha", "captchaToken must be the Turnstile token string");
    return { [CAPTCHA_HEADER]: t };
  };
  let siteKey: Promise<string | null> | null = null;

  const randomKey = (): string => {
    const bytes = config.randomBytes ? config.randomBytes(24)
      : (() => { const b = new Uint8Array(24); globalThis.crypto.getRandomValues(b); return b; })();
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  };

  const key = () => sessionStorageKey(siteId as string);
  function readStored(): Session | null {
    if (!storage || !siteId) return null;
    try {
      const raw = storage.getItem(key());
      return raw ? asSession(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  }
  function writeStored(s: Session | null): void {
    if (!storage || !siteId) return;
    try {
      if (s) storage.setItem(key(), JSON.stringify(s));
      else storage.removeItem(key());
    } catch {
    }
  }
  function setSession(next: Session | null, persist = true): void {
    const changed = (session?.access_token ?? null) !== (next?.access_token ?? null);
    session = next;
    if (persist) writeStored(next);
    if (changed) for (const l of [...listeners]) l(next);
  }

  async function ready(): Promise<Session | null> {
    await bootstrap();
    return session;
  }

  function bootstrap(): Promise<Session | null> {
    if (!readyPromise) {
      readyPromise = (async () => {
        if (config.siteId) {
          const id = await config.siteId();
          if (!id || typeof id !== "string") throw new ZaviError("server", "could not resolve this site", { reason: "no_site" });
          siteId = id;
        } else {
          siteId = "default";
        }
        setSession(readStored(), false);
        config.watchStorage?.((k) => {
          if (k !== null && k !== key()) return;
          setSession(readStored(), false);
        });
        if (session && session.expires_at - REFRESH_EARLY_S <= now() / 1000) {
          try { await refresh(session); } catch {  }
        }
        return session;
      })();
      readyPromise.catch(() => { readyPromise = null; });
    }
    return readyPromise;
  }

  async function send(method: string, path: string, opts: { body?: unknown; token?: string | null; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { accept: "application/json", ...(opts.headers ?? {}) };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    let res: ResponseLike;
    try {
      res = await config.fetch(path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    } catch (e) {
      throw new ZaviError("offline", "The site could not be reached. Check your connection and try again.", { reason: "offline" });
    }
    let parsed: unknown = null;
    const text = await res.text().catch(() => "");
    if (text) {
      try { parsed = JSON.parse(text); } catch { parsed = null; }
    }
    if (res.status >= 200 && res.status < 300) {
      return { status: res.status, data: parsed && typeof parsed === "object" && "data" in parsed ? (parsed as { data: unknown }).data : null };
    }
    const err = parsed && typeof parsed === "object" ? (parsed as { error?: { code?: unknown; message?: unknown; request_id?: unknown } }).error : undefined;
    const reason = typeof err?.code === "string" ? err.code : `http_${res.status}`;
    const retry = Number(res.headers.get("retry-after"));
    throw new ZaviError(codeForReason(reason, codeForStatus(res.status)), typeof err?.message === "string" ? err.message : `Request failed (${res.status})`, {
      reason,
      status: res.status,
      retryAfter: Number.isFinite(retry) && retry > 0 ? retry : undefined,
      requestId: typeof err?.request_id === "string" ? err.request_id : undefined,
      signedOut: !opts.token,
    });
  }

  function refresh(stale: Session): Promise<Session | null> {
    if (refreshing) return refreshing;
    const run = async (): Promise<Session | null> => {
      const current = readStored() ?? session;
      if (!current) { setSession(null, false); return null; }
      if (current.refresh_token !== stale.refresh_token) { setSession(current, false); return current; }
      try {
        const { data } = await send("POST", "/api/auth/refresh", { body: { refresh_token: current.refresh_token } });
        const next = asSession(data);
        if (!next) throw new ZaviError("server", "the sign-in service returned no session", { reason: "invalid_session" });
        const nextSub = decodeClaims(next.access_token)?.sub;
        if (!next.email && current.email && typeof nextSub === "string" && nextSub === decodeClaims(current.access_token)?.sub) {
          next.email = current.email;
        }
        setSession(next);
        return next;
      } catch (e) {
        if (e instanceof ZaviError && (e.code === "not_allowed" || e.code === "validation" || e.code === "not_found")) {
          const after = readStored();
          if (after && after.refresh_token !== current.refresh_token) { setSession(after, false); return after; }
          setSession(null);
          return null;
        }
        throw e;
      }
    };
    refreshing = withAuthLock(run).finally(() => { refreshing = null; });
    return refreshing;
  }

  function withAuthLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockName = `zavi.auth.refresh:${siteId}`;
    if (locks) return locks.request(lockName, fn);
    const p = localLock.then(fn, fn);
    localLock = p.catch(() => undefined);
    return p;
  }

  async function accessToken(): Promise<string | null> {
    await ready();
    const s = session;
    if (!s) return null;
    if (s.expires_at - REFRESH_EARLY_S > now() / 1000) return s.access_token;
    return (await refresh(s))?.access_token ?? null;
  }

  async function authed(method: string, path: string, opts: { body?: unknown; headers?: Record<string, string>; requireUser?: boolean } = {}) {
    const token = await accessToken();
    if (opts.requireUser && !token) throw new ZaviError("not_allowed", "Sign in first.", { reason: "signed_out" });
    try {
      return await send(method, path, { ...opts, token });
    } catch (e) {
      if (!(e instanceof ZaviError) || e.status !== 401 || !token || !session) throw e;
      const next = await refresh(session);
      if (!next) {
        if (opts.requireUser) throw new ZaviError("not_allowed", "Your session ended. Sign in again.", { reason: "signed_out", status: 401 });
        return send(method, path, { ...opts, token: null });
      }
      return send(method, path, { ...opts, token: next.access_token });
    }
  }

  function collection<T extends Record<string, unknown> = Record<string, unknown>>(name: string) {
    check(NAME.test(name), "invalid_collection", `"${name}" is not a collection name`);
    const base = `/api/data/${name}`;
    const idPath = (id: string) => {
      check(typeof id === "string" && UUID.test(id), "invalid_id", "record ids are uuids");
      return `${base}/${id.toLowerCase()}`;
    };
    return {
      async list(opts: ListOptions = {}): Promise<Page<T>> {
        const q: string[] = [];
        if (opts.filter !== undefined) {
          check(!!opts.filter && typeof opts.filter === "object" && !Array.isArray(opts.filter), "invalid_filter", "filter must be an object");
          q.push(`filter=${encodeURIComponent(JSON.stringify(opts.filter))}`);
        }
        if (opts.order !== undefined && opts.order !== "newest") {
          check(typeof opts.order === "string" && /^-?[a-z][a-z0-9_]{0,62}$/.test(opts.order), "invalid_order", 'order is "newest", "field" or "-field"');
          q.push(`sort=${encodeURIComponent(opts.order)}`);
        }
        if (opts.limit !== undefined) {
          check(Number.isInteger(opts.limit) && opts.limit >= 1 && opts.limit <= 100, "invalid_limit", "limit is 1 to 100");
          q.push(`limit=${opts.limit}`);
        }
        if (opts.cursor) q.push(`cursor=${encodeURIComponent(opts.cursor)}`);
        const { data } = await authed("GET", q.length ? `${base}?${q.join("&")}` : base);
        const page = (data ?? {}) as { items?: unknown; next_cursor?: unknown };
        return {
          items: Array.isArray(page.items) ? (page.items as ZaviRecord<T>[]) : [],
          next_cursor: typeof page.next_cursor === "string" ? page.next_cursor : null,
        };
      },
      async get(id: string): Promise<ZaviRecord<T> | null> {
        try {
          const { data } = await authed("GET", idPath(id));
          return (data as ZaviRecord<T> | null) ?? null;
        } catch (e) {
          if (e instanceof ZaviError && e.code === "not_found") return null;
          throw e;
        }
      },
      async create(values: Partial<T>, opts: { idempotencyKey?: string } & CaptchaOption = {}): Promise<{ id: string; replayed: boolean }> {
        check(!!values && typeof values === "object" && !Array.isArray(values), "invalid_values", "values must be an object");
        const k = opts.idempotencyKey ?? randomKey();
        check(IDEM_KEY.test(k), "idempotency_key_invalid", "idempotencyKey is 16-128 letters, digits, _ or -");
        const { data } = await authed("POST", base, { body: { data: values }, headers: { "idempotency-key": k, ...captcha(opts) } });
        return data as { id: string; replayed: boolean };
      },
      async update(id: string, patch: Partial<Record<keyof T, unknown>>): Promise<{ id: string }> {
        check(!!patch && typeof patch === "object" && !Array.isArray(patch), "invalid_patch", "patch must be an object");
        const { data } = await authed("PATCH", idPath(id), { body: { patch } });
        return data as { id: string };
      },
      async delete(id: string): Promise<{ id: string }> {
        const { data } = await authed("DELETE", idPath(id));
        return data as { id: string };
      },
      async transition(id: string, to: string, opts: { expect?: Record<string, unknown>; set?: Record<string, unknown> } = {}): Promise<Transition> {
        const path = `${idPath(id)}/transition`;
        check(typeof to === "string" && STATE.test(to), "invalid_state", "to is the name of a state");
        const body: Record<string, unknown> = { to };
        for (const k of ["expect", "set"] as const) {
          const v = opts[k];
          if (v === undefined) continue;
          check(!!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0, "invalid_transition", `${k} must be an object of fields`);
          body[k] = v;
        }
        const { data } = await authed("POST", path, { body, requireUser: true });
        return data as Transition;
      },
    };
  }

  const actions = {
    async run(name: string, req: ActionRequest, opts: { idempotencyKey?: string } & CaptchaOption = {}): Promise<ActionResult> {
      check(typeof name === "string" && NAME.test(name), "invalid_action", `"${name}" is not an action name`);
      const r = (req ?? {}) as { targetId?: unknown; recordId?: unknown; data?: unknown };
      const forward = r.targetId !== undefined;
      check(forward !== (r.recordId !== undefined), "invalid_action_input", "pass either targetId (an action) or recordId (its inverse)");
      const id = forward ? r.targetId : r.recordId;
      check(typeof id === "string" && UUID.test(id), "invalid_id", "record ids are uuids");
      if (forward && r.data !== undefined) check(!!r.data && typeof r.data === "object" && !Array.isArray(r.data), "invalid_values", "data must be an object");
      const k = opts.idempotencyKey ?? randomKey();
      check(IDEM_KEY.test(k), "idempotency_key_invalid", "idempotencyKey is 16-128 letters, digits, _ or -");
      const headers: Record<string, string> = { "idempotency-key": k, ...captcha(opts) };
      const body = forward ? { target_id: (id as string).toLowerCase(), data: r.data ?? {} } : { record_id: (id as string).toLowerCase() };
      const { data } = await authed("POST", `/api/actions/${name}`, { body, headers });
      return data as ActionResult;
    },
  };
  const aggregates = {
    async run(name: string, opts: { filter?: Filter } = {}): Promise<{ value: number }> {
      check(typeof name === "string" && NAME.test(name), "invalid_aggregate", `"${name}" is not an aggregate name`);
      const filter = opts.filter ?? {};
      check(!!filter && typeof filter === "object" && !Array.isArray(filter), "invalid_filter", "filter must be an object");
      const { data } = await authed("POST", `/api/aggregates/${name}`, { body: { filter }, requireUser: true });
      return data as { value: number };
    },
  };

  const functions = {
    async call<T = unknown>(name: string, input: unknown = {}): Promise<T> {
      check(typeof name === "string" && FN_NAME.test(name), "invalid_function", `"${name}" is not a function name`);
      const { data } = await authed("POST", `/api/fn/${name}`, { body: input ?? {} });
      return data as T;
    },
  };

  const userIdOf = (id: string) => {
    check(typeof id === "string" && UUID.test(id), "invalid_id", "user ids are uuids");
    return id.toLowerCase();
  };
  const roleOf = (role: string) => {
    check(typeof role === "string" && ROLE.test(role), "invalid_role", "a role is admin, user or a role declared in zavi-site.json");
    return role;
  };
  const members = {
    async invite(input: { email: string; role: string }): Promise<Member> {
      const { data } = await authed("POST", "/api/members/invite", { body: { email: String(input.email ?? "").trim(), role: roleOf(input.role) }, requireUser: true });
      return data as Member;
    },
    async list(opts: { limit?: number; cursor?: string | null } = {}): Promise<MemberPage> {
      const q: string[] = [];
      if (opts.limit !== undefined) {
        check(Number.isInteger(opts.limit) && opts.limit >= 1 && opts.limit <= 100, "invalid_limit", "limit is 1 to 100");
        q.push(`limit=${opts.limit}`);
      }
      if (opts.cursor) q.push(`cursor=${userIdOf(opts.cursor)}`);
      const { data } = await authed("GET", q.length ? `/api/members/list?${q.join("&")}` : "/api/members/list", { requireUser: true });
      const page = (data ?? {}) as { items?: unknown; next_cursor?: unknown };
      return { items: Array.isArray(page.items) ? (page.items as Member[]) : [], next_cursor: typeof page.next_cursor === "string" ? page.next_cursor : null };
    },
    async setRole(userId: string, role: string): Promise<Member> {
      const body = { user_id: userIdOf(userId), role: roleOf(role) };
      const { data } = await authed("POST", "/api/members/set-role", { body, requireUser: true });
      return data as Member;
    },
    async disable(userId: string): Promise<Member> {
      const { data } = await authed("POST", "/api/members/disable", { body: { user_id: userIdOf(userId) }, requireUser: true });
      return data as Member;
    },
    async remove(userId: string): Promise<{ user_id: string; removed: true }> {
      const { data } = await authed("POST", "/api/members/remove", { body: { user_id: userIdOf(userId) }, requireUser: true });
      return data as { user_id: string; removed: true };
    },
    async reenableMember(userId: string): Promise<Member> {
      const { data } = await authed("POST", "/api/members/reenable", { body: { user_id: userIdOf(userId) }, requireUser: true });
      return data as Member;
    },
    async reassignOwner(collectionName: string, id: string, toUserId: string): Promise<{ id: string; owner_id: string }> {
      check(typeof collectionName === "string" && NAME.test(collectionName), "invalid_collection", `"${collectionName}" is not a collection name`);
      check(typeof id === "string" && UUID.test(id), "invalid_id", "record ids are uuids");
      const body = { collection: collectionName, id: id.toLowerCase(), to_user_id: userIdOf(toUserId) };
      const { data } = await authed("POST", "/api/members/reassign-owner", { body, requireUser: true });
      return data as { id: string; owner_id: string };
    },
    async deleteUserData(userId: string, opts: { confirm: true }): Promise<{ user_id: string; records: number; files: number }> {
      check(opts?.confirm === true, "confirm_required", "deleteUserData erases data: pass { confirm: true }");
      const { data } = await authed("POST", "/api/members/delete-data", { body: { user_id: userIdOf(userId), confirm: true }, requireUser: true });
      return data as { user_id: string; records: number; files: number };
    },
  };

  const user = (): User | null => {
    if (!session) return null;
    const c = decodeClaims(session.access_token);
    if (!c || typeof c.sub !== "string") return null;
    const claimed = typeof c.email === "string" && !isSignInAlias(c.email) ? c.email : null;
    return { id: c.sub, email: session.email ?? claimed, role: typeof c.site_role === "string" ? c.site_role : null };
  };

  async function adopt(data: unknown): Promise<Session | null> {
    const s = asSession(data);
    if (s) setSession(s);
    return s;
  }

  const nextKey = () => `zavi.next.v1:${siteId}`;
  const signupKey = () => `zavi.signup.v1:${siteId}`;
  const safePath = (p: unknown): string | null =>
    typeof p === "string" && p.startsWith("/") && !p.startsWith("//") && !p.startsWith("/\\") ? p : null;

  const auth = {
    ready,
    session: (): Session | null => session,
    user,
    onChange(cb: (s: Session | null) => void): () => void {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    accessToken,
    async signUp(
      email: string | { email: string; password?: string; next?: string } & CaptchaOption,
      opts: { next?: string } & CaptchaOption = {},
    ): Promise<{ session: Session | null; confirmationRequired: boolean }> {
      const o = typeof email === "string" ? { ...opts, email } : { ...email, ...opts, email: email.email };
      await ready();
      const headers = captcha(o);
      remember(o.next);
      const { data } = await send("POST", "/api/auth/signup", { body: { email: String(o.email ?? "").trim() }, headers });
      try {
        storage?.setItem(signupKey(), JSON.stringify({ t: now(), email: String(o.email ?? "").normalize("NFC").trim().toLowerCase() }));
      } catch {  }
      const s = await adopt(data);
      return { session: s, confirmationRequired: !s };
    },
    async signIn(input: { email: string; password: string }): Promise<Session> {
      await ready();
      const { data } = await send("POST", "/api/auth/login", { body: { email: input.email.trim(), password: input.password } });
      const s = await adopt(data);
      if (!s) throw new ZaviError("server", "the sign-in service returned no session", { reason: "invalid_session" });
      return s;
    },
    async signInWithMagicLink(input: { email: string; next?: string } & CaptchaOption): Promise<void> {
      await ready();
      const headers = captcha(input);
      remember(input.next);
      const { data } = await send("POST", "/api/auth/magic-link", { body: { email: input.email.trim() }, headers });
      await adopt(data);
    },
    async resetPassword(input: { email: string } & CaptchaOption): Promise<void> {
      await ready();
      await send("POST", "/api/auth/recover", { body: { email: input.email.trim() }, headers: captcha(input) });
    },
    async updatePassword(password: string, opts: { currentPassword?: string } = {}): Promise<void> {
      const { data } = await authed("POST", "/api/auth/password", { body: { password, current_password: opts.currentPassword }, requireUser: true });
      const s = asSession((data as { session?: unknown } | null)?.session);
      if (s) setSession(s);
    },
    async changeEmail(input: { email: string; currentPassword?: string }): Promise<void> {
      await authed("POST", "/api/auth/email", { body: { new_email: input.email.trim(), current_password: input.currentPassword }, requireUser: true });
    },
    async deleteAccount(opts: { currentPassword?: string } = {}): Promise<void> {
      await authed("POST", "/api/auth/delete", { body: { current_password: opts.currentPassword }, requireUser: true });
      setSession(null);
    },
    async signOut(): Promise<void> {
      await ready();
      const s = await withAuthLock(async () => {
        const latest = readStored() ?? session;
        setSession(null);
        return latest;
      });
      if (s) {
        try { await send("POST", "/api/auth/logout", { token: s.access_token, body: {} }); } catch {  }
      }
    },
    async adoptSession(fields: Record<string, unknown>): Promise<Session | null> {
      await ready();
      return adopt(fields);
    },
    takeSignupMarker(): string | null {
      if (!storage || !siteId) return null;
      try {
        const v = storage.getItem(signupKey());
        if (v === null) return null;
        const m = JSON.parse(v) as { t?: unknown; email?: unknown } | null;
        const t = m && typeof m.t === "number" && Number.isFinite(m.t) ? m.t : null;
        const email = m && typeof m.email === "string" && m.email.includes("@") ? m.email : null;
        if (t !== null && email !== null && now() - t >= 0 && now() - t <= SIGNUP_MARKER_MS) return email;
        storage.removeItem(signupKey());
        return null;
      } catch {
        try { storage.removeItem(signupKey()); } catch {  }
        return null;
      }
    },
    async adoptSignupSession(fields: Record<string, unknown>, email: string): Promise<Session | null> {
      await ready();
      const given = asSession(fields);
      if (!given) return null;
      try {
        const { data } = await send("POST", "/api/auth/refresh", { body: { refresh_token: given.refresh_token } });
        const s = asSession(data);
        if (!s || !s.email || s.email.normalize("NFC").trim().toLowerCase() !== email.normalize("NFC").trim().toLowerCase()) return null;
        setSession(s);
        try { storage?.removeItem(signupKey()); } catch {  }
        return s;
      } catch {
        return null;
      }
    },
    takeNext(): string | null {
      if (!storage || !siteId) return null;
      try {
        const v = storage.getItem(nextKey());
        storage.removeItem(nextKey());
        return safePath(v);
      } catch {
        return null;
      }
    },
  };

  function remember(next: string | undefined): void {
    if (next === undefined) return;
    check(safePath(next) !== null, "invalid_redirect", "next must be a path on this site");
    try { storage?.setItem(nextKey(), next); } catch {  }
  }

  const sameOrigin = (url: string): string => {
    const u = new URL(url, config.origin);
    if (u.origin !== config.origin) throw new ZaviError("server", "the storage service returned an off-site URL", { reason: "off_origin_url" });
    return u.protocol === "blob:" ? url : u.pathname + u.search + u.hash;
  };
  const areaPath = (area: string) => {
    check(NAME.test(area), "invalid_area", `"${area}" is not a files area name`);
    return `/api/storage/${area}`;
  };
  const fileName = (name: string) => {
    check(typeof name === "string" && FILE_NAME.test(name), "invalid_file_name", "file names are letters, digits, . _ - (max 200), starting with a letter or digit");
    return name;
  };

  const files = {
    async list(area: string): Promise<Array<{ name: string; size: number; content_type: string | null; created_at: string }>> {
      const { data } = await authed("GET", `${areaPath(area)}/list`);
      const items = (data as { items?: unknown } | null)?.items;
      return Array.isArray(items) ? items : [];
    },
    async upload(area: string, file: Blob & { name?: string }, opts: { name?: string; upsert?: boolean } & CaptchaOption = {}): Promise<{ name: string }> {
      const ext = (file.name ?? "").match(/\.[A-Za-z0-9]{1,10}$/)?.[0] ?? "";
      const name = fileName(opts.name ?? `${randomKey().slice(0, 24)}${ext.toLowerCase()}`);
      const { data } = await authed("POST", `${areaPath(area)}/upload-url`, {
        body: { name, content_type: file.type || "application/octet-stream", size: file.size, upsert: opts.upsert === true },
        headers: captcha(opts),
      });
      const target = data as { url?: unknown; method?: unknown; headers?: unknown } | null;
      if (!target || typeof target.url !== "string") throw new ZaviError("server", "the storage service returned no upload URL", { reason: "invalid_upload_url" });
      const headers: Record<string, string> = { "content-type": file.type || "application/octet-stream" };
      if (target.headers && typeof target.headers === "object") {
        for (const [k, v] of Object.entries(target.headers as Record<string, unknown>)) if (typeof v === "string") headers[k.toLowerCase()] = v;
      }
      const putUrl = sameOrigin(target.url);
      let res: ResponseLike;
      try {
        res = await config.fetch(putUrl, { method: typeof target.method === "string" ? target.method : "PUT", headers, body: file });
      } catch {
        throw new ZaviError("offline", "The upload could not reach the site.", { reason: "offline" });
      }
      if (res.status < 200 || res.status >= 300) {
        throw new ZaviError(codeForStatus(res.status), `Upload failed (${res.status})`, { reason: `http_${res.status}`, status: res.status });
      }
      return { name };
    },
    async url(area: string, name: string): Promise<string> {
      const { data } = await authed("POST", `${areaPath(area)}/download-url`, { body: { name: fileName(name) } });
      const url = (data as { url?: unknown } | null)?.url;
      if (typeof url !== "string") throw new ZaviError("not_found", "File not found.", { reason: "not_found" });
      return sameOrigin(url);
    },
    async remove(area: string, name: string): Promise<void> {
      await authed("DELETE", `${areaPath(area)}/${fileName(name)}`, { requireUser: true });
    },
  };

  async function captchaSiteKey(): Promise<string | null> {
    if (!siteKey) {
      siteKey = (config.captchaSiteKey ? config.captchaSiteKey() : send("GET", "/api/site").then(({ data }) => {
        const k = (data as { turnstile_site_key?: unknown } | null)?.turnstile_site_key;
        return typeof k === "string" && k ? k : null;
      }));
      siteKey.catch(() => { siteKey = null; });
    }
    return siteKey;
  }

  return {
    data: { collection },
    auth,
    storage: files,
    actions,
    aggregates,
    functions,
    members,
    captcha: { siteKey: captchaSiteKey },
  };
}
