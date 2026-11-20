
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { getActiveGoals } from "@/services/autopilot/goal-measurement";
import { getTenantPersonalization } from "./store";
import { isMissingRelation, noteMissingRelationOnce } from "./missing-relation";

export type SummarySource = "confirmed" | "inferred";

export type SummaryItem = {
  text: string;
  source: SummarySource;
  updated_at: string | null;
  label?: string;
};

export type SummarySection = {
  id: "facts" | "goals" | "decisions" | "recent_work" | "agent_conclusions";
  items: SummaryItem[];
};

export type PersonalizationSummary = {
  updated_at: string | null;
  version: number;
  sections: SummarySection[];
};

const FACT_LABEL: Record<string, string> = {
  company_name: "Company name",
  domain: "Website",
  what_we_sell: "What you sell",
  who_we_serve: "Who you serve",
  competitors: "Competitors",
  markets: "Markets",
  industry: "Industry",
  location: "Based in",
  founded: "Founded",
  linkedin_url: "LinkedIn",
  instagram_url: "Instagram",
  facebook_url: "Facebook",
  x_url: "X",
};

const FACT_ORDER = Object.keys(FACT_LABEL);

const HUMAN_SOURCES = new Set(["human_confirmed", "typed_column", "staff_reviewed", "connector"]);

function firstLine(text: string, max = 140): string {
  const line = text.replace(/\r/g, "").split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const plain = line.replace(/^#+\s*/, "").replace(/[*_`]/g, "");
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

function decisionText(decision_class: string, body: unknown): string {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  for (const k of ["title", "headline", "summary", "action", "description", "rationale"]) {
    const v = b[k];
    if (typeof v === "string" && v.trim()) return firstLine(v);
  }
  return decision_class.replace(/[._-]+/g, " ");
}

function humanizeSlug(slug: string): string {
  const s = slug.replace(/[-_]+/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function newest(...stamps: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const s of stamps) {
    if (!s) continue;
    if (!best || Date.parse(s) > Date.parse(best)) best = s;
  }
  return best;
}

async function safeRows<T>(relation: string, run: () => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  try {
    const { data, error } = await run();
    if (error) {
      if (isMissingRelation(error)) noteMissingRelationOnce(relation, error);
      else console.warn(`[personalization] summary read '${relation}' failed: ${error.message}`);
      return [];
    }
    return Array.isArray(data) ? (data as T[]) : [];
  } catch (e) {
    if (isMissingRelation(e)) noteMissingRelationOnce(relation, e);
    return [];
  }
}

export async function buildPersonalizationSummary(tenant_id: string): Promise<PersonalizationSummary> {
  const client = tenantClient(asTenantId(tenant_id));

  const [facts, goals, decisions, runs, anchors, personalization] = await Promise.all([
    safeRows<{ key: string; value_text: string; source: string; verified_at: string }>("tenant_fact", () =>
      client.from("tenant_fact").select("key, value_text, source, verified_at"),
    ),
    getActiveGoals(tenant_id),
    safeRows<{ decision_class: string; body: unknown; status: string; emitted_at: string }>("decisions", () =>
      client
        .from("decisions")
        .select("decision_class, body, status, emitted_at")
        .in("status", ["approved", "acted"])
        .order("emitted_at", { ascending: false })
        .limit(5),
    ),
    safeRows<{ agent_slug: string; finished_at: string | null; output_text: string | null }>("agent_runs", () =>
      client
        .from("agent_runs")
        .select("agent_slug, finished_at, output_text")
        .eq("status", "success")
        .neq("agent_definition_hash", "seed-synthetic")
        .order("finished_at", { ascending: false })
        .limit(5),
    ),
    safeRows<{ updated_at: string; metadata: unknown }>("memory_note", () =>
      client
        .from("memory_note")
        .select("updated_at, metadata")
        .eq("slug", "company")
        .eq("note_type", "anchor")
        .is("superseded_by", null)
        .limit(1),
    ),
    getTenantPersonalization(tenant_id),
  ]);

  const factItems: SummaryItem[] = [];
  const byKey = new Map(facts.map((f) => [f.key, f]));
  for (const key of FACT_ORDER) {
    const f = byKey.get(key);
    if (!f || !f.value_text?.trim()) continue;
    factItems.push({
      label: FACT_LABEL[key],
      text: f.value_text.trim(),
      source: HUMAN_SOURCES.has(f.source) ? "confirmed" : "inferred",
      updated_at: f.verified_at ?? null,
    });
  }

  const goalItems: SummaryItem[] = goals
    .filter((g) => g.objective.trim())
    .map((g) => ({
      text: g.target_metric ? `${g.objective} (${g.target_metric})` : g.objective,
      source: "confirmed" as const,
      updated_at: null,
    }));

  const decisionItems: SummaryItem[] = decisions.map((d) => ({
    text: decisionText(d.decision_class, d.body),
    source: "confirmed" as const,
    updated_at: d.emitted_at ?? null,
  }));

  const runItems: SummaryItem[] = runs.map((r) => {
    const head = r.output_text ? firstLine(r.output_text) : "";
    return {
      label: humanizeSlug(r.agent_slug),
      text: head || `${humanizeSlug(r.agent_slug)} completed a run`,
      source: "inferred" as const,
      updated_at: r.finished_at ?? null,
    };
  });

  const anchor = anchors[0];
  const keyFacts = ((anchor?.metadata as { key_facts?: unknown } | null)?.key_facts ?? []) as unknown[];
  const conclusionItems: SummaryItem[] = keyFacts
    .filter(
      (x): x is { label: string; value: string } =>
        !!x &&
        typeof x === "object" &&
        typeof (x as { label?: unknown }).label === "string" &&
        typeof (x as { value?: unknown }).value === "string",
    )
    .slice(0, 12)
    .map((kf) => ({
      label: kf.label,
      text: kf.value,
      source: "inferred" as const,
      updated_at: anchor?.updated_at ?? null,
    }));

  return {
    updated_at: newest(
      personalization.updated_at,
      anchor?.updated_at,
      ...factItems.map((f) => f.updated_at),
    ),
    version: personalization.version,
    sections: [
      { id: "facts", items: factItems },
      { id: "goals", items: goalItems },
      { id: "decisions", items: decisionItems },
      { id: "recent_work", items: runItems },
      { id: "agent_conclusions", items: conclusionItems },
    ],
  };
}
