import { CHANNELS, RETIRED_CHANNEL_SLUGS } from "@zavi/shared";

export const PITCH: Record<string, string> = {
  meta_ads: "Reaches buyers on Facebook and Instagram who look like your best customers. Zavi reads what each ad set brings in and moves budget to the ones that book.",
  google_ads: "Puts you in front of people already searching for what you sell. Zavi finds which searches turn into customers and spends more there.",
  youtube_ads: "Video ads that reach people while they watch, before they know your name. It builds the demand that search ads later capture.",
  tiktok_ads: "Short video ads in a feed where a new brand can reach a lot of people cheaply. Clips that look native to the feed usually beat polished commercials.",
  linkedin_ads: "Targets buyers by job title, company and industry. The right fit when the person who pays is a professional at work.",
  reddit_ads: "Ads inside the communities where your buyers already ask for advice. It reaches niche audiences other platforms struggle to find.",
  x_ads: "Promotes your best posts to people on X who follow your topic. Zavi reads which campaigns bring customers and proposes where the budget goes next.",
  chatgpt_ads: "Shows your offer to people asking ChatGPT what to buy. You become an answer at the moment someone is deciding.",
  seo: "Gets your pages ranking for what customers search on Google. That traffic keeps arriving without paying for each click.",
  geo: "Gets AI assistants like ChatGPT and Perplexity to name you when people ask for a recommendation. Zavi checks who they cite today and what it takes to be included.",
  linkedin_organic: "Posts from you and your company that build trust with the people who buy. A founder's own voice travels further than ads here.",
  reddit_organic: "Helpful answers in threads where people are choosing what to buy. One good reply can keep sending customers long after it is posted.",
  x_organic: "Short posts and threads that reach builders, press and early adopters. You learn fast which message lands.",
  instagram_organic: "Photos, reels and stories that show your product in real life. It keeps you in front of followers until they are ready to buy.",
  tiktok_organic: "Short videos that can reach people far beyond your followers. One clip that hits can bring more new visitors than weeks of ads.",
  pinterest_organic: "Pins that people save while planning what to buy next. A pin keeps sending traffic for months after it goes up.",
  youtube_organic: "Videos people find through YouTube and Google search. Tutorials and reviews keep bringing viewers long after they go live.",
  ugc: "Real customers and creators filming honest clips about your product. People trust other people more than they trust brands.",
  generated_video: "AI-made videos in the style of customer clips, so you can test many ad angles without a shoot. Find the message that works before paying for production.",
  email_marketing: "Campaigns to people who already know you: signups, past customers and leads. The cheapest way to bring someone back to buy again.",
  sms: "Short texts for time-sensitive offers and reminders. Most get read within minutes.",
};

const GROUPS: ReadonlyArray<{ label: string; slugs: readonly string[] }> = [
  { label: "Paid ads", slugs: ["meta_ads", "google_ads", "youtube_ads", "tiktok_ads", "linkedin_ads", "reddit_ads", "x_ads", "chatgpt_ads"] },
  { label: "Search & AI answers", slugs: ["seo", "geo"] },
  { label: "Social", slugs: ["instagram_organic", "tiktok_organic", "youtube_organic", "linkedin_organic", "reddit_organic", "x_organic", "pinterest_organic"] },
  { label: "Creators & video", slugs: ["ugc", "generated_video"] },
  { label: "Your list", slugs: ["email_marketing", "sms"] },
];

type Chan = { slug: string; name: string; pitch: string };
const ALL: Chan[] = CHANNELS.filter((c) => PITCH[c.slug] && !RETIRED_CHANNEL_SLUGS.has(c.slug)).map((c) => ({ slug: c.slug, name: c.name, pitch: PITCH[c.slug]! }));
const grouped = new Set(GROUPS.flatMap((g) => g.slugs));
export const BOARD: ReadonlyArray<{ label: string; channels: Chan[] }> = [
  ...GROUPS.map((g) => ({ label: g.label, channels: g.slugs.flatMap((s) => ALL.filter((c) => c.slug === s)) })),
  { label: "More", channels: ALL.filter((c) => !grouped.has(c.slug)) },
].filter((g) => g.channels.length > 0);
export const CHANNEL_COUNT = ALL.length;
