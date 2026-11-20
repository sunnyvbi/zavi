"use client";

import type { ChannelMetric } from "@/lib/workspace/channelActionsApi";
import { MetricRows } from "../metrics/ChannelMetricRows";
import { saysSomething } from "../metrics/channelSummaryMetrics";
import { ChannelDashboard } from "./ChannelDashboard";
import { emptyTiles } from "./channelEmptyTiles";
import type { PlatformSpec } from "./types";

type ChannelMetricsRowProps = {
  slug: string;
  metrics: ChannelMetric[];
  platform: PlatformSpec;
  loading: boolean;
  connected: boolean;
  hasConnectors: boolean;
  connectors?: readonly string[];
  topInto?: HTMLElement | null;
  noticeInto?: HTMLElement | null;
  tablesInto?: HTMLElement | null;
  onSettled?: () => void;
  showEmpty?: boolean;
  onPayload?: (payload: unknown, refetch?: () => void) => void;
  onActionsChanged?: () => void;
};

export function ChannelMetricsRow(props: ChannelMetricsRowProps) {
  const { slug, metrics, platform, loading } = props;
  if (platform.kpiFallback || platform.extras?.length) {
    return <ChannelDashboard {...props} />;
  }
  const known = metrics.length > 0 && saysSomething(metrics);
  if (!known && loading) {
    const placeholders = emptyTiles(platform);
    if (placeholders.length === 0) return null;
    return (
      <div
        className="mt-5 animate-pulse [animation-duration:1.6s] motion-reduce:animate-none"
        role="status"
        aria-busy="true"
        data-testid="channel-metrics-loading"
      >
        <span className="sr-only">Reading this channel&apos;s numbers</span>
        <div aria-hidden>
          <MetricRows slug={slug} metrics={placeholders} platform={platform} plan={null} onPlanSaved={() => {}} />
        </div>
      </div>
    );
  }
  const shown = known ? metrics : emptyTiles(platform);
  if (shown.length > 0) {
    return (
      <div className="mt-5">
        <MetricRows slug={slug} metrics={shown} platform={platform} plan={null} onPlanSaved={() => {}} />
      </div>
    );
  }
  return null;
}
