import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  candidateRows: [] as Record<string, unknown>[],
  updates: [] as Array<{ id: string; payload: Record<string, unknown> }>,
  lastJudgePrompt: null as string | null,
}));

vi.mock("@/services/supabase", () => {
  function makeQuery(table: string) {
    let updatePayload: Record<string, unknown> | null = null;

    const q: Record<string, unknown> = {
      select: () => q,
      is: () => q,
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
          h.updates.push({ id: val, payload: { ...updatePayload } });
          updatePayload = null;
        }
        return q;
      },
      maybeSingle: () =>
        Promise.resolve({ data: { blob: {} }, error: null }),
      then: (resolve: (v: { data: unknown; error: null }) => void) => {
        resolve({ data: null, error: null });
      },
    };
    return q;
  }

  return {
    serviceClient: () => ({
      from: (table: string) => makeQuery(table),
    }),
  };
});

vi.mock("@/services/llm/call-model", () => ({
  callModel: vi.fn().mockImplementation(async (args: { messages: Array<{ role: string; content: string }> }) => {
    const userMsg = args.messages.find((m) => m.role === "user");
    h.lastJudgePrompt = userMsg?.content ?? null;
    return { text: JSON.stringify({ score: 82, rationale: "Good output" }) };
  }),
}));

import { scoreRecentUnscoredRuns, isNeverExecuted, SKIP_SENTINEL } from "../run-scorer";

function longText(len: number): string {
  const chunk =
    "This is a complete advice memo paragraph with full sentences and proper punctuation. ";
  let result = "";
  while (result.length < len) result += chunk;
  return result.slice(0, len);
}

const logger = { info: vi.fn(), warn: vi.fn() };

const longAdvisorRun = {
  id: "advisor-long-run-001",
  agent_slug: "advisor",
  status: "success",
  output_text: longText(8_000),
  error: null,
  model_used: "claude-opus-4-8",
  cost_usd: 0.15,
  tool_calls: 8,
};

const parsedFailedWithContent = {
  id: "advisor-parse-failed-001",
  agent_slug: "advisor",
  status: "parse_failed",
  output_text: "Here is the complete advice memo with actionable recommendations. " +
    "The company should focus on customer acquisition through community channels. " +
    "This is coherent, complete content that deserves a real quality score.",
  error: "envelope parse failed: rendered_markdown exceeds 20000 chars",
  model_used: "claude-opus-4-8",
  cost_usd: 0.12,
  tool_calls: 6,
};

const parsedFailedNoContent = {
  id: "parse-failed-orphan-001",
  agent_slug: "advisor",
  status: "parse_failed",
  output_text: null,
  error: "envelope parse failed: no output produced",
  model_used: null,
  cost_usd: null,
  tool_calls: null,
};

const bootReapOrphan = {
  id: "orphan-boot-reap-regression-001",
  agent_slug: "pm",
  status: "error",
  output_text: null,
  error: "boot_reap: container restart orphaned run",
  model_used: null,
  cost_usd: null,
  tool_calls: null,
};

beforeEach(() => {
  h.updates = [];
  h.candidateRows = [];
  h.lastJudgePrompt = null;
  logger.info.mockClear();
  logger.warn.mockClear();
});

describe("P0-a: truncation budget for long-envelope agents", () => {
  it("an 8000-char advisor output is NOT truncated to 4000 before judging", async () => {
    h.candidateRows = [longAdvisorRun];

    const result = await scoreRecentUnscoredRuns(logger, 10);

    expect(result.scored).toBe(1);
    expect(result.neverExecuted).toBe(0);

    expect(h.lastJudgePrompt).not.toBeNull();
    const prompt = h.lastJudgePrompt!;
    expect(prompt.length).toBeGreaterThan(7_000);
  });

  it("the judge prompt for advisor contains the full output (no mid-sentence truncation)", async () => {
    const marker = "MARKER_AT_CHAR_5000_" + "X".repeat(50);
    const output = longText(4_900) + marker + longText(1_000);
    h.candidateRows = [{ ...longAdvisorRun, output_text: output }];

    await scoreRecentUnscoredRuns(logger, 10);

    expect(h.lastJudgePrompt).toContain(marker);
  });

  it("the quality_score written for the long advisor run is non-null and a real grade", async () => {
    h.candidateRows = [longAdvisorRun];

    await scoreRecentUnscoredRuns(logger, 10);

    const update = h.updates.find((u) => u.id === longAdvisorRun.id);
    expect(update).toBeDefined();
    expect(update!.payload.quality_score).not.toBeNull();
    expect(typeof update!.payload.quality_score).toBe("number");
    expect(update!.payload.quality_model).not.toBe(SKIP_SENTINEL);
  });
});

