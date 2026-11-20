/* eslint-disable @next/next/no-img-element */

import type { ReactNode } from "react";
import {
  Camera,
  Clapperboard,
  FileSpreadsheet,
  FileText,
  Gauge,
  Image as ImageIcon,
  Images,
  MonitorPlay,
  PenLine,
  Presentation,
  Scale,
  Table2,
  type LucideIcon,
} from "lucide-react";
import { ALL_STARTERS, TOOLS_PATH } from "@/lib/workspace/starters";
import { StepGlyph } from "./stepIcons";
import { CHANNEL_PAGES, CHANNELS_PATH, ChannelGlyph } from "./channels/channelPages";
import { USE_CASES, USE_CASES_PATH, pathForUseCase } from "@/lib/marketing/useCases";

export type NavItem = {
  id: string;
  name: string;
  blurb: string;
  icon: ReactNode;
  href: string;
  soon?: boolean;
  tag?: string;
};

export type NavMenu = {
  label: string;
  items: NavItem[];
  aside?: { title: string; body: string; cta: string; href: string; link?: { label: string; href: string } };
  panel?: "useCases";
  more?: { label: string; href: string };
  groups?: { label: string; ids: string[] }[];
};

const CHANNEL_BLURB: Record<string, string> = {
  "meta-ads": "Move budget to what sells.",
  "google-ads": "Cut wasted search spend.",
  "tiktok-ads": "Test creative, scale winners.",
  "reddit-ads": "Reach niche communities.",
  "linkedin-ads": "Target by role and company.",
  "youtube-ads": "Run and trim video campaigns.",
  seo: "Close the content gaps.",
  geo: "Get cited by AI answers.",
  email: "Draft and schedule sends.",
  sms: "Short, timed nudges.",
  instagram: "Plan posts and Reels.",
  x: "Draft threads in your voice.",
  reddit: "Join the right threads.",
  youtube: "Hooks, briefs, and clips.",
  tiktok: "Short video ideas that land.",
  ugc: "Brief creators, clear rights.",
};

const CHANNELS: NavItem[] = CHANNEL_PAGES.map((c) => ({
  id: c.id,
  name: c.name,
  blurb: CHANNEL_BLURB[c.id] ?? "",
  icon: <ChannelGlyph channel={c} />,
  href: `/channels/${c.id}`,
}));

const glyph = (name: string) => <StepGlyph name={name} className={name === "X" ? "h-5 w-5" : "h-6 w-6"} />;

const INTEGRATIONS: NavItem[] = [
  { id: "google-analytics", name: "Google Analytics", blurb: "Traffic, conversions, and audience behavior.", icon: glyph("Google Analytics") },
  { id: "google-search-console", name: "Google Search Console", blurb: "Search performance and indexing health.", icon: glyph("Google Search Console") },
  { id: "hubspot", name: "HubSpot", blurb: "Contacts, deals, and marketing activity.", icon: glyph("HubSpot") },
  { id: "salesforce", name: "Salesforce", blurb: "Pipeline, opportunities, and account data.", icon: glyph("Salesforce") },
  { id: "slack", name: "Slack", blurb: "Bring Zavi into your team's conversations.", icon: glyph("Slack") },
  { id: "meta-ads", name: "Meta Ads", blurb: "Campaign spend and performance across Meta.", icon: glyph("Meta Ads") },
  { id: "google-ads", name: "Google Ads", blurb: "Search and display campaign performance.", icon: glyph("Google Ads") },
  { id: "linkedin", name: "LinkedIn", blurb: "Company page activity and ad performance.", icon: glyph("LinkedIn") },
  { id: "shopify", name: "Shopify", blurb: "Orders, products, and storefront analytics.", icon: glyph("Shopify") },
  { id: "tiktok", name: "TikTok", blurb: "Organic reach and TikTok Ads performance.", icon: glyph("TikTok") },
  { id: "reddit", name: "Reddit", blurb: "Community posts and Reddit Ads.", icon: glyph("Reddit") },
  { id: "x", name: "X", blurb: "Posts, replies, and ad performance on X.", icon: glyph("X") },
  { id: "youtube", name: "YouTube", blurb: "Channel growth and YouTube Ads.", icon: glyph("YouTube") },
  { id: "instagram", name: "Instagram", blurb: "Posts, Reels, and audience growth.", icon: glyph("Instagram") },
  {
    id: "teams",
    name: "Microsoft Teams",
    blurb: "Bring Zavi into your team's chats.",
    icon: <img src="/marketing/growth-home/logos/teams.svg" alt="" width={24} height={24} className="h-6 w-6" />,
  },
].map((c) => ({ ...c, href: "/start" }));

