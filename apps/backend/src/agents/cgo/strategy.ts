
import { CHANNELS, RETIRED_CHANNEL_SLUGS } from "@zavi/shared";
import { detectGoalJunk } from "@/services/autopilot/goal-metric-vocab";
import { goalMoneyMetric } from "@/services/growth/goal-trajectory";
import type { TenantFactKey } from "@/services/agents/company-fact-sheet";
import { fromTracedToolName } from "@/services/mcp/types";
import { tryParseEnvelopePayload } from "@/services/agents/envelope-json";

const KNOWN_CHANNEL_SLUGS: ReadonlySet<string> = new Set(
  CHANNELS.map((c) => c.slug).filter((s) => !RETIRED_CHANNEL_SLUGS.has(s)),
);

export function isMeasurableMetric(metric: string): boolean {
  const m = metric.trim();
  if (m.length === 0 || m.length > 40) return false;
  if (/^[\d.,%$]+$/.test(m)) return false;
  if (/[.?!]$/.test(m)) return false;
  if (m.split(/\s+/).length > 4) return false;
  if (detectGoalJunk({ target_metric: m }) !== null) return false;
  return true;
}

const NOT_A_COUNT_METRIC = /%|\b(rates?|ratio|percent|percentage|pct|roas|ltv cac|ctr|cvr|margin|score|rating|nps|avg|average|per|time|minutes?|hours?|days?|weeks?|months?|years?|payback)\b/i;
const READS_AS_X_METRIC = /\b(ratio|roas|ltv cac)\b/i;

function targetIsAMultiple(objective: string, metric: string, value: number): boolean {
  const key = metric.replace(/[_\-.:]+/g, " ");
  const multiples = [...objective.matchAll(/(\d+(?:\.\d+)?)\s*(?:x|×|times)(?![a-z])/gi)].map((m) => Number(m[1]));
  if (/\b(double|doubling|twice)\b/i.test(objective)) multiples.push(2);
  if (/\b(triple|tripling)\b/i.test(objective)) multiples.push(3);
  if (multiples.includes(value) && !READS_AS_X_METRIC.test(key)) return true;
  if (NOT_A_COUNT_METRIC.test(key)) return false;
  return !Number.isInteger(value) && !goalMoneyMetric(metric);
}

export function isUsableBetText(text: string): boolean {
  const t = text.trim();
  if (t.length < 12) return false;
  if (/^[\d.,%$]+$/.test(t)) return false;
  if (t.split(/\s+/).length < 3) return false;
  if (detectGoalJunk({ target_metric: t.slice(0, 40) }) !== null) return false;
  return true;
}

export const CHANNEL_FIT_VALUES = ["high", "medium", "low"] as const;
export type ChannelFitValue = (typeof CHANNEL_FIT_VALUES)[number];

export type ChannelFit = { channel_slug: string; value: ChannelFitValue; line: string };

const FIT_LINE_MAX = 180;

export function parseChannelFit(raw: unknown, bets: ChannelBet[]): ChannelFit[] {
  const out = new Map<string, ChannelFit>();
  for (const f of Array.isArray(raw) ? raw : []) {
    if (f === null || typeof f !== "object") continue;
    const ff = f as Record<string, unknown>;
    const slug = asString(ff.channel_slug);
    const value = asString(ff.value).toLowerCase();
    const line = asString(ff.line).replace(/\s+/g, " ");
    if (!slug || !KNOWN_CHANNEL_SLUGS.has(slug) || out.has(slug)) continue;
    if (!(CHANNEL_FIT_VALUES as readonly string[]).includes(value) || line.length < 8) continue;
    out.set(slug, {
      channel_slug: slug,
      value: value as ChannelFitValue,
      line: line.length > FIT_LINE_MAX ? `${line.slice(0, FIT_LINE_MAX - 1).trimEnd()}…` : line,
    });
  }
  for (const b of bets) {
    const line = b.rationale || b.intent;
    out.set(b.channel_slug, { channel_slug: b.channel_slug, value: "high", line });
  }
  return [...out.values()];
}

export type ChannelBet = {
  channel_slug: string;
  intent: string;
  rationale: string;
  expected_effect: string;
  falsifier: string;
};

