import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/supabase", () => {
  const q: Record<string, (...a: unknown[]) => unknown> = {
    select: () => q,
    eq: () => q,
    gt: () => q,
    limit: () => q,
    order: () => q,
    in: () => ({ data: [], error: null }),
    maybeSingle: () => ({ data: null, error: null }),
    single: () => ({ data: null, error: null }),
  };
  return {
    serviceClient: () => ({
      from: () => ({ ...q, insert: () => ({ error: null }) }),
    }),
  };
});
vi.mock("@/services/agents/runner", () => ({
  enqueueAgentRun: vi.fn(async () => ({ run_id: "child_x" })),
}));
vi.mock("@/services/memory", () => ({ writeNote: vi.fn(async () => {}) }));

import { productPmBacklogSchema } from "../output-schema";

const base = {
  rendered_markdown: "x",
  summary: { bullets: [] as string[] },
  backlog: [] as unknown[],
  dispatched_actions: [] as unknown[],
  recommended_actions_not_dispatched: [] as unknown[],
  sources_all: [] as unknown[],
  snapshot_run_id: "run_x",
};
const okItem = {
  item_id: "i1",
  theme: "t",
  theme_normalized: "t",
  problem: "p",
  proposed_fix: "f",
  target: "backend",
  code_reach: 0,
  code_confidence: 0,
  impact: "low",
  effort: "low",
  rice_score: 0,
  reasoning: "r",
  evidence_sources: [{ agent_run_id: "a", summary: "" }],
};
function makeStratBrief() {
  return {
    ...base,
    status: "strategy_memo" as const,
    strategy: {
      premise_check: "Premise inverted.",
      reframe_options: [
        { title: "Outcome packages", rationale: "Kills anchor", metrics: ["trial->paid"], rank: 1 },
      ],
      research_findings: [],
      clarifications_needed: false as const,
    },
  };
}

describe("strategy_memo schema isolation", () => {
  it("valid reframe memo", () => {
    expect(productPmBacklogSchema.safeParse(makeStratBrief()).success).toBe(true);
  });
  it("valid clarify memo", () => {
    expect(
      productPmBacklogSchema.safeParse({
        ...base,
        status: "strategy_memo",
        strategy: {
          premise_check: "",
          reframe_options: [],
          research_findings: [],
          clarifications_needed: { questions: ["q1", "q2"] },
        },
      }).success,
    ).toBe(true);
  });
  it.each([
    ["backlog", { backlog: [okItem] }],
    [
      "dispatched_actions",
      {
        dispatched_actions: [
          {
            item_id: "i1",
            target_agent_slug: "engineer",
            task_description: "do the thing",
            repo_hint: "rravi149/praxis",
            file_hints: ["a.ts"],
            child_run_id: "pending",
          },
        ],
      },
    ],
    [
      "recommended_actions_not_dispatched",
      {
        recommended_actions_not_dispatched: [
          { item_id: "i1", description: "d", target_team: "ops", urgency: "now" },
        ],
      },
    ],
  ])("REJECTS strategy_memo carrying delivery field %s", (_n, extra) => {
    expect(
      productPmBacklogSchema.safeParse({ ...makeStratBrief(), ...extra }).success,
    ).toBe(false);
  });
  it("REJECTS strategy_memo with neither reframe nor clarify", () => {
    expect(
      productPmBacklogSchema.safeParse({
        ...base,
        status: "strategy_memo",
        strategy: {
          premise_check: "x",
          reframe_options: [],
          research_findings: [],
          clarifications_needed: false,
        },
      }).success,
    ).toBe(false);
  });
  it("REJECTS a strategy block on a DELIVERY status", () => {
    expect(
      productPmBacklogSchema.safeParse({
        ...base,
        status: "no_signal",
        strategy: {
          premise_check: "x",
          reframe_options: [],
          research_findings: [],
          clarifications_needed: false,
        },
      }).success,
    ).toBe(false);
  });
  it("delivery actionable still valid (no regression)", () => {
    expect(
      productPmBacklogSchema.safeParse({
        ...base,
        status: "actionable",
        summary: { bullets: ["b"] },
        backlog: [okItem],
      }).success,
    ).toBe(true);
  });
});

