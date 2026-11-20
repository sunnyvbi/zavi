
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/auth/staff-middleware", () => ({
  assertStaff: vi.fn(() => ({ user_id: "u-staff", email: "staff@example.com" })),
}));
const { auditMock } = vi.hoisted(() => ({ auditMock: vi.fn(async () => {}) }));
vi.mock("@/services/staff/audit", () => ({ writeStaffAudit: auditMock }));

const { cfg, client } = vi.hoisted(() => {
  type Result = { data: unknown; error: { message: string } | null };
  const c = {
    tenant: { id: "t1" } as unknown,
    blob: {} as Record<string, unknown>,
    sub: null as unknown,
    writes: [] as Array<{ op: string; payload: Record<string, unknown> }>,
    updateMatches: 1,
    insertError: null as null | { code: string; message: string },
    rpcs: [] as string[],
  };
  const cl = {
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const op of ["select", "eq"]) b[op] = () => b;
      b.maybeSingle = () =>
        Promise.resolve<Result>({
          data: table === "tenants" ? c.tenant : table === "system_config" ? { blob: c.blob } : c.sub,
          error: null,
        });
      const writeOp = (op: string) => (payload: Record<string, unknown>) => {
        c.writes.push({ op, payload });
        const w: Record<string, unknown> = {};
        w.eq = () => w;
        w.is = () => w;
        w.select = () =>
          Promise.resolve({ data: Array.from({ length: c.updateMatches }, () => ({ tenant_id: "t1" })), error: null });
        w.then = (onF: (v: unknown) => unknown) =>
          Promise.resolve({ error: op === "insert" ? c.insertError : null }).then(onF);
        return w;
      };
      b.update = writeOp("update");
      b.insert = writeOp("insert");
      return b;
    },
    rpc: (name: string) => {
      c.rpcs.push(name);
      return Promise.resolve({ data: null, error: null });
    },
  };
  return { cfg: c, client: cl };
});
vi.mock("@/services/tenant-client", () => ({ staffCrossTenantClient: () => client }));
const { logEventMock } = vi.hoisted(() => ({ logEventMock: vi.fn(async () => {}) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: logEventMock }));
vi.mock("@/services/growth/preview-upgrade", () => ({ requestPreviewUpgrade: vi.fn() }));

import type { Request, Response } from "express";
import { makeStaffSetTenantPlan, addMonths } from "../tenant-plan";

const rerunMock = vi.fn(async (_t: string) => true);
const staffSetTenantPlan = makeStaffSetTenantPlan({ requestPreviewRerun: rerunMock });

function call(body: unknown) {
  const res = { statusCode: 200, body: undefined as unknown } as {
    statusCode: number;
    body: { error?: { code: string }; tier?: string; comp_expires_at?: string | null; preview_rerun?: string };
    status: (c: number) => typeof res;
    json: (b: unknown) => typeof res;
  };
  res.status = (c) => ((res.statusCode = c), res);
  res.json = (b) => ((res.body = b as typeof res.body), res);
  const req = { params: { tenant_id: "t1" }, body } as unknown as Request;
  return staffSetTenantPlan(req, res as unknown as Response).then(() => res);
}

const freeSub = {
  stripe_event_created: 0,
  plan: "free",
  monthly_usd: null,
  monthly_credits: null,
  tier: null,
  status: "active",
  stripe_subscription_id: null,
  current_period_end: null,
  comp_expires_at: null,
  grandfathered: false,
  credits_revoked_at: null,
};

