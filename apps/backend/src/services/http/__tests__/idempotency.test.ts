
import express, { type Express } from "express";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TENANT_A = "73db45ff-457e-4541-bc8f-bdb625390204";
const TENANT_B = "e0fe9ea8-1111-4222-8333-444455556666";

const h = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const rows: Row[] = [];
  const state = { failInsert: false, settleFailures: 0, settleCalls: 0, settleDelayMs: 0 };

  function matches(r: Row, tenant: string, filters: Array<[string, unknown]>): boolean {
    if (r.tenant_id !== tenant) return false;
    return filters.every(([c, v]) => r[c] === v);
  }

  function table(name: string, tenant: string) {
    if (name !== "request_idempotency") throw new Error(`unexpected table ${name}`);
    return {
      insert(row: Row) {
        const stamped: Row = { created_at: new Date().toISOString(), ...row, tenant_id: tenant };
        if (state.failInsert) return Promise.resolve({ error: { code: "XX000", message: "db down" } });
        const dup = rows.some(
          (r) =>
            r.tenant_id === tenant &&
            r.user_id === stamped.user_id &&
            r.route === stamped.route &&
            r.idem_key === stamped.idem_key,
        );
        if (dup) return Promise.resolve({ error: { code: "23505", message: "duplicate key" } });
        rows.push(stamped);
        return Promise.resolve({ error: null });
      },
      select(_cols: string) {
        const filters: Array<[string, unknown]> = [];
        const b = {
          eq(c: string, v: unknown) {
            filters.push([c, v]);
            return b;
          },
          maybeSingle() {
            const hit = rows.find((r) => matches(r, tenant, filters)) ?? null;
            return Promise.resolve({ data: hit ? { ...hit } : null, error: null });
          },
        };
        return b;
      },
      update(values: Row) {
        const filters: Array<[string, unknown]> = [];
        const b = {
          eq(c: string, v: unknown) {
            filters.push([c, v]);
            return b;
          },
          select(_cols: string) {
            const hit = rows.filter((r) => matches(r, tenant, filters));
            for (const r of hit) Object.assign(r, values);
            return Promise.resolve({ data: hit.map((r) => ({ ...r })), error: null });
          },
          then(res: (v: unknown) => void) {
            state.settleCalls++;
            const run = () => {
              if (state.settleFailures > 0) {
                state.settleFailures--;
                res({ error: { message: "transient" } });
                return;
              }
              for (const r of rows) if (matches(r, tenant, filters)) Object.assign(r, values);
              res({ error: null });
            };
            if (state.settleDelayMs > 0) setTimeout(run, state.settleDelayMs);
            else run();
          },
        };
        return b;
      },
      delete() {
        const filters: Array<[string, unknown]> = [];
        const b = {
          eq(c: string, v: unknown) {
            filters.push([c, v]);
            return b;
          },
          then(res: (v: unknown) => void) {
            for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i], tenant, filters)) rows.splice(i, 1);
            res({ error: null });
          },
        };
        return b;
      },
    };
  }
  return { rows, state, table };
});

vi.mock("@/services/tenant-client", () => ({
  tenantClient: (tid: string) => ({ from: (t: string) => h.table(t, tid) }),
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async (req: express.Request, res: express.Response) => {
    const t = req.headers["x-test-tenant"];
    if (typeof t !== "string") {
      res.status(401).json({ error: { code: "unauthenticated" } });
      return null;
    }
    const u = req.headers["x-test-user"];
    req.auth = { user_id: typeof u === "string" ? u : "u1", tenant_id: t, access_token: "tok" } as never;
    return req.auth;
  },
}));

import {
  mountIdempotency,
  idempotency,
  STALE_MS,
  SETTLE_HOLD_MS,
  _setSettleHoldMsForTests,
  _setStaleResolversForTests,
  idempotencyFor,
} from "../idempotency";
import type { StaleResolver } from "../stale-resolvers";
import { IDEMPOTENT_ROUTES } from "@/services/http/idempotent-routes";
import { SITE_DIRECT_CHANGE_LEASE_TTL_S } from "@/services/sites/site-preview-lease";

