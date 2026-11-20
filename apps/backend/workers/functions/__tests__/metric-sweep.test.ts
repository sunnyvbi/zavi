
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => {
  const state: {
    rpcImpl: (name: string) => Promise<{ data: unknown; error: unknown }>;
    tenantRows: Array<{ id: string }>;
    tenantScanError: { message: string } | null;
    connectorRows: Array<{ tenant_id: string; slug: string }>;
    connectorReadError: { message: string } | null;
    fromCalls: string[];
    snapshotCalls: Array<Record<string, unknown>>;
    historyRowsByKey: Record<string, unknown[]>;
    historyCalls: Array<{ tenant_id: string; metric_key: string; window_kind: string }>;
  } = {
    rpcImpl: async () => ({ data: false, error: null }),
    tenantRows: [],
    tenantScanError: null,
    connectorRows: [],
    connectorReadError: null,
    fromCalls: [],
    snapshotCalls: [],
    historyRowsByKey: {},
    historyCalls: [],
  };

  const serviceClientMock = vi.fn(() => ({
    from: (table: string) => {
      state.fromCalls.push(table);
      return {
        select: (_cols: string) => ({
          order: () => ({
            limit: async () => {
              if (state.tenantScanError) return { data: null, error: state.tenantScanError };
              return { data: state.tenantRows, error: null };
            },
          }),
          in: (_col: string, _vals: unknown[]) => ({
            in: async () => {
              if (state.connectorReadError)
                return { data: null, error: state.connectorReadError };
              return { data: state.connectorRows, error: null };
            },
          }),
        }),
      };
    },
    rpc: (name: string) => state.rpcImpl(name),
  }));

  const recordMetricSnapshotMock = vi.fn(async (input: Record<string, unknown>) => {
    state.snapshotCalls.push(input);
  });

  const readMetricHistoryMock = vi.fn(
    async (tenant_id: string, metric_key: string, opts: { window_kind: string }) => {
      state.historyCalls.push({ tenant_id, metric_key, window_kind: opts.window_kind });
      return state.historyRowsByKey[`${tenant_id}:${metric_key}`] ?? [];
    },
  );

  return { state, serviceClientMock, recordMetricSnapshotMock, readMetricHistoryMock };
});

vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));
vi.mock("@/services/analytics/record-metric-snapshot", () => ({
  recordMetricSnapshot: mocks.recordMetricSnapshotMock,
  readMetricHistory: mocks.readMetricHistoryMock,
}));
vi.mock("@/services/data-gateway", () => ({
  resolveAttachedDb: vi.fn(),
  withReadSession: vi.fn(),
}));
vi.mock("@/services/growth/action-outcomes", () => ({
  readMetaSnapshot: vi.fn(),
}));
vi.mock("@/services/tools/meta-ads/_client", () => ({
  metaAdsCreds: vi.fn(),
}));
const callGoogleAdsTool = vi.hoisted(() => vi.fn());
vi.mock("@/services/mcp/internal/google-ads", () => ({ callGoogleAdsTool }));
vi.mock("@/services/analytics/stripe-mrr", () => ({
  readTenantStripeMrr: vi.fn(async () => ({ available: false, reason: "stub" })),
}));
const resolveConfirmedOperatorDb = vi.hoisted(() => vi.fn());
vi.mock("@/services/analytics/confirmed-operator-db", () => ({ resolveConfirmedOperatorDb }));
vi.mock("@/services/analytics/tenant-timezone", () => ({
  resolveReportingTimezone: vi.fn(async () => ({ tz: "UTC", source: "default" })),
}));

import {
  runMetricSweep,
  sweepTenantMetrics,
  lastClosedCalendarWeeks,
  lastClosedCalendarWeeksInTz,
  backfillClosedWeeks,
  truncToHourIso,
  truncToDayIso,
  rolling7dWindow,
  BACKFILL_WEEKS,
  realSweepDeps,
  type SweepDeps,
} from "../metric-sweep";

const NOW = new Date("2026-07-01T15:30:45.123Z");
const logger = { warn: vi.fn(), error: vi.fn() };

