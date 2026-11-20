import type { ChannelMetric } from "@/lib/workspace/channelActionsApi";

export function saysSomething(metrics: readonly ChannelMetric[]): boolean {
  return metrics.some((metric) => Number.isFinite(metric.value) || !!metric.unmeasured);
}

export function channelSummaryMetrics(metrics: ChannelMetric[], fallback: ChannelMetric[], swappingWindow: boolean, preferDashboard = false): ChannelMetric[] {
  if (swappingWindow) return [];
  const source = (preferDashboard ? fallback : metrics.length > 0 ? metrics : fallback).filter((metric) => metric.key !== "daily_budget");
  return saysSomething(source) ? source : [];
}
