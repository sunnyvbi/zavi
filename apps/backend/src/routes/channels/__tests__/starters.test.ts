import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { migrationColumns, selectedColumns } from "@/__tests__/helpers/migration-columns";
import { requireAuth } from "@/services/auth/middleware";
import { generatedVideoApproveRefusal } from "@/services/channels/generated-video-render";

type Row = Record<string, unknown>;
type Query = { table: string; filters: string[] };

const mocks = vi.hoisted(() => ({
  startChannelRun: vi.fn(),
  tables: {} as Record<string, Row[]>,
  claimCols: [] as string[],
  violations: [] as string[],
  fail: null as null | ((q: { table: string; filters: string[] }) => boolean),
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ tenant_id: "t-1", user_id: "33333333-3333-3333-3333-333333333333" })),
}));
vi.mock("../run", () => ({ startChannelRun: mocks.startChannelRun }));
const videoGate = vi.hoisted(() => ({ router: true, video: true, asked: [] as string[], throws: false, locked: false as boolean | "unreadable", lockReads: [] as string[] }));
vi.mock("@/services/channels/lock", async (orig) => ({
  ...(await orig<typeof import("@/services/channels/lock")>()),
  isChannelLockedStrict: async (slug: string) => {
    videoGate.lockReads.push(slug);
    if (videoGate.locked === "unreadable") throw new Error("channel lock config unavailable");
    return videoGate.locked;
  },
}));
vi.mock("@/services/media-router/router", async (orig) => ({
  ...(await orig<typeof import("@/services/media-router/router")>()),
  isMediaRouterEnabled: async () => {
    if (videoGate.throws) throw new Error("config read failed");
    return videoGate.router;
  },
}));
const plan = vi.hoisted(() => ({ allowed: true, asked: [] as string[] }));
vi.mock("@/services/agents/entitlement", async (orig) => ({
  ...(await orig<typeof import("@/services/agents/entitlement")>()),
  checkAgentTier: async (tenant_id: string, slug: string) => (plan.asked.push(`${tenant_id}:${slug}`), { allowed: plan.allowed, required_tier: "starter" }),
}));
vi.mock("@/services/agents/_render-launch-video-flag-check", () => ({
  isGenerativeVideoEnabled: async (tenant_id: string) => (videoGate.asked.push(tenant_id), videoGate.video),
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: (tenant: string) => ({
    from: (table: string) => {
      const known = migrationColumns(table);
      const rows = mocks.tables[table] ?? [];
      for (const r of rows) for (const k of Object.keys(r)) if (!known.has(k)) throw new Error(`fixture column ${table}.${k} does not exist in supabase/migrations`);
      const q: Query = { table, filters: [] };
      const preds: Array<(r: Row) => boolean> = [(r) => r.tenant_id === tenant];
      let projection: Array<[string, string]> | null = null;
      const read = (r: Row, key: string) => {
        const [col, sub] = key.split("->>");
        const v = r[col];
        return sub === undefined ? v : v && typeof v === "object" ? ((v as Row)[sub] ?? null) : null;
      };
      const use = (key: string) => {
        q.filters.push(key);
        const col = key.split("->>")[0];
        if (!known.has(col)) mocks.violations.push(`${table}.${col}`);
      };
      const run = () => {
        if (q.filters.some((f) => !known.has(f.split("->>")[0]))) return { data: null, error: { message: "column does not exist", code: "42703" } };
        if (mocks.fail?.(q)) return { data: null, error: { message: "read failed" } };
        const m = rows.filter((r) => preds.every((p) => p(r)));
        return { data: projection ? m.map((r) => Object.fromEntries(projection!.map(([alias, key]) => [alias, read(r, key)]))) : m, error: null };
      };
      const chain: Record<string, unknown> = {
        select: (cols: string) => {
          const parts = cols.split(",").map((c) => c.trim());
          projection = parts.map((p) => {
            const m = p.match(/^([a-z_][a-z0-9_]*):(.+)$/i);
            return m ? [m[1], m[2]] : [p, p];
          });
          for (const c of selectedColumns(cols)) if (!known.has(c)) mocks.violations.push(`${table}.${c}`);
          if (table === "channel_run_claims") mocks.claimCols.push(...parts);
          return chain;
        },
        eq: (k: string, v: unknown) => (use(k), preds.push((r) => read(r, k) === v), chain),
        limit: () => chain,
        in: (k: string, vs: unknown[]) => (use(k), preds.push((r) => vs.includes(read(r, k))), chain),
        like: (k: string, pat: string) => (use(k), preds.push((r) => String(read(r, k)).startsWith(pat.replace(/%$/, ""))), chain),
        order: (k: string, o?: { ascending?: boolean }) => {
          use(k);
          if (table === "channel_run_claims") mocks.claimCols.push(k);
          const out = run();
          if (out.data) out.data.sort((a, b) => (String(a[k]) < String(b[k]) ? 1 : -1) * (o?.ascending === false ? 1 : -1));
          return Promise.resolve(out);
        },
        then: (r: (v: unknown) => unknown, j?: (e: unknown) => unknown) => Promise.resolve(run()).then(r, j),
      };
      return chain;
    },
  }),
}));

