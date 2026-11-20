import { describe, it, expect, vi } from "vitest";

const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ rpc }) }));

import { realEnsurePreviewDeps } from "@/services/build/live-edit";

describe("live-edit preview rows are written so the 5-minute preview reaper owns them", () => {
  it("writes through set_engineer_sandbox_preview with a live-edit run id, never the reaper-invisible set_sandbox_preview", async () => {
    await realEnsurePreviewDeps.setPreview("row1", "https://3000-sb1.e2b.app", 3000, "live", "live-edit:run-9");
    expect(rpc).toHaveBeenCalledWith("set_engineer_sandbox_preview", {
      p_id: "row1",
      p_url: "https://3000-sb1.e2b.app",
      p_port: 3000,
      p_status: "live",
      p_run_id: "live-edit:run-9",
    });
    expect(rpc.mock.calls.map((c) => c[0])).not.toContain("set_sandbox_preview");
  });
});

describe("the preview reaper acts on live-edit rows", () => {
  it("pauses an idle live-edit preview after 15 minutes and a stuck boot after 5", async () => {
    const { decideEngineerPreviewReap } = await import("../../../../workers/functions/preview-reaper");
    const now = Date.parse("2026-09-29T12:00:00Z");
    const base = { id: "row1", e2b_sandbox_id: "sb1", status: "active", preview_run_id: "live-edit:run-9" };
    const idle = decideEngineerPreviewReap(
      { ...base, preview_status: "live", preview_last_viewed_at: "2026-09-29T11:44:00Z", preview_started_at: "2026-09-29T11:40:00Z", updated_at: "2026-09-29T11:44:00Z" } as never,
      now,
    );
    expect(idle.reap).toBe(true);
    const watched = decideEngineerPreviewReap(
      { ...base, preview_status: "live", preview_last_viewed_at: "2026-09-29T11:58:00Z", preview_started_at: "2026-09-29T11:40:00Z", updated_at: "2026-09-29T11:58:00Z" } as never,
      now,
    );
    expect(watched.reap).toBe(false);
    const stuck = decideEngineerPreviewReap(
      { ...base, preview_status: "starting", preview_started_at: "2026-09-29T11:54:00Z", updated_at: "2026-09-29T11:54:00Z" } as never,
      now,
    );
    expect(stuck.reap).toBe(true);
  });
});
