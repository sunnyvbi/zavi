
import type { Request, Response } from "express";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";
import {
  createMessageWithFailover,
  hasAnthropicAuth,
  DEFAULT_FAST_MODEL,
} from "@/services/anthropic";
import { normalizeCompetitors } from "@/services/agents/company-fact-sheet";
import { resolveDomain } from "@/services/onboarding/enrichment/domain-match";
import { extractBrands } from "@/agents/research/persist-snapshot";
import { findCompetitors } from "@/services/onboarding/enrichment/competitors";
import { logEvent } from "@/services/logging/logEvent";

const Body = z.object({
  domain_hint: z.string().max(255).optional(),
});

const BRAIN_SLUGS = ["company", "ops"] as const;

const MAX_BRAIN_CHARS = 12_000;

const SNAPSHOT_STALE_DAYS = 45;

const WEB_COOLDOWN_MS = 10 * 60_000;
const WEB_GLOBAL_PER_HOUR = 30;
const lastWebSearchByTenant = new Map<string, number>();
const webSearchTimes: number[] = [];

function mayRunWebSearch(tenant_id: string, now: number): boolean {
  const last = lastWebSearchByTenant.get(tenant_id);
  if (last !== undefined && now - last < WEB_COOLDOWN_MS) return false;
  while (webSearchTimes.length > 0 && now - webSearchTimes[0]! > 3_600_000) webSearchTimes.shift();
  return webSearchTimes.length < WEB_GLOBAL_PER_HOUR;
}

function recordWebSearch(tenant_id: string, now: number): void {
  lastWebSearchByTenant.set(tenant_id, now);
  webSearchTimes.push(now);
}

const SuggestionSchema = z.object({
  what_we_sell: z.string().optional(),
  who_we_serve: z.string().optional(),
});

export type FactCitation = {
  name: string;
  url: string;
  source_title: string;
  source_url: string;
};

export type SuggestedFact = {
  key: "domain" | "what_we_sell" | "who_we_serve" | "competitors";
  value: string;
  source: "brain" | "web" | "research";
  evidence: string;
  citations?: FactCitation[];
};

async function readBrain(
  sb: ReturnType<typeof staffCrossTenantClient>,
  tenant_id: string,
): Promise<string> {
  const { data, error } = await sb
    .from("memory_note")
    .select("slug, body_markdown")
    .eq("tenant_id", tenant_id)
    .in("slug", BRAIN_SLUGS as unknown as string[])
    .neq("source", "agent_discovery_inferred")
    .is("superseded_by", null)
    .is("archived_at", null);

  if (error || !Array.isArray(data)) return "";
  return data
    .map((r) => `## ${String(r.slug)}\n${String(r.body_markdown ?? "")}`)
    .join("\n\n")
    .slice(0, MAX_BRAIN_CHARS);
}

function extractJson(raw: string): unknown | null {
  const tag = raw.match(/<facts_json>([\s\S]*?)<\/facts_json>/);
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const bare = raw.match(/\{[\s\S]*\}/);
  for (const c of [tag?.[1], fence?.[1], bare?.[0]]) {
    if (!c) continue;
    try {
      return JSON.parse(c.trim());
    } catch {
    }
  }
  return null;
}

async function extractFromBrain(brain: string): Promise<z.infer<typeof SuggestionSchema>> {
  if (!hasAnthropicAuth() || brain.trim().length < 100) return {};

  const prompt = [
    "Below is a company's own internal notes, written by its operator.",
    "",
    "Extract TWO facts, using ONLY what the notes actually say:",
    '- what_we_sell: ONE line naming the product/category. e.g. "project management software for small agencies".',
    '- who_we_serve: ONE line naming the audience. e.g. "car owners who want to earn, and renters".',
    "",
    "HARD RULES:",
    "- Use ONLY facts present in the notes. Invent NOTHING.",
    "- Omit any key the notes do not clearly answer. An omitted key is CORRECT; a guessed one is a bug.",
    "- If the notes hedge (e.g. '[operator to confirm: ...]'), that is NOT a fact — omit it.",
    "- Do NOT name competitors. That is not asked for here and the notes are not a source for it.",
    "- Describe the product directly. Do NOT use an analogy to another company",
    '  (no "the Airbnb of X", no "Uber for Y") even if the notes phrase it that way.',
    "",
    "Reply with ONLY a JSON object inside <facts_json></facts_json> tags.",
    "",
    "NOTES:",
    brain,
  ].join("\n");

  try {
    const msg = await createMessageWithFailover(
      {
        model: DEFAULT_FAST_MODEL,
        max_tokens: 700,
        messages: [{ role: "user", content: prompt }],
      },
      { signal: AbortSignal.timeout(30_000) },
    );
    const text = msg.content
      .map((b: { type: string; text?: string }) => (b.type === "text" ? (b.text ?? "") : ""))
      .join("");
    const parsed = extractJson(text);
    if (!parsed) return {};
    return SuggestionSchema.parse(parsed);
  } catch {
    return {};
  }
}

const CONTEXT_ANALOGY = /\b(?:like|similar to|positioned as|the\s+\w+\s+of)\b|\b\w+\s+for\s+[a-z]/i;

export function safeSearchContext(whatWeSell: string | undefined): string {
  const line = (whatWeSell ?? "").trim();
  if (!line || CONTEXT_ANALOGY.test(line)) return "";
  return line;
}