import { nextStarterRequest, startersRead, startersStart } from "../starters";
import { videoStudioHandlers } from "@/routes/video-studio";
import { defaultStudioDeps, type StudioStore } from "@/services/video-studio/studio";

const T = "t-1";
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const claim = (request_id: string, run_id: string | null, claimed_at: string = ago(60_000)): Row => ({
  tenant_id: T,
  channel_slug: "generated_video",
  request_id,
  run_id,
  claimed_at,
});
const agentRun = (id: string, status: string, starter_request?: string, enqueued_at: string = ago(60_000)): Row => ({
  tenant_id: T,
  id,
  status,
  trigger: "channel_recipe",
  enqueued_at,
  payload: starter_request ? { starter_by: "33333333-3333-3333-3333-333333333333", starter_request } : {},
});
const card = (id: string, run_id: string, exec_class: string | null = "generated_video.render.v1"): Row => ({
  tenant_id: T,
  id,
  run_id,
  channel_slug: "generated_video",
  exec_class,
});

function seed(claims: Row[], runs: Row[] = [], cards: Row[] = []) {
  mocks.tables = { channel_run_claims: claims, agent_runs: runs, channel_actions: cards };
}

function res() {
  const r: Record<string, unknown> & { body?: unknown; code?: number } = {};
  r.status = (c: number) => ((r.code = c), r);
  r.json = (b: unknown) => ((r.body = b), r);
  return r as never as { body: unknown; code?: number; status: (c: number) => unknown; json: (b: unknown) => unknown };
}

beforeEach(() => {
  mocks.startChannelRun.mockReset();
  seed([]);
  mocks.claimCols = [];
  mocks.violations = [];
  mocks.fail = null;
  videoGate.router = true;
  videoGate.video = true;
  videoGate.throws = false;
  videoGate.asked = [];
  videoGate.locked = false;
  videoGate.lockReads = [];
  plan.allowed = true;
  plan.asked = [];
});

afterEach(() => {
  expect(mocks.violations.splice(0)).toEqual([]);
});

