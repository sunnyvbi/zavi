import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ serviceClient: vi.fn() }));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClient }));

import { continueBuild, resumeGraph, expireStalePausedBuilds, resumeStrandedSiteRepublishes, CONTINUE_WINDOW_MS, STRANDED_SITE_REPUBLISH_MS } from "../continue-build";
import type { ConductorNode } from "../conductor";

const NOW = Date.parse("2026-09-22T20:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

const DEFAULT_SITE = "dddddddd-0000-4000-8000-00000000000d";
const onDefaultSite = (nodes: ConductorNode[]): ConductorNode[] =>
  nodes.map((n) => ({ ...n, payload: { site_id: DEFAULT_SITE, ...n.payload } }));
const graph = (): ConductorNode[] => onDefaultSite([
  { id: "scaffold", status: "done", target_agent_slug: "engineer", payload: { stage: "scaffold" }, estimate_usd: 1, child_run_id: "c1",
    checkpoint: { kind: "pushed", commit_sha: "aaa", verified_at: iso(NOW) } },
  { id: "build", status: "done", target_agent_slug: "engineer", payload: { stage: "build" }, estimate_usd: 3, child_run_id: "c2" },
  { id: "qa", status: "failed", target_agent_slug: "qa", payload: { stage: "qa" }, estimate_usd: 0.5, child_run_id: "c3",
    error: "qa failed", failure_class: "repair_exhausted", repair_attempts: 3 },
  { id: "deploy", status: "failed", target_agent_slug: "", payload: { stage: "deploy", deploy_enqueued_at: NOW - 999 }, estimate_usd: 0, child_run_id: null,
    error: "Deploy did not reach a live serving state.", failure_class: "deploy_failed" },
]);

type Row = Record<string, unknown>;
function client(opts: {
  row: Row | null;
  siblings?: Row[];
  flipped?: Row[];
  updateSpy?: (patch: unknown, filters: string[]) => void;
  rpcResult?: string;
  rpcSpy?: (fn: string, args: Record<string, unknown>) => void;
}) {
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      opts.rpcSpy?.(fn, args);
      return { data: opts.rpcResult ?? "resumed", error: null };
    },
    from: (table: string) => {
      expect(table).toBe("conductor_runs");
      const filters: string[] = [];
      let patch: unknown = null;
      let mode: "select" | "update" = "select";
      const q: Record<string, unknown> = {};
      q.select = () => q;
      for (const m of ["eq", "neq", "lt", "gt"]) q[m] = (col: string, val: unknown) => { filters.push(`${m}:${col}=${String(val)}`); return q; };
      q.not = (col: string, op: string, val: unknown) => { filters.push(`not:${col}.${op}=${String(val)}`); return q; };
      q.update = (p: unknown) => { mode = "update"; patch = p; return q; };
      q.maybeSingle = async () => ({ data: opts.row, error: null });
      q.then = (res: (v: { data: unknown; error: null }) => unknown) => {
        if (mode === "update") {
          opts.updateSpy?.(patch, filters);
          return res({ data: opts.flipped ?? [{ id: "run-1" }], error: null });
        }
        return res({ data: opts.siblings ?? [], error: null });
      };
      return q;
    },
  };
}

const pausedRow = (over: Row = {}): Row => ({
  id: "run-1", tenant_id: "t1", kind: "build_app", status: "paused",
  created_at: iso(NOW - 3_600_000), updated_at: iso(NOW - 60_000), paused_at: iso(NOW - 60_000),
  goal_graph: graph(), ...over,
});

beforeEach(() => mocks.serviceClient.mockReset());

describe("resumeGraph", () => {
  it("resets only failed stages, keeps finished ones and their checkpoints", () => {
    const g = resumeGraph(graph());
    expect(g[0]).toEqual(graph()[0]);
    expect(g[1]).toEqual(graph()[1]);
    expect(g[2]).toMatchObject({ status: "pending", error: null, failure_class: null, repair_attempts: 0, child_run_id: null });
    expect(g[3].status).toBe("pending");
    expect((g[2].payload as Record<string, unknown>).resume_epoch).toBe(1);
    expect((resumeGraph(g.map((n) => ({ ...n, status: n.status === "pending" ? "failed" : n.status })))[2].payload as Record<string, unknown>).resume_epoch).toBe(2);
    expect((g[0].payload as Record<string, unknown>).resume_epoch).toBeUndefined();
    expect((g[3].payload as Record<string, unknown>).deploy_enqueued_at).toBeUndefined();
  });
});

