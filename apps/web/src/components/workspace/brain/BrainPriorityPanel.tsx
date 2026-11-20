"use client";

import type { PriorityItem, PriorityKind } from "./useBrainPriority";
import { NextChevron } from "@/components/ui/NextChevron";

const KIND_META: Record<
  PriorityKind,
  { icon: string; label: string; accent: string }
> = {
  conflict: { icon: "⚠", label: "Conflict", accent: "bg-coral/10 text-coral" },
  pending_decision: { icon: "✋", label: "Approval", accent: "bg-violet/10 text-violetDeep" },
  agent_feedback: { icon: "💬", label: "Feedback", accent: "bg-marigold/15 text-marigoldDeep" },
  stale_anchor: { icon: "⏰", label: "Stale", accent: "bg-bone text-inkSoft" },
  untyped_pile: { icon: "📥", label: "Pile", accent: "bg-mint/30 text-mintDeep" },
};

export function BrainPriorityPanel({
  items,
  loading,
  hoveredRank,
  onHoverRankChange,
  onItemClick,
}: {
  items: PriorityItem[];
  loading: boolean;
  hoveredRank: number | null;
  onHoverRankChange: (rank: number | null) => void;
  onItemClick: (item: PriorityItem) => void;
}) {
  const slots = 5;
  return (
    <aside className="flex h-full min-h-[420px] flex-col rounded-2xl border border-ink/15 bg-white/60 p-3 shadow-sm">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="font-display text-[16px] font-semibold tracking-tight text-ink">
          Top 5 to review
        </h3>
        <span className="font-mono text-[11px] uppercase tracking-wide text-inkMuted">
          {items.length}/{slots} active
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-2 overflow-y-auto pr-1">
        {loading && (
          <>
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="h-20 animate-pulse rounded-lg bg-bone/50" />
            ))}
          </>
        )}
        {!loading && items.length === 0 && (
          <div className="rounded-lg border border-dashed border-ink/15 px-3 py-6 text-center text-[12px] text-inkMuted">
            All clear. No conflicts, pending approvals, or stale anchors.
            <br />
            Your brain is healthy.
          </div>
        )}
        {!loading &&
          items.map((it) => {
            const meta = KIND_META[it.kind];
            const isHovered = hoveredRank === it.rank;
            return (
              <button
                key={`${it.kind}:${it.refId}`}
                type="button"
                onMouseEnter={() => onHoverRankChange(it.rank)}
                onMouseLeave={() => onHoverRankChange(null)}
                onClick={() => onItemClick(it)}
                className={`group flex w-full items-start gap-2.5 rounded-cta border bg-white px-3 py-2.5 text-left transition-all ${
                  isHovered
                    ? "border-coral shadow-[0_0_0_3px_rgba(255,107,107,0.18)]"
                    : "border-ink/12 hover:border-ink/30"
                }`}
              >
                <div className="flex flex-col items-center gap-1 pt-0.5">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-coral text-[11px] font-bold text-white">
                    {it.rank}
                  </span>
                  <span
                    className={`flex h-5 w-5 items-center justify-center rounded text-[12px] ${meta.accent}`}
                    title={meta.label}
                  >
                    {meta.icon}
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="mb-0.5 flex items-baseline gap-2">
                    <span className="font-mono text-[9.5px] uppercase tracking-wide text-inkMuted">
                      {meta.label}
                      {it.anchorSlug ? ` · ${it.anchorSlug}` : ""}
                    </span>
                  </div>
                  <div className="line-clamp-2 text-[13px] font-medium leading-[1.3] text-ink">
                    {it.title}
                  </div>
                  <div className="mt-0.5 line-clamp-2 text-[12px] leading-[1.35] text-inkMuted">
                    {it.reason}
                  </div>
                  <div className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-violetDeep group-hover:underline">
                    {it.actionLabel}
                    <NextChevron />
                  </div>
                </div>
              </button>
            );
          })}
      </div>
    </aside>
  );
}
