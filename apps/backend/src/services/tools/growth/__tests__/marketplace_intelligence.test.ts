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

vi.mock("@/services/marketplace-intel/self-serve", () => ({
  resolveMarketplaceConfig: vi.fn(() =>
    Promise.resolve({
      tenant_id: TENANT,
      dialect: "postgres",
      bookings: { table: "jobs", created_at_field: "created_at", geo_field: "suburb", listing_ref_field: "provider_id", gmv_proxy_field: null },
      listings: { table: "providers", id_field: "id", status_field: null, geo_field: "suburb" },
      category: { source: "none_on_trips", note: "test" },
      intent_events: { search: null, view: null, contact: null },
      provenance: { source: "self_serve_confirmed", validated: true, setup_id: "setup-1" },
    }),
  ),
}));

const TENANT = "00000000-0000-4000-8000-000000000002";

import { getMarketplaceIntel } from "../marketplace_intelligence";
import { resolveMarketplaceConfig } from "@/services/marketplace-intel/self-serve";
import type { MarketplaceIntel } from "@/services/marketplace-intel/contract";

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
    tenant_id: TENANT,
    state: null,
    geo_label,
    week_start,
    bookings_n,
    active_supply_n: 1,
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

describe("growth marketplace intelligence tool", () => {
  it("rebuilds per-location supply from persisted rows and labels locations against each other", async () => {
    mockState.result = {
      data: [
        row("Manchester", recentWeek(2), 30, 20),
        row("Manchester", recentWeek(1), 30, 20),
        row("Leeds", recentWeek(2), 18, 20),
        row("Bristol", recentWeek(2), 16, 20),
        row("Sheffield", recentWeek(2), 4, 20),
        row("Cardiff", recentWeek(2), 6, null),
        row("__marketplace_total__", recentWeek(2), 0, 70),
      ],
      error: null,
    };

    const out = await getMarketplaceIntel(TENANT, { min_cell: 1 });

    expect(mockState.calls.from).toEqual([["marketplace_geo_category_weekly"]]);
    expect(mockState.calls.select?.[0]?.[0]).toContain("completed_listings");
    expect(mockState.calls.is).toBeUndefined();
    expect(mockState.calls.eq?.map((args) => args[0])).toEqual(["tenant_id"]);

    const intel = out as MarketplaceIntel;
    expect(intel.total).toMatchObject({ bookings_n: 104, total_listings: 70 });
    const by = Object.fromEntries(intel.regions.map((r) => [r.region_label, r]));
    expect(by.Manchester).toMatchObject({ bookings_n: 60, completed_listings: 20, balance_label: "demand_heavy" });
    expect(by.Sheffield?.balance_label).toBe("supply_heavy");
    expect(by.Cardiff).toMatchObject({ completed_listings: null, balance_label: "supply_unknown" });
  });

  it("focus_region narrows the answer AFTER labelling, so the label does not change", async () => {
    mockState.result = {
      data: [
        row("Manchester", recentWeek(2), 60, 20),
        row("Leeds", recentWeek(2), 18, 20),
        row("Bristol", recentWeek(2), 16, 20),
        row("Sheffield", recentWeek(2), 4, 20),
      ],
      error: null,
    };
    const all = (await getMarketplaceIntel(TENANT, { min_cell: 1 })) as MarketplaceIntel;
    const focused = (await getMarketplaceIntel(TENANT, {
      min_cell: 1,
      focus_region: " manchester ",
    })) as MarketplaceIntel;
    expect(focused.regions).toHaveLength(1);
    expect(focused.regions[0]?.balance_label).toBe(
      all.regions.find((r) => r.region_label === "Manchester")?.balance_label,
    );
    expect(focused.regions[0]?.balance_label).toBe("demand_heavy");
  });

  it("a window other than the rollup's own shows orders only, and compares nothing", async () => {
    mockState.result = {
      data: [
        row("Manchester", recentWeek(2), 60, 20),
        row("Leeds", recentWeek(2), 18, 20),
        row("Bristol", recentWeek(2), 16, 20),
      ],
      error: null,
    };
    const intel = (await getMarketplaceIntel(TENANT, { window_weeks: 4, min_cell: 1 })) as MarketplaceIntel;
    expect(intel.regions.every((r) => r.balance_label === "not_compared")).toBe(true);
    expect(intel.regions.every((r) => r.completed_listings === null)).toBe(true);
    expect(intel.total.bookings_n).toBe(94);
    expect(intel.provenance.caveats.some((c) => c.includes("13 weeks") && c.includes("orders only"))).toBe(true);
  });

  it("returns no numbers when the stored rows were computed for a different or failed setup", async () => {
    mockState.result = { data: [row("Manchester", "2026-06-08", 60, 20)], error: null };
    for (const lastRun of [
      { status: "ok", setup_id: "setup-from-another-database" },
      { status: "failed", setup_id: "setup-1" },
      null,
    ]) {
      mockState.lastRun = lastRun;
      const intel = (await getMarketplaceIntel(TENANT, { window_weeks: 104, min_cell: 1 })) as MarketplaceIntel;
      expect(intel.configured).toBe(true);
      expect(intel.regions).toEqual([]);
      expect(intel.total.bookings_n).toBe(0);
      expect(intel.provenance.caveats.join(" ")).toMatch(/nothing was measured/i);
    }
    expect(mockState.calls.from).toBeUndefined();
  });

  it("describes the weekly count and supply in the unit this setup uses (sellers, not listings)", async () => {
    vi.mocked(resolveMarketplaceConfig).mockResolvedValueOnce({
      tenant_id: TENANT,
      dialect: "mysql",
      location_source: "user",
      supply_source: "sellers_on_orders",
      bookings: { table: "jobs", created_at_field: "booked_at", geo_field: null, listing_ref_field: null, seller_ref_field: "provider_id", buyer_ref_field: "customer_id", gmv_proxy_field: null },
      listings: null,
      location_table: { table: "accounts", id_field: "id", geo_field: "suburb" },
      category: { source: "none_on_trips", note: "test" },
      intent_events: { search: null, view: null, contact: null },
      provenance: { source: "self_serve_confirmed", validated: true, setup_id: "setup-1" },
    } as never);
    mockState.result = { data: [row("Leeds", "2026-06-08", 18, 6)], error: null };
    const intel = (await getMarketplaceIntel(TENANT, { window_weeks: 104, min_cell: 1 })) as MarketplaceIntel;
    expect(intel.supply_unit).toBe("active_sellers");
    expect(intel.active_supply_unit).toBe("sellers");
    const caveats = intel.provenance.caveats.join(" | ");
    expect(caveats).toContain("sellers or providers with at least one order");
    expect(caveats).toContain("seller-weeks with orders");
    expect(caveats).not.toContain("booked listing-weeks");
    expect(caveats).not.toContain("supply is the listings you have");
  });
});
