"use client";

import type { ChannelMetric } from "@/lib/workspace/channelActionsApi";
import type { PlatformSpec } from "../actions/types";
import type { ChannelPlan } from "../agent/legacyChannelActions";
import { MonthlyPlan } from "../agent/google-ads/MonthlyPlan";
import { isAdsChannel } from "../actions/ads/AdsPresentation";
import { SummaryRow, defaultPerRow, type RowSelection } from "./SummaryRow";
import { KpiGrid } from "./KpiGrid";

export function MetricRows({
  slug,
  metrics,
  platform,
  plan,
  onPlanSaved,
  selection,
}: {
  slug: string;
  metrics: ChannelMetric[];
  platform: PlatformSpec;
  plan: ChannelPlan | null;
  onPlanSaved: () => void;
  selection?: RowSelection;
}) {
  const layout = platform.metricLayout ?? {};
  const display = platform.metricDisplay ?? {};
  const pacingKey = layout.pacingKey ?? "pacing";
  const lead = layout.lead;

  if (isAdsChannel(slug)) return (
    <section className="space-y-3" aria-label="Headline numbers">
      <SummaryRow metrics={metrics} variant="account" display={display} selection={selection} />
      {plan && metrics.some((metric) => metric.key === pacingKey) && <MonthlyPlan slug={slug} p={plan} onSaved={onPlanSaved} />}
    </section>
  );

  if (!lead?.length && !selection && (layout.variant ?? "grid") === "grid") {
    return <KpiGrid metrics={metrics} display={display} fourAcross={layout.perRow === 4} />;
  }

  if (!lead?.length) {
    return (
      <SummaryRow
        metrics={metrics}
        variant={layout.variant ?? "grid"}
        perRow={layout.perRow ?? defaultPerRow(metrics.length)}
        {...(layout.pacingKey ? { pacingKey: layout.pacingKey } : {})}
        display={display}
        {...(selection ? { selection } : {})}
      />
    );
  }
  const primary = metrics.filter((m) => lead.includes(m.key));
  const rest = metrics.filter((m) => !lead.includes(m.key));
  const hasPacing = primary.some((m) => m.key === pacingKey);

  return (
    <section className="space-y-3" aria-label="Headline numbers">
      {primary.length > 0 && (
        <SummaryRow
          metrics={primary}
          variant={hasPacing ? "spend" : (layout.variant ?? "grid")}
          pacingKey={pacingKey}
          display={display}
        />
      )}
      {hasPacing && plan && <MonthlyPlan slug={slug} p={plan} onSaved={onPlanSaved} />}
      {rest.length > 0 && (
        <SummaryRow
          metrics={rest}
          perRow={layout.perRow ?? defaultPerRow(rest.length)}
          display={display}
          label="More numbers"
        />
      )}
    </section>
  );
}
