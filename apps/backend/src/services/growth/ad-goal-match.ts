
import { classifyTargetMetric } from "@/services/autopilot/goal-metric-vocab";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import type { AdObjectFacts } from "./unattended-policy";

export type AdGoalMode = "value" | "count" | "native";

export function adGoalModeOf(target_metric: string): AdGoalMode {
  const m = (target_metric ?? "").toLowerCase().replace(/[_\-./]+/g, " ").replace(/\s+/g, " ").trim();
  if (!m) return "native";
  const src = classifyTargetMetric(m);
  if (src.kind === "unresolved" && /\brates?\b|%|\bpercent|\bratio\b|\baverage\b|\bavg\b|\baov\b|\barpu\b|\bltv\b/.test(m)) return "native";
  if (src.kind === "stripe_mrr" || src.kind === "stripe_gross_revenue" || src.kind === "booking_value") return "value";
  if (/\bgmv\b|\brevenue\b|\bsales value\b|\bbooked value\b|\bgross (bookings|merchandise)\b/.test(m)) return "value";
  if (src.kind === "operator_funnel") return "count";
  if (src.kind === "native_funnel") return src.step === "purchase" ? "count" : "native";
  if (/\bpaid (subscribers?|customers?|users?|members?)\b|\bnew customers?\b|\bcustomers? acquired\b|\bsubscriptions?\b/.test(m)) return "count";
  return "native";
}

export function adGoalModeOfTier(metrics: readonly string[]): AdGoalMode {
  const modes = new Set(metrics.map(adGoalModeOf));
  return modes.size === 1 ? [...modes][0]! : "native";
}

export type AdGoalRead = { ok: true; mode: AdGoalMode; metric: string | null } | { ok: false; error: string };

