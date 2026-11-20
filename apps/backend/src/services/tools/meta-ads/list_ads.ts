
import { z } from "zod";
import { fbGet, metaAdsCreds, metaActionValue, metaDateRange } from "./_client";
import type { ToolSpec } from "@/services/tools/types";
import { isWebsiteLink } from "./_link-hosts";
import { buildTotals } from "@/services/tools/_shared/totals";
import { buildWaste } from "@/services/tools/_shared/waste";

const inputSchema = z.object({
  adset_id: z.string().min(1).optional(),
  campaign_id: z.string().min(1).optional(),
  date_preset: z
    .enum(["last_7d", "last_14d", "last_28d", "last_30d", "this_month", "last_month"])
    .default("last_7d"),
  time_range: z
    .object({
      since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .optional(),
  include_creative: z.boolean().default(false),
}).refine((v) => Boolean(v.adset_id || v.campaign_id), {
  message: "Pass adset_id or campaign_id — list_ads will not read every ad in the account unscoped.",
});

type InsightRow = {
  ad_id?: string;
  ad_name?: string;
  adset_id?: string;
  campaign_id?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  ctr?: string;
  cpc?: string;
  reach?: string;
  frequency?: string;
  actions?: Array<{ action_type?: string; value?: string }>;
  action_values?: Array<{ action_type?: string; value?: string }>;
};

type AdDetail = {
  status?: string;
  configured_status?: string;
  effective_status?: string;
  creative?: AdCreative | null;
};

type AdCreative = {
  id?: string;
  url_tags?: string;
  name?: string;
  title?: string;
  body?: string;
  image_url?: string;
  thumbnail_url?: string;
  image_hash?: string;
  call_to_action_type?: string;
  link_url?: string;
  object_story_spec?: {
    link_data?: {
      message?: string;
      name?: string;
      description?: string;
      link?: string;
      call_to_action?: { type?: string };
      child_attachments?: Array<{ link?: string }>;
    };
    video_data?: { call_to_action?: { value?: { link?: string } } };
  } | null;
  asset_feed_spec?: {
    bodies?: Array<{ text?: string }>;
    titles?: Array<{ text?: string }>;
    call_to_action_types?: string[];
    link_urls?: Array<{ website_url?: string }>;
  } | null;
};

const DETAIL_FIELDS =
  "status,configured_status,effective_status,creative{url_tags,link_url,object_story_spec{link_data{link,child_attachments{link}},video_data{call_to_action}},asset_feed_spec{link_urls}}";

const CREATIVE_FIELDS =
  "creative{id,name,title,body,url_tags,image_url,thumbnail_url,image_hash,call_to_action_type," +
  "link_url,object_story_spec{link_data{message,name,description,link,call_to_action,child_attachments{link}},video_data{call_to_action}}," +
  "asset_feed_spec{bodies,titles,call_to_action_types,link_urls}}";

export const metaListAdsTool: ToolSpec = {
  name: "meta_ads_list_ads",
  effect: "read",
  description:
    "List ADS (individual creatives) within a Meta ad set or campaign with per-ad spend, impressions, ctr, frequency, conversions, ROAS, CPA, PLUS effective_status. Use this to detect CREATIVE FATIGUE — a single ad whose frequency is climbing and ctr is decaying week-over-week, hidden inside an otherwise-healthy ad set. Requires adset_id OR campaign_id (same ID-discipline as list_ad_sets, which requires campaign_id) — the only source of valid IDs is a fresh list_campaigns / list_ad_sets call this turn. Returns meta_ads_not_connected when Meta is absent.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const parsed = inputSchema.parse(input);
    const { adset_id, campaign_id, date_preset, include_creative } = parsed;
    const { since, until } = parsed.time_range ?? metaDateRange(date_preset);
    return readMetaAds(ctx.tenant_id, { adset_id, campaign_id, since, until, include_creative });
  },
};

export async function readMetaAds(
  tenant_id: string,
  opts: { adset_id?: string; campaign_id?: string; since: string; until: string; include_creative: boolean },
) {
  const { adset_id, campaign_id, since, until, include_creative } = opts;
  const ctx = { tenant_id };
  const creds = await metaAdsCreds(ctx.tenant_id);

  const filtering: Array<Record<string, unknown>> = [];
  if (adset_id) {
    filtering.push({ field: "adset.id", operator: "EQUAL", value: adset_id });
  } else if (campaign_id) {
    filtering.push({ field: "campaign.id", operator: "EQUAL", value: campaign_id });
  }

  const params: Record<string, string | number | undefined> = {
    level: "ad",
    time_range: JSON.stringify({ since, until }),
    time_increment: "all_days",
    limit: 200,
    fields:
      "ad_id,ad_name,adset_id,campaign_id,spend,impressions,clicks,ctr,cpc,reach,frequency,actions,action_values",
    filtering: JSON.stringify(filtering),
  };

  const j = (await fbGet(ctx.tenant_id, `${creds.ad_account_id}/insights`, params)) as {
    data?: InsightRow[];
    paging?: { next?: string };
  };
  const insightRows = j.data ?? [];
  const insightsComplete = !j.paging?.next;

  const ids = insightRows.map((r) => r.ad_id).filter((id): id is string => Boolean(id));
  const detailMap = await fetchAdDetails(ctx.tenant_id, ids, include_creative);

  const ads = mergeAdDetails(insightRows, detailMap, include_creative);
  return {
    untagged_live_ads: await readUntaggedLiveAds(ctx.tenant_id, adset_id ?? campaign_id ?? creds.ad_account_id),
    waste: buildWaste(ads, {
      labelFields: ["ad_name"],
      spendField: "spend_usd",
      conversionFields: ["conversions", "leads"],
      outcomeLabel: "sales, signups or leads",
      window: `${since}..${until}`,
      entity: "ads",
      complete: insightsComplete,
      currency: "account currency",
    }),
    totals: buildTotals(ads, {
      sum: ["spend_usd", "impressions", "clicks", "conversions", "purchases", "purchase_value_usd"],
      ratios: {
        roas: ["purchase_value_usd", "spend_usd"],
        cpa_usd: ["spend_usd", "conversions"],
        ctr_percent: ["clicks", "impressions"],
      },
      scope: `${ads.length} ads · ${since}..${until}`,
      complete: insightsComplete,
      note: insightsComplete ? undefined : "One API page only (limit 200); more rows exist. These are PAGE totals, not account totals.",
    }),
    ads,
    adset_id: adset_id ?? null,
    campaign_id: campaign_id ?? null,
    time_range: { since, until },
  };
}

const LIVE_LINK_FIELDS = "id,effective_status,creative{url_tags,link_url,object_story_spec{link_data{link,child_attachments{link}},video_data{call_to_action}},asset_feed_spec{link_urls}}";

async function readUntaggedLiveAds(
  tenant_id: string,
  scope: string,
): Promise<{ count: number; of_live: number; ad_ids: string[]; complete: boolean } | null> {
  try {
    const j = (await fbGet(tenant_id, `${scope}/ads`, {
      fields: LIVE_LINK_FIELDS,
      effective_status: JSON.stringify(["ACTIVE"]),
      limit: 200,
    })) as { data?: Array<{ id?: string; effective_status?: string; creative?: AdCreative | null }>; paging?: { next?: string } };
    const live = (j.data ?? []).filter((a) => a.effective_status === "ACTIVE");
    const untagged = live.filter((a) => urlTagged(a.creative) === false);
    return { count: untagged.length, of_live: live.length, ad_ids: untagged.slice(0, 20).map((a) => a.id ?? ""), complete: !j.paging?.next };
  } catch {
    return null;
  }
}

async function fetchAdDetails(
  tenant_id: string,
  ids: string[],
  includeCreative = false,
): Promise<Record<string, AdDetail>> {
  if (ids.length === 0) return {};
  const resp = (await fbGet(tenant_id, "", {
    ids: ids.join(","),
    fields: includeCreative ? `status,configured_status,effective_status,${CREATIVE_FIELDS}` : DETAIL_FIELDS,
  })) as Record<string, AdDetail>;
  return resp ?? {};
}

export function normalizeCreative(c: AdCreative | null | undefined): Record<string, unknown> | null {
  if (!c) return null;
  const link = c.object_story_spec?.link_data;
  const feed = c.asset_feed_spec;
  const feedBodies = feed?.bodies ?? [];
  const feedTitles = feed?.titles ?? [];
  const feedCtas = feed?.call_to_action_types ?? [];
  const feedLinks = feed?.link_urls ?? [];
  const isDynamic = feedBodies.length > 0 || feedTitles.length > 0 || feedCtas.length > 1 || feedLinks.length > 1;
  return {
    creative_id: c.id ?? null,
    body: c.body ?? link?.message ?? feedBodies[0]?.text ?? null,
    title: c.title ?? link?.name ?? feedTitles[0]?.text ?? null,
    description: link?.description ?? null,
    call_to_action:
      c.call_to_action_type ?? link?.call_to_action?.type ?? feed?.call_to_action_types?.[0] ?? null,
    destination_url: c.link_url ?? link?.link ?? feed?.link_urls?.[0]?.website_url ?? null,
    url_tags: c.url_tags?.trim() || null,
    thumbnail_url: c.thumbnail_url ?? null,
    image_url: c.image_url ?? null,
    image_hash: c.image_hash ?? null,
    is_dynamic_creative: isDynamic,
    variant_count: isDynamic ? Math.max(1, feedBodies.length, feedTitles.length, feedCtas.length, feedLinks.length) : 1,
  };
}

export function mergeAdDetails(
  insightRows: InsightRow[],
  detailMap: Record<string, AdDetail>,
  includeCreative = false,
): Array<Record<string, unknown>> {
  return insightRows.map((r) => {
    const spend = Number(r.spend ?? 0);
    const purchases = metaActionValue(r.actions, "purchase");
    const checkouts = metaActionValue(r.actions, "initiate_checkout");
    const regs =
      metaActionValue(r.actions, "complete_registration") ||
      metaActionValue(r.actions, "offsite_conversion.fb_pixel_complete_registration");
    const conv = purchases + checkouts + regs;
    const leads =
      metaActionValue(r.actions, "lead") ||
      metaActionValue(r.actions, "offsite_conversion.fb_pixel_lead");
    const purchaseValue = metaActionValue(r.action_values, "purchase");
    const detail = detailMap[r.ad_id ?? ""] ?? {};

    return {
      ad_id: r.ad_id ?? "",
      ad_name: r.ad_name ?? "",
      adset_id: r.adset_id ?? "",
      campaign_id: r.campaign_id ?? "",
      leads: round2(leads),
      spend_usd: round2(spend),
      impressions: Number(r.impressions ?? 0),
      clicks: Number(r.clicks ?? 0),
      ctr_percent: round2(Number(r.ctr ?? 0)),
      cpc_usd: round2(Number(r.cpc ?? 0)),
      reach: Number(r.reach ?? 0),
      frequency: round2(Number(r.frequency ?? 0)),
      conversions: round2(conv),
      purchases: round2(purchases),
      purchase_value_usd: round2(purchaseValue),
      roas: spend > 0 ? round2(purchaseValue / spend) : null,
      cpa_usd: conv > 0 ? round2(spend / conv) : null,
      status: detail.status ?? null,
      configured_status: detail.configured_status ?? null,
      effective_status: detail.effective_status ?? null,
      url_tags: detail.creative?.url_tags?.trim() || null,
      url_tagged: urlTagged(detail.creative),
      ...(includeCreative ? { creative: normalizeCreative(detail.creative) } : {}),
    };
  });
}

export function urlTagged(c: AdCreative | null | undefined): boolean | null {
  if (!c) return null;
  if (c.url_tags?.trim()) return true;
  const links = [
    c.link_url,
    c.object_story_spec?.link_data?.link,
    ...(c.object_story_spec?.link_data?.child_attachments ?? []).map((a) => a.link),
    c.object_story_spec?.video_data?.call_to_action?.value?.link,
    ...(c.asset_feed_spec?.link_urls ?? []).map((l) => l.website_url),
  ].filter(
    (l): l is string => typeof l === "string" && isWebsiteLink(l),
  );
  if (links.length === 0) return null;
  return links.every((l) => /[?&]utm_[a-z]+=/i.test(l));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
