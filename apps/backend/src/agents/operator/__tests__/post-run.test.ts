import { describe, it, expect, vi, beforeEach } from "vitest";

const maybeSingle = vi.fn();
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            order: () => ({
              limit: () => ({ maybeSingle }),
            }),
          }),
        }),
      }),
    }),
  }),
}));

import { operatorPostProcess } from "../post-run";
import type { AgentContext, DispatcherResult } from "@/services/agents/types";

function ctx(): AgentContext {
  return { runId: "run-1", tenant_id: "t-1", agent: { slug: "operator" } } as unknown as AgentContext;
}
function result(over: Partial<DispatcherResult> = {}): DispatcherResult {
  return {
    output_text: "clean answer",
    parsed: null,
    parse_ok: true,
    raw_response_text: "",
    prompt_snapshot: "",
    usage: { input_tokens: 0, output_tokens: 0 },
    tool_calls: [{ name: "operator_db__query", status: "ok" }],
    ...over,
  } as DispatcherResult;
}

beforeEach(() => {
  maybeSingle.mockReset();
  maybeSingle.mockResolvedValue({ data: { body: { classify: { tier: "tier2" } } }, error: null });
});

describe("operatorPostProcess — stashes failure shapes on result", () => {
  it("clean run sets operator_failure_shapes = [] (distinguishable from unran)", async () => {
    const r = result();
    await operatorPostProcess(ctx(), r, { current_message: "how many bookings?" });
    expect(r.operator_failure_shapes).toEqual([]);
  });

  it("tags a detected shape onto the result", async () => {
    const r = result({
      output_text: "I can't access your pricing.",
      tool_calls: [],
    });
    await operatorPostProcess(ctx(), r, { current_message: "what is our pricing?" });
    expect(r.operator_failure_shapes).toContain("capability-denial");
  });

  it("never throws when the classify read errors (best-effort)", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    const r = result();
    await expect(
      operatorPostProcess(ctx(), r, { current_message: "hi" }),
    ).resolves.toBeUndefined();
    expect(Array.isArray(r.operator_failure_shapes)).toBe(true);
  });

  it("does NOT mutate output_text (read-only on the answer)", async () => {
    const r = result({ output_text: "the original answer" });
    await operatorPostProcess(ctx(), r, {});
    expect(r.output_text).toBe("the original answer");
  });
});
