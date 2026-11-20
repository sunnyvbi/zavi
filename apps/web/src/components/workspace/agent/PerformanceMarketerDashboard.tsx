"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useWorkspace } from "@/components/workspace/WorkspaceShell";
import { useRefreshingSignal, type AttentionItem } from "./dashboard-ui";
import { ChannelEmpty } from "../layout/shared";
import {
  AdsManagerBudgetModal,
  type BudgetModalCampaign,
  type ModalMode,
  type RoasBand,
} from "./AdsManagerBudgetModal";
import {
  PerfMarketerTrendChart,
  type DailySeries,
  type BookingTrend,
} from "./PerfMarketerTrendChart";
import { ChannelKpiCards } from "./ChannelKpiCards";
import { Skeleton } from "../Skeleton";
import { AdsCampaignDetailDrawer } from "./AdsCampaignDetailDrawer";
import {
  AdsManagerDateRangePicker,
  presetRange,
  resolveWindow,
  ymd,
  type ResolvedRange,
} from "./AdsManagerDateRangePicker";

const DASHBOARD_TIMEOUT_MS = 60000;

const DASH_CACHE = new Map<string, DashboardData>();
const DASH_CACHE_TTL_MS = 3 * 60 * 60 * 1000;
export function dashboardCacheTimestampFresh(
  fetchedAt: string | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!fetchedAt) return true;
  const fetchedMs = Date.parse(fetchedAt);
  return (
    Number.isFinite(fetchedMs) &&
    nowMs - fetchedMs <= DASH_CACHE_TTL_MS
  );
}
function cacheEntryFresh(d: DashboardData | undefined): d is DashboardData {
  return !!d && dashboardCacheTimestampFresh(d.fetched_at);
}
function initialCacheEntry(
  tenant: string | undefined,
  win: string,
): DashboardData | null {
  const key = cacheKey(tenant, win);
  const cached = DASH_CACHE.get(key);
  if (cacheEntryFresh(cached)) return cached;
  DASH_CACHE.delete(key);
  return null;
}
function formatFreshness(d: DashboardData): string {
  if (d.cached === false) return "Live";
  if (!d.fetched_at) return "";
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(d.fetched_at)) / 60000));
  if (mins < 1) return "Updated just now";
  if (mins < 60) return `Updated ${mins}m ago`;
  return `Updated ${Math.round(mins / 60)}h ago`;
}

export function freshnessBadgeLabel(
  freshness: string,
  refreshing: boolean,
  refreshFailed: boolean,
): string {
  if (refreshing) return "Refreshing…";
  if (refreshFailed) {
    return freshness.startsWith("Updated ")
      ? `couldn't refresh · showing data from ${freshness.slice("Updated ".length)}`
      : "couldn't refresh";
  }
  return freshness;
}

export function campaignsTableTitle(count: number, total?: number | null): string {
  if (total != null && total > count) return `Your campaigns (${count} of ${total})`;
  return count === 1 ? "Your campaign (1)" : `Your campaigns (${count})`;
}

export function refreshCameBackStale(
  refresh: boolean,
  d: Pick<DashboardData, "served_last_good">,
): boolean {
  return refresh && d.served_last_good === true;
}
export function channelErrorBanner(
  label: "Meta" | "Google",
  err: ChannelError,
  servedLastGood: boolean,
): string {
  const busy = /try again after (\d{1,2}:\d{2}) UTC/.exec(err.message);
  const limited =
    err.code === "meta_ads_busy" || /request limit|too many calls|rate limit/i.test(err.message);
  const shown = servedLastGood
    ? "Showing the last good data."
    : "No data could be loaded for this range yet.";
  if (limited) {
    const when = busy ? `after ${busy[1]} UTC` : "in a few minutes";
    return `${label} is limiting requests right now. ${shown} Try Refresh ${when}.`;
  }
  return `${label} couldn't be reached. ${shown} Try Refresh in a minute.`;
}

const cacheKey = (tenant: string | undefined, win: string) =>
  `${tenant ?? "_"}:${win}`;

type ChannelRow = {
  channel: "meta" | "google";
  connected: boolean;
  spend_usd: number;
  conversions: number;
  revenue_usd: number;
  roas: number | null;
  cpa_usd: number | null;
  impressions: number;
  clicks: number;
  ctr_percent: number | null;
  cpc_usd: number | null;
  cpm_usd: number | null;
};

type CampaignRow = {
  channel: "meta" | "google";
  campaign_id: string;
  campaign_name: string;
  status?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  reach?: number | null;
  spend_usd: number;
  conversions: number;
  revenue_usd: number;
  roas: number | null;
  cpa_usd: number | null;
  impressions: number;
  clicks: number;
  ctr_percent: number | null;
  cpc_usd: number | null;
  cpm_usd: number | null;
  frequency: number | null;
  purchases: number;
  sign_ups: number;
  leads: number;
  cost_per_booking_usd: number | null;
  active_daily_budget_usd?: number | null;
  optimization_label?: string | null;
  ad_sets?: AdSetRow[];
  objective_key?: string;
  objective_label?: string;
  primary_result_label?: string;
  primary_result_count?: number;
  primary_cost_label?: string | null;
  primary_cost_usd?: number | null;
  objective_status?: ObjectiveStatus;
  confidence_reasons?: string[];
  is_delivering?: boolean;
  pending_change?: { kind: "budget" | "status"; label: string } | null;
  recent_daily_spend_usd?: number | null;
  triage_state?: TriageState;
  triage_reasons?: string[];
  manage_url: string | null;
};

