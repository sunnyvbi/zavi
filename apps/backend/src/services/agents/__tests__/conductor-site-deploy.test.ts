
import { describe, it, expect, vi } from "vitest";
import {
  conductorTick,
  type ConductorNode,
  type ConductorRow,
  type ConductorTickDeps,
  type SiteDeployDeps,
  type SiteDeployStepOutcome,
  SITE_CAPACITY_RETRY_MS,
  SITE_CAPACITY_WAIT_MS,
  SITE_DEPLOY_STEP_ERROR_LIMIT,
} from "../conductor";
import { SITE_DATABASE_SLOW, SITE_PUBLISH_PLATFORM_RETRY } from "@zavi/shared";

const SITE = "site-a";

function nodes(): ConductorNode[] {
  return [
    { id: "p", status: "done", target_agent_slug: "__provision_gate__", payload: { stage: "provision", site_id: SITE }, estimate_usd: 0.1, child_run_id: null },
    {
      id: "b",
      status: "done",
      target_agent_slug: "engineer",
      payload: { stage: "build", fast_single_pass: true, site_id: SITE, idea: "a booking site", target: { github_full_name: "praxis-built/shop-aaa111" } },
      estimate_usd: 3,
      child_run_id: "child-build",
    },
    { id: "d", status: "pending", target_agent_slug: "__deploy_gate__", payload: { stage: "deploy", site_id: SITE, seed_sha: "seed" }, estimate_usd: 0, child_run_id: null },
  ];
}

function row(graph: ConductorNode[]): ConductorRow {
  return { id: "cond-1", tenant_id: "t1", objective: "build", status: "active", max_usd: 100, spend_usd: 0, kind: "build_app", goal_graph: graph };
}

function harness(opts: {
  graph?: ConductorNode[];
  outcomes?: SiteDeployStepOutcome[];
  maxRepairs?: number;
  head?: string | null;
  childStatus?: "running" | "success" | "failed";
  withSite?: boolean;
  consume?: "charged" | "over_cap";
  owns?: boolean;
}) {
  let graph = opts.graph ?? nodes();
  const outcomes = [...(opts.outcomes ?? [])];
  const statuses: string[] = [];
  const stepCalls: Array<{ sha: string; attempt: number; tenant_id: string; site_id: string }> = [];
  const desired: string[] = [];
  const settled: string[] = [];
  const reasons: string[] = [];
  const hostingStatus = vi.fn(async () => "ready" as const);
  const staticPlan = vi.fn();
  const dispatchRepair = vi.fn(async (i: { attempt: number; payload: Record<string, unknown> }) => ({ ok: true as const, child_run_id: `fix-${i.attempt}` }));
  const site: SiteDeployDeps = {
    step: vi.fn(async (i): Promise<SiteDeployStepOutcome> => {
      stepCalls.push(i);
      return outcomes.shift() ?? { kind: "waiting" };
    }),
    headSha: vi.fn(async () => (opts.head === undefined ? "head1" : opts.head)),
    ownsSite: vi.fn(async () => opts.owns ?? true),
    markDesired: vi.fn(async ({ sha }) => { desired.push(sha); }),
    settle: vi.fn(async ({ outcome, reason }) => { settled.push(outcome); if (reason) reasons.push(reason); }),
    repairMaxAttempts: vi.fn(async () => opts.maxRepairs ?? 1),
  };
  const deps: ConductorTickDeps = {
    load: async () => row(graph),
    childStatus: async () => opts.childStatus ?? "success",
    consumeBudget: vi.fn(async () => opts.consume ?? "charged"),
    dispatch: vi.fn(async () => ({ ok: true as const, child_run_id: "x" })),
    dispatchRepair: dispatchRepair as unknown as ConductorTickDeps["dispatchRepair"],
    saveGraph: async (_id, g) => { graph = g.map((n) => ({ ...n, payload: { ...n.payload } })); },
    setStatus: async (_id, s) => { statuses.push(s); },
    hostingStatus,
    staticPublish: { plan: staticPlan, request: vi.fn(), rollback: vi.fn() },
    ...(opts.withSite === false ? {} : { siteDeploy: site }),
  };
  return {
    deps,
    site,
    statuses,
    stepCalls,
    desired,
    settled,
    reasons,
    hostingStatus,
    staticPlan,
    dispatchRepair,
    node: (id: string) => graph.find((n) => n.id === id)!,
  };
}

