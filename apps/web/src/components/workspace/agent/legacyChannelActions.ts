import { gadsCampaignTable, gadsDailyBudgetTable } from "./google-ads/campaignTableData";
export { gadsCampaignTable } from "./google-ads/campaignTableData";
import { chatgptChrome } from "../chatgpt-ads/adapters";

import { apiFetch } from "@/lib/api";
import { approveDecision } from "@/lib/approvals/approveDecision";
import type { ChannelActionView, ChannelMetric } from "@/lib/workspace/channelActionsApi";
import type { ActionType } from "@/lib/workspace/actionTypes";
import type { ActionHandlers, ActionItem, PlatformSpec } from "../actions/types";
import type { GadsAction, GadsKpi, GadsPacing, GadsPayload, GadsRange } from "./google-ads/types";
import type { XAttention, XDraft, XMetric, XPayload } from "./XAgentDashboard";
import { count, DEFAULT_RANGES, money, roas } from "./google-ads/types";
import { paceTone, roasVerdict } from "../metrics/format";
import type { ExtraTableData } from "../actions/ExtraTable";
import { redditKpiTables } from "./reddit/extraTables";
import type { RedditPayload } from "./reddit/shared";
import { seoHealth, seoKpis, seoPagesReadWords, seoTables } from "../seo/extraTables";
import type { ChannelHealth } from "../metrics/HealthSummary";
import type { SeoChannelPayload } from "../seo/types";
import { xChrome, xTables } from "./xTables";
import { geoChrome, geoKpis, geoTables } from "../geo/extraTables";
import { linkedinChrome, linkedinKpis, linkedinTables } from "./linkedinTables";
import { instagramChrome, instagramKpis, instagramTables } from "./instagramTables";
import { pinterestChrome, pinterestKpis } from "./pinterestDashboard";
import { tiktokChrome, tiktokKpis, tiktokTables } from "./tiktokTables";
import { metaCampaignLinks, metaCampaignTable, metaChrome, metaKpis } from "./metaAdsTables";
import { isTiktokPayload, tiktokCampaignLinks, tiktokCampaignTable, tiktokChrome as tiktokAdsChrome, tiktokKpis as tiktokAdsKpis } from "./tiktokAdsTables";
import { isRedditAdsPayload, redditAdsCampaignLinks, redditAdsCampaignTable, redditAdsChrome, redditAdsKpis } from "./redditAdsTables";
import { isLinkedinAdsPayload, linkedinAdsAccountId, linkedinAdsAdsTable, linkedinAdsCampaignLinks, linkedinAdsCampaignTable, linkedinAdsChrome, linkedinAdsGroupTable, linkedinAdsKpis } from "./linkedinAdsTables";
import type { TenantRole } from "@/lib/members";
import { isXAdsPayload, xAdsCampaignLinks, xAdsCampaignTable, xAdsChrome, xAdsKpis } from "./xAdsTables";

export function legacyApprovalHandlers(io: {
  setBusy: (id: string | null) => void;
  setNotice: (n: string | null) => void;
  refetch: () => void;
  approvedNote?: string;
}): ActionHandlers {
  const call = async (a: ActionItem, run: () => Promise<Response | null>, ok: string): Promise<boolean> => {
    io.setBusy(a.id);
    io.setNotice(null);
    try {
      const res = await run();
      if (!res) return false;
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      if (!res.ok) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      io.setNotice(ok);
      io.refetch();
      return true;
    } catch (e) {
      io.setNotice((e as Error).message);
      return false;
    } finally {
      io.setBusy(null);
    }
  };
  return {
    onSetStatus: (a, status, opts) => {
      if (status === "acted") return call(a, () => approveDecision(a.id), "Marked done.");
      if (status === "rejected") {
        return call(a, () => apiFetch(`/api/approvals/${a.id}/reject`, { method: "POST" }), "Rejected. Nothing changes in your account.");
      }
      return call(
        a,
        () => apiFetch(`/api/approvals/${a.id}/snooze`, { method: "POST", body: JSON.stringify(opts?.until ? { until: opts.until } : {}) }),
        "Hidden for now. It comes back on its own.",
      );
    },
    onRedo: (a, note) =>
      call(
        a,
        () => apiFetch(`/api/approvals/${a.id}/redo`, { method: "POST", body: JSON.stringify({ message: note }), idempotent: true }),
        "Zavi is running this channel again with your note.",
      ),
    onApprove: (a) => call(a, () => approveDecision(a.id), io.approvedNote ?? "Approved. Zavi is making the change now."),
  };
}

export { CHECK_CARD_PREFIX, xCheckToView, xDraftToView, xDraftsToViews } from "./cardViews";
import { base, xDraftToView } from "./cardViews";

