"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { BarChart3, Lock, Maximize2, PanelRightClose, RefreshCw } from "lucide-react";
import { PerformanceMarketerDashboard } from "../agent/PerformanceMarketerDashboard";
import {
  AdsManagerDateRangePicker,
  presetRange,
  resolveWindow,
  type ResolvedRange,
} from "../agent/AdsManagerDateRangePicker";
import { SeoGeoDashboard } from "../agent/SeoGeoDashboard";
import { GeoDashboard } from "../agent/GeoDashboard";
import { XAgentDashboard } from "../agent/XAgentDashboard";
import { RedditAnalyticsDashboard } from "../agent/RedditOrganicDashboard";
import { ProPlanGate } from "../ProPlanGate";
import { Skeleton } from "@/components/ui/Skeleton";
import type { ColumnChrome } from "./columnChrome";
import { useChannelLocks } from "./useChannelLocks";
import { TabIndicator, useTabIndicator } from "./TabIndicator";
import { cx, FOCUS_RING, PANEL_HEADER_TITLE } from "./shared";
import { CHANNEL_TAB, type ChannelSlug } from "@/lib/workspace/channelTabs";
import { useIsCompact } from "@/lib/responsive";
import { lockedTierOf, planBadgeLabel, type LockTier } from "@/lib/workspace/planUpgrade";
import {
  CompactHeaderActions,
  useCompactHeaderSlot,
} from "./compactHeaderSlot";

type ChannelCtx = {
  range: ResolvedRange;
  onRangeChange: (r: ResolvedRange) => void;
  refreshTick: number;
  active: boolean;
  onRefreshingChange: (refreshing: boolean) => void;
};

type Channel = {
  id: ChannelSlug;
  label: string;
  render: (ctx: ChannelCtx) => ReactNode;
};

const wide = (node: ReactNode) => (
  <div className="mx-auto w-full max-w-[1400px] px-4 pb-4 pt-2 compact:pt-4">{node}</div>
);

const CHANNELS: Channel[] = [
  {
    id: CHANNEL_TAB.metaAds,
    label: "Meta Ads",
    render: (ctx) => wide(<PerformanceMarketerDashboard channel="meta" {...ctx} />),
  },
  {
    id: CHANNEL_TAB.googleAds,
    label: "Google Ads",
    render: (ctx) => wide(<PerformanceMarketerDashboard channel="google" {...ctx} />),
  },
  {
    id: CHANNEL_TAB.seo,
    label: "SEO",
    render: (ctx) => (
      wide(
        <SeoGeoDashboard
          refreshTick={ctx.refreshTick}
          active={ctx.active}
          onRefreshingChange={ctx.onRefreshingChange}
        />,
      )
    ),
  },
  {
    id: CHANNEL_TAB.geo,
    label: "GEO",
    render: (ctx) => (
      wide(
        <GeoDashboard
          refreshTick={ctx.refreshTick}
          active={ctx.active}
          onRefreshingChange={ctx.onRefreshingChange}
        />,
      )
    ),
  },
  {
    id: CHANNEL_TAB.reddit,
    label: "Reddit",
    render: (ctx) => (
      wide(
        <RedditAnalyticsDashboard
          refreshTick={ctx.refreshTick}
          active={ctx.active}
          onRefreshingChange={ctx.onRefreshingChange}
        />,
      )
    ),
  },
  {
    id: CHANNEL_TAB.x,
    label: "X (Twitter)",
    render: (ctx) => (
      wide(
        <XAgentDashboard
          variant="analytics"
          refreshTick={ctx.refreshTick}
          active={ctx.active}
          onRefreshingChange={ctx.onRefreshingChange}
        />,
      )
    ),
  },
];

const RANGE_CHANNEL_IDS = new Set<string>([CHANNEL_TAB.metaAds, CHANNEL_TAB.googleAds]);

const TIER_RANK: Record<LockTier, number> = { free: 0, starter: 1, growth: 2, pro: 3 };

