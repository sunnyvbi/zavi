import type { Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TENANT = "11111111-1111-1111-1111-111111111111";
const NOW = new Date("2026-10-30T03:00:00Z");

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ user_id: "user-1", tenant_id: TENANT, access_token: "t" })),
}));
vi.mock("@/services/auth/tenant-role", () => ({
  loadTenantRole: vi.fn(async () => "owner"),
  requireTenantRole: vi.fn(async () => true),
}));
vi.mock("@/services/agents/entitlement", () => ({
  loadTierGateConfig: vi.fn(async () => ({ proTenants: [] })),
  resolveTenantTier: vi.fn(async () => "pro"),
}));

const tables: Record<string, unknown[]> = {
  ad_campaigns: [
    { platform: "meta", account_id: "act_1", object_id: "adset-1", status: "ACTIVE", budget_kind: "daily", budget_usd: 40 },
  ],
  ad_spend_daily: [
    { platform: "meta", object_id: "adset-1", spend_date: "2026-10-26", amount_usd: 30 },
    { platform: "meta", object_id: "adset-1", spend_date: "2026-10-27", amount_usd: 30 },
    { platform: "meta", object_id: "adset-1", spend_date: "2026-10-28", amount_usd: 30 },
    { platform: "meta", object_id: "adset-1", spend_date: "2026-10-29", amount_usd: 12 },
  ],
  ad_budget_reservations: [],
};
function query(table: string) {
  const q: Record<string, unknown> = {};
  let platforms: string[] | null = null;
  for (const m of ["select", "eq", "gte", "not", "limit", "order"]) q[m] = () => q;
  q.in = (column: string, values: string[]) => {
    if (column === "platform") platforms = values;
    return q;
  };
  q.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => {
    const rows = (tables[table] ?? []).filter((r) => !platforms || platforms.includes((r as { platform: string }).platform));
    return Promise.resolve({ data: rows, error: null }).then(ok, bad);
  };
  return q;
}
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({ from: (t: string) => query(t) }),
  tenantRpc: async () => ({ data: null, error: { message: "unexpected rpc" } }),
}));

const metaZone = { calls: [] as unknown[][], release: null as null | ((v: unknown) => void) };
vi.mock("@/services/tools/meta-ads/_client", () => ({
  metaAdsCreds: vi.fn(async () => ({ access_token: "x", ad_account_id: "act_1" })),
  fbGet: vi.fn((...a: unknown[]) => {
    metaZone.calls.push(a);
    return new Promise((resolve) => {
      metaZone.release = resolve;
    });
  }),
}));
const googleLive = { credentialReads: 0, stored: null as string | null };
vi.mock("@/services/tools/google-ads/_client", () => ({
  gadsCustomerId: async () => {
    googleLive.credentialReads += 1;
    throw new Error("Google Ads is not connected for this workspace.");
  },
  gadsStoredCustomerId: async () => {
    if (!googleLive.stored) throw new Error("Google Ads is not connected for this workspace.");
    return googleLive.stored;
  },
  gadsSearch: vi.fn(),
}));
const redditLive = { calls: [] as string[], answer: null as null | { details: Record<string, unknown> } };
vi.mock("@/services/connectors/reddit-ads/adapter", () => ({
  ownedAccount: (_tenant: string, account: string) => {
    redditLive.calls.push(account);
    return redditLive.answer ? Promise.resolve(redditLive.answer) : new Promise(() => {});
  },
}));

vi.mock("@/services/decisions/ad-budget-setup", async (orig) => {
  const real = await orig<typeof import("@/services/decisions/ad-budget-setup")>();
  return {
    ...real,
    readAdBudgetView: vi.fn(async () => ({
      id: "b-1",
      status: "active",
      monthly_usd: 1000,
      month_cap_usd: 1000,
      spent_usd: 100,
      held_usd: 0,
      left_usd: 900,
      creator_held_usd: 0,
      creator_spent_usd: 0,
      daily_limit_usd: null,
      next_month_start: "2026-11-01",
      days_left: 2,
      days_in_month: 31,
      started_on: "2026-10-30",
      stopped_at: null,
      month_start: "2026-10-01",
      still_running: [],
    })),
  };
});

