
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";
import { DEFAULT_NEXT_TILES, NEXT_TILE_MAKE_PROMPTS, NEXT_TILE_THINK_PROMPTS } from "@zavi/shared";

let authResult: { user_id: string; tenant_id: string; access_token: string } | null;

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async (_req: Request, res: Response) => {
    if (authResult) return authResult;
    res.status(401).json({ error: { code: "unauthenticated", message: "no auth" } });
    return null;
  }),
}));

type Result = { data?: unknown; error: { message: string } | null; count?: number | null };
let rpcResults: Record<string, Result>;
let tableResults: Record<string, Result>;
const rpcCalls: Array<[string, unknown]> = [];
const tableFilters: Record<string, Array<[string, string, unknown]>> = {};

function chain(table: string) {
  const result = () => tableResults[table] ?? { data: null, error: null, count: 0 };
  const c: Record<string, unknown> = {
    select: () => c,
    eq: (col: string, v: unknown) => {
      (tableFilters[table] ??= []).push(["eq", col, v]);
      return c;
    },
    in: (col: string, v: unknown) => {
      (tableFilters[table] ??= []).push(["in", col, v]);
      return c;
    },
    not: () => c,
    order: () => c,
    limit: () => c,
    maybeSingle: async () => result(),
    then: (resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(result()).then(resolve, reject),
  };
  return c;
}

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: vi.fn(() => ({
    rpc: async (fn: string, args?: unknown) => {
      rpcCalls.push([fn, args]);
      return rpcResults[fn] ?? { data: null, error: null };
    },
    from: (t: string) => chain(t),
  })),
}));

let planValue: { id: string | null } | null;
let planFails: boolean;
let planChannels: string[];
let drafting: boolean | Error;

vi.mock("../growth-plan", () => ({
  readPlan: vi.fn(async (_sb: unknown, _t: string, failed: Set<string>) => {
    if (planFails) failed.add("plan");
    return planValue;
  }),
  readPlanChannelSlugs: vi.fn(async () => planChannels),
}));
let locks: Record<string, string | null> = {};
let locksFail = false;
vi.mock("@/services/agents/entitlement", () => ({
  annotateLockedTier: vi.fn(async (rows: Array<{ slug: string }>, _t: string, onReadError?: () => void) => {
    if (locksFail) onReadError?.();
    return rows.map((r) => ({ ...r, locked_tier: locksFail ? null : (locks[r.slug] ?? null) }));
  }),
}));
vi.mock("../growth-strategy-draft", () => ({
  isGrowthDraftInFlight: vi.fn(async () => {
    if (drafting instanceof Error) throw drafting;
    return drafting;
  }),
}));

import { getNextTiles, postNextTilesMark } from "../next-tiles";

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(b: unknown) {
      res.body = b;
      return res;
    },
    end() {
      return res;
    },
  };
  return res;
}

const req = (body?: unknown) => ({ body }) as unknown as Request;

