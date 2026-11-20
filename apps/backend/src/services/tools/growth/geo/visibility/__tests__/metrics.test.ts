import { describe, it, expect } from "vitest";
import {
  compareRates,
  computeVisibility,
  rateOf,
  rivalForDomain,
  wilson,
  type ResponseForMetrics,
  type SweepForMetrics,
} from "../metrics";
import type { ResolvedCitation } from "../detect";
import type { GeoEngine } from "../engines";

describe("wilson / rateOf", () => {
  it("matches the doc's bands", () => {
    expect(rateOf(150, 300).margin_pp).toBeCloseTo(5.6, 0);
    expect(rateOf(13, 25).margin_pp).toBeGreaterThan(17);
    expect(rateOf(13, 25).margin_pp).toBeLessThan(20.5);
    expect(rateOf(122, 360).margin_pp).toBeCloseTo(4.9, 0);
  });

  it("never claims ±0 at 0% or 100%", () => {
    expect(rateOf(0, 25).margin_pp).toBeGreaterThan(5);
    expect(rateOf(25, 25).ci95!.low).toBeLessThan(1);
  });

  it("is null, not 0%, when nothing was collected", () => {
    expect(rateOf(0, 0)).toEqual({ numerator: 0, denominator: 0, rate: null, ci95: null, margin_pp: null });
    expect(wilson(0, 0)).toBeNull();
  });
});

describe("compareRates", () => {
  it("marks a move inside the noise band as not significant", () => {
    const d = compareRates(rateOf(102, 300), rateOf(109, 300))!;
    expect(d.delta_pp).toBeCloseTo(-2.3, 1);
    expect(d.significant).toBe(false);
  });

  it("marks a real move as significant", () => {
    expect(compareRates(rateOf(150, 300), rateOf(90, 300))!.significant).toBe(true);
  });

  it("has no delta when either side has no rate", () => {
    expect(compareRates(rateOf(0, 0), rateOf(5, 10))).toBeNull();
  });
});

describe("rivalForDomain", () => {
  it("matches a rival's name inside the domain label", () => {
    expect(rivalForDomain("usecarly.com", ["Carly", "Turo"])).toBe("Carly");
    expect(rivalForDomain("turo.com", ["Carly", "Turo"])).toBe("Turo");
  });

  it("does not match short names that appear by accident", () => {
    expect(rivalForDomain("olacabs.com", ["Ola"])).toBeNull();
  });
});

const sweep = (over: Partial<SweepForMetrics> = {}): SweepForMetrics => ({
  id: "s1",
  started_at: "2026-09-10T00:00:00Z",
  finished_at: "2026-09-10T00:10:00Z",
  engines: ["chatgpt", "claude", "gemini", "perplexity"],
  repeats: 3,
  prompts: [
    { id: "p1", text: "best car rental app", source: "zavi" },
    { id: "p2", text: "hourly car rental near me", source: "custom" },
  ],
  prompt_set_hash: "ps1",
  rivals: ["Turo", "Getaround"],
  rival_set_hash: "rs1",
  owned_domains: ["upcar.ai"],
  ...over,
});

const cite = (url: string, domain: string, infra = false): ResolvedCitation => ({ url, domain, title: null, infra });

const resp = (over: Partial<ResponseForMetrics> & { prompt_id: string; engine: GeoEngine }): ResponseForMetrics => ({
  sweep_id: "s1",
  status: "ok",
  brand_mentioned: false,
  owned_cited: false,
  rivals_mentioned: [],
  answer_position: "absent",
  citations: [],
  ...over,
});

