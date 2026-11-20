import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { createLocalServer, CSP, hostAllowed, type AppContext } from "../local/server";
import { Store } from "../store";
import { resolveKey } from "../keys";
import { RulesFile } from "../rules";
import { ActivityLog } from "../activity";
import { DatabaseManager } from "../db";
import { AdminAuth, ensureAdminToken } from "../admin-auth";
import { html } from "../html";
import type { Driver, Introspection } from "../db/types";

const intro: Introspection = {
  dialect: "postgres",
  database: null,
  tables: [{ name: "users", rowEstimate: 12, columns: [{ name: "id", type: "integer", nullable: false }, { name: "email", type: "text", nullable: false }, { name: "plan", type: "text", nullable: true }] }],
  skippedUnsafeNames: 0,
  namesSeenTotal: 1,
  deadlineHit: false,
  listingTruncated: false,
};
const PASSWORD = "hunter2-SECRET-pw";

let server: Server;
let port: number;
let token: string;
let ctx: AppContext;
let failTest = false;

function fakeDriver(): Driver {
  return {
    dialect: "postgres",
    database: null,
    test: async () => {
      if (failTest) throw new Error(`password authentication failed for postgres://ro:${PASSWORD}@db.internal/app`);
    },
    introspect: async () => intro,
    sql: async () => ({ columns: [], rows: [], truncated: false }),
    mongo: () => {
      throw new Error("x");
    },
    transport: () => "unverified_tls",
    close: async () => undefined,
  };
}

beforeEach(async () => {
  failTest = false;
  const dir = mkdtempSync(join(tmpdir(), "zc-local-"));
  const store = Store.open(dir, resolveKey({ secretFile: join(dir, "none"), envKey: null, dataDir: dir }));
  token = ensureAdminToken(store)!;
  ctx = {
    cfg: { machine: "box-1", version: "1.0.0", port: 7801, extraHosts: [], dataDir: dir },
    rules: new RulesFile(dir),
    db: new DatabaseManager(store, () => fakeDriver()),
    activity: new ActivityLog(dir),
    runtime: { status: { kind: "running" }, lastError: null, lastContactAt: Date.now(), lastHeartbeatAt: null, pairNote: null, online: () => true, heartbeatSoon: vi.fn() },
    auth: new AdminAuth(store),
    keySource: "generated",
    log: () => undefined,
  };
  server = createLocalServer(ctx);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

type Res = { status: number; headers: Record<string, string | string[] | undefined>; body: string };
function call(method: string, path: string, opts: { host?: string; origin?: string | null; cookie?: string; form?: Record<string, string | string[]>; type?: string } = {}): Promise<Res> {
  const host = opts.host ?? `localhost:${port}`;
  let body: string | undefined;
  if (opts.form) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.form)) for (const x of Array.isArray(v) ? v : [v]) p.append(k, x);
    body = p.toString();
  }
  const headers: Record<string, string> = { Host: host };
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (method === "POST") {
    headers["Content-Type"] = opts.type ?? "application/x-www-form-urlencoded";
    if (opts.origin !== null) headers.Origin = opts.origin ?? `http://${host}`;
  }
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function login(): Promise<{ cookie: string; csrf: string }> {
  const r = await call("POST", "/login", { form: { token } });
  expect(r.status).toBe(303);
  const set = String((r.headers["set-cookie"] as string[])[0]);
  const cookie = set.split(";")[0]!;
  const page = await call("GET", "/", { cookie });
  const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)![1]!;
  return { cookie, csrf };
}

describe("local page: authentication", () => {
  it.each(["/", "/database", "/rules", "/activity", "/activity/00000000-0000-0000-0000-000000000000"])("no session: %s redirects to /login", async (p) => {
    const r = await call("GET", p);
    expect(r.status).toBe(303);
    expect(r.headers.location).toBe("/login");
  });
  it("a wrong token is 401 and sets no cookie", async () => {
    const r = await call("POST", "/login", { form: { token: "zcadm_wrong" } });
    expect(r.status).toBe(401);
    expect(r.headers["set-cookie"]).toBeUndefined();
  });
  it("the session cookie is HttpOnly, SameSite=Strict, Path=/", async () => {
    const r = await call("POST", "/login", { form: { token } });
    const c = String((r.headers["set-cookie"] as string[])[0]);
    expect(c).toMatch(/^zc_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=43200$/);
  });
  it("logins lock after repeated wrong tokens", async () => {
    for (let i = 0; i < 10; i++) await call("POST", "/login", { form: { token: "zcadm_nope" } });
    expect((await call("POST", "/login", { form: { token } })).status).toBe(429);
  });
});

describe("local page: CSRF, Host, Origin", () => {
  it("POST without the CSRF token is 403", async () => {
    const { cookie } = await login();
    const r = await call("POST", "/rules", { cookie, form: { what_can_leave: "rows_without_blocked_columns", max_rows: "10", allowed: "users" } });
    expect(r.status).toBe(403);
  });
  it("a wrong Host (DNS rebinding) is 403 even with a session", async () => {
    const { cookie } = await login();
    expect((await call("GET", "/", { cookie, host: "attacker.example:7801" })).status).toBe(403);
    expect((await call("GET", "/healthz", { host: "rebind.attacker.example" })).status).toBe(403);
  });
  it("a cross-site or missing Origin on POST is 403", async () => {
    const { cookie, csrf } = await login();
    expect((await call("POST", "/database", { cookie, origin: "http://evil.example", form: { csrf, action: "remove" } })).status).toBe(403);
    expect((await call("POST", "/database", { cookie, origin: null, form: { csrf, action: "remove" } })).status).toBe(403);
  });
  it("Host names: localhost, 127.0.0.1, [::1] on any port, plus configured names", () => {
    expect(hostAllowed("localhost:9000", [])).toBe(true);
    expect(hostAllowed("127.0.0.1", [])).toBe(true);
    expect(hostAllowed("[::1]:7801", [])).toBe(true);
    expect(hostAllowed("localhost.attacker.com:7801", [])).toBe(false);
    expect(hostAllowed("box.lan:7801", ["box.lan"])).toBe(true);
    expect(hostAllowed(undefined, [])).toBe(false);
  });
  it("non-form bodies are refused", async () => {
    const { cookie } = await login();
    expect((await call("POST", "/rules", { cookie, type: "application/json", form: { a: "b" } })).status).toBe(415);
  });
});