import { productPmInputSchema } from "../input-contract";
describe("productPmInputSchema clarify round-trip", () => {
  it("accepts prior_run_id + answers", () => {
    expect(
      productPmInputSchema.safeParse({
        prior_run_id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        answers: ["a", "b"],
      }).success,
    ).toBe(true);
  });
  it("rejects non-uuid prior_run_id", () => {
    expect(productPmInputSchema.safeParse({ prior_run_id: "nope" }).success).toBe(false);
  });
  it("rejects >5 answers", () => {
    expect(
      productPmInputSchema.safeParse({ answers: ["a", "b", "c", "d", "e", "f"] }).success,
    ).toBe(false);
  });
  it("legacy empty input still valid", () => {
    expect(productPmInputSchema.safeParse({}).success).toBe(true);
  });
  it("accepts structured clarification_response", () => {
    expect(
      productPmInputSchema.safeParse({
        prior_run_id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        clarification_response: {
          request_id: "f47ac10b-58cc-4372-a567-0e02b2c3d480",
          answers: [
            { question_id: "side", option_ids: ["drivers"] },
            { question_id: "price", other_text: "$79/mo" },
            { question_id: "tier", skipped: true },
          ],
        },
      }).success,
    ).toBe(true);
  });
  it("rejects clarification_response with non-uuid request_id", () => {
    expect(
      productPmInputSchema.safeParse({
        clarification_response: { request_id: "nope", answers: [] },
      }).success,
    ).toBe(false);
  });
});

import { processProductPmBacklog } from "../post-run";
import { productPmPostProcess } from "../dispatcher";
import type { AgentContext, DispatcherResult } from "@/services/agents/types";

function ctx(o: Partial<AgentContext> = {}): AgentContext {
  return {
    tenant_id: "11111111-1111-1111-1111-111111111111",
    runId: "run_test",
    trigger: "chat",
    agent: { slug: "pm", metadata_praxis: {} },
    memory: { company: "", ops: "", policies: "", disputes: "", support: "" },
    ...o,
  } as unknown as AgentContext;
}

describe("post-run strategy mode", () => {
  it("thin company + chat → forced clarify, no dispatch, schema-valid", async () => {
    const { brief, dispatched } = await processProductPmBacklog(
      ctx({ memory: { company: "tiny", ops: "", policies: "", disputes: "", support: "" } }) as AgentContext,
      JSON.parse(JSON.stringify(makeStratBrief())),
    );
    expect(brief.status).toBe("strategy_memo");
    expect(brief.strategy?.clarifications_needed).not.toBe(false);
    expect(brief.strategy?.reframe_options ?? []).toHaveLength(0);
    expect(brief.snapshot_run_id).toBe("run_test");
    expect(productPmBacklogSchema.safeParse(brief).success).toBe(true);
    expect(dispatched).toHaveLength(0);
  });
  it("rich company + chat → passthrough, no RICE/A2A, snapshot stamped", async () => {
    const rich =
      "Apna Tutor: NRI parent to India tutor 1:1 marketplace plus NRI-cultural AI tutor. ICP NRI parents TK-5. Tutors India-based; demand US NRI families. Pre-launch.".repeat(
        2,
      );
    const { brief, dispatched } = await processProductPmBacklog(
      ctx({ memory: { company: rich, ops: "", policies: "", disputes: "", support: "" } }) as AgentContext,
      JSON.parse(JSON.stringify(makeStratBrief())),
    );
    expect(brief.status).toBe("strategy_memo");
    expect(brief.strategy?.reframe_options).toHaveLength(1);
    expect(brief.snapshot_run_id).toBe("run_test");
    expect(dispatched).toHaveLength(0);
  });
  it("strategy_memo on cron → coerced to delivery insufficient_data, schema-valid", async () => {
    const { brief, dispatched } = await processProductPmBacklog(
      ctx({
        trigger: "cron",
        memory: { company: "x".repeat(400), ops: "", policies: "", disputes: "", support: "" },
      }) as AgentContext,
      JSON.parse(JSON.stringify(makeStratBrief())),
    );
    expect(brief.status).toBe("insufficient_data");
    expect(brief.strategy).toBeUndefined();
    expect(productPmBacklogSchema.safeParse(brief).success).toBe(true);
    expect(dispatched).toHaveLength(0);
  });

  it("path (3) passthrough → meta rendered_markdown + structured questions → synthesized", async () => {
    const metaBrief = {
      ...base,
      status: "strategy_memo" as const,
      rendered_markdown:
        "Asking 5 clarifying questions before building the GTM. No backlog items emitted — this is a strategy memo clarification turn.",
      strategy: {
        premise_check: "",
        reframe_options: [] as unknown[],
        research_findings: [] as unknown[],
        clarifications_needed: {
          questions: ["What is the price point?", "Drivers or hosts first?"],
        },
      },
    };
    const { brief, dispatched } = await processProductPmBacklog(
      ctx({
        memory: { company: "x".repeat(400), ops: "", policies: "", disputes: "", support: "" },
      }) as AgentContext,
      JSON.parse(JSON.stringify(metaBrief)),
    );
    expect(brief.status).toBe("strategy_memo");
    expect(brief.rendered_markdown).toContain("## Clarifying questions");
    expect(brief.rendered_markdown).toContain("1. What is the price point?");
    expect(brief.rendered_markdown).toContain("2. Drivers or hosts first?");
    expect(brief.rendered_markdown).not.toContain("No backlog items emitted");
    expect(productPmBacklogSchema.safeParse(brief).success).toBe(true);
    expect(dispatched).toHaveLength(0);
  });
});