export type BasisEvidenceKind =
  | "founder"
  | "platform"
  | "site"
  | "inferred"
  | "gap";

export type BasisEvidence = {
  kind: BasisEvidenceKind;
  source: string;
  statement: string;
};

const FOUNDER_FACT_KEYS: readonly TenantFactKey[] = [
  "domain",
  "what_we_sell",
  "who_we_serve",
  "competitors",
  "company_name",
  "markets",
];

const FOUNDER_SOURCES: ReadonlySet<string> = new Set(FOUNDER_FACT_KEYS);

const TOOL_BACKED_KINDS: ReadonlySet<BasisEvidenceKind> = new Set<BasisEvidenceKind>([
  "platform",
  "site",
]);

export type ParsedStrategy = {
  north_star: { metric: string; why: string; provenance: string };
  constraint: {
    statement: string;
    lever_family: string;
    evidence: string;
    confidence: "high" | "medium" | "low";
  };
  channel_bets: ChannelBet[];
  goal: {
    objective: string;
    target_metric: string;
    target_value: number;
    due_date: string;
  } | null;
  gaps: string[];
  unmeasured: Array<{ lever: string; the_one_read_that_would_size_it: string }>;
  basis_evidence: BasisEvidence[];
  company_facts?: CompanyFact[];
  growth_moves?: GrowthMove[];
  first_steps?: FirstStep[];
  target_rationale?: string;
  would_change_plan?: string[];
  summary?: string;
  also_fix?: string;
  brand_voice?: string;
  channel_fit?: ChannelFit[];
};

export type CompanyFact = { fact: string; source_url: string };

export const GROWTH_MOVE_LEVERS = [
  "product",
  "activation",
  "conversion",
  "trust",
  "supply",
  "pricing",
  "retention",
  "partnerships",
  "operations",
] as const;

export type GrowthMove = {
  title: string;
  lever: string;
  action: string;
  rationale: string;
  expected_effect: string;
  falsifier: string;
};

export type FirstStep = { when: string; step: string };

export type StrategyParseResult =
  | { ok: true; strategy: ParsedStrategy; repaired?: true }
  | { ok: false; reason: string };

const CONFIDENCE = new Set(["high", "medium", "low"]);

