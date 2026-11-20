
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { fetchMetaDailySeries } from "./daily_series";
import { buildBriefs } from "@/services/growth/perf-brief/brief";

const inputSchema = z.object({
  level: z
    .enum(["campaign", "adset"])
    .default("campaign")
    .describe("Brief granularity: per campaign (default) or per ad set."),
  date_preset: z
    .enum(["last_7d", "last_14d", "last_28d", "last_30d", "this_month", "last_month"])
    .default("last_30d")
    .describe("Pull window for the daily series the brief is computed over."),
});

export const metaAnalystBriefTool: ToolSpec = {
  name: "meta_ads_analyst_brief",
  effect: "read",
  description:
    "Senior-analyst brief per campaign/ad set, computed from DAILY data. For each entity it returns a SETTLED-window read (the last ~3 days are excluded because conversions lag the click), a FUNNEL DIAGNOSIS (is the leak ABOVE or BELOW the click?), and a recommended POSTURE: SCALE / HOLD / INVESTIGATE_FUNNEL / CUT_CANDIDATE / NO_DECISION. `INVESTIGATE_FUNNEL` means the AD IS WORKING and the leak is below the click — do NOT cut it. Call this BEFORE any scale/cut/pause/budget decision instead of judging a single 30-day aggregate. Read-only.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { level, date_preset } = inputSchema.parse(input);
    const { rows, truncated } = await fetchMetaDailySeries(ctx.tenant_id, { level, date_preset });
    const briefs = buildBriefs(rows, new Date());

    const mapped = briefs.map((b) => ({
      campaign_id: b.campaign_id,
      campaign_name: b.campaign_name,
      ad_set_id: b.ad_set_id,
      ad_set_name: b.ad_set_name,
      funnel_diagnosis: truncated ? ("maturing_insufficient" as const) : b.funnel_label,
      recommended_posture: truncated ? ("NO_DECISION" as const) : b.posture,
      judged_on: b.judged_on,
      confidence: truncated ? ("inadequate" as const) : b.confidence,
      settled_through: b.settled_cutoff,
      maturing_days_excluded: b.maturing_days,
      settled_window: b.settled,
      prior_window: b.prior,
      notes: truncated
        ? [
            "PARTIAL DATA — this account exceeds the single-pull row cap, so postures are suppressed. Re-pull a NARROWER scope (a shorter window like last_7d, or analyze one campaign/ad set at a time) before any scale/cut decision.",
          ]
        : b.notes,
    }));

    return {
      briefs: mapped,
      truncated,
      ...(truncated
        ? {
            warning:
              "data_incomplete_truncated — postures suppressed to NO_DECISION. Do NOT scale or cut from this brief; re-pull a narrower scope (shorter window or single entity).",
          }
        : {}),
      as_of: new Date().toISOString().slice(0, 10),
      method:
        "Settled window excludes the last ~72h (conversion lag). Funnel diagnosis + posture are computed, not eyeballed. INVESTIGATE_FUNNEL = the ad is working and the leak is below the click; do not cut. Thin/NO_DECISION = not enough settled purchase signal to scale or cut.",
    };
  },
};
