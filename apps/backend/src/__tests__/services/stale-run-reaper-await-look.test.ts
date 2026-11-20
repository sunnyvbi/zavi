import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => {
    throw new Error("serviceClient() must not be called when svc is injected");
  },
}));

import { reapStaleRuns } from "@/services/agents/stale-run-reaper";
import { buildSiteGoalGraph } from "@/services/agents/product-pipeline";

const NOW = Date.parse("2026-10-07T12:00:00.000Z");

type Resp = { data: unknown; error: { message: string } | null };
type Trace = { table: string; select: string | null; update: unknown; eq: Array<[string, unknown]>; in: [string, unknown[]] | null; contains?: [string, unknown] };

function makeSvc(router: (t: Trace) => Resp) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const from = (table: string) => {
    const t: Trace = { table, select: null, update: null, eq: [], in: null };
    const b: Record<string, unknown> = {
      select: (c: string) => ((t.select = c), b),
      update: (p: unknown) => ((t.update = p), b),
      eq: (c: string, v: unknown) => (t.eq.push([c, v]), b),
      lt: () => b,
      is: () => b,
      in: (c: string, v: unknown[]) => ((t.in = [c, v]), b),
      filter: (c: string, op: string, v: unknown) => (op === "cs" ? (t.contains = [c, v]) : null, b),
      limit: () => b,
      single: () => b,
      maybeSingle: () => b,
      then: (resolve: (r: Resp) => void) => resolve(router(t)),
    };
    return b;
  };
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args });
    if (fn === "expire_parked_look_runs") return { data: 1, error: null };
    return { data: { ok: true, cancelled: true, prior_status: "active", stopped_children: 0 }, error: null };
  });
  return { svc: { from, rpc } as never, rpcCalls };
}

function siteGraph(awaitLook: boolean, buildStatus = "pending") {
  return buildSiteGoalGraph(
    { tenant_id: "t1", company_name: "Acme", idea: "x", max_usd: 5 },
    {
      site_id: "site-1",
      target: { github_full_name: "o/r", repo_url: "https://github.com/o/r", default_branch: "main" },
      seed_sha: "a".repeat(40),
      publish_on_request: false,
      await_look: awaitLook,
    },
  ).map((n) => (n.payload.stage === "build" ? { ...n, status: buildStatus } : n));
}

describe("stale-run reaper and builds parked on the look pick", () => {
  it("never reaps a parked build on staleness, ends expired parked builds through one ordered database sweep, and still cancels a stuck one", async () => {
    const { svc, rpcCalls } = makeSvc((t) => {
      if (t.table === "conductor_runs" && t.update === null && t.eq.some(([c, v]) => c === "status" && v === "active")) {
        return {
          data: [
            { id: "parked", tenant_id: "t1", goal_graph: siteGraph(true) },
            { id: "stuck", tenant_id: "t1", goal_graph: siteGraph(false) },
            { id: "released", tenant_id: "t1", goal_graph: siteGraph(false, "dispatched") },
          ],
          error: null,
        };
      }
      return { data: [], error: null };
    });
    const res = await reapStaleRuns(svc, undefined, NOW);
    const cancelled = rpcCalls.filter((c) => c.fn === "cancel_conductor_run").map((c) => c.args.p_conductor_run_id);
    expect(cancelled).toEqual(["stuck", "released"]);
    expect(rpcCalls.filter((c) => c.fn === "expire_parked_look_runs").map((c) => c.args)).toEqual([{ p_expiry_seconds: 1800, p_limit: 200 }]);
    expect(res.conductor_active_reaped).toBe(3);
  });
});
