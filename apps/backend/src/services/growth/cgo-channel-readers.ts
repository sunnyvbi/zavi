import { z } from "zod";
import {
  PAID_LABELS, compactMetrics, firstLine, organicChannel, paidChannel, paidUnread,
  type CampaignEvidence, type PaidChannelEvidence, type OrganicChannelEvidence,
} from "./cgo-evidence";

const metric = z.number().finite().optional();
const ctx = (tenant_id: string) => ({ tenant_id, log: () => {} });
const day = (d: Date) => d.toISOString().slice(0, 10);
const LINKEDIN_METRICS = ["impressions", "clicks", "spend", "conversions", "leads"] as const;

export async function readLinkedInAdsEvidence(tenant_id: string, now: Date): Promise<PaidChannelEvidence> {
  const { listLinkedInAdAccounts, listLinkedInCampaigns, readLinkedInAdAnalytics } = await import("@/services/connectors/linkedin-ads/client");
  const { ownLinkedinAccounts } = await import("@/services/connectors/linkedin-ads/own-accounts");
  const listed = (await listLinkedInAdAccounts(tenant_id)).filter(a => a.status?.toUpperCase() !== "CANCELED");
  const accounts = listed.length ? await ownLinkedinAccounts(tenant_id, listed) : [];
  if (accounts.length !== 1) return { channel_slug: "linkedin_ads", status: "could not read", reason: accounts.length ? "Multiple accessible ad accounts; select the workspace advertiser before reading performance." : "No accessible LinkedIn ad account." };
  const account = accounts[0];
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 86_400_000);
  const start = new Date(end.getTime() - 6 * 86_400_000);
  const ymd = (d: Date) => ({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
  const heads = await listLinkedInCampaigns(tenant_id, account.id, 100);
  const rows = heads.length ? await readLinkedInAdAnalytics(tenant_id, account.id, { pivot: "CAMPAIGN", start: ymd(start), end: ymd(end) }) : [];
  const campaigns: CampaignEvidence[] = heads.map((c) => {
    const matches = rows.filter((r) => r.pivot === `urn:li:sponsoredCampaign:${c.id}`);
    const r = matches.length === 1 ? matches[0] : undefined;
    const values = r ? Object.fromEntries(LINKEDIN_METRICS.filter((k) => !r.missing_metrics?.includes(k)).map((k) => [k, r[k]])) : {};
    return { id: c.id, name: c.name.slice(0, 80), objective: c.objective, label: PAID_LABELS.trackingUnknown, ad_sets: [], reported: { metrics: compactMetrics(values), currency: account.currency, status: c.status, period_confirmed: false, ...(typeof values.spend === "number" ? { spend: values.spend } : {}) } };
  });
  return { ...paidChannel("linkedin_ads", campaigns), source: "LinkedIn Ads whole-window analytics", as_of: now.toISOString(), reporting_period: `${day(start)} through ${day(end)} (requested dates)`, reason: "Privacy-noised totals; missing/suppressed metrics are unknown. Spend is in account currency; conversion tracking unverified. First 100 campaigns only; no account-wide total." };
}

const REDDIT_METRICS = ["impressions", "clicks", "spend", "signups", "leads", "purchases"] as const;
const addMetric = (a: number | null | undefined, b: number | null) => (a === undefined ? b : a === null || b === null ? null : a + b);

export async function readRedditAdsEvidence(tenant_id: string, now: Date): Promise<PaidChannelEvidence> {
  const { redditAdsAccount, listAdAccounts, listObjects } = await import("@/services/connectors/reddit-ads/adapter");
  const { performance } = await import("@/services/connectors/reddit-ads/reporting");
  const conn = await redditAdsAccount(tenant_id).catch(async (e: unknown) => {
    const { honestComposioToolError } = await import("@/services/connectors/composio/account");
    throw await honestComposioToolError(tenant_id, "reddit_ads", "Reddit Ads", e);
  });
  const accounts = await listAdAccounts(conn);
  if (accounts.length !== 1) return { channel_slug: "reddit_ads", status: "could not read", reason: accounts.length ? "Multiple accessible ad accounts; select the workspace advertiser before reading performance." : "No accessible Reddit ad account." };
  const account = accounts[0];
  const [report, heads] = await Promise.all([performance(tenant_id, account.id, 7, "campaign"), listObjects(conn, account.id, "campaign")]);
  const sums = new Map<string, Partial<Record<(typeof REDDIT_METRICS)[number], number | null>>>();
  for (const r of report.rows) {
    const s = sums.get(r.object_id) ?? {};
    for (const k of REDDIT_METRICS) s[k] = addMetric(s[k], r[k]);
    sums.set(r.object_id, s);
  }
  const metricsLine = (s: Partial<Record<(typeof REDDIT_METRICS)[number], number | null>> | undefined) =>
    REDDIT_METRICS.filter((k) => typeof s?.[k] === "number").map((k) => `${k} ${s![k]}`).join(", ") || "not read yet";
  const spendOf = (id: string) => sums.get(id)?.spend ?? -1;
  const campaigns: CampaignEvidence[] = heads
    .filter((c) => c.configured_status !== "ARCHIVED" && c.configured_status !== "DELETED")
    .sort((a, b) => spendOf(b.id) - spendOf(a.id))
    .map((c) => ({ id: c.id, name: c.name?.slice(0, 80) ?? null, objective: c.optimization_goal ?? null, label: PAID_LABELS.trackingUnknown, ad_sets: [], reported: { metrics: metricsLine(sums.get(c.id)), currency: account.currency, status: c.effective_status ?? c.configured_status ?? null, period_confirmed: true } }));
  return { ...paidChannel("reddit_ads", campaigns), source: "Reddit Ads campaign report", as_of: report.fetched_at, reporting_period: `${report.window.since} through ${report.window.until} (${report.account_timezone}; today provisional)`, reason: "Reports can lag six hours and conversions arrive later; a metric Reddit did not return is unknown, not zero. Spend is in account currency; conversion tracking unverified." };
}

const videos = z.object({ data: z.object({ videos: z.array(z.object({
  id: z.string(), title: z.string().optional(), video_description: z.string().optional(),
  create_time: z.number().finite().optional(), share_url: z.string().optional(),
  view_count: metric, like_count: metric, comment_count: metric, share_count: metric,
})), has_more: z.boolean().optional() }) });

export async function readOwnedOrganicEvidence(tenant_id: string, slug: "instagram_organic" | "tiktok_organic", now: Date): Promise<OrganicChannelEvidence> {
  if (slug === "instagram_organic") {
    const { instagramReadInsightsTool } = await import("@/services/tools/instagram/read_insights");
    const r = await instagramReadInsightsTool.execute(ctx(tenant_id), { max_posts: 6 }) as import("@/services/tools/instagram/read_insights").IgReadInsightsResult;
    if (!Array.isArray(r.items)) throw new Error("Instagram returned no media list");
    return { ...organicChannel(slug, r.items.map((p) => ({
      first_line: firstLine(p.caption_head), url: p.permalink, published_on: p.timestamp.slice(0, 10) || null,
      metrics: compactMetrics({ ...p.insights, likes: p.insights?.likes ?? p.like_count, comments: p.insights?.comments ?? p.comments_count }, r.fetched_at),
      as_of: r.fetched_at, source: "Instagram owned media insights",
    }))), ...(r.account_28d ? { account_summary: { metrics: compactMetrics(r.account_28d), period: "last 28 days (account totals, not per-post attribution)", as_of: r.fetched_at } } : {}), source: "Instagram owned media insights", period: "cumulative per-post counters at as_of", limitation: r.items.some((p) => p.insights_error) ? "Some post insights unavailable; only returned counters shown. No business conversion attribution." : "No business conversion attribution." };
  }
  const { queryVideoList } = await import("@/services/connectors/tiktok/api");
  const r = videos.parse(await queryVideoList(tenant_id, 6));
  const result = organicChannel(slug, r.data.videos.map((v) => ({
    first_line: firstLine(v.title || v.video_description), url: v.share_url ?? null,
    published_on: v.create_time == null ? null : day(new Date(v.create_time * 1000)),
    metrics: compactMetrics({ views: v.view_count, likes: v.like_count, comments: v.comment_count, shares: v.share_count }, now.toISOString()),
    source: "TikTok owned public videos", as_of: now.toISOString(),
  })));
  return { ...result, source: "TikTok owned public videos", period: "cumulative per-video counters at as_of", limitation: `Recent public videos only${r.data.has_more ? "; more videos exist" : ""}; no watch time or business conversion attribution.` };
}

const TIKTOK_WORDS: Record<import("@/services/connectors/tiktok-ads/composio-read").TiktokEvidenceMetric, string> = {
  spend: "spend", impressions: "impressions", clicks: "clicks", conversion: "conversions",
  complete_payment: "website_purchases", total_complete_payment_rate: "website_purchase_value",
  value_per_complete_payment: "value_per_website_purchase",
};

export function tiktokWindow(now: Date, timezone: string | null): { from: string; to: string; timezone: string } {
  let tz = timezone || "UTC";
  let today: string;
  try {
    today = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    tz = "UTC";
    today = day(now);
  }
  const t = Date.parse(`${today}T00:00:00Z`);
  return { from: day(new Date(t - 7 * 86_400_000)), to: day(new Date(t - 86_400_000)), timezone: tz };
}

export async function readTiktokAdsEvidence(tenant_id: string, now: Date): Promise<PaidChannelEvidence> {
  const { ensureAdAccounts } = await import("@/services/connectors/tiktok-ads/ad-accounts");
  const { tiktokAdsAccount, listCampaigns, strictReport, TIKTOK_EVIDENCE_METRICS } = await import("@/services/connectors/tiktok-ads/composio-read");
  const state = await ensureAdAccounts(tenant_id);
  if (!state.connected) {
    const { honestComposioToolError } = await import("@/services/connectors/composio/account");
    const { ExpectedToolError } = await import("@/services/tools/types");
    const e = await honestComposioToolError(tenant_id, "tiktok_ads", "TikTok Ads", new ExpectedToolError("tiktok_ads_not_connected", "TikTok Ads is not connected."));
    return paidUnread("tiktok_ads", e);
  }
  const advertiser = state.accounts.find((a) => a.advertiser_id === state.selected_id);
  if (!advertiser) return { channel_slug: "tiktok_ads", status: "could not read", reason: state.accounts.length ? "Multiple accessible ad accounts; select the workspace advertiser before reading performance." : "No confirmed TikTok ad account." };
  const account = await tiktokAdsAccount(tenant_id).catch(async (e: unknown) => {
    const { honestComposioToolError } = await import("@/services/connectors/composio/account");
    throw await honestComposioToolError(tenant_id, "tiktok_ads", "TikTok Ads", e);
  });
  const w = tiktokWindow(now, advertiser.timezone);
  const [heads, report] = await Promise.all([
    listCampaigns(account, advertiser.advertiser_id),
    strictReport(account, advertiser.advertiser_id, "campaign", w.from, w.to),
  ]);
  const zero = Object.fromEntries(TIKTOK_EVIDENCE_METRICS.map((k) => [k, 0])) as Record<(typeof TIKTOK_EVIDENCE_METRICS)[number], number | null>;
  const rowOf = (id: string) => report.get(id) ?? zero;
  const spendOf = (id: string) => rowOf(id).spend ?? -1;
  const campaigns: CampaignEvidence[] = heads
    .filter((c) => c.status !== "DELETED")
    .sort((a, b) => spendOf(b.campaign_id) - spendOf(a.campaign_id))
    .map((c) => {
      const r = rowOf(c.campaign_id);
      const metrics = TIKTOK_EVIDENCE_METRICS.filter((k) => typeof r[k] === "number").map((k) => `${TIKTOK_WORDS[k]} ${r[k]}`).join(", ") || "not read yet";
      return {
        id: c.campaign_id, name: c.name.slice(0, 80), objective: c.objective, label: PAID_LABELS.trackingUnknown, ad_sets: [],
        reported: { metrics, currency: advertiser.currency, status: c.secondary_status ?? c.status, period_confirmed: true, ...(typeof r.spend === "number" ? { spend: r.spend } : {}) },
      };
    });
  const others = state.accounts.length - 1;
  return {
    ...paidChannel("tiktok_ads", campaigns),
    source: "TikTok Ads campaign report",
    as_of: now.toISOString(),
    reporting_period: `${w.from} through ${w.to} (${w.timezone}; requested dates)`,
    reason: `Ad account ${advertiser.name}${others > 0 ? `; ${others} other saved account${others > 1 ? "s" : ""} not read` : ""}. A metric TikTok did not return is unknown, not zero. website_purchases and website_purchase_value are pixel purchases only (not app purchases or TikTok Shop sales), view-through included; a value that fails its cross-check is shown as unknown. Spend is in account currency; conversion tracking unverified.`,
  };
}

export async function loadTiktokObjects(
  tenant_id: string,
  card: { advertiser_id: string; level: "campaign" | "ad_group"; object_id: string },
  now: Date,
): Promise<import("./unattended-policy").AdObjectFacts[] | null> {
  const { ensureAdAccounts } = await import("@/services/connectors/tiktok-ads/ad-accounts");
  const { tiktokAdsAccount, strictReport } = await import("@/services/connectors/tiktok-ads/composio-read");
  const { readTiktokObject } = await import("@/services/connectors/tiktok-ads/objects");
  const state = await ensureAdAccounts(tenant_id);
  const advertiser = state.accounts.find((a) => a.advertiser_id === card.advertiser_id);
  if (!state.connected || !advertiser) return null;
  const account = await tiktokAdsAccount(tenant_id);
  const w = tiktokWindow(now, advertiser.timezone);
  const [object, report] = await Promise.all([
    readTiktokObject(account, card.advertiser_id, card.level, card.object_id),
    strictReport(account, card.advertiser_id, card.level, w.from, w.to),
  ]);
  if (!object) return null;
  const r = report.get(card.object_id);
  const usd = advertiser.currency === "USD";
  return [{
    id: card.object_id,
    conversionObjective: null,
    objective: null,
    learning: null,
    daysSinceEdit: null,
    lockDays: 0,
    spend7dUsd: !usd ? null : r ? r.spend : 0,
    conversions7d: r ? r.conversion : 0,
    targetCpaUsd: null,
  }];
}
