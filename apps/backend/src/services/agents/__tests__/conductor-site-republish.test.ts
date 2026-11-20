
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@/services/settings", () => ({ getNumberSetting: vi.fn(async () => 1), getBoolSetting: vi.fn(async () => false) }));

import { conductorTick, type ConductorNode, type ConductorRow, type ConductorTickDeps } from "../conductor";
import { siteRepublishGraph } from "../refine-product";
import { makeSiteDeployDeps } from "@/services/sites/site-deploy-deps";
import { setSiteWiring, resetSiteWiring } from "@/services/sites/wiring";
import { nodePayloadCheckpoints } from "@/services/sites/deploy-checkpoints";
import type { SiteDeployHandler, SiteDeployOutcome } from "@/services/sites/contract";
import { fakeSiteStore, siteRow, T1, T2 } from "@/services/sites/__tests__/fake-site-store";

const SA = "aaaaaaaa-0000-4000-8000-000000000001";
const SB = "bbbbbbbb-0000-4000-8000-000000000002";
const REVERT = "abcdef1234567";

afterEach(() => resetSiteWiring());

function harness(outcomes: SiteDeployOutcome[]) {
  const { store } = fakeSiteStore([
    siteRow({ id: SA, label: "alpha", root_conductor_run_id: "run-a", status: "live", live_sha: "1111111", live_deploy_id: "d1" }),
    siteRow({ id: SB, label: "beta", root_conductor_run_id: "run-b", status: "live", live_sha: "2222222", live_deploy_id: "d2" }),
    siteRow({ id: SA.replace("a", "c"), tenant_id: T2, label: "gamma", status: "live" }),
  ]);
  const site = siteRow({ id: SA, label: "alpha", root_conductor_run_id: "run-a", status: "live" });
  let graph: ConductorNode[] = siteRepublishGraph(site, REVERT);
  const statuses: string[] = [];
  const calls: Array<Parameters<SiteDeployHandler["step"]>[0]> = [];
  const cp = nodePayloadCheckpoints<{ n: number }>();
  const handler: SiteDeployHandler = {
    step: vi.fn(async (i): Promise<SiteDeployOutcome> => {
      calls.push(i);
      const prev = await cp.get("k");
      await cp.set("k", { n: (prev?.n ?? 0) + 1 });
      return outcomes.shift() ?? { kind: "waiting" };
    }),
  };
  setSiteWiring({ deployHandler: handler });
  const headOf = vi.fn(async (_github_full_name: string) => ({ sha: "head000" }) as { sha: string } | { error: string });
  const hostingStatus = vi.fn(async () => "ready" as const);
  const dispatch = vi.fn(async () => ({ ok: true as const, child_run_id: "x" }));
  const staticPlan = vi.fn();
  const row = (): ConductorRow => ({
    id: "cond-undo", tenant_id: T1, objective: "[refine] undo", status: "active", max_usd: 2, spend_usd: 0, kind: "build_app", goal_graph: graph,
  });
  const deps: ConductorTickDeps = {
    load: async () => row(),
    childStatus: async () => "success",
    consumeBudget: vi.fn(async () => "charged" as const),
    dispatch,
    saveGraph: async (_id, g) => { graph = JSON.parse(JSON.stringify(g)); },
    setStatus: async (_id, s) => { statuses.push(s); },
    hostingStatus,
    staticPublish: { plan: staticPlan, request: vi.fn(), rollback: vi.fn() },
    siteDeploy: makeSiteDeployDeps({ store, headOf, org: () => (site.github_full_name ?? "").split("/")[0] ?? "" }),
  };
  return { deps, store, calls, statuses, hostingStatus, dispatch, staticPlan, headOf, node: () => graph[0] };
}

describe("site undo / republish through the conductor (review S5 F1)", () => {
  it("the republish node goes to the site deploy handler at the pinned revert sha, not the hosting gate", async () => {
    const h = harness([{ kind: "waiting" }, { kind: "live", url: "https://alpha.zaviagent.com", verified_at: "2026-10-01T00:00:00.000Z" }]);

    expect(await conductorTick("cond-undo", h.deps)).toEqual({ action: "waiting", in_flight: 0 });
    expect(h.calls[0]).toEqual({ tenant_id: T1, conductor_run_id: "cond-undo", site_id: SA, sha: REVERT, attempt: 1, brief: "[refine] undo" });
    expect(h.node().payload.site_checkpoint).toEqual({ k: { n: 1 } });

    expect(await conductorTick("cond-undo", h.deps)).toEqual({ action: "completed", final: "done" });
    expect(h.node().payload.site_checkpoint).toEqual({ k: { n: 2 } });
    expect(h.node()).toMatchObject({ status: "done", hosting_verified_at: "2026-10-01T00:00:00.000Z" });
    expect(h.statuses).toEqual(["done"]);

    expect(h.hostingStatus).not.toHaveBeenCalled();
    expect(h.staticPlan).not.toHaveBeenCalled();
    expect(h.headOf).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.calls.every((c) => c.site_id === SA && c.tenant_id === T1)).toBe(true);
    expect((await h.store.get(T1, SB))!.desired_sha).toBeNull();
  });

  it("a handler 'failed' fails the undo run plainly (never reported live)", async () => {
    const h = harness([{ kind: "failed", reason: "the site did not pass its checks" }]);
    const r = await conductorTick("cond-undo", h.deps);
    expect(r.action).toBe("completed");
    expect(h.node()).toMatchObject({ status: "failed", error: "the site did not pass its checks" });
    expect(h.hostingStatus).not.toHaveBeenCalled();
    expect((await h.store.get(T1, SA))!.status).toBe("live");
  });
});
