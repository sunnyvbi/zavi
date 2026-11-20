"use client";

import { Skeleton } from "../Skeleton";

export function BrainListSkeleton({
  count = 4,
  lines = 2,
  label = "Loading…",
}: {
  count?: number;
  lines?: number;
  label?: string;
}) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className="space-y-1.5">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="rounded-xl border border-ink/[0.08] bg-white px-3 py-2.5 shadow-[0_1px_2px_rgba(25,25,25,0.04)]"
        >
          <div className="flex items-start gap-3">
            <Skeleton className="h-4 w-14 shrink-0" rounded="rounded" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <Skeleton className="h-3.5 w-1/2" />
              {lines > 1 && <Skeleton className="h-3 w-3/4" />}
            </div>
            <Skeleton className="h-3 w-14 shrink-0" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function EntitiesListSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading entities…" className="space-y-1">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="rounded-xl border border-ink/[0.08] bg-white px-3 py-2 shadow-[0_1px_2px_rgba(25,25,25,0.04)]"
        >
          <div className="flex items-center gap-3">
            <Skeleton className="h-3 w-16 shrink-0" />
            <Skeleton className="h-3 w-full max-w-[16rem]" />
            <Skeleton className="ml-auto h-3 w-14 shrink-0" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ConflictsSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading conflicts…" className="space-y-3">
      {[0, 1].map((i) => (
        <div
          key={i}
          className="rounded-xl border border-ink/[0.08] bg-white p-3 shadow-[0_1px_2px_rgba(25,25,25,0.04),0_6px_18px_rgba(25,25,25,0.05)]"
        >
          <Skeleton className="mb-3 h-3 w-40" />
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {[0, 1].map((c) => (
              <div key={c} className="space-y-2">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-3.5 w-2/3" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-5/6" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function BrainGraphSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading brain graph…"
      className="relative h-full min-h-[420px] w-full overflow-hidden rounded-2xl border border-ink/15 shadow-sm"
      style={{
        background:
          "radial-gradient(ellipse at 50% 32%, #F7F6F3 0%, #EFEDE7 60%, #E4E1D8 100%)",
      }}
    >
      {}
      <Skeleton className="absolute left-1/2 top-1/2 h-16 w-16 -translate-x-1/2 -translate-y-1/2" rounded="rounded-full" />
      {[
        { top: "22%", left: "30%", s: 9 },
        { top: "28%", left: "68%", s: 7 },
        { top: "60%", left: "24%", s: 8 },
        { top: "68%", left: "72%", s: 10 },
        { top: "44%", left: "82%", s: 6 },
        { top: "78%", left: "48%", s: 7 },
      ].map((n, i) => (
        <Skeleton
          key={i}
          className="absolute"
          rounded="rounded-full"
          style={{ top: n.top, left: n.left, height: `${n.s * 4}px`, width: `${n.s * 4}px` }}
        />
      ))}
    </div>
  );
}
