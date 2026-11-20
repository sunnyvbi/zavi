
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const m = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  auth: null as null | { user_id: string; tenant_id: string; access_token: string },
  rpc: vi.fn(),
  enqueue: vi.fn(),
  channelGuild: {} as Record<string, string>,
  failTable: null as string | null,
}));

function query(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let sorted = false;
  let asc = false;
  let cap = Infinity;
  let op: "select" | "update" | "delete" = "select";
  let patch: Row = {};
  const run = () => {
    if (op === "update") {
      const hit = (m.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      hit.forEach((r) => Object.assign(r, patch));
      return hit;
    }
    if (op === "delete") {
      const all = m.tables[table] ?? [];
      const hit = all.filter((r) => filters.every((f) => f(r)));
      m.tables[table] = all.filter((r) => !hit.includes(r));
      return hit;
    }
    const rows = (m.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
    if (sorted) rows.sort((x, y) => (`${y.created_at}|${y.id}` > `${x.created_at}|${x.id}` ? 1 : -1) * (asc ? -1 : 1));
    return rows.slice(0, cap);
  };
  const b = {
    select: () => b,
    update: (p: Row) => ((op = "update"), (patch = p), b),
    delete: () => ((op = "delete"), b),
    eq: (c: string, v: unknown) => {
      const jp = c.match(/^(\w+)->>(\w+)$/);
      filters.push(jp ? (r) => String((r[jp[1]] as Record<string, unknown> | undefined)?.[jp[2]]) === v : (r) => r[c] === v);
      return b;
    },
    neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), b),
    in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), b),
    or: (expr: string) => {
      const mm = expr.match(/^created_at\.lt\.(.+),and\(created_at\.eq\.(.+),id\.lt\.(.+)\)$/);
      if (!mm) throw new Error(`unexpected or(): ${expr}`);
      const [, t, , i] = mm;
      filters.push((r) => String(r.created_at) < t || (r.created_at === t && String(r.id) < i));
      return b;
    },
    order: (_c?: string, o?: { ascending?: boolean }) => ((sorted = true), (asc = o?.ascending === true), b),
    limit: (n: number) => ((cap = n), b),
    maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(
        m.failTable === table ? { data: null, error: { message: "boom" } } : { data: run(), error: null },
      ).then(res, rej),
  };
  return b;
}

const pauserMock = vi.hoisted(() => ({ names: new Map<string, string>(), calls: [] as string[][] }));
vi.mock("@/services/agents/custom-agent-pausers", () => ({
  UNKNOWN_PAUSER: "a teammate",
  pauserNames: async (_t: string, ids: string[]) => {
    pauserMock.calls.push(ids);
    return new Map(ids.filter((i) => pauserMock.names.has(i)).map((i) => [i, pauserMock.names.get(i)!]));
  },
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: (t: string) => query(t) }),
  serverClientFromBearer: () => ({ rpc: m.rpc }),
}));
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    if (!m.auth) {
      res.status(401).json({ error: { code: "unauthorized" } });
      return null;
    }
    return m.auth;
  },
}));
vi.mock("@/services/connectors/discord/adapter", () => ({
  discordChannelInGuild: async (c: string, g: string) => m.channelGuild[c] === g,
  discordChannelMembership: async (c: string, g: string) =>
    m.channelGuild[c] === "__down__" ? "unknown" : m.channelGuild[c] === "__nobot__" ? "bot_error" : m.channelGuild[c] === g ? "in" : "other",
}));
vi.mock("@/services/agents/registry", () => ({
  listGlobalAgentSlugs: () => ["operator", "growth-lead", "research", "engineer"],
}));
vi.mock("@/services/agents/runner", () => {
  class E extends Error {}
  return {
    enqueueAgentRun: m.enqueue,
    AgentNotFoundError: class extends E {},
    FleetHaltedError: class extends E {},
    InsufficientCreditsError: class extends E {},
    SafetyGateError: class extends E {},
    BudgetExceededError: class extends E {},
  };
});

import {
  customAgentsCreate,
  customAgentsGet,
  customAgentsList,
  customAgentsPatch,
  customAgentsReceipts,
  customAgentsSchedulePreview,
  customAgentsSetStatus,
  customAgentsTest,
  customAgentsUnarchive,
  runFailure,
  runRowSummary,
  runSummary,
} from "../custom-agents";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const AGENT_A = "44444444-4444-4444-8444-444444444444";

