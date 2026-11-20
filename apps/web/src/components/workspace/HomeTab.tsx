"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspace } from "./WorkspaceShell";
import { BrainSetupCard } from "./GettingStartedCard";
import { BuilderChatCard } from "./home/BuilderChatCard";
import { CompanyBriefCard } from "./home/CompanyBriefCard";
import { AgentInventoryCard } from "./home/AgentInventoryCard";
import { StackInventoryCard } from "./home/StackInventoryCard";
import { SpendCard } from "./home/SpendCard";
import { SuggestedNextCard } from "./home/SuggestedNextCard";
import { KpiStrip } from "./home/KpiStrip";
import { HomeSkeleton } from "./home/HomeSkeleton";
import { ActivityDigestCard } from "./home/ActivityDigestCard";
import { EMPTY_SUMMARY } from "./home/summary";
import { loadSummary } from "./home/summaryState";
import type { HomeSummaryPayload, ActiveRunRow } from "./home/types";
import { isHomeExecCalmEnabled } from "@/lib/workspace/homeExecCalmFlag";
import { CalmHome } from "./home/calm/CalmHome";

type HomeTabProps = {
  userEmail?: string;
  treeAgents: Array<{ slug: string; latest_run_status: string | null }>;
  variant?: "classic";
};

export function HomeTab(props: HomeTabProps) {
  if (props.variant !== "classic" && isHomeExecCalmEnabled()) return <CalmHome />;
  return <ClassicHomeTab {...props} />;
}

function ClassicHomeTab({ treeAgents }: HomeTabProps) {
  const { creditsRemaining, creditsAllowance, creditsEnforced } = useWorkspace();
  const [summary, setSummary] = useState<HomeSummaryPayload>(EMPTY_SUMMARY);
  const [loaded, setLoaded] = useState(false);
  const [noTenant, setNoTenant] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const runIdRef = useRef(0);

  const runLoad = useCallback(async () => {
    const myRun = ++runIdRef.current;
    const stale = () => runIdRef.current !== myRun;
    setLoadError(false);
    setLoaded(false);

    try {
      const result = await loadSummary();
      if (stale()) return;
      if (result.status === "no_tenant") {
        setNoTenant(true);
        setLoaded(true);
        window.location.assign("/start");
        return;
      }
      if (result.status === "ok") {
        setSummary(result.summary);
        setLoadError(false);
        setLoaded(true);
        return;
      }
      setLoadError(true);
      setLoaded(true);
    } catch {
      if (!stale()) {
        setLoadError(true);
        setLoaded(true);
      }
    }
  }, []);

  useEffect(() => {
    void runLoad();
    return () => {
      runIdRef.current++;
    };
  }, [runLoad]);

  const retry = useCallback(() => {
    void runLoad();
  }, [runLoad]);

  if (noTenant) {
    return (
      <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center gap-4 px-6 py-12 text-center">
        <h2 className="font-display text-[20px] font-semibold text-ink">
          Let&apos;s set up your workspace
        </h2>
        <p className="max-w-md text-[16px] leading-[1.55] text-inkMuted">
          Taking you to{" "}
          <a href="/start" className="text-ink underline">
            setup
          </a>
          .
        </p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center gap-4 px-6 py-12 text-center">
        <h2 className="font-display text-[20px] font-semibold text-ink">
          Couldn&apos;t load your workspace
        </h2>
        <p className="max-w-md text-[16px] leading-[1.55] text-inkMuted">
          We hit a snag loading your Home summary. Your workspace is fine. This
          is usually temporary.
        </p>
        <button
          type="button"
          onClick={retry}
          className="rounded-cta bg-ink px-4 py-2 text-[16px] font-medium text-white transition-colors hover:bg-ink/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!loaded) {
    return <HomeSkeleton />;
  }

  return (
    <div className="mx-auto max-w-7xl px-6 pt-8 pb-10 md:px-8">
      {}
      <KpiStrip
        activeRunsToday={summary.active_runs_today}
        pendingApprovals={summary.pending_approvals_count}
        spendTotalUsd={summary.spend_total_usd}
        creditsRemaining={creditsRemaining}
        creditsAllowance={creditsAllowance}
        creditsEnforced={creditsEnforced}
      />

      {}
      <div className="mt-5">
        <BrainSetupCard />
      </div>

      {}
      {}
      <div id="workspace-build" className="mb-5">
        <BuilderChatCard />
      </div>

      {}
      <div className="mb-5 grid grid-cols-1 gap-4">
        <CompanyBriefCard companyMd={summary.company_md_ref} />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <StackInventoryCard />
          <AgentInventoryCard agents={treeAgents} />
        </div>
      </div>

      {}
      <div className="mb-5">
        <ActivityDigestCard rows={summary.recent_activity} />
      </div>

      {}
      <div
        className={`grid grid-cols-1 gap-4 ${
          creditsEnforced ? "" : "md:grid-cols-2"
        }`}
      >
        {!creditsEnforced && (
          <SpendCard
            totalUsd={summary.spend_total_usd}
            buckets={summary.spend_week}
          />
        )}
        <SuggestedNextCard rows={summary.suggested_next} />
      </div>
    </div>
  );
}

export { useWorkspace as __useWorkspace };
export type { ActiveRunRow };
