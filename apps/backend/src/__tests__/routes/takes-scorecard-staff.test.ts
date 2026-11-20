
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const STAFF_USER = "11111111-1111-1111-1111-111111111111";

vi.mock("@/services/auth/staff-middleware", () => ({
  assertStaff: vi.fn(() => ({ user_id: STAFF_USER, email: "ravi@zaviagent.com" })),
}));

vi.mock("@/services/memory/takes-service", () => ({
  computeScorecard: vi.fn(async (tenant_id: string) => ({
    brier: 0.18,
    brier_n: 100,
    directional_accuracy: 0.73,
    directional_accuracy_n: 100,
    actual_rate: 0.71,
    actual_rate_n: 100,
    calibration_curve: [],
    _tenant: tenant_id,
  })),
}));

function mockResponse(): Response {
  let statusCode = 200;
  let body: unknown = null;
  const res: Partial<Response> = {
    status: vi.fn((c: number) => {
      statusCode = c;
      return res as Response;
    }),
    json: vi.fn((obj: unknown) => {
      body = obj;
      return res as Response;
    }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (res as any)._inspect = () => ({ statusCode, body });
  return res as Response;
}

function mockRequest(query: Record<string, string>): Request {
  return {
    query,
    staff: { user_id: STAFF_USER, email: "ravi@zaviagent.com" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("staffTakesScorecard", () => {
  it("happy: returns envelope for queried tenant_id", async () => {
    const { staffTakesScorecard } = await import("../../routes/admin/takes-scorecard");
    const req = mockRequest({ tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204" });
    const res = mockResponse();
    await staffTakesScorecard(req, res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (res as any)._inspect();
    expect(r.statusCode).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.report.brier).toBe(0.18);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((r.body.report as any)._tenant).toBe("73db45ff-457e-4541-bc8f-bdb625390204");
  });

  it("rejects missing tenant_id with 400", async () => {
    const { staffTakesScorecard } = await import("../../routes/admin/takes-scorecard");
    const req = mockRequest({});
    const res = mockResponse();
    await staffTakesScorecard(req, res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((res as any)._inspect().statusCode).toBe(400);
  });

  it("rejects non-uuid tenant_id", async () => {
    const { staffTakesScorecard } = await import("../../routes/admin/takes-scorecard");
    const req = mockRequest({ tenant_id: "not-a-uuid" });
    const res = mockResponse();
    await staffTakesScorecard(req, res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((res as any)._inspect().statusCode).toBe(400);
  });
});