describe("Start the AI is one run per business", () => {
  it("the first press claims attempt 1 and marks the run with who pressed it", async () => {
    await startersStart({} as never, res() as never);
    expect(mocks.startChannelRun).toHaveBeenCalledTimes(1);
    const [, auth, slug, opts] = mocks.startChannelRun.mock.calls[0];
    expect(auth.user_id).toBe("33333333-3333-3333-3333-333333333333");
    expect(slug).toBe("generated_video");
    expect(opts).toEqual({
      requestId: "ai-ugc-starters-1",
      extra: { starter_by: "33333333-3333-3333-3333-333333333333", starter_request: "ai-ugc-starters-1" },
    });
  });

  it("a second press while the first is running reuses the same request id, so the engine answers with the same run", async () => {
    seed([claim("ai-ugc-starters-1", "run-1")], [agentRun("run-1", "running", "ai-ugc-starters-1")]);
    await startersStart({} as never, res() as never);
    expect(mocks.startChannelRun.mock.calls[0][3].requestId).toBe("ai-ugc-starters-1");
  });

  it("a finished first run is not reused: the next press asks for a fresh suggestion", () => {
    expect(nextStarterRequest([{ request_id: "ai-ugc-starters-1", run_id: "run-1", status: "success", cards: 3 }])).toEqual({
      reuse: null,
      request_id: "ai-ugc-starters-2",
    });
  });

  it("a failed first run lets the founder try again with a new attempt", () => {
    expect(nextStarterRequest([{ request_id: "ai-ugc-starters-1", run_id: "run-1", status: "failed" }]).request_id).toBe("ai-ugc-starters-2");
  });

  it("GET reports the live starter run and ignores failed attempts", async () => {
    seed(
      [claim("ai-ugc-starters-2", "run-2", ago(30_000)), claim("ai-ugc-starters-1", "run-1", ago(90_000))],
      [agentRun("run-2", "success", "ai-ugc-starters-2"), agentRun("run-1", "failed", "ai-ugc-starters-1")],
      [card("c-1", "run-2")],
    );
    const r = res();
    await startersRead({} as never, r as never);
    expect(r.body).toEqual({ run_id: "run-2", started: true, run_status: "success", failed_attempts: 0, last_empty: false , first_video_used: false, first_video_action_id: null });
  });

  it("GET does not say the last suggestion failed when the latest one finished with ads after an older failure", async () => {
    seed(
      [claim("ai-ugc-starters-3", "run-3", ago(10_000)), claim("ai-ugc-starters-2", "run-2", ago(30_000)), claim("ai-ugc-starters-1", "run-1", ago(90_000))],
      [agentRun("run-3", "success", "ai-ugc-starters-3"), agentRun("run-2", "failed", "ai-ugc-starters-2"), agentRun("run-1", "failed", "ai-ugc-starters-1")],
      [card("c-1", "run-3")],
    );
    const r = res();
    await startersRead({} as never, r as never);
    expect(r.body).toMatchObject({ run_id: "run-3", failed_attempts: 0, last_empty: false });
  });

  it("GET says the latest suggestion came back empty even when an older one made ads", async () => {
    seed(
      [claim("ai-ugc-starters-2", "run-2", ago(10_000)), claim("ai-ugc-starters-1", "run-1", ago(90_000))],
      [agentRun("run-2", "success", "ai-ugc-starters-2"), agentRun("run-1", "success", "ai-ugc-starters-1")],
      [card("c-1", "run-1")],
    );
    const r = res();
    await startersRead({} as never, r as never);
    expect(r.body).toMatchObject({ run_id: "run-1", last_empty: true, failed_attempts: 1 });
  });

  it("GET counts the failures since the newest working suggestion, not every failure ever", async () => {
    seed(
      [claim("ai-ugc-starters-3", "run-3", ago(10_000)), claim("ai-ugc-starters-2", "run-2", ago(30_000)), claim("ai-ugc-starters-1", "run-1", ago(90_000))],
      [agentRun("run-3", "failed", "ai-ugc-starters-3"), agentRun("run-2", "success", "ai-ugc-starters-2"), agentRun("run-1", "failed", "ai-ugc-starters-1")],
      [card("c-1", "run-2")],
    );
    const r = res();
    await startersRead({} as never, r as never);
    expect(r.body).toMatchObject({ run_id: "run-2", failed_attempts: 1, last_empty: false });
  });

  it("GET says the workspace's one free starter video is already used, so the panel stops promising one", async () => {
    mocks.tables.starter_autostart_claims = [{ tenant_id: T, action_id: "a-1", run_id: "run-old", claimed_at: ago(86_400_000) }];
    const r = res();
    await startersRead({} as never, r as never);
    expect(r.body).toMatchObject({ started: false, first_video_used: true });
  });

  it("GET names the card that owns the free first video so the page can mark it", async () => {
    mocks.tables.starter_autostart_claims = [{ tenant_id: T, action_id: "a-1", run_id: "run-old", claimed_at: ago(1000) }];
    const r = res();
    await startersRead({} as never, r as never);
    expect(r.body).toMatchObject({ first_video_used: true, first_video_action_id: "a-1" });
  });

  it("GET names no card when the free-video claim cannot be read", async () => {
    mocks.fail = (q) => q.table === "starter_autostart_claims";
    const r = res();
    await startersRead({} as never, r as never);
    expect(r.body).toMatchObject({ first_video_used: null, first_video_action_id: null });
  });

  it("GET reports another workspace's used starter as not used here", async () => {
    mocks.tables.starter_autostart_claims = [{ tenant_id: "t-other", action_id: "a-9", run_id: null, claimed_at: ago(1000) }];
    const r = res();
    await startersRead({} as never, r as never);
    expect(r.body).toMatchObject({ first_video_used: false });
  });

  it("GET says unknown, not unused, when the free-video claim cannot be read", async () => {
    mocks.fail = (q) => q.table === "starter_autostart_claims";
    const r = res();
    await startersRead({} as never, r as never);
    expect(r.body).toMatchObject({ started: false, first_video_used: null });
  });

  it("GET before any press says not started", async () => {
    const r = res();
    await startersRead({} as never, r as never);
    expect(r.body).toEqual({ run_id: null, started: false, run_status: null, failed_attempts: 0, last_empty: false , first_video_used: false, first_video_action_id: null });
  });
});

