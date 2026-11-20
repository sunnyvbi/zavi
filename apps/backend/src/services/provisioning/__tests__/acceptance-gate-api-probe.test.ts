import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const setting = vi.hoisted(() => ({ value: true as boolean | Error, booking: false }));
const logged = vi.hoisted(() => [] as Array<{ code: string }>);
const claims = vi.hoisted(() => ({ rows: [] as Array<{ conductor_run_id: string; dedup_key: string }> }));
const siteDb = vi.hoisted(() => ({
  calls: [] as Array<{ tenant: string; sql: string; params: unknown[] }>,
  fail: null as Error | null,
  events: [] as string[],
  probeCleanups: [] as string[],
}));
const history = vi.hoisted(() => ({ earlierFullBuild: false }));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => {
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "select", "eq", "neq", "is"]) chain[m] = () => chain;
    chain.limit = async () => ({ data: history.earlierFullBuild ? [{ id: "earlier" }] : [], error: null });
    return chain;
  },
}));

vi.mock("@/services/website/app-data", () => ({
  withGeneratedAppClient: vi.fn(
    async (tenant: string, fn: (c: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) => Promise<unknown>) => {
      if (siteDb.fail) throw siteDb.fail;
      return fn({
        query: async (sql: string, params: unknown[] = []) => {
          if (sql.includes("acc-probe")) {
            siteDb.probeCleanups.push(tenant);
            return { rowCount: 0, rows: [] };
          }
          siteDb.calls.push({ tenant, sql, params });
          siteDb.events.push("delete");
          return { rowCount: 1, rows: [] };
        },
      });
    },
  ),
}));

vi.mock("@/services/settings", () => ({
  getBoolSetting: vi.fn(async (key: string) => {
    if (key === "build_booking_smoke") return setting.booking;
    if (key !== "build_smoke_gate") throw new Error(`unexpected key ${key}`);
    if (setting.value instanceof Error) throw setting.value;
    return setting.value;
  }),
}));
vi.mock("@/services/logging/logEvent", () => ({
  logEvent: vi.fn(async (e: { code: string }) => {
    logged.push(e);
  }),
}));
vi.mock("@/services/supabase", () => {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "select", "eq", "order"]) chain[m] = () => chain;
  chain.limit = async () => ({
    data: [{ external_ref: { url: "https://apna-tutor-693dfbdb.zaviagent.com" } }],
    error: null,
  });
  chain.insert = async (row: { conductor_run_id: string; dedup_key: string }) => {
    if (claims.rows.some((r) => r.conductor_run_id === row.conductor_run_id && r.dedup_key === row.dedup_key)) {
      return { error: { code: "23505", message: "duplicate key" } };
    }
    claims.rows.push(row);
    return { error: null };
  };
  return { serviceClient: () => chain };
});

import { ownerLoginSmokeCheck, runAcceptanceBattery, type FetchLike } from "../acceptance-gate";
import { acceptanceProbe, resolveTenantAcceptanceGate } from "../acceptance-gate-driver";
import { APP_SETTINGS } from "@/services/settings/registry";
import type { ConductorNode } from "@/services/agents/conductor";

type Req = { method: string; path: string; search: string; cookie?: string; body?: string };
type Spec = { status: number; body?: string; headers?: Record<string, string | undefined> };

const BASE = "https://apna-tutor-693dfbdb.zaviagent.com";
const BOOK_CHUNK = "/_next/static/chunks/app/book/page-4f1c2a.js";

function bookingApp(availabilityStatus: number): (req: Req) => Spec {
  return (req) => {
    if (req.method !== "GET") return { status: 404 };
    if (req.path === "/")
      return {
        status: 200,
        body: '<title>Bath &amp; Brush</title><script src="/_next/static/chunks/main-app-1.js"></script><a href="/book">Book</a>',
      };
    if (req.path === "/book")
      return { status: 200, body: `<title>Book</title><script src="${BOOK_CHUNK}" async></script>` };
    if (req.path === BOOK_CHUNK)
      return {
        status: 200,
        body: 'let d=s.date;fetch(`/api/availability?date=${d}`).then(r=>r.json());fetch("/api/bookings",{method:"POST"});fetch("/api/auth/me")',
      };
    if (req.path === "/_next/static/chunks/main-app-1.js") return { status: 200, body: "self.__next_f=1" };
    if (req.path === "/api/availability") {
      if (!/[?&]date=\d{4}-\d{2}-\d{2}/.test(req.search)) return { status: 400, body: '{"error":"date required"}' };
      return { status: availabilityStatus, body: "{}" };
    }
    if (req.path === "/api/bookings") return { status: 405 };
    if (req.path === "/api/auth/me") return { status: 500 };
    return { status: 404 };
  };
}

function mkFetch(handler: (req: Req) => Spec, log: Req[]): FetchLike {
  return async (url, init) => {
    const u = new URL(url);
    const req = {
      method: (init?.method ?? "GET").toUpperCase(),
      path: u.pathname,
      search: u.search,
      cookie: init?.headers?.cookie,
      body: init?.body,
    };
    log.push(req);
    const spec = handler(req);
    return {
      status: spec.status,
      headers: { get: (name: string) => spec.headers?.[name.toLowerCase()] ?? null },
      text: async () => spec.body ?? "",
    };
  };
}

describe("NO_500_API: the battery calls the api routes the app's own pages use (DEL-1323 B2)", () => {
  it("fails the live B2 shape: /api/availability answers 400 bare but 500 with ?date=, naming the route", async () => {
    const log: Req[] = [];
    const res = await runAcceptanceBattery(
      { baseUrl: BASE, appSlug: "apna-tutor-693dfbdb", smokeGate: true },
      mkFetch(bookingApp(500), log),
    );
    const api = res.invariants.find((i) => i.name === "NO_500_API");
    expect(api?.pass).toBe(false);
    expect(api?.evidence).toMatch(/GET \/api\/availability\?date=\d{4}-\d{2}-\d{2} -> 500/);
    expect(res.pass).toBe(false);
    expect(res.firstFailure).toBe("NO_500_API");
    expect(res.invariants.find((i) => i.name === "REAL_APP")?.pass).toBe(true);
    expect(res.invariants.find((i) => i.name === "NO_500_CORE")?.pass).toBe(true);
    expect(log.some((r) => r.path === "/api/availability" && /date=\d{4}-\d{2}-\d{2}/.test(r.search))).toBe(true);
    expect(log.some((r) => r.path === "/api/auth/me")).toBe(false);
    expect(log.filter((r) => r.path === "/api/bookings" || r.path === "/api/availability").map((r) => r.method)).toEqual(
      ["GET", "GET"],
    );
    expect(log.filter((r) => r.path === "/api/availability").every((r) => /date=/.test(r.search))).toBe(true);
    const booking = res.invariants.find((i) => i.name === "BOOKING_SMOKE");
    expect(booking?.pass).toBe(false);
    expect(booking?.evidence).toMatch(/GET \/api\/availability\?date=\d{4}-\d{2}-\d{2} -> 500/);
    expect(log.some((r) => r.method === "POST" && r.path === "/api/bookings")).toBe(false);
  });

  it("the bare 400 is exactly what hid the 500 before: the route really does answer 400 without a date", async () => {
    const bare = await mkFetch(bookingApp(500), [])(`${BASE}/api/availability`);
    const dated = await mkFetch(bookingApp(500), [])(`${BASE}/api/availability?date=2026-09-30`);
    expect([bare.status, dated.status]).toEqual([400, 500]);
  });

  it("passes the same site once availability answers 200, and a 405 on a POST-only route is not a failure", async () => {
    const res = await runAcceptanceBattery(
      { baseUrl: BASE, appSlug: "apna-tutor-693dfbdb", smokeGate: true },
      mkFetch(bookingApp(200), []),
    );
    const api = res.invariants.find((i) => i.name === "NO_500_API");
    expect(api?.pass).toBe(true);
    expect(api?.evidence).toContain("/api/availability");
    expect(api?.evidence).toContain("/api/bookings");
    expect(res.pass).toBe(true);
  });

  it("leaves the battery unchanged when api probing is off", async () => {
    const log: Req[] = [];
    const res = await runAcceptanceBattery({ baseUrl: BASE, appSlug: "x" }, mkFetch(bookingApp(500), log));
    expect(res.invariants.map((i) => i.name)).toEqual([
      "REAL_APP",
      "NO_500_CORE",
      "AUTH_ROUNDTRIP",
      "PROTECTED_GATING",
      "NO_FORGED_SESSION",
    ]);
    expect(res.pass).toBe(true);
    expect(log.some((r) => r.path === "/api/availability" || r.path === "/book" || r.path === BOOK_CHUNK)).toBe(false);
  });
});

