import { isAdImagePath, type CampaignLocation } from "@zavi/shared";

export const CHATGPT_ADS_SLUG = "chatgpt_ads";
export const API_BASE = "/api/channels/chatgpt_ads";
export const MANAGE_ON_WEB = "https://www.zaviagent.com/workspace?tab=channels&channel=chatgpt_ads";

export type Objective = { value: string; label: string; bidLabel?: string; bidMicros: number; automaticStrategy?: string; requiresEvent?: boolean };

export const SPEC = {
  title: "ChatGPT Ads",
  objectives: [
    { value: "clicks", label: "Clicks (CPC)", bidLabel: "Maximum cost-per-click bid", bidMicros: 1e6, automaticStrategy: "maximize_clicks" },
    { value: "impressions", label: "Views (CPM)", bidLabel: "Maximum bid per 1,000 impressions", bidMicros: 1000 },
    { value: "conversions", label: "Conversions (oCPC)", bidLabel: "Conversion bid (CPA)", bidMicros: 1e6, automaticStrategy: "maximize_conversions", requiresEvent: true },
  ] as Objective[],
  dailyMinimum: 25,
  platforms: [
    { value: "web", label: "Web (desktop and mobile)" },
    { value: "ios_app", label: "iOS app" },
    { value: "android_app", label: "Android app" },
  ],
  creative: { label: "chat card", type: "chat_card", contextLabel: "Buyer context hints", titleLimit: 50, bodyLimit: 100, tracking: "utm_source=chatgpt&utm_medium=paid" },
  metrics: [
    { field: "spend", label: "Spend", help: "Across your campaigns", format: "money" },
    { field: "impressions", label: "Impressions", help: "Ad impressions", format: "count" },
    { field: "clicks", label: "Clicks", help: "Ad clicks reported by OpenAI", format: "count" },
    { field: "conversions", label: "Conversions", help: "Click-through attribution", format: "count" },
    { field: "roas", label: "ROAS", help: "Attributed purchase return", format: "ratio" },
  ] as Array<{ field: "spend" | "impressions" | "clicks" | "conversions" | "roas"; label: string; help: string; format: "money" | "count" | "ratio" }>,
  empty: { title: "Create your first campaign with Zavi", body: "Review the researched draft, choose a budget and schedule, and save paused. Zavi handles advertiser setup before any ads can serve." },
};

export type Metrics = Partial<Record<"impressions" | "clicks" | "spend" | "ctr" | "cpc" | "cpm" | "conversions", number>>;

export type Targeting = {
  locations?: { countries?: string[]; include?: CampaignLocation[] };
  excluded_locations?: { countries?: string[]; include?: CampaignLocation[] };
  platforms?: { included: string[] };
  custom_audiences?: { ids: string[] };
  excluded_custom_audiences?: { ids: string[] };
};

export type Campaign = Metrics & {
  id: string;
  name: string;
  status: string | null;
  updated_at?: number;
  bidding_type?: string;
  budget?: { lifetime_spend_limit_micros?: number; daily_spend_limit_micros?: number };
  conversion_event_setting_ids?: string[];
  targeting?: Targeting;
  mode?: string | null;
  product_feed_id?: string;
  landing_page_configuration?: { query_string_template: string };
  start_time?: number | null;
  end_time?: number | null;
};

export type Entity = Metrics & {
  id: string;
  name: string;
  status: string | null;
  campaign_id: string;
  ad_group_id?: string;
  parent_name: string;
  metrics_unavailable?: boolean;
  review_status?: string;
  serving_issues?: string[];
  landing_page_configuration?: { query_string_template: string };
  bidding_config?: { strategy?: string; billing_event_type?: string; max_bid_micros?: number };
  context_hints?: string[];
  creative?: { type?: string; title?: string; body?: string; target_url?: string; image_url?: string; file_id?: string };
};