function makeDeps(overrides: Partial<SweepDeps> = {}): SweepDeps & {
  calls: { operator: Array<[string, string]>; meta: string[]; google: string[]; stripe: string[]; range: Array<[string, string, string, string]> };
} {
  const calls = {
    operator: [] as Array<[string, string]>,
    meta: [] as string[],
    google: [] as string[],
    stripe: [] as string[],
    range: [] as Array<[string, string, string, string]>,
  };
  const deps: SweepDeps = {
    async readOperatorCount7d(tenant_id, kind) {
      calls.operator.push([tenant_id, kind]);
      return { ok: true, value: kind === "users" ? 5 : 7 };
    },
    async readMetaAds7d(tenant_id) {
      calls.meta.push(tenant_id);
      return { ok: true, spend: 70, conversions: 10 };
    },
    async readGoogleAds7d(tenant_id) {
      calls.google.push(tenant_id);
      return { ok: true, spend: 210, conversions: 7 };
    },
    async readStripeMrr(tenant_id) {
      calls.stripe.push(tenant_id);
      return { ok: true, value: 1000, meta: { currency: "usd" } };
    },
    async readCountInRange(tenant_id, kind, since, until) {
      calls.range.push([tenant_id, kind, since, until]);
      return null;
    },
    ...overrides,
  };
  return Object.assign(deps, { calls });
}

beforeEach(() => {
  mocks.state.rpcImpl = async () => ({ data: false, error: null });
  mocks.state.tenantRows = [];
  mocks.state.tenantScanError = null;
  mocks.state.connectorRows = [];
  mocks.state.connectorReadError = null;
  mocks.state.fromCalls = [];
  mocks.state.snapshotCalls = [];
  mocks.state.historyRowsByKey = {};
  mocks.state.historyCalls = [];
  logger.warn.mockClear();
  logger.error.mockClear();
});

describe("metric-sweep gate order", () => {
  it("fails CLOSED when is_fleet_halted errors — no tenant or connector reads", async () => {
    mocks.state.rpcImpl = async () => ({ data: null, error: { message: "rpc boom" } });
    const res = await runMetricSweep(logger, makeDeps(), NOW);
    expect(res).toEqual({ skipped: true, reason: "fleet_kill_check_failed" });
    expect(mocks.state.fromCalls).toEqual([]);
    expect(mocks.state.snapshotCalls).toEqual([]);
  });

  it("skips the sweep when the fleet is halted", async () => {
    mocks.state.rpcImpl = async () => ({ data: true, error: null });
    const res = await runMetricSweep(logger, makeDeps(), NOW);
    expect(res).toEqual({ skipped: true, reason: "fleet_halted" });
    expect(mocks.state.fromCalls).toEqual([]);
  });

  it("fails CLOSED when the connector_metadata read errors", async () => {
    mocks.state.tenantRows = [{ id: "t1" }];
    mocks.state.connectorReadError = { message: "conn boom" };
    const res = await runMetricSweep(logger, makeDeps(), NOW);
    expect(res).toEqual({ skipped: true, reason: "connector_read_failed" });
    expect(mocks.state.snapshotCalls).toEqual([]);
  });
});

describe("metric-sweep connector filtering", () => {
  it("measures only metrics whose source connector is present; skips connector-less tenants", async () => {
    mocks.state.tenantRows = [{ id: "t-opdb" }, { id: "t-none" }, { id: "t-ads-stripe" }];
    mocks.state.connectorRows = [
      { tenant_id: "t-opdb", slug: "operator_db" },
      { tenant_id: "t-ads-stripe", slug: "meta_ads" },
      { tenant_id: "t-ads-stripe", slug: "stripe" },
    ];
    const deps = makeDeps();
    const res = await runMetricSweep(logger, deps, NOW);

    expect(res.scanned).toBe(3);
    expect(res.tenants_swept).toBe(2);
    expect(res.skipped_no_connectors).toBe(1);
    expect(res.measured).toBe(5);

    const byTenant = (id: string) =>
      mocks.state.snapshotCalls.filter((c) => c.tenant_id === id).map((c) => c.metric_key);
    expect(byTenant("t-opdb").sort()).toEqual(["weekly_bookings", "weekly_signups"]);
    expect(byTenant("t-ads-stripe").sort()).toEqual([
      "ads_cpa_7d",
      "ads_spend_7d",
      "stripe_mrr",
    ]);
    expect(byTenant("t-none")).toEqual([]);

    expect(deps.calls.operator.every(([t]) => t === "t-opdb")).toBe(true);
    expect(deps.calls.meta).toEqual(["t-ads-stripe"]);
    expect(deps.calls.stripe).toEqual(["t-ads-stripe"]);
  });

  it("derives cpa from the shared meta read (spend/conversions)", async () => {
    mocks.state.tenantRows = [{ id: "t1" }];
    mocks.state.connectorRows = [{ tenant_id: "t1", slug: "meta_ads" }];
    await runMetricSweep(logger, makeDeps(), NOW);
    const cpa = mocks.state.snapshotCalls.find((c) => c.metric_key === "ads_cpa_7d");
    expect(cpa?.value).toBe(7);
    expect(cpa?.status).toBe("measured");
  });
});

