
export type PickerAgent = { slug: string; name: string; blurb: string | null };

const AGENT_COPY: Record<string, { name: string; blurb: string }> = {
  operator: { name: "Zavi", blurb: "Your whole team in one chat — I route work to the right agent." },
  "chief-of-staff": { name: "Chief of Staff", blurb: "I read your channels and decide what's a fire today." },
  advisor: { name: "Advisor", blurb: "I think out loud about your hardest call this week." },
  engineer: { name: "Engineer", blurb: "I read the repo, write the PR, stop short of merging." },
  qa: { name: "QA", blurb: "I run your tests on every PR and flag the top 3 failures." },
  pm: { name: "Product Manager", blurb: "I draft PRDs and triage your roadmap against user signals." },
  cgo: {
    name: "Chief Growth Officer",
    blurb: "I set your growth strategy — the one metric, the real constraint, the channels to bet on.",
  },
  "growth-lead": { name: "Head of Growth", blurb: "I own your whole growth funnel and brief Ads Manager on paid." },
  "performance-marketer": {
    name: "Ads Manager",
    blurb: "I'm your paid specialist. Head of Growth sets strategy, I run the channels.",
  },
  "funnel-analysis": { name: "Funnel Analyst", blurb: "I find the step where your signups stop converting." },
  "seo-geo": { name: "SEO & AI Search", blurb: "I audit what Google crawls and what AI answers cite." },
  "content-design": {
    name: "Content Designer",
    blurb: "I start from a user need and propose the clearest content change.",
  },
  "content-seo": {
    name: "Content Designer",
    blurb: "I start from a user need and propose the clearest content change.",
  },
  "support-lead": { name: "Support Lead", blurb: "I run T1 ops triage across support, payments, trust signals." },
  "dispute-response": { name: "Dispute Response", blurb: "I draft compelling-evidence chargeback responses." },
  research: { name: "Research", blurb: "I research any question across the web and cite every source." },
  "onboarding-discovery": {
    name: "Onboarding Discovery",
    blurb: "I find out who your company actually is and write it into the brain.",
  },
  "supply-demand-balancer": {
    name: "Supply & Demand",
    blurb: "I read your geo rollup and flag where supply and demand diverge.",
  },
  "browser-operator": { name: "Browser Operator", blurb: "I drive a real cloud browser end-to-end on your behalf." },
  fundraising: { name: "Fundraising", blurb: "I source stage-fit investors and hand you a tiered list as a CSV." },
};

const DEFAULT_SLUG = "operator";

function titleizeSlug(slug: string): string {
  const words = slug.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function chatSlug(param: string | string[] | undefined): string {
  const s = Array.isArray(param) ? param[0] : param;
  return s && /^[a-z0-9][a-z0-9_-]*$/i.test(s) ? s : DEFAULT_SLUG;
}

export function pickerAgentName(slug: string): string {
  return AGENT_COPY[slug]?.name ?? (slug ? titleizeSlug(slug) : AGENT_COPY[DEFAULT_SLUG].name);
}

export type PickerRow = PickerAgent & { lockedTier: string | null };

export const GROWTH_SLUG = "cgo";

export function customAgentRows(
  listed: readonly { slug: string; name?: string | null; locked_tier?: string | null; custom?: boolean }[],
): PickerRow[] {
  return listed
    .filter((a) => a.custom === true)
    .map((a) => ({
      slug: a.slug,
      name: a.name?.trim() || pickerAgentName(a.slug),
      blurb: null,
      lockedTier: lockedTierOf(a.locked_tier),
    }));
}

export function pickerSlugs(
  listed: readonly { slug: string; custom?: boolean }[] | undefined,
  channelAgents: readonly string[] = [],
): string[] {
  return [...new Set([DEFAULT_SLUG, GROWTH_SLUG, ...channelAgents, ...customAgentRows(listed ?? []).map((r) => r.slug)])];
}

export function topicLabel(
  slug: string,
  channel: string | null | undefined,
  names: { channel: (slug: string) => string; agent?: (slug: string) => string | null | undefined },
): string | null {
  if (slug === GROWTH_SLUG) return "Growth strategy";
  if (channel) return names.channel(channel);
  if (slug === DEFAULT_SLUG) return null;
  return names.agent?.(slug) || pickerAgentName(slug);
}

export function channelStarters(channelName: string): string[] {
  return [
    `How is ${channelName} doing?`,
    `What should I do next on ${channelName}?`,
    `What's holding ${channelName} back?`,
  ];
}

export function lockedTierOf(tier: string | null | undefined): string | null {
  return tier === "starter" || tier === "growth" || tier === "pro" ? tier : null;
}

type ThreadLike = { id: string; last_message_at: string | null };

export function mergeAgentThreads<T extends ThreadLike>(
  lists: readonly { slug: string; rows: readonly T[] | undefined }[],
): (T & { slug: string })[] {
  const time = (t: ThreadLike) => (t.last_message_at ? Date.parse(t.last_message_at) || 0 : 0);
  const byId = new Map<string, T & { slug: string }>();
  for (const { slug, rows } of lists) {
    for (const row of rows ?? []) {
      const prev = byId.get(row.id);
      if (!prev || time(row) > time(prev)) byId.set(row.id, { ...row, slug });
    }
  }
  return [...byId.values()].sort((a, b) => time(b) - time(a));
}
