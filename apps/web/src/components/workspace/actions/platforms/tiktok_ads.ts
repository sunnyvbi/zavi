
import { TIKTOK_METRICS } from "./_shared";
import type { PlatformSpec } from "./_shared";
import { LINK, dailyBudget } from "../topActions/fieldSets";

export const tiktok_ads: PlatformSpec = {
  name: "TikTok Ads",
  createMenu: "Create",
  topActions: [
    { key: "create_campaign", label: "New campaign", modal: "tiktok_campaign" },
    {
      key: "create_new_ad",
      label: "Create new ad",
      modal: "plan",
      lead: "Pick the video and tell Zavi what the ad says. Zavi shows you the plan first.",
      note: "TikTok runs it as a traffic campaign and counts clicks and site visits, not sales.",
      hint: "Nothing goes live until an owner or admin approves it.",
      fields: [
        { kind: "text", name: "about", label: "What should the ad say?", max: 100, error: "Say what the ad should say." },
        LINK,
        dailyBudget("In US dollars, above TikTok's $20 minimum. Counts against your monthly ad budget.", "30", 20),
        { kind: "places", name: "places", label: "Where", optional: true, max: 25, hint: "Countries, states, cities or metro areas, up to 25. Leave empty and Zavi uses your business's country." },
        { kind: "multi_select", name: "age_groups", label: "Ages", allLabel: "All adult ages (18+)", max: 5, hint: "Leave empty to reach all adults.", options: [
          { id: "AGE_18_24", label: "18–24" }, { id: "AGE_25_34", label: "25–34" }, { id: "AGE_35_44", label: "35–44" }, { id: "AGE_45_54", label: "45–54" }, { id: "AGE_55_100", label: "55+" },
        ] },
        { kind: "choice", name: "gender", label: "Gender", initial: "GENDER_UNLIMITED", options: [
          { id: "GENDER_UNLIMITED", label: "All genders", sub: "" }, { id: "GENDER_FEMALE", label: "Female", sub: "" }, { id: "GENDER_MALE", label: "Male", sub: "" },
        ] },
        { kind: "multi_select", name: "languages", label: "Languages", from: "languages", allLabel: "All languages", max: 50, hint: "Leave empty to reach all languages. This doesn't translate the ad." },
        { kind: "video", name: "video", label: "Video", from: "videos" },
      ],
    },
  ],
  manageUrl: "https://ads.tiktok.com/i18n/manage/campaign",
  maxWidth: "max-w-[1180px]",
  paidAnalytics: "tiktok",
  kpiFallback: "tiktok_ads",
  metricDisplay: TIKTOK_METRICS,
  metricLayout: { lead: ["spend", "cpa", "conversions"] },
  extras: ["campaign_table"],
  adAccountPicker: "tiktok_ads",
  spendSettings: true,
  settings: [
    {
      kind: "text",
      id: "landing_page",
      label: "Where a TikTok tap lands",
      help: "Tell Zavi which page a paid tap should land on. It goes to the next run, which checks that page for the TikTok pixel and reads it the way a phone would.",
      placeholder: "https://example.com/book",
    },
    {
      kind: "text",
      id: "tiktok_handle",
      label: "Your TikTok handle",
      help: "The public account Zavi reads your posts from to find a Spark Ads candidate. Reading these posts does not spend money.",
      placeholder: "@yourbrand",
    },
  ],
};
