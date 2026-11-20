import { describe, it, expect, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  serviceClient: vi.fn(),
  seedProvisionedRepo: vi.fn(),
  giveNewAppFreshDatabase: vi.fn(),
  provisionCompany: vi.fn(),
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
}));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClient }));
vi.mock("@/services/provisioning/seed-provisioned-repo", () => ({ seedProvisionedRepo: mocks.seedProvisionedRepo }));
vi.mock("@/services/provisioning/fresh-app-database", () => ({ giveNewAppFreshDatabase: mocks.giveNewAppFreshDatabase }));
vi.mock("@/services/provisioning/provision-company", () => ({ provisionCompany: mocks.provisionCompany }));

import { continueBuild } from "../continue-build";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

const failedRun = {
  id: "run-live",
  tenant_id: "t1",
  kind: "build_app",
  status: "failed",
  created_at: iso(NOW - 3_600_000),
  updated_at: iso(NOW - 60_000),
  paused_at: null,
  failure_class: "repair_exhausted",
  spend_usd: 2,
  max_usd: 25,
  goal_graph: [
    { id: "provision", status: "done", target_agent_slug: "company-founder", payload: { stage: "provision", dry_run: false, site_id: "eeeeeeee-0000-4000-8000-00000000000e" }, estimate_usd: 0, child_run_id: null },
    { id: "build", status: "done", target_agent_slug: "engineer", payload: { stage: "build" }, estimate_usd: 3, child_run_id: "c2" },
    { id: "qa", status: "failed", target_agent_slug: "qa", payload: { stage: "qa" }, estimate_usd: 0.5, child_run_id: "c3", failure_class: "repair_exhausted" },
  ],
};

function client() {
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      mocks.rpcCalls.push({ fn, args });
      return { data: "resumed", error: null };
    },
    from: () => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "neq", "gt"]) q[m] = () => q;
      q.maybeSingle = async () => ({ data: failedRun, error: null });
      q.then = (res: (v: { data: unknown; error: null }) => unknown) => res({ data: [], error: null });
      return q;
    },
  };
}

describe("Try again on the live site's own failed build (same run)", () => {
  it("resumes the same run without re-provisioning, re-seeding over the live app or swapping its database", async () => {
    mocks.serviceClient.mockReturnValue(client());
    expect(await continueBuild("t1", "run-live", NOW)).toEqual({ ok: true, run_id: "run-live" });
    expect(mocks.rpcCalls.map((c) => c.fn)).toEqual(["continue_paused_build_with_site"]);
    const graph = mocks.rpcCalls[0].args.p_goal_graph as Array<{ id: string; status: string }>;
    expect(graph.find((n) => n.id === "provision")?.status).toBe("done");
    expect(graph.find((n) => n.id === "qa")?.status).toBe("pending");
    expect(mocks.seedProvisionedRepo).not.toHaveBeenCalled();
    expect(mocks.giveNewAppFreshDatabase).not.toHaveBeenCalled();
    expect(mocks.provisionCompany).not.toHaveBeenCalled();
  });
});