export function gadsActionType(decision_class: string): ActionType {
  if (decision_class === "channel.recipe_step") return "other";
  if (/pause|remove|negative/i.test(decision_class)) return "pause_ad";
  if (/create|add_|new_/i.test(decision_class)) return "create_ad";
  if (/^google_ads\./.test(decision_class)) return "update_ad";
  return "other";
}

export function gadsActionToView(a: GadsAction): ChannelActionView {
  const type = gadsActionType(a.decision_class);
  const applied = !!a.applied_at;
  return {
    ...base(a.decision_id, "google_ads", type, a.title, a.applied_at ?? ""),
    status: applied ? "acted" : "pending",
    executable: !applied && a.bucket === "needs_approval" && a.decision_class.startsWith("google_ads."),
    body: {
      step: {
        title: a.title,
        body: a.change_sentence ?? undefined,
        effort: a.effort_label,
      },
      change_sentence: a.change_sentence,
      exact_change: a.exact_change,
      decision_evidence: {
        ...(a.evidence?.tiles?.length ? { stats: a.evidence.tiles } : {}),
        ...(a.estimate?.tiles?.length ? { estimate: a.estimate.tiles } : {}),
        ...(a.evidence?.reasoning ? { reason_text: a.evidence.reasoning } : {}),
      },
      link: a.link,
    },
  };
}

export function gadsActionsToViews(actions: GadsAction[]): ChannelActionView[] {
  return actions.filter((a) => !a.applied_at).map(gadsActionToView);
}

const GADS_UNIT: Record<GadsKpi["unit"], string> = { usd: "usd", count: "count", ratio: "ratio", pct: "pct" };

export function gadsKpisToMetrics(d: GadsPayload): ChannelMetric[] {
  const day = d.period?.to ?? "";
  const prevDay = d.prev_period?.to ?? null;
  return d.kpis
    .map((k) => ({
      key: k.key,
      value: k.value ?? Number.NaN,
      unit: k.key === "pacing" ? "pct" : GADS_UNIT[k.unit],
      window_kind: `${d.window_days}d`,
      day,
      grounded: k.value !== null,
      prev_value: k.floor === true ? null : k.prev,
      prev_day: k.floor === true || k.prev === null ? null : prevDay,
      ...(k.key === "roas" ? roasVerdict(k.value, { floor: k.floor === true }) : {}),
      ...(k.key === "pacing" ? paceDisplay(k) : {}),
    }));
}

function paceDisplay(k: GadsKpi): Pick<ChannelMetric, "tone" | "note"> {
  const p = k.pacing;
  const tone = paceTone(k.value);
  const note =
    p && p.spend !== null && p.plan !== null
      ? `${money(p.spend)} of ${money(p.plan)} · day ${p.days_elapsed} of ${p.days_in_month}`
      : undefined;
  return { ...(tone ? { tone } : {}), ...(note ? { note } : {}) };
}

const THIN_VIEWS = 100;

export function xMetricsToMetrics(metrics: XMetric[], day = ""): ChannelMetric[] {
  const views = metrics.find((m) => m.key === "impressions")?.value ?? null;
  const ordered = [...metrics.filter((m) => m.unit !== "pct"), ...metrics.filter((m) => m.unit === "pct")];
  return ordered.map((m) => {
      const value = m.value ?? Number.NaN;
      const prev =
        m.delta === null
          ? null
          : m.delta_unit === "pp"
            ? value - m.delta
            : m.delta === -100
              ? 0
              : Math.round((value / (1 + m.delta / 100)) * 100) / 100;
      return {
        key: m.key,
        value,
        unit: m.unit === "pct" ? "pct" : "count",
        window_kind: null,
        day,
        grounded: m.value !== null && m.basis !== "none",
        prev_value: prev,
        prev_day: null,
        ...(m.key === "engagement_rate" && m.value !== null && views !== null && views < THIN_VIEWS
          ? { note: `From only ${views} ${views === 1 ? "view" : "views"}` }
          : {}),
      };
    });
}

export function redditKpisToMetrics(d: RedditPayload): ChannelMetric[] {
  const insights = d.insights;
  if (!insights?.has_data || !insights.kpis) return [];
  const k = insights.kpis;
  const row = (key: string, m: { value?: number; previous?: number | null } | undefined): ChannelMetric => {
    const value = typeof m?.value === "number" ? m.value : Number.NaN;
    return {
      key,
      value,
      unit: "count",
      window_kind: null,
      day: "",
      grounded: Number.isFinite(value),
      prev_value: typeof m?.previous === "number" ? m.previous : null,
      prev_day: null,
    };
  };
  const unscanned = (m: ChannelMetric, scanned: number | undefined, why = "Not scanned today"): ChannelMetric =>
    scanned === 0 ? { ...m, unmeasured: why, prev_value: null } : m;
  return [
    unscanned(row("brand_mentions", k.brand_mentions), k.brand_mentions?.scanned, "Not scanned this week"),
    row("reply_opportunities", k.reply_opportunities),
    unscanned(row("relevant_posts", k.relevant_posts), k.relevant_posts?.scanned),
    unscanned(row("relevant_comments", k.relevant_comments), k.relevant_comments?.scanned),
    row("subreddits", k.subreddits),
  ];
}

