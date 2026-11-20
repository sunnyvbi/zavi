import { bindings } from "@/services/connectors/chatgpt-ads/resources";
import { servingReady } from "@/services/connectors/chatgpt-ads/serving";
import { campaignDraftPresentationSchema } from "@/agents/lib/channel-recipe-step";
import { listChatgptAdsCampaigns } from "@/services/connectors/chatgpt-ads/client";
import { ownsCampaignName, normalizeCampaignName, resolveTenantCampaignPrefix } from "@/services/connectors/chatgpt-ads/tenant-scope";
import type { ChatgptAdsDashboard } from "@zavi/shared";
import type { DashboardBuilder } from "./_contract";
import { chatgptAdsReadPerformanceTool } from "@/services/tools/chatgpt-ads/read_performance";
import { getChatgptAdsApiKey } from "@/services/connectors/chatgpt-ads/key-provider";
import { chatgptAdsGet } from "@/services/connectors/chatgpt-ads/http";
import { ExpectedToolError } from "@/services/tools/types";
import { readOwnedPurchaseReturn } from "@/services/connectors/chatgpt-ads/purchases";

export const build: DashboardBuilder = async ({ ctx, rangeDays, sb }) => {
  const empty: ChatgptAdsDashboard = { source: "chatgpt_ads_api", campaigns: [], totals_across_your_campaigns_only: {}, currency: null, period: null };
  let key: string;
  try {
    const prefix = await resolveTenantCampaignPrefix(ctx.tenant_id);
    key = await getChatgptAdsApiKey();
    const inventory = await listChatgptAdsCampaigns(key);
    empty.account_read = { status: inventory.pages_exhausted ? "partial" : "complete", observed_at: new Date().toISOString() };
    empty.campaign_name_prefix = prefix;
    empty.campaigns = inventory.campaigns.filter(c => ownsCampaignName(c.name, prefix)).map(c => ({ ...c, status: c.status ?? null }));
    const ambiguous = inventory.campaigns.some(c => normalizeCampaignName(c.name).startsWith(prefix) && !ownsCampaignName(c.name, prefix));
    empty.no_campaigns_for_tenant = !inventory.pages_exhausted && !ambiguous && !empty.campaigns.length;
    if (ambiguous) empty.account_read.status = "partial";
    if (inventory.pages_exhausted || ambiguous) empty.warning = "The campaign list is incomplete. Zavi needs to check the remaining campaigns; controls for the verified campaigns remain available.";
  } catch (error) {
    return { ...empty, account_read: { status: "unavailable", observed_at: new Date().toISOString() }, error_code: error instanceof ExpectedToolError ? error.code : "chatgpt_ads_unavailable", warning: "Campaigns could not be read. Refresh to try again." };
  }
  try {
    const { data } = await sb.from("channel_actions").select("body").eq("tenant_id", ctx.tenant_id).eq("channel_slug", "chatgpt_ads").eq("status", "pending").order("proposed_at", { ascending: false }).limit(20);
    for (const row of data ?? []) {
      const draft = campaignDraftPresentationSchema.safeParse(row.body?.step?.deliverable?.presentation);
      if (draft.success) { empty.draft = draft.data; break; }
    }
  } catch {  }
  try {
    empty.conversion_tracking = (await bindings(ctx.tenant_id)).some(b => b.kind === "conversion_event") ? "configured" : "not_configured";
  } catch { empty.conversion_tracking = "unavailable"; }
  const warnings: string[] = empty.warning ? [empty.warning] : [];
  const [accountResult, reportResult] = await Promise.allSettled([
    chatgptAdsGet<{ currency_code?: string; timezone?: string; status?: string; review?: { status: string }; url?: string }>(key, "/ad_account"),
    chatgptAdsReadPerformanceTool.execute(ctx, { days: rangeDays ?? 30 }),
  ]);
  const account = accountResult.status === "fulfilled" ? accountResult.value : {};
  if (accountResult.status === "rejected") warnings.push("Account currency is unavailable. Campaign pause controls remain available.");
  if (!servingReady(account)) empty.setup_notice = "Zavi is completing launch setup. You can prepare paused campaigns while we finish setup; no action is needed from you for these checks.";
  empty.currency = /^[A-Z]{3}$/.test(account.currency_code ?? "") ? account.currency_code! : null;
  if (reportResult.status === "rejected") {
    warnings.push("Performance reporting is unavailable. Campaign status and pause controls remain available.");
    return { ...empty, warning: warnings.join(" ") };
  }
  const report = reportResult.value as Record<string, any>;
  const byId = new Map<string, Record<string, any>>((report.campaigns ?? []).map((c: any) => [c.id, c]));
  for (const campaign of empty.campaigns) {
    const metrics = byId.get(campaign.id);
    for (const field of ["spend", "impressions", "clicks", "conversions", "ctr", "cpc", "cpm", "click_through_conversions", "view_through_conversions"] as const) {
      if (typeof metrics?.[field] === "number" && Number.isFinite(metrics[field])) campaign[field] = metrics[field];
    }
  }
  for (const field of ["spend", "impressions", "clicks", "conversions"] as const) {
    if (empty.campaigns.length && empty.campaigns.every(c => c[field] !== undefined)) empty.totals_across_your_campaigns_only[field] = empty.campaigns.reduce((sum, c) => sum + c[field]!, 0);
  }
  if (report.reporting_warning) warnings.push(report.reporting_warning);
  if (report.truncated || report.rows_dropped_note) warnings.push("Some performance reporting is incomplete; unavailable figures are left blank.");
  if (report.period_unconfirmed || report.period_unconfirmed_note) warnings.push("OpenAI's report did not confirm the full dates you picked. These numbers may cover a shorter or different interval. Refresh before comparing performance for that period.");
  try {
    const window = report.period?.time_range ? JSON.parse(report.period.time_range) : null;
    if (window && !report.period_unconfirmed) empty.period = { from: window.since, to: window.until, timezone: window.timezone, days: rangeDays ?? 30 };
  } catch { warnings.push("The reporting period is unavailable."); }
  if (account.timezone && empty.campaigns.length) {
    try { empty.purchase_return = await readOwnedPurchaseReturn(key, empty.campaigns.map(c => c.id), rangeDays ?? 30, account.timezone); }
    catch { warnings.push("Purchase return could not be read; ROAS is unavailable."); }
  }
  return { ...empty, warning: warnings.join(" ") || undefined };
};
