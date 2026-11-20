
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

const execCommand = vi.fn();
const reapOrphanWorktrees = vi.fn();

vi.mock("@/services/sandbox/e2b-client", () => ({
  execCommand: (...a: unknown[]) => execCommand(...a),
}));
vi.mock("@/services/sandbox/run-worktree", () => ({
  reapOrphanWorktrees: (...a: unknown[]) => reapOrphanWorktrees(...a),
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));

import {
  diskHygieneMode,
  gcSandboxDisk,
  probeFreeKb,
  requiredFreeKb,
  templateReconcileEnabled,
} from "../disk-hygiene";

const ENV = { ...process.env };
beforeEach(() => {
  execCommand.mockReset();
  reapOrphanWorktrees.mockReset();
  reapOrphanWorktrees.mockResolvedValue({ removed: [] });
});
afterEach(() => {
  process.env = { ...ENV };
});

const ok = (stdout: string) => ({ exit_code: 0, stdout, stderr: "" });

describe("requiredFreeKb — the free-space bar", () => {
  it("NULL measurement uses the 2GiB FLOOR, does NOT fail open", () => {
    expect(requiredFreeKb(null)).toBe(2 * 1024 * 1024);
    expect(requiredFreeKb(undefined)).toBe(2 * 1024 * 1024);
    expect(requiredFreeKb(0)).toBe(2 * 1024 * 1024);
    expect(requiredFreeKb(-5)).toBe(2 * 1024 * 1024);
  });

  it("small repo → still the floor (the incident: a 122MB repo on a full 12GB box)", () => {
    expect(requiredFreeKb(125_500)).toBe(2 * 1024 * 1024);
  });

  it("large repo → tree * 1.1 + 512MiB margin, above the floor", () => {
    const treeKb = 2_500_000;
    expect(requiredFreeKb(treeKb)).toBe(Math.ceil(treeKb * 1.1) + 512 * 1024);
  });
});

describe("probeFreeKb — FAIL OPEN (this runs on every agent's hot path)", () => {
  it("parses df output", async () => {
    execCommand.mockResolvedValue(ok("  1932000\n"));
    expect(await probeFreeKb("sbx")).toBe(1_932_000);
  });

  it("exec THROWS (unreachable sandbox / timeout) → null, never 0", async () => {
    execCommand.mockRejectedValue(new Error("sandbox unreachable"));
    expect(await probeFreeKb("sbx")).toBeNull();
  });

  it("non-zero exit or garbage output → null (not 0)", async () => {
    execCommand.mockResolvedValue({ exit_code: 1, stdout: "", stderr: "boom" });
    expect(await probeFreeKb("sbx")).toBeNull();
    execCommand.mockResolvedValue(ok("not-a-number"));
    expect(await probeFreeKb("sbx")).toBeNull();
  });
});

describe("gcSandboxDisk", () => {
  it("reclaims and reports freed space", async () => {
    execCommand
      .mockResolvedValueOnce(ok("300000"))
      .mockResolvedValueOnce(ok(""))
      .mockResolvedValueOnce(ok(""))
      .mockResolvedValueOnce(ok("6500000"));
    reapOrphanWorktrees.mockResolvedValue({ removed: ["/home/user/wt-abc"] });
    const r = await gcSandboxDisk({ sandbox_id: "sbx", tenant_id: "t", keepRunIds: ["run-1"] });
    expect(r.freedKb).toBe(6_200_000);
    expect(r.steps).toContain("yarn");
  });

  it("a GC step that FAILS does not throw — a failed cleanup must not kill the run", async () => {
    execCommand
      .mockResolvedValueOnce(ok("300000"))
      .mockRejectedValueOnce(new Error("yarn exploded"))
      .mockRejectedValueOnce(new Error("npm exploded"))
      .mockResolvedValueOnce(ok("300000"));
    await expect(
      gcSandboxDisk({ sandbox_id: "sbx", tenant_id: "t" }),
    ).resolves.toMatchObject({ freedKb: 0 });
  });

  it("keeps the CURRENT run's worktree when reaping", async () => {
    execCommand.mockResolvedValue(ok("1000"));
    await gcSandboxDisk({ sandbox_id: "sbx", tenant_id: "t", keepRunIds: ["run-live"] });
    expect(reapOrphanWorktrees).toHaveBeenCalledWith({
      sandbox_id: "sbx",
      keepRunIds: ["run-live"],
    });
  });
});

describe("rollout switches — DEFAULT-ON at gc_only", () => {
  it("unset → gc_only (default-ON: reclaim, never destroy)", () => {
    delete process.env.SANDBOX_DISK_HYGIENE;
    expect(diskHygieneMode()).toBe("gc_only");
  });

  it("unrecognised value → gc_only, never a destructive mode (fail safe, not fail dead)", () => {
    process.env.SANDBOX_DISK_HYGIENE = "yes-please";
    expect(diskHygieneMode()).toBe("gc_only");
    process.env.SANDBOX_DISK_HYGIENE = "";
    expect(diskHygieneMode()).toBe("gc_only");
  });

  it("off is an explicit kill switch (and the ONLY way to get off)", () => {
    process.env.SANDBOX_DISK_HYGIENE = "off";
    expect(diskHygieneMode()).toBe("off");
  });

  it("recognises the staged modes", () => {
    for (const m of ["probe_only", "gc_only", "recreate"] as const) {
      process.env.SANDBOX_DISK_HYGIENE = m;
      expect(diskHygieneMode()).toBe(m);
    }
  });

  it("template reconcile is an INDEPENDENT switch (a disk rollback must not revert the OOM fix)", () => {
    delete process.env.SANDBOX_TEMPLATE_RECONCILE;
    process.env.SANDBOX_DISK_HYGIENE = "recreate";
    expect(templateReconcileEnabled()).toBe(false);
    process.env.SANDBOX_TEMPLATE_RECONCILE = "1";
    expect(templateReconcileEnabled()).toBe(true);
  });
});