export type KpiFallbackId = NonNullable<PlatformSpec["kpiFallback"]>;

export function kpiFallbackHealth(id: KpiFallbackId, payload: unknown): ChannelHealth | null {
  if (!payload || typeof payload !== "object") return null;
  try {
    return id === "seo" ? seoHealth(payload) : null;
  } catch {
    return null;
  }
}

export function kpiFallbackMetrics(id: KpiFallbackId, payload: unknown): ChannelMetric[] {
  if (!payload || typeof payload !== "object") return [];
  try {
    switch (id) {
      case "chatgpt": return [];
      case "gads": {
        const d = payload as GadsPayload;
        return Array.isArray(d.kpis) ? gadsKpisToMetrics(d) : [];
      }
      case "x": {
        const d = payload as XPayload;
        return Array.isArray(d.metrics) ? xMetricsToMetrics(d.metrics, d.period?.to ?? "") : [];
      }
      case "reddit": {
        return redditKpisToMetrics(payload as RedditPayload);
      }
      case "geo": {
        return geoKpis(payload);
      }
      case "seo": {
        return seoKpis(payload as SeoChannelPayload);
      }
      case "linkedin": {
        return linkedinKpis(payload);
      }
      case "instagram": {
        return instagramKpis(payload);
      }
      case "pinterest": {
        return pinterestKpis(payload);
      }
      case "tiktok": {
        return tiktokKpis(payload);
      }
      case "meta": {
        return metaKpis(payload);
      }
      case "tiktok_ads": {
        return tiktokAdsKpis(payload);
      }
      case "reddit_ads": {
        return redditAdsKpis(payload);
      }
      case "linkedin_ads": {
        return linkedinAdsKpis(payload);
      }
      case "x_ads": {
        return xAdsKpis(payload);
      }
      default: {
        const unhandled: never = id;
        void unhandled;
        return [];
      }
    }
  } catch {
    return [];
  }
}

export type ExtraTableId = NonNullable<PlatformSpec["extras"]>[number];

export type ExtraTableCtx = {
  role?: TenantRole | null;
  onActionsChanged?: () => void;
};

export function extraTableData(
  id: ExtraTableId,
  payload: unknown,
  onChanged?: () => void,
  ctx?: ExtraTableCtx,
): ExtraTableData[] {
  if (!payload || typeof payload !== "object") return [];
  try {
    switch (id) {
      case "campaign_table": {
        if (isTiktokPayload(payload)) return tiktokCampaignTable(payload);
        if (isRedditAdsPayload(payload)) return redditAdsCampaignTable(payload);
        if (isLinkedinAdsPayload(payload)) {
          return linkedinAdsCampaignTable(payload, {
            canPause: ctx?.role === "owner" || ctx?.role === "admin",
            onFiled: ctx?.onActionsChanged,
          });
        }
        if (isXAdsPayload(payload)) return xAdsCampaignTable(payload);
        if ("channels" in payload) return metaCampaignTable(payload, { canEdit: ctx?.role === "owner" || ctx?.role === "admin" });
        const d = payload as GadsPayload;
        if (d.connected === false) return [];
        if (!Array.isArray(d.campaigns)) return [];
        const breakdown = gadsDailyBudgetTable(d);
        return [...(breakdown ? [breakdown] : []), gadsCampaignTable(d, { canEdit: ctx?.role === "owner" || ctx?.role === "admin" })];
      }
      case "campaign_group_table": {
        if (!isLinkedinAdsPayload(payload)) return [];
        return linkedinAdsGroupTable(payload, { canPause: ctx?.role === "owner" || ctx?.role === "admin", onFiled: ctx?.onActionsChanged });
      }
      case "ads_table": {
        if (!isLinkedinAdsPayload(payload)) return [];
        return linkedinAdsAdsTable(payload, { canPause: ctx?.role === "owner" || ctx?.role === "admin", onFiled: ctx?.onActionsChanged });
      }
      case "x_tables": {
        return xTables(payload, onChanged);
      }
      case "reddit_kpi_tables": {
        return redditKpiTables(payload, onChanged);
      }
      case "geo_tables": {
        return geoTables(payload, onChanged);
      }
      case "seo_tables": {
        return seoTables(payload);
      }
      case "linkedin_tables": {
        return linkedinTables(payload);
      }
      case "instagram_tables": {
        return instagramTables(payload);
      }
      case "tiktok_tables": {
        return tiktokTables(payload);
      }
      default: {
        const unhandled: never = id;
        void unhandled;
        return [];
      }
    }
  } catch {
    return [];
  }
}

