
import { classifyTargetMetric } from "@/services/autopilot/goal-metric-vocab";

export type MetricDef = {
  key: string;
  label: string;
  direction: "up" | "down" | "context";
  unit: "count" | "usd" | "ratio";
  window_kind: "rolling_7d" | "day" | "calendar_week" | "point";
  source: "operator_db" | "meta_ads" | "google_ads" | "stripe" | "native_funnel";
};

export const METRIC_REGISTRY: Record<string, MetricDef> = {
  weekly_signups: {
    key: "weekly_signups",
    label: "Signups",
    direction: "up",
    unit: "count",
    window_kind: "rolling_7d",
    source: "operator_db",
  },
  weekly_bookings: {
    key: "weekly_bookings",
    label: "Bookings",
    direction: "up",
    unit: "count",
    window_kind: "rolling_7d",
    source: "operator_db",
  },
  ads_spend_7d: {
    key: "ads_spend_7d",
    label: "Ad spend",
    direction: "context",
    unit: "usd",
    window_kind: "rolling_7d",
    source: "meta_ads",
  },
  ads_cpa_7d: {
    key: "ads_cpa_7d",
    label: "Ad CPA",
    direction: "down",
    unit: "usd",
    window_kind: "rolling_7d",
    source: "meta_ads",
  },
  google_ads_spend_7d: {
    key: "google_ads_spend_7d",
    label: "Google Ads spend",
    direction: "context",
    unit: "usd",
    window_kind: "rolling_7d",
    source: "google_ads",
  },
  google_ads_cpa_7d: {
    key: "google_ads_cpa_7d",
    label: "Google Ads CPA",
    direction: "down",
    unit: "usd",
    window_kind: "rolling_7d",
    source: "google_ads",
  },
  stripe_mrr: {
    key: "stripe_mrr",
    label: "MRR",
    direction: "up",
    unit: "usd",
    window_kind: "point",
    source: "stripe",
  },
};

export function classifyGoalMetricKey(target_metric: string): string | null {
  const source = classifyTargetMetric(target_metric);
  switch (source.kind) {
    case "native_funnel":
      return source.step === "signup" ? "weekly_signups" : null;
    case "operator_funnel":
      return "weekly_bookings";
    case "stripe_mrr":
      return "stripe_mrr";
    default:
      return null;
  }
}

export type CatalogUnit = "currency" | "count" | "ratio" | "seconds" | "position";

export type CatalogSource =
  | "stripe"
  | "meta_ads"
  | "google_ads"
  | "google_analytics"
  | "google_search_console"
  | "operator_db"
  | "derived";

export type CatalogGrain = "day" | "week" | "month";

export type CatalogBreakdown = "campaign" | "source_medium" | "device" | "country" | "landing_page" | "query" | "page" | "platform";

export const CATALOG_BREAKDOWNS = ["campaign", "source_medium", "device", "country", "landing_page", "query", "page", "platform"] as const satisfies readonly CatalogBreakdown[];

export type CatalogMetricMeta = {
  id: string;
  label: string;
  unit: CatalogUnit;
  direction: "up" | "down" | "context";
  source: CatalogSource;
  needs: string[];
  needs_any?: string[];
  grains: CatalogGrain[];
  breakdowns: CatalogBreakdown[];
  point_in_time?: boolean;
  definition: string;
  caveats: string[];
  outcome?: true;
};

const ALL_GRAINS: CatalogGrain[] = ["day", "week", "month"];

const PLATFORM_REPORTED =
  "Platform-reported: the ad platform's own attribution, not verified against your sales.";
const AD_ACCOUNT_DAYS = "Days are the ad account's calendar days, in the ad account's time zone.";

