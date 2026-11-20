import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  rpcResult: { data: { ok: true, status: "rejected", replayed: false } as Record<string, unknown>, error: null as { message: string } | null },
  rpcCalls: [] as Array<{ fn: string; tid: string }>,
  actionReads: [] as Array<{ tid: string; filters: Array<[string, unknown]> }>,
  action: null as Record<string, unknown> | null,
  readError: null as { message: string } | null,
  decline: vi.fn(async (_a: { tenant_id: string; order_id: string; reason: string }) => undefined),
  log: vi.fn(async () => undefined),
  alert: vi.fn(async (_a: { code: string; msg: string; tenant_id?: string; email?: { dedupeKey: string } }) => undefined),
}));

const track = vi.hoisted(() => vi.fn());

vi.mock("@/services/growth/preview-plan", async (orig) =>
  (await import("@/__tests__/helpers/tenant-plan")).previewPlanOn(orig),
);
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204", user_id: "u-1", access_token: "tok" })),
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: (tid: string) => {
    const read = { tid, filters: [] as Array<[string, unknown]> };
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => (read.filters.push([c, v]), q),
      maybeSingle: async () => {
        m.actionReads.push(read);
        return m.readError ? { data: null, error: m.readError } : { data: m.action, error: null };
      },
    };
    return { from: () => q };
  },
  tenantRpc: (tid: string, fn: string) => {
    m.rpcCalls.push({ fn, tid });
    return Promise.resolve(m.rpcResult);
  },
}));
vi.mock("@/services/creators/hire-card", () => ({ declineCreatorHire: m.decline }));
vi.mock("@/services/rules/suggest", () => ({ suggestRuleFromReject: vi.fn(async () => undefined) }));
vi.mock("@/services/analytics/action-events", () => ({ trackChannelActionResponded: track }));
vi.mock("@/services/agents/runner", () => ({ enqueueAgentRun: vi.fn(), InsufficientCreditsError: class extends Error {} }));
vi.mock("@/services/agents/deepagent/engine", () => ({}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: m.log }));
vi.mock("@/services/logging/alert", () => ({ alert: m.alert }));
vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn(async () => undefined) } }));

import { channelActionSet } from "../actions";
import { resetTenantPlan } from "@/__tests__/helpers/tenant-plan";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const ID = "0f4d7c1a-2b3c-4d5e-8f90-123456789abc";
const ORDER = "33333333-3333-4333-8333-333333333333";

function res() {
  const r = {
    _status: 200,
    _body: undefined as unknown,
    setHeader() { return r; },
    status(n: number) { r._status = n; return r; },
    json(b: unknown) { r._body = b; return r; },
  };
  return r;
}

const call = async (body: Record<string, unknown>) => {
  const r = res();
  await channelActionSet({ params: { id: ID }, body } as unknown as Request, r as unknown as Response);
  return r;
};

const hireCard = (over: Record<string, unknown> = {}) => ({
  id: ID,
  channel_slug: "ugc",
  status: "rejected",
  exec_class: "creator.hire",
  exec_payload: { order_id: ORDER, caps_id: "caps-1" },
  ...over,
});

beforeEach(() => {
  resetTenantPlan();
  m.rpcResult = { data: { ok: true, status: "rejected", replayed: false }, error: null };
  m.rpcCalls.length = 0;
  m.actionReads.length = 0;
  m.action = hireCard();
  m.readError = null;
  track.mockClear();
  m.decline.mockReset();
  m.decline.mockResolvedValue(undefined);
  m.log.mockClear();
});