import { __classifyForTest } from "../dispatcher";
describe("dispatcher mode injection", () => {
  it("classifier wired DELIVERY-default", () => {
    expect(__classifyForTest("cron", "growth pricing")).toBe("delivery");
    expect(__classifyForTest("chat", "how do I grow the product?")).toBe("strategy_memo");
  });
});

describe("premise-challenge eval fixture (HIGH-risk regression)", () => {
  it("Indian-parents Q + EMPTY company + hallucinated product → forced clarify, hallucination gone", async () => {
    const memo = JSON.parse(JSON.stringify(makeStratBrief()));
    memo.strategy.reframe_options[0].rationale =
      "Pivot the Python Starter course to a low-risk trial.";
    const { brief, dispatched } = await processProductPmBacklog(
      ctx({ trigger: "chat", memory: { company: "", ops: "", policies: "", disputes: "", support: "" } }) as AgentContext,
      memo,
    );
    expect(brief.status).toBe("strategy_memo");
    expect(brief.strategy?.clarifications_needed).not.toBe(false);
    expect(JSON.stringify(brief.strategy)).not.toMatch(/Python Starter/i);
    expect(dispatched).toHaveLength(0);
  });

  it("thin brain + ALREADY clarify (0 reframe) → passes through (known limitation, documented)", async () => {
    const clar = {
      ...base,
      status: "strategy_memo" as const,
      strategy: {
        premise_check: "",
        reframe_options: [],
        research_findings: [],
        clarifications_needed: { questions: ["q1", "q2"] },
      },
    };
    const { brief, dispatched } = await processProductPmBacklog(
      ctx({ trigger: "chat", memory: { company: "tiny", ops: "", policies: "", disputes: "", support: "" } }) as AgentContext,
      JSON.parse(JSON.stringify(clar)),
    );
    expect(brief.status).toBe("strategy_memo");
    expect(dispatched).toHaveLength(0);
  });

  it("mode isolation — rich strategy never enters RICE/skip pipeline", async () => {
    const { dispatched, skipped } = await processProductPmBacklog(
      ctx({ trigger: "chat", memory: { company: "x".repeat(400), ops: "", policies: "", disputes: "", support: "" } }) as AgentContext,
      JSON.parse(JSON.stringify(makeStratBrief())),
    );
    expect(dispatched).toHaveLength(0);
    expect(skipped).toHaveLength(0);
  });

  it("delivery no-regression — cron actionable w/ invalid citation does NOT early-return as strategy", async () => {
    const deliveryBrief = {
      ...base,
      status: "actionable" as const,
      summary: { bullets: ["b"] },
      backlog: [
        {
          ...okItem,
          evidence_sources: [{ agent_run_id: "00000000-0000-0000-0000-000000000000", summary: "" }],
        },
      ],
    };
    const { brief } = await processProductPmBacklog(
      ctx({ trigger: "cron" }) as AgentContext,
      JSON.parse(JSON.stringify(deliveryBrief)),
    );
    expect(brief.status).not.toBe("strategy_memo");
    expect(["no_signal", "insufficient_data", "actionable"]).toContain(brief.status);
  });
});

