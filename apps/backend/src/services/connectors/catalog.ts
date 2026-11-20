
import { listAgents } from "@/services/agents/registry";
import { filterTenantVisibleAgents } from "@/services/agents/visibility";
import { filterPlanEntitledAgents } from "@/services/agents/entitlement";
import type { AgentDefinition } from "@/services/agents/types";

export const CONNECTOR_SLUGS = [
  "slack",
  "github",
  "meta_ads",
  "google_ads",
  "operator_db",
  "jira",
  "stripe",
  "linear",
  "google_analytics",
  "posthog",
  "google_search_console",
  "sentry",
  "figma",
  "google_calendar",
  "google_sheets",
  "supabase",
  "reddit_ads",
  "tiktok_ads",
  "linkedin_ads",
  "snapchat_ads",
  "spotify_ads",
  "pinterest_ads",
  "microsoft_ads",
  "x_ads",
  "apple_ads",
  "tiktok",
] as const;
export type ConnectorSlug = (typeof CONNECTOR_SLUGS)[number];

export const COMPANY_SHAPES = [
  "marketplace",
  "saas",
  "ecommerce",
  "services",
  "fintech",
  "other",
] as const;
export type CompanyShape = (typeof COMPANY_SHAPES)[number];

export type ConnectorDescriptor = {
  slug: ConnectorSlug;
  name: string;
  rationale_by_shape: Record<CompanyShape, string>;
};