function adMetrics(platform: "meta" | "google"): CatalogMetricMeta[] {
  const source: CatalogSource = platform === "meta" ? "meta_ads" : "google_ads";
  const name = platform === "meta" ? "Meta" : "Google Ads";
  const convDef =
    platform === "meta"
      ? "purchases + checkouts initiated + registrations"
      : "the account's conversion actions counted in Conversions";
  const valueDef = platform === "meta" ? "purchase conversion value" : "conversion value";
  const base = { source, needs: [source as string], grains: ALL_GRAINS };
  return [
    {
      ...base,
      breakdowns: ["campaign"],
      id: `${platform}_ad_spend`,
      label: `${name} spend`,
      unit: "currency",
      direction: "context",
      definition: `Amount spent across every ${name} campaign (any status) in the window, in the ad account's currency.`,
      caveats: [AD_ACCOUNT_DAYS],
    },
    {
      ...base,
      breakdowns: ["campaign"],
      id: `${platform}_clicks`,
      label: `${name} clicks`,
      unit: "count",
      direction: "up",
      definition:
        platform === "meta"
          ? "All clicks Meta reports (not only link clicks) across every campaign."
          : "Clicks across every Google Ads campaign.",
      caveats: [AD_ACCOUNT_DAYS],
    },
    {
      ...base,
      breakdowns: ["campaign"],
      id: `${platform}_cpc`,
      label: `${name} cost per click`,
      unit: "currency",
      direction: "down",
      definition: `${name} spend / ${name} clicks, from the same rows.`,
      caveats: [AD_ACCOUNT_DAYS],
    },
    {
      ...base,
      breakdowns: ["campaign"],
      id: `${platform}_conversions`,
      label: `${name} conversions (platform-reported)`,
      unit: "count",
      direction: "up",
      definition: `Conversions ${name} attributes to its own ads: ${convDef}.`,
      caveats: [PLATFORM_REPORTED, AD_ACCOUNT_DAYS, "The most recent ~3 days are still collecting late conversions."],
    },
    {
      ...base,
      breakdowns: ["campaign"],
      id: `${platform}_cpa`,
      label: `${name} cost per conversion (platform-reported)`,
      unit: "currency",
      direction: "down",
      definition: `${name} spend / ${name} platform-reported conversions.`,
      caveats: [PLATFORM_REPORTED, AD_ACCOUNT_DAYS],
    },
    {
      ...base,
      breakdowns: ["campaign"],
      id: `${platform}_roas`,
      label: `${name} ROAS (platform-reported)`,
      unit: "ratio",
      direction: "up",
      definition: `${name} ${valueDef} / ${name} spend. A ratio: 2.5 means 2.5x.`,
      caveats: [PLATFORM_REPORTED, AD_ACCOUNT_DAYS],
    },
  ];
}

const GA4_DAYS = "Days are the GA4 property's calendar days, in the property's time zone.";
const GSC_DAYS = "Search Console days are Pacific time, and the last 2-3 days are usually incomplete.";
const CONFIRMED_ONLY = "Only read through a table/field mapping the founder confirmed; never a guessed table.";

