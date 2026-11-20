import { asDashboard, chatgptAccountReadable } from "../../chatgpt-ads/adapters";
import type { PlatformSpec } from "./_shared";
import { getChannel } from "@zavi/shared";
import { BadgePercent, ChartLine, CircleDollarSign, Goal, MousePointerClick } from "lucide-react";

export const chatgpt_ads: PlatformSpec = {
  adsAccountPlatform: "chatgpt",
  name: "ChatGPT Ads",
  topActions: [
    { key: "create_campaign", label: "Create campaign", modal: "chatgpt_campaign" },
  ],
  description: "Create campaigns with Zavi, review your ads, and track performance",
  requireActionResponsibility: getChannel("chatgpt_ads")?.require_action_responsibility,
  kpiFallback: "chatgpt",
  accountReadable: chatgptAccountReadable,
  execPartial: { href: "#campaigns", label: "Open campaign list" },
  campaignWorkspace: {
    channel: "chatgpt_ads",
    headerBalance: true,
    actionReviewPath: "/api/channels/chatgpt_ads/actions",
    safetyPath: "/api/channels/chatgpt_ads/safety",
    title: "ChatGPT Ads", apiBase: "/api/channels/chatgpt_ads", readDashboard: asDashboard,
    metrics: [
      { field: "spend", label: "Spend", help: "Across your campaigns", format: "money", icon: CircleDollarSign },
      { field: "impressions", label: "Impressions", help: "Times ChatGPT showed an ad", format: "count", icon: ChartLine },
      { field: "clicks", label: "Clicks", help: "Ad clicks reported by OpenAI", format: "count", icon: MousePointerClick },
      { field: "conversions", label: "Conversions", help: "From people who clicked an ad", format: "count", icon: Goal },
      { field: "roas", label: "Return on ad spend", help: "Attributed sales per dollar spent", format: "ratio", icon: BadgePercent },
    ],
    objectives: [
      { value: "clicks", label: "Clicks (CPC)", short: "Website visits", bidLabel: "Maximum cost-per-click bid", bidMicros: 1e6, automaticStrategy: "maximize_clicks", plainGoal: "Get people to visit {site}", plainBid: "Most you pay for one visit" },
      { value: "impressions", label: "Views (CPM)", short: "Awareness", bidLabel: "Maximum bid per 1,000 impressions", bidMicros: 1000, plainGoal: "Show your ad to as many people as possible", plainBid: "Most you pay for 1,000 views" },
      { value: "conversions", label: "Conversions (oCPC)", short: "Conversions", bidLabel: "Conversion bid (CPA)", bidMicros: 1e6, automaticStrategy: "maximize_conversions", requiresEvent: true, plainGoal: "Get customers who take your chosen action on {site}", plainBid: "Bid for one customer action", bidIsTarget: true, bidHint: "Billed per valid click, not per conversion. Actual cost per conversion can vary." },
    ],
    controls: { dailyMinimum: 25, platforms: [{ value: "web", label: "Web (desktop and mobile)" }, { value: "ios_app", label: "iOS app" }, { value: "android_app", label: "Android app" }], resources: true, productFeeds: true, previewUnavailableReason: "Provider previews are not available in Zavi yet. Review your copy, image and destination before activation." },
    creative: { label: "chat card", type: "chat_card", contextLabel: "Buyer context hints", titleLimit: 50, bodyLimit: 100, tracking: "utm_source=chatgpt&utm_medium=paid", contextPlain: "Shown when people ask ChatGPT about" },
    balance: { currency: "USD", minTopup: 100, maxTopup: 500000, minRefill: 5000, dailyRefillCap: 100000, threshold: 5000, presets: [50, 100, 250, 500] },
    empty: { title: "Create your first campaign with Zavi", body: "Review the researched draft, choose a budget and schedule, and save paused. Zavi handles advertiser setup before any ads can serve." },
  },
  settings: [
    {
      kind: "text", id: "landing_page", label: "Where a click should land",
      help: "The public page customers should reach. Zavi checks this page and uses it in your campaign draft.",
      placeholder: "https://example.com/book",
    },
    {
      kind: "number", id: "tcpa", label: "Target cost per customer",
      help: "Your target acquisition cost. This guides recommendations; approve the campaign's lifetime budget separately before saving.",
      prefix: "$", suffix: "per customer",
    },
  ],
};