export const CONNECTOR_DESCRIPTORS: ConnectorDescriptor[] = [
  {
    slug: "tiktok",
    name: "TikTok",
    rationale_by_shape: {
      marketplace: "Publish and measure organic TikTok content that grows both sides of your marketplace.",
      saas: "Turn product education and customer proof into measurable organic TikTok posts.",
      ecommerce: "Schedule product stories, demos, and creator-style content, then learn from live engagement.",
      services: "Publish expertise-led TikTok content and measure which topics create demand.",
      fintech: "Schedule compliant educational TikTok content with explicit approval and live status tracking.",
      other: "Plan, schedule, publish, and analyze organic TikTok content from one connected account.",
    },
  },
  {
    slug: "slack",
    name: "Slack",
    rationale_by_shape: {
      marketplace:
        "Slack is where your support + ops team coordinate dispute and trip decisions in real time — the brain joins those threads and cuts the back-and-forth.",
      saas: "Slack is where customer-success threads with engineering on bugs — the brain extracts recurring issues into typed brain notes.",
      ecommerce:
        "Slack is where merch + ops triage stockouts and fulfillment issues — the brain summarizes daily and flags repeats.",
      services:
        "Slack is your client + delivery comms hub — the brain extracts SLA risks and scope-creep signals into brain notes.",
      fintech:
        "Slack is where ops + risk discuss flagged transactions — the brain joins the thread and grounds future calls on prior decisions.",
      other:
        "Slack is where your team coordinates day-to-day — the brain reads the channels and turns durable signal into brain notes.",
    },
  },
  {
    slug: "github",
    name: "GitHub",
    rationale_by_shape: {
      marketplace:
        "GitHub gives the brain visibility into product changes that touch your funnel — the PM agent watches PR-to-metric impact.",
      saas: "GitHub is the source of truth for what shipped and what regressed — the engineer and pm agents both ground on it.",
      ecommerce:
        "GitHub history grounds the engineering side of your store — the brain catches bug regressions before customers do.",
      services:
        "GitHub gives the brain access to internal tooling repos so the engineer agent can propose sandboxed fixes.",
      fintech:
        "GitHub access lets the brain audit code paths near money + compliance — the engineer flags risky diffs early.",
      other:
        "GitHub history grounds the engineering side of your business — the brain proposes targeted improvements via PR.",
    },
  },
  {
    slug: "operator_db",
    name: "Your database",
    rationale_by_shape: {
      marketplace:
        "Your marketplace DB is the ground truth for listings, users, and transactions — connecting it unlocks the agents that actually move GMV and retention.",
      saas: "Your app DB holds accounts, usage, and churn signal — connecting it lets the analytics + lifecycle agents work off real data, not guesses.",
      ecommerce:
        "Your store DB holds orders, SKUs, and customers — connecting it lets agents reconcile fulfillment and flag at-risk orders.",
      services:
        "Your delivery DB holds clients, projects, and invoices — connecting it lets agents track SLA risk and recon payouts.",
      fintech:
        "Your ledger DB holds transactions and balances — connecting it lets the recon + trust-safety agents work off the source of truth.",
      other:
        "Your operational DB is the ground truth your agents reason over — connecting it unlocks the data-grounded fleet.",
    },
  },
  {
    slug: "meta_ads",
    name: "Meta Ads",
    rationale_by_shape: {
      marketplace:
        "Meta Ads drives most marketplace top-of-funnel — connecting it lets performance-marketer read spend and propose reallocations toward the cohorts that convert.",
      saas: "Meta Ads is a primary paid channel for SaaS demand — performance-marketer reads campaign performance and flags wasted spend.",
      ecommerce:
        "Meta Ads is the workhorse for e-commerce acquisition — performance-marketer watches ROAS and proposes budget shifts.",
      services:
        "Meta Ads can feed your lead pipeline — performance-marketer reads campaign performance and flags inefficient spend.",
      fintech:
        "Meta Ads is a regulated but high-volume channel — performance-marketer reads performance and flags spend drift.",
      other:
        "Connect Meta Ads so performance-marketer can read Facebook + Instagram campaigns and propose reallocations.",
    },
  },
  {
    slug: "google_ads",
    name: "Google Ads",
    rationale_by_shape: {
      marketplace:
        "Google Ads captures high-intent marketplace demand — performance-marketer reads spend + performance and proposes reallocations.",
      saas: "Google Ads is the highest-intent SaaS channel — performance-marketer reads campaign spend and flags inefficiency.",
      ecommerce:
        "Google Shopping + Search drive e-commerce intent — performance-marketer watches ROAS and proposes budget shifts.",
      services:
        "Google Ads captures bottom-funnel service intent — performance-marketer reads performance and flags wasted spend.",
      fintech:
        "Google Ads captures high-intent fintech demand — performance-marketer reads spend + performance and flags drift.",
      other:
        "Connect Google Ads so performance-marketer can read campaigns + spend and propose reallocations.",
    },
  },
  {
    slug: "jira",
    name: "Jira",
    rationale_by_shape: {
      marketplace:
        "Jira holds the product + engineering backlog — pm and engineer ground their proposals on what's already planned.",
      saas: "Jira is your roadmap and bug tracker — pm, engineer, and qa read it for engineering context.",
      ecommerce:
        "Jira tracks the store's product + ops backlog — the PM and engineering agents read it to avoid duplicate work.",
      services:
        "Jira tracks delivery and internal-tooling work — the engineering agents read it for context before proposing changes.",
      fintech:
        "Jira tracks compliance + engineering work — pm and engineer read it to ground proposals.",
      other:
        "Connect Jira so pm, engineer, and qa get product + engineering context from your Atlassian site.",
    },
  },
  {
    slug: "stripe",
    name: "Stripe",
    rationale_by_shape: {
      marketplace:
        "Stripe is where your GMV moves. Connecting it lets the dispute-response, chief-of-staff, and operator agents read charges, payouts, and disputes and ground their calls on real money flow.",
      saas: "Stripe holds your MRR, invoices, and failed payments. Connecting it lets chief-of-staff and operator read revenue and flag billing issues.",
      ecommerce:
        "Stripe processes your orders and refunds. Connecting it lets agents reconcile payments and watch your dispute rate.",
      services:
        "Stripe handles client invoicing and payouts. Connecting it lets agents track paid vs unpaid invoices and reconcile revenue.",
      fintech:
        "Stripe is a core money rail. Connecting it lets operator and dispute-response work off real charges, payouts, and disputes.",
      other:
        "Connect Stripe so your finance and dispute agents can read charges, payouts, and disputes and ground on real money flow.",
    },
  },
  {
    slug: "linear",
    name: "Linear",
    rationale_by_shape: {
      marketplace:
        "Linear is where your eng team tracks bugs + feature work — engineer and pm ground fixes and roadmap in what's actually in flight.",
      saas: "Linear holds your product + engineering backlog — pm and engineer cite real tickets on triage and roadmap calls, not guesses.",
      ecommerce:
        "Linear tracks your storefront + ops eng work — fixes and priorities line up with what's already queued.",
      services:
        "Linear is your delivery + eng issue tracker — pm and operator spot at-risk work and file follow-ups.",
      fintech:
        "Linear holds your platform + compliance eng backlog — engineer and pm ground work in the live ticket queue.",
      other:
        "Linear is where your team tracks issues and projects — engineer, pm, and operator read it for context.",
    },
  },
  {
    slug: "google_analytics",
    name: "Google Analytics",
    rationale_by_shape: {
      marketplace:
        "Google Analytics shows where your marketplace traffic + conversions come from — performance-marketer reads GA4 attribution by source to judge which channels actually drive bookings.",
      saas: "Google Analytics ties signups + activation to their traffic source — performance-marketer reads GA4 attribution to see which channels convert, not just click.",
      ecommerce:
        "Google Analytics attributes revenue + conversions to source/medium/campaign — performance-marketer reads GA4 to see which traffic actually sells.",
      services:
        "Google Analytics shows which channels bring leads that convert — performance-marketer reads GA4 attribution to focus spend on what works.",
      fintech:
        "Google Analytics attributes signups + funded accounts to their traffic source — performance-marketer reads GA4 to judge real channel efficiency.",
      other:
        "Connect Google Analytics so performance-marketer can read GA4 traffic + conversions by source. Read-only.",
    },
  },
  {
    slug: "posthog",
    name: "PostHog",
    rationale_by_shape: {
      marketplace:
        "PostHog is where your funnel actually lives — the agent can ask why signups never reach a booking, and get the drop-off step by name instead of a guess.",
      saas: "PostHog holds activation and retention truth — the agent can find which onboarding step loses trials before they ever convert.",
      ecommerce:
        "PostHog tracks the browse-to-checkout path — the agent can pinpoint which step sheds buyers instead of blaming traffic quality.",
      services:
        "PostHog shows how prospects move through your site before they book a call, so the agent can tell which page is doing the work.",
      fintech:
        "PostHog shows where applicants abandon onboarding and KYC, which is usually the single biggest lever on approved-account volume.",
      other:
        "PostHog is the product-analytics source of truth — connecting it lets the agent answer funnel, activation and retention questions from real events instead of assumptions.",
    },
  },
  {
    slug: "google_search_console",
    name: "Google Search Console",
    rationale_by_shape: {
      marketplace:
        "Search Console shows which queries bring organic supply and demand to your marketplace — seo-geo reads real clicks, impressions, and rankings instead of guessing.",
      saas: "Search Console shows which queries and pages win organic signups — seo-geo grounds every SEO claim in real clicks, impressions, and positions.",
      ecommerce:
        "Search Console shows which product and category pages rank and convert from organic search — seo-geo reads real query-level data, not estimates.",
      services:
        "Search Console shows which searches bring prospects to your site — seo-geo sees the queries and pages that actually generate leads.",
      fintech:
        "Search Console shows which high-intent queries reach your site — seo-geo reads real rankings and click-through instead of fabricating them.",
      other:
        "Connect Google Search Console so seo-geo can read real clicks, impressions, CTR, and rankings by query and page. Read-only.",
    },
  },
  {
    slug: "sentry",
    name: "Sentry",
    rationale_by_shape: {
      marketplace:
        "Sentry holds the errors both sides of your marketplace actually hit — the agent can tell you which crash is costing you transactions rather than which one is loudest.",
      saas:
        "Sentry is where regressions surface first — the agent can tie a spike in errors to the release that caused it.",
      ecommerce:
        "Sentry catches the checkout errors that silently eat orders, which is usually the most expensive bug class you have.",
      services:
        "Sentry shows what breaks for clients before they email you about it.",
      fintech:
        "Sentry surfaces failures on payment and onboarding paths, where a silent error is a lost account.",
      other:
        "Sentry is your error stream — connecting it lets the agent reason about real failures instead of guessing from logs.",
    },
  },
  {
    slug: "figma",
    name: "Figma",
    rationale_by_shape: {
      marketplace:
        "Figma holds the flows your listing and booking screens were designed from, so the agent can check what shipped against what was intended.",
      saas:
        "Figma is where the product surface is designed — the agent can reference the intended flow when reviewing what was built.",
      ecommerce:
        "Figma holds your storefront and PDP designs, so the agent can spot where the build drifted from the design.",
      services:
        "Figma holds the site and proposal designs your clients see.",
      fintech:
        "Figma holds the onboarding and KYC screens where small design changes move completion rates a lot.",
      other:
        "Figma is the design source of truth — connecting it lets the agent compare intended design against shipped product.",
    },
  },
  {
    slug: "google_calendar",
    name: "Google Calendar",
    rationale_by_shape: {
      marketplace:
        "Your calendar shows where operator time actually goes, so the agent can tell you whether you are spending it on supply, demand, or neither.",
      saas:
        "Your calendar shows how much time goes to customers versus internal meetings, which is the clearest read on whether you are still close to users.",
      ecommerce:
        "Your calendar shows supplier and ops commitments alongside the numbers they drive.",
      services:
        "Your calendar IS the delivery record — billable client time versus everything else, visible to the agent.",
      fintech:
        "Your calendar shows compliance, partner, and customer time in one place.",
      other:
        "Connecting your calendar lets the agent see where time actually goes and weigh that against what the metrics say.",
    },
  },
  {
    slug: "google_sheets",
    name: "Google Sheets",
    rationale_by_shape: {
      marketplace:
        "Half your real operating numbers live in a spreadsheet, not the product DB — connecting Sheets lets the agent read them instead of asking you to paste.",
      saas:
        "Your pipeline, pricing, and forecast models live in Sheets — the agent can read them directly rather than working from a summary.",
      ecommerce:
        "Inventory, margin, and supplier sheets are usually the real source of truth — connecting Sheets puts them in reach.",
      services:
        "Client trackers and capacity plans live in Sheets, so the agent can read them rather than asking for a paste.",
      fintech:
        "Reconciliation and reporting sheets sit alongside the product data; connecting them closes the gap.",
      other:
        "Connecting Sheets lets the agent read the spreadsheets your business actually runs on.",
    },
  },
  {
    slug: "supabase",
    name: "Supabase",
    rationale_by_shape: {
      marketplace:
        "Supabase tells the agent whether your platform itself is healthy — project status, edge functions, and logs — separate from the business data in your database.",
      saas:
        "Supabase surfaces platform-level health: paused projects, failing edge functions, and error logs behind customer-visible breakage.",
      ecommerce:
        "Supabase shows whether the infrastructure behind your storefront is healthy, not just what the orders table says.",
      services:
        "Supabase shows the health of the infrastructure your client work runs on.",
      fintech:
        "Supabase surfaces platform status and logs on the infrastructure carrying money movement.",
      other:
        "Supabase covers project-level health — status, edge functions, logs — which your database connection does not reach.",
    },
  },
  {
    slug: "reddit_ads",
    name: "Reddit Ads",
    rationale_by_shape: {
      marketplace:
        "Reddit is where people ask for recommendations before they buy — connecting Reddit Ads lets performance-marketer read that spend alongside Meta and Google instead of leaving a channel unmeasured.",
      saas:
        "Reddit reaches practitioners in their own subreddits. Connecting it lets performance-marketer read campaign spend and performance rather than treating Reddit as an unmeasured manual lever.",
      ecommerce:
        "Reddit drives niche-product demand that Meta and Google miss. Connecting it puts that spend in the same performance read as your other paid channels.",
      services:
        "Reddit communities are where buyers vet service providers. Connecting Reddit Ads lets the agent read that spend and flag it when it is not converting.",
      fintech:
        "Reddit carries high-intent finance discussion. Connecting Reddit Ads lets performance-marketer read spend and performance on a channel that is otherwise invisible.",
      other:
        "Connect Reddit Ads so performance-marketer can read your Reddit campaigns and spend alongside Meta and Google, instead of guessing at an unmeasured channel.",
    },
  },
  {
    slug: "tiktok_ads",
    name: "TikTok Ads",
    rationale_by_shape: {
      marketplace:
        "TikTok drives discovery for consumer marketplaces at a lower CPM than Meta. Connecting it lets performance-marketer read that spend instead of leaving your cheapest top-of-funnel unmeasured.",
      saas:
        "TikTok is a real channel for prosumer and SMB SaaS. Connecting it lets performance-marketer read campaign spend and performance rather than treating it as a manual lever.",
      ecommerce:
        "TikTok is a primary e-commerce acquisition channel. Connecting it puts that spend in the same performance read as Meta and Google instead of a separate tab.",
      services:
        "TikTok can feed local and consumer service demand. Connecting it lets the agent read spend and flag it when the leads are not converting.",
      fintech:
        "TikTok reaches a younger cohort that Google search misses. Connecting it lets performance-marketer read spend and performance on a channel that is otherwise invisible.",
      other:
        "Connect TikTok Ads so performance-marketer can read your TikTok campaigns and spend alongside Meta and Google, instead of guessing at an unmeasured channel.",
    },
  },
  {
    slug: "linkedin_ads",
    name: "LinkedIn Ads",
    rationale_by_shape: {
      marketplace: "LinkedIn Ads is the B2B paid channel with the highest CPC — connecting it lets performance-marketer read spend and campaign status so targeting and offer strength get judged on real numbers.",
      saas: "LinkedIn Ads is the B2B paid channel with the highest CPC — connecting it lets performance-marketer read spend and campaign status so targeting and offer strength get judged on real numbers.",
      ecommerce: "LinkedIn Ads is the B2B paid channel with the highest CPC — connecting it lets performance-marketer read spend and campaign status so targeting and offer strength get judged on real numbers.",
      services: "LinkedIn Ads is the B2B paid channel with the highest CPC — connecting it lets performance-marketer read spend and campaign status so targeting and offer strength get judged on real numbers.",
      fintech: "LinkedIn Ads is the B2B paid channel with the highest CPC — connecting it lets performance-marketer read spend and campaign status so targeting and offer strength get judged on real numbers.",
      other: "Connect LinkedIn Ads so performance-marketer can read your campaigns and spend alongside Meta and Google, instead of guessing at an unmeasured channel.",
    },
  },
  {
    slug: "snapchat_ads",
    name: "Snapchat Ads",
    rationale_by_shape: {
      marketplace: "Snapchat reaches a younger consumer cohort Meta under-indexes — connecting it lets performance-marketer read that spend alongside your other paid channels instead of leaving it unmeasured.",
      saas: "Snapchat reaches a younger consumer cohort Meta under-indexes — connecting it lets performance-marketer read that spend alongside your other paid channels instead of leaving it unmeasured.",
      ecommerce: "Snapchat reaches a younger consumer cohort Meta under-indexes — connecting it lets performance-marketer read that spend alongside your other paid channels instead of leaving it unmeasured.",
      services: "Snapchat reaches a younger consumer cohort Meta under-indexes — connecting it lets performance-marketer read that spend alongside your other paid channels instead of leaving it unmeasured.",
      fintech: "Snapchat reaches a younger consumer cohort Meta under-indexes — connecting it lets performance-marketer read that spend alongside your other paid channels instead of leaving it unmeasured.",
      other: "Connect Snapchat Ads so performance-marketer can read your campaigns and spend alongside Meta and Google, instead of guessing at an unmeasured channel.",
    },
  },
  {
    slug: "spotify_ads",
    name: "Spotify Ads",
    rationale_by_shape: {
      marketplace: "Spotify audio ads reach listeners during commutes and workouts — connecting it puts that spend in the same paid-channel read as Meta and Google.",
      saas: "Spotify audio ads reach listeners during commutes and workouts — connecting it puts that spend in the same paid-channel read as Meta and Google.",
      ecommerce: "Spotify audio ads reach listeners during commutes and workouts — connecting it puts that spend in the same paid-channel read as Meta and Google.",
      services: "Spotify audio ads reach listeners during commutes and workouts — connecting it puts that spend in the same paid-channel read as Meta and Google.",
      fintech: "Spotify audio ads reach listeners during commutes and workouts — connecting it puts that spend in the same paid-channel read as Meta and Google.",
      other: "Connect Spotify Ads so performance-marketer can read your campaigns and spend alongside Meta and Google, instead of guessing at an unmeasured channel.",
    },
  },
  {
    slug: "pinterest_ads",
    name: "Pinterest Ads",
    rationale_by_shape: {
      marketplace: "Pinterest is planning-intent traffic (home, fashion, food, events) — connecting it lets performance-marketer read campaign spend and status on a channel most teams never measure.",
      saas: "Pinterest is planning-intent traffic (home, fashion, food, events) — connecting it lets performance-marketer read campaign spend and status on a channel most teams never measure.",
      ecommerce: "Pinterest is planning-intent traffic (home, fashion, food, events) — connecting it lets performance-marketer read campaign spend and status on a channel most teams never measure.",
      services: "Pinterest is planning-intent traffic (home, fashion, food, events) — connecting it lets performance-marketer read campaign spend and status on a channel most teams never measure.",
      fintech: "Pinterest is planning-intent traffic (home, fashion, food, events) — connecting it lets performance-marketer read campaign spend and status on a channel most teams never measure.",
      other: "Connect Pinterest Ads so performance-marketer can read your campaigns and spend alongside Meta and Google, instead of guessing at an unmeasured channel.",
    },
  },
  {
    slug: "microsoft_ads",
    name: "Microsoft Ads",
    rationale_by_shape: {
      marketplace: "Microsoft Advertising (Bing) captures high-intent search that Google misses at lower CPCs — connecting it lets performance-marketer read spend and campaigns alongside Google Ads.",
      saas: "Microsoft Advertising (Bing) captures high-intent search that Google misses at lower CPCs — connecting it lets performance-marketer read spend and campaigns alongside Google Ads.",
      ecommerce: "Microsoft Advertising (Bing) captures high-intent search that Google misses at lower CPCs — connecting it lets performance-marketer read spend and campaigns alongside Google Ads.",
      services: "Microsoft Advertising (Bing) captures high-intent search that Google misses at lower CPCs — connecting it lets performance-marketer read spend and campaigns alongside Google Ads.",
      fintech: "Microsoft Advertising (Bing) captures high-intent search that Google misses at lower CPCs — connecting it lets performance-marketer read spend and campaigns alongside Google Ads.",
      other: "Connect Microsoft Ads so performance-marketer can read your campaigns and spend alongside Meta and Google, instead of guessing at an unmeasured channel.",
    },
  },
  {
    slug: "x_ads",
    name: "X Ads",
    rationale_by_shape: {
      marketplace: "X Ads reach a news-and-tech audience at the moment they're paying attention — connecting it lets performance-marketer read spend and campaign status instead of guessing at an unmeasured channel.",
      saas: "X Ads reach a news-and-tech audience at the moment they're paying attention — connecting it lets performance-marketer read spend and campaign status instead of guessing at an unmeasured channel.",
      ecommerce: "X Ads reach a news-and-tech audience at the moment they're paying attention — connecting it lets performance-marketer read spend and campaign status instead of guessing at an unmeasured channel.",
      services: "X Ads reach a news-and-tech audience at the moment they're paying attention — connecting it lets performance-marketer read spend and campaign status instead of guessing at an unmeasured channel.",
      fintech: "X Ads reach a news-and-tech audience at the moment they're paying attention — connecting it lets performance-marketer read spend and campaign status instead of guessing at an unmeasured channel.",
      other: "Connect X Ads so performance-marketer can read your campaigns and spend alongside Meta and Google, instead of guessing at an unmeasured channel.",
    },
  },
  {
    slug: "apple_ads",
    name: "Apple Ads",
    rationale_by_shape: {
      marketplace: "Apple Search Ads is the highest-intent install channel for iOS apps — connecting it lets performance-marketer read App Store campaign spend and status alongside your other paid channels.",
      saas: "Apple Search Ads is the highest-intent install channel for iOS apps — connecting it lets performance-marketer read App Store campaign spend and status alongside your other paid channels.",
      ecommerce: "Apple Search Ads is the highest-intent install channel for iOS apps — connecting it lets performance-marketer read App Store campaign spend and status alongside your other paid channels.",
      services: "Apple Search Ads is the highest-intent install channel for iOS apps — connecting it lets performance-marketer read App Store campaign spend and status alongside your other paid channels.",
      fintech: "Apple Search Ads is the highest-intent install channel for iOS apps — connecting it lets performance-marketer read App Store campaign spend and status alongside your other paid channels.",
      other: "Connect Apple Ads so performance-marketer can read your campaigns and spend alongside Meta and Google, instead of guessing at an unmeasured channel.",
    },
  },
];

