import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => {
  const state: {
    ids: Array<{ id: string }>;
    scanError: string | null;
    lteArgs: Array<[string, string]>;
  } = { ids: [{ id: "d1" }, { id: "d2" }], scanError: null, lteArgs: [] };

  const builder: Record<string, unknown> = {};
  for (const meth of ["select", "eq", "in", "limit", "maybeSingle"]) {
    builder[meth] = vi.fn(() => builder);
  }
  builder.lte = vi.fn((col: string, val: string) => {
    state.lteArgs.push([col, val]);
    return builder;
  });
  builder.then = (resolve: (v: unknown) => void) =>
    resolve({ data: state.scanError ? null : state.ids, error: state.scanError ? { message: state.scanError } : null });

  const fromFn = vi.fn(() => builder);
  const serviceClient = vi.fn(() => ({ from: fromFn }));

  type BatchResult = {
    total: number;
    approved?: number;
    rejected?: number;
    skipped: number;
    errored: number;
    results: unknown[];
    aborted?: { reason: string };
  };
  const approveBatch = vi.fn(
    async (_a: unknown): Promise<BatchResult> => ({ total: 2, approved: 1, skipped: 1, errored: 0, results: [] }),
  );
  const rejectBatch = vi.fn(
    async (_a: unknown): Promise<BatchResult> => ({ total: 2, rejected: 2, skipped: 0, errored: 0, results: [] }),
  );

  const fetchMock = vi.fn(async (_url: unknown, _init?: { body?: string }) => ({ ok: true }));

  return { state, builder, fromFn, serviceClient, approveBatch, rejectBatch, fetchMock };
});

vi.mock("../client", () => ({
  inngest: { createFunction: (_c: unknown, _t: unknown, _f: unknown) => ({ id: "stub" }) },
}));
vi.mock("@/services/supabase", () => ({ serviceClient: m.serviceClient }));
vi.mock("@/services/staff/capture-admin-correction", () => ({ captureAdminCorrection: vi.fn(async () => {}) }));
vi.mock("@/services/approvals/batch-decide-service", () => ({
  approveBatch: m.approveBatch,
  rejectBatch: m.rejectBatch,
}));

vi.stubGlobal("fetch", m.fetchMock);

import { runSlackBatchDecide } from "../slack-batch-decide";

const BASE = {
  tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204",
  run_id: "30000000-0000-0000-0000-000000000077",
  actor_user_id: "u-approver",
  cutoff_ms: 1782636000000,
  response_url: "https://hooks.slack.com/actions/RESP",
};

beforeEach(() => {
  m.state.ids = [{ id: "d1" }, { id: "d2" }];
  m.state.scanError = null;
  m.state.lteArgs = [];
  m.approveBatch.mockClear();
  m.rejectBatch.mockClear();
  m.fetchMock.mockClear();
});

describe("runSlackBatchDecide", () => {
  it("approve: re-derives ids server-side, applies cutoff, calls approveBatch with loadMeta", async () => {
    const res = await runSlackBatchDecide({ ...BASE, action: "approve" });
    expect(m.approveBatch).toHaveBeenCalledTimes(1);
    const arg = m.approveBatch.mock.calls[0][0] as { decision_ids: string[]; loadMeta: unknown };
    expect(arg.decision_ids).toEqual(["d1", "d2"]);
    expect(typeof arg.loadMeta).toBe("function");
    expect(m.state.lteArgs[0][0]).toBe("emitted_at");
    expect(res).toEqual({ total: 2, applied: 1, skipped: 1, errored: 0 });
    expect(m.fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(m.fetchMock.mock.calls[0][1]!.body!);
    expect(body.text).toContain("Approved 1");
    expect(body.text).toContain("skipped");
  });

  it("reject: calls rejectBatch with captureReject (no money exclusion)", async () => {
    const res = await runSlackBatchDecide({ ...BASE, action: "reject" });
    expect(m.rejectBatch).toHaveBeenCalledTimes(1);
    expect(m.approveBatch).not.toHaveBeenCalled();
    const arg = m.rejectBatch.mock.calls[0][0] as { decision_ids: string[]; captureReject: unknown };
    expect(arg.decision_ids).toEqual(["d1", "d2"]);
    expect(typeof arg.captureReject).toBe("function");
    expect(res.applied).toBe(2);
  });

  it("no cutoff (0) → no emitted_at filter applied", async () => {
    await runSlackBatchDecide({ ...BASE, cutoff_ms: 0, action: "approve" });
    expect(m.state.lteArgs.length).toBe(0);
  });

  it("empty pending set → no batch call, posts 'nothing left'", async () => {
    m.state.ids = [];
    const res = await runSlackBatchDecide({ ...BASE, action: "approve" });
    expect(m.approveBatch).not.toHaveBeenCalled();
    expect(res).toEqual({ total: 0, applied: 0, skipped: 0, errored: 0 });
    const body = JSON.parse(m.fetchMock.mock.calls[0][1]!.body!);
    expect(body.text).toContain("Nothing left");
  });

  it("approve fail-closed (aborted) → approves zero, posts warning", async () => {
    m.approveBatch.mockResolvedValueOnce({ total: 2, skipped: 0, errored: 0, results: [], aborted: { reason: "lookup" } });
    const res = await runSlackBatchDecide({ ...BASE, action: "approve" });
    expect(res.applied).toBe(0);
    const body = JSON.parse(m.fetchMock.mock.calls[0][1]!.body!);
    expect(body.text).toContain("nothing approved");
  });

  it("scan error → no batch call, posts error, returns zeros", async () => {
    m.state.scanError = "boom";
    const res = await runSlackBatchDecide({ ...BASE, action: "approve" });
    expect(m.approveBatch).not.toHaveBeenCalled();
    expect(res).toEqual({ total: 0, applied: 0, skipped: 0, errored: 0 });
  });
});
