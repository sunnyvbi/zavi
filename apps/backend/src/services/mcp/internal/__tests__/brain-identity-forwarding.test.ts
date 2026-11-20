
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ execute: vi.fn() }));

vi.mock("@/services/tools/memory/refine-anchor", () => ({
  brainRefineAnchorTool: {
    name: "brain_refine_anchor",
    description: "",
    input_schema: { parse: (v: unknown) => v },
    execute: mocks.execute,
  },
}));

import { callBrainTool } from "../brain";

beforeEach(() => {
  mocks.execute.mockReset();
  mocks.execute.mockResolvedValue({ ok: true });
});

describe("callBrainTool forwards every human-trust signal to the tool", () => {
  it("passes captured_page_context through to the tool's ctx", async () => {
    await callBrainTool("t1", "refine_anchor", { slug: "ops" }, {
      run_id: "run-1",
      agent_slug: "operator",
      run_trigger: "chat",
      untrusted_context: false,
      captured_page_context: true,
      chat_thread_id: "thread-1",
    });

    expect(mocks.execute).toHaveBeenCalledTimes(1);
    const ctx = mocks.execute.mock.calls[0][0] as Record<string, unknown>;
    expect(ctx.captured_page_context).toBe(true);
    expect(ctx.untrusted_context).toBe(false);
    expect(ctx.run_trigger).toBe("chat");
  });

  it("leaves it undefined when the caller did not set it (no invented trust)", async () => {
    await callBrainTool("t1", "refine_anchor", { slug: "ops" }, {
      run_trigger: "chat",
    });

    const ctx = mocks.execute.mock.calls[0][0] as Record<string, unknown>;
    expect(ctx.captured_page_context).toBeUndefined();
  });
});