describe("metric-sweep unavailable honesty", () => {
  it("writes status='unavailable' + value null + meta.reason — never zeros", async () => {
    mocks.state.tenantRows = [{ id: "t1" }];
    mocks.state.connectorRows = [{ tenant_id: "t1", slug: "operator_db" }];
    const deps = makeDeps({
      async readOperatorCount7d(_t, kind) {
        return kind === "users"
          ? { ok: false, reason: "operator_db_not_connected" }
          : { ok: false, reason: "driver_method_missing_query_new_bookings_in_window" };
      },
    });
    const res = await runMetricSweep(logger, deps, NOW);
    expect(res.measured).toBe(0);
    expect(res.unavailable).toBe(2);
    for (const call of mocks.state.snapshotCalls.filter((c) => c.window_kind === "rolling_7d")) {
      expect(call.status).toBe("unavailable");
      expect(call.value).toBeNull();
      expect((call.meta as { reason?: string }).reason).toBeTruthy();
    }
  });

  it("cpa with zero conversions is unavailable (undefined, not $0/∞) while spend stays ok", async () => {
    mocks.state.tenantRows = [{ id: "t1" }];
    mocks.state.connectorRows = [{ tenant_id: "t1", slug: "meta_ads" }];
    const deps = makeDeps({
      async readMetaAds7d() {
        return { ok: true, spend: 12.5, conversions: 0 };
      },
    });
    await runMetricSweep(logger, deps, NOW);
    const spend = mocks.state.snapshotCalls.find((c) => c.metric_key === "ads_spend_7d");
    const cpa = mocks.state.snapshotCalls.find((c) => c.metric_key === "ads_cpa_7d");
    expect(spend?.status).toBe("measured");
    expect(spend?.value).toBe(12.5);
    expect(cpa?.status).toBe("unavailable");
    expect(cpa?.value).toBeNull();
    expect((cpa?.meta as { reason?: string }).reason).toBe("no_conversions_in_window");
  });
});

describe("metric-sweep idempotent grain", () => {
  it("re-run in the same hour produces the SAME window_end (rolling_7d) and same day (point)", async () => {
    mocks.state.tenantRows = [{ id: "t1" }];
    mocks.state.connectorRows = [
      { tenant_id: "t1", slug: "operator_db" },
      { tenant_id: "t1", slug: "stripe" },
    ];
    const run = async (now: Date) => {
      mocks.state.snapshotCalls = [];
      await runMetricSweep(logger, makeDeps(), now);
      return mocks.state.snapshotCalls
        .filter((c) => c.window_kind !== "calendar_week")
        .map((c) => ({ key: c.metric_key, end: c.window_end, start: c.window_start }));
    };
    const a = await run(new Date("2026-07-01T15:05:10.000Z"));
    const b = await run(new Date("2026-07-01T15:59:59.999Z"));
    expect(a).toEqual(b);
    const rolling = a.find((c) => c.key === "weekly_signups");
    expect(rolling?.end).toBe("2026-07-01T15:00:00.000Z");
    expect(rolling?.start).toBe("2026-06-24T15:00:00.000Z");
    const point = a.find((c) => c.key === "stripe_mrr");
    expect(point?.end).toBe("2026-07-01T00:00:00.000Z");
    expect(point?.start).toBeUndefined();
  });

  it("truncation helpers are stable within their grain", () => {
    expect(truncToHourIso(new Date("2026-03-01T23:59:59.999Z"))).toBe(
      "2026-03-01T23:00:00.000Z",
    );
    expect(truncToDayIso(new Date("2026-03-01T23:59:59.999Z"))).toBe(
      "2026-03-01T00:00:00.000Z",
    );
    const w = rolling7dWindow(new Date("2026-03-01T23:59:59.999Z"));
    expect(w.window_end).toBe("2026-03-01T23:00:00.000Z");
    expect(w.window_start).toBe("2026-02-22T23:00:00.000Z");
  });
});

