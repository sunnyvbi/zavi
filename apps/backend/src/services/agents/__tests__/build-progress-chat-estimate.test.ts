import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeSiteStore, siteRow } from "@/services/sites/__tests__/fake-site-store";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";

const h = vi.hoisted(() => ({
  runs: [] as Array<Record<string, unknown>>,
  children: [] as Array<Record<string, unknown>>,
  store: null as unknown,
  settings: {} as Record<string, boolean>,
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async () => ({ tenant_id: "11111111-1111-4111-8111-111111111111", user_id: "u", access_token: "tok" }),
}));
vi.mock("@/services/sites/store", () => ({ siteStore: () => h.store }));
vi.mock("@/services/hosting/site-publish", () => ({
  verifySiteDeploy: async () => ({ ok: false, error: "mismatch" }),
}));
vi.mock("@/services/settings", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/services/settings")>();
  return { ...real, getBoolSetting: async (key: string) => h.settings[key] ?? true };
});

function chain(resolve: (calls: Array<[string, unknown[]]>) => unknown) {
  const calls: Array<[string, unknown[]]> = [];
  const api: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "or", "order", "gte", "is", "not"]) {
    api[m] = (...a: unknown[]) => {
      calls.push([m, a]);
      return api;
    };
  }
  api.limit = (...a: unknown[]) => {
    calls.push(["limit", a]);
    return resolve(calls);
  };
  api.maybeSingle = () => resolve(calls);
  api.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(resolve(calls)).then(ok, bad);
  return api;
}

const eqOf = (calls: Array<[string, unknown[]]>, col: string) => calls.find(([m, a]) => m === "eq" && a[0] === col)?.[1][1];
const inOf = (calls: Array<[string, unknown[]]>, col: string) =>
  (calls.find(([m, a]) => m === "in" && a[0] === col)?.[1][1] as unknown[] | undefined) ?? [];

function childRows(calls: Array<[string, unknown[]]>) {
  const tenant = eqOf(calls, "tenant_id");
  const ids = inOf(calls, "id");
  return h.children.filter((c) => c.tenant_id === tenant && ids.includes(c.id));
}

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    from: (table: string) => {
      if (table === "conductor_runs") {
        return chain((calls) => {
          const id = eqOf(calls, "id");
          return { data: id ? h.runs.filter((r) => r.id === id) : h.runs, error: null };
        });
      }
      if (table === "agent_runs") return chain((calls) => ({ data: childRows(calls), error: null }));
      return chain(() => ({ data: [], error: null }));
    },
  }),
  serviceClient: () => ({ from: () => chain(() => ({ data: null, error: null })), rpc: async () => ({ data: null, error: null }) }),
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({ from: () => chain(() => ({ data: null, error: null })) }),
}));

import { getAutopilotBuildStatus } from "@/routes/workspace/autopilot";
import { resetSiteLiveChecks } from "@/services/sites/site-build-status";
import { buildProgressOfSession, type BindingDb } from "@/services/agents/build-session-binding";
import { buildEstimateText as cardEstimateText } from "../../../../../web/src/lib/workspace/buildEstimate";

function chatDb(): BindingDb {
  return {
    from: (table: string) =>
      chain((calls) => {
        const tenant = eqOf(calls, "tenant_id");
        if (table === "conductor_runs") {
          const row = h.runs.find((r) => r.id === eqOf(calls, "id") && r.tenant_id === tenant && r.kind === eqOf(calls, "kind"));
          return { data: row ?? null, error: null };
        }
        if (table === "agent_runs") return { data: childRows(calls), error: null };
        return { data: null, error: null };
      }),
  } as unknown as BindingDb;
}

const MIN = 60_000;
const OLD = "c0000000-0000-4000-8000-00000000000c";
const SITE_RUN = "b0000000-0000-4000-8000-00000000000b";
const SITE = "bbbbbbbb-0000-4000-8000-000000000002";
const CHILD = "d0000000-0000-4000-8000-00000000000d";
const T_SCAFFOLD = Date.parse("2026-10-01T10:05:00Z");
const T_DEPLOY = Date.parse("2026-10-01T11:00:00Z");

const run = (id: string, graph: Array<Record<string, unknown>>, status = "active") => ({
  id,
  tenant_id: TENANT,
  kind: "build_app",
  objective: "Build product: X — x",
  status,
  goal_graph: graph,
  spend_usd: 0,
  max_usd: 10,
  created_at: "2026-10-01T09:00:00Z",
  updated_at: "2026-10-01T09:00:00Z",
});

