import { describe, it, expect, vi, beforeEach } from "vitest";

const anthropicCreate = vi.fn();
vi.mock("@/services/anthropic", async () => {
  const actual =
    await vi.importActual<typeof import("@/services/anthropic")>(
      "@/services/anthropic",
    );
  return {
    ...actual,
    getAnthropic: () => ({
      messages: { create: (...a: unknown[]) => anthropicCreate(...a) },
    }),
  };
});

const openaiCreate = vi.fn();
const openaiState: { client: "ok" | "null" | "throw" } = { client: "ok" };
vi.mock("@/services/openai", () => ({
  getOpenAi: () => {
    if (openaiState.client === "null") return null;
    if (openaiState.client === "throw") throw new Error("getter boom");
    return {
      chat: { completions: { create: (...a: unknown[]) => openaiCreate(...a) } },
    };
  },
  estimateOpenAiCostUsd: () => 0.02,
  OPENAI_CRITIC_MODEL: "gpt-5.5",
}));

const flag = vi.fn(async (_tenantId: string) => false);
vi.mock("../pm-critic-xfamily-flag", () => ({
  isPmCriticXfamilyEnabled: (...a: [string]) => flag(...a),
}));

import { runPmDeliberationCritic, type PmCriticMode } from "../critic";
import type { ProductPmBacklog } from "../output-schema";