describe("acceptanceProbe enforces the smoke gate per tenant (DEL-1323 B2)", () => {
  const ORIG = process.env.BUILD_ACCEPTANCE_GATE_MODE;
  const fetchLog: Req[] = [];

  beforeEach(() => {
    delete process.env.BUILD_ACCEPTANCE_GATE_MODE;
    setting.value = true;
    logged.length = 0;
    fetchLog.length = 0;
    const f = mkFetch(bookingApp(500), fetchLog);
    vi.stubGlobal("fetch", (url: string, init: Parameters<FetchLike>[1]) => f(url, init));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (ORIG === undefined) delete process.env.BUILD_ACCEPTANCE_GATE_MODE;
    else process.env.BUILD_ACCEPTANCE_GATE_MODE = ORIG;
  });

  const node = { id: "deploy" } as unknown as ConductorNode;

  it("with the env unset and build_smoke_gate on, blocks a live site whose booking api 500s", async () => {
    const out = await acceptanceProbe({ tenant_id: "t1", conductor_run_id: "c1", node });
    expect(out.mode).toBe("enforce");
    expect(out.pass).toBe(false);
    expect(out.signal).toMatch(/^NO_500_API: .*\/api\/availability\?date=.* -> 500/);
    expect(logged.map((e) => e.code)).toEqual(["acceptance.enforce.fail"]);
  });

  it("with build_smoke_gate off, behaves exactly as before: env unset means no probe at all", async () => {
    setting.value = false;
    const out = await acceptanceProbe({ tenant_id: "t1", conductor_run_id: "c1", node });
    expect(out).toEqual({ mode: "shadow", pass: true, signal: "" });
    expect(fetchLog).toEqual([]);
    expect(logged).toEqual([]);
    await expect(resolveTenantAcceptanceGate("t1")).resolves.toEqual({ mode: "off", smokeGate: false, smokeOnly: false });
  });

  it("a settings read error falls back to the env mode, never to enforce", async () => {
    setting.value = new Error("db down");
    await expect(resolveTenantAcceptanceGate("t1")).resolves.toEqual({ mode: "off", smokeGate: false, smokeOnly: false });
    process.env.BUILD_ACCEPTANCE_GATE_MODE = "shadow";
    await expect(resolveTenantAcceptanceGate("t1")).resolves.toEqual({ mode: "shadow", smokeGate: false, smokeOnly: false });
  });

  it("env shadow does not let a smoke failure through while the key is on: the site is blocked, not called ready", async () => {
    process.env.BUILD_ACCEPTANCE_GATE_MODE = "shadow";
    const out = await acceptanceProbe({ tenant_id: "t1", conductor_run_id: "c1", node });
    expect(out.mode).toBe("enforce");
    expect(out.pass).toBe(false);
    expect(out.signal).toMatch(/^NO_500_API: .*\/api\/availability\?date=.* -> 500/);
    await expect(resolveTenantAcceptanceGate("t1")).resolves.toEqual({ mode: "enforce", smokeGate: true, smokeOnly: true });
  });

  it("env shadow with the key off stays shadow", async () => {
    process.env.BUILD_ACCEPTANCE_GATE_MODE = "shadow";
    setting.value = false;
    const out = await acceptanceProbe({ tenant_id: "t1", conductor_run_id: "c1", node });
    expect(out.mode).toBe("shadow");
    expect(out.pass).toBe(true);
  });
});

type SignupOutcome = "http500" | "error_redirect" | "works";

function ownerLoginApp(signup: SignupOutcome, usersRoute = 404): (req: Req) => Spec {
  return (req) => {
    if (req.method === "GET" && req.path === "/") return { status: 200, body: "<title>Bath &amp; Brush</title>" };
    if (req.method === "POST" && req.path === "/api/signup") {
      if (signup === "http500") return { status: 500 };
      if (signup === "error_redirect") return { status: 303, headers: { location: "/signup?error=server" } };
      return { status: 303, headers: { location: "/dashboard", "set-cookie": "session=tok.1; Path=/; HttpOnly" } };
    }
    if (req.method === "POST" && req.path === "/api/users") return { status: usersRoute };
    if (req.method === "GET" && (req.path === "/dashboard" || req.path === "/admin")) {
      if (req.cookie === "session=tok.1") return { status: 200 };
      return { status: 303, headers: { location: "/login?next=" + req.path } };
    }
    return { status: 404 };
  };
}

describe("AUTH_ROUNDTRIP: a signup that errors on the server fails the smoke gate (DEL-1323 B3)", () => {
  it("fails when POST /api/signup answers a bare 500, naming the route", async () => {
    const res = await runAcceptanceBattery(
      { baseUrl: BASE, appSlug: "apna-tutor-693dfbdb", smokeGate: true },
      mkFetch(ownerLoginApp("http500"), []),
    );
    const auth = res.invariants.find((i) => i.name === "AUTH_ROUNDTRIP");
    expect(auth?.pass).toBe(false);
    expect(auth?.evidence).toContain("POST /api/signup -> 500");
    expect(res.pass).toBe(false);
    expect(res.firstFailure).toBe("AUTH_ROUNDTRIP");
  });

  it("fails when signup redirects back with error=server, so a template-caught crash is not called ready", async () => {
    const res = await runAcceptanceBattery(
      { baseUrl: BASE, appSlug: "apna-tutor-693dfbdb", smokeGate: true },
      mkFetch(ownerLoginApp("error_redirect"), []),
    );
    const auth = res.invariants.find((i) => i.name === "AUTH_ROUNDTRIP");
    expect(auth?.pass).toBe(false);
    expect(auth?.evidence).toContain("POST /api/signup -> 303 (/signup?error=server)");
  });

  it("passes a site whose signup sets a session that opens the dashboard", async () => {
    const res = await runAcceptanceBattery(
      { baseUrl: BASE, appSlug: "apna-tutor-693dfbdb", smokeGate: true },
      mkFetch(ownerLoginApp("works", 500), []),
    );
    const auth = res.invariants.find((i) => i.name === "AUTH_ROUNDTRIP");
    expect(auth?.pass).toBe(true);
    expect(auth?.evidence).toContain("authed GET /dashboard -> 200");
  });

  it("a 500 from a non-signup route like POST /api/users is not read as a broken signup", async () => {
    const res = await runAcceptanceBattery(
      { baseUrl: BASE, appSlug: "apna-tutor-693dfbdb", smokeGate: true },
      mkFetch((req) => (req.method === "POST" && req.path === "/api/users" ? { status: 500 } : ownerLoginApp("works")(req)), []),
    );
    expect(res.invariants.find((i) => i.name === "AUTH_ROUNDTRIP")?.pass).toBe(true);
    const onlyUsers = await runAcceptanceBattery(
      { baseUrl: BASE, appSlug: "x", smokeGate: true },
      mkFetch((req) => (req.method === "POST" && req.path === "/api/users" ? { status: 500 } : req.path === "/" ? { status: 200, body: "<title>X</title>" } : { status: 404 }), []),
    );
    expect(onlyUsers.invariants.find((i) => i.name === "AUTH_ROUNDTRIP")?.pass).toBe(true);
  });

  it("with the key off the old inconclusive pass is unchanged", async () => {
    for (const outcome of ["http500", "error_redirect"] as const) {
      const res = await runAcceptanceBattery({ baseUrl: BASE, appSlug: "x" }, mkFetch(ownerLoginApp(outcome), []));
      const auth = res.invariants.find((i) => i.name === "AUTH_ROUNDTRIP");
      expect(auth?.pass).toBe(true);
      expect(auth?.evidence).toMatch(/inconclusive/);
    }
  });

  it("the driver blocks the live site end to end with the key on and the env unset", async () => {
    const ORIG = process.env.BUILD_ACCEPTANCE_GATE_MODE;
    delete process.env.BUILD_ACCEPTANCE_GATE_MODE;
    setting.value = true;
    logged.length = 0;
    const f = mkFetch(ownerLoginApp("http500"), []);
    vi.stubGlobal("fetch", (url: string, init: Parameters<FetchLike>[1]) => f(url, init));
    try {
      const out = await acceptanceProbe({
        tenant_id: "t1",
        conductor_run_id: "c1",
        node: { id: "deploy" } as unknown as ConductorNode,
      });
      expect(out.mode).toBe("enforce");
      expect(out.pass).toBe(false);
      expect(out.signal).toMatch(/^AUTH_ROUNDTRIP: signup fails with a server error.*POST \/api\/signup -> 500/);
      expect(logged.map((e) => e.code)).toEqual(["acceptance.enforce.fail"]);
    } finally {
      vi.unstubAllGlobals();
      if (ORIG === undefined) delete process.env.BUILD_ACCEPTANCE_GATE_MODE;
      else process.env.BUILD_ACCEPTANCE_GATE_MODE = ORIG;
    }
  });
});

