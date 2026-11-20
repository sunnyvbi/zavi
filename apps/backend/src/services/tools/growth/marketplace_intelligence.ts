
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { serviceClient } from "@/services/supabase";
import { getBoolSetting, getSetting } from "@/services/settings";
import {
  MIN_CELL_DEFAULT,
  WINDOW_WEEKS_DEFAULT,
  type Confidence,
  type GeoWeekCell,
  type MarketplaceIntel,
  type SupplySnapshot,
} from "@/services/marketplace-intel/contract";
import {
  assembleIntel,
  MARKETPLACE_INTEL_CAVEATS,
  activeSupplyUnitOf,
  regionKeyOf,
  supplyUnitOf,
} from "@/services/marketplace-intel/aggregate";
import { normalizeLocation } from "@/services/marketplace-intel/regions";
import { resolveMarketplaceConfig } from "@/services/marketplace-intel/self-serve";

const HONESTY_CAVEAT = "booking-based demand, not unmet demand";

const inputSchema = z.object({
  window_weeks: z.number().int().min(1).max(104).default(WINDOW_WEEKS_DEFAULT),
  min_cell: z.number().int().min(1).max(1000).default(MIN_CELL_DEFAULT),
  focus_region: z.string().trim().min(1).optional(),
});

export type MarketplaceIntelNotConfigured = {
  configured: false;
  tenant_id: string;
  message?: string;
};

export type MarketplaceIntelReadResult = MarketplaceIntel | MarketplaceIntelNotConfigured;

export type MarketplaceIntelReadOpts = z.infer<typeof inputSchema>;

type RollupRow = {
  tenant_id: string;
  state: string | null;
  geo_label: string | null;
  week_start: string;
  bookings_n: number | string | null;
  active_supply_n: number | string | null;
  total_listings: number | string | null;
  completed_listings: number | string | null;
  gmv_proxy_n: number | string | null;
  demand_basis: string | null;
  supply_basis: string | null;
  confidence: string | null;
  suppressed: boolean | null;
  computed_at: string | null;
};

function confidenceOf(value: unknown): Confidence {
  return value === "high" || value === "medium" || value === "low" || value === "none"
    ? value
    : "low";
}

function capBookingConfidence(confidence: Confidence): Confidence {
  return confidence === "high" ? "medium" : confidence;
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function windowStartDate(window_weeks: number): string {
  const d = new Date();
  const day = d.getUTCDay() || 7;
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - day + 1 - (window_weeks - 1) * 7);
  return dateOnly(d);
}