export type Draft = {
  type: "campaign_draft";
  name: string;
  bidding_type: "clicks" | "impressions" | "conversions";
  conversion_event_setting_ids?: string[];
  group: { name: string; context_hints: string[] };
  ads: Array<{ name: string; title: string; body: string; target_url: string; image_url?: string; image_spec?: string; tracking: string }>;
};

export type Dashboard = {
  source: string;
  campaigns: Campaign[];
  draft?: Draft;
  setup_notice?: string;
  totals_across_your_campaigns_only: Metrics;
  currency: string | null;
  period: { from: string; to: string; days: number; timezone?: string } | null;
  campaign_name_prefix?: string;
  no_campaigns_for_tenant?: boolean;
  error_code?: string;
  warning?: string;
  purchase_return?: { roas: number | null };
};

export type ResourceOptions = {
  conversion_events: Array<{ id: string; name: string }>;
  inclusion_audiences: Array<{ id: string; name: string }>;
  exclusion_audiences: Array<{ id: string; name: string }>;
  product_feeds: Array<{ id: string; name: string }>;
  warnings: string[];
};

export const EMPTY_OPTIONS: ResourceOptions = { conversion_events: [], inclusion_audiences: [], exclusion_audiences: [], product_feeds: [], warnings: [] };

export function asDashboard(payload: unknown): Dashboard | null {
  const p = payload as Dashboard | null;
  return p && typeof p === "object" && p.source === "chatgpt_ads_api" && Array.isArray(p.campaigns) ? p : null;
}

export function money(value: number | null | undefined, currency: string | null): string {
  if (value == null || !Number.isFinite(value) || !currency) return "—";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(value);
  } catch {
    return `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${currency}`;
  }
}
export const count = (n: number | null | undefined): string => (n == null || !Number.isFinite(n) ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: 2 }));
export const percent = (n: number | null | undefined): string => (n == null ? "—" : `${(n * 100).toFixed(2)}%`);
export const statusLabel = (s: string | null): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "Unknown");
export const statusTone = (s: string | null): "green" | "amber" | "muted" => (s === "active" ? "green" : s === "paused" ? "amber" : "muted");

