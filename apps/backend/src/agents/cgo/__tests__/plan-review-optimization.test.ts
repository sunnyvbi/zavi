import { describe, expect, it, vi } from "vitest";
import { buildDossier, hasCheckDate, reviewAndRevisePlan, type PlanCritique, type ReviewDeps } from "../plan-review";
import type { ParsedStrategy } from "../strategy";

const draft = (): ParsedStrategy => ({
  north_star: { metric: "new_customers", why: "Customer growth", provenance: "founder" },
  constraint: { statement: "Signup friction", lever_family: "activation", evidence: 'Customers say "setup took a full afternoon".', confidence: "medium" },
  goal: { objective: "Reach 40 new customers by Dec 16", target_metric: "new_customers", target_value: 40, due_date: "2026-12-16" },
  channel_bets: [], gaps: [], unmeasured: [], basis_evidence: [],
});
const passed = (): PlanCritique => ({ scores: { constraint: 9, target: 9, actions: 9, effects: 9, grounding: 9 }, overall: 9, pass: true, issues: [], unsupported_facts: [] });

describe("review evidence coverage", () => {
  it("passes successful fetched pages to both the critic and reviser, keeping failures out", async () => {
    const tools = [
      { name: "mcp__server__web_fetch__fetch", status: "ok", output_preview: JSON.stringify({ url: "https://example.com/faq", text: "FAQ evidence that both models must see" }) },
      { name: "web_fetch__fetch", status: "tool_error", output_preview: "Failure is not a business fact" },
    ];
    const critique = vi.fn().mockResolvedValueOnce({ ...passed(), pass: false }).mockResolvedValue(passed());
    const revise = vi.fn().mockResolvedValue(`<strategy>${JSON.stringify(draft())}</strategy>`);
    await reviewAndRevisePlan({ strategy: draft(), tools }, { now: () => 0, critique, revise });
    expect(critique.mock.calls[0][0].dossier).toContain("FAQ evidence that both models must see");
    expect(revise.mock.calls[0][0].dossier).toBe(critique.mock.calls[0][0].dossier);
    expect(revise.mock.calls[0][0].dossier).not.toContain("Failure is not a business fact");
  });

  it("retains evidence from later reads when earlier reads are large, with valid bounded JSON", () => {
    const text = buildDossier({}, Array.from({ length: 12 }, (_, i) => ({
      name: "web_fetch__fetch", status: "ok", output_preview: `source_${i} ${"x".repeat(6000)}`,
    })));
    for (let i = 0; i < 12; i++) expect(text).toContain(`source_${i} `);
    const readings = JSON.parse(text.slice(text.indexOf("\n") + 1));
    expect(readings).toHaveLength(12);
    expect(readings.every((r: { truncated: boolean }) => r.truncated)).toBe(true);
    expect(text.length).toBeLessThanOrEqual(60_000);
  });

  it("gives reads the room small research leaves, so a full page fetch reaches the critic", () => {
    const page = `Enquiries answered within two working days. ${"y".repeat(7000)} Abu Dhabi Grand Prix 3-6 Dec`;
    const tools = [
      { name: "web_fetch__fetch", status: "ok", output_preview: page },
      ...Array.from({ length: 14 }, (_, i) => ({ name: "web_search__search", status: "ok", output_preview: `result_${i} ${"z".repeat(3000)}` })),
    ];
    const text = buildDossier({ research: { dossier_facts: [{ fact: "small" }] } }, tools);
    expect(text).toContain("Abu Dhabi Grand Prix 3-6 Dec");
    expect(text.length).toBeLessThanOrEqual(60_000);
  });

  it("keeps the reads floor beside large research and still fits the dossier", () => {
    const research = { dossier_facts: [{ fact: "f" }], research_pages: Array.from({ length: 30 }, (_, i) => ({ url: `https://a.test/${i}`, title: "t", text_excerpt: "p".repeat(5000) })) };
    const tools = Array.from({ length: 10 }, (_, i) => ({ name: "web_fetch__fetch", status: "ok", output_preview: `read_${i} ${"x".repeat(5000)}` }));
    const text = buildDossier({ research }, tools);
    const reads = text.slice(text.indexOf("SUCCESSFUL READS"));
    for (let i = 0; i < 10; i++) expect(reads).toContain(`read_${i} `);
    expect(reads.length).toBeGreaterThan(15_000);
    expect(text).toContain("INTAKE RESEARCH");
    expect(text.length).toBeLessThanOrEqual(60_000);
  });

  it("deduplicates identical readings without conflating different evidence from the same tool", () => {
    const read = { name: "web_fetch__fetch", status: "ok", output_preview: "original fact" };
    const text = buildDossier({}, [read, read, { ...read, output_preview: "changed fact" }]);
    expect(text.match(/original fact/g)).toHaveLength(1);
    expect(text).toContain("changed fact");
  });

  it("does not treat inherited object properties as known read tools", () => {
    const text = buildDossier({}, [{ name: "constructor", status: "ok", output_preview: "Not observed evidence" }]);
    expect(text).not.toContain("Not observed evidence");
  });
});

