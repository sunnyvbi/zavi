
import { describe, it, expect, vi, beforeEach } from "vitest";

const ensureAgentRunnable = vi.fn();
const resolveDecisionReviser = vi.fn();
const canUserAccessAgent = vi.fn();
const requireAuth = vi.fn();
const inngestSend = vi.fn();

let decisionRow: Record<string, unknown> | null = null;

let channelActionRow: Record<string, unknown> | null = null;
let channelActionError: { message: string } | null = null;
const channelActionReads: Array<{ tenant: string; table: string; id: unknown }> = [];

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: (tenant: string) => ({
    from: (table: string) => {
      let id: unknown;
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          if (col === "id") id = val;
          return chain;
        },
        maybeSingle: async () => {
          channelActionReads.push({ tenant, table, id });
          if (channelActionError) return { data: null, error: channelActionError };
          return { data: channelActionRow, error: null };
        },
      };
      return chain;
    },
  }),
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: (...a: unknown[]) => requireAuth(...a),
}));
vi.mock("@/services/auth/members", () => ({
  canUserAccessAgent: (...a: unknown[]) => canUserAccessAgent(...a),
}));
vi.mock("@/services/agents/ensure-runnable", () => ({
  ensureAgentRunnable: (...a: unknown[]) => ensureAgentRunnable(...a),
}));
vi.mock("@/services/decisions/reviser", () => ({
  resolveDecisionReviser: (...a: unknown[]) => resolveDecisionReviser(...a),
}));
vi.mock("@/../workers/client", () => ({
  inngest: { send: (...a: unknown[]) => inngestSend(...a) },
}));
vi.mock("@/services/agents/run-lane", () => ({
  buildRunRequestedEvent: () => ({ name: "agent.run.requested", data: {} }),
}));

function makeSb() {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  Object.assign(chain, {
    from: self,
    select: self,
    eq: self,
    in: self,
    is: self,
    order: self,
    limit: self,
    insert: self,
    update: self,
    maybeSingle: async () => ({ data: decisionRow, error: null }),
    single: async () => ({
      data: { id: "rev-1", status: "requested", message: "m", created_at: "t" },
      error: null,
    }),
    then: undefined,
    rpc: async () => ({
      data: { thread_id: "th-1", user_message_id: "um-1", run_id: "run-1" },
      error: null,
    }),
  });
  (chain as { select: unknown }).select = (
    _cols?: string,
    opts?: { count?: string; head?: boolean },
  ) => {
    if (opts?.count) {
      return Object.assign(Object.create(chain), {
        eq: () => Object.assign(Object.create(chain), {
          eq: () => Object.assign(Object.create(chain), {
            in: async () => ({ count: 0, error: null }),
          }),
        }),
      });
    }
    return chain;
  };
  return chain;
}

vi.mock("@/services/supabase", () => ({
  serviceClient: () => makeSb(),
  serverClientFromBearer: () => makeSb(),
}));

import { approvalsRevisionRequest } from "@/routes/approvals/revision";

function makeRes() {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (c: number) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b: unknown) => {
    res.body = b;
    return res;
  };
  return res as { statusCode: number; body: any; status: unknown; json: unknown };
}

const OTHER_STORE_ID = "22222222-2222-4222-8222-222222222222";

async function postUnknownToDecisions(id = OTHER_STORE_ID) {
  decisionRow = null;
  const res = makeRes();
  await approvalsRevisionRequest(
    { params: { decision_id: id }, body: { message: "make it smaller" } } as never,
    res as never,
  );
  return res;
}

