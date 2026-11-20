import { getChannel } from "@zavi/shared";

export const GROWTH_OFFICER_SLUG = "cgo";
export const OPERATOR_SLUG = "operator";
export const PERFORMANCE_MARKETER_SLUG = "performance-marketer";
export const ENGINEER_SLUG = "engineer";
export const REDDIT_ORGANIC_SLUG = "reddit_organic";

export type Department =
  | "Leadership"
  | "Build"
  | "Growth"
  | "Operations";

export const DEPARTMENT_ORDER: Department[] = [
  "Leadership",
  "Build",
  "Growth",
  "Operations",
];

export const FLEET_ORDER: string[] = [
  "operator",
  "chief-of-staff",
  "advisor",
  "qa",
  "engineer",
  "pm",
  "performance-marketer",
  "support-lead",
  "cgo",
  "growth-lead",
  "research",
  "content-design",
  "seo-geo",
];

export function fleetRank(slug: string): number {
  const i = FLEET_ORDER.indexOf(slug);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

export type AgentMeta = {
  department: Department;
  name: string;
  subtitle: string;
  roleDescription?: string;
  roleBullets?: string[];
};

export const AGENT_REGISTRY: Record<string, AgentMeta> = {
  operator: {
    department: "Leadership",
    name: "Zavi",
    subtitle: "Your whole team in one chat. I route work to the right agent.",
    roleDescription:
      "Your whole team in one chat. Routes every request to the right agent for you.",
    roleBullets: [
      "Routing work to the right agent",
      "Cross-team questions",
      "Status across your whole fleet",
    ],
  },
  "chief-of-staff": {
    department: "Leadership",
    name: "Chief of Staff",
    subtitle: "I read your channels and decide what's a fire today.",
    roleDescription:
      "Reads your channels and decides what needs your attention today.",
    roleBullets: [
      "Reading your channels",
      "Daily priority calls",
      "Escalating today's fires",
    ],
  },
  advisor: {
    department: "Leadership",
    name: "Advisor",
    subtitle: "I think out loud about your hardest call this week.",
    roleDescription:
      "Thinks through your hardest strategic calls and trade-offs with you.",
    roleBullets: [
      "Hard strategic calls",
      "Decision framing + tradeoffs",
      "Weekly big-picture review",
    ],
  },

  "engineer": {
    department: "Build",
    name: "Engineer",
    subtitle: "I read the repo, write the PR, stop short of merging.",
    roleDescription:
      "Handles engineering tasks, code reviews, and technical decisions for your team.",
    roleBullets: [
      "Code reviews",
      "Pull requests",
      "Technical architecture decisions",
      "Debugging",
      "Deployment tasks",
    ],
  },
  "qa": {
    department: "Build",
    name: "QA",
    subtitle: "I run your tests on every PR and flag the top 3 failures.",
    roleDescription:
      "Runs your tests on every PR and flags the top failures for your team.",
    roleBullets: [
      "Test runs on every PR",
      "Failure triage",
      "Regression flags",
    ],
  },
  "pm": {
    department: "Build",
    name: "Product Manager",
    subtitle: "I draft PRDs and triage your roadmap against user signals.",
    roleDescription:
      "Drafts PRDs and triages your roadmap against real user signals.",
    roleBullets: [
      "PRD drafts",
      "Roadmap triage",
      "User-signal synthesis",
    ],
  },

  "cgo": {
    department: "Growth",
    name: "Chief Growth Officer",
    subtitle:
      "I set your growth strategy: the one metric, the real constraint, the channels to bet on.",
    roleDescription:
      "Sets your growth strategy and the goal the rest of the team works toward.",
    roleBullets: [
      "Names your North Star metric",
      "Finds the one constraint holding growth back",
      "Picks the 2-3 channels worth betting on",
    ],
  },
  "growth-lead": {
    department: "Growth",
    name: "Head of Growth",
    subtitle: "I own your whole growth funnel and brief Ads Manager on paid.",
    roleDescription:
      "Owns your growth funnel end-to-end and briefs Ads Manager on paid.",
    roleBullets: [
      "Growth strategy across channels",
      "Funnel ownership",
      "Briefing Ads Manager on paid",
    ],
  },
  "performance-marketer": {
    department: "Growth",
    name: "Ads Manager",
    subtitle: "I'm your paid specialist. Head of Growth sets strategy, I run the channels.",
    roleDescription:
      "Runs your paid channels: campaigns, budgets, and creative testing.",
    roleBullets: [
      "Paid campaign management",
      "Ad-set optimization",
      "Budget + bid tuning",
      "Creative testing",
    ],
  },
  "funnel-analysis": {
    department: "Growth",
    name: "Funnel Analyst",
    subtitle: "I find the step where your signups stop converting.",
    roleDescription:
      "Finds the exact step where your signups stop converting.",
    roleBullets: [
      "Signup funnel analysis",
      "Conversion drop-off detection",
      "Step-level metrics",
    ],
  },
  "seo-geo": {
    department: "Growth",
    name: "SEO & AI Search",
    subtitle: "I audit what Google crawls and what AI answers cite.",
    roleDescription:
      "Audits your pages for organic search and for whether AI answer engines cite you.",
    roleBullets: [
      "Why a page isn't ranking",
      "Showing up in AI Overviews + ChatGPT",
      "Technical SEO, schema + content quality",
    ],
  },
  "content-design": {
    department: "Growth",
    name: "Content Designer",
    subtitle: "I start from a user need and propose the clearest content change.",
    roleDescription:
      "Starts from a user need and proposes the clearest content change.",
    roleBullets: [
      "Content changes from user needs",
      "Copy clarity reviews",
      "SEO-aware content proposals",
    ],
  },
  "content-seo": {
    department: "Growth",
    name: "Content Designer",
    subtitle: "I start from a user need and propose the clearest content change.",
    roleDescription:
      "Starts from a user need and proposes the clearest content change.",
    roleBullets: [
      "Content changes from user needs",
      "Copy clarity reviews",
      "SEO-aware content proposals",
    ],
  },

  "support-lead": {
    department: "Operations",
    name: "Support Lead",
    subtitle: "I run T1 ops triage across support, payments, trust signals.",
    roleDescription:
      "Runs T1 ops triage across support, payments, and trust signals.",
    roleBullets: [
      "T1 support triage",
      "Payments + trust escalations",
      "Routing chargebacks to Dispute Response",
    ],
  },
  "dispute-response": {
    department: "Operations",
    name: "Dispute Response",
    subtitle: "I draft compelling-evidence chargeback responses.",
    roleDescription:
      "Drafts compelling-evidence responses for your chargeback disputes.",
    roleBullets: [
      "Chargeback dispute triage",
      "Compelling-evidence drafts",
      "Stripe evidence submission",
    ],
  },

  "research": {
    department: "Operations",
    name: "Research",
    subtitle: "I research any question across the web and cite every source.",
    roleDescription:
      "Researches any question across multiple web sources and delivers cited reports.",
    roleBullets: [
      "Multi-source web research",
      "Source-cited reports",
      "Competitor + market questions",
    ],
  },
  "onboarding-discovery": {
    department: "Operations",
    name: "Onboarding Discovery",
    subtitle: "I find out who your company actually is and write it into the brain.",
    roleDescription:
      "Discovers who your company actually is (from your product and the open web) and writes it into the brain.",
    roleBullets: [
      "Product + web discovery",
      "Cited company facts",
      "Filling the company brain",
    ],
  },
  "supply-demand-balancer": {
    department: "Operations",
    name: "Supply & Demand",
    subtitle: "I read your geo rollup and flag where supply and demand diverge.",
    roleDescription:
      "Analyzes marketplace supply vs demand per geo and proposes draft growth actions.",
    roleBullets: [
      "Per-geo balance notes",
      "Supply/demand gap detection",
      "Draft geo growth actions",
    ],
  },
  "browser-operator": {
    department: "Operations",
    name: "Browser Operator",
    subtitle: "I drive a real cloud browser end-to-end on your behalf.",
    roleDescription:
      "Drives a real cloud browser on your behalf: navigates, reads, fills forms, clicks through flows.",
    roleBullets: [
      "Hands-on web tasks",
      "Form fills + click-throughs",
      "Reading live pages",
    ],
  },
  "fundraising": {
    department: "Operations",
    name: "Fundraising",
    subtitle: "I source stage-fit investors and hand you a tiered list as a CSV.",
    roleDescription:
      "Sources real investors who fit your raise stage and delivers a tiered list with outreach suggestions.",
    roleBullets: [
      "Stage-anchored investor sourcing",
      "Tier 1 / 2 / 3 fit ranking",
      "Downloadable CSV list",
      "Suggested outreach messages",
    ],
  },
};

export function getAgentMeta(slug: string): AgentMeta {
  return (
    AGENT_REGISTRY[slug] ?? {
      department: "Operations",
      name: titleizeSlug(slug),
      subtitle: "",
    }
  );
}

const CUSTOM_AGENT_NAMES = new Map<string, string>();

export function registerCustomAgentNames(
  rows: ReadonlyArray<{ slug: string; name?: string; custom?: boolean }>,
): void {
  for (const r of rows) {
    if (r.custom && typeof r.name === "string" && r.name && /^c-[a-z0-9]{8,12}$/.test(r.slug)) {
      CUSTOM_AGENT_NAMES.set(r.slug, r.name);
    }
  }
}

function titleizeSlug(slug: string): string {
  return slug
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function agentDisplayName(slug: string): string {
  const custom = CUSTOM_AGENT_NAMES.get(slug);
  if (custom) return custom;
  return AGENT_REGISTRY[slug]?.name ?? getChannel(slug)?.name ?? titleizeSlug(slug);
}

export function groupAgentsByDepartment<T extends { slug: string }>(
  agents: T[],
): Array<{ department: Department; agents: T[] }> {
  const buckets = new Map<Department, T[]>();
  for (const dept of DEPARTMENT_ORDER) buckets.set(dept, []);
  for (const a of agents) {
    const meta = getAgentMeta(a.slug);
    buckets.get(meta.department)!.push(a);
  }
  return DEPARTMENT_ORDER.map((department) => ({
    department,
    agents: buckets.get(department) ?? [],
  }));
}