beforeEach(() => {
  locks = {};
  locksFail = false;
  authResult = { user_id: "u-1", tenant_id: "t-1", access_token: "tok" };
  rpcResults = {};
  tableResults = {};
  rpcCalls.length = 0;
  for (const k of Object.keys(tableFilters)) delete tableFilters[k];
  planValue = null;
  planFails = false;
  planChannels = [];
  drafting = false;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("GET /api/workspace/next-tiles", () => {
  it("401 when unauthenticated", async () => {
    authResult = null;
    const res = mockRes();
    await getNextTiles(req(), res as unknown as Response);
    expect(res.statusCode).toBe(401);
  });

  it("first login returns the default three tiles", async () => {
    tableResults.connector_metadata = { data: null, error: null, count: 1 };
    const res = mockRes();
    await getNextTiles(req(), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ tiles: DEFAULT_NEXT_TILES, first_run_done: false });
  });

  it("never offers to run a channel the plan does not include", async () => {
    tableResults.connector_metadata = { data: null, error: null, count: 1 };
    locks = { seo: "starter" };
    const res = mockRes();
    await getNextTiles(req(), res as unknown as Response);
    const tiles = (res.body as { tiles: Array<{ kind: string; key: string }> }).tiles;
    expect(tiles).toHaveLength(3);
    expect(tiles.some((t) => t.kind === "channel" && t.key === "seo")).toBe(false);
  });

  it("a failed plan read offers no Run tile (unknown, not included)", async () => {
    tableResults.connector_metadata = { data: null, error: null, count: 1 };
    locksFail = true;
    const res = mockRes();
    await getNextTiles(req(), res as unknown as Response);
    const tiles = (res.body as { tiles: Array<{ kind: string; state: string }> }).tiles;
    expect(tiles.some((t) => t.kind === "channel" && t.state === "run")).toBe(false);
  });

  it("resolves from real state: plan ready, channel working, talk shown", async () => {
    planValue = { id: "p-1" };
    planChannels = ["meta_ads"];
    tableResults.agent_runs = {
      data: [
        { channel_slug: "meta_ads", status: "running" },
        { channel_slug: "meta_ads", status: "succeeded" },
      ],
      error: null,
    };
    tableResults.connector_metadata = { data: null, error: null, count: 0 };
    tableResults.tenant_first_run_progress = {
      data: { plan_opened_at: null, asked: {}, made: {} },
      error: null,
    };
    const res = mockRes();
    await getNextTiles(req(), res as unknown as Response);
    const tiles = (res.body as { tiles: Array<{ kind: string; state: string; key: string }> }).tiles;
    expect(tiles).toHaveLength(3);
    expect(tiles.map((t) => [t.kind, t.state, t.key])).toEqual([
      ["plan", "open", "plan"],
      ["channel", "working", "meta_ads"],
      ["ask", "ask", NEXT_TILE_THINK_PROMPTS[0].prompt],
    ]);
    expect(tableFilters.connector_metadata).toContainEqual(["eq", "tenant_id", "t-1"]);
    expect(tableFilters.connector_metadata).toContainEqual([
      "in",
      "slug",
      ["whatsapp", "imessage", "slack", "telegram", "discord", "teams"],
    ]);
  });

  it("a founder paste's record run newer than a running agent run does not hide the running work", async () => {
    planValue = { id: "p-1" };
    planChannels = ["email_marketing"];
    tableResults.agent_runs = {
      data: [
        { channel_slug: "email_marketing", status: "success", agent_definition_hash: "email_marketing_founder_paste" },
        { channel_slug: "email_marketing", status: "running", agent_definition_hash: "abc123" },
      ],
      error: null,
    };
    tableResults.connector_metadata = { data: null, error: null, count: 0 };
    tableResults.tenant_first_run_progress = { data: { plan_opened_at: null, asked: {}, made: {} }, error: null };
    const res = mockRes();
    await getNextTiles(req(), res as unknown as Response);
    const tiles = (res.body as { tiles: Array<{ kind: string; state: string; key: string }> }).tiles;
    expect(tiles.find((t) => t.kind === "channel")).toMatchObject({ key: "email_marketing", state: "working" });
  });

  it("a chat-requested video holder run newer than a running Suggest run does not hide the running work", async () => {
    planValue = { id: "p-1" };
    planChannels = ["generated_video"];
    tableResults.agent_runs = {
      data: [
        { channel_slug: "generated_video", status: "failed", agent_definition_hash: "generated-video-requested-card" },
        { channel_slug: "generated_video", status: "success", agent_definition_hash: "generated-video-requested-card" },
        { channel_slug: "generated_video", status: "running", agent_definition_hash: "abc123" },
      ],
      error: null,
    };
    tableResults.connector_metadata = { data: null, error: null, count: 0 };
    tableResults.tenant_first_run_progress = { data: { plan_opened_at: null, asked: {}, made: {} }, error: null };
    const res = mockRes();
    await getNextTiles(req(), res as unknown as Response);
    const tiles = (res.body as { tiles: Array<{ kind: string; state: string; key: string }> }).tiles;
    expect(tiles.find((t) => t.kind === "channel")).toMatchObject({ key: "generated_video", state: "working" });
  });

  it("drafting when no plan and a draft is in flight", async () => {
    drafting = true;
    const res = mockRes();
    await getNextTiles(req(), res as unknown as Response);
    const tiles = (res.body as { tiles: Array<{ kind: string; state: string }> }).tiles;
    expect(tiles[0]).toMatchObject({ kind: "plan", state: "writing" });
  });

  it("reads channel runs for the session tenant only, and a queued run counts as working", async () => {
    planValue = null;
    tableResults.agent_runs = { data: [{ channel_slug: "seo", status: "queued" }], error: null };
    tableResults.connector_metadata = { data: null, error: null, count: 1 };
    const res = mockRes();
    await getNextTiles(req(), res as unknown as Response);
    expect(tableFilters.agent_runs).toContainEqual(["eq", "tenant_id", expect.any(String)]);
    const tiles = (res.body as { tiles: Array<{ kind: string; state: string; key: string }> }).tiles;
    expect(tiles.find((t) => t.kind === "channel")).toMatchObject({ key: "seo", state: "working" });
    expect(rpcCalls.map(([fn]) => fn)).not.toContain("list_agents_for_tenant");
  });

  it("a read error returns defaults with degraded:true", async () => {
    tableResults.agent_runs = { data: null, error: { message: "boom" } };
    const res = mockRes();
    await getNextTiles(req(), res as unknown as Response);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ tiles: DEFAULT_NEXT_TILES, first_run_done: false, degraded: true });
  });

  it("a plan read failure (recorded, not thrown) also degrades", async () => {
    planFails = true;
    const res = mockRes();
    await getNextTiles(req(), res as unknown as Response);
    expect(res.body).toEqual({ tiles: DEFAULT_NEXT_TILES, first_run_done: false, degraded: true });
  });

  it("a thrown draft read degrades", async () => {
    drafting = new Error("nope");
    const res = mockRes();
    await getNextTiles(req(), res as unknown as Response);
    expect(res.body).toEqual({ tiles: DEFAULT_NEXT_TILES, first_run_done: false, degraded: true });
  });
});

