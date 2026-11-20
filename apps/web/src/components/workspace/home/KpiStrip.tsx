"use client";

import type { ActiveRunRow } from "./types";
import { creditBannerState, STATUS_LOW_CREDIT_THRESHOLD } from "@/lib/workspace/runEstimate";

function fmtCredits(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`;
  return `${n}`;
}

export function KpiStrip({
  activeRunsToday,
  pendingApprovals,
  spendTotalUsd,
  creditsRemaining,
  creditsAllowance = null,
  creditsEnforced = false,
  loading = false,
}: {
  activeRunsToday: ActiveRunRow[];
  pendingApprovals: number;
  spendTotalUsd: number;
  creditsRemaining?: number | null;
  creditsAllowance?: number | null;
  creditsEnforced?: boolean;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <section aria-label="Today at a glance" className="mb-5">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-[72px] animate-pulse rounded-xl bg-bone"
            />
          ))}
        </div>
      </section>
    );
  }

  let running = 0;
  let failedToday = 0;
  for (const r of activeRunsToday) {
    if (r.presentation_status) {
      if (r.presentation_status === "running") running += 1;
      else if (r.presentation_status === "failed") failedToday += 1;
    } else if (r.status === "running" || r.status === "queued") running += 1;
    else if (
      r.status === "dispatch_error" ||
      r.status === "parse_failed" ||
      r.status === "failed" ||
      r.status === "error"
    )
      failedToday += 1;
  }
  const healthy = failedToday === 0;

  const creditsLow =
    typeof creditsRemaining === "number" &&
    creditBannerState(creditsRemaining, creditsAllowance ?? 0, STATUS_LOW_CREDIT_THRESHOLD) !== "none";

  return (
    <section aria-label="Today at a glance" className="mb-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi
          label="Running"
          value={String(running)}
          dot="bg-emerald-500"
          pulse={running > 0}
        />
        <Kpi
          label="Needs you"
          value={String(pendingApprovals)}
          attention={pendingApprovals > 0}
        />
        <Kpi
          label="Healthy"
          value={healthy ? "All clear" : "Failing"}
          dot={healthy ? "bg-emerald-500" : "bg-coral"}
          subtle={
            healthy ? undefined : `${failedToday} failed today`
          }
        />
        {creditsEnforced ? (
          <Kpi
            label="Credits"
            value={
              typeof creditsRemaining === "number"
                ? fmtCredits(creditsRemaining)
                : "-"
            }
            subtle="left"
            valueClassName={creditsLow ? "text-[#cb2029]" : undefined}
          />
        ) : (
          <Kpi label="Spend" value={`$${spendTotalUsd.toFixed(2)}`} subtle="7d" />
        )}
      </div>
    </section>
  );
}

function Kpi({
  label,
  value,
  dot,
  pulse = false,
  attention = false,
  subtle,
  valueClassName,
}: {
  label: string;
  value: string;
  dot?: string;
  pulse?: boolean;
  attention?: boolean;
  subtle?: string;
  valueClassName?: string;
}) {
  return (
    <div
      className={`flex flex-col justify-between rounded-xl border p-4 shadow-[0_1px_2px_rgba(25,25,25,0.04),0_6px_18px_rgba(25,25,25,0.05)] ${
        attention
          ? "border-[#f0d79a] bg-[#fbeccb]"
          : "border-ink/[0.08] bg-white"
      }`}
    >
      <span
        className={`font-mono text-[11px] uppercase tracking-[0.05em] ${
          attention ? "text-[#8a5a10]" : "text-inkMuted"
        }`}
      >
        {label}
      </span>
      <div className="mt-1.5 flex items-baseline gap-2">
        {dot && (
          <span className="relative inline-flex h-2 w-2 items-center justify-center self-center">
            {pulse && (
              <span
                className={`absolute inline-flex h-2 w-2 animate-ping rounded-full ${dot} opacity-70`}
                aria-hidden
              />
            )}
            <span
              className={`relative inline-flex h-2 w-2 rounded-full ${dot}`}
              aria-hidden
            />
          </span>
        )}
        <span
          className={`font-mono text-[24px] font-semibold tabular-nums leading-none ${
            attention ? "text-[#8a5a10]" : (valueClassName ?? "text-ink")
          }`}
        >
          {value}
        </span>
        {subtle && (
          <span
            className={`text-[11px] ${
              attention ? "text-[#8a5a10]/80" : "text-inkMuted"
            }`}
          >
            {subtle}
          </span>
        )}
      </div>
    </div>
  );
}
