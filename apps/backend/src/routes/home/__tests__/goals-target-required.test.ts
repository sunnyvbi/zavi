
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  createFounderGoalServiceRole: vi.fn(),
  role: "owner" as string,
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: vi.fn(async (_auth: unknown, allowed: readonly string[], res: import("express").Response) => {
    if (allowed.includes(mocks.role)) return true;
    res.status(403).json({ error: { code: "forbidden", message: "role" } });
    return false;
  }),
}));
vi.mock("@/routes/workspace/autopilot", () => ({
  createFounderGoalServiceRole: mocks.createFounderGoalServiceRole,
}));
vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
      }),
    }),
  }),
}));

import { postHomeGoal } from "../goals";

function mockRes() {
  const res: Record<string, unknown> = {};
  res.statusCode = 200;
  res.status = vi.fn((c: number) => {
    res.statusCode = c;
    return res;
  });
  res.json = vi.fn((b: unknown) => {
    res.body = b;
    return res;
  });
  return res as unknown as import("express").Response & {
    statusCode: number;
    body: { ok?: boolean; error?: { code: string; message: string } };
  };
}

function req(body: Record<string, unknown>) {
  return { body, headers: {} } as unknown as import("express").Request;
}

beforeEach(() => {
  mocks.role = "owner";
  mocks.requireAuth.mockReset();
  mocks.createFounderGoalServiceRole.mockReset();
  mocks.requireAuth.mockResolvedValue({
    user_id: "u1",
    tenant_id: "t-1",
    access_token: "tok",
  });
  mocks.createFounderGoalServiceRole.mockResolvedValue({ ok: true, id: "g-1" });
});

const BASE = { objective: "Grow verified hosts", target_metric: "hosts" };

describe("POST /api/home/goals — a target is required, never defaulted to 0", () => {
  it("an OMITTED target is rejected, and nothing is written", async () => {
    const res = mockRes();
    await postHomeGoal(req({ ...BASE }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error?.code).toBe("bad_request");
    expect(res.body.error?.message).toMatch(/^Add a number to your goal/);
    expect(res.body.error?.message).not.toMatch(/expected|received|undefined/i);
    expect(mocks.createFounderGoalServiceRole).not.toHaveBeenCalled();
  });

  it("a NULL target is rejected too, with the same instruction", async () => {
    const res = mockRes();
    await postHomeGoal(req({ ...BASE, target_value: null }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error?.message).toMatch(/^Add a number to your goal/);
    expect(mocks.createFounderGoalServiceRole).not.toHaveBeenCalled();
  });

  it("an EXPLICIT 0 is a real target and is honoured", async () => {
    const res = mockRes();
    await postHomeGoal(req({ ...BASE, target_metric: "churn", target_value: 0 }), res);
    expect(res.statusCode).toBe(200);
    expect(mocks.createFounderGoalServiceRole).toHaveBeenCalledTimes(1);
    expect(mocks.createFounderGoalServiceRole.mock.calls[0][0]).toMatchObject({
      target_value: 0,
    });
  });

  it("a real target still goes through unchanged", async () => {
    const res = mockRes();
    await postHomeGoal(req({ ...BASE, target_value: 800 }), res);
    expect(res.statusCode).toBe(200);
    expect(mocks.createFounderGoalServiceRole.mock.calls[0][0]).toMatchObject({
      target_value: 800,
    });
  });
});

describe("POST /api/home/goals: measurement_mode", () => {
  const args = () => mocks.createFounderGoalServiceRole.mock.calls[0][0] as { measurementMode?: string };

  it("defaults to manual_reported, even for a metric a source could read", async () => {
    const res = mockRes();
    await postHomeGoal(req({ objective: "Grow MRR", target_metric: "mrr", target_value: 5000 }), res);
    expect(res.statusCode).toBe(200);
    expect(args().measurementMode).toBe("manual_reported");
  });

  it("accepts auto when asked for and a source can read the metric", async () => {
    const res = mockRes();
    await postHomeGoal(
      req({ objective: "Grow MRR", target_metric: "mrr", target_value: 5000, measurement_mode: "auto" }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(args().measurementMode).toBe("auto");
  });

  it("rejects auto for a metric no source can read, before writing", async () => {
    const res = mockRes();
    await postHomeGoal(
      req({ objective: "Book more parent tours", target_metric: "parent tours", target_value: 10, measurement_mode: "auto" }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error?.code).toBe("measurement_unavailable");
    expect(mocks.createFounderGoalServiceRole).not.toHaveBeenCalled();
  });
});

describe("POST /api/home/goals: a failed mode write is said out loud", () => {
  it("returns the warning instead of a plain success", async () => {
    mocks.createFounderGoalServiceRole.mockResolvedValue({
      ok: true,
      id: "g-1",
      warning: "The goal was saved, but how it is measured was not.",
    });
    const res = mockRes();
    await postHomeGoal(req({ objective: "Grow MRR", target_metric: "mrr", target_value: 5000 }), res);
    expect(res.statusCode).toBe(200);
    expect((res.body as { warnings?: string[] }).warnings).toEqual([
      "The goal was saved, but how it is measured was not.",
    ]);
  });
});

describe("POST /api/home/goals: owner/admin only", () => {
  it("a member is refused and nothing is written", async () => {
    mocks.role = "member";
    const res = mockRes();
    await postHomeGoal(req({ objective: "Grow MRR to 5000", target_metric: "mrr", target_value: 5000 }), res);
    expect(res.statusCode).toBe(403);
    expect(mocks.createFounderGoalServiceRole).not.toHaveBeenCalled();
  });
});
