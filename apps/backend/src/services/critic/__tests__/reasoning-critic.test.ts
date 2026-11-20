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

import {
  runReasoningCritic,
  type ParsedReasoningCritic,
} from "../reasoning-critic";

type F = { kind: string; reviewer?: "anthropic" | "openai" };

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
const parseResult = (raw: string): ParsedReasoningCritic<F> => {
  try {
    const o = JSON.parse(raw);
    return { ok: true, verdict: o.verdict, findings: o.findings, reversal_triggers_present: o.rtp };
  } catch {
    return { ok: false, error: "malformed_json" };
  }
};
const cfg = (over: Partial<Parameters<typeof runReasoningCritic<F>>[0]> = {}) => ({
  userMsg: "u",
  systemPrompt: "s",
  anthropicModel: "claude-haiku-4-5-20251001",
  maxTokens: 1200,
  openAiJsonSchema: { type: "object" },
  openAiSchemaName: "t",
  parseResult,
  tags: { tenantId: "t1", agentSlug: "advisor", runId: "r1" },
  signal: AbortSignal.timeout(5000),
  findingCap: 8,
  ...over,
});

beforeEach(() => {
  anthropicCreate.mockReset();
  openaiCreate.mockReset();
  openaiState.client = "ok";
});

describe("runReasoningCritic — generic two-lane core", () => {
  it("both lanes ok → merged reviewer-tagged findings, anthropic leads", async () => {
    anthropicCreate.mockResolvedValue(aResp({ verdict: "ok", findings: [{ kind: "a1" }] }));
    openaiCreate.mockResolvedValue(oResp({ verdict: "revise", findings: [{ kind: "o1" }] }));
    const r = await runReasoningCritic<F>(cfg());
    expect(r.verdict).toBe("revise");
    expect(r.findings[0].reviewer).toBe("anthropic");
    expect(r.findings.some((f) => f.reviewer === "openai")).toBe(true);
    expect(r.lanes.anthropic.status).toBe("ok");
    expect(r.lanes.openai.status).toBe("ok");
    expect(r.cost_usd).toBeGreaterThan(0);
  });

  it("round-robin: 8 anthropic findings do not starve the 1 openai finding", async () => {
    anthropicCreate.mockResolvedValue(
      aResp({ verdict: "revise", findings: Array.from({ length: 8 }, () => ({ kind: "a" })) }),
    );
    openaiCreate.mockResolvedValue(oResp({ verdict: "revise", findings: [{ kind: "o" }] }));
    const r = await runReasoningCritic<F>(cfg());
    expect(r.findings.length).toBe(8);
    expect(r.findings.some((f) => f.reviewer === "openai")).toBe(true);
    expect(r.findings[0].reviewer).toBe("anthropic");
  });

  it("openai throws → anthropic carries; lanes.openai unavailable", async () => {
    anthropicCreate.mockResolvedValue(aResp({ verdict: "revise", findings: [{ kind: "a" }] }));
    openaiCreate.mockRejectedValue(new Error("429"));
    const r = await runReasoningCritic<F>(cfg());
    expect(r.verdict).toBe("revise");
    expect(r.lanes.openai.status).toBe("unavailable");
    expect(r.lanes.anthropic.status).toBe("ok");
  });

  it("both lanes throw → verdict ok, empty findings (caller maps to fail-open)", async () => {
    anthropicCreate.mockRejectedValue(new Error("x"));
    openaiCreate.mockRejectedValue(new Error("y"));
    const r = await runReasoningCritic<F>(cfg());
    expect(r.verdict).toBe("ok");
    expect(r.findings).toEqual([]);
    expect(r.reversal_triggers_present).toBeUndefined();
    expect(r.lanes.anthropic.status).toBe("unavailable");
    expect(r.lanes.openai.status).toBe("unavailable");
  });

  it("getOpenAi null → openai skipped, anthropic-only", async () => {
    openaiState.client = "null";
    anthropicCreate.mockResolvedValue(aResp({ verdict: "ok", findings: [] }));
    const r = await runReasoningCritic<F>(cfg());
    expect(openaiCreate).not.toHaveBeenCalled();
    expect(r.lanes.openai.status).toBe("skipped");
  });

  it("getOpenAi throws inside lane → unavailable, anthropic unaffected", async () => {
    openaiState.client = "throw";
    anthropicCreate.mockResolvedValue(aResp({ verdict: "ok", findings: [] }));
    const r = await runReasoningCritic<F>(cfg());
    expect(r.lanes.openai.status).toBe("unavailable");
    expect(r.lanes.anthropic.status).toBe("ok");
  });

  it("reversal_triggers_present = AND across lanes that report it", async () => {
    anthropicCreate.mockResolvedValue(aResp({ verdict: "ok", findings: [], rtp: true }));
    openaiCreate.mockResolvedValue(oResp({ verdict: "ok", findings: [], rtp: false }));
    const r = await runReasoningCritic<F>(cfg());
    expect(r.reversal_triggers_present).toBe(false);
  });
});