function toNumber(value: number | string | null | undefined, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toGmv(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toNullableNumber(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function mapRollupRow(row: RollupRow, tenant_id: string, min_cell: number): GeoWeekCell {
  const bookings_n = toNumber(row.bookings_n);
  return {
    tenant_id,
    state: row.state ?? null,
    geo_label: row.geo_label ?? row.state ?? "",
    week_start: String(row.week_start).slice(0, 10),
    bookings_n,
    active_supply_n: toNumber(row.active_supply_n),
    gmv_proxy_n: toGmv(row.gmv_proxy_n),
    demand_basis: row.demand_basis === "intent_events" ? "intent_events" : "bookings",
    supply_basis: row.supply_basis === "listing_status" ? "listing_status" : "booked_listings",
    confidence:
      row.demand_basis === "intent_events"
        ? confidenceOf(row.confidence)
        : capBookingConfidence(confidenceOf(row.confidence)),
    suppressed: row.suppressed === true || bookings_n < min_cell,
  };
}

function maxComputedAt(rows: RollupRow[]): string | undefined {
  const values = rows
    .map((row) => row.computed_at)
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort();
  return values.at(-1);
}

function supplySnapshotsFromRollup(
  rows: RollupRow[],
  tenant_id: string,
  fallbackAsOf: string,
): SupplySnapshot[] {
  const byRegion = new Map<string, SupplySnapshot>();

  for (const row of rows) {
    const completed_listings = toNullableNumber(row.completed_listings);
    if (completed_listings == null) continue;

    const total_listings = toNullableNumber(row.total_listings);
    if (total_listings == null) continue;

    const geo_label = row.geo_label ?? row.state ?? "";
    const regionKey = regionKeyOf({ state: row.state ?? null, geo_label });
    if (byRegion.has(regionKey)) continue;

    byRegion.set(regionKey, {
      tenant_id,
      state: row.state ?? null,
      geo_label,
      total_listings,
      completed_listings,
      basis: "listing_status",
      confidence: "medium",
      as_of: row.computed_at ?? fallbackAsOf,
    });
  }

  return [...byRegion.values()].sort((a, b) => a.geo_label.localeCompare(b.geo_label));
}

async function rowsAreCurrentForSetup(tenant_id: string, setupId: string | undefined): Promise<boolean> {
  if (!setupId) return false;
  try {
    const lastRun = (await getSetting("marketplace_rollup_last_run", tenant_id)) as
      | { status?: string; setup_id?: string }
      | null
      | undefined;
    return lastRun?.status === "ok" && lastRun.setup_id === setupId;
  } catch {
    return false;
  }
}

const SUPPLY_UNIT_CAVEAT: Record<string, string | null> = {
  listings_created: "supply is the listings created in the same window as the orders",
  listings: "supply is every current listing, whatever its status",
  active_sellers:
    "supply is the sellers or providers with at least one order at that location in the window, so a location with no orders shows no supply",
  none: null,
};

export async function getMarketplaceIntel(
  tenant_id: string,
  opts: Partial<MarketplaceIntelReadOpts> = {},
): Promise<MarketplaceIntelReadResult> {
  const parsed = inputSchema.parse(opts);

  if (!(await getBoolSetting("marketplace_intel_enabled", tenant_id))) {
    return {
      configured: false,
      tenant_id,
      message: "marketplace intelligence disabled",
    };
  }

  const cfg = await resolveMarketplaceConfig(tenant_id);
  if (!cfg) {
    return {
      configured: false,
      tenant_id,
      message: "marketplace intelligence not configured",
    };
  }

  if (!(await rowsAreCurrentForSetup(tenant_id, cfg.provenance.setup_id))) {
    const unmeasured = assembleIntel([], [], {
      tenant_id,
      configured: true,
      as_of: new Date().toISOString(),
      window_weeks: parsed.window_weeks,
      min_cell: parsed.min_cell,
      provenance: cfg.provenance,
    });
    unmeasured.provenance.caveats = [
      "no numbers yet: no calculation has finished for this setup, so every figure here is 0 because nothing was measured — NOT because there were no orders",
    ];
    return unmeasured;
  }

  const query = serviceClient()
    .from("marketplace_geo_category_weekly")
    .select(
      "tenant_id,state,geo_label,week_start,bookings_n,active_supply_n,total_listings,completed_listings,gmv_proxy_n,demand_basis,supply_basis,confidence,suppressed,computed_at",
    )
    .eq("tenant_id", tenant_id)
    .gte("week_start", windowStartDate(parsed.window_weeks))
    .order("week_start", { ascending: true });

  const { data, error } = await query;
  if (error) throw new Error(`marketplace rollup read failed: ${error.message}`);

  const rows = Array.isArray(data) ? (data as RollupRow[]) : [];
  const cells = rows.map((row) => mapRollupRow(row, tenant_id, parsed.min_cell));
  const as_of = maxComputedAt(rows) ?? new Date().toISOString();
  const supply_unit = supplyUnitOf(cfg);

  const supplyWindowMatches = parsed.window_weeks === WINDOW_WEEKS_DEFAULT;
  const supplySnapshots = supplyWindowMatches ? supplySnapshotsFromRollup(rows, tenant_id, as_of) : [];

  const labels_allowed = supplyWindowMatches && supply_unit !== "active_sellers";

  const intel = assembleIntel(cells, supplySnapshots, {
    tenant_id,
    configured: true,
    as_of,
    window_weeks: parsed.window_weeks,
    min_cell: parsed.min_cell,
    provenance: cfg.provenance,
    labels_allowed,
  });

  intel.supply_unit = supply_unit;
  const supplyCaveat = SUPPLY_UNIT_CAVEAT[intel.supply_unit ?? "none"];
  intel.provenance.caveats = intel.provenance.caveats.flatMap((c) =>
    c === MARKETPLACE_INTEL_CAVEATS[1] ? (supplyCaveat ? [supplyCaveat] : []) : [c],
  );
  if (!labels_allowed) {
    intel.provenance.caveats = intel.provenance.caveats.filter((c) => c !== MARKETPLACE_INTEL_CAVEATS[3]);
    intel.provenance.caveats.push(
      !supplyWindowMatches
        ? `supply is measured over the last ${WINDOW_WEEKS_DEFAULT} weeks, so this ${parsed.window_weeks}-week view shows orders only and compares no locations`
        : "locations are not compared: supply here is counted from the orders themselves, so a seller with no orders is invisible and a busy location cannot be told from one that is short of supply",
    );
  }

  const focus = parsed.focus_region ? normalizeLocation(parsed.focus_region) : "";
  if (focus) {
    intel.regions = intel.regions.filter(
      (region) =>
        normalizeLocation(region.region_key) === focus ||
        normalizeLocation(region.region_label) === focus,
    );
  }
  intel.active_supply_unit = activeSupplyUnitOf(cfg);
  if (intel.active_supply_unit === "listings") {
    intel.provenance.caveats.push(
      "booked listing-weeks: each listing counts once for every week it had a booking, so the total can be higher than your listing count",
    );
  } else if (intel.active_supply_unit === "sellers") {
    intel.provenance.caveats.push(
      "seller-weeks with orders: each seller or provider counts once for every week they had an order, so the total can be higher than your number of sellers",
    );
  }

  if (!intel.provenance.caveats.includes(HONESTY_CAVEAT)) {
    intel.provenance.caveats.push(HONESTY_CAVEAT);
  }

  return intel;
}

export const marketplaceIntelligenceTool: ToolSpec = {
  name: "growth_marketplace_intelligence",
  effect: "read",
  description:
    "Read Supply & Demand from the tenant's precomputed location/week rollup: orders and supply per location, and a balance label that compares each location with the tenant's other locations (demand_heavy / supply_heavy / balanced, or not_enough_locations / insufficient_data / supply_unknown when there is nothing honest to compare). Read-only — never connects to the live operator DB and never implies unmet demand; demand is order-based.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const parsed = inputSchema.parse(input);
    return getMarketplaceIntel(ctx.tenant_id, parsed);
  },
};