const TOOL_MENU: { id: string; name: string; blurb: string; Icon: LucideIcon; color: string }[] = [
  { id: "deck", name: "A deck you can present", blurb: "16:9 PDF plus a browser link.", Icon: Presentation, color: "text-[#7c3aed]" },
  { id: "board-update", name: "A board or investor update", blurb: "Claim-led slides, verifiable numbers.", Icon: Presentation, color: "text-[#5b21b6]" },
  { id: "monthly-report", name: "A report on the business", blurb: "A PDF, attached to the reply.", Icon: FileText, color: "text-[#027bff]" },
  { id: "evidence-packet", name: "A document that makes a case", blurb: "What happened, and what to do.", Icon: Scale, color: "text-[#0369a1]" },
  { id: "blog-post", name: "A blog post, ready to publish", blurb: "Finished piece with hero images.", Icon: PenLine, color: "text-[#167f50]" },
  { id: "xlsx", name: "A spreadsheet you can pivot", blurb: "Typed columns, real numbers.", Icon: Table2, color: "text-[#946300]" },
  { id: "csv", name: "A CSV for another system", blurb: "Rows you can import elsewhere.", Icon: FileSpreadsheet, color: "text-[#a16207]" },
  { id: "social-post", name: "A branded post image", blurb: "Three treatments, your brand colours.", Icon: ImageIcon, color: "text-[#e11d48]" },
  { id: "carousel", name: "A swipeable carousel", blurb: "Two to ten ordered slides.", Icon: Images, color: "text-[#be123c]" },
  { id: "plain-image", name: "A plain photo, no words", blurb: "Up to five images per request.", Icon: Camera, color: "text-[#9f1239]" },
  { id: "wireframe", name: "A clickable prototype", blurb: "A working screen, not a description.", Icon: MonitorPlay, color: "text-[#0e0f11]" },
];

const GROWTH_SCORE_PATH = "/start";
const LEADERBOARD_PATH = "/growth";

const TOOLS: NavItem[] = [
  {
    id: "growth-score",
    name: "Growth score",
    blurb: "See where your site ranks.",
    icon: <Gauge aria-hidden="true" className="h-5 w-5 text-[#167f50]" />,
    href: GROWTH_SCORE_PATH,
    tag: "Free",
  },
  {
    id: "launch-video",
    name: "A launch video",
    blurb: "No account needed. Just an email.",
    icon: <Clapperboard aria-hidden="true" className="h-5 w-5 text-[#0064E0]" />,
    href: "/launch-video",
  },
  ...TOOL_MENU.flatMap((m) => {
    const s = ALL_STARTERS.find((x) => x.id === m.id);
    if (!s) return [];
    return [
      {
        id: s.id,
        name: m.name,
        blurb: m.blurb,
        icon: <m.Icon aria-hidden="true" className={`h-5 w-5 ${m.color}`} />,
        href: TOOLS_PATH,
      },
    ];
  }),
];

const USE_CASE_ITEMS: NavItem[] = USE_CASES.map((u) => ({
  id: u.slug,
  name: u.name,
  blurb: u.outcome,
  icon: <u.icon aria-hidden="true" className={`h-5 w-5 ${u.color}`} />,
  href: pathForUseCase(u.slug),
}));

export const NAV_MENUS = {
  channels: {
    label: "Channels",
    items: CHANNELS,
    more: { label: "See all channels", href: CHANNELS_PATH },
    aside: {
      title: "One agent across all of them.",
      body: "Zavi reads every channel you connect, finds what is quietly costing you money, and proposes the fix. Changes wait for your yes, or you set a spend cap the ad agents stay inside.",
      cta: "See what Zavi would change",
      href: "/start",
    },
  },
  tools: {
    label: "Tools",
    items: TOOLS,
    aside: {
      title: "Where does your site rank?",
      body: "The free growth check scores your site on Google, AI answers, SEO, design and competitors, then ranks it on the leaderboard. Free. Sign in with Google to see it.",
      cta: "Get your growth score",
      href: GROWTH_SCORE_PATH,
      link: { label: "See this week's leaderboard", href: LEADERBOARD_PATH },
    },
    more: { label: "See all tools", href: TOOLS_PATH },
  },
  useCases: {
    label: "Use case",
    items: USE_CASE_ITEMS,
    panel: "useCases",
    more: { label: "See all use cases", href: USE_CASES_PATH },
    groups: [
      { label: "Online businesses", ids: ["saas", "startups", "ecommerce", "marketplaces"] },
      { label: "Local businesses", ids: ["restaurants", "local-services", "healthcare", "real-estate", "small-business"] },
      { label: "Professional firms", ids: ["professional-services", "law-firms", "financial-advisors", "agencies"] },
    ],
  },
  integration: {
    label: "Integration",
    items: INTEGRATIONS,
    aside: {
      title: "Connect in two clicks.",
      body: "Every recommendation is grounded in the real numbers from your own tools, not a guess. Start with whichever channel costs you most.",
      cta: "Connect a channel",
      href: "/start",
    },
  },
} satisfies Record<string, NavMenu>;

export type NavMenuKey = keyof typeof NAV_MENUS;

export const NAV_LINKS = [
  { label: "Leaderboard", href: "/growth" },
  { label: "Pricing", href: "/pricing" },
] as const;
