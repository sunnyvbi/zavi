
import { ZaviError, type ZaviErrorCode } from "./errors";
import { ANON, DevStore, type Caller } from "./devstore";
import type { FetchLike, KeyValueStorage, ResponseLike } from "./client";

export type DevSeed = {
  users?: Array<{ email: string; password?: string; role?: string }>;
  records?: Record<string, Array<{ owner?: string; data: Record<string, unknown> }>>;
};

type DevUser = { id: string; email: string; password: string | null };

const STATUS: Record<ZaviErrorCode, number> = {
  not_allowed: 403, validation: 400, not_found: 404, conflict: 409, quota: 413, rate_limited: 429, offline: 503, server: 500,
};
const EMAIL = /^[^@\s]{1,64}@[^@\s]{1,255}\.[^@\s]{1,63}$/;
const R_NAME = /^[a-z][a-z0-9_]{0,62}$/;
const R_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const R_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const AUTH_ACTIONS = new Set(["signup", "login", "magic-link", "refresh", "logout", "recover", "password", "email", "delete", "callback"]);
const MEMBER_OPS: Record<string, string> = {
  invite: "POST", list: "GET", "set-role": "POST", disable: "POST", remove: "POST",
  reenable: "POST", "reassign-owner": "POST", "delete-data": "POST",
};

export function gatewayRoutes(method: string, path: string): boolean {
  const parts = path.split("/");
  if (parts[0] !== "" || parts[1] !== "api") return false;
  const rest = parts.slice(2);
  if (rest.length === 0 || rest.some((x) => x === "")) return false;
  const [head] = rest;
  if (head === "data") {
    if (!R_NAME.test(rest[1] ?? "")) return false;
    if (rest.length === 2) return method === "GET" || method === "POST";
    if (!R_UUID.test(rest[2].toLowerCase())) return false;
    if (rest.length === 3) return method === "GET" || method === "PATCH" || method === "DELETE";
    return rest.length === 4 && rest[3] === "transition" && method === "POST";
  }
  if (head === "site") return rest.length === 1 && method === "GET";
  if (head === "storage") {
    if (!R_NAME.test(rest[1] ?? "")) return false;
    if (rest.length === 4) return rest[2] === "object" && R_FILE.test(rest[3]) && (method === "GET" || method === "PUT");
    if (rest.length !== 3) return false;
    if (method === "DELETE") { try { return R_FILE.test(decodeURIComponent(rest[2])); } catch { return false; } }
    return (rest[2] === "list" && method === "GET") || ((rest[2] === "download-url" || rest[2] === "upload-url") && method === "POST");
  }
  if (head === "auth") return rest.length === 2 && AUTH_ACTIONS.has(rest[1]) && method === (rest[1] === "callback" ? "GET" : "POST");
  if (head === "actions" || head === "aggregates") return rest.length === 2 && R_NAME.test(rest[1]) && method === "POST";
  if (head === "members") return rest.length === 2 && MEMBER_OPS[rest[1]] === method;
  return false;
}
const TOKEN_TTL_S = 3600;
const REAUTH_WINDOW_S = 600;

function b64url(s: string): string {
  return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  return decodeURIComponent(escape(atob(b64)));
}

function respond(status: number, body: unknown, headers: Record<string, string> = {}): ResponseLike {
  const text = body === undefined ? "" : JSON.stringify(body);
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { status, headers: { get: (n: string) => h[n.toLowerCase()] ?? null }, text: async () => text };
}
const ok = (data: unknown) => respond(200, { data });
function fail(e: unknown): ResponseLike {
  if (e instanceof ZaviError) {
    const status = e.status ?? (e.reason.startsWith("quota_exceeded") ? 429 : STATUS[e.code]);
    return respond(status, { error: { code: e.reason, message: e.message, request_id: "dev" } });
  }
  return respond(500, { error: { code: "server", message: String((e as Error)?.message ?? e), request_id: "dev" } });
}