type AdSetRow = {
  ad_set_id: string;
  ad_set_name: string;
  optimization_event: string | null;
  daily_budget_usd: number | null;
};

type ObjectiveStatus = "scale" | "watch" | "cut" | "pause" | "hold";
type TriageState = "act_now" | "watch" | "settling" | "ok";

type ObjectiveGroup = {
  objective_key: string;
  objective_label: string;
  spend_usd: number;
  active_daily_budget_usd: number | null;
  revenue_usd: number;
  roas: number | null;
  conversions: number;
  primary_result_label: string;
  primary_result_count: number;
  primary_cost_label: string | null;
  primary_cost_usd: number | null;
  status: ObjectiveStatus;
  confidence_reasons: string[];
  campaigns_count: number;
};

type SpendSummary = {
  spend_usd: number;
  daily_run_rate_usd: number;
  active_daily_budget_usd: number | null;
  revenue_usd: number;
  roas: number | null;
  primary_result_label: string;
  primary_result_count: number;
  primary_cost_label: string | null;
  primary_cost_usd: number | null;
  target_outcome_label: string;
  confidence_reasons: string[];
};

type ChannelError = { code: string; message: string };

type DashboardData = {
  generic: boolean;
  window: string;
  window_label: string;
  refreshed_at: string;
  fetched_at?: string;
  cached?: boolean;
  stale?: boolean;
  served_last_good?: boolean;
  served_last_good_channels?: string[];
  channel_errors?: { meta?: ChannelError; google?: ChannelError } | null;
  connected: { meta: boolean; google: boolean };
  kpis: {
    spend_usd: number;
    conversions: number;
    revenue_usd: number;
    roas: number | null;
    cpa_usd: number | null;
    impressions: number;
    clicks: number;
    ctr_percent: number | null;
    cpc_usd: number | null;
    cpm_usd: number | null;
  };
  spend_summary?: SpendSummary;
  objective_groups?: ObjectiveGroup[];
  channels: ChannelRow[];
  campaigns: CampaignRow[];
  total_campaigns?: number;
  top_campaigns: CampaignRow[];
  bottom_campaigns: CampaignRow[];
  pixel: { status: string } | null;
  attention: AttentionItem[];
  daily_series?: DailySeries | null;
  daily_series_by_channel?: { meta?: DailySeries | null; google?: DailySeries | null } | null;
  booking_trend?: BookingTrend | null;
  placements?: Array<{ label: string; spend_usd: number; share_pct: number }> | null;
  networks?: Array<{ label: string; spend_usd: number; share_pct: number }> | null;
};

