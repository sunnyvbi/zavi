
import { GADS_METRICS } from "./_shared";
import type { PlatformSpec } from "./_shared";

export const google_ads: PlatformSpec = {
    name: "Google Ads",
  createMenu: "Create",
  topActions: [{ key: "new_campaign", label: "Create campaign", modal: "google_campaign" }],
    description: "Reviews your campaigns and proposes changes you approve",
  manageUrl: "https://ads.google.com/aw/campaigns",
    maxWidth: "max-w-[1180px]",
    sectionTitle: "What Zavi wants to do",
    paidAnalytics: "google",
  kpiFallback: "gads",
    metricDisplay: GADS_METRICS,
    metricLayout: { lead: ["spend", "cpa", "pacing"], pacingKey: "pacing" },
    connect: () =>
      import("@/app/connectors/GoogleAdsConnectButton").then((m) => m.startGoogleAdsConnect()),
    extras: ["campaign_table"],
    settings: [
      {
        kind: "list",
        id: "negatives",
        label: "Negative keywords",
        help: "Searches Zavi will not let your ads show on. It never removes one you added.",
        itemTypes: ["phrase", "exact", "broad"],
      },
      {
        kind: "number",
        id: "budget",
        label: "Monthly budget",
        help: "The ceiling Zavi paces against. It will not propose past it.",
        prefix: "$",
        suffix: "a month",
        writesTo: "channel.monthly_budget",
      },
      {
        kind: "number",
        id: "tcpa",
        label: "Target cost per conversion",
        help: "What a booked job is worth paying for. Every proposal is judged against this.",
        prefix: "$",
        suffix: "per conversion",
      },
      {
        kind: "toggle",
        id: "maypause",
        label: "Pause a losing campaign",
        help: "Whether Zavi may propose a pause at all.",
        on: "Yes, propose it with the numbers",
        off: "No, never propose a pause",
        unsetIsOn: true,
      },
      {
        kind: "text",
        id: "landing_page",
        label: "Where a click should land",
        help: "The page Zavi checks against when it reads a campaign.",
        placeholder: "https://example.com/book",
      },
    ],
  };
