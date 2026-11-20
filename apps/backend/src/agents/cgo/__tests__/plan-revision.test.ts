import { describe, expect, it, vi } from "vitest";
import { canTargetRevision, parseRevision } from "../plan-revision";
import { reviewAndRevisePlan, type PlanCritique } from "../plan-review";
import type { ParsedStrategy } from "../strategy";

const strategy = (): ParsedStrategy => ({
  north_star: { metric: "new_customers", why: "Paying customers", provenance: "founder" },
  constraint: { statement: "Signup friction", lever_family: "activation", evidence: 'Reviews say "setup took a full afternoon".', confidence: "medium" },
  goal: { objective: "Reach 40 customers by Dec 16", target_metric: "new_customers", target_value: 40, due_date: "2026-12-16" },
  channel_bets: [{ channel_slug: "seo", intent: "Publish an illustrated setup guide", rationale: "Help prospects complete setup", expected_effect: "10 signups by day 30", falsifier: "Fewer than 5 signups" }],
  summary: "A tool with a setup problem.", first_steps: [{ when: "Day 1", step: "Observe five setup attempts" }],
  gaps: ["Baseline unknown"], unmeasured: [], basis_evidence: [],
  company_facts: [{ fact: "Setup has several steps", source_url: "https://example.com/setup" }], brand_voice: "Plain and helpful",
});
const critique = (pass = false): PlanCritique => ({
  scores: { constraint: 9, target: 9, actions: 9, effects: 9, grounding: 9 }, overall: 9, pass,
  unsupported_facts: [], issues: pass ? [] : [{ bar: "effects", problem: "No failure date", fix: "Date the check" }],
});
const patch = (data: unknown) => `<strategy_patch>${JSON.stringify(data)}</strategy_patch>`;
const repairedBets = () => strategy().channel_bets.map(b => ({ ...b, falsifier: "Fewer than 5 signups by day 30" }));

describe("lossless section revision", () => {
  it("preserves all unrelated fields and never mutates the input", () => {
    const original = strategy();
    const snapshot = structuredClone(original);
    const result = parseRevision(patch({ channel_bets: repairedBets() }), original, "targeted");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.strategy).toEqual({ ...original, channel_bets: repairedBets() });
    expect(original).toEqual(snapshot);
  });

  it.each([
    { basis_evidence: [] }, { constraint: { statement: "Different strategy" } },
    { company_facts: [] }, { unexpected: "value" },
    { goal: null }, { goal: { ...strategy().goal, due_date: "2026-02-31" } },
    { goal: { ...strategy().goal, target_value: "40" } },
    { channel_bets: [{ ...repairedBets()[0], channel_slug: "invented_channel" }] },
    { channel_bets: [] }, { channel_bets: [{ ...repairedBets()[0], intent: "" }] },
    { first_steps: [{ step: "Missing when" }] }, {}, { summary: strategy().summary },
  ])("rejects unsafe, lossy or ineffective edits: %j", data => {
    expect(parseRevision(patch(data), strategy(), "targeted")).toEqual({ ok: false });
  });

  it("rejects prototype keys, mixed outputs, and patches on the full-only path", () => {
    expect(parseRevision('<strategy_patch>{"__proto__":{"polluted":true}}</strategy_patch>', strategy(), "targeted")).toEqual({ ok: false });
    expect(parseRevision(`${patch({ summary: "changed" })}<strategy>{}</strategy>`, strategy(), "targeted")).toEqual({ ok: false });
    expect(parseRevision(patch({ summary: "changed" }), strategy(), "full")).toEqual({ ok: false });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("retains the complete rewrite option for strategy or grounding changes", () => {
    expect(canTargetRevision({ ...critique(), unsupported_facts: ["Unverified revenue"] })).toBe(false);
    expect(canTargetRevision({ ...critique(), scores: { ...critique().scores, constraint: 7 } })).toBe(false);
    const full = `<strategy>${JSON.stringify(strategy())}</strategy>`;
    expect(parseRevision(full, strategy(), "targeted")).toMatchObject({ ok: true, targeted: false });
  });
});

describe("section revision quality gates", () => {
  it("is off by default and still uses the full revision contract", async () => {
    vi.stubEnv("CGO_PLAN_TARGETED_REVISIONS", "");
    try {
      const revise = vi.fn().mockResolvedValue("unparseable");
      await reviewAndRevisePlan({ strategy: strategy() }, { now: () => 0, critique: async () => critique(), revise });
      expect(revise.mock.calls[0][0].mode).toBe("full");
    } finally { vi.unstubAllEnvs(); }
  });

  it("reviews the full merged strategy and only then selects a section repair", async () => {
    const inspect = vi.fn().mockResolvedValueOnce(critique()).mockResolvedValue(critique(true));
    const revise = vi.fn().mockResolvedValue(patch({ channel_bets: repairedBets() }));
    const out = await reviewAndRevisePlan({ strategy: strategy(), revisionMode: "targeted" }, { now: () => 0, critique: inspect, revise });
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(inspect.mock.calls[1][0].strategy).toEqual({ ...strategy(), channel_bets: repairedBets() });
    expect(out.stopped).toBe("passed");
    expect(out.strategy.channel_bets).toEqual(repairedBets());
    expect(revise.mock.calls[0][0].mode).toBe("targeted");
  });

  it.each(["worse_bar", "new_false_fact", "review_timeout"])("does not select an edit with %s", async failure => {
    const original = strategy();
    const inspect = vi.fn().mockResolvedValueOnce(critique());
    if (failure === "review_timeout") inspect.mockRejectedValueOnce(new Error("timeout"));
    else inspect.mockResolvedValueOnce({ ...critique(true),
      ...(failure === "worse_bar" ? { scores: { ...critique().scores, grounding: 8 } } : { unsupported_facts: ["Invented fact"], pass: false }),
    });
    const out = await reviewAndRevisePlan({ strategy: original, revisionMode: "targeted" }, {
      now: () => 0, critique: inspect, revise: async () => patch({ channel_bets: repairedBets() }),
    });
    expect(out.strategy).toBe(original);
    expect(out.stopped).toBe(failure === "review_timeout" ? "error" : "quality_regression");
  });
});
