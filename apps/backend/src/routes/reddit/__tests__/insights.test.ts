import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  build: vi.fn(),
  open: vi.fn(),
  runningRows: [] as unknown[],
  manualRows: [] as unknown[],
  runningError: null as null | { message: string },
  manualError: null as null | { message: string },
  calls: [] as Array<{ table: string; ops: Array<[string, unknown[]]> }>,
}));

const fakeDb = {
  from(table: string) {
    const rec = { table, ops: [] as Array<[string, unknown[]]> };
    mocks.calls.push(rec);
    const chain: Record<string, (...a: unknown[]) => unknown> = {};
    for (const op of ["select", "eq", "gt", "or", "order"]) {
      chain[op] = (...a: unknown[]) => {
        rec.ops.push([op, a]);
        return chain;
      };
    }
    chain.limit = (...a: unknown[]) => {
      rec.ops.push(["limit", a]);
      const running = rec.ops.some(([o, args]) => o === "eq" && args[0] === "status" && args[1] === "running");
      return Promise.resolve(
        running
          ? { data: mocks.runningRows, error: mocks.runningError }
          : { data: mocks.manualRows, error: mocks.manualError },
      );
    };
    return chain;
  },
};

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/channels/reddit/db", () => ({ redditDb: () => fakeDb }));
vi.mock("@/services/channels/reddit/insights", () => ({ buildRedditInsights: mocks.build }));
vi.mock("@/services/channels/reddit/sweep", () => ({ openRedditSweep: mocks.open }));
vi.mock("@/services/growth/preview-plan", async (orig) =>
  (await import("@/__tests__/helpers/tenant-plan")).previewPlanOn(orig));

import { redditInsightsGet, redditSweepPost } from "../insights";
import { resetTenantPlan, tenantPlan } from "@/__tests__/helpers/tenant-plan";

const mkRes = () => {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; body: any };
};
const mkReq = (body: unknown = {}, query: Record<string, string> = {}) => ({ body, query, params: {} }) as unknown as Request;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  mocks.runningRows = [];
  mocks.manualRows = [];
  mocks.runningError = null;
  mocks.manualError = null;
  mocks.calls = [];
  resetTenantPlan();
  mocks.requireAuth.mockResolvedValue({ user_id: "u1", tenant_id: "t1", access_token: "tok" });
  mocks.build.mockResolvedValue({ has_data: false });
  mocks.open.mockResolvedValue({ ok: true, sweep_id: "sw1" });
});

describe("GET /api/reddit/insights", () => {
  it("stops at auth", async () => {
    mocks.requireAuth.mockResolvedValue(null);
    await redditInsightsGet(mkReq(), mkRes());
    expect(mocks.build).not.toHaveBeenCalled();
  });

  it("reads the authenticated tenant only, ignoring any tenant in the request", async () => {
    const res = mkRes();
    await redditInsightsGet(mkReq({ tenant_id: "evil" }, { tenant_id: "evil" }), res);
    expect(mocks.build).toHaveBeenCalledWith(fakeDb, "t1");
    expect(res.body).toEqual({ has_data: false });
  });

  it("500s without leaking the error", async () => {
    mocks.build.mockRejectedValue(new Error("relation does not exist"));
    const res = mkRes();
    await redditInsightsGet(mkReq(), res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "reddit_insights_failed" });
  });
});

