import { describe, it, expect, vi } from "vitest";
import { createZavi, sessionStorageKey, type FetchLike, type KeyValueStorage, type ResponseLike, type LockManagerLike } from "../files/src/zavi/client";
import { ZaviError } from "../files/src/zavi/errors";

const ORIGIN = "https://shop.zavi.site";
const SITE = "11111111-2222-4333-8444-555555555555";
const ID = "0f0e0d0c-0b0a-4908-8706-050403020100";

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function res(status: number, body?: unknown, headers: Record<string, string> = {}): ResponseLike {
  const text = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  return { status, headers: { get: (n) => headers[n.toLowerCase()] ?? null }, text: async () => text };
}

function token(claims: Record<string, unknown>): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "ES256" })}.${b(claims)}.sig`;
}
const NOW = 1_800_000_000;
function session(n = 1, expiresIn = 3600, role = "user") {
  return {
    access_token: token({ sub: `00000000-0000-4000-8000-00000000000${n}`, email: `u${n}@x.test`, site_role: role, exp: NOW + expiresIn }),
    refresh_token: `refresh-${n}`,
    expires_at: NOW + expiresIn,
    token_type: "bearer",
  };
}

function memStorage(init: Record<string, string> = {}): KeyValueStorage & { data: Record<string, string> } {
  const data = { ...init };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = v; },
    removeItem: (k) => { delete data[k]; },
  };
}

function harness(route: (c: Call) => ResponseLike | Promise<ResponseLike>, opts: { storage?: ReturnType<typeof memStorage>; locks?: LockManagerLike; siteId?: () => Promise<string> } = {}) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    const c = { url, method: init.method, headers: init.headers, body };
    calls.push(c);
    return route(c);
  };
  const storage = opts.storage ?? memStorage();
  const zavi = createZavi({
    fetch, origin: ORIGIN, siteId: opts.siteId ?? (async () => SITE), storage, locks: opts.locks ?? null,
    now: () => NOW * 1000, randomBytes: (n) => new Uint8Array(n).fill(171),
  });
  return { zavi, calls, storage };
}
const ok = (data: unknown) => res(200, { data });

describe("data: request shapes", () => {
  it("list sends filter, sort, limit and cursor as query params to the same origin", async () => {
    const { zavi, calls } = harness(() => ok({ items: [{ id: ID, data: { a: 1 }, mine: false, created_at: "x", updated_at: "x" }], next_cursor: "abc" }));
    const page = await zavi.data.collection("posts").list({ filter: { status: "live", price: { gte: 5 } }, order: "-price", limit: 10, cursor: "c1/=" });
    expect(page.next_cursor).toBe("abc");
    expect(page.items[0].id).toBe(ID);
    const u = new URL(calls[0].url, ORIGIN);
    expect(calls[0].method).toBe("GET");
    expect(u.pathname).toBe("/api/data/posts");
    expect(JSON.parse(u.searchParams.get("filter")!)).toEqual({ status: "live", price: { gte: 5 } });
    expect(u.searchParams.get("sort")).toBe("-price");
    expect(u.searchParams.get("limit")).toBe("10");
    expect(u.searchParams.get("cursor")).toBe("c1/=");
    expect(calls[0].url.startsWith("/")).toBe(true);
    expect(calls[0].headers.authorization).toBeUndefined();
  });

  it("never sends a site id: the gateway binds the site from the hostname", async () => {
    const { zavi, calls } = harness(() => ok({ id: ID, replayed: false }));
    await zavi.data.collection("posts").create({ title: "x" });
    expect(JSON.stringify(calls)).not.toContain(SITE);
  });

  it("create posts {data} with an Idempotency-Key, generated when not given", async () => {
    const { zavi, calls } = harness(() => ok({ id: ID, replayed: false }));
    await expect(zavi.data.collection("posts").create({ title: "x" })).resolves.toEqual({ id: ID, replayed: false });
    expect(calls[0]).toMatchObject({ url: "/api/data/posts", method: "POST", body: { data: { title: "x" } } });
    expect(calls[0].headers["idempotency-key"]).toMatch(/^[0-9a-f]{48}$/);
    await zavi.data.collection("posts").create({ title: "x" }, { idempotencyKey: "retry-key-0123456789" });
    expect(calls[1].headers["idempotency-key"]).toBe("retry-key-0123456789");
  });

  it("update sends {patch}, delete sends nothing, get maps 404 to null", async () => {
    const { zavi, calls } = harness((c) => (c.method === "GET" ? res(404, { error: { code: "not_found", message: "no" } }) : ok({ id: ID })));
    await zavi.data.collection("posts").update(ID, { title: "y", old: null });
    await zavi.data.collection("posts").delete(ID.toUpperCase());
    expect(await zavi.data.collection("posts").get(ID)).toBeNull();
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ["PATCH", `/api/data/posts/${ID}`, { patch: { title: "y", old: null } }],
      ["DELETE", `/api/data/posts/${ID}`, undefined],
      ["GET", `/api/data/posts/${ID}`, undefined],
    ]);
  });

  it.each([
    ["a collection name with a path", () => (z: Z) => z.data.collection("../auth/login")],
    ["an uppercase collection", () => (z: Z) => z.data.collection("Posts")],
    ["a non-uuid id (path injection)", () => (z: Z) => z.data.collection("posts").get("../../auth/delete")],
    ["limit 0", () => (z: Z) => z.data.collection("posts").list({ limit: 0 })],
    ["limit 101", () => (z: Z) => z.data.collection("posts").list({ limit: 101 })],
    ["an order that is not a field", () => (z: Z) => z.data.collection("posts").list({ order: "price; drop" })],
    ["a filter that is an array", () => (z: Z) => z.data.collection("posts").list({ filter: [] as never })],
    ["a short idempotency key", () => (z: Z) => z.data.collection("posts").create({}, { idempotencyKey: "short" })],
    ["values that are an array", () => (z: Z) => z.data.collection("posts").create([] as never)],
  ])("refuses %s before any request (validation)", async (_n, make) => {
    const { zavi, calls } = harness(() => ok({}));
    await expect(Promise.resolve().then((): unknown => make()(zavi))).rejects.toMatchObject({ code: "validation" });
    expect(calls).toHaveLength(0);
  });
});
type Z = ReturnType<typeof createZavi>;

describe("data: typed errors", () => {
  it.each([
    [403, { error: { code: "rls", message: "denied", request_id: "req-1" } }, {}, { code: "not_allowed", reason: "rls", requestId: "req-1" }],
    [400, { error: { code: "schema_violation: title is required", message: "x" } }, {}, { code: "validation" }],
    [400, { error: { code: "filter_not_allowed", message: "x" } }, {}, { code: "validation" }],
    [409, { error: { code: "idempotency_conflict", message: "x" } }, {}, { code: "conflict" }],
    [413, { error: { code: "quota_exceeded", message: "x" } }, {}, { code: "quota" }],
    [429, { error: { code: "rate_limited", message: "slow down" } }, { "retry-after": "7" }, { code: "rate_limited", retryAfter: 7 }],
    [404, { error: { code: "something_new", message: "x" } }, {}, { code: "not_found" }],
    [500, "<html>oops</html>", {}, { code: "server", status: 500 }],
    [502, undefined, {}, { code: "server" }],
  ])("HTTP %s %j -> %j", async (status, body, headers, want) => {
    const { zavi } = harness(() => res(status as number, body, headers as Record<string, string>));
    const err = await zavi.data.collection("posts").list().catch((e) => e);
    expect(err).toBeInstanceOf(ZaviError);
    expect(err).toMatchObject(want);
  });

  it("a network failure is `offline`", async () => {
    const { zavi } = harness(() => { throw new TypeError("Failed to fetch"); });
    await expect(zavi.data.collection("posts").list()).rejects.toMatchObject({ code: "offline" });
  });
});

describe("auth + session", () => {
  it("signIn posts to /api/auth/login, stores the native session under zavi.auth.v1:<site_id>, then sends Bearer", async () => {
    const s = session(1);
    const { zavi, calls, storage } = harness((c) => (c.url === "/api/auth/login" ? ok(s) : ok({ items: [], next_cursor: null })));
    const changes: unknown[] = [];
    zavi.auth.onChange((x) => changes.push(x));
    await zavi.auth.signIn({ email: " U1@x.test ", password: "pw-123456" });
    expect(calls[0].body).toEqual({ email: "U1@x.test", password: "pw-123456" });
    expect(JSON.parse(storage.data[sessionStorageKey(SITE)])).toEqual(s);
    expect(Object.keys(storage.data)).toEqual([`zavi.auth.v1:${SITE}`]);
    expect(zavi.auth.user()).toEqual({ id: "00000000-0000-4000-8000-000000000001", email: "u1@x.test", role: "user" });
    expect(changes).toEqual([s]);
    await zavi.data.collection("posts").list();
    expect(calls[1].headers.authorization).toBe(`Bearer ${s.access_token}`);
  });

  it("user().email is the real address the service sent with the session, never the token's sign-in alias", async () => {
    const ALIAS = "uabcdefghijklmnopqrstuvwxyz234567@u.sites-auth.zaviagent.com";
    const live = {
      ...session(1),
      access_token: token({ sub: "00000000-0000-4000-8000-000000000001", email: ALIAS, site_role: "user", exp: NOW + 3600 }),
    };
    const old = harness((c) => (c.url === "/api/auth/login" ? ok(live) : ok({})));
    await old.zavi.auth.signIn({ email: "alice@x.test", password: "pw-123456" });
    expect(old.zavi.auth.user()).toEqual({ id: "00000000-0000-4000-8000-000000000001", email: null, role: "user" });

    const { zavi, storage } = harness((c) => {
      if (c.url === "/api/auth/login") return ok({ ...live, email: "alice@x.test" });
      if (c.url === "/api/auth/refresh") return ok({ ...live, refresh_token: "refresh-rotated" });
      return res(401, { error: { code: "invalid_session", message: "x" } });
    });
    await zavi.auth.signIn({ email: "alice@x.test", password: "pw-123456" });
    expect(zavi.auth.user()?.email).toBe("alice@x.test");
    expect(JSON.parse(storage.data[sessionStorageKey(SITE)]).email).toBe("alice@x.test");
    await zavi.data.collection("posts").list().catch(() => {});
    expect(zavi.auth.session()?.refresh_token).toBe("refresh-rotated");
    expect(zavi.auth.user()?.email).toBe("alice@x.test");
    const LOOKALIKE = "uabcdefghijklmnopqrstuvwxyz234567@example.com";
    const real = harness(() => ok({}));
    await real.zavi.auth.adoptSession({ ...live, email: LOOKALIKE });
    expect(real.zavi.auth.user()?.email).toBe(LOOKALIKE);
    const dev = harness(() => ok({}));
    await dev.zavi.auth.adoptSession({ ...live, access_token: token({ sub: "00000000-0000-4000-8000-000000000001", email: LOOKALIKE, exp: NOW + 3600 }) });
    expect(dev.zavi.auth.user()?.email).toBe(LOOKALIKE);
  });

  it("a session stored for ANOTHER site is never read", async () => {
    const other = memStorage({ [sessionStorageKey("99999999-2222-4333-8444-555555555555")]: JSON.stringify(session(2)) });
    const { zavi, calls } = harness(() => ok({ items: [], next_cursor: null }), { storage: other });
    await zavi.auth.ready();
    expect(zavi.auth.session()).toBeNull();
    await zavi.data.collection("posts").list();
    expect(calls[0].headers.authorization).toBeUndefined();
  });

  it("a corrupted or partial stored session is ignored", async () => {
    for (const raw of ["{not json", JSON.stringify({ access_token: "a" }), JSON.stringify({ ...session(1), expires_at: "soon" })]) {
      const { zavi } = harness(() => ok({}), { storage: memStorage({ [sessionStorageKey(SITE)]: raw }) });
      await zavi.auth.ready();
      expect(zavi.auth.session()).toBeNull();
    }
  });

  it("the site id comes only from the resolver; a failed bootstrap is retried on the next call", async () => {
    let attempts = 0;
    const siteId = async () => { if (++attempts === 1) throw new Error("offline"); return SITE; };
    const { zavi } = harness(() => ok({ items: [], next_cursor: null }), { siteId });
    await expect(zavi.auth.ready()).rejects.toThrow();
    await expect(zavi.auth.ready()).resolves.toBeNull();
    expect(attempts).toBe(2);
  });

  it("ready() resolves with the CURRENT session, not the one from first page load (email-link sign-in, then /admin)", async () => {
    const { zavi } = harness(() => ok({}));
    await expect(zavi.auth.ready()).resolves.toBeNull();
    const admin = session(1, 3600, "admin");
    await zavi.auth.adoptSession({ ...admin, expires_at: String(admin.expires_at) });
    await expect(zavi.auth.ready()).resolves.toEqual(admin);
    await zavi.auth.signOut();
    await expect(zavi.auth.ready()).resolves.toBeNull();
  });

  it("an expired session is refreshed once at startup, even with concurrent callers", async () => {
    const stale = session(1, -10);
    const fresh = session(1, 3600);
    fresh.refresh_token = "refresh-rotated";
    const storage = memStorage({ [sessionStorageKey(SITE)]: JSON.stringify(stale) });
    const { zavi, calls } = harness((c) => (c.url === "/api/auth/refresh" ? ok(fresh) : ok({ items: [], next_cursor: null })), { storage });
    await Promise.all([zavi.data.collection("a").list(), zavi.data.collection("b").list(), zavi.auth.ready()]);
    expect(calls.filter((c) => c.url === "/api/auth/refresh")).toHaveLength(1);
    expect(calls.find((c) => c.url === "/api/auth/refresh")!.body).toEqual({ refresh_token: "refresh-1" });
    expect(JSON.parse(storage.data[sessionStorageKey(SITE)]).refresh_token).toBe("refresh-rotated");
    for (const c of calls.filter((x) => x.url.startsWith("/api/data"))) expect(c.headers.authorization).toBe(`Bearer ${fresh.access_token}`);
  });

  it("cross-tab: inside the refresh lock it adopts a session another tab already rotated (no second refresh)", async () => {
    const stale = session(1, -10);
    const rotated = { ...session(1, 3600), refresh_token: "refresh-from-other-tab" };
    const storage = memStorage({ [sessionStorageKey(SITE)]: JSON.stringify(stale) });
    const lockNames: string[] = [];
    const locks: LockManagerLike = {
      request: async (name, fn) => {
        lockNames.push(name);
        storage.data[sessionStorageKey(SITE)] = JSON.stringify(rotated);
        return fn();
      },
    };
    const { zavi, calls } = harness(() => ok({ items: [], next_cursor: null }), { storage, locks });
    await zavi.data.collection("posts").list();
    expect(lockNames).toEqual([`zavi.auth.refresh:${SITE}`]);
    expect(calls.some((c) => c.url === "/api/auth/refresh")).toBe(false);
    expect(calls[0].headers.authorization).toBe(`Bearer ${rotated.access_token}`);
  });

  it("a refused refresh (reused or revoked token) signs out; the call goes on signed out", async () => {
    const storage = memStorage({ [sessionStorageKey(SITE)]: JSON.stringify(session(1, -10)) });
    const { zavi, calls } = harness((c) => (c.url === "/api/auth/refresh"
      ? res(401, { error: { code: "unauthorized", message: "Sign in again." } })
      : ok({ items: [], next_cursor: null })), { storage });
    const changes: unknown[] = [];
    zavi.auth.onChange((s) => changes.push(s));
    await zavi.data.collection("posts").list();
    expect(zavi.auth.session()).toBeNull();
    expect(storage.data[sessionStorageKey(SITE)]).toBeUndefined();
    expect(calls.at(-1)!.headers.authorization).toBeUndefined();
    expect(changes.at(-1)).toBeNull();
  });

  it("without Web Locks, a refresh that lost the race to another tab adopts the winner instead of signing out", async () => {
    const storage = memStorage({ [sessionStorageKey(SITE)]: JSON.stringify(session(1, -10)) });
    const winner = { ...session(1, 3600), refresh_token: "refresh-won-elsewhere" };
    const { zavi } = harness((c) => {
      if (c.url === "/api/auth/refresh") {
        storage.data[sessionStorageKey(SITE)] = JSON.stringify(winner);
        return res(401, { error: { code: "unauthorized", message: "x" } });
      }
      return ok({ items: [], next_cursor: null });
    }, { storage });
    await zavi.data.collection("posts").list();
    expect(zavi.auth.session()).toEqual(winner);
    expect(JSON.parse(storage.data[sessionStorageKey(SITE)])).toEqual(winner);
  });

  it("sign-out runs under the refresh lock and revokes the LATEST stored session", async () => {
    const storage = memStorage({ [sessionStorageKey(SITE)]: JSON.stringify(session(1)) });
    const rotated = { ...session(1), access_token: token({ sub: "x", rotated: true }), refresh_token: "refresh-rotated" };
    const lockNames: string[] = [];
    const locks: LockManagerLike = {
      request: async (name, fn) => {
        lockNames.push(name);
        storage.data[sessionStorageKey(SITE)] = JSON.stringify(rotated);
        return fn();
      },
    };
    const { zavi, calls } = harness(() => ok({ signed_out: true }), { storage, locks });
    await zavi.auth.ready();
    await zavi.auth.signOut();
    expect(lockNames).toEqual([`zavi.auth.refresh:${SITE}`]);
    expect(calls[0]).toMatchObject({ url: "/api/auth/logout", headers: { authorization: `Bearer ${rotated.access_token}` } });
    expect(storage.data[sessionStorageKey(SITE)]).toBeUndefined();
    expect(zavi.auth.session()).toBeNull();
  });

  it("an offline refresh keeps the session (no sign-out on a network blip)", async () => {
    const stale = session(1, -10);
    const storage = memStorage({ [sessionStorageKey(SITE)]: JSON.stringify(stale) });
    const { zavi } = harness((c) => { if (c.url === "/api/auth/refresh") throw new TypeError("offline"); return ok({}); }, { storage });
    await expect(zavi.data.collection("posts").list()).rejects.toMatchObject({ code: "offline" });
    expect(JSON.parse(storage.data[sessionStorageKey(SITE)])).toEqual(stale);
  });

  it("a 401 on a data call refreshes once and retries with the new token", async () => {
    const s1 = session(1);
    const s2 = { ...session(1), access_token: token({ sub: "x", n: 2 }), refresh_token: "refresh-2" };
    let first = true;
    const { zavi, calls } = harness((c) => {
      if (c.url === "/api/auth/login") return ok(s1);
      if (c.url === "/api/auth/refresh") return ok(s2);
      if (first) { first = false; return res(401, { error: { code: "session_expired", message: "x" } }); }
      return ok({ items: [], next_cursor: null });
    });
    await zavi.auth.signIn({ email: "a@b.co", password: "pw-123456" });
    await zavi.data.collection("posts").list();
    const data = calls.filter((c) => c.url.startsWith("/api/data"));
    expect(data.map((c) => c.headers.authorization)).toEqual([`Bearer ${s1.access_token}`, `Bearer ${s2.access_token}`]);
  });

  it("signOut clears locally even when the server is unreachable, and tells the broker with the token", async () => {
    const s = session(1);
    const storage = memStorage({ [sessionStorageKey(SITE)]: JSON.stringify(s) });
    const { zavi, calls } = harness(() => { throw new TypeError("offline"); }, { storage });
    await zavi.auth.signOut();
    expect(zavi.auth.session()).toBeNull();
    expect(storage.data[sessionStorageKey(SITE)]).toBeUndefined();
    expect(calls[0]).toMatchObject({ url: "/api/auth/logout", headers: { authorization: `Bearer ${s.access_token}` } });
  });

  it("every auth route matches the broker contract (bodies included)", async () => {
    const s = session(1);
    const { zavi, calls } = harness((c) => (c.url === "/api/auth/signup" ? ok({ status: "check_email" }) : c.url === "/api/auth/login" ? ok({ session: s }) : ok({ status: "check_email" })));
    expect(await zavi.auth.signUp({ email: "a@b.co", password: "pw-123456" })).toEqual({ session: null, confirmationRequired: true });
    await zavi.auth.signIn({ email: "a@b.co", password: "pw-123456" });
    await zavi.auth.signInWithMagicLink({ email: "a@b.co", next: "/admin" });
    await zavi.auth.resetPassword({ email: "a@b.co" });
    await zavi.auth.updatePassword("new-password", { currentPassword: "pw-123456" });
    await zavi.auth.changeEmail({ email: "new@b.co" });
    await zavi.auth.deleteAccount({ currentPassword: "pw-123456" });
    expect(calls.map((c) => [c.url, c.body])).toEqual([
      ["/api/auth/signup", { email: "a@b.co" }],
      ["/api/auth/login", { email: "a@b.co", password: "pw-123456" }],
      ["/api/auth/magic-link", { email: "a@b.co" }],
      ["/api/auth/recover", { email: "a@b.co" }],
      ["/api/auth/password", { password: "new-password", current_password: "pw-123456" }],
      ["/api/auth/email", { new_email: "new@b.co" }],
      ["/api/auth/delete", { current_password: "pw-123456" }],
    ]);
    expect(calls[4].headers.authorization).toBe(`Bearer ${s.access_token}`);
    expect(zavi.auth.session()).toBeNull();
  });

  it("keeps the broker's expires_in", async () => {
    const s = { ...session(1), expires_in: 3600 };
    const { zavi } = harness(() => ok({ session: s }));
    await zavi.auth.signIn({ email: "a@b.co", password: "pw-123456" });
    expect(zavi.auth.session()).toEqual(s);
  });

  it("reauth_required is a typed refusal the page can act on", async () => {
    const { isReauthRequired } = await import("../files/src/zavi/errors");
    const { zavi } = harness((c) => (c.url === "/api/auth/login" ? ok({ session: session(1) })
      : res(403, { error: { code: "reauth_required", message: "Confirm your current password to continue." } })));
    await zavi.auth.signIn({ email: "a@b.co", password: "pw-123456" });
    const e = await zavi.auth.deleteAccount().catch((x) => x);
    expect(e).toMatchObject({ code: "not_allowed", reason: "reauth_required" });
    expect(isReauthRequired(e)).toBe(true);
    expect(zavi.auth.session()).not.toBeNull();
  });

  it.each(["https://evil.example/x", "//evil.example/x", "/\\evil.example"])("refuses an off-site next %s", async (to) => {
    const { zavi, calls } = harness(() => ok({}));
    await expect(zavi.auth.signInWithMagicLink({ email: "a@b.co", next: to })).rejects.toMatchObject({ code: "validation" });
    expect(calls).toHaveLength(0);
  });

  it("account changes need a session (no anonymous call is made)", async () => {
    const { zavi, calls } = harness(() => ok({}));
    await expect(zavi.auth.updatePassword("x-12345678")).rejects.toMatchObject({ code: "not_allowed", reason: "signed_out" });
    expect(calls).toHaveLength(0);
  });
});

describe("storage", () => {
  const blob = (type = "image/png") => new Blob(["png-bytes"], { type });

  it("upload asks for a same-origin upload URL, then PUTs the bytes there", async () => {
    const { zavi, calls } = harness((c) => (c.url.endsWith("/upload-url") ? ok({ url: `${ORIGIN}/api/storage/photos/put/tok123`, method: "PUT" }) : res(200, {})));
    const out = await zavi.storage.upload("photos", Object.assign(blob(), { name: "Cat.PNG" }));
    expect(out.name).toMatch(/^[0-9a-f]{24}\.png$/);
    expect(calls[0]).toMatchObject({ url: "/api/storage/photos/upload-url", method: "POST", body: { name: out.name, content_type: "image/png", size: 9, upsert: false } });
    expect(calls[1]).toMatchObject({ url: "/api/storage/photos/put/tok123", method: "PUT", headers: { "content-type": "image/png" } });
  });

  it("refuses an off-site upload URL and never sends the bytes there", async () => {
    const { zavi, calls } = harness(() => ok({ url: "https://attacker.example/collect" }));
    await expect(zavi.storage.upload("photos", blob(), { name: "a.png" })).rejects.toMatchObject({ reason: "off_origin_url" });
    expect(calls).toHaveLength(1);
  });

  it("url() returns a same-origin path; remove needs a session; names are validated", async () => {
    const { zavi, calls } = harness(() => ok({ url: `${ORIGIN}/api/storage/photos/get/t?sig=1`, expires_at: 1 }));
    expect(await zavi.storage.url("photos", "a.png")).toBe("/api/storage/photos/get/t?sig=1");
    await expect(zavi.storage.remove("photos", "a.png")).rejects.toMatchObject({ code: "not_allowed" });
    for (const bad of ["../x", ".hidden", "a/b", "x".repeat(201)]) {
      await expect(zavi.storage.url("photos", bad)).rejects.toMatchObject({ code: "validation" });
    }
    await expect(zavi.storage.list("../auth")).rejects.toMatchObject({ code: "validation" });
    expect(calls).toHaveLength(1);
  });
});

describe("no secrets in the browser", () => {
  it("the SDK source has no database URL, key or supabase client", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(__dirname, "../files/src/zavi");
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
      const src = readFileSync(join(dir, f), "utf-8");
      expect(src, f).not.toMatch(/supabase\.co|anon_key|service_role|createClient\(/i);
    }
  });
});

vi.setConfig({ testTimeout: 10_000 });
