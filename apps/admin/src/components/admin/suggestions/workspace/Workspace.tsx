"use client";

import { useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AnalyticsTab } from "./AnalyticsTab";
import { ChannelsTab } from "./ChannelsTab";
import { CompanyTab } from "./CompanyTab";
import { CompetitorTab } from "./CompetitorTab";
import { FunnelTab } from "./FunnelTab";
import { GoalTab } from "./GoalTab";
import { Empty } from "../ui";
import { useClientContext, type ContextSectionKey, type SectionStates } from "./useClientContext";
import { WORKSPACE_TABS, type WorkspaceTab } from "./types";

const TAB_SECTIONS: Record<WorkspaceTab, ContextSectionKey[]> = {
  company: ["company"],
  goal: ["goals"],
  channels: ["channels"],
  analytics: ["analytics"],
  funnel: [],
  competitor: ["competitors", "company"],
};

export function Workspace({
  tenantId,
  onPrefill,
}: {
  tenantId: string;
  onPrefill: (text: string) => void;
}) {
  const [tab, setTab] = useState<WorkspaceTab>("company");
  const { sections, ensure, reload } = useClientContext(tenantId);
  const keys = TAB_SECTIONS[tab];

  useEffect(() => {
    if (tenantId) void ensure(keys);
  }, [tenantId, keys, ensure]);

  const states = keys.map((key) => sections[key]);
  const ready = states.every((state) => state.data);
  const failed = states.find((state) => state.error);

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-muted/30">
      <Tabs value={tab} onValueChange={(next) => setTab(next as WorkspaceTab)}>
        <TabsList className="h-12 w-full justify-start rounded-none border-b bg-card px-4">
          {WORKSPACE_TABS.map((item) => (
            <TabsTrigger key={item.id} value={item.id} disabled={!tenantId}>
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain px-6 py-6">
        {!tenantId ? (
          <Empty title="Pick a client" detail="Choose a client on the left to open their workspace." />
        ) : failed && !ready ? (
          <Empty
            title="Could not load this tab"
            detail={failed.error}
            action={
              <Button variant="outline" size="sm" onClick={() => void reload(keys)}>
                <RefreshCw className="size-4" />
                Try again
              </Button>
            }
          />
        ) : !ready ? (
          <div className="grid h-full place-items-center" aria-busy="true" aria-live="polite">
            <div className="flex flex-col items-center gap-3 text-muted-foreground">
              <Loader2 className="size-6 animate-spin" />
              <p className="text-sm">Loading {WORKSPACE_TABS.find((item) => item.id === tab)?.label.toLowerCase()}…</p>
            </div>
          </div>
        ) : (
          <TabBody
            tab={tab}
            tenantId={tenantId}
            sections={sections}
            onPrefill={onPrefill}
            onRefresh={() => void reload(keys)}
          />
        )}
      </div>
    </section>
  );
}

function TabBody({
  tab,
  tenantId,
  sections,
  onPrefill,
  onRefresh,
}: {
  tab: WorkspaceTab;
  tenantId: string;
  sections: SectionStates;
  onPrefill: (text: string) => void;
  onRefresh: () => void;
}) {
  switch (tab) {
    case "company":
      return <CompanyTab section={sections.company.data!} tenantId={tenantId} onRefresh={onRefresh} />;
    case "goal":
      return <GoalTab section={sections.goals.data!} />;
    case "channels":
      return <ChannelsTab section={sections.channels.data!} />;
    case "analytics":
      return <AnalyticsTab section={sections.analytics.data!} onPrefill={onPrefill} />;
    case "competitor":
      return (
        <CompetitorTab
          section={sections.competitors.data!}
          tenantId={tenantId}
          subject={sections.company.data!.data.name}
          onPrefill={onPrefill}
          onAdded={onRefresh}
        />
      );
    default:
      return <FunnelTab />;
  }
}