const oldGraph = () => [
  { status: "done", payload: { stage: "provision" }, started_at: "2026-10-01T10:00:00Z", finished_at: "2026-10-01T10:02:00Z" },
  { status: "done", payload: { stage: "spec" }, started_at: "2026-10-01T10:02:00Z", finished_at: "2026-10-01T10:05:00Z" },
  { status: "dispatched", payload: { stage: "scaffold" }, child_run_id: CHILD },
  { status: "pending", payload: { stage: "build" } },
  { status: "pending", payload: { stage: "qa" } },
];

const siteGraph = () => [
  { status: "done", payload: { stage: "provision" } },
  { status: "done", payload: { stage: "build", site_id: SITE, fast_single_pass: true } },
  { status: "running", payload: { stage: "deploy", site_id: SITE }, started_at: "2026-10-01T11:00:00Z" },
];

async function cardText(run_id: string, nowMs: number): Promise<string | null> {
  const r = { statusCode: 200, body: undefined as any, status(c: number) { r.statusCode = c; return r; }, json(b: unknown) { r.body = b; return r; } };
  await getAutopilotBuildStatus({ query: { run_id } } as never, r as never);
  expect(r.statusCode).toBe(200);
  return cardEstimateText(r.body.run.stages, nowMs);
}

async function chat(run_id: string, nowMs: number, tenant = TENANT) {
  return buildProgressOfSession(chatDb(), tenant, run_id, { now: () => nowMs });
}

beforeEach(() => {
  resetSiteLiveChecks();
  h.settings = {};
  h.store = fakeSiteStore([siteRow({ id: SITE, label: "beta", root_conductor_run_id: SITE_RUN, status: "building" })]).store;
  h.runs = [run(OLD, oldGraph()), run(SITE_RUN, siteGraph())];
  h.children = [
    { id: CHILD, tenant_id: TENANT, agent_slug: "engineer", status: "running", started_at: "2026-10-01T10:05:00Z" },
    { id: CHILD, tenant_id: OTHER_TENANT, agent_slug: "engineer", status: "running", started_at: "2026-10-01T09:00:00Z" },
  ];
});

describe("chat gets the build card's own time estimate", () => {
  it("old flow: the stage start comes from the child run, and chat says what the card says", async () => {
    const now = T_SCAFFOLD + 10 * MIN;
    const card = await cardText(OLD, now);
    expect(card).toBe("About 35 minutes left");
    expect(await chat(OLD, now)).toEqual({ current_stage: "scaffold", estimate: card });
  });

  it("matches the card second by second through a long stage, up to and past the point the card hides it", async () => {
    let shown = 0;
    let hidden = 0;
    for (let t = T_SCAFFOLD; t <= T_SCAFFOLD + 40 * MIN; t += 37_000) {
      const card = await cardText(OLD, t);
      const progress = await chat(OLD, t);
      expect(progress?.estimate ?? null, `at +${(t - T_SCAFFOLD) / 1000}s`).toBe(card);
      if (card) shown++;
      else hidden++;
    }
    expect(shown).toBeGreaterThan(10);
    expect(hidden).toBeGreaterThan(10);
  });

  it("overrun: once the running stage passes 1.25x its expected time the card shows nothing and chat gets no number", async () => {
    const just = T_SCAFFOLD + 1.25 * 25 * MIN;
    expect(await cardText(OLD, just)).toBe("About 20 minutes left");
    expect((await chat(OLD, just))?.estimate).toBe("About 20 minutes left");
    const past = just + 1;
    expect(await cardText(OLD, past)).toBeNull();
    expect(await chat(OLD, past)).toEqual({ current_stage: "scaffold", estimate: null });
  });

  it("new-flow site: site stage lengths, same text, and the same cut-off", async () => {
    for (const offset of [0, 30_000, 2 * MIN, 3 * MIN + 45_000, 3 * MIN + 45_001, 10 * MIN]) {
      const card = await cardText(SITE_RUN, T_DEPLOY + offset);
      const progress = await chat(SITE_RUN, T_DEPLOY + offset);
      expect(progress?.current_stage).toBe("deploy");
      expect(progress?.estimate ?? null).toBe(card);
    }
    expect(await cardText(SITE_RUN, T_DEPLOY + 30_000)).toBe("About 3 minutes left");
    expect(await cardText(SITE_RUN, T_DEPLOY + 3 * MIN + 45_001)).toBeNull();
  });

  it("timings switched off: the card has no number, so chat has none either", async () => {
    h.settings.build_progress_moves_in_stage = false;
    const now = T_SCAFFOLD + MIN;
    expect(await cardText(OLD, now)).toBeNull();
    expect(await chat(OLD, now)).toEqual({ current_stage: "scaffold", estimate: null });
  });

  it("a stopped, paused or finished build gives chat no progress block", async () => {
    for (const status of ["paused", "halted", "failed", "done"]) {
      h.runs = [run(OLD, oldGraph(), status)];
      expect(await chat(OLD, T_SCAFFOLD + MIN)).toBeNull();
    }
  });

  it("a build of another tenant, a non-build run, or a bad id gives nothing", async () => {
    expect(await chat(OLD, T_SCAFFOLD + MIN, OTHER_TENANT)).toBeNull();
    h.runs = [{ ...run(OLD, oldGraph()), kind: "company_goal" }];
    expect(await chat(OLD, T_SCAFFOLD + MIN)).toBeNull();
    expect(await chat("not-a-uuid", T_SCAFFOLD + MIN)).toBeNull();
  });

  it("a failed run read throws so chat-send can drop the block instead of sending a made-up one", async () => {
    const db = { from: () => chain(() => ({ data: null, error: { message: "boom" } })) } as unknown as BindingDb;
    await expect(buildProgressOfSession(db, TENANT, OLD, { now: () => T_SCAFFOLD })).rejects.toThrow(/boom/);
  });
});

