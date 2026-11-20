
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const AUTH_TENANT = "11111111-1111-1111-1111-111111111111";

let _authed = true;
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async (_req: Request, res: Response) => {
    if (_authed) return { tenant_id: AUTH_TENANT, user_id: "u", access_token: "t" };
    res.status(401).json({ error: { code: "unauthenticated", message: "no" } });
    return null;
  }),
}));

let _isAdmin = true;
vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: vi.fn(async (_auth: unknown, allowed: string[], res: Response) => {
    if (_isAdmin) return true;
    res.status(403).json({
      error: { code: "forbidden", message: `This action requires one of: ${allowed.join(", ")}.` },
    });
    return false;
  }),
}));

const setCompanyFactMock = vi.fn(async () => ({ ok: true, error: null }));

let _enabled = true;
let _recDecisions: unknown = [];
vi.mock("@/services/settings", () => ({
  getBoolSetting: vi.fn(async () => _enabled),
  getSetting: vi.fn(async () => _recDecisions),
  setTenantSetting: vi.fn(async () => undefined),
}));

let _competitors: string[] = [];
vi.mock("@/services/company/facts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/company/facts")>()),
  getCompanyFacts: vi.fn(async () => ({
    name: null,
    nameIsWorkspaceLabel: false,
    website: null,
    competitors: _competitors,
    facts: {},
  })),
  setCompanyFact: (...a: unknown[]) => setCompanyFactMock(...(a as [])),
}));

const eqMock = vi.fn();
let _rows: Array<Record<string, unknown>> = [];
let _inflightRows: Array<Record<string, unknown>> = [];
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: vi.fn((table: string) => {
      if (table === "agent_runs") {
        const chain: Record<string, unknown> = {};
        chain.select = vi.fn(() => chain);
        chain.eq = vi.fn(() => chain);
        chain.in = vi.fn(() => chain);
        chain.limit = vi.fn(async () => ({ data: _inflightRows, error: null }));
        return chain;
      }
      return {
        select: vi.fn(() => ({
          eq: eqMock.mockImplementation(() => ({
            order: vi.fn(() => ({
              limit: vi.fn(async () => ({ data: _rows, error: null })),
            })),
          })),
        })),
      };
    }),
  }),
}));

const logEventMock = vi.fn(async (_input: Record<string, unknown>) => undefined);
vi.mock("@/services/logging/logEvent", () => ({
  logEvent: (input: Record<string, unknown>) => logEventMock(input),
}));

import {
  competitorIntelGet,
  postCompetitorBrands,
  postCompetitorRecDecision,
  postCompetitorRecEvent,
} from "../../routes/competitor-intel";

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

beforeEach(() => {
  vi.clearAllMocks();
  _authed = true;
  _isAdmin = true;
  setCompanyFactMock.mockResolvedValue({ ok: true, error: null });
  _enabled = true;
  _recDecisions = [];
  _competitors = [];
  _rows = [];
  _inflightRows = [];
});

