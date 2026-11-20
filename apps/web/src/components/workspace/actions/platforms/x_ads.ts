import { X_ADS_METRICS } from "./_shared";
import type { PlatformSpec } from "./_shared";
import type { TopActionField } from "../platformSpec";
import { APPROVAL, dailyBudget } from "../topActions/fieldSets";

const GOAL_OPTIONS = [
  { id: "engage", label: "Get engagement", sub: "Likes, replies, reposts and profile visits." },
  { id: "visit", label: "Send people to a site", sub: "Clicks on the link in the post. Every post needs a link." },
  { id: "reach", label: "Reach more people", sub: "Shown to as many people as the budget allows." },
] as const;
const GOAL: TopActionField = {
  kind: "choice",
  name: "goal",
  label: "What should the ad do?",
  initial: "engage",
  options: [...GOAL_OPTIONS, { id: "video", label: "Get video views", sub: "Every post needs a video." }],
};
const NEW_AD_GOAL: TopActionField = { kind: "choice", name: "goal", label: "What should the ad do?", initial: "engage", options: GOAL_OPTIONS };

const DURATION: TopActionField = {
  kind: "choice",
  name: "duration",
  label: "How long",
  initial: "open",
  options: [
    { id: "open", label: "Until you stop it", sub: "No end date. Pause it any time." },
    { id: "7", label: "1 week", sub: "Stops on its own after 7 days." },
    { id: "14", label: "2 weeks", sub: "Stops on its own after 14 days." },
    { id: "30", label: "30 days", sub: "Stops on its own after 30 days." },
  ],
};

const CAMPAIGN_FIELDS: readonly TopActionField[] = [
  dailyBudget("In your X Ads account's currency. Counts against your monthly ad budget.", "15"),
  { kind: "money", name: "total_budget", label: "Total spend cap", optional: true, hint: "X stops the campaign at this amount. Leave empty for no cap." },
  DURATION,
  { kind: "places", name: "places", label: "Target locations", from: "places", placeholder: "Search for a country, region or city", optional: true, max: 25, notIn: "excluded_places", takenLabel: "Excluded", hint: "Countries, regions, metro areas or cities. Starts with your business's country; empty means that country." },
  { kind: "places", name: "excluded_places", label: "Exclude locations", placeholder: "Search for a country, region or city", optional: true, max: 25, notIn: "places", takenLabel: "Targeted", hint: "Ads won't show in these places. Optional." },
  { kind: "text", name: "keywords", label: "Keywords (optional)", optional: true, max: 2000, placeholder: "saas, startup, founders", hint: "People who post about or search these, comma-separated, up to 50." },
  { kind: "text", name: "languages", label: "Languages (optional)", optional: true, max: 100, placeholder: "en, es", hint: "Two-letter codes. Empty means any language." },
  {
    kind: "choice",
    name: "gender",
    label: "Gender",
    initial: "any",
    options: [
      { id: "any", label: "Everyone", sub: "No gender filter." },
      { id: "men", label: "Men", sub: "" },
      { id: "women", label: "Women", sub: "" },
    ],
  },
  {
    kind: "choice",
    name: "age",
    label: "Age",
    initial: "any",
    options: [
      { id: "any", label: "All ages", sub: "No age filter." },
      { id: "18_34", label: "18 to 34", sub: "" },
      { id: "25_49", label: "25 to 49", sub: "" },
      { id: "35_plus", label: "35 and over", sub: "" },
      { id: "50_plus", label: "50 and over", sub: "" },
    ],
  },
];

export const x_ads: PlatformSpec = {
  name: "X Ads",
  createMenu: "Create",
  topActions: [
    {
      key: "promote_post",
      label: "Promote a post",
      modal: "plan",
      lead: "Promote 1 to 10 posts you already published from your X account.",
      note: `${APPROVAL} The campaign is created paused. Nothing spends until you turn it on.`,
      fields: [
        { kind: "area", name: "posts", label: "Posts", placeholder: "Paste post links, one per line", max: 4000, error: "Paste 1 to 10 links to your own X posts (x.com/<you>/status/…), one per line.", accepts: "x_posts" },
        GOAL,
        ...CAMPAIGN_FIELDS,
      ],
    },
    {
      key: "create_new_ad",
      label: "Create new ad",
      modal: "plan",
      lead: "Tell Zavi what the ad is about. It writes one post and shows you the plan first.",
      note: `${APPROVAL} The post is published promoted-only when you approve: it shows as an ad, never on your timeline. The campaign is created paused.`,
      fields: [
        { kind: "text", name: "about", label: "What is the ad about?", max: 200, error: "Say what the ad is about." },
        { kind: "url", name: "link", label: "Link (optional)", optional: true, hint: "Where people land when they tap. Starts with https://. Needed when the ad sends people to a site." },
        NEW_AD_GOAL,
        ...CAMPAIGN_FIELDS,
      ],
    },
  ],
  description: "Promotes your best posts on X and keeps spend on what converts",
  manageUrl: "https://ads.x.com",
  spendSettings: true,
  maxWidth: "max-w-[1180px]",
  paidAnalytics: "x",
  kpiFallback: "x_ads",
  metricDisplay: X_ADS_METRICS,
  metricLayout: { lead: ["spend", "cpa", "conversions"] },
  extras: ["campaign_table"],
  settings: [
    {
      kind: "text",
      id: "landing_page",
      label: "Where an X ad click lands",
      help: "Tell Zavi which page a paid click should land on. The next run reads it before picking which posts to promote.",
      placeholder: "https://example.com/start",
    },
  ],
};
