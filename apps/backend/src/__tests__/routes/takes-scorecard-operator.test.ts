
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const AUTH_TENANT = "11111111-1111-1111-1111-111111111111";

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ tenant_id: AUTH_TENANT, user_id: "u" })),
}));

let _returnPopulated = false;

vi.mock("@/services/memory/takes-service", () => ({
  computeScorecard: vi.fn(async (tenant_id: string) =>
    _returnPopulated
      ? {
          brier: 0.18,
          brier_n: 100,
          directional_accuracy: 0.73,
          directional_accuracy_n: 100,
          actual_rate: 0.71,
          actual_rate_n: 100,
          calibration_curve: [],
          _tenant: tenant_id,
        }
      : {
          brier: null,
          brier_n: 0,
          directional_accuracy: null,
          directional_accuracy_n: 0,
          actual_rate: null,
          actual_rate_n: 0,
          calibration_curve: [],
          _tenant: tenant_id,
        },
  ),
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
  return { query } as unknown as Request;
}

beforeEach(() => {
  vi.clearAllMocks();
  _returnPopulated = false;
});

describe("takesScorecard (operator)", () => {
  it("empty state (brier_n=0): returns 404 no_data_yet (audit hotfix)", async () => {
    _returnPopulated = false;
    const { takesScorecard } = await import("../../routes/takes/scorecard");
    const req = mockRequest({});
    const res = mockResponse();
    await takesScorecard(req, res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (res as any)._inspect();
    expect(r.statusCode).toBe(404);
    expect(r.body.error.code).toBe("no_data_yet");
  });

  it("data present: returns 200 + envelope w/ tenant_id from auth", async () => {
    _returnPopulated = true;
    const { takesScorecard } = await import("../../routes/takes/scorecard");
    const req = mockRequest({});
    const res = mockResponse();
    await takesScorecard(req, res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (res as any)._inspect();
    expect(r.statusCode).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.report.brier).toBe(0.18);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((r.body.report as any)._tenant).toBe(AUTH_TENANT);
  });

  it("rejects tenant_id query param with 400 tenant_id_not_allowed", async () => {
    const { takesScorecard } = await import("../../routes/takes/scorecard");
    const req = mockRequest({ tenant_id: "22222222-2222-2222-2222-222222222222" });
    const res = mockResponse();
    await takesScorecard(req, res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (res as any)._inspect();
    expect(r.statusCode).toBe(400);
    expect(r.body.error.code).toBe("tenant_id_not_allowed");
  });

  it("rejects malformed since with 400 invalid_query", async () => {
    const { takesScorecard } = await import("../../routes/takes/scorecard");
    const req = mockRequest({ since: "not-a-date" });
    const res = mockResponse();
    await takesScorecard(req, res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (res as any)._inspect();
    expect(r.statusCode).toBe(400);
    expect(r.body.error.code).toBe("invalid_query");
  });

  it("rejects unknown query field (strict zod)", async () => {
    const { takesScorecard } = await import("../../routes/takes/scorecard");
    const req = mockRequest({ bogus_field: "x" });
    const res = mockResponse();
    await takesScorecard(req, res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((res as any)._inspect().statusCode).toBe(400);
  });

  it("rejects until<since with 400 invalid_range", async () => {
    const { takesScorecard } = await import("../../routes/takes/scorecard");
    const req = mockRequest({
      since: "2026-05-10T00:00:00.000Z",
      until: "2026-05-01T00:00:00.000Z",
    });
    const res = mockResponse();
    await takesScorecard(req, res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (res as any)._inspect();
    expect(r.statusCode).toBe(400);
    expect(r.body.error.code).toBe("invalid_range");
  });

  it("rejects range>365 days", async () => {
    const { takesScorecard } = await import("../../routes/takes/scorecard");
    const req = mockRequest({
      since: "2024-01-01T00:00:00.000Z",
      until: "2026-05-18T00:00:00.000Z",
    });
    const res = mockResponse();
    await takesScorecard(req, res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (res as any)._inspect();
    expect(r.statusCode).toBe(400);
    expect(r.body.error.code).toBe("range_too_large");
  });
});
