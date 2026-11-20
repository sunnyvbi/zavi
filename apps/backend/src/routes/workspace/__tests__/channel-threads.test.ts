
import { describe, it, expect, vi, beforeEach } from "vitest";

const T1 = "00000000-0000-0000-0000-000000000001";
const T2 = "00000000-0000-0000-0000-000000000002";
const U1 = "10000000-0000-0000-0000-000000000001";
const U2 = "10000000-0000-0000-0000-000000000002";
const CARD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  threads: [] as Array<Record<string, unknown>>,
  messages: [] as Array<Record<string, unknown>>,
  cards: [] as Array<Record<string, unknown>>,
  threadQueries: [] as Array<Array<[string, string, unknown]>>,
  cardTenants: [] as string[],
  threadError: null as null | { message: string },
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));

type Filter = [string, string, unknown];

function table(rows: () => Array<Record<string, unknown>>, log?: Filter[], err?: () => unknown) {
  const filters: Filter[] = log ?? [];
  let limitN = Infinity;
  let orderCol: string | null = null;
  const run = () => {
    const e = err?.();
    if (e) return { data: null, error: e };
    let out = rows().filter((r) =>
      filters.every(([op, col, val]) => {
        if (op === "eq") return r[col] === val;
        if (op === "is") return (r[col] ?? null) === val;
        if (op === "not-is") return (r[col] ?? null) !== val;
        if (op === "in") return (val as unknown[]).includes(r[col]);
        return true;
      }),
    );
    if (orderCol) {
      const c = orderCol;
      out = [...out].sort((a, b) => String(b[c] ?? "").localeCompare(String(a[c] ?? "")));
    }
    return { data: out.slice(0, limitN), error: null };
  };
  const api: Record<string, unknown> = {
    select: () => api,
    eq: (c: string, v: unknown) => (filters.push(["eq", c, v]), api),
    is: (c: string, v: unknown) => (filters.push(["is", c, v]), api),
    not: (c: string, op: string, v: unknown) => (filters.push([`not-${op}`, c, v]), api),
    in: (c: string, v: unknown) => (filters.push(["in", c, v]), api),
    order: (c: string) => ((orderCol = c), api),
    limit: (n: number) => ((limitN = n), api),
    maybeSingle: async () => {
      const r = run();
      return { data: (r.data as unknown[] | null)?.[0] ?? null, error: r.error };
    },
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
  };
  return api;
}

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    from: (name: string) => {
      if (name === "agent_threads") {
        const log: Filter[] = [];
        mocks.threadQueries.push(log);
        return table(() => mocks.threads, log, () => mocks.threadError);
      }
      if (name === "agent_thread_messages") {
        return table(() => mocks.messages);
      }
      throw new Error(`unexpected table ${name}`);
    },
  }),
}));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: (t: string) => {
    mocks.cardTenants.push(t);
    return {
      from: (name: string) => {
        if (name !== "channel_actions") throw new Error(`unexpected ${name}`);
        return table(() => mocks.cards.filter((c) => c.tenant_id === t));
      },
    };
  },
}));

import { workspaceListChannelThreads } from "../channel-threads";

function call(query: Record<string, unknown>) {
  const out = { code: 200, body: undefined as unknown };
  const res = {
    status(c: number) {
      out.code = c;
      return res;
    },
    json(b: unknown) {
      out.body = b;
      return res;
    },
  };
  return workspaceListChannelThreads({ query } as never, res as never).then(() => out);
}

const thread = (over: Record<string, unknown>) => ({
  tenant_id: T1,
  user_id: U1,
  agent_slug: "chatgpt_ads",
  channel_slug: "chatgpt_ads",
  channel_action_id: null,
  deleted_at: null,
  synthetic: false,
  title: "t",
  last_message_at: "2026-10-14T10:00:00Z",
  ...over,
});