describe("a start whose run was never created does not block Start the AI forever", () => {
  it("reads and orders claims by claimed_at, the column channel_run_claims actually has", async () => {
    await startersRead({} as never, res() as never);
    expect(mocks.claimCols).toContain("claimed_at");
    expect(mocks.claimCols).not.toContain("created_at");
  });

  it("a claim left with no run after a refused start (release failed) lets the next press start a new attempt", async () => {
    seed([claim("ai-ugc-starters-1", null, ago(6 * 60_000))]);
    await startersStart({} as never, res() as never);
    expect(mocks.startChannelRun.mock.calls[0][3].requestId).toBe("ai-ugc-starters-2");
    const r = res();
    await startersRead({} as never, r as never);
    expect(r.body).toEqual({ run_id: null, started: false, run_status: null, failed_attempts: 1, last_empty: false , first_video_used: false, first_video_action_id: null });
  });

  it("two presses while the first is still creating its run share one request id", async () => {
    seed([claim("ai-ugc-starters-1", null, ago(20_000))]);
    await startersStart({} as never, res() as never);
    await startersStart({} as never, res() as never);
    expect(mocks.startChannelRun.mock.calls.map((c) => c[3].requestId)).toEqual(["ai-ugc-starters-1", "ai-ugc-starters-1"]);
  });

  it("a claim with no run and no readable time is not live", () => {
    expect(nextStarterRequest([{ request_id: "ai-ugc-starters-1", run_id: null, status: null, claimed_at: null }]).request_id).toBe(
      "ai-ugc-starters-2",
    );
  });

  it("a new attempt never reuses the number of a claim that is still on file", () => {
    expect(nextStarterRequest([{ request_id: "ai-ugc-starters-2", run_id: "run-2", status: "failed", claimed_at: ago(60_000) }]).request_id).toBe(
      "ai-ugc-starters-3",
    );
  });
});

