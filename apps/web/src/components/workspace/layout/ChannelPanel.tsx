"use client";

import { AD_LOCATION_SLUGS, AdLocationsCard } from "../actions/AdLocations";
import { AdsAccountSettings } from "../actions/managed-campaigns/AdsAccountSettings";
import { usePendingCampaignReview } from "../actions/managed-campaigns/campaignReviewRequest";
import { channelFamily } from "../actions/card/family";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { apiFetch } from "@/lib/api";
import { useChannelPlanLock } from "../actions/channelPlanLock";
import { useAgentDashboard, type DashboardState } from "../agent/dashboard-ui";
import { cx, FOCUS_RING } from "./shared";
import { ChannelHeaderRow } from "./ChannelHeaderRow";
import {
  channelTabs,
  ChannelSettingsTab,
  prefetchChannelSettings,
  type ChannelTabKey,
} from "./ChannelTabs";
import { useTabSwap } from "@/lib/workspace/useTabSwap";
import { ChannelTabBar } from "./ChannelTabBar";
import { ChannelPageProvider } from "./channelPage";
import { useWorkspaceOptional } from "../WorkspaceShell";
import { isMember } from "@/lib/members";
import { AdSpendSection } from "./settings/AdSpendSection";
import { ConnectionSection } from "./settings/ConnectionSection";
import { DashboardConnection } from "./settings/DashboardConnection";
import { PostingSettings } from "./settings/PostingSettings";
import { ChannelOverviewPanels, ChannelSettingsPanels, useSettingsBadge } from "../email/EmailSettingsPanels";
import { platformFor } from "../actions/platforms";
import { showsAccountSnapshot } from "../actions/platformSpec";
import { ChannelScanControl } from "./ChannelScanControl";
import { ChannelHumanLane } from "./ChannelHumanLane";
import { ChannelHeaderAction } from "./ChannelHeaderAction";
import { UgcDrawerHost } from "../ugc/UgcDrawerHost";
import { MessagesDrawerHost } from "../ugc/MessagesDrawer";
import { useCreatorHiringCards } from "../ugc/CreatorHiringCards";
import { ChannelSnapshotPaste, channelCanPaste } from "./ChannelSnapshotPaste";
import { ActionsEmpty } from "./ChannelEmptyStates";
import { connectorNames } from "../actions/ChannelDashboard";
import { CREATOR_MARKETPLACE_ENABLED, connectorHasConnectPath } from "@zavi/shared";
import { ChannelRunFoot } from "./ChannelRunFoot";
import { ChannelRefreshNotice, ChannelRefreshProvider, useChannelReadFailure } from "./ChannelRefresh";
import { type ChannelDetail } from "./channelDetail";
import { ChannelActionsLane, type PriorRows } from "../actions/ChannelActionsLane";
import { useStudioLibrary } from "../videoStudio/studioApi";
import { VideoOverview } from "../videoStudio/VideoOverview";
import { VideoLibrary } from "../videoStudio/VideoLibrary";
import { EMAIL_SETTINGS_GOTO_EVENT } from "../email/emailSettingsNav";
import { EmailHeadTools } from "../email/EmailHeadTools";
import { EmailSettingsTab } from "../email/EmailSettingsTab";
import { EmailAnalytics } from "../email/EmailAnalytics";
import { PinterestAnalytics } from "../pinterest/PinterestAnalytics";
import { XAnalytics } from "../x/XAnalytics";
import { PinterestSettingsTab } from "../pinterest/PinterestSettingsTab";
import { announceChannelActionsChanged, APPROVALS_CHANGED_EVENT, CHANNEL_TAB_EVENT } from "../actions/topActions/api";
import { onApiWrite } from "@/lib/workspace/apiWrites";
import { announceEmailPlanChanged } from "@/lib/workspace/emailCardEvents";
import { announceChannelSettingsChanged } from "@/lib/workspace/onTabReturn";
import { TabHiddenContext } from "./tabHidden";
import { announceChannelDashboardStale } from "../actions/campaignLinks";
import { startRailConnect } from "@/app/connectors/connectStrategies";

