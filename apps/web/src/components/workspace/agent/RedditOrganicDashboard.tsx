"use client";

import { useEffect, useState } from "react";
import { SlidingIndicator, useSlidingIndicator } from "@/components/ui/SlidingIndicator";
import {
  DashboardShell,
  EmptyState,
  useAgentDashboard,
  useExternalRefresh,
  useRefreshingSignal,
} from "./dashboard-ui";
import { RedditAnalyticsTab } from "./reddit/AnalyticsTab";
import { OverviewTab, ScanControl, useScan } from "./reddit/OverviewTab";
import {
  StrategyTab,
  strategyDefaultSubs,
  strategyVisibleOpportunities,
} from "./reddit/StrategyTab";
import { KeywordsTab } from "./reddit/KeywordsTab";
import type { RedditPayload } from "./reddit/shared";
import { normSub } from "./reddit/ui";

export type { RedditPayload } from "./reddit/shared";

type Tab = "overview" | "strategy" | "keywords";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "strategy", label: "Comment & post strategy" },
  { id: "keywords", label: "Keywords & competitors" },
];

export function RedditOrganicDashboard() {
  const state = useAgentDashboard<RedditPayload>("reddit_organic", {
    getRowIds: (data) => [
      ...data.suggestions.map((s) => s.id),
      ...(data.supporting_steps ?? []).map((s) => s.id),
    ],
  });
  return (
    <DashboardShell<RedditPayload>
      state={state}
      genericFallback={
        <EmptyState title="No Reddit suggestions yet">
          Have Zavi research a topic and draft your first post.
        </EmptyState>
      }
      render={(data) =>
        data.workspace_v2 === false ? null : (
          <RedditOrganicBody
            data={data}
            onChanged={state.refreshSilent ?? state.refresh}
          />
        )
      }
    />
  );
}

export function RedditAnalyticsDashboard({
  refreshTick,
  active,
  onRefreshingChange,
}: {
  refreshTick?: number;
  active?: boolean;
  onRefreshingChange?: (refreshing: boolean) => void;
} = {}) {
  const state = useAgentDashboard<RedditPayload>("reddit_organic");
  useExternalRefresh(state, refreshTick, active);
  useRefreshingSignal(state.refreshing, onRefreshingChange);
  return (
    <DashboardShell<RedditPayload>
      state={state}
      genericFallback={
        <EmptyState title="No Reddit numbers yet">
          Open the Reddit channel and run a scan; the numbers land here.
        </EmptyState>
      }
      render={(data) =>
        data.workspace_v2 === false ? null : (
          <RedditAnalyticsTab data={data} onChanged={state.refreshSilent ?? state.refresh} />
        )
      }
    />
  );
}

export function RedditOrganicBody({
  data,
  onChanged,
}: {
  data: RedditPayload;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<Tab>("overview");
  const [strategySubs, setStrategySubs] = useState<string[] | null>(null);
  const insights = data.insights ?? null;

  const scan = useScan(insights ?? null, onChanged);
  const sweepRunning = insights?.sweep.last?.status === "running";
  useEffect(() => {
    if (!sweepRunning) return;
    const id = setInterval(onChanged, 20_000);
    return () => clearInterval(id);
  }, [sweepRunning, onChanged]);

  const [arrival, setArrival] = useState(0);
  const openStrategy = (subreddit?: string) => {
    setStrategySubs(subreddit ? [normSub(subreddit)] : null);
    setTab("strategy");
    setArrival((n) => n + 1);
  };
  const [competitorsArrival, setCompetitorsArrival] = useState(0);
  const openCompetitors = () => {
    setTab("keywords");
    setCompetitorsArrival((n) => n + 1);
  };
  const [suggestedArrival, setSuggestedArrival] = useState(0);
  const openSuggested = () => {
    setTab("keywords");
    setSuggestedArrival((n) => n + 1);
  };

  const strategyCount = Math.min(
    5,
    insights?.has_data
      ? strategyVisibleOpportunities(
          data,
          strategySubs ?? strategyDefaultSubs(data),
        ).length
      : data.suggestions.filter((s) => s.type === "reddit_reply").length,
  );
  const { listRef, box } = useSlidingIndicator<HTMLDivElement>(tab);

  return (
    <div className="space-y-[18px]">
      <div className="flex items-center border-b border-rule">
        <div
          ref={listRef}
          role="tablist"
          aria-label="Reddit agent"
          className="relative flex min-w-0 flex-1 gap-1 overflow-x-auto"
        >
          <SlidingIndicator box={box} className="border-b-2 border-ink" />
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`reddit-tab-${t.id}`}
              aria-controls="reddit-tabpanel"
              aria-selected={tab === t.id}
              onClick={() => {
                setTab(t.id);
                setArrival(0);
                setCompetitorsArrival(0);
                setSuggestedArrival(0);
              }}
              className={`relative -mb-px inline-flex shrink-0 items-center gap-2 border-b-2 border-transparent px-3.5 py-4 text-[16px] font-semibold leading-none transition-colors duration-300 ${
                tab === t.id ? "text-ink" : "text-inkMuted hover:text-ink"
              }`}
            >
              {t.label}
              {t.id === "strategy" && strategyCount > 0 && (
                <span
                  aria-hidden
                  title={`${strategyCount} comment ${strategyCount === 1 ? "opportunity" : "opportunities"}`}
                  className="mt-[3px] inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-ink px-1 text-[11px] font-bold leading-none text-cream"
                >
                  {strategyCount}
                </span>
              )}
            </button>
          ))}
        </div>
        {insights?.has_data && (
          <ScanControl insights={insights} running={scan.running} scan={scan.scan} />
        )}
      </div>

      {scan.error && (
        <p
          role="alert"
          className="rounded-xl border border-coral/40 bg-coral/5 px-4 py-3 text-[16px] text-ink"
        >
          {scan.error}
        </p>
      )}

      <div
        role="tabpanel"
        id="reddit-tabpanel"
        aria-labelledby={`reddit-tab-${tab}`}
      >
        {tab === "overview" && (
          <OverviewTab
            data={data}
            onChanged={onChanged}
            onOpenStrategy={openStrategy}
            onOpenKeywords={openSuggested}
            onOpenCompetitors={openCompetitors}
          />
        )}
        {tab === "strategy" && (
          <StrategyTab
            data={data}
            onChanged={onChanged}
            selectedSubs={strategySubs}
            onSelectSubs={setStrategySubs}
            arrival={arrival}
          />
        )}
        {tab === "keywords" && (
          <KeywordsTab
            data={data}
            onChanged={onChanged}
            competitorsArrival={competitorsArrival}
            suggestedArrival={suggestedArrival}
          />
        )}
      </div>
    </div>
  );
}
