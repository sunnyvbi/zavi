"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { ReadProblemAlert } from "./ReadProblemAlert";
import { channelFamily } from "./card/family";
import { FOCUS_RING } from "../layout/shared";
import { linkedinMetricSlots } from "../metrics/linkedinMetrics";
import { CHANNEL_TAB_EVENT } from "./topActions/api";
import { channelSummaryMetrics } from "../metrics/channelSummaryMetrics";
import { emptyTiles } from "./channelEmptyTiles";
export { saysSomething } from "../metrics/channelSummaryMetrics";
import { createPortal } from "react-dom";
import { CampaignWorkspace } from "./managed-campaigns/CampaignWorkspace";
import { connectorLabel } from "../growth/GrowthConnections";
import type { ChannelMetric } from "@/lib/workspace/channelActionsApi";
import { channelMark } from "../channelMark";
import { MetricRows } from "../metrics/ChannelMetricRows";
import type { RowSelection } from "../metrics/SummaryRow";
import { HealthSummary } from "../metrics/HealthSummary";
import { useAgentDashboard } from "../agent/dashboard-ui";
import { useChannelReadFailure } from "../layout/ChannelRefresh";
import {
  channelChrome,
  extraTableData,
  kpiFallbackHealth,
  kpiFallbackMetrics,
  campaignLinksOf,
  channelAccountOf,
  type ChannelChrome,
} from "../agent/legacyChannelActions";
import { DEFAULT_RANGES } from "../agent/google-ads/types";
import { CHANNEL_DASHBOARD_STALE_EVENT, setCampaignLinks, setCampaignStates, setChannelAccount } from "./campaignLinks";
import { linkedinCampaignStates } from "../agent/linkedinAdsTables";
import { ExtraTable } from "./ExtraTable";
import { LinkedInCampaignWorkspace } from "./linkedin-ads/LinkedInCampaignWorkspace";
import { useWorkspaceOptional } from "../WorkspaceShell";
import { TiktokAdAccountCard } from "./tiktok-ad-account/TiktokAdAccountCard";
import { PaidAnalytics } from "./paid-analytics/PaidAnalytics";
import { GeoVisibility } from "../geo/GeoVisibility";
import { ChannelDashboardControls } from "./ChannelDashboardControls";
import { LinkedInReadStatus } from "../agent/LinkedInReadStatus";
import { CUSTOM_RANGE_ID, customRangeRefused, payloadPeriod, spanLabel, windowKey, type PickedRange } from "./dateRange";

const CUSTOM_RANGE_SLUGS = new Set(["linkedin_ads", "instagram_organic", "linkedin_organic", "tiktok_organic", "geo"]);
import { OnTab } from "../layout/channelPage";
import type { PlatformSpec } from "./types";
import { connectInfoFor, hasConnectPath } from "@zavi/shared";
import { launchConnect } from "@/app/connectors/connectStrategies";

const METRIC_PANEL_ID = "channel-metric-panel";

export function connectFirst(connectors: readonly string[] | undefined): (() => Promise<void>) | undefined {
  const first = connectors?.[0];
  if (!first || !hasConnectPath(first)) return undefined;
  return () => launchConnect(first, connectInfoFor(first) ?? { connect: "oauth", label: first, settingsAnchor: null });
}