describe("GET /api/competitor-intel", () => {
  it("401 when unauthenticated", async () => {
    _authed = false;
    const res = mockResponse();
    await competitorIntelGet({} as Request, res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (res as any)._inspect();
    expect(r.statusCode).toBe(401);
    expect(r.body.error.code).toBe("unauthenticated");
  });

  it("returns {enabled, snapshots} with an EXPLICIT tenant filter", async () => {
    _rows = [
      {
        week_bucket: "2026-06-08",
        landscape: { kind: "report" },
        delta: null,
        created_at: "2026-06-08T09:30:00Z",
        tenant_id: AUTH_TENANT,
      },
    ];
    const res = mockResponse();
    await competitorIntelGet({} as Request, res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (res as any)._inspect();
    expect(r.statusCode).toBe(200);
    expect(r.body.enabled).toBe(true);
    expect(r.body.snapshots).toEqual([
      {
        week_bucket: "2026-06-08",
        landscape: { kind: "report" },
        delta: null,
        created_at: "2026-06-08T09:30:00Z",
      },
    ]);
    expect(eqMock).toHaveBeenCalledWith("tenant_id", AUTH_TENANT);
  });

  it("serves custom_brands from THE company record, not the retired setting", async () => {
    _competitors = ["Kyte", "Tom & Jerry Rentals"];
    _recDecisions = [];
    const res = mockResponse();
    await competitorIntelGet({} as Request, res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (res as any)._inspect();
    expect(r.statusCode).toBe(200);
    expect(r.body.custom_brands).toEqual(["Kyte", "Tom & Jerry Rentals"]);
  });

  it("reflects flag-off in `enabled` (web gates nav on it)", async () => {
    _enabled = false;
    _rows = [];
    const res = mockResponse();
    await competitorIntelGet({} as Request, res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (res as any)._inspect();
    expect(r.statusCode).toBe(200);
    expect(r.body.enabled).toBe(false);
    expect(r.body.scan_in_progress).toBe(false);
  });

  it("scan_in_progress=true when a first scan is in flight (enabled, zero snapshots)", async () => {
    _rows = [];
    _inflightRows = [{ id: "run-x" }];
    const res = mockResponse();
    await competitorIntelGet({} as Request, res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (res as any)._inspect();
    expect(r.statusCode).toBe(200);
    expect(r.body.scan_in_progress).toBe(true);
    expect(r.body.snapshots).toEqual([]);
  });

  it("scan_in_progress=false when no first scan is in flight (enabled, zero snapshots)", async () => {
    _rows = [];
    _inflightRows = [];
    const res = mockResponse();
    await competitorIntelGet({} as Request, res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (res as any)._inspect();
    expect(r.body.scan_in_progress).toBe(false);
  });

  it("skips the scan_in_progress probe once a snapshot exists", async () => {
    _rows = [
      { week_bucket: "2026-06-08", landscape: { kind: "report" }, delta: null, created_at: "x" },
    ];
    _inflightRows = [{ id: "run-x" }];
    const res = mockResponse();
    await competitorIntelGet({} as Request, res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (res as any)._inspect();
    expect(r.body.scan_in_progress).toBe(false);
  });
});

describe("POST /api/competitor-intel/rec-decisions", () => {
  it("upserts a decision and returns the canonical map", async () => {
    _recDecisions = {};
    const res = mockResponse();
    await postCompetitorRecDecision(
      { body: { rec_key: "k1", title: "Move", status: "act" } } as unknown as Request,
      res,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (res as any)._inspect();
    expect(r.statusCode).toBe(200);
    expect(r.body.rec_decisions.k1.status).toBe("act");
  });

  it("400 on a bad status", async () => {
    _recDecisions = {};
    const res = mockResponse();
    await postCompetitorRecDecision(
      { body: { rec_key: "k1", status: "explode" } } as unknown as Request,
      res,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (res as any)._inspect();
    expect(r.statusCode).toBe(400);
    expect(r.body.error.code).toBe("bad_status");
  });
});

describe("POST /api/competitor-intel/rec-event (#5 telemetry)", () => {
  it("logs an ask_agent CTA with the agent_slug in meta and 202s", async () => {
    const res = mockResponse();
    await postCompetitorRecEvent(
      { body: { event: "ask_agent", agent_slug: "pm" } } as unknown as Request,
      res,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (res as any)._inspect();
    expect(r.statusCode).toBe(202);
    expect(logEventMock).toHaveBeenCalledTimes(1);
    const arg = logEventMock.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.code).toBe("competitor_intel.rec_ask_agent");
    expect(arg.tenant_id).toBe(AUTH_TENANT);
    expect(arg.meta).toEqual({ agent_slug: "pm" });
  });

  it("encodes the decision verdict in the code, never rec content", async () => {
    const res = mockResponse();
    await postCompetitorRecEvent(
      { body: { event: "decision", status: "dismiss" } } as unknown as Request,
      res,
    );
    const arg = logEventMock.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.code).toBe("competitor_intel.rec_decision.dismiss");
    expect(arg.meta).toEqual({});
  });

  it("400 on an unknown event", async () => {
    const res = mockResponse();
    await postCompetitorRecEvent({ body: { event: "nope" } } as unknown as Request, res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (res as any)._inspect();
    expect(r.statusCode).toBe(400);
    expect(logEventMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/competitor-intel/custom-brands", () => {
  it("refuses a member who is not owner or admin, and writes nothing", async () => {
    _isAdmin = false;
    const res = mockResponse();
    await postCompetitorBrands(
      { body: { brands: ["FakeCo"] } } as unknown as Request,
      res,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (res as any)._inspect();
    expect(r.statusCode).toBe(403);
    expect(setCompanyFactMock).not.toHaveBeenCalled();
  });

  it("lets an owner or admin save the list", async () => {
    const res = mockResponse();
    await postCompetitorBrands(
      { body: { brands: ["Kyte", "Turo"] } } as unknown as Request,
      res,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (res as any)._inspect();
    expect(r.statusCode).toBe(200);
    expect(r.body.brands).toEqual(["Kyte", "Turo"]);
    expect(setCompanyFactMock).toHaveBeenCalledTimes(1);
  });
});
