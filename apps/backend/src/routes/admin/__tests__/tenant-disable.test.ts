
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const state = {
    staff: true,
    tenant: { id: "t1", display_name: "Acme", disabled_at: null, disabled_reason: null } as unknown,
    rpcResult: { changed: true, disabled_at: "2026-10-16T00:00:00Z" } as unknown,
    rpcError: null as null | { message: string },
    members: [
      { user_id: "u-owner", role: "owner" },
      { user_id: "u-member", role: "member" },
    ],
    sub: { stripe_subscription_id: "sub_1", status: "active", source: "stripe" } as unknown,
    lastDisableAudit: null as unknown,
    rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  };
  const client = {
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const op of ["select", "eq", "contains", "order", "limit"]) b[op] = () => b;
      b.maybeSingle = () =>
        Promise.resolve({
          data:
            table === "tenants"
              ? state.tenant
              : table === "tenant_subscriptions"
                ? state.sub
                : table === "staff_audit_log"
                  ? state.lastDisableAudit
                  : null,
          error: null,
        });
      b.then = (onF: (v: unknown) => unknown) =>
        Promise.resolve({ data: table === "tenant_users" ? state.members : [], error: null }).then(onF);
      return b;
    },
    rpc: (name: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ name, args });
      return Promise.resolve({ data: state.rpcError ? null : state.rpcResult, error: state.rpcError });
    },
  };
  const stripe = {
    subscriptions: {
      retrieve: vi.fn(async (id: string) => ({ id, status: "active", cancel_at_period_end: false, schedule: null })),
      update: vi.fn(async (id: string, p: Record<string, unknown>) => ({ id, ...p })),
    },
    subscriptionSchedules: { release: vi.fn(async () => ({})) },
  };
  return {
    state,
    client,
    stripe,
    audit: vi.fn(async (_i: unknown) => {}),
    send: vi.fn(async (..._a: unknown[]) => {}),
    invalidateUser: vi.fn((_u: string) => {}),
    invalidateDisabled: vi.fn((_t?: string) => {}),
  };
});