async function postRevision(
  decision: { decision_class: string; body: Record<string, unknown> },
  message: string,
) {
  decisionRow = {
    id: "11111111-1111-4111-8111-111111111111",
    tenant_id: "t-1",
    agent_run_id: "run-0",
    handler: null,
    status: "proposed",
    ...decision,
  };
  const res = makeRes();
  await approvalsRevisionRequest(
    {
      params: { decision_id: "11111111-1111-4111-8111-111111111111" },
      body: { message },
    } as never,
    res as never,
  );
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  channelActionRow = null;
  channelActionError = null;
  channelActionReads.length = 0;
  requireAuth.mockResolvedValue({
    tenant_id: "t-1",
    user_id: "u-1",
    access_token: "tok",
  });
  canUserAccessAgent.mockResolvedValue(true);
  resolveDecisionReviser.mockResolvedValue({ ok: true, slug: "seo" });
  ensureAgentRunnable.mockResolvedValue({
    runnable: true,
    agent: { content_hash: "h" },
  });
  inngestSend.mockResolvedValue(undefined);
});

describe("approvals revision — channel actions", () => {
  it("passes CHANNEL origin when revising a channel action", async () => {
    await postRevision(
      {
        decision_class: "channel.recipe_step",
        body: { step: { title: "Add an H1" } },
      },
      "shorter",
    );
    expect(ensureAgentRunnable).toHaveBeenCalledWith(
      expect.any(String),
      "seo",
      { origin: "channel" },
    );
  });

  it("still passes STANDARD origin for a meta_ads decision", async () => {
    resolveDecisionReviser.mockResolvedValue({
      ok: true,
      slug: "performance-marketer",
    });
    await postRevision(
      { decision_class: "meta_ads.set_status", body: {} },
      "pause it",
    );
    expect(ensureAgentRunnable).toHaveBeenCalledWith(
      expect.any(String),
      "performance-marketer",
      { origin: "standard" },
    );
  });

  it("accepts a channel.recipe_step decision (was 400 unsupported_decision_class)", async () => {
    const res = await postRevision(
      {
        decision_class: "channel.recipe_step",
        body: { step: { title: "t" } },
      },
      "shorter",
    );
    expect(res.statusCode).not.toBe(400);
  });

  it("rejects a channel class that was never opted in", async () => {
    const res = await postRevision(
      { decision_class: "channel.launch_campaign", body: {} },
      "change it",
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe("unsupported_decision_class");
  });

  it("still rejects a class no family claims", async () => {
    const res = await postRevision(
      { decision_class: "engineer.ship-pr", body: {} },
      "change it",
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe("unsupported_decision_class");
  });
});

describe("approvals revision — an id from the channel_actions store", () => {
  it("names the redo rail instead of reporting a row that exists as missing", async () => {
    channelActionRow = { id: OTHER_STORE_ID };
    const res = await postUnknownToDecisions();
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe("wrong_store");
    expect(res.body.error.action_source).toBe("channel_action");
    expect(res.body.error.message).toContain("/api/channel-actions/:id/redo");
  });

  it("asks the other store for the SAME id, scoped to the caller's tenant", async () => {
    channelActionRow = { id: OTHER_STORE_ID };
    await postUnknownToDecisions();
    expect(channelActionReads).toEqual([
      { tenant: "t-1", table: "channel_actions", id: OTHER_STORE_ID },
    ]);
  });

  it("an id in NEITHER store is still a plain not-found", async () => {
    channelActionRow = null;
    const res = await postUnknownToDecisions();
    expect(res.statusCode).toBe(404);
    expect(res.body.error.code).toBe("decision_not_found");
  });

  it("a failed read of the other store falls back to not-found, never a 500", async () => {
    channelActionError = { message: "channel_actions unavailable" };
    const res = await postUnknownToDecisions();
    expect(res.statusCode).toBe(404);
    expect(res.body.error.code).toBe("decision_not_found");
  });

  it("a decision the route CAN serve never touches the other store", async () => {
    resolveDecisionReviser.mockResolvedValue({ ok: true, slug: "performance-marketer" });
    await postRevision({ decision_class: "meta_ads.set_status", body: {} }, "pause it");
    expect(channelActionReads).toEqual([]);
  });
});