describe("lastClosedCalendarWeeks", () => {
  const CASES: Array<{
    name: string;
    now: string;
    lastClosedStart: string;
    lastClosedEnd: string;
  }> = [
    {
      name: "mid-week (Wednesday)",
      now: "2026-07-01T15:30:00Z",
      lastClosedStart: "2026-06-22T00:00:00.000Z",
      lastClosedEnd: "2026-06-29T00:00:00.000Z",
    },
    {
      name: "exactly Monday 00:00 UTC — the just-ended week IS closed",
      now: "2026-06-29T00:00:00Z",
      lastClosedStart: "2026-06-22T00:00:00.000Z",
      lastClosedEnd: "2026-06-29T00:00:00.000Z",
    },
    {
      name: "Sunday 23:59 — the in-flight week is NOT closed",
      now: "2026-06-28T23:59:59Z",
      lastClosedStart: "2026-06-15T00:00:00.000Z",
      lastClosedEnd: "2026-06-22T00:00:00.000Z",
    },
    {
      name: "year boundary (Thu 2026-01-01 → weeks span 2025/2026)",
      now: "2026-01-01T00:00:00Z",
      lastClosedStart: "2025-12-22T00:00:00.000Z",
      lastClosedEnd: "2025-12-29T00:00:00.000Z",
    },
  ];

  for (const c of CASES) {
    it(c.name, () => {
      const weeks = lastClosedCalendarWeeks(new Date(c.now), 12);
      expect(weeks).toHaveLength(12);
      const last = weeks[weeks.length - 1];
      expect(last.window_start).toBe(c.lastClosedStart);
      expect(last.window_end).toBe(c.lastClosedEnd);
      for (let i = 0; i < weeks.length; i++) {
        const start = Date.parse(weeks[i].window_start);
        const end = Date.parse(weeks[i].window_end);
        expect(end - start).toBe(7 * 24 * 3600 * 1000);
        expect(new Date(start).getUTCDay()).toBe(1);
        expect(weeks[i].window_start.endsWith("T00:00:00.000Z")).toBe(true);
        if (i > 0) expect(weeks[i].window_start).toBe(weeks[i - 1].window_end);
      }
      expect(Date.parse(last.window_end)).toBeLessThanOrEqual(Date.parse(c.now));
    });
  }
});