const LIVE_POLL_MS = 20_000;

type ChannelPanelProps = {
  detail: ChannelDetail;
  actionCount: number;
  onOpenConnectors: () => void;
  children?: ReactNode;
  prior?: PriorRows;
  chatStaged?: PriorRows;
  settings?: ReactNode;
  onExtraCount?: (slug: string, n: number) => void;
};

function adAccountName(payload: unknown): string | null {
  const name = (payload as { account?: { name?: unknown } } | null)?.account?.name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

export function ChannelPanel(props: ChannelPanelProps) {
  const platform = platformFor(props.detail.channel.slug);
  return (
    <ChannelRefreshProvider>
      {platform.payload ? <PayloadChannelPanel {...props} /> : <ChannelPanelBody {...props} />}
    </ChannelRefreshProvider>
  );
}

function PayloadChannelPanel(props: ChannelPanelProps) {
  const { channel } = props.detail;
  const spec = platformFor(channel.slug).payload!;
  const dashboard = useAgentDashboard<unknown>(channel.slug);
  const data = dashboard.data;
  const refresh = dashboard.refreshSilent ?? dashboard.refresh;
  useChannelReadFailure(dashboard.error !== null, refresh);

  const surfaceOff = spec.offWhen ? !data || spec.offWhen(data) : false;

  const seeded = useRef(false);
  const seed = spec.seed;
  const openedWith = useRef(data);
  const fresh = data !== null && data !== openedWith.current;
  const planLocked = Boolean(useChannelPlanLock()?.tierName);
  const seedNow = !surfaceOff && !planLocked && !!seed && fresh && !!data && seed.emptyWhen(data);
  useEffect(() => {
    if (!seedNow || !seed || seeded.current) return;
    seeded.current = true;
    void apiFetch(seed.endpoint, { method: "POST" })
      .then(() => refresh())
      .catch(() => undefined);
  }, [seedNow, seed, refresh]);

  const live = !surfaceOff && !!spec.liveWhen && !!data && spec.liveWhen(data);
  useEffect(() => {
    if (!live) return;
    const id = setInterval(refresh, LIVE_POLL_MS);
    return () => clearInterval(id);
  }, [live, refresh]);

  return <ChannelPanelBody {...props} dashboard={dashboard} surfaceOff={surfaceOff} />;
}

function ChannelPanelBody({
  detail,
  actionCount,
  onOpenConnectors,
  children,
  prior,
  chatStaged,
  settings,
  onExtraCount,
  dashboard,
  surfaceOff = false,
}: ChannelPanelProps & {
  dashboard?: DashboardState<unknown>;
  surfaceOff?: boolean;
}) {
  const {
    channel,
    mode,
    connected,
    connectors,
    workState,
    lastRunAt,
    runnable,
  } = detail;

  const platform = platformFor(channel.slug);
  const publishWhen = platform.payload?.publishWhen;
  const publishReady = !surfaceOff && !!publishWhen && !!dashboard?.data && publishWhen(dashboard.data);

  const linkableConnectors = connectors.filter(connectorHasConnectPath);
  const canConnect = linkableConnectors.length > 0 && !connected;
  const canRead = connected || !!platform.accountReadable?.(dashboard?.data);
  const canPaste = channelCanPaste(channel.slug, canRead);
  const hasHumanLane = CREATOR_MARKETPLACE_ENABLED && Boolean(channel.human?.available);
  const creator = useCreatorHiringCards(channel.slug, CREATOR_MARKETPLACE_ENABLED);
  const creatorCount = creator.cards.length + creator.more.length;
  useEffect(() => {
    if (creator.settled) onExtraCount?.(channel.slug, creatorCount);
  }, [creator.settled, creatorCount, channel.slug, onExtraCount]);
  const hasSchedule = (connected || connectors.length === 0) && runnable !== false;
  const settingsFields = surfaceOff ? [] : (platform.settings ?? []);
  const hostsSettings = !surfaceOff && !!platform.settingsPanels && platform.settingsPanels.length > 0;
  const connectLink = (
    <button
      type="button"
      onClick={onOpenConnectors}
      className={cx(
        "mt-5 block text-[13px] font-medium text-inkMuted underline underline-offset-2",
        FOCUS_RING,
      )}
    >
      {platform.connectCopy?.link ?? `Connect ${connectorNames(linkableConnectors)} to get real numbers here`}
    </button>
  );
  const posting = Boolean((platform.createMenu && channelFamily(channel.slug) === "organic") || platform.postingSettings || platform.spendSettings) && !hostsSettings && !surfaceOff;
  const role = useWorkspaceOptional()?.role ?? null;
  const canEditSettings = role !== null && !isMember(role);
  const settingsExtras =
    canConnect || canPaste || hasSchedule || Boolean(settings) || posting;
  const settingsCount = useSettingsBadge(platform.settingsBadge);
  const emailPage = !surfaceOff && platform.headTools === "email_campaign";
  const pinterestPage = !surfaceOff && platform.analyticsView === "pinterest";
  const xPage = !surfaceOff && platform.analyticsView === "x";
  const hasAnalytics = emailPage || pinterestPage || xPage ||
    showsAccountSnapshot(platform) &&
    (Boolean(platform.kpiFallback || platform.extras?.length) || Object.keys(platform.metricDisplay ?? {}).length > 0 || linkableConnectors.length > 0);
  const tabs = channelTabs(
    surfaceOff ? { ...platform, settings: undefined } : platform,
    settingsExtras,
    hasAnalytics,
  );
  const [analyticsEl, setAnalyticsEl] = useState<HTMLDivElement | null>(null);
  const [tab, setTab] = useState<ChannelTabKey>(tabs[0][0]);
  const [studioThread, setStudioThread] = useState<string | null>(null);
  const active: ChannelTabKey = tabs.some(([k]) => k === tab) ? tab : tabs[0][0];
  const library = useStudioLibrary(Boolean(platform.studio));
  const reloadLibrary = library.reload;
  useEffect(() => {
    if (active === "library") reloadLibrary();
  }, [active, reloadLibrary]);
  const listensForSettingsGoto = Boolean(platform.settingsPanels?.length) && !surfaceOff;
  useEffect(() => {
    if (!listensForSettingsGoto) return;
    const go = () => setTab("settings");
    window.addEventListener(EMAIL_SETTINGS_GOTO_EVENT, go);
    return () => window.removeEventListener(EMAIL_SETTINGS_GOTO_EVENT, go);
  }, [listensForSettingsGoto]);
  const reviewRequested = usePendingCampaignReview();
  const reviewsCampaigns = Boolean(platform.sponsoredPostReview);
  const opensWalletOnReturn = Boolean(platform.adsAccountPlatform);
  useEffect(() => {
    if (opensWalletOnReturn && new URLSearchParams(window.location.search).has("ads_payment")) setTab("settings");
  }, [opensWalletOnReturn]);
  useEffect(() => {
    if (reviewRequested && reviewsCampaigns) setTab("overview");
  }, [reviewRequested, reviewsCampaigns]);
  useEffect(() => {
    const onTab = (e: Event) => {
      const d = (e as CustomEvent<{ slug?: unknown; tab?: unknown }>).detail;
      if (d?.slug !== channel.slug || !(d.tab === "studio" || d.tab === "library" || d.tab === "overview" || d.tab === "analytics" || d.tab === "settings")) return;
      setTab(d.tab);
      if (d.tab !== "studio") setStudioThread(null);
    };
    window.addEventListener(CHANNEL_TAB_EVENT, onTab);
    return () => window.removeEventListener(CHANNEL_TAB_EVENT, onTab);
  }, [channel.slug]);

  const nextSteps = (
    <>
      <h3 className="mt-5 text-[16px] font-semibold text-ink">Next steps</h3>
      {actionCount === 0 ? (
        <ActionsEmpty workState={workState} lastRunAt={lastRunAt} />
      ) : (
        <ul className="mt-2 flex flex-col gap-2.5">{children}</ul>
      )}
    </>
  );

  const hasDashboardHeader = Boolean(platform.kpiFallback || platform.extras?.length);
  const refreshDashboard = dashboard?.reread ?? dashboard?.refreshSilent;
  const connectionChanged = useCallback(() => {
    refreshDashboard?.();
    announceChannelDashboardStale(channel.slug, "selection");
    window.dispatchEvent(new Event(APPROVALS_CHANGED_EVENT));
  }, [refreshDashboard, channel.slug]);
  const tabSwapRef = useTabSwap<HTMLDivElement>(active);
  const [paintedSlug, setPaintedSlug] = useState<string | null>(null);
  const below = paintedSlug === channel.slug;

  const keepTabs = !platform.studio;
  const prefetchSettings = keepTabs && below && !hostsSettings && settingsFields.length > 0 && tabs.some(([k]) => k === "settings");
  const prefetchedSlug = useRef<string | null>(null);
  useEffect(() => {
    if (!prefetchSettings || prefetchedSlug.current === channel.slug) return;
    prefetchedSlug.current = channel.slug;
    prefetchChannelSettings(channel.slug);
  }, [prefetchSettings, channel.slug]);
  const settingsChanged = useCallback(() => {
    connectionChanged();
    announceChannelActionsChanged(channel.slug);
    announceEmailPlanChanged();
    announceChannelSettingsChanged();
  }, [connectionChanged, channel.slug]);
  const postingSettings = (
    <div data-testid="channel-posting-settings" className="mx-auto flex w-full max-w-[720px] flex-col gap-6 pt-5">
      <h2 className="sr-only">{`${channel.name} settings`}</h2>
      {(linkableConnectors.length > 0 || connected) && (platform.postingSettings ? (
        <DashboardConnection
          slug={channel.slug}
          name={platform.postingSettings.connectionName}
          logo={platform.postingSettings.connectionLogo}
          connected={connected}
          readAccount={platform.postingSettings.accountFromPayload}
          onManage={onOpenConnectors}
        />
      ) : (
        <ConnectionSection
          slug={channel.slug}
          name={platform.name}
          connected={connected}
          account={platform.accountFromPayload?.(dashboard?.data)?.name ?? (platform.spendSettings ? adAccountName(dashboard?.data) : null)}
          {...(platform.spendSettings && connected ? { manageLabel: "Disconnect" } : {})}
          onManage={onOpenConnectors}
        />
      ))}
      {platform.spendSettings && <AdSpendSection slug={channel.slug} canEdit={canEditSettings} />}
      <PostingSettings slug={channel.slug} name={platform.name} canEdit={canEditSettings} />
      {platform.railConnect && !!dashboard?.data && !publishReady && <RailConnect connect={platform.railConnect} />}
      <ChannelSnapshotPaste channel={channel} connected={canRead} />
      {settings}
      {settingsFields.length > 0 && <ChannelSettingsTab slug={channel.slug} fields={settingsFields} />}
    </div>
  );
  const adsAccountSettings = (
    <div data-testid="channel-posting-settings" className={cx("mx-auto flex w-full max-w-[960px] flex-col gap-6", platform.adsAccountPlatform === "linkedin" ? "pt-6" : "pt-5")}>
      <h2 className="sr-only">{`${channel.name} settings`}</h2>
      {platform.adsAccountPlatform === "linkedin" ? (
        <ConnectionSection slug={channel.slug} name={platform.name} connected={connected} account={null} onManage={onOpenConnectors} />
      ) : (
        <AdsAccountSettings key={channel.slug} settingsPage platform="chatgpt" onConnectionChange={connectionChanged} />
      )}
      <PostingSettings slug={channel.slug} name={platform.name} canEdit={canEditSettings} />
      <ChannelSnapshotPaste channel={channel} connected={canRead} />
      {settings}
      {settingsFields.length > 0 && <ChannelSettingsTab slug={channel.slug} fields={settingsFields} />}
    </div>
  );
  const emailSettings = (
    <EmailSettingsTab
      slug={channel.slug}
      name={platform.name}
      panels={platform.settingsPanels ?? []}
      canEdit={canEditSettings}
      extra={settingsFields.length > 0 ? <ChannelSettingsTab slug={channel.slug} fields={settingsFields} bare /> : null}
      onOpenConnectors={onOpenConnectors}
    />
  );
  const pinterestSettings = (
    <PinterestSettingsTab
      slug={channel.slug}
      name={platform.name}
      connected={connected}
      canEdit={canEditSettings}
      fields={settingsFields}
      onOpenConnectors={onOpenConnectors}
    />
  );
  const settingsTab = platform.adsAccountPlatform && !surfaceOff ? adsAccountSettings : emailPage && hostsSettings ? emailSettings : pinterestPage ? pinterestSettings : posting ? postingSettings : (
        <>
          {}
          {}
          {hostsSettings && (
            <ChannelSettingsPanels
              panels={platform.settingsPanels ?? []}
              below={canConnect ? connectLink : null}
              extra={
                settingsFields.length > 0 ? (
                  <ChannelSettingsTab slug={channel.slug} fields={settingsFields} bare />
                ) : null
              }
            />
          )}

          {}
          {canConnect && !hostsSettings && connectLink}

          {platform.railConnect && !surfaceOff && !!dashboard?.data && !publishReady && (
            <RailConnect connect={platform.railConnect} />
          )}

          {}
          <ChannelSnapshotPaste channel={channel} connected={canRead} />

          {}
          {hasSchedule && !hostsSettings && (
            <p data-testid="channel-run-note" className="mt-5 text-[13px] text-inkMuted">
              {`There is no timer for ${channel.name}: it runs when you ask. Which channels CGO may run under Autopilot is set on the Growth page.`}
            </p>
          )}

          {settings}

          {!hostsSettings && settingsFields.length > 0 && (
            <ChannelSettingsTab slug={channel.slug} fields={settingsFields} />
          )}
        </>
  );
  const overviewTab = (
        <>
          {}
          <ChannelRefreshNotice key={channel.slug} />
          {}
          {AD_LOCATION_SLUGS.has(channel.slug) && (
            <AdLocationsCard
              key={`locations-${channel.slug}`}
              slug={channel.slug}
              channelName={channel.name}
              onOpenConnectors={onOpenConnectors}
            />
          )}
          {}
          {!surfaceOff && platform.overviewTopPanels && platform.overviewTopPanels.length > 0 && (
            <ChannelOverviewPanels key={`overview-top-${channel.slug}`} panels={platform.overviewTopPanels} />
          )}
          <ChannelActionsLane
            key={`actions-${channel.slug}`}
            slug={channel.slug}
            legacy={nextSteps}
            workState={workState}
            lastRunAt={lastRunAt}
            planIntent={detail.planIntent ?? null}
            planRationale={detail.planRationale ?? null}
            fit={detail.fit ?? null}
            hasStrategy={detail.hasStrategy ?? false}
            actionCount={actionCount}
            prior={prior}
            chatStaged={chatStaged}
            onPainted={setPaintedSlug}
            connected={connected}
            publishReady={publishReady}
            surfaceOff={surfaceOff}
            hasConnectors={linkableConnectors.length > 0}
            connectors={linkableConnectors}
            linkedConnectors={detail.linkedConnectors}
            extraCards={{
              cards: creator.cards,
              more: creator.more,
              metrics: creator.metrics,
              settled: creator.settled,
              position: hasHumanLane ? "before" : "after",
              notice: creator.notice,
              kinds: creator.kinds,
              reload: creator.reload,
            }}
          >
            {children}
          </ChannelActionsLane>

          {}
          <div data-testid="channel-overview-below" hidden={!below} className={below ? "contents" : "hidden"}>
          {hasHumanLane && <ChannelHumanLane channel={channel} />}

          {}
          {!surfaceOff && platform.overviewPanels && platform.overviewPanels.length > 0 && (
            <ChannelOverviewPanels key={`overview-${channel.slug}`} panels={platform.overviewPanels} />
          )}

          <ChannelRunFoot key={`runs-${channel.slug}`} slug={channel.slug} runKey={`${workState}|${lastRunAt ?? ""}`} />
          </div>
        </>
  );

  const page = { active, tabs: tabs.map(([k]) => k), analytics: analyticsEl };

  return (
    <ChannelPageProvider value={page}>
    <ChannelHeaderRow
      underline={tabs.length > 1}
      spaced={tabs.length > 1 || hasDashboardHeader}
      left={
        <ChannelTabBar
          tabs={tabs}
          active={active}
          onSelect={(k) => {
            setTab(k);
            if (k !== "studio") setStudioThread(null);
          }}
          count={actionCount + creatorCount}
          settingsCount={settingsCount}
          libraryCount={library.videos?.length ?? 0}
          label={channel.name}
        />
      }
    >
      {}
      {}
      {hasHumanLane && platform.headerAction && <ChannelHeaderAction action={platform.headerAction} />}
      {!surfaceOff && platform.headTools === "email_campaign" && <EmailHeadTools slug={channel.slug} channelName={platform.name} />}

      <ChannelScanControl
        slug={channel.slug}
        name={platform.name}
        scan={platform.scan}
        dashboard={dashboard}
        surfaceOff={surfaceOff}
      />

      {platform.adsAccountPlatform === "linkedin" && (
        <div className={cx("mx-auto w-full max-w-[960px]", active === "settings" && "pt-5")}>
          <AdsAccountSettings key={channel.slug} settingsPage hidden={active !== "settings"} platform={platform.adsAccountPlatform} onConnectionChange={connectionChanged} />
        </div>
      )}
      <div ref={tabSwapRef} data-testid="channel-tab-content">
      {platform.studio && (
        <div hidden={active !== "studio"}>
          <VideoOverview slug={channel.slug} focusThread={studioThread} />
        </div>
      )}
      {keepTabs ? (
        <>
          <KeptTabs key={channel.slug} active={active} overview={overviewTab} settings={settingsTab} onSettingsChanged={settingsChanged} />
          {tabs.some(([k]) => k === "analytics") && (
            <div ref={setAnalyticsEl} data-testid="channel-tab-analytics" role="tabpanel" aria-label={`${channel.name} analytics`} hidden={active !== "analytics"} className={active === "analytics" ? "block pt-5" : "hidden"}>
              {emailPage && <EmailAnalytics active={active === "analytics"} foot={<ChannelRunFoot key={`logs-${channel.slug}`} slug={channel.slug} runKey={`${workState}|${lastRunAt ?? ""}`} logsOnly />} />}
              {pinterestPage && <PinterestAnalytics active={active === "analytics"} connected={connected} foot={<ChannelRunFoot key={`foot-${channel.slug}`} slug={channel.slug} runKey={`${workState}|${lastRunAt ?? ""}`} memory={false} />} />}
              {xPage && <XAnalytics active={active === "analytics"} foot={<ChannelRunFoot key={`foot-${channel.slug}`} slug={channel.slug} runKey={`${workState}|${lastRunAt ?? ""}`} memory={false} />} />}
            </div>
          )}
        </>
      ) : active === "studio" ? null : active === "library" ? (
        <>
          {library.videos && library.error && (
            <p role="alert" data-testid="video-library-refresh-error" className="mx-auto mb-3 w-full max-w-[960px] rounded-xl border border-coral/30 bg-coral/10 px-4 py-3 text-[14px] text-coral">
              {library.error}
            </p>
          )}
          <VideoLibrary
            videos={library.videos}
            error={library.videos ? null : library.error}
            onOpenChat={(id) => {
              setStudioThread(id);
              setTab("studio");
            }}
            onMake={() => setTab("studio")}
            onRefresh={reloadLibrary}
          />
        </>
      ) : active === "settings" ? (
        settingsTab
      ) : (
        overviewTab
      )}
      </div>

      {}
      {(hasHumanLane || platform.creatorMessages) && (CREATOR_MARKETPLACE_ENABLED ? <UgcDrawerHost /> : <MessagesDrawerHost />)}
    </ChannelHeaderRow>
    </ChannelPageProvider>
  );
}

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let at = el?.parentElement ?? null; at; at = at.parentElement) {
    if (/(auto|scroll)/.test(window.getComputedStyle(at).overflowY)) return at;
  }
  return null;
}

