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
const openaiState: { client: "ok" | "null" } = { client: "ok" };
vi.mock("@/services/openai", () => ({
  getOpenAi: () =>
    openaiState.client === "null"
      ? null
      : { chat: { completions: { create: (...a: unknown[]) => openaiCreate(...a) } } },
  estimateOpenAiCostUsd: () => 0.02,
  OPENAI_CRITIC_MODEL: "gpt-5.5",
}));

import { runAdviceCritic } from "../critic";
import type { Advice } from "../output-schema";

function aResp(obj: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(obj) }],
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}
function oResp(obj: unknown) {
  return {
    choices: [{ message: { content: JSON.stringify(obj) } }],
    usage: { prompt_tokens: 10, completion_tokens: 10 },
  };
}
const finding = (kind: string) => ({ kind, target: "t", problem: "p", fix: "f" });
const draft = {} as unknown as Advice;
const tags = { tenantId: "t1", agentSlug: "advisor" as const, runId: "r1" };

beforeEach(() => {
  anthropicCreate.mockReset();
  openaiCreate.mockReset();
  openaiState.client = "ok";
});

describe("runAdviceCritic — always two-lane (flag-gated upstream)", () => {
  it("both lanes ok → merged reviewer-tagged findings, verdict either-revise, lanes attached", async () => {
    anthropicCreate.mockResolvedValue(aResp({ verdict: "ok", findings: [finding("missing_dissent")] }));
    openaiCreate.mockResolvedValue(oResp({ verdict: "revise", findings: [finding("ungrounded_recommendation")] }));
    const r = await runAdviceCritic(draft, tags);
    expect(openaiCreate).toHaveBeenCalledTimes(1);
    expect(r.verdict).toBe("revise");
    expect(r.findings[0].reviewer).toBe("anthropic");
    expect(r.findings.some((f) => f.reviewer === "openai")).toBe(true);
    expect(r.lanes?.openai.status).toBe("ok");
    expect(r.cost_usd).toBeGreaterThan(0);
  });

  it("OpenAI throws → Anthropic verdict survives; lanes.openai unavailable; never throws", async () => {
    anthropicCreate.mockResolvedValue(aResp({ verdict: "revise", findings: [finding("flashy_misprioritized")] }));
    openaiCreate.mockRejectedValue(new Error("429"));
    const r = await runAdviceCritic(draft, tags);
    expect(r.verdict).toBe("revise");
    expect(r.findings.every((f) => f.reviewer === "anthropic")).toBe(true);
    expect(r.lanes?.openai.status).toBe("unavailable");
    expect(r.lanes?.anthropic.status).toBe("ok");
  });

  it("both lanes throw → fail-open (verdict ok, empty findings)", async () => {
    anthropicCreate.mockRejectedValue(new Error("a"));
    openaiCreate.mockRejectedValue(new Error("b"));
    const r = await runAdviceCritic(draft, tags);
    expect(r.verdict).toBe("ok");
    expect(r.findings).toEqual([]);
    expect(r.lanes?.anthropic.status).toBe("unavailable");
    expect(r.lanes?.openai.status).toBe("unavailable");
  });

  it("no OpenAI key → lane skipped, anthropic-only", async () => {
    openaiState.client = "null";
    anthropicCreate.mockResolvedValue(aResp({ verdict: "ok", findings: [] }));
    const r = await runAdviceCritic(draft, tags);
    expect(openaiCreate).not.toHaveBeenCalled();
    expect(r.lanes?.openai.status).toBe("skipped");
    expect(r.lanes?.anthropic.status).toBe("ok");
  });
});
