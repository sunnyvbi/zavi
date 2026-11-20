
import { z } from "zod";
import { gadsSearch } from "./_client";
import { recommendationTypeInfo } from "./_recommendation-types";
import { readEnabledServing, servingWhy } from "./_serving-status";
import type { ToolSpec } from "@/services/tools/types";

const EXTRA_FIELDS = [
  "campaign.asset_automation_settings",
  "campaign.broad_match_migration_date_time",
  "campaign.aca_migration_date_time",
] as const;

const CORE_FIELDS = [
  "campaign.id",
  "campaign.name",
  "campaign.status",
  "campaign.advertising_channel_type",
  "campaign.advertising_channel_sub_type",
  "campaign.bidding_strategy_type",
  "campaign.target_cpa.target_cpa_micros",
  "campaign.target_roas.target_roas",
  "campaign.network_settings.target_google_search",
  "campaign.network_settings.target_search_network",
  "campaign.network_settings.target_content_network",
  "campaign.network_settings.target_partner_search_network",
  "campaign.geo_target_type_setting.positive_geo_target_type",
  "campaign.dynamic_search_ads_setting.domain_name",
  "campaign.ai_max_setting.enable_ai_max",
  "campaign.ai_max_setting.bundling_required",
  "campaign.keyword_match_type",
  "campaign_budget.name",
  "campaign_budget.amount_micros",
  "campaign_budget.explicitly_shared",
  "campaign_budget.reference_count",
  "metrics.cost_micros",
  "metrics.conversions",
  "metrics.search_impression_share",
  "metrics.search_budget_lost_impression_share",
  "metrics.search_rank_lost_impression_share",
  "metrics.search_absolute_top_impression_share",
] as const;

const inputSchema = z.object({
  date_range: z
    .enum(["LAST_7_DAYS", "LAST_14_DAYS", "LAST_30_DAYS", "THIS_MONTH", "LAST_MONTH"])
    .default("LAST_30_DAYS"),
  status: z.enum(["ENABLED", "PAUSED", "REMOVED", "ALL"]).default("ENABLED"),
});

type DiagRow = {
  campaign?: {
    id?: string;
    name?: string;
    status?: string;
    advertisingChannelType?: string;
    advertisingChannelSubType?: string;
    biddingStrategyType?: string;
    targetCpa?: { targetCpaMicros?: string };
    targetRoas?: { targetRoas?: number };
    networkSettings?: {
      targetGoogleSearch?: boolean;
      targetSearchNetwork?: boolean;
      targetContentNetwork?: boolean;
      targetPartnerSearchNetwork?: boolean;
    };
    geoTargetTypeSetting?: { positiveGeoTargetType?: string };
    dynamicSearchAdsSetting?: { domainName?: string };
    aiMaxSetting?: { enableAiMax?: boolean; bundlingRequired?: string };
    keywordMatchType?: string;
    broadMatchMigrationDateTime?: string;
    acaMigrationDateTime?: string;
    assetAutomationSettings?: Array<{
      assetAutomationType?: string;
      assetAutomationStatus?: string;
    }>;
  };
  campaignBudget?: {
    name?: string;
    amountMicros?: string;
    explicitlyShared?: boolean;
    referenceCount?: string;
  };
  metrics?: {
    costMicros?: string;
    conversions?: string;
    searchImpressionShare?: number;
    searchBudgetLostImpressionShare?: number;
    searchRankLostImpressionShare?: number;
    searchAbsoluteTopImpressionShare?: number;
  };
};

type AutoApplyEntry = {
  type: string;
  status: string;
  name: string;
  changes: string | null;
  since: string | null;
  scope: "account";
};

