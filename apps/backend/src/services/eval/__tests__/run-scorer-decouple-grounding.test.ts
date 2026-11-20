import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  candidateRows: [] as Record<string, unknown>[],
  updates: [] as Array<{ table: string; id: string; payload: Record<string, unknown> }>,
  meta: { tenant_id: "t-1", finished_at: new Date().toISOString() } as {
    tenant_id: string | null;
    finished_at: string | null;
  },
}));

vi.mock("@/services/supabase", () => {
  function makeQuery(table: string) {
    let updatePayload: Record<string, unknown> | null = null;
    const q: Record<string, unknown> = {
      select: () => q,
      is: () => q,
      not: () => q,
      in: () => q,
      gte: () => q,
      order: () => q,
      limit: () => {
        if (table === "agent_runs" && updatePayload === null) {
          return Promise.resolve({ data: h.candidateRows, error: null });
        }
        return Promise.resolve({ data: [], error: null });
      },
      update: (payload: Record<string, unknown>) => {
        updatePayload = payload;
        return q;
      },
      eq: (col: string, val: unknown) => {
        if (col === "id" && typeof val === "string" && updatePayload !== null) {
          h.updates.push({ table, id: val, payload: updatePayload });
          updatePayload = null;
        }
        return q;
      },
      maybeSingle: () => {
        if (table === "system_config") {
          return Promise.resolve({ data: { blob: {} }, error: null });
        }
        return Promise.resolve({ data: h.meta, error: null });
      },
      then: (resolve: (v: { data: unknown; error: null }) => void) => {
        resolve({ data: null, error: null });
      },
    };
    return q;
  }
  return { serviceClient: () => ({ from: (table: string) => makeQuery(table) }) };
});

vi.mock("@/services/llm/call-model", () => ({
  callModel: vi.fn().mockResolvedValue({
    text: JSON.stringify({ score: 80, rationale: "solid" }),
  }),
}));

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

import { scoreRecentUnscoredRuns, groundRecentScoredRuns } from "../run-scorer";

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

const logger = { info: () => {}, warn: () => {} };

beforeEach(() => {
  h.updates.length = 0;
  h.candidateRows = [];
  h.meta = { tenant_id: "t-1", finished_at: new Date().toISOString() };
  groundMock.fn.mockReset();
  delete process.env.NEG_EXISTENCE_GROUNDING_ENABLED;
});

describe("A) scoreRecentUnscoredRuns no longer grounds inline", () => {
  it("scores a detector-tripping run with the LLM judge ONLY — never calls the grounder", async () => {
    process.env.NEG_EXISTENCE_GROUNDING_ENABLED = "1";
    h.candidateRows = [
      {
        id: "r-detector-trip",
        agent_slug: "engineer",
        status: "success",
        output_text: "I could not locate a host-review reply endpoint.",
        error: null,
        model_used: "claude",
        cost_usd: 0.1,
        tool_calls: 3,
      },
    ];
    const res = await scoreRecentUnscoredRuns(logger, 20);
    expect(res.scored).toBe(1);
    expect(groundMock.fn).not.toHaveBeenCalled();
    const upd = h.updates.find((u) => u.id === "r-detector-trip");
    expect(upd).toBeTruthy();
    expect(upd?.payload.quality_score).toBe(80);
    expect(upd?.payload).not.toHaveProperty("quality_grounded_at");
    expect(upd?.payload).not.toHaveProperty("quality_evidence");
  });
});

describe("B) groundRecentScoredRuns — the decoupled lane", () => {
  const scoredRun = {
    id: "r-scored",
    agent_slug: "engineer",
    status: "success",
    output_text: "I could not locate a host-review reply endpoint.",
    quality_score: 80,
    quality_rationale: "solid",
    quality_model: "gpt-5.5",
  };

  it("latch OFF ⇒ INERT: enabled:false, zero candidates, zero updates", async () => {
    process.env.NEG_EXISTENCE_GROUNDING_ENABLED = "0";
    h.candidateRows = [scoredRun];
    const res = await groundRecentScoredRuns(logger, 20);
    expect(res.enabled).toBe(false);
    expect(res.candidates).toBe(0);
    expect(h.updates).toHaveLength(0);
    expect(groundMock.fn).not.toHaveBeenCalled();
  });

  it("recent confirmed-false ⇒ clamps ≤49 + writes evidence + stamps grounded_at", async () => {
    process.env.NEG_EXISTENCE_GROUNDING_ENABLED = "1";
    groundMock.fn.mockResolvedValue(PROVEN_WRONG);
    h.candidateRows = [scoredRun];
    const res = await groundRecentScoredRuns(logger, 20);
    expect(res.grounded).toBe(1);
    expect(res.clamped).toBe(1);
    const upd = h.updates.find((u) => u.id === "r-scored");
    expect(upd?.payload.quality_score).toBeLessThanOrEqual(49);
    expect(upd?.payload.quality_rationale).toBe("false_negative_existence");
    expect(upd?.payload.quality_grounded_at).toBeTruthy();
    expect((upd?.payload.quality_evidence as { path: string }).path).toContain("cars.route");
  });

  it("no negative-existence claim ⇒ stamps grounded_at, NO clamp", async () => {
    process.env.NEG_EXISTENCE_GROUNDING_ENABLED = "1";
    h.candidateRows = [{ ...scoredRun, output_text: "I shipped the endpoint successfully." }];
    const res = await groundRecentScoredRuns(logger, 20);
    expect(res.grounded).toBe(1);
    expect(res.clamped).toBe(0);
    expect(groundMock.fn).not.toHaveBeenCalled();
    const upd = h.updates.find((u) => u.id === "r-scored");
    expect(upd?.payload.quality_grounded_at).toBeTruthy();
    expect(upd?.payload).not.toHaveProperty("quality_score");
  });

  it("github unavailable ⇒ skip, cursor NOT stamped (no update) so it retries", async () => {
    process.env.NEG_EXISTENCE_GROUNDING_ENABLED = "1";
    groundMock.fn.mockRejectedValue(new Error("ECONNRESET"));
    h.candidateRows = [scoredRun];
    const res = await groundRecentScoredRuns(logger, 20);
    expect(res.skipped).toBe(1);
    expect(res.grounded).toBe(0);
    expect(h.updates).toHaveLength(0);
  });
});