function extractBlock(text: string): string | null {
  const m = /<strategy>([\s\S]*?)<\/strategy>/i.exec(text);
  if (!m) return null;
  const inner = m[1].trim();
  return inner.length > 0 ? inner : null;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export function parseStrategy(outputText: string): StrategyParseResult {
  const block = extractBlock(outputText ?? "");
  if (block === null) return { ok: false, reason: "no <strategy> block in output" };

  const envelope = tryParseEnvelopePayload(block, { envelope_name: "strategy" });
  if (envelope.kind !== "strict" && envelope.kind !== "repaired") {
    return { ok: false, reason: "strategy block is not valid JSON" };
  }
  const raw = envelope.value;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "strategy block is not an object" };
  }
  const o = raw as Record<string, unknown>;

  const ns = (o.north_star ?? {}) as Record<string, unknown>;
  const nsMetric = asString(ns.metric);
  if (!nsMetric) return { ok: false, reason: "north_star.metric is missing" };

  const c = (o.constraint ?? {}) as Record<string, unknown>;
  const cStatement = asString(c.statement);
  if (!cStatement) return { ok: false, reason: "constraint.statement is missing" };
  const confRaw = asString(c.confidence).toLowerCase();
  const confidence = (CONFIDENCE.has(confRaw) ? confRaw : "low") as "high" | "medium" | "low";

  const betsRaw = Array.isArray(o.channel_bets) ? o.channel_bets : [];
  const channel_bets: ChannelBet[] = [];
  for (const b of betsRaw) {
    if (b === null || typeof b !== "object") continue;
    const bb = b as Record<string, unknown>;
    const slug = asString(bb.channel_slug);
    if (!slug || !KNOWN_CHANNEL_SLUGS.has(slug)) continue;

    const intent = asString(bb.intent);
    const falsifier = asString(bb.falsifier);
    if (!isUsableBetText(intent) || !isUsableBetText(falsifier)) continue;

    channel_bets.push({
      channel_slug: slug,
      intent,
      rationale: asString(bb.rationale),
      expected_effect: asString(bb.expected_effect),
      falsifier,
    });
    if (channel_bets.length === 3) break;
  }

  let goal: ParsedStrategy["goal"] = null;
  const g = (o.goal ?? {}) as Record<string, unknown>;
  const gObjective = asString(g.objective);
  const gMetric = asString(g.target_metric);
  const gValue = typeof g.target_value === "number" ? g.target_value : Number(g.target_value);
  const gDue = asString(g.due_date);
  const dueIsRealDate =
    /^\d{4}-\d{2}-\d{2}$/.test(gDue) &&
    !Number.isNaN(Date.parse(`${gDue}T00:00:00Z`)) &&
    new Date(`${gDue}T00:00:00Z`).toISOString().slice(0, 10) === gDue;
  if (
    gObjective &&
    isMeasurableMetric(gMetric) &&
    detectGoalJunk({ objective: gObjective }) === null &&
    Number.isFinite(gValue) &&
    gValue > 0 &&
    !targetIsAMultiple(gObjective, gMetric, gValue) &&
    dueIsRealDate
  ) {
    goal = {
      objective: gObjective,
      target_metric: gMetric,
      target_value: gValue,
      due_date: gDue,
    };
  }

  const clarify = (o.clarifications_needed ?? {}) as Record<string, unknown>;
  const questionSource = Array.isArray(o.questions)
    ? o.questions
    : Array.isArray(clarify.questions)
      ? clarify.questions
      : Array.isArray(o.gaps)
        ? o.gaps
        : [];
  const gaps = questionSource
    .map(asString)
    .filter((q) => q.length > 0)
    .slice(0, 5);

  const basis_evidence = (Array.isArray(o.basis_evidence) ? o.basis_evidence : [])
    .map((e) => {
      const ee = (e ?? {}) as Record<string, unknown>;
      return {
        kind: asString(ee.kind).toLowerCase() as BasisEvidenceKind,
        source: asString(ee.source),
        statement: asString(ee.statement),
      };
    })
    .filter(
      (e) =>
        e.statement.length > 0 &&
        (["founder", "platform", "site", "inferred", "gap"] as string[]).includes(e.kind),
    )
    .slice(0, 12);

  const unmeasured = (Array.isArray(o.unmeasured) ? o.unmeasured : [])
    .map((u) => {
      const uu = (u ?? {}) as Record<string, unknown>;
      return {
        lever: asString(uu.lever),
        the_one_read_that_would_size_it: asString(uu.the_one_read_that_would_size_it),
      };
    })
    .filter((u) => u.lever.length > 0);

  return {
    ok: true,
    strategy: {
      north_star: {
        metric: nsMetric,
        why: asString(ns.why),
        provenance: asString(ns.provenance),
      },
      constraint: {
        statement: cStatement,
        lever_family: asString(c.lever_family),
        evidence: asString(c.evidence),
        confidence,
      },
      channel_bets,
      goal,
      gaps,
      unmeasured,
      basis_evidence,
      ...parsePlanDetail(o),
      channel_fit: parseChannelFit(o.channel_fit, channel_bets),
    },
    ...(envelope.kind === "repaired" ? { repaired: true as const } : {}),
  };
}