export function connectable(connectors: readonly string[] | undefined, linked: readonly string[] = []): string[] {
  const accountName = (slug: string) => connectInfoFor(slug)?.label ?? connectorLabel(slug);
  const linkedNames = new Set(linked.map(accountName));
  const seen = new Set<string>();
  return (connectors ?? []).filter((c) => {
    if (linked.includes(c) || !hasConnectPath(c)) return false;
    const name = accountName(c);
    if (linkedNames.has(name) || seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

const CONNECT_BUTTON = "inline-flex h-9 cursor-pointer items-center rounded-cta bg-ink px-3.5 text-[14px] font-semibold text-cream hover:bg-inkSoft disabled:opacity-50";

export function ConnectButtons({ connectors }: { connectors: readonly string[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const start = async (slug: string) => {
    setBusy(slug);
    setError(null);
    try {
      await launchConnect(slug, connectInfoFor(slug) ?? { connect: "oauth", label: slug, settingsAnchor: null });
    } catch (e) {
      setError(e instanceof Error ? e.message : "The connection could not start. Try again.");
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <div className="flex flex-wrap items-center justify-end gap-2" data-testid="connect-buttons">
        {connectors.map((slug) => (
          <button key={slug} type="button" onClick={() => void start(slug)} disabled={busy !== null} className={CONNECT_BUTTON}>
            {busy === slug ? "Connecting…" : `Connect ${connectorLabel(slug)}`}
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="mt-3 text-[13px] text-red-700">
          {error}
        </p>
      )}
    </>
  );
}

export function AlsoConnect({
  platform,
  connectors,
  linked,
}: {
  platform: PlatformSpec;
  connectors?: readonly string[];
  linked: readonly string[];
}) {
  const rest = connectable(connectors, linked);
  if (rest.length === 0) return null;
  return (
    <div className="rounded-2xl border border-rule bg-creamDeep p-4" data-testid="also-connect">
      <p className="text-[14px] font-semibold text-ink">You can also connect {connectorNames(rest)}</p>
      <p className="mb-3 text-[16px] text-inkMuted">
        {platform.connectCopy?.also ?? "Each account you connect gives Zavi more to work from. Nothing changes in an account without your approval."}
      </p>
      <ConnectButtons connectors={rest} />
    </div>
  );
}

export function justConnectedSlugs(search: string, slugs: readonly string[]): string[] {
  const qs = new URLSearchParams(search);
  return slugs.filter((s) => qs.get(s) === "connected");
}

function dropConnectedFlags(slugs: readonly string[]): void {
  const url = new URL(window.location.href);
  for (const s of slugs) url.searchParams.delete(s);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

export function connectorNames(connectors: readonly string[]): string {
  const names = [...new Set(connectors.map(connectorLabel))];
  return names.length > 0 ? names.join(" or ") : "an account";
}

function ChannelMark({ slug, compact }: { slug: string; compact?: boolean }) {
  const mark = channelMark(slug);
  return (
    <span className={`relative flex shrink-0 ${compact ? "size-7" : "size-10"}`}>
      <span
        className={`flex h-full w-full items-center justify-center overflow-hidden rounded-xl ${mark.bg}`}
      >
        {mark.kind === "glyph" ? (
          <mark.Icon
            className={`${compact ? "h-3.5 w-3.5" : "h-5 w-5"} ${mark.fg}`}
            aria-hidden
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={mark.src}
            alt=""
            aria-hidden
            className={
              mark.fit === "cover"
                ? "h-full w-full object-cover"
                : compact
                  ? "h-4 w-4 object-contain"
                  : "h-6 w-6 object-contain"
            }
          />
        )}
      </span>
    </span>
  );
}

export function ConnectCard({
  slug,
  platform,
  connectors,
  onConnect,
}: {
  slug: string;
  platform: PlatformSpec;
  connectors?: readonly string[];
  onConnect?: () => Promise<void>;
}) {
  const connect = platform.connect ?? onConnect;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    if (!connect) return;
    setBusy(true);
    setError(null);
    try {
      await connect();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The connection could not start. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const choices = platform.connect ? [] : connectable(connectors);
  if (choices.length > 1) {
    return (
      <div className="rounded-2xl border border-rule bg-creamDeep p-4" data-testid="connect-card">
        <div className="flex flex-col gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <ChannelMark slug={slug} />
            <div className="min-w-0">
              <p className="text-[14px] font-semibold text-ink">Connect {connectorNames(choices)}</p>
              <p className="mt-0.5 text-[14px] leading-5 text-inkMuted">
                {platform.connectCopy?.blurb ??
                  "Zavi reads your account so its advice uses your real numbers. Nothing changes in your account without your approval."}
              </p>
            </div>
          </div>
          <div className="flex justify-end">
            <ConnectButtons connectors={choices} />
          </div>
        </div>
      </div>
    );
  }
  if (!connect) return null;
  return (
    <div className="rounded-2xl border border-rule bg-creamDeep p-4" data-testid="connect-card">
      <div className="flex flex-col gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <ChannelMark slug={slug} />
          <div className="min-w-0">
            <p className="text-[14px] font-semibold text-ink">
              Connect {connectors?.length ? connectorNames(connectors) : platform.name}
            </p>
            <p className="mt-0.5 text-[14px] leading-5 text-inkMuted">
              {platform.connectCopy?.blurb ??
                "Zavi reads your account so its advice uses your real numbers. Nothing changes in your account without your approval."}
            </p>
          </div>
        </div>
        <div className="flex justify-end">
          <button type="button" data-testid="connect-primary" onClick={() => void start()} disabled={busy} className={`${CONNECT_BUTTON} justify-center`}>
            {busy ? "Connecting…" : "Connect"}
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-[13px] text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

function ProblemBanner({
  slug,
  platform,
  problem,
  alert = false,
}: {
  slug: string;
  platform: PlatformSpec;
  problem: NonNullable<ChannelChrome["problem"]>;
  alert?: boolean;
}) {
  const connect = problem.reconnect ? platform.connect : undefined;
  const verb = problem.firstConnect ? "Connect" : "Reconnect";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reconnect = async () => {
    if (!connect || busy) return;
    setBusy(true);
    setError(null);
    try {
      await connect();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The connection could not start. Try again.");
      setBusy(false);
    }
  };
  const openSettings = () => window.dispatchEvent(new CustomEvent(CHANNEL_TAB_EVENT, { detail: { slug, tab: "settings" } }));
  const button = problem.settings ? (
    <button
      type="button"
      data-testid="problem-open-settings"
      onClick={openSettings}
      className={alert ? `inline-flex h-9 shrink-0 items-center rounded-full bg-ink px-4 text-[14px] font-medium text-cream ${FOCUS_RING}` : `rounded-sm font-medium text-ink underline underline-offset-2 ${FOCUS_RING}`}
    >
      {problem.settings}
    </button>
  ) : connect ? (
    <button
      type="button"
      onClick={() => void reconnect()}
      disabled={busy}
      aria-label={`${verb} ${platform.name}`}
      className={`rounded-sm font-medium text-ink underline underline-offset-2 disabled:opacity-50 ${FOCUS_RING}`}
    >
      {busy ? `${verb}ing…` : verb}
    </button>
  ) : undefined;
  if (alert) {
    return (
      <>
        <ReadProblemAlert key={problem.text} text={problem.text} action={button} step={!!problem.settings} />
        {error && <p role="alert" className="text-[13px] text-red-700">{error}</p>}
      </>
    );
  }
  return (
    <>
      <p
        role="status"
        data-testid="channel-read-problem"
        className="text-[14px] leading-5 text-inkMuted"
      >
        {problem.text}
        {button && <> {button}</>}
      </p>
      {error && (
        <p role="alert" className="text-[13px] text-red-700">
          {error}
        </p>
      )}
    </>
  );
}

const AD_ACCOUNT_PICKERS = {
  tiktok_ads: TiktokAdAccountCard,
} as const satisfies Record<NonNullable<PlatformSpec["adAccountPicker"]>, unknown>;

export function ChannelDashboard({
  slug,
  platform,
  metrics,
  loading,
  connectors,
  onSettled,
  tablesInto,
  topInto,
  noticeInto,
  onPayload,
  onActionsChanged,
}: {
  slug: string;
  platform: PlatformSpec;
  metrics: ChannelMetric[];
  loading: boolean;
  connected: boolean;
  hasConnectors: boolean;
  connectors?: readonly string[];
  onActionsChanged?: () => void;
  onSettled?: () => void;
  showEmpty?: boolean;
  tablesInto?: HTMLElement | null;
  topInto?: HTMLElement | null;
  noticeInto?: HTMLElement | null;
  onPayload?: (payload: unknown, refetch?: () => void) => void;
}) {
  const initial = DEFAULT_RANGES[DEFAULT_RANGES.length - 1];
  const [picked, setPicked] = useState<PickedRange>({
    id: initial.id,
    days: initial.days,
  });
  const [pickedMetric, setPickedMetric] = useState<string | null | undefined>(undefined);
  const startClosed = Boolean(platform.metricLayout?.startClosed);
  const dashboard = useAgentDashboard<unknown>(platform.dashboardSlug ?? slug, {
    params: useMemo(
      (): Record<string, string> =>
        picked.since && picked.until
          ? { days: String(picked.days), since: picked.since, until: picked.until }
          : { days: String(picked.days), window: `last_${picked.days}d` },
      [picked.days, picked.since, picked.until],
    ),
  });

  useEffect(() => {
    if (!dashboard.loading) onSettled?.();
  }, [dashboard.loading, onSettled]);

  const connectedKey = (connectors?.length ? connectors : [slug]).join(",");
  const [justConnected, setJustConnected] = useState<string[]>([]);
  useEffect(() => {
    const keys = connectedKey.split(",");
    const found = justConnectedSlugs(window.location.search, keys);
    setJustConnected((prev) => (found.length > 0 ? found : prev.filter((s) => keys.includes(s))));
    if (found.length > 0) dropConnectedFlags(found);
  }, [connectedKey]);

  const role = useWorkspaceOptional()?.role ?? null;
  const AdAccountPicker = platform.adAccountPicker ? AD_ACCOUNT_PICKERS[platform.adAccountPicker] : null;
  const refetch = useCallback(
    () => (dashboard.refreshSilent ?? dashboard.refresh)(),
    [dashboard.refreshSilent, dashboard.refresh],
  );
  const reread = dashboard.reread;
  const [accountReread, setAccountReread] = useState(false);
  useEffect(() => {
    if (!dashboard.refreshing) setAccountReread(false);
  }, [dashboard.refreshing]);
  useChannelReadFailure(dashboard.error !== null, refetch);
  const pickedKey = windowKey(picked);
  const customSpan = picked.since && picked.until ? { since: picked.since, until: picked.until } : null;
  const allowCustom = Boolean(platform.paidAnalytics) || CUSTOM_RANGE_SLUGS.has(slug);
  const dataWindow = useRef<{ data: unknown; key: string }>({ data: null, key: pickedKey });
  if (dataWindow.current.data !== dashboard.data) dataWindow.current = { data: dashboard.data, key: pickedKey };

  useEffect(() => {
    onPayload?.(dashboard.data ?? null, refetch);
  }, [dashboard.data, onPayload, refetch]);

  useEffect(() => {
    if (!dashboard.data) return;
    setCampaignLinks(slug, campaignLinksOf(dashboard.data));
    setChannelAccount(slug, channelAccountOf(dashboard.data));
    if (slug === "linkedin_ads" && !dashboard.cachedAt) setCampaignStates(slug, linkedinCampaignStates(dashboard.data));
  }, [slug, dashboard.data, dashboard.cachedAt]);

  useEffect(() => {
    const stale = (e: Event) => {
      const detail = (e as CustomEvent<{ slug?: string; scope?: string }>).detail;
      if (detail?.slug !== slug) return;
      if (detail.scope === "selection" && reread) {
        setAccountReread(true);
        reread();
      } else refetch();
    };
    window.addEventListener(CHANNEL_DASHBOARD_STALE_EVENT, stale);
    return () => window.removeEventListener(CHANNEL_DASHBOARD_STALE_EVENT, stale);
  }, [slug, refetch, reread]);

  if (dashboard.loading && dashboard.data == null) {
    return (
      <div role="status" aria-busy="true" aria-label="Loading" data-testid="channel-numbers-loading" className="pt-5">
        {}
        {platform.kpiFallback && (
          <span aria-hidden className="mt-3 block min-h-account-metric animate-pulse rounded-2xl border border-rule bg-bone/60 [animation-duration:1.6s] motion-reduce:animate-none" />
        )}
      </div>
    );
  }
  if (platform.payload?.offWhen && dashboard.data != null && platform.payload.offWhen(dashboard.data)) return null;

  const paidChannel = channelFamily(slug) === "paid";
  const chrome: ChannelChrome | null =
    platform.kpiFallback && dashboard.data
      ? channelChrome(platform.kpiFallback, dashboard.data)
      : null;
  const publishingAccount = platform.accountFromPayload?.(dashboard.data);
  const ranges = chrome?.ranges?.length ? chrome.ranges : DEFAULT_RANGES;
  const range = customSpan ? { id: CUSTOM_RANGE_ID, label: spanLabel(customSpan), days: picked.days } : ranges.find((r) => r.id === picked.id) ?? ranges[ranges.length - 1];

  const fallback =
    platform.kpiFallback && dashboard.data
      ? kpiFallbackMetrics(platform.kpiFallback, dashboard.data)
      : [];
  const offWindow = dashboard.data != null && dataWindow.current.key !== pickedKey;
  const customRefused = !offWindow && !dashboard.loading && customRangeRefused(customSpan, payloadPeriod(dashboard.data));
  const swappingWindow = (dashboard.loading && dashboard.data != null) || offWindow || customRefused;
  const windowReadFailed = customRefused || (offWindow && !dashboard.loading && !dashboard.refreshing && dashboard.error !== null);
  const health =
    platform.kpiFallback && dashboard.data && !swappingWindow
      ? kpiFallbackHealth(platform.kpiFallback, dashboard.data)
      : null;
  const organicAccount = platform.kpiFallback === "instagram" || platform.kpiFallback === "tiktok";
  const publicLinkedIn = platform.kpiFallback === "linkedin";
  const summary = channelSummaryMetrics(metrics, fallback, swappingWindow, organicAccount || publicLinkedIn || platform.kpiFallback === "tiktok_ads");
  const shown = swappingWindow
    ? summary
    : publicLinkedIn
      ? linkedinMetricSlots(summary, dashboard.data)
      : organicAccount
        ? emptyTiles(platform).map((slot) => {
            const measured = summary.find((metric) => metric.key === slot.key);
            if (measured && !measured.unmeasured && Number.isFinite(measured.value)) return measured;
            return {
              ...slot,
              unmeasured: typeof measured?.unmeasured === "string"
                ? measured.unmeasured
                : !dashboard.data
                  ? "Account data is unavailable. Try Refresh."
                  : (dashboard.data as { connected?: unknown }).connected === false
                    ? `Connect ${platform.name} in Settings to see this.`
                    : "Not available from the latest account read.",
            };
          })
        : summary;

  const linkedinTables = slug === "linkedin_ads";
  const tables = linkedinTables || platform.paidAnalytics || platform.analyticsLead
    ? []
    : (platform.extras ?? []).flatMap((extra) =>
        dashboard.data
          ? extraTableData(extra, dashboard.data, refetch, { role, onActionsChanged }).map((data) => ({ id: data.id ?? extra, data }))
          : [],
      );

  const claims = new Map<string, string>();
  for (const m of shown) {
    const id = platform.metricDisplay?.[m.key]?.selects;
    if (id && tables.some((t) => t.id === id)) claims.set(m.key, id);
  }
  const picking = claims.size > 1;
  const selectedKey: string | null | undefined = !picking
    ? undefined
    : pickedMetric === null
      ? null
      : pickedMetric && claims.has(pickedMetric)
        ? pickedMetric
        : startClosed
          ? null
          : [...claims.keys()][0];
  const selectedTable = selectedKey ? claims.get(selectedKey) : undefined;
  const onSelect = (key: string) => setPickedMetric(startClosed && key === selectedKey ? null : key);
  const claimed = new Set(claims.values());
  const visibleTables = swappingWindow
    ? []
    : picking
      ? tables.filter((t) => t.id === selectedTable || !claimed.has(t.id))
      : tables;
  const last = platform.tablesLast;
  const goesLast = (id: string) => last === true || (typeof last === "object" && last.includes(id));
  const blank = shown.length === 0 && !swappingWindow ? emptyTiles(platform) : [];

  return (
    <div className="mt-5 flex flex-col gap-6 compact:mt-4 compact:gap-4">
      {!platform.analyticsView && (
        <ChannelDashboardControls
          ranges={ranges}
          range={range}
          pickedId={picked.id}
          onPick={setPicked}
          allowCustom={allowCustom}
          custom={customSpan}
          period={swappingWindow ? null : payloadPeriod(dashboard.data)}
          hideRange={slug === "seo"}
          onRefresh={dashboard.refresh}
          refreshing={dashboard.refreshing}
          scan={Boolean(platform.scan)}
        />
      )}

      {slug === "linkedin_organic" && <OnTab tab="analytics"><LinkedInReadStatus payload={dashboard.data} /></OnTab>}

      {chrome?.connected && platform.accountFromPayload && !platform.hidePublishingAccount && (publishingAccount || chrome.readNote) && (
        <OnTab tab="analytics">
          <div data-testid="publishing-account" className="min-w-0 text-ca-action text-ca-secondary">
            {publishingAccount ? <p>Publishing as <span className="font-medium text-ca-xdark">{publishingAccount.name}</span>{publishingAccount.handle && publishingAccount.handle !== publishingAccount.name ? ` · ${publishingAccount.handle}` : ""}</p> : <p>The publishing account has not been confirmed yet.</p>}
            {chrome.readNote && <p className="mt-0.5">{chrome.readNote}</p>}
          </div>
        </OnTab>
      )}

      {}
      {chrome && !chrome.connected ? (
        <>
          {}
          {blank.length > 0 && (
            <MetricRows slug={slug} metrics={blank} platform={platform} plan={null} onPlanSaved={() => {}} />
          )}
          <ConnectCard
            slug={slug}
            platform={platform}
            connectors={connectors}
            onConnect={connectFirst(connectors)}
          />
        </>
      ) : (
        <>
          {justConnected.length > 0 && (
            <p role="status" data-testid="just-connected" className="text-[13px] font-medium text-ink">
              {`${connectorNames(justConnected)} is connected.`}
            </p>
          )}
          {chrome?.problem && (noticeInto && chrome.problem.reconnect && !chrome.problem.firstConnect
            ? createPortal(<ProblemBanner slug={slug} platform={platform} problem={chrome.problem} alert={paidChannel} />, noticeInto)
            : <ProblemBanner slug={slug} platform={platform} problem={chrome.problem} alert={paidChannel} />)}
          {accountReread && dashboard.refreshing && (
            <p role="status" data-testid="account-reread" className="inline-flex items-center gap-2 text-sm text-inkMuted">
              <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              Updating campaigns and numbers for your ad account…
            </p>
          )}
          {windowReadFailed && (
            <p role="alert" data-testid="window-read-failed" className="text-sm text-inkMuted">
              {`Zavi could not read the numbers for ${range.label} just now. Try Refresh in a minute, or pick another window.`}
            </p>
          )}

          {AdAccountPicker && <AdAccountPicker onChanged={refetch} onReconnect={platform.connect ?? connectFirst(connectors)} />}

          {health && <HealthSummary health={health} />}

          {platform.analyticsLead === "geo" && <GeoVisibility payload={swappingWindow ? null : dashboard.data} />}

          {(() => {
            const detail = (
              <>
          {platform.paidAnalytics ? (
            <PaidAnalytics kind={platform.paidAnalytics} payload={swappingWindow ? null : dashboard.data} days={picked.days} custom={customSpan} canEdit={role === "owner" || role === "admin"} refreshing={dashboard.refreshing || dashboard.loading} channelName={platform.name} onChanged={refetch} />
          ) : platform.campaignWorkspace ? (
            <CampaignWorkspace spec={platform.campaignWorkspace} key={pickedKey} payload={swappingWindow ? null : dashboard.data} days={picked.days} loading={dashboard.loading} onRefresh={refetch} />
          ) : shown.length > 0 ? (
            <MetricRows
              slug={slug}
              metrics={shown}
              platform={platform}
              plan={chrome?.plan ?? null}
              onPlanSaved={refetch}
              {...(picking
                ? {
                    selection: {
                      selectedKey,
                      onSelect,
                      panelId: METRIC_PANEL_ID,
                      ...(startClosed ? { mode: "disclosure" as const } : {}),
                    } satisfies RowSelection,
                  }
                : {})}
            />
          ) : loading || dashboard.loading ? (
            null
          ) : blank.length > 0 ? (
            <MetricRows slug={slug} metrics={blank} platform={platform} plan={null} onPlanSaved={() => {}} />
          ) : null}

          {}
          {picking && !startClosed && (
            <div role="tabpanel" id={METRIC_PANEL_ID} aria-label="Details for the selected number">
              {visibleTables
                .filter((t) => t.id === selectedTable)
                .map((t) => (
                  <ExtraTable key={t.id} data={t.data} />
                ))}
            </div>
          )}
          {picking && startClosed && selectedTable && (
            <div role="region" id={METRIC_PANEL_ID} aria-label="Details for the selected number">
              {visibleTables
                .filter((t) => t.id === selectedTable)
                .map((t) => (
                  <ExtraTable key={t.id} data={t.data} />
                ))}
            </div>
          )}
              </>
            );
            return platform.analyticsLead ? null : detail;
          })()}
          {(() => {
            const rest = visibleTables.filter((t) => !picking || t.id !== selectedTable);
            const draw = (list: typeof rest) => list.map((t) => <ExtraTable key={t.id} data={t.data} />);
            const top = [
              ...(linkedinTables && dashboard.data && !swappingWindow
                ? [<LinkedInCampaignWorkspace key="linkedin-campaigns" payload={dashboard.data} role={role} onFiled={onActionsChanged} onChanged={refetch} channelName={platform.name} />]
                : []),
              ...draw(rest.filter((t) => !goesLast(t.id))),
            ];
            const after = draw(rest.filter((t) => goesLast(t.id)));
            return (
              <>
                {topInto ? createPortal(top, topInto) : top}
                {after.length > 0 && tablesInto ? createPortal(after, tablesInto) : null}
              </>
            );
          })()}
        </>
      )}
    </div>
  );
}