function res() {
  const r = {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return r;
}
const req = (body: unknown, params: Record<string, string> = {}, query: Record<string, string> = {}) =>
  ({ body, params, query }) as never;

const rowA = {
  id: AGENT_A,
  tenant_id: A,
  slug: "c-abc123def0",
  name: "Standup bot",
  role: "",
  instructions: "Summarize yesterday.",
  tools: [],
  default_deliver: null,
  status: "draft",
  paused_reason: null,
  version: 1,
  test_run_id: null,
  created_at: "x",
  updated_at: "x",
};

beforeEach(() => {
  m.tables = { custom_agents: [{ ...rowA }], custom_agent_triggers: [], tenants: [{ id: A, timezone: "America/Los_Angeles" }, { id: B, timezone: "UTC" }] };
  m.rpc.mockReset();
  m.enqueue.mockReset();
  m.auth = { user_id: "u-a", tenant_id: A, access_token: "tok-a" };
});

describe("POST /api/custom-agents: the paid line", () => {
  it("Free tenant: the RPC's plan_upgrade_required becomes the typed refusal (403)", async () => {
    m.rpc.mockResolvedValue({ data: null, error: { message: "plan_upgrade_required", details: "starter", code: "P0001" } });
    const r = res();
    await customAgentsCreate(req({ name: "Standup bot 2", instructions: "Do it." }), r as never);
    expect(r.statusCode).toBe(403);
    expect(r.body).toEqual({
      error: {
        code: "plan_upgrade_required",
        message: "Custom agents are available on paid plans.",
        action: "upgrade",
        required_tier: "starter",
      },
    });
  });

  it("Starter tenant: created (201), tenant taken from auth, not the body", async () => {
    m.rpc.mockResolvedValue({ data: { ...rowA, id: "55555555-5555-4555-8555-555555555555", status: "active" }, error: null });
    const r = res();
    await customAgentsCreate(
      req({ name: "Standup bot 2", instructions: "Do it.", tenant_id: B, triggers: [{ kind: "schedule", cron: "0 9 * * 1-5" }] }),
      r as never,
    );
    expect(r.statusCode).toBe(201);
    const [fn, args] = m.rpc.mock.calls[0];
    expect(fn).toBe("create_custom_agent");
    expect(args.p_tenant_id).toBe(A);
    expect(args.p_status).toBe("active");
    expect(args.p_triggers[0]).toMatchObject({ kind: "schedule", cron: "0 9 * * 1-5", tz: "America/Los_Angeles" });
  });

  it.each(["operator", "Operator ", "Growth Lead", "Head of Growth"])("name %j is reserved (409, no RPC)", async (name) => {
    const r = res();
    await customAgentsCreate(req({ name, instructions: "Do it." }), r as never);
    expect(r.statusCode).toBe(409);
    expect((r.body as { error: { code: string } }).error.code).toBe("name_reserved");
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("rejects a model/client-supplied arbitrary delivery target", async () => {
    const r = res();
    await customAgentsCreate(req({ name: "X bot", instructions: "Do it.", deliver: { kind: "email", to: "a@b.c" } }), r as never);
    expect(r.statusCode).toBe(400);
    expect(m.rpc).not.toHaveBeenCalled();
  });
});

describe("Discord destination: the channel must be in this tenant's guild", () => {
  const discordDeliver = { kind: "discord", channel_id: "900000000000000001", guild_id: "800000000000000001" };
  beforeEach(() => {
    m.tables.discord_guilds = [{ guild_id: "800000000000000001", tenant_id: A, status: "enabled" }];
    m.rpc.mockResolvedValue({ data: { ...rowA, status: "active" }, error: null });
  });

  it("own guild + a channel in it: saved", async () => {
    m.channelGuild = { "900000000000000001": "800000000000000001" };
    const r = res();
    await customAgentsCreate(req({ name: "Disc bot", instructions: "Do it.", deliver: discordDeliver }), r as never);
    expect(r.statusCode).toBe(201);
  });

  it("own guild + ANOTHER tenant's channel: 400 on create and on PATCH, nothing saved", async () => {
    m.channelGuild = { "900000000000000001": "899999999999999999" };
    const r = res();
    await customAgentsCreate(req({ name: "Disc bot", instructions: "Do it.", deliver: discordDeliver }), r as never);
    expect(r.statusCode).toBe(400);
    const p = res();
    await customAgentsPatch(req({ deliver: discordDeliver }, { id: AGENT_A }), p as never);
    expect(p.statusCode).toBe(400);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("Discord did not answer: 503 try-again on create and PATCH, never the cross-tenant 400, nothing saved", async () => {
    m.channelGuild = { "900000000000000001": "__down__" };
    const r = res();
    await customAgentsCreate(req({ name: "Disc bot", instructions: "Do it.", deliver: discordDeliver }), r as never);
    expect(r.statusCode).toBe(503);
    const p = res();
    await customAgentsPatch(req({ deliver: discordDeliver }, { id: AGENT_A }), p as never);
    expect(p.statusCode).toBe(503);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("no working bot token: 503 destination_not_configured (not a one-minute retry, not the cross-tenant 400)", async () => {
    m.channelGuild = { "900000000000000001": "__nobot__" };
    const r = res();
    await customAgentsCreate(req({ name: "Disc bot", instructions: "Do it.", deliver: discordDeliver }), r as never);
    expect(r.statusCode).toBe(503);
    expect((r.body as { error: { code: string } }).error.code).toBe("destination_not_configured");
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("another tenant's guild: 400", async () => {
    m.tables.discord_guilds = [{ guild_id: "800000000000000001", tenant_id: B, status: "enabled" }];
    m.channelGuild = { "900000000000000001": "800000000000000001" };
    const r = res();
    await customAgentsCreate(req({ name: "Disc bot", instructions: "Do it.", deliver: discordDeliver }), r as never);
    expect(r.statusCode).toBe(400);
  });
});

describe("cross-tenant: tenant B cannot touch tenant A's agent", () => {
  beforeEach(() => {
    m.auth = { user_id: "u-b", tenant_id: B, access_token: "tok-b" };
  });

  it("GET → 404", async () => {
    const r = res();
    await customAgentsGet(req({}, { id: AGENT_A }), r as never);
    expect(r.statusCode).toBe(404);
  });

  it("Test → 404, nothing enqueued, no token issued", async () => {
    const r = res();
    await customAgentsTest(req({}, { id: AGENT_A }), r as never);
    expect(r.statusCode).toBe(404);
    expect(m.enqueue).not.toHaveBeenCalled();
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("PATCH / status: the RPC gets B's tenant (from auth), never A's from the body", async () => {
    m.rpc.mockResolvedValue({ data: null, error: { message: "custom_agent_not_found", code: "P0002" } });
    const r1 = res();
    await customAgentsPatch(req({ name: "Renamed", tenant_id: A }, { id: AGENT_A }), r1 as never);
    const r2 = res();
    await customAgentsSetStatus(req({ status: "archived", tenant_id: A }, { id: AGENT_A }), r2 as never);
    expect(r1.statusCode).toBe(404);
    expect(r2.statusCode).toBe(404);
    for (const [, args] of m.rpc.mock.calls) expect(args.p_tenant_id).toBe(B);
  });
});

describe("POST /api/custom-agents/:id/test", () => {
  it("draft: issues a token, enqueues a manual run carrying it, delivery none", async () => {
    m.rpc.mockResolvedValue({ data: "66666666-6666-4666-8666-666666666666", error: null });
    m.enqueue.mockResolvedValue({ run_id: "run-1" });
    const r = res();
    await customAgentsTest(req({}, { id: AGENT_A }), r as never);
    expect(r.statusCode).toBe(202);
    expect(m.rpc.mock.calls[0][0]).toBe("set_custom_agent_test_token");
    expect(m.enqueue.mock.calls[0][0]).toMatchObject({
      agent_slug: "c-abc123def0",
      tenant_id: A,
      trigger: "manual",
      cron_dedupe_key: "custom-test:66666666-6666-4666-8666-666666666666",
      user_access_token: "tok-a",
    });
  });

  it("Free tenant: the token RPC refuses → typed refusal, nothing enqueued", async () => {
    m.rpc.mockResolvedValue({ data: null, error: { message: "plan_upgrade_required", details: "starter" } });
    const r = res();
    await customAgentsTest(req({}, { id: AGENT_A }), r as never);
    expect(r.statusCode).toBe(403);
    expect((r.body as { error: { code: string } }).error.code).toBe("plan_upgrade_required");
    expect(m.enqueue).not.toHaveBeenCalled();
  });
});

describe("one card, one agent (reload shows server truth)", () => {
  const RUN = "77777777-7777-4777-8777-777777777777";

  it("create carries the card's run id to the RPC", async () => {
    m.rpc.mockResolvedValue({ data: { ...rowA, status: "active" }, error: null });
    const r = res();
    await customAgentsCreate(req({ name: "Standup bot 2", instructions: "Do it.", origin_run_id: RUN }), r as never);
    expect(m.rpc.mock.calls[0][1].p_origin_run_id).toBe(RUN);
  });

  it("a second create from the same card is 409 already_created", async () => {
    m.rpc.mockResolvedValue({ data: null, error: { message: "custom_agent_already_created", code: "23505" } });
    const r = res();
    await customAgentsCreate(req({ name: "Standup bot 2", instructions: "Do it.", origin_run_id: RUN }), r as never);
    expect(r.statusCode).toBe(409);
    expect(r.body).toEqual({ error: { code: "already_created", message: "This agent was already created." } });
  });

  it("list ?origin_run_id finds what the card created, archived included, own tenant only", async () => {
    m.tables.custom_agents = [{ ...rowA, status: "archived", origin_run_id: RUN }];
    const r = res();
    await customAgentsList(req({}, {}, { origin_run_id: RUN }), r as never);
    expect((r.body as { agents: Array<{ status: string }> }).agents.map((a) => a.status)).toEqual(["archived"]);
    m.auth = { user_id: "u-b", tenant_id: B, access_token: "tok-b" };
    const r2 = res();
    await customAgentsList(req({}, {}, { origin_run_id: RUN }), r2 as never);
    expect((r2.body as { agents: unknown[] }).agents).toEqual([]);
  });
});

describe("PATCH deliver: omitted keeps, null clears", () => {
  it("{deliver: null} clears; an omitted key does not", async () => {
    m.rpc.mockResolvedValue({ data: { ...rowA }, error: null });
    await customAgentsPatch(req({ deliver: null }, { id: AGENT_A }), res() as never);
    await customAgentsPatch(req({ name: "Renamed bot" }, { id: AGENT_A }), res() as never);
    expect(m.rpc.mock.calls[0][1]).toMatchObject({ p_clear_deliver: true, p_default_deliver: null });
    expect(m.rpc.mock.calls[1][1]).toMatchObject({ p_clear_deliver: false });
  });
});

describe("a name that normalizes to nothing is a 400, not a 500 (C5)", () => {
  it.each(["!!!", "  ", "---"])("create %j → 400 name_invalid, no RPC", async (name) => {
    const r = res();
    await customAgentsCreate(req({ name, instructions: "Do it." }), r as never);
    expect(r.statusCode).toBe(400);
    expect((r.body as { error: { code: string } }).error.code).toMatch(/name_invalid|validation/);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("PATCH '!!!' → 400; an RPC raising custom_agent_name_invalid → 400", async () => {
    const r = res();
    await customAgentsPatch(req({ name: "!!!" }, { id: AGENT_A }), r as never);
    expect(r.statusCode).toBe(400);
    m.rpc.mockResolvedValue({ data: null, error: { message: "custom_agent_name_invalid", code: "22023" } });
    const r2 = res();
    await customAgentsCreate(req({ name: "Ok name", instructions: "Do it." }), r2 as never);
    expect(r2.statusCode).toBe(400);
    expect(r2.body).toEqual({
      error: { code: "name_invalid", message: "Give the agent a name with at least one letter or number." },
    });
  });
});

describe("watch triggers: refused when Zavi cannot observe them", () => {
  const MSG = "Zavi can't see that yet, so it can't watch for it. Connect the source or name a web page to watch.";
  const watch = (condition: string) => [{ kind: "watch", interval_minutes: 30, condition }];

  it("create: no web page, nothing connected → 400 watch_unobservable, no RPC", async () => {
    const r = res();
    await customAgentsCreate(req({ name: "Rival bot", instructions: "Watch rivals.", triggers: watch("when a rival launches") }), r as never);
    expect(r.statusCode).toBe(400);
    expect(r.body).toEqual({ error: { code: "watch_unobservable", message: MSG } });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("create: a web page is enough", async () => {
    m.rpc.mockResolvedValue({ data: { ...rowA, id: "55555555-5555-4555-8555-555555555555", status: "active" }, error: null });
    const r = res();
    await customAgentsCreate(
      req({ name: "Price bot", instructions: "Watch the price.", triggers: watch("when https://acme.com/pricing drops") }),
      r as never,
    );
    expect(r.statusCode).toBe(201);
  });

  it("create: another tenant's connection does not count", async () => {
    m.tables.connector_metadata = [{ tenant_id: B, slug: "stripe" }];
    const r = res();
    await customAgentsCreate(req({ name: "Refund bot", instructions: "Watch refunds.", triggers: watch("when Stripe refunds spike") }), r as never);
    expect(r.statusCode).toBe(400);
    m.tables.connector_metadata = [{ tenant_id: A, slug: "stripe" }];
    m.rpc.mockResolvedValue({ data: { ...rowA, status: "active" }, error: null });
    const ok = res();
    await customAgentsCreate(req({ name: "Refund bot", instructions: "Watch refunds.", triggers: watch("when Stripe refunds spike") }), ok as never);
    expect(ok.statusCode).toBe(201);
  });

  it("edit: judged against the agent's saved instructions when the edit leaves them out", async () => {
    const r = res();
    await customAgentsPatch(req({ triggers: watch("when a rival launches") }, { id: AGENT_A }), r as never);
    expect(r.statusCode).toBe(400);
    expect((r.body as { error: { code: string } }).error.code).toBe("watch_unobservable");
    expect(m.rpc).not.toHaveBeenCalled();
  });
});

describe("GET /api/custom-agents/:id/receipts (S3)", () => {
  const RUN_1 = "55555555-5555-4555-8555-555555555555";
  const RUN_2 = "66666666-6666-4666-8666-666666666666";
  const rid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  beforeEach(() => {
    m.tables.custom_agents[0].status = "archived";
    m.tables.custom_agent_write_receipts = [
      { id: rid(1), tenant_id: A, agent_id: AGENT_A, run_id: RUN_1, tool_name: "email__send", outcome: "succeeded", created_at: "2026-09-25T10:00:00.000Z" },
      { id: rid(2), tenant_id: A, agent_id: AGENT_A, run_id: RUN_2, tool_name: "slack__post_message", outcome: "failed", created_at: "2026-09-25T11:00:00.000Z" },
      { id: rid(3), tenant_id: A, agent_id: AGENT_A, run_id: RUN_2, tool_name: "tiktok__create_post", outcome: "succeeded", created_at: "2026-09-25T11:00:00.000Z" },
      { id: rid(9), tenant_id: B, agent_id: AGENT_A, run_id: RUN_1, tool_name: "email__send", outcome: "succeeded", created_at: "2026-09-25T12:00:00.000Z" },
    ];
  });
  const ids = (r: { body: unknown }) => (r.body as { receipts: Row[] }).receipts.map((x) => x.id);
  const next = (r: { body: unknown }) => (r.body as { next_cursor: string | null }).next_cursor;

  it("own tenant, newest first, archived included; never another tenant's", async () => {
    const r = res();
    await customAgentsReceipts(req({}, { id: AGENT_A }), r as never);
    expect(r.statusCode).toBe(200);
    expect(ids(r)).toEqual([rid(3), rid(2), rid(1)]);
    expect(next(r)).toBeNull();
  });

  it("pages with a cursor instead of silently capping (ties on created_at broken by id)", async () => {
    const r1 = res();
    await customAgentsReceipts(req({}, { id: AGENT_A }, { limit: "2" }), r1 as never);
    expect(ids(r1)).toEqual([rid(3), rid(2)]);
    expect(next(r1)).toBe(`2026-09-25T11:00:00.000Z,${rid(2)}`);
    const r2 = res();
    await customAgentsReceipts(req({}, { id: AGENT_A }, { limit: "2", before: next(r1)! }), r2 as never);
    expect(ids(r2)).toEqual([rid(1)]);
    expect(next(r2)).toBeNull();
  });

  it("bad cursor or limit → 400", async () => {
    for (const q of [
      { before: "garbage" },
      { before: `Sep 25, 2026,${rid(1)}` },
      { before: `2026-09-25T11:00:00.000Z),or(id.gt.0,${rid(1)}` },
      { limit: "0" },
      { limit: "x" },
    ] as Array<Record<string, string>>) {
      const r = res();
      await customAgentsReceipts(req({}, { id: AGENT_A }, q), r as never);
      expect(r.statusCode).toBe(400);
    }
  });

  it("?run_id narrows to one run", async () => {
    const r = res();
    await customAgentsReceipts(req({}, { id: AGENT_A }, { run_id: RUN_1 }), r as never);
    expect(ids(r)).toEqual([rid(1)]);
  });

  it("another tenant asking for this agent id → 404 (tenant from auth only)", async () => {
    m.auth = { user_id: "u-b", tenant_id: B, access_token: "tok-b" };
    const r = res();
    await customAgentsReceipts(req({ tenant_id: A }, { id: AGENT_A }), r as never);
    expect(r.statusCode).toBe(404);
  });

  it("unauthenticated → 401", async () => {
    m.auth = null;
    const r = res();
    await customAgentsReceipts(req({}, { id: AGENT_A }), r as never);
    expect(r.statusCode).toBe(401);
  });
});

describe("who paused it (decision 37)", () => {
  const paused = (over: Record<string, unknown>) => ({ ...rowA, status: "paused", paused_reason: "Paused by a teammate", paused_at: "2026-09-26T10:00:00Z", ...over });

  it("paused by the viewer: paused_by_self, no name, and the user id never leaves the server", async () => {
    m.tables.custom_agents = [paused({ paused_by: "u-a" })];
    const r = res();
    await customAgentsGet(req({}, { id: AGENT_A }), r as never);
    const a = (r.body as { agent: Record<string, unknown> }).agent;
    expect(a).toMatchObject({ paused_by_self: true, paused_by_name: null, paused_at: "2026-09-26T10:00:00Z" });
    expect(JSON.stringify(r.body)).not.toContain("paused_by\":\"u-a");
    expect(a).not.toHaveProperty("paused_by");
  });

  it("paused by a teammate: their short name; unknown pauser: 'a teammate'", async () => {
    pauserMock.names = new Map([["u-x", "priya"]]);
    m.tables.custom_agents = [paused({ paused_by: "u-x" })];
    const r = res();
    await customAgentsGet(req({}, { id: AGENT_A }), r as never);
    expect((r.body as { agent: Record<string, unknown> }).agent).toMatchObject({ paused_by_self: false, paused_by_name: "priya" });
    m.tables.custom_agents = [paused({ paused_by: "u-gone" })];
    const r2 = res();
    await customAgentsGet(req({}, { id: AGENT_A }), r2 as never);
    expect((r2.body as { agent: Record<string, unknown> }).agent).toMatchObject({ paused_by_name: "a teammate" });
  });

  it("an automatic pause (no person) keeps its own reason and names nobody", async () => {
    m.tables.custom_agents = [paused({ paused_by: null, paused_reason: "Paused after 3 runs in a row did not finish." })];
    const r = res();
    await customAgentsGet(req({}, { id: AGENT_A }), r as never);
    expect((r.body as { agent: Record<string, unknown> }).agent).toMatchObject({
      paused_by_self: false,
      paused_by_name: null,
      paused_reason: "Paused after 3 runs in a row did not finish.",
    });
  });
});

describe("Archived list + unarchive (decision 43)", () => {
  it("?status=archived lists only this tenant's archived agents; any other status value keeps the default list", async () => {
    m.tables.custom_agents = [
      { ...rowA, id: AGENT_A, status: "archived" },
      { ...rowA, id: "55555555-5555-4555-8555-555555555555", status: "active", slug: "c-live000001" },
      { ...rowA, id: "66666666-6666-4666-8666-666666666666", tenant_id: B, status: "archived", slug: "c-otherten01" },
    ];
    const r = res();
    await customAgentsList(req({}, {}, { status: "archived" }), r as never);
    expect((r.body as { agents: Array<{ id: string }> }).agents.map((x) => x.id)).toEqual([AGENT_A]);
    const d = res();
    await customAgentsList(req({}, {}, { status: "draft" }), d as never);
    expect((d.body as { agents: Array<{ id: string }> }).agents.map((x) => x.id)).toEqual(["55555555-5555-4555-8555-555555555555"]);
  });

  it("unarchive: calls the RPC with the auth tenant and returns the paused agent", async () => {
    m.rpc.mockResolvedValue({ data: { ...rowA, status: "paused", paused_reason: "Unarchived. Resume it to start running again." }, error: null });
    const r = res();
    await customAgentsUnarchive(req({ tenant_id: B }, { id: AGENT_A }), r as never);
    expect(m.rpc).toHaveBeenCalledWith("unarchive_custom_agent", {
      p_tenant_id: A,
      p_agent_id: AGENT_A,
      p_reserved_names: expect.arrayContaining(["operator"]),
    });
    expect((r.body as { agent: Record<string, unknown> }).agent).toMatchObject({ status: "paused" });
  });

  it("unarchive into a name a live agent took: 409 with the name, never a 500", async () => {
    m.tables.custom_agents = [{ ...rowA, status: "archived" }];
    m.rpc.mockResolvedValue({ data: null, error: { message: "custom_agent_name_taken", code: "23505" } });
    const r = res();
    await customAgentsUnarchive(req({}, { id: AGENT_A }), r as never);
    expect(r.statusCode).toBe(409);
    expect(r.body).toEqual({ error: { code: "name_taken", message: "Another agent is already called Standup bot. Rename that one first." } });
  });
});

describe("When it runs box (decision 36)", () => {
  const sched = (over: Record<string, unknown> = {}) => ({
    id: "t-s1", tenant_id: A, agent_id: AGENT_A, kind: "schedule", cron: "0 9 * * 1-5", tz: "America/Los_Angeles",
    interval_minutes: null, condition: null, enabled: true, deliver: { channel: "slack" }, next_due_at: "old",
    last_fired_at: null, created_at: "2026-09-01", ...over,
  });
  const watch = {
    id: "t-w1", tenant_id: A, agent_id: AGENT_A, kind: "watch", cron: null, tz: null, interval_minutes: 60,
    condition: "pricing page changes", enabled: true, next_due_at: "w-next", last_fired_at: null, created_at: "2026-09-01",
    url_baseline: { "https://x.com/pricing": "h1" }, last_fingerprint: "fp1",
  };

  it("preview: plain words -> label + 3 increasing run times; unreadable -> the try-again line", async () => {
    const r = res();
    await customAgentsSchedulePreview(req({ text: "weekdays at 10am" }), r as never);
    const b = r.body as { ok: boolean; cron: string; label: string; next: string[] };
    expect(b.ok).toBe(true);
    expect(b.cron).toBe("0 10 * * 1-5");
    expect(b.label).toMatch(/^Weekdays at 10:00 AM \(/);
    expect(b.next).toHaveLength(3);
    expect(new Set(b.next).size).toBe(3);
    expect(b.next[0] < b.next[1] && b.next[1] < b.next[2]).toBe(true);
    const bad = res();
    await customAgentsSchedulePreview(req({ text: "every other thursday" }), bad as never);
    expect(bad.body).toEqual({ ok: false, message: "Try something like 'weekdays at 10am' or 'every Monday at 9am'." });
  });

  it("PATCH schedule_cron replaces only the schedule trigger; the watch keeps its baseline and fingerprint", async () => {
    m.tables.custom_agent_triggers = [sched(), sched({ id: "t-s2", created_at: "2026-09-02" }), { ...watch }];
    m.rpc.mockResolvedValue({ data: { ...rowA, status: "active" }, error: null });
    const r = res();
    await customAgentsPatch(req({ schedule_cron: "0 10 * * 1-5" }, { id: AGENT_A }), r as never);
    expect(r.statusCode).toBe(200);
    const call = m.rpc.mock.calls.at(-1)!;
    expect(call[0]).toBe("update_custom_agent");
    expect((call[1] as Record<string, unknown>).p_triggers).toBeNull();
    const rows = m.tables.custom_agent_triggers;
    expect(rows.map((t) => t.id).sort()).toEqual(["t-s1", "t-w1"]);
    const s1 = rows.find((t) => t.id === "t-s1")!;
    expect(s1).toMatchObject({ cron: "0 10 * * 1-5", deliver: { channel: "slack" }, enabled: true });
    expect(s1.next_due_at).not.toBe("old");
    expect(rows.find((t) => t.id === "t-w1")).toMatchObject({
      url_baseline: { "https://x.com/pricing": "h1" }, last_fingerprint: "fp1", next_due_at: "w-next",
    });
  });

  it("PATCH instructions only never touches triggers; a bad cron is refused before any write", async () => {
    m.tables.custom_agent_triggers = [sched()];
    m.rpc.mockResolvedValue({ data: { ...rowA, status: "active" }, error: null });
    const r = res();
    await customAgentsPatch(req({ instructions: "New words." }, { id: AGENT_A }), r as never);
    expect(r.statusCode).toBe(200);
    expect(m.tables.custom_agent_triggers[0]).toMatchObject({ cron: "0 9 * * 1-5", next_due_at: "old" });
    m.rpc.mockClear();
    const bad = res();
    await customAgentsPatch(req({ schedule_cron: "* * * * *" }, { id: AGENT_A }), bad as never);
    expect(bad.statusCode).toBe(400);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("PATCH schedule_cron on a watch-only agent is refused BEFORE the RPC saves anything else", async () => {
    m.tables.custom_agent_triggers = [{ ...watch }];
    m.rpc.mockClear();
    m.rpc.mockResolvedValue({ data: { ...rowA, status: "active" }, error: null });
    const r = res();
    await customAgentsPatch(req({ schedule_cron: "0 10 * * 1-5", instructions: "New words." }, { id: AGENT_A }), r as never);
    expect(r.statusCode).toBe(400);
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.tables.custom_agent_triggers[0]).toMatchObject({ kind: "watch", last_fingerprint: "fp1" });
  });

  it("a cron that never fires is refused and nothing is written", async () => {
    m.tables.custom_agent_triggers = [sched()];
    m.rpc.mockResolvedValue({ data: { ...rowA, status: "active" }, error: null });
    const r = res();
    m.rpc.mockClear();
    await customAgentsPatch(req({ schedule_cron: "0 9 31 2 *", instructions: "New words." }, { id: AGENT_A }), r as never);
    expect(r.statusCode).toBe(400);
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.tables.custom_agent_triggers[0]).toMatchObject({ cron: "0 9 * * 1-5", next_due_at: "old" });
  });
});

describe("unarchive under a name that is now reserved", () => {
  it("is a 409 in plain words, never a 500", async () => {
    m.rpc.mockResolvedValue({ data: null, error: { message: "custom_agent_name_reserved", code: "22023" } });
    const r = res();
    await customAgentsUnarchive(req({}, { id: AGENT_A }), r as never);
    expect(r.statusCode).toBe(409);
    expect(r.body).toEqual({
      error: { code: "name_reserved", message: "That name now belongs to a built-in agent, so this agent can't come back." },
    });
  });

  it("a usage-limit stop reads the way chat says it, not the generic line", () => {
    expect(runFailure("failed", "You've hit your usage limit · resets 7pm (UTC)")).toBe(
      "Stopped: the AI service hit a usage limit. It clears on its own shortly.",
    );
  });
});

describe("unknown timezone (decision 44)", () => {
  it("PATCH with tz Mars/Olympus is a 400 naming the zone; no write", async () => {
    m.rpc.mockClear();
    const r = res();
    await customAgentsPatch(
      req({ triggers: [{ kind: "schedule", cron: "0 9 * * 1-5", tz: "Mars/Olympus" }] }, { id: AGENT_A }),
      r as never,
    );
    expect(r.statusCode).toBe(400);
    expect(JSON.stringify(r.body)).toContain('Unknown timezone \\"Mars/Olympus\\". Use a name like America/New_York.');
    expect(m.rpc).not.toHaveBeenCalled();
  });
});

describe("run history lines (decision 40)", () => {
  it("row summary skips headings and bold labels and keeps the first real sentence", () => {
    expect(runRowSummary("# Daily standup\n\n**Summary:**\n- Shipped the pricing page. Then lunch.")).toBe("Shipped the pricing page.");
    expect(runRowSummary("## Only a heading")).toBeNull();
    expect(runRowSummary("x".repeat(300))!.length).toBe(200);
    expect(runSummary("# Daily standup\nbody")).toBe("Daily standup");
  });

  it("failure is plain words, never the raw error", () => {
    expect(runFailure("dispatch_error", 'custom agent "c-abc123def0" is not active')).toBe("Stopped: the agent was paused before it ran.");
    expect(runFailure("failed", "TypeError: cannot read x of undefined at /app/dist/y.js:12")).toBe("The run stopped before it finished.");
    expect(runFailure("success", "whatever")).toBeNull();
    expect(runFailure("running", null)).toBeNull();
  });
});

describe("QA bug round (2026-09-27)", () => {
  it("B5: a test already running for this agent is returned; no token, no second run", async () => {
    m.tables.agent_runs = [
      { id: "run-live", tenant_id: A, agent_slug: "c-abc123def0", status: "running", payload: { custom_agent_test: true }, enqueued_at: "t", created_at: "t" },
    ];
    m.rpc.mockClear();
    m.enqueue.mockClear();
    const r = res();
    await customAgentsTest(req({}, { id: AGENT_A }), r as never);
    expect(r.statusCode).toBe(202);
    expect(r.body).toEqual({ run_id: "run-live", slug: "c-abc123def0", already_running: true });
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it("B5: a failed lookup refuses (503) rather than risk a second paid run", async () => {
    m.rpc.mockClear();
    m.enqueue.mockClear();
    m.failTable = "agent_runs";
    const r = res();
    await customAgentsTest(req({}, { id: AGENT_A }), r as never);
    m.failTable = null;
    expect(r.statusCode).toBe(503);
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it("B5 control: a finished test or another agent's test does not block a new one", async () => {
    m.tables.agent_runs = [
      { id: "old", tenant_id: A, agent_slug: "c-abc123def0", status: "success", payload: { custom_agent_test: true }, enqueued_at: "t", created_at: "t" },
      { id: "other", tenant_id: A, agent_slug: "c-other00001", status: "running", payload: { custom_agent_test: true }, enqueued_at: "t", created_at: "t" },
    ];
    m.rpc.mockResolvedValue({ data: "66666666-6666-4666-8666-666666666666", error: null });
    m.enqueue.mockResolvedValue({ run_id: "run-new" });
    const r = res();
    await customAgentsTest(req({}, { id: AGENT_A }), r as never);
    expect(r.body).toMatchObject({ run_id: "run-new" });
  });

  it("B3: a bold headline sentence is the summary; a short bold label is skipped", () => {
    expect(runRowSummary("## Summary\n\n**Zavi fixed the revenue chart and flagged a payout.**\n\n- The chart fix corrects today.")).toBe(
      "Zavi fixed the revenue chart and flagged a payout.",
    );
    expect(runRowSummary("**Summary:**\n- First real point here.")).toBe("First real point here.");
    expect(runRowSummary("**Highlights**\nShipped the pricing page.")).toBe("Shipped the pricing page.");
  });

  it("B9: a run cut short by archiving says so in plain words", () => {
    expect(runFailure("failed", 'blocked at execution: not_found — Agent "c-5a839e162b" not found in src/agents/')).toBe(
      "Stopped: the agent was archived or couldn't be loaded.",
    );
  });

  it("B14: a member's pause returns no stored generic reason; an automatic pause keeps its own", async () => {
    m.tables.custom_agents = [{ ...rowA, status: "paused", paused_by: "u-a", paused_at: "2026-09-27T10:00:00Z", paused_reason: "Paused by a teammate" }];
    const r = res();
    await customAgentsGet(req({}, { id: AGENT_A }), r as never);
    expect((r.body as { agent: Record<string, unknown> }).agent).toMatchObject({ paused_reason: null, paused_by_self: true });
    m.tables.custom_agents = [{ ...rowA, status: "paused", paused_by: null, paused_reason: "Paused after 3 runs in a row did not finish." }];
    const r2 = res();
    await customAgentsGet(req({}, { id: AGENT_A }), r2 as never);
    expect((r2.body as { agent: Record<string, unknown> }).agent).toMatchObject({ paused_reason: "Paused after 3 runs in a row did not finish." });
  });

  it("B16: a schedule edit on an unknown agent is a 404 and nothing is written", async () => {
    m.tables.custom_agents = [];
    m.rpc.mockClear();
    const r = res();
    await customAgentsPatch(req({ schedule_cron: "0 10 * * 1-5" }, { id: "00000000-0000-4000-8000-000000000000" }), r as never);
    expect(r.statusCode).toBe(404);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("B8: minute intervals under 15 say the minimum; other minute counts say which work", async () => {
    const say = async (text: string) => {
      const r = res();
      await customAgentsSchedulePreview(req({ text }), r as never);
      return r.body;
    };
    expect(await say("every 5 minutes")).toEqual({ ok: false, message: "The shortest schedule is every 15 minutes." });
    expect(await say("every minute")).toEqual({ ok: false, message: "The shortest schedule is every 15 minutes." });
    expect(await say("every 45 minutes")).toEqual({ ok: false, message: "Minutes work as every 15, 20 or 30 minutes." });
  });

  it("B12: an unknown timezone error has no field path", async () => {
    const r = res();
    await customAgentsPatch(req({ triggers: [{ kind: "schedule", cron: "0 9 * * 1-5", tz: "Mars/Olympus" }] }, { id: AGENT_A }), r as never);
    expect(r.statusCode).toBe(400);
    expect((r.body as { error: { message: string } }).error.message).toBe('Unknown timezone "Mars/Olympus". Use a name like America/New_York.');
  });
});