const CATALOG_LIST: CatalogMetricMeta[] = [
  {
    id: "net_revenue",
    label: "Net revenue",
    unit: "currency",
    direction: "up",
    source: "stripe",
    needs: ["stripe"],
    grains: ALL_GRAINS,
    breakdowns: [],
    definition:
      "Stripe balance transactions in the revenue reporting categories (charge, refund, refund_failure, dispute, dispute_reversal, partial_capture_reversal), summed on `net`: charges after Stripe's processing fees, minus refunds and disputes. Payouts, transfers and Stripe billing fees are not revenue and are excluded.",
    caveats: ["Dated by when the money moved in Stripe, not by when the order was placed."],
  },
  {
    id: "gross_revenue",
    label: "Gross revenue",
    unit: "currency",
    direction: "up",
    source: "stripe",
    needs: ["stripe"],
    grains: ALL_GRAINS,
    breakdowns: [],
    definition:
      "Stripe balance transactions with reporting category `charge`, summed on `amount`: before fees, refunds and disputes.",
    caveats: ["Dated by when the charge landed in the Stripe balance."],
  },
  {
    id: "refunds",
    label: "Refunds",
    unit: "currency",
    direction: "down",
    source: "stripe",
    needs: ["stripe"],
    grains: ALL_GRAINS,
    breakdowns: [],
    definition:
      "Money returned through Stripe refunds (reporting category `refund`, less `refund_failure`), as a positive amount. Disputes are not refunds and are not counted here.",
    caveats: ["Dated by the refund, not by the original charge."],
  },
  {
    id: "mrr",
    label: "MRR",
    unit: "currency",
    direction: "up",
    source: "stripe",
    needs: ["stripe"],
    grains: ["day"],
    breakdowns: [],
    point_in_time: true,
    definition: "Monthly recurring revenue of ACTIVE Stripe subscriptions right now, each price normalised to a month.",
    caveats: [
      "A reading of now: the requested window and compare are not applied.",
      "Trialing, past_due and paused subscriptions are excluded.",
    ],
  },
  {
    id: "new_customers",
    label: "New customers",
    unit: "count",
    direction: "up",
    source: "stripe",
    needs: ["stripe"],
    grains: ALL_GRAINS,
    breakdowns: [],
    definition: "Stripe customer records created in the window.",
    caveats: ["A Stripe customer is not always a paying customer. Deleted customer records are not counted."],
  },
  ...adMetrics("meta"),
  ...adMetrics("google"),
  {
    id: "ad_spend_total",
    label: "Total ad spend",
    unit: "currency",
    direction: "context",
    source: "derived",
    needs: [],
    needs_any: ["meta_ads", "google_ads"],
    grains: ALL_GRAINS,
    breakdowns: ["platform"],
    definition: "Meta spend + Google Ads spend over the same days, only when both accounts use the same currency.",
    caveats: [AD_ACCOUNT_DAYS, "Covers Meta and Google Ads only."],
  },
  {
    id: "sessions",
    label: "Sessions",
    unit: "count",
    direction: "up",
    source: "google_analytics",
    needs: ["google_analytics"],
    grains: ALL_GRAINS,
    breakdowns: ["source_medium", "device", "country", "landing_page"],
    definition: "GA4 `sessions` on the connected property.",
    caveats: [GA4_DAYS],
  },
  {
    id: "users",
    label: "Users",
    unit: "count",
    direction: "up",
    source: "google_analytics",
    needs: ["google_analytics"],
    grains: ALL_GRAINS,
    breakdowns: ["source_medium", "device", "country", "landing_page"],
    definition: "GA4 `totalUsers`: distinct users, counted once per period (a week is not the sum of its days).",
    caveats: [GA4_DAYS],
  },
  {
    id: "key_events",
    label: "Key events",
    unit: "count",
    direction: "up",
    source: "google_analytics",
    needs: ["google_analytics"],
    grains: ALL_GRAINS,
    breakdowns: ["source_medium", "device", "country", "landing_page"],
    definition: "GA4 `keyEvents`: every event the property marks as a key event (formerly 'conversions').",
    caveats: [GA4_DAYS, "Counts events, so one visitor can count more than once."],
  },
  {
    id: "conversion_rate",
    label: "Conversion rate",
    unit: "ratio",
    direction: "up",
    source: "google_analytics",
    needs: ["google_analytics"],
    grains: ALL_GRAINS,
    breakdowns: ["source_medium", "device", "country", "landing_page"],
    definition: "GA4 key events / GA4 sessions, from the same rows. A ratio: 0.03 means 3%.",
    caveats: [GA4_DAYS, "Key events per session, so it can exceed 1 when sessions fire several key events."],
  },
  {
    id: "search_clicks",
    label: "Search clicks",
    unit: "count",
    direction: "up",
    source: "google_search_console",
    needs: ["google_search_console"],
    grains: ALL_GRAINS,
    breakdowns: ["query", "page"],
    definition: "Clicks from Google web search results to the connected site.",
    caveats: [GSC_DAYS],
  },
  {
    id: "search_impressions",
    label: "Search impressions",
    unit: "count",
    direction: "up",
    source: "google_search_console",
    needs: ["google_search_console"],
    grains: ALL_GRAINS,
    breakdowns: ["query", "page"],
    definition: "Times the site appeared in Google web search results.",
    caveats: [GSC_DAYS],
  },
  {
    id: "search_ctr",
    label: "Search click-through rate",
    unit: "ratio",
    direction: "up",
    source: "google_search_console",
    needs: ["google_search_console"],
    grains: ALL_GRAINS,
    breakdowns: ["query", "page"],
    definition: "Search clicks / search impressions. A ratio: 0.02 means 2%.",
    caveats: [GSC_DAYS],
  },
  {
    id: "search_avg_position",
    label: "Average search position",
    unit: "position",
    direction: "down",
    source: "google_search_console",
    needs: ["google_search_console"],
    grains: ALL_GRAINS,
    breakdowns: ["query", "page"],
    definition: "Average ranking position in Google web search, weighted by impressions. Lower is better.",
    caveats: [GSC_DAYS, "Impression-weighted across days, so it can differ slightly from the Search Console chart."],
  },
  {
    id: "signups",
    label: "Signups",
    unit: "count",
    direction: "up",
    source: "operator_db",
    needs: ["operator_db"],
    grains: ALL_GRAINS,
    breakdowns: [],
    definition: "Rows created in the window in the table the founder confirmed as users/accounts, by its created-at field.",
    caveats: [CONFIRMED_ONLY],
  },
  {
    id: "bookings",
    label: "Bookings / orders",
    unit: "count",
    direction: "up",
    source: "operator_db",
    needs: ["operator_db"],
    grains: ALL_GRAINS,
    breakdowns: [],
    definition:
      "Rows created in the window in the table the founder confirmed as bookings/orders, by the created-at field they confirmed.",
    caveats: [CONFIRMED_ONLY, "Every row counts whatever its status, so cancelled orders are included."],
  },
  {
    id: "cac",
    label: "CAC (blended)",
    unit: "currency",
    direction: "down",
    source: "derived",
    needs: ["stripe"],
    needs_any: ["meta_ads", "google_ads"],
    grains: ALL_GRAINS,
    breakdowns: [],
    definition: "Total ad spend (Meta + Google Ads) / new Stripe customers, over the same days.",
    caveats: [
      "Blended: every new customer counts, including ones no ad brought in.",
      "Only computed when every connected ad account shares one currency.",
    ],
  },
  {
    id: "blended_roas",
    label: "Blended ROAS",
    unit: "ratio",
    direction: "up",
    source: "derived",
    needs: ["stripe"],
    needs_any: ["meta_ads", "google_ads"],
    grains: ALL_GRAINS,
    breakdowns: [],
    definition: "Stripe net revenue / total ad spend (Meta + Google Ads), over the same days. A ratio: 3 means 3x.",
    caveats: [
      "Blended: all revenue counts, not only revenue ads brought in.",
      "Only computed when Stripe and the ad accounts share one currency.",
    ],
  },
  {
    id: "first_completed_cac",
    label: "Blended CAC per new customer (first finished order, first seen in your connected data)",
    unit: "currency",
    direction: "down",
    source: "derived",
    needs: ["operator_db"],
    needs_any: ["meta_ads", "google_ads"],
    grains: ALL_GRAINS,
    breakdowns: [],
    outcome: true,
    definition:
      "Meta + Google Ads spend / customers whose FIRST finished order (founder-confirmed finish date, customer and finished statuses) falls on those days, each customer's first finish taken over all connected history.",
    caveats: [
      "Blended: every new customer counts, including ones no ad brought in. Per-channel CAC needs an attribution mapping, which is not set up.",
      "New = first seen in your connected data: orders from before the database was connected are not visible.",
      "Period spend over customers who first finished in the period; not the cohort of customers acquired with that spend.",
      "The founder confirmed that one row of the orders table is one order.",
    ],
  },
  {
    id: "completed_net_roas",
    label: "Blended ROAS on finished orders (net revenue by finish date)",
    unit: "ratio",
    direction: "up",
    source: "derived",
    needs: ["operator_db"],
    needs_any: ["meta_ads", "google_ads"],
    grains: ALL_GRAINS,
    breakdowns: [],
    outcome: true,
    definition:
      "Net revenue (confirmed revenue minus confirmed refund) of orders with a finished status, dated by when they finished, / Meta + Google Ads spend on those days. A ratio: 3 means 3x.",
    caveats: [
      "Blended: all finished revenue counts, not only revenue ads brought in. Per-channel ROAS needs an attribution mapping, which is not set up.",
      "Revenue is dated by finish, spend by when it was spent: a calendar reconciliation, not the return on one period's spend.",
      "The founder confirmed that one row of the orders table is one order.",
    ],
  },
];

export const METRIC_CATALOG: Readonly<Record<string, CatalogMetricMeta>> = Object.freeze(
  Object.fromEntries(CATALOG_LIST.map((m) => [m.id, m])),
);

export const CATALOG_METRIC_IDS = CATALOG_LIST.map((m) => m.id) as [string, ...string[]];
