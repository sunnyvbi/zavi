import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AgentMetadataSchema } from "../types";

describe("tool_iter_cap zod schema", () => {
  function parseWith(extra: Record<string, unknown>) {
    return AgentMetadataSchema.safeParse({
      model: "claude-sonnet-4-6",
      ...extra,
    });
  }

  it("accepts undefined — default behavior preserved", () => {
    const res = parseWith({});
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.tool_iter_cap).toBeUndefined();
    }
  });

  it("accepts integer in 10-120", () => {
    for (const v of [10, 30, 60, 90, 120]) {
      const res = parseWith({ tool_iter_cap: v });
      expect(res.success, `tool_iter_cap=${v} should pass`).toBe(true);
    }
  });

  it("rejects below 10", () => {
    const res = parseWith({ tool_iter_cap: 5 });
    expect(res.success).toBe(false);
  });

  it("rejects above 120", () => {
    const res = parseWith({ tool_iter_cap: 200 });
    expect(res.success).toBe(false);
  });

  it("rejects non-integer", () => {
    const res = parseWith({ tool_iter_cap: 45.5 });
    expect(res.success).toBe(false);
  });
});

describe("soft-nudge source guards in generic-dispatcher", () => {
  const src = readFileSync(
    join(__dirname, "../generic-dispatcher.ts"),
    "utf-8",
  );

  it("computes effectiveCap from per-agent override falling back to MAX_TOOL_ITERS", () => {
    expect(src).toContain("metadata_praxis.tool_iter_cap ?? MAX_TOOL_ITERS");
  });

  it("soft nudge fires at floor(effectiveCap * 0.75)", () => {
    expect(src).toMatch(/softNudgeAt\s*=\s*Math\.floor\(effectiveCap\s*\*\s*0\.75\)/);
  });

  it("nudge fires exactly once per run (softNudgeFired guard)", () => {
    expect(src).toMatch(/let softNudgeFired = false/);
    expect(src).toMatch(/softNudgeFired = true/);
    expect(src).toMatch(/!softNudgeFired/);
  });

  it("nudge does NOT fire when cap is about to hit (last-iter guard)", () => {
    expect(src).toMatch(/iter\s*\+\s*1\s*<\s*effectiveCap/);
  });

  it("nudge text contains the load-bearing 'envelope NOW' phrase", () => {
    expect(src).toContain("Wrap your final output in your");
    expect(src).toContain("envelope NOW");
    expect(src).toContain("partial > silent");
  });

  it("nudge emits a parsed progress event with code=tool_nudge_emitted (telemetry)", () => {
    expect(src).toMatch(/code:\s*"tool_nudge_emitted"/);
  });

  it("iter-cap block uses effectiveCap (NOT hardcoded MAX_TOOL_ITERS)", () => {
    expect(src).toMatch(/iter\s*===\s*effectiveCap\s*-\s*1/);
    expect(src).toMatch(/iter_cap_summarize.*iter:\s*effectiveCap/s);
    expect(src).toMatch(/Tool budget exhausted \(\$\{effectiveCap\}/);
  });

  it("SDK path maxTurns also honors per-agent override", () => {
    expect(src).toMatch(
      /maxTurns:\s*ctx\.agent\.metadata_praxis\.tool_iter_cap\s*\?\?\s*MAX_TOOL_ITERS/,
    );
  });

  it("MAX_TOOL_ITERS=60 default is unchanged (don't shrink the global)", () => {
    expect(src).toMatch(/const MAX_TOOL_ITERS = 60/);
  });
});

describe("per-agent tool_iter_cap opt-ins", () => {
  function readAgentMd(slug: string) {
    return readFileSync(
      join(__dirname, `../../../agents/${slug}/agent.md`),
      "utf-8",
    );
  }

  const noOverrideSlugs = [
    "operator",
    "qa",
    "pm",
    "chief-of-staff",
    "dispute-response",
  ];
  for (const slug of noOverrideSlugs) {
    it(`${slug}/agent.md does NOT set tool_iter_cap (rides the default)`, () => {
      expect(readAgentMd(slug)).not.toMatch(/tool_iter_cap:/);
    });
  }

  it("engineer/agent.md sets tool_iter_cap to a valid in-range integer", () => {
    const src = readAgentMd("engineer");
    const m = src.match(/tool_iter_cap:\s*(\d+)/);
    expect(m, "engineer should declare tool_iter_cap").not.toBeNull();
    const cap = Number(m![1]);
    expect(Number.isInteger(cap)).toBe(true);
    expect(cap).toBeGreaterThanOrEqual(10);
    expect(cap).toBeLessThanOrEqual(120);
  });
});
