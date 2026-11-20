
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import {
  MIN_CELL_DEFAULT,
  WINDOW_WEEKS_DEFAULT,
  type BalanceLabel,
  type Confidence,
  type MarketplaceIntel,
} from "@/services/marketplace-intel/contract";
import { getMarketplaceIntel } from "@/services/tools/growth/marketplace_intelligence";

const METRIC = "realized_order_pressure" as const;
export const LIQUIDITY_METRIC_CAVEAT =
  "Realized order pressure (orders per unit of supply, compared with this marketplace's other locations) — a SUPPLY-PRESSURE PROXY, NOT true unmet demand. " +
  "A high demand_index flags locations whose supply gets more orders than supply elsewhere does (supply may be the constraint there). " +
  "It CANNOT see zero-order / failed-search / out-of-stock locations: a location where buyers searched but found " +
  "nothing shows LOW orders and looks demand-limited here. True unmet demand needs search-intent data (not wired yet).";

const inputSchema = z.object({
  min_cell: z.number().int().min(1).max(1000).default(MIN_CELL_DEFAULT),
  focus_region: z.string().trim().min(1).optional(),
});

export type LiquidityGapGeo = {
  region_key: string;
  region_label: string;
  state: string | null;
  bookings_n: number;
  completed_listings: number | null;
  active_supply_n: number;
  weekly_bookings_per_bookable_listing: number | null;
  demand_index: number | null;
  balance_label: BalanceLabel;
  confidence: Confidence;
  suppressed: boolean;
};

export type LiquidityGapAvailable = {
  available: true;
  tenant_id: string;
  as_of: string;
  window_weeks: number;
  metric: typeof METRIC;
  metric_caveat: string;
  supply_unit: MarketplaceIntel["supply_unit"] | null;
  geos: LiquidityGapGeo[];
  provenance: MarketplaceIntel["provenance"];
};

export type LiquidityGapNotAvailable = {
  available: false;
  tenant_id: string;
  reason: "liquidity_not_available" | "no_rollup_data";
  message: string;
};

export type LiquidityGapResult = LiquidityGapAvailable | LiquidityGapNotAvailable;

function weeklyBookingsPerBookableListing(
  bookings_n: number,
  completed_listings: number | null,
  window_weeks: number,
): number | null {
  if (completed_listings == null || completed_listings <= 0) return null;
  return bookings_n / Math.max(1, window_weeks) / completed_listings;
}

export async function getLiquidityGap(
  tenant_id: string,
  opts: Partial<z.infer<typeof inputSchema>> = {},
): Promise<LiquidityGapResult> {
  const parsed = inputSchema.parse(opts);

  const intel = await getMarketplaceIntel(tenant_id, parsed);

  if (!("regions" in intel)) {
    return {
      available: false,
      tenant_id,
      reason: "liquidity_not_available",
      message:
        intel.message ??
        "No marketplace rollup for this tenant — treat liquidity/supply as a manual operator lever.",
    };
  }

  const geos: LiquidityGapGeo[] = intel.regions.map((region) => ({
    region_key: region.region_key,
    region_label: region.region_label,
    state: region.state,
    bookings_n: region.bookings_n,
    completed_listings: region.completed_listings,
    active_supply_n: region.active_supply_n,
    weekly_bookings_per_bookable_listing: weeklyBookingsPerBookableListing(
      region.bookings_n,
      region.completed_listings,
      intel.window_weeks,
    ),
    demand_index: region.demand_index,
    balance_label: region.balance_label,
    confidence: region.confidence,
    suppressed: region.suppressed,
  }));

  if (geos.length === 0) {
    return {
      available: false,
      tenant_id,
      reason: "no_rollup_data",
      message:
        "Marketplace rollup has no rows for this window yet — cannot assess supply pressure. Treat supply as a manual operator lever.",
    };
  }

  return {
    available: true,
    tenant_id,
    as_of: intel.as_of,
    window_weeks: intel.window_weeks,
    metric: METRIC,
    metric_caveat: LIQUIDITY_METRIC_CAVEAT,
    supply_unit: intel.supply_unit ?? null,
    geos,
    provenance: intel.provenance,
  };
}

export const liquidityGapTool: ToolSpec = {
  name: "growth_liquidity_gap",
  effect: "read",
  description:
    "Read per-location REALIZED order pressure (orders per unit of supply, compared with the tenant's other locations via demand_index) from the tenant's precomputed marketplace rollup. " +
    "This is a SUPPLY-PRESSURE PROXY, NOT true unmet demand — it cannot see zero-order / failed-search / out-of-stock locations. " +
    "Use it to spot locations whose supply is clearly busier than elsewhere (supply may be the constraint); do NOT read it as unmet demand. " +
    "supply_unit says what one unit of supply IS for this tenant (listings, listings created in the window, or sellers with an order); quote the number in those words. " +
    "The window is fixed to the one the rollup measures supply over — there is no window argument. " +
    "Returns available:false (no throw) when the tenant has no marketplace rollup (reason: liquidity_not_available) OR is configured but the rollup has no rows for this window yet (reason: no_rollup_data) — in either case treat supply as a manual operator lever, and NEVER read an absent result as 'no supply pressure anywhere'.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const parsed = inputSchema.parse(input);
    return getLiquidityGap(ctx.tenant_id, parsed);
  },
};
