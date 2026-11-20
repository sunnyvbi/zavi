
import { GEO_ENGINES, type GeoEngine } from "./engines";
import type { AnswerPosition, ResolvedCitation } from "./detect";
import { isOwned } from "./detect";

export const VISIBILITY_DISCLOSURE =
  "Sampled: each rate is computed from answers we collected for your tracked prompt set, in one country, and carries its sample size and a 95% interval. It describes that prompt set, not every AI answer in your market.";

export const MAX_CITED_PAGES = 25;
export const MAX_SOURCE_DOMAINS = 30;

export type SweepPrompt = { id: string; text: string; source: "zavi" | "custom" };

export type SweepForMetrics = {
  id: string;
  started_at: string;
  finished_at: string | null;
  engines: GeoEngine[];
  repeats: number;
  prompts: SweepPrompt[];
  prompt_set_hash: string;
  rivals: string[];
  rival_set_hash: string;
  owned_domains: string[];
};

export type ResponseForMetrics = {
  sweep_id: string;
  prompt_id: string;
  engine: GeoEngine;
  status: "ok" | "error";
  brand_mentioned: boolean;
  owned_cited: boolean;
  rivals_mentioned: string[];
  answer_position: AnswerPosition | null;
  citations: ResolvedCitation[];
};

export type Rate = {
  numerator: number;
  denominator: number;
  rate: number | null;
  ci95: { low: number; high: number } | null;
  margin_pp: number | null;
};

const round = (n: number, places: number): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

export function wilson(k: number, n: number, z = 1.96): { low: number; high: number } | null {
  if (n <= 0) return null;
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: round(Math.max(0, centre - half), 4), high: round(Math.min(1, centre + half), 4) };
}

export function rateOf(numerator: number, denominator: number): Rate {
  const ci95 = wilson(numerator, denominator);
  return {
    numerator,
    denominator,
    rate: denominator > 0 ? round(numerator / denominator, 4) : null,
    ci95,
    margin_pp: ci95 ? round(((ci95.high - ci95.low) / 2) * 100, 1) : null,
  };
}

export type RateDelta = {
  delta_pp: number;
  significant: boolean;
};

export function compareRates(current: Rate, previous: Rate): RateDelta | null {
  if (current.rate === null || previous.rate === null) return null;
  const n1 = current.denominator;
  const n2 = previous.denominator;
  const pooled = (current.numerator + previous.numerator) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  const diff = current.rate - previous.rate;
  return {
    delta_pp: round(diff * 100, 1),
    significant: se > 0 && Math.abs(diff / se) >= 1.96,
  };
}

export type EngineRate = Rate & { engine: GeoEngine; label: string };

export type PromptCell = {
  collected: number;
  mentioned: number;
  cited: number;
  mention_rate: number | null;
};

export type PromptRow = {
  prompt_id: string;
  prompt_text: string;
  source: "zavi" | "custom";
  engines: Record<GeoEngine, PromptCell>;
  all: PromptCell;
  rival_only_responses: number;
  top_rivals: { name: string; responses: number }[];
  cited_domains: { domain: string; responses: number; kind: SourceDomain["kind"]; rival: string | null }[];
};

export type SourceDomain = {
  domain: string;
  responses: number;
  used: number;
  citations: number;
  avg_citations: number;
  kind: "owned" | "rival" | "other";
  rival: string | null;
};

export type VisibilityMetrics = {
  tier: 2;
  provenance: "sampled";
  disclosure: string;
  responses: {
    planned: number;
    collected: number;
    failed: number;
    sweeps: number;
    prompts: number;
    engines: number;
    repeats: number | null;
  };
  prompt_set_changed: boolean;
  mention_rate: Rate & { by_engine: EngineRate[] };
  citation_rate: Rate & {
    by_engine: EngineRate[];
    cited_pages: { url: string; responses: number }[];
    cited_pages_total: number;
  };
  source_mix: {
    domains: SourceDomain[];
    domains_total: number;
    infra_hidden: { domain: string; responses: number; used: number }[];
  };
  share_of_voice: {
    state: "ok" | "no_rivals" | "no_mentions";
    share: number | null;
    brand_mentions: number;
    rival_mentions: number;
    rivals: { name: string; mentions: number; share: number | null }[];
    rival_set_hash: string | null;
    responses_excluded_for_rival_change: number;
  };
  answer_position: Record<AnswerPosition, number>;
  prompt_coverage: { engine: GeoEngine; label: string; planned: number; collected: number; failed: number; coverage: number | null }[];
  prompt_grid: {
    rows: PromptRow[];
    totals: { engines: Record<GeoEngine, PromptCell>; all: PromptCell };
  };
};