describe("local page: headers and escaping", () => {
  it("every response has the CSP, no-store, nosniff and a same-origin referrer policy", async () => {
    const { cookie } = await login();
    for (const p of ["/", "/database", "/rules", "/activity", "/login", "/healthz", "/style.css", "/nope"]) {
      const r = await call("GET", p, { cookie });
      expect(r.headers["content-security-policy"]).toBe(CSP);
      expect(r.headers["cache-control"]).toBe("no-store");
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(r.headers["referrer-policy"]).toBe("same-origin");
      expect(r.body).not.toMatch(/<script/i);
      expect(r.body).not.toMatch(/name="referrer" content="no-referrer"/);
    }
    expect(CSP).toContain("default-src 'none'");
    expect(CSP).toContain("form-action 'self'");
    expect(CSP).toContain("base-uri 'none'");
    expect(CSP).toContain("frame-ancestors 'none'");
  });
  it("hostile query text and payloads in the activity log render escaped", async () => {
    const evil = `<script>alert(1)</script>"'><img src=x onerror=alert(2)>`;
    const e = ctx.activity.append({ request_id: "r1", op: "sql", query: evil, decision: "refused", reason: evil, rows: 0, bytes: 10, delivery: "delivered", sent: `{"reason":"${evil}"}` });
    const { cookie } = await login();
    const list = await call("GET", "/activity", { cookie });
    const detail = await call("GET", `/activity/${e.id}`, { cookie });
    for (const b of [list.body, detail.body]) {
      expect(b).not.toContain("<script>alert(1)</script>");
      expect(b).not.toContain("<img src=x");
      expect(b).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    }
  });
  it("the html template escapes every interpolation and has no raw escape hatch", () => {
    expect(html`<p title="${`" onmouseover="x`}">${"<b>&"}</p>`.value).toBe('<p title="&quot; onmouseover=&quot;x">&lt;b&gt;&amp;</p>');
    expect(html`${["<a>", html`<i>ok</i>`]}`.value).toBe("&lt;a&gt;<i>ok</i>");
    expect(html`${{ value: "<b>", toString: () => "<b>" }}`.value).toBe("&lt;b&gt;");
  });
});

describe("local page: database and rules", () => {
  it("the connection string never echoes: not on failure, not after saving", async () => {
    const { cookie, csrf } = await login();
    failTest = true;
    const bad = await call("POST", "/database", { cookie, form: { csrf, action: "test", dialect: "postgres", connection_string: `postgres://ro:${PASSWORD}@db.internal/app` } });
    expect(bad.body).toContain("[FAILED]");
    expect(bad.body).toContain("Nothing was saved");
    expect(bad.body).not.toContain(PASSWORD);
    failTest = false;
    const ok = await call("POST", "/database", { cookie, form: { csrf, action: "test", dialect: "postgres", connection_string: `postgres://ro:${PASSWORD}@db.internal/app` } });
    expect(ok.body).toContain("[OK] Connected. Found 1 table: users (12 rows).");
    for (const p of ["/", "/database", "/rules"]) expect((await call("GET", p, { cookie })).body).not.toContain(PASSWORD);
    expect(ctx.runtime.heartbeatSoon).toHaveBeenCalled();
  });
  it("rules: sensitive columns are pre-ticked, saving writes rules.yaml and takes effect", async () => {
    const { cookie, csrf } = await login();
    await call("POST", "/database", { cookie, form: { csrf, action: "test", dialect: "postgres", connection_string: "postgres://ro:pw@db.internal/app" } });
    const page = await call("GET", "/rules", { cookie });
    expect(page.body).toMatch(/name="blocked" value="users\.email" checked/);
    expect(page.body).toContain("Totals only stops raw rows leaving your network.");
    const r = await call("POST", "/rules", { cookie, form: { csrf, allowed: ["users", "not_a_table"], blocked: "users.email", blocked_extra: "users.notes.secret\n", what_can_leave: "rows_without_blocked_columns", max_rows: "75" } });
    expect(r.status).toBe(303);
    expect(ctx.rules.current().rules).toEqual({ allowed: ["users"], blocked: ["users.email", "users.notes.secret"], what_can_leave: "rows_without_blocked_columns", max_rows: 75 });
  });
  it("rules: an out-of-range max rows is refused and nothing is written", async () => {
    const { cookie, csrf } = await login();
    await call("POST", "/database", { cookie, form: { csrf, action: "test", dialect: "postgres", connection_string: "postgres://ro:pw@db.internal/app" } });
    const r = await call("POST", "/rules", { cookie, form: { csrf, allowed: "users", what_can_leave: "rows_without_blocked_columns", max_rows: "100000" } });
    expect(r.status).toBe(400);
    expect(ctx.rules.current().status).toBe("missing");
  });
  it("status shows the generated-key warning", async () => {
    const { cookie } = await login();
    expect((await call("GET", "/", { cookie })).body).toContain("Accidental-plaintext protection only");
  });
});