import { getAdBudget } from "../ad-budget";
import { loadLiveForecast } from "@/services/growth/spend-pace";
import { _resetAccountZones, rememberAccountZone } from "@/services/growth/account-zone";

function mockRes() {
  const res: Record<string, unknown> = { statusCode: 200, body: null, sent: false };
  res.status = vi.fn((c: number) => {
    res.statusCode = c;
    return res;
  });
  res.json = vi.fn((b: unknown) => {
    res.body = b;
    res.sent = true;
    return res;
  });
  return res as unknown as Response & { statusCode: number; body: any; sent: boolean };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  _resetAccountZones();
  metaZone.calls.length = 0;
  metaZone.release = null;
  googleLive.credentialReads = 0;
  googleLive.stored = null;
  redditLive.calls.length = 0;
  redditLive.answer = null;
  tables.ad_campaigns = tables.ad_campaigns.filter((r) => (r as { platform: string }).platform === "meta");
  tables.ad_spend_daily = tables.ad_spend_daily.filter((r) => (r as { platform: string }).platform === "meta");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GET /api/workspace/ad-budget while the Meta connection hangs", () => {
  it("answers within 50ms with the real forecast, never waiting on Meta for the account clock", async () => {
    const res = mockRes();
    const done = getAdBudget({ body: {}, params: {} } as unknown as Request, res);
    await vi.advanceTimersByTimeAsync(50);
    expect(res.sent).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.body.budget.status).toBe("active");
    expect(res.body.forecast).toEqual({ daily_usd: 24, runs_out_on: null, projected_month_usd: 148 });
    expect(metaZone.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(6_000);
    await done;
  });

  it("uses an account clock already read (bounded-stale) rather than UTC", async () => {
    rememberAccountZone(TENANT, "meta", "act_1", "America/Los_Angeles", new Date(NOW.getTime() - 3_600_000));
    const res = mockRes();
    const done = getAdBudget({ body: {}, params: {} } as unknown as Request, res);
    await vi.advanceTimersByTimeAsync(50);
    expect(res.sent).toBe(true);
    expect(res.body.forecast).toEqual({ daily_usd: 30, runs_out_on: null, projected_month_usd: 148 });
    expect(metaZone.calls).toHaveLength(0);
    await done;
  });
});