function aResp(obj: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(obj) }],
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}
function aRespRaw(text: string) {
  return {
    content: [{ type: "text", text }],
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}
function oResp(obj: unknown) {
  return {
    choices: [{ message: { content: JSON.stringify(obj) } }],
    usage: { prompt_tokens: 10, completion_tokens: 10 },
  };
}
const finding = (kind: string) => ({ kind, target: "i1", problem: "p", fix: "f" });

const tags = { tenantId: "t1", agentSlug: "pm" as const, runId: "r1" };
const delivery = { status: "actionable" } as unknown as ProductPmBacklog;
const strategy = { status: "strategy_memo" } as unknown as ProductPmBacklog;
const run = (d: ProductPmBacklog, mode: PmCriticMode) =>
  runPmDeliberationCritic(d, mode, tags);

beforeEach(() => {
  anthropicCreate.mockReset();
  openaiCreate.mockReset();
  flag.mockReset();
  flag.mockResolvedValue(false);
  openaiState.client = "ok";
});

describe("runPmDeliberationCritic — cross-family two-lane", () => {
  it("(1) flag OFF → single-lane; no OpenAI call; no lanes/cost_usd attached", async () => {
    flag.mockResolvedValue(false);
    anthropicCreate.mockResolvedValue(
      aResp({ verdict: "ok", findings: [], reversal_triggers_present: true }),
    );
    const r = await run(strategy, "strategy_memo");
    expect(openaiCreate).not.toHaveBeenCalled();
    expect(r.lanes).toBeUndefined();
    expect(r.cost_usd).toBeUndefined();
    expect(r.verdict).toBe("ok");
  });

  it("(2) flag ON but mode=delivery → flag NEVER read (short-circuit), no OpenAI", async () => {
    flag.mockResolvedValue(true);
    anthropicCreate.mockResolvedValue(
      aResp({ verdict: "ok", findings: [], reversal_triggers_present: true }),
    );
    await run(delivery, "delivery");
    expect(flag).not.toHaveBeenCalled();
    expect(openaiCreate).not.toHaveBeenCalled();
  });

  it("(3) flag ON + strategy_memo + both lanes ok → merged reviewer-tagged findings, anthropic-first", async () => {
    flag.mockResolvedValue(true);
    anthropicCreate.mockResolvedValue(
      aResp({
        verdict: "ok",
        findings: [finding("ungrounded_item")],
        reversal_triggers_present: true,
      }),
    );
    openaiCreate.mockResolvedValue(
      oResp({
        verdict: "revise",
        findings: [finding("flashy_misprioritized")],
        reversal_triggers_present: true,
      }),
    );
    const r = await run(strategy, "strategy_memo");
    expect(openaiCreate).toHaveBeenCalledTimes(1);
    expect(r.verdict).toBe("revise");
    expect(r.findings[0].reviewer).toBe("anthropic");
    expect(r.findings.some((f) => f.reviewer === "openai")).toBe(true);
    expect(r.lanes?.anthropic.status).toBe("ok");
    expect(r.lanes?.openai.status).toBe("ok");
    expect(r.cost_usd).toBeGreaterThan(0);
  });

  it("(4) OpenAI lane throws → Anthropic verdict survives; lanes.openai unavailable; never throws", async () => {
    flag.mockResolvedValue(true);
    anthropicCreate.mockResolvedValue(
      aResp({
        verdict: "revise",
        findings: [finding("ungrounded_item")],
        reversal_triggers_present: false,
      }),
    );
    openaiCreate.mockRejectedValue(new Error("429 rate limit"));
    const r = await run(strategy, "strategy_memo");
    expect(r.verdict).toBe("revise");
    expect(r.findings.every((f) => f.reviewer === "anthropic")).toBe(true);
    expect(r.lanes?.openai.status).toBe("unavailable");
    expect(r.lanes?.anthropic.status).toBe("ok");
  });

  it("(5) Anthropic parse-fail + OpenAI revise → merged revise from OpenAI (asymmetric, no swallow)", async () => {
    flag.mockResolvedValue(true);
    anthropicCreate.mockResolvedValue(aRespRaw("not json at all"));
    openaiCreate.mockResolvedValue(
      oResp({
        verdict: "revise",
        findings: [finding("prose_not_structured")],
        reversal_triggers_present: false,
      }),
    );
    const r = await run(strategy, "strategy_memo");
    expect(r.verdict).toBe("revise");
    expect(r.lanes?.anthropic.status).toBe("unavailable");
    expect(r.lanes?.openai.status).toBe("ok");
    expect(r.findings.every((f) => f.reviewer === "openai")).toBe(true);
  });

  it("(6) both lanes throw → FAIL_OPEN (verdict ok, empty findings) with lane diagnostics", async () => {
    flag.mockResolvedValue(true);
    anthropicCreate.mockRejectedValue(new Error("boom"));
    openaiCreate.mockRejectedValue(new Error("boom2"));
    const r = await run(strategy, "strategy_memo");
    expect(r.verdict).toBe("ok");
    expect(r.findings).toEqual([]);
    expect(r.reversal_triggers_present).toBe(true);
    expect(r.lanes?.anthropic.status).toBe("unavailable");
    expect(r.lanes?.openai.status).toBe("unavailable");
  });

  it("(7) no OpenAI key (getOpenAi null) → lane skipped, Anthropic-only verdict", async () => {
    flag.mockResolvedValue(true);
    openaiState.client = "null";
    anthropicCreate.mockResolvedValue(
      aResp({ verdict: "ok", findings: [], reversal_triggers_present: true }),
    );
    const r = await run(strategy, "strategy_memo");
    expect(openaiCreate).not.toHaveBeenCalled();
    expect(r.lanes?.openai.status).toBe("skipped");
    expect(r.lanes?.anthropic.status).toBe("ok");
    expect(r.verdict).toBe("ok");
  });

  it("(8) getOpenAi() THROWS inside the lane → caught as unavailable; Anthropic unaffected", async () => {
    flag.mockResolvedValue(true);
    openaiState.client = "throw";
    anthropicCreate.mockResolvedValue(
      aResp({ verdict: "ok", findings: [], reversal_triggers_present: true }),
    );
    const r = await run(strategy, "strategy_memo");
    expect(r.lanes?.openai.status).toBe("unavailable");
    expect(r.lanes?.anthropic.status).toBe("ok");
    expect(r.verdict).toBe("ok");
  });

  it("(9b) round-robin merge: 8 Anthropic findings do NOT starve the 1 OpenAI finding (codex P2)", async () => {
    flag.mockResolvedValue(true);
    const eight = Array.from({ length: 8 }, (_, i) => finding("ungrounded_item"));
    anthropicCreate.mockResolvedValue(
      aResp({ verdict: "revise", findings: eight, reversal_triggers_present: true }),
    );
    openaiCreate.mockResolvedValue(
      oResp({
        verdict: "revise",
        findings: [finding("flashy_misprioritized")],
        reversal_triggers_present: true,
      }),
    );
    const r = await run(strategy, "strategy_memo");
    expect(r.findings.length).toBe(8);
    expect(r.findings.some((f) => f.reviewer === "openai")).toBe(true);
    expect(r.findings[0].reviewer).toBe("anthropic");
  });

  it("(9) reversal_triggers_present = false if EITHER ok lane says false", async () => {
    flag.mockResolvedValue(true);
    anthropicCreate.mockResolvedValue(
      aResp({ verdict: "ok", findings: [], reversal_triggers_present: true }),
    );
    openaiCreate.mockResolvedValue(
      oResp({ verdict: "ok", findings: [], reversal_triggers_present: false }),
    );
    const r = await run(strategy, "strategy_memo");
    expect(r.reversal_triggers_present).toBe(false);
  });
});
