import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

let authResult: { tenant_id: string; user_id: string; access_token: string } | null = null;
const rpcCalls: Array<{ fn: string; tid: string; args: Record<string, unknown> }> = [];
let rpcResult: { data: unknown; error: { message: string } | null } = { data: null, error: null };
const cards = new Map<string, { tenant_id: string; id: string; run_id: string; body: unknown }>();
let pairing: Record<string, unknown> | "throw" = {};

vi.mock("@/services/growth/preview-plan", async (orig) =>
  (await import("@/__tests__/helpers/tenant-plan")).previewPlanOn(orig),
);
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async (_req: Request, res: Response) => {
    if (authResult) return authResult;
    res.status(401).json({ error: { code: "unauthenticated", message: "no auth" } });
    return null;
  }),
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: (tid: string) => {
    let id = "";
    const q = {
      select: () => q,
      eq: (col: string, v: string) => {
        if (col === "id") id = v;
        return q;
      },
      maybeSingle: async () => {
        const row = cards.get(id);
        return { data: row && row.tenant_id === tid ? row : null, error: null };
      },
    };
    return { from: () => q };
  },
  tenantRpc: (tid: string, fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, tid, args });
    return Promise.resolve(rpcResult);
  },
}));
vi.mock("@/services/channels/channel-actions", async () => {
  const actual = await vi.importActual<typeof import("@/services/channels/channel-actions")>(
    "@/services/channels/channel-actions",
  );
  return {
    ...actual,
    tenantTimezone: vi.fn(async () => "America/Los_Angeles"),
    scheduledAtForDay: (day: string, tz: string, _now?: number, time?: string) =>
      actual.scheduledAtForDay(day, tz, Date.UTC(2020, 0, 1), time),
    stagedPostsForCards: vi.fn(async (_tid: string, list: Array<{ id: string }>) => {
      if (pairing === "throw") throw new Error("staged posts read failed: boom");
      const m = new Map<string, unknown>();
      for (const c of list) if (pairing[c.id]) m.set(c.id, pairing[c.id]);
      return m;
    }),
  };
});
const refreshApprovalCard = vi.fn(async (_a: { tenant_id: string; decision_id: string }) => true);
vi.mock("@/services/slack/approval-post-target", () => ({
  refreshApprovalCard: (a: { tenant_id: string; decision_id: string }) => refreshApprovalCard(a),
}));
vi.mock("@/services/agents/runner", () => ({ enqueueAgentRun: vi.fn(), InsufficientCreditsError: class InsufficientCreditsError extends Error {} }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn() } }));

import { channelActionPublishOn } from "../actions";
import { resetTenantPlan, tenantPlan } from "@/__tests__/helpers/tenant-plan";

const MINE = "73db45ff-457e-4541-bc8f-bdb625390204";
const THEIRS = "11111111-2222-4333-8444-555555555555";
const ID = "0f4d7c1a-2b3c-4d5e-8f90-123456789abc";
const OTHER_ID = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";
const DECISION = "d0000000-0000-4000-8000-000000000001";

function res() {
  const r: { _status: number; _body: unknown; status: (n: number) => typeof r; json: (b: unknown) => typeof r } = {
    _status: 200,
    _body: undefined,
    status(n) { r._status = n; return r; },
    json(b) { r._body = b; return r; },
  };
  return r;
}

const call = async (id: string, body: unknown) => {
  const r = res();
  await channelActionPublishOn({ params: { id }, body } as unknown as Request, r as unknown as Response);
  return r;
};

beforeEach(() => {
  resetTenantPlan();
  authResult = { tenant_id: MINE, user_id: "u-1", access_token: "tok" };
  rpcCalls.length = 0;
  refreshApprovalCard.mockReset().mockResolvedValue(true);
  rpcResult = { data: { ok: true, publish_on: "2026-10-05" }, error: null };
  pairing = {};
  cards.clear();
  cards.set(ID, { tenant_id: MINE, id: ID, run_id: "run-1", body: { step: { title: "t", publish_on: "2026-10-01" } } });
  cards.set(OTHER_ID, { tenant_id: THEIRS, id: OTHER_ID, run_id: "run-2", body: { step: { title: "t" } } });
});