describe("P0-b: parse_failed runs with content are scored", () => {
  it("a parse_failed run WITH coherent output_text gets a real quality_score", async () => {
    h.candidateRows = [parsedFailedWithContent];

    const result = await scoreRecentUnscoredRuns(logger, 10);

    expect(result.scored).toBe(1);
    expect(result.neverExecuted).toBe(0);
    expect(result.skipped).toBe(0);

    const update = h.updates.find((u) => u.id === parsedFailedWithContent.id);
    expect(update).toBeDefined();
    expect(update!.payload.quality_score).not.toBeNull();
    expect(typeof update!.payload.quality_score).toBe("number");
    expect(update!.payload.quality_model).not.toBe(SKIP_SENTINEL);
    expect(typeof update!.payload.quality_scored_at).toBe("string");
  });

  it("a parse_failed run with model_used=null (never executed) still gets SKIP_SENTINEL", async () => {
    h.candidateRows = [parsedFailedNoContent];

    const result = await scoreRecentUnscoredRuns(logger, 10);

    expect(result.neverExecuted).toBe(1);
    expect(result.scored).toBe(0);

    const update = h.updates.find((u) => u.id === parsedFailedNoContent.id);
    expect(update).toBeDefined();
    expect(update!.payload.quality_score).toBeNull();
    expect(update!.payload.quality_model).toBe(SKIP_SENTINEL);
  });

  it("mixed batch: parse_failed-with-content scored, boot-reap orphan skipped, long advisor scored", async () => {
    h.candidateRows = [
      parsedFailedWithContent,
      bootReapOrphan,
      longAdvisorRun,
    ];

    const result = await scoreRecentUnscoredRuns(logger, 20);

    expect(result.scored).toBe(2);
    expect(result.neverExecuted).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.candidates).toBe(3);

    const orphanUpdate = h.updates.find((u) => u.id === bootReapOrphan.id);
    expect(orphanUpdate).toBeDefined();
    expect(orphanUpdate!.payload.quality_score).toBeNull();
    expect(orphanUpdate!.payload.quality_model).toBe(SKIP_SENTINEL);

    const parseFailedUpdate = h.updates.find((u) => u.id === parsedFailedWithContent.id);
    expect(parseFailedUpdate).toBeDefined();
    expect(parseFailedUpdate!.payload.quality_score).not.toBeNull();
    expect(parseFailedUpdate!.payload.quality_model).not.toBe(SKIP_SENTINEL);

    const advisorUpdate = h.updates.find((u) => u.id === longAdvisorRun.id);
    expect(advisorUpdate).toBeDefined();
    expect(advisorUpdate!.payload.quality_score).not.toBeNull();
  });
});

describe("isNeverExecuted — parse_failed classification", () => {
  it("parse_failed WITH model_used + content → false (not an orphan, should be scored)", () => {
    expect(isNeverExecuted(parsedFailedWithContent)).toBe(false);
  });

  it("parse_failed WITHOUT model_used → true (orphan, dispatcher never fired)", () => {
    expect(isNeverExecuted(parsedFailedNoContent)).toBe(true);
  });

  it("boot_reap orphan → true (regression guard)", () => {
    expect(isNeverExecuted(bootReapOrphan)).toBe(true);
  });
});