describe("continueBuild", () => {
  it("resumes through the locked RPC with the row version it read and the reset graph", async () => {
    let seen: { fn: string; args: Record<string, unknown> } | null = null;
    mocks.serviceClient.mockReturnValue(client({ row: pausedRow(), rpcSpy: (fn, args) => (seen = { fn, args }) }));
    expect(await continueBuild("t1", "run-1", NOW)).toEqual({ ok: true, run_id: "run-1" });
    expect(seen!.fn).toBe("continue_paused_build_with_site");
    expect(seen!.args).toMatchObject({ p_tenant_id: "t1", p_run_id: "run-1", p_expected_updated_at: iso(NOW - 60_000) });
    const g = seen!.args.p_goal_graph as ConductorNode[];
    expect(g[2]).toMatchObject({ status: "pending", repair_attempts: 0 });
  });

  it("a newer build that appeared (and even finished) in the meantime wins: the locked RPC refuses", async () => {
    mocks.serviceClient.mockReturnValue(client({ row: pausedRow(), rpcResult: "superseded" }));
    expect(await continueBuild("t1", "run-1", NOW)).toMatchObject({ ok: false, code: "superseded" });
  });

  it("a build that started in the meantime wins: the locked RPC refuses", async () => {
    mocks.serviceClient.mockReturnValue(client({ row: pausedRow(), rpcResult: "another_build_running" }));
    expect(await continueBuild("t1", "run-1", NOW)).toMatchObject({ ok: false, code: "another_build_running" });
  });

  it.each([
    ["another tenant's or missing run", null, "not_found"],
    ["a refine", pausedRow({ goal_graph: [{ id: "b", status: "failed", payload: { stage: "build", refine_mode: true } }] }), "not_found"],
    ["not paused", pausedRow({ status: "done" }), "not_paused"],
    ["paused over 7 days ago", pausedRow({ paused_at: iso(NOW - CONTINUE_WINDOW_MS - 1) }), "expired"],
  ])("refuses %s", async (_n, r, code) => {
    mocks.serviceClient.mockReturnValue(client({ row: r as Row | null }));
    expect(await continueBuild("t1", "run-1", NOW)).toMatchObject({ ok: false, code });
  });

  it("refuses when a newer fresh build replaced it (a newer refine does not)", async () => {
    mocks.serviceClient.mockReturnValue(client({ row: pausedRow(), siblings: [{ id: "r2", status: "done", created_at: iso(NOW - 1000), goal_graph: [{ payload: { refine_mode: true } }] }] }));
    expect(await continueBuild("t1", "run-1", NOW)).toEqual({ ok: true, run_id: "run-1" });
    mocks.serviceClient.mockReturnValue(client({ row: pausedRow(), siblings: [{ id: "b2", status: "failed", created_at: iso(NOW - 1000), goal_graph: [{ payload: { stage: "spec", site_id: DEFAULT_SITE } }] }] }));
    expect(await continueBuild("t1", "run-1", NOW)).toMatchObject({ ok: false, code: "superseded" });
  });

  it("a double click or a racing expiry resumes at most once", async () => {
    mocks.serviceClient.mockReturnValue(client({ row: pausedRow(), rpcResult: "changed_concurrently" }));
    expect(await continueBuild("t1", "run-1", NOW)).toMatchObject({ ok: false, code: "changed_concurrently" });
  });
});