describe("a starter run whose claim was never settled is still the founder's run", () => {
  it("finds the run by its starter request after the grace window, so a second press never makes a second paid run", async () => {
    seed([claim("ai-ugc-starters-1", null, ago(30 * 60_000))], [agentRun("run-1", "running", "ai-ugc-starters-1")]);
    await startersStart({} as never, res() as never);
    await startersStart({} as never, res() as never);
    expect(mocks.startChannelRun.mock.calls.map((c) => c[3].requestId)).toEqual(["ai-ugc-starters-1", "ai-ugc-starters-1"]);
    const r = res();
    await startersRead({} as never, r as never);
    expect(r.body).toEqual({ run_id: "run-1", started: true, run_status: "running", failed_attempts: 0, last_empty: false , first_video_used: false, first_video_action_id: null });
  });

  it("a finished run found that way, with its videos, does not block the next suggestion", async () => {
    seed([claim("ai-ugc-starters-1", null, ago(3 * 60 * 60_000))], [agentRun("run-1", "success", "ai-ugc-starters-1")], [card("c-1", "run-1")]);
    await startersStart({} as never, res() as never);
    expect(mocks.startChannelRun.mock.calls[0][3].requestId).toBe("ai-ugc-starters-2");
  });

  it("a run made for a different starter request does not rescue the dead claim", async () => {
    seed([claim("ai-ugc-starters-2", null, ago(30 * 60_000)), claim("ai-ugc-starters-1", "run-1", ago(60 * 60_000))], [agentRun("run-1", "failed", "ai-ugc-starters-1")]);
    await startersStart({} as never, res() as never);
    expect(mocks.startChannelRun.mock.calls[0][3].requestId).toBe("ai-ugc-starters-3");
  });

  it("an unreadable run lookup keeps the claim live: no second run on a database hiccup", async () => {
    seed([claim("ai-ugc-starters-1", null, ago(30 * 60_000))], [agentRun("run-1", "running", "ai-ugc-starters-1")]);
    mocks.fail = (q) => q.table === "agent_runs" && q.filters.includes("payload->>starter_request");
    await startersStart({} as never, res() as never);
    expect(mocks.startChannelRun.mock.calls[0][3].requestId).toBe("ai-ugc-starters-1");
    const r = res();
    await startersRead({} as never, r as never);
    expect(r.body).toMatchObject({ started: true, failed_attempts: 0 });
  });

  it("a recovered run that failed lets the founder start again", async () => {
    seed([claim("ai-ugc-starters-1", null, ago(30 * 60_000))], [agentRun("run-1", "dispatch_error", "ai-ugc-starters-1")]);
    await startersStart({} as never, res() as never);
    expect(mocks.startChannelRun.mock.calls[0][3].requestId).toBe("ai-ugc-starters-2");
  });
});

describe("a starter run that finished without making a single card", () => {
  it("lets the founder start again instead of reading 0 of 0 ready forever", async () => {
    seed([claim("ai-ugc-starters-1", "run-1")], [agentRun("run-1", "success", "ai-ugc-starters-1")], [card("c-other", "run-other")]);
    const r = res();
    await startersRead({} as never, r as never);
    expect(r.body).toEqual({ run_id: null, started: false, run_status: null, failed_attempts: 1, last_empty: true , first_video_used: false, first_video_action_id: null });
    await startersStart({} as never, res() as never);
    expect(mocks.startChannelRun.mock.calls[0][3].requestId).toBe("ai-ugc-starters-2");
  });

  it("a run that wrote only a blocking check, no video script, is empty: the founder is not left on No videos yet", async () => {
    seed(
      [claim("ai-ugc-starters-1", "run-1")],
      [agentRun("run-1", "success", "ai-ugc-starters-1")],
      [card("c-check", "run-1", null), card("c-review", "run-1", "growth_review")],
    );
    const r = res();
    await startersRead({} as never, r as never);
    expect(r.body).toEqual({ run_id: null, started: false, run_status: null, failed_attempts: 1, last_empty: true , first_video_used: false, first_video_action_id: null });
    await startersStart({} as never, res() as never);
    expect(mocks.startChannelRun.mock.calls[0][3].requestId).toBe("ai-ugc-starters-2");
  });

  it("a run that wrote a check beside one video script still counts as started", async () => {
    seed(
      [claim("ai-ugc-starters-1", "run-1")],
      [agentRun("run-1", "success", "ai-ugc-starters-1")],
      [card("c-check", "run-1", null), card("c-video", "run-1", "generated_video.render.v1_review")],
    );
    const r = res();
    await startersRead({} as never, r as never);
    expect(r.body).toEqual({ run_id: "run-1", started: true, run_status: "success", failed_attempts: 0, last_empty: false , first_video_used: false, first_video_action_id: null });
  });

  it("an unreadable card count keeps the finished run on screen, and a press still asks for a fresh suggestion", async () => {
    seed([claim("ai-ugc-starters-1", "run-1")], [agentRun("run-1", "success", "ai-ugc-starters-1")]);
    mocks.fail = (q) => q.table === "channel_actions";
    const r = res();
    await startersRead({} as never, r as never);
    expect(r.body).toMatchObject({ run_id: "run-1", started: true });
    await startersStart({} as never, res() as never);
    expect(mocks.startChannelRun.mock.calls[0][3].requestId).toBe("ai-ugc-starters-2");
  });

  it("a run whose status cannot be found is treated as still working, so a press never pays for a second", async () => {
    seed([claim("ai-ugc-starters-1", "run-1")], []);
    await startersStart({} as never, res() as never);
    expect(mocks.startChannelRun.mock.calls[0][3].requestId).toBe("ai-ugc-starters-1");
  });

  it("a run still working with no cards yet stays live", async () => {
    seed([claim("ai-ugc-starters-1", "run-1")], [agentRun("run-1", "running", "ai-ugc-starters-1")]);
    await startersStart({} as never, res() as never);
    expect(mocks.startChannelRun.mock.calls[0][3].requestId).toBe("ai-ugc-starters-1");
  });
});

