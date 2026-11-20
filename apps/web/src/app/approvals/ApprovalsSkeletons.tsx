"use client";

import { Skeleton } from "@/components/workspace/Skeleton";

function DecisionCardSkeleton() {
  return (
    <div className="rounded-xl border border-ink/[0.08] bg-white p-4 shadow-[0_1px_2px_rgba(25,25,25,0.04),0_6px_18px_rgba(25,25,25,0.05)]">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-3 w-40" />
        </div>
        <div className="flex shrink-0 gap-2">
          <Skeleton className="h-8 w-16" rounded="rounded-lg" />
          <Skeleton className="h-8 w-20" rounded="rounded-lg" />
        </div>
      </div>
      <Skeleton className="h-16 w-full" rounded="rounded-md" />
    </div>
  );
}

export function PendingQueueSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading pending decisions…" className="space-y-3">
      {}
      <div className="mb-2 flex items-center justify-between gap-2">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-6 w-20" rounded="rounded-lg" />
      </div>
      <DecisionCardSkeleton />
      <DecisionCardSkeleton />
    </div>
  );
}

export function HistorySkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading history…">
      <div className="space-y-2">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="rounded-xl border border-ink/[0.08] bg-white p-3.5 shadow-[0_1px_2px_rgba(25,25,25,0.04),0_6px_18px_rgba(25,25,25,0.05)]"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex items-center gap-2">
                  <Skeleton className="h-3.5 w-40" />
                  <Skeleton className="h-4 w-20" rounded="rounded-full" />
                </div>
                <Skeleton className="h-3 w-28" />
                <Skeleton className="h-3 w-24" />
              </div>
              <Skeleton className="h-4 w-16 shrink-0" rounded="rounded-full" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function AutonomySkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading decision classes…">
      <div className="overflow-hidden rounded-xl border border-ink/[0.08] bg-white shadow-[0_1px_2px_rgba(25,25,25,0.04),0_6px_18px_rgba(25,25,25,0.05)] divide-y divide-[#ece8e0]">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="grid grid-cols-1 items-center gap-3 px-4 py-3 lg:grid-cols-[1.4fr_1fr]"
          >
            <div className="space-y-2">
              <Skeleton className="h-3.5 w-40" />
              <Skeleton className="h-3 w-full max-w-md" />
              <Skeleton className="h-3 w-32" />
            </div>
            <div className="flex justify-start lg:justify-end">
              <Skeleton className="h-8 w-56" rounded="rounded-lg" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
