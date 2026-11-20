"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { useWorkspace } from "./WorkspaceShell";
import type { TabDescriptor } from "@/lib/workspace/types";
import { AgentTab } from "./AgentTab";
import { HomeTab } from "./HomeTab";
import { BrainTab } from "./BrainTab";
import { ToolkitTab } from "./layout/ToolkitTab";
import { SettingsTab } from "./SettingsTab";
import { AutopilotTab } from "./AutopilotTab";
import { NeedsYouTab } from "./NeedsYouTab";
import { CompetitorTab } from "./CompetitorTab";
import { WebsiteTab } from "./WebsiteTab";
import { DisputeDetailTab } from "./agent/DisputeDetailTab";
import { OnboardingView } from "./layout/OnboardingView";
import { View360 } from "./layout/View360";
import { ChannelsPanel } from "./layout/ChannelsPanel";
import { MeetTab } from "./layout/MeetTab";
import { MessagingTab } from "./MessagingTab";
import { CalendarTab } from "./CalendarTab";
import { ArtifactsTab } from "./artifacts/ArtifactsTab";
import { AgentPageTab } from "./AgentPageTab";
import { FundraisingDashboard } from "./agent/FundraisingDashboard";
import { MarketplaceDashboard } from "./agent/MarketplaceDashboard";
import { EngineerDashboard } from "./agent/EngineerDashboard";
import { AgentBuilderTab } from "./agentBuilder/AgentBuilderTab";
import { MemoryPageClient } from "@/components/memory/MemoryPageClient";
import type { WorkspaceMode } from "./ZaviWelcome";

type PaneOptions = {
  chatOnly?: boolean;
  home?: ReactNode;
  activeTabIdOverride?: string;
  homeAgentSlug?: string;
  workspaceMode?: WorkspaceMode;
};

export function WorkspacePane({
  chatOnly = false,
  home,
  homeAgentSlug,
  activeTabIdOverride,
  workspaceMode,
}: PaneOptions = {}) {
  const {
    tabs,
    activeTabId: workspaceActiveTabId,
    setActiveTab,
  } = useWorkspace();
  const activeTabId = activeTabIdOverride ?? workspaceActiveTabId;
  const tab = tabs.find((t) => t.id === activeTabId);

  const visitedRef = useRef<Set<string>>(new Set());
  if (tab) visitedRef.current.add(tab.id);
  const liveIds = new Set(tabs.map((t) => t.id));
  for (const id of Array.from(visitedRef.current)) {
    if (!liveIds.has(id)) visitedRef.current.delete(id);
  }

  useEffect(() => {
    if (!activeTabIdOverride && !tab && tabs.length > 0) {
      const target =
        tabs.find((t) => t.kind === "home") ??
        tabs.find((t) => t.kind === "agent") ??
        tabs[0];
      setActiveTab(target.id);
    }
  }, [activeTabIdOverride, tab, tabs, setActiveTab]);

  if (!tab) {
    return <EmptyState reason="no-active-tab" />;
  }

  const mounted = tabs.filter((t) => visitedRef.current.has(t.id));

  return (
    <div className="relative h-full min-h-0 overflow-hidden">
      {mounted.map((t) => {
        const isActive = t.id === activeTabId;
        return (
          <div
            key={t.id}
            data-tab-id={t.id}
            className={isActive ? "absolute inset-0 h-full min-h-0" : "hidden"}
            aria-hidden={!isActive}
          >
            <TabHost
              tab={t}
              isActive={isActive}
              chatOnly={chatOnly}
              home={home}
              homeAgentSlug={homeAgentSlug}
              workspaceMode={workspaceMode}
            />
          </div>
        );
      })}
    </div>
  );
}

function TabHost({
  tab,
  isActive,
  chatOnly,
  home,
  homeAgentSlug,
  workspaceMode,
}: {
  tab: TabDescriptor;
  isActive: boolean;
} & PaneOptions) {
  if (tab.kind === "home" && homeAgentSlug) {
    const p = tab.payload as { threadId?: string | null };
    return (
      <AgentTab
        slug={homeAgentSlug}
        tabId={tab.id}
        threadId={p.threadId ?? null}
        isActive={isActive}
        chatOnly={chatOnly}
        workspaceMode={workspaceMode}
      />
    );
  }
  if (tab.kind === "agent") {
    const p = tab.payload as { slug: string; threadId?: string | null };
    return (
      <AgentTab
        slug={p.slug}
        tabId={tab.id}
        threadId={p.threadId}
        isActive={isActive}
        chatOnly={chatOnly}
        workspaceMode={workspaceMode}
      />
    );
  }
  if (tab.kind === "dispute-detail") {
    return <DisputeDetailTab tab={tab} isActive={isActive} />;
  }
  return (
    <div className="h-full overflow-y-auto">
      <TabContent tab={tab} isActive={isActive} home={home} />
    </div>
  );
}

