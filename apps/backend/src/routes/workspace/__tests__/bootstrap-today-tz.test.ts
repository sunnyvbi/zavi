
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const FROZEN = new Date("2026-09-07T01:30:00.000Z");

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  getTenantDisabledSlugs: vi.fn(),
  annotateLockedTier: vi.fn(),
  listAgents: vi.fn(),
  tenantTimezone: { value: null as string | null },
  runRows: { value: [] as Array<{ cost_usd: number | null; started_at: string }> },
  breakTenantsRead: { value: false },
  gteCalls: [] as Array<{ table: string; col: string; val: unknown }>,
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/agents/visibility", () => ({
  getTenantDisabledSlugs: mocks.getTenantDisabledSlugs,
}));
vi.mock("@/services/agents/entitlement", () => ({
  annotateLockedTier: mocks.annotateLockedTier,
}));
vi.mock("@/services/agents/registry", () => ({ listAgents: mocks.listAgents }));
vi.mock("@/services/agents/thread-counts", () => ({
  countThreadsBySlug: async () => ({}),
}));
vi.mock("@/services/workspace/scrubThreadBindings", () => ({
  scrubForeignThreadBindings: async (tabs: unknown[]) => tabs,
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: async () => {} }));

function makeBuilder(table: string) {
  const b: Record<string, unknown> = {};
  const chain = () => b;
  b.select = chain;
  b.eq = chain;
  b.lte = chain;
  b.in = chain;
  b.is = chain;
  b.neq = chain;
  b.order = chain;
  b.limit = chain;
  b.gte = (col: string, val: unknown) => {
    mocks.gteCalls.push({ table, col, val });
    return b;
  };
  if (!(table === "tenants" && mocks.breakTenantsRead.value)) {
    b.maybeSingle = async () => ({
      data: table === "tenants" ? { timezone: mocks.tenantTimezone.value } : null,
      error: null,
    });
  }
  b.then = (resolve: (v: unknown) => unknown) =>
    resolve({
      data: table === "agent_runs" ? mocks.runRows.value : [],
      count: 0,
      error: null,
    });
  return b;
}

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    from: (t: string) => makeBuilder(t),
    rpc: async () => ({ data: null, error: null }),
  }),
}));

import { workspaceBootstrap } from "../bootstrap";

function mockRes() {
  const res: Record<string, unknown> = {};
  res.statusCode = 200;
  res.status = vi.fn((c: number) => {
    res.statusCode = c;
    return res;
  });
  res.json = vi.fn((b: unknown) => {
    res.body = b;
    return res;
  });
  return res as unknown as import("express").Response & {
    statusCode: number;
    body: { status_counters: { cost_today_usd: number } };
  };
}

const req = {
  body: {},
  headers: { authorization: "Bearer tok" },
} as unknown as import("express").Request;

async function costToday(): Promise<number> {
  const res = mockRes();
  await workspaceBootstrap(req, res);
  expect(res.statusCode).toBe(200);
  return res.body.status_counters.cost_today_usd;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FROZEN);
  mocks.gteCalls.length = 0;
  mocks.tenantTimezone.value = null;
  mocks.runRows.value = [];
  mocks.breakTenantsRead.value = false;
  mocks.requireAuth.mockResolvedValue({
    user_id: "u1",
    tenant_id: "t-1",
    access_token: "tok",
  });
  mocks.getTenantDisabledSlugs.mockResolvedValue(new Set<string>());
  mocks.listAgents.mockReturnValue([]);
  mocks.annotateLockedTier.mockImplementation(async (a: Array<Record<string, unknown>>) =>
    a.map((x) => ({ ...x, locked_tier: null })),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe('workspace/bootstrap — "cost today" uses the tenant timezone', () => {
  const MORNING = "2026-09-06T16:00:00+00:00";
  const YESTERDAY = "2026-09-06T06:00:00+00:00";

  it("counts this morning's run that UTC midnight would have excluded", async () => {
    mocks.tenantTimezone.value = "America/Los_Angeles";
    mocks.runRows.value = [{ cost_usd: 4.25, started_at: MORNING }];
    expect(await costToday()).toBe(4.25);
    expect(Date.parse(MORNING)).toBeLessThan(Date.parse("2026-09-07T00:00:00Z"));
  });

  it("still excludes the previous local day", async () => {
    mocks.tenantTimezone.value = "America/Los_Angeles";
    mocks.runRows.value = [
      { cost_usd: 4.25, started_at: MORNING },
      { cost_usd: 99, started_at: YESTERDAY },
    ];
    expect(await costToday()).toBe(4.25);
  });

  it("the widened query is a SUPERSET, never the tenant-day boundary itself", async () => {
    mocks.tenantTimezone.value = "America/Los_Angeles";
    await costToday();
    const floor = mocks.gteCalls.find(
      (c) => c.table === "agent_runs" && c.col === "started_at",
    );
    expect(floor).toBeTruthy();
    const floorMs = Date.parse(String(floor!.val));
    expect(floorMs).toBeLessThanOrEqual(Date.parse("2026-09-06T07:00:00.000Z"));
    expect(FROZEN.getTime() - floorMs).toBeGreaterThanOrEqual(26 * 3600 * 1000);
    expect(FROZEN.getTime() - floorMs).toBeLessThanOrEqual(72 * 3600 * 1000);
  });

  it("a UTC-11 tenant's day is narrower than the 48h window it fetched", async () => {
    mocks.tenantTimezone.value = "Pacific/Niue";
    mocks.runRows.value = [
      { cost_usd: 7, started_at: "2026-09-06T12:00:00+00:00" },
      { cost_usd: 5, started_at: "2026-09-06T10:00:00+00:00" },
    ];
    expect(await costToday()).toBe(7);
  });

  it("no timezone → the old UTC boundary, and the route still answers", async () => {
    mocks.tenantTimezone.value = null;
    mocks.runRows.value = [
      { cost_usd: 3, started_at: "2026-09-07T01:00:00+00:00" },
      { cost_usd: 9, started_at: MORNING },
    ];
    expect(await costToday()).toBe(3);
  });

  it("a tenants read that throws while BUILDING the query degrades to UTC, never a 500", async () => {
    mocks.breakTenantsRead.value = true;
    mocks.tenantTimezone.value = "America/Los_Angeles";
    mocks.runRows.value = [
      { cost_usd: 3, started_at: "2026-09-07T01:00:00+00:00" },
      { cost_usd: 9, started_at: MORNING },
    ];
    expect(await costToday()).toBe(3);
  });

  it("a row with a null/garbage started_at is skipped, not counted or thrown on", async () => {
    mocks.tenantTimezone.value = "America/Los_Angeles";
    mocks.runRows.value = [
      { cost_usd: 4.25, started_at: MORNING },
      { cost_usd: 50, started_at: null as unknown as string },
      { cost_usd: 50, started_at: "not-a-date" },
    ];
    expect(await costToday()).toBe(4.25);
  });
});
