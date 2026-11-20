import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  candidateRows: [] as Record<string, unknown>[],
  updates: [] as Array<{ id: string; payload: Record<string, unknown> }>,
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
          h.updates.push({ id: val, payload: updatePayload });
          updatePayload = null;
        }
        return q;
      },
      maybeSingle: () => Promise.resolve({ data: { blob: {} }, error: null }),
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
    text: JSON.stringify({ score: 70, rationale: "ok" }),
  }),
}));

import { scoreRecentUnscoredRuns, SKIP_SENTINEL } from "../run-scorer";
import {
  isResearchSelfAbortOutput,
  RESEARCH_UNVERIFIED_FALLBACK,
  RESEARCH_SELF_ABORT_SENTINEL,
} from "@/agents/research/self-abort";

const logger = { info: vi.fn(), warn: vi.fn() };

describe("isResearchSelfAbortOutput — exact + agent-gated", () => {
  it("research + exact stub → true", () => {
    expect(isResearchSelfAbortOutput("research", RESEARCH_UNVERIFIED_FALLBACK)).toBe(true);
  });
  it("non-research agent echoing the same string → false (agent-gated)", () => {
    expect(isResearchSelfAbortOutput("pm", RESEARCH_UNVERIFIED_FALLBACK)).toBe(false);
  });
  it("research with a near-miss / real report → false (exact-match)", () => {
    expect(isResearchSelfAbortOutput("research", "Here is a grounded report with sources.")).toBe(false);
    expect(isResearchSelfAbortOutput("research", RESEARCH_UNVERIFIED_FALLBACK + " extra")).toBe(false);
    expect(isResearchSelfAbortOutput("research", null)).toBe(false);
  });
});

const selfAbortRun = {
  id: "research-selfabort-0001",
  agent_slug: "research",
  status: "success",
  output_text: RESEARCH_UNVERIFIED_FALLBACK,
  error: null,
  model_used: "claude-sonnet-4-6",
  cost_usd: 0.084,
  tool_calls: 0,
};
const realResearchRun = {
  id: "research-real-0002",
  agent_slug: "research",
  status: "success",
  output_text: "Grounded competitor teardown with 5 cited sources...",
  error: null,
  model_used: "claude-sonnet-4-6",
  cost_usd: 0.21,
  tool_calls: 6,
};
const pmEchoRun = {
  id: "pm-echo-0003",
  agent_slug: "pm",
  status: "success",
  output_text: RESEARCH_UNVERIFIED_FALLBACK,
  error: null,
  model_used: "claude-sonnet-4-6",
  cost_usd: 0.05,
  tool_calls: 2,
};

describe("scoreRecentUnscoredRuns — research self-abort discount", () => {
  beforeEach(() => {
    h.updates = [];
    h.candidateRows = [selfAbortRun, realResearchRun, pmEchoRun];
    logger.info.mockClear();
    logger.warn.mockClear();
  });

  it("discounts the self-abort run: NULL score + RESEARCH_SELF_ABORT_SENTINEL, counted in skipped", async () => {
    const result = await scoreRecentUnscoredRuns(logger, 20);
    expect(result.skipped).toBe(1);
    expect(result.neverExecuted).toBe(0);
    const u = h.updates.find((x) => x.id === selfAbortRun.id);
    expect(u).toBeDefined();
    expect(u!.payload.quality_score).toBeNull();
    expect(u!.payload.quality_model).toBe(RESEARCH_SELF_ABORT_SENTINEL);
    expect(u!.payload.quality_model).not.toBe(SKIP_SENTINEL);
  });

  it("the real research run is scored normally (NOT discounted)", async () => {
    await scoreRecentUnscoredRuns(logger, 20);
    const u = h.updates.find((x) => x.id === realResearchRun.id);
    expect(u).toBeDefined();
    expect(u!.payload.quality_model).not.toBe(RESEARCH_SELF_ABORT_SENTINEL);
    expect(u!.payload.quality_score).not.toBeNull();
  });

  it("a NON-research run echoing the same string is NOT discounted (scored normally)", async () => {
    await scoreRecentUnscoredRuns(logger, 20);
    const u = h.updates.find((x) => x.id === pmEchoRun.id);
    expect(u).toBeDefined();
    expect(u!.payload.quality_model).not.toBe(RESEARCH_SELF_ABORT_SENTINEL);
    expect(u!.payload.quality_score).not.toBeNull();
  });
});
