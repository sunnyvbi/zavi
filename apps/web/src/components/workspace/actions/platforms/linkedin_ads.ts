
import { LINKEDIN_ADS_METRICS } from "./_shared";
import type { PlatformSpec } from "./_shared";

const LINKEDIN_CARD_NOTICE = /^(Turned the ad |Edited the campaign group |Archived the |Deleted the |Copied the |Created the campaign |Replaced the ad |Added ad |The (ad|campaign|campaign group) ".*" was already |An? (ad|campaign) named ".*" already exists)/;

export const linkedin_ads: PlatformSpec = {
  adsAccountPlatform: "linkedin",
  compactSections: true,
  name: "LinkedIn Ads",
  createMenu: "Create",
  topActions: [
    {
      key: "boost_post",
      label: "Boost a Page post",
      modal: "form",
      submit: "linkedin_campaign_draft",
      lead: "Run a post from your company Page as a sponsored post.",
      note: "Zavi opens a campaign draft. You pick the company post, the daily budget and the country, then Zavi creates it paused in Campaign Manager. Nothing spends until you launch it.",
      primary: "Prepare the campaign",
      hint: "Created paused. Nothing spends until you launch it.",
      ownersOnly: "Only workspace owners and admins can prepare LinkedIn campaigns.",
    },
  ],
  description: "Picks the audience by job role and writes ads ready to launch",
  manageUrl: "https://www.linkedin.com/campaignmanager/accounts",
  taskLink: (targetKind, accountId) =>
    !accountId
      ? null
      : targetKind === "audience"
        ? `https://www.linkedin.com/campaignmanager/accounts/${accountId}/audiences/saved`
        : targetKind === "tracking"
          ? `https://www.linkedin.com/campaignmanager/accounts/${accountId}/insight-tag`
          : targetKind === "billing"
            ? `https://www.linkedin.com/campaignmanager/accounts/${accountId}/billing`
            : `https://www.linkedin.com/campaignmanager/accounts/${accountId}/campaigns`,
  taskLinkLabel: "Open Campaign Manager",
  maxWidth: "max-w-[1180px]",
  kpiFallback: "linkedin_ads",
  hideRunCost: true,
  connect: () =>
    import("@/app/connectors/ConnectButton").then((m) => m.startConnectFlow("linkedin_ads", { returnHere: true })),
  metricDisplay: LINKEDIN_ADS_METRICS,
  sponsoredPostReview: { actionReviewPath: "/api/channels/linkedin_ads/actions", title: "LinkedIn" },
  execCopy: {
    working: "Zavi is making this change in LinkedIn Campaign Manager…",
    done: "Done in LinkedIn Campaign Manager.",
    doneFor: (a) =>
      a.exec_notice && (a.action_type === "other" || LINKEDIN_CARD_NOTICE.test(a.exec_notice))
        ? a.exec_notice
        : a.action_type === "create_ad"
        ? a.body?.exact_change?.rows?.some((r) => r.item === "Funding" && r.after === "Shared Zavi ads balance")
          ? "Created paused in Zavi's managed LinkedIn ad account, paid from your shared ads balance. Nothing spends until you launch it from this channel in Zavi."
          : "Created in LinkedIn Campaign Manager, paused. Nothing spends until you launch it."
        : a.action_type === "pause_ad"
          ? a.exec_notice && !a.exec_notice.startsWith("Paused ")
            ? a.exec_notice
            : "Paused in LinkedIn Campaign Manager. It stops spending until someone turns it back on."
          : a.action_type === "update_ad"
            ? "Launched. The campaign is live in LinkedIn Campaign Manager."
            : "Done in LinkedIn Campaign Manager.",
    failedTitle: "LinkedIn did not accept this change",
    partialTitle: "This may have reached LinkedIn",
    failedHint: "Nothing was changed twice. Open Campaign Manager to check before trying again.",
  },
  execPartial: { href: "https://www.linkedin.com/campaignmanager/accounts", label: "Open Campaign Manager" },
  metricLayout: { lead: ["spend", "leads", "cpl"] },
  extras: ["campaign_group_table", "campaign_table", "ads_table"],
  settings: [
    {
      kind: "number",
      id: "deal_value",
      label: "What one new customer is worth in year one",
      help: "What one new customer pays you in year one. Zavi uses it as the break-even check against LinkedIn's own published test floors. It is not a budget and it spends nothing.",
      prefix: "$",
      suffix: "in year one",
      min: 0,
    },
    {
      kind: "text",
      id: "landing_page",
      label: "Where a LinkedIn click lands",
      help: "Tell Zavi which page a paid click should land on. It goes to the next run, which reads that page and looks for the Insight Tag.",
      placeholder: "https://example.com/demo",
    },
  ],
};
