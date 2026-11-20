
import { z } from "zod";
import { fbGet, getAdAccountCurrency, metaAdsCreds, metaActionValue, metaDateRange } from "./_client";
import { minorToMajor } from "./write/_currency";
import { buildTotals } from "@/services/tools/_shared/totals";
import { buildWaste } from "@/services/tools/_shared/waste";
import { metaJudgedOn } from "./_objective";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({
  date_preset: z
    .enum([
      "last_7d",
      "last_14d",
      "last_28d",
      "last_30d",
      "this_month",
      "last_month",
    ])
    .default("last_30d"),
  time_range: z
    .object({
      since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .optional(),
  status: z.enum(["ACTIVE", "PAUSED", "DELETED", "ALL"]).default("ACTIVE"),
});

type InsightRow = {
  campaign_id?: string;
  campaign_name?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  ctr?: string;
  cpc?: string;
  cpm?: string;
  reach?: string;
  frequency?: string;
  actions?: Array<{ action_type?: string; value?: string }>;
  action_values?: Array<{ action_type?: string; value?: string }>;
  effective_status?: string;
  start_time?: string;
  stop_time?: string;
  objective?: string;
  campaign_daily_budget?: number | null;
  campaign_lifetime_budget?: number | null;
  bid_strategy?: string | null;
  spend_cap?: number | null;
};

type CampaignDetail = {
  daily_budget?: string;
  lifetime_budget?: string;
  bid_strategy?: string;
  spend_cap?: string;
  id?: string;
  name?: string;
  status?: string;
  effective_status?: string;
  start_time?: string;
  stop_time?: string;
  objective?: string;
};

export const metaListCampaignsTool: ToolSpec = {
  name: "meta_ads_list_campaigns",
  effect: "read",
  description:
    "List Meta Ads campaigns (FB+IG) with spend + reach + impressions + clicks + conversions + ROAS. " +
    "Pulls live data from the operator's ad account.\n" +
    "DEFAULTS (both are filters — an empty result usually means the filter, not an empty account): " +
    "status='ACTIVE' returns only campaigns CURRENTLY DELIVERING; pass status='ALL' to include " +
    "paused/completed ones. date_preset='last_30d'; the insights endpoint omits any campaign that " +
    "did not deliver in that window, so widen with date_preset or an explicit time_range. " +
    "The response echoes the applied filter as `status_filter` — that is OUTPUT ONLY; " +
    "the INPUT parameter is `status`.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const parsed = inputSchema.parse(input);
    const { date_preset, status } = parsed;
    const { since, until } = parsed.time_range ?? metaDateRange(date_preset);
    const creds = await metaAdsCreds(ctx.tenant_id);

    const params: Record<string, string | number | undefined> = {
      level: "campaign",
      time_range: JSON.stringify({ since, until }),
      time_increment: "all_days",
      limit: 200,
      fields:
        "campaign_id,campaign_name,objective,spend,impressions,clicks,ctr,cpc,cpm,reach,frequency,actions,action_values",
    };
    if (status !== "ALL") {
      params.filtering = JSON.stringify([
        {
          field: "campaign.delivery_info",
          operator: "IN",
          value: [statusToDelivery(status)],
        },
      ]);
    }

    const j = (await fbGet(
      ctx.tenant_id,
      `${creds.ad_account_id}/insights`,
      params,
    )) as {
      data?: InsightRow[];
      paging?: { next?: string };
    };
    const rows = j.data ?? [];
    const insightsComplete = !j.paging?.next;
    const edgeParams = {
      fields: "id,name,status,effective_status,start_time,stop_time,objective,daily_budget,lifetime_budget,bid_strategy,spend_cap",
      limit: 200,
    };
    let campaignResponse: { data?: CampaignDetail[]; paging?: { next?: string } };
    if (status === "ALL") {
      campaignResponse = (await fbGet(ctx.tenant_id, `${creds.ad_account_id}/campaigns`, edgeParams)) as typeof campaignResponse;
    } else {
      try {
        campaignResponse = (await fbGet(ctx.tenant_id, `${creds.ad_account_id}/campaigns`, edgeParams)) as typeof campaignResponse;
      } catch {
        campaignResponse = { data: [] };
      }
    }
    const allDetails = campaignResponse.data ?? [];
    const details = status === "ALL" ? allDetails : [];
    const settings = await campaignSettingsById(ctx.tenant_id, allDetails);
    const insightById = new Map(
      rows.map((row) => [row.campaign_id ?? "", row]),
    );
    const mergedRows: InsightRow[] =
      status === "ALL"
        ? details.map((detail) => ({
            ...(insightById.get(detail.id ?? "") ?? {}),
            campaign_id: detail.id ?? "",
            campaign_name: detail.name ?? "",
            effective_status: detail.effective_status ?? detail.status,
            start_time: detail.start_time,
            stop_time: detail.stop_time,
            objective: detail.objective ?? insightById.get(detail.id ?? "")?.objective,
          }))
        : [...rows];
    for (const r of mergedRows) Object.assign(r, settings.get(r.campaign_id ?? "") ?? {});
    if (status === "ALL") {
      for (const row of rows) {
        if (!details.some((detail) => detail.id === row.campaign_id))
          mergedRows.push(row);
      }
    }
    const campaigns = mergedRows.map((r) => mapInsight(r));
    const complete = insightsComplete && !campaignResponse.paging?.next;
    return {
      waste: buildWaste(campaigns, {
        labelFields: ["campaign_name"],
        spendField: "spend_usd",
        conversionFields: ["conversions", "leads"],
        outcomeLabel: "sales, signups or leads",
        window: `${since}..${until}`,
        entity: "campaigns",
        complete: complete,
        currency: "account currency",
        excludeWhen: {
          field: "judged_on",
          values: ["reach_and_clicks"],
          label: "their objective buys reach or clicks, not results",
        },
      }),
      totals: buildTotals(campaigns, {
        sum: [
          "spend_usd",
          "impressions",
          "clicks",
          "conversions",
          "purchases",
          "leads",
          "purchase_value_usd",
        ],
        ratios: {
          roas: ["purchase_value_usd", "spend_usd"],
          cpa_usd: ["spend_usd", "conversions"],
          cost_per_booking_usd: ["spend_usd", "purchases"],
          ctr_percent: ["clicks", "impressions"],
        },
        scope: `${campaigns.length} campaigns · status=${status} · ${since}..${until}`,
        complete,
        note: complete ? undefined : "One API page only (limit 200); more campaigns exist. These are PAGE totals, not account totals.",
      }),
      campaigns,
      time_range: { since, until },
      ...(rows.length === 0 && status !== "ALL"
        ? {
            hint:
              `No campaigns matched. This is a FILTERED view: status="${status}" ` +
              `(currently-delivering only) over ${since}..${until}. Before concluding the ` +
              `account has no campaigns, retry with status:"ALL" and/or a wider date_preset. ` +
              `Note the input parameter is "status", not "status_filter".`,
          }
        : {}),
      status_filter: status,
      ad_account_id: creds.ad_account_id,
    };
  },
};

function statusToDelivery(s: string): string {
  switch (s) {
    case "ACTIVE":
      return "ACTIVE";
    case "PAUSED":
      return "INACTIVE";
    case "DELETED":
      return "DELETED";
    default:
      return "ACTIVE";
  }
}

function mapInsight(r: InsightRow): Record<string, unknown> {
  const spend = Number(r.spend ?? 0);
  const purchases = metaActionValue(r.actions, "purchase");
  const checkouts = metaActionValue(r.actions, "initiate_checkout");
  const regs =
    metaActionValue(r.actions, "complete_registration") ||
    metaActionValue(
      r.actions,
      "offsite_conversion.fb_pixel_complete_registration",
    );
  const leads =
    metaActionValue(r.actions, "lead") ||
    metaActionValue(r.actions, "offsite_conversion.fb_pixel_lead");
  const conv = purchases + checkouts + regs;
  const purchaseValue = metaActionValue(r.action_values, "purchase");
  return {
    campaign_id: r.campaign_id ?? "",
    campaign_name: r.campaign_name ?? "",
    status: r.effective_status ?? null,
    start_time: r.start_time ?? null,
    end_time: r.stop_time ?? null,
    objective: r.objective ?? null,
    campaign_daily_budget: r.campaign_daily_budget ?? null,
    campaign_lifetime_budget: r.campaign_lifetime_budget ?? null,
    bid_strategy: r.bid_strategy ?? null,
    spend_cap: r.spend_cap ?? null,
    judged_on: metaJudgedOn(r.objective),
    spend_usd: round2(spend),
    impressions: Number(r.impressions ?? 0),
    clicks: Number(r.clicks ?? 0),
    ctr_percent: round2(Number(r.ctr ?? 0)),
    cpc_usd: round2(Number(r.cpc ?? 0)),
    cpm_usd: round2(Number(r.cpm ?? 0)),
    reach: Number(r.reach ?? 0),
    frequency: round2(Number(r.frequency ?? 0)),
    conversions: round2(conv),
    purchases: round2(purchases),
    sign_ups: round2(regs),
    leads: round2(leads),
    purchase_value_usd: round2(purchaseValue),
    roas: spend > 0 ? round2(purchaseValue / spend) : null,
    cpa_usd: conv > 0 ? round2(spend / conv) : null,
    cost_per_booking_usd: purchases > 0 ? round2(spend / purchases) : null,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function campaignSettingsById(
  tenant_id: string,
  details: CampaignDetail[],
): Promise<Map<string, Partial<InsightRow>>> {
  const out = new Map<string, Partial<InsightRow>>();
  const hasAmount = details.some((d) => d.daily_budget || d.lifetime_budget || d.spend_cap);
  let currency: string | null = null;
  if (hasAmount) {
    try {
      currency = await getAdAccountCurrency(tenant_id);
    } catch {
      currency = null;
    }
  }
  for (const d of details) {
    if (!d.id) continue;
    out.set(d.id, {
      campaign_daily_budget: positive(minorToMajor(d.daily_budget ?? null, currency)),
      campaign_lifetime_budget: positive(minorToMajor(d.lifetime_budget ?? null, currency)),
      spend_cap: d.spend_cap === META_NO_SPEND_CAP ? null : positive(minorToMajor(d.spend_cap ?? null, currency)),
      bid_strategy: d.bid_strategy ?? null,
    });
  }
  return out;
}

export const META_NO_SPEND_CAP = "922337203685478";

function positive(n: number | null): number | null {
  return n != null && n > 0 ? n : null;
}
