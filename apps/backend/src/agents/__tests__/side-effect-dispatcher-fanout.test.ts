
import { describe, it, expect, vi, beforeEach } from "vitest";

const runGeneric = vi.fn();
vi.mock("@/services/agents/generic-dispatcher", () => ({
  runGeneric: (...args: unknown[]) => runGeneric(...args),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => {
    throw new Error("serviceClient must not be reached by a fanOut dispatcher");
  },
}));
vi.mock("@/services/channels/channel-actions", () => ({
  switchedChannelForRun: async () => null,
  recordChannelRunActions: async () => {
    throw new Error("the channel_actions writer must not run on an unswitched channel");
  },
}));

import { createSideEffectDispatcher } from "@/agents/lib/side-effect-dispatcher";
import { stepDecisionBodies } from "@/agents/lib/channel-recipe-step";

const TWO_STEP = {
  rendered_markdown: "x",
  steps: [
    {
      title: "Add an H1 to the homepage",
      body: "b",
      blocking: true,
      effort: "minutes",
      evidence: ["e"],
    },
    {
      title: "Fix the /sell page",
      body: "b",
      blocking: false,
      effort: "hours",
      evidence: ["e"],
    },
  ],
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makeCtx = (over: Record<string, unknown> = {}): any => ({
  tenant_id: "t-1",
  runId: "run-1",
  agent: { slug: "seo" },
  emitDecision: vi.fn().mockResolvedValue("dec-1"),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  runGeneric.mockImplementation(async (_ctx: unknown, _payload: unknown) => ({
    parse_ok: true,
    parsed: _payload,
    tool_calls: [],
  }));
});

describe("createSideEffectDispatcher — fanOut", () => {
  it("fanOut emits ONE decision per action", async () => {
    const emitDecision = vi.fn().mockResolvedValue("dec-1");
    const dispatch = createSideEffectDispatcher({
      slug: "seo",
      decisionClass: "channel.recipe_step",
      fanOut: stepDecisionBodies,
    });
    await dispatch(makeCtx({ emitDecision }), TWO_STEP);
    expect(emitDecision).toHaveBeenCalledTimes(2);
    expect(emitDecision.mock.calls[0][1].step.title).toBe(
      "Add an H1 to the homepage",
    );
    expect(emitDecision.mock.calls[1][1].position).toBe(2);
  });

  it("without fanOut behaviour is unchanged — one emit, whole envelope", async () => {
    const emitDecision = vi.fn().mockResolvedValue("dec-1");
    const dispatch = createSideEffectDispatcher({
      slug: "google_ads",
      decisionClass: "channel.recipe_step",
    });
    await dispatch(makeCtx({ emitDecision }), TWO_STEP);
    expect(emitDecision).toHaveBeenCalledTimes(1);
    expect(emitDecision.mock.calls[0][1].steps).toHaveLength(2);
  });

  it("a fanOut returning [] emits nothing and does not throw", async () => {
    const emitDecision = vi.fn();
    const dispatch = createSideEffectDispatcher({
      slug: "seo",
      decisionClass: "channel.recipe_step",
      fanOut: () => [],
    });
    await expect(
      dispatch(makeCtx({ emitDecision }), {
        rendered_markdown: "nothing",
        steps: [],
      }),
    ).resolves.toBeTruthy();
    expect(emitDecision).not.toHaveBeenCalled();
  });

  it("one failed emit does not cost the founder the remaining actions", async () => {
    const emitDecision = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue("dec-2");
    const dispatch = createSideEffectDispatcher({
      slug: "seo",
      decisionClass: "channel.recipe_step",
      fanOut: stepDecisionBodies,
    });
    const res = await dispatch(makeCtx({ emitDecision }), TWO_STEP);
    expect(emitDecision).toHaveBeenCalledTimes(2);
    expect(res.side_effect).toMatchObject({ kind: "shipped" });
  });

  it("throws when EVERY emit fails, rather than reporting a successful empty run", async () => {
    const emitDecision = vi.fn().mockRejectedValue(new Error("forbidden class"));
    const dispatch = createSideEffectDispatcher({
      slug: "seo",
      decisionClass: "channel.recipe_step",
      fanOut: stepDecisionBodies,
    });
    await expect(
      dispatch(makeCtx({ emitDecision }), TWO_STEP),
    ).rejects.toThrow(/all 2 emit\(s\) failed/);
    expect(emitDecision).toHaveBeenCalledTimes(2);
  });

  it("records every emitted decision id, not just the first", async () => {
    const emitDecision = vi
      .fn()
      .mockResolvedValueOnce("dec-a")
      .mockResolvedValueOnce("dec-b");
    const dispatch = createSideEffectDispatcher({
      slug: "seo",
      decisionClass: "channel.recipe_step",
      fanOut: stepDecisionBodies,
    });
    const res = await dispatch(makeCtx({ emitDecision }), TWO_STEP);
    expect(res.side_effect).toEqual({ kind: "shipped", detail: "dec-a,dec-b" });
  });

  it("a not_here fit verdict keeps only the verdict card; a redo run is exempt", async () => {
    const NOT_HERE = {
      rendered_markdown: "x",
      fit: { verdict: "not_here", reason: "their buyer is not on this channel" },
      steps: [
        { ...TWO_STEP.steps[1], title: "Post this week's carousel", intent: "create" },
        { ...TWO_STEP.steps[0], title: "Spend this week elsewhere", fit_verdict: true },
      ],
    };
    const dispatch = createSideEffectDispatcher({
      slug: "instagram_organic",
      decisionClass: "channel.recipe_step",
      fanOut: stepDecisionBodies,
    });
    const emitDecision = vi.fn().mockResolvedValue("dec-1");
    await dispatch(makeCtx({ emitDecision }), NOT_HERE);
    expect(emitDecision.mock.calls.map((c) => c[1].step.title)).toEqual(["Spend this week elsewhere"]);

    const redoEmit = vi.fn().mockResolvedValue("dec-2");
    await dispatch(makeCtx({ emitDecision: redoEmit }), { ...NOT_HERE, redo: { origin_run_id: "run-0" } });
    expect(redoEmit.mock.calls.map((c) => c[1].step.title)).toEqual(["Post this week's carousel"]);
  });
});