const earlyFailGraph = (): ConductorNode[] => onDefaultSite([
  { id: "provision", status: "done", target_agent_slug: "", payload: { stage: "provision" }, estimate_usd: 0, child_run_id: null },
  { id: "spec", status: "done", target_agent_slug: "pm", payload: { stage: "spec" }, estimate_usd: 1, child_run_id: "pm-1" },
  { id: "scaffold", status: "failed", target_agent_slug: "engineer", payload: { stage: "scaffold" }, estimate_usd: 2, child_run_id: "eng-1",
    error: "resolve-repo-creds: GITHUB_PROVISION_TOKEN not configured", failure_class: "dispatch_failed" },
  { id: "build", status: "pending", target_agent_slug: "engineer", payload: { stage: "build" }, estimate_usd: 3, child_run_id: null },
]);

const failedRow = (over: Row = {}): Row => ({
  id: "run-1", tenant_id: "t1", kind: "build_app", status: "failed", paused_at: null,
  failure_class: "dispatch_failed", spend_usd: "0.5", max_usd: "50",
  created_at: iso(NOW - 600_000), updated_at: iso(NOW - 120_000),
  goal_graph: earlyFailGraph(), ...over,
});

describe("continueBuild on a failed build (Try again keeps the same session)", () => {
  it("resumes the same run from the failed stage without re-running the finished spec", async () => {
    let seen: { fn: string; args: Record<string, unknown> } | null = null;
    mocks.serviceClient.mockReturnValue(client({ row: failedRow(), rpcSpy: (fn, args) => (seen = { fn, args }) }));

    expect(await continueBuild("t1", "run-1", NOW)).toEqual({ ok: true, run_id: "run-1" });

    expect(seen!.fn).toBe("continue_paused_build_with_site");
    expect(seen!.args).toMatchObject({ p_tenant_id: "t1", p_run_id: "run-1", p_expected_updated_at: iso(NOW - 120_000) });
    const g = seen!.args.p_goal_graph as ConductorNode[];
    expect(g[0]).toEqual({
      ...earlyFailGraph()[0],
      payload: { ...earlyFailGraph()[0].payload, owner_worker: "dev:unknown" },
    });
    expect(g[1]).toEqual(earlyFailGraph()[1]);
    expect(g[2]).toMatchObject({ status: "pending", child_run_id: null, error: null, failure_class: null });
    expect((g[2].payload as Record<string, unknown>).resume_epoch).toBe(1);
    expect(g[3]).toEqual(earlyFailGraph()[3]);
  });

  it.each([
    ["a paused build the 7-day sweep already expired", failedRow({ paused_at: iso(NOW - CONTINUE_WINDOW_MS - 5_000), updated_at: iso(NOW - 1_000) }), "expired"],
    ["a build that failed over 7 days ago", failedRow({ updated_at: iso(NOW - CONTINUE_WINDOW_MS - 1) }), "expired"],
    ["a failed build with no failed stage to retry", failedRow({ goal_graph: earlyFailGraph().map((n) => ({ ...n, status: n.status === "failed" ? "pending" : n.status })) }), "not_resumable"],
    ["a build whose slot was released before any graph existed", failedRow({ goal_graph: [] }), "not_resumable"],
    ["a build the founder stopped mid-repair", failedRow({ failure_class: "user_cancelled" }), "not_resumable"],
    ["a provisioning failure", failedRow({ failure_class: "provision_failed" }), "not_resumable"],
    ["a coach-precedence stop", failedRow({ failure_class: "coach_precedence" }), "not_resumable"],
    ["a build that spent its whole lifetime cap", failedRow({ spend_usd: "50", max_usd: "50" }), "budget_spent"],
  ])("refuses %s and never touches the row", async (_n, r, code) => {
    const rpcSpy = vi.fn();
    mocks.serviceClient.mockReturnValue(client({ row: r as Row, rpcSpy }));

    expect(await continueBuild("t1", "run-1", NOW)).toMatchObject({ ok: false, code });
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("a newer fresh build replaced it: refused, so the UI falls back to a new build", async () => {
    mocks.serviceClient.mockReturnValue(client({ row: failedRow(), siblings: [{ id: "b2", status: "failed", created_at: iso(NOW - 1000), goal_graph: [{ payload: { stage: "spec", site_id: DEFAULT_SITE } }] }] }));
    expect(await continueBuild("t1", "run-1", NOW)).toMatchObject({ ok: false, code: "superseded" });
  });
});

describe("expireStalePausedBuilds", () => {
  it("fails only paused builds past the window", async () => {
    let seen: { patch: unknown; filters: string[] } | null = null;
    mocks.serviceClient.mockReturnValue(client({ row: null, flipped: [{ id: "a" }, { id: "b" }], updateSpy: (patch, filters) => (seen = { patch, filters }) }));
    expect(await expireStalePausedBuilds(NOW)).toBe(2);
    expect(seen!.patch).toMatchObject({ status: "failed" });
    expect(seen!.filters).toEqual(["eq:status=paused", `lt:paused_at=${iso(NOW - CONTINUE_WINDOW_MS)}`]);
  });
});

describe("resumeStrandedSiteRepublishes", () => {
  it("moves ONLY reserved runs carrying a site republish node, staged past the window, to active (CAS on provisioning)", async () => {
    let seen: { patch: unknown; filters: string[] } | null = null;
    mocks.serviceClient.mockReturnValue(client({ row: null, flipped: [{ id: "r1", tenant_id: "t1" }], updateSpy: (patch, filters) => (seen = { patch, filters }) }));
    expect(await resumeStrandedSiteRepublishes(NOW)).toBe(1);
    expect(seen!.patch).toMatchObject({ status: "active" });
    expect(seen!.filters).toEqual([
      "eq:status=provisioning",
      `lt:updated_at=${iso(NOW - STRANDED_SITE_REPUBLISH_MS)}`,
      "eq:goal_graph->0->payload->>republish=true",
      "not:goal_graph->0->payload->>site_id.is=null",
    ]);
  });
});

describe("continueBuild — new-flow site runs", () => {
  const SITE = "aaaaaaaa-0000-4000-8000-000000000001";
  const siteGraph = () => graph().map((n) => ({ ...n, payload: { ...n.payload, site_id: SITE } }));
  const failedRow = () => pausedRow({ status: "failed", paused_at: null, failure_class: "deploy_failed", goal_graph: siteGraph() });

  it("resumes and claims the site in ONE call, passing the run's own site id", async () => {
    let seen: { fn: string; args: Record<string, unknown> } | null = null;
    mocks.serviceClient.mockReturnValue(client({ row: failedRow(), rpcSpy: (fn, args) => { seen = { fn, args }; } }));
    const r = await continueBuild("t1", "run-1", NOW);
    expect(r).toEqual({ ok: true, run_id: "run-1" });
    expect(seen!.fn).toBe("continue_paused_build_with_site");
    expect(seen!.args).toMatchObject({ p_run_id: "run-1", p_site_id: SITE });
  });

  it("a site the reaper already took is refused with a plain reason", async () => {
    mocks.serviceClient.mockReturnValue(client({ row: failedRow(), rpcResult: "site_gone" }));
    const r = await continueBuild("t1", "run-1", NOW);
    expect(r).toMatchObject({ ok: false, code: "not_resumable" });
    expect((r as { message: string }).message).toMatch(/site was cleaned up/);
  });

  it("an old-flow run (no site) is refused: the old-flow app is frozen, nothing is resumed", async () => {
    let called = false;
    const oldFlow = graph().map((n) => {
      const { site_id: _drop, ...payload } = n.payload as Record<string, unknown>;
      return { ...n, payload };
    });
    mocks.serviceClient.mockReturnValue(client({ row: pausedRow({ goal_graph: oldFlow }), rpcSpy: () => { called = true; } }));
    const r = await continueBuild("t1", "run-1", NOW);
    expect(r).toMatchObject({ ok: false, code: "old_site_frozen" });
    expect(called).toBe(false);
    const expired = pausedRow({ goal_graph: oldFlow, paused_at: iso(NOW - CONTINUE_WINDOW_MS - 60_000) });
    mocks.serviceClient.mockReturnValue(client({ row: expired }));
    expect(await continueBuild("t1", "run-1", NOW)).toMatchObject({ ok: false, code: "old_site_frozen" });
  });

  it("an RPC error never touches the site from the outside (nothing to give back)", async () => {
    const c = client({ row: failedRow() });
    c.rpc = async () => ({ data: null, error: { message: "timeout" } }) as never;
    mocks.serviceClient.mockReturnValue(c);
    await expect(continueBuild("t1", "run-1", NOW)).rejects.toThrow(/resume failed: timeout/);
  });
});

describe("continueBuild — two sites in one workspace", () => {
  const SITE_A = "aaaaaaaa-0000-4000-8000-00000000000a";
  const SITE_B = "bbbbbbbb-0000-4000-8000-00000000000b";
  const onSite = (site: string) => graph().map((n) => ({ ...n, payload: { ...n.payload, site_id: site } }));
  const olderSiteA = () => pausedRow({ goal_graph: onSite(SITE_A) });
  const newer = (over: Row) => ({ id: "b2", status: "done", created_at: iso(NOW - 1000), objective: "Build x", ...over });

  it("the older paused site continues while a newer, different site exists", async () => {
    let fn: string | null = null;
    mocks.serviceClient.mockReturnValue(client({
      row: olderSiteA(),
      siblings: [newer({ goal_graph: [{ payload: { stage: "provision", site_id: SITE_B } }] })],
      rpcSpy: (f) => { fn = f; },
    }));
    expect(await continueBuild("t1", "run-1", NOW)).toEqual({ ok: true, run_id: "run-1" });
    expect(fn).toBe("continue_paused_build_with_site");
  });

  it("a newer fresh build of the SAME site still supersedes it", async () => {
    mocks.serviceClient.mockReturnValue(client({
      row: olderSiteA(),
      siblings: [newer({ goal_graph: [{ payload: { stage: "provision", site_id: SITE_A.toUpperCase() } }] })],
    }));
    expect(await continueBuild("t1", "run-1", NOW)).toMatchObject({ ok: false, code: "superseded" });
  });

  it("a newer refine or republish of the same site does not", async () => {
    mocks.serviceClient.mockReturnValue(client({
      row: olderSiteA(),
      siblings: [
        newer({ id: "r1", goal_graph: [{ payload: { stage: "build", refine_mode: true, site_id: SITE_A } }] }),
        newer({ id: "r2", objective: "[refine] republish a.zavi.site", goal_graph: [{ payload: { stage: "deploy", site_id: SITE_A } }] }),
      ],
    }));
    expect(await continueBuild("t1", "run-1", NOW)).toEqual({ ok: true, run_id: "run-1" });
  });

  it("an older build of the same site never supersedes a newer one", async () => {
    mocks.serviceClient.mockReturnValue(client({
      row: olderSiteA(),
      siblings: [newer({ created_at: iso(NOW - 7_200_000), goal_graph: [{ payload: { stage: "provision", site_id: SITE_A } }] })],
    }));
    expect(await continueBuild("t1", "run-1", NOW)).toEqual({ ok: true, run_id: "run-1" });
  });

  it("a site run is superseded by a newer build of the SAME site, not by a newer different site", async () => {
    mocks.serviceClient.mockReturnValue(client({
      row: pausedRow(),
      siblings: [newer({ goal_graph: [{ payload: { stage: "provision", site_id: SITE_B } }] })],
    }));
    expect(await continueBuild("t1", "run-1", NOW)).toEqual({ ok: true, run_id: "run-1" });
    mocks.serviceClient.mockReturnValue(client({
      row: pausedRow(),
      siblings: [newer({ goal_graph: [{ payload: { stage: "spec", site_id: DEFAULT_SITE } }] })],
    }));
    expect(await continueBuild("t1", "run-1", NOW)).toMatchObject({ ok: false, code: "superseded" });
  });

  it("a site run is never superseded by a newer old-flow build (a different app)", async () => {
    mocks.serviceClient.mockReturnValue(client({
      row: olderSiteA(),
      siblings: [newer({ goal_graph: [{ payload: { stage: "spec" } }] })],
    }));
    expect(await continueBuild("t1", "run-1", NOW)).toEqual({ ok: true, run_id: "run-1" });
  });
});