export const campaignDiagnosticsTool: ToolSpec = {
  name: "google_ads_campaign_diagnostics",
  effect: "read",
  description:
    "Read Google Ads campaign CONFIGURATION and impression share — bidding strategy and its target, campaign type, network settings (Search Partners / Display expansion), location targeting mode (presence vs presence-or-interest), Dynamic Search Ads, automatically-created assets, and search impression share split into lost-to-budget vs lost-to-rank. This is the settings read; use google_ads_list_campaigns for spend. Impression share is ABSENT (null), never zero, when Google withholds it below its volume threshold. Throws google_ads_not_connected if OAuth is not wired.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { date_range, status } = inputSchema.parse(input);
    const statusFilter = status === "ALL" ? "" : `AND campaign.status = '${status}'`;

    let currency_code: string | null = null;
    try {
      const cur = (await gadsSearch(
        ctx.tenant_id,
        "SELECT customer.currency_code FROM customer LIMIT 1",
      )) as Array<{ customer?: { currencyCode?: string } }>;
      currency_code = cur[0]?.customer?.currencyCode ?? null;
    } catch {
      currency_code = null;
    }

    let auto_apply: AutoApplyEntry[] | null = null;
    let auto_apply_error: string | null = null;
    try {
      const subs = (await gadsSearch(
        ctx.tenant_id,
        `SELECT recommendation_subscription.type, recommendation_subscription.status,
                recommendation_subscription.create_date_time, recommendation_subscription.modify_date_time
         FROM recommendation_subscription`,
      )) as Array<{ recommendationSubscription?: { type?: string; status?: string; createDateTime?: string; modifyDateTime?: string } }>;
      auto_apply = subs.map((r) => {
        const sub = r.recommendationSubscription;
        const type = sub?.type ?? "UNKNOWN";
        const info = recommendationTypeInfo(type);
        return {
          type,
          status: sub?.status ?? "UNKNOWN",
          name: info.name,
          changes: info.changes,
          since: sub?.modifyDateTime ?? sub?.createDateTime ?? null,
          scope: "account" as const,
        };
      });
    } catch (e) {
      auto_apply_error = e instanceof Error ? e.message : String(e);
    }

    const build = (fields: readonly string[]) => `
      SELECT
        ${fields.join(",\n        ")}
      FROM campaign
      WHERE segments.date DURING ${date_range}
      ${statusFilter}
      ORDER BY metrics.cost_micros DESC
      LIMIT 200
    `;

    let rows: DiagRow[];
    let dropped_fields: string[] = [];
    try {
      rows = (await gadsSearch(ctx.tenant_id, build([...CORE_FIELDS, ...EXTRA_FIELDS]))) as DiagRow[];
    } catch (e) {
      if (!isFieldCompatibilityError(e)) throw e;
      rows = (await gadsSearch(ctx.tenant_id, build(CORE_FIELDS))) as DiagRow[];
      dropped_fields = [...EXTRA_FIELDS];
    }

    const campaigns = rows.map((r) => {
      const c = r.campaign ?? {};
      const m = r.metrics ?? {};
      const ns = c.networkSettings ?? {};
      const isSearch = c.advertisingChannelType === "SEARCH";
      return {
        campaign_id: c.id ?? "",
        campaign_name: c.name ?? "",
        status: c.status ?? "",
        channel_type: c.advertisingChannelType ?? "",
        channel_sub_type: c.advertisingChannelSubType ?? null,
        spend: round2(Number(m.costMicros ?? 0) / 1_000_000),
        conversions: round2(Number(m.conversions ?? 0)),

        bidding: {
          strategy_type: c.biddingStrategyType ?? null,
          target_cpa:
            c.targetCpa?.targetCpaMicros != null
              ? round2(Number(c.targetCpa.targetCpaMicros) / 1_000_000)
              : null,
          target_roas: c.targetRoas?.targetRoas ?? null,
        },

        networks: {
          google_search: ns.targetGoogleSearch ?? null,
          search_partners: ns.targetSearchNetwork ?? null,
          display_expansion: ns.targetContentNetwork ?? null,
          partner_search: ns.targetPartnerSearchNetwork ?? null,
        },

        geo_targeting: {
          positive_geo_target_type: c.geoTargetTypeSetting?.positiveGeoTargetType ?? null,
          note:
            c.geoTargetTypeSetting?.positiveGeoTargetType === "PRESENCE_OR_INTEREST"
              ? "PRESENCE_OR_INTEREST is Google's default and reaches people who are merely INTERESTED IN the targeted area, not only people in it. For a business that can only serve customers locally this is usually paid-for waste; PRESENCE restricts to people actually there."
              : null,
        },

        dynamic_search_ads_domain: c.dynamicSearchAdsSetting?.domainName ?? null,

        ai_max: (() => {
          const inScope =
            c.advertisingChannelType === "SEARCH" || c.advertisingChannelType === "SHOPPING";
          if (!inScope) {
            return {
              applicable: false as const,
              enabled: null,
              note: "AI Max does not apply to this campaign type.",
            };
          }
          const on = c.aiMaxSetting?.enableAiMax ?? false;
          const broad = c.keywordMatchType === "BROAD";
          return {
            applicable: true as const,
            enabled: on,
            adopted_before: c.aiMaxSetting?.bundlingRequired ?? null,
            campaign_level_broad_match: broad,
            migrated_from_broad_match_at: c.broadMatchMigrationDateTime ?? null,
            migrated_from_auto_created_assets_at: c.acaMigrationDateTime ?? null,
            note: on
              ? "AI Max is ON for this campaign."
              : broad
                ? "AI Max is off, but campaign-level broad match is ON — one of the settings Google uses to auto-upgrade Search campaigns to AI Max from 2026-09-01. In scope, not migrated."
                : null,
          };
        })(),

        budget: (() => {
          const b = r.campaignBudget ?? {};
          const shared = b.explicitlyShared ?? null;
          const refs = b.referenceCount != null ? Number(b.referenceCount) : null;
          return {
            name: b.name ?? null,
            daily_amount: b.amountMicros != null ? round2(Number(b.amountMicros) / 1_000_000) : null,
            explicitly_shared: shared,
            campaigns_using_it: refs,
            note:
              shared === true
                ? "SHARED budget. This daily amount is the POOL, not this campaign's entitlement, so per-campaign utilisation is not a meaningful number — do not compute one. Google also reallocates an underused share to whichever campaigns on this budget are capped, so the split moves within the window."
                : shared === false
                  ? null
                  : "Whether this budget is shared was not reported. If two campaigns show an identical daily amount, treat a shared budget as a live possibility before reading utilisation.",
          };
        })(),

        asset_automation: dropped_fields.includes("campaign.asset_automation_settings")
          ? null
          : (c.assetAutomationSettings ?? []).map((a) => ({
              type: a.assetAutomationType ?? null,
              status: a.assetAutomationStatus ?? null,
            })),

        impression_share: isSearch
          ? {
              search: m.searchImpressionShare ?? null,
              lost_to_budget: m.searchBudgetLostImpressionShare ?? null,
              lost_to_rank: m.searchRankLostImpressionShare ?? null,
              absolute_top: m.searchAbsoluteTopImpressionShare ?? null,
              basis: "fraction_of_1",
            }
          : null,
      };
    });

    let not_serving: Array<{ campaign_id: string; campaign_name: string; primary_status: string | null; reasons: string[]; why: string }> | null = null;
    let not_serving_error: string | null = null;
    if (status === "ENABLED" || status === "ALL") {
      try {
        const spent = new Map(campaigns.map((c) => [String(c.campaign_id), c.spend]));
        const serving = await readEnabledServing(ctx.tenant_id);
        not_serving = [...serving.entries()]
          .filter(([id]) => !(Number(spent.get(id) ?? 0) > 0))
          .map(([id, s]) => ({ campaign_id: id, campaign_name: s.name, primary_status: s.primary_status, reasons: s.reasons, why: servingWhy(s) }));
      } catch (e) {
        not_serving_error = e instanceof Error ? e.message : String(e);
      }
    }

    return {
      window: date_range,
      currency_code,
      not_serving,
      not_serving_note:
        not_serving === null
          ? not_serving_error
            ? `Which enabled campaigns are not serving could not be read (${not_serving_error}); a campaign missing from \`campaigns\` may simply have had no impressions.`
            : null
          : "Enabled campaigns with no spend in this window, and Google's own reason (primary_status_reasons). They are absent from `campaigns`, which only lists campaigns that served. Report the reason as given; do not guess another.",
      currency_note:
        currency_code === null
          ? "The account's currency could not be read. `spend` and `target_cpa` are in the ACCOUNT's currency — do not write a dollar sign in front of them."
          : `\`spend\` and \`target_cpa\` are in ${currency_code}, the account's own currency. Google reports money in account-currency micros, never USD.`,
      campaigns,
      dropped_fields,
      dropped_fields_note: dropped_fields.length
        ? `These fields were not readable in this API version and were dropped from the query; everything else in this result is complete. Do not report an absent automatically-created-assets setting as "off": ${dropped_fields.join(", ")}`
        : null,
      impression_share_note:
        "Search impression share, lost-to-budget and lost-to-rank are fractions of 1 and are reported ONLY for Search campaigns; they are null on Performance Max, Display and video. A null means Google withheld the metric (it does so below a volume threshold) — it does NOT mean zero, and must never be rendered as 0%. Lost-to-budget and lost-to-rank point at opposite fixes: budget-limited wants more budget, rank-limited wants better bids, ad relevance or landing page.",
      auto_apply,
      auto_apply_note:
        auto_apply === null
          ? `Auto-apply subscriptions could not be read this run (${auto_apply_error ?? "unknown error"}). Do NOT report auto-apply as on or off — say it was not readable, and have the operator check Recommendations > Auto-apply in the UI.`
          : auto_apply.length === 0
            ? "No recommendation types are subscribed for auto-apply on this account. Google is not applying changes on its own."
            : `${auto_apply.filter((a) => a.status === "ENABLED").length} recommendation type(s) are set to AUTO-APPLY. Google applies these without asking, account-wide: every campaign, not chosen ones. Name each ENABLED type by \`name\` and what it \`changes\`, and let the operator decide; a PAUSED one applies nothing. For what was actually applied, read google_ads__change_history rows whose client_type is GOOGLE_ADS_RECOMMENDATIONS_SUBSCRIPTION (auto-applied).`,
    };
  },
};

function isFieldCompatibilityError(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toUpperCase();
  return (
    msg.includes("UNRECOGNIZED_FIELD") ||
    msg.includes("UNKNOWN_FIELD") ||
    msg.includes("FIELD_NOT_FOUND") ||
    msg.includes("UNSELECTABLE_FIELD") ||
    msg.includes("PROHIBITED_FIELD") ||
    msg.includes("INCOMPATIBLE_FIELDS") ||
    msg.includes("BAD_FIELD")
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
