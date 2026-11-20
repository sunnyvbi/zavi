
export const COMPARE_PATH = "/compare";

export type Claim = {
  text: string;
  quote: string;
  sourceUrl: string;
  seen: string;
};

export type CompareRow = { label: string; other: Claim; zavi: string };

export type CompareFaq = { q: string; a: string };

export type Comparison = {
  slug: string;
  other: string;
  metaTitle: string;
  metaDescription: string;
  h1: string;
  intro: string;
  pickOther: string;
  pickZavi: string;
  rows: CompareRow[];
  otherWins: Claim[];
  zaviWins: string[];
  faq: CompareFaq[];
};

export function pathForComparison(slug: string): string {
  return `${COMPARE_PATH}/${slug}`;
}

export function formatSeen(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

const SEEN = "2026-10-10";
const SEEN_NOV = "2026-11-10";

const ZAVI_APPROVAL =
  "By default Zavi asks before it publishes or spends. You can let it act on its own inside limits you set, such as an ad budget or an ads spend cap; anything outside them still waits for you.";

export const COMPARISONS: Comparison[] = [
  {
    slug: "zavi-vs-lovable",
    other: "Lovable",
    metaTitle: "Zavi vs Lovable: build the product or grow it? | Zavi",
    metaDescription:
      "Zavi and Lovable compared, with sources: building apps versus growth work, Google Ads, SEO, pricing, and when Lovable is the better pick.",
    h1: "Zavi vs Lovable",
    intro:
      "Lovable builds websites and web apps from a chat, and its docs now cover Google Ads and SEO reviews for what you build. Zavi is an AI growth agent for your business: it reads your business, writes the growth plan, and runs the channels with your approval. Here is how they differ, with a source for every line about Lovable.",
    pickOther: "Pick Lovable if you need the product or site built, with Google Ads and SEO for that app handled in the same chat.",
    pickZavi: "Pick Zavi if the job is growth: an AI growth agent that plans the work, runs organic and paid channels, and asks your approval before it publishes or spends.",
    rows: [
      {
        label: "What it is",
        other: {
          text: "Its site says Lovable is an AI software engineer that builds websites and web apps by chat.",
          quote:
            "Lovable is an AI software engineer, which enables anyone to build for the web. Simply chat to instantly build websites and web apps, with no technical knowledge needed.",
          sourceUrl: "https://lovable.dev/pricing",
          seen: SEEN,
        },
        zavi: "Zavi is an AI growth agent for your business.",
      },
      {
        label: "Ads",
        other: {
          text: "Its docs say it can build and launch Google Search, Performance Max and Demand Gen campaigns, with budget and targeting approved by you, and that this connector is rolling out gradually.",
          quote:
            "Build and launch Search, Performance Max, and Demand Gen campaigns from the project chat, with budget and targeting approved by you ... The Google Ads connector is rolling out gradually, so it may not be available in your workspace yet.",
          sourceUrl: "https://docs.lovable.dev/integrations/google-ads",
          seen: SEEN,
        },
        zavi: "Zavi's paid ad channels are on the Pro plan, and changes wait for your approval by default.",
      },
      {
        label: "SEO and AI search",
        other: {
          text: "Its docs say it runs an SEO and AI-search review and keyword research with live Semrush data.",
          quote: "Run an SEO and AI search review, research keywords and competitors with live Semrush data",
          sourceUrl: "https://docs.lovable.dev/features/seo-aeo",
          seen: SEEN,
        },
        zavi: "Zavi works on SEO and AI-search visibility as part of the growth work, and measures how often AI answers name you.",
      },
      {
        label: "Where it starts",
        other: {
          text: "Its homepage invites you to bring a new product, internal tool or company to life.",
          quote: "Bring a new product, internal tool, or entire company to life.",
          sourceUrl: "https://lovable.dev",
          seen: SEEN,
        },
        zavi: "Zavi reads your business first, then drafts a growth plan: the goal that matters, such as signups or bookings, and what is most likely holding it back.",
      },
    ],
    otherWins: [
      {
        text: "Building the product or site itself, from a plain-language description.",
        quote: "Describe what you want in plain language. Watch as Lovable builds production-grade software with you in real time.",
        sourceUrl: "https://lovable.dev",
        seen: SEEN,
      },
      {
        text: "Hosting, sign-in and payments handled for the app you build.",
        quote: "Lovable handles your end-to-end infrastructure \u2013 from hosting and authentication to payments and integrations.",
        sourceUrl: "https://lovable.dev",
        seen: SEEN,
      },
      {
        text: "SEO fixes for a Lovable app, most applied in one click.",
        quote: "Lovable surfaces clear recommendations and can apply most fixes in one click.",
        sourceUrl: "https://docs.lovable.dev/features/seo-aeo",
        seen: SEEN,
      },
    ],
    zaviWins: [
      "Built for growth on whatever site you already have, not only apps built in it.",
      "A growth plan Zavi writes from your business, run across organic and paid channels.",
      ZAVI_APPROVAL,
      "Its growth playbooks come from running a real company, Upcar, in public.",
    ],
    faq: [
      {
        q: "How is Zavi like Lovable?",
        a: "Lovable made building software as simple as describing it. Zavi aims to do the same for growth: it is an AI growth agent for your business that writes the growth plan and does the growth work.",
      },
      {
        q: "Can I use Zavi with a site built in Lovable?",
        a: "Yes. Zavi works on the growth of the site or app you already have, whatever it was built with.",
      },
      {
        q: "Can I try Zavi before paying?",
        a: "Yes. Zavi is free to start, with free credits every day and no card. See the pricing page for current plans.",
      },
    ],
  },
  {
    slug: "zavi-vs-genspark",
    other: "Genspark",
    metaTitle: "Zavi vs Genspark: AI growth agent or AI workspace? | Zavi",
    metaDescription:
      "Zavi and Genspark compared, with sources: an all-in-one AI workspace versus a growth agent, marketing roles, ad creative, pricing, and when Genspark is the better pick.",
    h1: "Zavi vs Genspark",
    intro:
      "Genspark's Super Agent is an AI assistant that plans and acts to complete everyday tasks. Zavi is an AI growth agent built for one job: moving a growth number. Here is how they differ, with a source for every line about Genspark.",
    pickOther: "Pick Genspark if you want decks, docs, sheets, research and ad creative made for you across many kinds of work.",
    pickZavi: "Pick Zavi if the work is growth: an AI growth agent that plans it, runs the channels, and asks your approval before it publishes or spends.",
    rows: [
      {
        label: "What it is",
        other: {
          text: "Its help center calls Super Agent Genspark's autonomous AI assistant that thinks, plans and acts to complete everyday tasks.",
          quote: "Super Agent is Genspark's autonomous AI assistant that thinks, plans, and acts to complete your everyday tasks.",
          sourceUrl: "https://www.genspark.ai/helpcenter",
          seen: SEEN,
        },
        zavi: "Zavi is an AI growth agent for your business: it reads your business, writes the growth plan, and runs the channels with your approval.",
      },
      {
        label: "Approval",
        other: {
          text: "Its business page says its agents complete multi-step work with you approving the steps that matter.",
          quote: "Autonomous agents that plan, research, and complete multi-step work ... with you approving the steps that matter.",
          sourceUrl: "https://www.genspark.ai/business",
          seen: SEEN,
        },
        zavi: ZAVI_APPROVAL,
      },
      {
        label: "Marketing work",
        other: {
          text: "Its Super Agent ships in ready-made roles, including a marketing planner and an SEO lead.",
          quote: '"Super Agent ships pre-cast in fifty roles \u2014 analyst, designer, PM, SEO lead." / "Mktg. Planner"',
          sourceUrl: "https://www.genspark.ai/business/products/super-agent",
          seen: SEEN,
        },
        zavi: "Zavi works out what is most likely holding your number back, proposes the work, and does it across organic and paid channels.",
      },
      {
        label: "Ads",
        other: {
          text: "Its ad generator designs ad creative on the canvas each placement needs.",
          quote: "The design agent composes the ad creative on the exact canvas each placement needs",
          sourceUrl: "https://www.genspark.ai/tools/ai-ad-generator",
          seen: SEEN,
        },
        zavi: "Zavi's paid ad channels are on the Pro plan, and changes wait for your approval by default.",
      },
    ],
    otherWins: [
      {
        text: "Decks, docs and spreadsheets made for you.",
        quote: "Native spreadsheets, docs, and decks that build themselves.",
        sourceUrl: "https://www.genspark.ai/business",
        seen: SEEN,
      },
      {
        text: "Editable ad creative, with copy, buttons and images kept as separate layers.",
        quote: "Genspark builds the ad as a layered design, so copy, buttons and imagery stay separate objects after generation.",
        sourceUrl: "https://www.genspark.ai/tools/ai-ad-generator",
        seen: SEEN,
      },
      {
        text: "More than 200 connectors, including Salesforce, HubSpot and Google Workspace.",
        quote: "200+ connectors to Salesforce, HubSpot, Snowflake, Google Workspace, Microsoft 365, Slack, and more.",
        sourceUrl: "https://www.genspark.ai/business",
        seen: SEEN,
      },
    ],
    zaviWins: [
      "Built for growth: an AI growth agent for your business that brings you the plan.",
      "It reads your real data and labels a weak read as a best guess.",
      ZAVI_APPROVAL,
      "Its growth playbooks come from running a real company, Upcar, in public.",
    ],
    faq: [
      {
        q: "Is Zavi an AI workspace like Genspark?",
        a: "No. Genspark's Super Agent takes on everyday tasks of many kinds. Zavi is built for growth: it reads your business, writes the growth plan, and does the growth work.",
      },
      {
        q: "Does Zavi act without asking?",
        a: ZAVI_APPROVAL,
      },
      {
        q: "Can I try Zavi before paying?",
        a: "Yes. Zavi is free to start, with free credits every day and no card. See the pricing page for current plans.",
      },
    ],
  },
  {
    slug: "zavi-vs-meta-muse",
    other: "Meta Muse",
    metaTitle: "Zavi vs Meta Muse for small business | Zavi",
    metaDescription:
      "Zavi and Meta Muse for Small Business compared, with sources: goals, ad accounts, approvals, pricing, and when Muse is the better pick.",
    h1: "Zavi vs Meta Muse",
    intro:
      "Muse is Meta's personal AI agent. Its small-business version works toward goals like finding new customers, using your Facebook Pages, Instagram analytics and Meta ad accounts. Zavi is an AI growth agent for your business, across channels beyond Meta's. Here is how they differ, with a source for every line about Muse.",
    pickOther: "Pick Muse if your business lives on Facebook and Instagram and you want an agent tied to those accounts.",
    pickZavi: "Pick Zavi if growth runs across more than Meta: your site, SEO, AI search and organic social, plus email and paid ads on Pro, all run from one growth plan.",
    rows: [
      {
        label: "What it is",
        other: {
          text: "Meta says you give Muse a goal, such as running your business or finding new customers.",
          quote: "Give Muse a goal \u2014 like running your business or finding new customers \u2014 and it gets it done.",
          sourceUrl: "https://about.fb.com/news/2026/09/introducing-muse-small-business/",
          seen: SEEN,
        },
        zavi: "Zavi is an AI growth agent for your business: it reads your business, writes the growth plan, and runs the channels with your approval.",
      },
      {
        label: "Accounts it works with",
        other: {
          text: "Meta says it connects Instagram professional analytics, Facebook Pages and Meta ad accounts.",
          quote: "Muse can connect your Instagram professional account analytics, Facebook Pages, and Meta ad accounts in a few clicks",
          sourceUrl: "https://about.fb.com/news/2026/09/introducing-muse-small-business/",
          seen: SEEN,
        },
        zavi: "Zavi works across channels, not one platform: your site, SEO, AI search and organic social, plus email and paid ads on Pro.",
      },
      {
        label: "Growth plans",
        other: {
          text: "Meta's own example asks Muse to analyse sales, campaigns and social and make a growth plan.",
          quote:
            "Analyze this year's sales, campaigns, and social and make me a growth plan to meet my business goals for next year.",
          sourceUrl: "https://about.fb.com/news/2026/09/introducing-muse-small-business/",
          seen: SEEN,
        },
        zavi: "Zavi reads your business, drafts the plan with what is most likely holding growth back, and labels a weak read as a best guess.",
      },
      {
        label: "Approval",
        other: {
          text: "Meta says nothing publishes, sends or spends without your approval.",
          quote: "You're in control: nothing publishes, sends, or spends without your approval.",
          sourceUrl: "https://about.fb.com/news/2026/09/introducing-muse-small-business/",
          seen: SEEN,
        },
        zavi: ZAVI_APPROVAL,
      },
    ],
    otherWins: [
      {
        text: "A business that lives on Facebook and Instagram: Muse already knows what you sell and how your brand sounds there.",
        quote: "it already understands your business: what you sell, what your brand sounds like, and what customers keep asking you about.",
        sourceUrl: "https://about.fb.com/news/2026/09/introducing-muse-small-business/",
        seen: SEEN,
      },
      {
        text: "Questions about the business's own finances, such as spotting expenses that look off.",
        quote: "How was my business's financial performance this month? Find any expenses that look off.",
        sourceUrl: "https://about.fb.com/news/2026/09/introducing-muse-small-business/",
        seen: SEEN,
      },
    ],
    zaviWins: [
      "Growth beyond Meta: your site, SEO, AI search and organic social, plus email and paid ads on Pro.",
      "Zavi brings you the growth plan, keeps adjusting it, and keeps track of what it tried.",
      ZAVI_APPROVAL,
      "Its growth playbooks come from running a real company, Upcar, in public.",
    ],
    faq: [
      {
        q: "Is Zavi like Meta Muse for small business?",
        a: "Both work toward a business goal and ask before they publish or spend. Muse connects Meta's own accounts: Facebook Pages, Instagram analytics and Meta ad accounts. Zavi works across your site, search and organic social, plus email and paid ads on Pro.",
      },
      {
        q: "Does Zavi act without asking?",
        a: ZAVI_APPROVAL,
      },
      {
        q: "Can I try Zavi before paying?",
        a: "Yes. Zavi is free to start, with free credits every day and no card. See the pricing page for current plans.",
      },
    ],
  },
  {
    slug: "zavi-vs-grok",
    other: "Grok",
    metaTitle: "Zavi vs Grok for marketing and growth | Zavi",
    metaDescription:
      "Zavi and Grok compared for growth work, with sources: live search, connected tools, memory, pricing, and when Grok is the better pick.",
    h1: "Zavi vs Grok for growth",
    intro:
      "Grok is xAI's general assistant for chat, search, reasoning and creation. Zavi is an AI growth agent for your business that does the growth work. Here is how they differ, with a source for every line about Grok.",
    pickOther: "Pick Grok if you want a general assistant with live search across the web and X, plus image and video generation.",
    pickZavi: "Pick Zavi if you want the growth work itself planned and done, with your approval before it publishes or spends.",
    rows: [
      {
        label: "What it is",
        other: {
          text: "Its site describes Grok as an assistant to chat, search, reason and create in one place.",
          quote: "AI that is useful for everyone. Chat, search, reason, and create \u2014 all in one place.",
          sourceUrl: "https://x.ai/grok",
          seen: SEEN,
        },
        zavi: "Zavi is an AI growth agent for your business: it reads your business, writes the growth plan, and runs the channels with your approval.",
      },
      {
        label: "Connected tools",
        other: {
          text: "Its docs list connectors for Gmail, Google Drive, Outlook, Teams, SharePoint and Salesforce, and you can add your own MCP server.",
          quote:
            '"Gmail & Google Calendar ... Google Drive ... Outlook Mail & Calendar ... Microsoft Teams ... SharePoint ... Salesforce" / "you can bring your own [Model Context Protocol (MCP)] server"',
          sourceUrl: "https://docs.x.ai/grok/connectors",
          seen: SEEN,
        },
        zavi: "Zavi connects to your ad accounts and data so it can propose changes and, with your approval, make them in your ad accounts. Website fixes come as drafts, or as a pull request you approve.",
      },
      {
        label: "Making changes",
        other: {
          text: "xAI says Grok can read and write emails, documents, spreadsheets and events in connected tools.",
          quote: "Grok can read and write emails, documents, spreadsheets, and events.",
          sourceUrl: "https://x.ai/blog/grok-connectors",
          seen: SEEN,
        },
        zavi: ZAVI_APPROVAL,
      },
      {
        label: "Memory",
        other: {
          text: "Its site says it remembers your preferences and past conversations.",
          quote: "Memory across chats \u2014 Remembers your preferences and past conversations",
          sourceUrl: "https://x.ai/grok",
          seen: SEEN,
        },
        zavi: "Zavi keeps a record of your goals, what it tried and what moved.",
      },
    ],
    otherWins: [
      {
        text: "Live search across the web and X for news and trends as they happen.",
        quote: "Searches the web and \u{1D54F} live, so answers always reflect what's happening right now",
        sourceUrl: "https://x.ai/grok",
        seen: SEEN,
      },
      {
        text: "Images and video generated from a prompt or a reference photo.",
        quote: "Generate images and video from text prompts or reference photos.",
        sourceUrl: "https://x.ai/grok",
        seen: SEEN,
      },
    ],
    zaviWins: [
      "Built specifically for growth work: experiments, ads, SEO, email, and drafted site fixes.",
      "Zavi brings you the growth plan, keeps adjusting it, and keeps track of what it tried.",
      ZAVI_APPROVAL,
      "Its growth playbooks come from running a real company, Upcar, in public.",
    ],
    faq: [
      {
        q: "Can't I just use Grok for marketing?",
        a: "You can use Grok to research, write and create. Zavi is an AI growth agent for your business: it reads your business, works out what is most likely holding growth back, proposes the work, and does it with your approval.",
      },
      {
        q: "Does Zavi act without asking?",
        a: ZAVI_APPROVAL,
      },
      {
        q: "Can I try Zavi before paying?",
        a: "Yes. Zavi is free to start, with free credits every day and no card. See the pricing page for current plans.",
      },
    ],
  },
  {
    slug: "zavi-vs-manus",
    other: "Manus",
    metaTitle: "Zavi vs Manus: AI growth agent or general AI agent? | Zavi",
    metaDescription:
      "Zavi and Manus compared, with sources: general tasks versus growth work, ad accounts, pricing, and when Manus is the better pick.",
    h1: "Zavi vs Manus",
    intro:
      "Manus is a general AI agent that takes on almost any task. Zavi is an AI growth agent built for one job: moving a growth number. Here is how they differ, with a source for every line about Manus.",
    pickOther: "Pick Manus if you want one agent for many kinds of work, from slide decks to research across hundreds of items.",
    pickZavi: "Pick Zavi if the work is growth: an AI growth agent that plans it, runs the channels, and asks your approval before it publishes or spends.",
    rows: [
      {
        label: "What it is",
        other: {
          text: "Its docs call Manus an autonomous general AI agent that plans, executes and delivers complete work products.",
          quote:
            "Manus AI is an autonomous general AI agent designed to complete tasks and deliver results. ... capable of planning, executing, and delivering complete work products from start to finish",
          sourceUrl: "https://manus.im/docs/introduction/welcome",
          seen: SEEN,
        },
        zavi: "Zavi is an AI growth agent for your business: it reads your business, writes the growth plan, and runs the channels with your approval.",
      },
      {
        label: "Marketing work",
        other: {
          text: "Its marketing page offers on-brand video ads, product demos and promo clips.",
          quote: "Generate on-brand video ads, product demos, and promo clips",
          sourceUrl: "https://manus.im/solutions/marketing",
          seen: SEEN,
        },
        zavi: "Zavi works out what is most likely holding your number back, proposes the work, and does it across organic and paid channels.",
      },
      {
        label: "Ad accounts",
        other: {
          text: "Its Meta Ads Manager connector is read-only.",
          quote: "For security and control, the connector cannot make changes to your campaigns.",
          sourceUrl: "https://manus.im/blog/manus-meta-ads-manager-connector",
          seen: SEEN,
        },
        zavi: "Zavi's paid ad channels are on the Pro plan, and changes wait for your approval by default.",
      },
      {
        label: "How it charges",
        other: {
          text: "It says the credits each task uses depend on how complex the task is.",
          quote: "The specific number of points/credits consumed by each interaction with Manus depends on the complexity of the task.",
          sourceUrl: "https://manus.im/docs/introduction/plans",
          seen: SEEN,
        },
        zavi: "Zavi also runs on credits, with free credits every day.",
      },
    ],
    otherWins: [
      {
        text: "Planning, doing and delivering complete work products for general tasks.",
        quote:
          "Manus AI is an autonomous general AI agent designed to complete tasks and deliver results. ... capable of planning, executing, and delivering complete work products from start to finish",
        sourceUrl: "https://manus.im/docs/introduction/welcome",
        seen: SEEN,
      },
      {
        text: "Slide decks from a short description.",
        quote: "Manus creates complete presentations from a simple description.",
        sourceUrl: "https://manus.im/docs/features/slides",
        seen: SEEN,
      },
      {
        text: "Research across many items at once.",
        quote: "Wide Research deploys hundreds of independent agents that work in parallel.",
        sourceUrl: "https://manus.im/docs/features/wide-research",
        seen: SEEN,
      },
    ],
    zaviWins: [
      "Built for growth: an AI growth agent for your business that brings you the plan.",
      "It reads your real data and labels a weak read as a best guess.",
      ZAVI_APPROVAL,
      "Its growth playbooks come from running a real company, Upcar, in public.",
    ],
    faq: [
      {
        q: "Is Zavi a general AI agent like Manus?",
        a: "No. Manus is a general agent for many kinds of tasks. Zavi is built for growth: it reads your business, writes the growth plan, and does the growth work.",
      },
      {
        q: "Does Zavi act without asking?",
        a: ZAVI_APPROVAL,
      },
      {
        q: "Can I try Zavi before paying?",
        a: "Yes. Zavi is free to start, with free credits every day and no card. See the pricing page for current plans.",
      },
    ],
  },
  {
    slug: "zavi-vs-chatgpt",
    other: "ChatGPT",
    metaTitle: "Zavi vs ChatGPT for marketing and growth | Zavi",
    metaDescription:
      "Zavi and ChatGPT compared for growth work, with sources: connected tools, ad accounts, memory, pricing, and when ChatGPT is the better pick.",
    h1: "Zavi vs ChatGPT for growth",
    intro:
      "ChatGPT is a general assistant you can ask about anything, including marketing. Zavi is an AI growth agent for your business that does the growth work. Here is how they differ, with a source for every line about ChatGPT.",
    pickOther: "Pick ChatGPT if you want help writing, researching and thinking through anything, growth included.",
    pickZavi: "Pick Zavi if you want the growth work itself planned and done, with your approval before it publishes or spends.",
    rows: [
      {
        label: "Connected tools",
        other: {
          text: "OpenAI's help center says the apps OpenAI builds are search-only today, and changing things in other tools needs a custom MCP app.",
          quote:
            "OpenAI-built apps are search-only today and do not support write actions. Use custom MCP apps for write/modify capabilities.",
          sourceUrl: "https://help.openai.com/en/articles/12584461",
          seen: SEEN,
        },
        zavi: "Zavi connects to your ad accounts and data so it can propose changes and, with your approval, make them in your ad accounts. Website fixes come as drafts, or as a pull request you approve.",
      },
      {
        label: "Making changes",
        other: {
          text: "It says write actions through custom apps are rolling out in beta to Business, Enterprise and Edu plans.",
          quote:
            "Full MCP (Model Context Protocol) support, including modify/write actions, is rolling out in beta to ChatGPT Business, Enterprise, and Edu plans.",
          sourceUrl: "https://help.openai.com/en/articles/12584461",
          seen: SEEN,
        },
        zavi: ZAVI_APPROVAL,
      },
      {
        label: "Where it starts",
        other: {
          text: "Its memory can draw on past chats, saved memories, files and connected apps.",
          quote: "past chats / saved memories / custom instructions / files in Library / content from connected apps, such as Gmail",
          sourceUrl: "https://help.openai.com/en/articles/8590148-memory-faq",
          seen: SEEN,
        },
        zavi: "Zavi starts from a growth plan it writes from your business and keeps a record of what it tried and what moved.",
      },
    ],
    otherWins: [
      {
        text: "Memory that can draw on your past chats, saved memories, files and connected apps.",
        quote: "past chats / saved memories / custom instructions / files in Library / content from connected apps, such as Gmail",
        sourceUrl: "https://help.openai.com/en/articles/8590148-memory-faq",
        seen: SEEN,
      },
      {
        text: "Deep research that can read from custom apps you connect.",
        quote: "Deep research can use custom apps, but for read/fetch actions only",
        sourceUrl: "https://help.openai.com/en/articles/12584461",
        seen: SEEN,
      },
    ],
    zaviWins: [
      "Built specifically for growth work: experiments, ads, SEO, email, and drafted site fixes.",
      "Zavi brings you the growth plan, keeps adjusting it, and keeps track of what it tried.",
      ZAVI_APPROVAL,
      "Its growth playbooks come from running a real company, Upcar, in public.",
    ],
    faq: [
      {
        q: "Can't I just use ChatGPT for marketing?",
        a: "You can use ChatGPT to write and research. Zavi is an AI growth agent for your business: it reads your business, works out what is most likely holding growth back, proposes the work, and does it with your approval.",
      },
      {
        q: "Does Zavi act without asking?",
        a: ZAVI_APPROVAL,
      },
      {
        q: "Can I try Zavi before paying?",
        a: "Yes. Zavi is free to start, with free credits every day and no card. See the pricing page for current plans.",
      },
    ],
  },
  {
    slug: "zavi-vs-polsia",
    other: "Polsia",
    metaTitle: "Zavi vs Polsia: grow your business or have AI run a company? | Zavi",
    metaDescription:
      "Zavi and Polsia compared, with sources: an AI that runs a whole company versus an AI growth agent, ads, who each is for, and when Polsia is the better pick.",
    h1: "Zavi vs Polsia",
    intro:
      "Polsia says it is your whole team in one AI, from the roadmap and the code to ads and customer replies. Zavi is an AI growth agent for your business: it reads your business, writes the growth plan, and runs the channels with your approval. Here is how they differ, with a source for every line about Polsia.",
    pickOther: "Pick Polsia if you want one AI to start a company and take on every role in it, from shipping code to replying to customers.",
    pickZavi: "Pick Zavi if you have a business and the job is growing it: an AI growth agent that plans the work, runs organic and paid channels, and asks your approval before it publishes or spends.",
    rows: [
      {
        label: "What it is",
        other: {
          text: "Its homepage says Polsia is your team: one name for every role.",
          quote: "Polsia is your team. ... One name. Every role.",
          sourceUrl: "https://polsia.com",
          seen: SEEN_NOV,
        },
        zavi: "Zavi is an AI growth agent for your business: it reads your business, writes the growth plan, and runs the channels with your approval.",
      },
      {
        label: "What it covers",
        other: {
          text: "Its homepage lists the roadmap, code, ads, customer replies, deals and tweets as work Polsia does.",
          quote:
            "Polsia plans your roadmap. Polsia ships your code. Polsia runs your ads. Polsia replies to customers. Polsia closes your deals. Polsia posts your tweets.",
          sourceUrl: "https://polsia.com",
          seen: SEEN_NOV,
        },
        zavi: "Zavi stays on growth: it works out what is most likely holding your number back, proposes the work, and does it across organic and paid channels.",
      },
      {
        label: "Ads",
        other: {
          text: "Its homepage says Polsia runs your ads.",
          quote: "Polsia runs your ads.",
          sourceUrl: "https://polsia.com",
          seen: SEEN_NOV,
        },
        zavi: "Zavi's paid ad channels are on the Pro plan, and changes wait for your approval by default.",
      },
      {
        label: "Where it starts",
        other: {
          text: "Its homepage invites you to start a company tonight.",
          quote: "Start a company tonight",
          sourceUrl: "https://polsia.com",
          seen: SEEN_NOV,
        },
        zavi: "Zavi reads your business first, then drafts a growth plan: the goal that matters, such as signups or bookings, and what is most likely holding it back.",
      },
    ],
    otherWins: [
      {
        text: "One AI for every role in a company, not only growth.",
        quote: "Polsia is your team. ... One name. Every role.",
        sourceUrl: "https://polsia.com",
        seen: SEEN_NOV,
      },
      {
        text: "Starting a new company from nothing.",
        quote: "Start a company tonight",
        sourceUrl: "https://polsia.com",
        seen: SEEN_NOV,
      },
      {
        text: "A first employee for a solo founder.",
        quote: "Polsia is your first employee. Never sleeps. The solo founder's standing army.",
        sourceUrl: "https://polsia.com",
        seen: SEEN_NOV,
      },
    ],
    zaviWins: [
      "Built for growth on the business you already have.",
      "A growth plan Zavi writes from your business, with a weak read labelled as a best guess.",
      ZAVI_APPROVAL,
      "Its growth playbooks come from running a real company, Upcar, in public.",
    ],
    faq: [
      {
        q: "Does Zavi run my whole company like Polsia?",
        a: "No. Polsia says it takes on every role in a company. Zavi is built for growth: it reads your business, writes the growth plan, and does the growth work.",
      },
      {
        q: "Does Zavi act without asking?",
        a: ZAVI_APPROVAL,
      },
      {
        q: "Can I try Zavi before paying?",
        a: "Yes. Zavi is free to start, with free credits every day and no card. See the pricing page for current plans.",
      },
    ],
  },
  {
    slug: "zavi-vs-sintra",
    other: "Sintra",
    metaTitle: "Zavi vs Sintra: AI growth agent or a team of AI employees? | Zavi",
    metaDescription:
      "Zavi and Sintra compared, with sources: a team of role-based AI employees versus one AI growth agent, marketing roles, how you work with each, and when Sintra is the better pick.",
    h1: "Zavi vs Sintra",
    intro:
      "Sintra sells a team of AI employees for business owners, each built for one role such as social media, SEO, email or customer support. Zavi is an AI growth agent for your business: it reads your business, writes the growth plan, and runs the channels with your approval. Here is how they differ, with a source for every line about Sintra.",
    pickOther: "Pick Sintra if you want a set of AI helpers for day-to-day work across the business, from social posts to your calendar and customer replies.",
    pickZavi: "Pick Zavi if the job is growth: an AI growth agent that plans the work, runs organic and paid channels, and asks your approval before it publishes or spends.",
    rows: [
      {
        label: "What it is",
        other: {
          text: "Its homepage says Sintra built AI employees for business roles, each one taking a specific function.",
          quote:
            "we built AI employees for real business roles. Each worker is designed to take ownership of a specific function",
          sourceUrl: "https://sintra.ai",
          seen: SEEN_NOV,
        },
        zavi: "Zavi is an AI growth agent for your business: it reads your business, writes the growth plan, and runs the channels with your approval.",
      },
      {
        label: "Marketing work",
        other: {
          text: "Its AI employees include an email marketing specialist, a copywriter, an SEO specialist and a social media manager.",
          quote:
            "Emmie Email Marketing Specialist. ... Penn Copywriter. ... Seomi SEO Specialist. ... Soshie Social Media Manager.",
          sourceUrl: "https://sintra.ai",
          seen: SEEN_NOV,
        },
        zavi: "Zavi works out what is most likely holding your number back, then does the work across organic and paid channels from one plan.",
      },
      {
        label: "How you work with it",
        other: {
          text: "Its FAQ says every AI worker runs as a chatbot.",
          quote: "Using Sintra AI is very intuitive and simple. Every AI worker runs as a chatbot.",
          sourceUrl: "https://sintra.ai",
          seen: SEEN_NOV,
        },
        zavi: "Zavi brings you the plan and a short list of actions to approve. You can also chat with it.",
      },
      {
        label: "Where it starts",
        other: {
          text: "It asks you to add your brand context, workflows and goals once, and its AI employees work from that.",
          quote:
            "Add your brand context, workflows, and goals once. This becomes the foundation your AI employees use to make decisions and produce work that fits your business.",
          sourceUrl: "https://sintra.ai",
          seen: SEEN_NOV,
        },
        zavi: "Zavi reads your business first, then drafts a growth plan: the goal that matters, such as signups or bookings, and what is most likely holding it back.",
      },
    ],
    otherWins: [
      {
        text: "Help outside growth, such as a virtual assistant for calendars, meetings and trips.",
        quote:
          "Virtual Assistant. A trustworthy AI for business owners and busy entrepreneurs to handle calendars, schedule meetings, plan trips",
        sourceUrl: "https://sintra.ai",
        seen: SEEN_NOV,
      },
      {
        text: "Customer support replies written in your brand's voice.",
        quote:
          "Cassie crafts expertly tailored responses to customer queries while maintaining your brand’s unique voice.",
        sourceUrl: "https://sintra.ai",
        seen: SEEN_NOV,
      },
      {
        text: "Work in more than 100 languages.",
        quote: "Speaks in 100+ languages.",
        sourceUrl: "https://sintra.ai",
        seen: SEEN_NOV,
      },
    ],
    zaviWins: [
      "One growth plan Zavi writes from your business, not a separate chat for each role.",
      "It reads your real data and labels a weak read as a best guess.",
      ZAVI_APPROVAL,
      "Its growth playbooks come from running a real company, Upcar, in public.",
    ],
    faq: [
      {
        q: "Is Zavi a team of AI employees like Sintra?",
        a: "No. Sintra gives you a set of AI employees, one per business role. Zavi is one AI growth agent: it reads your business, writes the growth plan, and does the growth work.",
      },
      {
        q: "Does Zavi act without asking?",
        a: ZAVI_APPROVAL,
      },
      {
        q: "Can I try Zavi before paying?",
        a: "Yes. Zavi is free to start, with free credits every day and no card. See the pricing page for current plans.",
      },
    ],
  },
];

export function findComparison(slug: string): Comparison | undefined {
  return COMPARISONS.find((c) => c.slug === slug);
}
