export const MIN_CELL_DEFAULT = 5;
export const WINDOW_WEEKS_DEFAULT = 13;

export type Confidence = "high" | "medium" | "low" | "none";

import type { BalanceLabel } from "./balance";

export type { BalanceLabel } from "./balance";

export interface GeoWeekCell {
  tenant_id: string;
  state: string | null;
  geo_label: string;
  week_start: string;
  bookings_n: number;
  active_supply_n: number;
  gmv_proxy_n: number | null;
  demand_basis: "bookings" | "intent_events";
  supply_basis: "booked_listings" | "listing_status";
  confidence: Confidence;
  suppressed: boolean;
}

export interface SupplySnapshot {
  tenant_id: string;
  state: string | null;
  geo_label: string;
  total_listings: number;
  completed_listings: number;
  basis: "listing_status";
  confidence: Confidence;
  as_of: string;
}

export interface MarketplaceRegion {
  region_key: string;
  region_label: string;
  state: string | null;
  bookings_n: number;
  active_supply_n: number;
  total_listings: number | null;
  completed_listings: number | null;
  balance_label: BalanceLabel;
  demand_index: number | null;
  confidence: Confidence;
  suppressed: boolean;
}

export interface MarketplaceIntel {
  tenant_id: string;
  configured: boolean;
  as_of: string;
  window_weeks: number;
  min_cell: number;
  demand_basis: "bookings" | "intent_events";
  grouped_by: "us_state" | "location";
  supply_unit?: "listings_created" | "listings" | "active_sellers" | null;
  active_supply_unit?: "listings" | "sellers" | null;
  regions: MarketplaceRegion[];
  weeks: Array<{ week_start: string; bookings_n: number; active_supply_n: number }>;
  provenance: { source: string; validated: boolean; caveats: string[]; confirmed_at?: string; setup_id?: string };
  total: { bookings_n: number; active_supply_n: number; total_listings: number | null };
}

export type LocationSource = "order" | "listing" | "user" | "none";
export type SupplySource = "listings" | "sellers_on_orders" | "none";

export interface MarketplaceIntelConfig {
  tenant_id: string;
  dialect: "mongodb" | "postgres" | "mysql";
  location_source: LocationSource;
  supply_source: SupplySource;
  bookings: {
    table: string;
    created_at_field: string;
    geo_field: string | null;
    listing_ref_field: string | null;
    seller_ref_field: string | null;
    buyer_ref_field: string | null;
    gmv_proxy_field: string | null;
  };
  listings: {
    table: string;
    id_field: string;
    geo_field: string | null;
    listed_at_field: string | null;
  } | null;
  location_table: { table: string; id_field: string; geo_field: string } | null;
  category: {
    source: "none_on_trips";
    note: string;
  };
  intent_events: {
    search: string | null;
    view: string | null;
    contact: string | null;
  };
  provenance: {
    source: string;
    validated: boolean;
    confirmed_at?: string;
    setup_id?: string;
  };
}
