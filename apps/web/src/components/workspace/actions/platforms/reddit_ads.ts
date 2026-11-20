
import { REDDIT_ADS_METRICS } from "./_shared";
import type { PlatformSpec } from "./_shared";
import { ABOUT, LINK, dailyBudget } from "../topActions/fieldSets";
import type { TopActionField } from "../platformSpec";

export const reddit_ads: PlatformSpec = {
  name: "Reddit Ads",
  createMenu: "Create",
  topActions: [
    {
      key: "create_new_ad",
      label: "Create new ad",
      modal: "plan",
      hint: "Created paused. Turning it on is a separate approval.",
      note: "Zavi sets the most it can spend in total (a week at this budget, at least Reddit's $100 minimum) and shows it in the plan before you approve.",
      fields: [
        ABOUT,
        LINK,
        { ...dailyBudget("In US dollars. Reddit needs at least $5 a day. Counts against your monthly ad budget."), atLeast: 5, error: "Enter at least 5. Reddit needs at least $5 a day." } as TopActionField,
        { kind: "countries", name: "countries", label: "Target countries", placeholder: "Search for a country", optional: true, notIn: "excluded_countries", takenLabel: "Excluded", hint: "Leave empty to use your business's country." },
        { kind: "countries", name: "excluded_countries", label: "Exclude countries", placeholder: "Search for a country", optional: true, notIn: "countries", takenLabel: "Targeted", hint: "Ads won't show in these countries. Optional." },
      ],
    },
    {
      key: "write_ad_copy",
      label: "Write ad copy",
      modal: "form",
      lead: "Three ad variants for one community, written for how that community talks. You can use them anywhere.",
      primary: "Write 3 ads",
      hint: "Drafts only. Nothing changes in your Reddit account.",
      done: "Zavi is writing them now. The three drafts land in What Zavi wants to do.",
      fields: [{ kind: "text", name: "community", label: "Community", placeholder: "r/smallbusiness", max: 200, error: "Enter a community like r/smallbusiness." }],
    },
  ],
  description: "Picks the communities to target and writes three ads for them",
  manageUrl: "https://ads.reddit.com",
  spendSettings: true,
  maxWidth: "max-w-[1180px]",
  paidAnalytics: "reddit",
  kpiFallback: "reddit_ads",
  metricDisplay: REDDIT_ADS_METRICS,
  metricLayout: { lead: ["spend", "cpa", "conversions"] },
  extras: ["campaign_table"],
  settings: [
    {
      kind: "toggle",
      id: "comments_on",
      label: "Can someone answer comments on an ad?",
      help: "Reddit ads default to comments off. Say yes only if a real person will be there to reply.",
      on: "Yes, someone will answer them",
      off: "No, keep comments off",
    },
    {
      kind: "text",
      id: "landing_page",
      label: "Where a Reddit click lands",
      help: "Tell Zavi which page a paid click should land on. It goes to the next run, which reads that page and judges whether it matches the ad's register.",
      placeholder: "https://example.com/start",
    },
  ],
};
