"use client";

import { Skeleton } from "../../Skeleton";

function StatTileSkeleton() {
  return (
    <div className="min-w-[9.5rem] flex-1 rounded-2xl border border-[#f0f0f0] bg-white p-4">
      <Skeleton className="h-3 w-20" />
      <Skeleton className="mt-2.5 h-6 w-16" />
      <Skeleton className="mt-3 h-2 w-full" rounded="rounded-full" />
    </div>
  );
}

export function ApprovalCardSkeleton() {
  return (
    <div className="flex w-full flex-col gap-3 rounded-[20px] border border-[#f0f0f0] bg-white px-4 py-4">
      <div className="flex items-start gap-4">
        <Skeleton className="h-10 w-10 shrink-0" rounded="rounded-full" />
        <div className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3 w-1/2" />
        </div>
        <Skeleton className="h-6 w-20 shrink-0" rounded="rounded-full" />
      </div>
      <div className="border-t border-[#f0f0f0]" aria-hidden />
      <div className="flex items-center gap-3 pl-14">
        <Skeleton className="h-9 w-24" rounded="rounded-xl" />
        <Skeleton className="h-9 w-16" rounded="rounded-xl" />
        <Skeleton className="h-9 w-20" rounded="rounded-xl" />
      </div>
    </div>
  );
}

function GoalRowSkeleton() {
  return (
    <div className="flex items-center gap-4 rounded-[20px] border border-[#f0f0f0] bg-white px-4 py-4">
      <Skeleton className="h-10 w-10 shrink-0" rounded="rounded-3xl" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-3 w-1/4" />
      </div>
      <div className="flex w-40 shrink-0 flex-col items-end gap-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-2 w-full" rounded="rounded-full" />
      </div>
    </div>
  );
}

export function CalmHomeSkeleton() {
  return (
    <div role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Loading your home…</span>

      {}
      <div className="mb-6 flex items-center gap-4 rounded-2xl border border-[#f0f0f0] bg-white p-3">
        <Skeleton className="h-2 w-[67px] shrink-0" rounded="rounded-full" />
        <Skeleton className="h-4 flex-1" />
        <Skeleton className="h-10 w-28 shrink-0" rounded="rounded-xl" />
      </div>

      {}
      <section aria-hidden>
        <div className="mb-4 flex flex-col gap-2">
          <Skeleton className="h-6 w-56" />
          <Skeleton className="h-3 w-14" />
        </div>
        <div className="flex flex-wrap gap-3">
          {[0, 1, 2].map((i) => (
            <StatTileSkeleton key={i} />
          ))}
        </div>
      </section>

      {}
      <section className="mt-9" aria-hidden>
        <div className="mb-4 flex items-baseline justify-between">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-20" />
        </div>
        <div className="flex flex-col gap-4">
          {[0, 1].map((i) => (
            <ApprovalCardSkeleton key={i} />
          ))}
        </div>
      </section>

      {}
      <section className="mt-9" aria-hidden>
        <div className="mb-4 flex items-center justify-between">
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-10 w-28" rounded="rounded-xl" />
        </div>
        <div className="flex flex-col gap-4">
          {[0, 1].map((i) => (
            <GoalRowSkeleton key={i} />
          ))}
        </div>
      </section>

      {}
      <div className="mt-9 border-t border-[#f0f0f0] pt-4" aria-hidden>
        <Skeleton className="h-3 w-48" />
      </div>
    </div>
  );
}
