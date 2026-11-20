"use client";

import type React from "react";
import { SkeletonBars, type SkeletonBar } from "@/components/ui/SettledSection";

const HEADLINE: SkeletonBar[] = [
  { w: "w-3/4", h: "h-7", mt: "mt-5" },
  { w: "w-1/2", h: "h-4", mt: "mt-3.5" },
  { w: "w-32", h: "h-9", mt: "mt-5", className: "rounded-lg" },
];
const GOALS: SkeletonBar[] = [
  { w: "w-48", h: "h-4" },
  { w: "w-2/3", h: "h-7", mt: "mt-5" },
  { w: "w-28", h: "h-3", mt: "mt-2.5" },
  { w: "w-full", h: "h-5", mt: "mt-6" },
  { w: "w-full", h: "h-5" },
];
const BLOCKER: SkeletonBar[] = [
  { w: "w-44", h: "h-4" },
  { w: "w-full", h: "h-6", mt: "mt-5" },
  { w: "w-2/3", h: "h-6" },
  { w: "w-24", h: "h-4", mt: "mt-4" },
];
const CHANNELS: SkeletonBar[] = [
  { w: "w-56", h: "h-4" },
  { w: "w-full", h: "h-10", mt: "mt-5" },
  { w: "w-full", h: "h-10" },
  { w: "w-full", h: "h-10" },
];
const COMPANY: SkeletonBar[] = [
  { w: "w-3/4", h: "h-5", mt: "mt-3" },
  { w: "w-1/2", h: "h-4", mt: "mt-6" },
];
const DATA: SkeletonBar[] = [
  { w: "w-2/3", h: "h-5", mt: "mt-3" },
  { w: "w-1/3", h: "h-4" },
];
const VOICE: SkeletonBar[] = [
  { w: "w-3/4", h: "h-5", mt: "mt-3" },
  { w: "w-1/2", h: "h-4" },
];

export const HeadlineBars = ({ ariaLabel }: { ariaLabel?: string }) => (
  <SkeletonBars ariaLabel={ariaLabel} bars={HEADLINE} />
);
export const GoalsBars = ({ ariaLabel }: { ariaLabel?: string }) => (
  <SkeletonBars ariaLabel={ariaLabel} minHeight={200} bars={GOALS} />
);
export const BlockerBars = ({ ariaLabel }: { ariaLabel?: string }) => (
  <SkeletonBars ariaLabel={ariaLabel} minHeight={120} bars={BLOCKER} />
);
export const ChannelsBars = ({ ariaLabel }: { ariaLabel?: string }) => (
  <SkeletonBars ariaLabel={ariaLabel} minHeight={180} bars={CHANNELS} />
);
export const CompanyBars = ({ ariaLabel }: { ariaLabel?: string }) => (
  <SkeletonBars ariaLabel={ariaLabel} minHeight={96} bars={COMPANY} onDeep />
);
export const DataBars = ({ ariaLabel }: { ariaLabel?: string }) => (
  <SkeletonBars ariaLabel={ariaLabel} minHeight={64} bars={DATA} onDeep />
);
export const VoiceBars = ({ ariaLabel }: { ariaLabel?: string }) => (
  <SkeletonBars ariaLabel={ariaLabel} minHeight={72} bars={VOICE} onDeep />
);

const STEP_NODE = "absolute left-0 top-0 h-8 w-8 rounded-full bg-creamDeep compact:h-7 compact:w-7";

function StepBars({ last = false, children }: { last?: boolean; children: React.ReactNode }) {
  return (
    <div data-skeleton-step className="relative pl-12 compact:pl-10">
      {!last && <span aria-hidden="true" className="absolute bottom-[-24px] left-[15px] top-[34px] w-0.5 bg-rule compact:left-[13px]" />}
      <span aria-hidden="true" className={STEP_NODE} />
      <SkeletonBars bars={[{ w: "w-40", h: "h-5", mt: "mt-1.5" }]} />
      <div className="mt-3 rounded-2xl border border-rule px-4 py-3">{children}</div>
    </div>
  );
}

export function GrowthMemoSkeleton() {
  return (
    <div role="status" aria-label="Loading growth plan" className="mx-auto max-w-[720px] pb-8 compact:pb-6">
      <div className="mt-2">
        {}
        <SkeletonBars bars={[{ w: "w-56", h: "h-4" }, { w: "w-3/4", h: "h-7", mt: "mt-3" }, { w: "w-1/3", h: "h-4", mt: "mt-2.5" }]} />
      </div>
      <div className="mt-7 space-y-6">
        <StepBars>
          <SkeletonBars bars={GOALS.slice(1)} />
        </StepBars>
        <StepBars>
          <SkeletonBars bars={BLOCKER.slice(1)} />
        </StepBars>
        <StepBars>
          <SkeletonBars bars={CHANNELS.slice(1)} />
        </StepBars>
        <StepBars>
          <SkeletonBars bars={[{ w: "w-full", h: "h-5" }, { w: "w-full", h: "h-5" }, { w: "w-2/3", h: "h-5" }]} />
        </StepBars>
        <StepBars last>
          <SkeletonBars bars={[{ w: "w-full", h: "h-10" }, { w: "w-2/3", h: "h-10" }]} />
        </StepBars>
      </div>
    </div>
  );
}
