"use client";

import { BarChart3, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function CampaignMetricTile({ metricKey, icon: Icon = BarChart3, label, value, suffix, help, action, className = "" }: {
  metricKey: string;
  icon?: LucideIcon;
  label: string;
  value: ReactNode;
  suffix?: string;
  help: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div data-metric={metricKey} className={`flex min-h-[142px] min-w-0 flex-col rounded-2xl border border-ca-border bg-ca-bg p-5 ${className}`}>
      <span className="flex items-center gap-2.5 text-ca-label text-ca-secondary">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-ca-subtle">
          <Icon className="size-4 text-ca-dark" aria-hidden />
        </span>
        {label}
      </span>
      <p className="mt-3 flex min-w-0 items-baseline gap-1.5">
        <strong data-testid={`value-${metricKey}`} className="text-[32px] font-bold leading-10 tabular-nums text-ca-xdark">{value}</strong>
        {suffix && <span className="text-ca-title font-semibold text-ca-secondary">{suffix}</span>}
      </p>
      <div className="mt-auto flex items-end justify-between gap-3 pt-2">
        <span className="min-w-0 text-ca-label text-ca-secondary">{help}</span>
        {action}
      </div>
    </div>
  );
}