export const SHAPE_PRIORITY: Record<CompanyShape, ConnectorSlug[]> = {
  marketplace: ["operator_db", "stripe", "slack", "github", "meta_ads", "google_ads", "google_analytics", "google_search_console", "posthog", "jira", "linear", "sentry", "figma", "google_calendar", "google_sheets", "supabase", "reddit_ads", "tiktok_ads", "linkedin_ads", "snapchat_ads", "spotify_ads", "pinterest_ads", "microsoft_ads", "x_ads", "apple_ads", "tiktok"],
  saas: ["github", "operator_db", "stripe", "slack", "jira", "linear", "google_ads", "google_analytics", "google_search_console", "posthog", "meta_ads", "sentry", "figma", "google_calendar", "google_sheets", "supabase", "reddit_ads", "tiktok_ads", "linkedin_ads", "snapchat_ads", "spotify_ads", "pinterest_ads", "microsoft_ads", "x_ads", "apple_ads", "tiktok"],
  ecommerce: ["operator_db", "stripe", "meta_ads", "google_ads", "google_analytics", "google_search_console", "posthog", "slack", "github", "jira", "linear", "sentry", "figma", "google_calendar", "google_sheets", "supabase", "reddit_ads", "tiktok_ads", "linkedin_ads", "snapchat_ads", "spotify_ads", "pinterest_ads", "microsoft_ads", "x_ads", "apple_ads", "tiktok"],
  services: ["slack", "operator_db", "stripe", "github", "jira", "linear", "google_ads", "google_analytics", "google_search_console", "posthog", "meta_ads", "sentry", "figma", "google_calendar", "google_sheets", "supabase", "reddit_ads", "tiktok_ads", "linkedin_ads", "snapchat_ads", "spotify_ads", "pinterest_ads", "microsoft_ads", "x_ads", "apple_ads", "tiktok"],
  fintech: ["operator_db", "stripe", "slack", "github", "jira", "linear", "google_ads", "google_analytics", "google_search_console", "posthog", "meta_ads", "sentry", "figma", "google_calendar", "google_sheets", "supabase", "reddit_ads", "tiktok_ads", "linkedin_ads", "snapchat_ads", "spotify_ads", "pinterest_ads", "microsoft_ads", "x_ads", "apple_ads", "tiktok"],
  other: ["slack", "github", "operator_db", "stripe", "meta_ads", "google_ads", "google_analytics", "google_search_console", "posthog", "jira", "linear", "sentry", "figma", "google_calendar", "google_sheets", "supabase", "reddit_ads", "tiktok_ads", "linkedin_ads", "snapchat_ads", "spotify_ads", "pinterest_ads", "microsoft_ads", "x_ads", "apple_ads", "tiktok"],
};

