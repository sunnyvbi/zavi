import { describe, it, expect, vi, beforeEach } from "vitest";

type BuilderResult = { data: unknown[] | null; error: { message: string } | null };
const mockState = vi.hoisted(() => ({
  calls: {} as Record<string, unknown[][]>,
  result: { data: [], error: null } as BuilderResult,
  enabled: true,
  lastRun: { status: "ok", setup_id: "setup-1" } as Record<string, unknown> | null,
}));

function makeBuilder() {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "gte", "order", "is"]) {
    b[m] = vi.fn((...args: unknown[]) => {
      (mockState.calls[m] ??= []).push(args);
      return b;
    });
  }
  b.then = (resolve: (v: BuilderResult) => unknown) => resolve(mockState.result);
  return b;
}

vi.mock("@/services/settings", () => ({
  getBoolSetting: vi.fn(() => Promise.resolve(mockState.enabled)),
  getSetting: vi.fn(() => Promise.resolve(mockState.lastRun)),
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: vi.fn((table: string) => {
      (mockState.calls.from ??= []).push([table]);
      return makeBuilder();
    }),
  }),
}));

const CONFIGURED = "00000000-0000-4000-8000-000000000003";
vi.mock("@/services/marketplace-intel/self-serve", () => ({
  resolveMarketplaceConfig: vi.fn((tenant_id: string) =>
    Promise.resolve(
      tenant_id === "00000000-0000-4000-8000-000000000003"
        ? {
            tenant_id,
            dialect: "mysql",
            bookings: { table: "orders", created_at_field: "created_at", geo_field: "province", listing_ref_field: "sku", gmv_proxy_field: null },
            listings: { table: "stock", id_field: "sku", status_field: null, geo_field: "province" },
            category: { source: "none_on_trips", note: "test" },
            intent_events: { search: null, view: null, contact: null },
            provenance: { source: "self_serve_confirmed", validated: true, setup_id: "setup-1" },
          }
        : null,
    ),
  ),
}));

import {
  getLiquidityGap,
  LIQUIDITY_METRIC_CAVEAT,
  type LiquidityGapAvailable,
  type LiquidityGapNotAvailable,
} from "../liquidity_gap";

beforeEach(() => {
  for (const k of Object.keys(mockState.calls)) delete mockState.calls[k];
  mockState.result = { data: [], error: null };
  mockState.enabled = true;
  mockState.lastRun = { status: "ok", setup_id: "setup-1" };
});

function recentWeek(weeksAgo: number): string {
  const d = new Date(Date.now() - weeksAgo * 7 * 86400000);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

function row(geo_label: string, week_start: string, bookings_n: number, supply: number | null) {
  return {
    tenant_id: CONFIGURED,
    state: null,
    geo_label,
    week_start,
    bookings_n,
    active_supply_n: 2,
    total_listings: supply,
    completed_listings: supply,
    gmv_proxy_n: null,
    demand_basis: "bookings",
    supply_basis: "booked_listings",
    confidence: "medium",
    suppressed: false,
    computed_at: "2026-06-30T18:00:00.000Z",
  };
}

describe("growth liquidity_gap tool", () => {
  it("returns per-location order pressure from the marketplace rollup, labelled against the other locations", async () => {
    mockState.result = {
      data: [
        row("Ontario", recentWeek(2), 40, 30),
        row("Ontario", recentWeek(1), 44, 30),
        row("Quebec", recentWeek(2), 30, 30),
        row("Alberta", recentWeek(2), 28, 30),
        row("Manitoba", recentWeek(2), 6, 30),
        row("Yukon", recentWeek(2), 9, null),
      ],
      error: null,
    };

    const out = (await getLiquidityGap(CONFIGURED, { min_cell: 1 })) as LiquidityGapAvailable;

    expect(mockState.calls.from).toEqual([["marketplace_geo_category_weekly"]]);

    expect(out.available).toBe(true);
    expect(out.metric).toBe("realized_order_pressure");
    expect(out.metric_caveat).toBe(LIQUIDITY_METRIC_CAVEAT);
    expect(out.metric_caveat).toContain("SUPPLY-PRESSURE PROXY");
    expect(out.metric_caveat).toContain("NOT true unmet demand");

    const ontario = out.geos.find((g) => g.region_label === "Ontario");
    expect(ontario).toMatchObject({
      state: null,
      bookings_n: 84,
      completed_listings: 30,
      active_supply_n: 4,
      balance_label: "demand_heavy",
    });
    expect(ontario!.demand_index).toBeGreaterThan(1.5);
    expect(ontario!.weekly_bookings_per_bookable_listing).toBeCloseTo(84 / 13 / 30, 6);
    expect(out.geos.find((g) => g.region_label === "Manitoba")?.balance_label).toBe("supply_heavy");

    expect(out.geos.find((g) => g.region_label === "Yukon")).toMatchObject({
      completed_listings: null,
      weekly_bookings_per_bookable_listing: null,
      demand_index: null,
      balance_label: "supply_unknown",
    });
  });

  it("returns the not_available shape (no throw) when the tenant has no rollup", async () => {
    mockState.enabled = false;

    const out = (await getLiquidityGap(
      "11111111-1111-1111-1111-111111111111",
    )) as LiquidityGapNotAvailable;

    expect(out.available).toBe(false);
    expect(out.reason).toBe("liquidity_not_available");
    expect(typeof out.message).toBe("string");
  });

  it("returns not_available for a tenant with no Supply & Demand setup", async () => {
    mockState.enabled = true;

    const out = (await getLiquidityGap(
      "22222222-2222-2222-2222-222222222222",
    )) as LiquidityGapNotAvailable;

    expect(out.available).toBe(false);
    expect(out.reason).toBe("liquidity_not_available");
  });

  it("returns not_available(no_rollup_data) — not available:true with empty geos — when configured but the rollup has zero rows", async () => {
    mockState.enabled = true;
    mockState.result = { data: [], error: null };

    const out = (await getLiquidityGap(CONFIGURED)) as LiquidityGapNotAvailable;

    expect(out.available).toBe(false);
    expect(out.reason).toBe("no_rollup_data");
    expect(out.message).toMatch(/no rows for this window/i);
  });
});
