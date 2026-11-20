
import { describe, it, expect, vi, beforeEach } from "vitest";

const { connect, kill, betaPause, write, run, maybeSingle } = vi.hoisted(() => {
  const betaPause = vi.fn(async () => undefined);
  const write = vi.fn(async () => undefined);
  const run = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
  const connect = vi.fn(async () => ({ betaPause, files: { write }, commands: { run } }));
  const kill = vi.fn(async () => true);
  const maybeSingle = vi.fn(async () => ({ data: null as unknown, error: null as unknown }));
  return { connect, kill, betaPause, write, run, maybeSingle };
});
vi.mock("e2b", () => ({ Sandbox: { connect, kill } }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
    rpc: vi.fn(async () => ({ error: null })),
  }),
}));
vi.mock("@/services/logging/alert", () => ({ alert: vi.fn(async () => undefined) }));

import {
  __resetQuarantinedSandboxesForTests,
  execCommand,
  isSandboxQuarantined,
  quarantineSandboxBox,
  revokeSandboxGithubToken,
} from "../e2b-client";
import {
  isSandboxRowQuarantined,
  quarantineSandbox,
  sandboxScrubFailureReason,
  TOKEN_SCRUB_FAILED_ERROR,
} from "../lifecycle";

const handle = { row_id: "row-1", e2b_sandbox_id: "sbx-1" };