vi.mock("@/services/auth/staff-middleware", () => ({
  assertStaff: vi.fn(() => {
    if (!h.state.staff) throw new Error("assertStaff: req.staff missing");
    return { user_id: "u-staff", email: "staff@example.com" };
  }),
}));
vi.mock("@/services/tenant-client", () => ({ staffCrossTenantClient: () => h.client }));
vi.mock("@/services/staff/audit", () => ({ writeStaffAuditStrict: h.audit }));
vi.mock("@/services/billing/client", () => ({ billingStripe: () => h.stripe }));
vi.mock("@/services/auth/tenant-cache", () => ({ invalidateCachedTenant: h.invalidateUser }));
vi.mock("@/services/tenants/disabled", () => ({ invalidateTenantDisabledCache: h.invalidateDisabled }));
vi.mock("@/email/sendAuthEmail", () => ({
  sgSend: h.send,
  resolveMemberEmail: async (uid: string) => `${uid}@example.com`,
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));

import type { Request, Response } from "express";
import { staffSetTenantDisabled } from "../tenant-disable";

type Body = { ok?: boolean; changed?: boolean; disabled_at?: string | null; warnings?: string[]; error?: { code: string } };

async function call(body: unknown) {
  const res = { statusCode: 200, body: undefined as unknown as Body } as {
    statusCode: number;
    body: Body;
    status: (c: number) => typeof res;
    json: (b: unknown) => typeof res;
  };
  res.status = (c) => ((res.statusCode = c), res);
  res.json = (b) => ((res.body = b as Body), res);
  const req = { params: { tenant_id: "t1" }, body } as unknown as Request;
  await staffSetTenantDisabled(req, res as unknown as Response);
  return res;
}

beforeEach(() => {
  h.state.staff = true;
  h.state.tenant = { id: "t1", display_name: "Acme", disabled_at: null, disabled_reason: null };
  h.state.rpcResult = { changed: true, disabled_at: "2026-10-16T00:00:00Z" };
  h.state.rpcError = null;
  h.state.sub = { stripe_subscription_id: "sub_1", status: "active", source: "stripe" };
  h.state.lastDisableAudit = null;
  h.state.rpcCalls = [];
  h.audit.mockReset();
  h.audit.mockImplementation(async () => {});
  h.send.mockReset();
  h.send.mockImplementation(async () => {});
  h.invalidateUser.mockClear();
  h.invalidateDisabled.mockClear();
  h.stripe.subscriptions.retrieve.mockReset();
  h.stripe.subscriptions.retrieve.mockImplementation(async (id: string) => ({
    id,
    status: "active",
    cancel_at_period_end: false,
    schedule: null,
  }));
  h.stripe.subscriptions.update.mockClear();
  h.stripe.subscriptionSchedules.release.mockClear();
});

describe("staffSetTenantDisabled", () => {
  it("refuses a non-staff caller before touching anything", async () => {
    h.state.staff = false;
    await expect(call({ disabled: true, reason: "asked to leave" })).rejects.toThrow(/req\.staff missing/);
    expect(h.state.rpcCalls).toHaveLength(0);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("requires a reason when disabling", async () => {
    for (const body of [{ disabled: true }, { disabled: true, reason: "no" }, { disabled: "yes", reason: "abc" }, {}]) {
      const res = await call(body);
      expect(res.statusCode).toBe(400);
    }
    expect(h.state.rpcCalls).toHaveLength(0);
  });

  it("404s an unknown tenant", async () => {
    h.state.tenant = null;
    const res = await call({ disabled: true, reason: "asked to leave" });
    expect(res.statusCode).toBe(404);
    expect(h.state.rpcCalls).toHaveLength(0);
  });

  it("disables: RPC, caches, Stripe cancel at period end, owner email, audit", async () => {
    const res = await call({ disabled: true, reason: "  asked to leave  " });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, changed: true, disabled_at: "2026-10-16T00:00:00Z", warnings: [] });

    expect(h.state.rpcCalls).toEqual([
      { name: "set_tenant_disabled", args: { p_tenant: "t1", p_disabled: true, p_reason: "asked to leave", p_actor: "u-staff" } },
    ]);
    expect(h.invalidateDisabled).toHaveBeenCalledWith("t1");
    expect(h.invalidateUser.mock.calls.map((c) => c[0]).sort()).toEqual(["u-member", "u-owner"]);
    expect(h.stripe.subscriptions.update).toHaveBeenCalledWith("sub_1", { cancel_at_period_end: true });

    expect(h.send).toHaveBeenCalledTimes(1);
    const [to, subject, html] = h.send.mock.calls[0] as [string, string, string];
    expect(to).toBe("u-owner@example.com");
    expect(subject).toBe("Your Zavi workspace has been disabled");
    expect(html).toContain("support@zaviagent.com");
    expect(html).not.toContain("asked to leave");

    expect(h.audit).toHaveBeenCalledTimes(1);
    const audit = h.audit.mock.calls[0][0] as { action: string; meta: Record<string, unknown> };
    expect(audit.action).toBe("tenant.disable");
    expect(audit.meta.reason).toBe("asked to leave");
    expect(audit.meta.before).toEqual({ disabled_at: null, disabled_reason: null });
    expect((audit.meta.side_effects as { stripe: unknown }).stripe).toMatchObject({
      result: "set_cancel",
      subscription_id: "sub_1",
      was_cancel_at_period_end: false,
    });
  });

  it("an idempotent repeat changes nothing and sends nothing, but is audited", async () => {
    h.state.rpcResult = { changed: false, disabled_at: "2026-10-15T00:00:00Z" };
    const res = await call({ disabled: true, reason: "asked to leave" });
    expect(res.body).toMatchObject({ ok: true, changed: false });
    expect(h.stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.invalidateDisabled).not.toHaveBeenCalled();
    expect(h.audit).toHaveBeenCalledTimes(1);
  });

  it("a Stripe failure is a warning, not a 500, and the email still goes", async () => {
    h.stripe.subscriptions.retrieve.mockRejectedValueOnce(new Error("stripe down"));
    const res = await call({ disabled: true, reason: "asked to leave" });
    expect(res.statusCode).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(res.body.warnings?.join(" ")).toMatch(/Stripe update failed: stripe down/);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("does not undo a cancel the customer had set themselves on enable", async () => {
    h.state.rpcResult = { changed: true, disabled_at: null };
    h.stripe.subscriptions.retrieve.mockImplementation(async (id: string) => ({
      id,
      status: "active",
      cancel_at_period_end: true,
      schedule: null,
    }));
    h.state.lastDisableAudit = { meta: { side_effects: { stripe: { result: "already_cancelling", subscription_id: "sub_1" } } } };
    const res = await call({ disabled: false });
    expect(res.body).toMatchObject({ ok: true, changed: true, disabled_at: null });
    expect(h.stripe.subscriptions.update).not.toHaveBeenCalled();
    expect((h.send.mock.calls[0] as unknown[])[1]).toBe("Your Zavi workspace has been re-enabled");
    expect((h.audit.mock.calls[0][0] as { action: string }).action).toBe("tenant.enable");
  });

  it("undoes the cancel Zavi set on enable", async () => {
    h.state.rpcResult = { changed: true, disabled_at: null };
    h.stripe.subscriptions.retrieve.mockImplementation(async (id: string) => ({
      id,
      status: "active",
      cancel_at_period_end: true,
      schedule: null,
    }));
    h.state.lastDisableAudit = { meta: { side_effects: { stripe: { result: "set_cancel", subscription_id: "sub_1" } } } };
    await call({ disabled: false });
    expect(h.stripe.subscriptions.update).toHaveBeenCalledWith("sub_1", { cancel_at_period_end: false });
  });

  it("an audit failure is a 500 that says the change landed", async () => {
    h.audit.mockRejectedValueOnce(new Error("insert failed"));
    const res = await call({ disabled: true, reason: "asked to leave" });
    expect(res.statusCode).toBe(500);
    expect(res.body.error?.code).toBe("audit_failed");
  });
});