export const SHAPE_PATTERNS: Array<{ shape: CompanyShape; re: RegExp }> = [
  { shape: "marketplace", re: /\bmarketplace\b|\bp2p\b|\btwo[-\s]?sided\b|\bhost(?:s)?\b.*\bguest(?:s)?\b/i },
  { shape: "saas", re: /\bsaas\b|\bsubscription\b|\bseat(?:s)?\b|\bmrr\b|\barr\b/i },
  { shape: "fintech", re: /\bfintech\b|\bbank(?:ing)?\b|\bpayment(?:s)?\b|\blending\b|\bpayouts?\b/i },
  { shape: "ecommerce", re: /\be[-\s]?commerce\b|\bdtc\b|\bd2c\b|\bstore\b.*\bproduct(?:s)?\b/i },
  { shape: "services", re: /\bagency\b|\bconsult(?:ing|ant)\b|\bservices?\b.*\bclient(?:s)?\b/i },
];

export function classifyShape(companyBody: string): CompanyShape {
  if (!companyBody) return "other";
  for (const { shape, re } of SHAPE_PATTERNS) {
    if (re.test(companyBody)) return shape;
  }
  return "other";
}

export const TOOL_PREFIX_TO_CONNECTOR: Record<string, ConnectorSlug> = {
  slack: "slack",
  github: "github",
  jira: "jira",
  meta_ads: "meta_ads",
  google_ads: "google_ads",
  operator_db: "operator_db",
  stripe: "stripe",
  linear: "linear",
  google_analytics: "google_analytics",
  posthog: "posthog",
  sentry: "sentry",
  figma: "figma",
  google_calendar: "google_calendar",
  google_sheets: "google_sheets",
  supabase: "supabase",
  google_search_console: "google_search_console",
  tiktok: "tiktok",
  reddit_ads: "reddit_ads",
  tiktok_ads: "tiktok_ads",
  linkedin_ads: "linkedin_ads",
  snapchat_ads: "snapchat_ads",
  spotify_ads: "spotify_ads",
  pinterest_ads: "pinterest_ads",
  microsoft_ads: "microsoft_ads",
  x_ads: "x_ads",
  apple_ads: "apple_ads",
};

