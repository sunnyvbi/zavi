import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  start: vi.fn(),
  sender: { ok: true } as { ok: true } | { ok: false; code: string; sentence: string },
  senderCalls: 0,
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: vi.fn(async () => ({ tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204", user_id: "u1", access_token: "t" })) }));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: vi.fn(async () => true) }));
vi.mock("../run", () => ({ startChannelRun: h.start }));
vi.mock("@/services/agents/runner", () => ({ canCurrentUserReadRun: async () => true }));
vi.mock("@/services/channels/channel-actions", () => ({ listActionViewsForRun: async () => [] }));
vi.mock("@/services/agents/entitlement", async (orig) => ({
  ...(await orig<typeof import("@/services/agents/entitlement")>()),
  checkAgentTier: async () => ({ enforced: true, tier: "pro", required_tier: "pro", allowed: true }),
}));
vi.mock("@/services/comms/bulk-outbound/readiness", async (orig) => ({
  ...(await orig<typeof import("@/services/comms/bulk-outbound/readiness")>()),
  checkBulkSender: async () => {
    h.senderCalls += 1;
    return h.sender;
  },
}));
vi.mock("@/services/comms/bulk-outbound/lists", async (orig) => ({
  ...(await orig<typeof import("@/services/comms/bulk-outbound/lists")>()),
  listSummaries: async () => [
    { id: LIST, name: "Customers", created_at: "2026-10-01T00:00:00Z", latest: null, active: { id: "v1", source_kind: "csv", contact_count: 40, sendable: 40, unsubscribed_or_bounced: 0 }, needs_consent: false },
  ],
}));
vi.mock("@/services/tenant-client", () => {
  const q: Record<string, unknown> = {};
  for (const k of ["from", "select", "eq", "in", "order", "gt", "gte"]) q[k] = () => q;
  q.limit = async () => ({ data: [], error: null });
  q.maybeSingle = async () => ({ data: null, error: null });
  return { asTenantId: (s: string) => s, tenantClient: () => q, tenantRpc: async () => ({ data: null, error: null }), tenantStorage: () => ({ from: () => ({}) }), globalClient: () => q, applySecretListEditRpc: async () => ({ data: null, error: null }), StaleRevisionError: class extends Error {} };
});

const LIST = "8f0c3c1e-2b1a-4c55-9d1e-4b7f1b2a9c10";

import { startTopAction } from "../top-actions";

function res() {
  const r = { _status: 200, _body: undefined as unknown, status(n: number) { r._status = n; return r; }, json(b: unknown) { r._body = b; return r; } };
  return r;
}
const press = (request_id: string, inputs: Record<string, unknown>) =>
  ({ params: { slug: "email_marketing", key: "new_email" }, body: { request_id, inputs: { brief: "Our spring sale starts Friday", ...inputs } } }) as unknown as Request;

beforeEach(() => {
  h.start.mockReset().mockImplementation(async (r: Response) => { r.json({ ok: true }); });
  h.sender = { ok: true };
  h.senderCalls = 0;
});

describe("Write it to a Zavi list refuses before any paid run when Zavi's own sender cannot send", () => {
  it("abuse hold: 409 with the hold's sentence and no run enqueued", async () => {
    h.sender = { ok: false, code: "bulk_abuse_hold", sentence: "Bulk email is paused for this workspace because too many people marked a recent email as spam or it bounced." };
    const r = res();
    await startTopAction(press("req-send-0001", { route: "zavi_list", list_id: LIST }), r as never);
    expect(r._status).toBe(409);
    expect((r._body as { error: { message: string } }).error.message).toMatch(/marked a recent email as spam/);
    expect(h.start).not.toHaveBeenCalled();
  });

  it("global stop: 409 and no run enqueued", async () => {
    h.sender = { ok: false, code: "bulk_sending_paused", sentence: "Zavi's own sender is stopped for every workspace right now." };
    const r = res();
    await startTopAction(press("req-send-0002", { route: "zavi_list", list_id: LIST }), r as never);
    expect(r._status).toBe(409);
    expect(h.start).not.toHaveBeenCalled();
  });

  it("a ready sender lets the run start", async () => {
    const r = res();
    await startTopAction(press("req-send-0003", { route: "zavi_list", list_id: LIST }), r as never);
    expect(r._status).toBe(200);
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it("Write it to a Mailchimp list under a global stop still starts its run, and never asks Zavi's sender", async () => {
    h.sender = { ok: false, code: "bulk_sending_paused", sentence: "Zavi's own sender is stopped for every workspace right now." };
    const r = res();
    await startTopAction(press("req-send-0004", { route: "mailchimp", list_id: "a1b2c3" }), r as never);
    expect(r._status).toBe(200);
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.senderCalls).toBe(0);
  });
});
