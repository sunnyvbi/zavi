import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const mockState = vi.fn();
vi.mock("./dashboard-ui", async () => {
  const actual = await vi.importActual<typeof import("./dashboard-ui")>(
    "./dashboard-ui",
  );
  return { ...actual, useAgentDashboard: () => mockState() };
});

import { MarketplaceDashboard } from "./MarketplaceDashboard";

const base = {
  loading: false,
  refreshing: false,
  error: null,
  refresh: () => {},
};

describe("MarketplaceDashboard", () => {
  it("does NOT crash on a not-configured payload (missing provenance/us_total)", () => {
    mockState.mockReturnValue({ ...base, data: { configured: false, tenant_id: "t1" } });
    let html = "";
    expect(() => {
      html = renderToStaticMarkup(<MarketplaceDashboard />);
    }).not.toThrow();
    expect(html).toContain("not configured");
  });

  it("renders locations from the region-shaped payload, with no US or state wording", () => {
    mockState.mockReturnValue({
      ...base,
      data: {
        generic: false,
        tenant_id: "t-goods",
        configured: true,
        as_of: "2026-06-30T00:00:00.000Z",
        window_weeks: 13,
        min_cell: 5,
        demand_basis: "bookings",
        grouped_by: "location",
        regions: [
          { region_key: "lagos", region_label: "Lagos", state: null, bookings_n: 36, active_supply_n: 30, total_listings: 40, completed_listings: 40, balance_label: "demand_heavy", demand_index: 2.57, confidence: "medium", suppressed: false },
          { region_key: "kampala", region_label: "Kampala", state: null, bookings_n: 4, active_supply_n: 4, total_listings: 40, completed_listings: 40, balance_label: "supply_heavy", demand_index: 0.16, confidence: "medium", suppressed: true },
          { region_key: "__other__", region_label: "Other locations", state: null, bookings_n: 12, active_supply_n: 9, total_listings: null, completed_listings: null, balance_label: "not_compared", demand_index: null, confidence: "medium", suppressed: false },
        ],
        weeks: [{ week_start: "2026-04-06", bookings_n: 40, active_supply_n: 35 }],
        provenance: { source: "self_serve_confirmed", validated: true, caveats: ["booking-based demand, not unmet demand"] },
        total: { bookings_n: 52, active_supply_n: 43, total_listings: 80 },
      },
    });
    const html = renderToStaticMarkup(<MarketplaceDashboard />);
    expect(html).toContain("Lagos");
    expect(html).toContain("Busier than your other locations");
    expect(html).toContain("Quieter than your other locations");
    expect(html).toContain("Other locations");
    expect(html).not.toContain("Not compared");
    expect(html).not.toMatch(/\bUS\b|[Ss]tate\b/);
  });

  it("a sellers-as-supply setup names the weekly count in sellers, never listings", () => {
    mockState.mockReturnValue({
      ...base,
      data: {
        tenant_id: "t-services",
        configured: true,
        as_of: "2026-06-30T00:00:00.000Z",
        window_weeks: 13,
        min_cell: 5,
        demand_basis: "bookings",
        grouped_by: "location",
        supply_unit: "active_sellers",
        active_supply_unit: "sellers",
        regions: [
          { region_key: "leeds", region_label: "Leeds", state: null, bookings_n: 21, active_supply_n: 6, total_listings: 6, completed_listings: 6, balance_label: "balanced", demand_index: 1, confidence: "medium", suppressed: false },
        ],
        weeks: [{ week_start: "2026-06-08", bookings_n: 21, active_supply_n: 6 }],
        provenance: { source: "self_serve_confirmed", validated: true, caveats: [] },
        total: { bookings_n: 21, active_supply_n: 6, total_listings: 6 },
      },
    });
    const html = renderToStaticMarkup(<MarketplaceDashboard />);
    expect(html).toContain("Seller-weeks with orders");
    expect(html).toContain("Active sellers");
    expect(html).toContain("Bookings and sellers with orders, by week");
    expect(html).not.toMatch(/[Ll]isting/);
  });

  it("says nothing about listings when the setup measures no supply, and can be scrolled on a phone", () => {
    mockState.mockReturnValue({
      ...base,
      data: {
        generic: false,
        tenant_id: "t-rooms",
        configured: true,
        as_of: "2026-09-17T00:00:00.000Z",
        window_weeks: 13,
        min_cell: 5,
        demand_basis: "bookings",
        grouped_by: "location",
        supply_unit: null,
        active_supply_unit: null,
        regions: [
          { region_key: "auckland", region_label: "Auckland", state: null, bookings_n: 287, active_supply_n: 0, total_listings: null, completed_listings: null, balance_label: "supply_unknown", demand_index: null, confidence: "medium", suppressed: false },
        ],
        weeks: [{ week_start: "2026-09-07", bookings_n: 287, active_supply_n: 0 }],
        total: { bookings_n: 287, active_supply_n: 0, total_listings: null },
        provenance: { source: "self_serve_confirmed", validated: true, caveats: ["booking-based demand, not unmet demand"] },
      },
    });
    const html = renderToStaticMarkup(<MarketplaceDashboard />);
    expect(html).not.toMatch(/[Ll]isting/);
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("Change where these numbers come from");
  });

  it("offers a way back to the setup when a calculation failed on something other than the date", () => {
    mockState.mockReturnValue({
      ...base,
      data: {
        generic: false,
        tenant_id: "t-stuck",
        configured: true,
        as_of: "2026-09-17T00:00:00.000Z",
        window_weeks: 13,
        min_cell: 5,
        demand_basis: "bookings",
        grouped_by: "location",
        regions: [],
        weeks: [],
        total: { bookings_n: 0, active_supply_n: 0, total_listings: null },
        provenance: { source: "self_serve_confirmed", validated: true, caveats: [] },
        setup: { state: "calculation_failed", code: "too_much_data" },
      },
    });
    const html = renderToStaticMarkup(<MarketplaceDashboard />);
    expect(html).toContain("Change where these numbers come from");
  });

  it("still renders the older states/us_total payload during a staggered deploy", () => {
    mockState.mockReturnValue({
      ...base,
      data: {
        generic: false,
        tenant_id: "73db45ff",
        configured: true,
        as_of: "2026-06-30T00:00:00.000Z",
        window_weeks: 13,
        min_cell: 5,
        demand_basis: "bookings",
        states: [
          { state: "CA", geo_label: "CA", bookings_n: 657, active_supply_n: 500, total_listings: 1163, completed_listings: 1020, balance_label: "balanced", confidence: "medium", suppressed: false },
          { state: "FL", geo_label: "FL", bookings_n: 63, active_supply_n: 60, total_listings: 414, completed_listings: 320, balance_label: "supply_heavy", confidence: "medium", suppressed: false },
          { state: null, geo_label: "unknown_state", bookings_n: 69, active_supply_n: 45, total_listings: null, completed_listings: null, balance_label: "supply_unknown", confidence: "none", suppressed: false },
          { state: "MD", geo_label: "MD", bookings_n: 3, active_supply_n: 3, total_listings: 25, completed_listings: 25, balance_label: "insufficient_data", confidence: "medium", suppressed: true },
        ],
        weeks: [
          { week_start: "2026-04-06", bookings_n: 40, active_supply_n: 35 },
          { week_start: "2026-04-13", bookings_n: 55, active_supply_n: 48 },
        ],
        provenance: { source: "phase0_audit", validated: true, caveats: ["booking-based demand, not unmet demand"] },
        us_total: { bookings_n: 906, active_supply_n: 801, total_listings: 1989 },
      },
    });
    let html = "";
    expect(() => {
      html = renderToStaticMarkup(<MarketplaceDashboard />);
    }).not.toThrow();
    expect(html).toContain("Quieter than your other locations");
    expect(html).toContain("Other locations");
    expect(html).toContain("booking-based demand, not unmet demand");
  });
});