const calls = new Map<string, number>();
const fenced: { n: number; gate: Promise<void>; open: () => void } = { n: 0, gate: Promise.resolve(), open: () => undefined };
let server: Server;
let base = "";

function concrete(path: string): string {
  return path.replace(/:[A-Za-z_]+/g, "abc-123");
}

beforeAll(async () => {
  const app: Express = express();
  app.use(express.json());
  mountIdempotency(app);
  for (const r of IDEMPOTENT_ROUTES) {
    if (r.auth === "pre_resolved") {
      app[r.method](r.path, (req, res, next) => {
        const tenant = req.headers["x-test-tenant"];
        if (typeof tenant !== "string") {
          res.status(401).json({ error: { code: "unauthenticated" } });
          return;
        }
        const user = req.headers["x-test-user"];
        req.idempotencyScope = { tenant_id: tenant as never, user_id: typeof user === "string" ? user : "u1" };
        next();
      }, idempotencyFor(r.path, r.staleMs));
    }
    app[r.method](r.path, (req, res) => {
      const k = `${req.headers["x-test-tenant"] ?? "-"} ${r.method} ${r.path}`;
      const who = `${req.headers["x-test-tenant"] ?? "-"}/${req.headers["x-test-user"] ?? "u1"}`;
      calls.set(`${who} ${r.method} ${r.path}`, (calls.get(`${who} ${r.method} ${r.path}`) ?? 0) + 1);
      const n = (calls.get(k) ?? 0) + 1;
      calls.set(k, n);
      res.status(202).json({
        ok: true,
        run_id: `run-${n}`,
        tenant: req.headers["x-test-tenant"],
        user: req.headers["x-test-user"] ?? "u1",
      });
    });
  }
  let plain = 0;
  app.post("/probe/plain", idempotency, (_req, res) => {
    plain++;
    res.status(200).end(`plain-${plain}`);
  });
  let boom = 0;
  app.post("/probe/boom", idempotency, (_req, res) => {
    boom++;
    res.status(500).json({ error: { code: "boom", n: boom } });
  });
  let released = 0;
  app.post("/probe/released", idempotency, (_req, res) => {
    released++;
    if (released === 1) {
      res.locals.idempotencyRelease = true;
      res.status(503).json({ error: { code: "product_builder_unavailable", n: released } });
      return;
    }
    res.status(200).json({ ok: true, n: released });
  });
  app.post("/probe/fenced", idempotencyFor("/probe/fenced"), async (_req, res) => {
    fenced.n++;
    const n = fenced.n;
    if (n === 1) await fenced.gate;
    res.status(200).json({ n });
  });
  let slow = 0;
  app.post("/probe/slow", idempotency, async (_req, res) => {
    slow++;
    await new Promise((r) => setTimeout(r, 400));
    res.status(200).json({ n: slow });
  });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
});

beforeEach(() => {
  h.rows.length = 0;
  h.state.failInsert = false;
  h.state.settleFailures = 0;
  h.state.settleCalls = 0;
  h.state.settleDelayMs = 0;
  _setSettleHoldMsForTests(null);
  _setStaleResolversForTests({});
  calls.clear();
});

