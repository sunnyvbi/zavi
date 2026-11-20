
import {
  checkTenantFacts,
  checkConflictOfInterest,
  hasEnoughSources,
  type TenantIdentity,
} from "./fold-guards";

export interface FoldSourceEvent {
  id: string;
  tenant_id: string;
  gap_dimension: string | null;
  action_kind: string;
  agent_training_hint: string | null;
  before_score: number | null;
  after_score: number | null;
}

export interface FoldCandidate {
  pattern_summary: string;
  gap_dimension: string | null;
  target_agent_slug: string | null;
  source_event_ids: string[];
  source_tenant_count: number;
  conflict_of_interest: boolean;
  conflict_detail: string | null;
  tenant_fact_check: "clean" | "contains_tenant_fact";
}

export interface FoldRejection {
  reason:
    | "no_hint"
    | "single_tenant"
    | "contains_tenant_fact";
  gap_dimension: string | null;
  action_kind: string;
  detail: string;
}

export interface FoldResult {
  candidates: FoldCandidate[];
  rejections: FoldRejection[];
}

const GAP_TO_AGENT: Record<string, string> = {
  verified_brain: "onboarding-discovery",
  product_url: "onboarding-discovery",
  connectors: "chief-of-staff",
  goal_measurable: "chief-of-staff",
  deliverable: "chief-of-staff",
  founder_engaged: "chief-of-staff",
};

export function proposeFoldCandidates(
  events: FoldSourceEvent[],
  tenants: Map<string, TenantIdentity>,
): FoldResult {
  const groups = new Map<string, FoldSourceEvent[]>();
  for (const e of events) {
    const key = `${e.gap_dimension ?? "none"}::${e.action_kind}`;
    const list = groups.get(key) ?? [];
    list.push(e);
    groups.set(key, list);
  }

  const candidates: FoldCandidate[] = [];
  const rejections: FoldRejection[] = [];

  for (const [key, group] of groups) {
    const [gapRaw, action_kind] = key.split("::");
    const gap_dimension = gapRaw === "none" ? null : gapRaw;

    const hints = group
      .map((e) => (e.agent_training_hint ?? "").trim())
      .filter((h) => h.length > 0);

    if (hints.length === 0) {
      rejections.push({
        reason: "no_hint",
        gap_dimension,
        action_kind,
        detail: `${group.length} rescue(s) carried no agent_training_hint — the FDE did not write down what the agent should have done, so there is nothing to fold.`,
      });
      continue;
    }

    const sources: TenantIdentity[] = [];
    for (const e of group) {
      const t = tenants.get(e.tenant_id);
      if (t) sources.push(t);
    }

    if (!hasEnoughSources(sources)) {
      rejections.push({
        reason: "single_tenant",
        gap_dimension,
        action_kind,
        detail: `Seen on only ${new Set(sources.map((s) => s.tenant_id)).size} tenant. A lesson from one business is an anecdote — waiting for it to recur elsewhere before teaching it to the fleet.`,
      });
      continue;
    }

    const pattern_summary = dedupe(hints).join(" ");

    const factCheck = checkTenantFacts(pattern_summary, sources);
    if (!factCheck.clean) {
      rejections.push({
        reason: "contains_tenant_fact",
        gap_dimension,
        action_kind,
        detail: `The hint still names a source tenant ("${"token" in factCheck ? factCheck.token : "?"}"). Rewrite it as a general rule before it can be taught to the fleet.`,
      });
      continue;
    }

    const coi = checkConflictOfInterest(sources);

    candidates.push({
      pattern_summary,
      gap_dimension,
      target_agent_slug: gap_dimension ? (GAP_TO_AGENT[gap_dimension] ?? null) : null,
      source_event_ids: group.map((e) => e.id),
      source_tenant_count: new Set(sources.map((s) => s.tenant_id)).size,
      conflict_of_interest: coi.conflict,
      conflict_detail: coi.detail,
      tenant_fact_check: "clean",
    });
  }

  return { candidates, rejections };
}

function dedupe(hints: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of hints) {
    const norm = h.toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(h.trim());
  }
  return out;
}