async function fromSnapshot(
  sb: ReturnType<typeof staffCrossTenantClient>,
  tenant_id: string,
  now: Date,
): Promise<SuggestedFact | null> {
  const { data, error } = await sb
    .from("competitor_snapshots")
    .select("landscape, week_bucket, created_at")
    .eq("tenant_id", tenant_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ landscape: unknown; week_bucket: string | null; created_at: string }>();

  if (error || !data) return null;

  const brands = extractBrands(data.landscape);
  if (brands.length === 0) return null;

  const { value } = normalizeCompetitors(brands.join(", "));
  if (!value) return null;

  const ageDays = Math.floor((now.getTime() - Date.parse(data.created_at)) / 86_400_000);
  const week = data.week_bucket ? ` (week of ${data.week_bucket})` : "";
  const stale = Number.isFinite(ageDays) && ageDays > SNAPSHOT_STALE_DAYS;

  return {
    key: "competitors",
    value,
    source: "research",
    evidence: stale
      ? `from this tenant's competitor research${week} — ${ageDays} days old, re-check`
      : `from this tenant's competitor research${week}`,
  };
}

async function fromWeb(
  orgName: string,
  domain: string,
  searchContext: string,
): Promise<SuggestedFact | null> {
  const candidates = await findCompetitors(orgName, domain, searchContext).catch(() => []);
  if (candidates.length === 0) return null;

  const { value } = normalizeCompetitors(candidates.map((c) => c.name).join(", "));
  if (!value) return null;

  const kept = new Set(value.split(", ").map((n) => n.toLowerCase()));
  return {
    key: "competitors",
    value,
    source: "web",
    evidence: "found on the web just now — open each source before saving",
    citations: candidates
      .filter((c) => kept.has(c.name.toLowerCase()))
      .map((c) => ({
        name: c.name,
        url: c.url,
        source_title: c.source_title,
        source_url: c.source_url,
      })),
  };
}

export async function staffCompanyFactsSuggest(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const tenant_id = String(req.params.tenant_id ?? "");
  if (!tenant_id) {
    res.status(400).json({ error: { code: "missing_tenant", message: "tenant id required" } });
    return;
  }

  const parsed = Body.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid_body", message: parsed.error.message } });
    return;
  }

  const sb = staffCrossTenantClient(
    "admin console: research a tenant's company facts to propose them to a human",
  );

  const { data: tenantRow } = await sb
    .from("tenants")
    .select("display_name, product_url")
    .eq("id", tenant_id)
    .maybeSingle<{ display_name: string | null; product_url: unknown }>();

  if (!tenantRow) {
    res.status(404).json({ error: { code: "no_tenant", message: "tenant not found" } });
    return;
  }

  const suggestions: SuggestedFact[] = [];

  const brain = await readBrain(sb, tenant_id);
  const fromBrain = await extractFromBrain(brain);

  if (fromBrain.what_we_sell?.trim()) {
    suggestions.push({
      key: "what_we_sell",
      value: fromBrain.what_we_sell.trim(),
      source: "brain",
      evidence: "from this tenant's company brain",
    });
  }
  if (fromBrain.who_we_serve?.trim()) {
    suggestions.push({
      key: "who_we_serve",
      value: fromBrain.who_we_serve.trim(),
      source: "brain",
      evidence: "from this tenant's company brain",
    });
  }
  const pu = tenantRow.product_url as { marketing?: unknown } | null;
  const known =
    pu && typeof pu.marketing === "string" && pu.marketing.trim() ? pu.marketing.trim() : null;

  let resolvedDomain = known ? known.replace(/^https?:\/\//i, "").replace(/\/.*$/, "") : "";

  if (known) {
    suggestions.push({
      key: "domain",
      value: known,
      source: "brain",
      evidence: "already set on this tenant's workspace settings",
    });
  } else {
    try {
      const r = await resolveDomain(tenantRow.display_name ?? "", {
        override: parsed.data.domain_hint,
      });
      if (r?.domain) {
        resolvedDomain = r.domain;
        suggestions.push({
          key: "domain",
          value: `https://${r.domain}`,
          source: "web",
          evidence:
            r.via === "override"
              ? "from the website you typed"
              : `matched from the company name (confidence ${r.confidence})`,
        });
      }
    } catch {
    }
  }

  let competitorSource: "research" | "web" | "none" | "rate_limited" = "none";
  const snapshotSuggestion = await fromSnapshot(sb, tenant_id, new Date()).catch(() => null);

  if (snapshotSuggestion) {
    suggestions.push(snapshotSuggestion);
    competitorSource = "research";
  } else if (resolvedDomain && (tenantRow.display_name ?? "").trim()) {
    const now = Date.now();
    if (!mayRunWebSearch(tenant_id, now)) {
      competitorSource = "rate_limited";
    } else {
      recordWebSearch(tenant_id, now);
      const webSuggestion = await fromWeb(
        tenantRow.display_name ?? "",
        resolvedDomain,
        safeSearchContext(fromBrain.what_we_sell),
      ).catch(() => null);
      if (webSuggestion) {
        suggestions.push(webSuggestion);
        competitorSource = "web";
      }
    }
  }

  void logEvent({
    level: "info",
    source: "admin.company_facts_suggest",
    code: "suggested",
    message: `company-facts suggest tenant=${tenant_id} n=${suggestions.length}`,
    meta: { competitor_source: competitorSource },
  });

  res.json({ tenant_id, suggestions });
}
