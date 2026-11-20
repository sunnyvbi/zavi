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

vi.mock("@/services/openai", () => ({
  getOpenAi: () => null,
  estimateOpenAiCostUsd: () => 0,
  OPENAI_CRITIC_MODEL: "gpt-5.5",
}));

const flag = vi.fn(async (_t: string) => false);
vi.mock("../advisor-critic-xfamily-flag", () => ({
  isAdvisorCriticXfamilyEnabled: (...a: [string]) => flag(...a),
}));

import { deliberateAdviceEnvelope } from "../deliberation";
import { adviceSchema } from "../output-schema";
import type { AgentContext, DispatcherResult } from "@/services/agents/types";

function textResponse(obj: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(obj) }],
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}
function rawTextResponse(text: string) {
  return { content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 10 } };
}

const ctx = {
  tenant_id: "11111111-1111-1111-1111-111111111111",
  runId: "run_adv_1",
} as unknown as AgentContext;

function makeResult(parsed: unknown): DispatcherResult {
  return { output_text: "ORIGINAL_OUTPUT", parsed, parse_ok: true } as unknown as DispatcherResult;
}

function substantiveAdvice(over: Record<string, unknown> = {}) {
  return {
    diagnosis: { stage: "growth", goal_restated: "Grow activation", key_signals: ["signups flat"] },
    research_findings: [],
    recommendations: { decide_today: [], next_30d: [], watch_for: [], deprioritize: [], lead_priority: undefined },
    dispatch_proposals: [],
    clarifications_needed: false as const,
    close_recommendations: [],
    rendered_markdown: "## Advice\nOriginal body",
    ...over,
  };
}
function clarificationAdvice() {
  return {
    diagnosis: { stage: "growth", goal_restated: "?", key_signals: [] },
    research_findings: [],
    recommendations: { decide_today: [], next_30d: [], watch_for: [], deprioritize: [], lead_priority: undefined },
    dispatch_proposals: [],
    clarifications_needed: { questions: ["What is the target ICP?"] },
    close_recommendations: [],
    rendered_markdown: "I need a few specifics first.",
  };
}

beforeEach(() => {
  captureCall.mockReset();
  responseQueue = [];
  flag.mockReset();
  flag.mockResolvedValue(true);
});

describe("deliberateAdviceEnvelope", () => {
  it("flag ON + substantive + critic revise + valid revise → parsed AND output_text updated; returns true", async () => {
    expect(adviceSchema.safeParse(substantiveAdvice()).success).toBe(true);
    const revised = substantiveAdvice({ rendered_markdown: "## Advice\nREVISED body with dissent + kill-condition" });
    responseQueue = [
      textResponse({ verdict: "revise", findings: [{ kind: "missing_dissent", target: "x", problem: "no dissent", fix: "add one" }] }),
      rawTextResponse("<advice>" + JSON.stringify(revised) + "</advice>"),
    ];
    const result = makeResult(substantiveAdvice());
    const didRevise = await deliberateAdviceEnvelope(ctx, result);
    expect(didRevise).toBe(true);
    expect(captureCall).toHaveBeenCalledTimes(2);
    expect((result.parsed as { rendered_markdown: string }).rendered_markdown).toContain("REVISED body");
    expect(result.output_text).toBe("## Advice\nREVISED body with dissent + kill-condition");
    expect(result.critic_lanes).toEqual({
      anthropic: { status: "ok" },
      openai: { status: "skipped" },
      revise_applied: true,
      critic_cost_usd: expect.any(Number),
    });
    expect(Object.keys((result.critic_lanes as { openai: object }).openai)).toEqual(["status"]);
    expect(JSON.stringify(result.critic_lanes)).not.toContain("error");
  });

  it("a FAILED anthropic lane records WHY, sanitized — never the raw error", async () => {
    responseQueue = [rawTextResponse("I'm afraid I can't help with that.")];
    const result = makeResult(substantiveAdvice());
    const didRevise = await deliberateAdviceEnvelope(ctx, result);
    expect(didRevise).toBe(false);

    const lanes = result.critic_lanes as {
      anthropic: { status: string; reason?: string };
    };
    expect(lanes.anthropic.status).toBe("unavailable");
    expect(lanes.anthropic.reason).toBe("malformed_json");
    expect(Object.keys(lanes.anthropic).sort()).toEqual(["reason", "status"]);
    expect(JSON.stringify(result.critic_lanes)).not.toContain("error");
  });

  it("an OK lane stays bare — no reason key invented on success", async () => {
    responseQueue = [textResponse({ verdict: "ok", findings: [] })];
    const result = makeResult(substantiveAdvice());
    await deliberateAdviceEnvelope(ctx, result);
    expect((result.critic_lanes as { anthropic: object }).anthropic).toEqual({
      status: "ok",
    });
  });

  it("flag OFF → fully inert: no critic call, nothing mutated, returns false (ships-inert contract)", async () => {
    flag.mockResolvedValue(false);
    const result = makeResult(substantiveAdvice());
    const didRevise = await deliberateAdviceEnvelope(ctx, result);
    expect(didRevise).toBe(false);
    expect(captureCall).not.toHaveBeenCalled();
    expect(result.output_text).toBe("ORIGINAL_OUTPUT");
    expect(flag).toHaveBeenCalledTimes(1);
    expect(result.critic_lanes).toBeUndefined();
  });

  it("clarification turn → no critic call, flag NOT read (gate is before flag)", async () => {
    const result = makeResult(clarificationAdvice());
    const didRevise = await deliberateAdviceEnvelope(ctx, result);
    expect(didRevise).toBe(false);
    expect(captureCall).not.toHaveBeenCalled();
    expect(flag).not.toHaveBeenCalled();
  });

  it("flag ON + critic verdict ok → no revise, original kept, returns false", async () => {
    responseQueue = [textResponse({ verdict: "ok", findings: [] })];
    const result = makeResult(substantiveAdvice());
    const didRevise = await deliberateAdviceEnvelope(ctx, result);
    expect(didRevise).toBe(false);
    expect(captureCall).toHaveBeenCalledTimes(1);
    expect(result.output_text).toBe("ORIGINAL_OUTPUT");
    expect(result.critic_lanes).toMatchObject({ revise_applied: false, openai: { status: "skipped" } });
  });

  it("flag ON + revise malformed → keep original (parsed + output_text unchanged)", async () => {
    responseQueue = [
      textResponse({ verdict: "revise", findings: [{ kind: "ungrounded_recommendation", target: "x", problem: "p", fix: "f" }] }),
      rawTextResponse("<advice>{ not valid json </advice>"),
    ];
    const result = makeResult(substantiveAdvice());
    const didRevise = await deliberateAdviceEnvelope(ctx, result);
    expect(didRevise).toBe(false);
    expect(captureCall).toHaveBeenCalledTimes(2);
    expect(result.output_text).toBe("ORIGINAL_OUTPUT");
    expect((result.parsed as { rendered_markdown: string }).rendered_markdown).toBe("## Advice\nOriginal body");
  });

  it("flag ON + critic throws → fail-open, no revise, original kept", async () => {
    responseQueue = [new Error("AbortError: timeout")];
    const result = makeResult(substantiveAdvice());
    const didRevise = await deliberateAdviceEnvelope(ctx, result);
    expect(didRevise).toBe(false);
    expect(captureCall).toHaveBeenCalledTimes(1);
    expect(result.output_text).toBe("ORIGINAL_OUTPUT");
  });
});
