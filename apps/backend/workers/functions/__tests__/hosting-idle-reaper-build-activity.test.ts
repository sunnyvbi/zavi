import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  failTable: null as string | null,
}));
const handler = vi.hoisted(() => ({ fn: null as null | ((ctx: unknown) => Promise<unknown>) }));

vi.mock("../../client", () => ({
  inngest: {
    createFunction: (_cfg: unknown, _trigger: unknown, fn: (ctx: unknown) => Promise<unknown>) => {
      handler.fn = fn;
      return fn;
    },
  },
}));

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      let limit = Infinity;
      let orderCol: string | null = null;
      let ascending = true;
      const q = {
        select: () => q,
        eq: (col: string, val: unknown) => {
          filters.push((r) => r[col] === val);
          return q;
        },
        in: (col: string, vals: unknown[]) => {
          filters.push((r) => vals.includes(r[col]));
          return q;
        },
        order: (col: string, opts?: { ascending?: boolean }) => {
          orderCol = col;
          ascending = opts?.ascending ?? true;
          return q;
        },
        limit: (n: number) => {
          limit = n;
          return q;
        },
        then: (resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown) => {
          if (db.failTable === table) return resolve({ data: null, error: { message: "boom" } });
          let rows = (db.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
          if (orderCol) {
            const c = orderCol;
            rows = [...rows].sort((a, b) => {
              const d = new Date(String(a[c])).getTime() - new Date(String(b[c])).getTime();
              return ascending ? d : -d;
            });
          }
          return resolve({ data: rows.slice(0, limit), error: null });
        },
      };
      return q;
    },
  }),
}));

import "../hosting-idle-reaper";

const SERVICE = "srv-build-only";
const TENANT = "tenant-build-only";
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const calls: Array<{ url: string; method: string }> = [];
let renderState: { suspended: string; suspenders: string[] };

beforeEach(() => {
  process.env.RENDER_API_KEY = "test-key";
  calls.length = 0;
  db.failTable = null;
  renderState = { suspended: "not_suspended", suspenders: [] };
  db.tables = {
    tenant_resources: [
      {
        tenant_id: TENANT,
        resource_kind: "hosting",
        provider: "render",
        status: "ready",
        external_ref: { render_service_id: SERVICE },
      },
    ],
    agent_runs: [
      { tenant_id: TENANT, trigger: "a2a", enqueued_at: daysAgo(1) },
      { tenant_id: TENANT, trigger: "cron", enqueued_at: daysAgo(0.1) },
    ],
    conductor_runs: [
      { tenant_id: TENANT, kind: "build_app", created_at: daysAgo(40) },
      { tenant_id: TENANT, kind: "build_app", created_at: daysAgo(1) },
    ],
    tenant_custom_domains: [],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string }) => {
      calls.push({ url, method: init?.method ?? "GET" });
      if ((init?.method ?? "GET") === "GET") {
        return new Response(
          JSON.stringify({ ...renderState, serviceDetails: { plan: "starter" } }),
          { status: 200 },
        );
      }
      return new Response(null, { status: 202 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const posts = () => calls.filter((c) => c.method === "POST").map((c) => c.url);

describe("hosting-idle-reaper counts Build and refine activity as human", () => {
  it("does not suspend a paid site whose owner only uses Build and refined it yesterday", async () => {
    const out = await handler.fn!({ logger });
    expect(posts()).toEqual([]);
    expect(out).toMatchObject({ considered: 1, suspended: 0 });
  });

  it("resumes a suspended site once the owner refines it through Build", async () => {
    renderState = { suspended: "suspended", suspenders: ["user"] };
    const out = await handler.fn!({ logger });
    expect(posts()).toEqual([`https://api.render.com/v1/services/${SERVICE}/resume`]);
    expect(out).toMatchObject({ resumed: 1, suspended: 0 });
  });

  it("still suspends a paid site whose last build is older than the idle window", async () => {
    db.tables.conductor_runs = [{ tenant_id: TENANT, kind: "build_app", created_at: daysAgo(40) }];
    const out = await handler.fn!({ logger });
    expect(posts()).toEqual([`https://api.render.com/v1/services/${SERVICE}/suspend`]);
    expect(out).toMatchObject({ suspended: 1 });
  });

  it("does not treat a recent company_goal conductor as human activity", async () => {
    db.tables.conductor_runs = [{ tenant_id: TENANT, kind: "company_goal", created_at: daysAgo(1) }];
    await handler.fn!({ logger });
    expect(posts()).toEqual([`https://api.render.com/v1/services/${SERVICE}/suspend`]);
  });

  it("leaves the site alone when the build activity read fails", async () => {
    db.failTable = "conductor_runs";
    db.tables.agent_runs = [];
    const out = await handler.fn!({ logger });
    expect(posts()).toEqual([]);
    expect(out).toMatchObject({ considered: 0, suspended: 0 });
  });
});
