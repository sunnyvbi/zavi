"use client";

import { Skeleton } from "./Skeleton";

export function AutopilotSkeleton() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="mx-auto max-w-5xl px-6 py-10"
    >
      <span className="sr-only">Loading Autopilot…</span>

      {}
      <Skeleton className="h-8 w-56" />
      <div className="mt-4 space-y-2">
        <Skeleton className="h-3.5 w-full max-w-2xl" />
        <Skeleton className="h-3.5 w-3/4 max-w-xl" />
      </div>

      {}
      <div className="mt-6 flex items-center justify-between gap-4 rounded-xl border border-ink/[0.08] bg-white px-4 py-4">
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-4 w-52" />
          <Skeleton className="h-3 w-full max-w-lg" />
        </div>
        <Skeleton className="h-9 w-40 shrink-0" rounded="rounded-full" />
      </div>

      {}
      <section className="mt-10">
        <Skeleton className="mb-2 h-5 w-40" />
        <Skeleton className="mb-4 h-3.5 w-full max-w-xl" />
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="rounded-xl border border-ink/[0.08] bg-white px-4 py-4 shadow-[0_1px_2px_rgba(25,25,25,0.04)]"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex items-center gap-2">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-4 w-16" rounded="rounded-full" />
                  </div>
                  <Skeleton className="h-3 w-full max-w-md" />
                </div>
                <Skeleton className="h-7 w-16 shrink-0" rounded="rounded-full" />
              </div>
              <div className="mt-3 flex flex-wrap items-end gap-4">
                <Skeleton className="h-8 w-48" rounded="rounded-lg" />
                <Skeleton className="h-8 w-28" rounded="rounded-lg" />
                <Skeleton className="h-8 w-28" rounded="rounded-lg" />
              </div>
            </div>
          ))}
        </div>
      </section>

      {}
      <section className="mt-12">
        <Skeleton className="mb-2 h-5 w-36" />
        <Skeleton className="mb-4 h-3.5 w-full max-w-lg" />
        <div className="overflow-hidden rounded-xl border border-ink/[0.08] bg-white">
          <div className="border-b border-ink/[0.06] bg-bone/60 px-4 py-2.5">
            <Skeleton className="h-3 w-24" />
          </div>
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className={`flex items-center gap-4 px-4 py-2.5 ${
                i < 3 ? "border-b border-ink/[0.06]" : ""
              }`}
            >
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-3 w-16" />
              <Skeleton className="ml-auto h-3 w-14" />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
