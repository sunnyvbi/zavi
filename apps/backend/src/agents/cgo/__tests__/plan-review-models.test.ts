import { afterEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ critic: vi.fn(), claude: vi.fn() }));
vi.mock("@/services/critic/critic-model", () => ({ callCriticModel: h.critic }));
vi.mock("@/services/llm/claude-oneshot", () => ({ claudeOneShot: h.claude }));
import { reviewAndRevisePlan } from "../plan-review";
import { STRATEGY_REVIEW_CASES } from "@/services/eval/growth-sim/strategy-review-cases";
import { loadGlobalAgentDefinition } from "@/services/agents/registry";
import { agentDefaultEffort } from "@/services/agents/engineer-cost-v2";
import { MODELS } from "@/services/llm/models";

const highScore = JSON.stringify({ scores: { constraint: 9, target: 9, actions: 9, effects: 9, grounding: 9 }, issues: [], unsupported_facts: [] });
afterEach(() => { h.critic.mockReset(); h.claude.mockReset(); vi.useRealTimers(); });

describe("real review adapter wiring, model providers stubbed", () => {
  it("keeps the configured CGO model/effort and whole-strategy review for an eligible section edit", async () => {
    const fixture = structuredClone(STRATEGY_REVIEW_CASES[0]);
    const bets = fixture.strategy.channel_bets.map(b => ({ ...b, falsifier: b.falsifier + " by day 30" }));
    h.critic.mockResolvedValue({ text: highScore });
    h.claude.mockResolvedValue({ text: `<strategy_patch>${JSON.stringify({ channel_bets: bets })}</strategy_patch>` });
    const result = await reviewAndRevisePlan({ ...fixture, revisionMode: "targeted" });
    expect(result.stopped).toBe("passed");
    expect(h.critic).toHaveBeenCalledTimes(2);
    expect(h.claude).toHaveBeenCalledOnce();
    const model = loadGlobalAgentDefinition("cgo")?.metadata_praxis?.model ?? MODELS.anthropic.opus;
    const opts = h.claude.mock.calls[0][0];
    expect(opts.model).toBe(model);
    expect(opts.effort).toBe(agentDefaultEffort("cgo", model));
    expect(opts.effort).toBe("xhigh");
    expect(h.critic.mock.calls[1][0].user).toContain(fixture.strategy.constraint.statement);
    expect(h.critic.mock.calls[1][0].user).toContain(bets[0].falsifier);
    expect(result.passes[0].revision_mode).toBe("targeted");
  });

  it("times primary and fallback separately and gives fallback only the remaining deadline", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const fixture = structuredClone(STRATEGY_REVIEW_CASES[0]);
    fixture.strategy.channel_bets[0].falsifier += " by day 30";
    const events: unknown[] = [];
    h.critic.mockImplementation(async () => { vi.setSystemTime(20_000); throw Object.assign(new Error("private provider response"), { status: 401 }); });
    h.claude.mockImplementation(async () => { vi.setSystemTime(21_000); return { text: highScore }; });
    const result = await reviewAndRevisePlan({ ...fixture, budgetMs: 30_000, onTiming: e => events.push(e) });
    expect(result.stopped).toBe("passed");
    expect(h.claude.mock.calls[0][0].timeoutMs).toBe(10_000);
    expect(h.claude.mock.calls[0][0].signal).toBe(h.critic.mock.calls[0][0].signal);
    expect(events).toContainEqual(expect.objectContaining({ stage: "critic_primary", ms: 20_000, outcome: "error", httpStatus: 401 }));
    expect(events).toContainEqual(expect.objectContaining({ stage: "critic_fallback", ms: 1_000, outcome: "ok" }));
    expect(JSON.stringify(events)).not.toContain("private provider response");
  });
});