describe("a starter run whose start was lost and never left the queue", () => {
  it("does not block Suggest new ads forever: a press after 20 minutes queued starts a new request", async () => {
    seed(
      [claim("ai-ugc-starters-2", "run-2", ago(2 * 24 * 60 * 60_000)), claim("ai-ugc-starters-1", "run-1", ago(3 * 24 * 60 * 60_000))],
      [agentRun("run-2", "queued", "ai-ugc-starters-2", ago(2 * 24 * 60 * 60_000)), agentRun("run-1", "success", "ai-ugc-starters-1", ago(3 * 24 * 60 * 60_000))],
      [card("c-1", "run-1")],
    );
    await startersStart({} as never, res() as never);
    await startersStart({} as never, res() as never);
    expect(mocks.startChannelRun.mock.calls.map((c) => c[3].requestId)).toEqual(["ai-ugc-starters-3", "ai-ugc-starters-3"]);
  });

  it("GET stops reporting the dead run as writing, so the panel lets the founder press again", async () => {
    seed([claim("ai-ugc-starters-1", "run-1", ago(25 * 60_000))], [agentRun("run-1", "queued", "ai-ugc-starters-1", ago(25 * 60_000))]);
    const r = res();
    await startersRead({} as never, r as never);
    expect(r.body).toMatchObject({ run_id: null, started: false, run_status: null, failed_attempts: 1 });
  });

  it("a run queued for less than 20 minutes is still the founder's run, so a press never pays for a second", async () => {
    seed([claim("ai-ugc-starters-1", "run-1", ago(19 * 60_000))], [agentRun("run-1", "queued", "ai-ugc-starters-1", ago(19 * 60_000))]);
    await startersStart({} as never, res() as never);
    const r = res();
    await startersRead({} as never, r as never);
    expect(mocks.startChannelRun.mock.calls[0][3].requestId).toBe("ai-ugc-starters-1");
    expect(r.body).toMatchObject({ run_id: "run-1", started: true, run_status: "queued" });
  });

  it("a run that started long ago and is still working is not cut off, only a run that never left the queue", async () => {
    seed([claim("ai-ugc-starters-1", "run-1", ago(2 * 60 * 60_000))], [agentRun("run-1", "running", "ai-ugc-starters-1", ago(2 * 60 * 60_000))]);
    await startersStart({} as never, res() as never);
    expect(mocks.startChannelRun.mock.calls[0][3].requestId).toBe("ai-ugc-starters-1");
  });
});

describe("Suggest new ads while video making is switched off", () => {
  it.each([
    ["switched off for this workspace", { video: false }],
    ["off because the media router is off", { router: false }],
  ])("is refused up front with the switched-off 503 when video making is %s, and no run is started", async (_n, over) => {
    Object.assign(videoGate, over);
    seed([claim("ai-ugc-starters-1", "run-1")], [agentRun("run-1", "failed", "ai-ugc-starters-1")]);
    const r = res();
    await startersStart({} as never, r as never);
    expect(r.code).toBe(503);
    expect(r.body).toEqual({ error: { code: "video_unavailable", message: "Video making is switched off right now, so nothing was made and nothing was charged." } });
    expect(mocks.startChannelRun).not.toHaveBeenCalled();
  });

  it("an unreadable video switch is answered the way the card's Approve answers it, never with a raw 500", async () => {
    videoGate.throws = true;
    const approve = await generatedVideoApproveRefusal(T, null);
    expect(approve).toBeNull();
    const r = res();
    await expect(startersStart({} as never, r as never)).resolves.toBeUndefined();
    expect(r.code).not.toBe(500);
    expect(r.code).not.toBe(503);
    expect(mocks.startChannelRun).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["staff switched AI UGC Videos off", true],
    ["the switch cannot be read", "unreadable"],
  ] as const)("is refused with the channel switched-off copy, not coming soon, when %s, and no run is started", async (_n, locked) => {
    videoGate.locked = locked;
    const r = res();
    await startersStart({} as never, r as never);
    expect(r.code).toBe(503);
    expect(r.body).toEqual({ error: { code: "video_unavailable", message: "AI UGC Videos is switched off right now, so nothing was made and nothing was charged." } });
    expect(videoGate.lockReads).toEqual(["generated_video"]);
    expect(mocks.startChannelRun).not.toHaveBeenCalled();
  });

  it("asks about this tenant and starts the run as before when video making is on", async () => {
    await startersStart({} as never, res() as never);
    expect(videoGate.asked).toEqual([T]);
    expect(mocks.startChannelRun).toHaveBeenCalledTimes(1);
  });
});