export function normalizeSourceUrl(u: string): string | null {
  try {
    const url = new URL(u.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${url.hostname.toLowerCase().replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "").toLowerCase()}`;
  } catch {
    return null;
  }
}

export function guardCompanyFacts(facts: CompanyFact[] | undefined, research: unknown): CompanyFact[] | undefined {
  if (!facts || facts.length === 0) return undefined;
  const r = (research ?? {}) as {
    domain?: unknown;
    research_pages?: Array<{ url?: unknown }>;
    competitors?: Array<{ url?: unknown; source_url?: unknown }>;
    dossier_facts?: Array<{ source_url?: unknown }>;
  };
  const known = new Set<string>();
  const add = (v: unknown) => {
    const n = typeof v === "string" ? normalizeSourceUrl(v) : null;
    if (n) known.add(n);
  };
  for (const x of r.research_pages ?? []) add(x?.url);
  for (const x of r.competitors ?? []) {
    add(x?.url);
    add(x?.source_url);
  }
  for (const x of r.dossier_facts ?? []) add(x?.source_url);
  const domain = typeof r.domain === "string" ? r.domain.trim() : "";
  const own = domain ? normalizeSourceUrl(domain.includes("://") ? domain : `https://${domain}`)?.split("/")[0] ?? null : null;
  const kept = facts.filter((f) => {
    const n = normalizeSourceUrl(f.source_url);
    if (!n) return false;
    return known.has(n) || (own !== null && (n === own || n.startsWith(`${own}/`)));
  });
  return kept.length ? kept : undefined;
}

const isHttpUrl = (u: string): boolean => /^https?:\/\/[^\s]+\.[^\s]+/i.test(u);

export function parsePlanDetail(
  o: Record<string, unknown>,
): Pick<
  ParsedStrategy,
  "company_facts" | "growth_moves" | "first_steps" | "target_rationale" | "would_change_plan" | "summary" | "also_fix"
> {
  const arr = (v: unknown): Record<string, unknown>[] =>
    (Array.isArray(v) ? v : []).filter(
      (x): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x),
    );

  const company_facts = arr(o.company_facts)
    .map((f) => ({ fact: asString(f.fact), source_url: asString(f.source_url) }))
    .filter((f) => f.fact.length >= 12 && isHttpUrl(f.source_url))
    .slice(0, 10);

  const levers: ReadonlySet<string> = new Set(GROWTH_MOVE_LEVERS);
  const growth_moves = arr(o.growth_moves)
    .map((m) => ({
      title: asString(m.title),
      lever: levers.has(asString(m.lever).toLowerCase()) ? asString(m.lever).toLowerCase() : "product",
      action: asString(m.action),
      rationale: asString(m.rationale),
      expected_effect: asString(m.expected_effect),
      falsifier: asString(m.falsifier),
    }))
    .filter((m) => m.title.length > 0 && isUsableBetText(m.action) && isUsableBetText(m.falsifier))
    .slice(0, 6);

  const first_steps = arr(o.first_steps)
    .map((st) => ({ when: asString(st.when), step: asString(st.step) }))
    .filter((st) => st.step.length >= 12)
    .slice(0, 12);

  const target_rationale = asString(o.target_rationale);
  const summary = asString(o.summary).slice(0, 800);
  const also_fix = asString(o.also_fix).slice(0, 300);
  const brand_voice = asString(o.brand_voice).slice(0, 600);
  const would_change_plan = (Array.isArray(o.would_change_plan) ? o.would_change_plan : [])
    .map(asString)
    .filter((x) => x.length >= 12)
    .slice(0, 5);

  return {
    ...(company_facts.length ? { company_facts } : {}),
    ...(growth_moves.length ? { growth_moves } : {}),
    ...(first_steps.length ? { first_steps } : {}),
    ...(target_rationale ? { target_rationale } : {}),
    ...(would_change_plan.length ? { would_change_plan } : {}),
    ...(summary.length >= 20 ? { summary } : {}),
    ...(also_fix.length >= 12 ? { also_fix } : {}),
    ...(brand_voice.length >= 40 ? { brand_voice } : {}),
  };
}

export function guardBasisEvidence(
  raw: BasisEvidence[],
  observed: { tools: readonly string[] },
): BasisEvidence[] {
  const ran = new Set(observed.tools);
  const kept: BasisEvidence[] = [];
  const inferred: BasisEvidence[] = [];
  let readings = 0;
  for (const item of raw) {
    if (item.kind === "gap") continue;
    if (item.kind === "inferred") {
      inferred.push({ ...item, source: "" });
      continue;
    }
    if (TOOL_BACKED_KINDS.has(item.kind)) {
      if (!ran.has(item.source)) continue;
      if (NOT_EVIDENCE.has(item.source)) continue;
      kept.push(item);
      readings += 1;
      continue;
    }
    if (FOUNDER_SOURCES.has(item.source)) kept.push(item);
  }
  if (readings > 0) kept.push(...inferred);
  return kept;
}

export function observedTools(
  toolCalls: ReadonlyArray<{ name?: unknown; status?: unknown }> | null | undefined,
): string[] {
  return (toolCalls ?? [])
    .filter((t) => t.status === "ok")
    .map((t) => t.name)
    .filter((n): n is string => typeof n === "string")
    .map((n) => {
      const parsed = fromTracedToolName(n);
      return parsed ? `${parsed.server_id}__${parsed.tool_name}` : n;
    });
}

