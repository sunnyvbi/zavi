"use client";

import type { ReactNode } from "react";
import { Area, Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

export const CHANNEL_COLORS = ["#0ea5e9", "#14b8a6", "#6366f1", "#f97316", "#a855f7", "#64748b"];

export type Serie = {
  key: string;
  label: string;
  color: string;
  kind?: "line" | "area" | "bar" | "dashed";
  values: Array<number | null>;
};

const AXIS_TICK = { fill: "#8c8c8c", fontSize: 11 };
const GRID = "#f0f0f0";

function toConfig(series: Serie[]): ChartConfig {
  return Object.fromEntries(series.map((s) => [s.key, { label: s.label, color: s.color }]));
}

function toRows(labels: string[], series: Serie[]) {
  return labels.map((label, index) => ({
    label,
    ...Object.fromEntries(series.map((s) => [s.key, s.values[index]])),
  }));
}

function hasReadings(series: Serie[]): boolean {
  return series.some((s) => s.values.some((v) => v !== null && Number.isFinite(v)));
}

function niceMax(series: Serie[], stacked = false): number {
  const peak = stacked
    ? Math.max(
        ...series[0].values.map((_, i) =>
          series.reduce((sum, s) => sum + (Number.isFinite(s.values[i]) ? (s.values[i] as number) : 0), 0),
        ),
        0,
      )
    : Math.max(...series.flatMap((s) => s.values.filter((v): v is number => Number.isFinite(v as number))), 0);
  if (peak <= 0) return 1;
  const rough = peak / 4;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const scaled = rough / mag;
  const step = [1, 1.5, 2, 2.5, 5, 10].find((s) => scaled <= s) ?? 10;
  return step * mag * 4;
}

function markerColor(hex: string): string {
  const value = hex.replace("#", "");
  if (value.length !== 6) return hex;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.3 ? "#ffffff" : hex;
}

function tooltipRow(series: Serie[], format: (value: number) => string) {
  return function render(value: unknown, name: unknown) {
    const serie = series.find((s) => s.key === name);
    if (!serie) return null;
    const muted = serie.kind === "bar";
    const tone = muted ? "text-[#9ca3af]" : "text-white";
    return (
      <div className="flex w-full items-center justify-between gap-3">
        <span className="flex items-center gap-1.5">
          <span
            className={`size-1.5 shrink-0 ${muted ? "rounded-[1px]" : "rounded-full"}`}
            style={{ backgroundColor: markerColor(serie.color) }}
          />
          <span className={`text-[12px] font-medium ${tone}`}>{serie.label}</span>
        </span>
        <span className={`text-[12px] font-semibold ${tone}`}>
          {typeof value === "number" && Number.isFinite(value) ? format(value) : "—"}
        </span>
      </div>
    );
  };
}

function Tip({ series, formatY }: { series: Serie[]; formatY: (value: number) => string }) {
  return (
    <ChartTooltip
      cursor={{ stroke: "#cbd5e1", strokeWidth: 1, strokeDasharray: "3 3" }}
      itemSorter={(item) => (series.find((s) => s.key === item.dataKey)?.kind === "bar" ? 1 : 0)}
      content={
        <ChartTooltipContent
          className="w-40 gap-2 rounded-xl border-0 bg-[#111827] p-3 shadow-[0_1px_2px_rgba(16,18,20,0.1),0_1px_2px_rgba(16,18,20,0.05)]"
          labelClassName="text-[10px] font-semibold uppercase text-[#9ca3af]"
          formatter={tooltipRow(series, formatY)}
        />
      }
    />
  );
}

function Axes({
  count,
  max,
  formatY,
}: {
  count: number;
  max: number;
  formatY: (value: number) => string;
}) {
  return (
    <>
      <CartesianGrid vertical={false} stroke={GRID} />
      <XAxis
        dataKey="label"
        tickLine={false}
        axisLine={false}
        tickMargin={12}
        tick={AXIS_TICK}
        interval={Math.max(0, Math.ceil(count / 7) - 1)}
      />
      <YAxis
        tickLine={false}
        axisLine={false}
        tickMargin={8}
        tick={AXIS_TICK}
        width={56}
        domain={[0, max]}
        ticks={[0, 0.25, 0.5, 0.75, 1].map((f) => max * f)}
        tickFormatter={(value: number) => formatY(value)}
      />
    </>
  );
}

export function Legend({ series }: { series: Serie[] }) {
  return (
    <div className="flex flex-wrap items-center gap-4">
      {series.map((serie) => (
        <span key={serie.key} className="flex items-center gap-2 text-[12px] font-medium text-[#4b5563]">
          <span className="h-[3px] w-3 rounded-full" style={{ backgroundColor: serie.color }} />
          {serie.label}
        </span>
      ))}
    </div>
  );
}

export function TimeSeriesChart({
  labels,
  series,
  formatY,
  empty,
}: {
  labels: string[];
  series: Serie[];
  formatY: (value: number) => string;
  empty: ReactNode;
}) {
  if (!hasReadings(series) || labels.length === 0) return <>{empty}</>;

  return (
    <ChartContainer config={toConfig(series)} className="h-[250px] w-full">
      <ComposedChart data={toRows(labels, series)} margin={{ top: 22, right: 16, bottom: 0, left: 0 }}>
        <Axes count={labels.length} max={niceMax(series)} formatY={formatY} />
        <Tip series={series} formatY={formatY} />

        {series.map((serie) => {
          if (serie.kind === "bar") {
            return (
              <Bar
                key={serie.key}
                dataKey={serie.key}
                fill={serie.color}
                radius={[2, 2, 0, 0]}
                maxBarSize={12}
                isAnimationActive={false}
              />
            );
          }
          if (serie.kind === "area") {
            return (
              <Area
                key={serie.key}
                dataKey={serie.key}
                stroke={serie.color}
                strokeWidth={2}
                fill={serie.color}
                fillOpacity={0.12}
                dot={false}
                isAnimationActive={false}
              />
            );
          }
          return (
            <Line
              key={serie.key}
              dataKey={serie.key}
              stroke={serie.color}
              strokeWidth={2}
              strokeDasharray={serie.kind === "dashed" ? "4 3" : undefined}
              dot={false}
              activeDot={{ r: 3.5, fill: serie.color, stroke: "#ffffff", strokeWidth: 2 }}
              isAnimationActive={false}
            />
          );
        })}
      </ComposedChart>
    </ChartContainer>
  );
}

export function StackedAreaChart({
  labels,
  series,
  formatY,
  empty,
}: {
  labels: string[];
  series: Serie[];
  formatY: (value: number) => string;
  empty: ReactNode;
}) {
  if (!hasReadings(series) || labels.length === 0) return <>{empty}</>;

  return (
    <ChartContainer config={toConfig(series)} className="h-[250px] w-full">
      <ComposedChart data={toRows(labels, series)} margin={{ top: 22, right: 16, bottom: 0, left: 0 }}>
        <Axes count={labels.length} max={niceMax(series, true)} formatY={formatY} />
        <Tip series={series} formatY={formatY} />

        {series.map((serie) => (
          <Area
            key={serie.key}
            dataKey={serie.key}
            stackId="revenue"
            stroke={serie.color}
            strokeWidth={2}
            fill={serie.color}
            fillOpacity={0.18}
            dot={false}
            isAnimationActive={false}
          />
        ))}
      </ComposedChart>
    </ChartContainer>
  );
}