describe("productPmPostProcess clobber guard", () => {
  function makeResult(
    parsed: unknown,
    output_text: string,
    envelope_rescue_kind: "structured_questions" | "preceding_prose" | null = null,
  ): DispatcherResult {
    return {
      output_text,
      parsed: JSON.parse(JSON.stringify(parsed)),
      parse_ok: true,
      envelope_rescue_kind,
      raw_response_text: output_text + "\n<product_pm_backlog>{}</product_pm_backlog>",
      prompt_snapshot: "",
      usage: { input_tokens: 0, output_tokens: 0 },
    } as unknown as DispatcherResult;
  }

  it("keeps dispatcher-rescued questions when envelope_rescue_kind is set (no_signal + header-decorated meta rm)", async () => {
    const realQuestions =
      "Five questions, answer what you know:\n\n1. What's the current student subscription price point?\n2. Which segment launches first — drivers or hosts?";
    const metaBrief = {
      ...base,
      status: "no_signal" as const,
      artifact_label: "subscription gtm clarifying questions",
      rendered_markdown:
        "5 clarifying questions written out for operator. Awaiting answers before GTM strategy memo can be produced. No backlog items emitted this turn.",
    };
    const result = makeResult(metaBrief, realQuestions, "preceding_prose");
    await productPmPostProcess(ctx() as AgentContext, result);
    expect(result.output_text).toBe(realQuestions);
    expect(result.output_text).not.toContain("No backlog items emitted");
  });

  it("keeps the trimmed intro on a strategy_memo clarify turn (Slice A new path)", async () => {
    const trimmedIntro =
      "I have the architecture context. Before I rank GTM options I need a few answers:";
    const memoBrief = {
      ...base,
      status: "strategy_memo" as const,
      rendered_markdown:
        "## Subscription GTM\n\nFull prose with **1. Question one?** and **2. Question two?** written out.",
      strategy: {
        premise_check: "",
        reframe_options: [] as unknown[],
        research_findings: [] as unknown[],
        clarifications_needed: { questions: ["Question one?", "Question two?"] },
      },
    };
    const result = makeResult(memoBrief, trimmedIntro, "structured_questions");
    await productPmPostProcess(ctx() as AgentContext, result);
    expect(result.output_text).toBe(trimmedIntro);
    expect(result.output_text).not.toContain("**1.");
    expect(result.output_text).not.toContain("Question one?");
  });

  it("still overwrites output_text when no rescue happened (envelope_rescue_kind null)", async () => {
    const substantive =
      "## Reframe\nThis is a real strategy memo body with substantive content the model put directly in rendered_markdown.";
    const brief = { ...base, status: "no_signal" as const, rendered_markdown: substantive };
    const result = makeResult(brief, "stale dispatcher prose", null);
    await productPmPostProcess(ctx() as AgentContext, result);
    expect(result.output_text).toBe(substantive);
  });

  it("actionable delivery: server backlog-wiped message wins over stale LLM prose", async () => {
    const actionableBrief = {
      ...base,
      status: "actionable" as const,
      summary: { bullets: ["b"] },
      backlog: [
        {
          ...okItem,
          evidence_sources: [{ agent_run_id: "00000000-0000-0000-0000-000000000000", summary: "" }],
        },
      ],
    };
    const staleProse = "Top 3 things to fix: item A, item B, item C.";
    const result = makeResult(actionableBrief, staleProse, null);
    await productPmPostProcess(ctx() as AgentContext, result);
    expect(result.output_text).toContain("No product backlog items to surface");
    expect(result.output_text).not.toBe(staleProse);
  });

  it("engineer handoff with wiped backlog: honest handoff message, NOT canned no_signal", async () => {
    const handoffBrief = {
      ...base,
      status: "actionable" as const,
      summary: { bullets: ["b"] },
      backlog: [
        {
          ...okItem,
          evidence_sources: [{ agent_run_id: "00000000-0000-0000-0000-000000000000", summary: "" }],
        },
      ],
    };
    const staleProse = "I'll file a backlog item to send the pricing card to engineering.";
    const result = makeResult(handoffBrief, staleProse, null);
    await productPmPostProcess(ctx() as AgentContext, result, {
      mode: "delivery",
      pm_engineer_handoff: true,
    });
    expect(result.output_text).not.toContain("No product backlog items to surface");
    expect(result.output_text).toContain("hand this to the engineer");
    expect(result.output_text).not.toBe(staleProse);
  });

  it("no handoff flag: wiped backlog still emits the generic no_signal copy", async () => {
    const handoffBrief = {
      ...base,
      status: "actionable" as const,
      summary: { bullets: ["b"] },
      backlog: [
        {
          ...okItem,
          evidence_sources: [{ agent_run_id: "00000000-0000-0000-0000-000000000000", summary: "" }],
        },
      ],
    };
    const result = makeResult(handoffBrief, "stale", null);
    await productPmPostProcess(ctx() as AgentContext, result, { mode: "delivery" });
    expect(result.output_text).toContain("No product backlog items to surface");
    expect(result.output_text).not.toContain("hand this to the engineer");
  });
});