function TabContent({
  tab,
  isActive,
  home,
}: {
  tab: TabDescriptor;
  isActive: boolean;
  home?: ReactNode;
}) {
  const { treeAgents, userEmail, layout, closeTab, supplyDemandEligible, supplyDemandReachable } =
    useWorkspace();
  switch (tab.kind) {
    case "home":
      return home ?? <HomeTab userEmail={userEmail} treeAgents={treeAgents} />;
    case "agent":
      return null;
    case "run":
      return (
        <Stub
          title="Run detail"
          subtitle={`Run ${(tab.payload as { runId: string }).runId.slice(0, 8)}…`}
          phaseNote="Ships in Phase 3."
        />
      );
    case "brain":
      return layout === "legacy" ? <BrainTab /> : <ToolkitTab active={isActive} />;
    case "settings":
      return (
        <SettingsTab
          initialSection={
            (tab.payload as { section?: string } | undefined)?.section as
              | NonNullable<Parameters<typeof SettingsTab>[0]>["initialSection"]
              | undefined
          }
          sectionRequestedAt={(tab.payload as { requestedAt?: number } | undefined)?.requestedAt}
        />
      );
    case "members":
      return <SettingsTab initialSection="team" />;
    case "autopilot":
      return (
        <AutopilotTab
          tabId={tab.id}
          isActive={isActive}
          focusDecisionId={(tab.payload as { decision?: string }).decision}
        />
      );
    case "needs-you":
      return (
        <NeedsYouTab
          isActive={isActive}
          focusDecisionId={(tab.payload as { decision?: string }).decision}
        />
      );
    case "competitor":
      return <CompetitorTab />;
    case "website":
      return <WebsiteTab />;
    case "onboarding":
      return <OnboardingView />;
    case "analytics":
      return (
        <div className="h-full min-h-0 overflow-hidden">
          <View360 active={isActive} />
        </div>
      );
    case "channels":
      return (
        <div className="h-full min-h-0 overflow-hidden">
          <ChannelsPanel collapsed={false} onToggle={() => {}} variant="page" />
        </div>
      );
    case "messaging":
      return <MessagingTab />;
    case "meet":
      return <MeetTab />;
    case "memory":
      return (
        <div className="px-6 py-6">
          <div className="mx-auto w-full max-w-3xl">
            {isActive ? <MemoryPageClient /> : null}
          </div>
        </div>
      );
    case "calendar":
      return <CalendarTab />;
    case "artifacts":
      return <ArtifactsTab />;
    case "fundraising":
      return (
        <AgentPageTab
          slug="fundraising"
          Dashboard={FundraisingDashboard}
          tabId={tab.id}
          isActive={isActive}
        />
      );
    case "supply-demand":
      if (!supplyDemandEligible && !supplyDemandReachable) {
        return (
          <div className="flex h-full items-center justify-center px-6 py-12 text-center">
            <div className="max-w-sm">
              <div className="font-display text-[16px] text-ink">
                Supply & Demand is for marketplaces
              </div>
              <div className="mt-1 text-[13px] text-inkMuted">
                It shows orders and supply by location for two-sided marketplaces.
              </div>
            </div>
          </div>
        );
      }
      return (
        <AgentPageTab
          slug="supply-demand-balancer"
          Dashboard={MarketplaceDashboard}
          tabId={tab.id}
          isActive={isActive}
        />
      );
    case "engineer":
      return (
        <AgentPageTab
          slug="engineer"
          Dashboard={EngineerDashboard}
          tabId={tab.id}
          isActive={isActive}
        />
      );
    case "agent-builder":
      return (
        <AgentBuilderTab
          agentId={(tab.payload as { agentId?: string | null }).agentId ?? null}
          runId={(tab.payload as { runId?: string | null }).runId ?? null}
        />
      );
    case "dispute-detail":
      return null;
    case "build":
      return null;
    default:
      return <EmptyState reason="unknown-tab-kind" />;
  }
}

function Stub({
  title,
  subtitle,
  phaseNote,
}: {
  title: string;
  subtitle: string;
  phaseNote: string;
}) {
  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="font-display text-[22px] font-semibold text-ink">
        {title}
      </h1>
      <p className="mt-2 text-[16px] text-inkMuted">{subtitle}</p>
      <p className="mt-6 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
        {phaseNote}
      </p>
    </div>
  );
}

function EmptyState({ reason }: { reason: string }) {
  return (
    <div className="flex h-full items-center justify-center px-6 py-12 text-center">
      <div>
        <div className="font-display text-[16px] text-ink">Nothing here.</div>
        <div className="mt-1 text-[12px] text-inkMuted">
          ({reason}) Open an agent from the Explorer.
        </div>
      </div>
    </div>
  );
}