const UNLOCK_EXCLUDE = new Set<string>(["operator"]);

function connectorsForAgent(def: AgentDefinition): Set<ConnectorSlug> {
  const out = new Set<ConnectorSlug>();
  const meta = def.metadata_praxis;
  const tools = meta.tools ?? [];
  for (const t of tools) {
    const idx = t.indexOf("__");
    if (idx <= 0) continue;
    const prefix = t.slice(0, idx);
    const connector = TOOL_PREFIX_TO_CONNECTOR[prefix];
    if (connector) out.add(connector);
  }
  const explicit = [
    ...(meta.setup?.connectors ?? []),
    ...(meta.setup?.optional_connectors ?? []),
  ];
  for (const c of explicit) {
    if ((CONNECTOR_SLUGS as readonly string[]).includes(c)) {
      out.add(c as ConnectorSlug);
    }
  }
  return out;
}

export async function buildAgentsUnlockedMap(
  tenantId: string,
): Promise<Record<ConnectorSlug, string[]>> {
  const all = listAgents();
  let visible: AgentDefinition[];
  try {
    visible = await filterTenantVisibleAgents(all, tenantId);
  } catch {
    visible = all;
  }
  try {
    visible = await filterPlanEntitledAgents(visible, tenantId);
  } catch {
  }
  const map = Object.fromEntries(
    CONNECTOR_SLUGS.map((s) => [s, new Set<string>()]),
  ) as Record<ConnectorSlug, Set<string>>;
  for (const def of visible) {
    if (UNLOCK_EXCLUDE.has(def.slug)) continue;
    for (const connector of connectorsForAgent(def)) {
      map[connector].add(def.slug);
    }
  }
  return Object.fromEntries(
    CONNECTOR_SLUGS.map((s) => [s, [...map[s]].sort()]),
  ) as Record<ConnectorSlug, string[]>;
}
