
import { describe, it, expect } from "vitest";
import { aggregateModelRouting, type RoutingRunInput } from "../model-routing";

function run(over: Partial<RoutingRunInput>): RoutingRunInput {
  return {
    agent_slug: "engineer",
    model_used: "claude-sonnet-4-6",
    input_tokens: 10,
    output_tokens: 20,
    cache_read_tokens: 100,
    cache_creation_tokens: 0,
    cost_usd: 0.5,
    routing_decision: { tier: "sonnet", reason_code: "classifier_low", classifier_ms: 600, shadow: false },
    ...over,
  };
}

describe("aggregateModelRouting", () => {
  it("empty input → empty perAgent, zero totals", () => {
    const out = aggregateModelRouting([]);
    expect(out.perAgent).toEqual([]);
    expect(out.totals.routed_runs).toBe(0);
    expect(out.totals.classifier_error_rate).toBe(0);
  });

  it("skips runs with no routing_decision (not routed)", () => {
    const out = aggregateModelRouting([
      run({ routing_decision: null }),
      run({}),
    ]);
    expect(out.totals.routed_runs).toBe(1);
  });

  it("counts tier split, live/shadow, reason codes, and tokens per agent", () => {
    const out = aggregateModelRouting([
      run({ routing_decision: { tier: "sonnet", reason_code: "classifier_low", classifier_ms: 600, shadow: false } }),
      run({ routing_decision: { tier: "opus", reason_code: "floor_keyword", classifier_ms: null, shadow: false } }),
      run({ routing_decision: { tier: "opus", reason_code: "classifier_high", classifier_ms: 700, shadow: true } }),
    ]);
    const eng = out.perAgent.find((a) => a.agent_slug === "engineer")!;
    expect(eng.routed_runs).toBe(3);
    expect(eng.live_runs).toBe(2);
    expect(eng.shadow_runs).toBe(1);
    expect(eng.tier).toEqual({ sonnet: 1, opus: 2 });
    expect(eng.reason_codes).toEqual({ classifier_low: 1, floor_keyword: 1, classifier_high: 1 });
    expect(eng.classifier_runs).toBe(2);
    expect(eng.avg_classifier_ms).toBe(650);
    expect(eng.tokens.total).toBe(3 * (10 + 20 + 100));
  });

  it("computes classifier_error_rate and raises high_classifier_error flag (>10%, n>=5)", () => {
    const rows: RoutingRunInput[] = [];
    for (let i = 0; i < 4; i++)
      rows.push(run({ routing_decision: { tier: "sonnet", reason_code: "classifier_low", classifier_ms: 500, shadow: false } }));
    for (let i = 0; i < 2; i++)
      rows.push(run({ routing_decision: { tier: "opus", reason_code: "classifier_error_opus", classifier_ms: null, shadow: false } }));
    const out = aggregateModelRouting(rows);
    const eng = out.perAgent[0];
    expect(eng.classifier_runs).toBe(6);
    expect(eng.classifier_errors).toBe(2);
    expect(eng.classifier_error_rate).toBeCloseTo(2 / 6, 5);
    expect(eng.flags).toContain("high_classifier_error");
  });

  it("does NOT flag high_classifier_error below the n>=5 floor", () => {
    const out = aggregateModelRouting([
      run({ routing_decision: { tier: "opus", reason_code: "classifier_error_opus", classifier_ms: null, shadow: false } }),
    ]);
    expect(out.perAgent[0].flags).not.toContain("high_classifier_error");
  });

  it("sorts perAgent by total tokens desc + rolls up grand totals", () => {
    const out = aggregateModelRouting([
      run({ agent_slug: "advisor", input_tokens: 1, output_tokens: 1, cache_read_tokens: 1, cache_creation_tokens: 0 }),
      run({ agent_slug: "engineer", input_tokens: 100, output_tokens: 100, cache_read_tokens: 100, cache_creation_tokens: 0 }),
    ]);
    expect(out.perAgent.map((a) => a.agent_slug)).toEqual(["engineer", "advisor"]);
    expect(out.totals.routed_runs).toBe(2);
    expect(out.totals.by_tier).toEqual({ sonnet: 2 });
  });
});
