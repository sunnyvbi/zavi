
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const AUTH_TENANT = "11111111-1111-1111-1111-111111111111";

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ tenant_id: AUTH_TENANT, user_id: "u", access_token: "t" })),
}));
vi.mock("@/services/settings", () => ({
  getBoolSetting: vi.fn(async () => true),
  getSetting: vi.fn(async () => []),
  setTenantSetting: vi.fn(async () => undefined),
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: async () => {} }));

const state: {
  snapshotCount: number;
  agentRunsQueue: unknown[][];
  attemptCount: number;
  inFlightError: boolean;
  enqueueResults: Array<string | null>;
  enqueueKeys: string[];
} = { snapshotCount: 0, agentRunsQueue: [], attemptCount: 0, inFlightError: false, enqueueResults: [], enqueueKeys: [] };

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      const c: Record<string, unknown> = {};
      let isCount = false;
      for (const m of ["eq", "in", "like", "limit"]) c[m] = () => c;
      c.select = (_cols: string, opts?: { head?: boolean }) => ((isCount = !!opts?.head), c);
      c.then = (res: (v: unknown) => unknown) =>
        Promise.resolve(
          table === "competitor_snapshots"
            ? { count: state.snapshotCount, error: null }
            : isCount
              ? { count: state.attemptCount, error: null }
              : state.inFlightError
                ? { data: null, error: { message: "boom" } }
                : { data: state.agentRunsQueue.shift() ?? [], error: null },
        ).then(res);
      return c;
    },
  }),
}));

const enqueue = vi.fn(async (_tenant: string, opts: { dedupe_key: string }) => {
  state.enqueueKeys.push(opts.dedupe_key);
  return { run_id: state.enqueueResults.shift() ?? null };
});
vi.mock("@/services/competitor-intel/scan", () => ({
  enqueueCompetitorScan: (...a: [string, { dedupe_key: string }]) => enqueue(...a),
}));

import { postCompetitorFirstScan } from "../../routes/competitor-intel";

function resSpy() {
  const out: { status: number; body: unknown } = { status: 200, body: null };
  const res = {
    status: (s: number) => ((out.status = s), res),
    json: (b: unknown) => ((out.body = b), res),
  } as unknown as Response;
  return { res, out };
}

beforeEach(() => {
  state.snapshotCount = 0;
  state.agentRunsQueue = [];
  state.attemptCount = 0;
  state.inFlightError = false;
  state.enqueueResults = [];
  state.enqueueKeys = [];
  enqueue.mockClear();
});

const BASE = new RegExp(`^competitor-intel-firstscan:${AUTH_TENANT}:[^:]+$`);

describe("POST /api/competitor-intel/first-scan", () => {
  it("uses the week key on the first attempt", async () => {
    state.enqueueResults = ["run-1"];
    const { res, out } = resSpy();
    await postCompetitorFirstScan({} as Request, res);
    expect(out.body).toEqual({ status: "started", run_id: "run-1" });
    expect(state.enqueueKeys).toHaveLength(1);
    expect(state.enqueueKeys[0]).toMatch(BASE);
  });

  it("retries a failed attempt under an attempt-scoped key, with one enqueue", async () => {
    state.attemptCount = 1;
    state.enqueueResults = ["run-2"];
    const { res, out } = resSpy();
    await postCompetitorFirstScan({} as Request, res);
    expect(out.body).toEqual({ status: "started", run_id: "run-2" });
    expect(state.enqueueKeys).toHaveLength(1);
    expect(state.enqueueKeys[0]).toMatch(/:r1$/);
    expect(state.enqueueKeys[0].replace(/:r1$/, "")).toMatch(BASE);
  });

  it("answers already_running when a twin holds the same key", async () => {
    state.enqueueResults = [null];
    const { res, out } = resSpy();
    await postCompetitorFirstScan({} as Request, res);
    expect(out.body).toEqual({ status: "already_running" });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("does not enqueue while a scan is in flight", async () => {
    state.attemptCount = 1;
    state.agentRunsQueue = [[{ id: "live" }]];
    const { res, out } = resSpy();
    await postCompetitorFirstScan({} as Request, res);
    expect(out.body).toEqual({ status: "already_running" });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("fails closed when the in-flight check cannot be read", async () => {
    state.attemptCount = 1;
    state.inFlightError = true;
    const { res, out } = resSpy();
    await postCompetitorFirstScan({} as Request, res);
    expect(out.status).toBe(500);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