export type LocalServerOptions = {
  store: DevStore;
  siteId: string;
  seed?: DevSeed;
  persist?: KeyValueStorage | null;
  now?: () => number;
  randomId?: () => string;
  objectUrl?: (body: unknown, contentType: string) => string;
};

export function createLocalServer(opts: LocalServerOptions) {
  const { store, siteId } = opts;
  const now = opts.now ?? (() => Date.now());
  const rid = opts.randomId ?? (() => globalThis.crypto.randomUUID());
  const users = new Map<string, DevUser>();
  const refresh = new Map<string, string>();
  const uploads = new Map<string, { caller: Caller; area: string; name: string; owner: string | null; contentType: string; size: number }>();
  const persistKey = `zavi.dev.v1:${siteId}`;

  function save(): void {
    if (!opts.persist) return;
    try {
      opts.persist.setItem(persistKey, JSON.stringify({ store: store.snapshot(), users: [...users.values()], refresh: [...refresh.entries()] }));
    } catch {  }
  }

  function load(): boolean {
    if (!opts.persist) return false;
    try {
      const raw = opts.persist.getItem(persistKey);
      if (!raw) return false;
      const s = JSON.parse(raw) as { store: string; users: DevUser[]; refresh: Array<[string, string]> };
      store.restore(s.store);
      for (const u of s.users ?? []) users.set(u.email, u);
      for (const [t, id] of s.refresh ?? []) refresh.set(t, id);
      return true;
    } catch {
      return false;
    }
  }

  function addUser(email: string, password: string | null, role: string | null = "user"): DevUser {
    const u: DevUser = { id: rid(), email: email.toLowerCase(), password };
    users.set(u.email, u);
    if (role !== null) store.setMember(u.id, role);
    return u;
  }

  if (!load() && opts.seed) {
    const byEmail = new Map<string, string>();
    for (const u of opts.seed.users ?? []) byEmail.set(u.email.toLowerCase(), addUser(u.email, u.password ?? null, u.role ?? "user").id);
    for (const [collection, rows] of Object.entries(opts.seed.records ?? {})) {
      for (const row of rows) {
        const owner = row.owner ? byEmail.get(row.owner.toLowerCase()) : null;
        if (row.owner && !owner) throw new Error(`dev seed: ${collection}: owner ${row.owner} is not a seeded user`);
        store.seedRecord(collection, row.data, owner ?? null);
      }
    }
    save();
  }

  const findUser = (id: string) => [...users.values()].find((u) => u.id === id) ?? null;

  function session(u: DevUser) {
    const exp = Math.floor(now() / 1000) + TOKEN_TTL_S;
    const role = store.members.get(u.id)?.role ?? null;
    const iat = Math.floor(now() / 1000);
    const claims = { sub: u.id, email: u.email, role: "authenticated", site_id: siteId, site_role: role, iat, exp };
    const access_token = `${b64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}.dev`;
    const refresh_token = rid().replace(/-/g, "");
    refresh.set(refresh_token, u.id);
    save();
    return { session: { access_token, refresh_token, expires_at: exp, expires_in: TOKEN_TTL_S, token_type: "bearer" } };
  }

  function callerOf(auth: string | undefined): Caller & { iat?: number } {
    if (!auth) return ANON;
    const m = /^Bearer (.+)$/.exec(auth);
    const unauth = () => new ZaviError("not_allowed", "session_expired", { reason: "session_expired", status: 401 });
    if (!m) throw unauth();
    try {
      const claims = JSON.parse(unb64url(m[1].split(".")[1] ?? "")) as Record<string, unknown>;
      if (claims.site_id !== siteId || claims.role !== "authenticated" || typeof claims.sub !== "string") throw unauth();
      if (typeof claims.exp !== "number" || claims.exp <= now() / 1000) throw unauth();
      if (!findUser(claims.sub)) throw unauth();
      return { sub: claims.sub, siteRole: typeof claims.site_role === "string" ? claims.site_role : null, iat: typeof claims.iat === "number" ? claims.iat : 0 };
    } catch (e) {
      if (e instanceof ZaviError) throw e;
      throw unauth();
    }
  }

  function credentials(body: Record<string, unknown>): { email: string; password: string } {
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!EMAIL.test(email)) throw new ZaviError("validation", "invalid_email", { reason: "invalid_email" });
    const password = typeof body.password === "string" ? body.password : "";
    return { email, password };
  }

  async function route(method: string, path: string, query: URLSearchParams, headers: Record<string, string>, body: unknown): Promise<ResponseLike> {
    const json = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const caller = () => callerOf(headers.authorization);
    const signedIn = () => {
      const c = callerOf(headers.authorization);
      if (!c.sub) throw new ZaviError("not_allowed", "unauthorized", { reason: "unauthorized", status: 401 });
      return c;
    };
    const reauth = (c: Caller & { iat?: number }) => {
      const u = findUser(c.sub as string) as DevUser;
      const fresh = now() / 1000 - (c.iat ?? 0) <= REAUTH_WINDOW_S;
      const pw = typeof json.current_password === "string" && u.password !== null && json.current_password === u.password;
      if (!fresh && !pw) throw new ZaviError("not_allowed", "reauth_required", { reason: "reauth_required", status: 403 });
      return u;
    };

    if (path.startsWith("/api/fn/") || path.startsWith("/api/hooks/")) {
      throw new ZaviError("server", "Server functions run on the published site, not in the preview.", { reason: "function_preview_only", status: 503 });
    }
    if (path.startsWith("/api/") && !gatewayRoutes(method, path)) throw new ZaviError("not_found", "no_such_route", { reason: "no_such_route" });
    if (method === "GET" && path === "/api/site") return ok({ site_id: siteId, turnstile_site_key: null });

    if (method === "POST" && path.startsWith("/api/auth/")) {
      const action = path.slice("/api/auth/".length);
      switch (action) {
        case "signup": {
          const { email } = credentials(json);
          if (users.has(email)) return ok({ status: "check_email" });
          return ok(session(addUser(email, null)));
        }
        case "login": {
          const { email, password } = credentials(json);
          const u = users.get(email);
          if (!u || u.password === null || u.password !== password) {
            throw new ZaviError("not_allowed", "invalid_credentials", { reason: "invalid_credentials", status: 401 });
          }
          return ok(session(u));
        }
        case "magic-link": {
          const { email } = credentials(json);
          return ok(session(users.get(email) ?? addUser(email, null)));
        }
        case "refresh": {
          const t = typeof json.refresh_token === "string" ? json.refresh_token : "";
          const id = refresh.get(t);
          const u = id ? findUser(id) : null;
          if (!u) throw new ZaviError("not_allowed", "unauthorized", { reason: "unauthorized", status: 401 });
          refresh.delete(t);
          return ok(session(u));
        }
        case "logout": {
          const c = signedIn();
          for (const [t, id] of refresh) if (id === c.sub) refresh.delete(t);
          save();
          return ok({ signed_out: true });
        }
        case "recover":
          credentials(json);
          return ok({ status: "check_email" });
        case "password": {
          const c = signedIn();
          if (typeof json.password !== "string" || json.password.length < 8 || json.password.length > 72) throw new ZaviError("validation", "weak_password", { reason: "weak_password" });
          const u = reauth(c);
          for (const [t, id] of refresh) if (id === u.id) refresh.delete(t);
          u.password = json.password;
          return ok({ updated: true, ...session(u) });
        }
        case "email": {
          const c = signedIn();
          const { email } = credentials({ email: json.new_email });
          const u = reauth(c);
          if (users.has(email)) return ok({ status: "check_email" });
          users.delete(u.email);
          u.email = email;
          users.set(email, u);
          save();
          return ok({ status: "check_email" });
        }
        case "delete": {
          const c = signedIn();
          const u = reauth(c);
          users.delete(u.email);
          store.removeMember(u.id);
          for (const [t, id] of refresh) if (id === u.id) refresh.delete(t);
          save();
          return ok({ deleted: true });
        }
        default:
          throw new ZaviError("not_found", "no_such_route", { reason: "no_such_route" });
      }
    }

    const tr = /^\/api\/data\/([^/]+)\/([^/]+)\/transition$/.exec(path);
    if (tr && method === "POST") {
      if (Object.keys(json).some((k) => k !== "to" && k !== "expect" && k !== "set")) throw new ZaviError("validation", "invalid_transition", { reason: "invalid_transition" });
      const r = store.transition(signedIn(), tr[1], tr[2].toLowerCase(), typeof json.to === "string" ? json.to : "", {
        expect: json.expect as Record<string, unknown> | undefined,
        set: json.set as Record<string, unknown> | undefined,
      });
      save();
      return ok(r);
    }
    const act = /^\/api\/actions\/([^/]+)$/.exec(path);
    if (act && method === "POST") {
      const known = new Set(["target_id", "record_id", "data"]);
      if (Object.keys(json).some((k) => !known.has(k))) throw new ZaviError("validation", "invalid_action_input", { reason: "invalid_action_input" });
      const r = store.runAction(caller(), act[1], {
        targetId: typeof json.target_id === "string" ? json.target_id.toLowerCase() : json.target_id === undefined ? null : String(json.target_id),
        recordId: typeof json.record_id === "string" ? json.record_id.toLowerCase() : json.record_id === undefined ? null : String(json.record_id),
        data: json.data,
      }, headers["idempotency-key"] ?? null);
      save();
      return ok(r);
    }
    const agg = /^\/api\/aggregates\/([^/]+)$/.exec(path);
    if (agg && method === "POST") return ok(store.aggregate(signedIn(), agg[1], json.filter ?? {}));
    const mem = /^\/api\/members\/([a-z-]+)$/.exec(path);
    if (mem) {
      const actor = signedIn();
      const withEmail = (v: { user_id: string; role: string; status: string }) => ({ ...v, email: findUser(v.user_id)?.email ?? null });
      const uid = typeof json.user_id === "string" ? json.user_id.toLowerCase() : "";
      let out: unknown;
      if (method === "GET" && mem[1] === "list") {
        const limit = query.get("limit");
        const page = store.memberList(actor, { limit: limit === null ? null : Number.parseInt(limit, 10), cursor: query.get("cursor") });
        out = { items: page.items.map(withEmail), next_cursor: page.next_cursor };
      } else if (method === "POST" && mem[1] === "invite") {
        const { email } = credentials({ email: json.email });
        const role = typeof json.role === "string" ? json.role : "";
        store.memberList(actor, { limit: 1 });
        const u = users.get(email) ?? addUser(email, null, null);
        store.memberInvite(actor, u.id, role);
        out = { email, role, status: "invited" };
      } else if (method === "POST" && mem[1] === "set-role") out = withEmail(store.memberSetRole(actor, uid, typeof json.role === "string" ? json.role : ""));
      else if (method === "POST" && mem[1] === "disable") out = withEmail(store.memberDisable(actor, uid));
      else if (method === "POST" && mem[1] === "reenable") out = withEmail(store.memberReenable(actor, uid));
      else if (method === "POST" && mem[1] === "reassign-owner") {
        const to = typeof json.to_user_id === "string" ? json.to_user_id.toLowerCase() : "";
        out = store.reassignOwner(actor, typeof json.collection === "string" ? json.collection : "", typeof json.id === "string" ? json.id.toLowerCase() : "", to);
      } else if (method === "POST" && mem[1] === "delete-data") out = store.deleteUserData(actor, uid, json.confirm);
      else if (method === "POST" && mem[1] === "remove") {
        out = store.memberRemove(actor, uid);
        for (const [t, id] of refresh) if (id === uid) refresh.delete(t);
      } else throw new ZaviError("not_found", "no_such_route", { reason: "no_such_route" });
      save();
      return ok(out);
    }

    const data = /^\/api\/data\/([^/]+)(?:\/([^/]+))?$/.exec(path);
    if (data) {
      const [, collection, rawId] = data;
      const id = rawId?.toLowerCase();
      if (!id && method === "GET") {
        const parse = (k: string) => {
          const v = query.get(k);
          if (v === null) return undefined;
          try { return JSON.parse(v) as unknown; } catch { throw new ZaviError("validation", `invalid_${k}`, { reason: `invalid_${k}` }); }
        };
        const limit = query.get("limit");
        return ok(store.list(caller(), collection, {
          filter: parse("filter"),
          sort: query.get("sort"),
          limit: limit === null ? null : Number.parseInt(limit, 10),
          cursor: query.get("cursor"),
        }));
      }
      if (!id && method === "POST") {
        const res = store.create(caller(), collection, json.data, headers["idempotency-key"] ?? null);
        save();
        return ok(res);
      }
      if (id && method === "GET") {
        const r = store.get(caller(), collection, id);
        return r ? ok(r) : respond(404, { error: { code: "not_found", message: "not_found", request_id: "dev" } });
      }
      if (id && method === "PATCH") { const r = store.update(caller(), collection, id, json.patch); save(); return ok(r); }
      if (id && method === "DELETE") { const r = store.delete(caller(), collection, id); save(); return ok(r); }
    }

    const st = /^\/api\/storage\/([^/]+)\/([^/]+)$/.exec(path);
    if (st) {
      const [, area, tail] = st;
      if (method === "GET" && tail === "list") return ok({ items: store.listFiles(caller(), area) });
      if (method === "POST" && tail === "upload-url") {
        const c = caller();
        const name = typeof json.name === "string" ? json.name : "";
        const size = typeof json.size === "number" ? json.size : 0;
        const owner = store.authorizeUpload(c, area, name, size, json.upsert === true);
        const token = rid().replace(/-/g, "");
        uploads.set(token, { caller: c, area, name, owner, contentType: typeof json.content_type === "string" ? json.content_type : "application/octet-stream", size });
        return ok({ url: `/__zavi_dev/upload/${token}`, method: "PUT" });
      }
      if (method === "POST" && tail === "download-url") {
        const f = store.readFile(caller(), area, typeof json.name === "string" ? json.name : "");
        const url = opts.objectUrl ? opts.objectUrl(f.body, f.contentType) : `/__zavi_dev/file/${area}/${String(json.name)}`;
        return ok({ url, expires_at: Math.floor(now() / 1000) + 300 });
      }
      if (method === "DELETE") { store.removeFile(caller(), area, decodeURIComponent(tail)); return ok({ removed: true }); }
    }
    const up = /^\/__zavi_dev\/upload\/([0-9a-f]+)$/.exec(path);
    if (up && method === "PUT") {
      const u = uploads.get(up[1]);
      if (!u) throw new ZaviError("not_allowed", "invalid_upload_url", { reason: "invalid_upload_url", status: 403 });
      uploads.delete(up[1]);
      store.putFile(u.area, u.name, u.owner, u.contentType, u.size, body);
      return ok({ name: u.name });
    }
    throw new ZaviError("not_found", "no_such_route", { reason: "no_such_route" });
  }

  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url, "http://dev.local");
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    let body: unknown = init.body;
    if (typeof init.body === "string" && (headers["content-type"] ?? "").includes("application/json")) {
      try { body = JSON.parse(init.body); } catch { return fail(new ZaviError("validation", "invalid_json", { reason: "invalid_json" })); }
    }
    try {
      return await route(init.method.toUpperCase(), u.pathname, u.searchParams, headers, body);
    } catch (e) {
      return fail(e);
    }
  };

  return { fetch, users };
}
