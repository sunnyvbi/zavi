import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  blob: {} as Record<string, unknown>,
  sub: null as { tier: string; status: string; comp_expires_at: string | null } | null,
  configError: null as string | null,
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: h.requireAuth }));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: async () => true }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      const q = {
        select: () => q,
        eq: () => q,
        in: () => q,
        maybeSingle: async () => {
          if (table === "system_config") return h.configError ? { data: null, error: { message: h.configError } } : { data: { blob: h.blob }, error: null };
          if (table === "tenant_subscriptions") return { data: h.sub, error: null };
          return { data: null, error: null };
        },
      };
      return q;
    },
  }),
}));

import { emailCardHandlers } from "@/routes/email-cards";
import { emailPlanHandlers } from "@/routes/workspace/email-plan";

const T = "33333333-3333-4333-8333-333333333333";
const ID = "11111111-1111-4111-8111-111111111111";

function res() {
  return {
    statusCode: 200,
    body: undefined as any,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
    setHeader() {
      return this;
    },
  };
}

function recorder() {
  const calls: string[] = [];
  const rpc = (async (_t: string, name: string) => {
    calls.push(name);
    return { ok: false, code: "not_found" };
  }) as never;
  const enqueue = vi.fn(async () => undefined);
  return {
    calls,
    enqueue,
    card: { rpc, enqueue, liveCount: async () => 412 } as never,
    plan: {
      rpc,
      zone: async () => "America/Denver",
      count: async () => 412,
      plan: { zone: async () => "America/Denver", list: async () => ({ ok: true as const, name: "Members" }), rpc },
    } as never,
  };
}

const approveReq = { params: { rail: "decisions", id: ID }, body: { variant: 1, request_id: "req-12345678" } };
const scheduleReq = { params: { id: ID }, body: { variant: 1, schedule_gen: 2, content_version: 1, request_id: "req-12345678" } };
const planReq = { body: { route: "zavi_list", list_id: "list-1", date: "2026-11-20", time: "09:00", angle: "Holiday hours", request_id: "req-12345678" } };

beforeEach(() => {
  h.requireAuth.mockResolvedValue({ tenant_id: T, user_id: "user-1" });
  h.blob = { tier_gate_enforced: true };
  h.sub = { tier: "free", status: "active", comp_expires_at: null };
  h.configError = null;
});

describe("a workspace below the email plan cannot start a send", () => {
  it("Approve on an email card is refused with the upgrade words, and nothing is approved or queued", async () => {
    const x = recorder();
    const r = res();
    await emailCardHandlers(x.card).approve(approveReq as never, r as never);
    expect(r.statusCode).toBe(403);
    expect(r.body.error).toMatchObject({ code: "plan_upgrade_required", required_tier: "pro" });
    expect(r.body.error.message).toMatch(/needs the Pro plan/);
    expect(x.calls).toEqual([]);
    expect(x.enqueue).not.toHaveBeenCalled();
  });

  it("Schedule, Plan an email and Draft now are refused the same way, and nothing is written", async () => {
    const x = recorder();
    const s = res();
    await emailPlanHandlers(x.plan).schedule(scheduleReq as never, s as never);
    const p = res();
    await emailPlanHandlers(x.plan).plan(planReq as never, p as never);
    const d = res();
    await emailPlanHandlers(x.plan).draftNow({ params: { id: ID } } as never, d as never);
    for (const r of [s, p, d]) {
      expect(r.statusCode).toBe(403);
      expect(r.body.error.code).toBe("plan_upgrade_required");
    }
    expect(x.calls).toEqual([]);
  });

  it("Don't send and Skip still work after a downgrade, so a founder can always stop what is planned", async () => {
    const x = recorder();
    const w = res();
    await emailPlanHandlers(x.plan).withdraw({ params: { id: ID } } as never, w as never);
    const k = res();
    await emailPlanHandlers(x.plan).skip({ params: { id: ID } } as never, k as never);
    expect(w.statusCode).not.toBe(403);
    expect(k.statusCode).not.toBe(403);
    expect(x.calls.length).toBeGreaterThan(0);
  });

  it("a plan that cannot be read refuses with nothing done (fail closed)", async () => {
    h.configError = "timeout";
    h.sub = { tier: "pro", status: "active", comp_expires_at: null };
    const x = recorder();
    const a = res();
    await emailCardHandlers(x.card).approve(approveReq as never, a as never);
    const s = res();
    await emailPlanHandlers(x.plan).schedule(scheduleReq as never, s as never);
    for (const r of [a, s]) {
      expect(r.statusCode).toBe(503);
      expect(r.body.error.code).toBe("plan_unreadable");
    }
    expect(x.calls).toEqual([]);
  });

  it("a workspace on the plan reaches the approve and the schedule", async () => {
    h.sub = { tier: "pro", status: "active", comp_expires_at: null };
    const x = recorder();
    await emailCardHandlers(x.card).approve(approveReq as never, res() as never);
    await emailPlanHandlers(x.plan).schedule(scheduleReq as never, res() as never);
    expect(x.calls).toContain("email_card_view_state");
    expect(x.calls.length).toBeGreaterThan(1);
  });
});
