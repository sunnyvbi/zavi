
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  proposals: [] as Array<{ tenant_id: string; p: Record<string, unknown> }>,
  insertThrows: false,
  writeNote: vi.fn(),
}));

vi.mock("@/services/memory", () => ({ writeNote: H.writeNote }));
vi.mock("@/services/memory/write-path", () => ({
  insertProposal: async (tenant_id: string, p: Record<string, unknown>) => {
    if (H.insertThrows) throw new Error("memory proposal insert failed: db down");
    H.proposals.push({ tenant_id, p });
    return { proposal_id: "prop-1", already_queued: false };
  },
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { payload: { thread_id: "thread-9" } } }),
        }),
      }),
    }),
  }),
}));

import { memoryWriteTool, __testHelpers } from "../write";
import { ExpectedToolError } from "../../types";

beforeEach(() => {
  H.proposals.length = 0;
  H.insertThrows = false;
  H.writeNote.mockReset();
});

function mkCtx(over: { run_id?: string; agent_slug?: string; tenant_id?: string } = {}) {
  return {
    tenant_id: over.tenant_id ?? "test-tenant-uuid",
    run_id: over.run_id,
    agent_slug: over.agent_slug,
    log: () => {},
  };
}

describe("looksLikeRawPaste", () => {
  it("small body always allowed (under 5KB threshold)", () => {
    expect(__testHelpers.looksLikeRawPaste("just a short fact")).toBe(false);
    expect(__testHelpers.looksLikeRawPaste("x".repeat(4999))).toBe(false);
  });

  it("large body with NO markdown structure is rejected", () => {
    const wall = "lorem ipsum dolor sit amet ".repeat(300);
    expect(wall.length).toBeGreaterThan(5000);
    expect(__testHelpers.looksLikeRawPaste(wall)).toBe(true);
  });

  it("large body with a heading, list, fence or emphasis passes", () => {
    expect(__testHelpers.looksLikeRawPaste("# A heading\n\n" + "filler text. ".repeat(500))).toBe(false);
    expect(__testHelpers.looksLikeRawPaste("- bullet one\n- bullet two\n" + "filler. ".repeat(500))).toBe(false);
    expect(__testHelpers.looksLikeRawPaste("```ts\nconst x = 1;\n```\n\n" + "narrative. ".repeat(500))).toBe(false);
    expect(__testHelpers.looksLikeRawPaste("This is *important*: " + "filler. ".repeat(500))).toBe(false);
  });

  it("threshold constant exposed as 5000 bytes", () => {
    expect(__testHelpers.RAW_PASTE_THRESHOLD_BYTES).toBe(5000);
  });
});

describe("memoryWriteTool queues a proposal, never a note", () => {
  it("queues the run's proposal and writes no note", async () => {
    const out = await memoryWriteTool.execute(mkCtx({ run_id: "run-abc-123" }), {
      title: "Take rate",
      body_markdown: "Take rate is 15%.",
      tags: ["pricing"],
    });
    expect(H.writeNote).not.toHaveBeenCalled();
    expect(H.proposals).toHaveLength(1);
    expect(H.proposals[0].tenant_id).toBe("test-tenant-uuid");
    expect(H.proposals[0].p).toEqual({
      run_id: "run-abc-123",
      thread_id: "thread-9",
      title: "Take rate",
      body: "Take rate is 15%.",
      tags: ["pricing"],
    });
    expect(out).toEqual({ queued: true, proposal_id: "prop-1", note: "Queued for memory review; not saved yet." });
  });

  it("no run id fails closed with an ExpectedToolError and queues nothing", async () => {
    await expect(
      memoryWriteTool.execute(mkCtx({ run_id: undefined }), { title: "", body_markdown: "fact", tags: [] }),
    ).rejects.toBeInstanceOf(ExpectedToolError);
    expect(H.proposals).toHaveLength(0);
    expect(H.writeNote).not.toHaveBeenCalled();
  });

  it("a queue error reaches the agent instead of reporting success", async () => {
    H.insertThrows = true;
    await expect(
      memoryWriteTool.execute(mkCtx({ run_id: "r1" }), { title: "", body_markdown: "fact", tags: [] }),
    ).rejects.toThrow(/proposal insert failed/);
  });

  it("the description no longer promises a saved note", () => {
    expect(memoryWriteTool.description).toContain("does NOT save it now");
    expect(memoryWriteTool.description).not.toContain("note_id");
  });
});

describe("memoryWriteTool: PII redaction before queueing", () => {
  it("emails are scrubbed before the proposal is stored", async () => {
    await memoryWriteTool.execute(mkCtx({ run_id: "r1" }), {
      title: "Customer complaint",
      body_markdown: "User alice@example.com flagged the bug.",
      tags: [],
    });
    expect(H.proposals[0].p.body).not.toMatch(/alice@example\.com/);
  });

  it("clean body passes through unchanged", async () => {
    await memoryWriteTool.execute(mkCtx({ run_id: "r1" }), {
      title: "Generic learning",
      body_markdown: "Operator prefers PR-per-feature, not commit-to-main.",
      tags: [],
    });
    expect(H.proposals[0].p.body).toBe("Operator prefers PR-per-feature, not commit-to-main.");
  });
});

describe("memoryWriteTool: raw-paste rejection", () => {
  it("rejects with ExpectedToolError when body >5KB + no structure", async () => {
    const wall = "lorem ipsum dolor sit amet consectetur ".repeat(200);
    let caught: unknown = null;
    try {
      await memoryWriteTool.execute(mkCtx({ run_id: "r1" }), { title: "stacktrace dump", body_markdown: wall, tags: [] });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ExpectedToolError);
    if (caught instanceof ExpectedToolError) {
      expect(caught.code).toBe("memory_write_raw_paste_rejected");
      expect(caught.message).toMatch(/markdown structure/);
    }
    expect(H.proposals).toHaveLength(0);
  });

  it("does NOT reject when body has at least one heading + bullet", async () => {
    const structured = "# Operator learning\n\n- Stripe webhook signing must be on\n- " + "lorem ipsum ".repeat(400);
    await memoryWriteTool.execute(mkCtx({ run_id: "r1" }), { title: "structured note", body_markdown: structured, tags: [] });
    expect(H.proposals).toHaveLength(1);
  });
});
