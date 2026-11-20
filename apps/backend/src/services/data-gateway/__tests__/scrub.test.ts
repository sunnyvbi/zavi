import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/tenant-client", () => ({ asTenantId: (t: string) => t, tenantClient: () => ({}) }));
vi.mock("../settings", () => ({ rawResultsRetention: async () => null }));

import { deleteCheckpointsAtRunEnd, scrubDbPreviews, scrubPreviewsForRunEnd } from "../scrub";

const calls = () => [
  { name: "operator_db__query", output_preview: "rows" },
  { name: "operator_db_codeact", output_preview: "rows" },
  { name: "mcp__operator_db__codeact", output_preview: "rows" },
  { name: "mcp__server__operator_db__query", output_preview: "rows" },
  { name: "github__read_file", output_preview: "code" },
];

describe("scrubDbPreviews", () => {
  it("scrubs all four DB tool name forms and leaves other tools alone", () => {
    const out = scrubDbPreviews(calls());
    expect(out.slice(0, 4).every((c) => c.output_preview === "" && (c as { output_removed?: string }).output_removed === "privacy_setting")).toBe(true);
    expect(out[4]).toEqual({ name: "github__read_file", output_preview: "code" });
  });
});

describe("scrubPreviewsForRunEnd (before the terminal write)", () => {
  const retention = (r: "run" | "7" | "30" | null) => ({ retention: vi.fn(async () => r) });

  it("'run': previews scrubbed in the write itself; checkpoints to delete after the win", async () => {
    const out = await scrubPreviewsForRunEnd("t1", calls(), retention("run"));
    expect(out.calls[0].output_preview).toBe("");
    expect(out.calls[4].output_preview).toBe("code");
    expect(out.deleteCheckpoints).toBe(true);
  });

  it("legacy NULL and 7/30 days: unchanged at run end", async () => {
    for (const r of [null, "7", "30"] as const) {
      const out = await scrubPreviewsForRunEnd("t1", calls(), retention(r));
      expect(out.calls[0].output_preview).toBe("rows");
      expect(out.deleteCheckpoints).toBe(false);
    }
  });

  it("fails closed: an unreadable setting or no tenant scrubs (checkpoints left to the sweep)", async () => {
    const broken = {
      retention: vi.fn(async (): Promise<"run" | null> => {
        throw new Error("db down");
      }),
    };
    expect((await scrubPreviewsForRunEnd("t1", calls(), broken)).calls[0].output_preview).toBe("");
    const noTenant = await scrubPreviewsForRunEnd(null, calls(), retention(null));
    expect(noTenant.calls[0].output_preview).toBe("");
    expect(noTenant.deleteCheckpoints).toBe(false);
  });

  it("no DB tool call: no read at all", async () => {
    const r = retention("run");
    await scrubPreviewsForRunEnd("t1", [{ name: "github__read_file", output_preview: "x" }], r);
    expect(r.retention).not.toHaveBeenCalled();
  });
});

describe("deleteCheckpointsAtRunEnd (after the terminal write wins)", () => {
  it("deletes for a status a run ends in", async () => {
    const del = vi.fn(async () => undefined);
    expect(await deleteCheckpointsAtRunEnd("t1", "r1", "failed", { deleteCheckpoints: del })).toBe(true);
    expect(del).toHaveBeenCalledWith("t1", "r1");
  });

  it.each(["paused_awaiting_approval", "paused_awaiting_child", "running", "queued", null])(
    "never for a run that has not ended (%s)",
    async (status) => {
      const del = vi.fn(async () => undefined);
      expect(await deleteCheckpointsAtRunEnd("t1", "r1", status, { deleteCheckpoints: del })).toBe(false);
      expect(del).not.toHaveBeenCalled();
    },
  );

  it("a failed delete is reported, not thrown (the sweep is the backstop)", async () => {
    const del = vi.fn(async (): Promise<void> => {
      throw new Error("x");
    });
    expect(await deleteCheckpointsAtRunEnd("t1", "r1", "success", { deleteCheckpoints: del })).toBe(false);
  });
});