describe("review preflight and observability", () => {
  it("reports each quality bar and its issue count without copying the critique text", async () => {
    const events: Array<Record<string, unknown>> = [];
    const critique = { ...passed(), pass: false, scores: { constraint: 7, target: 8, actions: 6, effects: 5, grounding: 4 },
      issues: [{ bar: "grounding" as const, problem: "private claim", fix: "private evidence" }], unsupported_facts: ["private fact"] };
    await reviewAndRevisePlan({ strategy: draft(), onTiming: e => events.push(e as unknown as Record<string, unknown>) },
      { now: () => 0, critique: async () => critique, revise: async () => "invalid revision" });
    const scored = events.find(e => e.stage === "review_scored");
    expect(scored).toMatchObject({ scores: critique.scores, issueCounts: { constraint: 0, grounding: 1 } });
    expect(JSON.stringify(events)).not.toContain("private");
  });

  it("recognizes a concrete event-relative check without accepting an unanchored duration", () => {
    expect(hasCheckDate("Fewer than 3 bookings 30 days after it goes live.")).toBe(true);
    expect(hasCheckDate("Fewer than 3 sessions 30 days after the approved launch.")).toBe(true);
    expect(hasCheckDate("Under 5 enquiries 6 weeks after publication.")).toBe(true);
    expect(hasCheckDate("Fewer than 3 bookings within 30 days.")).toBe(false);
    expect(hasCheckDate("Fewer than 3 bookings 30 days after enough data is collected.")).toBe(false);
    expect(hasCheckDate("Fewer than 3 bookings after launch.")).toBe(false);
  });

  it("never prefers a better-formatted rewrite that introduces unsupported facts", async () => {
    const original = { ...draft(), goal: null };
    const critique = vi.fn()
      .mockResolvedValueOnce({ ...passed(), overall: 8, pass: false })
      .mockResolvedValueOnce({ ...passed(), overall: 9, pass: false, unsupported_facts: ["New invented company claim"] });
    const revise = vi.fn().mockResolvedValueOnce(`<strategy>${JSON.stringify(draft())}</strategy>`)
      .mockRejectedValueOnce(new Error("No further rewrite"));
    const out = await reviewAndRevisePlan({ strategy: original }, { now: () => 0, critique, revise });
    expect(out.strategy).toBe(original);
  });

  it("gives the independent reviewer structural findings before it scores, without skipping review", async () => {
    const strategy = { ...draft(), goal: null };
    const critique = vi.fn().mockResolvedValue(passed());
    const revise = vi.fn().mockResolvedValue("not a strategy");
    const out = await reviewAndRevisePlan({ strategy }, { now: () => 0, critique, revise });
    expect(critique.mock.calls[0][0].structuralIssues.some((i: { bar: string }) => i.bar === "target")).toBe(true);
    expect(out.passes[0].pass).toBe(false);
    expect(revise).toHaveBeenCalledOnce();
  });

  it("reports review and revision durations even on failure, without raw company text", async () => {
    let clock = 0;
    const events: unknown[] = [];
    const deps: ReviewDeps = { now: () => clock,
      critique: async () => { clock += 20; return { ...passed(), pass: false }; },
      revise: async () => { clock += 30; throw new Error("private company data"); },
    };
    const out = await reviewAndRevisePlan({ strategy: draft(), onTiming: e => events.push(e) }, deps);
    expect(out.stopped).toBe("error");
    expect(events).toContainEqual(expect.objectContaining({ stage: "critic", ms: 20, outcome: "ok", iteration: 0 }));
    expect(events).toContainEqual(expect.objectContaining({ stage: "revision", ms: 30, outcome: "error" }));
    expect(events).toContainEqual(expect.objectContaining({ stage: "review_total", ms: 50, outcome: "error" }));
    expect(JSON.stringify(events)).not.toContain("private company data");
  });

  it("never lets telemetry failure change the chosen strategy", async () => {
    const strategy = draft();
    const out = await reviewAndRevisePlan({ strategy, onTiming: () => { throw new Error("logger down"); } }, {
      now: () => 0, critique: async () => passed(), revise: async () => { throw new Error("unnecessary rewrite"); },
    });
    expect(out.strategy).toBe(strategy);
    expect(out.stopped).toBe("passed");
  });
});
