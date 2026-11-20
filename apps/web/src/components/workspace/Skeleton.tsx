"use client";

import type { CSSProperties } from "react";

export function Skeleton({
  className = "",
  style,
  rounded = "rounded-md",
  delayMs = 0,
}: {
  className?: string;
  style?: CSSProperties;
  rounded?: string;
  delayMs?: number;
}) {
  return (
    <span
      aria-hidden
      style={style}
      className={`relative block overflow-hidden bg-bone/70 ${rounded} ${className}`}
    >
      <span
        style={delayMs ? { animationDelay: `${delayMs}ms` } : undefined}
        className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-cream/55 to-transparent motion-reduce:hidden"
      />
    </span>
  );
}

export function SkeletonListCard({
  rows = 3,
  header = true,
  label = "Loading…",
}: {
  rows?: number;
  header?: boolean;
  label?: string;
}) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className="overflow-hidden rounded-xl border border-ink/[0.08] bg-white shadow-[0_1px_2px_rgba(25,25,25,0.04),0_6px_18px_rgba(25,25,25,0.05)]"
    >
      {header && (
        <div className="border-b border-ink/10 px-4 py-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="mt-2 h-3 w-3/4" />
        </div>
      )}
      <ul className="divide-y divide-ink/10">
        {Array.from({ length: rows }).map((_, i) => (
          <li key={i} className="flex items-center justify-between px-4 py-3">
            <div className="min-w-0 flex-1">
              <Skeleton className="h-3.5 w-40" />
              <Skeleton className="mt-2 h-3 w-24" />
            </div>
            <Skeleton className="ml-4 h-6 w-16 shrink-0 rounded-md" />
          </li>
        ))}
      </ul>
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function SkeletonConnectorTile() {
  return (
    <div className="flex items-center gap-3 rounded-[16px] border border-[#f0f0f0] bg-white py-3 pl-5 pr-3">
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-2 py-0.5">
        <Skeleton className="h-[22px] w-[92px]" rounded="rounded" />
        <div className="flex items-center gap-2">
          <Skeleton className="h-1.5 w-1.5 shrink-0" rounded="rounded-full" />
          <Skeleton className="h-3 w-28" />
        </div>
      </div>
      <Skeleton className="h-10 w-[92px] shrink-0" rounded="rounded-[12px]" />
    </div>
  );
}

function SkeletonRichCard() {
  return (
    <div className="col-span-full flex flex-col gap-3 rounded-[16px] border border-[#f0f0f0] bg-white px-4 py-[19px]">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Skeleton className="h-[22px] w-[96px]" rounded="rounded" />
          <Skeleton className="h-3 w-40" />
        </div>
        <Skeleton className="h-10 w-[140px] shrink-0" rounded="rounded-[12px]" />
      </div>
      <div className="mt-1 flex flex-col gap-2 border-t border-[#f0f0f0] pt-3">
        <Skeleton className="h-[52px] w-full" rounded="rounded-[16px]" />
        <Skeleton className="h-[52px] w-full" rounded="rounded-[16px]" />
      </div>
    </div>
  );
}

export function SkeletonConnectorGrid({ tiles = 6 }: { tiles?: number }) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className="flex flex-col gap-8"
    >
      <div className="flex flex-col gap-[13px]">
        <Skeleton className="h-5 w-24" />
        <div className="grid grid-cols-1 gap-2.5">
          <SkeletonRichCard />
        </div>
      </div>
      <div className="flex flex-col gap-[13px]">
        <Skeleton className="h-5 w-10" />
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: tiles }).map((_, i) => (
            <SkeletonConnectorTile key={i} />
          ))}
        </div>
      </div>
      <span className="sr-only">Loading connectors…</span>
    </div>
  );
}

export function SkeletonSkillGrid({ cards = 4 }: { cards?: number }) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className="grid grid-cols-1 gap-4 sm:grid-cols-2"
    >
      {Array.from({ length: cards }).map((_, i) => (
        <div key={i} className="flex flex-col rounded-2xl border border-rule bg-cream p-4">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="mt-3 h-3 w-full" />
          <Skeleton className="mt-2 h-3 w-4/5" />
          <div className="mt-6 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Skeleton className="h-4 w-4 shrink-0" rounded="rounded-full" />
              <Skeleton className="h-3 w-14" />
            </div>
            <Skeleton className="h-3 w-16" />
          </div>
        </div>
      ))}
      <span className="sr-only">Loading skills…</span>
    </div>
  );
}