describe("computeVisibility", () => {
  const responses: ResponseForMetrics[] = [
    resp({
      prompt_id: "p1",
      engine: "chatgpt",
      brand_mentioned: true,
      owned_cited: true,
      answer_position: "primary",
      citations: [
        cite("https://upcar.ai/pricing", "upcar.ai"),
        cite("https://upcar.ai/pricing", "upcar.ai"),
        cite("https://reddit.com/r/cars", "reddit.com"),
      ],
    }),
    resp({
      prompt_id: "p1",
      engine: "chatgpt",
      rivals_mentioned: ["Turo"],
      citations: [cite("https://reddit.com/r/cars", "reddit.com"), cite("https://turo.com/", "turo.com")],
    }),
    resp({
      prompt_id: "p1",
      engine: "gemini",
      brand_mentioned: true,
      rivals_mentioned: ["Turo", "Getaround"],
      answer_position: "list_item",
      citations: [cite("https://vertexaisearch.cloud.google.com/x", "vertexaisearch.cloud.google.com", true)],
    }),
    resp({ prompt_id: "p2", engine: "claude", rivals_mentioned: ["Getaround"] }),
    resp({ prompt_id: "p2", engine: "claude", status: "error" }),
  ];
  const m = computeVisibility({ sweeps: [sweep()], responses });

  it("labels itself as a sample of OUR prompt set", () => {
    expect(m.tier).toBe(2);
    expect(m.provenance).toBe("sampled");
    expect(m.disclosure).toMatch(/tracked prompt set/);
  });

  it("excludes failed calls from every rate and reports them as coverage", () => {
    expect(m.responses).toMatchObject({ planned: 24, collected: 4, failed: 1, prompts: 2, repeats: 3 });
    expect(m.mention_rate).toMatchObject({ numerator: 2, denominator: 4, rate: 0.5 });
    const claude = m.prompt_coverage.find((c) => c.engine === "claude")!;
    expect(claude).toMatchObject({ planned: 6, collected: 1, failed: 1 });
  });

  it("keeps citation rate apart from mention rate, with the cited-pages drill-down", () => {
    expect(m.citation_rate).toMatchObject({ numerator: 1, denominator: 4, rate: 0.25 });
    expect(m.citation_rate.cited_pages).toEqual([{ url: "https://upcar.ai/pricing", responses: 1 }]);
  });

  it("source mix: used% over responses collected, avg citations over responses citing, infra hidden but listed", () => {
    const reddit = m.source_mix.domains.find((d) => d.domain === "reddit.com")!;
    expect(reddit).toMatchObject({ responses: 2, used: 0.5, citations: 2, avg_citations: 1, kind: "other" });
    const owned = m.source_mix.domains.find((d) => d.domain === "upcar.ai")!;
    expect(owned).toMatchObject({ responses: 1, citations: 2, avg_citations: 2, kind: "owned" });
    expect(m.source_mix.domains.find((d) => d.domain === "turo.com")).toMatchObject({ kind: "rival", rival: "Turo" });
    expect(m.source_mix.domains.some((d) => d.domain.includes("vertexaisearch"))).toBe(false);
    expect(m.source_mix.infra_hidden).toEqual([{ domain: "vertexaisearch.cloud.google.com", responses: 1, used: 0.25 }]);
  });

  it("share of voice: brand ÷ (brand + declared rivals)", () => {
    expect(m.share_of_voice).toMatchObject({ state: "ok", brand_mentions: 2, rival_mentions: 4, share: 0.3333 });
  });

  it("counts SOV against ONE rival list — responses from an earlier list are excluded, and counted", () => {
    const older = sweep({ id: "s0", started_at: "2026-09-01T00:00:00Z", rival_set_hash: "rs0", rivals: ["Zoomcar"] });
    const both = computeVisibility({
      sweeps: [older, sweep()],
      responses: [...responses, resp({ sweep_id: "s0", prompt_id: "p1", engine: "chatgpt", brand_mentioned: true })],
    });
    expect(both.share_of_voice.brand_mentions).toBe(2);
    expect(both.share_of_voice.responses_excluded_for_rival_change).toBe(1);
    expect(both.mention_rate.denominator).toBe(5);
  });

  it("says no_rivals rather than 100% when no rival list is declared", () => {
    const solo = computeVisibility({ sweeps: [sweep({ rivals: [] })], responses });
    expect(solo.share_of_voice).toMatchObject({ state: "no_rivals", share: null });
  });

  it("builds the prompt x model grid the two panels must reconcile against", () => {
    const p1 = m.prompt_grid.rows.find((r) => r.prompt_id === "p1")!;
    expect(p1.engines.chatgpt).toMatchObject({ collected: 2, mentioned: 1, mention_rate: 0.5 });
    expect(p1.engines.gemini).toMatchObject({ collected: 1, mentioned: 1, mention_rate: 1 });
    expect(p1.all).toMatchObject({ collected: 3, mentioned: 2 });
    expect(p1.rival_only_responses).toBe(1);
    expect(m.prompt_grid.totals.all.mentioned).toBe(m.mention_rate.numerator);
    expect(m.prompt_grid.totals.all.collected).toBe(m.mention_rate.denominator);
    expect(m.prompt_grid.rows[0].prompt_id).toBe("p1");
  });

  it("lists the domains each prompt's answers cited, counted once per answer, without retrieval plumbing", () => {
    const p1 = m.prompt_grid.rows.find((r) => r.prompt_id === "p1")!;
    expect(p1.cited_domains).toEqual([
      { domain: "reddit.com", responses: 2, kind: "other", rival: null },
      { domain: "turo.com", responses: 1, kind: "rival", rival: "Turo" },
      { domain: "upcar.ai", responses: 1, kind: "owned", rival: null },
    ]);
    expect(m.prompt_grid.rows.find((r) => r.prompt_id === "p2")!.cited_domains).toEqual([]);
  });

  it("keeps a row for a prompt whose every call failed — a coverage gap, not a missing row", () => {
    const failedOnly = computeVisibility({
      sweeps: [sweep()],
      responses: [resp({ prompt_id: "p2", engine: "claude", status: "error" })],
    });
    const p2 = failedOnly.prompt_grid.rows.find((r) => r.prompt_id === "p2")!;
    expect(p2.all).toMatchObject({ collected: 0, mention_rate: null });
    expect(failedOnly.prompt_grid.rows).toHaveLength(2);
  });

  it("filters the whole payload to one engine", () => {
    const gemini = computeVisibility({ sweeps: [sweep()], responses, engine: "gemini" });
    expect(gemini.responses).toMatchObject({ planned: 6, collected: 1, engines: 1 });
    expect(gemini.mention_rate.rate).toBe(1);
    expect(gemini.prompt_coverage.map((c) => c.engine)).toEqual(["gemini"]);
  });

  it("answer position is a distribution over collected responses", () => {
    expect(m.answer_position).toEqual({ primary: 1, list_item: 1, in_body: 0, sources_only: 0, absent: 2 });
  });

  it("flags a prompt-set change inside the window", () => {
    const changed = computeVisibility({
      sweeps: [sweep({ id: "s0", prompt_set_hash: "ps0", started_at: "2026-09-01T00:00:00Z" }), sweep()],
      responses,
    });
    expect(changed.prompt_set_changed).toBe(true);
    expect(m.prompt_set_changed).toBe(false);
  });
});

describe("computeVisibility source mix cap", () => {
  it("keeps your own domain when it ranks below the top 30", () => {
    const others = Array.from({ length: 31 }, (_, i) => `site${i}.com`);
    const responses = [
      ...[0, 1].map(() =>
        resp({ prompt_id: "p1", engine: "chatgpt", citations: others.map((d) => cite(`https://${d}/`, d)) }),
      ),
      resp({ prompt_id: "p1", engine: "claude", owned_cited: true, citations: [cite("https://upcar.ai/", "upcar.ai")] }),
    ];
    const m = computeVisibility({ sweeps: [sweep()], responses });
    expect(m.source_mix.domains_total).toBe(32);
    expect(m.source_mix.domains).toHaveLength(31);
    expect(m.source_mix.domains.at(-1)).toMatchObject({ domain: "upcar.ai", kind: "owned" });
  });
});
