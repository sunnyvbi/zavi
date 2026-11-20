import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

let authResult: { user_id: string; tenant_id: string; access_token: string } | null;
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async (_req: Request, res: Response) => {
    if (authResult) return authResult;
    res.status(401).json({ error: { code: "unauthenticated" } });
    return null;
  }),
}));
vi.mock("@/services/auth/tenant-role", () => ({ loadTenantRole: vi.fn(), requireTenantRole: vi.fn() }));
vi.mock("@/services/agents/entitlement", () => ({ loadTierGateConfig: vi.fn(), resolveTenantTier: vi.fn() }));
vi.mock("@/services/tenant-client", () => ({ asTenantId: (t: string) => t, tenantRpc: vi.fn() }));
vi.mock("@/services/decisions/ad-changes", () => ({ stageUndo: vi.fn() }));
vi.mock("@/services/growth/spend-pace", () => ({ loadLiveForecast: vi.fn() }));

const budgetReads: string[] = [];
vi.mock("@/services/decisions/ad-budget-setup", () => ({
  parseBudgetInput: vi.fn(),
  parseHumanAction: vi.fn(),
  readAdBudgetLedger: vi.fn(),
  stopAdBudget: vi.fn(),
  utcToday: () => "2026-10-31",
  readAdBudgetView: vi.fn(async (tenant: string) => {
    budgetReads.push(tenant);
    return { id: "bud-1", status: "active", month_cap_usd: 28400, monthly_usd: 28400, spent_usd: 600, month_start: "2026-10-01" };
  }),
}));

const spendReads: Array<{ tenant: string; since: string }> = [];
const snapshotReads: Array<{ token: string; tenant: string }> = [];
let spendFails = false;
const failureReads: Array<{ tenant: string; budgetId: string | null }> = [];
vi.mock("@/services/growth/ad-money-table", async (orig) => {
  const real = await orig<typeof import("@/services/growth/ad-money-table")>();
  return {
    ...real,
    readSpendRows: vi.fn(async (tenant: string, since: string) => {
      spendReads.push({ tenant, since });
      if (spendFails) throw new Error("db down");
      return tenant === TENANT
        ? [
            { platform: "meta", spend_date: "2026-10-30", amount_usd: "500.00", account_id: "a", object_id: "o", provisional: false },
            { platform: "reddit", spend_date: "2026-10-29", amount_usd: "100.00", account_id: "a", object_id: "r", provisional: false },
          ]
        : [{ platform: "meta", spend_date: "2026-10-30", amount_usd: "99999.00" }];
    }),
    readSpendReadFailures: vi.fn(async (tenant: string, budgetId: string | null) => {
      failureReads.push({ tenant, budgetId });
      return [];
    }),
    readResultsSnapshot: vi.fn(async (token: string, tenant: string) => {
      snapshotReads.push({ token, tenant });
      return {
        fetched_at: "2026-10-30T06:15:05.000Z",
        series: { meta: { points: [{ date: "2026-10-28", bookings: 10, spend_usd: 400 }] } },
      };
    }),
  };
});

import { getAdBudgetChannels } from "../ad-budget";

function mockRes() {
  const res: Record<string, unknown> = { statusCode: 200, body: null };
  res.status = vi.fn((c: number) => {
    res.statusCode = c;
    return res;
  });
  res.json = vi.fn((b: unknown) => {
    res.body = b;
    return res;
  });
  return res as unknown as Response & { statusCode: number; body: any };
}

beforeEach(() => {
  authResult = { user_id: "u1", tenant_id: TENANT, access_token: "tok-1" };
  budgetReads.length = 0;
  spendReads.length = 0;
  snapshotReads.length = 0;
  failureReads.length = 0;
  spendFails = false;
});

describe("getAdBudgetChannels", () => {
  it("401s without a session and reads nothing", async () => {
    authResult = null;
    const res = mockRes();
    await getAdBudgetChannels({ query: {}, headers: {} } as unknown as Request, res);
    expect(res.statusCode).toBe(401);
    expect(spendReads).toEqual([]);
    expect(snapshotReads).toEqual([]);
  });

  it("reads the session's tenant only, whatever the request names", async () => {
    const res = mockRes();
    const req = { query: { tenant_id: OTHER }, body: { tenant_id: OTHER }, headers: { "x-tenant-id": OTHER } } as unknown as Request;
    await getAdBudgetChannels(req, res);
    expect(res.statusCode).toBe(200);
    expect(budgetReads).toEqual([TENANT]);
    expect(spendReads).toEqual([{ tenant: TENANT, since: "2026-10-01" }]);
    expect(snapshotReads).toEqual([{ token: "tok-1", tenant: TENANT }]);
    expect(failureReads).toEqual([{ tenant: TENANT, budgetId: "bud-1" }]);
    expect(res.body.total.spent_usd).toBe(600);
  });

  it("answers the table: rows, results for Meta, spend only for Reddit, the budget", async () => {
    const res = mockRes();
    await getAdBudgetChannels({ query: {}, headers: {} } as unknown as Request, res);
    const body = res.body;
    expect(body.month_start).toBe("2026-10-01");
    expect(body.rows.map((r: { platform: string }) => r.platform)).toEqual(["meta", "reddit"]);
    expect(body.rows[0]).toMatchObject({ name: "Meta Ads", spent_usd: 500, share: 0.833, results_status: "platform", results: { count: 10, cost_each_usd: 40, source: "Meta's own count" } });
    expect(body.rows[1]).toMatchObject({ name: "Reddit Ads", results: null, results_status: "not_synced" });
    expect(body.budget).toEqual({ status: "active", month_cap_usd: 28400, monthly_usd: 28400, spent_usd: 600 });
  });

  it("503s with a plain message when spend cannot be read", async () => {
    spendFails = true;
    const res = mockRes();
    await getAdBudgetChannels({ query: {}, headers: {} } as unknown as Request, res);
    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe("ad_spend_unavailable");
  });
});