function apiApp(chunk: string, routes: Record<string, (search: string) => number>): (req: Req) => Spec {
  return (req) => {
    if (req.method !== "GET") return { status: 404 };
    if (req.path === "/") return { status: 200, body: `<title>Acme</title><script src="${BOOK_CHUNK}"></script>` };
    if (req.path === BOOK_CHUNK) return { status: 200, body: chunk };
    const route = routes[req.path];
    if (route) return { status: route(req.search) };
    return { status: 404 };
  };
}

describe("NO_500_API only fails on read routes that 5xx for real (review finding 4)", () => {
  it("never calls side-effecting routes the bundle names, even when they would 500", async () => {
    const sideEffecting = [
      "/api/sendReminders", "/api/notifyOwner", "/api/cronDaily", "/api/emailCustomers", "/api/adminStats",
      "/api/SMSBlast", "/api/notify-owner", "/api/send-reminder", "/api/seed", "/api/reset-demo", "/api/delete-account",
      "/api/cron/daily", "/api/webhooks/twilio", "/api/email/welcome", "/api/sms", "/api/charge",
      "/api/pay", "/api/checkout", "/api/logout", "/api/admin/stats",
    ];
    const routes: Record<string, (s: string) => number> = { "/api/services": () => 200 };
    for (const r of sideEffecting) routes[r] = () => 500;
    const chunk = [...sideEffecting, "/api/services"].map((r) => `fetch("${r}")`).join(";");
    const log: Req[] = [];
    const res = await runAcceptanceBattery({ baseUrl: BASE, appSlug: "x", smokeGate: true }, mkFetch(apiApp(chunk, routes), log));
    const api = res.invariants.find((i) => i.name === "NO_500_API");
    expect(api?.pass).toBe(true);
    expect(api?.evidence).toBe("probed 1 api route(s): /api/services — none 5xx");
    expect(log.filter((r) => sideEffecting.includes(r.path))).toEqual([]);
  });

  it("does not fail a route that obviously needs params, however it is written in the bundle", async () => {
    const chunk = [
      "fetch(`/api/bookings/${id}`)",
      'fetch("/api/orders/" + id)',
      'fetch("/api/staff/[staffId]")',
      'fetch("/api/rooms/:roomId")',
      'fetch("/api/tutors/id")',
    ].join(";");
    const log: Req[] = [];
    const res = await runAcceptanceBattery(
      { baseUrl: BASE, appSlug: "x", smokeGate: true },
      mkFetch(
        apiApp(chunk, {
          "/api/bookings": () => 500,
          "/api/orders": () => 500,
          "/api/staff": () => 500,
          "/api/rooms": () => 500,
          "/api/tutors/id": () => 500,
        }),
        log,
      ),
    );
    expect(res.invariants.find((i) => i.name === "NO_500_API")?.pass).toBe(true);
    expect(res.pass).toBe(true);
    expect(log.filter((r) => r.method === "GET" && r.path.startsWith("/api/"))).toEqual([]);
  });

  it("still probes a collection route the bundle also calls bare, and fails it when it 500s", async () => {
    const chunk = 'fetch(`/api/bookings/${id}`);fetch("/api/bookings")';
    const res = await runAcceptanceBattery(
      { baseUrl: BASE, appSlug: "x", smokeGate: true },
      mkFetch(apiApp(chunk, { "/api/bookings": () => 500 }), []),
    );
    const api = res.invariants.find((i) => i.name === "NO_500_API");
    expect(api?.pass).toBe(false);
    expect(api?.evidence).toMatch(/GET \/api\/bookings\?date=\d{4}-\d{2}-\d{2} -> 500/);
  });

  it("fails a route that 500s on the date query even when the bare GET is fine, without a bare re-check", async () => {
    const log: Req[] = [];
    const res = await runAcceptanceBattery(
      { baseUrl: BASE, appSlug: "x", smokeGate: true, transientRetryDelayMs: 0 },
      mkFetch(apiApp('fetch("/api/services")', { "/api/services": (search) => (search.includes("date=") ? 500 : 200) }), log),
    );
    const api = res.invariants.find((i) => i.name === "NO_500_API");
    expect(api?.pass).toBe(false);
    expect(api?.evidence).toMatch(/GET \/api\/services\?date=\d{4}-\d{2}-\d{2} -> 500/);
    expect(log.filter((r) => r.path === "/api/services").map((r) => (r.search === "" ? "bare" : "dated"))).toEqual(["dated"]);
  });
});

describe("signup probe retries as JSON on a 5xx before calling it a server error (review finding 3)", () => {
  function jsonOnlySignup(jsonStatus: number): (req: Req & { contentType?: string }) => Spec {
    return (req) => {
      if (req.method === "GET" && req.path === "/") return { status: 200, body: "<title>Acme</title>" };
      if (req.method === "POST" && req.path === "/api/signup") {
        if (req.contentType !== "application/json") return { status: 500 };
        if (jsonStatus === 303) return { status: 303, headers: { location: "/dashboard", "set-cookie": "session=tok.1; Path=/" } };
        return { status: jsonStatus };
      }
      if (req.method === "GET" && req.path === "/dashboard") {
        return req.cookie === "session=tok.1" ? { status: 200 } : { status: 303, headers: { location: "/login" } };
      }
      return { status: 404 };
    };
  }
  function mkTypedFetch(handler: (req: Req & { contentType?: string }) => Spec, log: Array<Req & { contentType?: string }>): FetchLike {
    return async (url, init) => {
      const u = new URL(url);
      const req = {
        method: (init?.method ?? "GET").toUpperCase(),
        path: u.pathname,
        search: u.search,
        cookie: init?.headers?.cookie,
        contentType: init?.headers?.["content-type"],
      };
      log.push(req);
      const spec = handler(req);
      return {
        status: spec.status,
        headers: { get: (name: string) => spec.headers?.[name.toLowerCase()] ?? null },
        text: async () => spec.body ?? "",
      };
    };
  }

  it("a JSON-only signup that 500s on a form body but works with JSON passes", async () => {
    const log: Array<Req & { contentType?: string }> = [];
    const res = await runAcceptanceBattery({ baseUrl: BASE, appSlug: "x", smokeGate: true }, mkTypedFetch(jsonOnlySignup(303), log));
    const auth = res.invariants.find((i) => i.name === "AUTH_ROUNDTRIP");
    expect(auth?.pass).toBe(true);
    expect(auth?.evidence).toContain("authed GET /dashboard -> 200");
    expect(log.filter((r) => r.path === "/api/signup").map((r) => r.contentType)).toEqual([
      "application/x-www-form-urlencoded",
      "application/json",
    ]);
    expect(res.pass).toBe(true);
  });

  it("a JSON-only signup that answers the JSON body with a 400 is not a server error", async () => {
    const res = await runAcceptanceBattery({ baseUrl: BASE, appSlug: "x", smokeGate: true }, mkTypedFetch(jsonOnlySignup(400), []));
    const auth = res.invariants.find((i) => i.name === "AUTH_ROUNDTRIP");
    expect(auth?.pass).toBe(true);
    expect(auth?.evidence).not.toMatch(/server error/);
  });

  it("still fails when the JSON attempt 5xxs too", async () => {
    const res = await runAcceptanceBattery({ baseUrl: BASE, appSlug: "x", smokeGate: true }, mkTypedFetch(jsonOnlySignup(502), []));
    const auth = res.invariants.find((i) => i.name === "AUTH_ROUNDTRIP");
    expect(auth?.pass).toBe(false);
    expect(auth?.evidence).toContain("POST /api/signup -> 502");
  });
});

