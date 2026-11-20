
import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  AgentContext,
  DispatcherResult,
} from "@/services/agents/types";

const mockRunGeneric = vi.fn();
vi.mock("@/services/agents/generic-dispatcher", () => ({
  runGeneric: (...args: unknown[]) => mockRunGeneric(...args),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: vi.fn() }),
}));

import { createSideEffectDispatcher } from "@/agents/lib/side-effect-dispatcher";

beforeEach(() => {
  vi.clearAllMocks();
});

function baseResult(over: Partial<DispatcherResult> = {}): DispatcherResult {
  return {
    output_text: "",
    parsed: { tier1: [], tier2: [], tier3: [], tier4: [], rendered_markdown: "x" },
    parse_ok: true,
    raw_response_text: "",
    prompt_snapshot: "",
    usage: { input_tokens: 0, output_tokens: 0 },
    tool_calls: [
      {
        name: "qa_engineer__add_test_case",
        input_preview: "{}",
        output_preview: "{}",
        ms: 1,
        status: "ok",
        returned_ids: ["00000000-0000-4000-8000-000000000001"],
      },
    ],
    ...over,
  };
}

function fakeCtx(): AgentContext {
  return {
    emitDecision: vi.fn().mockResolvedValue("decision-1"),
    tenant_id: "tnt-1",
    runId: "r-1",
  } as unknown as AgentContext;
}

describe("createSideEffectDispatcher — transform receives result", () => {
  it("passes the result (with tool_calls) as the 4th transform arg", async () => {
    mockRunGeneric.mockResolvedValueOnce(baseResult());
    const seen: DispatcherResult[] = [];
    const dispatcher = createSideEffectDispatcher({
      slug: "qa",
      decisionClass: "qa.weekly-digest",
      transformBeforeCriticAndEmit: async (envelope, _ctx, _payload, result) => {
        seen.push(result);
        return { envelope };
      },
    });
    await dispatcher(fakeCtx(), {});
    expect(seen).toHaveLength(1);
    expect(seen[0].tool_calls).toBeDefined();
    expect(seen[0].tool_calls?.[0]?.name).toBe("qa_engineer__add_test_case");
    expect(seen[0].tool_calls?.[0]?.returned_ids).toEqual([
      "00000000-0000-4000-8000-000000000001",
    ]);
  });

  it("emits the transformed envelope as the decision body", async () => {
    mockRunGeneric.mockResolvedValueOnce(baseResult());
    const ctx = fakeCtx();
    const dispatcher = createSideEffectDispatcher({
      slug: "qa",
      decisionClass: "qa.weekly-digest",
      transformBeforeCriticAndEmit: async (_envelope, _ctx, _payload, result) => ({
        envelope: { stamped: result.tool_calls?.length ?? 0 },
      }),
    });
    await dispatcher(ctx, {});
    expect(ctx.emitDecision).toHaveBeenCalledWith("qa.weekly-digest", {
      stamped: 1,
    });
  });

  it("stamps side_effect=shipped (with decision id) when a decision is emitted", async () => {
    mockRunGeneric.mockResolvedValueOnce(baseResult());
    const ctx = fakeCtx();
    const dispatcher = createSideEffectDispatcher({
      slug: "qa",
      decisionClass: "qa.weekly-digest",
      transformBeforeCriticAndEmit: async () => ({ envelope: { ok: true } }),
    });
    const out = await dispatcher(ctx, {});
    expect((out as DispatcherResult).side_effect).toEqual({ kind: "shipped", detail: "decision-1" });
  });

  it("stamps side_effect=refused (with reason) when the transform suppresses", async () => {
    mockRunGeneric.mockResolvedValueOnce(baseResult());
    const ctx = fakeCtx();
    const dispatcher = createSideEffectDispatcher({
      slug: "qa",
      decisionClass: "qa.weekly-digest",
      transformBeforeCriticAndEmit: async () => ({
        suppress: true,
        reason: "refused_envelope",
        output_text: "answered in prose",
      }),
    });
    const out = await dispatcher(ctx, {});
    expect((out as DispatcherResult).side_effect).toEqual({
      kind: "refused",
      reason: "refused_envelope",
    });
    expect(ctx.emitDecision).not.toHaveBeenCalled();
  });
});

describe("createSideEffectDispatcher — emitAfterRun (chat turns)", () => {
  const opts = {
    slug: "meta_ads",
    decisionClass: "x.class",
    shouldEmit: (parsed: unknown) => Array.isArray((parsed as { steps?: unknown }).steps),
  };

  it("a prose chat answer (no envelope) files nothing and never re-runs the model", async () => {
    const ctx = fakeCtx();
    const result = baseResult({ parse_ok: false, parsed: null, output_text: "Your CPA rose because..." });
    const out = await createSideEffectDispatcher(opts).emitAfterRun(ctx, result, {});
    expect(ctx.emitDecision).not.toHaveBeenCalled();
    expect(mockRunGeneric).not.toHaveBeenCalled();
    expect(out.output_text).toBe("Your CPA rose because...");
  });

  it("an envelope the founder asked for is filed from the chat's own result", async () => {
    const ctx = fakeCtx();
    const result = baseResult({ parsed: { steps: [{ title: "Pause ad set 3" }] } });
    const out = await createSideEffectDispatcher(opts).emitAfterRun(ctx, result, {});
    expect(mockRunGeneric).not.toHaveBeenCalled();
    expect(ctx.emitDecision).toHaveBeenCalledWith("x.class", { steps: [{ title: "Pause ad set 3" }] });
    expect(out.side_effect).toEqual({ kind: "shipped", detail: "decision-1" });
  });
});