export function dateOf(seconds: number | null | undefined): string {
  return seconds ? new Date(seconds * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";
}

export function shortName(name: string, prefix: string | undefined): string {
  return prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

export function budgetLine(c: Pick<Campaign, "budget">, currency: string | null): string {
  const b = c.budget;
  if (!b) return "—";
  const daily = b.daily_spend_limit_micros;
  const v = (daily ?? b.lifetime_spend_limit_micros ?? 0) / 1e6;
  return `${money(v, currency)}${daily != null ? " / day" : " total"}`;
}

export function metricCards(d: Dashboard | null): Array<{ key: string; label: string; value: string; help: string }> {
  const totals = d?.totals_across_your_campaigns_only ?? {};
  return SPEC.metrics.map((m) => {
    const raw = m.field === "roas" ? d?.purchase_return?.roas : totals[m.field];
    const value = m.format === "money" ? money(raw, d?.currency ?? null) : m.format === "ratio" ? (raw != null ? `${raw.toFixed(2)}×` : "—") : count(raw ?? undefined);
    return { key: m.field, label: m.label, value, help: m.help };
  });
}

export const canEditHere = (c: Pick<Campaign, "status">): boolean => c.status === "paused";

export function editBlocked(c: Pick<Campaign, "status">): string | null {
  if (c.status === "paused") return null;
  if (c.status === "active") return "Active campaigns change live delivery, so edit this one on zaviagent.com.";
  if (c.status === "archived") return "Archived campaigns cannot be edited.";
  return "This campaign cannot be edited right now.";
}

export type EditorForm = {
  name: string;
  objective: string;
  event: string;
  budgetType: "daily" | "lifetime";
  budget: string;
  start: string;
  end: string;
  countries: string;
  excludedCountries: string;
  locations: CampaignLocation[];
  excludedLocations: CampaignLocation[];
  platforms: string[];
  included: string[];
  excluded: string[];
  feed: string;
  template: string;
};

const pad = (n: number) => String(n).padStart(2, "0");

export function toLocalText(seconds?: number | null): string {
  if (!seconds) return "";
  const d = new Date(seconds * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function fromLocalText(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(t);
  if (!m) return Number.NaN;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
  const ok = d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) && d.getHours() === Number(m[4] ?? 0) && d.getMinutes() === Number(m[5] ?? 0) && d.getSeconds() === Number(m[6] ?? 0);
  return ok ? Math.floor(d.getTime() / 1000) : Number.NaN;
}

export function editorTime(text: string, original?: number | null): number | null {
  return text === toLocalText(original) ? original ?? null : fromLocalText(text);
}

export const countryCodes = (value: string): string[] => [...new Set(value.split(/[\s,]+/).map((v) => v.trim().toUpperCase()).filter(Boolean))];

export function formFrom(existing: Campaign | null, draft: Draft | undefined, prefix: string): EditorForm {
  const t = existing?.targeting;
  const amount = existing?.budget ? (existing.budget.daily_spend_limit_micros ?? existing.budget.lifetime_spend_limit_micros ?? 0) / 1e6 : null;
  return {
    name: existing ? shortName(existing.name, prefix) : shortName(draft?.name ?? "", prefix),
    objective: existing?.bidding_type ?? draft?.bidding_type ?? SPEC.objectives[0].value,
    event: existing?.conversion_event_setting_ids?.[0] ?? draft?.conversion_event_setting_ids?.[0] ?? "",
    budgetType: existing?.budget?.daily_spend_limit_micros != null ? "daily" : "lifetime",
    budget: amount === null ? "" : String(amount),
    start: toLocalText(existing?.start_time),
    end: toLocalText(existing?.end_time),
    countries: t?.locations?.countries?.join(", ") ?? "",
    excludedCountries: t?.excluded_locations?.countries?.join(", ") ?? "",
    locations: t?.locations?.include ?? [],
    excludedLocations: t?.excluded_locations?.include ?? [],
    platforms: t?.platforms?.included ?? SPEC.platforms.map((p) => p.value),
    included: t?.custom_audiences?.ids ?? [],
    excluded: t?.excluded_custom_audiences?.ids ?? [],
    feed: existing?.product_feed_id ?? "",
    template: existing?.landing_page_configuration?.query_string_template ?? "",
  };
}

export function formProblem(f: EditorForm, currency: string | null, existing: Campaign | null): string | null {
  const objective = SPEC.objectives.find((o) => o.value === f.objective);
  const daily = f.budgetType === "daily";
  const budget = Number(f.budget);
  if (f.name.trim().length < 3) return "Give the campaign a name of at least 3 characters.";
  if (!currency) return "Account currency is not available yet. Refresh and try again.";
  if (objective?.requiresEvent && !f.event) return "Choose a verified conversion event.";
  if (!f.budget.trim() || !Number.isFinite(budget) || budget < (daily ? SPEC.dailyMinimum : 1)) {
    return daily ? `A daily budget starts at ${money(SPEC.dailyMinimum, currency)}.` : "Enter a campaign budget of at least 1.";
  }
  if (Math.abs(budget * 100 - Math.round(budget * 100)) > 0.000001) return "Use no more than two decimal places for the budget.";
  if (budget > 1_000_000) return "That budget is above the most one campaign can have.";
  const start = editorTime(f.start, existing?.start_time);
  const end = editorTime(f.end, existing?.end_time);
  if (Number.isNaN(start) || Number.isNaN(end)) return "Write dates as 2026-10-12 09:00.";
  const previousBudget = existing?.budget?.daily_spend_limit_micros ?? existing?.budget?.lifetime_spend_limit_micros;
  const financialEdit = Math.round(budget * 1e6) !== previousBudget || start !== (existing?.start_time ?? null) || end !== (existing?.end_time ?? null);
  const validateSchedule = !existing || financialEdit;
  if (validateSchedule && daily && (start === null || end === null)) return "A daily campaign needs a start and an end time.";
  if (validateSchedule && start !== null && end !== null && end <= start) return "The end time must be after the start.";
  if (validateSchedule && end !== null && end <= Date.now() / 1000) return "Choose an end time in the future.";
  if (validateSchedule && daily && start !== null && end !== null && end - start > 90 * 86400) return "A daily campaign can run for at most 90 days.";
  if (!f.platforms.length) return "Select at least one platform.";
  if (existing && existing.status !== "paused") return editBlocked(existing);
  return null;
}

export type SaveRequest = { path: string; body: Record<string, unknown> };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function saveRequest(f: EditorForm, existing: Campaign | null): SaveRequest {
  const objective = SPEC.objectives.find((o) => o.value === f.objective);
  const daily = f.budgetType === "daily";
  const targeting: Targeting = {
    ...existing?.targeting,
    locations: { countries: countryCodes(f.countries), include: f.locations.map(({ id }) => ({ id })) },
    excluded_locations: { countries: countryCodes(f.excludedCountries), include: f.excludedLocations.map(({ id }) => ({ id })) },
    ...(f.platforms.length ? { platforms: { included: f.platforms } } : {}),
    custom_audiences: { ids: f.included },
    excluded_custom_audiences: { ids: f.excluded },
  };
  const body: Record<string, unknown> = { name: f.name.trim() };
  const amount = Math.round(Number(f.budget) * 1e6);
  const old = existing?.budget?.daily_spend_limit_micros ?? existing?.budget?.lifetime_spend_limit_micros;
  if (amount !== old) body[daily ? "daily_budget_micros" : "lifetime_budget_micros"] = amount;
  if (!same(targeting, existing?.targeting)) body.targeting = targeting;
  const start = editorTime(f.start, existing?.start_time);
  const end = editorTime(f.end, existing?.end_time);
  if (start !== (existing?.start_time ?? null)) body.start_time = start;
  if (end !== (existing?.end_time ?? null)) body.end_time = end;
  if (f.template !== (existing?.landing_page_configuration?.query_string_template ?? "")) body.landing_page_configuration = { query_string_template: f.template };
  if (existing) body.expected_updated_at = existing.updated_at;
  else {
    body.bidding_type = f.objective;
    if (objective?.requiresEvent) body.conversion_event_setting_ids = [f.event];
    if (f.feed) {
      body.mode = "product_feed";
      body.product_feed_id = f.feed;
    }
  }
  return { path: `${API_BASE}/campaigns${existing ? `/${existing.id}` : ""}`, body };
}

export const EDITOR_NOTE =
  "New campaigns are saved paused. Add ad groups and creatives before activating on zaviagent.com. Spend reporting can be delayed; pausing does not instantly stop all billable activity.";

export const DAILY_NOTE =
  "Daily campaigns require an end date within 90 days. Daily spend can reach twice the average. Zavi reserves twice the daily budget for the scheduled days plus a two-day buffer; previous coverage is retained when budgets change.";

export type GroupForm = { name: string; hints: string; strategy: string; bid: string };

export function groupRequest(campaignId: string, campaign: Campaign | undefined, f: GroupForm, editingId: string | null): SaveRequest {
  const objective = SPEC.objectives.find((o) => o.value === campaign?.bidding_type);
  const bidMicros = objective?.bidMicros ?? 1e6;
  return {
    path: `${API_BASE}/campaigns/${encodeURIComponent(campaignId)}/ad-groups${editingId ? `/${editingId}/edit` : ""}`,
    body: {
      name: f.name,
      context_hints: f.hints.split("\n").map((s) => s.trim()).filter(Boolean),
      strategy: f.strategy,
      ...(f.strategy === "fixed_bid" ? { max_bid_micros: Math.round(Number(f.bid) * bidMicros) } : {}),
    },
  };
}

export function groupProblem(f: GroupForm, campaign: Campaign | undefined): string | null {
  if (f.name.trim().length < 3) return "Give the ad group a name of at least 3 characters.";
  if (f.strategy === "fixed_bid") {
    const bidMicros = SPEC.objectives.find((o) => o.value === campaign?.bidding_type)?.bidMicros ?? 1e6;
    const bid = Number(f.bid);
    if (!f.bid.trim() || !Number.isFinite(bid) || bid < 1 / bidMicros || bid > 1e9 / bidMicros) return "Enter a bid within the allowed range.";
  }
  return null;
}

export const bidText = (e: Entity | null, campaign: Campaign | undefined): string => {
  const bidMicros = SPEC.objectives.find((o) => o.value === campaign?.bidding_type)?.bidMicros ?? 1e6;
  return e?.bidding_config?.max_bid_micros != null ? String(e.bidding_config.max_bid_micros / bidMicros) : "";
};

export type AdForm = { group: string; name: string; title: string; body: string; url: string; image: string | null; tracking: string };

export function trackingFor(fallback: string, url?: string): string {
  if (!url) return fallback;
  try {
    const kept = Array.from(new URL(url).searchParams).filter(([k]) => k.startsWith("utm_"));
    return kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  } catch {
    return "";
  }
}

export function adRequest(campaign: Campaign | undefined, campaignId: string, f: AdForm, editing: Entity | null): SaveRequest {
  const product = campaign?.mode === "product_feed";
  const image = f.image ? (isAdImagePath(f.image) ? { image_path: f.image } : { image_url: f.image }) : {};
  return {
    path: `${API_BASE}/campaigns/${encodeURIComponent(campaignId)}/creatives${editing ? `/${editing.id}` : ""}`,
    body: {
      ad_group_id: editing?.ad_group_id ?? f.group,
      name: f.name,
      title: f.title,
      body: f.body,
      ...(!product ? { target_url: f.url, ...image } : { creative_type: "product_ad_template" }),
      tracking: "",
      landing_page_configuration: { query_string_template: f.tracking },
    },
  };
}

export function adProblem(f: AdForm, campaign: Campaign | undefined, editing: Entity | null): string | null {
  const product = campaign?.mode === "product_feed";
  if (f.name.trim().length < 3) return "Give the ad a name of at least 3 characters.";
  if (!editing && !f.group) return "Choose an ad group.";
  if (f.title.trim().length < 3 || f.title.length > SPEC.creative.titleLimit) return `The title needs 3 to ${SPEC.creative.titleLimit} characters.`;
  if (!f.body.trim() || f.body.length > SPEC.creative.bodyLimit) return `The ad copy needs 1 to ${SPEC.creative.bodyLimit} characters.`;
  if (!product) {
    if (!/^https?:\/\/\S+$/i.test(f.url.trim())) return "Enter the page visitors should land on, starting with https://.";
    if (!editing && !f.image) return "Choose an image for the ad.";
  }
  return null;
}

export const adEditable = (e: Entity): boolean => [SPEC.creative.type, "product_ad_template"].includes(e.creative?.type ?? "");

export const AD_NOTE =
  "Tracking replaces UTM and click_id parameters in the destination URL. Supports click_id={oppref}. Saving an edited ad pauses it for your review.";

export const SAVED_PAUSED = "Saved. New or edited creatives stay paused until you activate them on zaviagent.com.";

export function requestKey(previous: { signature: string; id: string } | null, path: string, body: unknown, newId: () => string): { signature: string; id: string } {
  const signature = JSON.stringify([path, body]);
  return previous?.signature === signature ? previous : { signature, id: newId() };
}
