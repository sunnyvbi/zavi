import { describe, it, expect, vi, beforeEach } from "vitest";

const captureCall = vi.fn();
let responseQueue: Array<unknown | Error> = [];

vi.mock("@/services/anthropic", async () => {
  const actual =
    await vi.importActual<typeof import("@/services/anthropic")>(
      "@/services/anthropic",
    );
  return {
    ...actual,
    getAnthropic: () => ({
      messages: {
        create: async (...args: unknown[]) => {
          captureCall(...args);
          const next = responseQueue.shift();
          if (next instanceof Error) throw next;
          return next;
        },
      },
    }),
  };
});

vi.mock("../pm-critic-xfamily-flag", () => ({
  isPmCriticXfamilyEnabled: vi.fn(async () => false),
}));

import { deliberatePmEnvelope } from "../deliberation";
import { productPmBacklogSchema } from "../output-schema";
import type { AgentContext, DispatcherResult } from "@/services/agents/types";

function textResponse(obj: unknown): unknown {
  return {
    content: [{ type: "text", text: JSON.stringify(obj) }],
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}
function rawTextResponse(text: string): unknown {
  return {
    content: [{ type: "text", text }],
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

const ctx = {
  tenant_id: "11111111-1111-1111-1111-111111111111",
  runId: "run_pm_1",
} as unknown as AgentContext;

function makeResult(parsed: unknown): DispatcherResult {
  return {
    output_text: "ORIGINAL_OUTPUT",
    parsed,
    parse_ok: true,
  } as unknown as DispatcherResult;
}

const okItem = {
  item_id: "i1",
  theme: "Checkout latency",
  theme_normalized: "checkout latency",
  problem: "Checkout p95 is 4s and users abandon at payment.",
  proposed_fix: "Defer the fraud check to async after auth.",
  target: "backend",
  code_reach: 100,
  code_confidence: 60,
  impact: "high",
  effort: "medium",
  rice_score: 42,
  reasoning: "Cited support run shows 3 abandonment complaints tied to payment lag.",
  evidence_sources: [{ agent_run_id: "run_support_9", summary: "payment lag complaints" }],
};

function actionableBrief(over: Record<string, unknown> = {}) {
  return {
    status: "actionable" as const,
    rendered_markdown: "## Top theme\nCheckout latency",
    summary: { bullets: ["a"] },
    backlog: [okItem],
    dispatched_actions: [],
    recommended_actions_not_dispatched: [],
    sources_all: [],
    snapshot_run_id: "run_snap",
    ...over,
  };
}

function strategyBrief(over: Record<string, unknown> = {}) {
  return {
    status: "strategy_memo" as const,
    rendered_markdown: "## Premise\nReframe the pricing anchor.",
    summary: { bullets: [] as string[] },
    backlog: [] as unknown[],
    dispatched_actions: [] as unknown[],
    recommended_actions_not_dispatched: [] as unknown[],
    sources_all: [] as unknown[],
    strategy: {
      premise_check: "The free trial is the wrong anchor.",
      reframe_options: [
        { title: "Outcome packages", rationale: "Sell results not seats.", metrics: ["trial->paid"], rank: 1 },
      ],
      research_findings: [],
      clarifications_needed: false as const,
    },
    ...over,
  };
}

beforeEach(() => {
  captureCall.mockReset();
  responseQueue = [];
});

describe("deliberatePmEnvelope", () => {
  it("(1) critic flags a prose-only item → verdict revise (revise pass invoked)", async () => {
    responseQueue = [
      textResponse({
        verdict: "revise",
        findings: [
          {
            kind: "prose_not_structured",
            target: "i1",
            problem: "reasoning is boilerplate",
            fix: "ground it",
          },
        ],
        reversal_triggers_present: false,
      }),
      rawTextResponse(
        "<product_pm_backlog>" +
          JSON.stringify(
            actionableBrief({
              rendered_markdown: "## Top theme\nRevised checkout latency",
              backlog: [
                { ...okItem, reasoning: "Strengthened: 3 cited support runs + funnel drop." },
              ],
            }),
          ) +
          "</product_pm_backlog>",
      ),
    ];
    const result = makeResult(actionableBrief());
    await deliberatePmEnvelope(ctx, result);
    expect(captureCall).toHaveBeenCalledTimes(2);
  });

  it("(2) revise success → result.parsed updated + schema-valid (output_text owned by post-run)", async () => {
    const revisedBrief = actionableBrief({
      rendered_markdown: "## Top theme\nREVISED MARKDOWN BODY",
      backlog: [{ ...okItem, reasoning: "Now fully grounded with cited runs." }],
    });
    responseQueue = [
      textResponse({
        verdict: "revise",
        findings: [
          { kind: "empty_structured_field", target: "i1", problem: "weak", fix: "strengthen" },
        ],
        reversal_triggers_present: true,
      }),
      rawTextResponse("<product_pm_backlog>" + JSON.stringify(revisedBrief) + "</product_pm_backlog>"),
    ];
    const result = makeResult(actionableBrief());
    await deliberatePmEnvelope(ctx, result);

    expect(result.output_text).toBe("ORIGINAL_OUTPUT");
    const reparse = productPmBacklogSchema.safeParse(result.parsed);
    expect(reparse.success).toBe(true);
    expect((result.parsed as { backlog: { reasoning: string }[] }).backlog[0].reasoning).toContain(
      "fully grounded",
    );
  });

  it("(3) loop cap = 1: the revision is NOT re-critiqued (exactly 2 calls)", async () => {
    responseQueue = [
      textResponse({
        verdict: "revise",
        findings: [{ kind: "ungrounded_item", target: "i1", problem: "x", fix: "y" }],
        reversal_triggers_present: false,
      }),
      rawTextResponse(
        "<product_pm_backlog>" + JSON.stringify(actionableBrief()) + "</product_pm_backlog>",
      ),
      textResponse({ verdict: "revise", findings: [], reversal_triggers_present: false }),
    ];
    const result = makeResult(actionableBrief());
    await deliberatePmEnvelope(ctx, result);
    expect(captureCall).toHaveBeenCalledTimes(2);
    expect(responseQueue.length).toBe(1);
  });

  it("(4) critic throws/timeout → fail-open, original kept (no revise call)", async () => {
    responseQueue = [new Error("AbortError: timeout")];
    const original = actionableBrief();
    const result = makeResult(original);
    await deliberatePmEnvelope(ctx, result);
    expect(captureCall).toHaveBeenCalledTimes(1);
    expect(result.output_text).toBe("ORIGINAL_OUTPUT");
    expect(result.parsed).toBe(original);
  });

  it("(5) revise returns malformed → fall back to original", async () => {
    const original = actionableBrief();
    responseQueue = [
      textResponse({
        verdict: "revise",
        findings: [{ kind: "missing_tradeoff_side", target: "i1", problem: "x", fix: "y" }],
        reversal_triggers_present: false,
      }),
      rawTextResponse("<product_pm_backlog>{ this is not valid json </product_pm_backlog>"),
    ];
    const result = makeResult(original);
    await deliberatePmEnvelope(ctx, result);
    expect(captureCall).toHaveBeenCalledTimes(2);
    expect(result.output_text).toBe("ORIGINAL_OUTPUT");
    expect(result.parsed).toBe(original);
  });

  it("(6) no_signal / clarify / iterate-shaped statuses → no-op (critic NOT called)", async () => {
    for (const brief of [
      {
        status: "no_signal" as const,
        rendered_markdown: "Nothing actionable this run.",
        summary: { bullets: [] as string[] },
        backlog: [] as unknown[],
        dispatched_actions: [] as unknown[],
        recommended_actions_not_dispatched: [] as unknown[],
        sources_all: [] as unknown[],
      },
      {
        status: "insufficient_data" as const,
        rendered_markdown: "Need more inputs.",
        summary: { bullets: [] as string[] },
        backlog: [] as unknown[],
        dispatched_actions: [] as unknown[],
        recommended_actions_not_dispatched: [] as unknown[],
        sources_all: [] as unknown[],
      },
    ]) {
      captureCall.mockReset();
      const result = makeResult(brief);
      await deliberatePmEnvelope(ctx, result);
      expect(captureCall).not.toHaveBeenCalled();
      expect(result.output_text).toBe("ORIGINAL_OUTPUT");
    }
  });

  it("(6b) strategy_memo with EMPTY reframe_options (clarifications path) → no-op", async () => {
    const brief = strategyBrief({
      strategy: {
        premise_check: "",
        reframe_options: [] as unknown[],
        research_findings: [],
        clarifications_needed: { questions: ["What is the target ICP?"] },
      },
    });
    expect(productPmBacklogSchema.safeParse(brief).success).toBe(true);
    const result = makeResult(brief);
    await deliberatePmEnvelope(ctx, result);
    expect(captureCall).not.toHaveBeenCalled();
  });

  it("(7) strategy_memo WITH reframe_options + critic flags prose_not_structured → revise", async () => {
    const revised = strategyBrief({
      rendered_markdown: "## Premise\nRevised: structured options + reversal triggers.",
    });
    responseQueue = [
      textResponse({
        verdict: "revise",
        findings: [
          {
            kind: "prose_not_structured",
            target: "strategy.reframe_options",
            problem: "options buried in premise prose",
            fix: "promote to reframe_options[]",
          },
        ],
        reversal_triggers_present: false,
      }),
      rawTextResponse("<product_pm_backlog>" + JSON.stringify(revised) + "</product_pm_backlog>"),
    ];
    const result = makeResult(strategyBrief());
    await deliberatePmEnvelope(ctx, result);
    expect(captureCall).toHaveBeenCalledTimes(2);
    expect(
      (result.parsed as { rendered_markdown?: string }).rendered_markdown,
    ).toContain("Revised: structured options");
    expect(productPmBacklogSchema.safeParse(result.parsed).success).toBe(true);
  });

  it("(8) critic verdict ok → no revise, original kept", async () => {
    responseQueue = [
      textResponse({ verdict: "ok", findings: [], reversal_triggers_present: true }),
    ];
    const original = actionableBrief();
    const result = makeResult(original);
    await deliberatePmEnvelope(ctx, result);
    expect(captureCall).toHaveBeenCalledTimes(1);
    expect(result.parsed).toBe(original);
    expect(result.output_text).toBe("ORIGINAL_OUTPUT");
    expect((result as { critic_lanes?: unknown }).critic_lanes).toBeUndefined();
  });

  it("(9) override_unjustified finding triggers a revise pass (P1.1)", async () => {
    const revised = actionableBrief({
      backlog: [{ ...okItem, reasoning: "Override rationale now names the unblocked sibling." }],
    });
    responseQueue = [
      textResponse({
        verdict: "revise",
        findings: [{ kind: "override_unjustified", target: "i1", problem: "boilerplate override", fix: "name the sibling" }],
        reversal_triggers_present: true,
      }),
      rawTextResponse("<product_pm_backlog>" + JSON.stringify(revised) + "</product_pm_backlog>"),
    ];
    const result = makeResult(actionableBrief());
    await deliberatePmEnvelope(ctx, result);
    expect(captureCall).toHaveBeenCalledTimes(2);
    expect(productPmBacklogSchema.safeParse(result.parsed).success).toBe(true);
  });

  it("(10) unmeasurable_criterion is an accepted finding kind → revise fires (P1.2)", async () => {
    const revised = actionableBrief({
      backlog: [{ ...okItem, reasoning: "Criterion rewritten to a binary condition." }],
    });
    responseQueue = [
      textResponse({
        verdict: "revise",
        findings: [{ kind: "unmeasurable_criterion", target: "i1", problem: "vague 'works'", fix: "make it binary" }],
        reversal_triggers_present: true,
      }),
      rawTextResponse("<product_pm_backlog>" + JSON.stringify(revised) + "</product_pm_backlog>"),
    ];
    const result = makeResult(actionableBrief());
    await deliberatePmEnvelope(ctx, result);
    expect(captureCall).toHaveBeenCalledTimes(2);
    expect(productPmBacklogSchema.safeParse(result.parsed).success).toBe(true);
  });

  it("(11) reversal_trigger field round-trips through revise → safeParse (P1.4)", async () => {
    const revised = actionableBrief({
      backlog: [{ ...okItem, reversal_trigger: "kill if the error signature is gone in 2 weeks" }],
    });
    responseQueue = [
      textResponse({
        verdict: "revise",
        findings: [{ kind: "missing_tradeoff_side", target: "i1", problem: "no kill-condition", fix: "add reversal_trigger" }],
        reversal_triggers_present: false,
      }),
      rawTextResponse("<product_pm_backlog>" + JSON.stringify(revised) + "</product_pm_backlog>"),
    ];
    const result = makeResult(actionableBrief());
    await deliberatePmEnvelope(ctx, result);
    expect(captureCall).toHaveBeenCalledTimes(2);
    expect(productPmBacklogSchema.safeParse(result.parsed).success).toBe(true);
    expect((result.parsed as { backlog: { reversal_trigger?: string }[] }).backlog[0].reversal_trigger).toContain(
      "kill if",
    );
  });
});
