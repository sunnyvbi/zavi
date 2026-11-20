
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { callOperatorDbTool } from "@/services/mcp/internal/operator-db";

const inputSchema = z.object({
  window_days: z.number().int().min(1).max(365).default(30),
});

const MATCHED_BASIS_DEFAULT =
  "a UTM campaign tag on the customer record (found by its field name; not a confirmed attribution mapping, and not a guaranteed ad-platform campaign name)";
const LIMITATION =
  "DISPLAY/ANOMALY-ONLY — verified bookings never rank budget; pixel ROAS stays the ranker. Attribution coverage is partial; at low coverage treat verified as directional, not authoritative.";
const COVERAGE_MEANING =
  "Share of customers with a finished order in the window whose customer record carries a UTM campaign tag. Not attribution accuracy: an untagged customer may still have come from an ad.";
const LOW_COVERAGE_PCT = 25;

type DelegateRow = {
  utm_campaign?: unknown;
  utm_source?: unknown;
  verified_bookings?: unknown;
  net_gmv?: unknown;
};
type DelegateData = {
  available?: unknown;
  reason?: unknown;
  total_verified?: unknown;
  matched_verified?: unknown;
  rows?: unknown;
  truncated?: unknown;
  unreadable_revenue_orders?: unknown;
  utm_fields?: { campaign?: unknown; source?: unknown } | null;
};

const REASON_TEXT: Record<string, string> = {
  order_map_unconfirmed:
    "The finished-order map is not confirmed (when an order finished, who the customer is, which statuses mean finished): propose it with growth__read_outcome_fields and save what the founder confirms.",
  no_customer_table: "The database's customer table is not identified, so tags cannot be read.",
  no_utm_field: "No UTM campaign tag field was found on the customer record.",
  no_finished_orders: "No finished order fell in this window under the confirmed order map; check the map before reading this as zero.",
  read_failed: "The database read failed.",
};

function notAvailable(window_days: number, reason = "not_available") {
  return {
    connected: false as const,
    reason: "not_available" as const,
    why: REASON_TEXT[reason] ?? "The operator DB has no usable shape for this read.",
    window: `${window_days}d`,
    matched_basis: MATCHED_BASIS_DEFAULT,
    limitation:
      "Verified or completed-outcome CAC is unavailable from this operator DB for this run. Pixel ROAS still ranks lines. If the founder asked for it, say that first; label every increase a test with a readout date.",
  };
}

export const readVerifiedBookingsByCampaignTool: ToolSpec = {
  name: "growth_read_verified_bookings_by_campaign",
  effect: "read",
  description:
    "Read-only verified-outcome cross-check for paid attribution. Joins customers with a FINISHED order (the founder-confirmed order map) to the UTM tag on their customer record and reports, per (campaign, source) AND overall, the customers + net revenue + the share of customers carrying a tag. " +
    "DISPLAY/ANOMALY-ONLY — NEVER rank or scale budget by this; pixel ROAS stays the ranker. Use it as a confidence signal: pixel-high + verified-low at usable coverage ⇒ 'do not scale confidently, investigate attribution' (NOT 'cut'). The utm_campaign is the business's UTM tag, not a guaranteed Meta campaign name. " +
    "Returns {connected:false, reason:'not_available', why} when it cannot be read honestly — never fabricates a number.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { window_days } = inputSchema.parse(input);

    let res;
    try {
      res = await callOperatorDbTool(ctx.tenant_id, "query_verified_bookings_by_campaign", { window_days });
    } catch {
      return notAvailable(window_days, "read_failed");
    }

    if (!res.ok || res.is_error) return notAvailable(window_days);

    let data: DelegateData;
    try {
      data = JSON.parse(res.content) as DelegateData;
    } catch {
      return notAvailable(window_days, "read_failed");
    }

    if (data?.available === false) return notAvailable(window_days, typeof data.reason === "string" ? data.reason : undefined);

    const num = (x: unknown) => {
      const n = Number(x ?? 0);
      return Number.isFinite(n) ? n : 0;
    };
    const total_verified = num(data?.total_verified);
    const matched_verified = num(data?.matched_verified);
    if (total_verified <= 0) return notAvailable(window_days, "no_finished_orders");
    const rawRows: DelegateRow[] = Array.isArray(data?.rows) ? (data.rows as DelegateRow[]) : [];

    const pct = (n: number) => (total_verified > 0 ? Math.round((100 * n) / total_verified) : 0);
    const rows = rawRows.map((r) => {
      const verified_bookings = num(r.verified_bookings);
      return {
        utm_campaign: String(r.utm_campaign ?? ""),
        utm_source: r.utm_source == null ? null : String(r.utm_source),
        verified_bookings,
        net_gmv: num(r.net_gmv),
        share_pct: pct(verified_bookings),
      };
    });
    const perCampaignCount: Record<string, number> = {};
    for (const r of rows) {
      if (r.utm_campaign) perCampaignCount[r.utm_campaign] = (perCampaignCount[r.utm_campaign] ?? 0) + r.verified_bookings;
    }
    const per_campaign: Record<string, number> = {};
    for (const [k, v] of Object.entries(perCampaignCount)) per_campaign[k] = pct(v);
    const overall_pct = pct(matched_verified);

    const tagField = typeof data.utm_fields?.campaign === "string" ? data.utm_fields.campaign : null;
    const unreadable = num(data.unreadable_revenue_orders);
    return {
      connected: true as const,
      window: `${window_days}d`,
      basis: "finished orders (founder-confirmed order map)",
      matched_basis: tagField
        ? `the customer record's ${tagField} (found by its field name; not a confirmed attribution mapping, and not a guaranteed ad-platform campaign name)`
        : MATCHED_BASIS_DEFAULT,
      rows,
      coverage: { overall_pct, per_campaign, meaning: COVERAGE_MEANING },
      total_verified,
      matched_verified,
      low_coverage: overall_pct < LOW_COVERAGE_PCT,
      ...(data.truncated === true ? { truncated: true, truncated_note: "More (campaign, source) tags exist than were returned; the totals still count every customer." } : {}),
      ...(unreadable > 0 ? { unreadable_revenue_orders: unreadable, revenue_note: `${unreadable} finished orders have a revenue value that is missing or not a number; net_gmv leaves them out.` } : {}),
      limitation: LIMITATION,
    };
  },
};
