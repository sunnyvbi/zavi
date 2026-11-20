
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ rows: [] as Array<{ id: string }>, filters: [] as string[], patch: null as unknown }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      expect(table).toBe("conductor_runs");
      const q: Record<string, unknown> = {};
      q.update = (p: unknown) => { h.patch = p; return q; };
      q.eq = (k: string, v: unknown) => { h.filters.push(`${k}=${String(v)}`); return q; };
      q.select = async () => ({ data: h.rows, error: null });
      return q;
    },
  }),
}));

import { realStartProductBuildDeps, RunNoLongerProvisioning } from "@/services/agents/start-product-build";

beforeEach(() => {
  h.rows = [];
  h.filters = [];
  h.patch = null;
});

describe("updateConductorRunStatus (real)", () => {
  it("only writes a run that is still 'provisioning'", async () => {
    h.rows = [{ id: "cr_1" }];
    await realStartProductBuildDeps.updateConductorRunStatus({ conductor_run_id: "cr_1", status: "active", goal_graph: [] });
    expect(h.filters).toEqual(["id=cr_1", "status=provisioning"]);
  });

  it("an activation of a run that already ended throws RunNoLongerProvisioning (never resurrects it)", async () => {
    await expect(
      realStartProductBuildDeps.updateConductorRunStatus({ conductor_run_id: "cr_1", status: "active", goal_graph: [] }),
    ).rejects.toBeInstanceOf(RunNoLongerProvisioning);
  });

  it("a failure write on a run that already ended is skipped, never relabels a cancellation", async () => {
    await expect(
      realStartProductBuildDeps.updateConductorRunStatus({ conductor_run_id: "cr_1", status: "failed", failure_class: "provision_failed" }),
    ).resolves.toBeUndefined();
  });
});
