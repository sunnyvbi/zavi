import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT = "22222222-2222-2222-2222-222222222222";
const MINE = "aaaaaaaa-0000-0000-0000-000000000001";
const THEIRS = "aaaaaaaa-0000-0000-0000-000000000002";

let authResult: { user_id: string; tenant_id: string; access_token: string; tenant_overridden?: boolean } | null;
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async (_req: Request, res: Response) => {
    if (authResult) return authResult;
    res.status(401).json({ error: { code: "unauthenticated" } });
    return null;
  }),
}));

let role: string | null = "owner";
vi.mock("@/services/auth/tenant-role", () => ({
  loadTenantRole: vi.fn(async () => role),
  requireTenantRole: vi.fn(async (_auth: unknown, allowed: readonly string[], res: Response) => {
    if (role && allowed.includes(role)) return true;
    res.status(403).json({ error: { code: "forbidden", message: "nope" } });
    return false;
  }),
}));

let tier: string | Error = "pro";
vi.mock("@/services/agents/entitlement", () => ({
  loadTierGateConfig: vi.fn(async () => ({ proTenants: [] })),
  resolveTenantTier: vi.fn(async () => {
    if (tier instanceof Error) throw tier;
    return tier;
  }),
}));

let createStatus = "created";
const budgets: Record<string, { tenant: string; used: number }> = {};
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: (tid: string, fn: string, args: Record<string, unknown>) => {
    const a: Record<string, unknown> = { ...args, p_tenant_id: tid };
    rpcCalls.push({ fn, args: a });
    const b = budgets[String(a.p_budget_id)];
    const mine = b && b.tenant === tid;
    if (fn === "create_ad_budget") {
      return Promise.resolve({ data: { status: createStatus, budget_id: "new-id", month_cap_usd: "183.33" }, error: null });
    }
    if (fn === "update_ad_budget") {
      if (!mine) return Promise.resolve({ data: { status: "not_found" }, error: null });
      if (a.p_daily_limit_usd != null && Number(a.p_daily_limit_usd) < 40) {
        return Promise.resolve({ data: { status: "daily_below_live", daily_limit_usd: a.p_daily_limit_usd, live_daily_usd: "40.00" }, error: null });
      }
      if (Number(a.p_monthly_usd) < b.used) {
        return Promise.resolve({ data: { status: "below_used", used_usd: b.used, month_cap_usd: a.p_monthly_usd }, error: null });
      }
      return Promise.resolve({ data: { status: "updated", month_cap_usd: a.p_monthly_usd }, error: null });
    }
    if (fn === "log_ad_budget_human_action") {
      return Promise.resolve({ data: { status: mine ? "logged" : "not_found" }, error: null });
    }
    return Promise.resolve({ data: null, error: { message: `unexpected ${fn}` } });
  },
}));

const stops: Array<{ tenant: string; actor: string; id: string }> = [];
vi.mock("@/services/decisions/ad-budget-setup", async (orig) => {
  const real = await orig<typeof import("@/services/decisions/ad-budget-setup")>();
  return {
    ...real,
    stopAdBudget: vi.fn(async (tenant: string, actor: string, id: string) => {
      stops.push({ tenant, actor, id });
      const b = budgets[id];
      if (!b || b.tenant !== tenant) return { status: "not_found" };
      return {
        status: "stopped",
        paused: [{ platform: "meta", object_id: "adset-1", released_usd: 10 }],
        failed: [{ platform: "google", object_id: "555", error: "Google Ads googleAds:mutate failed: 503", label: "Google Ads campaign Spring", reason: "Google Ads did not answer. Press Stop again in a minute." }],
      };
    }),
    readAdBudgetView: vi.fn(async () => null),
    readAdBudgetLedger: vi.fn(async (tenant: string, viewer?: string) => {
      ledgerReads.push(tenant);
      ledgerViewers.push(viewer ?? null);
      if (ledgerFails) throw new Error("db down");
      return tenant === TENANT
        ? [
            { at: "2026-09-27T10:00:00Z", action: "Budget changed: $3,000.00 → $2,400.00 a month", kind: "event", date: null, amount_usd: null, amount_label: null, result: "Changed", source: "person" },
            { at: "2026-09-26T10:00:00Z", action: "Budget set up: $3,000.00 a month", kind: "event", date: null, amount_usd: null, amount_label: null, result: "Set up", source: "person" },
          ]
        : [];
    }),
  };
});
const ledgerReads: string[] = [];
const ledgerViewers: Array<string | null> = [];
let ledgerFails = false;

