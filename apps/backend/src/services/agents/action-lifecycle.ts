
import { serviceClient } from "@/services/supabase";

type Sb = ReturnType<typeof serviceClient>;

export const ACTION_LIFECYCLE_AGENTS: ReadonlySet<string> = new Set([
  "growth-lead",
  "pm",
  "advisor",
  "operator",
  "qa",
  "dispute-response",
  "content-design",
]);

const EXTRA_DECISION_CLASS_PREFIXES: Readonly<Record<string, readonly string[]>> = {
  "content-design": ["content-seo"],
};

const LOOKBACK_DAYS = 30;
const MAX_ROWS = 24;

export type LifecycleDecision = {
  decision_class: string;
  status: string;
  label: string;
};

export type AgentActionLifecycle = {
  pending: LifecycleDecision[];
  acted: LifecycleDecision[];
  rejected: LifecycleDecision[];
  expired: LifecycleDecision[];
};

export async function isActionLifecycleContextEnabled(sb?: Sb): Promise<boolean> {
  try {
    const client = sb ?? serviceClient();
    const { data, error } = await client
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle<{ blob: Record<string, unknown> }>();
    if (error) return true;
    const blob = (data?.blob ?? {}) as Record<string, unknown>;
    return blob.action_lifecycle_context_enabled !== false;
  } catch {
    return true;
  }
}

function decisionLabel(
  decisionClass: string,
  body: Record<string, unknown> | null,
): string {
  const b = body ?? {};
  const raw =
    (typeof b.bet_claim === "string" && b.bet_claim) ||
    (typeof b.title === "string" && b.title) ||
    (typeof b.summary === "string" && b.summary) ||
    (typeof b.headline === "string" && b.headline) ||
    "";
  const text = raw.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 100) : decisionClass;
}

export async function loadAgentActionLifecycle(
  tenantId: string,
  agentSlug: string,
  sb?: Sb,
): Promise<AgentActionLifecycle | null> {
  try {
    const client = sb ?? serviceClient();
    const sinceIso = new Date(
      Date.now() - LOOKBACK_DAYS * 86_400_000,
    ).toISOString();
    const prefixes = [agentSlug, ...(EXTRA_DECISION_CLASS_PREFIXES[agentSlug] ?? [])];
    const orFilter = prefixes
      .map((p) => `decision_class.like.${p}.%`)
      .join(",");
    const { data, error } = await client
      .from("decisions")
      .select("decision_class, status, body, emitted_at")
      .eq("tenant_id", tenantId)
      .or(orFilter)
      .gte("emitted_at", sinceIso)
      .order("emitted_at", { ascending: false })
      .limit(MAX_ROWS);
    if (error) return null;
    const rows = (data ?? []) as Array<{
      decision_class: string;
      status: string;
      body: Record<string, unknown> | null;
    }>;
    if (rows.length === 0) return null;

    const out: AgentActionLifecycle = {
      pending: [],
      acted: [],
      rejected: [],
      expired: [],
    };
    for (const r of rows) {
      const item: LifecycleDecision = {
        decision_class: r.decision_class,
        status: r.status,
        label: decisionLabel(r.decision_class, r.body),
      };
      if (r.status === "proposed") out.pending.push(item);
      else if (r.status === "acted") out.acted.push(item);
      else if (r.status === "rejected") out.rejected.push(item);
      else if (r.status === "expired") out.expired.push(item);
    }
    if (
      out.pending.length === 0 &&
      out.acted.length === 0 &&
      out.rejected.length === 0 &&
      out.expired.length === 0
    ) {
      return null;
    }
    return out;
  } catch {
    return null;
  }
}

function bullets(items: LifecycleDecision[]): string {
  return items.map((i) => `  - ${i.label}`).join("\n");
}

export function renderActionLifecycleBlock(c: AgentActionLifecycle): string {
  const sections: string[] = [];
  if (c.pending.length > 0) {
    sections.push(
      `### ⏳ Still awaiting the founder (${c.pending.length})\n${bullets(c.pending)}\n→ Still in the approval queue. If still live, follow up / note how long it has been open; do NOT re-propose an equivalent as brand-new.`,
    );
  }
  if (c.acted.length > 0) {
    sections.push(
      `### ✅ Approved & acted (${c.acted.length})\n${bullets(c.acted)}\n→ Done. Build on these; do NOT re-propose them.`,
    );
  }
  if (c.rejected.length > 0) {
    sections.push(
      `### ✋ Declined by the founder (${c.rejected.length})\n${bullets(c.rejected)}\n→ Do NOT re-raise unless something material changed — say what changed if you do.`,
    );
  }
  if (c.expired.length > 0) {
    sections.push(
      `### ⌛ Expired unacted (${c.expired.length})\n${bullets(c.expired)}\n→ The founder never got to these. Re-surface ONE with that context if still the priority, or drop it — do not silently repeat the same pile.`,
    );
  }
  if (sections.length === 0) return "";
  return [
    "\n\n---",
    "## Your open loops & recent outcomes (your own proposals, last 30d)",
    "Before proposing anything new, reconcile against what you already put in front of the founder. Open by acknowledging open/decided items so you close the loop instead of re-advising. Never present a stale or already-decided item as brand-new.",
    "",
    ...sections,
  ].join("\n");
}
