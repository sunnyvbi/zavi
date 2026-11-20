"use client";

import { useMemo } from "react";
import { Card } from "@/components/ui/card";
import { CHANNEL_COLORS, Legend, StackedAreaChart, TimeSeriesChart, type Serie } from "./Chart";
import type { AnalyticsSection, MetricRow, Section, TrendPoint } from "./types";
import { Delta, Empty, Notice, Panel, Stat, TabHeader } from "../ui";
import { fmtCount, fmtDate, fmtMetric, fmtPct, fmtUsd } from "./format";

function shortDay(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function pick(points: TrendPoint[], key: keyof TrendPoint): Array<number | null> {
  return points.map((point) => (typeof point[key] === "number" ? (point[key] as number) : null));
}

function NoSeries({ detail }: { detail: string }) {
  return (
    <div className="grid h-[250px] place-items-center px-6 text-center">
      <p className="max-w-sm text-sm text-muted-foreground">{detail}</p>
    </div>
  );
}

export function AnalyticsTab({
  section,
  onPrefill,
}: {
  section: Section<AnalyticsSection>;
  onPrefill: (text: string) => void;
}) {
  const { metrics, trends } = section.data;
  const points = trends?.points ?? [];
  const labels = useMemo(() => points.map((point) => shortDay(point.date)), [points]);

  const channelSeries: Serie[] = useMemo(() => {
    const channelPoints = trends?.channel_points ?? [];
    const names = [...new Set(channelPoints.flatMap((point) => Object.keys(point.by_channel)))].slice(0, 6);
    return names.map((name, index) => ({
      key: name,
      label: name,
      color: CHANNEL_COLORS[index % CHANNEL_COLORS.length],
      values: channelPoints.map((point) => point.by_channel[name] ?? 0),
    }));
  }, [trends?.channel_points]);

  const source = trends?.sources?.join(" + ") || "no source";
  const noSeries = trends?.sources?.length
    ? "No readings in this window."
    : "No connected source reports a daily series for this client, so there is nothing to chart.";

  function investigate(metric: MetricRow) {
    onPrefill(
      [
        `Metric: ${metric.label}`,
        `- Value: ${fmtMetric(metric.value, metric.unit)}`,
        `- Previous: ${fmtMetric(metric.previous_value, metric.unit)}`,
        `- Change: ${metric.change === null ? "not computable" : `${(metric.change * 100).toFixed(1)}%`}`,
        `- Source: ${metric.source}`,
        `- Window: ${metric.window_kind}, ending ${metric.window_end}`,
        "",
        "What does this movement mean for the client, and what should we suggest?",
      ].join("\n"),
    );
  }

  const header = (
    <TabHeader
      title="360° analytics"
      meta={
        trends?.window &&
        `${fmtDate(trends.window.since)} – ${fmtDate(trends.window.until)}${
          trends.sources?.length ? ` · ${trends.sources.join(" + ")}` : ""
        }`
      }
    />
  );

  if (metrics.length === 0 && points.length === 0) {
    return (
      <div>
        {header}
        <Empty title="No analytics for this client" detail={section.detail} />
      </div>
    );
  }

  return (
    <div>
      {header}
      <Notice status={section.status} detail={section.detail} />

      {metrics.length > 0 && (
        <Card className="mb-5 grid grid-cols-2 gap-px overflow-hidden bg-border lg:grid-cols-4">
          {metrics.map((metric) => (
            <Stat
              key={metric.key}
              label={metric.label}
              value={
                metric.value === null ? (
                  <span className="text-base font-normal text-muted-foreground">Not measured</span>
                ) : (
                  fmtMetric(metric.value, metric.unit)
                )
              }
              hint={
                <>
                  {metric.change !== null && (
                    <Delta value={metric.change} invert={metric.direction === "down"} />
                  )}
                  <span className="truncate">{metric.source.replace(/_/g, " ")}</span>
                </>
              }
              onClick={() => investigate(metric)}
            />
          ))}
        </Card>
      )}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Panel title="Revenue & spend" meta={`source · ${source}`}>
          <TimeSeriesChart
            labels={labels}
            formatY={fmtUsd}
            empty={<NoSeries detail={noSeries} />}
            series={[
              { key: "spend", label: "Spend", color: "#c8c9c5", kind: "bar", values: pick(points, "spend_usd") },
              { key: "revenue", label: "Revenue", color: "#0f172a", kind: "line", values: pick(points, "revenue_usd") },
            ]}
          />
        </Panel>

        <Panel title="Leads & customers" meta={`source · ${source}`}>
          <TimeSeriesChart
            labels={labels}
            formatY={(value) => fmtCount(Math.round(value))}
            empty={<NoSeries detail={noSeries} />}
            series={[
              { key: "leads", label: "Leads", color: "#a3b2c0", kind: "bar", values: pick(points, "leads") },
              { key: "customers", label: "Customers", color: "#0f766e", kind: "line", values: pick(points, "customers") },
            ]}
          />
        </Panel>

        <Panel title="CAC & ROAS" meta="model · computed per day">
          <TimeSeriesChart
            labels={labels}
            formatY={fmtUsd}
            empty={<NoSeries detail={noSeries} />}
            series={[
              { key: "cac", label: "CAC", color: "#b91c1c", kind: "line", values: pick(points, "cac_usd") },
              { key: "roas", label: "ROAS", color: "#2563eb", kind: "dashed", values: pick(points, "roas") },
            ]}
          />
        </Panel>

        <Panel title="Conversion rate" meta="model · computed per day">
          <TimeSeriesChart
            labels={labels}
            formatY={(value) => fmtPct(value, 1)}
            empty={<NoSeries detail={noSeries} />}
            series={[
              {
                key: "conversion",
                label: "Conversion rate",
                color: "#b45309",
                kind: "area",
                values: pick(points, "conversion_rate"),
              },
            ]}
          />
        </Panel>
      </div>

      <Panel
        title="Revenue by channel"
        meta="source · ga4"
        action={channelSeries.length > 0 ? <Legend series={channelSeries} /> : undefined}
        className="mt-5"
      >
        <StackedAreaChart
          labels={(trends?.channel_points ?? []).map((point) => shortDay(point.date))}
          series={channelSeries}
          formatY={fmtUsd}
          empty={
            <NoSeries detail="Google Analytics is not connected, so revenue cannot be split by channel." />
          }
        />
      </Panel>
    </div>
  );
}