describe("site deploy node", () => {
  it("never calls the Render / static-publish deploy paths", async () => {
    const h = harness({ outcomes: [{ kind: "waiting" }] });
    await conductorTick("cond-1", h.deps);
    expect(h.hostingStatus).not.toHaveBeenCalled();
    expect(h.staticPlan).not.toHaveBeenCalled();
    expect(h.stepCalls[0]).toMatchObject({ tenant_id: "t1", site_id: SITE, sha: "head1", attempt: 1 });
  });

  it("waiting: the node stays pending and the run stays active", async () => {
    const h = harness({ outcomes: [{ kind: "waiting" }] });
    const r = await conductorTick("cond-1", h.deps);
    expect(r).toEqual({ action: "waiting", in_flight: 0 });
    expect(h.node("d").status).toBe("pending");
    expect(h.statuses).toEqual([]);
  });

  it("live: node done with hosting_verified_at = the handler's verified_at, run done", async () => {
    const h = harness({ outcomes: [{ kind: "live", url: "https://shop.zaviagent.com", verified_at: "2026-10-01T00:00:00.000Z" }] });
    const r = await conductorTick("cond-1", h.deps);
    expect(r).toEqual({ action: "completed", final: "done" });
    expect(h.node("d")).toMatchObject({ status: "done", hosting_verified_at: "2026-10-01T00:00:00.000Z" });
    expect(h.statuses).toEqual(["done"]);
    expect(h.settled).toEqual(["live"]);
  });

  it("live: the deploy that went live is kept on the node for version history, even after its checkpoint is cleared", async () => {
    const h = harness({ outcomes: [{ kind: "live", url: "https://x", verified_at: "2026-10-01T00:00:00.000Z", deploy_id: "d0muqzh2uy-1d58fa82" }] });
    await conductorTick("cond-1", h.deps);
    expect(h.node("d").payload.site_live_deploy_id).toBe("d0muqzh2uy-1d58fa82");
  });

  it("failed: the run fails (or pauses) with the handler's plain reason", async () => {
    const h = harness({ outcomes: [{ kind: "failed", reason: "site sandbox gone, start the build again" }] });
    const r = await conductorTick("cond-1", h.deps);
    expect(r.action).toBe("completed");
    expect(h.node("d")).toMatchObject({ status: "failed", error: "site sandbox gone, start the build again", failure_class: "deploy_failed" });
    expect(h.statuses).toEqual(["paused"]);
    expect(h.settled).toEqual(["paused"]);
  });

  it("marks the published commit as desired once, before the step", async () => {
    const h = harness({ outcomes: [{ kind: "waiting" }, { kind: "waiting" }] });
    await conductorTick("cond-1", h.deps);
    await conductorTick("cond-1", h.deps);
    expect(h.desired).toEqual(["head1"]);
  });

  it("persists the step's checkpoint on the deploy node and hands it back next tick", async () => {
    const h = harness({ outcomes: [{ kind: "waiting" }, { kind: "waiting" }] });
    const seen: unknown[] = [];
    (h.site.step as ReturnType<typeof vi.fn>).mockImplementation(async (i: { checkpoint: Record<string, unknown> }) => {
      seen.push(JSON.parse(JSON.stringify(i.checkpoint)));
      i.checkpoint.k = { deploy_id: "dep-1" };
      return { kind: "waiting" };
    });
    await conductorTick("cond-1", h.deps);
    expect(h.node("d").payload.site_checkpoint).toEqual({ k: { deploy_id: "dep-1" } });
    await conductorTick("cond-1", h.deps);
    expect(seen).toEqual([{}, { k: { deploy_id: "dep-1" } }]);
  });

  it("a stop settle carries the run's publish generation: its own begun one, else the one it took over", async () => {
    const h = harness({ outcomes: [{ kind: "waiting" }, { kind: "failed", reason: "gate kept failing" }] });
    (h.site.markDesired as ReturnType<typeof vi.fn>).mockResolvedValue({ publish_generation: 4 });
    expect(h.node("d").payload.site_publish_generation).toBeUndefined();
    await conductorTick("cond-1", h.deps);
    expect(h.node("d").payload.site_publish_generation).toBe(4);
    (h.site.step as ReturnType<typeof vi.fn>).mockImplementationOnce(async (i: { checkpoint: Record<string, unknown> }) => {
      i.checkpoint.k = { generation: 5, deploy_id: "" };
      return { kind: "failed", reason: "gate kept failing" };
    });
    await conductorTick("cond-1", h.deps);
    expect(h.node("d").payload.site_publish_generation).toBe(5);
    expect(h.site.settle).toHaveBeenCalledWith(expect.objectContaining({ outcome: "paused", generation: 5 }));
  });

  it("a run that stopped before its deploy step settles without a fence (unchanged)", async () => {
    const g = nodes();
    g[1] = { ...g[1], status: "dispatched", child_run_id: "child-build" };
    const h = harness({ graph: g, childStatus: "failed", maxRepairs: 0 });
    for (let i = 0; i < 6 && !h.statuses.length; i++) await conductorTick("cond-1", h.deps);
    const calls = (h.site.settle as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0][0]).not.toHaveProperty("generation");
  });

  it("a refine/republish deploy node publishes its pinned site_sha, not HEAD", async () => {
    const g: ConductorNode[] = [
      { id: "d", status: "pending", target_agent_slug: "__deploy_gate__", payload: { stage: "deploy", site_id: SITE, site_sha: "pinned1", refine_mode: true, republish: true }, estimate_usd: 0, child_run_id: null },
    ];
    const h = harness({ graph: g, outcomes: [{ kind: "live", url: "https://x", verified_at: "2026-10-01T00:00:00.000Z" }] });
    const r = await conductorTick("cond-1", h.deps);
    expect(h.stepCalls[0].sha).toBe("pinned1");
    expect(h.site.headSha).not.toHaveBeenCalled();
    expect(r).toEqual({ action: "completed", final: "done" });
    expect(h.node("d").hosting_verified_at).toBe("2026-10-01T00:00:00.000Z");
  });

  it.each([
    ["returns null", null],
    ["throws", "throw"],
  ] as const)("when main's HEAD read %s, the node waits and nothing is published (never the seed)", async (_label, head) => {
    const h = harness({ head: head === "throw" ? "unused" : head, outcomes: [{ kind: "live", url: "https://x", verified_at: "2026-10-01T00:00:00.000Z" }] });
    if (head === "throw") (h.site.headSha as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("github 502"));
    const r = await conductorTick("cond-1", h.deps);
    expect(r).toEqual({ action: "waiting", in_flight: 0 });
    expect(h.stepCalls).toEqual([]);
    expect(h.desired).toEqual([]);
    expect(h.node("d").status).toBe("pending");
    expect(h.statuses).toEqual([]);
  });

  it("a site owned by another environment is left alone: no head read, no step, no error counted", async () => {
    const h = harness({ owns: false, head: null });
    for (let i = 0; i < SITE_DEPLOY_STEP_ERROR_LIMIT + 2; i++) {
      expect(await conductorTick("cond-1", h.deps)).toEqual({ action: "waiting", in_flight: 0 });
    }
    expect(h.site.headSha).not.toHaveBeenCalled();
    expect(h.stepCalls).toEqual([]);
    expect(h.desired).toEqual([]);
    expect(h.node("d").payload.site_head_errors).toBeUndefined();
    expect(h.node("d").status).not.toBe("failed");
    expect(h.statuses).toEqual([]);
  });

  it("the head read's reason is the run's failure reason", async () => {
    const h = harness({ head: "unused" });
    (h.site.headSha as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("GitHub answered 404 for o/r"));
    let r = await conductorTick("cond-1", h.deps);
    for (let i = 1; i < SITE_DEPLOY_STEP_ERROR_LIMIT && r.action === "waiting"; i++) r = await conductorTick("cond-1", h.deps);
    expect(h.node("d").error).toMatch(/GitHub answered 404 for o\/r/);
  });

  it("the seed is published only when it IS main's HEAD", async () => {
    const h = harness({ head: "seed", outcomes: [{ kind: "waiting" }] });
    await conductorTick("cond-1", h.deps);
    expect(h.stepCalls[0].sha).toBe("seed");
  });

  it("an unreadable HEAD retries, then fails the run after the step-error limit (never the seed)", async () => {
    const h = harness({ head: null });
    let r = await conductorTick("cond-1", h.deps);
    for (let i = 1; i < SITE_DEPLOY_STEP_ERROR_LIMIT && r.action === "waiting"; i++) r = await conductorTick("cond-1", h.deps);
    expect(r).toMatchObject({ action: "completed" });
    expect(h.node("d")).toMatchObject({ status: "failed", failure_class: "deploy_failed" });
    expect(h.stepCalls).toEqual([]);
    expect(h.desired).toEqual([]);
  });

  it("recording the commit to publish retries a database blip, then fails retryably (bounded, never a repair)", async () => {
    const h = harness({ outcomes: [{ kind: "waiting" }] });
    const mark = h.site.markDesired as ReturnType<typeof vi.fn>;
    mark.mockRejectedValueOnce(new Error("SiteStore: site_mark_desired failed (PGRST002): schema cache"));
    expect((await conductorTick("cond-1", h.deps)).action).toBe("waiting");
    expect(h.node("d").payload.site_mark_errors).toBe(1);
    await conductorTick("cond-1", h.deps);
    expect(h.node("d").payload.site_mark_errors).toBeUndefined();
    expect(h.stepCalls).toHaveLength(1);

    const down = harness({});
    (down.site.markDesired as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("SiteStore: site_mark_desired failed (PGRST002)"));
    let r = await conductorTick("cond-1", down.deps);
    for (let i = 1; i < SITE_DEPLOY_STEP_ERROR_LIMIT && r.action === "waiting"; i++) r = await conductorTick("cond-1", down.deps);
    expect(r).toMatchObject({ action: "completed" });
    expect(down.node("d")).toMatchObject({ status: "failed", failure_class: "deploy_failed" });
    expect(down.node("d").error).toMatch(/^Publishing hit a temporary problem on our side/);
    expect(down.stepCalls).toEqual([]);
    expect(down.deps.dispatchRepair).not.toHaveBeenCalled();
  });

  it("a site row that cannot be read is retried, then fails retryably (bounded, never forever)", async () => {
    const h = harness({});
    (h.site.ownsSite as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("SiteStore: read failed (PGRST002)"));
    let r = await conductorTick("cond-1", h.deps);
    expect(h.node("d").payload.site_owns_errors).toBe(1);
    for (let i = 1; i < SITE_DEPLOY_STEP_ERROR_LIMIT && r.action === "waiting"; i++) r = await conductorTick("cond-1", h.deps);
    expect(r).toMatchObject({ action: "completed" });
    expect(h.node("d")).toMatchObject({ status: "failed", failure_class: "deploy_failed" });
    expect(h.node("d").error).toMatch(/^Publishing hit a temporary problem on our side/);
    expect(h.stepCalls).toEqual([]);
    expect(h.deps.dispatchRepair).not.toHaveBeenCalled();
  });

  it("a successful HEAD read clears the earlier read-error count", async () => {
    const h = harness({ head: null });
    await conductorTick("cond-1", h.deps);
    expect(h.node("d").payload.site_head_errors).toBe(1);
    (h.site.headSha as ReturnType<typeof vi.fn>).mockResolvedValue("head1");
    await conductorTick("cond-1", h.deps);
    expect(h.node("d").payload.site_head_errors).toBeUndefined();
    expect(h.stepCalls[0].sha).toBe("head1");
  });

  it("repair: one targeted fix pass on the build agent, then the gate runs again", async () => {
    const h = harness({ outcomes: [{ kind: "repair", signal: "smoke: login journey failed" }] });
    const r = await conductorTick("cond-1", h.deps);
    expect(r).toMatchObject({ action: "site_repair_dispatched", attempt: 1, child_run_id: "fix-1" });
    const call = h.dispatchRepair.mock.calls[0][0] as unknown as { payload: Record<string, unknown>; target_agent_slug: string };
    expect(call.target_agent_slug).toBe("engineer");
    expect(call.payload).toMatchObject({ stage: "build", site_id: SITE, fast_single_pass: true, repair_mode: true, failure_signal: "smoke: login journey failed" });
    expect(h.node("d")).toMatchObject({ status: "dispatched", site_repair_pending: true, site_repair_attempts: 1 });

    await conductorTick("cond-1", h.deps);
    expect(h.node("d")).toMatchObject({ status: "pending", site_repair_pending: false });
  });

  it("repair: a fix pass that died before doing any work is refunded and does not use up the attempt", async () => {
    const h = harness({
      outcomes: [
        { kind: "repair", signal: "smoke: login journey failed" },
        { kind: "repair", signal: "smoke: login journey failed" },
      ],
    });
    const refunds: string[] = [];
    h.deps.consumeBudgetOnce = vi.fn(async () => "charged" as const);
    h.deps.refundBudgetOnce = vi.fn(async (_run: string, key: string) => { refunds.push(key); });
    h.deps.childDidNoWork = vi.fn(async () => true);
    await conductorTick("cond-1", h.deps);
    expect(h.node("d")).toMatchObject({ status: "dispatched", site_repair_attempts: 1, last_charge_usd: 3 });

    h.deps.childStatus = async () => "failed";
    const r = await conductorTick("cond-1", h.deps);
    expect(refunds).toEqual(["repair:site:d:e0:a1"]);
    expect(h.stepCalls).toHaveLength(2);
    expect(r).toMatchObject({ action: "site_repair_dispatched", attempt: 2, child_run_id: "fix-2" });
    expect(h.dispatchRepair.mock.calls.map((c) => (c[0] as { attempt: number }).attempt)).toEqual([1, 2]);
    expect(h.node("d")).toMatchObject({ status: "dispatched", site_repair_attempts: 2, last_charge_key: "repair:site:d:e0:a2" });
    expect(h.node("d").payload.site_repair_no_work).toBe(1);
  });

  it("repair: a dead pass whose refund did not land still counts as a used fix", async () => {
    const h = harness({ outcomes: [{ kind: "repair", signal: "smoke: x" }, { kind: "repair", signal: "smoke: x" }] });
    h.deps.consumeBudgetOnce = vi.fn(async () => "charged" as const);
    h.deps.refundBudgetOnce = vi.fn(async () => { throw new Error("db down"); });
    h.deps.childDidNoWork = vi.fn(async () => true);
    await conductorTick("cond-1", h.deps);
    h.deps.childStatus = async () => "failed";
    await conductorTick("cond-1", h.deps);
    expect(h.node("d").payload.site_repair_no_work).toBeUndefined();
    expect(h.node("d")).toMatchObject({ status: "failed", failure_class: "repair_exhausted" });
  });

  it("repair: a fix pass that did work keeps its charge and its attempt", async () => {
    const h = harness({ outcomes: [{ kind: "repair", signal: "smoke: login journey failed" }] });
    const refunds: string[] = [];
    h.deps.consumeBudgetOnce = vi.fn(async () => "charged" as const);
    h.deps.refundBudgetOnce = vi.fn(async (_run: string, key: string) => { refunds.push(key); });
    h.deps.childDidNoWork = vi.fn(async () => false);
    await conductorTick("cond-1", h.deps);
    h.deps.childStatus = async () => "failed";
    await conductorTick("cond-1", h.deps);
    expect(refunds).toEqual([]);
    expect(h.node("d")).toMatchObject({ status: "pending", site_repair_attempts: 1, last_charge_usd: 3 });
  });

  it("repair: dead fix passes stop being given back after the limit, so the run still ends", async () => {
    const h = harness({ outcomes: Array.from({ length: 6 }, () => ({ kind: "repair" as const, signal: "smoke: x" })) });
    h.deps.consumeBudgetOnce = vi.fn(async () => "charged" as const);
    h.deps.refundBudgetOnce = vi.fn(async () => undefined);
    h.deps.childDidNoWork = vi.fn(async () => true);
    let last: unknown;
    for (let i = 0; i < 12; i++) {
      h.deps.childStatus = async () => "failed";
      last = await conductorTick("cond-1", h.deps);
      if (h.node("d").status === "failed") break;
    }
    expect(h.node("d")).toMatchObject({ status: "failed", failure_class: "deploy_failed" });
    expect(String(h.node("d").error)).toContain(SITE_PUBLISH_PLATFORM_RETRY);
    expect(h.node("d").payload.site_repair_no_work).toBe(2);
    expect(h.dispatchRepair).toHaveBeenCalledTimes(2);
    expect(last).toMatchObject({ action: "completed" });
  });

  it("repair: a Continue (new resume epoch) gives the box a fresh try past the breaker", async () => {
    const graph = nodes();
    graph[2] = { ...graph[2], site_repair_attempts: 2, payload: { ...graph[2].payload, resume_epoch: 1, site_repair_no_work: 2, site_repair_no_work_epoch: { e: 0, n: 2 } } };
    const h = harness({ graph, outcomes: [{ kind: "repair", signal: "smoke: x" }] });
    h.deps.consumeBudgetOnce = vi.fn(async () => "charged" as const);
    const r = await conductorTick("cond-1", h.deps);
    expect(r).toMatchObject({ action: "site_repair_dispatched", attempt: 3 });
  });

  it("a crash between the repair charge and the graph save never charges the attempt twice", async () => {
    const h = harness({
      outcomes: [
        { kind: "repair", signal: "smoke: login journey failed" },
        { kind: "repair", signal: "smoke: login journey failed" },
      ],
    });
    const charges = new Map<string, number>();
    let spend = 0;
    h.deps.consumeBudgetOnce = vi.fn(async (_run: string, est: number, key: string) => {
      if (charges.has(key)) return "already_charged" as const;
      charges.set(key, est);
      spend += est;
      return "charged" as const;
    });
    h.deps.refundBudgetOnce = vi.fn(async (_run: string, key: string) => {
      const amt = charges.get(key);
      if (amt === undefined) return;
      charges.delete(key);
      spend -= amt;
    });
    h.dispatchRepair.mockImplementationOnce(async () => {
      throw new Error("process killed");
    });
    await expect(conductorTick("cond-1", h.deps)).rejects.toThrow(/process killed/);
    expect(h.node("d").site_repair_attempts).toBeUndefined();
    expect(spend).toBe(3);

    const r = await conductorTick("cond-1", h.deps);
    expect(r).toMatchObject({ action: "site_repair_dispatched", attempt: 1 });
    expect(spend).toBe(3);
    expect([...charges.keys()]).toEqual(["repair:site:d:e0:a1"]);
    expect(h.deps.consumeBudget).not.toHaveBeenCalled();
    expect(h.node("d")).toMatchObject({ last_charge_key: "repair:site:d:e0:a1", last_charge_usd: 3 });
  });

  it("a keyed repair charge is shared by the attempt's ticks: a failed dispatch never refunds it (another tick may run on it)", async () => {
    const h = harness({ outcomes: [{ kind: "repair", signal: "s" }, { kind: "repair", signal: "s" }] });
    const refunds: string[] = [];
    h.deps.consumeBudgetOnce = vi.fn(async () => "charged" as const);
    h.deps.refundBudgetOnce = vi.fn(async (_run: string, key: string) => {
      refunds.push(key);
    });
    h.dispatchRepair.mockResolvedValueOnce({ ok: false, reason: "dispatch_in_flight" } as never);
    await conductorTick("cond-1", h.deps);
    expect(refunds).toEqual([]);
    h.dispatchRepair.mockResolvedValueOnce({ ok: false, reason: "kill_switch" } as never);
    await conductorTick("cond-1", h.deps);
    expect(refunds).toEqual([]);
    expect(h.node("d")).toMatchObject({ site_repair_attempts: 1, last_charge_key: "repair:site:d:e0:a1" });
  });

  it("every fix attempt's gate is held to the journeys of the failed checks, and going live clears the old failure", async () => {
    const h = harness({
      maxRepairs: 2,
      outcomes: [
        { kind: "repair", signal: "journey \"open-times\" failed", journeys: { names: ["home", "open-times"], must_pass: ["open-times"], fingerprints: { "open-times": "v1" } } },
        { kind: "repair", signal: "journey \"book\" failed", journeys: { names: ["home", "open-times", "book"], must_pass: ["book"], fingerprints: { book: "b1", "open-times": "v2" } } },
        { kind: "live", url: "https://paws.zaviagent.com", verified_at: "2026-10-05T00:00:00.000Z" },
      ],
    });
    for (let i = 0; i < 8 && !h.statuses.length; i++) await conductorTick("cond-1", h.deps);
    const kept = (h.stepCalls as Array<{ kept_journeys?: unknown }>).map((c) => c.kept_journeys);
    expect(kept).toEqual([
      undefined,
      { names: ["home", "open-times"], must_pass: ["open-times"], fingerprints: { "open-times": "v1" } },
      { names: ["home", "open-times", "book"], must_pass: ["open-times", "book"], fingerprints: { "open-times": "v1", book: "b1" } },
    ]);
    expect(h.statuses).toEqual(["done"]);
    expect(h.node("d").status).toBe("done");
    expect(h.node("d").last_failure_signal ?? null).toBeNull();
    expect(h.node("d").payload.site_gate_kept).toBeUndefined();
  });

  it("repair is capped at fast_build_repair_attempts (1): the second repair fails the run", async () => {
    const h = harness({
      outcomes: [
        { kind: "repair", signal: "first failure" },
        { kind: "repair", signal: "still failing" },
      ],
    });
    await conductorTick("cond-1", h.deps);
    await conductorTick("cond-1", h.deps);
    const r = await conductorTick("cond-1", h.deps);
    expect(r.action).toBe("completed");
    expect(h.dispatchRepair).toHaveBeenCalledTimes(1);
    expect(h.stepCalls.map((c) => c.attempt)).toEqual([1, 2]);
    expect(h.node("d")).toMatchObject({ status: "failed", failure_class: "repair_exhausted" });
    expect(h.node("d").error).toContain("still failing");
  });

  describe("the site's one free brief-journey fix (Zavi pays)", () => {
    const deadEnd = { kind: "repair" as const, signal: "the main action dead-ends", free_fix: "brief_journey" as const };

    it("a claimed free fix is dispatched marked free, charges nothing, and runs even when the paid passes are used up", async () => {
      const h = harness({ maxRepairs: 0, outcomes: [deadEnd] });
      const claims: Array<{ conductor_run_id: string; attempt: number }> = [];
      h.site.claimJourneyFix = vi.fn(async (i) => {
        claims.push(i);
        return { status: "claimed" as const, token: "tok-1" };
      });
      const charged = vi.fn(async () => "charged" as const);
      h.deps.consumeBudgetOnce = charged;
      const r = await conductorTick("cond-1", h.deps);
      expect(r).toMatchObject({ action: "site_repair_dispatched", attempt: 1 });
      expect(claims).toEqual([{ tenant_id: "t1", site_id: SITE, conductor_run_id: "cond-1", attempt: 1 }]);
      const call = h.dispatchRepair.mock.calls[0][0] as unknown as { payload: Record<string, unknown> };
      expect(call.payload).toMatchObject({ brief_journey_fix: true, brief_journey_fix_token: "tok-1", site_id: SITE, repair_attempt: 1 });
      expect(charged).not.toHaveBeenCalled();
      expect(h.deps.consumeBudget).not.toHaveBeenCalled();
      expect(h.node("d")).toMatchObject({ last_charge_usd: 0, last_charge_key: "repair:site:d:e0:a1" });
    });

    it("a site whose free fix another run is bound to (already_used) gets an ordinary, charged repair, never marked free", async () => {
      const h = harness({ outcomes: [deadEnd] });
      h.site.claimJourneyFix = vi.fn(async () => ({ status: "already_used" as const }));
      await conductorTick("cond-1", h.deps);
      const call = h.dispatchRepair.mock.calls[0][0] as unknown as { payload: Record<string, unknown> };
      expect(call.payload.brief_journey_fix).toBeUndefined();
      expect(h.deps.consumeBudget).toHaveBeenCalledTimes(1);
    });

    it("already_used with the paid passes used up ends repair_exhausted, dispatching nothing", async () => {
      const h = harness({ maxRepairs: 0, outcomes: [deadEnd] });
      h.site.claimJourneyFix = vi.fn(async () => ({ status: "already_used" as const }));
      const r = await conductorTick("cond-1", h.deps);
      expect(r.action).toBe("completed");
      expect(h.dispatchRepair).not.toHaveBeenCalled();
      expect(h.node("d")).toMatchObject({ status: "failed", failure_class: "repair_exhausted" });
    });

    it("a repair without the free marker never asks for the claim", async () => {
      const h = harness({ outcomes: [{ kind: "repair", signal: "smoke failed" }] });
      h.site.claimJourneyFix = vi.fn(async () => ({ status: "claimed" as const, token: "tok-1" }));
      await conductorTick("cond-1", h.deps);
      expect(h.site.claimJourneyFix).not.toHaveBeenCalled();
    });

    const notEstablished: Array<[string, (h: ReturnType<typeof harness>) => void]> = [
      ["the claim throws", (h) => { h.site.claimJourneyFix = vi.fn(async () => { throw new Error("db down"); }); }],
      ["the claim is unavailable (no design row)", (h) => { h.site.claimJourneyFix = vi.fn(async () => ({ status: "unavailable" as const, reason: "no_design" })); }],
      ["another run holds an unbound reservation", (h) => { h.site.claimJourneyFix = vi.fn(async () => ({ status: "unavailable" as const, reason: "reserved" })); }],
      ["the claim answers claimed without a token", (h) => { h.site.claimJourneyFix = vi.fn(async () => ({ status: "claimed" as const, token: "" })); }],
      ["the claim dep is missing", (h) => { delete h.site.claimJourneyFix; }],
    ];

    for (const [label, setup] of notEstablished) {
      it(`${label}: no repair is dispatched and nothing is reserved or charged; the node waits`, async () => {
        const h = harness({ outcomes: [deadEnd] });
        setup(h);
        const once = vi.fn(async () => "charged" as const);
        h.deps.consumeBudgetOnce = once;
        const r = await conductorTick("cond-1", h.deps);
        expect(r).toEqual({ action: "waiting", in_flight: 0 });
        expect(h.dispatchRepair).not.toHaveBeenCalled();
        expect(h.deps.consumeBudget).not.toHaveBeenCalled();
        expect(once).not.toHaveBeenCalled();
        expect(h.node("d").status).toBe("pending");
        expect(h.node("d").site_repair_attempts ?? 0).toBe(0);
        expect(h.node("d").payload.site_journey_claim_errors).toBe(1);
        expect(h.statuses).toEqual([]);
      });
    }

    it("a claim that keeps failing ends the publish retryably after the step budget, never charging or dispatching", async () => {
      const h = harness({ outcomes: [deadEnd] });
      h.site.claimJourneyFix = vi.fn(async () => {
        throw new Error("function claim_brief_journey_fix_status does not exist");
      });
      const once = vi.fn(async () => "charged" as const);
      h.deps.consumeBudgetOnce = once;
      for (let i = 1; i < SITE_DEPLOY_STEP_ERROR_LIMIT; i++) {
        expect(await conductorTick("cond-1", h.deps)).toEqual({ action: "waiting", in_flight: 0 });
      }
      const r = await conductorTick("cond-1", h.deps);
      expect(r.action).toBe("completed");
      expect(h.site.claimJourneyFix).toHaveBeenCalledTimes(SITE_DEPLOY_STEP_ERROR_LIMIT);
      expect(h.stepCalls).toHaveLength(1);
      expect(h.node("d").payload.site_journey_fix_pending).toBeUndefined();
      expect(h.dispatchRepair).not.toHaveBeenCalled();
      expect(h.deps.consumeBudget).not.toHaveBeenCalled();
      expect(once).not.toHaveBeenCalled();
      expect(h.node("d")).toMatchObject({ status: "failed", failure_class: "deploy_failed" });
      expect(h.node("d").error).toContain(SITE_PUBLISH_PLATFORM_RETRY);
      expect(h.node("d").payload.site_journey_claim_errors).toBeUndefined();
      expect(h.statuses).toEqual(["paused"]);
    });

    it("a claim that recovers on a later tick dispatches the saved fix free and clears the error count", async () => {
      const kept = { names: ["book"], must_pass: ["zavi:brief-journey"], fingerprints: { book: "f1" } };
      const h = harness({ maxRepairs: 0, outcomes: [{ ...deadEnd, journeys: kept }] });
      h.site.claimJourneyFix = vi
        .fn()
        .mockRejectedValueOnce(new Error("timeout"))
        .mockResolvedValueOnce({ status: "claimed", token: "tok-2" });
      expect(await conductorTick("cond-1", h.deps)).toEqual({ action: "waiting", in_flight: 0 });
      const r = await conductorTick("cond-1", h.deps);
      expect(r).toMatchObject({ action: "site_repair_dispatched", attempt: 1 });
      const call = h.dispatchRepair.mock.calls[0][0] as unknown as { payload: Record<string, unknown> };
      expect(call.payload).toMatchObject({ brief_journey_fix: true, brief_journey_fix_token: "tok-2", failure_signal: deadEnd.signal });
      expect(h.stepCalls).toHaveLength(1);
      expect(h.deps.consumeBudget).not.toHaveBeenCalled();
      expect(h.node("d").payload.site_journey_claim_errors).toBeUndefined();
      expect(h.node("d").payload.site_journey_fix_pending).toBeUndefined();
      expect(h.node("d").payload.site_gate_kept).toEqual(kept);
    });

    it("a new commit drops the saved fix and publishes again; a step that stops asking resets the count", async () => {
      const h = harness({ outcomes: [deadEnd, { kind: "waiting" }] });
      h.site.claimJourneyFix = vi.fn(async () => {
        throw new Error("db down");
      });
      await conductorTick("cond-1", h.deps);
      expect(h.node("d").payload.site_journey_claim_errors).toBe(1);
      expect(h.node("d").payload.site_journey_fix_pending).toMatchObject({ sha: "head1" });
      h.site.headSha = vi.fn(async () => "head2");
      await conductorTick("cond-1", h.deps);
      expect(h.stepCalls.map((c) => c.sha)).toEqual(["head1", "head2"]);
      expect(h.node("d").payload.site_journey_claim_errors).toBeUndefined();
      expect(h.node("d").payload.site_journey_fix_pending).toBeUndefined();
    });
  });

  it("a free fix whose dispatch did not start gives the site its free pass back", async () => {
    const h = harness({ outcomes: [{ kind: "repair", signal: "dead end", free_fix: "brief_journey" }] });
    h.site.claimJourneyFix = vi.fn(async () => ({ status: "claimed" as const, token: "tok-1" }));
    const released: unknown[] = [];
    h.site.releaseJourneyFix = vi.fn(async (i) => {
      released.push(i);
    });
    h.dispatchRepair.mockResolvedValueOnce({ ok: false, reason: "kill_switch" } as never);
    await conductorTick("cond-1", h.deps);
    expect(released).toEqual([{ tenant_id: "t1", site_id: SITE, token: "tok-1" }]);
    const inFlight = harness({ outcomes: [{ kind: "repair", signal: "dead end", free_fix: "brief_journey" }] });
    inFlight.site.claimJourneyFix = vi.fn(async () => ({ status: "claimed" as const, token: "tok-1" }));
    inFlight.site.releaseJourneyFix = vi.fn(async () => undefined);
    inFlight.dispatchRepair.mockResolvedValueOnce({ ok: false, reason: "dispatch_in_flight" } as never);
    await conductorTick("cond-1", inFlight.deps);
    expect(inFlight.site.releaseJourneyFix).not.toHaveBeenCalled();
  });

  it("a repair over the lifetime budget halts without dispatching", async () => {
    const h = harness({ consume: "over_cap", outcomes: [{ kind: "repair", signal: "x" }] });
    const r = await conductorTick("cond-1", h.deps);
    expect(r).toEqual({ action: "halted" });
    expect(h.dispatchRepair).not.toHaveBeenCalled();
    expect(h.settled).toEqual(["paused"]);
    expect(h.node("d").status).toBe("failed");
  });

  it("with no site deploy dep a site run fails plainly (never reported live)", async () => {
    const h = harness({ withSite: false });
    const r = await conductorTick("cond-1", h.deps);
    expect(r.action).toBe("completed");
    expect(h.node("d").status).toBe("failed");
    expect(h.hostingStatus).not.toHaveBeenCalled();
  });

  it("a step that keeps throwing fails after the error limit, not forever", async () => {
    const h = harness({});
    (h.site.step as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("r2 blip"));
    for (let i = 0; i < 4; i++) {
      expect((await conductorTick("cond-1", h.deps)).action).toBe("waiting");
    }
    const r = await conductorTick("cond-1", h.deps);
    expect(r.action).toBe("completed");
    expect(h.node("d").error).toContain("r2 blip");
    expect(h.deps.consumeBudget).not.toHaveBeenCalled();
    expect(h.deps.dispatchRepair).not.toHaveBeenCalled();
  });

  describe("no site database capacity (prod 2026-10-02: the only pool shard flipped full for 10 min)", () => {
    const capacity: SiteDeployStepOutcome = { kind: "waiting", reason: "database_capacity" };

    it("waits up to SITE_CAPACITY_WAIT_MS (never on the step error limit), marking the node so the founder is told", async () => {
      let clock = Date.UTC(2026, 9, 2, 22, 0);
      const h = harness({ outcomes: Array.from({ length: 20 }, () => capacity) });
      h.deps.now = () => clock;
      for (let i = 0; i < 7; i++) {
        expect((await conductorTick("cond-1", h.deps)).action).toBe("waiting");
        expect(h.node("d").payload.site_capacity_wait_since).toBe(Date.UTC(2026, 9, 2, 22, 0));
        clock += 2 * 60_000;
      }
      expect(h.node("d").status).toBe("pending");
      expect(h.statuses).toEqual([]);
      expect(h.node("d").payload.site_step_errors).toBeUndefined();
      expect(h.stepCalls.length).toBe(4);
      expect(SITE_CAPACITY_RETRY_MS).toBe(4 * 60_000);
      clock = Date.UTC(2026, 9, 2, 22, 0) + SITE_CAPACITY_WAIT_MS;
      const r = await conductorTick("cond-1", h.deps);
      expect(r).toEqual({ action: "completed", final: "paused" });
      expect(h.node("d")).toMatchObject({ status: "failed", failure_class: "deploy_failed", error: SITE_DATABASE_SLOW });
      expect(h.node("d").payload.site_capacity_wait_since).toBeUndefined();
      expect(h.reasons.join(" ")).not.toMatch(/shard/);
    });

    it("a retry that THROWS during the wait is throttled too", async () => {
      let clock = Date.UTC(2026, 9, 2, 22, 0);
      const h = harness({ outcomes: [capacity] });
      h.deps.now = () => clock;
      await conductorTick("cond-1", h.deps);
      const step = h.site.step as ReturnType<typeof vi.fn>;
      step.mockRejectedValue(new Error("r2 blip"));
      clock += 4 * 60_000;
      await conductorTick("cond-1", h.deps);
      clock += 60_000;
      await conductorTick("cond-1", h.deps);
      clock += 60_000;
      await conductorTick("cond-1", h.deps);
      expect(step).toHaveBeenCalledTimes(2);
    });

    it("capacity coming back clears the marker and the publish carries on", async () => {
      let clock = Date.UTC(2026, 9, 2, 22, 0);
      const h = harness({ outcomes: [capacity, capacity, { kind: "waiting" }, capacity] });
      h.deps.now = () => clock;
      await conductorTick("cond-1", h.deps);
      clock += 10 * 60_000;
      await conductorTick("cond-1", h.deps);
      expect(h.node("d").payload.site_capacity_wait_since).toBe(Date.UTC(2026, 9, 2, 22, 0));
      clock += 4 * 60_000;
      await conductorTick("cond-1", h.deps);
      expect(h.node("d").payload.site_capacity_last_try).toBeUndefined();
      expect(h.node("d").payload.site_capacity_wait_since).toBeUndefined();
      clock += 14 * 60_000;
      await conductorTick("cond-1", h.deps);
      expect(h.node("d").payload.site_capacity_wait_since).toBe(clock);
      expect(h.node("d").status).toBe("pending");
    });
  });

  it("a non-site deploy node still uses the hosting gate (old flow unchanged)", async () => {
    const g = nodes().map((n) => ({ ...n, payload: { ...n.payload } }));
    for (const n of g) delete n.payload.site_id;
    const h = harness({ graph: g });
    await conductorTick("cond-1", h.deps);
    expect(h.hostingStatus).toHaveBeenCalled();
    expect(h.site.step).not.toHaveBeenCalled();
  });
});

