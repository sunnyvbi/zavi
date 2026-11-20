"use client";

import type { ComponentType } from "react";
import { getAgentMeta } from "@/lib/agentRegistry";
import { PerformanceMarketerDashboard } from "./PerformanceMarketerDashboard";
import { AdvisorDashboard } from "./AdvisorDashboard";
import { BrowserOperatorDashboard } from "./BrowserOperatorDashboard";
import { ChiefOfStaffDashboard } from "./ChiefOfStaffDashboard";
import { ContentDesignDashboard } from "./ContentDesignDashboard";
import { DisputeResponseDashboard } from "./DisputeResponseDashboard";
import { EngineerDashboard } from "./EngineerDashboard";
import { FundraisingDashboard } from "./FundraisingDashboard";
import { GrowthLeadDashboard } from "./GrowthLeadDashboard";
import { MarketplaceDashboard } from "./MarketplaceDashboard";
import { OperatorDashboard } from "./OperatorDashboard";
import { OutboundSdrDashboard } from "./OutboundSdrDashboard";
import { PmDashboard } from "./PmDashboard";
import { QaDashboard } from "./QaDashboard";
import { ResearchDashboard } from "./ResearchDashboard";
import { RedditOrganicDashboard } from "./RedditOrganicDashboard";
import { SeoGeoDashboard } from "./SeoGeoDashboard";
import { SupportLeadDashboard } from "./SupportLeadDashboard";
import { XAgentDashboard } from "./XAgentDashboard";

const DASHBOARDS: Record<string, ComponentType> = {
  "performance-marketer": PerformanceMarketerDashboard,
  advisor: AdvisorDashboard,
  "browser-operator": BrowserOperatorDashboard,
  "chief-of-staff": ChiefOfStaffDashboard,
  "content-design": ContentDesignDashboard,
  "content-seo": ContentDesignDashboard,
  "dispute-response": DisputeResponseDashboard,
  engineer: EngineerDashboard,
  fundraising: FundraisingDashboard,
  "growth-lead": GrowthLeadDashboard,
  "marketplace-intelligence": MarketplaceDashboard,
  "supply-demand-balancer": MarketplaceDashboard,
  operator: OperatorDashboard,
  "outbound-sdr": OutboundSdrDashboard,
  pm: PmDashboard,
  qa: QaDashboard,
  research: ResearchDashboard,
  reddit_organic: RedditOrganicDashboard,
  "seo-geo": SeoGeoDashboard,
  "support-lead": SupportLeadDashboard,
  x_organic: XAgentDashboard,
};

export function AgentDashboard({ slug }: { slug: string }) {
  const Dashboard = DASHBOARDS[slug];
  if (Dashboard) return <Dashboard />;
  return <GenericDashboard slug={slug} />;
}

function GenericDashboard({ slug }: { slug: string }) {
  const meta = getAgentMeta(slug);
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-[16px] font-semibold text-[#0e0f11]">
          {meta.name} · area overview
        </h2>
        <p className="text-[12px] text-[#595959]">{meta.subtitle}</p>
      </div>

      <div className="rounded-xl border border-dashed border-[#d8d2c4] bg-white px-6 py-8 text-center">
        <div className="text-[16px] font-semibold text-[#1f1f1f]">
          No activity yet
        </div>
        <p className="mx-auto mt-1 max-w-md text-[12px] text-[#595959]">
          This agent runs when you direct it. Use the chat on the right to give
          it a task. Its runs and results will show up in the Run tab.
        </p>
      </div>
    </div>
  );
}