export type ChannelPlan = GadsPacing;

export type ChannelChrome = {
  connected: boolean;
  ranges: GadsRange[];
  period: { from: string; to: string } | null;
  account: { name: string | null; sub: string } | null;
  readNote?: string;
  problem: { text: string; reconnect: boolean; firstConnect?: boolean; settings?: string } | null;
  plan: ChannelPlan | null;
};

export function channelChrome(id: KpiFallbackId, payload: unknown): ChannelChrome | null {
  if (!payload || typeof payload !== "object") return null;
  try {
    switch (id) {
      case "chatgpt": return chatgptChrome(payload);
      case "gads": {
        const d = payload as GadsPayload;
        if (typeof d.connected !== "boolean") return null;
        const n = d.account?.campaign_count;
        return {
          connected: d.connected,
          ranges: d.ranges?.length ? d.ranges : DEFAULT_RANGES,
          period: d.period ?? null,
          account: d.kpis?.length
            ? {
                name: d.account?.name ?? null,
                sub:
                  n === null || n === undefined
                    ? "Campaigns could not be read"
                    : `${n} ${n === 1 ? "campaign" : "campaigns"}`,
              }
            : null,
          problem:
            d.error_code === "google_ads_token_revoked"
              ? {
                  text: "Google Ads stopped accepting Zavi's access, so these numbers could not be read. Reconnect to bring them back.",
                  reconnect: true,
                }
              : d.error_code
                ? {
                    text: "Zavi could not read your Google Ads account just now. Try Refresh in a minute.",
                    reconnect: false,
                  }
                : null,
          plan: d.kpis?.find((k) => k.key === "pacing")?.pacing ?? null,
        };
      }
      case "reddit": {
        return { connected: true, ranges: [], period: null, account: null, problem: null, plan: null };
      }
      case "geo": {
        return geoChrome(payload);
      }
      case "seo": {
        const d = payload as SeoChannelPayload;
        const health = d.site_health;
        return {
          connected: true,
          ranges: [{ id: "now", label: "Latest read", days: 30 }],
          period: null,
          account:
            health?.status === "ok" && health.site
              ? {
                  name: health.site.replace(/^https?:\/\//, "").replace(/\/$/, ""),
                  sub: seoPagesReadWords(health),
                }
              : null,
          problem:
            health?.status === "error"
              ? {
                  text: "Zavi could not read your site just now, so the crawl numbers are missing. Try Refresh in a minute.",
                  reconnect: false,
                }
              : null,
          plan: null,
        };
      }
      case "x": {
        return xChrome(payload);
      }
      case "linkedin": {
        return linkedinChrome(payload);
      }
      case "instagram": {
        return instagramChrome(payload);
      }
      case "pinterest": {
        return pinterestChrome(payload);
      }
      case "tiktok": {
        return tiktokChrome(payload);
      }
      case "meta": {
        return metaChrome(payload);
      }
      case "tiktok_ads": {
        return tiktokAdsChrome(payload);
      }
      case "reddit_ads": {
        return redditAdsChrome(payload);
      }
      case "linkedin_ads": {
        return linkedinAdsChrome(payload);
      }
      case "x_ads": {
        return xAdsChrome(payload);
      }
      default: {
        const unhandled: never = id;
        void unhandled;
        return null;
      }
    }
  } catch {
    return null;
  }
}

export function channelAccountOf(payload: unknown): string | null {
  return linkedinAdsAccountId(payload);
}

export function campaignLinksOf(payload: unknown): Record<string, string> {
  if (!payload || typeof payload !== "object") return {};
  if (isTiktokPayload(payload)) return tiktokCampaignLinks(payload);
  if (isRedditAdsPayload(payload)) return redditAdsCampaignLinks(payload);
  if (isLinkedinAdsPayload(payload)) return linkedinAdsCampaignLinks(payload);
  if (isXAdsPayload(payload)) return xAdsCampaignLinks(payload);
  if ("channels" in payload) return metaCampaignLinks(payload);
  const campaigns = (payload as Partial<GadsPayload>).campaigns;
  const out: Record<string, string> = {};
  if (!Array.isArray(campaigns)) return out;
  for (const c of campaigns) if (c.name && c.url) out[c.name] = c.url;
  return out;
}