describe("POST /api/reddit/sweep", () => {
  it("stops at auth", async () => {
    mocks.requireAuth.mockResolvedValue(null);
    await redditSweepPost(mkReq(), mkRes());
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("starts a manual sweep by default with the tenant and user from auth", async () => {
    const res = mkRes();
    await redditSweepPost(mkReq({ tenant_id: "evil" }), res);
    expect(mocks.open).toHaveBeenCalledWith("t1", { trigger: "manual", requestedBy: "u1" });
    expect(res.statusCode).toBe(202);
    expect(res.body).toEqual({ sweep_id: "sw1" });
  });

  it("rejects an unknown trigger (cron is not client-callable)", async () => {
    const res = mkRes();
    await redditSweepPost(mkReq({ trigger: "cron" }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ reason: "invalid_request" });
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it.each([
    ["already_running", 409, "A scan is already running."],
    ["tenant_cap_reached", 429, "This week's scan budget is used up. Scans resume as the 7-day window rolls."],
    ["fleet_cap_reached", 429, "Zavi has hit today's Reddit scan limit across all workspaces. Try again tomorrow."],
    ["nothing_to_scan", 422, null],
    ["disabled", 422, null],
    ["not_configured", 422, null],
    ["admission_failed", 502, null],
    ["enqueue_failed", 502, null],
  ])("maps %s to %i with its plain message", async (reason, status, message) => {
    mocks.open.mockResolvedValue({ ok: false, reason });
    const res = mkRes();
    await redditSweepPost(mkReq(), res);
    expect(res.statusCode).toBe(status);
    expect(res.body).toEqual(message ? { reason, message } : { reason });
  });

  it("502s when opening throws", async () => {
    mocks.open.mockRejectedValue(new Error("boom"));
    const res = mkRes();
    await redditSweepPost(mkReq(), res);
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ reason: "sweep_failed" });
  });

  it("rejects any trigger but manual — a sweep spends money, so only a human click opens one", async () => {
    const res = mkRes();
    await redditSweepPost(mkReq({ trigger: "auto" }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ reason: "invalid_request" });
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("409s already_running from a live running row and never opens (pays for) a second sweep", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-18T12:00:00Z"));
    mocks.runningRows = [{ id: "sw0" }];
    const res = mkRes();
    await redditSweepPost(mkReq(), res);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ reason: "already_running", message: "A scan is already running." });
    expect(mocks.open).not.toHaveBeenCalled();
    const q = mocks.calls[0];
    expect(q.table).toBe("reddit_sweeps");
    expect(q.ops).toEqual(
      expect.arrayContaining([
        ["eq", ["tenant_id", "t1"]],
        ["eq", ["status", "running"]],
        ["gt", ["heartbeat_at", "2026-09-18T11:00:00.000Z"]],
      ]),
    );
  });

  it("429s rate_limited from the last manual reddit_sweeps row, minutes rounded up, and never opens a sweep", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-18T12:04:00Z"));
    mocks.manualRows = [{ started_at: "2026-09-18T12:00:00Z" }];
    const res = mkRes();
    await redditSweepPost(mkReq(), res);
    expect(res.statusCode).toBe(429);
    expect(res.body).toEqual({
      reason: "rate_limited",
      message: "A scan ran a few minutes ago. Try again in 6 minutes.",
      retry_after_s: 360,
    });
    expect(mocks.open).not.toHaveBeenCalled();
    const q = mocks.calls[1];
    expect(q.ops).toEqual(
      expect.arrayContaining([
        ["eq", ["tenant_id", "t1"]],
        ["eq", ["trigger", "manual"]],
        ["gt", ["started_at", "2026-09-18T11:54:00.000Z"]],
        ["or", ["error_code.is.null,error_code.neq.enqueue_failed"]],
      ]),
    );
  });

  it("says '1 minute' (singular) with under a minute left", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-18T12:09:30Z"));
    mocks.manualRows = [{ started_at: "2026-09-18T12:00:00Z" }];
    const res = mkRes();
    await redditSweepPost(mkReq(), res);
    expect(res.body).toEqual({
      reason: "rate_limited",
      message: "A scan ran a few minutes ago. Try again in 1 minute.",
      retry_after_s: 30,
    });
  });

  it("opens when no recent manual sweep exists", async () => {
    mocks.manualRows = [{ started_at: null }];
    const res = mkRes();
    await redditSweepPost(mkReq(), res);
    expect(res.statusCode).toBe(202);
    expect(mocks.open).toHaveBeenCalledTimes(1);
  });

  it.each([["running"], ["cooldown"]])("fails closed (502, no sweep) when the %s read errors", async (which) => {
    if (which === "running") mocks.runningError = { message: "boom" };
    else mocks.manualError = { message: "boom" };
    const res = mkRes();
    await redditSweepPost(mkReq(), res);
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ reason: "sweep_failed" });
    expect(mocks.open).not.toHaveBeenCalled();
  });
});

describe("POST /api/reddit/sweep, the plan", () => {
  it("Free: 403 with the upgrade body plus a flat reason and message, no DB read, no sweep opened", async () => {
    tenantPlan.tier = "free";
    const res = mkRes();
    await redditSweepPost(mkReq(), res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe("plan_upgrade_required");
    expect(res.body.reason).toBe("plan_upgrade_required");
    expect(typeof res.body.message).toBe("string");
    expect(res.body.message.length).toBeGreaterThan(0);
    expect(res.body.message).toBe(res.body.error.message);
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.calls).toEqual([]);

    tenantPlan.tier = "starter";
    const after = mkRes();
    await redditSweepPost(mkReq(), after);
    expect(after.statusCode).toBe(202);
  });

  it("an unreadable plan refuses rather than scanning", async () => {
    tenantPlan.unreadable = true;
    const res = mkRes();
    await redditSweepPost(mkReq(), res);
    expect(res.statusCode).toBe(403);
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("Starter: the scan opens", async () => {
    tenantPlan.tier = "starter";
    const res = mkRes();
    await redditSweepPost(mkReq(), res);
    expect(res.statusCode).toBe(202);
    expect(mocks.open).toHaveBeenCalledTimes(1);
  });
});