describe("Suggest new ads from a staff or eval session acting on another workspace", () => {
  it("is refused with 403 tenant_override_forbidden before any read, and no run is started", async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ tenant_id: T, user_id: "33333333-3333-3333-3333-333333333333", tenant_overridden: true } as never);
    seed([claim("ai-ugc-starters-1", "run-1")], [agentRun("run-1", "failed", "ai-ugc-starters-1")]);
    mocks.fail = () => {
      throw new Error("no read may happen for an overridden tenant");
    };
    const r = res();
    await startersStart({} as never, r as never);
    expect(r.code).toBe(403);
    expect(r.body).toEqual({ error: { code: "tenant_override_forbidden", message: "Not available for an overridden tenant." } });
    expect(videoGate.asked).toEqual([]);
    expect(mocks.startChannelRun).not.toHaveBeenCalled();
  });

  it("the workspace's own session still starts the run", async () => {
    seed([claim("ai-ugc-starters-1", "run-1")], [agentRun("run-1", "failed", "ai-ugc-starters-1")]);
    await startersStart({} as never, res() as never);
    expect(mocks.startChannelRun).toHaveBeenCalledTimes(1);
  });
});

describe("Suggest new ads after a suggestion has finished", () => {
  const settle = (requestId: string, runId: string, status: string, claimedAgo: number) => {
    const claims = mocks.tables.channel_run_claims;
    const existing = claims.find((c) => c.request_id === requestId);
    if (existing) existing.run_id = runId;
    else claims.push(claim(requestId, runId, ago(claimedAgo)));
    const runs = mocks.tables.agent_runs;
    const run = runs.find((r) => r.id === runId);
    if (run) run.status = status;
    else runs.push(agentRun(runId, status, requestId));
  };

  it("a press after a finished run with ads starts a new run, while presses during each run share it", async () => {
    seed([]);
    await startersStart({} as never, res() as never);
    settle("ai-ugc-starters-1", "run-1", "running", 120_000);
    await startersStart({} as never, res() as never);
    settle("ai-ugc-starters-1", "run-1", "success", 120_000);
    mocks.tables.channel_actions.push(card("c-1", "run-1"), card("c-2", "run-1"), card("c-3", "run-1"));
    const between = res();
    await startersRead({} as never, between as never);
    expect(between.body).toMatchObject({ run_id: "run-1", started: true, run_status: "success", last_empty: false });
    await startersStart({} as never, res() as never);
    settle("ai-ugc-starters-2", "run-2", "queued", 30_000);
    await startersStart({} as never, res() as never);
    settle("ai-ugc-starters-2", "run-2", "success", 30_000);
    mocks.tables.channel_actions.push(card("c-4", "run-2"));
    await startersStart({} as never, res() as never);
    expect(mocks.startChannelRun.mock.calls.map((c) => c[3].requestId)).toEqual([
      "ai-ugc-starters-1",
      "ai-ugc-starters-1",
      "ai-ugc-starters-2",
      "ai-ugc-starters-2",
      "ai-ugc-starters-3",
    ]);
    expect(mocks.startChannelRun.mock.calls.map((c) => c[3].extra.starter_request)).toEqual([
      "ai-ugc-starters-1",
      "ai-ugc-starters-1",
      "ai-ugc-starters-2",
      "ai-ugc-starters-2",
      "ai-ugc-starters-3",
    ]);
  });

  it("a double press while the new run is still being created shares one request id", async () => {
    seed(
      [claim("ai-ugc-starters-2", null, ago(5_000)), claim("ai-ugc-starters-1", "run-1", ago(60 * 60_000))],
      [agentRun("run-1", "success", "ai-ugc-starters-1")],
      [card("c-1", "run-1")],
    );
    await startersStart({} as never, res() as never);
    await startersStart({} as never, res() as never);
    expect(mocks.startChannelRun.mock.calls.map((c) => c[3].requestId)).toEqual(["ai-ugc-starters-2", "ai-ugc-starters-2"]);
  });

  it("a press after a finished run with zero ads also starts a new run", async () => {
    seed([claim("ai-ugc-starters-1", "run-1")], [agentRun("run-1", "success", "ai-ugc-starters-1")]);
    await startersStart({} as never, res() as never);
    expect(mocks.startChannelRun.mock.calls[0][3].requestId).toBe("ai-ugc-starters-2");
  });
});

