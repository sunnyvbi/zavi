
import { META_METRICS } from "./_shared";
import type { PlatformSpec } from "./_shared";

const OUTCOME_METRICS: ReadonlySet<string> = new Set(["cpa", "conversions", "conv_value", "roas"]);

export const meta_ads: PlatformSpec = {
  name: "Meta Ads",
  description: "Reads your ad account and proposes budget and ad changes you approve",
  manageUrl: "https://adsmanager.facebook.com/adsmanager/manage/campaigns",
  maxWidth: "max-w-[1180px]",
  sectionTitle: "What Zavi wants to do",
  dashboardSlug: "performance-marketer",
  paidAnalytics: "meta",
  kpiFallback: "meta",
  metricDisplay: META_METRICS,
  metricLayout: { lead: ["spend", "cpa", "conversions"] },
  extras: ["campaign_table"],
  createMenu: "Create",
  topActions: [
    {
      key: "new_campaign",
      label: "Create campaign",
      modal: "meta_campaign",
      ownersOnly: "Only workspace owners and admins can create or edit Meta campaigns in Zavi.",
    },
    { key: "boost_post", label: "Boost a Page post", modal: "boost_post" },
  ],
  settings: [
    {
      id: "metric_sources",
      kind: "mapping",
      label: "Metric sources",
      help: "Which source Zavi's Meta Ads runs should trust for each number. The dashboard still shows what Meta reports.",
      rowHeader: "Metric",
      columnHeader: "Source",
      rows: Object.entries(META_METRICS)
        .filter(([key]) => OUTCOME_METRICS.has(key))
        .map(([key, m]) => ({ key, label: m.label ?? key })),
      unsetLabel: "Meta Ads",
      options: [
        { value: "stripe", label: "Stripe" },
        { value: "database", label: "Database" },
        { value: "product_analytics", label: "Product analytics" },
      ],
    },
  ],
};