const emptyCell = (): PromptCell => ({ collected: 0, mentioned: 0, cited: 0, mention_rate: null });

function finishCell(c: PromptCell): PromptCell {
  return { ...c, mention_rate: c.collected > 0 ? round(c.mentioned / c.collected, 4) : null };
}

function engineCells(): Record<GeoEngine, PromptCell> {
  return Object.fromEntries(GEO_ENGINES.map((e) => [e.id, emptyCell()])) as Record<GeoEngine, PromptCell>;
}

const alnum = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

export function rivalForDomain(domain: string, rivals: readonly string[]): string | null {
  const label = alnum(domain.split(".").slice(0, -1).join("") || domain);
  for (const r of rivals) {
    const n = alnum(r);
    if (n.length >= 4 && label.includes(n)) return r;
  }
  return null;
}

export function computeVisibility(input: {
  sweeps: SweepForMetrics[];
  responses: ResponseForMetrics[];
  engine?: GeoEngine | null;
}): VisibilityMetrics {
  const engineFilter = input.engine ?? null;
  const sweeps = [...input.sweeps].sort((a, b) => a.started_at.localeCompare(b.started_at));
  const sweepById = new Map(sweeps.map((s) => [s.id, s]));
  const engines = GEO_ENGINES.filter((e) => engineFilter === null || e.id === engineFilter);
  const rows = input.responses.filter(
    (r) => sweepById.has(r.sweep_id) && (engineFilter === null || r.engine === engineFilter),
  );
  const ok = rows.filter((r) => r.status === "ok");
  const collected = ok.length;

  const plannedFor = (engine: GeoEngine): number =>
    sweeps.reduce((n, s) => n + (s.engines.includes(engine) ? s.prompts.length * s.repeats : 0), 0);
  const prompt_coverage = engines.map((e) => {
    const planned = plannedFor(e.id);
    const got = ok.filter((r) => r.engine === e.id).length;
    return {
      engine: e.id,
      label: e.label,
      planned,
      collected: got,
      failed: rows.filter((r) => r.engine === e.id && r.status === "error").length,
      coverage: planned > 0 ? round(got / planned, 4) : null,
    };
  });
  const planned = prompt_coverage.reduce((n, c) => n + c.planned, 0);

  const byEngine = (pick: (r: ResponseForMetrics) => boolean): EngineRate[] =>
    engines.map((e) => {
      const set = ok.filter((r) => r.engine === e.id);
      return { engine: e.id, label: e.label, ...rateOf(set.filter(pick).length, set.length) };
    });

  const pageCounts = new Map<string, number>();
  for (const r of ok) {
    const seen = new Set<string>();
    for (const c of r.citations) {
      const owned = sweepById.get(r.sweep_id)!.owned_domains;
      if (c.infra || !isOwned(c.domain, owned) || seen.has(c.url)) continue;
      seen.add(c.url);
      pageCounts.set(c.url, (pageCounts.get(c.url) ?? 0) + 1);
    }
  }
  const cited_pages = [...pageCounts.entries()]
    .map(([url, responses]) => ({ url, responses }))
    .sort((a, b) => b.responses - a.responses || a.url.localeCompare(b.url));

  const latest = sweeps[sweeps.length - 1] ?? null;
  const allRivals = latest?.rivals ?? [];
  const allOwned = [...new Set(sweeps.flatMap((s) => s.owned_domains))];
  const domainAgg = new Map<string, { responses: number; citations: number; infra: boolean }>();
  for (const r of ok) {
    const perResponse = new Map<string, { n: number; infra: boolean }>();
    for (const c of r.citations) {
      if (!c.domain) continue;
      const cur = perResponse.get(c.domain) ?? { n: 0, infra: c.infra };
      cur.n += 1;
      perResponse.set(c.domain, cur);
    }
    for (const [domain, { n, infra }] of perResponse) {
      const agg = domainAgg.get(domain) ?? { responses: 0, citations: 0, infra };
      agg.responses += 1;
      agg.citations += n;
      domainAgg.set(domain, agg);
    }
  }
  const used = (n: number): number => (collected > 0 ? round(n / collected, 4) : 0);
  const visible = [...domainAgg.entries()]
    .filter(([, a]) => !a.infra)
    .map(([domain, a]): SourceDomain => {
      const owned = isOwned(domain, allOwned);
      const rival = owned ? null : rivalForDomain(domain, allRivals);
      return {
        domain,
        responses: a.responses,
        used: used(a.responses),
        citations: a.citations,
        avg_citations: round(a.citations / a.responses, 2),
        kind: owned ? "owned" : rival ? "rival" : "other",
        rival,
      };
    })
    .sort((a, b) => b.responses - a.responses || b.citations - a.citations || a.domain.localeCompare(b.domain));
  const infra_hidden = [...domainAgg.entries()]
    .filter(([, a]) => a.infra)
    .map(([domain, a]) => ({ domain, responses: a.responses, used: used(a.responses) }))
    .sort((a, b) => b.responses - a.responses);

  const sovHash = latest?.rival_set_hash ?? null;
  const sovRows = ok.filter((r) => sweepById.get(r.sweep_id)!.rival_set_hash === sovHash);
  const brandMentions = sovRows.filter((r) => r.brand_mentioned).length;
  const rivalCounts = allRivals.map((name) => ({
    name,
    mentions: sovRows.filter((r) => r.rivals_mentioned.includes(name)).length,
  }));
  const rivalMentions = rivalCounts.reduce((n, r) => n + r.mentions, 0);
  const sovTotal = brandMentions + rivalMentions;
  const sovState: VisibilityMetrics["share_of_voice"]["state"] =
    allRivals.length === 0 ? "no_rivals" : sovTotal === 0 ? "no_mentions" : "ok";

  const answer_position: Record<AnswerPosition, number> = {
    primary: 0,
    list_item: 0,
    in_body: 0,
    sources_only: 0,
    absent: 0,
  };
  for (const r of ok) answer_position[r.answer_position ?? (r.brand_mentioned ? "in_body" : "absent")] += 1;

  const promptMeta = new Map<string, SweepPrompt>();
  for (const s of sweeps) for (const p of s.prompts) promptMeta.set(p.id, p);
  const rowsById = new Map<string, PromptRow>();
  for (const meta of promptMeta.values()) {
    rowsById.set(meta.id, {
      prompt_id: meta.id,
      prompt_text: meta.text,
      source: meta.source,
      engines: engineCells(),
      all: emptyCell(),
      rival_only_responses: 0,
      top_rivals: [],
      cited_domains: [],
    });
  }
  const totals = { engines: engineCells(), all: emptyCell() };
  for (const r of ok) {
    const row = rowsById.get(r.prompt_id);
    if (!row) continue;
    for (const cell of [row.engines[r.engine], row.all, totals.engines[r.engine], totals.all]) {
      cell.collected += 1;
      if (r.brand_mentioned) cell.mentioned += 1;
      if (r.owned_cited) cell.cited += 1;
    }
    if (!r.brand_mentioned && r.rivals_mentioned.length > 0) row.rival_only_responses += 1;
  }
  const rivalTally = new Map<string, Map<string, number>>();
  for (const r of ok) {
    if (!rowsById.has(r.prompt_id)) continue;
    const t = rivalTally.get(r.prompt_id) ?? new Map<string, number>();
    for (const name of r.rivals_mentioned) t.set(name, (t.get(name) ?? 0) + 1);
    rivalTally.set(r.prompt_id, t);
  }
  const domainTally = new Map<string, Map<string, number>>();
  for (const r of ok) {
    if (!rowsById.has(r.prompt_id)) continue;
    const t = domainTally.get(r.prompt_id) ?? new Map<string, number>();
    const inResponse = new Set(r.citations.filter((c) => c.domain && !c.infra).map((c) => c.domain as string));
    for (const domain of inResponse) t.set(domain, (t.get(domain) ?? 0) + 1);
    domainTally.set(r.prompt_id, t);
  }
  const gridRows = [...rowsById.values()].map((row) => {
    for (const e of GEO_ENGINES) row.engines[e.id] = finishCell(row.engines[e.id]);
    row.all = finishCell(row.all);
    row.top_rivals = [...(rivalTally.get(row.prompt_id) ?? new Map()).entries()]
      .map(([name, responses]) => ({ name, responses }))
      .sort((a, b) => b.responses - a.responses)
      .slice(0, 5);
    row.cited_domains = [...(domainTally.get(row.prompt_id) ?? new Map<string, number>()).entries()]
      .map(([domain, responses]) => {
        const owned = isOwned(domain, allOwned);
        const rival = owned ? null : rivalForDomain(domain, allRivals);
        return { domain, responses, kind: owned ? ("owned" as const) : rival ? ("rival" as const) : ("other" as const), rival };
      })
      .sort((a, b) => b.responses - a.responses || a.domain.localeCompare(b.domain))
      .slice(0, 5);
    return row;
  });
  gridRows.sort((a, b) => (b.all.mention_rate ?? -1) - (a.all.mention_rate ?? -1) || a.prompt_text.localeCompare(b.prompt_text));
  for (const e of GEO_ENGINES) totals.engines[e.id] = finishCell(totals.engines[e.id]);
  totals.all = finishCell(totals.all);

  const repeats = new Set(sweeps.map((s) => s.repeats));

  return {
    tier: 2,
    provenance: "sampled",
    disclosure: VISIBILITY_DISCLOSURE,
    responses: {
      planned,
      collected,
      failed: rows.filter((r) => r.status === "error").length,
      sweeps: sweeps.length,
      prompts: promptMeta.size,
      engines: engines.filter((e) => sweeps.some((s) => s.engines.includes(e.id))).length,
      repeats: repeats.size === 1 ? [...repeats][0] : null,
    },
    prompt_set_changed: new Set(sweeps.map((s) => s.prompt_set_hash)).size > 1,
    mention_rate: {
      ...rateOf(ok.filter((r) => r.brand_mentioned).length, collected),
      by_engine: byEngine((r) => r.brand_mentioned),
    },
    citation_rate: {
      ...rateOf(ok.filter((r) => r.owned_cited).length, collected),
      by_engine: byEngine((r) => r.owned_cited),
      cited_pages: cited_pages.slice(0, MAX_CITED_PAGES),
      cited_pages_total: cited_pages.length,
    },
    source_mix: {
      domains: [
        ...visible.slice(0, MAX_SOURCE_DOMAINS),
        ...visible.slice(MAX_SOURCE_DOMAINS).filter((d) => d.kind === "owned"),
      ],
      domains_total: visible.length,
      infra_hidden,
    },
    share_of_voice: {
      state: sovState,
      share: sovState === "ok" ? round(brandMentions / sovTotal, 4) : null,
      brand_mentions: brandMentions,
      rival_mentions: rivalMentions,
      rivals: rivalCounts
        .map((r) => ({ ...r, share: sovTotal > 0 ? round(r.mentions / sovTotal, 4) : null }))
        .sort((a, b) => b.mentions - a.mentions),
      rival_set_hash: sovHash,
      responses_excluded_for_rival_change: collected - sovRows.length,
    },
    answer_position,
    prompt_coverage,
    prompt_grid: { rows: gridRows, totals },
  };
}