describe("POST /api/channels/actions/:id/publish-on, an unstaged card", () => {
  it("moves the step's day with the auth tenant and actor, never the body's", async () => {
    const r = await call(ID, { publish_on: "2026-10-05", tenant_id: THEIRS });
    expect(r._status).toBe(200);
    expect(r._body).toEqual({ plan_day: "2026-10-05", plan_day_source: "planned" });
    expect(rpcCalls).toEqual([
      {
        fn: "set_channel_action_publish_on",
        tid: MINE,
        args: { p_action_id: ID, p_publish_on: "2026-10-05", p_actor_user_id: "u-1" },
      },
    ]);
  });

  it("clears the day with null", async () => {
    rpcResult = { data: { ok: true, publish_on: null }, error: null };
    const r = await call(ID, { publish_on: null });
    expect(r._status).toBe(200);
    expect(r._body).toEqual({ plan_day: null, plan_day_source: null });
    expect(rpcCalls[0].args.p_publish_on).toBeNull();
  });

  it("404s another tenant's card and writes nothing", async () => {
    const r = await call(OTHER_ID, { publish_on: "2026-10-05" });
    expect(r._status).toBe(404);
    expect(rpcCalls).toEqual([]);
  });

  it("404s when the RPC's own tenant check refuses", async () => {
    rpcResult = { data: { ok: false, code: "not_found" }, error: null };
    expect((await call(ID, { publish_on: "2026-10-05" }))._status).toBe(404);
  });

  it("409s a closed card", async () => {
    rpcResult = { data: { ok: false, code: "illegal_transition" }, error: null };
    expect((await call(ID, { publish_on: "2026-10-05" }))._status).toBe(409);
  });
});

