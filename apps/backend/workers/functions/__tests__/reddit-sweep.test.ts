import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  resolveRedditSweep: vi.fn(),
  loadSweepJobs: vi.fn(),
  runSweepJob: vi.fn(),
  runDownstreamStep: vi.fn(),
  finalizeSweep: vi.fn(),
  failRedditSweep: vi.fn(),
}));

vi.mock("../../client", () => ({
  inngest: {
    createFunction: (opts: unknown, trigger: unknown, handler: unknown) => ({ opts, trigger, handler }),
  },
}));
vi.mock("@/services/agents/cron-stopped", () => ({ isWorkerCronStopped: () => true }));
vi.mock("@/services/channels/reddit/sweep", () => ({
  REDDIT_SWEEP_EVENT: "reddit.sweep.requested",
  downstreamSteps: () => [
    { id: "score", paid: true, run: vi.fn() },
    { id: "community-stats", paid: false, run: vi.fn() },
    { id: "google-rank", paid: true, run: vi.fn() },
    { id: "snapshot", paid: false, run: vi.fn() },
  ],
  listSweepableTenants: vi.fn(),
  openRedditSweep: vi.fn(),
  ...m,
}));

import { redditSweepFn } from "../reddit-sweep";

type Handler = (ctx: { event: { data: Record<string, unknown> }; step: { run: (id: string, fn: () => unknown) => unknown } }) => Promise<unknown>;
const handler = (redditSweepFn as unknown as { handler: Handler }).handler;
const onFailure = (redditSweepFn as unknown as { opts: { onFailure: (a: unknown) => Promise<void> } }).opts.onFailure;

const T = "11111111-1111-1111-1111-111111111111";
const S = "22222222-2222-2222-2222-222222222222";
const job = (key: string) => ({ kind: "term", key, term: key });

function run(eventTenant = "someone-else") {
  const ids: string[] = [];
  const step = { run: async (id: string, fn: () => unknown) => (ids.push(id), fn()) };
  return { ids, done: handler({ event: { data: { sweep_id: S, tenant_id: eventTenant } }, step }) };
}

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.resolveRedditSweep.mockResolvedValue({ tenant_id: T, status: "running" });
  m.loadSweepJobs.mockResolvedValue([job("a"), job("b")]);
  m.runSweepJob.mockResolvedValue({ ok: true, posts: 1, comments: 0, mentions: 0 });
  m.runDownstreamStep.mockImplementation(async (ds: { id: string }) =>
    ds.id === "google-rank" ? { ok: true, cost_usd: 0.032 } : { ok: true, cost_usd: 0 },
  );
  m.finalizeSweep.mockResolvedValue({ status: "complete", posts_scanned: 2 });
});

describe("redditSweepFn", () => {
  it("runs exactly the admitted jobs under the row's tenant and charges the reported spend", async () => {
    const r = run();
    expect(await r.done).toMatchObject({ status: "complete", jobs: 2, jobs_failed: 0, step_failures: 0 });
    expect(m.loadSweepJobs).toHaveBeenCalledWith(T, S);
    expect(m.runSweepJob.mock.calls.map((c) => [c[0], c[1], c[2].key])).toEqual([
      [T, S, "a"],
      [T, S, "b"],
    ]);
    expect(r.ids).toEqual(["resolve-sweep", "load-jobs", "job-a", "job-b", "score", "community-stats", "google-rank", "snapshot", "finalize"]);
    const ran = { jobs_done: 2, jobs_failed: 0 };
    expect(m.finalizeSweep).toHaveBeenCalledWith(T, S, { step_failures: 0, spend_usd: 0.032, ran });
    for (const c of m.runDownstreamStep.mock.calls) expect(c[4]).toEqual(ran);
  });

  it("stops running jobs and downstream steps once the sweep is closed under it", async () => {
    m.loadSweepJobs.mockResolvedValue([job("a"), job("b"), job("c")]);
    m.runSweepJob
      .mockResolvedValueOnce({ ok: true, posts: 1, comments: 0, mentions: 0 })
      .mockResolvedValueOnce({ ok: false, posts: 0, comments: 0, mentions: 0, error: "sweep_not_running" });
    m.runDownstreamStep.mockResolvedValue({ ok: true, cost_usd: 0, skipped: "sweep_not_running" });
    const r = run();
    expect(await r.done).toMatchObject({ jobs_failed: 0 });
    expect(m.runSweepJob).toHaveBeenCalledTimes(2);
    expect(m.runDownstreamStep).toHaveBeenCalledTimes(1);
    expect(m.finalizeSweep).toHaveBeenCalledWith(T, S, { step_failures: 0, spend_usd: 0, ran: { jobs_done: 1, jobs_failed: 0 } });
  });

  it("counts failed steps and still adds spend from a step that failed after paying", async () => {
    m.runDownstreamStep.mockImplementation(async (ds: { id: string }) =>
      ds.id === "google-rank" ? { ok: false, cost_usd: 0.012, error: "write failed" } : { ok: true, cost_usd: 0 },
    );
    await run().done;
    expect(m.finalizeSweep).toHaveBeenCalledWith(T, S, { step_failures: 1, spend_usd: 0.012, ran: { jobs_done: 2, jobs_failed: 0 } });
  });

  it("skips a sweep that is not running", async () => {
    m.resolveRedditSweep.mockResolvedValue({ tenant_id: T, status: "failed" });
    expect(await run().done).toEqual({ status: "skip", reason: "sweep_failed" });
    expect(m.loadSweepJobs).not.toHaveBeenCalled();
  });

  it("onFailure fails the sweep under the row's tenant", async () => {
    await onFailure({ event: { data: { event: { data: { sweep_id: S, tenant_id: "spoofed" } } } } });
    expect(m.failRedditSweep).toHaveBeenCalledWith(T, S, "worker_failed");
  });
});
