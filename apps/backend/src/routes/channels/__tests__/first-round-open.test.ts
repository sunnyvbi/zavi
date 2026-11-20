
import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const T = "73db45ff-457e-4541-bc8f-bdb625390204";
const OTHER = "11111111-2222-4333-8444-555555555555";

type Row = Record<string, unknown> & { tenant_id: string };
const h = vi.hoisted(() => ({
  channelRows: [] as Array<{ channel_slug: string }>,
  locks: {} as Record<string, string | null>,
  agent_runs: [] as Array<Record<string, unknown> & { tenant_id: string }>,
  channel_actions: [] as Array<Record<string, unknown> & { tenant_id: string }>,
  failTable: null as string | null,
  reads: [] as Array<{ tenant: string; table: string; cols: string }>,
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204", user_id: "u-1", access_token: "tok" })),
}));
vi.mock("@/services/supabase", () => {
  const chain = (): Record<string, unknown> => {
    const self: Record<string, unknown> = {};
    for (const m of ["select", "eq", "not", "order", "limit", "in", "gte", "like"]) self[m] = () => self;
    self.maybeSingle = async () => ({ data: null, error: null });
    self.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
    return self;
  };
  return { serverClientFromBearer: () => ({ from: () => chain() }), serviceClient: () => ({ from: () => chain() }) };
});
vi.mock("@/services/channels/state", async (orig) => {
  const real = await orig<typeof import("@/services/channels/state")>();
  return {
    ...real,
    readChannelStates: vi.fn(async () => ({
      states: real.joinChannelStates(h.channelRows),
      rowCount: h.channelRows.length,
      error: null,
    })),
  };
});
vi.mock("@/services/tenants/seed-channels", () => ({
  seedTenantChannels: vi.fn(async () => ({ channels_inserted: 0, error: null })),
}));
vi.mock("@/services/channels/lock", () => ({ readLockedChannelSlugs: vi.fn(async () => new Set<string>()) }));
vi.mock("@/services/growth/strategy-note", () => ({ readStrategyNote: vi.fn(async () => null) }));
vi.mock("@/services/tools/growth/seo/snapshot", () => ({
  readSiteReadState: vi.fn(async () => ({ state: "unknown", site: null, error_code: null })),
}));
vi.mock("@/services/agents/entitlement", async (orig) => ({
  ...(await orig<typeof import("@/services/agents/entitlement")>()),
  annotateLockedTier: vi.fn(async (rows: Array<{ slug: string }>) =>
    rows.map((r) => ({ ...r, locked_tier: h.locks[r.slug] ?? null })),
  ),
  tenantPlanForDisplay: vi.fn(async () => "free"),
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: (tenant: string) => ({
    from: (table: "agent_runs" | "channel_actions") => {
      const filters: Array<(r: Row) => boolean> = [(r) => r.tenant_id === tenant];
      const self: Record<string, unknown> = {};
      self.select = (cols: string) => {
        h.reads.push({ tenant, table, cols });
        return self;
      };
      self.like = (k: string, pat: string) => {
        const prefix = pat.replace(/%$/, "");
        filters.push((r) => String(r[k] ?? "").startsWith(prefix));
        return self;
      };
      self.in = (k: string, vs: unknown[]) => {
        filters.push((r) => vs.includes(r[k]));
        return self;
      };
      self.limit = async () =>
        h.failTable === table
          ? { data: null, error: { message: "boom" } }
          : { data: (h[table] as Row[]).filter((r) => filters.every((f) => f(r))), error: null };
      return self;
    },
  }),
}));

import { channelsList } from "../list";

function res() {
  const r: { _status: number; _body: unknown; status: (n: number) => typeof r; json: (b: unknown) => typeof r } = {
    _status: 200,
    _body: undefined,
    status(n) { r._status = n; return r; },
    json(b) { r._body = b; return r; },
  };
  return r;
}

async function list(): Promise<Record<string, { locked_tier: string | null; first_round_open: boolean }>> {
  const r = res();
  await channelsList({} as Request, r as unknown as Response);
  expect(r._status).toBe(200);
  const channels = (r._body as { channels: Array<{ channel_slug: string; locked_tier: string | null; first_round_open: boolean }> }).channels;
  return Object.fromEntries(channels.map((c) => [c.channel_slug, c]));
}

const previewRun = (id: string, slug: string, tenant = T) => ({
  tenant_id: tenant,
  id,
  agent_slug: slug,
  trigger: "channel_recipe",
  enqueued_by: null,
  cron_dedupe_key: `first-run-preview:${tenant}:${slug}`,
});
const card = (run_id: string, channel_slug: string, status: string, responsibility: string | null = null, tenant = T) => ({
  tenant_id: tenant,
  run_id,
  channel_slug,
  status,
  responsibility,
});

beforeEach(() => {
  h.channelRows = [{ channel_slug: "seo" }, { channel_slug: "x_organic" }, { channel_slug: "reddit_organic" }];
  h.locks = { seo: "starter", x_organic: "starter", reddit_organic: "starter", geo: "starter" };
  h.agent_runs = [];
  h.channel_actions = [];
  h.failTable = null;
  h.reads.length = 0;
});

