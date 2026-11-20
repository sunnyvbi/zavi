import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JWTPayload } from "jose";

const h = vi.hoisted(() => ({
  jwt: { sub: "user-not-staff", email: "stranger@example.com" } as JWTPayload,
  staffRow: null as { user_id: string } | null,
  auditFails: false,
  audits: [] as Array<Record<string, unknown>>,
  runs: [] as Array<{ backfillFrom?: string }>,
  runThrows: false,
}));

vi.mock("@/services/auth/jwt", () => ({
  verifyJwt: vi.fn(async () => h.jwt),
  readBearerToken: vi.fn(() => "fake.jwt.token"),
  customerJwksUrl: vi.fn(() => "https://example.test/auth/v1/.well-known/jwks.json"),
  customerExpectedIssuer: vi.fn(() => "https://example.test/auth/v1"),
  verifyBearer: vi.fn(async () => null),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: vi.fn(() => ({
    from: vi.fn((table: string) => {
      if (table === "staff_users") {
        return { select: () => ({ eq: () => ({ is: () => ({ maybeSingle: async () => ({ data: h.staffRow, error: null }) }) }) }) };
      }
      return { insert: async () => ({ error: null }) };
    }),
  })),
}));
vi.mock("@/services/tenant-client", async (orig) => ({
  ...(await orig<typeof import("@/services/tenant-client")>()),
  staffCrossTenantClient: () => ({}),
}));
vi.mock("@/services/staff/audit", () => ({
  writeStaffAuditStrict: async (a: Record<string, unknown>) => {
    if (h.auditFails) throw new Error("audit down");
    h.audits.push(a);
  },
}));
vi.mock("@/services/growth/first-plan-watch-deps", () => ({ firstPlanWatchDeps: async () => ({}) }));
vi.mock("@/services/growth/first-plan-watch", async (orig) => {
  const real = await orig<typeof import("@/services/growth/first-plan-watch")>();
  return {
    ...real,
    runFirstPlanWatch: async (_d: unknown, opts: { backfillFrom?: string }) => {
      h.runs.push(opts);
      if (h.runThrows) throw new Error("first-plan-watch deletions read failed: down");
      return {
        checked: 2, started: 1, retried: 1, alerted: 0, resolved: 0, errors: 0, skipped_leaving: 0,
        backfill: { from: "2026-10-14T00:00:00.000Z", before: "x", enrolled: 2, skipped: [{ tenant_id: "t", reason: "deletion_requested" }] },
      };
    },
  };
});

import { staffMiddleware } from "@/services/auth/staff-middleware";
import { staffFirstPlanBackfill } from "../first-plan-backfill";

function mockRes() {
  return {
    statusCode: 200,
    payload: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.payload = body;
      return this;
    },
  } as any;
}
const DAY = 24 * 60 * 60 * 1000;
const day = (msAgo: number) => new Date(Date.now() - msAgo).toISOString().slice(0, 10);

beforeEach(() => {
  process.env.SUPABASE_URL = "https://example.test";
  h.jwt = { sub: "user-not-staff", email: "stranger@example.com" };
  h.staffRow = null;
  h.auditFails = false;
  h.audits = [];
  h.runs = [];
  h.runThrows = false;
});

describe("POST /api/admin/first-plan-backfill", () => {
  it("a non-staff caller gets the existing not_staff denial and nothing runs", async () => {
    const req = { headers: { authorization: "Bearer fake.jwt.token" }, body: { from: day(15 * DAY) }, path: "/first-plan-backfill" } as any;
    const res = mockRes();
    const next = vi.fn();
    await staffMiddleware()(req, res, next as never);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.payload.error.code).toBe("not_staff");
    expect(h.runs).toEqual([]);
  });

  const staffReq = (body: unknown) => ({ staff: { user_id: "staff-1", email: "ops@zaviagent.com" }, body }) as any;

  it.each([
    ["not a date", { from: "last week" }],
    ["inside the last 24 hours", { from: new Date().toISOString() }],
    ["more than 90 days back", { from: day(100 * DAY) }],
    ["missing", {}],
  ])("refuses a from that is %s, with nothing audited or run", async (_n, body) => {
    const res = mockRes();
    await staffFirstPlanBackfill(staffReq(body), res);
    expect(res.statusCode).toBe(400);
    expect(res.payload.error.code).toBe("invalid_from");
    expect(h.runs).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it("writes the audit row, runs one backfill pass and returns started / retried / skipped", async () => {
    const from = day(15 * DAY);
    const res = mockRes();
    await staffFirstPlanBackfill(staffReq({ from }), res);
    expect(res.statusCode).toBe(200);
    expect(h.audits).toEqual([expect.objectContaining({ actor_user_id: "staff-1", action: "first_plan.backfill", meta: { from } })]);
    expect(h.runs).toEqual([{ backfillFrom: from }]);
    expect(res.payload).toMatchObject({ started: 1, retried: 1, enrolled: 2, skipped: [{ tenant_id: "t", reason: "deletion_requested" }] });
  });

  it("an audit that cannot be written runs nothing (503)", async () => {
    h.auditFails = true;
    const res = mockRes();
    await staffFirstPlanBackfill(staffReq({ from: day(15 * DAY) }), res);
    expect(res.statusCode).toBe(503);
    expect(h.runs).toEqual([]);
  });

  it("a failed pass-wide read answers 503 backfill_read_failed", async () => {
    h.runThrows = true;
    const res = mockRes();
    await staffFirstPlanBackfill(staffReq({ from: day(15 * DAY) }), res);
    expect(res.statusCode).toBe(503);
    expect(res.payload.error.code).toBe("backfill_read_failed");
  });
});
