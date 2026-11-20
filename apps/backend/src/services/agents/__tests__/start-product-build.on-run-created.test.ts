import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/settings")>();
  return { ...actual, getBoolSetting: vi.fn(async () => false) };
});

import { startProductBuild, type StartProductBuildDeps } from "@/services/agents/start-product-build";

const BASE = { tenant_id: "t1", company_name: "Lucky Paws", idea: "A dog walking site for Austin", started_by_user_id: "u1", site_name: "Lucky Paws" };

function deps(): StartProductBuildDeps & { startFastBuild: ReturnType<typeof vi.fn>; updateConductorRunStatus: ReturnType<typeof vi.fn> } {
  return {
    checkSitePrereqs: vi.fn().mockResolvedValue({ ok: true }),
    tryAcquireBuildSlot: vi.fn().mockResolvedValue("cr_1"),
    updateConductorRunStatus: vi.fn().mockResolvedValue(undefined),
    resolveDailyCap: vi.fn().mockResolvedValue(0),
    assertBuildCredits: vi.fn().mockResolvedValue(undefined),
    resolveOwnerEmail: vi.fn().mockResolvedValue(null),
    resolveWorkspaceName: vi.fn().mockResolvedValue("Lucky Paws"),
    resolveSiteName: vi.fn(async () => "Lucky Paws"),
    startFastBuild: vi.fn(async () => ({
      kind: "started" as const,
      result: { conductor_run_id: "cr_1", provision: { provisioned: [], connected: [], pending_creds: [], failed: [], context: {} }, target: {} },
    })),
  } as never;
}

describe("startProductBuild onRunCreated", () => {
  it("is called with the new run id before the build starts", async () => {
    const d = deps();
    const order: string[] = [];
    d.startFastBuild.mockImplementation(async () => {
      order.push("build");
      return { kind: "started", result: { conductor_run_id: "cr_1", provision: { provisioned: [], connected: [], pending_creds: [], failed: [], context: {} }, target: {} } };
    });
    await startProductBuild({ ...BASE, onRunCreated: async (id) => { order.push(`recorded:${id}`); } }, d);
    expect(order).toEqual(["recorded:cr_1", "build"]);
  });

  it("a throw fails the run and releases the slot; nothing is built", async () => {
    const d = deps();
    await expect(
      startProductBuild({ ...BASE, onRunCreated: async () => { throw new Error("claim lost"); } }, d),
    ).rejects.toThrow("claim lost");
    expect(d.startFastBuild).not.toHaveBeenCalled();
    expect(d.updateConductorRunStatus).toHaveBeenCalledWith(expect.objectContaining({ conductor_run_id: "cr_1", status: "failed" }));
  });
});
