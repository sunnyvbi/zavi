"use client";

import { BarChart3, CircleDollarSign, Gauge, MousePointerClick, Percent, Receipt, Target, Wallet, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { cn } from "@/lib/cn";
import type { ChannelMetric } from "@/lib/workspace/channelActionsApi";
import type { TileSelect } from "./MetricCard";

export const ACCOUNT_METRIC_GRID = "grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3";

const METRIC_ICONS: Record<string, LucideIcon> = { spend: CircleDollarSign, impressions: BarChart3, clicks: MousePointerClick, conversions: Target, roas: Percent, cpa: Receipt, cpc: Gauge, ctr: MousePointerClick, conv_value: Wallet, pacing: Gauge };

export function AccountMetricCard({ label, value, help, metricKey, select, icon, tone }: {
  label: string;
  value: ReactNode;
  help?: ReactNode;
  metricKey?: string;
  select?: TileSelect;
  icon?: LucideIcon;
  tone?: ChannelMetric["tone"];
}) {
  const Icon = icon ?? METRIC_ICONS[metricKey ?? ""] ?? BarChart3;
  const valueTone = tone === "good" ? "text-success" : tone === "warn" ? "text-warn" : tone === "bad" ? "text-danger" : "text-ink";
  const content = <><span className="flex min-w-0 items-center gap-2 break-words text-base font-semibold text-inkSoft"><Icon className="size-metric-icon shrink-0" aria-hidden /><span>{label}</span></span><span className="mt-auto min-w-0 text-left"><strong className={cn("block break-words text-metric-value font-bold tabular-nums", valueTone)} data-testid={metricKey ? `value-${metricKey}` : undefined}>{value}</strong>{help && <span className="mt-2 block break-words text-detail font-normal leading-snug text-inkMuted">{help}</span>}</span></>;
  const className = cn("flex min-h-account-metric min-w-0 flex-col justify-between gap-3 rounded-2xl border border-rule bg-bone/60 px-4 py-4 shadow-none", select?.selected && "border-ink");
  if (select) return <Button type="button" role={select.mode === "disclosure" ? undefined : "tab"} aria-selected={select.mode === "disclosure" ? undefined : select.selected} aria-expanded={select.mode === "disclosure" ? select.selected : undefined} aria-controls={select.mode === "disclosure" && !select.selected ? undefined : select.controls} onClick={select.onSelect} data-metric={metricKey} className={cn(className, "h-auto !items-stretch !justify-between !bg-bone/60 text-left")}>{content}</Button>;
  return <Card variant="muted" className={className} data-metric={metricKey}>{content}</Card>;
}
