
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { ExpectedToolError } from "@/services/tools/types";
import type { ToolContext } from "@/services/tools/types";
import {
  metaListAdSetsTool,
  fetchTargetingSentences,
  type TargetingSentence,
} from "@/services/tools/meta-ads/list_ad_sets";
import { metaListAdsTool } from "@/services/tools/meta-ads/list_ads";
import { parseCustomRange, mapInChunks } from "./dashboard";

const META_WINDOWS = new Set([
  "last_7d",
  "last_14d",
  "last_28d",
  "last_30d",
  "this_month",
  "last_month",
]);
function parseMetaWindow(raw: unknown): string {
  return typeof raw === "string" && META_WINDOWS.has(raw) ? raw : "last_30d";
}

const MAX_AD_SETS_DETAILED = 12;

const DETAIL_FETCH_CONCURRENCY = 3;

const DETAIL_AGENT_SLUG = "performance-marketer";

export type AdSetDetailView = {
  ad_set_id: string;
  ad_set_name: string;
  optimization_event: string | null;
  bid_strategy: string | null;
  bid_amount_usd: number | null;
  attribution_window: string | null;
  daily_budget_usd: number | null;
  effective_status: string | null;
  advantage_audience: boolean;
  automatic_placements: boolean;
  age_min: number | null;
  age_max: number | null;
  genders: string | null;
  custom_audiences: string[];
  excluded_custom_audiences: string[];
  targeting_sentences: TargetingSentence[];
  spend_usd: number;
  ads: Array<Record<string, unknown>>;
};

export async function agentCampaignDetail(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  if (req.params.slug !== DETAIL_AGENT_SLUG) {
    res.status(404).json({
      error: {
        code: "no_campaign_detail",
        message: `campaign-detail is served for ${DETAIL_AGENT_SLUG} only; got ${req.params.slug}`,
      },
    });
    return;
  }

  const campaignId = req.query.campaign_id;
  if (typeof campaignId !== "string" || campaignId.length === 0) {
    res.status(400).json({
      error: { code: "campaign_id_required", message: "campaign_id query param is required" },
    });
    return;
  }

  const channel = typeof req.query.channel === "string" ? req.query.channel : "meta";
  if (channel !== "meta") {
    res.status(400).json({
      error: {
        code: "channel_unsupported",
        message: `campaign-detail is Meta-only today; got channel=${channel}`,
      },
    });
    return;
  }

  const windowKey = parseMetaWindow(req.query.window);
  const customRange = parseCustomRange(req.query.since, req.query.until);
  const ctx: ToolContext = {
    tenant_id: auth.tenant_id,
    log: () => {},
    agent_slug: "performance-marketer",
  };

  try {
    const adSetsResp = (await metaListAdSetsTool.execute(ctx, {
      campaign_id: campaignId,
      date_preset: windowKey,
      ...(customRange ? { time_range: customRange } : {}),
    })) as { ad_sets?: Array<Record<string, unknown>>; currency?: string | null };

    const rawAdSets = adSetsResp.ad_sets ?? [];
    const truncated = rawAdSets.length > MAX_AD_SETS_DETAILED;
    const slice = rawAdSets.slice(0, MAX_AD_SETS_DETAILED);

    const detailed: AdSetDetailView[] = await mapInChunks(
      slice,
      DETAIL_FETCH_CONCURRENCY,
      async (a) => {
        const adSetId = String(a.ad_set_id ?? "");
        const [sentences, adsResp] = await Promise.all([
          fetchTargetingSentences(auth.tenant_id, adSetId),
          metaListAdsTool
            .execute(ctx, {
              adset_id: adSetId,
              date_preset: windowKey,
              ...(customRange ? { time_range: customRange } : {}),
              include_creative: true,
            })
            .catch(() => ({ ads: [] })) as Promise<{ ads?: Array<Record<string, unknown>> }>,
        ]);
        return {
          ad_set_id: adSetId,
          ad_set_name: String(a.ad_set_name ?? ""),
          optimization_event: (a.optimization_event as string) ?? null,
          bid_strategy: (a.bid_strategy as string) ?? null,
          bid_amount_usd: (a.bid_amount_usd as number) ?? null,
          attribution_window: (a.attribution_window as string) ?? null,
          daily_budget_usd: (a.daily_budget_usd as number) ?? null,
          effective_status: (a.effective_status as string) ?? null,
          advantage_audience: a.advantage_audience === true,
          automatic_placements: a.automatic_placements === true,
          age_min: (a.age_min as number) ?? null,
          age_max: (a.age_max as number) ?? null,
          genders: (a.genders as string) ?? null,
          custom_audiences: (a.custom_audiences as string[]) ?? [],
          excluded_custom_audiences: (a.excluded_custom_audiences as string[]) ?? [],
          targeting_sentences: sentences,
          spend_usd: Number(a.spend_usd ?? 0),
          ads: adsResp.ads ?? [],
        };
      },
    );

    res.json({
      campaign_id: campaignId,
      window: windowKey,
      custom_range: customRange,
      currency: adSetsResp.currency ?? null,
      ad_sets: detailed,
      truncated,
      total_ad_sets: rawAdSets.length,
      fetched_at: new Date().toISOString(),
    });
  } catch (e) {
    if (e instanceof ExpectedToolError) {
      res.status(200).json({
        campaign_id: campaignId,
        ad_sets: [],
        error: { code: e.code, message: e.message },
      });
      return;
    }
    throw e;
  }
}