describe("chat estimate while the build waits for the founder's look", () => {
  const PARKED = "e0000000-0000-4000-8000-00000000000e";
  const parkedGraph = (siteId: unknown = SITE) => [
    { status: "done", payload: { stage: "provision", site_id: SITE } },
    { status: "pending", payload: { stage: "build", site_id: siteId, fast_single_pass: true, await_look: true } },
    { status: "pending", payload: { stage: "deploy", site_id: SITE } },
  ];
  const unparkedGraph = () => [
    { status: "done", payload: { stage: "provision", site_id: SITE } },
    { status: "pending", payload: { stage: "build", site_id: SITE, fast_single_pass: true } },
    { status: "pending", payload: { stage: "deploy", site_id: SITE } },
  ];
  const at = Date.parse("2026-10-01T12:00:00Z");
  const progress = (awaitsLook: (t: string, s: string) => Promise<boolean>) =>
    buildProgressOfSession(chatDb(), TENANT, PARKED, { now: () => at, awaitsLook });

  it("shows the waiting line while parked and the row awaits a pick", async () => {
    h.runs = [run(PARKED, parkedGraph())];
    const awaitsLook = vi.fn(async () => true);
    const p = await progress(awaitsLook);
    expect(p).toEqual({ current_stage: "build", estimate: "Waiting for you to pick a website" });
    expect(p!.estimate).not.toMatch(/minute/);
    expect(awaitsLook).toHaveBeenCalledTimes(1);
    expect(awaitsLook).toHaveBeenCalledWith(TENANT, SITE);
  });

  it("gives the normal minutes once the pick is saved, even with the marker still in the graph", async () => {
    h.runs = [run(PARKED, parkedGraph())];
    const p = await progress(async () => false);
    expect(p!.estimate).toMatch(/^About \d+ minutes? left$/);
  });

  it("never reads the design row for a run that is not parked, and gives the normal minutes", async () => {
    h.runs = [run(PARKED, unparkedGraph())];
    const awaitsLook = vi.fn(async () => true);
    const p = await progress(awaitsLook);
    expect(awaitsLook).not.toHaveBeenCalled();
    expect(p!.estimate).toMatch(/^About \d+ minutes? left$/);
  });

  it("falls back to the normal estimate when the design row read fails", async () => {
    h.runs = [run(PARKED, parkedGraph())];
    const p = await progress(async () => {
      throw new Error("db down");
    });
    expect(p!.estimate).toMatch(/^About \d+ minutes? left$/);
  });

  it("matches the normal estimate exactly when not waiting", async () => {
    h.runs = [run(PARKED, parkedGraph())];
    const waiting = await progress(async () => false);
    h.runs = [run(PARKED, unparkedGraph())];
    const plain = await progress(async () => false);
    expect(waiting).toEqual(plain);
  });
});
