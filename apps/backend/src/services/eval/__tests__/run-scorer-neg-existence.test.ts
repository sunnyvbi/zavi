import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  meta: { tenant_id: "t-1", finished_at: new Date().toISOString() } as {
    tenant_id: string | null;
    finished_at: string | null;
  } | null,
  metaErr: null as { message: string } | null,
}));

vi.mock("@/services/supabase", () => {
  const q: Record<string, unknown> = {
    select: () => q,
    eq: () => q,
    maybeSingle: async () => ({ data: h.metaErr ? null : h.meta, error: h.metaErr }),
  };
  return { serviceClient: () => ({ from: () => q }) };
});

const groundMock = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/services/agents/negative-existence-grounding-verifier", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    isBackendSubsystemPath: actual.isBackendSubsystemPath,
    detectNegativeExistenceClaims: (text: string) =>
      /could not locate/i.test(text)
        ? [{ claim: text, symbol: "respondToCarReview", kind: "endpoint" }]
        : [],
    groundNegativeExistence: (...args: unknown[]) => groundMock.fn(...args),
  };
});

import { maybeGroundNegativeExistence } from "../run-scorer";

const PROVEN_WRONG = [
  {
    claim: "could not locate a host-review reply endpoint",
    exists: true,
    evidence: {
      claimed_absent: "respondToCarReview",
      matched_symbol: "respondToCarReview",
      repo: "rravi149/upcar",
      path: "src/routes/cars.route.ts",
      line: 96,
      hit_type: "route" as const,
      checked_ref: "HEAD",
    },
  },
];

const baseRun = {
  id: "r1",
  agent_slug: "engineer",
  status: "success",
  output_text: "I could not locate a host-review reply endpoint.",
  error: null,
  model_used: "claude",
  cost_usd: 0.1,
  tool_calls: 3,
};
const baseQuality = { score: 80, rationale: "ok", model: "gpt-5.5" };

describe("maybeGroundNegativeExistence", () => {
  beforeEach(() => {
    groundMock.fn.mockReset();
    h.meta = { tenant_id: "t-1", finished_at: new Date().toISOString() };
    h.metaErr = null;
  });
  afterEach(() => {
    delete process.env.NEG_EXISTENCE_GROUNDING_ENABLED;
  });

  it("latch OFF (=0) ⇒ skip:latch_off, never calls the grounder, cursor untouched", async () => {
    process.env.NEG_EXISTENCE_GROUNDING_ENABLED = "0";
    const budget = { remaining: 5 };
    const out = await maybeGroundNegativeExistence(
      baseRun,
      baseQuality,
      budget,
      { info: () => {}, warn: () => {} },
    );
    expect(out.outcome).toBe("skip");
    expect(out.outcome === "skip" && out.reason).toBe("latch_off");
    expect(groundMock.fn).not.toHaveBeenCalled();
    expect(budget.remaining).toBe(5);
  });

  it("latch ON + recent run + proven-wrong ⇒ processed + clamps to ≤49 + evidence", async () => {
    process.env.NEG_EXISTENCE_GROUNDING_ENABLED = "1";
    groundMock.fn.mockResolvedValue(PROVEN_WRONG);
    const budget = { remaining: 5 };
    const out = await maybeGroundNegativeExistence(
      baseRun,
      baseQuality,
      budget,
      { info: () => {}, warn: () => {} },
    );
    expect(out.outcome).toBe("processed");
    if (out.outcome !== "processed") throw new Error("unreachable");
    expect(out.quality?.score).toBeLessThanOrEqual(49);
    expect(out.quality?.rationale).toBe("false_negative_existence");
    expect(out.evidence?.path).toContain("cars.route");
    expect(budget.remaining).toBe(4);
  });

  it("latch ON but run is STALE (>120min) ⇒ processed, records evidence, does NOT clamp", async () => {
    process.env.NEG_EXISTENCE_GROUNDING_ENABLED = "1";
    groundMock.fn.mockResolvedValue(PROVEN_WRONG);
    h.meta = {
      tenant_id: "t-1",
      finished_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    };
    const out = await maybeGroundNegativeExistence(
      baseRun,
      baseQuality,
      { remaining: 5 },
      { info: () => {}, warn: () => {} },
    );
    expect(out.outcome).toBe("processed");
    if (out.outcome !== "processed") throw new Error("unreachable");
    expect(out.quality).toBeUndefined();
    expect(out.evidence?.checked_ref).toContain("unbounded");
  });

  it("latch ON, detector empty (non-negative prose) ⇒ processed + ZERO grounder call", async () => {
    process.env.NEG_EXISTENCE_GROUNDING_ENABLED = "1";
    const out = await maybeGroundNegativeExistence(
      { ...baseRun, output_text: "I shipped the endpoint successfully." },
      baseQuality,
      { remaining: 5 },
      { info: () => {}, warn: () => {} },
    );
    expect(out.outcome).toBe("processed");
    expect(groundMock.fn).not.toHaveBeenCalled();
  });

  it("latch ON but budget exhausted ⇒ skip:budget, no grounder call, no score change", async () => {
    process.env.NEG_EXISTENCE_GROUNDING_ENABLED = "1";
    const out = await maybeGroundNegativeExistence(
      baseRun,
      baseQuality,
      { remaining: 0 },
      { info: () => {}, warn: () => {} },
    );
    expect(out.outcome).toBe("skip");
    expect(out.outcome === "skip" && out.reason).toBe("budget");
    expect(groundMock.fn).not.toHaveBeenCalled();
  });

  it("latch ON, github throws/times-out ⇒ skip:github_unavailable (cursor left NULL to retry)", async () => {
    process.env.NEG_EXISTENCE_GROUNDING_ENABLED = "1";
    groundMock.fn.mockRejectedValue(new Error("ECONNRESET"));
    const out = await maybeGroundNegativeExistence(
      baseRun,
      baseQuality,
      { remaining: 5 },
      { info: () => {}, warn: () => {} },
    );
    expect(out.outcome).toBe("skip");
    expect(out.outcome === "skip" && out.reason).toBe("github_unavailable");
  });

  it("latch ON, transient DB error on the C8 re-derive ⇒ skip:rederive_failed (NOT stamped)", async () => {
    process.env.NEG_EXISTENCE_GROUNDING_ENABLED = "1";
    h.metaErr = { message: "connection reset" };
    const out = await maybeGroundNegativeExistence(
      baseRun,
      baseQuality,
      { remaining: 5 },
      { info: () => {}, warn: () => {} },
    );
    expect(out.outcome).toBe("skip");
    expect(out.outcome === "skip" && out.reason).toBe("rederive_failed");
    expect(groundMock.fn).not.toHaveBeenCalled();
  });
});
