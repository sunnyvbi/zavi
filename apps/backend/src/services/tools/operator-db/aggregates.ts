
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { withAttachedDriver, runSummary } from "@/services/data-gateway";
import { SummaryRequest } from "@zavi/shared/db-guard";
import { gatewayCtx } from "./gateway-ctx";
import { getCatalog } from "./catalog";
import type { VerifiedOrderMap } from "./types";
import { getOutcomeMap } from "@/services/growth/booking-metrics/outcomes";

export const SAFE_GEO_CATEGORY_RE = /^[a-zA-Z0-9 ,'\-]{1,80}$/;

const aggregateFilterShape = {
  lookback_weeks: z.number().int().min(1).max(52).default(13),
  focus_city: z.string().regex(SAFE_GEO_CATEGORY_RE).optional(),
  focus_category: z.string().regex(SAFE_GEO_CATEGORY_RE).optional(),
  top_n: z.number().int().min(1).max(200).default(100),
};

const queryBookingsInput = z.object(aggregateFilterShape).strict();
const queryActiveSupplyInput = z.object(aggregateFilterShape).strict();
const queryFunnelInput = z.object(aggregateFilterShape).strict();

export const queryBookingsByGeoCategoryTool: ToolSpec = {
  name: "operator_db_query_bookings_by_geo_category",
  effect: "read",
  description:
    "Aggregate bookings by city × category × week from the operator's DB. Returns rows ORDERED BY bookings_n DESC up to top_n (default 100, max 200). " +
    "Result includes {truncated: bool, total_segments_seen: int} so the LLM knows whether long-tail segments were dropped. " +
    "lookback_weeks defaults to 13. focus_city / focus_category are optional regex-validated filters. " +
    "Requires schema_map.bookings with geo_field + category_field + created_at_field. If missing, throws operator_db_schema_map_missing.",
  input_schema: queryBookingsInput,
  async execute(ctx, input) {
    const args = input as z.infer<typeof queryBookingsInput>;
    return withAttachedDriver(gatewayCtx(ctx, "operator_db__query_bookings_by_geo_category"), ({ driver, cfg }) =>
      driver.query_bookings_by_geo_category(args, cfg),
    );
  },
};

export const queryActiveSupplyByGeoCategoryTool: ToolSpec = {
  name: "operator_db_query_active_supply_by_geo_category",
  effect: "read",
  description:
    "Aggregate active supply (distinct listings with at least one booking in the window) by city × category × week. " +
    "Returns rows ORDERED BY active_listings_n DESC up to top_n. v1 defines 'active supply' as distinct listings that booked at least once in the week. " +
    "Requires schema_map.bookings.listing_ref_field. avg_days_since_last_booking is null in v1 (post-v1 enhancement).",
  input_schema: queryActiveSupplyInput,
  async execute(ctx, input) {
    const args = input as z.infer<typeof queryActiveSupplyInput>;
    return withAttachedDriver(gatewayCtx(ctx, "operator_db__query_active_supply_by_geo_category"), ({ driver, cfg }) =>
      driver.query_active_supply_by_geo_category(args, cfg),
    );
  },
};

const queryVerifiedBookingsInput = z.object({
  window_days: z.number().int().min(1).max(365).default(30),
}).strict();

export async function resolveVerifiedInputs(
  tenant_id: string,
  deps: {
    getOutcomeMap: typeof getOutcomeMap;
    getCatalog: typeof getCatalog;
  } = { getOutcomeMap, getCatalog },
): Promise<{ order_map: VerifiedOrderMap | null; user_columns: Array<{ name: string; type: string }> }> {
  const [res, cat] = await Promise.all([deps.getOutcomeMap(tenant_id).catch(() => null), deps.getCatalog(tenant_id).catch(() => null)]);
  const usersTable = cat?.hints?.users?.table;
  const user_columns = (usersTable && cat?.catalog.tables.find((t) => t.name === usersTable)?.columns) || [];
  if (!res || !res.ok || res.map.engine !== "mongodb" || res.map.refund_basis === "refund_event_day") {
    return { order_map: null, user_columns: user_columns.map((c) => ({ name: c.name, type: c.type })) };
  }
  const m = res.map;
  return {
    order_map: {
      booking_source: m.booking_source,
      status_field: m.status_field,
      terminal_statuses: m.terminal_statuses,
      completed_at_field: m.completed_at_field,
      customer_ref_field: m.customer_ref_field,
      revenue_field: m.revenue_field,
      refund_field: m.refund_field,
      refund_basis: m.refund_basis,
      amount_unit: m.amount_unit,
    },
    user_columns: user_columns.map((c) => ({ name: c.name, type: c.type })),
  };
}

export const queryVerifiedBookingsByCampaignTool: ToolSpec = {
  name: "operator_db_query_verified_bookings_by_campaign",
  effect: "read",
  description:
    "Join customers with a FINISHED order in a day window (the founder-confirmed order map: finished statuses, finish date, customer, revenue/refund) to the UTM campaign/source tag on their customer record. " +
    "DISPLAY/ANOMALY-ONLY — NOT a budget ranker. Returns one row per (utm_campaign, utm_source) with verified_bookings (distinct customers) and net_gmv (confirmed revenue minus confirmed refund), plus total_verified + matched_verified and the tag fields used (found by name, not a confirmed attribution mapping). " +
    "The utm_campaign is the business's UTM tag, NOT a guaranteed ad-platform campaign name. " +
    "Returns {available:false, reason} when the order map is not confirmed, no tag field exists, or nothing finished — never fabricates. SQL drivers throw operator_db_aggregate_not_yet_implemented.",
  input_schema: queryVerifiedBookingsInput,
  async execute(ctx, input) {
    const args = input as z.infer<typeof queryVerifiedBookingsInput>;
    const resolved = await resolveVerifiedInputs(ctx.tenant_id);
    return withAttachedDriver(gatewayCtx(ctx, "operator_db__query_verified_bookings_by_campaign"), ({ driver, cfg }) =>
      driver.query_verified_bookings_by_campaign({ window_days: args.window_days, ...resolved }, cfg),
    );
  },
};

const queryNewUsersInput = z.object({
  window_days: z.number().int().min(1).max(365).default(7),
}).strict();

export const queryNewUsersTool: ToolSpec = {
  name: "operator_db_query_new_users",
  effect: "read",
  description:
    "Count NEW users created in the operator's DB over a rolling day window (users rows/docs with created-at >= now - window_days; default 7). " +
    "HONESTY SEMANTICS: returns {available:false, reason:'not_available'} when the users table/collection or its created-at field can't be verified — a broken read NEVER fabricates a zero. " +
    "Mongo falls back to the 'createdAt' field when the schema map doesn't declare users.created_at_field; SQL requires the explicit column. " +
    "MySQL throws operator_db_aggregate_not_yet_implemented.",
  input_schema: queryNewUsersInput,
  async execute(ctx, input) {
    const args = input as z.infer<typeof queryNewUsersInput>;
    return withAttachedDriver(gatewayCtx(ctx, "operator_db__query_new_users"), ({ driver, cfg }) =>
      driver.query_new_users_in_window({ window_days: args.window_days }, cfg),
    );
  },
};

const queryNewBookingsInput = z.object({
  window_days: z.number().int().min(1).max(365).default(7),
}).strict();

export const queryNewBookingsTool: ToolSpec = {
  name: "operator_db_query_new_bookings",
  effect: "read",
  description:
    "Count NEW bookings created in the operator's DB over a rolling day window (bookings rows/docs with created-at >= now - window_days; default 7). " +
    "HONESTY SEMANTICS: returns {available:false, reason:'not_available'} when the bookings table/collection or its created-at field can't be verified — a broken read NEVER fabricates a zero. " +
    "Mongo falls back to the 'createdAt' field when the schema map doesn't declare bookings.created_at_field; SQL requires the explicit column. " +
    "MySQL throws operator_db_aggregate_not_yet_implemented.",
  input_schema: queryNewBookingsInput,
  async execute(ctx, input) {
    const args = input as z.infer<typeof queryNewBookingsInput>;
    return withAttachedDriver(gatewayCtx(ctx, "operator_db__query_new_bookings"), ({ driver, cfg }) =>
      driver.query_new_bookings_in_window({ window_days: args.window_days }, cfg),
    );
  },
};

export const queryFunnelByGeoCategoryTool: ToolSpec = {
  name: "operator_db_query_funnel_by_geo_category",
  effect: "read",
  description:
    "Aggregate marketplace funnel (search → view → contact → book) by city × category × week. " +
    "book_n is always populated from the bookings table. search_n / view_n / contact_n are NULL in v1 — populated when search_events / view_events / contact_events schema_map entries are declared (post-v1). " +
    "The agent should treat nulls as 'funnel-stage-not-tracked' and skip those stages in reasoning.",
  input_schema: queryFunnelInput,
  async execute(ctx, input) {
    const args = input as z.infer<typeof queryFunnelInput>;
    return withAttachedDriver(gatewayCtx(ctx, "operator_db__query_funnel_by_geo_category"), ({ driver, cfg }) =>
      driver.query_funnel_by_geo_category(args, cfg),
    );
  },
};

export const operatorDbSummaryTool: ToolSpec = {
  name: "operator_db_summary",
  effect: "read",
  description:
    "Totals and counts from your database: count, and sum/avg/min/max of numeric or date fields, grouped by up to 3 fields, with filters. Rows covering fewer than 5 records are hidden. Use this when the connector only allows totals.",
  input_schema: SummaryRequest,
  async execute(ctx, input) {
    const req = input as SummaryRequest;
    const { rows, table } = await runSummary(gatewayCtx(ctx, "operator_db__summary"), req);
    return { ok: true, data: { table, row_count: rows.length, rows, min_group_size: 5 } };
  },
};
