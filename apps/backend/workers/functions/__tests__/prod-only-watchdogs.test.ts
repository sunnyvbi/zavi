import { describe, it, expect, vi, afterEach } from "vitest";

const svcCalls = vi.fn();
vi.mock("@/services/supabase", () => ({
  serviceClient: () => {
    svcCalls();
    throw new Error("touched prod data");
  },
}));
const sweep = vi.fn(async () => ({ scanned: 0 }));
vi.mock("@/services/agents/operator-followthrough-sweep", () => ({
  sweepOperatorFollowthrough: () => sweep(),
}));
const reap = vi.fn(async () => ({ blocked_reaped: 0, queued_reaped: 0, conductor_provisioning_reaped: 0, conductor_active_reaped: 0 }));
vi.mock("@/services/agents/stale-run-reaper", () => ({ reapStaleRuns: () => reap() }));
vi.mock("../../client", () => ({
  inngest: {
    createFunction: (_c: unknown, _t: unknown, handler: unknown) => ({ handler }),
    send: vi.fn(),
  },
}));

import { queuedStuckScanFn } from "../queued-stuck-scan";
import { operatorFollowthroughSweepFn } from "../operator-followthrough-sweep";
import { staleRunReaperFn } from "../stale-run-reaper";

type Handler = (ctx: { logger: { info: () => void; warn: () => void; error: () => void } }) => Promise<unknown>;
const run = (fn: unknown) =>
  (fn as { handler: Handler }).handler({ logger: { info: () => {}, warn: () => {}, error: () => {} } });

afterEach(() => {
  delete process.env.PRAXIS_CONTAINER_ROLE;
  delete process.env.PRAXIS_DRAIN_SHARED_QUEUE;
  svcCalls.mockClear();
  sweep.mockClear();
  reap.mockClear();
});

describe("prod-only watchdogs", () => {
  it("queued-stuck-scan does nothing on a local stack, before touching data", async () => {
    await expect(run(queuedStuckScanFn)).resolves.toEqual({ skipped: "not_canonical" });
    expect(svcCalls).not.toHaveBeenCalled();
  });

  it("queued-stuck-scan runs on the prod container", async () => {
    process.env.PRAXIS_CONTAINER_ROLE = "canonical";
    await expect(run(queuedStuckScanFn)).rejects.toThrow("touched prod data");
    expect(svcCalls).toHaveBeenCalled();
  });

  it("operator-followthrough-sweep does nothing on a local stack", async () => {
    await expect(run(operatorFollowthroughSweepFn)).resolves.toEqual({ skipped: "not_canonical" });
    expect(sweep).not.toHaveBeenCalled();
  });

  it("operator-followthrough-sweep runs on prod", async () => {
    process.env.PRAXIS_CONTAINER_ROLE = "canonical";
    await run(operatorFollowthroughSweepFn);
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it("the shared-queue opt-in does NOT re-enable the watchdogs on a laptop", async () => {
    process.env.PRAXIS_DRAIN_SHARED_QUEUE = "1";
    await expect(run(queuedStuckScanFn)).resolves.toEqual({ skipped: "not_canonical" });
    await expect(run(operatorFollowthroughSweepFn)).resolves.toEqual({ skipped: "not_canonical" });
    await expect(run(staleRunReaperFn)).resolves.toEqual({ skipped: "not_canonical" });
    expect(svcCalls).not.toHaveBeenCalled();
    expect(sweep).not.toHaveBeenCalled();
    expect(reap).not.toHaveBeenCalled();
  });

  it("stale-run-reaper runs on prod", async () => {
    process.env.PRAXIS_CONTAINER_ROLE = "canonical";
    await expect(run(staleRunReaperFn)).rejects.toThrow("touched prod data");
  });
});