describe("env gate off + build_smoke_gate on enforces only the new smoke checks (review finding 5)", () => {
  const ORIG = process.env.BUILD_ACCEPTANCE_GATE_MODE;
  const node = { id: "deploy" } as unknown as ConductorNode;

  function forgeableApp(availability: number): (req: Req) => Spec {
    return (req) => {
      if (req.method === "POST" && req.path === "/api/signup")
        return { status: 303, headers: { location: "/dashboard", "set-cookie": "session=real.1; Path=/" } };
      if (req.method === "GET" && req.path === "/dashboard") {
        if (!req.cookie) return { status: 303, headers: { location: "/login" } };
        return { status: 200 };
      }
      return bookingApp(availability)(req);
    };
  }

  beforeEach(() => {
    delete process.env.BUILD_ACCEPTANCE_GATE_MODE;
    setting.value = true;
    logged.length = 0;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (ORIG === undefined) delete process.env.BUILD_ACCEPTANCE_GATE_MODE;
    else process.env.BUILD_ACCEPTANCE_GATE_MODE = ORIG;
  });

  function stub(handler: (req: Req) => Spec) {
    const f = mkFetch(handler, []);
    vi.stubGlobal("fetch", (url: string, init: Parameters<FetchLike>[1]) => f(url, init));
  }

  it("an old-invariant failure (forged session accepted) is logged in shadow and does not block", async () => {
    stub(forgeableApp(200));
    const battery = await runAcceptanceBattery({ baseUrl: BASE, appSlug: "x", smokeGate: true }, mkFetch(forgeableApp(200), []));
    expect(battery.firstFailure).toBe("NO_FORGED_SESSION");
    const out = await acceptanceProbe({ tenant_id: "t1", conductor_run_id: "c1", node });
    expect(out).toEqual({ mode: "enforce", pass: true, signal: "" });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      code: "acceptance.enforce.pass",
      meta: { acceptance_shadow_verdict: "fail", acceptance_shadow_failed_invariant: "NO_FORGED_SESSION" },
    });
  });

  it("a NO_500_API failure still blocks, even behind an earlier old-invariant failure", async () => {
    stub((req) => (req.path === "/" ? { status: 200, body: bookingApp(500)(req).body!.replace("Bath &amp; Brush", "Your Company") } : forgeableApp(500)(req)));
    const out = await acceptanceProbe({ tenant_id: "t1", conductor_run_id: "c1", node });
    expect(out.mode).toBe("enforce");
    expect(out.pass).toBe(false);
    expect(out.signal).toMatch(/^NO_500_API: .*\/api\/availability\?date=.* -> 500/);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      code: "acceptance.enforce.fail",
      meta: { acceptance_failed_invariant: "NO_500_API", acceptance_shadow_failed_invariant: "REAL_APP" },
    });
  });

  it("an explicit env enforce keeps blocking on the old invariants", async () => {
    process.env.BUILD_ACCEPTANCE_GATE_MODE = "enforce";
    stub(forgeableApp(200));
    const out = await acceptanceProbe({ tenant_id: "t1", conductor_run_id: "c1", node });
    expect(out.mode).toBe("enforce");
    expect(out.pass).toBe(false);
    expect(out.signal).toMatch(/^NO_FORGED_SESSION:/);
  });
});

describe("NO_500_API route skipping matches whole segments, not substrings (DEL-1323 B2)", () => {
  it("probes a tutoring site's /api/sessions booking route and fails it when it 500s with a date", async () => {
    const chunk = 'fetch("/api/sessions");fetch("/api/session");fetch("/api/auth/session");fetch("/api/authors")';
    const log: Req[] = [];
    const res = await runAcceptanceBattery(
      { baseUrl: BASE, appSlug: "x", smokeGate: true, transientRetryDelayMs: 0 },
      mkFetch(
        apiApp(chunk, {
          "/api/sessions": (search) => (search.includes("date=") ? 500 : 400),
          "/api/session": () => 500,
          "/api/auth/session": () => 500,
          "/api/authors": () => 200,
        }),
        log,
      ),
    );
    const api = res.invariants.find((i) => i.name === "NO_500_API");
    expect(api?.pass).toBe(false);
    expect(api?.evidence).toMatch(/GET \/api\/sessions\?date=\d{4}-\d{2}-\d{2} -> 500/);
    expect(api?.evidence).not.toMatch(/\/api\/session\?|\/api\/auth\/session/);
    const probed = [...new Set(log.filter((r) => r.method === "GET" && r.path.startsWith("/api/")).map((r) => r.path))].sort();
    expect(probed).toEqual(["/api/authors", "/api/sessions"]);
  });
});