describe("metric-sweep backfill", () => {
  beforeEach(() => {
    mocks.state.tenantRows = [{ id: "t1" }];
    mocks.state.connectorRows = [{ tenant_id: "t1", slug: "operator_db" }];
  });

  it("zero calendar_week history + range reads available → 12 closed-week rows per metric", async () => {
    const deps = makeDeps({
      async readCountInRange(_t, kind, since) {
        return (kind === "users" ? 100 : 200) + new Date(since).getUTCDate();
      },
    });
    const res = await runMetricSweep(logger, deps, NOW);
    expect(res.backfilled_rows).toBe(2 * BACKFILL_WEEKS);

    const backfill = mocks.state.snapshotCalls.filter(
      (c) => c.window_kind === "calendar_week",
    );
    expect(backfill).toHaveLength(2 * BACKFILL_WEEKS);
    for (const row of backfill) {
      expect(row.status).toBe("measured");
      expect(row.source).toBe("operator_db");
      expect((row.meta as { backfill?: boolean }).backfill).toBe(true);
      expect(new Date(Date.parse(row.window_start as string)).getUTCDay()).toBe(1);
    }
    const signupRows = backfill.filter((c) => c.metric_key === "weekly_signups");
    for (const row of signupRows) {
      expect(row.value).toBe(100 + new Date(row.window_start as string).getUTCDate());
    }
  });

  it("history detection is PER metric — existing signup history only backfills bookings", async () => {
    mocks.state.historyRowsByKey["t1:weekly_signups"] = [{ window_end: "x" }];
    const deps = makeDeps({
      async readCountInRange() {
        return 3;
      },
    });
    const res = await runMetricSweep(logger, deps, NOW);
    expect(res.backfilled_rows).toBe(BACKFILL_WEEKS);
    const backfill = mocks.state.snapshotCalls.filter(
      (c) => c.window_kind === "calendar_week",
    );
    expect(backfill.every((c) => c.metric_key === "weekly_bookings")).toBe(true);
    expect(
      mocks.state.historyCalls.every((h) => h.window_kind === "calendar_week"),
    ).toBe(true);
  });

  it("explicit-range read unavailable (pre-wh-s2) → backfill SKIPS, writes nothing", async () => {
    const deps = makeDeps();
    const res = await runMetricSweep(logger, deps, NOW);
    expect(res.backfilled_rows).toBe(0);
    expect(
      mocks.state.snapshotCalls.filter((c) => c.window_kind === "calendar_week"),
    ).toEqual([]);
    expect(deps.calls.range).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe("metric-sweep failure isolation", () => {
  it("one metric throwing doesn't stop the tenant's other metrics or the sweep", async () => {
    mocks.state.tenantRows = [{ id: "t1" }, { id: "t2" }];
    mocks.state.connectorRows = [
      { tenant_id: "t1", slug: "operator_db" },
      { tenant_id: "t2", slug: "stripe" },
    ];
    const deps = makeDeps({
      async readOperatorCount7d(_t, kind) {
        if (kind === "users") throw new Error("substrate exploded");
        return { ok: true, value: 9 };
      },
    });
    const res = await runMetricSweep(logger, deps, NOW);
    expect(res.errors).toBe(1);
    expect(res.measured).toBe(2);
    expect(res.tenants_swept).toBe(2);
  });
});

describe("google_ads metrics (added 2026-09-05)", () => {
  it("measures spend and CPA from ONE read, like Meta", async () => {
    const deps = makeDeps();
    const out = await sweepTenantMetrics("t1", new Set(["google_ads"]), NOW, deps, logger);
    expect(deps.calls.google).toEqual(["t1"]);
    expect(out.measured).toBe(2);
  });

  it("reports a gap rather than a CPA when there were no conversions", async () => {
    const deps = makeDeps({
      async readGoogleAds7d() {
        return { ok: true, spend: 500, conversions: 0 };
      },
    });
    const out = await sweepTenantMetrics("t1", new Set(["google_ads"]), NOW, deps, logger);
    expect(out.measured).toBe(1);
    expect(out.unavailable).toBe(1);
  });

  it("does not touch google metrics for a tenant without the connector", async () => {
    const deps = makeDeps();
    await sweepTenantMetrics("t1", new Set(["meta_ads"]), NOW, deps, logger);
    expect(deps.calls.google).toEqual([]);
  });
});

describe("realSweepDeps.readGoogleAds7d — sums the rows list_campaigns actually returns", () => {
  it("reads spend from `spend_usd` (the Google row shape) over ALL campaigns in the last 7 days", async () => {
    callGoogleAdsTool.mockResolvedValue({
      ok: true,
      is_error: false,
      ms: 1,
      content: JSON.stringify({
        campaigns: [
          { campaign_id: "1", spend_usd: 120.5, conversions: 3 },
          { campaign_id: "2", spend_usd: 79.5, conversions: 1 },
        ],
      }),
    });
    await expect(realSweepDeps.readGoogleAds7d("t1")).resolves.toEqual({
      ok: true,
      spend: 200,
      conversions: 4,
    });
    expect(callGoogleAdsTool).toHaveBeenCalledWith({ tenant_id: "t1" }, "list_campaigns", {
      custom_range: expect.objectContaining({ since: expect.any(String), until: expect.any(String) }),
      status: "ALL",
    });
  });

  it("reports a gap, not $0, when the read fails", async () => {
    callGoogleAdsTool.mockResolvedValue({ ok: false, is_error: true, ms: 1, content: "{}" });
    await expect(realSweepDeps.readGoogleAds7d("t1")).resolves.toEqual({
      ok: false,
      reason: "google_ads_read_failed",
    });
  });
});

describe("operator-DB sweep reads only through a CONFIRMED mapping", () => {
  const driver = {
    query_new_users_in_window: vi.fn(async () => ({ ok: true, data: { available: true, count: 9, window_days: 7 } })),
    query_new_bookings_in_range: vi.fn(async () => ({ ok: true, data: { available: true, count: 3, since: "", until: "" } })),
  };

  beforeEach(() => {
    resolveConfirmedOperatorDb.mockReset();
    driver.query_new_users_in_window.mockClear();
  });

  it("unconfirmed -> an honest gap (mapping_not_confirmed), no query", async () => {
    resolveConfirmedOperatorDb.mockResolvedValue({ ok: false, reason: "needs_confirmation", message: "x" });
    await expect(realSweepDeps.readOperatorCount7d("t1", "users")).resolves.toEqual({
      ok: false,
      reason: "mapping_not_confirmed",
    });
    await expect(realSweepDeps.readCountInRange("t1", "bookings", "a", "b")).resolves.toBeNull();
    expect(driver.query_new_users_in_window).not.toHaveBeenCalled();
    expect(resolveConfirmedOperatorDb).toHaveBeenCalledWith({ tenant_id: "t1", caller: { kind: "background", feature: "Metric sweep" } }, "users");
  });

  it("confirmed -> reads through the confirmed driver", async () => {
    const close = vi.fn(async () => undefined);
    resolveConfirmedOperatorDb.mockResolvedValue({ ok: true, driver, cfg: {}, confirmed_at: "", table: "users", created_at_field: null, close });
    await expect(realSweepDeps.readOperatorCount7d("t1", "users")).resolves.toEqual({ ok: true, value: 9 });
    await expect(realSweepDeps.readCountInRange("t1", "bookings", "a", "b")).resolves.toBe(3);
    expect(close).toHaveBeenCalledTimes(2);
  });
});

describe("closed weeks in the tenant's reporting time zone", () => {
  it("UTC gives exactly the old UTC weeks", () => {
    expect(lastClosedCalendarWeeksInTz(NOW, 12, "UTC")).toEqual(lastClosedCalendarWeeks(NOW, 12));
  });

  it("New York weeks start at local Monday midnight", () => {
    const w = lastClosedCalendarWeeksInTz(NOW, 1, "America/New_York");
    expect(w).toEqual([{ window_start: "2026-06-22T04:00:00.000Z", window_end: "2026-06-29T04:00:00.000Z" }]);
  });

  it("the backfill asks deps for the tenant zone and uses it", async () => {
    const deps = makeDeps({ resolveTimezone: vi.fn(async () => "America/New_York") });
    mocks.state.historyRowsByKey = {};
    await backfillClosedWeeks("t1", NOW, deps, logger);
    const first = deps.calls.range[0];
    expect(first[2]).toMatch(/T04:00:00.000Z$/);
  });
});

describe("realSweepDeps.readMetaAds7d — the same 7 full days Google reads (B5)", () => {
  it("reads the 7 full days ending yesterday, never a partial today", async () => {
    const { readMetaSnapshot } = await import("@/services/growth/action-outcomes");
    const { metaAdsCreds } = await import("@/services/tools/meta-ads/_client");
    (metaAdsCreds as ReturnType<typeof vi.fn>).mockResolvedValue({ ad_account_id: "act_1" });
    (readMetaSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue({ spend: 70, conversions: 7 });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T15:00:00Z"));
    try {
      await expect(realSweepDeps.readMetaAds7d("t1")).resolves.toEqual({ ok: true, spend: 70, conversions: 7 });
    } finally {
      vi.useRealTimers();
    }
    expect(readMetaSnapshot).toHaveBeenCalledWith("t1", "act_1", "2026-09-21", "2026-09-27");
  });
});