describe("a failed site run settles its site", () => {
  function buildFailingGraph(): ConductorNode[] {
    const g = nodes();
    g[1] = { ...g[1], status: "dispatched", child_run_id: "child-build" };
    return g;
  }

  it("build node failure: run failed, site settled 'failed' with the real reason", async () => {
    const h = harness({ graph: buildFailingGraph(), childStatus: "failed", maxRepairs: 0 });
    for (let i = 0; i < 6 && !h.statuses.length; i++) await conductorTick("cond-1", h.deps);
    expect(h.statuses).toEqual(["failed"]);
    expect(h.settled).toEqual(["failed"]);
    expect(h.reasons[0]).toBeTruthy();
    expect(h.reasons[0]).not.toMatch(/without recording a reason/);
  });

  it("a PAUSED run (build done, deploy failed) never marks its site failed: Continue must still be able to push", async () => {
    const h = harness({ outcomes: [{ kind: "failed", reason: "site sandbox gone, start the build again" }] });
    await conductorTick("cond-1", h.deps);
    expect(h.statuses).toEqual(["paused"]);
    expect(h.settled).toEqual(["paused"]);
    expect(h.settled).not.toContain("failed");
  });

  it("a paused run settles its site BEFORE the run is marked paused (a Continue cannot slip in between)", async () => {
    const h = harness({ outcomes: [{ kind: "failed", reason: "x" }] });
    const order: string[] = [];
    const setStatus = h.deps.setStatus;
    h.deps.setStatus = async (id, s, r) => { order.push(`status:${s}`); return setStatus(id, s, r); };
    const settle = h.site.settle!;
    h.site.settle = async (i) => { order.push(`settle:${i.outcome}`); return settle(i); };
    await conductorTick("cond-1", h.deps);
    expect(order).toEqual(["settle:paused", "status:paused"]);
  });

  it("a paused settle that fails transiently is retried (a paused run is never ticked again)", async () => {
    const h = harness({ outcomes: [{ kind: "failed", reason: "x" }] });
    let calls = 0;
    const waits: number[] = [];
    h.deps.sleep = async (ms) => { waits.push(ms); };
    h.site.settle = async () => { calls += 1; if (calls < 3) throw new Error("db blip"); };
    await conductorTick("cond-1", h.deps);
    expect(calls).toBe(3);
    expect(waits).toEqual([250, 1_000]);
    expect(h.statuses).toEqual(["paused"]);
  });

  it("a paused settle that never succeeds gives up after backing off and still pauses the run", async () => {
    const h = harness({ outcomes: [{ kind: "failed", reason: "x" }] });
    let calls = 0;
    const waits: number[] = [];
    h.deps.sleep = async (ms) => { waits.push(ms); };
    h.site.settle = async () => { calls += 1; throw new Error("db down"); };
    await conductorTick("cond-1", h.deps);
    expect(calls).toBe(4);
    expect(waits).toEqual([250, 1_000, 3_000]);
    expect(h.statuses).toEqual(["paused"]);
  });

  it("repair exhausted at deploy: the run pauses and the site is settled out of 'publishing' with the reason", async () => {
    const h = harness({
      maxRepairs: 0,
      outcomes: [{ kind: "repair", signal: "The site's smoke check failed: login journey" }],
    });
    const r = await conductorTick("cond-1", h.deps);
    expect(r).toEqual({ action: "completed", final: "paused" });
    expect(h.node("d")).toMatchObject({ status: "failed", failure_class: "repair_exhausted" });
    expect(h.statuses).toEqual(["paused"]);
    expect(h.settled).toEqual(["paused"]);
    expect(h.reasons[0]).toMatch(/login journey/);
  });

  it("an old-flow run never calls the site settle", async () => {
    const g = buildFailingGraph().map((n) => ({ ...n, payload: { ...n.payload, site_id: undefined } }));
    const h = harness({ graph: g, childStatus: "failed", maxRepairs: 0 });
    for (let i = 0; i < 6 && !h.statuses.length; i++) await conductorTick("cond-1", h.deps);
    expect(h.settled).toEqual([]);
  });
});
