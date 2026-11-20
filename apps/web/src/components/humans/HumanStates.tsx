"use client";

import Link from "next/link";
import type { ReactNode } from "react";

export function HumanCard({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl border border-ink/[0.08] bg-white px-4 py-4 shadow-[0_1px_2px_rgba(25,25,25,0.04)] ${className}`}
    >
      {children}
    </div>
  );
}

export function HumanSectionHeading({
  children,
  right,
}: {
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-[16px] font-semibold leading-6 text-ink">{children}</h2>
      {right}
    </div>
  );
}

export function HumanChip({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "ok" | "warn" | "bad" | "info";
}) {
  const map = {
    neutral: "bg-slate-100 text-slate-700 ring-slate-200",
    ok: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    warn: "bg-amber-50 text-amber-700 ring-amber-200",
    bad: "bg-rose-50 text-rose-700 ring-rose-200",
    info: "bg-sky-50 text-sky-700 ring-sky-200",
  } as const;
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-[11px] font-medium leading-none ring-1 ring-inset ${map[tone]}`}
    >
      {children}
    </span>
  );
}

export function HumanSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <ul className="space-y-4" aria-busy aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <li
          key={i}
          className="animate-pulse rounded-xl border border-ink/[0.08] bg-white px-4 py-4 motion-reduce:animate-none"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="h-4 w-2/3 rounded bg-ink/[0.06]" />
            <div className="h-5 w-20 shrink-0 rounded-full bg-ink/[0.06]" />
          </div>
          <div className="mt-3 h-3 w-1/3 rounded bg-ink/[0.06]" />
          <div className="mt-4 flex flex-wrap gap-2">
            {[0, 1, 2].map((j) => (
              <div key={j} className="h-6 w-16 rounded-full bg-ink/[0.06]" />
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function HumanEmpty({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-ink/[0.08] bg-white px-6 py-12 text-center">
      <p className="text-[16px] font-medium text-ink">{title}</p>
      <p className="mx-auto mt-2 max-w-[46ch] text-[13px] leading-[1.55] text-inkMuted">
        {body}
      </p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function HumanError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-4">
      <p className="text-[16px] font-semibold text-rose-800">
        Couldn&apos;t load this
      </p>
      <p className="mt-1 text-[13px] leading-[1.5] text-rose-700">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 rounded-full border border-rose-300 bg-white px-3.5 py-1.5 text-[13px] font-medium text-rose-800 hover:bg-rose-100"
      >
        Try again
      </button>
    </div>
  );
}

export function HumanNotBuilt({ what }: { what: string }) {
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-4">
      <p className="text-[16px] font-semibold text-amber-800">
        {what} isn&apos;t live yet
      </p>
      <p className="mt-1 max-w-[62ch] text-[13px] leading-[1.5] text-amber-700">
        The Human section is shipped ahead of the API that fills it. Nothing is
        broken and nothing you do here is lost. This panel starts showing real
        rows the moment the endpoint is deployed.
      </p>
    </div>
  );
}

export function HumanSessionExpired({ next }: { next: string }) {
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-4">
      <p className="text-[16px] font-semibold text-amber-800">Session expired</p>
      <p className="mt-1 text-[13px] leading-[1.5] text-amber-700">
        Your sign-in token has timed out. Sign in again to pick up where you left
        off.
      </p>
      <Link
        href={`/login?next=${encodeURIComponent(next)}`}
        className="mt-3 inline-flex items-center justify-center rounded-full bg-ink px-4 py-1.5 text-[13px] font-semibold text-cream hover:bg-ink/90"
      >
        Sign in
      </Link>
    </div>
  );
}
