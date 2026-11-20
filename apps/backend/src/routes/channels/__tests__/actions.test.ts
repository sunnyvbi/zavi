import express from "express";
import type { Server } from "node:http";
import { z } from "zod";
import type { Request, Response } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let authResult: { tenant_id: string; user_id: string; access_token: string; tenant_overridden?: boolean } | null = null;
const rpcCalls: Array<{ fn: string; tid: string; args: Record<string, unknown> }> = [];
let rpcResult: { data: unknown; error: { message: string } | null } = { data: { ok: true, status: "acted" }, error: null };
const draftWrites: Array<{ values: unknown; filters: Array<[string, unknown]> }> = [];
vi.mock("@/services/growth/channel-stopped", () => ({ readChannelStopped: async () => false }));
vi.mock("@/services/channels/post-draft-media", () => ({ renderPostDraftImage: vi.fn(async () => null) }));
let rpcThrow: Error | null = null;
let actionRead: { data: Record<string, unknown> | null; error: { message: string } | null } = { data: null, error: null };

vi.mock("@/services/growth/preview-plan", async (orig) =>
  (await import("@/__tests__/helpers/tenant-plan")).previewPlanOn(orig),
);
const lock = vi.hoisted(() => ({ slugs: new Set<string>(), unreadable: false, reads: [] as string[] }));
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async (_req: Request, res: Response) => {
    if (authResult) return authResult;
    res.status(401).json({ error: { code: "unauthenticated", message: "no auth" } });
    return null;
  }),
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => {
    let write: { values: unknown; filters: Array<[string, unknown]> } | null = null;
    const q = { select: () => q, eq: (column: string, value: unknown) => { write?.filters.push([column, value]); return q; }, is: (column: string, value: unknown) => { write?.filters.push([column, value]); return q; }, update: (values: unknown) => { write = { values, filters: [] }; draftWrites.push(write); return q; }, maybeSingle: async () => write ? { data: { id: ID }, error: null } : actionRead };
    return { from: () => q };
  },
  tenantRpc: (tid: string, fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, tid, args });
    if (rpcThrow) throw rpcThrow;
    return Promise.resolve(rpcResult);
  },
}));
const adsAuthCalls = vi.hoisted(() => [] as boolean[]);
vi.mock("../chatgpt-ads", () => ({ adsAuth: async (_req: Request, response: Response, write = false) => {
  adsAuthCalls.push(write);
  if (!write) return authResult;
  response.status(403).json({ error: { code: "forbidden", message: "Owner or administrator required." } });
  return null;
} }));
const role = vi.hoisted(() => ({ value: "owner" as string | null, calls: [] as Array<[string, string]> }));
vi.mock("@/services/auth/tenant-role", () => ({
  loadTenantRoleFor: vi.fn(async (user_id: string, tenant_id: string) => {
    role.calls.push([user_id, tenant_id]);
    return role.value;
  }),
  loadTenantRole: vi.fn(async () => role.value),
  requireTenantRole: vi.fn(async () => true),
}));
vi.mock("@/services/agents/runner", () => ({ enqueueAgentRun: vi.fn(), InsufficientCreditsError: class InsufficientCreditsError extends Error {} }));
const walletShort = vi.hoisted(() => ({ fn: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) }));
const videoGate = vi.hoisted(() => ({ router: true, video: true, locked: false as boolean | "unreadable", lockReads: [] as string[], afford: "ok" as string, affordCalls: [] as Array<[string, number]> }));
vi.mock("@/services/channels/lock", async (orig) => ({
  ...(await orig<typeof import("@/services/channels/lock")>()),
  isChannelLockedStrict: async (slug: string) => {
    videoGate.lockReads.push(slug);
    lock.reads.push(slug);
    if (videoGate.locked === "unreadable" || lock.unreadable) throw new Error("channel lock config unavailable");
    return videoGate.locked === true || lock.slugs.has(slug);
  },
}));
vi.mock("@/services/media-router/router", async (orig) => ({
  ...(await orig<typeof import("@/services/media-router/router")>()),
  isMediaRouterEnabled: async () => videoGate.router,
}));
vi.mock("@/services/agents/_render-launch-video-flag-check", () => ({ isGenerativeVideoEnabled: async () => videoGate.video }));
vi.mock("@/services/media-router/charge", () => ({
  checkAffordMedia: async (tenant_id: string, usd: number) => {
    videoGate.affordCalls.push([tenant_id, usd]);
    return videoGate.afford;
  },
}));
vi.mock("@/services/billing/flat-pricing", async (orig) => ({
  ...(await orig<typeof import("@/services/billing/flat-pricing")>()),
  isFlatJobPricingOn: async () => false,
}));
vi.mock("@/services/channels/chatgpt-ads/proposal-readiness", () => ({
  chatgptWalletShortfall: (...a: unknown[]) => walletShort.fn(...a),
  decorateProposalFunding: async (_t: string, actions: unknown[]) => actions,
}));
vi.mock("@/services/agents/deepagent/engine", () => ({}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
const listRead = vi.hoisted(() => ({ throws: null as Error | null }));
vi.mock("@/services/channels/channel-actions", async (orig) => {
  const actual = await orig<typeof import("@/services/channels/channel-actions")>();
  return {
    ...actual,
    listChannelActions: async (...a: Parameters<typeof actual.listChannelActions>) => {
      if (listRead.throws) throw listRead.throws;
      return actual.listChannelActions(...a);
    },
    listChannelMetrics: async (...a: Parameters<typeof actual.listChannelMetrics>) => {
      if (listRead.throws) throw listRead.throws;
      return actual.listChannelMetrics(...a);
    },
  };
});
const inngestSend = vi.fn(async (_event: { id?: string; name: string; data: Record<string, unknown> }) => undefined);
const held = vi.hoisted(() => ({ slug: null as string | null }));
vi.mock("@zavi/shared", async () => {
  const actual = await vi.importActual<typeof import("@zavi/shared")>("@zavi/shared");
  return {
    ...actual,
    actionsStoreFor: (slug: string) =>
      slug === held.slug ? "decisions" : actual.actionsStoreFor(slug),
  };
});

vi.mock("@/../workers/client", () => ({
  inngest: { send: (e: { id?: string; name: string; data: Record<string, unknown> }) => inngestSend(e) },
}));

import { CHANNELS, type Channel } from "@zavi/shared";

import { channelActionApprove, channelActionErrorStatus, channelActionSet, channelActionSteps, channelActionsList, channelMetricsList, execInFlight } from "../actions";
import { channelPostDraftRead, channelPostDraftSave } from "../post-draft";
import { resetTenantPlan, tenantPlan } from "@/__tests__/helpers/tenant-plan";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const ID = "0f4d7c1a-2b3c-4d5e-8f90-123456789abc";

function res() {
  const r: { _status: number; _body: unknown; setHeader: () => unknown; status: (n: number) => typeof r; json: (b: unknown) => typeof r } = {
    _status: 200,
    _body: undefined,
    setHeader() { return this; },
    status(n) { r._status = n; return r; },
    json(b) { r._body = b; return r; },
  };
  return r;
}

beforeEach(() => {
  resetTenantPlan();
  authResult = { tenant_id: TENANT, user_id: "u-1", access_token: "tok" };
  rpcCalls.length = 0;
  rpcThrow = null;
  actionRead = { data: null, error: null };
  inngestSend.mockClear();
  rpcResult = { data: { ok: true, status: "acted", replayed: false }, error: null };
  lock.slugs = new Set();
  lock.unreadable = false;
  lock.reads.length = 0;
  listRead.throws = null;
});

describe("GET /api/channels/:slug/actions", () => {
  it("401s without auth", async () => {
    authResult = null;
    const r = res();
    await channelActionsList({ params: { slug: "seo" }, query: {} } as unknown as Request, r as unknown as Response);
    expect(r._status).toBe(401);
  });

  it("404s an unknown channel", async () => {
    const r = res();
    await channelActionsList({ params: { slug: "nope" }, query: {} } as unknown as Request, r as unknown as Response);
    expect(r._status).toBe(404);
  });

  it("an unswitched channel answers store=decisions with no rows and no read", async () => {
    const every = (CHANNELS as readonly Channel[]).filter((c) => c.actions_store !== "channel_actions");
    expect(every, "the registry has an unswitched channel again — the fixture is no longer needed").toEqual([]);
    held.slug = "email_marketing";
    try {
      const r = res();
      await channelActionsList(
        { params: { slug: held.slug }, query: {} } as unknown as Request,
        r as unknown as Response,
      );
      expect(r._status).toBe(200);
      expect(r._body).toEqual({ actions: [], more: 0, store: "decisions" });
    } finally {
      held.slug = null;
    }
  });

  it("a read the database refuses answers 500 and names the refusal in the server log", async () => {
    listRead.throws = new Error("column channel_actions.held_reason does not exist");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const r = res();
      await channelActionsList({ params: { slug: "linkedin_ads" }, query: { all: "1" } } as unknown as Request, r as unknown as Response);
      expect(r._status).toBe(500);
      expect(r._body).toEqual({ error: { code: "read_failed", message: "Could not read actions." } });
      const logged = warn.mock.calls.map((c) => c.join(" "));
      expect(logged.some((l) => l.includes("linkedin_ads") && l.includes("column channel_actions.held_reason does not exist"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("GET /api/channels/:slug/metrics", () => {
  it("a read the database refuses answers 500 and names the refusal in the server log", async () => {
    listRead.throws = new Error("column channel_metrics.nope does not exist");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const r = res();
      await channelMetricsList({ params: { slug: "linkedin_ads" }, query: {} } as unknown as Request, r as unknown as Response);
      expect(r._status).toBe(500);
      const logged = warn.mock.calls.map((c) => c.join(" "));
      expect(logged.some((l) => l.includes("linkedin_ads") && l.includes("column channel_metrics.nope does not exist"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("POST /api/channel-actions/:id", () => {
  const call = async (body: unknown) => {
    const r = res();
    await channelActionSet({ params: { id: ID }, body } as unknown as Request, r as unknown as Response);
    return r;
  };

  it("passes the authed tenant and user, never a body tenant", async () => {
    const r = await call({ action: "acted", request_id: "req-12345678", tenant_id: "evil" });
    expect(r._status).toBe(200);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]).toMatchObject({
      fn: "set_channel_action",
      tid: TENANT,
      args: { p_action_id: ID, p_status: "acted", p_event_key: "req-12345678", p_actor_user_id: "u-1" },
    });
    expect(rpcCalls[0].args).not.toHaveProperty("p_tenant_id");
  });

  it("400s a missing request_id or an unknown action", async () => {
    expect((await call({ action: "acted" }))._status).toBe(400);
    expect((await call({ action: "done", request_id: "req-12345678" }))._status).toBe(400);
    expect(rpcCalls).toHaveLength(0);
  });

  it("400s a snooze past 14 days", async () => {
    const until = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    expect((await call({ action: "snoozed", until, request_id: "req-12345678" }))._status).toBe(400);
  });

  it("maps RPC refusals: not_found 404, illegal_transition 409", async () => {
    rpcResult = { data: { ok: false, code: "not_found" }, error: null };
    expect((await call({ action: "acted", request_id: "req-12345678" }))._status).toBe(404);
    rpcResult = { data: { ok: false, code: "illegal_transition" }, error: null };
    expect((await call({ action: "acted", request_id: "req-12345678" }))._status).toBe(409);
    expect(channelActionErrorStatus("snooze_until_required")).toBe(400);
  });

  it("maps exec_in_flight (an approved ad change is executing) to 409", async () => {
    rpcResult = { data: { ok: false, code: "exec_in_flight", exec_status: "queued" }, error: null };
    const r = await call({ action: "rejected", request_id: "req-12345678" });
    expect(r._status).toBe(409);
    expect((r._body as { error: { code: string } }).error.code).toBe("exec_in_flight");
    expect(execInFlight({ exec_status: "queued" })).toBe(true);
    expect(execInFlight({ exec_status: "dispatching" })).toBe(true);
    expect(execInFlight({ exec_status: "failed" })).toBe(false);
    expect(execInFlight({ exec_status: null })).toBe(false);
  });

  it("403s an overridden tenant before any write", async () => {
    authResult = { ...authResult!, tenant_overridden: true };
    expect((await call({ action: "acted", request_id: "req-12345678" }))._status).toBe(403);
    expect(rpcCalls).toHaveLength(0);
  });

  it("reopens through the same RPC with the authed tenant and nothing else runs", async () => {
    rpcResult = { data: { ok: true, status: "pending", replayed: false }, error: null };
    const r = await call({ action: "open", request_id: "req-12345678" });
    expect(r._status).toBe(200);
    expect(r._body).toEqual({ ok: true, status: "pending", replayed: false });
    expect(rpcCalls).toEqual([
      expect.objectContaining({ fn: "set_channel_action", tid: TENANT, args: expect.objectContaining({ p_status: "open", p_actor_user_id: "u-1" }) }),
    ]);
    expect(inngestSend).not.toHaveBeenCalled();
  });

  it("maps a card that may not reopen to 409", async () => {
    rpcResult = { data: { ok: false, code: "not_reopenable" }, error: null };
    const r = await call({ action: "open", request_id: "req-12345678" });
    expect(r._status).toBe(409);
    expect((r._body as { error: { code: string } }).error.code).toBe("not_reopenable");
  });
});

describe("POST /api/channel-actions/:id/approve", () => {
  const call = async (body: unknown) => {
    const r = res();
    await channelActionApprove({ params: { id: ID }, body } as unknown as Request, r as unknown as Response);
    return r;
  };

  it("an email send refused to the card links to that card in the caller's workspace", async () => {
    rpcResult = { data: { ok: false, code: "email_card_approve_required" }, error: null };
    const out = await call({ request_id: "req-12345678" });
    const link = (out._body as { error: { open_in_zavi?: string } }).error.open_in_zavi;
    expect(link).toBeDefined();
    const u = new URL(link as string);
    expect(u.pathname).toBe(`/workspace/email-cards/channel_actions/${ID}`);
    expect(u.searchParams.get("company")).toBe(TENANT);
    expect(inngestSend).not.toHaveBeenCalled();
  });

  describe("a page-copy pull request (spec piece 4): owner or admin only", () => {
    beforeEach(() => {
      rpcResult = { data: { ok: true, attempt: 1, replayed: false }, error: null };
    });
    it("refuses a member with a plain 403 and queues nothing; head-tag cards stay open to members", async () => {
      role.value = "member";
      actionRead = { data: { id: ID, channel_slug: "seo", exec_class: "seo.create_pr.v1", exec_payload: { kind: "page_copy", blocks: [] }, exec_status: null, exec_result: null }, error: null };
      const out = await call({ request_id: "req-12345678" });
      expect(out._status).toBe(403);
      expect((out._body as { error: { message: string } }).error.message).toBe("Only a workspace owner or admin can approve this page change.");
      expect(rpcCalls).toHaveLength(0);
      actionRead = { data: { id: ID, channel_slug: "seo", exec_class: "seo.create_pr.v1", exec_payload: { changes: [] }, exec_status: null, exec_result: null }, error: null };
      expect((await call({ request_id: "req-12345678" }))._status).toBe(202);
    });
  });

  describe("approved_via: the phone's approval is traceable on the approval event", () => {
    beforeEach(() => {
      role.value = "owner";
      draftWrites.length = 0;
      actionRead = { data: { id: ID, channel_slug: "meta_ads", exec_class: "meta_ads.set_status_review", exec_payload: { object_id: "1", level: "adset", status: "PAUSED" }, exec_status: null, exec_result: null }, error: null };
      rpcResult = { data: { ok: true, attempt: 1, replayed: false }, error: null };
    });
    it("stamps the approval event this click wrote, and queues exactly one execution", async () => {
      const out = await call({ request_id: "req-12345678", via: "mobile" });
      expect(out._status).toBe(202);
      expect(rpcCalls.map((c) => c.fn)).toEqual(["approve_channel_action"]);
      expect(inngestSend).toHaveBeenCalledTimes(1);
      expect(draftWrites).toEqual([{ values: { note: "approved_via: mobile" }, filters: [["action_id", ID], ["event", "approved"], ["event_key", "req-12345678"], ["note", null]] }]);
    });
    it("a web click (no via) stamps nothing; an unknown via is refused before anything runs", async () => {
      await call({ request_id: "req-12345678" });
      expect(draftWrites).toEqual([]);
      const bad = await call({ request_id: "req-12345678", via: "tablet" });
      expect(bad._status).toBe(400);
    });
    it("a replayed or sibling-queued click stamps nothing (it wrote no event)", async () => {
      rpcResult = { data: { ok: true, attempt: 1, replayed: true, queued: true, exec_status: "dispatching" }, error: null };
      await call({ request_id: "req-12345678", via: "mobile" });
      expect(draftWrites).toEqual([]);
    });
  });

  describe("a creator hire (test 14): owner or admin only", () => {
    beforeEach(() => {
      role.value = "owner";
      role.calls.length = 0;
      actionRead = { data: { id: ID, channel_slug: "ugc", exec_class: "creator.hire", exec_status: null, exec_result: null }, error: null };
      rpcResult = { data: { ok: true, attempt: 1, replayed: false }, error: null };
    });
    it.each(["member", "viewer", null])("refuses a %s with a plain 403 and queues nothing", async (r) => {
      role.value = r;
      const out = await call({ request_id: "req-12345678" });
      expect(out._status).toBe(403);
      expect((out._body as { error: { message: string } }).error.message).toBe("Only a workspace owner or admin can approve a creator hire.");
      expect(rpcCalls).toHaveLength(0);
      expect(inngestSend).not.toHaveBeenCalled();
    });
    it.each(["owner", "admin"])("lets an %s approve, reading the role for the authed user and tenant", async (r) => {
      role.value = r;
      const out = await call({ request_id: "req-12345678" });
      expect(out._status).toBe(202);
      expect(role.calls).toEqual([["u-1", TENANT]]);
      expect(inngestSend).toHaveBeenCalledTimes(1);
    });
    it("an unreadable role refuses (503), nothing queued", async () => {
      const { loadTenantRoleFor } = await import("@/services/auth/tenant-role");
      vi.mocked(loadTenantRoleFor).mockRejectedValueOnce(new Error("db down"));
      const out = await call({ request_id: "req-12345678" });
      expect(out._status).toBe(503);
      expect(rpcCalls).toHaveLength(0);
    });
    it("a LinkedIn campaign bundle is owner/admin only, like its review", async () => {
      role.value = "member";
      actionRead = { data: { id: ID, channel_slug: "linkedin_ads", exec_class: "linkedin_ads.create_campaign_bundle", exec_status: null, exec_result: null }, error: null };
      const out = await call({ request_id: "req-12345678" });
      expect(out._status).toBe(403);
      expect((out._body as { error: { message: string } }).error.message).toBe("Only a workspace owner or admin can approve this campaign.");
      expect(rpcCalls).toHaveLength(0);
      expect(inngestSend).not.toHaveBeenCalled();
    });
    it.each(["member", "viewer", null])("a LinkedIn launch refuses a %s up front with a plain 403 and queues nothing", async (r) => {
      role.value = r;
      actionRead = { data: { id: ID, channel_slug: "linkedin_ads", exec_class: "linkedin_ads.launch_campaign", exec_status: null, exec_result: null, exec_payload: { campaign_binding_id: "00000000-0000-4000-8000-000000000001" } }, error: null };
      const out = await call({ request_id: "req-12345678" });
      expect(out._status).toBe(403);
      expect((out._body as { error: { code: string; message: string } }).error).toEqual({ code: "forbidden", message: "Only a workspace owner or admin can launch a LinkedIn campaign. Ask one of them to approve it." });
      expect(role.calls).toEqual([["u-1", TENANT]]);
      expect(rpcCalls).toHaveLength(0);
      expect(inngestSend).not.toHaveBeenCalled();
    });
    it.each(["owner", "admin"])("a LinkedIn launch queues once for an %s", async (r) => {
      role.value = r;
      actionRead = { data: { id: ID, channel_slug: "linkedin_ads", exec_class: "linkedin_ads.launch_campaign", exec_status: null, exec_result: null, exec_payload: {} }, error: null };
      const out = await call({ request_id: "req-12345678" });
      expect(out._status).toBe(202);
      expect(inngestSend).toHaveBeenCalledTimes(1);
    });
    it("a LinkedIn pause stays open to a member and reads no role", async () => {
      role.value = "member";
      actionRead = { data: { id: ID, channel_slug: "linkedin_ads", exec_class: "linkedin_ads.set_status", exec_status: null, exec_result: null, exec_payload: { status: "PAUSED" } }, error: null };
      const out = await call({ request_id: "req-12345678" });
      expect(out._status).toBe(202);
      expect(role.calls).toHaveLength(0);
      expect(inngestSend).toHaveBeenCalledTimes(1);
    });
    it.each([
      ["reddit_ads.launch_campaign", { ad_account_id: "a", operation_key: "operation_123" }],
      ["reddit_ads.authorize_account", { ad_account_id: "a" }],
      ["reddit_ads.update_budget", { expected_current_daily_budget_usd: 10, daily_budget_usd: 20 }],
      ["reddit_ads.update_budget", {}],
    ])("a Reddit spend raise (%s) is owner/admin only", async (cls, payload) => {
      role.value = "member";
      actionRead = { data: { id: ID, channel_slug: "reddit_ads", exec_class: cls, exec_status: null, exec_result: null, exec_payload: payload }, error: null };
      const out = await call({ request_id: "req-12345678" });
      expect(out._status).toBe(403);
      expect(rpcCalls).toHaveLength(0);
      expect(inngestSend).not.toHaveBeenCalled();
    });
    it.each([
      ["reddit_ads.update_budget", { expected_current_daily_budget_usd: 20, daily_budget_usd: 10 }],
      ["reddit_ads.set_object_status", { status: "PAUSED" }],
    ])("a Reddit cut or pause (%s) stays open to members", async (cls, payload) => {
      role.value = "member";
      actionRead = { data: { id: ID, channel_slug: "reddit_ads", exec_class: cls, exec_status: null, exec_result: null, exec_payload: payload }, error: null };
      const out = await call({ request_id: "req-12345678" });
      expect(out._status).toBe(202);
      expect(role.calls).toHaveLength(0);
    });
    it("an admin may approve a Reddit launch", async () => {
      role.value = "admin";
      actionRead = { data: { id: ID, channel_slug: "reddit_ads", exec_class: "reddit_ads.launch_campaign", exec_status: null, exec_result: null, exec_payload: {} }, error: null };
      const out = await call({ request_id: "req-12345678" });
      expect(out._status).toBe(202);
    });
    it.each([
      ["x_ads.create_campaign", { launch: "ACTIVE" }],
      ["x_ads.set_status", { status: "ACTIVE" }],
      ["x_ads.update_campaign", { changes: { daily_budget: 20 }, before: { daily_budget: 10 } }],
      ["x_ads.manage_objects", { request: { operation: "update_ad_group", changes: { entity_status: "ACTIVE" } } }],
    ])("an X spend raise (%s) is owner/admin only", async (cls, payload) => {
      role.value = "member";
      actionRead = { data: { id: ID, channel_slug: "x_ads", exec_class: cls, exec_status: null, exec_result: null, exec_payload: payload }, error: null };
      const out = await call({ request_id: "req-12345678" });
      expect(out._status).toBe(403);
      expect(rpcCalls).toHaveLength(0);
      expect(inngestSend).not.toHaveBeenCalled();
    });
    it.each([
      ["x_ads.set_status", { status: "PAUSED" }],
      ["x_ads.update_campaign", { changes: { daily_budget: 5 }, before: { daily_budget: 10 } }],
      ["x_ads.create_campaign", { launch: "PAUSED" }],
      ["x_ads.manage_objects", { request: { operation: "delete_ad_group" } }],
    ])("an X pause, cut or removal (%s) stays open to members", async (cls, payload) => {
      role.value = "member";
      actionRead = { data: { id: ID, channel_slug: "x_ads", exec_class: cls, exec_status: null, exec_result: null, exec_payload: payload }, error: null };
      const out = await call({ request_id: "req-12345678" });
      expect(out._status).toBe(202);
      expect(role.calls).toHaveLength(0);
    });
    it("an admin may approve an X launch", async () => {
      role.value = "admin";
      actionRead = { data: { id: ID, channel_slug: "x_ads", exec_class: "x_ads.create_campaign", exec_status: null, exec_result: null, exec_payload: { launch: "ACTIVE" } }, error: null };
      const out = await call({ request_id: "req-12345678" });
      expect(out._status).toBe(202);
    });
    it.each([
      ["tiktok_ads.update_budget", { expected_current_daily_budget_usd: 50, daily_budget_usd: 60 }],
      ["tiktok_ads.update_budget", {}],
      ["tiktok_ads.set_status", { status: "ACTIVE" }],
      ["tiktok_ads.create_launch", { daily_budget_usd: 25 }],
    ])("a TikTok spend raise, resume or launch (%s) is owner/admin only", async (cls, payload) => {
      role.value = "member";
      actionRead = { data: { id: ID, channel_slug: "tiktok_ads", exec_class: cls, exec_status: null, exec_result: null, exec_payload: payload }, error: null };
      const out = await call({ request_id: "req-12345678" });
      expect(out._status).toBe(403);
      expect(rpcCalls).toHaveLength(0);
      expect(inngestSend).not.toHaveBeenCalled();
    });
    it.each([
      ["tiktok_ads.update_budget", { expected_current_daily_budget_usd: 60, daily_budget_usd: 50 }],
      ["tiktok_ads.set_status", { status: "PAUSED" }],
    ])("a TikTok cut or pause (%s) stays open to members", async (cls, payload) => {
      role.value = "member";
      actionRead = { data: { id: ID, channel_slug: "tiktok_ads", exec_class: cls, exec_status: null, exec_result: null, exec_payload: payload }, error: null };
      const out = await call({ request_id: "req-12345678" });
      expect(out._status).toBe(202);
      expect(role.calls).toHaveLength(0);
    });
    it.each([
      ["meta_ads.launch_campaign", { campaign: { daily_budget_usd: 30 } }],
      ["meta_ads.duplicate_campaign", { source_campaign_id: "1", daily_budget_usd: 20 }],
      ["meta_ads.duplicate_ad_set", { source_ad_set_id: "1", daily_budget_usd: 20 }],
      ["meta_ads.update_ad_set_budget", { expected_current_daily_budget_usd: 50, daily_budget_usd: 60 }],
      ["meta_ads.update_campaign_budget_review", { expected_current_daily_budget_usd: 50, daily_budget_usd: 60 }],
      ["meta_ads.update_campaign_budget", {}],
      ["meta_ads.set_status", { status: "ACTIVE" }],
      ["meta_ads.set_status_review", { status: "ACTIVE" }],
      ["meta_ads.update_ad", { ad_id: "1", status: "ACTIVE" }],
      ["meta_ads.create_ad", { ad_set_id: "1" }],
      ["meta_ads.duplicate_ad", { source_ad_id: "1", ad_set_id: "2" }],
      ["meta_ads.update_campaign", { campaign_id: "1", spend_cap_usd: null, expected_current_spend_cap_usd: 300 }],
      ["meta_ads.update_campaign", { campaign_id: "1", bid_strategy: "LOWEST_COST_WITHOUT_CAP", expected_current_bid_strategy: "COST_CAP" }],
      ["meta_ads.update_ad_set", { ad_set_id: "1", bid_amount_usd: 3, expected_current_bid_amount_usd: 2 }],
      ["meta_ads.update_ad_set", { ad_set_id: "1", end_time: "2026-12-31T00:00:00Z", expected_current_end_time: "2026-11-30T00:00:00Z" }],
    ])("a Meta launch, copy, raise or switch-on (%s) is owner/admin only", async (cls, payload) => {
      role.value = "member";
      actionRead = { data: { id: ID, channel_slug: "meta_ads", exec_class: cls, exec_status: null, exec_result: null, exec_payload: payload }, error: null };
      const out = await call({ request_id: "req-12345678" });
      expect(out._status).toBe(403);
      expect((out._body as { error: { message: string } }).error.message).toBe("Only a workspace owner or admin can approve this campaign.");
      expect(rpcCalls).toHaveLength(0);
      expect(inngestSend).not.toHaveBeenCalled();
    });
    it.each([
      ["meta_ads.update_ad_set_budget", { expected_current_daily_budget_usd: 60, daily_budget_usd: 50 }],
      ["meta_ads.update_campaign_budget", { expected_current_daily_budget_usd: 60, daily_budget_usd: 60 }],
      ["meta_ads.set_status", { status: "PAUSED" }],
      ["meta_ads.update_ad", { ad_id: "1", status: "PAUSED" }],
      ["meta_ads.update_ad_set", { ad_set_id: "1", bid_amount_usd: 2, expected_current_bid_amount_usd: 3 }],
      ["meta_ads.update_ad_set", { ad_set_id: "1", end_time: "2026-11-01T00:00:00Z", expected_current_end_time: "2026-11-30T00:00:00Z" }],
    ])("a Meta cut or pause (%s) stays open to members", async (cls, payload) => {
      role.value = "member";
      actionRead = { data: { id: ID, channel_slug: "meta_ads", exec_class: cls, exec_status: null, exec_result: null, exec_payload: payload }, error: null };
      const out = await call({ request_id: "req-12345678" });
      expect(out._status).toBe(202);
      expect(role.calls).toHaveLength(0);
    });
    it.each([
      ["google_ads.update_campaign_budget", { expected_current_daily_budget_usd: 20, daily_budget_usd: 30 }],
      ["google_ads.set_status", { status: "ENABLED" }],
      ["google_ads.add_keywords", { keywords: ["a"] }],
    ])("a Google raise (%s) is owner/admin only", async (cls, payload) => {
      role.value = "member";
      actionRead = { data: { id: ID, channel_slug: "google_ads", exec_class: cls, exec_status: null, exec_result: null, exec_payload: payload }, error: null };
      const out = await call({ request_id: "req-12345678" });
      expect(out._status).toBe(403);
      expect(rpcCalls).toHaveLength(0);
      expect(inngestSend).not.toHaveBeenCalled();
    });
    it.each([
      ["google_ads.update_campaign_budget", { expected_current_daily_budget_usd: 20, daily_budget_usd: 10 }],
      ["google_ads.set_status", { status: "PAUSED" }],
    ])("a Google cut or pause (%s) stays open to members", async (cls, payload) => {
      role.value = "member";
      actionRead = { data: { id: ID, channel_slug: "google_ads", exec_class: cls, exec_status: null, exec_result: null, exec_payload: payload }, error: null };
      const out = await call({ request_id: "req-12345678" });
      expect(out._status).toBe(202);
    });
    it.each(["owner", "admin"])("a Meta launch is approvable by an %s", async (r) => {
      role.value = r;
      actionRead = { data: { id: ID, channel_slug: "meta_ads", exec_class: "meta_ads.launch_campaign", exec_status: null, exec_result: null, exec_payload: {} }, error: null };
      const out = await call({ request_id: "req-12345678" });
      expect(out._status).toBe(202);
    });
    it.each([
      ["chatgpt_ads.create_and_launch", { name: "c" }],
      ["chatgpt_ads.create_campaign_bundle", {}],
      ["chatgpt_ads.update_campaign_budget", { daily_budget_usd: 60, expected_current_daily_budget_usd: 50 }],
      ["chatgpt_ads.update_campaign_budget", { daily_budget_usd: 60 }],
      ["chatgpt_ads.set_status", { status: "ACTIVE" }],
    ].flatMap(([c, p]) => [["chatgpt_ads", c, p], ["meta_ads", c, p]] as const))("a member approving a ChatGPT spend-up (%s: %s) is refused", async (slug, cls, payload) => {
      role.value = "member";
      actionRead = { data: { id: ID, channel_slug: slug, exec_class: cls, exec_status: null, exec_result: null, exec_payload: payload }, error: null };
      const out = await call({ request_id: "req-12345678" });
      expect(out._status).toBe(403);
      expect((out._body as { error: { message: string } }).error.message).toBe("Only a workspace owner or admin can approve this campaign.");
      expect(rpcCalls).toHaveLength(0);
      expect(inngestSend).not.toHaveBeenCalled();
    });
    it.each([
      ["chatgpt_ads.set_status", { status: "PAUSED" }],
      ["chatgpt_ads.update_campaign_budget", { daily_budget_usd: 40, expected_current_daily_budget_usd: 50 }],
      ["chatgpt_ads.update_campaign_budget", { daily_budget_usd: 50, expected_current_daily_budget_usd: 50 }],
    ].flatMap(([c, p]) => [["chatgpt_ads", c, p], ["meta_ads", c, p]] as const))("a member's ChatGPT pause or cut (%s: %s) is approvable", async (slug, cls, payload) => {
      role.value = "member";
      adsAuthCalls.length = 0;
      actionRead = { data: { id: ID, channel_slug: slug, exec_class: cls, exec_status: null, exec_result: null, exec_payload: payload }, error: null };
      const out = await call({ request_id: "req-12345678" });
      expect(out._status).toBe(202);
      expect(role.calls).toHaveLength(0);
      expect(adsAuthCalls).toEqual(slug === "chatgpt_ads" ? [false] : []);
    });
    it("a non-ChatGPT class on the ChatGPT channel stays owner/admin", async () => {
      role.value = "owner";
      actionRead = { data: { id: ID, channel_slug: "chatgpt_ads", exec_class: "meta_ads.set_status", exec_status: null, exec_result: null, exec_payload: { status: "PAUSED" } }, error: null };
      const out = await call({ request_id: "req-12345678" });
      expect(out._status).toBe(403);
      expect(rpcCalls).toHaveLength(0);
    });
    it("an ad change is not gated on role (unchanged)", async () => {
      role.value = "member";
      actionRead = { data: { id: ID, channel_slug: "meta_ads", exec_class: "meta_ads.raise_budget", exec_status: null, exec_result: null }, error: null };
      const out = await call({ request_id: "req-12345678" });
      expect(out._status).toBe(202);
      expect(role.calls).toHaveLength(0);
    });
  });

  describe("a ChatGPT launch the wallet cannot cover", () => {
    beforeEach(() => {
      role.value = "owner";
      walletShort.fn.mockReset().mockResolvedValue(null);
      actionRead = { data: { id: ID, channel_slug: "chatgpt_ads", status: "pending", exec_class: "chatgpt_ads.create_and_launch", exec_status: null, exec_result: null, exec_payload: { name: "c" } }, error: null };
      rpcResult = { data: { ok: true, attempt: 1, replayed: false }, error: null };
    });
    it("is refused with 409 chatgpt_wallet_short before anything is queued or sent", async () => {
      walletShort.fn.mockResolvedValue({ required_cents: 30000, available_cents: 16882, shortfall_cents: 13118 });
      const out = await call({ request_id: "req-12345678" });
      expect(out._status).toBe(409);
      expect(out._body).toEqual({
        error: {
          code: "chatgpt_wallet_short",
          message: "Your ChatGPT ads balance is $131.18 short of this campaign's schedule. Add balance, then approve.",
          required_cents: 30000,
          available_cents: 16882,
        },
      });
      expect(walletShort.fn).toHaveBeenCalledWith(TENANT, expect.objectContaining({ id: ID }));
      expect(rpcCalls).toHaveLength(0);
      expect(inngestSend).not.toHaveBeenCalled();
    });
    it.each([
      ["a snoozed card", { status: "snoozed" }],
      ["a retry after a failure", { exec_status: "failed", exec_result: { code: "chatgpt_wallet_short", bucket: "needs_founder" } }],
    ])("refuses %s too, before anything is queued", async (_name, over) => {
      actionRead = { data: { ...(actionRead.data as Record<string, unknown>), ...over }, error: null };
      walletShort.fn.mockResolvedValue({ required_cents: 30000, available_cents: 16882, shortfall_cents: 13118 });
      const out = await call({ request_id: "req-12345678" });
      expect(out._status).toBe(409);
      expect((out._body as { error: { code: string } }).error.code).toBe("chatgpt_wallet_short");
      expect(walletShort.fn).toHaveBeenCalledWith(TENANT, expect.objectContaining(over));
      expect(rpcCalls).toHaveLength(0);
    });
    it("goes ahead as before when the preflight does not block (an envelope, a covered or unreadable wallet)", async () => {
      const out = await call({ request_id: "req-12345678" });
      expect(out._status).toBe(202);
      expect(rpcCalls.map((c) => c.fn)).toEqual(["approve_channel_action"]);
      expect(inngestSend).toHaveBeenCalledTimes(1);
    });
    it("is not consulted for other channels' changes", async () => {
      actionRead = { data: { id: ID, channel_slug: "meta_ads", exec_class: "meta_ads.raise_budget", exec_status: null, exec_result: null }, error: null };
      await call({ request_id: "req-12345678" });
      expect(walletShort.fn).not.toHaveBeenCalled();
    });
  });

  describe("an AI UGC video card the founder cannot make right now", () => {
    const INTAKE = {
      prompt: "A generic AI presenter at a desk. Vertical 9:16 UGC-style video.",
      intent: "talking_head",
      premium: false,
      aspect_ratio: "9:16",
      script: "Setup took four minutes and that was the whole job. Connect the calendar, pick the shifts, and the rota fills itself every week.",
    };
    beforeEach(() => {
      role.value = "owner";
      videoGate.router = true;
      videoGate.video = true;
      videoGate.afford = "ok";
      videoGate.locked = false;
      videoGate.lockReads.length = 0;
      videoGate.affordCalls.length = 0;
      actionRead = { data: { id: ID, channel_slug: "generated_video", status: "pending", exec_class: "generated_video.render.v1", exec_status: null, exec_result: null, exec_payload: { intake: INTAKE, format: "product_demo" } }, error: null };
      rpcResult = { data: { ok: true, attempt: 1, replayed: false }, error: null };
    });
    it.each([
      ["video making is switched off for the workspace", { video: false }],
      ["the media router is off", { router: false }],
    ])("is refused with the switched-off 503 when %s, and nothing is queued, sent or priced", async (_n, over) => {
      Object.assign(videoGate, over);
      const out = await call({ request_id: "req-12345678" });
      expect(out._status).toBe(503);
      expect(out._body).toEqual({ error: { code: "video_unavailable", message: "Video making is switched off right now, so nothing was made and nothing was charged. Try again later." } });
      expect(rpcCalls).toHaveLength(0);
      expect(inngestSend).not.toHaveBeenCalled();
      expect(videoGate.affordCalls).toHaveLength(0);
    });
    it.each([
      ["staff switched AI UGC Videos off", true],
      ["the switch cannot be read", "unreadable"],
    ] as const)("is refused with the channel switched-off copy when %s, and nothing is queued, sent or priced", async (_n, locked) => {
      videoGate.locked = locked;
      videoGate.afford = "short";
      const out = await call({ request_id: "req-12345678" });
      expect(out._status).toBe(503);
      expect(out._body).toEqual({ error: { code: "video_unavailable", message: "AI UGC Videos is switched off right now, so nothing was made and nothing was charged." } });
      expect(videoGate.lockReads).toEqual(["generated_video"]);
      expect(rpcCalls).toHaveLength(0);
      expect(inngestSend).not.toHaveBeenCalled();
      expect(videoGate.affordCalls).toHaveLength(0);
    });
    it("is refused with 402 insufficient_credits for this card's own price when the wallet is short, before anything is queued", async () => {
      videoGate.afford = "short";
      const { billedVideoUsd, videoCreditsOf } = await import("@/services/launch-video/video-estimate");
      const usd = await billedVideoUsd(INTAKE as never);
      const out = await call({ request_id: "req-12345678" });
      expect(out._status).toBe(402);
      const err = (out._body as { error: { code: string; message: string; required_credits: number } }).error;
      expect(err.code).toBe("insufficient_credits");
      expect(err.required_credits).toBe(videoCreditsOf(usd));
      expect(err.message).toContain(`${videoCreditsOf(usd).toLocaleString("en-US")} credits`);
      expect(videoGate.affordCalls).toEqual([[TENANT, usd]]);
      expect(rpcCalls).toHaveLength(0);
      expect(inngestSend).not.toHaveBeenCalled();
    });
    it("refuses a retry after a failed render the same way", async () => {
      videoGate.afford = "short";
      actionRead = { data: { ...(actionRead.data as Record<string, unknown>), exec_status: "failed", exec_result: { code: "insufficient_credits" } }, error: null };
      const out = await call({ request_id: "req-12345678" });
      expect(out._status).toBe(402);
      expect(rpcCalls).toHaveLength(0);
    });
    it.each(["ok", "unknown"])("queues as before when the wallet read is %s (the worker still fails closed)", async (a) => {
      videoGate.afford = a;
      const out = await call({ request_id: "req-12345678" });
      expect(out._status).toBe(202);
      expect(rpcCalls.map((c) => c.fn)).toEqual(["approve_channel_action"]);
      expect(inngestSend).toHaveBeenCalledTimes(1);
    });
    it("is not consulted for other channels' changes", async () => {
      videoGate.video = false;
      actionRead = { data: { id: ID, channel_slug: "meta_ads", exec_class: "meta_ads.raise_budget", exec_status: null, exec_result: null }, error: null };
      const out = await call({ request_id: "req-12345678" });
      expect(out._status).toBe(202);
    });
  });

  it("queues through the RPC with the authed tenant and user, then fires ONE event", async () => {
    rpcResult = { data: { ok: true, attempt: 1, replayed: false }, error: null };
    const r = await call({ request_id: "req-12345678", tenant_id: "evil" });
    expect(r._status).toBe(202);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]).toMatchObject({
      fn: "approve_channel_action",
      tid: TENANT,
      args: { p_action_id: ID, p_event_key: "req-12345678", p_actor_user_id: "u-1", p_source: null },
    });
    expect(rpcCalls[0].args).not.toHaveProperty("p_tenant_id");
    expect(inngestSend).toHaveBeenCalledTimes(1);
    const sent = inngestSend.mock.calls[0]![0] as { id?: string; name: string; data: Record<string, unknown> };
    expect(sent.name).toBe("channel-action.approved");
    expect(sent.data).toEqual({ action_id: ID });
    expect(sent.id).toBe(`approve:${ID}:1`);
  });

  it("a SECOND overlapping Approve re-sends the SAME id, so Inngest still runs it once", async () => {
    rpcResult = {
      data: { ok: true, queued: true, replayed: true, exec_status: "queued", attempt: 1 },
      error: null,
    };
    const r = await call({ request_id: "req-second-1" });
    expect(r._status).toBe(200);
    expect(inngestSend).toHaveBeenCalledTimes(1);
    expect(inngestSend.mock.calls[0]![0].id).toBe(`approve:${ID}:1`);
  });

  it("an Approve on a row the worker already claimed sends NOTHING", async () => {
    rpcResult = {
      data: { ok: true, queued: true, replayed: true, exec_status: "dispatching", attempt: 1 },
      error: null,
    };
    const r = await call({ request_id: "req-second-2" });
    expect(r._status).toBe(200);
    expect(inngestSend).not.toHaveBeenCalled();
  });

  it.each(["exec_partial", "exec_outcome_unknown"])("refuses a re-approve after a %s failure with 409 exec_partial_no_retry", async (code) => {
    actionRead = { data: { id: ID, channel_slug: "google_ads", exec_class: "google_ads.set_status", exec_status: "failed", exec_result: { code, error: "x" } }, error: null };
    rpcResult = { data: { ok: true, attempt: 2, replayed: false }, error: null };
    const r = await call({ request_id: "req-retry-002" });
    expect(r._status).toBe(409);
    expect((r._body as { error: { code: string } }).error.code).toBe("exec_partial_no_retry");
    expect(rpcCalls).toHaveLength(0);
    expect(inngestSend).not.toHaveBeenCalled();
  });

  it("maps the RPC's exec_partial_no_retry (raced past the pre-check) to 409, nothing sent", async () => {
    actionRead = { data: { id: ID, channel_slug: "google_ads", exec_class: "google_ads.create_ad", exec_status: "dispatching", exec_result: null }, error: null };
    rpcResult = { data: { ok: false, code: "exec_partial_no_retry" }, error: null };
    const r = await call({ request_id: "req-race-001" });
    expect(r._status).toBe(409);
    expect((r._body as { error: { code: string; message: string } }).error).toMatchObject({
      code: "exec_partial_no_retry",
      message: expect.stringMatching(/will not run it again/i),
    });
    expect(rpcCalls).toHaveLength(1);
    expect(inngestSend).not.toHaveBeenCalled();
  });

  it("refuses a re-approve of a blocked_on_us card with 409 exec_blocked_no_retry, before the RPC", async () => {
    actionRead = { data: { id: ID, channel_slug: "youtube_ads", exec_class: "google_ads.create_campaign", exec_status: "failed", exec_result: { error: "x", bucket: "blocked_on_us" } }, error: null };
    rpcResult = { data: { ok: true, attempt: 2, replayed: false }, error: null };
    const r = await call({ request_id: "req-blocked-001" });
    expect(r._status).toBe(409);
    expect((r._body as { error: unknown }).error).toEqual({
      code: "exec_blocked_no_retry",
      message: "The platform refused this change, so it can't be run again. We've been alerted.",
    });
    expect(rpcCalls).toHaveLength(0);
    expect(inngestSend).not.toHaveBeenCalled();
  });

  it("maps the RPC's exec_blocked_no_retry (raced past the pre-check) to 409 with the same words, nothing sent", async () => {
    actionRead = { data: { id: ID, channel_slug: "google_ads", exec_class: "google_ads.create_campaign", exec_status: "dispatching", exec_result: null }, error: null };
    rpcResult = { data: { ok: false, code: "exec_blocked_no_retry" }, error: null };
    const r = await call({ request_id: "req-blocked-002" });
    expect(r._status).toBe(409);
    expect((r._body as { error: unknown }).error).toEqual({
      code: "exec_blocked_no_retry",
      message: "The platform refused this change, so it can't be run again. We've been alerted.",
    });
    expect(inngestSend).not.toHaveBeenCalled();
  });

  it("a partial_risk verdict is refused like a partial-risk code", async () => {
    actionRead = { data: { id: ID, channel_slug: "google_ads", exec_class: "google_ads.create_campaign", exec_status: "failed", exec_result: { error: "x", code: "google_ads_mutate_incomplete", bucket: "partial_risk" } }, error: null };
    const r = await call({ request_id: "req-partial-bucket" });
    expect(r._status).toBe(409);
    expect((r._body as { error: { code: string } }).error.code).toBe("exec_partial_no_retry");
    expect(rpcCalls).toHaveLength(0);
  });

  it.each(["needs_founder", "temporary"])("a %s failure stays approvable (Try again)", async (bucket) => {
    role.value = "owner";
    actionRead = { data: { id: ID, channel_slug: "meta_ads", exec_class: "meta_ads.set_status", exec_status: "failed", exec_result: { error: "x", bucket } }, error: null };
    rpcResult = { data: { ok: true, attempt: 2, replayed: false }, error: null };
    expect((await call({ request_id: `req-retry-${bucket}` }))._status).toBe(202);
  });

  it("still allows a re-approve after an ordinary failure", async () => {
    actionRead = { data: { id: ID, channel_slug: "google_ads", exec_class: "google_ads.set_status", exec_status: "failed", exec_result: { code: "google_ads_budget_drift", error: "x" } }, error: null };
    rpcResult = { data: { ok: true, attempt: 2, replayed: false }, error: null };
    expect((await call({ request_id: "req-retry-003" }))._status).toBe(202);
  });

  it("a re-approve after a failure is a NEW attempt, so a NEW event id", async () => {
    rpcResult = { data: { ok: true, attempt: 2, replayed: false }, error: null };
    await call({ request_id: "req-retry-001" });
    expect(inngestSend.mock.calls[0]![0].id).toBe(`approve:${ID}:2`);
  });

  it("an RPC refusal sends nothing: not_found 404, not_executable 409", async () => {
    rpcResult = { data: { ok: false, code: "not_found" }, error: null };
    expect((await call({ request_id: "req-12345678" }))._status).toBe(404);
    rpcResult = { data: { ok: false, code: "not_executable" }, error: null };
    expect((await call({ request_id: "req-12345678" }))._status).toBe(409);
    rpcResult = { data: { ok: false, code: "already_executed" }, error: null };
    expect((await call({ request_id: "req-12345678" }))._status).toBe(409);
    expect(inngestSend).not.toHaveBeenCalled();
  });

  it("a failed enqueue says so instead of reporting a success nobody will run", async () => {
    rpcResult = { data: { ok: true, attempt: 1, replayed: false }, error: null };
    inngestSend.mockRejectedValueOnce(new Error("inngest down"));
    const r = await call({ request_id: "req-12345678" });
    expect(r._status).toBe(502);
  });

  it("400s a missing request_id, and 403s an overridden tenant, before any write", async () => {
    expect((await call({}))._status).toBe(400);
    authResult = { ...authResult!, tenant_overridden: true };
    expect((await call({ request_id: "req-12345678" }))._status).toBe(403);
    expect(rpcCalls).toHaveLength(0);
    expect(inngestSend).not.toHaveBeenCalled();
  });
});

describe("POST /api/channel-actions/:id/steps", () => {
  const call = async (body: unknown, id = ID) => {
    const r = res();
    await channelActionSteps({ params: { id }, body } as unknown as Request, r as unknown as Response);
    return r;
  };

  it("saves the ticks with the auth tenant and actor, never the body's", async () => {
    rpcResult = { data: { ok: true, steps_done: [0, 2] }, error: null };
    const r = await call({ steps_done: [0, 2], tenant_id: "someone-else" });
    expect(r._status).toBe(200);
    expect(r._body).toEqual({ ok: true, steps_done: [0, 2] });
    expect(rpcCalls).toEqual([
      { fn: "set_channel_action_steps", tid: TENANT, args: { p_action_id: ID, p_steps_done: [0, 2], p_actor_user_id: "u-1" } },
    ]);
  });

  it("401s without auth and 400s a bad id, with no RPC", async () => {
    authResult = null;
    expect((await call({ steps_done: [] }))._status).toBe(401);
    authResult = { tenant_id: TENANT, user_id: "u-1", access_token: "tok" };
    expect((await call({ steps_done: [] }, "not-a-uuid"))._status).toBe(400);
    expect(rpcCalls).toHaveLength(0);
  });

  it("rejects duplicates, negatives, fractions, out-of-range and non-arrays before the RPC", async () => {
    for (const steps_done of [[1, 1], [-1], [1.5], [12], "0", null, Array.from({ length: 13 }, (_, i) => i % 12)]) {
      const r = await call({ steps_done });
      expect(r._status, JSON.stringify(steps_done)).toBe(400);
    }
    expect(rpcCalls).toHaveLength(0);
  });

  it("maps refusals: another tenant's card 404, mid-execution 409, invalid 400", async () => {
    for (const [code, status] of [["not_found", 404], ["exec_in_flight", 409], ["illegal_transition", 409], ["invalid_steps", 400]] as const) {
      rpcResult = { data: { ok: false, code }, error: null };
      expect((await call({ steps_done: [0] }))._status).toBe(status);
    }
  });

  it("a thrown RPC call (e.g. not registered) is a 500 with no detail, never an unhandled rejection", async () => {
    rpcThrow = new Error("tenantRpc: RPC 'set_channel_action_steps' is not in the tenant-RPC registry");
    const r = await call({ steps_done: [0] });
    expect(r._status).toBe(500);
    expect(JSON.stringify(r._body)).not.toContain("registry");
  });

  it("a database error is a 500 with no detail", async () => {
    rpcResult = { data: null, error: { message: "boom secret detail" } };
    const r = await call({ steps_done: [0] });
    expect(r._status).toBe(500);
    expect(JSON.stringify(r._body)).not.toContain("secret");
  });
});

describe("managed campaign approval boundary", () => {
  it("refuses a non-admin before queuing a managed campaign", async () => {
    role.value = "member";
    actionRead = { data: { channel_slug: "chatgpt_ads", exec_class: "chatgpt_ads.create_campaign_bundle" }, error: null };
    const response = res();
    await channelActionApprove({ params: { id: ID }, body: { request_id: "review-approve-123" } } as unknown as Request, response as unknown as Response);
    expect(response._status).toBe(403); expect(rpcCalls).toHaveLength(0); expect(inngestSend).not.toHaveBeenCalled();
  });
  it("fails closed if the action's authorization scope cannot be read", async () => {
    actionRead = { data: null, error: { message: "unavailable" } };
    const response = res();
    await channelActionApprove({ params: { id: ID }, body: { request_id: "review-approve-123" } } as unknown as Request, response as unknown as Response);
    expect(response._status).toBe(503); expect(rpcCalls).toHaveLength(0); expect(inngestSend).not.toHaveBeenCalled();
  });
});

describe("the plan: Zavi applying a card needs it, the founder closing one does not", () => {
  const approve = async () => {
    const r = res();
    await channelActionApprove({ params: { id: ID }, body: { request_id: "req-12345678" } } as unknown as Request, r as unknown as Response);
    return r;
  };
  const set = async (body: unknown) => {
    const r = res();
    await channelActionSet({ params: { id: ID }, body } as unknown as Request, r as unknown as Response);
    return r;
  };
  const execCard = (channel_slug: string, exec_class: string) => {
    role.value = "owner";
    actionRead = { data: { id: ID, channel_slug, exec_class, exec_status: null, exec_result: null }, error: null };
    rpcResult = { data: { ok: true, attempt: 1, replayed: false }, error: null };
  };

  it("Free: approving an executable card on a Starter channel is a 403 with the upgrade body, nothing queued", async () => {
    tenantPlan.tier = "free";
    execCard("seo", "site_pr.apply");
    const out = await approve();
    expect(out._status).toBe(403);
    expect(out._body).toMatchObject({ error: { code: "plan_upgrade_required", required_tier: "starter" } });
    expect(rpcCalls).toHaveLength(0);
    expect(inngestSend).not.toHaveBeenCalled();
  });

  it("Starter: the same approval is queued as before", async () => {
    tenantPlan.tier = "starter";
    execCard("seo", "site_pr.apply");
    const out = await approve();
    expect(out._status).toBe(202);
    expect(inngestSend).toHaveBeenCalledTimes(1);
  });

  it("Starter on a Pro channel (a downgrade since the card was proposed) is refused with Pro", async () => {
    tenantPlan.tier = "starter";
    execCard("reddit_ads", "reddit_ads.set_object_status");
    const out = await approve();
    expect(out._status).toBe(403);
    expect(out._body).toMatchObject({ error: { code: "plan_upgrade_required", required_tier: "pro" } });
    expect(inngestSend).not.toHaveBeenCalled();
  });

  it("Starter on the Pro LinkedIn channel: a pause is still queued, because it only stops spend", async () => {
    tenantPlan.tier = "starter";
    execCard("linkedin_ads", "linkedin_ads.set_status");
    const out = await approve();
    expect(out._status).toBe(202);
    expect(rpcCalls).toHaveLength(1);
    expect(inngestSend).toHaveBeenCalledTimes(1);
  });

  it("Starter on the Pro LinkedIn channel: a new campaign is still refused with Pro", async () => {
    tenantPlan.tier = "starter";
    execCard("linkedin_ads", "linkedin_ads.create_campaign_bundle");
    const out = await approve();
    expect(out._status).toBe(403);
    expect(out._body).toMatchObject({ error: { code: "plan_upgrade_required", required_tier: "pro" } });
    expect(rpcCalls).toHaveLength(0);
    expect(inngestSend).not.toHaveBeenCalled();
  });

  it("an unreadable plan refuses the approval rather than queuing it", async () => {
    tenantPlan.unreadable = true;
    execCard("seo", "site_pr.apply");
    expect((await approve())._status).toBe(403);
    expect(inngestSend).not.toHaveBeenCalled();
  });

  it.each(["acted", "rejected", "snoozed"] as const)("Free: marking a card %s stays open, with no plan check", async (action) => {
    tenantPlan.tier = "free";
    tenantPlan.unreadable = true;
    rpcResult = { data: { ok: true, status: action, replayed: false }, error: null };
    const until = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString();
    const out = await set({ action, request_id: "req-12345678", ...(action === "snoozed" ? { until } : {}) });
    expect(out._status).toBe(200);
    expect(rpcCalls[0]).toMatchObject({ fn: "set_channel_action", args: { p_status: action } });
  });
});

describe("the staff lock: a Coming soon channel takes no spend on approve, a pause still goes", () => {
  const approve = async () => {
    const r = res();
    await channelActionApprove({ params: { id: ID }, body: { request_id: "req-12345678" } } as unknown as Request, r as unknown as Response);
    return r;
  };
  const execCard = (channel_slug: string, exec_class: string, exec_payload: unknown = {}) => {
    role.value = "owner";
    actionRead = { data: { id: ID, channel_slug, exec_class, exec_payload, exec_status: null, exec_result: null }, error: null };
    rpcResult = { data: { ok: true, attempt: 1, replayed: false }, error: null };
  };

  it("a new LinkedIn campaign on a locked channel is a 403 coming_soon with the channel's name, nothing queued", async () => {
    lock.slugs = new Set(["linkedin_ads"]);
    execCard("linkedin_ads", "linkedin_ads.create_campaign_bundle");
    const out = await approve();
    expect(out._status).toBe(403);
    expect(out._body).toEqual({ error: { code: "coming_soon", message: "LinkedIn Ads is coming soon." } });
    expect(lock.reads).toEqual(["linkedin_ads"]);
    expect(rpcCalls).toHaveLength(0);
    expect(inngestSend).not.toHaveBeenCalled();
  });

  it("a LinkedIn pause on the same locked channel is still queued, and never reads the lock", async () => {
    lock.slugs = new Set(["linkedin_ads"]);
    execCard("linkedin_ads", "linkedin_ads.set_status");
    const out = await approve();
    expect(out._status).toBe(202);
    expect(lock.reads).toEqual([]);
    expect(inngestSend).toHaveBeenCalledTimes(1);
  });

  it("an unreadable lock refuses the new campaign with 503 rather than queuing it", async () => {
    lock.unreadable = true;
    execCard("linkedin_ads", "linkedin_ads.create_campaign_bundle");
    const out = await approve();
    expect(out._status).toBe(503);
    expect(out._body).toMatchObject({ error: { code: "authorization_unavailable" } });
    expect(rpcCalls).toHaveLength(0);
    expect(inngestSend).not.toHaveBeenCalled();
  });

  it("a lock on another channel does not touch a LinkedIn campaign", async () => {
    lock.slugs = new Set(["meta_ads"]);
    execCard("linkedin_ads", "linkedin_ads.create_campaign_bundle");
    const out = await approve();
    expect(out._status).toBe(202);
    expect(inngestSend).toHaveBeenCalledTimes(1);
  });
});

describe("persistent channel post drafts", () => {
  let server: Server;
  let origin = "";
  beforeAll(async () => {
    const app = express(); app.use(express.json());
    app.get("/draft/:id", channelPostDraftRead); app.put("/draft/:id", channelPostDraftSave);
    await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test address");
    origin = `http://127.0.0.1:${address.port}`;
  });
  afterAll(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  async function callDraft(method: "GET" | "PUT", body?: unknown, staged = false) {
    const response = await fetch(`${origin}/draft/${ID}${staged ? "?store=decisions" : ""}`, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  beforeEach(() => {
    draftWrites.length = 0;
    role.value = "owner";
    actionRead = { data: { id: ID, body: { text: "Original" }, edited_body: null, status: "pending", action_type: "text_post", exec_class: null, exec_status: null, approved_by: null }, error: null };
  });
  async function readRevision() {
    const answer = await callDraft("GET");
    expect(answer.status).toBe(200);
    return z.object({ revision: z.string(), editable: z.boolean() }).parse(answer.body).revision;
  }
  it("saves without approving and compares both the original body and previous edit", async () => {
    const revision = await readRevision();
    const answer = await callDraft("PUT", { revision, content: { text: "Saved", thread: null } });
    expect(answer.status).toBe(200);
    expect(draftWrites[0].values).toEqual({ edited_body: { text: "Saved", thread: null } });
    expect(draftWrites[0].filters).toEqual(expect.arrayContaining([["status", "pending"], ["exec_class", null], ["exec_status", null], ["approved_by", null], ["edited_body", null]]));
    expect(rpcCalls).toHaveLength(0);
  });
  it("refuses stale versions without writing", async () => {
    const answer = await callDraft("PUT", { revision: "0".repeat(64), content: { text: "Wrong", thread: null } });
    expect(answer.status).toBe(409); expect(draftWrites).toHaveLength(0);
  });
  it("keeps the returned revision valid after a JSONB round trip, including nested variants", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const db = new PGlite();
    try {
      if (!actionRead.data) throw new Error("Missing row");
      actionRead.data.body = { text: "Original", step: { deliverable: { kind: "post", content: "Original" } } };
      const revision = await readRevision();
      const answer = await callDraft("PUT", { revision, content: { text: "Saved", thread: null, variant_index: 1 } });
      expect(answer.status).toBe(200);
      const saved = z.object({ revision: z.string(), content: z.unknown() }).parse(answer.body);
      const roundTrip = await db.query<{ body: unknown; edited_body: unknown }>("select $1::jsonb as body, $2::jsonb as edited_body", [JSON.stringify(actionRead.data.body), JSON.stringify(saved.content)]);
      Object.assign(actionRead.data, roundTrip.rows[0]);
      expect(await readRevision()).toBe(saved.revision);
      expect((await callDraft("PUT", { revision: saved.revision, content: { text: "Saved again", thread: null, variant_index: 0 } })).status).toBe(200);
      const latest = z.object({ edited_body: z.unknown() }).parse(draftWrites.at(-1)?.values);
      actionRead.data.edited_body = latest.edited_body;
      const writes = draftWrites.length;
      expect((await callDraft("PUT", { revision: saved.revision, content: null })).status).toBe(409);
      expect(draftWrites).toHaveLength(writes);
    } finally { await db.close(); }
  });
  it("refuses media owned by another tenant", async () => {
    if (!actionRead.data) throw new Error("Missing row");
    actionRead.data.action_type = "image_post";
    const revision = await readRevision();
    const answer = await callDraft("PUT", { revision, content: { text: "Caption", thread: null, image_path: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jpg" } });
    expect(answer.status).toBe(403); expect(draftWrites).toHaveLength(0);
  });
  it("refuses executable and already approved cards", async () => {
    if (!actionRead.data) throw new Error("Missing row");
    actionRead.data.exec_class = "social.publish.v2";
    const answer = await callDraft("GET");
    expect(answer.status).toBe(404);
  });
  it("saves a staged social draft without approving or dispatching it", async () => {
    actionRead = { data: { id: ID, status: "proposed", decision_class: "social.publish.v2", body: { channel: "x", payload: { text: "Original staged copy" }, scheduled_at: null } }, error: null };
    const read = await callDraft("GET", undefined, true);
    const revision = z.object({ revision: z.string() }).parse(read.body).revision;
    const saved = await callDraft("PUT", { revision, content: { text: "Edited staged copy", thread: null } }, true);
    expect(saved.status).toBe(200);
    expect(draftWrites[0].values).toMatchObject({ body: { channel: "x", payload: { text: "Edited staged copy" }, post_draft_original: { channel: "x", payload: { text: "Original staged copy" } } } });
    expect(draftWrites[0].filters).toEqual(expect.arrayContaining([["status", "proposed"], ["decision_class", "social.publish.v2"]]));
    expect(rpcCalls).toHaveLength(0);
  });
  it("keeps edits for other variants when saving one variant", async () => {
    if (!actionRead.data) throw new Error("Missing row");
    actionRead.data.edited_body = { text: "First", thread: null, variant_index: 0, variants: { "0": { text: "First", thread: null } } };
    const revision = await readRevision();
    const answer = await callDraft("PUT", { revision, content: { text: "Second", thread: null, variant_index: 1 } });
    expect(answer.status).toBe(200);
    expect(draftWrites[0].values).toMatchObject({ edited_body: { variants: { "0": { text: "First" }, "1": { text: "Second" } } } });
  });
});