function KeptTabs({
  active,
  overview,
  settings,
  onSettingsChanged,
}: {
  active: ChannelTabKey;
  overview: ReactNode;
  settings: ReactNode;
  onSettingsChanged: () => void;
}) {
  const [opened, setOpened] = useState<ReadonlySet<ChannelTabKey>>(() => new Set([active]));
  if (!opened.has(active)) setOpened(new Set(opened).add(active));
  const rootRef = useRef<HTMLDivElement>(null);
  const scrolled = useRef<Partial<Record<ChannelTabKey, number>>>({});
  const shown = useRef(active);
  useEffect(() => {
    const scroller = scrollParent(rootRef.current);
    if (!scroller) return;
    const note = () => {
      scrolled.current[shown.current] = scroller.scrollTop;
    };
    scroller.addEventListener("scroll", note, { passive: true });
    return () => scroller.removeEventListener("scroll", note);
  }, []);
  useLayoutEffect(() => {
    if (shown.current === active) return;
    shown.current = active;
    const scroller = scrollParent(rootRef.current);
    if (scroller) scroller.scrollTop = scrolled.current[active] ?? 0;
  }, [active]);
  const wrote = useRef(false);
  useEffect(() => {
    if (active === "overview") return;
    return onApiWrite(() => {
      wrote.current = true;
    });
  }, [active]);
  useEffect(() => {
    if (active !== "overview" || !wrote.current) return;
    wrote.current = false;
    onSettingsChanged();
  }, [active, onSettingsChanged]);
  const panel = (key: ChannelTabKey, node: ReactNode) => {
    if (!opened.has(key)) return null;
    const hide = active !== key;
    return (
      <TabHiddenContext.Provider value={hide}>
        <div data-testid={`channel-tab-${key}`} hidden={hide} className={hide ? "hidden" : "contents"}>
          {node}
        </div>
      </TabHiddenContext.Provider>
    );
  };
  return (
    <div ref={rootRef} className="contents">
      {panel("overview", overview)}
      {panel("settings", settings)}
    </div>
  );
}

function RailConnect({ connect }: { connect: { toolkit: string; native: string; label: string } }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mt-5">
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await startRailConnect(connect.toolkit, connect.native);
          } catch {
            setError("Couldn't start the connection. Try again in a minute.");
          } finally {
            setBusy(false);
          }
        }}
        className={cx(
          "inline-flex h-9 items-center rounded-full border border-rule bg-cream px-4 text-[14px] font-medium text-ink hover:border-ink disabled:opacity-50",
          FOCUS_RING,
        )}
      >
        {connect.label}
      </button>
      {error && (
        <p role="alert" className="mt-2 text-[13px] text-warn">
          {error}
        </p>
      )}
    </div>
  );
}
