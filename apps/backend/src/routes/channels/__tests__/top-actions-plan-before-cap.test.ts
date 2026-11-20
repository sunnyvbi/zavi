import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ start: vi.fn(), tier: vi.fn(), tierSlugs: [] as string[] }));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: vi.fn(async () => ({ tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204", user_id: "u1", access_token: "t" })) }));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: vi.fn(async () => true) }));
vi.mock("../run", () => ({ startChannelRun: h.start }));
vi.mock("@/services/agents/runner", () => ({ canCurrentUserReadRun: async () => true }));
vi.mock("@/services/channels/channel-actions", () => ({ listActionViewsForRun: async () => [] }));
vi.mock("@/services/agents/entitlement", async (orig) => ({
  ...(await orig<typeof import("@/services/agents/entitlement")>()),
  checkAgentTier: async (tenant: string, slug: string) => {
    h.tierSlugs.push(slug);
    return h.tier(tenant, slug);
  },
}));
vi.mock("@/services/tenant-client", () => {
  const q: Record<string, unknown> = {};
  for (const k of ["from", "select", "eq", "in", "order", "gt", "gte"]) q[k] = () => q;
  q.limit = async () => ({ data: Array.from({ length: 500 }, (_, i) => ({ id: `r${i}` })), error: null });
  q.maybeSingle = async () => ({ data: null, error: null });
  return { asTenantId: (s: string) => s, tenantClient: () => q, tenantRpc: async () => ({ data: null, error: null }), tenantStorage: () => ({ from: () => ({}) }), globalClient: () => q, applySecretListEditRpc: async () => ({ data: null, error: null }), StaleRevisionError: class extends Error {} };
});

import { startTopAction } from "../top-actions";
import { loadChannelRecipe } from "@/services/channels/recipe";

function res() {
  const r = { _status: 200, _body: undefined as unknown, status(n: number) { r._status = n; return r; }, json(b: unknown) { r._body = b; return r; } };
  return r;
}
const press = (request_id: string) =>
  ({ params: { slug: "email_marketing", key: "new_email" }, body: { request_id, inputs: { route: "mailchimp", list_id: "a1b2c3", brief: "Our spring sale starts Friday" } } }) as unknown as Request;

beforeEach(() => {
  h.start.mockReset().mockImplementation(async (r: Response) => { r.json({ ok: true }); });
  h.tier.mockReset();
  h.tierSlugs.length = 0;
});

describe("new email on a plan that does not include it, with the daily card cap already full", () => {
  it("answers with the upgrade refusal, not 'Try again tomorrow', and starts no run", async () => {
    h.tier.mockResolvedValue({ enforced: true, tier: "free", required_tier: "growth", allowed: false });
    const r = res();
    await startTopAction(press("req-plan-0001"), r as never);
    expect(r._status).toBe(403);
    const err = (r._body as { error: { code: string; required_tier: string; message: string } }).error;
    expect(err.code).toBe("plan_upgrade_required");
    expect(err.required_tier).toBe("growth");
    expect(err.message).not.toMatch(/tomorrow/i);
    expect(h.tierSlugs).toEqual([loadChannelRecipe("email_marketing").meta.executor]);
    expect(h.start).not.toHaveBeenCalled();
  });

  it("on a plan that includes it, the cap still answers 409 Try again tomorrow", async () => {
    h.tier.mockResolvedValue({ enforced: true, tier: "pro", required_tier: "growth", allowed: true });
    const r = res();
    await startTopAction(press("req-plan-0002"), r as never);
    expect(r._status).toBe(409);
    expect(JSON.stringify(r._body)).toMatch(/Try again tomorrow/);
    expect(h.start).not.toHaveBeenCalled();
  });

  it("a plan read that throws leaves the decision to the run start, and the cap still answers", async () => {
    h.tier.mockRejectedValue(new Error("config down"));
    const r = res();
    await startTopAction(press("req-plan-0003"), r as never);
    expect(r._status).toBe(409);
    expect(h.start).not.toHaveBeenCalled();
  });
});