async function send(
  method: string,
  path: string,
  opts: { key?: string; tenant?: string; user?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.key) headers["Idempotency-Key"] = opts.key;
  if (opts.tenant !== undefined) headers["x-test-tenant"] = opts.tenant;
  if (opts.user !== undefined) headers["x-test-user"] = opts.user;
  const res = await fetch(base + path, {
    method: method.toUpperCase(),
    headers,
    body: JSON.stringify(opts.body ?? { note: "x" }),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, replayed: res.headers.get("idempotent-replayed") };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

describe("IDEMPOTENT_ROUTES", () => {
  it("is not empty and every entry is a mutating method", () => {
    expect(IDEMPOTENT_ROUTES.length).toBeGreaterThan(0);
    for (const r of IDEMPOTENT_ROUTES) expect(["post", "put", "patch", "delete"]).toContain(r.method);
  });

  it("keeps a paid site edit claim alive longer than its direct-change lease", () => {
    const route = IDEMPOTENT_ROUTES.find((r) => r.path === "/api/website/site-design-edit");
    expect(route?.staleMs).toBeGreaterThan(SITE_DIRECT_CHANGE_LEASE_TTL_S * 1000);
  });
});

describe.each(IDEMPOTENT_ROUTES.map((r) => [`${r.method.toUpperCase()} ${r.path}`, r] as const))(
  "%s",
  (_label, r) => {
    const path = concrete(r.path);
    const workKey = (tenant: string) => `${tenant} ${r.method} ${r.path}`;

    it("same key twice: the work runs once and the replay returns the first result", async () => {
      const first = await send(r.method, path, { key: "key-aaaaaaaa", tenant: TENANT_A });
      await tick();
      const second = await send(r.method, path, { key: "key-aaaaaaaa", tenant: TENANT_A });
      expect(calls.get(workKey(TENANT_A))).toBe(1);
      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
      expect(second.json).toEqual(first.json);
      expect(second.replayed).toBe("true");
    });

    it("different keys: two actions", async () => {
      await send(r.method, path, { key: "key-aaaaaaaa", tenant: TENANT_A });
      await send(r.method, path, { key: "key-bbbbbbbb", tenant: TENANT_A });
      expect(calls.get(workKey(TENANT_A))).toBe(2);
    });

    it("no key: behaves as today (every request runs, nothing stored)", async () => {
      await send(r.method, path, { tenant: TENANT_A });
      await send(r.method, path, { tenant: TENANT_A });
      expect(calls.get(workKey(TENANT_A))).toBe(2);
      expect(h.rows).toHaveLength(0);
    });

    it("cross-tenant: the same key from another tenant runs for that tenant and never returns this tenant's result", async () => {
      const a = await send(r.method, path, { key: "key-shared01", tenant: TENANT_A });
      await tick();
      const b = await send(r.method, path, { key: "key-shared01", tenant: TENANT_B });
      expect(calls.get(workKey(TENANT_A))).toBe(1);
      expect(calls.get(workKey(TENANT_B))).toBe(1);
      expect(b.replayed).toBeNull();
      expect((b.json as { tenant: string }).tenant).toBe(TENANT_B);
      expect((a.json as { tenant: string }).tenant).toBe(TENANT_A);
    });

    it("same tenant, different user: the handler runs for them and the first user's body is never replayed", async () => {
      const admin = await send(r.method, path, { key: "key-samet001", tenant: TENANT_A, user: "admin-1" });
      await tick();
      const member = await send(r.method, path, { key: "key-samet001", tenant: TENANT_A, user: "member-2" });
      expect(calls.get(`${TENANT_A}/admin-1 ${r.method} ${r.path}`)).toBe(1);
      expect(calls.get(`${TENANT_A}/member-2 ${r.method} ${r.path}`)).toBe(1);
      expect(member.replayed).toBeNull();
      expect((member.json as { user: string }).user).toBe("member-2");
      expect((admin.json as { user: string }).user).toBe("admin-1");
    });
  },
);

describe("idempotency middleware edges", () => {
  const route = IDEMPOTENT_ROUTES[0];
  const path = concrete(route.path);

  it("a key reused with a different body is refused (422), not replayed", async () => {
    await send(route.method, path, { key: "key-reuse001", tenant: TENANT_A, body: { note: "a" } });
    await tick();
    const second = await send(route.method, path, { key: "key-reuse001", tenant: TENANT_A, body: { note: "b" } });
    expect(second.status).toBe(422);
    expect((second.json as { error: { code: string } }).error.code).toBe("idempotency_key_reused");
  });

  it("the same key on a different action id is a different request", async () => {
    const withId = IDEMPOTENT_ROUTES.find((r) => r.path.includes(":"));
    if (!withId) return;
    const p1 = withId.path.replace(/:[A-Za-z_]+/g, "id-one");
    const p2 = withId.path.replace(/:[A-Za-z_]+/g, "id-two");
    await send(withId.method, p1, { key: "key-perid001", tenant: TENANT_A });
    await send(withId.method, p2, { key: "key-perid001", tenant: TENANT_A });
    expect(calls.get(`${TENANT_A} ${withId.method} ${withId.path}`)).toBe(2);
  });

  it("a malformed key is refused before any work", async () => {
    const res = await send(route.method, path, { key: "short", tenant: TENANT_A });
    expect(res.status).toBe(400);
    expect(calls.size).toBe(0);
  });

  it("no auth with a key: 401 and no claim", async () => {
    const res = await send(route.method, path, { key: "key-noauth01" });
    expect(res.status).toBe(401);
    expect(h.rows).toHaveLength(0);
    expect(calls.size).toBe(0);
  });

  it("store unavailable: fails closed (503) and does not run the work", async () => {
    h.state.failInsert = true;
    const res = await send(route.method, path, { key: "key-dbdown01", tenant: TENANT_A });
    expect(res.status).toBe(503);
    expect(calls.size).toBe(0);
  });

  it("a replay that arrives while the first is still running waits and returns the first result", async () => {
    const [a, b] = await Promise.all([
      send("post", "/probe/slow", { key: "key-slow0001", tenant: TENANT_A }),
      (async () => {
        await new Promise((r) => setTimeout(r, 100));
        return send("post", "/probe/slow", { key: "key-slow0001", tenant: TENANT_A });
      })(),
    ]);
    expect(a.json).toEqual({ n: 1 });
    expect(b.json).toEqual({ n: 1 });
    expect(b.replayed).toBe("true");
  });

  it("a non-JSON first response replays as 409 already_processed without re-running", async () => {
    const a = await send("post", "/probe/plain", { key: "key-plain001", tenant: TENANT_A });
    await tick();
    const b = await send("post", "/probe/plain", { key: "key-plain001", tenant: TENANT_A });
    expect(a.json).toBe("plain-1");
    expect(b.status).toBe(409);
    expect((b.json as { error: { code: string } }).error.code).toBe("already_processed");
  });

  it("a 5xx is stored, not released: a same-key retry replays the 500 and does NOT re-run the work", async () => {
    const a = await send("post", "/probe/boom", { key: "key-boom0001", tenant: TENANT_A });
    const b = await send("post", "/probe/boom", { key: "key-boom0001", tenant: TENANT_A });
    expect(a.status).toBe(500);
    expect(b.status).toBe(500);
    expect(b.json).toEqual(a.json);
    expect(b.replayed).toBe("true");
  });

  it("a refusal that did no work RELEASES the claim: the same key retries and runs", async () => {
    const a = await send("post", "/probe/released", { key: "key-release1", tenant: TENANT_A });
    expect(a.status).toBe(503);
    await tick();
    expect(h.rows.find((r) => r.idem_key === "key-release1")).toBeUndefined();
    const b = await send("post", "/probe/released", { key: "key-release1", tenant: TENANT_A });
    expect(b.status).toBe(200);
    expect(b.replayed).toBeNull();
    expect((b.json as { n: number }).n).toBe(2);
    const c = await send("post", "/probe/released", { key: "key-release1", tenant: TENANT_A });
    expect(c.replayed).toBe("true");
    expect(c.json).toEqual(b.json);
  });

  it("after a 5xx, a NEW key (the founder pressing again) runs the work again", async () => {
    const a = await send("post", "/probe/boom", { key: "key-boomA001", tenant: TENANT_A });
    const b = await send("post", "/probe/boom", { key: "key-boomB001", tenant: TENANT_A });
    expect((b.json as { error: { n: number } }).error.n).toBe((a.json as { error: { n: number } }).error.n + 1);
    expect(b.replayed).toBeNull();
  });

  it("the outcome is written BEFORE the response is released (no settle-after-send window)", async () => {
    h.state.settleDelayMs = 150;
    const res = await send(route.method, path, { key: "key-order001", tenant: TENANT_A });
    expect(res.status).toBe(202);
    const row = h.rows.find((r) => r.idem_key === "key-order001");
    expect(row?.status).toBe("done");
    expect(row?.response_status).toBe(202);
  });

  it("the hold deadline is short (5s), far under the proxy's 120s read timeout", () => {
    expect(SETTLE_HOLD_MS).toBe(5000);
  });

  it("a settle slower than the hold deadline releases the response at the deadline, and the row settles afterwards", async () => {
    _setSettleHoldMsForTests(200);
    h.state.settleDelayMs = 1000;
    const started = Date.now();
    const res = await send(route.method, path, { key: "key-slowst01", tenant: TENANT_A });
    const took = Date.now() - started;
    expect(res.status).toBe(202);
    expect(took).toBeGreaterThanOrEqual(150);
    expect(took).toBeLessThan(900);
    expect(h.rows.find((r) => r.idem_key === "key-slowst01")?.status).toBe("in_progress");
    await new Promise((r) => setTimeout(r, 1200));
    expect(h.rows.find((r) => r.idem_key === "key-slowst01")?.status).toBe("done");
    const b = await send(route.method, path, { key: "key-slowst01", tenant: TENANT_A });
    expect(b.replayed).toBe("true");
    expect(calls.get(`${TENANT_A} ${route.method} ${route.path}`)).toBe(1);
  });

  it("a transient settle-write error is retried before the response goes out", async () => {
    h.state.settleFailures = 1;
    const res = await send(route.method, path, { key: "key-retry001", tenant: TENANT_A });
    expect(res.status).toBe(202);
    expect(h.state.settleCalls).toBe(2);
    expect(h.rows.find((r) => r.idem_key === "key-retry001")?.status).toBe("done");
  });

  it("a settle that never lands still answers the caller; a later replay is refused, never re-run", async () => {
    h.state.settleFailures = 99;
    const a = await send(route.method, path, { key: "key-nosett01", tenant: TENANT_A });
    expect(a.status).toBe(202);
    h.state.settleFailures = 0;
    const row = h.rows.find((r) => r.idem_key === "key-nosett01")!;
    expect(row.status).toBe("in_progress");
    row.created_at = new Date(Date.now() - STALE_MS - 60_000).toISOString();
    const b = await send(route.method, path, { key: "key-nosett01", tenant: TENANT_A });
    expect(b.status).toBe(409);
    expect((b.json as { error: { code: string } }).error.code).toBe("idempotency_stale");
    expect(calls.get(`${TENANT_A} ${route.method} ${route.path}`)).toBe(1);
  });

  it("a stale in_progress claim (process died mid-request) answers 409 idempotency_stale at once and never re-runs", async () => {
    h.rows.push({
      tenant_id: TENANT_A,
      user_id: "u1",
      route: `${route.method.toUpperCase()} ${path}`,
      idem_key: "key-stale001",
      request_hash: createHash("sha256").update(JSON.stringify({ note: "x" })).digest("hex"),
      status: "in_progress",
      created_at: new Date(Date.now() - STALE_MS - 1000).toISOString(),
    });
    const started = Date.now();
    const res = await send(route.method, path, { key: "key-stale001", tenant: TENANT_A });
    expect(res.status).toBe(409);
    expect((res.json as { error: { code: string } }).error.code).toBe("idempotency_stale");
    expect((res.json as { error: { message: string } }).error.message).toMatch(/never finished/);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(calls.size).toBe(0);
  });

  it("a fresh in_progress claim is not stale: the replay waits, then answers idempotency_in_progress", async () => {
    h.rows.push({
      tenant_id: TENANT_A,
      user_id: "u1",
      route: `${route.method.toUpperCase()} ${path}`,
      idem_key: "key-fresh001",
      request_hash: createHash("sha256").update(JSON.stringify({ note: "x" })).digest("hex"),
      status: "in_progress",
      created_at: new Date().toISOString(),
    });
    const res = await send(route.method, path, { key: "key-fresh001", tenant: TENANT_A });
    expect(res.status).toBe(409);
    expect((res.json as { error: { code: string } }).error.code).toBe("idempotency_in_progress");
    expect(calls.size).toBe(0);
  }, 15_000);
});

describe("routes/index.ts wiring", () => {
  const src = readFileSync(join(__dirname, "..", "..", "..", "routes", "index.ts"), "utf8");
  const mountAt = src.indexOf("mountIdempotency(app)");
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

  it("calls mountIdempotency inside mountRoutes", () => {
    expect(mountAt).toBeGreaterThan(src.indexOf("export function mountRoutes"));
  });

  it("mounts Shopify identity before its route-local idempotency claim", () => {
    const authAt = src.indexOf("shopifyAppHomeBillingAuth", mountAt);
    const claimAt = src.indexOf('idempotencyFor("/api/shopify/app-home/billing")');
    const handlerAt = src.indexOf("shopifyAppHomeBilling,", claimAt);
    expect(authAt).toBeGreaterThan(mountAt);
    expect(claimAt).toBeGreaterThan(authAt);
    expect(handlerAt).toBeGreaterThan(claimAt);
  });

  it.each(IDEMPOTENT_ROUTES.map((r) => [`${r.method.toUpperCase()} ${r.path}`, r] as const))(
    "%s is registered after the idempotency mount",
    (_l, r) => {
      if (r.router) {
        const routerSrc = readFileSync(join(__dirname, "..", "..", "..", "routes", r.router.file), "utf8");
        expect(routerSrc).toMatch(new RegExp(`\\.${r.method}\\(\\s*"${esc(r.router.path)}"`));
        const appSrc = readFileSync(join(__dirname, "..", "..", "..", "app.ts"), "utf8");
        const prefix = r.path.slice(0, r.path.length - r.router.path.length);
        const useAt = appSrc.indexOf(`app.use("${prefix}"`);
        expect(useAt).toBeGreaterThan(appSrc.indexOf("mountRoutes(app)"));
        return;
      }
      const m = new RegExp(`app\\.${r.method}\\(\\s*"${esc(r.path)}"`).exec(src);
      expect(m, `no app.${r.method}("${r.path}" in routes/index.ts`).not.toBeNull();
      expect(m!.index).toBeGreaterThan(mountAt);
    },
  );
});

it("build start is registered for replaying a dropped response", () => {
  expect(IDEMPOTENT_ROUTES).toContainEqual({ method: "post", path: "/api/workspace/autopilot/build-product" });
});

describe("stale claim on a route with a resolver", () => {
  const route = IDEMPOTENT_ROUTES[0];
  const path = concrete(route.path);
  function stale(key: string) {
    h.rows.push({
      tenant_id: TENANT_A,
      user_id: "u1",
      route: `${route.method.toUpperCase()} ${path}`,
      idem_key: key,
      request_hash: createHash("sha256").update(JSON.stringify({ note: "x" })).digest("hex"),
      status: "in_progress",
      created_at: new Date(Date.now() - STALE_MS - 1000).toISOString(),
    });
  }

  it("is the build-product route", () => {
    expect(route.path).toBe("/api/workspace/autopilot/build-product");
  });

  it("found: replays the original build (the handler does not run) and settles the claim", async () => {
    const resolver: StaleResolver = vi.fn(async ({ key }) => ({ status: 200, body: { ok: true, conductor_run_id: `run-of-${key}` } }));
    _setStaleResolversForTests({ [route.path]: resolver });
    stale("key-stalefound");
    const res = await send(route.method, path, { key: "key-stalefound", tenant: TENANT_A });
    expect(res.status).toBe(200);
    expect(res.replayed).toBe("true");
    expect(res.json).toEqual({ ok: true, conductor_run_id: "run-of-key-stalefound" });
    expect(calls.size).toBe(0);
    await tick();
    expect(h.rows.find((r) => r.idem_key === "key-stalefound")).toMatchObject({ status: "done", response_status: 200 });
    expect(resolver).toHaveBeenCalledWith({ tenant_id: TENANT_A, user_id: "u1", key: "key-stalefound" });
  });

  it("provably not done: the SAME key takes the claim over and runs once; a second retry replays it", async () => {
    _setStaleResolversForTests({ [route.path]: async () => "not_found" });
    stale("key-stalenone");
    const a = await send(route.method, path, { key: "key-stalenone", tenant: TENANT_A });
    expect(a.status).toBe(202);
    expect(a.replayed).toBeNull();
    expect(calls.get(`${TENANT_A} ${route.method} ${route.path}`)).toBe(1);
    const b = await send(route.method, path, { key: "key-stalenone", tenant: TENANT_A });
    expect(b.replayed).toBe("true");
    expect(b.json).toEqual(a.json);
    expect(calls.get(`${TENANT_A} ${route.method} ${route.path}`)).toBe(1);
  });

  it("an unknown answer (resolver error) still refuses as idempotency_stale and never runs", async () => {
    _setStaleResolversForTests({
      [route.path]: async () => {
        throw new Error("db down");
      },
    });
    stale("key-staleerr1");
    const res = await send(route.method, path, { key: "key-staleerr1", tenant: TENANT_A });
    expect(res.status).toBe(409);
    expect((res.json as { error: { code: string } }).error.code).toBe("idempotency_stale");
    expect(calls.size).toBe(0);
  });

  it("a FRESH in-progress claim never consults the resolver", async () => {
    const resolver = vi.fn(async () => "not_found" as const);
    _setStaleResolversForTests({ [route.path]: resolver });
    h.rows.push({
      tenant_id: TENANT_A,
      user_id: "u1",
      route: `${route.method.toUpperCase()} ${path}`,
      idem_key: "key-freshres1",
      request_hash: createHash("sha256").update(JSON.stringify({ note: "x" })).digest("hex"),
      status: "in_progress",
      created_at: new Date().toISOString(),
    });
    const res = await send(route.method, path, { key: "key-freshres1", tenant: TENANT_A });
    expect((res.json as { error: { code: string } }).error.code).toBe("idempotency_in_progress");
    expect(resolver).not.toHaveBeenCalled();
    expect(calls.size).toBe(0);
  }, 15_000);
});

it("a slow original request whose claim was taken over can never overwrite the new owner's result", async () => {
  fenced.n = 0;
  fenced.gate = new Promise<void>((r) => (fenced.open = r));
  _setStaleResolversForTests({ "/probe/fenced": async () => "not_found" });
  const first = send("post", "/probe/fenced", { key: "key-fenced01", tenant: TENANT_A });
  await tick();
  const row = h.rows.find((r) => r.idem_key === "key-fenced01")!;
  row.created_at = new Date(Date.now() - STALE_MS - 1000).toISOString();
  const second = await send("post", "/probe/fenced", { key: "key-fenced01", tenant: TENANT_A });
  expect(second.json).toEqual({ n: 2 });
  await tick();
  fenced.open();
  expect((await first).json).toEqual({ n: 1 });
  await tick();
  expect(h.rows.find((r) => r.idem_key === "key-fenced01")).toMatchObject({ status: "done", response_body: { n: 2 } });
});