const NOT_EVIDENCE: ReadonlySet<string> = new Set(["growth__propose_business_controls", "growth__start_channel_work", "growth__record_card_answer"]);

const NOT_A_READ: ReadonlySet<string> = new Set([
  "growth__compute",
  "growth__explain_change",
  "growth__propose_business_controls",
  "growth__start_channel_work",
  "growth__record_card_answer",
]);

export function gapsFromUnusedTools(
  available: readonly string[],
  observed: { tools: readonly string[] },
): BasisEvidence[] {
  const ran = new Set(observed.tools);
  return available
    .filter((tool) => tool.startsWith("growth__") && !NOT_A_READ.has(tool) && !ran.has(tool))
    .map((tool) => ({
      kind: "gap" as const,
      source: "",
      statement: `${TOOL_LABELS[tool] ?? tool} was not read for this plan.`,
    }));
}

export const TOOL_LABELS: Readonly<Record<string, string>> = {
  growth__diagnose_funnel: "Funnel diagnosis",
  growth__read_cohort: "Cohort read",
  growth__read_revenue: "Revenue read",
  growth__ad_budget_room: "Ad budget",
  growth__read_ads_perf: "Ads performance",
  growth__seo_audit: "Site audit",
  growth__liquidity_gap: "Liquidity gap",
  growth__marketplace_intelligence: "Marketplace intelligence",
  growth__get_metric: "Metric read",
  growth__read_metric_history: "Metric history",
  growth__compute: "Calculation",
  growth__explain_change: "Change breakdown",
  growth__read_business_controls: "Business controls",
  growth__propose_business_controls: "Business controls proposal",
  growth__start_channel_work: "Channel work request",
  growth__record_card_answer: "Question answer recorded",
  memory__search: "Company memory",
  web_search__search: "Web search",
};

const FACT_LABELS: Readonly<Record<string, string>> = {
  domain: "Your website",
  what_we_sell: "What you sell",
  who_we_serve: "Who you serve",
  competitors: "Your competitors",
  company_name: "Your company",
  markets: "Your markets",
};

export function sourceLabel(source: string): string {
  return TOOL_LABELS[source] ?? FACT_LABELS[source] ?? "";
}

export function renderStrategy(s: ParsedStrategy): string {
  const lines: string[] = ["# Growth strategy", ""];

  lines.push(`## North Star — ${s.north_star.metric}`);
  if (s.north_star.why) lines.push("", s.north_star.why);
  if (s.north_star.provenance) lines.push("", `_Basis: ${s.north_star.provenance}_`);
  lines.push("");

  lines.push(`## The binding constraint (${s.constraint.confidence} confidence)`);
  lines.push("", s.constraint.statement);
  if (s.constraint.lever_family) lines.push("", `**Lever family:** ${s.constraint.lever_family}`);
  if (s.constraint.evidence) lines.push("", `**Evidence:** ${s.constraint.evidence}`);
  lines.push("");

  if (s.channel_bets.length > 0) {
    lines.push("## Channel bets", "");
    for (const b of s.channel_bets) {
      lines.push(`- **${b.channel_slug}** — ${b.intent}`);
      if (b.rationale) lines.push(`  - Why: ${b.rationale}`);
      if (b.expected_effect) lines.push(`  - Expected: ${b.expected_effect}`);
      lines.push(`  - Reconsider if: ${b.falsifier}`);
    }
    lines.push("");
  }

  if (s.goal) {
    lines.push("## Primary goal", "");
    lines.push(
      `${s.goal.objective} — \`${s.goal.target_metric}\` to ${s.goal.target_value} by ${s.goal.due_date}`,
    );
    lines.push("");
  } else {
    lines.push("## Primary goal", "", "_Not yet measurable — see open questions._", "");
  }

  if (s.unmeasured.length > 0) {
    lines.push("## Unmeasured levers", "");
    for (const u of s.unmeasured) {
      lines.push(`- **${u.lever}** — size it with: ${u.the_one_read_that_would_size_it}`);
    }
    lines.push("");
  }

  if (s.gaps.length > 0) {
    lines.push("## Open questions", "");
    for (const q of s.gaps) lines.push(`- ${q}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}
