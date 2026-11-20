import { afterEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ insert: vi.fn(async (_row: unknown) => ({ error: null })) }));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ from: () => ({ insert: h.insert }) }) }));
import { strategyTimingObserver, timeStrategyStep } from "../strategy-timing";

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); h.insert.mockClear(); });

describe("strategy timings through the real log sanitizer", () => {
  it("persists numerical review findings and discards company content", async () => {
    vi.stubEnv("PRAXIS_CONTAINER_ROLE", "canonical");
    strategyTimingObserver("tenant", "run")({
      stage: "review_scored", ms: 200, iteration: 1, outcome: "passed", score: 9, issues: 2, unsupported: 0,
      privateText: "Confidential business facts",
    } as never);
    await vi.waitFor(() => expect(h.insert).toHaveBeenCalledOnce());
    const row = h.insert.mock.calls[0][0] as { meta: Record<string, unknown> };
    expect(row).toMatchObject({ tenant_id: "tenant", run_id: "run", code: "strategy_stage_timing" });
    expect(row.meta).toMatchObject({ stage: "review_scored", ms: 200, step_index: 1, count: 2, review_score: 9, review_unsupported: 0 });
    expect(JSON.stringify(row)).not.toContain("Confidential");
  });

  it("keeps only bounded numerical quality bars through the real sanitizer", async () => {
    vi.stubEnv("PRAXIS_CONTAINER_ROLE", "canonical");
    strategyTimingObserver("tenant", "run")({
      stage: "review_scored", ms: 0, iteration: 0, outcome: "needs_revision",
      scores: { constraint: 7, target: 8, actions: 6, effects: 5, grounding: 4, private: "company text" },
      issueCounts: { constraint: 1, target: 0, actions: 2, effects: 3, grounding: 4, private: "company text" },
    } as never);
    await vi.waitFor(() => expect(h.insert).toHaveBeenCalledOnce());
    const row = h.insert.mock.calls[0][0] as { meta: Record<string, unknown> };
    expect(row.meta).toMatchObject({
      review_constraint_score: 7, review_target_score: 8, review_actions_score: 6,
      review_effects_score: 5, review_grounding_score: 4,
      review_constraint_issues: 1, review_target_issues: 0, review_actions_issues: 2,
      review_effects_issues: 3, review_grounding_issues: 4,
    });
    expect(JSON.stringify(row)).not.toContain("company text");
  });

  it("drops malformed quality scores rather than logging arbitrary values", async () => {
    vi.stubEnv("PRAXIS_CONTAINER_ROLE", "canonical");
    strategyTimingObserver("tenant", "run")({
      stage: "review_scored", ms: 0, iteration: 0, outcome: "needs_revision",
      scores: { constraint: "private", target: Infinity, actions: -1, effects: 11, grounding: 8 },
      issueCounts: { constraint: {}, target: NaN, actions: -1, effects: 1.5, grounding: 0 },
    } as never);
    await vi.waitFor(() => expect(h.insert).toHaveBeenCalledOnce());
    const row = h.insert.mock.calls[0][0] as { meta: Record<string, unknown> };
    expect(Object.fromEntries(Object.entries(row.meta).filter(([k]) => k.startsWith("review_"))))
      .toEqual({ review_grounding_score: 8, review_grounding_issues: 0 });
  });

  it("persists only numerical attempt diagnostics, without counting another analytics stage", async () => {
    vi.stubEnv("PRAXIS_CONTAINER_ROLE", "canonical");
    vi.stubEnv("POSTHOG_PROJECT_KEY", "phc_test");
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    strategyTimingObserver("tenant", "run")({ stage: "revision_attempt", ms: 120, iteration: 0, outcome: "rate_limited",
      attemptTiming: { attempt: 1, ms: 120, outcome: "rate_limited", promptChars: 1234,
        apiMs: 80, inputTokens: 50, outputTokens: 9, cacheReadTokens: 30, cacheWriteTokens: 5,
        token: "PRIVATE CREDENTIAL", prompt: "PRIVATE CONTENT" },
    } as never);
    await vi.waitFor(() => expect(h.insert).toHaveBeenCalledOnce());
    const row = h.insert.mock.calls[0][0] as { meta: Record<string, unknown> };
    expect(row.meta).toMatchObject({ stage: "revision_attempt", ms: 120, step_index: 0, outcome: "rate_limited",
      retry_count: 1, prompt_chars: 1234, provider_api_ms: 80, input_tokens: 50, output_tokens: 9,
      cache_read_tokens: 30, cache_write_tokens: 5 });
    expect(JSON.stringify(row)).not.toContain("PRIVATE");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drops malformed attempt metrics and keeps unknown usage absent", async () => {
    vi.stubEnv("PRAXIS_CONTAINER_ROLE", "canonical");
    strategyTimingObserver("tenant", "run")({ stage: "critic_fallback_attempt", ms: 20, iteration: 0, outcome: "error",
      attemptTiming: { attempt: 0, promptChars: "PRIVATE", apiMs: NaN, inputTokens: -1, outputTokens: 1.2, cacheReadTokens: Infinity },
    } as never);
    await vi.waitFor(() => expect(h.insert).toHaveBeenCalledOnce());
    const row = h.insert.mock.calls[0][0] as { meta: Record<string, unknown> };
    expect(row.meta).toEqual({ agent_slug: "cgo", stage: "critic_fallback_attempt", ms: 20, step_index: 0, outcome: "error", retry_count: 0 });
  });

  it("measures failed saves while preserving the original error", async () => {
    vi.stubEnv("PRAXIS_CONTAINER_ROLE", "canonical");
    vi.useFakeTimers(); vi.setSystemTime(0);
    const error = new Error("private database response");
    await expect(timeStrategyStep("tenant", "run", "apply", async () => { vi.setSystemTime(321); throw error; })).rejects.toBe(error);
    expect(h.insert.mock.calls[0][0]).toMatchObject({ meta: { stage: "apply", ms: 321, outcome: "error" } });
    expect(JSON.stringify(h.insert.mock.calls)).not.toContain("private database response");
  });

  it("sends each timed stage to PostHog without company content, and skips the score marker", async () => {
    vi.stubEnv("PRAXIS_CONTAINER_ROLE", "canonical");
    vi.stubEnv("POSTHOG_PROJECT_KEY", "phc_test");
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({ ok: true, status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const observe = strategyTimingObserver("tenant", "run");
    observe({ stage: "review_scored", ms: 0, iteration: 1, outcome: "passed", score: 9 } as never);
    observe({ stage: "critic", ms: 200, iteration: 1, outcome: "ok", privateText: "Confidential business facts" } as never);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const body = fetchMock.mock.calls[0][1].body as string;
    expect(JSON.parse(body).properties).toMatchObject({ stage: "critic", ms: 200, outcome: "ok", step_index: 1, run_id: "run" });
    expect(body).not.toContain("Confidential");
  });

  it("does not wait for a slow log write before returning the saved receipt", async () => {
    vi.stubEnv("PRAXIS_CONTAINER_ROLE", "canonical");
    h.insert.mockImplementationOnce(() => new Promise(() => {}));
    const receipt = { phase: "applied" };
    expect(await timeStrategyStep("tenant", "run", "apply", async () => receipt)).toBe(receipt);
  });
});
