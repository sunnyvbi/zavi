
import { describe, it, expect, vi, beforeEach } from "vitest";

const { pauseSandboxMock, quarantineBoxMock, maybeSingleMock, rpcMock } = vi.hoisted(() => ({
  pauseSandboxMock: vi.fn(async () => undefined),
  quarantineBoxMock: vi.fn(async () => "paused" as const),
  maybeSingleMock: vi.fn(),
  rpcMock: vi.fn(async () => ({ error: null })),
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: maybeSingleMock }),
      }),
    }),
    rpc: rpcMock,
  }),
}));

vi.mock("@/services/sandbox/e2b-client", async () => {
  const actual = await vi.importActual<typeof import("@/services/sandbox/e2b-client")>(
    "@/services/sandbox/e2b-client",
  );
  return { ...actual, pauseSandbox: pauseSandboxMock, quarantineSandboxBox: quarantineBoxMock };
});

vi.mock("@/services/logging/alert", () => ({ alert: vi.fn(async () => undefined) }));

import { pauseAndMarkPaused } from "../lifecycle";

const handle = { row_id: "row-1", e2b_sandbox_id: "sbx-1", tenant_id: "t1", repo_full_name: "o/r" };

describe("pauseAndMarkPaused — keep-warm for a live preview", () => {
  beforeEach(() => {
    pauseSandboxMock.mockClear();
    rpcMock.mockClear();
    maybeSingleMock.mockReset();
  });

  it("SKIPS pause + mark_paused when preview_status='live' (keep-warm)", async () => {
    maybeSingleMock.mockResolvedValue({ data: { preview_status: "live" }, error: null });
    await pauseAndMarkPaused(handle);
    expect(pauseSandboxMock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("force quarantines a live preview's box (#3474): pause, retire the row, never keep warm", async () => {
    maybeSingleMock.mockResolvedValue({ data: { preview_status: "live" }, error: null });
    await pauseAndMarkPaused(handle, { force: true });
    expect(maybeSingleMock).not.toHaveBeenCalled();
    expect(quarantineBoxMock).toHaveBeenCalledWith("sbx-1", {});
    expect(rpcMock).toHaveBeenCalledWith("retire_sandbox_box", {
      p_e2b_sandbox_id: "sbx-1",
      p_error: "github_token_scrub_failed: forced-pause",
    });
    expect(rpcMock).not.toHaveBeenCalledWith("mark_sandbox_paused", expect.anything());
  });

  it("pauses normally when there is no live preview (preview_status null)", async () => {
    maybeSingleMock.mockResolvedValue({ data: { preview_status: null }, error: null });
    await pauseAndMarkPaused(handle);
    expect(pauseSandboxMock).toHaveBeenCalledWith("sbx-1");
    expect(rpcMock).toHaveBeenCalledWith("mark_sandbox_paused", { p_id: "row-1" });
  });

  it("pauses normally for a non-live preview state (e.g. 'swapped')", async () => {
    maybeSingleMock.mockResolvedValue({ data: { preview_status: "swapped" }, error: null });
    await pauseAndMarkPaused(handle);
    expect(pauseSandboxMock).toHaveBeenCalledOnce();
  });

  it("falls through to pause (safe default) if the preview probe throws", async () => {
    maybeSingleMock.mockRejectedValue(new Error("probe failed"));
    await pauseAndMarkPaused(handle);
    expect(pauseSandboxMock).toHaveBeenCalledWith("sbx-1");
  });

  it("no-op on a null handle", async () => {
    await pauseAndMarkPaused(null);
    expect(maybeSingleMock).not.toHaveBeenCalled();
    expect(pauseSandboxMock).not.toHaveBeenCalled();
  });
});
