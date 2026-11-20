
import { AGENT_TRIGGERS } from "../services/agents/types";

export type PlaybookTrigger = Extract<(typeof AGENT_TRIGGERS)[number], "playbook">;

export type PlaybookDef = {
  slug: string;
  title: string;
  outcome: string;
  agent_slug: string;
  trigger: PlaybookTrigger;
  surface_kind: "playbook_card";
  data_used: string[];
  produces: string[];
  needs_approval: string[];
  est_credits: number;
  allowed_decision_classes: string[];
};

export const PLAYBOOKS: readonly PlaybookDef[] = [
  {
    slug: "recover-stalled-sellers",
    title: "Recover stalled sellers",
    outcome:
      "Re-activate sellers who listed but never completed setup, with a drafted nudge you approve before it sends.",
    agent_slug: "chief-of-staff",
    trigger: "playbook",
    surface_kind: "playbook_card",
    data_used: ["operator marketplace DB (active supply / funnel)", "company brain"],
    produces: [
      "list of stalled sellers with why-stalled",
      "a drafted re-activation email you approve before it sends",
    ],
    needs_approval: ["sending any seller email (you Approve each before it goes out)"],
    est_credits: 1200,
    allowed_decision_classes: ["outbound.send"],
  },
  {
    slug: "campaigns-over-cac",
    title: "Campaigns over CAC target",
    outcome:
      "Find ad sets spending above your CAC target and propose pausing the worst + reallocating budget — you approve every spend change.",
    agent_slug: "performance-marketer",
    trigger: "playbook",
    surface_kind: "playbook_card",
    data_used: ["Meta Ads (ad sets, spend, CAC)", "company brain (CAC target)"],
    produces: [
      "ad sets over CAC target, ranked",
      "a proposed pause + budget reallocation",
    ],
    needs_approval: [
      "pausing any ad set (you Approve)",
      "any budget reallocation (you Approve)",
    ],
    est_credits: 900,
    allowed_decision_classes: [
      "meta_ads.set_status_review",
      "meta_ads.update_ad_set_budget_review",
    ],
  },
] as const;

export function getPlaybook(slug: string): PlaybookDef | undefined {
  return PLAYBOOKS.find((p) => p.slug === slug);
}