describe("POST /api/workspace/next-tiles/mark", () => {
  it("401 when unauthenticated", async () => {
    authResult = null;
    const res = mockRes();
    await postNextTilesMark(req({ kind: "plan_opened" }), res as unknown as Response);
    expect(res.statusCode).toBe(401);
    expect(rpcCalls).toHaveLength(0);
  });

  it("400 on an unknown kind", async () => {
    const res = mockRes();
    await postNextTilesMark(req({ kind: "hacked", key: "x" }), res as unknown as Response);
    expect(res.statusCode).toBe(400);
    expect(rpcCalls).toHaveLength(0);
  });

  it("400 when asked is not a THINK prompt, or made is not a MAKE prompt", async () => {
    for (const body of [
      { kind: "asked", key: "anything I like" },
      { kind: "asked", key: NEXT_TILE_MAKE_PROMPTS[0].prompt },
      { kind: "made", key: NEXT_TILE_THINK_PROMPTS[0].prompt },
    ]) {
      const res = mockRes();
      await postNextTilesMark(req(body), res as unknown as Response);
      expect(res.statusCode).toBe(400);
    }
    expect(rpcCalls).toHaveLength(0);
  });

  it("calls the RPC with kind and key", async () => {
    const res = mockRes();
    await postNextTilesMark(
      req({ kind: "asked", key: NEXT_TILE_THINK_PROMPTS[2].prompt }),
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(204);
    expect(rpcCalls).toEqual([
      ["mark_first_run_progress", { p_tenant_id: expect.any(String), p_kind: "asked", p_key: NEXT_TILE_THINK_PROMPTS[2].prompt }],
    ]);
  });

  it("plan_opened needs no key", async () => {
    const res = mockRes();
    await postNextTilesMark(req({ kind: "plan_opened" }), res as unknown as Response);
    expect(res.statusCode).toBe(204);
    expect(rpcCalls).toEqual([["mark_first_run_progress", { p_tenant_id: expect.any(String), p_kind: "plan_opened", p_key: "plan" }]]);
  });

  it("an RPC error is non-fatal (still 204)", async () => {
    rpcResults.mark_first_run_progress = { data: null, error: { message: "db down" } };
    const res = mockRes();
    await postNextTilesMark(
      req({ kind: "made", key: NEXT_TILE_MAKE_PROMPTS[1].prompt }),
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(204);
  });
});
