"use client";

import { useState } from "react";
import { Markdown } from "@/components/workspace/Markdown";

export function PlanReviewCard({
  markdown,
  draft,
  onDraftChange,
  approveLabel,
  approveDisabled,
  onApprove,
  onDiscard,
  className = "mt-3",
}: {
  markdown: string;
  draft: string;
  onDraftChange: (value: string) => void;
  approveLabel: string;
  approveDisabled: boolean;
  onApprove: () => void;
  onDiscard: () => void;
  className?: string;
}) {
  const [showPreview, setShowPreview] = useState(false);
  return (
    <div
      data-testid="plan-review"
      className={`${className} flex flex-col rounded-2xl border border-[#efe2c3] bg-white p-4 pt-0 shadow-[0_1px_2px_rgba(43,36,22,0.06)] lg:max-h-[min(60vh,350px)]`}
    >
      <div aria-hidden className="-mx-4 mb-3 h-1.5 rounded-t-2xl bg-[#e8c46a] lg:shrink-0" />
      <div className="-mx-4 -mt-3 mb-2 flex items-center justify-between gap-2 bg-[#fbf6ea] px-4 py-2 lg:shrink-0">
        <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#8a5a10]">Proposed plan</span>
        <div className="flex items-center gap-2">
          <span className="hidden text-[11px] text-inkSoft sm:inline">Edit anything, then approve</span>
          <button
            type="button"
            onClick={() => setShowPreview((v) => !v)}
            className="rounded-full border border-ink/15 bg-white px-2.5 py-1 text-[12px] font-medium text-ink transition-colors hover:bg-[#f2f2f2]"
          >
            {showPreview ? "Edit" : "Preview"}
          </button>
        </div>
      </div>
      {}
      <div
        className={
          showPreview
            ? "min-h-0 max-h-[55vh] overflow-y-auto lg:max-h-none lg:flex-1"
            : "min-h-0 lg:max-h-none lg:flex-1 lg:overflow-y-auto"
        }
      >
        {showPreview ? (
          <div className="min-h-[200px] rounded-lg border border-ink/10 bg-white p-3 text-base leading-[1.6] text-ink lg:min-h-[160px]">
            {}
            <Markdown source={draft || markdown} disableActionLinks />
          </div>
        ) : (
          <textarea
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            rows={10}
            aria-label="Edit the proposed plan before building"
            className="block min-h-[200px] w-full max-w-full resize rounded-lg border border-ink/15 bg-white px-3 py-2 font-mono text-[13px] leading-[1.6] text-ink outline-none transition-colors focus:border-ink/40 lg:min-h-[160px]"
          />
        )}
      </div>
      <div className="mt-3 flex items-center gap-2 lg:shrink-0">
        <button
          type="button"
          onClick={onApprove}
          disabled={approveDisabled || draft.trim().length === 0}
          className="rounded-xl bg-[#0f1729] px-4 py-2 text-[13px] font-bold text-white transition-colors hover:bg-[#1c2740] disabled:opacity-60"
        >
          {approveLabel}
        </button>
        <button
          type="button"
          onClick={onDiscard}
          className="rounded-xl px-3 py-2 text-[13px] font-semibold text-[#7a6a4a] transition-colors hover:text-[#b3261e]"
        >
          Discard
        </button>
      </div>
    </div>
  );
}
