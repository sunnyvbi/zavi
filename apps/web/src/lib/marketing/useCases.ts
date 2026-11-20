
import type { LucideIcon } from "lucide-react";
import {
  ArrowLeftRight,
  Briefcase,
  Cloud,
  Gavel,
  Handshake,
  House,
  PiggyBank,
  Rocket,
  ShoppingBag,
  Stethoscope,
  Store,
  UtensilsCrossed,
  Wrench,
} from "lucide-react";

export type UseCasePlan = "Starter" | "Growth" | "Pro";

export type UseCasePlay = {
  title: string;
  body: string;
  plan?: UseCasePlan;
};

export type UseCaseMetric = { label: string; why: string };

export type UseCaseChannel = { name: string; soon?: boolean; pro?: boolean };

export type UseCase = {
  slug: string;
  name: string;
  outcome: string;
  icon: LucideIcon;
  color: string;
  metaTitle: string;
  metaDescription: string;
  headline: string;
  subline: string;
  findYou: string;
  plays: UseCasePlay[];
  metrics: UseCaseMetric[];
  asks: string[];
  channels: UseCaseChannel[];
  firstWeek: [string, string, string];
  week: { owner: string; days: [string, string, string, string] };
  reviewNote?: string;
  proof?: { title: string; body: string; href: string; cta: string };
};

const SEO: UseCaseChannel = { name: "SEO" };
const GEO: UseCaseChannel = { name: "AI Answers (GEO)" };
const LINKEDIN: UseCaseChannel = { name: "LinkedIn" };
const REDDIT: UseCaseChannel = { name: "Reddit" };
const X: UseCaseChannel = { name: "X" };
const INSTAGRAM: UseCaseChannel = { name: "Instagram" };
const UGC: UseCaseChannel = { name: "UGC Videos" };
const TIKTOK: UseCaseChannel = { name: "TikTok", soon: true };
const GOOGLE_ADS: UseCaseChannel = { name: "Google/YouTube Ads", pro: true };
const META_ADS: UseCaseChannel = { name: "Meta Ads", pro: true };

