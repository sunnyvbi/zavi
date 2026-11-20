
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { fetchMetaDailySeries } from "./daily_series";

const inputSchema = z
  .object({
    campaign_id: z
      .string()
      .min(1)
      .optional()
      .describe("Read every day for this campaign. Id must come from a list call THIS turn."),
    ad_set_id: z
      .string()
      .min(1)
      .optional()
      .describe("Read every day for this ad set. Id must come from a list call THIS turn."),
    date_preset: z
      .enum(["last_7d", "last_14d", "last_28d", "last_30d", "this_month", "last_month"])
      .default("last_30d")
      .describe("Window to pull. Ignored when time_range is set."),
    time_range: z
      .object({
        since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .optional()
      .describe(
        "Explicit inclusive YYYY-MM-DD range. Overrides date_preset. Use this to read a window around a change you applied.",
      ),
  })
  .strict();

export const metaDailySeriesTool: ToolSpec = {
  name: "meta_ads_daily_series",
  effect: "read",
  description:
    "Per-DAY rows for ONE campaign or ONE ad set: spend, impressions, clicks, ctr_percent, cpm_usd, conversions, purchases, sign_ups, leads, purchase_value_usd. Exactly one of campaign_id or ad_set_id is REQUIRED — this is deliberately not an account-wide read. Call meta_ads__analyst_brief FIRST to learn which line matters and what posture it carries, then call this to see WHY that line looks the way it does, day by day: is CTR decaying or was one day expensive, is spend pacing against its cap, did the change applied last week move anything. NOTE ctr_percent is Meta's `ctr` = ALL clicks / impressions, not link clicks, so it reads higher than a link-CTR benchmark. The most recent ~3 days are still accruing late conversions — do not read a drop there as real. Read-only.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { campaign_id, ad_set_id, date_preset, time_range } = inputSchema.parse(input);

    if (!campaign_id && !ad_set_id) {
      throw new ExpectedToolError(
        "meta_ads_daily_series_needs_scope",
        "Pass exactly one of campaign_id or ad_set_id. This tool reads one line at a time by design — call meta_ads__analyst_brief first to decide which line, then read that line's days here.",
      );
    }
    if (campaign_id && ad_set_id) {
      throw new ExpectedToolError(
        "meta_ads_daily_series_ambiguous_scope",
        "Pass campaign_id OR ad_set_id, not both. To see one ad set's days, pass only its ad_set_id.",
      );
    }

    const level = ad_set_id ? ("adset" as const) : ("campaign" as const);

    const { rows, time_range: window, truncated } = await fetchMetaDailySeries(ctx.tenant_id, {
      level,
      date_preset,
      ...(time_range ? { time_range } : {}),
      filter: ad_set_id ? { ad_set_id } : { campaign_id: campaign_id! },
    });

    return {
      scope: ad_set_id ? { ad_set_id } : { campaign_id },
      level,
      time_range: window,
      days_returned: new Set(rows.map((r) => r.date)).size,
      rows,
      truncated,
      ...(truncated
        ? {
            warning:
              "data_incomplete_truncated — this scoped pull unexpectedly hit the row cap, so the days below are PARTIAL. Do not read a trend from them; re-pull a shorter window.",
          }
        : {}),
      method:
        "One row per day for the requested entity. ctr_percent is Meta's `ctr` (ALL clicks / impressions), NOT link clicks. cpm_usd is Meta's `cpm`. conversions = purchases + initiate_checkout + complete_registration. The most recent ~3 days under-report conversions and revenue because attribution settles over ~72h — judge trend on the days before that, and never report a late-window dip as a real decline.",
    };
  },
};