const ids = (out: { body: unknown }) => (out.body as { threads: Array<{ id: string }> }).threads.map((t) => t.id);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.threadQueries.length = 0;
  mocks.cardTenants.length = 0;
  mocks.threadError = null;
  mocks.requireAuth.mockResolvedValue({ user_id: U1, tenant_id: T1, access_token: "tok" });
  mocks.threads = [
    thread({ id: "mine-old", title: "Older chat", last_message_at: "2026-10-12T10:00:00Z" }),
    thread({ id: "mine-new", title: "Newest chat", last_message_at: "2026-10-14T10:00:00Z" }),
    thread({ id: "mine-card", title: "Card chat", channel_action_id: CARD, last_message_at: "2026-10-13T10:00:00Z" }),
    thread({ id: "other-tenant", tenant_id: T2 }),
    thread({ id: "other-user", user_id: U2 }),
    thread({ id: "synthetic", synthetic: true }),
    thread({ id: "deleted", deleted_at: "2026-10-14T11:00:00Z" }),
    thread({ id: "main-tagged", channel_slug: null }),
    thread({ id: "other-channel", channel_slug: "meta_ads" }),
    thread({ id: "other-agent", agent_slug: "cgo" }),
    thread({ id: "old-operator", agent_slug: "operator" }),
  ];
  mocks.messages = [
    { thread_id: "mine-new", tenant_id: T1, body: "first   line\nsecond", created_at: "2026-10-14T09:00:00Z" },
    { thread_id: "mine-new", tenant_id: T1, body: "latest reply", created_at: "2026-10-14T10:00:00Z" },
  ];
  mocks.cards = [
    { id: CARD, tenant_id: T1, title: "Raise budget on Search" },
    { id: CARD, tenant_id: T2, title: "Other tenant's title" },
  ];
});

describe("GET /api/workspace/channel-threads", () => {
  it("lists the user's page chats for the channel, newest first, limit 30, with preview and card title", async () => {
    const out = await call({ channel: "chatgpt_ads" });
    expect(out.code).toBe(200);
    expect(ids(out)).toEqual(["mine-new", "mine-card", "mine-old"]);
    const rows = (out.body as { threads: Array<Record<string, unknown>> }).threads;
    expect(rows[0]).toMatchObject({ title: "Newest chat", preview: "latest reply", card_title: null });
    expect(rows[1]).toMatchObject({ channel_action_id: CARD, card_title: "Raise budget on Search" });
    expect(mocks.cardTenants).toEqual([T1]);
  });

  it("caps the list at 30", async () => {
    mocks.threads = Array.from({ length: 40 }, (_, i) =>
      thread({ id: `t${i}`, last_message_at: `2026-10-14T10:${String(i).padStart(2, "0")}:00Z` }),
    );
    const out = await call({ channel: "chatgpt_ads" });
    expect(ids(out)).toHaveLength(30);
    expect(ids(out)[0]).toBe("t39");
  });

  it("filters by the card when action is given", async () => {
    const out = await call({ channel: "chatgpt_ads", action: CARD.toUpperCase() });
    expect(ids(out)).toEqual(["mine-card"]);
  });

  it("must-not: another tenant's, another user's, synthetic, deleted, main-workspace-tagged, other channel and other agent threads never appear", async () => {
    const out = await call({ channel: "chatgpt_ads" });
    for (const id of ["other-tenant", "other-user", "synthetic", "deleted", "main-tagged", "other-channel", "other-agent", "old-operator"]) {
      expect(ids(out)).not.toContain(id);
    }
    expect(mocks.threadQueries[0]).toEqual(
      expect.arrayContaining([
        ["eq", "user_id", U1],
        ["eq", "tenant_id", T1],
        ["eq", "agent_slug", "chatgpt_ads"],
        ["eq", "channel_slug", "chatgpt_ads"],
        ["is", "deleted_at", null],
        ["not-is", "synthetic", true],
      ]),
    );
  });

  it("must-not: a tenant or user named in the query string is ignored", async () => {
    const out = await call({ channel: "chatgpt_ads", tenant_id: T2, user_id: U2 });
    expect(ids(out)).not.toContain("other-tenant");
    expect(ids(out)).not.toContain("other-user");
  });

  it("400 on an unknown or missing channel", async () => {
    expect((await call({ channel: "myspace_ads" })).code).toBe(400);
    expect((await call({})).code).toBe(400);
    expect(mocks.threadQueries).toHaveLength(0);
  });

  it("empty list on a non-uuid card (a payload-built card has no stamped chats)", async () => {
    const out = await call({ channel: "chatgpt_ads", action: "staged-post-1" });
    expect(out.body).toEqual({ threads: [] });
    expect(mocks.threadQueries).toHaveLength(0);
  });

  it("401 without auth: requireAuth answers and nothing is read", async () => {
    mocks.requireAuth.mockImplementation(async (_req: unknown, res: { status: (c: number) => { json: (b: unknown) => void } }) => {
      res.status(401).json({ error: { code: "unauthenticated" } });
      return null;
    });
    const out = await call({ channel: "chatgpt_ads" });
    expect(out.code).toBe(401);
    expect(mocks.threadQueries).toHaveLength(0);
  });

  it("500 on a read error", async () => {
    mocks.threadError = { message: "db down" };
    const out = await call({ channel: "chatgpt_ads" });
    expect(out.code).toBe(500);
  });
});