export const USE_CASES: readonly UseCase[] = [
  {
    slug: "saas",
    name: "SaaS",
    outcome: "Trial signups, traced to the source",
    icon: Cloud,
    color: "text-[#027bff]",
    week: {
      owner: "Your SaaS",
      days: [
        "Read your site and signup data. Find where trials drop.",
        "Draft a comparison page for the tool people search against you.",
        "Reddit and LinkedIn posts answering the questions your buyers ask.",
        "Put all three in front of you to approve.",
      ],
    },
    metaTitle: "Zavi for SaaS: more trial signups from search, Reddit and LinkedIn",
    metaDescription:
      "Zavi finds the problem searches, comparison pages, Reddit threads and AI answers your buyers use, drafts the content, and reads your signup data to see what moved.",
    headline: "More trial signups from the people already searching for your fix.",
    subline:
      "Zavi finds where buyers look for the problem you solve, drafts the pages and posts that answer them, and reads your signup data to see what moved.",
    findYou:
      "SaaS buyers rarely search for your name. They search for the problem, read comparison and 'alternative to' pages, ask on Reddit, and watch what peers share on LinkedIn. More of them now ask ChatGPT or Perplexity which tool to use, and those answers cite a short list of sources.",
    plays: [
      {
        title: "Problem and comparison pages",
        body: "The SEO agent finds the problem and 'alternative to' searches you are missing and drafts the pages for your review.",
        plan: "Starter",
      },
      {
        title: "Earn a place in AI tool picks",
        body: "Checks which tools ChatGPT and Perplexity recommend in your category, what those answers cite, and drafts the content to get you cited.",
        plan: "Starter",
      },
      {
        title: "Reddit and LinkedIn in your voice",
        body: "Finds threads where buyers describe the pain, drafts helpful replies and founder posts, and waits for your approval.",
        plan: "Starter",
      },
      {
        title: "Competitor teardown",
        body: "Research on your closest competitors: pricing, positioning, and the pages that rank for them.",
      },
      {
        title: "Trial-to-paid read",
        body: "Connect Stripe, GA4 and your database, and Zavi shows where trial users drop off before they pay.",
      },
    ],
    metrics: [
      { label: "Trial signups", why: "The top of the funnel every play above feeds." },
      { label: "Trial-to-paid rate", why: "Signups only count if they turn into revenue." },
      { label: "Cost per trial", why: "What each signup costs once ads are in the mix." },
    ],
    asks: [
      "Why did trial signups drop last week?",
      "Write a fair comparison page for us against our biggest competitor.",
      "Find five Reddit threads this week where people ask for a tool like ours.",
    ],
    channels: [SEO, GEO, REDDIT, LINKEDIN, X, GOOGLE_ADS],
    firstWeek: [
      "Day 1: Zavi audits your site and writes a 30-day plan built around trial signups.",
      "Days 2 to 4: it drafts your first comparison page and a batch of Reddit and LinkedIn replies.",
      "By day 7: you approve what goes live, and with GA4 or Stripe connected, Zavi checks signups against it.",
    ],
  },
  {
    slug: "startups",
    name: "Startups",
    outcome: "Launch it, then find users",
    icon: Rocket,
    color: "text-[#7c3aed]",
    week: {
      owner: "Your startup",
      days: [
        "Read your site. Name the one audience most likely to try it first.",
        "Write the launch posts for X, LinkedIn and Reddit.",
        "Build the landing page with a waitlist form.",
        "You approve, it goes live.",
      ],
    },
    metaTitle: "Zavi for startups: find your first users without a marketing team",
    metaDescription:
      "Zavi finds where your first users gather, drafts founder-led posts and a launch page, and writes a 30-day launch plan sized for one founder.",
    headline: "Launch it, then find your first hundred users.",
    subline:
      "Zavi works out who your first users are and where they gather, then drafts the launch posts, pages and outreach for you to approve.",
    findYou:
      "Nobody searches for a product they have never heard of. Early users come from the communities where the problem is discussed, from the founder's own posts on X and LinkedIn, from launch days, and from a site that explains the product in one read.",
    plays: [
      {
        title: "Find where your users gather",
        body: "Research on the subreddits, communities and accounts where your first users already talk about the problem.",
      },
      {
        title: "Founder-led posts",
        body: "Drafts X and LinkedIn posts in your voice from what you shipped this week.",
        plan: "Starter",
      },
      {
        title: "A launch page that converts",
        body: "Build a landing page with a waitlist for the launch, or audit the one you already have.",
      },
      {
        title: "A launch plan for one founder",
        body: "A 30-day plan with the launch sequence, channels and daily tasks, sized for the hours you actually have.",
      },
      {
        title: "Investor updates and decks",
        body: "Turn your early numbers into a monthly update or a pitch deck when it is time to raise.",
      },
    ],
    metrics: [
      { label: "First active users", why: "People who used it twice, not just signed up." },
      { label: "Waitlist signups", why: "Proof of pull before launch day." },
      { label: "Week-over-week growth", why: "The number early investors ask about first." },
    ],
    asks: [
      "Where do people who need what I am building hang out online?",
      "Draft my launch post for X and LinkedIn from this changelog.",
      "Build a landing page with a waitlist for my idea.",
    ],
    channels: [X, LINKEDIN, REDDIT, SEO, GEO],
    firstWeek: [
      "Day 1: Zavi maps your likely first users and the communities they read.",
      "Days 2 to 4: it builds a launch page and drafts your launch posts and community replies.",
      "By day 7: you post what you approved, and Zavi compares signups week on week.",
    ],
  },
  {
    slug: "ecommerce",
    name: "Ecommerce",
    outcome: "Orders and AOV, not just traffic",
    icon: ShoppingBag,
    color: "text-[#e11d48]",
    week: {
      owner: "Your store",
      days: [
        "Find your best sellers and where AOV is lowest.",
        "Draft a bundle offer and the page for it.",
        "Meta and Google ad sets for the bundle (Pro), budget set by you.",
        "Nothing spends until you approve.",
      ],
    },
    metaTitle: "Zavi for ecommerce: more orders, higher AOV, less wasted ad spend",
    metaDescription:
      "Zavi reads your store and ad data, finds the products and pages worth pushing, and prepares ads, product pages and creator briefs for you to approve.",
    headline: "Sell more of what already sells, at a better margin.",
    subline:
      "Zavi reads your store and ad data, finds the products and pages worth pushing, and prepares the ads, posts and product pages for you to approve.",
    findYou:
      "Shoppers find stores through Google search and Shopping, Meta and Instagram ads, creator videos, and more often through AI assistants that recommend products. Most visit more than once before they buy, so product pages and reviews do as much work as the first click.",
    plays: [
      {
        title: "Ad spend that sells",
        body: "Finds Meta and Google ad sets that spend without selling and proposes budget moves. Nothing changes until you approve.",
        plan: "Pro",
      },
      {
        title: "Product pages that rank",
        body: "The SEO agent rewrites product and category pages around what shoppers actually type.",
        plan: "Starter",
      },
      {
        title: "Creator video briefs",
        body: "Briefs for UGC videos on your best sellers, with usage rights spelled out.",
        plan: "Growth",
      },
      {
        title: "Launch posts for Instagram",
        body: "The content and design agent drafts posts and captions for new drops and bestsellers.",
        plan: "Starter",
      },
      {
        title: "Basket and repeat-buyer read",
        body: "Connect Stripe or your order database, and Zavi shows which products sell together and who comes back.",
      },
    ],
    metrics: [
      { label: "Orders", why: "The count every channel is judged on." },
      { label: "Average order value (AOV)", why: "Bundles and cross-sells move it without more traffic." },
      { label: "Return on ad spend (ROAS)", why: "Revenue per dollar once ads are running." },
    ],
    asks: [
      "Which Meta ads spent money last week without a single sale?",
      "Rewrite the product page for our best seller so it ranks.",
      "Write three UGC briefs for our summer range.",
    ],
    channels: [META_ADS, GOOGLE_ADS, INSTAGRAM, UGC, SEO, TIKTOK],
    firstWeek: [
      "Day 1: Zavi audits your store and writes a 30-day plan around orders and AOV.",
      "Days 2 to 4: it rewrites your top product pages and drafts creator briefs.",
      "By day 7: with ads connected on Pro, it lists the ad sets to cut, and you approve each change.",
    ],
  },
  {
    slug: "marketplaces",
    name: "Marketplaces",
    outcome: "Balance supply and demand by city",
    icon: ArrowLeftRight,
    color: "text-[#0e9f6e]",
    week: {
      owner: "Your platform",
      days: [
        "Read listings and bookings by city. Find the city short on supply.",
        "Draft the outreach to bring supply into that city.",
        "A search page for renters in the cities with spare supply.",
        "You approve each step.",
      ],
    },
    metaTitle: "Marketplace growth with Zavi: supply and demand, grown together",
    metaDescription:
      "Zavi reads your listings and bookings, shows where demand outruns supply by city or category, and proposes the move on the side that is short.",
    headline: "Grow both sides at once, and keep them in balance.",
    subline:
      "Zavi reads your listings and bookings, spots where demand outruns supply or the other way round, and proposes the move on the side that is short.",
    findYou:
      "A marketplace has to be found twice. Buyers search by what they need and where, often landing on a listing or a city page. The supply side is recruited through communities, referrals and targeted ads. Grow one side without the other and new buyers find empty shelves.",
    plays: [
      {
        title: "The Supply & Demand page",
        body: "Connect your database and see where supply is short against demand, by city or category, on one page.",
        plan: "Pro",
      },
      {
        title: "Liquidity gap alerts",
        body: "Finds the searches and categories where buyers leave without a match, and says which side to recruit.",
        plan: "Pro",
      },
      {
        title: "City and category pages",
        body: "The SEO agent drafts the location and category pages buyers search for, built from your real listings.",
        plan: "Starter",
      },
      {
        title: "Recruit the short side",
        body: "Drafts Reddit, LinkedIn and community posts aimed at the side you are missing.",
        plan: "Starter",
      },
      {
        title: "Separate ads for each side",
        body: "Google and Meta campaigns for buyers and for supply, with every budget move waiting for your approval.",
        plan: "Pro",
      },
    ],
    metrics: [
      { label: "New listings", why: "Supply is what buyers come back for." },
      { label: "Bookings or transactions", why: "Where both sides meet and revenue happens." },
      { label: "Match rate", why: "The share of searches that end in a booking." },
    ],
    asks: [
      "Which cities have more demand than listings this month?",
      "Draft a Reddit post to recruit new sellers in Austin.",
      "Why did bookings drop in Miami last week?",
    ],
    channels: [SEO, REDDIT, INSTAGRAM, META_ADS, GOOGLE_ADS],
    firstWeek: [
      "Day 1: Zavi connects to your database and maps supply against demand.",
      "Days 2 to 4: it names the thinnest city or category and drafts the recruiting posts for it.",
      "By day 7: you approve what goes out, and the Supply & Demand page shows whether the gap closed.",
    ],
    proof: {
      title: "Built on a live company",
      body: "Zavi runs on Upcar, a live P2P car rental company. Its agents work on Upcar's real operating data, which is where these plays come from.",
      href: "/live/upcar",
      cta: "Read the Upcar story",
    },
  },
  {
    slug: "agencies",
    name: "Agencies",
    outcome: "One workspace per client",
    icon: Briefcase,
    color: "text-[#946300]",
    week: {
      owner: "Your agency",
      days: [
        "Open a workspace for each client.",
        "Each gets its own site read and 30-day plan.",
        "Drafts for every client, in one place.",
        "You approve per client.",
      ],
    },
    metaTitle: "Zavi for agencies: audits, reports and content for every client",
    metaDescription:
      "Zavi runs client audits before the first call, builds monthly reports from GA4 and Search Console, and drafts content for each client, all waiting on your approval.",
    headline: "Run growth for every client from one account.",
    subline:
      "Zavi does the research, audits, drafts and reports across your client accounts, so your team spends its hours on judgment and relationships.",
    findYou:
      "Agencies win work through referrals, LinkedIn, and showing up when a founder searches for help in their niche. They keep clients through visible work and clear reporting, so the new-business pipeline and the delivery both matter.",
    plays: [
      {
        title: "A pitch audit before the first call",
        body: "Run a website audit and 30-day growth plan for a prospect, so you walk in with specifics.",
      },
      {
        title: "One company per client",
        body: "Set up each client as its own company in Zavi, with its own connected tools and history.",
      },
      {
        title: "Monthly client reports",
        body: "Turn a client's GA4, Search Console and ad data into a PDF report or a deck.",
      },
      {
        title: "Client content at volume",
        body: "SEO pages, LinkedIn posts and ad drafts for each client, every piece waiting for approval.",
        plan: "Starter",
      },
      {
        title: "Your own new-business engine",
        body: "LinkedIn posts and niche research that bring the agency its next clients.",
        plan: "Starter",
      },
    ],
    metrics: [
      { label: "Clients per account manager", why: "The margin lever for a service business." },
      { label: "Client retention", why: "Clear monthly reporting keeps retainers renewing." },
      { label: "New-business calls booked", why: "The pipeline that replaces churned clients." },
    ],
    asks: [
      "Audit this prospect's site and give me three things to pitch tomorrow.",
      "Build this month's report for our dental client from GA4 and Search Console.",
      "Draft ten LinkedIn posts for a client in commercial cleaning.",
    ],
    channels: [LINKEDIN, SEO, GEO, GOOGLE_ADS, META_ADS],
    firstWeek: [
      "Day 1: set up your two busiest clients and connect their GA4 and Search Console.",
      "Days 2 to 4: Zavi drafts each client's report and the next month's content.",
      "By day 7: your team reviews and sends, instead of assembling from scratch.",
    ],
  },
  {
    slug: "professional-services",
    name: "Professional services",
    outcome: "More discovery calls",
    icon: Handshake,
    color: "text-[#0369a1]",
    week: {
      owner: "Your firm",
      days: [
        "Find the questions your best clients search before they call.",
        "Turn one into a LinkedIn post and a page.",
        "A discovery call page with booking.",
        "You approve every word.",
      ],
    },
    metaTitle: "Zavi for consultants and professional services: more discovery calls",
    metaDescription:
      "Zavi turns your expertise into LinkedIn posts, service pages and proposals, researches prospects before you meet, and shows which pages bring visitors who get in touch.",
    headline: "More discovery calls from the clients you want.",
    subline:
      "Zavi turns your expertise into the articles, LinkedIn posts and pages that make a buyer reach out, and drafts them for you every week.",
    findYou:
      "Consultants, accountants and other advisers are hired on trust. Buyers hear your name through a referral, then check your LinkedIn, your site and what you have written before they book a call. A clear point of view, published often, is what turns a name into a meeting.",
    plays: [
      {
        title: "Thought leadership on LinkedIn",
        body: "Drafts posts from your notes, calls and past projects, in your voice, for you to approve.",
        plan: "Starter",
      },
      {
        title: "Pages for the problems you solve",
        body: "SEO and AI-answer pages built around the specific problems buyers have, not a list of services.",
        plan: "Starter",
      },
      {
        title: "Proposals from a scoping call",
        body: "Turn your call notes into a clean proposal deck.",
      },
      {
        title: "A briefing before every meeting",
        body: "Research on a prospect's business, market and competitors before you meet.",
      },
      {
        title: "See which pages bring enquiries",
        body: "Connect GA4 and Search Console to see which pages and posts bring the visitors who get in touch.",
      },
    ],
    metrics: [
      { label: "Discovery calls booked", why: "The step before every engagement." },
      { label: "Inbound leads", why: "Buyers who found you instead of the other way round." },
      { label: "Proposal win rate", why: "Better-prepared calls close more often." },
    ],
    asks: [
      "Turn these call notes into three LinkedIn posts.",
      "Research this prospect before my call on Thursday.",
      "Which of our service pages brings visitors who contact us?",
    ],
    channels: [LINKEDIN, SEO, GEO, X],
    firstWeek: [
      "Day 1: Zavi reads your site and past work and writes a 30-day plan around booked calls.",
      "Days 2 to 4: it drafts a week of LinkedIn posts and one page for your most asked-about problem.",
      "By day 7: you approve and publish, and Zavi starts a briefing for your next prospect call.",
    ],
  },
  {
    slug: "small-business",
    name: "Small business",
    outcome: "A weekly plan for new customers",
    icon: Store,
    color: "text-[#be123c]",
    week: {
      owner: "Your business",
      days: [
        "Read your site and name the one thing holding sales back.",
        "Three quick fixes for your site, drafted.",
        "A week of posts for the channel your customers use.",
        "You approve, Zavi does the work.",
      ],
    },
    metaTitle: "Zavi for small businesses: more customers without a marketing hire",
    metaDescription:
      "Zavi gives a small business a plain-words growth plan, a website if you need one, a week of posts in one go, and a browser agent for the web chores.",
    headline: "Know what to do this week to win more customers.",
    subline:
      "Tell Zavi what you sell and who buys it. It writes the plan, drafts the posts and pages, and takes on the web chores, and you approve what goes out.",
    findYou:
      "Most small businesses are found by word of mouth, a Google search, a social profile and, more often now, an AI assistant asked for a recommendation. The owner rarely has time to keep all of these fresh, and that is where customers quietly go to a competitor.",
    plays: [
      {
        title: "A 30-day plan in plain words",
        body: "An audit of your site and a day-by-day plan you can follow in a few minutes a day.",
      },
      {
        title: "A website that works",
        body: "Build a fast, simple site if you do not have one, or fix the one you do.",
      },
      {
        title: "A week of posts in one go",
        body: "Instagram and LinkedIn posts for the week, drafted together so you approve them in one sitting.",
        plan: "Starter",
      },
      {
        title: "Web chores, handled",
        body: "The browser agent does repetitive tasks on the web, like updating your details across directory listings.",
        plan: "Starter",
      },
      {
        title: "Get recommended by AI assistants",
        body: "Checks whether ChatGPT recommends you for what you sell, and what to fix if it does not.",
      },
    ],
    metrics: [
      { label: "New customers per month", why: "The number the whole plan is built around." },
      { label: "Website enquiries", why: "Calls, forms and messages from the site." },
      { label: "Repeat customers", why: "Cheaper than finding new ones." },
    ],
    asks: [
      "I sell handmade candles online and at markets. Where should I focus first?",
      "Build me a simple website with our hours and a contact form.",
      "Update our opening hours on every directory we are listed on.",
    ],
    channels: [INSTAGRAM, SEO, GEO, LINKEDIN, META_ADS],
    firstWeek: [
      "Day 1: Zavi reads your site and writes a plan you can follow in minutes a day.",
      "Days 2 to 4: it fixes or builds your site and drafts a week of posts.",
      "By day 7: you have approved your first posts and cleared a list of web chores.",
    ],
  },
  {
    slug: "local-services",
    name: "Local services",
    outcome: "More calls from 'near me' searches",
    icon: Wrench,
    color: "text-[#a16207]",
    week: {
      owner: "Your business",
      days: [
        "Find the 'near me' searches you should win and don't.",
        "A page per service and area, with a clear call button.",
        "Draft replies to recent reviews and a request for new ones.",
        "You approve each one.",
      ],
    },
    metaTitle: "Zavi for local services: more calls from 'near me' searches",
    metaDescription:
      "Zavi works on your Google Business Profile, service-area pages, review replies and local search ads, the things that decide who gets the call.",
    headline: "Be the one they call when they search 'near me'.",
    subline:
      "Zavi works on the Google Business Profile, reviews, service-area pages and local ads that decide who gets the call.",
    findYou:
      "People find a plumber, cleaner or salon by searching the service plus 'near me', then picking from the map results by reviews, photos and hours. The businesses that show up there, with recent reviews and a clear page for each area they cover, get the calls.",
    plays: [
      {
        title: "Google Business Profile tune-up",
        body: "Connect your profile and Zavi checks categories, services, photos and posts against the businesses that outrank you.",
      },
      {
        title: "A page for every town you cover",
        body: "One page per service and area, written for the searches people actually type.",
        plan: "Starter",
      },
      {
        title: "Review requests and replies",
        body: "Drafts the message that asks happy customers for a review, and a reply to every review in your voice.",
        plan: "Starter",
      },
      {
        title: "Search ads for urgent jobs",
        body: "Google search ads for high-intent local searches, with a budget you set and approve.",
        plan: "Pro",
      },
      {
        title: "Why they rank above you",
        body: "Research on the local competitors who win the map results, and what they do that you do not.",
      },
    ],
    metrics: [
      { label: "Calls and quote requests", why: "The job starts with the phone ringing." },
      { label: "Map ranking for your top services", why: "Most local clicks go to the first few results." },
      { label: "New reviews per month", why: "Fresh reviews are what searchers read first." },
    ],
    asks: [
      "Why does the other plumber in town show above us on Google Maps?",
      "Write service pages for drain cleaning in the three towns we cover.",
      "Draft replies to our last ten reviews.",
    ],
    channels: [SEO, GEO, GOOGLE_ADS, INSTAGRAM, META_ADS],
    firstWeek: [
      "Day 1: Zavi checks your Google Business Profile and site against the top local competitors.",
      "Days 2 to 4: it drafts pages for your main services and towns, plus your review replies.",
      "By day 7: you publish what you approved and start asking every finished job for a review.",
    ],
  },
  {
    slug: "restaurants",
    name: "Restaurants",
    outcome: "Fill the quiet nights",
    icon: UtensilsCrossed,
    color: "text-[#ea580c]",
    week: {
      owner: "Your restaurant",
      days: [
        "Check your maps listing, menu link and photos against places nearby.",
        "Instagram posts for your quiet nights, built from your specials.",
        "Draft replies to your latest reviews.",
        "You approve before anything posts.",
      ],
    },
    metaTitle: "Zavi for restaurants: fill more tables from maps, reviews and Instagram",
    metaDescription:
      "Zavi keeps your maps listing, review replies, menu site and Instagram working together, so people deciding where to eat tonight pick you.",
    headline: "Fill more tables on the nights that are quiet.",
    subline:
      "Zavi keeps your maps listing, reviews and Instagram working together, so people deciding where to eat tonight pick you.",
    findYou:
      "Diners decide fast. They search 'dinner near me' or a cuisine on Google Maps, check the photos, reviews and menu, and scroll Instagram for what looks good. The restaurant with fresh photos, recent reviews and a menu that loads on a phone wins the table.",
    plays: [
      {
        title: "Maps listing check",
        body: "Connect Google Business Profile and Zavi checks hours, menu link, photos and categories against the spots nearby.",
      },
      {
        title: "Posts for the slow nights",
        body: "Instagram posts and captions built from your specials and events, timed for the nights you need to fill.",
        plan: "Starter",
      },
      {
        title: "A reply to every review",
        body: "Drafts replies that sound like you, not a template, for you to approve.",
        plan: "Starter",
      },
      {
        title: "A menu site that loads on a phone",
        body: "Build or fix a mobile site with your menu, hours and reservation link.",
      },
      {
        title: "Nearby ads for a quiet week",
        body: "Meta and Google ads to people close by, with a budget you set and approve.",
        plan: "Pro",
      },
    ],
    metrics: [
      { label: "Table reservations", why: "Booked covers, not just profile views." },
      { label: "Covers on quiet nights", why: "Where an extra table matters most." },
      { label: "Direct online orders", why: "Orders that skip the delivery-app fee." },
    ],
    asks: [
      "Tuesdays are dead. What can we post to fill tables?",
      "Reply to our three newest Google reviews.",
      "Make a simple site with our menu and a reservation link.",
    ],
    channels: [INSTAGRAM, SEO, GEO, UGC, META_ADS, TIKTOK],
    firstWeek: [
      "Day 1: Zavi checks your maps listing, menu site and reviews against the places nearby.",
      "Days 2 to 4: it drafts two weeks of Instagram posts and replies to your recent reviews.",
      "By day 7: your approved posts are going out ahead of the quiet nights.",
    ],
  },
  {
    slug: "real-estate",
    name: "Real estate",
    outcome: "Listing appointments and buyer leads",
    icon: House,
    color: "text-[#167f50]",
    week: {
      owner: "Your agency",
      days: [
        "Find the neighbourhoods where you should rank first.",
        "A market update page and post for each one.",
        "A listing appointment page with a clear next step.",
        "You approve what goes out.",
      ],
    },
    metaTitle: "Zavi for real estate agents: more listings and buyer leads",
    metaDescription:
      "Zavi drafts neighborhood guides, listing launch posts and market updates for past clients, and runs seller-lead ads with a budget you approve.",
    headline: "Win more listings by being the agent people find first.",
    subline:
      "Zavi turns your market knowledge into neighborhood pages, listing posts and market updates that bring buyers and sellers to you, not to the portals.",
    findYou:
      "Buyers start on the big portals, but sellers choose an agent by name, reviews and what they see about their neighborhood. A search for a real estate agent in their town, the listing posts on Instagram, and a market update from someone they know are where that choice gets made.",
    plays: [
      {
        title: "Neighborhood guides",
        body: "SEO pages for each area you work, covering schools, prices and what it is like to live there.",
        plan: "Starter",
      },
      {
        title: "A launch kit for every listing",
        body: "Instagram posts, captions and a listing page for each new property, from your photos.",
        plan: "Starter",
      },
      {
        title: "Market updates for past clients",
        body: "A monthly PDF or deck on local prices you can send to your sphere.",
      },
      {
        title: "Seller-lead ads",
        body: "Meta and Google campaigns aimed at homeowners in your farm area, with spend you approve.",
        plan: "Pro",
      },
      {
        title: "Listing updates across sites",
        body: "The browser agent handles the repetitive updates to listing details on the sites you use.",
        plan: "Starter",
      },
    ],
    metrics: [
      { label: "Listing appointments", why: "Sellers are where an agent's income starts." },
      { label: "Buyer inquiries", why: "Leads that come to you, not through a portal." },
      { label: "Listings won", why: "The number the rest of the year depends on." },
    ],
    asks: [
      "Write a neighborhood guide for the area we sell most in.",
      "Make Instagram posts for our new three-bed listing from these photos.",
      "Build a market update for past clients from last month's sales.",
    ],
    channels: [INSTAGRAM, SEO, GEO, META_ADS, GOOGLE_ADS],
    firstWeek: [
      "Day 1: Zavi reads your site and listings and writes a 30-day plan around listing appointments.",
      "Days 2 to 4: it drafts your first neighborhood guide and a launch kit for your newest listing.",
      "By day 7: you publish what you approved and send your first market update.",
    ],
  },
  {
    slug: "healthcare",
    name: "Healthcare practices",
    outcome: "New patients from nearby searches",
    icon: Stethoscope,
    color: "text-[#0284c7]",
    week: {
      owner: "Your practice",
      days: [
        "Find the searches new patients use near you.",
        "Draft a page per service, written for patients.",
        "Answers to common questions, ready for AI answers.",
        "Every draft waits for your review.",
      ],
    },
    metaTitle: "Zavi for healthcare practices: more booked appointments from local search",
    metaDescription:
      "Zavi helps clinics show up for local treatment searches and AI answers, drafts clear treatment pages for your review, and finds where visitors drop before booking.",
    headline: "More new patients from the searches near your practice.",
    subline:
      "Zavi helps clinics and practices show up for local searches, answer common patient questions online, and turn more visits into booked appointments.",
    findYou:
      "Patients search a treatment or specialty plus their town, compare practices on Google Maps by reviews, and more often ask an AI assistant who to see. They book with the practice that answers their question clearly and makes booking easy.",
    plays: [
      {
        title: "Treatment pages patients understand",
        body: "Clear pages for each treatment you offer, written around the questions patients ask.",
        plan: "Starter",
      },
      {
        title: "Local profile and review replies",
        body: "Checks your Google Business Profile against nearby practices and drafts general review replies for you to check.",
        plan: "Starter",
      },
      {
        title: "Show up when patients ask AI",
        body: "Checks whether AI assistants mention your practice for your specialty in your area.",
      },
      {
        title: "Find the booking drop-off",
        body: "Connect GA4 and Zavi shows where visitors leave before booking an appointment.",
      },
      {
        title: "Treatment search ads",
        body: "Google search ads for treatment searches in your area, with a budget you approve.",
        plan: "Pro",
      },
    ],
    metrics: [
      { label: "Appointments booked", why: "The outcome every page and profile serves." },
      { label: "New patient enquiries", why: "Calls and forms from people not yet on your books." },
      { label: "Calls from Google Maps", why: "Where most local patients first make contact." },
    ],
    asks: [
      "Write a page explaining our teeth whitening treatment for patients.",
      "Why do we show up below the other clinic on Maps?",
      "Where do people leave our booking page?",
    ],
    channels: [SEO, GEO, GOOGLE_ADS, INSTAGRAM],
    firstWeek: [
      "Day 1: Zavi checks your site, Maps profile and AI-answer presence for your main treatments.",
      "Days 2 to 4: it drafts pages for your two most-booked treatments, for your review.",
      "By day 7: you publish what you signed off, and Zavi flags where your booking page loses people.",
    ],
    reviewNote:
      "Zavi does not check content against healthcare advertising or privacy rules. Everything it drafts is for you to review before it is published.",
  },
  {
    slug: "financial-advisors",
    name: "Financial advisors",
    outcome: "Consultations with the right clients",
    icon: PiggyBank,
    color: "text-[#5b21b6]",
    week: {
      owner: "Your practice",
      days: [
        "Find the clients you're best placed to help and what they search.",
        "A guide page and a LinkedIn post for them.",
        "A consultation page with booking.",
        "Drafts wait for your review.",
      ],
    },
    metaTitle: "Zavi for financial advisors: more qualified consultations",
    metaDescription:
      "Zavi helps financial advisors publish plain-English guides, LinkedIn posts and local pages that bring in qualified consultations. Every draft is yours to review.",
    headline: "Get found by the clients you are best placed to help.",
    subline:
      "Zavi helps advisors publish the plain-English guides, LinkedIn posts and local pages that bring in qualified consultations.",
    findYou:
      "People look for a financial advisor after a life event: a new job, an inheritance, retirement getting close. They search the question first, then look for an advisor nearby or one who serves people like them, and read what that advisor has written before booking. Referrals still matter, and those people check your site and LinkedIn too.",
    plays: [
      {
        title: "Guides for life events",
        body: "Plain-English articles on the questions your clients ask, ready for your own review process before publishing.",
        plan: "Starter",
      },
      {
        title: "Market views on LinkedIn",
        body: "Posts drafted from your market notes and client questions. Nothing goes out without your approval.",
        plan: "Starter",
      },
      {
        title: "Know your niche",
        body: "Research on a client niche, like physicians or small-business owners, and what they search for.",
      },
      {
        title: "Client-ready quarterly decks",
        body: "Turn your quarterly market notes into a clean deck or PDF.",
      },
      {
        title: "Local and AI search check",
        body: "An SEO and AI-answer audit of how you show up when people look for an advisor in your area.",
      },
    ],
    metrics: [
      { label: "Consultations booked", why: "The first meeting is where a client relationship starts." },
      { label: "Qualified inbound leads", why: "People who fit the clients you serve best." },
      { label: "Site visitors who book", why: "Whether your content turns readers into meetings." },
    ],
    asks: [
      "Write a guide on what to do with a 401(k) when you change jobs.",
      "Turn my market notes into three LinkedIn posts.",
      "What do small-business owners in Austin search for about retirement?",
    ],
    channels: [LINKEDIN, SEO, GEO],
    firstWeek: [
      "Day 1: Zavi audits how you show up in local and AI search for your specialty.",
      "Days 2 to 4: it drafts your first life-event guide and a week of LinkedIn posts, for your review.",
      "By day 7: what you and your compliance process approved is live.",
    ],
    reviewNote:
      "Zavi does not check content against financial advertising or promotion rules. Every draft is for you, and your compliance process, to review before it is published.",
  },
  {
    slug: "law-firms",
    name: "Law firms",
    outcome: "Consultations by practice area",
    icon: Gavel,
    color: "text-[#0e0f11]",
    week: {
      owner: "Your firm",
      days: [
        "Find the practice-area searches in your city you don't rank for.",
        "Draft a page for the one you want most.",
        "Answers written so AI tools can cite you.",
        "Drafts wait for your review.",
      ],
    },
    metaTitle: "Zavi for law firms: more consultations from practice-area search",
    metaDescription:
      "Zavi helps law firms show up for practice-area and city searches and in AI answers, drafts pages for your review, and shows which pages bring consultation requests.",
    headline: "More consultations from people searching for your practice area.",
    subline:
      "Zavi helps firms show up when someone searches their legal problem in their city, and in the AI answers they read first.",
    findYou:
      "People rarely search for a firm by name. They search the problem and the place, like 'divorce lawyer Denver' or 'what to do after a car accident', and more often they ask an AI assistant first. The firms that answer those questions clearly, with strong reviews on Maps, get the consultation.",
    plays: [
      {
        title: "Practice-area pages by city",
        body: "Pages for each practice area and location you serve, written around real searches.",
        plan: "Starter",
      },
      {
        title: "Answers to what clients ask first",
        body: "Plain-language articles on the questions people have before they call a lawyer.",
        plan: "Starter",
      },
      {
        title: "Be the firm AI assistants name",
        body: "Checks which firms AI assistants name for your practice area and city, and what they cite.",
      },
      {
        title: "Who outranks you, and why",
        body: "Research on the firms above you for your main practice areas.",
      },
      {
        title: "Which pages bring consultations",
        body: "Connect GA4 and Search Console to see which pages bring visitors who request a consultation.",
      },
    ],
    metrics: [
      { label: "Consultations booked", why: "Every matter starts with one." },
      { label: "Qualified case inquiries", why: "Inquiries in the practice areas you want." },
      { label: "Calls from search and Maps", why: "Most people call the first firm that answers their question." },
    ],
    asks: [
      "Which firms show up when someone asks ChatGPT for a divorce lawyer in Denver?",
      "Write a page on what to do in the first week after a car accident.",
      "Which of our pages brings people who fill out the consultation form?",
    ],
    channels: [SEO, GEO, GOOGLE_ADS, LINKEDIN],
    firstWeek: [
      "Day 1: Zavi checks how your firm shows up in search and AI answers for your main practice areas.",
      "Days 2 to 4: it drafts pages for your top practice area in each city you serve, for your review.",
      "By day 7: you publish what you signed off, and Zavi tracks which pages bring consultation requests.",
    ],
    reviewNote:
      "Zavi does not check content against bar or legal advertising rules. Every draft is for your review before it is published.",
  },
];

export const USE_CASES_PATH = "/use-cases";

export function pathForUseCase(slug: string): string {
  return `${USE_CASES_PATH}/${slug}`;
}

export function findUseCase(slug: string): UseCase | undefined {
  return USE_CASES.find((u) => u.slug === slug);
}