const channelIdFromHash = () => {
  if (typeof window === "undefined") return null;
  const id = window.location.hash.replace(/^#/, "");
  return CHANNELS.some((c) => c.id === id) ? id : null;
};

function AnalyticsSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-4 p-4" data-testid="analytics-skeleton" aria-busy="true">
      <span className="sr-only">Loading analytics</span>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
      <Skeleton className="h-56" />
      <Skeleton className="h-32" />
    </div>
  );
}

export function View360({
  chrome,
  onCollapse,
  onExpand,
  active = true,
}: {
  chrome?: ColumnChrome;
  onCollapse?: () => void;
  onExpand?: () => void;
  active?: boolean;
}) {
  const locks = useChannelLocks();
  const lockOf = (id: string) => lockedTierOf({ locked_tier: locks?.[id] });
  const resolved = (id: string) => locks !== null && id in locks;
  const rank = (id: string) => (resolved(id) ? TIER_RANK[lockOf(id) ?? "free"] : 99);
  const open = (id: string) => resolved(id) && !lockOf(id);
  const [pickedId, setChannelId] = useState<string | null>(() => channelIdFromHash());
  const channelId =
    pickedId ?? CHANNELS.reduce((best, c) => (rank(c.id) < rank(best.id) ? c : best)).id;
  const channel = CHANNELS.find((c) => c.id === channelId) ?? CHANNELS[0];
  const visitedRef = useRef<Set<string>>(new Set());
  if (open(channel.id)) visitedRef.current.add(channel.id);

  const selectChannel = (id: string) => {
    setChannelId(id);
    window.history.replaceState(null, "", `#${id}`);
  };

  useEffect(() => {
    const onHash = () => {
      const id = channelIdFromHash();
      if (id) setChannelId(id);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const [range, setRange] = useState<ResolvedRange>(() => {
    const now = new Date();
    const { start, end } = presetRange("last_7d", now);
    return resolveWindow(start, end, now);
  });
  const [refreshTick, setRefreshTick] = useState(0);
  const activeTabRef = useRef<HTMLButtonElement | null>(null);
  const [refreshingIds, setRefreshingIds] = useState<Set<string>>(() => new Set());
  const setChannelRefreshing = useCallback((id: string, refreshing: boolean) => {
    setRefreshingIds((prev) => {
      if (prev.has(id) === refreshing) return prev;
      const next = new Set(prev);
      if (refreshing) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const compact = useIsCompact();
  const channelLock = lockOf(channel.id);

  const headerSlot = useCompactHeaderSlot();
  const liftControls = compact && active && headerSlot !== null;

  useEffect(() => {
    if (!compact) return;
    activeTabRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [channel.id, compact]);

  const canPickRange = RANGE_CHANNEL_IDS.has(channel.id);
  const refreshing = refreshingIds.has(channel.id);

  const iconButton = cx(
    "flex h-8 w-8 items-center justify-center rounded-cta text-inkLight hover:bg-bone hover:text-ink",
    liftControls && "compact:h-10 compact:w-10 relative after:absolute after:-inset-y-1.5 after:inset-x-0 after:content-['']",
    FOCUS_RING,
  );

  const controls = (
    <div className={cx("flex shrink-0 items-center", liftControls ? "gap-0.5" : "gap-2")}>
      {open(channel.id) && (
        <>
          <button
            type="button"
            disabled={refreshing}
            onClick={() => setRefreshTick((t) => t + 1)}
            aria-label={refreshing ? "Refreshing" : "Refresh"}
            title={refreshing ? "Refreshing…" : "Refresh"}
            className={cx(
              iconButton,
              "disabled:cursor-not-allowed disabled:hover:bg-transparent",
            )}
          >
            <RefreshCw className={cx("h-4 w-4", liftControls && "compact:h-[18px] compact:w-[18px]", refreshing && "animate-spin")} aria-hidden />
          </button>
          <div
            className={cx(
              "flex items-center justify-center",
              liftControls &&
                "compact:h-10 compact:w-10 compact:[&>div>button]:h-10 compact:[&>div>button]:w-10",
            )}
          >
            <AdsManagerDateRangePicker
              value={range}
              onChange={setRange}
              align="right"
              disabled={!canPickRange}
              compact
            />
          </div>
        </>
      )}
      {onExpand && (
        <button
          type="button"
          onClick={onExpand}
          aria-label="Expand analytics"
          title="Expand analytics"
          className={iconButton}
        >
          <Maximize2 className="h-4 w-4" aria-hidden />
        </button>
      )}
      {onCollapse && (
        <button
          type="button"
          onClick={onCollapse}
          aria-label="Hide analytics"
          title="Hide analytics"
          className={iconButton}
        >
          <PanelRightClose className="h-[18px] w-[18px]" aria-hidden />
        </button>
      )}
    </div>
  );

  const { listRef: tabsRef, geometry: tabGeometry } = useTabIndicator<HTMLDivElement>(channel.id);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header
        {...(chrome?.dropProps ?? {})}
        className={cx(
          "flex h-20 shrink-0 items-center pt-2",
          liftControls ? "hidden" : "compact:h-12 compact:pt-0",
        )}
      >
        <div className="mx-auto flex w-full min-w-0 max-w-[1400px] items-center gap-2 px-4 compact:px-3">
          <div data-testid="analytics-title" className="flex min-w-0 items-center gap-2 compact:hidden">
            <BarChart3 className="h-4 w-4 shrink-0 text-ink" aria-hidden />
            <h2 className={PANEL_HEADER_TITLE}>Analytics</h2>
          </div>
          <span className="flex-1" />
          {!liftControls && controls}
        </div>
      </header>
      {liftControls && <CompactHeaderActions>{controls}</CompactHeaderActions>}
      <div className="shrink-0 bg-cream compact:border-b compact:border-rule compact:pt-1.5">
        <div
          role="tablist"
          aria-label="Analytics section"
          ref={tabsRef}
          className="scrollbar-none relative mx-auto flex w-full min-w-0 max-w-[1400px] items-center gap-x-4 overflow-x-auto overscroll-x-contain px-4 compact:snap-x compact:px-3"
        >
          <TabIndicator geometry={tabGeometry} className="bottom-0" />
          {CHANNELS.map((c) => {
            const active = c.id === channel.id;
            const lock = lockOf(c.id);
            return (
              <button
                key={c.id}
                ref={active ? activeTabRef : undefined}
                type="button"
                role="tab"
                aria-selected={active}
                aria-label={lock ? `${c.label}, ${planBadgeLabel(lock)}` : undefined}
                onClick={() => selectChannel(c.id)}
                className={cx(
                  "-mb-px shrink-0 whitespace-nowrap border-b-2 pb-2 pt-2.5 text-[13px] font-medium transition-colors duration-100 motion-reduce:transition-none compact:snap-start",
                  "border-transparent",
                  active ? "text-ink" : "text-inkMuted hover:text-ink",
                  FOCUS_RING,
                )}
              >
                {c.label}
                {lock && <Lock className="ml-1 inline h-3 w-3 align-[-1px]" aria-hidden />}
              </button>
            );
          })}
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {locks === null && <AnalyticsSkeleton />}
        <ProPlanGate lockedTier={channelLock} feature={`${channel.label} analytics`}>
          {CHANNELS.filter((c) => visitedRef.current.has(c.id) && open(c.id)).map((c) => (
            <div
              key={c.id}
              aria-hidden={c.id !== channel.id}
              className={c.id === channel.id ? "ws-scroll h-full overflow-y-auto animate-tab-swap motion-reduce:animate-none" : "hidden"}
            >
              {c.render({
                range,
                onRangeChange: setRange,
                refreshTick,
                active: c.id === channel.id,
                onRefreshingChange: (v) => setChannelRefreshing(c.id, v),
              })}
            </div>
          ))}
        </ProPlanGate>
      </div>
    </div>
  );
}
