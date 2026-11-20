import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OneShotAttemptTiming } from "@/services/llm/claude-oneshot";
import type { ParsedStrategy } from "../strategy";

const h = vi.hoisted(() => ({ oneShot: vi.fn(), critic: vi.fn() }));
vi.mock("@/services/llm/claude-oneshot", () => ({ claudeOneShot: (...args: unknown[]) => h.oneShot(...args) }));
vi.mock("@/services/critic/critic-model", () => ({ callCriticModel: (...args: unknown[]) => h.critic(...args) }));
vi.mock("@/services/agents/registry", () => ({ loadGlobalAgentDefinition: () => ({ body_markdown: "test contract", metadata_praxis: { model: "test-model" } }) }));
import { createPlanReviewDeps, parseCritique } from "../plan-review";

const critiqueText = JSON.stringify({ scores: { constraint: 9, target: 9, actions: 9, effects: 9, grounding: 9 }, issues: [], unsupported_facts: [] });
const attempt: OneShotAttemptTiming = { attempt: 1, ms: 80, outcome: "ok", promptChars: 123, apiMs: 60, inputTokens: 14, outputTokens: 4 };
const input = () => ({ strategy: {} as ParsedStrategy, dossier: "private evidence", timeoutMs: 2000, signal: new AbortController().signal, iteration: 0, onTiming: vi.fn() });
beforeEach(() => {
  h.critic.mockReset(); h.oneShot.mockReset();
  h.oneShot.mockImplementation(async (opts: { onAttempt?: (e: OneShotAttemptTiming) => void }) => {
    opts.onAttempt?.(attempt);
    return { text: critiqueText, cost_usd: 0.01 };
  });
});

describe("CGO one-shot attempt wiring", () => {
  it("attaches revision diagnostics to the same review iteration and preserves the response", async () => {
    const i = input();
    expect(await createPlanReviewDeps().revise({ ...i, mode: "full", critique: parseCritique(critiqueText) })).toBe(critiqueText);
    expect(i.onTiming).toHaveBeenCalledWith({ stage: "revision_attempt", iteration: 0, ms: 80, outcome: "ok", attemptTiming: attempt });
    expect(h.oneShot).toHaveBeenCalledOnce();
    expect(h.oneShot.mock.calls[0][0]).toMatchObject({ timeoutMs: 2000, signal: i.signal, model: "test-model" });
  });

  it("marks fallback attempts separately without changing the primary/fallback decision", async () => {
    h.critic.mockRejectedValueOnce(new Error("provider down"));
    const i = input();
    const result = await createPlanReviewDeps().critique({ ...i, structuralIssues: [] });
    expect(result.pass).toBe(true);
    expect(i.onTiming).toHaveBeenCalledWith({ stage: "critic_fallback_attempt", iteration: 0, ms: 80, outcome: "ok", attemptTiming: attempt });
    expect(h.oneShot).toHaveBeenCalledOnce();
    expect(h.critic).toHaveBeenCalledOnce();
  });

  it("does not introduce a one-shot call when the primary critic answers", async () => {
    h.critic.mockResolvedValueOnce({ text: critiqueText });
    const i = input();
    expect((await createPlanReviewDeps().critique({ ...i, structuralIssues: [] })).pass).toBe(true);
    expect(h.oneShot).not.toHaveBeenCalled();
    expect(i.onTiming.mock.calls.map(([e]) => e.stage)).toEqual(["critic_primary"]);
  });
});
