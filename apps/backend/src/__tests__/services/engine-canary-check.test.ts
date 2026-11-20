
import { describe, it, expect } from "vitest";
import {
  PARITY_FLOOR,
  DEFAULT_THRESHOLD,
  DEFAULT_AGENT_THRESHOLDS,
  thresholdForAgent,
  evaluateCanary,
  rollbackCommand,
  parseCanaryArgs,
} from "../../../scripts/engine-canary-check";
import type { AgentScore } from "../../../scripts/shadow-grade";

const TID = "73db45ff-457e-4541-bc8f-bdb625390204";

function score(partial: Partial<AgentScore>): AgentScore {
  return {
    agent_slug: "research",
    n: 0,
    mean: 0,
    parity_pct: 0,
    skipped_null: 0,
    judge_unavailable: 0,
    ...partial,
  };
}

describe("thresholdForAgent", () => {
  it("returns the per-agent threshold when one exists", () => {
    expect(thresholdForAgent("research")).toBe(DEFAULT_AGENT_THRESHOLDS.research);
    expect(thresholdForAgent("growth-lead")).toBe(DEFAULT_AGENT_THRESHOLDS["growth-lead"]);
  });
  it("falls back to DEFAULT_THRESHOLD for an unlisted agent", () => {
    expect(thresholdForAgent("some-new-agent")).toBe(DEFAULT_THRESHOLD);
  });
});

describe("evaluateCanary — threshold logic (fail-closed)", () => {
  it("PASS when parity >= threshold and no judge outages", () => {
    const s = score({ agent_slug: "research", n: 10, parity_pct: 90, judge_unavailable: 0 });
    const v = evaluateCanary("research", s, 0.8);
    expect(v.pass).toBe(true);
    expect(v.parity).toBeCloseTo(0.9);
    expect(v.reason).toMatch(/PASS/);
  });

  it("PASS exactly AT the threshold (>= is inclusive)", () => {
    const s = score({ agent_slug: "research", n: 10, parity_pct: 80, judge_unavailable: 0 });
    const v = evaluateCanary("research", s, 0.8);
    expect(v.pass).toBe(true);
  });

  it("FAIL when parity is below threshold", () => {
    const s = score({ agent_slug: "research", n: 10, parity_pct: 70, judge_unavailable: 0 });
    const v = evaluateCanary("research", s, 0.8);
    expect(v.pass).toBe(false);
    expect(v.reason).toMatch(/parity 70% < threshold 80%/);
  });

  it("FAIL — ANY judge_unavailable forces a fail even with perfect parity", () => {
    const s = score({ agent_slug: "research", n: 10, parity_pct: 100, judge_unavailable: 1 });
    const v = evaluateCanary("research", s, 0.8);
    expect(v.pass).toBe(false);
    expect(v.reason).toMatch(/judge_unavailable/);
  });

  it("FAIL — zero graded rows can never certify a switch", () => {
    const v = evaluateCanary("research", null, 0.8);
    expect(v.pass).toBe(false);
    expect(v.graded).toBe(0);
    expect(v.reason).toMatch(/zero graded rows/);
    const s = score({ agent_slug: "research", n: 0, parity_pct: 0 });
    expect(evaluateCanary("research", s, 0.8).reason).toMatch(/zero graded rows/);
  });

  it("PARITY_FLOOR is the documented >=3/4 bar", () => {
    expect(PARITY_FLOOR).toBe(3);
  });
});

describe("parseCanaryArgs", () => {
  it("accepts a valid stateless bedrock canary", () => {
    const a = parseCanaryArgs(["--agent", "research", "--provider", "bedrock"]);
    expect(a.agent).toBe("research");
    expect(a.provider).toBe("bedrock");
    expect(a.tenant).toBe(TID);
    expect(a.limit).toBe(20);
  });

  it("REJECTS --allow-partial (a partial grade can never certify a switch)", () => {
    expect(() =>
      parseCanaryArgs(["--agent", "research", "--provider", "bedrock", "--allow-partial"]),
    ).toThrow(/--allow-partial is NOT supported/);
  });

  it("rejects a conversational agent (no Bedrock stateless resume)", () => {
    for (const a of ["pm", "chief-of-staff", "support-lead", "advisor", "operator"]) {
      expect(() => parseCanaryArgs(["--agent", a, "--provider", "bedrock"])).toThrow(
        /conversational/,
      );
    }
  });

  it("rejects an agent not in the stateless canary set", () => {
    expect(() => parseCanaryArgs(["--agent", "engineer", "--provider", "bedrock"])).toThrow(
      /not in the stateless canary set/,
    );
  });

  it("rejects a non-bedrock provider", () => {
    expect(() => parseCanaryArgs(["--agent", "research", "--provider", "openai"])).toThrow(
      /must be "bedrock"/,
    );
  });

  it("rejects a missing --agent", () => {
    expect(() => parseCanaryArgs(["--provider", "bedrock"])).toThrow(/--agent <slug> is required/);
  });

  it("accepts an in-range --threshold and rejects out-of-range", () => {
    expect(parseCanaryArgs(["--agent", "research", "--provider", "bedrock", "--threshold", "0.9"]).threshold).toBe(0.9);
    expect(() =>
      parseCanaryArgs(["--agent", "research", "--provider", "bedrock", "--threshold", "1.5"]),
    ).toThrow(/--threshold must be a number in \[0, 1\]/);
  });
});

describe("rollbackCommand", () => {
  it("includes BOTH levers with the exact tenant + agent interpolated", () => {
    const out = rollbackCommand(TID, "research");
    expect(out).toMatch(/DELETE https:\/\/api\.zaviagent\.com\/api\/admin\/engine-override/);
    expect(out).toContain(`"tenant_id":"${TID}","agent_slug":"research"`);
    expect(out).toMatch(/master-kill/);
    expect(out).toContain(`"provider_overrides_disabled":true`);
  });

  it("interpolates a different agent slug verbatim", () => {
    const out = rollbackCommand(TID, "growth-lead");
    expect(out).toContain(`"agent_slug":"growth-lead"`);
  });
});