describe("Suggest new ads answers a blocked video the way Generate does: plan first, then the switch", () => {
  const studioStore = (): StudioStore => ({
    findThread: async () => null,
    createThread: async () => "thread-1",
    listMessages: async () => [],
    getMessage: async () => null,
    insertMessage: async () => {
      throw new Error("a blocked video must not write a message");
    },
    claimRender: async () => false,
    createRenderRun: async () => {
      throw new Error("a blocked video must not create a run");
    },
    listVideoArtifacts: async () => [],
  });
  const fromGenerate = async () => {
    const send = vi.fn();
    const h = videoStudioHandlers(() => ({ ...defaultStudioDeps(studioStore()), send }));
    const r = { code: 200, body: undefined as unknown } as { code: number; body: unknown; status: (c: number) => unknown; json: (b: unknown) => unknown };
    r.status = (c: number) => ((r.code = c), r);
    r.json = (b: unknown) => ((r.body = b), r);
    await h.send({ body: { text: "ugc ad for my gym" }, headers: {}, get: () => undefined } as never, r as never);
    expect(send).not.toHaveBeenCalled();
    return { code: r.code, body: r.body };
  };
  const fromSuggest = async () => {
    const r = res();
    await startersStart({} as never, r as never);
    return { code: r.code, body: r.body };
  };

  it.each([
    ["switched off for this workspace", { video: false }],
    ["off because the media router is off", { router: false }],
    ["off because staff locked AI UGC Videos", { locked: true }],
  ] as const)("a Free workspace with video %s is told it needs Starter, by Suggest new ads exactly as by Generate, and no run starts", async (_n, over) => {
    plan.allowed = false;
    Object.assign(videoGate, over);
    seed([claim("ai-ugc-starters-1", "run-1")], [agentRun("run-1", "failed", "ai-ugc-starters-1")]);
    const suggest = await fromSuggest();
    expect(suggest).toEqual({
      code: 403,
      body: { error: { code: "plan_upgrade_required", message: "AI UGC Videos needs the Starter plan ($20/mo).", required_tier: "starter" } },
    });
    expect(plan.asked).toEqual([`${T}:generated_video`]);
    expect(mocks.startChannelRun).not.toHaveBeenCalled();
    expect(await fromGenerate()).toEqual(suggest);
  });

  it.each([
    ["switched off for this workspace", { video: false }],
    ["off because the media router is off", { router: false }],
  ] as const)("a Starter workspace with video %s gets the studio's switched-off 503 word for word, and no run starts", async (_n, over) => {
    Object.assign(videoGate, over);
    const suggest = await fromSuggest();
    expect(suggest).toEqual({
      code: 503,
      body: { error: { code: "video_unavailable", message: "Video making is switched off right now, so nothing was made and nothing was charged." } },
    });
    expect(JSON.stringify(suggest.body)).not.toContain("Try again later");
    expect(mocks.startChannelRun).not.toHaveBeenCalled();
    expect(await fromGenerate()).toEqual(suggest);
  });
});