beforeEach(() => {
  __resetQuarantinedSandboxesForTests();
  for (const m of [connect, kill, betaPause, write, run, maybeSingle]) m.mockClear();
  betaPause.mockImplementation(async () => undefined);
  kill.mockImplementation(async () => true);
  write.mockImplementation(async () => undefined);
  run.mockImplementation(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
  process.env.E2B_API_KEY = "test-key";
});

describe("quarantineSandboxBox", () => {
  it("pauses the box and refuses every later connect from this process", async () => {
    await expect(quarantineSandboxBox("sbx-1")).resolves.toBe("paused");
    expect(betaPause).toHaveBeenCalledTimes(1);
    expect(isSandboxQuarantined("sbx-1")).toBe(true);
    connect.mockClear();
    await expect(execCommand("sbx-1", "true")).rejects.toThrow(/quarantined/);
    expect(connect).not.toHaveBeenCalled();
  });

  it("destroys the box when the pause fails", async () => {
    betaPause.mockRejectedValueOnce(new Error("pause 500"));
    await expect(quarantineSandboxBox("sbx-1")).resolves.toBe("destroyed");
    expect(kill).toHaveBeenCalledWith("sbx-1", expect.anything());
  });

  it("throws only when both the pause and the destroy fail", async () => {
    betaPause.mockRejectedValueOnce(new Error("pause 500"));
    kill.mockRejectedValueOnce(new Error("kill 500"));
    await expect(quarantineSandboxBox("sbx-1")).rejects.toThrow(/pause failed.*destroy failed/);
    expect(isSandboxQuarantined("sbx-1")).toBe(true);
  });

  it("destroyOnly kills the box without connecting (a connect would resume it)", async () => {
    await expect(quarantineSandboxBox("sbx-1", { destroyOnly: true })).resolves.toBe("destroyed");
    expect(connect).not.toHaveBeenCalled();
    expect(kill).toHaveBeenCalledWith("sbx-1", expect.anything());
    expect(isSandboxQuarantined("sbx-1")).toBe(true);
  });

  it("a second quarantine re-pauses even though connect() refuses the id", async () => {
    await quarantineSandboxBox("sbx-1");
    await quarantineSandboxBox("sbx-1");
    expect(betaPause).toHaveBeenCalledTimes(2);
  });
});

describe("quarantineSandbox", () => {
  const deps = () => ({
    box: vi.fn(async (_id: string, _o?: { destroyOnly?: boolean }) => "paused" as "paused" | "destroyed"),
    retireRow: vi.fn(async (_id: string, _err: string) => 1),
    alert: vi.fn(async (_i: unknown) => undefined),
    isQuarantined: vi.fn((_id: string) => false),
  });
  type Page = { code: string; tenant_id: string | null; msg: string; email?: { dedupeKey: string } };
  const pageOf = (d: ReturnType<typeof deps>, i = 0) => (d.alert.mock.calls[i] as unknown as [Page])[0];

  it("pauses, retires the row for THIS box (one CAS on the box id), and alerts", async () => {
    const d = deps();
    const out = await quarantineSandbox(handle, { source: "engineer-token-rearm", tenant_id: "t1", reason: "exit 3" }, d);
    expect(out).toBe("paused");
    expect(d.box).toHaveBeenCalledWith("sbx-1", {});
    expect(d.retireRow).toHaveBeenCalledWith("sbx-1", `${TOKEN_SCRUB_FAILED_ERROR}: engineer-token-rearm`);
    expect(d.alert).toHaveBeenCalledTimes(1);
    expect(pageOf(d).code).toBe("sandbox_token_scrub_failed");
    expect(pageOf(d).tenant_id).toBe("t1");
    expect(pageOf(d).msg).toContain("box paused");
    expect(pageOf(d).email).toBeUndefined();
  });

  it("a box another worker already retired is killed without the pause path, and not paged again", async () => {
    const d = deps();
    d.box.mockResolvedValueOnce("destroyed");
    await expect(quarantineSandbox(handle, { source: "s", alreadyRetired: true }, d)).resolves.toBe("destroyed");
    expect(d.box).toHaveBeenCalledWith("sbx-1", { destroyOnly: true });
    expect(d.alert).not.toHaveBeenCalled();
    d.box.mockRejectedValueOnce(new Error("kill 500"));
    await expect(quarantineSandbox(handle, { source: "s", alreadyRetired: true }, d)).resolves.toBe("failed");
    expect(d.alert).not.toHaveBeenCalled();
  });

  it("reports when no row points at the box any more (a replacement is never retired)", async () => {
    const d = deps();
    d.retireRow.mockResolvedValueOnce(0);
    await quarantineSandbox(handle, { source: "s" }, d);
    expect(pageOf(d).msg).toContain("no row points at this box");
  });

  it("a row that cannot be retired gets its paused box destroyed instead", async () => {
    const d = deps();
    d.retireRow.mockRejectedValueOnce(new Error("db down"));
    d.box.mockResolvedValueOnce("paused").mockResolvedValueOnce("destroyed");
    await expect(quarantineSandbox(handle, { source: "s" }, d)).resolves.toBe("destroyed");
    expect(d.box).toHaveBeenLastCalledWith("sbx-1", { destroyOnly: true });
    expect(pageOf(d).msg).toContain("row not retired");
  });

  it("never throws; a box that could be neither paused nor destroyed pages by email", async () => {
    const d = deps();
    d.box.mockRejectedValueOnce(new Error("pause and destroy failed"));
    await expect(quarantineSandbox(handle, { source: "s" }, d)).resolves.toBe("failed");
    expect(pageOf(d).code).toBe("sandbox_token_scrub_quarantine_failed");
    expect(pageOf(d).email).toEqual({ dedupeKey: "sandbox_token_scrub:sbx-1" });
  });

  it("a repeat for a box this process already quarantined never reconnects or pages, only re-retires the row", async () => {
    const d = deps();
    d.isQuarantined.mockReturnValue(true);
    await expect(quarantineSandbox(handle, { source: "run-agent-teardown" }, d)).resolves.toBe("already");
    expect(d.box).not.toHaveBeenCalled();
    expect(d.retireRow).toHaveBeenCalledTimes(1);
    expect(d.alert).not.toHaveBeenCalled();
  });

  it("a repeat whose row cannot be retired kills the box", async () => {
    const d = deps();
    d.isQuarantined.mockReturnValue(true);
    d.retireRow.mockRejectedValueOnce(new Error("db down"));
    d.box.mockResolvedValueOnce("destroyed");
    await expect(quarantineSandbox(handle, { source: "s" }, d)).resolves.toBe("destroyed");
    expect(d.box).toHaveBeenCalledWith("sbx-1", { destroyOnly: true });
    expect(d.alert).not.toHaveBeenCalled();
  });
});

describe("sandboxScrubFailureReason (run-agent teardown)", () => {
  it("a pre-model revoke failure is reported without any lookup", async () => {
    const rowQuarantined = vi.fn(async () => false);
    await expect(sandboxScrubFailureReason(handle, true, { rowQuarantined })).resolves.toEqual({
      reason: expect.stringMatching(/pre-model/),
      retiredElsewhere: false,
    });
    expect(rowQuarantined).not.toHaveBeenCalled();
  });

  it("a post-run quarantine in this process is seen", async () => {
    await expect(
      sandboxScrubFailureReason(handle, false, { isQuarantined: () => true, rowQuarantined: async () => false }),
    ).resolves.toEqual({ reason: expect.stringMatching(/during the run/), retiredElsewhere: false });
  });

  it("a post-run quarantine on another worker is seen through the retired row", async () => {
    await expect(
      sandboxScrubFailureReason(handle, false, { isQuarantined: () => false, rowQuarantined: async () => true }),
    ).resolves.toEqual({ reason: expect.stringMatching(/row retired/), retiredElsewhere: true });
  });

  it("a clean run reports nothing", async () => {
    await expect(
      sandboxScrubFailureReason(handle, false, { isQuarantined: () => false, rowQuarantined: async () => false }),
    ).resolves.toBeNull();
  });
});

describe("isSandboxRowQuarantined", () => {
  it("true only for a failed row of THIS box retired by a scrub failure", async () => {
    maybeSingle.mockResolvedValueOnce({
      data: { status: "failed", e2b_sandbox_id: "sbx-1", last_error: `${TOKEN_SCRUB_FAILED_ERROR}: x` },
      error: null,
    });
    await expect(isSandboxRowQuarantined(handle)).resolves.toBe(true);
    maybeSingle.mockResolvedValueOnce({
      data: { status: "failed", e2b_sandbox_id: "sbx-NEW", last_error: `${TOKEN_SCRUB_FAILED_ERROR}: x` },
      error: null,
    });
    await expect(isSandboxRowQuarantined(handle)).resolves.toBe(false);
    maybeSingle.mockResolvedValueOnce({
      data: { status: "failed", e2b_sandbox_id: "sbx-1", last_error: "resume failed" },
      error: null,
    });
    await expect(isSandboxRowQuarantined(handle)).resolves.toBe(false);
  });

  it("fails closed when the row cannot be read", async () => {
    maybeSingle.mockResolvedValueOnce({ data: null, error: { message: "timeout" } });
    await expect(isSandboxRowQuarantined(handle)).resolves.toBe(true);
  });
});

describe("revokeSandboxGithubToken", () => {
  it("still runs the git scrub when the env rewrite fails, then throws", async () => {
    write.mockRejectedValueOnce(new Error("write failed"));
    await expect(revokeSandboxGithubToken("sbx-2")).rejects.toThrow(/env rewrite failed/);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("a failed git scrub wins over the env error (the token is still in the remote)", async () => {
    write.mockRejectedValueOnce(new Error("write failed"));
    run.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 3 });
    await expect(revokeSandboxGithubToken("sbx-2")).rejects.toThrow(/scrub failed \(exit 3\)/);
  });
});
