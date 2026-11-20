
export type ReplayCaseKind = "positive" | "negative" | "ambiguous";

export interface ReplayCase {
  id: string;
  agent_slug: string;
  prompt: string;
  kind: ReplayCaseKind;
  expected_slugs: string[];
  note: string;
}

export const REPLAY_CASES: readonly ReplayCase[] = [
  {
    id: "pos-pricing-copy",
    agent_slug: "growth-lead",
    prompt: "Write our pricing page copy — headline, plan descriptions, and CTAs.",
    kind: "positive",
    expected_slugs: ["copywriting", "page-cro"],
    note: "The original incident case: a pricing-page copy ask should ground in copywriting/page-cro.",
  },
  {
    id: "pos-landing-cro",
    agent_slug: "growth-lead",
    prompt: "Our landing page isn't converting — review it and tell me what to fix.",
    kind: "positive",
    expected_slugs: ["page-cro"],
    note: "A conversion-review ask maps cleanly to page-cro.",
  },
  {
    id: "pos-seo-audit",
    agent_slug: "growth-lead",
    prompt: "Why aren't we ranking on Google? Audit our SEO and give me the top fixes.",
    kind: "positive",
    expected_slugs: ["seo-audit"],
    note: "An explicit SEO-audit ask maps to seo-audit.",
  },
  {
    id: "pos-homepage-rewrite",
    agent_slug: "content-design",
    prompt: "Rewrite our homepage hero section — it reads flat and generic.",
    kind: "positive",
    expected_slugs: ["copywriting", "page-cro"],
    note: "content-design copy rewrite → copywriting (page-cro acceptable if it reframes structure).",
  },
  {
    id: "neg-mrr-data",
    agent_slug: "growth-lead",
    prompt: "What is our current MRR and how did it change week over week?",
    kind: "negative",
    expected_slugs: [],
    note: "A pure data question — no marketing playbook applies; loading one is noise.",
  },
  {
    id: "neg-slack-summary",
    agent_slug: "growth-lead",
    prompt: "Summarize what happened in our team Slack yesterday.",
    kind: "negative",
    expected_slugs: [],
    note: "An ops/summary task — should NOT page a copywriting/CRO/SEO playbook.",
  },
  {
    id: "amb-signup-page",
    agent_slug: "growth-lead",
    prompt: "Make our signup page better.",
    kind: "ambiguous",
    expected_slugs: ["page-cro", "copywriting"],
    note: "Copy vs CRO boundary — either load is defensible; watch which it picks.",
  },
  {
    id: "amb-onboarding-emails",
    agent_slug: "content-design",
    prompt: "Improve our onboarding emails so more people activate.",
    kind: "ambiguous",
    expected_slugs: ["copywriting"],
    note: "email-sequence isn't distilled yet — does it stretch copywriting or correctly load nothing?",
  },
];
