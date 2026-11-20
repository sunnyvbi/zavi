"use client";

import { ArrowDownRight, ArrowUpRight, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { kpiTile } from "./KpiGrid";

export function DeltaTile({ icon: Icon, label, value, delta, since, signed = false, unit = "%", note }: { icon: LucideIcon; label: string; value: string; delta: { pct: number; up: boolean } | null; since: string; signed?: boolean; unit?: string; note?: string | null }) {
  const Arrow = delta?.up ? ArrowUpRight : ArrowDownRight;
  return (
    <li data-testid={`kpi-tile-${label.toLowerCase().replace(/\s+/g, "-")}`} className={cn(kpiTile, "flex min-h-[148px] min-w-0 flex-col p-5")}>
      <p className="flex items-center gap-2 text-ca-action font-medium text-ca-secondary">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-ca-subtle text-ca-icon">
          <Icon className="size-[18px]" aria-hidden />
        </span>
        {label}
      </p>
      <p className="mt-3 text-ca-kpi font-bold tracking-tight text-ca-xdark tabular-nums">{value}</p>
      {delta && (
        <p className={cn("mt-1 flex flex-wrap items-center gap-x-1 text-[13px] leading-5 font-semibold", delta.up ? "text-ca-success" : "text-ca-danger")}>
          <Arrow className="size-4 shrink-0" aria-hidden />
          {signed ? `${delta.up ? "+" : "−"}${delta.pct}${unit}` : `${delta.pct}${unit} ${delta.up ? "up" : "down"}`}
          <span className="font-normal text-ca-secondary">{since}</span>
        </p>
      )}
      {!delta && note && <p className="mt-1 text-[13px] leading-5 text-ca-secondary">{note}</p>}
    </li>
  );
}
