"use client";

import { ACCOUNT_METRIC_GRID } from "./AccountMetricCard";
import { cn } from "@/lib/cn";
import type { CSSProperties } from "react";
import type { LucideIcon } from "lucide-react";
import type { ChannelMetric } from "@/lib/workspace/channelActionsApi";
import { MetricCard, PacingCard } from "./MetricCard";

export type PerRow = 3 | 4 | 5 | 6 | 8;

export const ROW_GAP_PX = 12;
export const TILE_MIN_PX = 132;
export const DETAIL_TILE_MIN_PX = 220;

export const PER_ROW_MAX_COLS: Record<PerRow, number> = {
  3: 3,
  4: 4,
  5: 5,
  6: 3,
  8: 4,
};

export function columnTemplate(
  maxCols: number,
  minPx: number,
  gapPx: number = ROW_GAP_PX,
): string {
  const share = `calc((100% - ${gapPx * (maxCols - 1)}px) / ${maxCols})`;
  return `repeat(auto-fill, minmax(max(${minPx}px, ${share}), 1fr))`;
}

export function tileBasis(
  maxCols: number,
  minPx: number,
  gapPx: number = ROW_GAP_PX,
): string {
  return `max(${minPx}px, calc((100% - ${gapPx * (maxCols - 1)}px) / ${maxCols}))`;
}

function tileBasisStyle(maxCols: number, minPx: number): CSSProperties {
  return { "--metric-tile-basis": tileBasis(maxCols, minPx) } as CSSProperties;
}

function scoreTileStyle(maxCols: number): CSSProperties {
  return { "--metric-tile-basis": tileBasis(maxCols, DETAIL_TILE_MIN_PX, 16) } as CSSProperties;
}

export function defaultPerRow(n: number): PerRow {
  if (n <= 3) return 3;
  if (n === 4) return 4;
  if (n === 5) return 5;
  if (n <= 6) return 6;
  return 8;
}

export type MetricDisplay = {
  label?: string;
  icon?: LucideIcon;
  sub?: string;
  selects?: string;
};

export type RowSelection = {
  selectedKey?: string | null;
  onSelect: (key: string) => void;
  panelId: string;
  mode?: "tab" | "disclosure";
};

export function SummaryRow({
  metrics,
  perRow,
  variant = "grid",
  display = {},
  pacingKey = "pacing",
  label = "Headline numbers",
  selection,
}: {
  metrics: ChannelMetric[];
  perRow?: PerRow;
  variant?: "grid" | "spend" | "account" | "score";
  display?: Record<string, MetricDisplay>;
  pacingKey?: string;
  label?: string;
  selection?: RowSelection;
}) {
  if (!metrics.length) return null;
  if (variant === "spend") {
    return (
      <div
        className="flex flex-wrap gap-3 [&>*]:min-w-0 [&>*]:grow [&>*]:shrink-0 [&>*]:basis-[var(--metric-tile-basis)]"
        style={tileBasisStyle(3, DETAIL_TILE_MIN_PX)}
        aria-label={label}
        data-testid="summary-row"
        data-variant="spend"
      >
        {metrics.map((m) => {
          const d = display[m.key] ?? {};
          return m.key === pacingKey ? (
            <PacingCard key={m.key} metric={m} label={d.label} icon={d.icon} sub={d.sub} />
          ) : (
            <MetricCard key={m.key} metric={m} label={d.label} icon={d.icon} sub={d.sub} variant="detail" />
          );
        })}
      </div>
    );
  }
  const maxCols = PER_ROW_MAX_COLS[perRow ?? defaultPerRow(metrics.length)];
  const disclosure = selection?.mode === "disclosure";
  const picking =
    !!selection &&
    metrics.length > 1 &&
    (disclosure
      ? metrics.some((m) => !!display[m.key]?.selects)
      : metrics.every((m) => !!display[m.key]?.selects));
  const score = variant === "score";
  const chosen = picking
    ? metrics.some((m) => m.key === selection?.selectedKey)
      ? selection?.selectedKey
      : disclosure
        ? null
        : metrics[0].key
    : undefined;
  return (
    <div
      className={cn(variant === "account" ? ACCOUNT_METRIC_GRID : cn("flex flex-wrap [&>*]:min-w-0 [&>*]:grow [&>*]:shrink-0 [&>*]:basis-[var(--metric-tile-basis)] compact:grid compact:grid-cols-2 compact:[&>*:first-child:nth-last-child(odd)]:col-span-2", score ? "gap-4" : "gap-3"))}
      style={variant === "account" ? undefined : score ? scoreTileStyle(maxCols) : tileBasisStyle(maxCols, TILE_MIN_PX)}
      aria-label={label}
      role={picking && !disclosure ? "tablist" : undefined}
      data-testid="summary-row"
      data-variant={variant}
    >
      {metrics.map((m) => {
        const d = display[m.key] ?? {};
        return (
          <MetricCard
            key={m.key}
            metric={m}
            label={d.label}
            icon={d.icon}
            sub={d.sub}
            variant={variant === "grid" ? "compact" : variant}
            {...(picking && selection && d.selects
              ? {
                  select: {
                    selected: m.key === chosen,
                    onSelect: () => selection.onSelect(m.key),
                    controls: selection.panelId,
                    ...(disclosure ? { mode: "disclosure" as const } : {}),
                  },
                }
              : {})}
          />
        );
      })}
    </div>
  );
}