describe("GET /api/channels first_round_open", () => {
  it("a locked channel holding cards from the workspace's own signup run is open", async () => {
    h.agent_runs = [previewRun("run-seo", "seo")];
    h.channel_actions = [card("run-seo", "seo", "pending"), card("run-seo", "seo", "pending")];
    const out = await list();
    expect(out.seo).toMatchObject({ locked_tier: "starter", first_round_open: true });
    expect(out.x_organic).toMatchObject({ locked_tier: "starter", first_round_open: false });
    expect(out.reddit_organic.first_round_open).toBe(false);
  });

  it("stays open after ALL of its cards are closed (done, skipped, superseded)", async () => {
    h.agent_runs = [previewRun("run-seo", "seo")];
    h.channel_actions = [card("run-seo", "seo", "acted"), card("run-seo", "seo", "rejected"), card("run-seo", "seo", "stale")];
    expect((await list()).seo.first_round_open).toBe(true);
  });

  it("false for a channel the plan includes, whatever cards it has", async () => {
    h.locks = { ...h.locks, seo: null };
    h.agent_runs = [previewRun("run-seo", "seo")];
    h.channel_actions = [card("run-seo", "seo", "pending")];
    const out = await list();
    expect(out.seo).toMatchObject({ locked_tier: null, first_round_open: false });
    for (const c of Object.values(out)) if (c.locked_tier === null) expect(c.first_round_open).toBe(false);
  });

  it("false for a locked channel whose only cards came from a non-preview run", async () => {
    h.agent_runs = [
      { tenant_id: T, id: "run-old", agent_slug: "seo", trigger: "channel_recipe", enqueued_by: null, cron_dedupe_key: null },
      { ...previewRun("run-user", "x_organic"), enqueued_by: "u-1" },
      { ...previewRun("run-done", "reddit_organic"), cron_dedupe_key: `first-run-preview-done:${T}:reddit_organic` },
    ];
    h.channel_actions = [
      card("run-old", "seo", "pending"),
      card("run-user", "x_organic", "pending"),
      card("run-done", "reddit_organic", "pending"),
    ];
    const out = await list();
    expect(out.seo.first_round_open).toBe(false);
    expect(out.x_organic.first_round_open).toBe(false);
    expect(out.reddit_organic.first_round_open).toBe(false);
  });

  it("a card filed under another channel's preview run does not open this one", async () => {
    h.agent_runs = [previewRun("run-seo", "seo")];
    h.channel_actions = [card("run-seo", "x_organic", "pending")];
    const out = await list();
    expect(out.seo.first_round_open).toBe(false);
    expect(out.x_organic.first_round_open).toBe(false);
  });

  it("only customer-visible cards count: a Zavi-side note alone does not open the channel", async () => {
    h.agent_runs = [previewRun("run-seo", "seo")];
    h.channel_actions = [card("run-seo", "seo", "pending", "zavi")];
    expect((await list()).seo.first_round_open).toBe(false);
    h.channel_actions.push(card("run-seo", "seo", "pending", "client"));
    expect((await list()).seo.first_round_open).toBe(true);
  });

  it("another tenant's preview run and cards are never read as this tenant's", async () => {
    h.agent_runs = [previewRun("run-theirs", "seo", OTHER)];
    h.channel_actions = [card("run-theirs", "seo", "pending", null, OTHER)];
    expect((await list()).seo.first_round_open).toBe(false);
    expect(h.reads.every((r) => r.tenant === T)).toBe(true);
  });

  it("reads narrow columns, never the card body", async () => {
    h.agent_runs = [previewRun("run-seo", "seo")];
    h.channel_actions = [card("run-seo", "seo", "pending")];
    await list();
    expect(h.reads.map((r) => r.table)).toEqual(["agent_runs", "channel_actions"]);
    expect(h.reads[1].cols).toBe("channel_slug, run_id, responsibility:body->step->>responsibility");
  });

  it("FAILS CLOSED: an unreadable run list or card list leaves every channel shut", async () => {
    h.agent_runs = [previewRun("run-seo", "seo")];
    h.channel_actions = [card("run-seo", "seo", "pending")];
    h.failTable = "agent_runs";
    expect((await list()).seo.first_round_open).toBe(false);
    h.failTable = "channel_actions";
    expect((await list()).seo.first_round_open).toBe(false);
  });

  it("nothing locked (a paid plan): no first-round read at all", async () => {
    h.locks = {};
    h.agent_runs = [previewRun("run-seo", "seo")];
    h.channel_actions = [card("run-seo", "seo", "pending")];
    const out = await list();
    expect(Object.values(out).every((c) => c.first_round_open === false)).toBe(true);
    expect(h.reads).toEqual([]);
  });

  it("a zero-row read answers no channels and runs NO first-round read", async () => {
    h.channelRows = [];
    h.agent_runs = [previewRun("run-seo", "seo")];
    h.channel_actions = [card("run-seo", "seo", "pending")];
    const r = res();
    await channelsList({} as Request, r as unknown as Response);
    expect((r._body as { channels: unknown[] }).channels).toEqual([]);
    expect(h.reads).toEqual([]);
  });
});