describe("staffSetTenantPlan", () => {
  beforeEach(() => {
    cfg.tenant = { id: "t1" };
    cfg.blob = {};
    cfg.sub = null;
    cfg.writes = [];
    cfg.rpcs = [];
    cfg.updateMatches = 1;
    cfg.insertError = null;
    auditMock.mockClear();
    logEventMock.mockClear();
    rerunMock.mockReset();
    rerunMock.mockResolvedValue(true);
  });

  it("a paid grant re-runs the signup previews once, like a paid upgrade", async () => {
    cfg.sub = freeSub;
    const res = await call({ tier: "pro", months: 1, reason: "launch comp" });
    expect(res.statusCode).toBe(200);
    expect(rerunMock).toHaveBeenCalledTimes(1);
    expect(rerunMock).toHaveBeenCalledWith("t1");
    expect(res.body.preview_rerun).toBe("requested");
  });

  it("says so when the tenant has no previews to re-run", async () => {
    rerunMock.mockResolvedValue(false);
    const res = await call({ tier: "starter", months: 1, reason: "friend" });
    expect(res.statusCode).toBe(200);
    expect(res.body.preview_rerun).toBe("no_previews");
  });

  it("ending a comp (free) never requests a re-run", async () => {
    cfg.sub = { ...freeSub, tier: "growth", comp_expires_at: "2026-12-01T00:00:00Z" };
    const res = await call({ tier: "free", reason: "ended early" });
    expect(res.statusCode).toBe(200);
    expect(rerunMock).not.toHaveBeenCalled();
    expect(res.body).not.toHaveProperty("preview_rerun");
  });

  it("a refused grant never requests a re-run", async () => {
    cfg.sub = { ...freeSub, tier: "starter", stripe_subscription_id: "sub_1" };
    const res = await call({ tier: "growth", months: 1, reason: "upgrade" });
    expect(res.statusCode).toBe(409);
    expect(rerunMock).not.toHaveBeenCalled();
  });

  it("a failed re-run request keeps the grant, logs, and reports it", async () => {
    cfg.sub = freeSub;
    rerunMock.mockRejectedValue(new Error("inngest down"));
    const res = await call({ tier: "pro", months: 3, reason: "launch comp" });
    expect(res.statusCode).toBe(200);
    expect(res.body.tier).toBe("pro");
    expect(res.body.preview_rerun).toBe("request_failed");
    expect(cfg.writes[0]).toMatchObject({ op: "update", payload: { tier: "pro" } });
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "tenant.plan_comp" }));
    expect(logEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ code: "preview_rerun_request_failed", tenant_id: "t1" }),
    );
  });

  it("comps a tenant with no subscription row by inserting one", async () => {
    const res = await call({ tier: "growth", months: 3, reason: "launch partner" });
    expect(res.statusCode).toBe(200);
    expect(res.body.tier).toBe("growth");
    const w = cfg.writes[0];
    expect(w.op).toBe("insert");
    expect(w.payload).toMatchObject({ tenant_id: "t1", tier: "growth" });
    expect(w.payload.comp_expires_at).toEqual(expect.any(String));
    expect(w.payload).not.toHaveProperty("status");
    expect(w.payload.current_period_end).toBe(w.payload.comp_expires_at);
    expect(cfg.rpcs).toContain("_credit_balance_touch");
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "tenant.plan_comp" }));
  });

  it("updates an existing free row", async () => {
    cfg.sub = freeSub;
    const res = await call({ tier: "starter", months: 1, reason: "friend" });
    expect(res.statusCode).toBe(200);
    expect(cfg.writes[0]).toMatchObject({ op: "update", payload: { tier: "starter" } });
  });

  it("comps a tenant onto Pro", async () => {
    cfg.sub = freeSub;
    const res = await call({ tier: "pro", months: 1, reason: "friend" });
    expect(res.statusCode).toBe(200);
    expect(res.body.tier).toBe("pro");
    expect(cfg.writes[0]).toMatchObject({ op: "update", payload: { tier: "pro" } });
  });

  it("refuses a tenant paying through Stripe", async () => {
    cfg.sub = { ...freeSub, tier: "starter", stripe_subscription_id: "sub_1" };
    const res = await call({ tier: "growth", months: 1, reason: "upgrade" });
    expect(res.statusCode).toBe(409);
    expect(res.body.error?.code).toBe("paying_customer");
    expect(cfg.writes).toHaveLength(0);
  });

  it("allows comping a tenant whose Stripe subscription was canceled", async () => {
    cfg.sub = { ...freeSub, status: "canceled", stripe_subscription_id: "sub_old" };
    const res = await call({ tier: "starter", months: 1, reason: "win-back" });
    expect(res.statusCode).toBe(200);
    expect(cfg.writes[0].payload).not.toHaveProperty("status");
  });

  it("refuses when a billing webhook changed the row after the read", async () => {
    cfg.sub = freeSub;
    cfg.updateMatches = 0;
    const res = await call({ tier: "starter", months: 1, reason: "friend" });
    expect(res.statusCode).toBe(409);
    expect(res.body.error?.code).toBe("changed_concurrently");
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("refuses when a webhook created the row between read and insert", async () => {
    cfg.insertError = { code: "23505", message: "duplicate key" };
    const res = await call({ tier: "starter", months: 1, reason: "friend" });
    expect(res.statusCode).toBe(409);
    expect(res.body.error?.code).toBe("changed_concurrently");
  });

  it("refuses a tenant on the tier_pro_tenants override", async () => {
    cfg.blob = { tier_pro_tenants: ["t1"] };
    const res = await call({ tier: "starter", months: 1, reason: "x-y-z" });
    expect(res.statusCode).toBe(409);
    expect(res.body.error?.code).toBe("pro_override");
  });

  it("still lets staff end a comp for a tenant later put on the Pro override", async () => {
    cfg.blob = { tier_pro_tenants: ["t1"] };
    cfg.sub = { ...freeSub, tier: "growth", comp_expires_at: "2099-01-01T00:00:00Z" };
    const res = await call({ tier: "free", reason: "ended early" });
    expect(res.statusCode).toBe(200);
  });

  it("refuses a legacy paid-plan tenant", async () => {
    cfg.sub = { ...freeSub, plan: "team" };
    const res = await call({ tier: "starter", months: 1, reason: "x-y-z" });
    expect(res.statusCode).toBe(409);
    expect(res.body.error?.code).toBe("not_free");
  });

  it("refuses a refund-blocked tenant", async () => {
    cfg.sub = { ...freeSub, credits_revoked_at: "2026-09-01T00:00:00Z" };
    const res = await call({ tier: "starter", months: 1, reason: "x-y-z" });
    expect(res.statusCode).toBe(409);
    expect(res.body.error?.code).toBe("refund_blocked");
  });

  it("ends a comp early and refuses to 'end' a non-comp", async () => {
    cfg.sub = { ...freeSub, tier: "growth", comp_expires_at: "2026-12-01T00:00:00Z" };
    const ok = await call({ tier: "free", reason: "ended early" });
    expect(ok.statusCode).toBe(200);
    expect(cfg.writes[0].payload).toEqual(expect.objectContaining({ tier: null, comp_expires_at: null }));
    expect(cfg.writes[0].payload).not.toHaveProperty("current_period_end");

    cfg.writes = [];
    cfg.sub = freeSub;
    const no = await call({ tier: "free", reason: "ended early" });
    expect(no.statusCode).toBe(409);
    expect(no.body.error?.code).toBe("not_comped");
  });

  it("rejects bad input and unknown tenants", async () => {
    expect((await call({ tier: "enterprise", months: 1, reason: "abc" })).statusCode).toBe(400);
    expect((await call({ tier: "starter", months: 2, reason: "abc" })).statusCode).toBe(400);
    expect((await call({ tier: "starter", months: 1, reason: "" })).statusCode).toBe(400);
    cfg.tenant = null;
    expect((await call({ tier: "starter", months: 1, reason: "abc" })).statusCode).toBe(404);
  });

  it("addMonths adds calendar months in UTC", () => {
    expect(addMonths(new Date("2026-09-23T10:00:00Z"), 3).toISOString()).toBe("2026-12-23T00:00:00.000Z");
    expect(addMonths(new Date("2027-01-31T10:00:00Z"), 1).toISOString()).toBe("2027-02-28T00:00:00.000Z");
    expect(addMonths(new Date("2026-08-31T23:59:00Z"), 6).toISOString()).toBe("2027-02-28T00:00:00.000Z");
  });
});
