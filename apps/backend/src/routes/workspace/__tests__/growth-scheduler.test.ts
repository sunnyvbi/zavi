import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const T = "11111111-1111-4111-8111-111111111111";

let authed = true;
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async (_req: unknown, res: Response) => {
    if (authed) return { user_id: "u1", tenant_id: T, access_token: "tok" };
    res.status(401).json({ error: { code: "unauthorized" } });
    return null;
  },
}));

const resolveSchedulerCapability = vi.fn();
vi.mock("@/services/agents/scheduler-capability", () => ({
  resolveSchedulerCapability: (...a: unknown[]) => resolveSchedulerCapability(...(a as [string])),
}));

vi.mock("@/services/supabase", () => ({ serverClientFromBearer: () => ({ rpc: async () => ({ error: null }) }) }));
vi.mock("@/services/settings", () => ({ setTenantSetting: async () => {} }));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: async () => true }));
vi.mock("@/services/tenant-client", () => ({ asTenantId: (t: string) => t, tenantClient: () => ({}), tenantRpc: async () => ({ data: null, error: null }) }));
vi.mock("@/services/growth/goal-write", () => ({ writeAutopilotGoal: async () => ({}) }));
vi.mock("@/email/sendAuthEmail", () => ({ sgSend: async () => {} }));
vi.mock("@/services/tenants/new-tenant-alert", () => ({ alertRecipient: () => null }));

import { getGrowthScheduler } from "../head-of-growth";

function call(handler: (req: Request, res: Response) => Promise<void>, req: Partial<Request> = {}) {
  const out: { status: number; body: unknown } = { status: 200, body: undefined };
  const res = {
    status: (s: number) => ((out.status = s), res),
    json: (b: unknown) => ((out.body = b), res),
    end: () => res,
  } as unknown as Response;
  return handler(req as Request, res).then(() => out);
}

beforeEach(() => {
  authed = true;
  resolveSchedulerCapability.mockReset();
});

describe("GET /api/workspace/growth/scheduler", () => {
  it("returns the resolved capability for the session's tenant", async () => {
    const cap = { version: 1, autopilot_enabled: true, scheduled_workers: [] };
    resolveSchedulerCapability.mockResolvedValueOnce(cap);
    const out = await call(getGrowthScheduler);
    expect(out.status).toBe(200);
    expect(out.body).toBe(cap);
    expect(resolveSchedulerCapability).toHaveBeenCalledWith(T);
  });

  it("requires auth", async () => {
    authed = false;
    const out = await call(getGrowthScheduler);
    expect(out.status).toBe(401);
    expect(resolveSchedulerCapability).not.toHaveBeenCalled();
  });

  it("maps a resolver failure to 500 scheduler_read_failed", async () => {
    resolveSchedulerCapability.mockRejectedValueOnce(new Error("db down"));
    const out = await call(getGrowthScheduler);
    expect(out.status).toBe(500);
    expect(out.body).toMatchObject({ error: { code: "scheduler_read_failed" } });
  });
});
