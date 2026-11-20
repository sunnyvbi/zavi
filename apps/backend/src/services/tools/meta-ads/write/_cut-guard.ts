
import {
  buildCampaignBrief,
  type CampaignBrief,
} from "@/services/growth/perf-brief/brief";
import { fetchMetaDailySeries } from "../daily_series";
import { enumerateCampaignAdSets, type CampaignAdSet } from "../list_ad_sets";
import { metaJudgedOn, type MetaJudgedOn } from "../_objective";

export type CutGuardVerdict = {
  block: boolean;
  reason: string | null;
  guidance: string | null;
};

const ALLOW: CutGuardVerdict = { block: false, reason: null, guidance: null };

export function evaluateCutGuard(
  brief: CampaignBrief | null,
  opts: { operatorDirected: boolean; cgoOriginated?: boolean },
): CutGuardVerdict {
  if (opts.operatorDirected) return ALLOW;
  if (!brief) {
    if (opts.cgoOriginated) {
      return {
        block: true,
        reason: "cut_blocked_no_brief_autopilot",
        guidance:
          "Hold: the performance data for this could not be read, and Autopilot does not cut without it. " +
          "Try again later, or leave the cut to the founder.",
      };
    }
    return ALLOW;
  }

  if (brief.judged_on === "reach_and_clicks") {
    return {
      block: true,
      reason: "cut_blocked_objective_not_conversions",
      guidance:
        "Do not cut this on conversions: its objective buys reach and clicks. Judge it on reach, CTR and cost per click. " +
        "If it should drive results instead, offer the founder the choice to change its objective or pause it.",
    };
  }

  const s = brief.settled;

  if (brief.funnel_label === "top_funnel_working_bottleneck_below_click") {
    return {
      block: true,
      reason: "cut_blocked_top_funnel_working",
      guidance:
        `Do NOT cut this — the ad is working. ${brief.settled.sign_ups} signups ` +
        `@ $${brief.settled.cost_per_signup_usd}/signup in the settled window, but bookings are weak. ` +
        `The leak is BELOW the click (landing / offer / booking flow). Investigate the funnel; ` +
        `cutting the ad budget will starve a working top-of-funnel.`,
    };
  }

  if (brief.confidence === "inadequate" || brief.funnel_label === "maturing_insufficient") {
    return {
      block: true,
      reason: "cut_blocked_insufficient_settled_signal",
      guidance:
        `Hold — not enough settled data to justify a cut. Judged through ${brief.settled_cutoff} ` +
        `(the last ${brief.maturing_days}d excluded as still-maturing due to conversion lag): ` +
        `days=${s.days}, spend=$${s.spend_usd}, clicks=${s.clicks}. Gather more settled data or hold.`,
    };
  }

  const WORKING_SIGNUP_FLOOR = 10;
  const genuineWaster =
    s.purchases < 1 &&
    s.sign_ups < WORKING_SIGNUP_FLOOR &&
    (s.roas === null || s.roas < 0.5);
  if (genuineWaster) return ALLOW;

  return {
    block: true,
    reason: "cut_blocked_brief_contradicts",
    guidance:
      `The analysis does not support cutting this — it is producing down-funnel signal ` +
      `(settled: ${s.purchases} purchases, ${s.sign_ups} signups, ROAS ${s.roas ?? "n/a"}; ` +
      `posture ${brief.posture}). ${brief.posture === "SCALE" ? "It's a winner" : "Hold or investigate the funnel"}, don't cut it.`,
  };
}

export async function briefForAdSet(
  tenant_id: string,
  ad_set_id: string,
  asOf: Date,
): Promise<CampaignBrief | null> {
  try {
    const { rows, truncated } = await fetchMetaDailySeries(tenant_id, {
      level: "adset",
      date_preset: "last_30d",
      filter: { ad_set_id },
    });
    if (truncated) return null;
    const mine = rows.filter((r) => r.ad_set_id === ad_set_id);
    if (mine.length === 0) return null;
    return buildCampaignBrief(mine, asOf);
  } catch {
    return null;
  }
}

export async function briefForCampaign(
  tenant_id: string,
  campaign_id: string,
  asOf: Date,
): Promise<CampaignBrief | null> {
  try {
    const { rows, truncated } = await fetchMetaDailySeries(tenant_id, {
      level: "campaign",
      date_preset: "last_30d",
      filter: { campaign_id },
    });
    if (truncated) return null;
    const mine = rows.filter((r) => r.campaign_id === campaign_id);
    if (mine.length === 0) return null;
    if (mine.every((r) => (r.judged_on ?? "unknown") === "unknown")) {
      const judged = await campaignJudgedOnFromAdSets(tenant_id, campaign_id, mine[0]?.objective ?? null);
      if (judged !== "unknown") {
        return buildCampaignBrief(mine.map((r) => ({ ...r, judged_on: judged })), asOf);
      }
    }
    return buildCampaignBrief(mine, asOf);
  } catch {
    return null;
  }
}

export function judgedOnFromAdSets(objective: string | null, adSets: CampaignAdSet[]): MetaJudgedOn {
  const running = adSets.filter((a) => {
    const eff = (a.effective_status ?? "").toUpperCase();
    const cfg = (a.configured_status ?? a.status ?? "").toUpperCase();
    return !["DELETED", "ARCHIVED", "PAUSED"].includes(cfg) && !["DELETED", "ARCHIVED"].includes(eff);
  });
  if (running.length === 0) return "unknown";
  const verdicts = running.map((a) => (a.optimization_goal ? metaJudgedOn(objective, a.optimization_goal) : "unknown"));
  if (verdicts.includes("conversions")) return "conversions";
  if (verdicts.every((v) => v === "reach_and_clicks")) return "reach_and_clicks";
  return "unknown";
}

async function campaignJudgedOnFromAdSets(
  tenant_id: string,
  campaign_id: string,
  objective: string | null,
): Promise<MetaJudgedOn> {
  try {
    return judgedOnFromAdSets(objective, await enumerateCampaignAdSets(tenant_id, campaign_id));
  } catch {
    return "unknown";
  }
}

export async function isCgoOriginatedRun(
  tenant_id: string,
  run_id: string | null | undefined,
  agent_slug: string | null | undefined,
): Promise<boolean> {
  if (agent_slug === "cgo") return true;
  try {
    if (run_id) {
      const { asTenantId, tenantClient } = await import("@/services/tenant-client");
      const { data, error } = await tenantClient(asTenantId(tenant_id))
        .from("agent_runs")
        .select("payload")
        .eq("id", run_id)
        .eq("tenant_id", tenant_id)
        .maybeSingle();
      if (error) return true;
      const by = (data as { payload?: { dispatched_by?: unknown } | null } | null)?.payload?.dispatched_by;
      if (by === "cgo") return true;
    }
    const { cgoAdBudget } = await import("@/services/growth/cgo-ads");
    return (await cgoAdBudget(tenant_id)) !== null;
  } catch {
    return true;
  }
}
