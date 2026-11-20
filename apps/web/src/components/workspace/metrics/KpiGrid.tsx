"use client";

import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/cn";
import type { ChannelMetric } from "@/lib/workspace/channelActionsApi";
import { formatMetricValue, humanizeMetricKey, metricDelta } from "./format";
import { Unverified } from "./MetricCard";
import type { MetricDisplay } from "./SummaryRow";

export const kpiTile = "rounded-2xl border border-ca-border bg-ca-bg shadow-ca-sm";

function KpiTile({ metric: m, display }: { metric: ChannelMetric; display: MetricDisplay }) {
  const Icon = display.icon;
  const blank = Boolean(m.unmeasured);
  const sub = typeof m.unmeasured === "string" ? m.unmeasured : blank ? null : (display.sub ?? m.note ?? null);
  const delta = blank ? null : metricDelta(m);
  const Arrow = delta?.direction === "down" ? ArrowDownRight : ArrowUpRight;
  return (
    <div data-testid={`kpi-${m.key}`} data-metric={m.key} className={cn(kpiTile, "flex flex-col p-5")}>
      <dt className="flex items-center gap-2 text-ca-action font-medium text-ca-muted">
        {Icon && (
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-ca-subtle text-ca-icon">
            <Icon className="size-[18px]" aria-hidden />
          </span>
        )}
        {display.label ?? humanizeMetricKey(m.key)}
        {!m.grounded && !blank && <Unverified />}
      </dt>
      <dd className="mt-2">
        <span data-testid={`value-${m.key}`} className="block text-ca-kpi font-bold tracking-tight tabular-nums text-ca-xdark">
          {blank ? "–" : formatMetricValue(m)}
        </span>
        {delta && (
          <span data-testid={`delta-${m.key}`} className={cn("mt-1 flex items-center gap-1 text-ca-action", delta.good ? "text-ca-success" : "text-ca-danger")}>
            <Arrow className="size-4" aria-hidden />
            {delta.text.replace(/^[+-]/, "")} {delta.direction} on last read
          </span>
        )}
        {sub && <span className="mt-1 block text-ca-action text-ca-secondary">{sub}</span>}
      </dd>
    </div>
  );
}

export function KpiGrid({ metrics, display, className, fourAcross = false }: { metrics: ChannelMetric[]; display: Record<string, MetricDisplay>; className?: string; fourAcross?: boolean }) {
  if (!metrics.length) return null;
  return (
    <dl data-testid="summary-row" data-variant="kpi" aria-label="Headline numbers" className={cn("grid grid-cols-1 gap-4 [@container(min-width:36rem)]:grid-cols-2", fourAcross ? "[@container(min-width:56rem)]:grid-cols-4" : "[@container(min-width:56rem)]:grid-cols-3", className)}>
      {metrics.map((m) => (
        <KpiTile key={m.key} metric={m} display={display[m.key] ?? {}} />
      ))}
    </dl>
  );
}