describe("POST /api/channels/actions/:id/publish-on, a card staged as a pending proposal", () => {
  it("moves the proposal to 09:00 that day in the tenant's zone, not the step", async () => {
    pairing = { [ID]: { kind: "paired", decision_id: DECISION, scheduled_at: "2026-10-02T16:00:00Z" } };
    rpcResult = { data: { ok: true, scheduled_at: "2026-10-05T16:00:00Z" }, error: null };
    const r = await call(ID, { publish_on: "2026-10-05" });
    expect(r._status).toBe(200);
    expect(r._body).toEqual({ plan_day: "2026-10-05", plan_day_source: "scheduled", plan_time: "09:00", plan_timezone: "America/Los_Angeles" });
    expect(rpcCalls).toEqual([
      {
        fn: "set_staged_post_scheduled_at",
        tid: MINE,
        args: { p_decision_id: DECISION, p_scheduled_at: "2026-10-05T16:00:00.000Z", p_actor_user_id: "u-1" },
      },
    ]);
  });

  it("moves the proposal to the picked time that day in the tenant's zone", async () => {
    pairing = { [ID]: { kind: "paired", decision_id: DECISION, scheduled_at: null } };
    rpcResult = { data: { ok: true, scheduled_at: "2026-10-05T19:43:00Z" }, error: null };
    const r = await call(ID, { publish_on: "2026-10-05", publish_time: "12:43" });
    expect(r._status).toBe(200);
    expect(rpcCalls[0].args.p_scheduled_at).toBe("2026-10-05T19:43:00.000Z");
    expect(r._body).toEqual({ plan_day: "2026-10-05", plan_day_source: "scheduled", plan_time: "12:43", plan_timezone: "America/Los_Angeles" });
  });

  it("400s an explicit time that has passed or does not exist in the tenant's zone, with no write", async () => {
    pairing = { [ID]: { kind: "paired", decision_id: DECISION, scheduled_at: null } };
    const past = await call(ID, { publish_on: "2019-12-31", publish_time: "12:43" });
    expect(past._status).toBe(400);
    expect(past._body).toMatchObject({ error: { code: "invalid_publish_time" } });
    const gap = await call(ID, { publish_on: "2027-03-14", publish_time: "02:30" });
    expect(gap._status).toBe(400);
    expect(rpcCalls).toEqual([]);
  });

  it("400 on a time that is not HH:MM, and writes nothing", async () => {
    pairing = { [ID]: { kind: "paired", decision_id: DECISION, scheduled_at: null } };
    expect((await call(ID, { publish_on: "2026-10-05", publish_time: "25:00" }))._status).toBe(400);
    expect((await call(ID, { publish_on: "2026-10-05", publish_time: "9am" }))._status).toBe(400);
    expect(rpcCalls).toEqual([]);
  });

  it("re-renders the posted Slack approval card for that proposal, in the caller's tenant", async () => {
    pairing = { [ID]: { kind: "paired", decision_id: DECISION, scheduled_at: null } };
    rpcResult = { data: { ok: true, scheduled_at: "2026-10-05T16:00:00Z" }, error: null };
    await call(ID, { publish_on: "2026-10-05" });
    expect(refreshApprovalCard).toHaveBeenCalledWith({ tenant_id: MINE, decision_id: DECISION });
  });

  it("a failed Slack refresh never fails or undoes the move", async () => {
    pairing = { [ID]: { kind: "paired", decision_id: DECISION, scheduled_at: null } };
    rpcResult = { data: { ok: true, scheduled_at: "2026-10-05T16:00:00Z" }, error: null };
    refreshApprovalCard.mockRejectedValueOnce(new Error("slack down"));
    const r = await call(ID, { publish_on: "2026-10-05" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(r._status).toBe(200);
    expect(rpcCalls.map((c) => c.fn)).toEqual(["set_staged_post_scheduled_at"]);
  });

  it("no Slack refresh when the move was refused", async () => {
    pairing = { [ID]: { kind: "paired", decision_id: DECISION, scheduled_at: null } };
    rpcResult = { data: { ok: false, code: "not_pending" }, error: null };
    await call(ID, { publish_on: "2026-10-05" });
    expect(refreshApprovalCard).not.toHaveBeenCalled();
  });

  it("null clears the proposal's time and the card falls back to its planned day", async () => {
    pairing = { [ID]: { kind: "paired", decision_id: DECISION, scheduled_at: "2026-10-02T16:00:00Z" } };
    rpcResult = { data: { ok: true, scheduled_at: null }, error: null };
    const r = await call(ID, { publish_on: null });
    expect(r._status).toBe(200);
    expect(rpcCalls[0].args.p_scheduled_at).toBeNull();
    expect(r._body).toEqual({ plan_day: "2026-10-01", plan_day_source: "planned", plan_time: null, plan_timezone: "America/Los_Angeles" });
  });

  it("409s before either write once the matching proposal was already decided", async () => {
    pairing = { [ID]: { kind: "not_pending", status: "approved" } };
    const r = await call(ID, { publish_on: "2026-10-05" });
    expect(r._status).toBe(409);
    expect((r._body as { error: { code: string } }).error.code).toBe("not_pending");
    expect(rpcCalls).toEqual([]);
  });

  it("409 ambiguous when two proposals could be this card's, with no write", async () => {
    pairing = { [ID]: { kind: "ambiguous" } };
    const r = await call(ID, { publish_on: "2026-10-05" });
    expect(r._status).toBe(409);
    expect((r._body as { error: { code: string } }).error.code).toBe("ambiguous");
    expect(rpcCalls).toEqual([]);
  });

  it("500s when the pairing read fails, and writes nothing", async () => {
    pairing = "throw";
    const r = await call(ID, { publish_on: "2026-10-05" });
    expect(r._status).toBe(500);
    expect(rpcCalls).toEqual([]);
  });
});

describe("POST /api/channels/actions/:id/publish-on, input", () => {
  it.each([[{ publish_on: "2026-02-30" }], [{ publish_on: "Monday" }], [{}], [{ publish_on: 20261005 }]])(
    "400s %j with no write",
    async (body) => {
      expect((await call(ID, body))._status).toBe(400);
      expect(rpcCalls).toEqual([]);
    },
  );

  it("401s without auth and 400s a bad id", async () => {
    authResult = null;
    expect((await call(ID, { publish_on: "2026-10-05" }))._status).toBe(401);
    authResult = { tenant_id: MINE, user_id: "u-1", access_token: "tok" };
    expect((await call("not-a-uuid", { publish_on: "2026-10-05" }))._status).toBe(400);
    expect(rpcCalls).toEqual([]);
  });
});

describe("publish-on and the plan", () => {
  const xCard = () =>
    cards.set(ID, {
      tenant_id: MINE,
      id: ID,
      run_id: "run-1",
      body: { step: { title: "t" } },
      channel_slug: "x_organic",
    } as never);

  it("Free: 403 with the upgrade body; no step write, no staged-post move, no Slack refresh", async () => {
    tenantPlan.tier = "free";
    xCard();
    pairing = { [ID]: { kind: "paired", decision_id: DECISION, scheduled_at: null } };
    const r = await call(ID, { publish_on: "2026-10-05" });
    expect(r._status).toBe(403);
    expect(r._body).toMatchObject({ error: { code: "plan_upgrade_required", required_tier: "starter" } });
    expect(rpcCalls).toHaveLength(0);
    expect(refreshApprovalCard).not.toHaveBeenCalled();
  });

  it("Free: clearing a day is refused too", async () => {
    tenantPlan.tier = "free";
    xCard();
    expect((await call(ID, { publish_on: null }))._status).toBe(403);
    expect(rpcCalls).toHaveLength(0);
  });

  it("Starter: the day is saved as before", async () => {
    tenantPlan.tier = "starter";
    xCard();
    const r = await call(ID, { publish_on: "2026-10-05" });
    expect(r._status).toBe(200);
    expect(rpcCalls.map((c) => c.fn)).toEqual(["set_channel_action_publish_on"]);
  });

  it("another tenant's card is still a 404, never a plan answer", async () => {
    tenantPlan.tier = "free";
    expect((await call(OTHER_ID, { publish_on: "2026-10-05" }))._status).toBe(404);
  });
});