function usd(n: number | null | undefined): string {
  if (n === null || n === undefined) return "-";
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}
function ratio(n: number | null | undefined): string {
  if (n === null || n === undefined) return "-";
  return `${n.toFixed(2)}×`;
}
function int(n: number | null | undefined): string {
  if (n === null || n === undefined) return "-";
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}
function pct(n: number | null | undefined): string {
  if (n === null || n === undefined) return "-";
  return `${n.toFixed(2)}%`;
}
function usd2(n: number | null | undefined): string {
  if (n === null || n === undefined) return "-";
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
function roasBand(roas: number | null | undefined): RoasBand {
  if (roas === null || roas === undefined) return "gray";
  if (roas < 1) return "red";
  if (roas < 2) return "amber";
  return "green";
}
const BAND_TEXT: Record<RoasBand, string> = {
  red: "text-[#cb2029]",
  amber: "text-[#8a6d00]",
  green: "text-[#167f50]",
  gray: "text-[#595959]",
};
function shortDate(s?: string | null): string | null {
  if (!s) return null;
  const d = new Date(s.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function deliveryLabel(s?: string | null): { label: string; cls: string } {
  const t = (s ?? "").toUpperCase();
  if (t === "ACTIVE" || t === "ENABLED")
    return { label: "Active", cls: "text-[#167f50]" };
  if (t === "PAUSED") return { label: "Paused", cls: "text-[#8a6d00]" };
  if (!t) return { label: "-", cls: "text-[#a8a8a8]" };
  return {
    label: t.charAt(0) + t.slice(1).toLowerCase().replace(/_/g, " "),
    cls: "text-[#595959]",
  };
}
function statusWord(s: ObjectiveStatus | undefined): string {
  switch (s) {
    case "cut":
    case "pause":
      return "cut";
    case "watch":
      return "watch";
    case "scale":
      return "scale";
    default:
      return "hold";
  }
}
function bandForStatus(s: ObjectiveStatus | undefined): RoasBand {
  switch (s) {
    case "cut":
    case "pause":
      return "red";
    case "watch":
      return "amber";
    case "scale":
      return "green";
    default:
      return "gray";
  }
}

type AdChannel = "meta" | "google";

export function PerformanceMarketerDashboard({
  channel,
  range: controlledRange,
  onRangeChange,
  refreshTick = 0,
  active = true,
  onRefreshingChange,
}: {
  channel?: AdChannel;
  range?: ResolvedRange;
  onRangeChange?: (r: ResolvedRange) => void;
  refreshTick?: number;
  active?: boolean;
  onRefreshingChange?: (refreshing: boolean) => void;
} = {}) {
  const { tenantName } = useWorkspace();
  const [rangeState, setRangeState] = useState<ResolvedRange>(() => {
    const now = new Date();
    const { start, end } = presetRange("last_7d", now);
    return resolveWindow(start, end, now);
  });
  const controlled = controlledRange != null;
  const range = controlledRange ?? rangeState;
  const setRange = onRangeChange ?? setRangeState;
  const [data, setData] = useState<DashboardData | null>(
    () => initialCacheEntry(tenantName, "last_7d"),
  );
  const [loading, setLoading] = useState(() => data === null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showTable, setShowTable] = useState(true);
  const [selectedCampaigns, setSelectedCampaigns] = useState<Set<string>>(
    () => new Set(),
  );
  const [changingCampaigns, setChangingCampaigns] = useState<Set<string>>(
    () => new Set(),
  );
  const [campaignActionError, setCampaignActionError] = useState<string | null>(null);
  useEffect(() => {
    const visible = new Set(
      (data?.campaigns ?? [])
        .filter((campaign) => !channel || campaign.channel === channel)
        .map((campaign) => `${campaign.channel}:${campaign.campaign_id}`),
    );
    setSelectedCampaigns((current) => {
      const next = new Set([...current].filter((key) => visible.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [data?.campaigns, channel]);
  const [detailFor, setDetailFor] = useState<{ id: string; name: string } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggleExpanded = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const [modal, setModal] = useState<{
    mode: ModalMode;
    campaign: BudgetModalCampaign;
  } | null>(null);

  const loadRef = useRef<(r: ResolvedRange, refresh?: boolean) => Promise<void>>(undefined);
  const tenantRef = useRef(tenantName);
  tenantRef.current = tenantName;
  const load = useCallback(
    async (r: ResolvedRange, refresh = false) => {
      const custom = r.isCustom;
      const cacheK = custom ? `custom:${ymd(r.start)}:${ymd(r.end)}` : r.key;
      const query = custom
        ? `window=${encodeURIComponent(r.key)}&since=${ymd(r.start)}&until=${ymd(r.end)}`
        : `window=${encodeURIComponent(r.key)}`;
      const key = cacheKey(tenantRef.current, cacheK);
      const cached = DASH_CACHE.get(key);
      if (cacheEntryFresh(cached) && !refresh) {
        setData(cached);
        setLoading(false);
        setError(null);
        setRefreshFailed(false);
        return;
      }
      if (refresh) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setError(null);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), DASHBOARD_TIMEOUT_MS);
      try {
        const res = await apiFetch(
          `/api/agents/performance-marketer/dashboard?${query}${refresh ? "&refresh=1" : ""}`,
          { signal: ctrl.signal },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as DashboardData;
        DASH_CACHE.set(key, json);
        setData(json);
        setRefreshFailed(refreshCameBackStale(refresh, json));
        if (!refresh && json.stale) void loadRef.current?.(r, true);
      } catch (e) {
        const timedOut = e instanceof Error && e.name === "AbortError";
        if (refresh) {
          setRefreshFailed(true);
        } else {
          setError(
            timedOut
              ? "timed out: the server took too long to respond"
              : e instanceof Error
                ? e.message
                : "Failed to load",
          );
        }
      } finally {
        clearTimeout(timer);
        setLoading(false);
        setRefreshing(false);
      }
    },
    [],
  );
  loadRef.current = load;

  useEffect(() => {
    if (!active) return;
    void load(range);
  }, [load, range, active]);

  useEffect(() => {
    if (refreshTick > 0 && active) void loadRef.current?.(range, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  useRefreshingSignal(refreshing, onRefreshingChange);

  const onChangeApplied = useCallback(() => {
    void load(range, true);
  }, [load, range]);

  const openDetail = useCallback(
    (campaign: { id: string; name: string }) => {
      setDetailFor(campaign);
      if (data?.stale && !refreshing) void load(range, true);
    },
    [data?.stale, refreshing, load, range],
  );

  if (loading && !data) {
    return <DashboardSkeleton />;
  }
  if (error && !data) {
    return (
      <DashboardMessage>
        Couldn&apos;t load the dashboard ({error}).{" "}
        <button
          type="button"
          onClick={() => void load(range)}
          className="cursor-pointer font-semibold text-[#1f1f1f] underline"
        >
          Retry
        </button>
      </DashboardMessage>
    );
  }
  if (!data) return null;

  const noConnectors =
    !data.connected.meta && !data.connected.google && !data.channel_errors;
  if (noConnectors) {
    return (
      <div className="flex flex-col gap-5">
        <ConnectEmptyState channel={channel} />
      </div>
    );
  }
  if (channel && !data.connected[channel] && !data.channel_errors?.[channel]) {
    return (
      <div className="flex flex-col gap-5">
        <ConnectEmptyState channel={channel} />
      </div>
    );
  }
  const channelReconnectCode = channel ? data.channel_errors?.[channel]?.code : undefined;
  if (
    channel &&
    (channelReconnectCode === "meta_ads_token_expired" ||
      channelReconnectCode === "meta_ads_permission_revoked" ||
      channelReconnectCode === "google_ads_token_revoked")
  ) {
    const name = channel === "meta" ? "Meta Ads" : "Google Ads";
    return (
      <div className="min-h-[420px]">
        <ChannelEmpty
          label={name}
          title={`${name} needs to be reconnected`}
          description={`The ${name} connection expired or was revoked. Reconnect it and your campaign data fills back in.`}
          cta={`Reconnect ${channel === "meta" ? "Meta" : "Google"}`}
        />
      </div>
    );
  }

  const dailySeries = channel ? data.daily_series_by_channel?.[channel] ?? null : data.daily_series;
  const rangeStart = ymd(range.start);
  const rangeEnd = ymd(range.end);
  const rangedSeries = dailySeries
    ? {
        ...dailySeries,
        points: dailySeries.points.filter((p) => p.date >= rangeStart && p.date <= rangeEnd),
      }
    : null;
  const kpiTotals = channel
    ? data.channels.find((c) => c.channel === channel) ?? null
    : data.kpis;

  const ranked = data.campaigns.filter((c) => !channel || c.channel === channel);
  const totalSpend = ranked.reduce((s, c) => s + c.spend_usd, 0);
  const rowKey = (c: CampaignRow) => `${c.channel}:${c.campaign_id}`;
  const actionable = ranked.filter((c) => {
    const status = (c.status ?? "").toUpperCase();
    return status === "ACTIVE" || status === "ENABLED" || status === "PAUSED";
  });
  const allSelected =
    actionable.length > 0 && actionable.every((c) => selectedCampaigns.has(rowKey(c)));
  const someSelected = actionable.some((c) => selectedCampaigns.has(rowKey(c)));
  const selectedRows = actionable.filter((c) => selectedCampaigns.has(rowKey(c)));

  const toggleSelection = (key: string) => {
    setSelectedCampaigns((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const setAllSelected = (checked: boolean) => {
    setSelectedCampaigns((current) => {
      const next = new Set(current);
      for (const campaign of actionable) {
        const key = rowKey(campaign);
        if (checked) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  };

  const changeCampaignStatus = async (campaigns: CampaignRow[], enabled: boolean) => {
    if (campaigns.length === 0) return;
    const keys = campaigns.map(rowKey);
    setCampaignActionError(null);
    setChangingCampaigns((current) => new Set([...current, ...keys]));

    const results = await Promise.allSettled(
      campaigns.map(async (campaign) => {
        const staged = await apiFetch(
          "/api/agents/performance-marketer/campaign-status",
          {
            method: "POST",
            body: JSON.stringify({
              channel: campaign.channel,
              campaign_id: campaign.campaign_id,
              campaign_name: campaign.campaign_name,
              enabled,
            }),
          },
        );
        const body = (await staged.json().catch(() => null)) as
          | { decision_id?: string; error?: { message?: string } }
          | null;
        if (!staged.ok || !body?.decision_id) {
          throw new Error(body?.error?.message ?? "Couldn't stage the change.");
        }
        const approved = await apiFetch(`/api/approvals/${body.decision_id}/approve`, {
          method: "POST",
        });
        if (!approved.ok) throw new Error("The change couldn't be confirmed.");
        return rowKey(campaign);
      }),
    );

    const changed = new Set(
      results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])),
    );
    const failed = results.filter((result) => result.status === "rejected");
    if (changed.size > 0) {
      setData((current) =>
        current
          ? {
              ...current,
              campaigns: current.campaigns.map((campaign) =>
                changed.has(rowKey(campaign))
                  ? {
                      ...campaign,
                      status: enabled
                        ? campaign.channel === "meta"
                          ? "ACTIVE"
                          : "ENABLED"
                        : "PAUSED",
                    }
                  : campaign,
              ),
            }
          : current,
      );
      setSelectedCampaigns((current) => {
        const next = new Set(current);
        for (const key of changed) next.delete(key);
        return next;
      });
      void load(range, true);
    }
    if (failed.length > 0) {
      const first = failed[0];
      setCampaignActionError(
        first.status === "rejected" && first.reason instanceof Error
          ? `${first.reason.message}${failed.length > 1 ? ` (${failed.length} failed)` : ""}`
          : `${failed.length} campaign changes failed.`,
      );
    }
    setChangingCampaigns((current) => {
      const next = new Set(current);
      for (const key of keys) next.delete(key);
      return next;
    });
  };

  const openModal = (mode: ModalMode, c: CampaignRow) => {
    const band = bandForStatus(c.objective_status) === "gray"
      ? roasBand(c.roas)
      : bandForStatus(c.objective_status);
    const shareOfSpend =
      totalSpend > 0 ? Math.round((c.spend_usd / totalSpend) * 100) : 0;
    const modalCampaign: BudgetModalCampaign = {
      campaign_id: c.campaign_id,
      channel: c.channel,
      name: c.campaign_name || "(unnamed)",
      band,
      status_label: statusWord(c.objective_status),
      spend_label: usd(c.spend_usd),
      roas_label: ratio(c.roas),
      bookings_label: int(c.primary_result_count ?? c.conversions),
      cost_label: usd(c.primary_cost_usd ?? c.cost_per_booking_usd ?? c.cpa_usd),
      pct_label: `${shareOfSpend}%`,
      objective_label: c.objective_label ?? "Campaign",
      current_daily_budget_usd: c.active_daily_budget_usd ?? null,
      cost_per_result_usd: c.primary_cost_usd ?? c.cost_per_booking_usd ?? c.cpa_usd ?? null,
    };
    setModal({ mode, campaign: modalCampaign });
  };

  const metaErr = channel === "google" ? undefined : data.channel_errors?.meta;
  const googleErr = channel === "meta" ? undefined : data.channel_errors?.google;
  const metaNeedsReconnect =
    metaErr?.code === "meta_ads_token_expired" ||
    metaErr?.code === "meta_ads_permission_revoked";
  const googleNeedsReconnect = googleErr?.code === "google_ads_token_revoked";
  const needsReconnect = metaNeedsReconnect || googleNeedsReconnect;
  const freshnessLabel = needsReconnect ? "" : formatFreshness(data);
  const reconnectChannelLabel = metaNeedsReconnect ? "Meta" : "Google";

  return (
    <div className="flex flex-col gap-6">
      {loading && (
        <div className="rounded-[12px] border border-[#f0f0f0] bg-[#fafafa] px-4 py-2.5 text-[13px] text-[#595959]">
          Loading {range.presetLabel === "Custom" ? "the selected range" : range.presetLabel}… showing previous data below.
        </div>
      )}
      {!loading && error && (
        <div className="flex items-center justify-between gap-3 rounded-[12px] border border-[#f1c0bc] bg-[#fdf2f1] px-4 py-2.5 text-[13px] text-[#c0392b]">
          <span>Couldn&apos;t load this range ({error}). Still showing the previous data.</span>
          <button
            type="button"
            onClick={() => void load(range)}
            className="shrink-0 cursor-pointer font-semibold underline"
          >
            Retry
          </button>
        </div>
      )}
      {needsReconnect ? (
        <div className="flex items-center justify-between gap-3 rounded-[12px] border border-[#f0dca4] bg-[#fffaf0] px-4 py-2.5 text-[13px] text-[#8a6d00]">
          <span>
            {metaNeedsReconnect && googleNeedsReconnect
              ? "Meta and Google Ads need to be reconnected. Campaign data can't refresh until you do."
              : `${reconnectChannelLabel} Ads needs to be reconnected. Campaign data can't refresh until you do.`}
          </span>
          <a
            href="/workspace?tab=brain#integrations"
            className="shrink-0 font-semibold text-[#1f1f1f] underline"
          >
            {metaNeedsReconnect && googleNeedsReconnect
              ? "Reconnect ad accounts"
              : `Reconnect ${reconnectChannelLabel}`}
          </a>
        </div>
      ) : metaErr || googleErr ? (
        <div className="rounded-[12px] border border-[#f0dca4] bg-[#fffaf0] px-4 py-2.5 text-[13px] text-[#8a6d00]">
          {channelErrorBanner(
            metaErr ? "Meta" : "Google",
            (metaErr ?? googleErr)!,
            (data.served_last_good_channels ?? (data.served_last_good ? ["meta", "google"] : [])).includes(
              metaErr ? "meta" : "google",
            ),
          )}
        </div>
      ) : null}
      <div className={`flex flex-col gap-6 ${loading ? "opacity-60" : ""}`} aria-busy={loading}>
      <section className="flex flex-col gap-3 rounded-[17px] border border-[#f0f0f0] p-4">
        {!controlled && (
          <>
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate text-[12px] text-[#8a8a8a]">
                {freshnessLabel || refreshFailed
                  ? freshnessBadgeLabel(freshnessLabel, refreshing, refreshFailed)
                  : ""}
              </span>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => void load(range, true)}
                  disabled={refreshing}
                  aria-label="Refresh"
                  title={refreshing ? "Refreshing…" : "Refresh"}
                  className="flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full text-[#1f1f1f] transition-colors hover:bg-[#f5f5f5] disabled:opacity-50"
                >
                  <RefreshIcon
                    className={`size-5 ${refreshing ? "animate-spin motion-reduce:animate-none" : ""}`}
                  />
                </button>
                <AdsManagerDateRangePicker value={range} onChange={setRange} />
              </div>
            </div>
            <div className="h-px w-full bg-[#f0f0f0]" />
          </>
        )}

        {kpiTotals ? (
          <ChannelKpiCards
            channel={channel}
            windowLabel={data.window_label}
            totals={kpiTotals}
            series={dailySeries}
            statusLabel={
              controlled && (freshnessLabel || refreshFailed)
                ? freshnessBadgeLabel(
                    freshnessLabel,
                    refreshing,
                    refreshFailed,
                  )
                : undefined
            }
          />
        ) : (
          <div className="text-[13px] text-[#8a8a8a]">
            No {channel === "google" ? "Google Ads" : "Meta Ads"} data yet for
            this window.
          </div>
        )}
      </section>

      {rangedSeries && rangedSeries.points.length > 1 && (
        <section className="flex flex-col gap-3">
          <PerfMarketerTrendChart
            key={channel ?? "all"}
            series={rangedSeries}
            booking={data.booking_trend}
            requestedEnd={ymd(range.end)}
            channel={channel}
          />
        </section>
      )}

      {channel === "google"
        ? (data.networks?.length ?? 0) > 0 && (
            <section className="flex flex-col gap-3">
              <h3 className="text-[16px] font-semibold leading-6 text-[#0e0f11]">
                Spend by network
              </h3>
              <PlacementBars rows={data.networks ?? []} />
            </section>
          )
        : (data.placements?.length ?? 0) > 0 && (
            <section className="flex flex-col gap-3">
              <h3 className="text-[16px] font-semibold leading-6 text-[#0e0f11]">
                Spend by placement
              </h3>
              <PlacementBars rows={data.placements ?? []} />
            </section>
          )}

      <section className="flex flex-col gap-4">
        <button
          type="button"
          onClick={() => setShowTable((s) => !s)}
          className="flex w-full items-center gap-3 text-left"
        >
          <span className="flex-1 text-[16px] font-semibold leading-6 text-[#0e0f11]">
            {campaignsTableTitle(ranked.length, channel ? undefined : data.total_campaigns)}
          </span>
          <ChevronToggle open={showTable} />
        </button>
        {showTable && (
          <div className="overflow-hidden rounded-[12px] border border-[#e5e7eb] bg-white">
            {(selectedRows.length > 0 || campaignActionError) && (
              <div className="flex min-h-12 items-center gap-2 border-b border-[#e5e7eb] bg-[#f9f9f9] px-4 py-2">
                {selectedRows.length > 0 && (
                  <>
                    <span className="mr-auto text-[13px] font-medium text-[#595959]">
                      {selectedRows.length} selected
                    </span>
                    <button
                      type="button"
                      disabled={changingCampaigns.size > 0}
                      onClick={() => void changeCampaignStatus(selectedRows, true)}
                      className="rounded-cta border border-[#e5e7eb] bg-white px-3 py-1.5 text-[12px] font-semibold text-[#0e0f11] hover:bg-[#f4f4f4] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Turn on
                    </button>
                    <button
                      type="button"
                      disabled={changingCampaigns.size > 0}
                      onClick={() => void changeCampaignStatus(selectedRows, false)}
                      className="rounded-cta border border-[#e5e7eb] bg-white px-3 py-1.5 text-[12px] font-semibold text-[#0e0f11] hover:bg-[#f4f4f4] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Turn off
                    </button>
                  </>
                )}
                {campaignActionError && (
                  <span className="text-[12px] text-[#c0392b]">{campaignActionError}</span>
                )}
              </div>
            )}
            <div className="max-h-[70vh] overflow-auto overscroll-contain">
            <table className="w-full min-w-[1760px] border-separate border-spacing-0 text-[14px] [&_td]:border-r [&_td]:border-rule [&_td:last-child]:border-r-0 [&_th]:border-r [&_th]:border-rule [&_th:last-child]:border-r-0">
              <thead>
                <tr className="text-right text-[12px] font-medium uppercase tracking-[0.05em] text-[#0e0f11] [&>th]:sticky [&>th]:top-0 [&>th]:z-10 [&>th]:whitespace-nowrap [&>th]:border-b [&>th]:border-b-rule [&>th]:bg-creamDeep">
                  <th className="w-12 px-4 py-3.5 text-left font-medium">
                    <CampaignCheckbox
                      checked={allSelected}
                      indeterminate={someSelected && !allSelected}
                      disabled={actionable.length === 0 || changingCampaigns.size > 0}
                      onChange={setAllSelected}
                      label="Select all campaigns"
                    />
                  </th>
                  <th className="w-20 whitespace-nowrap px-2 py-3.5 text-left font-medium">On/Off</th>
                  <th className="min-w-[210px] px-4 py-3.5 text-left font-medium">Campaign</th>
                  <th className="px-2 py-3.5 text-left font-medium">Status</th>
                  <th className="px-2 py-3.5 font-medium">Budget</th>
                  <th className="px-2 py-3.5 font-medium">Amount spent</th>
                  <th className="px-2 py-3.5 font-medium">Impressions</th>
                  <th className="px-2 py-3.5 font-medium">Reach</th>
                  <th className="px-2 py-3.5 font-medium">Results</th>
                  <th className="px-2 py-3.5 font-medium">Cost / result</th>
                  <th className="px-2 py-3.5 font-medium">Purchases</th>
                  <th className="px-2 py-3.5 font-medium">Registrations</th>
                  <th className="px-2 py-3.5 font-medium">Clicks</th>
                  <th className="px-2 py-3.5 font-medium">CTR</th>
                  <th className="px-2 py-3.5 font-medium">CPC</th>
                  <th className="px-2 py-3.5 font-medium">CPM</th>
                  <th className="px-2 py-3.5 font-medium">ROAS</th>
                  <th className="whitespace-nowrap px-2 py-3.5 text-left font-medium">Schedule</th>
                  <th className="whitespace-nowrap px-2 py-3.5 text-left font-medium">Ends</th>
                  <th className="px-2 py-3.5 pr-4 font-medium">Edit</th>
                </tr>
              </thead>
              <tbody>
                {ranked.map((c) => {
                  const adSets = c.ad_sets ?? [];
                  const canExpand = adSets.length > 1;
                  const canOpenDetail = c.channel === "meta";
                  const isOpen = expanded.has(c.campaign_id);
                  const key = rowKey(c);
                  const status = (c.status ?? "").toUpperCase();
                  const canChangeStatus =
                    status === "ACTIVE" || status === "ENABLED" || status === "PAUSED";
                  const enabled = status === "ACTIVE" || status === "ENABLED";
                  const changing = changingCampaigns.has(key);
                  return (
                    <Fragment key={`tbl:${c.channel}:${c.campaign_id}`}>
                      <tr className="text-right tabular-nums [&>td]:border-b [&>td]:border-b-rule">
                        <td className="px-4 py-4 text-left align-middle">
                          <CampaignCheckbox
                            checked={selectedCampaigns.has(key)}
                            disabled={!canChangeStatus || changing}
                            onChange={() => toggleSelection(key)}
                            label={`Select ${c.campaign_name || "campaign"}`}
                          />
                        </td>
                        <td className="px-2 py-4 text-left align-middle">
                          <CampaignToggle
                            checked={enabled}
                            disabled={!canChangeStatus || changing}
                            onChange={(checked) => void changeCampaignStatus([c], checked)}
                            label={`${enabled ? "Turn off" : "Turn on"} ${c.campaign_name || "campaign"}`}
                          />
                        </td>
                        <td className="px-4 py-4 text-left align-middle">
                          <span className="flex items-start gap-2">
                            {canExpand ? (
                              <button
                                type="button"
                                onClick={() => toggleExpanded(c.campaign_id)}
                                aria-expanded={isOpen}
                                aria-label={`${isOpen ? "Collapse" : "Expand"} ad sets for ${c.campaign_name || "campaign"}`}
                                className="mt-1 flex size-3 shrink-0 items-center justify-center text-[#8a8a8a] hover:text-[#0e0f11]"
                              >
                                <CaretTriangle open={isOpen} />
                              </button>
                            ) : (
                              <span className="mt-0.5 w-2 shrink-0" />
                            )}
                            {canOpenDetail ? (
                              <button
                                type="button"
                                onClick={() =>
                                  openDetail({ id: c.campaign_id, name: c.campaign_name })
                                }
                                aria-label={`Show what ${c.campaign_name || "this campaign"} optimizes for, targets, and its creative`}
                                className="cursor-pointer text-left font-semibold leading-[18px] text-[#027bff] hover:underline"
                              >
                                {c.campaign_name || "(unnamed)"}
                              </button>
                            ) : (
                              <span className="font-semibold leading-[18px] text-[#0e0f11]">
                                {c.campaign_name || "(unnamed)"}
                              </span>
                            )}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-2 py-4 text-left align-middle">
                          {(() => {
                            const d = deliveryLabel(c.status);
                            return (
                              <span className={`inline-flex items-center gap-2 text-[13px] font-medium ${d.cls}`}>
                                <span className="size-1.5 rounded-full bg-current" />
                                {d.label}
                              </span>
                            );
                          })()}
                        </td>
                        <td className="px-2 py-4 align-middle text-[#0e0f11]">
                          {c.active_daily_budget_usd != null ? (
                            <span className="inline-flex flex-col items-end leading-4">
                              {usd(c.active_daily_budget_usd)}
                              <span className="text-[12px] text-[#6b7280]">Daily</span>
                            </span>
                          ) : (
                            "-"
                          )}
                        </td>
                        <td className="px-2 py-4 align-middle text-[#0e0f11]">{usd(c.spend_usd)}</td>
                        <td className="px-2 py-4 align-middle text-[#0e0f11]">{int(c.impressions)}</td>
                        <td className="px-2 py-4 align-middle text-[#0e0f11]">
                          {c.reach != null ? int(c.reach) : "-"}
                        </td>
                        <td className="px-2 py-4 align-middle text-[#0e0f11]">
                          {int(c.primary_result_count ?? c.conversions)}
                        </td>
                        <td className="px-2 py-4 align-middle text-[#0e0f11]">
                          {usd(c.primary_cost_usd ?? c.cost_per_booking_usd ?? c.cpa_usd)}
                        </td>
                        <td className="px-2 py-4 align-middle text-[#0e0f11]">{int(c.purchases)}</td>
                        <td className="px-2 py-4 align-middle text-[#0e0f11]">{int(c.sign_ups)}</td>
                        <td className="px-2 py-4 align-middle text-[#0e0f11]">{int(c.clicks)}</td>
                        <td className="px-2 py-4 align-middle text-[#0e0f11]">{pct(c.ctr_percent)}</td>
                        <td className="px-2 py-4 align-middle text-[#0e0f11]">{usd2(c.cpc_usd)}</td>
                        <td className="px-2 py-4 align-middle text-[#0e0f11]">{usd2(c.cpm_usd)}</td>
                        <td
                          className={`px-2 py-4 align-middle font-semibold ${BAND_TEXT[roasBand(c.roas)]}`}
                        >
                          {ratio(c.roas)}
                        </td>
                        <td className="whitespace-nowrap px-2 py-4 text-left align-middle text-[#595959]">
                          {shortDate(c.start_time) ?? "-"}
                        </td>
                        <td className="whitespace-nowrap px-2 py-4 text-left align-middle text-[#595959]">
                          {shortDate(c.end_time) ?? "Ongoing"}
                        </td>
                        <td className="px-2 py-4 pr-4 align-middle">
                          {c.channel === "meta" || c.active_daily_budget_usd != null ? (
                            <button
                              type="button"
                              onClick={() => openModal("edit", c)}
                              className="cursor-pointer font-semibold text-[#027bff] hover:underline"
                            >
                              Edit
                            </button>
                          ) : (
                            <span className="text-[#d9d9d9]">-</span>
                          )}
                        </td>
                      </tr>
                      {isOpen &&
                        adSets.map((a) => (
                          <tr
                            key={`adset:${c.campaign_id}:${a.ad_set_id}`}
                            className="bg-[#f9f9f9] text-right tabular-nums text-[#595959] [&>td]:border-b [&>td]:border-b-rule"
                          >
                            <td className="px-2 py-2.5" colSpan={2} />
                            <td className="py-2.5 pl-9 pr-3 text-left leading-[18px]">
                              {a.ad_set_name || "(unnamed ad set)"}
                              {a.optimization_event ? ` · ${a.optimization_event}` : ""}
                            </td>
                            <td className="px-2 py-2.5 text-left" />
                            <td className="px-2 py-2.5">
                              {a.daily_budget_usd != null ? usd(a.daily_budget_usd) : "-"}
                            </td>
                            <td className="px-2 py-2.5 text-[#d9d9d9]" colSpan={15}>
                              {" "}
                            </td>
                          </tr>
                        ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 p-3 text-[13px]">
              <span className="text-[#0e0f11]">
                {data.pixel ? (
                  <>
                    Meta pixel:{" "}
                    <span
                      className={
                        data.pixel.status === "healthy"
                          ? "text-[#167f50]"
                          : "text-[#c0392b]"
                      }
                    >
                      {data.pixel.status.replace("_", " ")}
                    </span>{" "}
                    ·{" "}
                  </>
                ) : null}
                {freshnessLabel ||
                  `Updated ${new Date(data.refreshed_at).toLocaleTimeString()}`}
              </span>
            </div>
          </div>
        )}
      </section>
      </div>

      {modal && (
        <AdsManagerBudgetModal
          mode={modal.mode}
          campaign={modal.campaign}
          onClose={() => setModal(null)}
          onDone={onChangeApplied}
        />
      )}
      {detailFor && (
        <AdsCampaignDetailDrawer
          campaignId={detailFor.id}
          campaignName={detailFor.name}
          agentSlug="performance-marketer"
          window={range.key}
          windowLabel={range.presetLabel}
          since={range.isCustom ? ymd(range.start) : undefined}
          until={range.isCustom ? ymd(range.end) : undefined}
          onClose={() => setDetailFor(null)}
        />
      )}
    </div>
  );
}

function CampaignCheckbox({
  checked,
  indeterminate = false,
  disabled = false,
  onChange,
  label,
}: {
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
      aria-label={label}
      className="size-4 cursor-pointer rounded border-[#d9d9d9] accent-[#0e0f11] disabled:cursor-not-allowed disabled:opacity-40"
    />
  );
}

function CampaignToggle({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 rounded-full transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-40 ${
        checked ? "bg-[#0e0f11]" : "bg-[#ededed]"
      }`}
    >
      <span
        className={`absolute left-0 top-0.5 flex size-5 items-center justify-center rounded-full bg-white shadow-sm transition-transform duration-200 ${
          checked ? "translate-x-[22px]" : "translate-x-0.5"
        }`}
      >
        {checked && (
          <svg
            viewBox="0 0 16 16"
            aria-hidden="true"
            className="size-3.5 text-[#0e0f11]"
            fill="none"
          >
            <path
              d="m3 8 3 3 7-7"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </span>
    </button>
  );
}

function RefreshIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M3 12a9 9 0 0 1 14.5-7.1L20 7"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M20 3v4h-4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M21 12a9 9 0 0 1-14.5 7.1L4 17"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4 21v-4h4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronToggle({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={`size-6 shrink-0 text-[#1f1f1f] transition-transform ${open ? "rotate-180" : ""}`}
    >
      <path
        d="M7 9.5 12 14.5 17 9.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CaretTriangle({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 8 8"
      aria-hidden
      className={`size-[7px] transition-transform ${open ? "rotate-90" : ""}`}
    >
      <path d="M2 1.2 6.2 4 2 6.8z" fill="currentColor" />
    </svg>
  );
}

function PlacementBars({
  rows,
}: {
  rows: Array<{ label: string; share_pct: number }>;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-[17px] border border-[#f0f0f0] bg-white p-4">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-4">
          <span className="w-40 shrink-0 truncate text-[16px] font-medium text-[#0e0f11]">
            {r.label}
          </span>
          <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-[#f0f0f0]">
            <div
              className="h-full rounded-full bg-[#0e0f11] transition-[width] duration-500 motion-reduce:transition-none"
              style={{ width: `${Math.max(r.share_pct, 2)}%` }}
            />
          </div>
          <span className="w-11 shrink-0 text-right text-[16px] font-semibold tabular-nums text-[#0e0f11]">
            {r.share_pct}%
          </span>
        </div>
      ))}
    </div>
  );
}

function ConnectEmptyState({ channel }: { channel?: AdChannel }) {
  const name = channel === "meta" ? "Meta Ads" : channel === "google" ? "Google Ads" : "an ad account";
  return (
    <div className="rounded-xl border border-dashed border-[#d8d2c4] bg-white px-6 py-8 text-center">
      <div className="text-[16px] font-semibold text-[#1f1f1f]">
        {channel ? `${name} isn't connected yet` : "Connect an ad account to see your campaigns"}
      </div>
      <p className="mx-auto mt-1 max-w-md text-[12px] text-[#595959]">
        Once {channel ? name : "Meta or Google Ads"} is connected, this panel shows live spend, ROAS,
        and which campaigns to scale or pause.
      </p>
      <a
        href="/workspace?tab=brain#integrations"
        className="mt-4 inline-flex h-9 items-center rounded-[10px] bg-[#0e0f11] px-4 text-[13px] font-semibold text-white hover:bg-[#1f1f1f]"
      >
        Connect {channel ? name : "in Connectors"}
      </a>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading paid-acquisition dashboard"
      className="flex flex-col gap-6"
    >
      <section className="flex flex-col gap-3 rounded-[17px] border border-rule p-4">
        <Skeleton className="h-5 w-24" />
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,8.5rem),1fr))] gap-3">
          {Array.from({ length: 8 }).map((_, index) => (
            <div
              key={index}
              className="flex min-h-[98px] flex-col gap-2 rounded-2xl border border-rule px-3.5 py-3"
            >
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-6 w-20" />
              <Skeleton className="h-3 w-12" />
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-8 w-36" rounded="rounded-lg" />
        </div>
        <div className="rounded-[17px] border border-rule p-4">
          <Skeleton className="h-[220px] w-full" rounded="rounded-xl" />
          <div className="mt-3 flex gap-4">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-3 w-14" />
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <Skeleton className="h-5 w-36" />
        <div className="space-y-4 rounded-[17px] border border-rule p-4">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="flex items-center gap-4">
              <Skeleton className="h-3 w-24 shrink-0" />
              <Skeleton className="h-2.5 flex-1" rounded="rounded-full" />
              <Skeleton className="h-3 w-8 shrink-0" />
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <Skeleton className="h-5 w-40" />
        <div className="overflow-hidden rounded-2xl border border-rule">
          <Skeleton className="h-10 w-full" rounded="rounded-none" />
          {Array.from({ length: 4 }).map((_, index) => (
            <div
              key={index}
              className="flex items-center gap-5 border-t border-rule px-4 py-3"
            >
              <Skeleton className="h-4 w-4 shrink-0" />
              <Skeleton className="h-4 w-48" />
              <Skeleton className="ml-auto h-4 w-20" />
              <Skeleton className="h-4 w-16" />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function DashboardMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[#e5e7eb] bg-white px-4 py-6 text-center text-[13px] text-[#595959]">
      {children}
    </div>
  );
}
