"use client";

import { Skeleton } from "../Skeleton";

function CardShell({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-ink/[0.08] bg-white p-4 shadow-[0_1px_2px_rgba(25,25,25,0.04),0_6px_18px_rgba(25,25,25,0.05)]">
      {children}
    </section>
  );
}

export function HomeSkeleton() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="mx-auto max-w-5xl px-6 pt-8 pb-10 md:px-8"
    >
      <span className="sr-only">Loading your workspace…</span>

      {}
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="flex h-[72px] flex-col justify-between rounded-xl border border-ink/[0.08] bg-white p-4 shadow-[0_1px_2px_rgba(25,25,25,0.04),0_6px_18px_rgba(25,25,25,0.05)]"
          >
            <Skeleton className="h-2.5 w-16" />
            <Skeleton className="h-6 w-12" />
          </div>
        ))}
      </div>

      {}
      <div className="mb-5">
        <CardShell>
          <div className="mb-4 flex items-center justify-between">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-5 w-20" rounded="rounded-full" />
          </div>
          <Skeleton className="h-24 w-full" rounded="rounded-lg" />
          <div className="mt-3 flex gap-2">
            <Skeleton className="h-8 w-28" rounded="rounded-lg" />
            <Skeleton className="h-8 w-8" rounded="rounded-lg" />
          </div>
        </CardShell>
      </div>

      {}
      <div className="mb-5">
        <CardShell>
          <div className="mb-3 flex items-center justify-between">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-3 w-12" />
          </div>
          <div className="mb-4 flex flex-wrap gap-2">
            {[20, 24, 16].map((w, i) => (
              <Skeleton key={i} className="h-5" style={{ width: `${w * 4}px` }} rounded="rounded-full" />
            ))}
          </div>
          <div className="space-y-2">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-11/12" />
            <Skeleton className="h-3 w-3/4" />
          </div>
        </CardShell>
      </div>

      {}
      <div className="mb-5 grid grid-cols-1 gap-4 md:grid-cols-2">
        {[0, 1].map((c) => (
          <CardShell key={c}>
            <Skeleton className="mb-4 h-4 w-32" />
            <div className="space-y-2.5">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex items-center gap-2.5">
                  <Skeleton className="h-7 w-7 shrink-0" rounded="rounded-lg" />
                  <Skeleton className="h-3 flex-1" />
                  <Skeleton className="h-3 w-10 shrink-0" />
                </div>
              ))}
            </div>
          </CardShell>
        ))}
      </div>

      {}
      <div className="mb-5">
        <CardShell>
          <Skeleton className="mb-3 h-4 w-40" />
          <div className="space-y-3">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-2">
                <Skeleton className="h-1.5 w-1.5 shrink-0" rounded="rounded-full" />
                <Skeleton className="h-3 w-32" />
                <Skeleton className="ml-auto h-3 w-14 shrink-0" />
                <Skeleton className="h-3 w-12 shrink-0" />
              </div>
            ))}
          </div>
        </CardShell>
      </div>

      {}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {[0, 1].map((c) => (
          <CardShell key={c}>
            <Skeleton className="mb-4 h-4 w-28" />
            <Skeleton className="h-28 w-full" rounded="rounded-lg" />
          </CardShell>
        ))}
      </div>
    </div>
  );
}