describe("GET /api/workspace/ad-budget never calls a provider, for any platform", () => {
  const withReddit = () => {
    tables.ad_campaigns.push({ platform: "reddit", account_id: "t2_acct", object_id: "rc-1", status: "ACTIVE", budget_kind: "daily", budget_usd: 20 });
    for (const spend_date of ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29"])
      tables.ad_spend_daily.push({ platform: "reddit", object_id: "rc-1", spend_date, amount_usd: 6 });
  };

  it("a Reddit campaign with no zone read yet answers at once on UTC days, with no Reddit call, while Reddit would hang", async () => {
    withReddit();
    const res = mockRes();
    const done = getAdBudget({ body: {}, params: {} } as unknown as Request, res);
    await vi.advanceTimersByTimeAsync(50);
    expect(redditLive.calls).toEqual([]);
    expect(res.sent).toBe(true);
    expect(res.body.forecast.daily_usd).toBe(30);
    await vi.advanceTimersByTimeAsync(6_000);
    await done;
  });

  it("a Reddit zone already read moves its day without a Reddit call", async () => {
    withReddit();
    tables.ad_spend_daily.push({ platform: "reddit", object_id: "rc-1", spend_date: "2026-10-26", amount_usd: 18 });
    rememberAccountZone(TENANT, "reddit", "t2_acct", "America/Los_Angeles", new Date(NOW.getTime() - 3_600_000));
    const res = mockRes();
    const done = getAdBudget({ body: {}, params: {} } as unknown as Request, res);
    await vi.advanceTimersByTimeAsync(50);
    expect(redditLive.calls).toEqual([]);
    expect(res.body.forecast.daily_usd).toBe(24 + 10);
    await vi.advanceTimersByTimeAsync(6_000);
    await done;
  });

  const liveLinkedin = (daily: Record<string, number>, provisionalDay?: string) => {
    tables.ad_campaigns.push({ platform: "linkedin", account_id: "503", object_id: "li-1", status: "ACTIVE", budget_kind: "lifetime", budget_usd: 500, as_of: NOW.toISOString() });
    for (const [spend_date, amount_usd] of Object.entries(daily))
      tables.ad_spend_daily.push({ platform: "linkedin", account_id: "503", object_id: "li-1", spend_date, amount_usd, provisional: spend_date === provisionalDay, recorded_at: NOW.toISOString() });
  };

  it("a live LinkedIn campaign adds its pace and run-out date from the stored ledger, with no LinkedIn call", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("no provider call may happen on this read");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const before = mockRes();
    const first = getAdBudget({ body: {}, params: {} } as unknown as Request, before);
    await vi.advanceTimersByTimeAsync(50);
    await first;
    liveLinkedin({ "2026-10-27": 30, "2026-10-28": 30, "2026-10-29": 30 });
    const res = mockRes();
    const done = getAdBudget({ body: {}, params: {} } as unknown as Request, res);
    await vi.advanceTimersByTimeAsync(50);
    await done;
    expect(res.body.forecast.daily_usd).toBe(before.body.forecast.daily_usd + 30);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("LinkedIn's ledger is dated by UTC days, so a provisional row from yesterday never moves its window back", async () => {
    const before = mockRes();
    const first = getAdBudget({ body: {}, params: {} } as unknown as Request, before);
    await vi.advanceTimersByTimeAsync(50);
    await first;
    liveLinkedin({ "2026-10-26": 0, "2026-10-27": 30, "2026-10-28": 30, "2026-10-29": 30 }, "2026-10-29");
    const res = mockRes();
    const done = getAdBudget({ body: {}, params: {} } as unknown as Request, res);
    await vi.advanceTimersByTimeAsync(50);
    await done;
    expect(res.body.forecast.daily_usd).toBe(before.body.forecast.daily_usd + 30);
  });

  it("Google's account id is read from the vault, never through the credential read that refreshes an OAuth token", async () => {
    googleLive.stored = "1234567890";
    const res = mockRes();
    const done = getAdBudget({ body: {}, params: {} } as unknown as Request, res);
    await vi.advanceTimersByTimeAsync(50);
    expect(googleLive.credentialReads).toBe(0);
    expect(res.sent).toBe(true);
    await vi.advanceTimersByTimeAsync(6_000);
    await done;
  });

  it("must not catch: the CGO's own forecast still reads Reddit's clock, and holds when Reddit names none", async () => {
    withReddit();
    rememberAccountZone(TENANT, "meta", "act_1", "UTC", NOW);
    redditLive.answer = { details: { time_zone_id: "America/Los_Angeles" } };
    await expect(loadLiveForecast(TENANT, NOW)).resolves.toMatchObject({ forecast_daily_usd: expect.any(Number) });
    expect(redditLive.calls).toEqual(["t2_acct"]);
    redditLive.answer = { details: {} };
    _resetAccountZones();
    rememberAccountZone(TENANT, "meta", "act_1", "UTC", NOW);
    await expect(loadLiveForecast(TENANT, NOW)).rejects.toThrow(/Reddit timezone is unknown/);
  });
});

describe("GET /api/workspace/ad-budget on a host that holds no account clock (Review 10)", () => {
  const READ_AT = "2026-10-30T02:30:00.000Z";
  const saved = { campaigns: tables.ad_campaigns, spend: tables.ad_spend_daily };
  afterEach(() => {
    tables.ad_campaigns = saved.campaigns;
    tables.ad_spend_daily = saved.spend;
  });
  const row = (platform: string, account_id: string, object_id: string, spend_date: string, amount_usd: number, provisional = false, recorded_at = READ_AT) => ({ platform, account_id, object_id, spend_date, amount_usd, provisional, recorded_at });
  const onLosAngelesClock = (platform: string, account_id: string, object_id: string) => {
    tables.ad_campaigns = [{ platform, account_id, object_id, status: "ACTIVE", budget_kind: "daily", budget_usd: 40, as_of: READ_AT }];
    tables.ad_spend_daily = [
      row(platform, account_id, object_id, "2026-10-26", 30),
      row(platform, account_id, object_id, "2026-10-27", 30),
      row(platform, account_id, object_id, "2026-10-28", 30),
      row(platform, account_id, object_id, "2026-10-29", 12, true),
    ];
  };
  const forecastOnGet = async () => {
    const res = mockRes();
    const done = getAdBudget({ body: {}, params: {} } as unknown as Request, res);
    await vi.advanceTimersByTimeAsync(50);
    expect(res.sent).toBe(true);
    expect(res.statusCode).toBe(200);
    await vi.advanceTimersByTimeAsync(6_000);
    await done;
    return res.body.forecast;
  };

  it.each([
    ["Meta", "meta", "act_1", "adset-1"],
    ["Google", "google", "1234567890", "camp-1"],
    ["Reddit", "reddit", "t2_acct", "rc-1"],
  ])("must catch: %s in its evening: the half-spent day the ledger marks as today is not a whole day, with no provider call", async (_name, platform, account, object) => {
    googleLive.stored = "1234567890";
    onLosAngelesClock(platform, account, object);
    expect((await forecastOnGet()).daily_usd).toBe(30);
    expect(metaZone.calls).toHaveLength(0);
    expect(redditLive.calls).toEqual([]);
    expect(googleLive.credentialReads).toBe(0);
  });

  it("must catch: an account ahead of UTC keeps its yesterday, which UTC would call today", async () => {
    tables.ad_campaigns = [{ platform: "meta", account_id: "act_1", object_id: "adset-1", status: "ACTIVE", budget_kind: "daily", budget_usd: 40, as_of: "2026-10-30T20:30:00.000Z" }];
    tables.ad_spend_daily = [
      row("meta", "act_1", "adset-1", "2026-10-28", 30, false, "2026-10-30T20:30:00.000Z"),
      row("meta", "act_1", "adset-1", "2026-10-29", 30, false, "2026-10-30T20:30:00.000Z"),
      row("meta", "act_1", "adset-1", "2026-10-30", 30, false, "2026-10-30T20:30:00.000Z"),
      row("meta", "act_1", "adset-1", "2026-10-31", 1, true, "2026-10-30T20:30:00.000Z"),
    ];
    await expect(loadLiveForecast(TENANT, new Date("2026-10-30T21:00:00Z"), { fetchZones: false })).resolves.toEqual({ forecast_daily_usd: 30, actual_today_usd: 1 });
  });

  it("must catch: an account with no spend yet today is on the day after its newest row, not on UTC's", async () => {
    tables.ad_campaigns = [{ platform: "meta", account_id: "act_1", object_id: "adset-1", status: "ACTIVE", budget_kind: "daily", budget_usd: 40, as_of: READ_AT }];
    tables.ad_spend_daily = [
      row("meta", "act_1", "adset-1", "2026-10-26", 30),
      row("meta", "act_1", "adset-1", "2026-10-27", 30),
      row("meta", "act_1", "adset-1", "2026-10-28", 30),
    ];
    expect((await forecastOnGet()).daily_usd).toBe(30);
  });

  it("must catch: two accounts of one platform keep their own clocks", async () => {
    tables.ad_campaigns = [
      { platform: "reddit", account_id: "t2_west", object_id: "w", status: "ACTIVE", budget_kind: "daily", budget_usd: 40, as_of: READ_AT },
      { platform: "reddit", account_id: "t2_utc", object_id: "u", status: "ACTIVE", budget_kind: "daily", budget_usd: 40, as_of: READ_AT },
    ];
    tables.ad_spend_daily = [
      ...["2026-10-26", "2026-10-27", "2026-10-28"].map((d) => row("reddit", "t2_west", "w", d, 30)),
      row("reddit", "t2_west", "w", "2026-10-29", 3, true),
      ...["2026-10-27", "2026-10-28", "2026-10-29"].map((d) => row("reddit", "t2_utc", "u", d, 9)),
      row("reddit", "t2_utc", "u", "2026-10-30", 1, true),
    ];
    await expect(loadLiveForecast(TENANT, NOW, { fetchZones: false })).resolves.toEqual({ forecast_daily_usd: 39, actual_today_usd: 4 });
    expect(redditLive.calls).toEqual([]);
  });

  it("must catch: last month's final row, left flagged because the new month's read no longer covers it, is not today", async () => {
    const at = "2026-11-01T00:40:00.000Z";
    const earlier = "2026-10-31T23:40:00.000Z";
    tables.ad_campaigns = [{ platform: "meta", account_id: "act_1", object_id: "adset-1", status: "ACTIVE", budget_kind: "daily", budget_usd: 40, as_of: at }];
    tables.ad_spend_daily = [
      row("meta", "act_1", "adset-1", "2026-10-29", 30, false, earlier),
      row("meta", "act_1", "adset-1", "2026-10-30", 30, false, earlier),
      row("meta", "act_1", "adset-1", "2026-10-31", 30, true, earlier),
    ];
    await expect(loadLiveForecast(TENANT, new Date("2026-11-01T00:45:00Z"), { fetchZones: false })).resolves.toEqual({ forecast_daily_usd: 30, actual_today_usd: 0 });
  });

  it("must not catch: a clock this process already read beats the ledger's clue", async () => {
    onLosAngelesClock("meta", "act_1", "adset-1");
    rememberAccountZone(TENANT, "meta", "act_1", "Asia/Tokyo", new Date(NOW.getTime() - 3_600_000));
    expect((await forecastOnGet()).daily_usd).toBe(24);
  });

  it("must not catch: a ledger too old to say anything counts on UTC days instead of a stale day", async () => {
    tables.ad_campaigns = [{ platform: "meta", account_id: "act_1", object_id: "adset-1", status: "ACTIVE", budget_kind: "daily", budget_usd: 40, as_of: "2026-10-20T00:00:00.000Z" }];
    tables.ad_spend_daily = [row("meta", "act_1", "adset-1", "2026-10-19", 30, true, "2026-10-20T00:00:00.000Z")];
    await expect(loadLiveForecast(TENANT, NOW, { fetchZones: false })).resolves.toEqual({ forecast_daily_usd: 0, actual_today_usd: 0 });
  });

  it("must not catch: the CGO's own forecast ignores the ledger's clue and asks for the real clock", async () => {
    onLosAngelesClock("meta", "act_1", "adset-1");
    rememberAccountZone(TENANT, "meta", "act_1", "UTC", NOW);
    await expect(loadLiveForecast(TENANT, NOW)).resolves.toEqual({ forecast_daily_usd: 24, actual_today_usd: 0 });
  });
});

describe("the CGO's forecast (decisions) still reads the account clock fresh", () => {
  it("calls Meta for the zone, waits for it, and counts on the clock Meta reports", async () => {
    let result: { forecast_daily_usd: number; actual_today_usd: number } | null = null;
    const p = loadLiveForecast(TENANT, NOW).then((r) => {
      result = r;
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(metaZone.calls).toHaveLength(1);
    expect(metaZone.calls[0]?.[1]).toBe("act_1");
    expect(metaZone.calls[0]?.[2]).toEqual({ fields: "timezone_name" });
    expect(result).toBeNull();
    metaZone.release?.({ timezone_name: "America/Los_Angeles" });
    await p;
    expect(result).toEqual({ forecast_daily_usd: 30, actual_today_usd: 12 });
  });
});