import { adBudgetForecast, getAdBudget, getAdBudgetLedger, patchAdBudget, postAdBudget, postAdBudgetHumanAction, postAdBudgetStop } from "../ad-budget";
import { utcToday } from "@/services/decisions/ad-budget-setup";

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
const req = (body: unknown, params: Record<string, string> = {}) => ({ body, params }) as unknown as Request;

const GOOD = () => ({ monthly_usd: 500, daily_limit_usd: 50 });

beforeEach(() => {
  authResult = { user_id: "user-1", tenant_id: TENANT, access_token: "t" };
  role = "owner";
  tier = "pro";
  rpcCalls.length = 0;
  stops.length = 0;
  createStatus = "created";
  for (const k of Object.keys(budgets)) delete budgets[k];
  budgets[MINE] = { tenant: TENANT, used: 120 };
  budgets[THEIRS] = { tenant: OTHER_TENANT, used: 0 };
});

describe("create", () => {
  it("owner: created, with the session's tenant and actor, never the body's", async () => {
    const res = mockRes();
    await postAdBudget(req({ ...GOOD(), tenant_id: OTHER_TENANT, p_tenant_id: OTHER_TENANT }), res);
    expect(res.statusCode).toBe(201);
    expect(rpcCalls).toEqual([
      {
        fn: "create_ad_budget",
        args: { p_actor: "user-1", p_monthly_usd: 500, p_daily_limit_usd: 50, p_tenant_id: TENANT },
      },
    ]);
    expect(res.body).toEqual({ budget_id: "new-id", month_cap_usd: 183.33 });
  });

  it("an end date from an old client is never sent", async () => {
    const res = mockRes();
    await postAdBudget(req({ ...GOOD(), ends_on: "2026-12-01" }), res);
    expect(res.statusCode).toBe(201);
    expect(rpcCalls[0].args).not.toHaveProperty("p_ends_on");
  });

  it("a stopped budget that still holds money blocks a new one (409, the reason shown)", async () => {
    createStatus = "outstanding_holds";
    const res = mockRes();
    await postAdBudget(req(GOOD()), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error.message).toContain("Press Stop again");
  });

  it("admin: created", async () => {
    role = "admin";
    const res = mockRes();
    await postAdBudget(req(GOOD()), res);
    expect(res.statusCode).toBe(201);
  });

  it("member: refused, nothing written", async () => {
    role = "member";
    const res = mockRes();
    await postAdBudget(req(GOOD()), res);
    expect(res.statusCode).toBe(403);
    expect(rpcCalls).toEqual([]);
  });

  it.each(["free", "starter", "growth"])("%s plan: refused with the Pro reason, nothing written", async (t) => {
    tier = t;
    const res = mockRes();
    await postAdBudget(req(GOOD()), res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatchObject({ code: "plan_upgrade_required", required_tier: "pro", message: "Ad budgets are on the Pro plan." });
    expect(rpcCalls).toEqual([]);
  });

  it("a plan read error refuses (fail closed)", async () => {
    tier = new Error("db down");
    const res = mockRes();
    await postAdBudget(req(GOOD()), res);
    expect(res.statusCode).toBe(503);
    expect(rpcCalls).toEqual([]);
  });

  it("an eval tenant override may not write", async () => {
    authResult = { ...authResult!, tenant_overridden: true };
    const res = mockRes();
    await postAdBudget(req(GOOD()), res);
    expect(res.statusCode).toBe(403);
    expect(rpcCalls).toEqual([]);
  });

  it.each([
    [{ monthly_usd: 0 }],
    [{ monthly_usd: -5 }],
    [{ monthly_usd: 100, daily_limit_usd: 200 }],
    [{ monthly_usd: 100, daily_limit_usd: 0 }],
    [{ total_usd: 100 }],
    [{}],
  ])("bad input %j: 400, nothing written", async (body) => {
    const res = mockRes();
    await postAdBudget(req(body), res);
    expect(res.statusCode).toBe(400);
    expect(rpcCalls).toEqual([]);
  });
});

describe("edit", () => {
  it("owner edits their own budget", async () => {
    const res = mockRes();
    await patchAdBudget(req(GOOD(), { id: MINE }), res);
    expect(res.statusCode).toBe(200);
    expect(rpcCalls[0]).toMatchObject({ fn: "update_ad_budget", args: { p_budget_id: MINE, p_tenant_id: TENANT, p_actor: "user-1" } });
  });

  it("a monthly amount below what is already spent + held this month is refused, with the numbers", async () => {
    const res = mockRes();
    await patchAdBudget(req({ ...GOOD(), monthly_usd: 100 }, { id: MINE }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe("below_used");
    expect(res.body.error.message).toBe(
      "That would make this month's budget $100.00, but $120.00 is already spent or set aside this month for running ads and creator hires. " +
        "Pick an amount that leaves at least $120.00 this month, or pause some ads first.",
    );
    expect(res.body.error).toMatchObject({ used_usd: 120, month_cap_usd: 100 });
    expect(res.body.error.message).not.toMatch(/—/);
  });

  it("a daily limit below what the running ads already hold a day is refused, with both numbers", async () => {
    const res = mockRes();
    await patchAdBudget(req({ ...GOOD(), daily_limit_usd: 30 }, { id: MINE }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe("daily_below_live");
    expect(res.body.error.message).toBe(
      "Your running ads already spend up to $40.00 a day, more than a $30.00 daily limit. " +
        "Set the daily limit to at least $40.00, or pause some ads first.",
    );
    expect(res.body.error).toMatchObject({ daily_limit_usd: 30, live_daily_usd: 40 });
    expect(res.body.error.message).not.toMatch(/—/);
  });

  it("an edit answers this month's new cap", async () => {
    const res = mockRes();
    await patchAdBudget(req({ ...GOOD(), monthly_usd: 900 }, { id: MINE }), res);
    expect(res.body).toEqual({ ok: true, month_cap_usd: 900 });
  });

  it("another tenant's budget id is not found (T16 cross-tenant)", async () => {
    const res = mockRes();
    await patchAdBudget(req(GOOD(), { id: THEIRS }), res);
    expect(res.statusCode).toBe(404);
    expect(rpcCalls[0].args.p_tenant_id).toBe(TENANT);
  });

  it("member and non-Pro are refused before any write", async () => {
    role = "member";
    const r1 = mockRes();
    await patchAdBudget(req(GOOD(), { id: MINE }), r1);
    expect(r1.statusCode).toBe(403);
    role = "admin";
    tier = "starter";
    const r2 = mockRes();
    await patchAdBudget(req(GOOD(), { id: MINE }), r2);
    expect(r2.statusCode).toBe(403);
    expect(rpcCalls).toEqual([]);
  });

  it("a malformed id is refused", async () => {
    const res = mockRes();
    await patchAdBudget(req(GOOD(), { id: "not-a-uuid" }), res);
    expect(res.statusCode).toBe(400);
    expect(rpcCalls).toEqual([]);
  });
});

describe("stop", () => {
  it("owner stops; a partial failure is reported, never hidden", async () => {
    const res = mockRes();
    await postAdBudgetStop(req({}, { id: MINE }), res);
    expect(res.statusCode).toBe(200);
    expect(stops).toEqual([{ tenant: TENANT, actor: "user-1", id: MINE }]);
    expect(res.body).toMatchObject({
      status: "stopped",
      partial: true,
      failed: [{ platform: "google", object_id: "555", label: "Google Ads campaign Spring", reason: "Google Ads did not answer. Press Stop again in a minute." }],
    });
    expect(res.body.failed[0]).not.toHaveProperty("error");
    expect(JSON.stringify(res.body)).not.toContain("googleAds:mutate");
  });

  it("stop works on any plan: a downgraded owner can still stop", async () => {
    tier = "free";
    const res = mockRes();
    await postAdBudgetStop(req({}, { id: MINE }), res);
    expect(res.statusCode).toBe(200);
  });

  it("member is refused", async () => {
    role = "member";
    const res = mockRes();
    await postAdBudgetStop(req({}, { id: MINE }), res);
    expect(res.statusCode).toBe(403);
    expect(stops).toEqual([]);
  });

  it("another tenant's budget id is not found (T16 cross-tenant)", async () => {
    const res = mockRes();
    await postAdBudgetStop(req({}, { id: THEIRS }), res);
    expect(res.statusCode).toBe(404);
    expect(stops[0].tenant).toBe(TENANT);
  });
});

describe("log a human action", () => {
  it("owner logs on their budget; another tenant's budget is not found; member refused", async () => {
    const ok = mockRes();
    await postAdBudgetHumanAction(req({ occurred_at: utcToday(), note: "Raised in Ads Manager", amount_usd: 25 }, { id: MINE }), ok);
    expect(ok.statusCode).toBe(201);
    const cross = mockRes();
    await postAdBudgetHumanAction(req({ occurred_at: utcToday(), note: "x" }, { id: THEIRS }), cross);
    expect(cross.statusCode).toBe(404);
    role = "member";
    const member = mockRes();
    await postAdBudgetHumanAction(req({ occurred_at: utcToday(), note: "x" }, { id: MINE }), member);
    expect(member.statusCode).toBe(403);
  });

  it("an empty or long note is refused", async () => {
    const res = mockRes();
    await postAdBudgetHumanAction(req({ occurred_at: utcToday(), note: "   " }, { id: MINE }), res);
    expect(res.statusCode).toBe(400);
  });
});

describe("ledger", () => {
  beforeEach(() => {
    ledgerReads.length = 0;
    ledgerViewers.length = 0;
    ledgerFails = false;
  });
  it("a member reads the session tenant's history, whatever the request says", async () => {
    role = "member";
    const res = mockRes();
    await getAdBudgetLedger({ body: { tenant_id: OTHER_TENANT }, params: {}, query: { tenant_id: OTHER_TENANT } } as unknown as Request, res);
    expect(res.statusCode).toBe(200);
    expect(ledgerReads).toEqual([TENANT]);
    expect(ledgerViewers).toEqual(["user-1"]);
    expect(res.body.rows.map((r: { action: string }) => r.action)).toEqual([
      "Budget changed: $3,000.00 → $2,400.00 a month",
      "Budget set up: $3,000.00 a month",
    ]);
  });
  it("unauthenticated is refused before any read", async () => {
    authResult = null;
    const res = mockRes();
    await getAdBudgetLedger(req({}), res);
    expect(res.statusCode).toBe(401);
    expect(ledgerReads).toEqual([]);
  });
  it("a read failure is a 503, never an empty history", async () => {
    ledgerFails = true;
    const res = mockRes();
    await getAdBudgetLedger(req({}), res);
    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe("ledger_unavailable");
  });
});

describe("read", () => {
  it("a member reads, and is told they cannot manage", async () => {
    role = "member";
    tier = "starter";
    const res = mockRes();
    await getAdBudget(req({}), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ budget: null, can_manage: false, pro: false, forecast: null });
  });
});

describe("forecast (one pace for every date the Growth page shows)", () => {
  const b = { left_usd: 300, spent_usd: 600, month_cap_usd: 1000, next_month_start: "2026-11-01" };
  const now = new Date("2026-10-20T15:00:00Z");

  it("runs out on the day the money left covers, and projects the month from the same pace", () => {
    expect(adBudgetForecast(b, { forecast_daily_usd: 40, actual_today_usd: 10 }, now)).toEqual({
      daily_usd: 40,
      runs_out_on: "2026-10-27",
      projected_month_usd: 1000,
    });
  });

  it("says nothing runs out when the money lasts past the month", () => {
    expect(adBudgetForecast(b, { forecast_daily_usd: 10, actual_today_usd: 0 }, now)).toEqual({
      daily_usd: 10,
      runs_out_on: null,
      projected_month_usd: 720,
    });
  });

  it("no running ads: no run-out date, the month stays what was spent", () => {
    expect(adBudgetForecast(b, { forecast_daily_usd: 0, actual_today_usd: 0 }, now)).toEqual({
      daily_usd: 0,
      runs_out_on: null,
      projected_month_usd: 600,
    });
  });
});
