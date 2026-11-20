"use client";

import { Compass } from "lucide-react";

export function GrowthStrategyEmpty() {
  return (
    <section aria-label="Growth strategy">
      <div className="rounded-xl border border-dashed border-[#d8d8d8] bg-white p-6">
        <div className="flex items-center gap-2">
          <Compass className="h-4 w-4 text-[#8a8a8a]" aria-hidden />
          <h2 className="font-display text-[16px] font-semibold text-[#1f1f1f]">
            No growth strategy yet
          </h2>
        </div>
        <p className="mt-2 max-w-[56ch] text-[13px] leading-[20px] text-[#595959]">
          Zavi reads your funnel, your connected data and what we
          already know about the company, then drafts one for you to correct: the one
          metric to own, the constraint actually holding growth back, and the two or
          three channels worth betting on.
        </p>
        <p className="mt-3 text-[12px] text-[#8a8a8a]">
          Start the conversation on the right. It&rsquo;ll appear here.
        </p>
      </div>
    </section>
  );
}