describe("rejecting a creator hire card (test 11)", () => {
  it("declines the card's order under the authed tenant, with the founder's reason, after the reject landed", async () => {
    const r = await call({ action: "rejected", note: "too pricey", request_id: "req-12345678", tenant_id: "evil" });
    expect(r._status).toBe(200);
    expect(r._body).toEqual({ ok: true, status: "rejected", replayed: false });
    expect(m.rpcCalls.map((c) => c.fn)).toEqual(["set_channel_action"]);
    expect(m.decline).toHaveBeenCalledTimes(1);
    expect(m.decline).toHaveBeenCalledWith({ tenant_id: TENANT, order_id: ORDER, reason: expect.stringContaining("too pricey") });
    expect(m.actionReads.some((rd) => rd.tid === TENANT && rd.filters.some(([c, v]) => c === "id" && v === ID))).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(m.actionReads).toHaveLength(1);
  });

  it("a replayed reject does nothing to the order", async () => {
    m.rpcResult = { data: { ok: true, status: "rejected", replayed: true }, error: null };
    const r = await call({ action: "rejected", request_id: "req-12345678" });
    expect(r._status).toBe(200);
    expect(m.decline).not.toHaveBeenCalled();
  });

  it("a refused reject does nothing to the order", async () => {
    m.rpcResult = { data: { ok: false, code: "illegal_transition" }, error: null };
    const r = await call({ action: "rejected", request_id: "req-12345678" });
    expect(r._status).toBe(409);
    expect(m.decline).not.toHaveBeenCalled();
  });

  it("snoozing the card never cancels the hire", async () => {
    m.rpcResult = { data: { ok: true, status: "snoozed", replayed: false }, error: null };
    await call({ action: "snoozed", request_id: "req-12345678", until: new Date(Date.now() + 3600_000).toISOString() });
    await new Promise((r) => setTimeout(r, 0));
    expect(m.decline).not.toHaveBeenCalled();
  });

  it("marking the card done without approving declines the order, once, under the authed tenant", async () => {
    m.rpcResult = { data: { ok: true, status: "acted", replayed: false }, error: null };
    m.action = hireCard({ status: "acted" });
    const r = await call({ action: "acted", request_id: "req-12345678" });
    expect(r._status).toBe(200);
    expect(r._body).toEqual({ ok: true, status: "acted", replayed: false });
    expect(m.decline).toHaveBeenCalledTimes(1);
    expect(m.decline).toHaveBeenCalledWith({ tenant_id: TENANT, order_id: ORDER, reason: "The founder closed this hire without approving it." });
    expect(track).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: TENANT, channel_slug: "ugc", response: "acted" }));
  });

  it.each(["dispatching", "executed", "queued"] as const)("a hire card already %s is never declined when marked done", async (exec_status) => {
    m.rpcResult = { data: { ok: true, status: "acted", replayed: false }, error: null };
    m.action = hireCard({ exec_status });
    await call({ action: "acted", request_id: "req-12345678" });
    expect(m.decline).not.toHaveBeenCalled();
  });

  it("a replayed done does nothing to the order", async () => {
    m.rpcResult = { data: { ok: true, status: "acted", replayed: true }, error: null };
    await call({ action: "acted", request_id: "req-12345678" });
    expect(m.decline).not.toHaveBeenCalled();
    expect(m.actionReads).toHaveLength(0);
  });

  it.each(["acted", "rejected"] as const)("%s on a non-creator card reads the row once, for tracking and the class check together", async (action) => {
    m.rpcResult = { data: { ok: true, status: action, replayed: false }, error: null };
    m.action = hireCard({ exec_class: null, channel_slug: "x_organic" });
    await call({ action, request_id: "req-12345678" });
    await new Promise((r) => setTimeout(r, 0));
    expect(m.actionReads).toHaveLength(1);
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(expect.objectContaining({ channel_slug: "x_organic", response: action }));
    expect(m.decline).not.toHaveBeenCalled();
  });

  it("a failed read after a reject is logged and the reject still answers done", async () => {
    m.readError = { message: "db down" };
    const r = await call({ action: "rejected", request_id: "req-12345678" });
    expect(r._status).toBe(200);
    expect(m.decline).not.toHaveBeenCalled();
    expect(m.log).toHaveBeenCalledWith(expect.objectContaining({ code: "channel_action_close_read_failed", tenant_id: TENANT }));
  });

  it.each(["dispatching", "executed"] as const)("a hire card already %s (money may be held) is never declined", async (exec_status) => {
    m.action = hireCard({ exec_status });
    const r = await call({ action: "rejected", request_id: "req-12345678" });
    expect(r._status).toBe(200);
    expect(m.decline).not.toHaveBeenCalled();
  });

  it("a hire card whose saved-card charge failed (nothing held) is still declined", async () => {
    m.action = hireCard({ exec_status: "failed" });
    await call({ action: "rejected", request_id: "req-12345678" });
    expect(m.decline).toHaveBeenCalledTimes(1);
  });

  it("rejecting any other card never touches a creator order", async () => {
    m.action = hireCard({ exec_class: "generated_video.render.v1" });
    await call({ action: "rejected", request_id: "req-12345678" });
    m.action = hireCard({ exec_payload: {} });
    await call({ action: "rejected", request_id: "req-12345678" });
    expect(m.decline).not.toHaveBeenCalled();
  });

  it("a failed decline still answers the reject as done, and pages staff with ids only", async () => {
    m.decline.mockRejectedValue(new Error("stripe down: sk_test_secret"));
    const r = await call({ action: "rejected", request_id: "req-12345678" });
    expect(r._status).toBe(200);
    expect(r._body).toEqual({ ok: true, status: "rejected", replayed: false });
    expect(m.alert).toHaveBeenCalledTimes(1);
    const page = m.alert.mock.calls[0][0];
    expect(page).toEqual(expect.objectContaining({ code: "creator_hire_decline_failed", tenant_id: TENANT }));
    expect(page.msg).toContain("expire it and close the order by hand");
    expect(page.msg).not.toContain("sk_test");
    expect(page.email?.dedupeKey).toMatch(/^creator_hire_decline_failed:/);
  });
});
