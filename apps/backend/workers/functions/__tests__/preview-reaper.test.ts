
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/services/settings", () => ({ getBoolSetting: vi.fn() }));
import { getBoolSetting } from "@/services/settings";
import { engineerPreviewGloballyEnabled } from "@/services/sandbox/engineer-preview";

import {
  decideEngineerPreviewReap,
  PREVIEW_HARD_CEILING_MIN,
  PREVIEW_STARTING_TTL_MIN,
} from "../preview-reaper";
import { PREVIEW_IDLE_MIN } from "../infra-reaper";

const mockedGetBool = vi.mocked(getBoolSetting);

const NOW = Date.parse("2026-06-30T12:00:00Z");
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

function row(over: Partial<Parameters<typeof decideEngineerPreviewReap>[0]> = {}) {
  return {
    id: "row-1",
    tenant_id: "ten-A",
    repo_full_name: "owner/repo",
    e2b_sandbox_id: "sb-1",
    status: "active",
    updated_at: minsAgo(1),
    preview_status: "live" as string | null,
    preview_last_viewed_at: minsAgo(1),
    preview_started_at: minsAgo(1),
    preview_run_id: "run-1" as string | null,
    ...over,
  };
}

describe("decideEngineerPreviewReap", () => {
  it("live + idle > 15min → reap (idle TTL, reused helper)", () => {
    const d = decideEngineerPreviewReap(
      row({ preview_last_viewed_at: minsAgo(PREVIEW_IDLE_MIN + 1) }),
      NOW,
    );
    expect(d.reap).toBe(true);
    expect(d.reason).toMatch(/idle/);
  });

  it("live + recently viewed → NOT reaped", () => {
    const d = decideEngineerPreviewReap(row({ preview_last_viewed_at: minsAgo(2) }), NOW);
    expect(d.reap).toBe(false);
    expect(d.reason).toBe("live_within_limits");
  });

  it("live + recently viewed BUT started > 60min → reap (hard ceiling)", () => {
    const d = decideEngineerPreviewReap(
      row({
        preview_last_viewed_at: minsAgo(1),
        preview_started_at: minsAgo(PREVIEW_HARD_CEILING_MIN + 1),
      }),
      NOW,
    );
    expect(d.reap).toBe(true);
    expect(d.reason).toMatch(/hard_ceiling/);
  });

  it("stuck 'starting' > 5min → reap", () => {
    const d = decideEngineerPreviewReap(
      row({ preview_status: "starting", preview_started_at: minsAgo(PREVIEW_STARTING_TTL_MIN + 1) }),
      NOW,
    );
    expect(d.reap).toBe(true);
    expect(d.reason).toMatch(/stuck_starting/);
  });

  it("'starting' but recent → NOT reaped", () => {
    const d = decideEngineerPreviewReap(
      row({ preview_status: "starting", preview_started_at: minsAgo(1) }),
      NOW,
    );
    expect(d.reap).toBe(false);
  });

  it("product-builder preview (preview_run_id NULL) → never reaped here", () => {
    const d = decideEngineerPreviewReap(
      row({ preview_run_id: null, preview_last_viewed_at: minsAgo(999) }),
      NOW,
    );
    expect(d.reap).toBe(false);
    expect(d.reason).toBe("not_engineer_preview");
  });

  it("non-live/non-starting status → not reaped", () => {
    const d = decideEngineerPreviewReap(row({ preview_status: "swapped" }), NOW);
    expect(d.reap).toBe(false);
  });
});

describe("preview-reaper global gate (dryRun source)", () => {
  beforeEach(() => {
    mockedGetBool.mockReset();
  });

  it("global setting ON → globally enabled (reaper runs live)", async () => {
    mockedGetBool.mockResolvedValue(true);
    expect(await engineerPreviewGloballyEnabled()).toBe(true);
    expect(mockedGetBool).toHaveBeenCalledWith("engineer_live_preview_enabled");
    expect((mockedGetBool.mock.calls[0] as unknown[]).length).toBe(1);
  });

  it("global setting OFF → globally disabled (reaper stays dryRun, no-op)", async () => {
    mockedGetBool.mockResolvedValue(false);
    expect(await engineerPreviewGloballyEnabled()).toBe(false);
  });

  it("settings read throws → fail-closed (dryRun)", async () => {
    mockedGetBool.mockRejectedValue(new Error("settings store blip"));
    expect(await engineerPreviewGloballyEnabled()).toBe(false);
  });
});