describe("NO_500_API treats 502/503/504 as transient and re-probes once (DEL-1323 B2)", () => {
  function flaky(statuses: number[]): { handler: (req: Req) => Spec; calls: () => number } {
    let n = 0;
    const handler = apiApp('fetch("/api/services")', {
      "/api/services": (search) => {
        if (!search.includes("date=")) return 400;
        const s = statuses[Math.min(n, statuses.length - 1)];
        n += 1;
        return s;
      },
    });
    return { handler, calls: () => n };
  }

  it("a 503 that clears on the re-probe passes, and the re-probe repeats the dated GET", async () => {
    const log: Req[] = [];
    const f = flaky([503, 200]);
    const res = await runAcceptanceBattery({ baseUrl: BASE, appSlug: "x", smokeGate: true, transientRetryDelayMs: 0 }, mkFetch(f.handler, log));
    expect(res.invariants.find((i) => i.name === "NO_500_API")?.pass).toBe(true);
    expect(log.filter((r) => r.path === "/api/services").map((r) => (r.search === "" ? "bare" : "dated"))).toEqual(["dated", "dated"]);
  });

  it("a 503 that persists fails, even though the bare GET answers 400", async () => {
    const f = flaky([503, 503]);
    const res = await runAcceptanceBattery({ baseUrl: BASE, appSlug: "x", smokeGate: true, transientRetryDelayMs: 0 }, mkFetch(f.handler, []));
    const api = res.invariants.find((i) => i.name === "NO_500_API");
    expect(api?.pass).toBe(false);
    expect(api?.evidence).toMatch(/GET \/api\/services\?date=\d{4}-\d{2}-\d{2} -> 503/);
    expect(f.calls()).toBe(2);
  });

  it("a plain 500 is never re-probed", async () => {
    const f = flaky([500, 200]);
    const res = await runAcceptanceBattery({ baseUrl: BASE, appSlug: "x", smokeGate: true, transientRetryDelayMs: 0 }, mkFetch(f.handler, []));
    expect(res.invariants.find((i) => i.name === "NO_500_API")?.pass).toBe(false);
    expect(f.calls()).toBe(1);
  });

  it("waits before the re-probe", async () => {
    vi.useFakeTimers();
    try {
      const f = flaky([502, 200]);
      const done = runAcceptanceBattery({ baseUrl: BASE, appSlug: "x", smokeGate: true, transientRetryDelayMs: 1500 }, mkFetch(f.handler, []));
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.calls()).toBe(1);
      await vi.advanceTimersByTimeAsync(600);
      expect(f.calls()).toBe(2);
      expect((await done).invariants.find((i) => i.name === "NO_500_API")?.pass).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("401/403 and an unreachable route are not failures", async () => {
    const handler = apiApp('fetch("/api/services");fetch("/api/staff");fetch("/api/rooms")', {
      "/api/services": () => 401,
      "/api/staff": () => 403,
    });
    const fetchImpl: FetchLike = async (url, init) => {
      if (new URL(url).pathname === "/api/rooms") throw new Error("aborted");
      return mkFetch(handler, [])(url, init);
    };
    const res = await runAcceptanceBattery({ baseUrl: BASE, appSlug: "x", smokeGate: true, transientRetryDelayMs: 0 }, fetchImpl);
    expect(res.invariants.find((i) => i.name === "NO_500_API")?.pass).toBe(true);
  });
});

type SalonOpts = {
  days?: Record<number, unknown>;
  post?: number;
  postBody?: string;
  del?: number;
};

const SALON_CHUNK = "/_next/static/chunks/app/book/page-9a1b.js";

function dayOffset(search: string): number | null {
  const m = search.match(/date=(\d{4}-\d{2}-\d{2})/);
  if (!m) return null;
  const today = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.round((Date.parse(`${m[1]}T00:00:00Z`) - today) / 86_400_000);
}

function salonApp(opts: SalonOpts = {}): (req: Req) => Spec {
  const days: Record<number, unknown> = opts.days ?? {
    0: { slots: [{ time: "09:00", available: false }, { id: 31, time: "10:30", available: true, staffId: 4 }] },
  };
  return (req) => {
    if (req.method === "POST" && req.path === "/api/sessions") {
      return { status: opts.post ?? 201, body: opts.postBody ?? '{"booking":{"id":"bk_9"}}' };
    }
    if (req.method === "DELETE" && req.path === "/api/sessions/bk_9") return { status: opts.del ?? 204 };
    if (req.method !== "GET") return { status: 404 };
    if (req.path === "/") return { status: 200, body: '<title>Glow Salon</title><a href="/book">Book</a>' };
    if (req.path === "/book") return { status: 200, body: `<title>Book</title><script src="${SALON_CHUNK}"></script>` };
    if (req.path === SALON_CHUNK) {
      return {
        status: 200,
        body:
          'fetch("/api/services").then(r=>r.json());fetch(`/api/availability?date=${d}`).then(r=>r.json());' +
          'fetch("/api/sessions",{headers:{"content-type":"application/json"},method:"POST",body:JSON.stringify(b)})',
      };
    }
    if (req.path === "/api/services") return { status: 200, body: '[{"id":"svc_1","name":"Cut"}]' };
    if (req.path === "/api/availability") {
      const off = dayOffset(req.search);
      if (off === null) return { status: 400, body: '{"error":"date required"}' };
      const day = off in days ? days[off] : { slots: [] };
      return typeof day === "number" ? { status: day } : { status: 200, body: JSON.stringify(day) };
    }
    return { status: 404 };
  };
}

async function runSalon(
  opts: SalonOpts,
  log: Req[],
  smokeGate = true,
  claimBookingSmoke: (() => Promise<boolean>) | null = async () => true,
) {
  return runAcceptanceBattery(
    { baseUrl: BASE, appSlug: "glow", smokeGate, transientRetryDelayMs: 0, claimBookingSmoke: claimBookingSmoke ?? undefined },
    mkFetch(salonApp(opts), log),
  );
}

describe("BOOKING_SMOKE: the gate books one real slot on the live site (DEL-1323 B2, Ravi Q8)", () => {
  it("fails when the booking POST 500s for a slot the site itself offered, after exactly one attempt with test data", async () => {
    const log: Req[] = [];
    const res = await runSalon({ post: 500 }, log);
    const booking = res.invariants.find((i) => i.name === "BOOKING_SMOKE");
    expect(booking?.pass).toBe(false);
    expect(booking?.smoke).toBe(true);
    expect(booking?.evidence).toMatch(/POST \/api\/sessions -> 500 for a slot the site offered \(\/api\/availability\?date=\d{4}-\d{2}-\d{2}\)/);
    expect(res.invariants.find((i) => i.name === "NO_500_API")?.pass).toBe(true);
    expect(res.firstFailure).toBe("BOOKING_SMOKE");
    const posts = log.filter((r) => r.method === "POST" && r.path === "/api/sessions");
    expect(posts).toHaveLength(1);
    const body = JSON.parse(posts[0].body ?? "{}");
    expect(body).toMatchObject({
      name: "Zavi smoke test",
      email: "zavi-smoke-test@zavi.invalid",
      date: new Date().toISOString().slice(0, 10),
      time: "10:30",
      staffId: 4,
      slotId: 31,
      serviceId: "svc_1",
      service_id: "svc_1",
    });
    expect(body.id).toBeUndefined();
    expect(Object.keys(body).filter((k) => /phone/i.test(k))).toEqual([]);
    expect(log.some((r) => r.method === "DELETE")).toBe(false);
  });

  it("passes when the booking lands, and deletes its own test booking by the id the site returned", async () => {
    const log: Req[] = [];
    const res = await runSalon({}, log);
    const booking = res.invariants.find((i) => i.name === "BOOKING_SMOKE");
    expect(booking?.pass).toBe(true);
    expect(booking?.evidence).toContain("POST /api/sessions -> 201; test booking deleted");
    expect(log.filter((r) => r.method === "POST" && r.path === "/api/sessions")).toHaveLength(1);
    expect(log.filter((r) => r.method === "DELETE").map((r) => r.path)).toEqual(["/api/sessions/bk_9"]);
    expect(res.pass).toBe(true);
  });

  it("says so when the site offers no way to delete the test booking", async () => {
    const res = await runSalon({ del: 405 }, []);
    expect(res.invariants.find((i) => i.name === "BOOKING_SMOKE")?.evidence).toContain("DELETE /api/sessions/:id -> 405, test booking left in place");
  });

  it("looks ahead when today is full, never books a slot marked taken, and books the first open day", async () => {
    const log: Req[] = [];
    const res = await runSalon(
      {
        days: {
          0: { bookedTimes: ["11:00"], slots: [{ time: "09:00", booked: true }] },
          1: { slots: [] },
          2: ["2026-01-01T14:00:00.000Z"],
        },
      },
      log,
    );
    expect(res.invariants.find((i) => i.name === "BOOKING_SMOKE")?.pass).toBe(true);
    expect(log.filter((r) => r.path === "/api/availability").map((r) => dayOffset(r.search))).toEqual([0, 1, 2]);
    const body = JSON.parse(log.find((r) => r.method === "POST" && r.path === "/api/sessions")?.body ?? "{}");
    expect(body).toMatchObject({ start: "2026-01-01T14:00:00.000Z", time: "14:00", date: "2026-01-01" });
  });

  it("fails when a later day's availability 500s, before any booking is attempted", async () => {
    const log: Req[] = [];
    const res = await runSalon({ days: { 0: { slots: [] }, 1: 500 } }, log);
    const booking = res.invariants.find((i) => i.name === "BOOKING_SMOKE");
    expect(booking?.pass).toBe(false);
    expect(booking?.evidence).toMatch(/GET \/api\/availability\?date=\d{4}-\d{2}-\d{2} -> 500/);
    expect(log.some((r) => r.method === "POST" && r.path === "/api/sessions")).toBe(false);
  });

  it("never retries the booking POST: a 503 is one attempt and an inconclusive pass", async () => {
    const log: Req[] = [];
    const res = await runSalon({ post: 503 }, log);
    const booking = res.invariants.find((i) => i.name === "BOOKING_SMOKE");
    expect(booking?.pass).toBe(true);
    expect(booking?.evidence).toMatch(/inconclusive/);
    expect(log.filter((r) => r.method === "POST" && r.path === "/api/sessions")).toHaveLength(1);
  });

  it("a 4xx from the booking route (payload the app rejects) is not a failure", async () => {
    const res = await runSalon({ post: 422 }, []);
    expect(res.invariants.find((i) => i.name === "BOOKING_SMOKE")?.pass).toBe(true);
    expect(res.pass).toBe(true);
  });

  it("does nothing with the smoke gate off: no booking POST, no invariant", async () => {
    const log: Req[] = [];
    const res = await runSalon({ post: 500 }, log, false);
    expect(res.invariants.find((i) => i.name === "BOOKING_SMOKE")).toBeUndefined();
    expect(log.some((r) => r.method === "POST" && r.path === "/api/sessions")).toBe(false);
  });

  it("a site with no booking POST in its pages gets no booking attempt", async () => {
    const log: Req[] = [];
    const res = await runAcceptanceBattery(
      { baseUrl: BASE, appSlug: "x", smokeGate: true, transientRetryDelayMs: 0 },
      mkFetch(apiApp('fetch(`/api/availability?date=${d}`)', { "/api/availability": () => 200 }), log),
    );
    expect(res.invariants.find((i) => i.name === "BOOKING_SMOKE")).toBeUndefined();
    expect(log.some((r) => r.method === "POST" && r.path === "/api/availability")).toBe(false);
  });
});

describe("BOOKING_SMOKE is opt-in, once per build, and never deletes what it did not create (DEL-1323 B2 review)", () => {
  it("without a claim (build_booking_smoke off or a refine) it checks availability but never POSTs a booking", async () => {
    const log: Req[] = [];
    const res = await runSalon({ post: 500 }, log, true, null);
    const booking = res.invariants.find((i) => i.name === "BOOKING_SMOKE");
    expect(booking?.pass).toBe(true);
    expect(booking?.evidence).toContain("test booking not attempted");
    expect(log.some((r) => r.method === "POST" && r.path === "/api/sessions")).toBe(false);
    expect(log.some((r) => r.path === "/api/availability")).toBe(true);
  });

  it("a claim already taken for this build means no second booking", async () => {
    const log: Req[] = [];
    const claim = vi.fn(async () => false);
    const res = await runSalon({ post: 500 }, log, true, claim);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(res.invariants.find((i) => i.name === "BOOKING_SMOKE")?.evidence).toContain("already attempted for this build");
    expect(log.some((r) => r.method === "POST" && r.path === "/api/sessions")).toBe(false);
  });

  it("never copies ids from user, owner, admin or member list routes into the booking", async () => {
    const log: Req[] = [];
    const base = salonApp();
    const handler = (req: Req): Spec => {
      if (req.path === SALON_CHUNK) {
        return {
          status: 200,
          body:
            'fetch("/api/users");fetch("/api/owners");fetch("/api/adminMembers");fetch("/api/team-members");fetch("/api/services");' +
            'fetch(`/api/availability?date=${d}`);fetch("/api/sessions",{method:"POST",body:b})',
        };
      }
      if (["/api/users", "/api/owners", "/api/adminMembers", "/api/team-members"].includes(req.path)) {
        return { status: 200, body: '[{"id":"u_owner_1","email":"owner@real.example"}]' };
      }
      return base(req);
    };
    await runAcceptanceBattery(
      { baseUrl: BASE, appSlug: "glow", smokeGate: true, transientRetryDelayMs: 0, claimBookingSmoke: async () => true },
      mkFetch(handler, log),
    );
    const body = JSON.parse(log.find((r) => r.method === "POST" && r.path === "/api/sessions")?.body ?? "{}");
    expect(body.serviceId).toBe("svc_1");
    expect(JSON.stringify(body)).not.toContain("u_owner_1");
  });

  it("only DELETEs an id the booking response clearly returned for the created booking, never a slot id", async () => {
    for (const postBody of ['{"id":31}', '{"id":"x_1","ok":true}', '{"booking":{"id":31}}', '{"data":{"id":"x_2"}}']) {
      const log: Req[] = [];
      const res = await runSalon({ postBody }, log);
      expect(log.some((r) => r.method === "DELETE"), postBody).toBe(false);
      expect(res.invariants.find((i) => i.name === "BOOKING_SMOKE")?.evidence, postBody).toContain("no id returned, test booking left in place");
    }
    const log: Req[] = [];
    await runSalon({ postBody: '{"id":"bk_9","email":"zavi-smoke-test@zavi.invalid"}' }, log);
    expect(log.filter((r) => r.method === "DELETE").map((r) => r.path)).toEqual(["/api/sessions/bk_9"]);
  });
});

describe("acceptanceProbe: booking smoke key, first build only, one claim per run, env kill switch (DEL-1323 B2 review)", () => {
  const ORIG = process.env.BUILD_ACCEPTANCE_GATE_MODE;
  const fetchLog: Req[] = [];
  const node = { id: "deploy", payload: { stage: "deploy" } } as unknown as ConductorNode;
  const posts = () => fetchLog.filter((r) => r.method === "POST" && r.path === "/api/sessions");

  beforeEach(() => {
    delete process.env.BUILD_ACCEPTANCE_GATE_MODE;
    setting.value = true;
    setting.booking = true;
    claims.rows = [];
    logged.length = 0;
    fetchLog.length = 0;
    const f = mkFetch(salonApp(), fetchLog);
    vi.stubGlobal("fetch", (url: string, init: Parameters<FetchLike>[1]) => f(url, init));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setting.booking = false;
    if (ORIG === undefined) delete process.env.BUILD_ACCEPTANCE_GATE_MODE;
    else process.env.BUILD_ACCEPTANCE_GATE_MODE = ORIG;
  });

  it("key on, first build: books once, and a re-probe or overlapping tick of the same run never books again", async () => {
    await acceptanceProbe({ tenant_id: "t1", conductor_run_id: "run-1", node });
    await Promise.all([
      acceptanceProbe({ tenant_id: "t1", conductor_run_id: "run-1", node: { ...node, acceptance_attempts: 1 } as ConductorNode }),
      acceptanceProbe({ tenant_id: "t1", conductor_run_id: "run-1", node }),
    ]);
    expect(posts()).toHaveLength(1);
    expect(claims.rows).toEqual([{ conductor_run_id: "run-1", dedup_key: "acceptance:booking_smoke" }]);
  });

  it("a later full build of a tenant that already finished one never books again (review F5)", async () => {
    history.earlierFullBuild = true;
    try {
      const out = await acceptanceProbe({ tenant_id: "t1", conductor_run_id: "run-5b", node });
      expect(out.pass).toBe(true);
      expect(posts()).toEqual([]);
      expect(claims.rows).toEqual([]);
    } finally {
      history.earlierFullBuild = false;
    }
  });

  it("removes the AUTH_ROUNDTRIP acc-probe users from the tenant's site after every gate run (review F1)", async () => {
    siteDb.probeCleanups = [];
    await acceptanceProbe({ tenant_id: "t1", conductor_run_id: "run-5c", node });
    expect(siteDb.probeCleanups).toEqual(["t1"]);
  });

  it("key off by default: no booking POST, no claim", async () => {
    setting.booking = false;
    const out = await acceptanceProbe({ tenant_id: "t1", conductor_run_id: "run-2", node });
    expect(out.pass).toBe(true);
    expect(posts()).toEqual([]);
    expect(claims.rows).toEqual([]);
  });

  it("a refine never books, whether flagged by the conductor or by pre_refine_sha on the deploy node", async () => {
    await acceptanceProbe({ tenant_id: "t1", conductor_run_id: "run-3", node, refine: true });
    await acceptanceProbe({
      tenant_id: "t1",
      conductor_run_id: "run-4",
      node: { ...node, payload: { stage: "deploy", pre_refine_sha: "abc" } } as unknown as ConductorNode,
    });
    expect(posts()).toEqual([]);
    expect(claims.rows).toEqual([]);
  });

  it("BUILD_ACCEPTANCE_GATE_MODE=off disables the gate entirely even with build_smoke_gate on", async () => {
    process.env.BUILD_ACCEPTANCE_GATE_MODE = " OFF ";
    const f = mkFetch(bookingApp(500), fetchLog);
    vi.stubGlobal("fetch", (url: string, init: Parameters<FetchLike>[1]) => f(url, init));
    const out = await acceptanceProbe({ tenant_id: "t1", conductor_run_id: "run-5", node });
    expect(out).toEqual({ mode: "shadow", pass: true, signal: "" });
    expect(fetchLog).toEqual([]);
    expect(logged).toEqual([]);
    await expect(resolveTenantAcceptanceGate("t1")).resolves.toEqual({ mode: "off", smokeGate: false, smokeOnly: false });
    process.env.BUILD_ACCEPTANCE_GATE_MODE = "shadow";
    await expect(resolveTenantAcceptanceGate("t1")).resolves.toEqual({ mode: "enforce", smokeGate: true, smokeOnly: true });
  });
});

describe("owner-login smoke hook (left for DEL-1323 B3)", () => {
  it("runs the injected check against the live url and enforces its verdict as a smoke check", async () => {
    const seen: string[] = [];
    const res = await runAcceptanceBattery(
      {
        baseUrl: `${BASE}/`,
        appSlug: "x",
        smokeGate: true,
        ownerLoginCheck: async ({ baseUrl, fetch }) => {
          seen.push(baseUrl);
          const p = await fetch(`${baseUrl}/admin`);
          return { name: "OWNER_LOGIN", pass: p.status === 200, evidence: `GET /admin -> ${p.status}` };
        },
      },
      mkFetch((req) => (req.path === "/" ? { status: 200, body: "<title>X</title>" } : req.path === "/admin" ? { status: 303 } : { status: 404 }), []),
    );
    expect(seen).toEqual([BASE]);
    const owner = res.invariants.find((i) => i.name === "OWNER_LOGIN");
    expect(owner).toEqual({ name: "OWNER_LOGIN", pass: false, smoke: true, evidence: "GET /admin -> 303" });
    expect(res.firstFailure).toBe("OWNER_LOGIN");
  });

  it("a hook that throws never fails the gate, and the hook never runs with the smoke gate off", async () => {
    const hook = vi.fn(async () => {
      throw new Error("boom");
    });
    const on = await runAcceptanceBattery({ baseUrl: BASE, appSlug: "x", smokeGate: true, ownerLoginCheck: hook }, mkFetch(() => ({ status: 404 }), []));
    expect(on.invariants.find((i) => i.name === "OWNER_LOGIN")).toMatchObject({ pass: true, smoke: true });
    hook.mockClear();
    await runAcceptanceBattery({ baseUrl: BASE, appSlug: "x", ownerLoginCheck: hook }, mkFetch(() => ({ status: 404 }), []));
    expect(hook).not.toHaveBeenCalled();
  });
});

type AuthOpts = {
  signupPage?: boolean;
  signup?: (req: Req) => Spec;
  admin?: (cookie: string | undefined) => Spec;
};

function authApp(opts: AuthOpts = {}): (req: Req) => Spec {
  return (req) => {
    if (req.method === "GET" && req.path === "/") return { status: 200, body: "<title>Still Water Yoga</title><a href=\"/signup\">Sign up</a>" };
    if (req.method === "GET" && req.path === "/signup") return opts.signupPage === false ? { status: 404 } : { status: 200, body: "<form></form>" };
    if (req.method === "POST" && req.path === "/api/signup") {
      return opts.signup
        ? opts.signup(req)
        : { status: 303, headers: { location: "/", "set-cookie": "zavi_session=s3cr3t.sig; Path=/; HttpOnly" } };
    }
    if (req.method === "GET" && req.path === "/admin") {
      return opts.admin ? opts.admin(req.cookie) : req.cookie ? { status: 403 } : { status: 307, headers: { location: "/login" } };
    }
    return { status: 404 };
  };
}

const smokeSignups = (log: Req[]) =>
  log.filter((r) => r.method === "POST" && r.path === "/api/signup" && (r.body ?? "").includes("zavi-smoke-"));

async function ownerLogin(app: (req: Req) => Spec, claim: () => Promise<boolean> = async () => true) {
  const log: Req[] = [];
  const res = await runAcceptanceBattery(
    { baseUrl: BASE, appSlug: "x", smokeGate: true, ownerLoginCheck: ownerLoginSmokeCheck({ runId: "Run-9f3a", claim, password: "Aa1!pw-fixed" }) },
    mkFetch(app, log),
  );
  return { owner: res.invariants.find((i) => i.name === "OWNER_LOGIN"), res, log };
}

describe("OWNER_LOGIN: a throwaway user signs up on the live site and /admin answers with that session (DEL-1323 B2, Ravi Q8)", () => {
  it("signs up zavi-smoke-<run>@zavi.invalid, then GETs /admin with the returned cookie; a non-admin 403 passes", async () => {
    const claim = vi.fn(async () => true);
    const { owner, log } = await ownerLogin(authApp(), claim);
    expect(owner).toMatchObject({ name: "OWNER_LOGIN", pass: true, smoke: true });
    expect(owner!.evidence).toBe("POST /api/signup -> 303 (/) +cookie; GET /admin with that session -> 403");
    expect(claim).toHaveBeenCalledTimes(1);
    const posts = smokeSignups(log);
    expect(posts).toHaveLength(1);
    expect(new URLSearchParams(posts[0].body).get("email")).toBe("zavi-smoke-run-9f3a@zavi.invalid");
    expect(new URLSearchParams(posts[0].body).get("password")).toBe("Aa1!pw-fixed");
    expect(log.some((r) => r.path === "/admin" && r.cookie === "zavi_session=s3cr3t.sig")).toBe(true);
  });

  it("a redirect to the admin login or the admin page itself also passes", async () => {
    expect((await ownerLogin(authApp({ admin: (c) => (c ? { status: 200 } : { status: 404 }) }))).owner!.pass).toBe(true);
    expect((await ownerLogin(authApp({ admin: (c) => (c ? { status: 307, headers: { location: "/login?next=/admin" } } : { status: 404 }) }))).owner!.pass).toBe(true);
  });

  it("fails when /admin answers 5xx or bounces to error=server with the new session", async () => {
    const five = await ownerLogin(authApp({ admin: (c) => (c ? { status: 500 } : { status: 307, headers: { location: "/login" } }) }));
    expect(five.owner).toMatchObject({ pass: false, smoke: true });
    expect(five.owner!.evidence).toContain("GET /admin with that session -> 500, so the owner cannot open the admin");
    expect(five.res.pass).toBe(false);
    const err = await ownerLogin(authApp({ admin: (c) => (c ? { status: 303, headers: { location: "/admin?error=server" } } : { status: 404 }) }));
    expect(err.owner!.pass).toBe(false);
  });

  it("fails when signup answers 5xx or redirects with error=server", async () => {
    const five = await ownerLogin(authApp({ signup: () => ({ status: 500 }) }));
    expect(five.owner).toMatchObject({ pass: false });
    expect(five.owner!.evidence).toContain("POST /api/signup -> 500: signing up fails with a server error");
    const redirect = await ownerLogin(authApp({ signup: () => ({ status: 303, headers: { location: "/signup?error=server" } }) }));
    expect(redirect.owner!.pass).toBe(false);
    expect(redirect.owner!.evidence).toContain("(/signup?error=server)");
  });

  it("fails when signup redirects as a success but sets no session cookie", async () => {
    const { owner } = await ownerLogin(authApp({ signup: () => ({ status: 303, headers: { location: "/" } }) }));
    expect(owner!.pass).toBe(false);
    expect(owner!.evidence).toBe("POST /api/signup -> 303 (/) but set no session cookie, so a new account is never logged in and the owner cannot reach /admin");
  });

  it("an ordinary form error (error=exists) or a 2xx with no cookie is inconclusive, not a failure", async () => {
    expect((await ownerLogin(authApp({ signup: () => ({ status: 303, headers: { location: "/signup?error=exists" } }) }))).owner!.pass).toBe(true);
    expect((await ownerLogin(authApp({ signup: () => ({ status: 200, body: "check your email" }) }))).owner!.pass).toBe(true);
  });

  it("no sign-up page: nothing is claimed and nobody is signed up", async () => {
    const claim = vi.fn(async () => true);
    const { owner, log } = await ownerLogin(authApp({ signupPage: false }), claim);
    expect(owner).toMatchObject({ pass: true, evidence: "no sign-up page — owner login not asserted" });
    expect(claim).not.toHaveBeenCalled();
    expect(smokeSignups(log)).toEqual([]);
  });

  it("hands the throwaway email to cleanup after the signup, and a failing cleanup never changes the verdict", async () => {
    const order: string[] = [];
    const cleanup = vi.fn(async (_email: string) => {
      order.push("cleanup");
      throw new Error("site db down");
    });
    const log: Req[] = [];
    const app = authApp({ admin: (c) => (c ? { status: 500 } : { status: 404 }) });
    const res = await runAcceptanceBattery(
      {
        baseUrl: BASE,
        appSlug: "x",
        smokeGate: true,
        ownerLoginCheck: ownerLoginSmokeCheck({ runId: "Run-9f3a", claim: async () => true, cleanup }),
      },
      mkFetch((req) => {
        if ((req.body ?? "").includes("zavi-smoke-run-9f3a") || (req.path === "/admin" && req.cookie)) {
          order.push(`${req.method} ${req.path}`);
        }
        return app(req);
      }, log),
    );
    const owner = res.invariants.find((i) => i.name === "OWNER_LOGIN");
    expect(owner).toMatchObject({ pass: false, smoke: true });
    expect(owner!.evidence).toContain("GET /admin with that session -> 500");
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledWith("zavi-smoke-run-9f3a@zavi.invalid");
    expect(order.slice(0, 3)).toEqual(["POST /api/signup", "GET /admin", "cleanup"]);
  });

  it("no cleanup runs when nobody was signed up", async () => {
    const cleanup = vi.fn(async () => undefined);
    for (const [app, claim] of [[authApp({ signupPage: false }), true], [authApp(), false]] as const) {
      await runAcceptanceBattery(
        { baseUrl: BASE, appSlug: "x", smokeGate: true, ownerLoginCheck: ownerLoginSmokeCheck({ runId: "r", claim: async () => claim, cleanup }) },
        mkFetch(app, []),
      );
    }
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("a lost claim never signs up a second throwaway user", async () => {
    const { owner, log } = await ownerLogin(authApp(), async () => false);
    expect(owner!.pass).toBe(true);
    expect(owner!.evidence).toContain("already checked for this build");
    expect(smokeSignups(log)).toEqual([]);
  });
});

describe("acceptanceProbe wires OWNER_LOGIN for first product builds, once per run, behind build_smoke_gate (DEL-1323 B2, Ravi Q8)", () => {
  const ORIG = process.env.BUILD_ACCEPTANCE_GATE_MODE;
  const fetchLog: Req[] = [];
  const node = { id: "deploy", payload: { stage: "deploy" } } as unknown as ConductorNode;
  const stub = (app: (req: Req) => Spec) => {
    const f = mkFetch(app, fetchLog);
    vi.stubGlobal("fetch", (url: string, init: Parameters<FetchLike>[1]) => f(url, init));
  };

  beforeEach(() => {
    delete process.env.BUILD_ACCEPTANCE_GATE_MODE;
    setting.value = true;
    setting.booking = false;
    claims.rows = [];
    logged.length = 0;
    fetchLog.length = 0;
    siteDb.calls = [];
    siteDb.fail = null;
    siteDb.events = [];
    stub(authApp());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (ORIG === undefined) delete process.env.BUILD_ACCEPTANCE_GATE_MODE;
    else process.env.BUILD_ACCEPTANCE_GATE_MODE = ORIG;
  });

  it("first build: one throwaway signup for the run even across re-probes and overlapping ticks", async () => {
    const first = await acceptanceProbe({ tenant_id: "t1", conductor_run_id: "run-7", node });
    expect(first.pass).toBe(true);
    await Promise.all([
      acceptanceProbe({ tenant_id: "t1", conductor_run_id: "run-7", node: { ...node, acceptance_attempts: 1 } as ConductorNode }),
      acceptanceProbe({ tenant_id: "t1", conductor_run_id: "run-7", node }),
    ]);
    const posts = smokeSignups(fetchLog);
    expect(posts).toHaveLength(1);
    expect(new URLSearchParams(posts[0].body).get("email")).toBe("zavi-smoke-run-7@zavi.invalid");
    expect(new URLSearchParams(posts[0].body).get("password")).toMatch(/^Aa1!.{32}$/);
    expect(claims.rows).toEqual([{ conductor_run_id: "run-7", dedup_key: "acceptance:owner_login" }]);
  });

  it("an /admin that 500s with the new session fails the gate with an OWNER_LOGIN repair signal", async () => {
    stub(authApp({ admin: (c) => (c ? { status: 500 } : { status: 307, headers: { location: "/login" } }) }));
    const out = await acceptanceProbe({ tenant_id: "t1", conductor_run_id: "run-8", node });
    expect(out.mode).toBe("enforce");
    expect(out.pass).toBe(false);
    expect(out.signal).toMatch(/^OWNER_LOGIN: POST \/api\/signup -> 303 \(\/\) \+cookie; GET \/admin with that session -> 500/);
  });

  it("deletes the throwaway user from this tenant's site database after the check, pass or fail", async () => {
    stub((req) => {
      if (req.method === "POST" && (req.body ?? "").includes("zavi-smoke-run-12")) siteDb.events.push("signup");
      return authApp({ admin: (c) => (c ? { status: 500 } : { status: 307, headers: { location: "/login" } }) })(req);
    });
    const out = await acceptanceProbe({ tenant_id: "t-acme", conductor_run_id: "run-12", node });
    expect(out.pass).toBe(false);
    expect(out.signal).toMatch(/^OWNER_LOGIN: /);
    expect(siteDb.calls).toEqual([
      { tenant: "t-acme", sql: "DELETE FROM public.users WHERE email = $1", params: ["zavi-smoke-run-12@zavi.invalid"] },
    ]);
    expect(siteDb.events).toEqual(["signup", "delete"]);
    await acceptanceProbe({ tenant_id: "t-acme", conductor_run_id: "run-12", node });
    expect(siteDb.calls).toHaveLength(1);
  });

  it("a cleanup that cannot reach the site database is logged and never changes the verdict", async () => {
    siteDb.fail = Object.assign(new Error("no db"), { code: "app_db_not_ready" });
    const out = await acceptanceProbe({ tenant_id: "t1", conductor_run_id: "run-13", node });
    expect(out).toEqual({ mode: "enforce", pass: true, signal: "" });
    expect(logged.map((e) => e.code)).toEqual([
      "acceptance.owner_login.cleanup_failed",
      "acceptance.auth_probe.cleanup_failed",
      "acceptance.enforce.pass",
    ]);
    expect(logged[0]).toMatchObject({ tenant_id: "t1", run_id: "run-13" });
  });

  it("a refine never signs up a throwaway user, whether flagged by the conductor or by pre_refine_sha", async () => {
    await acceptanceProbe({ tenant_id: "t1", conductor_run_id: "run-9", node, refine: true });
    await acceptanceProbe({
      tenant_id: "t1",
      conductor_run_id: "run-10",
      node: { ...node, payload: { stage: "deploy", pre_refine_sha: "abc" } } as unknown as ConductorNode,
    });
    expect(smokeSignups(fetchLog)).toEqual([]);
    expect(claims.rows).toEqual([]);
  });

  it("build_smoke_gate off: no owner-login check even in env enforce mode", async () => {
    setting.value = false;
    process.env.BUILD_ACCEPTANCE_GATE_MODE = "enforce";
    stub(authApp({ admin: (c) => (c ? { status: 500 } : { status: 307, headers: { location: "/login" } }) }));
    await acceptanceProbe({ tenant_id: "t1", conductor_run_id: "run-11", node });
    expect(smokeSignups(fetchLog)).toEqual([]);
    expect(claims.rows).toEqual([]);
  });

  it("build_booking_smoke is on by default and its description names first build only, the tag and the cleanup", () => {
    const entry = APP_SETTINGS.build_booking_smoke;
    expect(entry.defaultValue).toBe(true);
    expect(entry.description).toContain("first product build only (never a refine)");
    expect(entry.description).toContain("'Zavi smoke test'");
    expect(entry.description).toContain("deleted when the site allows it");
  });
});
