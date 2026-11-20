import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({ tables: {} as Record<string, Row[]> }));
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
        order: () => q,
        limit: (n: number) => {
          limit = n;
          return q;
        },
        then: (resolve: (v: { data: Row[]; error: null }) => unknown) =>
          resolve({
            data: (db.tables[table] ?? []).filter((r) => filters.every((f) => f(r))).slice(0, limit),
            error: null,
          }),
      };
      return q;
    },
  }),
}));

import "../hosting-idle-reaper";

const SERVICE = "srv-own-domain";
const TENANT = "tenant-own-domain";
const calls: Array<{ url: string; method: string }> = [];

beforeEach(() => {
  process.env.RENDER_API_KEY = "test-key";
  calls.length = 0;
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
      { tenant_id: TENANT, trigger: "chat", enqueued_at: new Date(Date.now() - 40 * 86_400_000).toISOString() },
    ],
    tenant_custom_domains: [
      { render_service_id: SERVICE, hostname: "app.acme.com", status: "verified" },
    ],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string }) => {
      calls.push({ url, method: init?.method ?? "GET" });
      if ((init?.method ?? "GET") === "GET") {
        return new Response(
          JSON.stringify({ suspended: "not_suspended", suspenders: [], serviceDetails: { plan: "starter" } }),
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

describe("hosting-idle-reaper own-domain exemption", () => {
  it("never suspends an idle paid service whose custom domain is verified", async () => {
    const out = await handler.fn!({ logger });
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    expect(out).toMatchObject({ considered: 1, suspended: 0, skipped: 1 });
  });

  it("still suspends the same idle service when its custom domain never verified", async () => {
    db.tables.tenant_custom_domains = [
      { render_service_id: SERVICE, hostname: "app.acme.com", status: "dns_required" },
    ];
    const out = await handler.fn!({ logger });
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([
      `https://api.render.com/v1/services/${SERVICE}/suspend`,
    ]);
    expect(out).toMatchObject({ considered: 1, suspended: 1 });
  });
});
