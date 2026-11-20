import { Badge } from "@/components/ui/Badge";
import { tierDisplayName } from "@/lib/marketing/pricing";
import { formatComparison, formatMetricValue } from "@/lib/shopify-app-home/format";
import type { MetricValue, ShopifyAppHome } from "@/lib/shopify-app-home/types";
import { AppHomeCard } from "./AppHomeCard";

function Metric({ label, metric }: { label: string; metric: MetricValue }) {
  const value = formatMetricValue(metric);
  const delta = formatComparison(metric);
  return (
    <div className="space-y-1 p-4">
      <p className="text-[12px] text-neutral-500 underline decoration-dotted underline-offset-4">{label}</p>
      {metric.availability === "plan_locked" ? (
        <Badge>{tierDisplayName(metric.locked_tier)} plan</Badge>
      ) : metric.availability === "unavailable" || value === null ? (
        <p className="text-[15px] text-neutral-500">Not available</p>
      ) : (
        <p className="text-[22px] font-semibold leading-tight text-neutral-900">{value}</p>
      )}
      {delta && (
        <p className={delta.up ? "text-[12px] font-medium text-success" : "text-[12px] font-medium text-danger"}>
          <span aria-hidden="true">{delta.up ? "↑" : "↓"}</span> {delta.text}
        </p>
      )}
      {metric.note && <p className="text-[12px] text-neutral-500">{metric.note}</p>}
      {metric.availability === "stale" && <p className="text-[12px] text-amber-700">Last synced data</p>}
    </div>
  );
}

export function MetricsCard({ data }: { data: ShopifyAppHome }) {
  const m = data.metrics;
  return (
    <AppHomeCard>
      <div className="flex items-center justify-between px-4 pt-4">
        <h2 className="text-[15px] font-semibold text-neutral-900">Last {m.window_days} days</h2>
        <p className="text-[12px] text-neutral-500">vs. previous {m.window_days} days</p>
      </div>
      <div className="mt-2 grid grid-cols-2 divide-neutral-200 sm:grid-cols-4 sm:divide-x [&>*:nth-child(odd)]:border-r [&>*:nth-child(odd)]:border-neutral-200 sm:[&>*:nth-child(odd)]:border-r-0 [&>*:nth-child(-n+2)]:border-b [&>*:nth-child(-n+2)]:border-neutral-200 sm:[&>*:nth-child(-n+2)]:border-b-0">
        <Metric label="Store sales" metric={m.sales} />
        <Metric label="Orders" metric={m.orders} />
        <Metric label="Zavi actions done" metric={m.zavi_actions} />
        <Metric label="Ad spend managed" metric={m.ad_spend} />
      </div>
      <p className="border-t border-neutral-200 px-4 py-3 text-[12px] text-neutral-500">Sales and orders come from Shopify. Zavi does not claim them as its own results.</p>
    </AppHomeCard>
  );
}