export async function loadAdGoalMode(tenant_id: string): Promise<AdGoalRead> {
  try {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("autopilot_goals")
      .select("target_metric, priority")
      .eq("tenant_id", tenant_id)
      .eq("status", "active")
      .order("priority", { ascending: false })
      .limit(20);
    if (error) return { ok: false, error: error.message };
    const rows = (data ?? []) as Array<{ target_metric?: unknown; priority?: unknown }>;
    if (rows.length === 0) return { ok: true, mode: "native", metric: null };
    const top = rows[0]!.priority ?? null;
    const tier = rows.filter((r) => (r.priority ?? null) === top).map((r) => (typeof r.target_metric === "string" ? r.target_metric : ""));
    return { ok: true, mode: adGoalModeOfTier(tier), metric: tier.length === 1 ? tier[0]! : null };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export const BRAND_TOKEN_MIN = 4;

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export function brandTokens(display_name: string | null | undefined, product_url: string | null | undefined): string[] {
  const out = new Set<string>();
  const name = compact(display_name ?? "");
  if (name.length >= BRAND_TOKEN_MIN) out.add(name);
  const raw = (product_url ?? "").trim();
  if (raw) {
    let host = "";
    try {
      host = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase();
    } catch {
      host = "";
    }
    const labels = host.replace(/^www\./, "").split(".").filter(Boolean);
    if (labels.length >= 2) {
      const sld = labels[labels.length - 2]!;
      const stem = labels.length >= 3 && sld.length <= 3 ? labels[labels.length - 3]! : sld;
      const c = compact(stem);
      if (c.length >= BRAND_TOKEN_MIN) out.add(c);
    }
  }
  return [...out];
}

export function keywordIsBrand(keyword: string, tokens: readonly string[]): boolean {
  const k = compact(keyword);
  return tokens.some((t) => k.includes(t));
}

export function brandCampaignIds(rows: ReadonlyArray<{ campaign_id: string; keyword: string }>, tokens: readonly string[]): Set<string> {
  const out = new Set<string>();
  if (tokens.length === 0) return out;
  const by = new Map<string, { n: number; brand: number }>();
  for (const r of rows) {
    const c = by.get(r.campaign_id) ?? { n: 0, brand: 0 };
    c.n += 1;
    if (keywordIsBrand(r.keyword, tokens)) c.brand += 1;
    by.set(r.campaign_id, c);
  }
  for (const [id, c] of by) if (c.n > 0 && c.brand * 2 > c.n) out.add(id);
  return out;
}

type GRow = { campaign?: { id?: string | number }; adGroupCriterion?: { keyword?: { text?: string } } };

export const couldBeBrandSearch = (channelType: string | null | undefined) => !channelType || channelType === "SEARCH";

export function googleBrandOf(id: string, channelType: string | null | undefined, brand: Set<string> | null): boolean | null {
  if (brand) return brand.has(id);
  return couldBeBrandSearch(channelType) ? null : false;
}

export const BRAND_SEARCH_CAMPAIGNS_MAX = 50;

export function redactError(message: string): string {
  return message
    .replace(/(bearer|token|secret|key|password|authorization|developer[-_ ]?token|refresh[-_ ]?token|access[-_ ]?token|client[-_ ]?secret)(["':=\s]+)[^\s"',}]+/gi, "$1$2[redacted]")
    .replace(/ya29\.[\w.-]+/g, "[redacted]")
    .replace(/[A-Za-z0-9_\-]{32,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .slice(0, 300);
}

export async function loadGoogleBrandCampaignIds(tenant_id: string): Promise<Set<string> | null> {
  const r = await readGoogleBrandCampaignIds(tenant_id);
  return "ids" in r ? r.ids : null;
}

export async function readGoogleBrandCampaignIds(tenant_id: string): Promise<{ ids: Set<string> } | { error: string }> {
  try {
    const { data, error } = await tenantClient(asTenantId(tenant_id)).from("tenants").select("display_name, product_url").limit(1);
    if (error) throw new Error(error.message);
    const t = ((data ?? [])[0] ?? {}) as { display_name?: string | null; product_url?: unknown };
    const { marketingUrlOf } = await import("@/services/brand/resolve-brand-kit");
    const tokens = brandTokens(t.display_name, marketingUrlOf(t.product_url));
    if (tokens.length === 0) return { ids: new Set() };
    const { gadsSearch } = await import("@/services/tools/google-ads/_client");
    const camps = (await gadsSearch(
      tenant_id,
      `SELECT campaign.id FROM campaign WHERE campaign.status = 'ENABLED' AND campaign.advertising_channel_type = 'SEARCH' LIMIT ${BRAND_SEARCH_CAMPAIGNS_MAX + 1}`,
    )) as GRow[];
    if (camps.length > BRAND_SEARCH_CAMPAIGNS_MAX) throw new Error(`more than ${BRAND_SEARCH_CAMPAIGNS_MAX} enabled Search campaigns`);
    const ids = new Set<string>();
    for (const c of camps) {
      const id = c.campaign?.id != null ? String(c.campaign.id) : "";
      if (!/^\d+$/.test(id)) continue;
      let rows: GRow[];
      try {
        rows = (await gadsSearch(
          tenant_id,
          `SELECT campaign.id, ad_group_criterion.keyword.text FROM keyword_view WHERE campaign.id = ${id} AND ad_group.status = 'ENABLED' AND ad_group_criterion.status = 'ENABLED' AND ad_group_criterion.negative = FALSE`,
          { complete: true },
        )) as GRow[];
      } catch (e) {
        if ((e as { code?: string }).code !== "google_ads_query_truncated") throw e;
        ids.add(id);
        continue;
      }
      const kws = rows
        .map((r) => ({ campaign_id: id, keyword: r.adGroupCriterion?.keyword?.text ?? "" }))
        .filter((r) => r.keyword);
      for (const b of brandCampaignIds(kws, tokens)) ids.add(b);
    }
    return { ids };
  } catch (e) {
    const error = redactError(String((e as Error)?.message ?? e));
    console.warn(`[ad-goal-match] google brand campaigns unread for ${tenant_id}: ${error}`);
    return { error };
  }
}

export type CutGoalMode = AdGoalMode | "unknown";

const META_PURCHASE = new Set(["purchase", "offsitepurchase"]);

export function metaResultsMatchGoal(conversionEvent: string | null | undefined, mode: CutGoalMode): boolean | null | undefined {
  if (mode === "native") return undefined;
  if (mode === "unknown" || !conversionEvent) return null;
  return META_PURCHASE.has(conversionEvent.toLowerCase().replace(/[^a-z]/g, ""));
}

export function googleResultsMatchGoal(purchaseCampaigns: ReadonlySet<string> | null, campaignId: string, mode: CutGoalMode): boolean | null | undefined {
  if (mode === "native") return undefined;
  if (mode === "unknown" || purchaseCampaigns === null) return null;
  return purchaseCampaigns.has(campaignId);
}

export async function loadGooglePurchaseCampaignIds(tenant_id: string): Promise<Set<string> | null> {
  try {
    const { gadsSearch } = await import("@/services/tools/google-ads/_client");
    const rows = (await gadsSearch(
      tenant_id,
      "SELECT campaign.id, segments.conversion_action_category, metrics.conversions FROM campaign WHERE segments.date DURING LAST_30_DAYS AND segments.conversion_action_category = 'PURCHASE'",
      { complete: true },
    )) as Array<{ campaign?: { id?: string | number }; metrics?: { conversions?: number | string } }>;
    const out = new Set<string>();
    for (const r of rows) if (r.campaign?.id != null && (Number(r.metrics?.conversions ?? 0) || 0) > 0) out.add(String(r.campaign.id));
    return out;
  } catch {
    return null;
  }
}

export type GoalMatchContext = { mode: CutGoalMode; googleBrand: Set<string> | null; googlePurchaseCampaigns: Set<string> | null };

export function withGoalMatch(objects: AdObjectFacts[], platform: "meta" | "google", ctx: GoalMatchContext): AdObjectFacts[] {
  return objects.map((o) => {
    const match = platform === "meta" ? metaResultsMatchGoal(o.conversionEvent, ctx.mode) : googleResultsMatchGoal(ctx.googlePurchaseCampaigns, o.id, ctx.mode);
    return {
      ...o,
      brand: platform === "google" ? googleBrandOf(o.id, o.channelType, ctx.googleBrand) : false,
      ...(match === undefined ? {} : { resultsMatchGoal: match }),
    };
  });
}

export async function loadGoalMatchContext(tenant_id: string, platform: "meta" | "google"): Promise<GoalMatchContext> {
  const goal = await loadAdGoalMode(tenant_id);
  const mode: CutGoalMode = goal.ok ? goal.mode : "unknown";
  if (platform === "meta") return { mode, googleBrand: null, googlePurchaseCampaigns: null };
  const [googleBrand, googlePurchaseCampaigns] = await Promise.all([
    loadGoogleBrandCampaignIds(tenant_id),
    mode === "native" ? Promise.resolve(null) : loadGooglePurchaseCampaignIds(tenant_id),
  ]);
  return { mode, googleBrand, googlePurchaseCampaigns };
}
