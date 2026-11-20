import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const mocks = vi.hoisted(() => ({
  auth: { tenant_id: "", user_id: "", access_token: "tok" } as { tenant_id: string; user_id: string; access_token: string } | null,
  roles: [] as Array<{ user_id: string; tenant_id: string; role: string }>,
  roleReads: [] as Array<{ user_id: unknown; tenant_id: unknown }>,
  builderOn: true,
  runWrites: [] as Array<{ update: Record<string, unknown>; eq: Record<string, unknown>; in: Record<string, unknown>; select: string }>,
  runResult: { data: [{ id: "cr_1" }] as Array<{ id: string }> | null, error: null as null | { message: string } },
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async (_req: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }) => {
    if (!mocks.auth) {
      res.status(401).json({ error: { code: "unauthorized", message: "sign in" } });
      return null;
    }
    return mocks.auth;
  }),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      if (table === "conductor_runs") {
        const w = { update: {} as Record<string, unknown>, eq: {} as Record<string, unknown>, in: {} as Record<string, unknown>, select: "" };
        type RunQuery = {
          update: (v: Record<string, unknown>) => RunQuery;
          eq: (k: string, v: unknown) => RunQuery;
          in: (k: string, v: unknown) => RunQuery;
          select: (c: string) => Promise<typeof mocks.runResult>;
        };
        const q: RunQuery = {
          update: (v) => {
            w.update = v;
            return q;
          },
          eq: (k, v) => {
            w.eq[k] = v;
            return q;
          },
          in: (k, v) => {
            w.in[k] = v;
            return q;
          },
          select: async (c) => {
            w.select = c;
            mocks.runWrites.push(w);
            return mocks.runResult;
          },
        };
        return q;
      }
      if (table !== "tenant_users") throw new Error(`unexpected service read of ${table}`);
      const filters: Record<string, unknown> = {};
      type RoleQuery = {
        select: () => RoleQuery;
        eq: (k: string, v: unknown) => RoleQuery;
        maybeSingle: () => Promise<{ data: { role: string } | null; error: null }>;
      };
      const b: RoleQuery = {
        select: () => b,
        eq: (k: string, v: unknown) => {
          filters[k] = v;
          return b;
        },
        maybeSingle: async () => {
          mocks.roleReads.push({ user_id: filters.user_id, tenant_id: filters.tenant_id });
          const row = mocks.roles.find((r) => r.user_id === filters.user_id && r.tenant_id === filters.tenant_id);
          return { data: row ? { role: row.role } : null, error: null };
        },
      };
      return b;
    },
  }),
}));
vi.mock("@/agents/engineer/product-builder-flag", () => ({ isProductBuilderEnabled: async () => mocks.builderOn }));

import { handleSitePublish, realDiscardPublishSlot, type SitePublishDeps } from "../site-publish";
import { createSiteRepublisher, SITE_FIRST_PUBLISH_MAX_USD } from "@/services/agents/refine-product";
import { DoubleBuildInFlight, ProvisionBudgetExceeded, TooManyBuildsToday } from "@/services/agents/start-product-build";
import type { ConductorNode } from "@/services/agents/conductor";
import { fakeSiteStore, siteRow, T1, T2 } from "@/services/sites/__tests__/fake-site-store";

const SA = "aaaaaaaa-0000-4000-8000-000000000001";
const SB = "bbbbbbbb-0000-4000-8000-000000000002";
const SLIVE = "cccccccc-0000-4000-8000-000000000003";
const SGONE = "dddddddd-0000-4000-8000-000000000004";
const SFAILED = "eeeeeeee-0000-4000-8000-000000000005";
const MISSING = "ffffffff-0000-4000-8000-000000000006";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const OLD_SHA = "89abcdef0123456789abcdef0123456789abcdef";
const UNDONE_SHA = "fedcba9876543210fedcba9876543210fedcba98";

type FakeRun = { id: string; tenant_id: string; status: string; kind?: string; goal_graph?: ConductorNode[] };

function world(over: Partial<SitePublishDeps> = {}) {
  const runs: FakeRun[] = [];
  const ticks: string[] = [];
  const slotCalls: Array<Record<string, unknown>> = [];
  const statusWrites: Array<{ conductor_run_id: string; status: string; goal_graph?: ConductorNode[] }> = [];
  const hooks = {
    acquire: null as null | Error,
    tick: null as null | Error,
    activate: null as null | Error,
    releaseWrite: null as null | Error,
    discard: null as null | Error,
  };
  const { store } = fakeSiteStore([
    siteRow({ id: SA, tenant_id: T1, label: "alpha", root_conductor_run_id: "root-a", status: "building" }),
    siteRow({ id: SB, tenant_id: T2, label: "beta", root_conductor_run_id: "root-b", status: "building" }),
    siteRow({ id: SLIVE, tenant_id: T1, label: "gamma", root_conductor_run_id: "root-c", status: "live", live_sha: OLD_SHA, desired_sha: OLD_SHA, live_deploy_id: "d1", live_url: "https://gamma.zaviagent.com" }),
    siteRow({ id: SGONE, tenant_id: T1, label: "delta", status: "deleted" }),
    siteRow({ id: SFAILED, tenant_id: T1, label: "epsilon", status: "failed" }),
  ]);
  const get = vi.fn(store.get);
  const headOf = vi.fn(async (_repo: string): Promise<{ sha: string } | { error: string }> => ({ sha: HEAD }));
  const republisher = createSiteRepublisher({
    resolveDailyCap: async () => 25,
    tryAcquireBuildSlot: async (params) => {
      slotCalls.push(params);
      await Promise.resolve();
      if (hooks.acquire) throw hooks.acquire;
      if (runs.some((r) => r.tenant_id === params.tenant_id && (r.status === "provisioning" || r.status === "active"))) {
        throw new DoubleBuildInFlight(params.tenant_id);
      }
      const id = `cr_${runs.length + 1}`;
      runs.push({ id, tenant_id: params.tenant_id, status: "provisioning", kind: "build_app", goal_graph: [] });
      return id;
    },
    updateConductorRunStatus: async (params) => {
      if (params.status === "failed" && hooks.releaseWrite) throw hooks.releaseWrite;
      statusWrites.push(params);
      const run = runs.find((r) => r.id === params.conductor_run_id);
      if (!run) throw new Error("no such run");
      run.status = params.status;
      if (params.goal_graph) run.goal_graph = params.goal_graph;
    },
    stageReservedGraph: async (params) => {
      const run = runs.find((r) => r.id === params.conductor_run_id);
      if (!run || run.status !== "provisioning") throw new Error("no held run");
      run.goal_graph = params.goal_graph;
    },
    activateReserved: async (params) => {
      if (hooks.activate) throw hooks.activate;
      const run = runs.find((r) => r.id === params.conductor_run_id);
      if (!run || (run.status !== "provisioning" && run.status !== "active")) return "gone" as const;
      if (run.status === "active") return "already_active" as const;
      run.status = "active";
      run.goal_graph = params.goal_graph;
      statusWrites.push({ ...params, status: "active" });
      return "activated" as const;
    },
    requestTick: async (id) => {
      if (hooks.tick) throw hooks.tick;
      ticks.push(id);
    },
  });
  const reserve = vi.fn(republisher.reserve);
  const start = vi.fn(republisher.start);
  const release = vi.fn(republisher.release);
  const stage = vi.fn(republisher.stage);
  const discardHeldSlot = vi.fn(async ({ tenant_id, conductor_run_id }: { tenant_id: string; conductor_run_id: string }) => {
    await Promise.resolve();
    if (hooks.discard) throw hooks.discard;
    const run = runs.find(
      (r) => r.id === conductor_run_id && r.tenant_id === tenant_id && r.kind === "build_app" && (r.status === "provisioning" || r.status === "active"),
    );
    if (!run) throw new Error("no held slot");
    run.kind = "undo";
    run.status = "failed";
  });
  const rootRunStatus = vi.fn(async (_tenant_id: string, _run_id: string): Promise<string | null> => "done");
  const deps: SitePublishDeps = { store: { get }, headOf, republisher: { reserve, start, release, stage }, discardHeldSlot, rootRunStatus, ...over };
  const deployGraphs = () => statusWrites.filter((w) => w.goal_graph !== undefined);
  const failedBuilds = () => runs.filter((r) => r.kind === "build_app" && r.status === "failed");
  const builds = () => runs.filter((r) => r.kind === "build_app");
  return { deps, runs, ticks, slotCalls, statusWrites, hooks, get, headOf, reserve, start, release, discardHeldSlot, rootRunStatus, deployGraphs, failedBuilds, builds };
}

type Reply = { statusCode: number; body: { ok?: boolean; conductor_run_id?: string; error?: { code: string; message: string } } };

async function publish(deps: SitePublishDeps, site_id: string): Promise<Reply> {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  await handleSitePublish({ params: { site_id }, body: {}, headers: {} } as unknown as Request, res as unknown as Response, deps);
  return res as unknown as Reply;
}

function nothingStarted(w: ReturnType<typeof world>) {
  expect(w.reserve).not.toHaveBeenCalled();
  expect(w.start).not.toHaveBeenCalled();
  expect(w.slotCalls).toEqual([]);
  expect(w.statusWrites).toEqual([]);
  expect(w.ticks).toEqual([]);
  expect(w.runs).toEqual([]);
}

beforeEach(() => {
  mocks.auth = { tenant_id: T1, user_id: "u-admin", access_token: "tok" };
  mocks.roles = [
    { user_id: "u-admin", tenant_id: T1, role: "admin" },
    { user_id: "u-owner", tenant_id: T1, role: "owner" },
    { user_id: "u-member", tenant_id: T1, role: "member" },
    { user_id: "u-member", tenant_id: T2, role: "owner" },
    { user_id: "u-viewer", tenant_id: T1, role: "viewer" },
    { user_id: "u-viewer", tenant_id: T2, role: "owner" },
    { user_id: "u-other", tenant_id: T2, role: "owner" },
  ];
  mocks.roleReads = [];
  mocks.builderOn = true;
  mocks.runWrites = [];
  mocks.runResult = { data: [{ id: "cr_1" }], error: null };
});

describe("realDiscardPublishSlot", () => {
  it("moves only this tenant's held build_app slot out of the build bucket, as a failed undo row", async () => {
    await realDiscardPublishSlot({ tenant_id: T1, conductor_run_id: "cr_1" });
    expect(mocks.runWrites).toHaveLength(1);
    const w = mocks.runWrites[0];
    expect(w.update).toMatchObject({ kind: "undo", status: "failed" });
    expect(w.eq).toEqual({ tenant_id: T1, id: "cr_1", kind: "build_app" });
    expect(w.in).toEqual({ status: ["provisioning", "active"] });
  });

  it("throws when no held slot matched, so the caller falls back to a release", async () => {
    mocks.runResult = { data: [], error: null };
    await expect(realDiscardPublishSlot({ tenant_id: T1, conductor_run_id: "cr_1" })).rejects.toThrow(/matched no held slot/);
  });

  it("throws on a database error", async () => {
    mocks.runResult = { data: null, error: { message: "timeout" } };
    await expect(realDiscardPublishSlot({ tenant_id: T1, conductor_run_id: "cr_1" })).rejects.toThrow(/timeout/);
  });
});

describe("POST /api/workspace/autopilot/sites/:site_id/publish", () => {
  it.each(["u-admin", "u-owner"])("%s starts exactly one deploy run at the repo's HEAD", async (user_id) => {
    mocks.auth = { tenant_id: T1, user_id, access_token: "tok" };
    const w = world();
    const r = await publish(w.deps, SA);

    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ ok: true, conductor_run_id: "cr_1" });
    expect(w.headOf.mock.calls).toEqual([["Praxis-build/alpha"], ["Praxis-build/alpha"]]);
    expect(w.slotCalls).toHaveLength(1);
    expect(w.slotCalls[0]).toMatchObject({ tenant_id: T1, is_refine: true, max_usd: SITE_FIRST_PUBLISH_MAX_USD });
    expect(w.deployGraphs()).toHaveLength(1);
    const write = w.deployGraphs()[0];
    expect(write.conductor_run_id).toBe("cr_1");
    expect(write.status).toBe("active");
    expect(write.goal_graph).toHaveLength(1);
    expect(write.goal_graph![0].payload).toMatchObject({
      stage: "deploy",
      republish: true,
      publish_request: true,
      site_id: SA,
      site_sha: HEAD,
      parent_conductor_run_id: "root-a",
      target: { github_full_name: "Praxis-build/alpha", default_branch: "main" },
    });
    expect(w.ticks).toEqual(["cr_1"]);
    expect(w.runs).toEqual([{ id: "cr_1", tenant_id: T1, status: "active", kind: "build_app", goal_graph: write.goal_graph }]);
    expect(w.discardHeldSlot).not.toHaveBeenCalled();
    expect(w.release).not.toHaveBeenCalled();
  });

  it.each(["active", "provisioning", "paused", "failed", "halted"])("a site whose build run is %s is refused with build_not_finished, before any slot or GitHub read", async (status) => {
    const w = world();
    w.rootRunStatus.mockResolvedValue(status);
    const r = await publish(w.deps, SA);
    expect(r.statusCode).toBe(409);
    expect(r.body.error?.code).toBe("build_not_finished");
    expect(r.body.error?.message).toMatch(/build/i);
    expect(w.rootRunStatus.mock.calls).toEqual([[T1, "root-a"]]);
    expect(w.headOf).not.toHaveBeenCalled();
    nothingStarted(w);
  });

  it("a site whose build run cannot be found is refused the same way", async () => {
    const w = world();
    w.rootRunStatus.mockResolvedValue(null);
    const r = await publish(w.deps, SA);
    expect(r.statusCode).toBe(409);
    expect(r.body.error?.code).toBe("build_not_finished");
    nothingStarted(w);
  });

  it("a site with no build run on record is refused without a read", async () => {
    const w = world();
    const site = (await w.get(T1, SA))!;
    w.get.mockResolvedValueOnce({ ...site, root_conductor_run_id: null });
    const r = await publish(w.deps, SA);
    expect(r.statusCode).toBe(409);
    expect(r.body.error?.code).toBe("build_not_finished");
    expect(w.rootRunStatus).not.toHaveBeenCalled();
    nothingStarted(w);
  });

  it("a build run that cannot be read refuses the publish and starts nothing", async () => {
    const w = world();
    w.rootRunStatus.mockRejectedValue(new Error("db timeout"));
    const r = await publish(w.deps, SA);
    expect(r.statusCode).toBe(503);
    expect(r.body.error?.code).toBe("build_status_unreadable");
    expect(r.body.error?.message).not.toContain("db timeout");
    expect(w.headOf).not.toHaveBeenCalled();
    nothingStarted(w);
  });

  it("a site whose build run is done publishes", async () => {
    const w = world();
    const r = await publish(w.deps, SA);
    expect(r.statusCode).toBe(200);
    expect(w.rootRunStatus.mock.calls).toEqual([[T1, "root-a"]]);
    expect(w.reserve).toHaveBeenCalledTimes(1);
  });

  it("publishes the commit GitHub reports, normalised, and never a client-supplied one", async () => {
    const w = world();
    w.headOf.mockResolvedValue({ sha: HEAD.toUpperCase() });
    const res = { statusCode: 200, body: undefined as unknown, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
    await handleSitePublish(
      { params: { site_id: SA }, body: { sha: OLD_SHA, tenant_id: T2, site_id: SB }, query: { tenant_id: T2 }, headers: {} } as unknown as Request,
      res as unknown as Response,
      w.deps,
    );
    expect(res.statusCode).toBe(200);
    expect(w.deployGraphs()[0].goal_graph![0].payload).toMatchObject({ site_id: SA, site_sha: HEAD });
    expect(w.slotCalls[0]).toMatchObject({ tenant_id: T1 });
  });

  it("publishes the head it reads AFTER taking the slot, not the one it saw before: a commit undone in between is never deployed", async () => {
    const w = world();
    const slotHeldAtRead: boolean[] = [];
    w.headOf.mockImplementation(async () => {
      slotHeldAtRead.push(w.runs.some((r) => r.status === "provisioning"));
      return { sha: slotHeldAtRead.length === 1 ? UNDONE_SHA : HEAD };
    });
    const r = await publish(w.deps, SA);

    expect(r.statusCode).toBe(200);
    expect(slotHeldAtRead).toEqual([false, true]);
    expect(w.start).toHaveBeenCalledTimes(1);
    expect(w.start.mock.calls[0][0]).toMatchObject({ tenant_id: T1, conductor_run_id: "cr_1", sha: HEAD });
    expect(w.deployGraphs()).toHaveLength(1);
    expect(w.deployGraphs()[0].goal_graph![0].payload).toMatchObject({ site_id: SA, site_sha: HEAD });
    expect(JSON.stringify(w.statusWrites)).not.toContain(UNDONE_SHA);
    expect(w.release).not.toHaveBeenCalled();
  });

  it.each([
    ["GitHub does not answer", async (): Promise<{ sha: string } | { error: string }> => ({ error: "GitHub answered 502 for Praxis-build/alpha@main" })],
    ["the answer is not a commit", async (): Promise<{ sha: string } | { error: string }> => ({ sha: "main" })],
    ["the read throws", async (): Promise<{ sha: string } | { error: string }> => {
      throw new Error("socket hang up");
    }],
  ])("when the head read after the slot fails (%s): the slot is discarded, no failed build is left behind, nothing is started, and it says the head is unreadable", async (_name, second) => {
    const w = world();
    const buildsBefore = w.builds().length;
    w.headOf.mockImplementationOnce(async () => ({ sha: HEAD })).mockImplementationOnce(second);
    const r = await publish(w.deps, SA);

    expect(r.statusCode).toBe(502);
    expect(r.body.error?.code).toBe("site_head_unreadable");
    expect(r.body.error?.message).not.toMatch(/GitHub answered|socket/);
    expect(w.reserve).toHaveBeenCalledTimes(1);
    expect(w.discardHeldSlot.mock.calls).toEqual([[{ tenant_id: T1, conductor_run_id: "cr_1" }]]);
    expect(w.release).not.toHaveBeenCalled();
    expect(w.start).not.toHaveBeenCalled();
    expect(w.deployGraphs()).toEqual([]);
    expect(w.ticks).toEqual([]);
    expect(w.failedBuilds()).toEqual([]);
    expect(w.builds()).toHaveLength(buildsBefore);
    expect(w.runs.map((x) => ({ id: x.id, status: x.status, kind: x.kind }))).toEqual([{ id: "cr_1", status: "failed", kind: "undo" }]);

    w.headOf.mockImplementation(async () => ({ sha: HEAD }));
    const again = await publish(w.deps, SA);
    expect(again.statusCode).toBe(200);
    expect(again.body.conductor_run_id).toBe("cr_2");
  });

  it("when the head read after the slot is already the live commit: the slot is released and nothing is republished", async () => {
    const w = world();
    w.headOf.mockImplementationOnce(async () => ({ sha: HEAD })).mockImplementationOnce(async () => ({ sha: OLD_SHA.toUpperCase() }));
    const r = await publish(w.deps, SLIVE);

    expect(r.statusCode).toBe(409);
    expect(r.body.error?.code).toBe("already_published");
    expect(w.headOf).toHaveBeenCalledTimes(2);
    expect(w.discardHeldSlot.mock.calls).toEqual([[{ tenant_id: T1, conductor_run_id: "cr_1" }]]);
    expect(w.release).not.toHaveBeenCalled();
    expect(w.start).not.toHaveBeenCalled();
    expect(w.deployGraphs()).toEqual([]);
    expect(w.ticks).toEqual([]);
    expect(w.failedBuilds()).toEqual([]);
    expect(w.builds()).toEqual([]);
  });

  it("a refused slot never triggers the second head read", async () => {
    const w = world();
    w.runs.push({ id: "cr_build", tenant_id: T1, status: "active" });
    const r = await publish(w.deps, SA);
    expect(r.statusCode).toBe(409);
    expect(w.headOf).toHaveBeenCalledTimes(1);
  });

  it("a member publishes like an owner (Ravi 2026-10-02, option C), scoped to their own tenant's site", async () => {
    mocks.auth = { tenant_id: T1, user_id: "u-member", access_token: "tok" };
    const w = world();
    const r = await publish(w.deps, SA);
    expect(r.statusCode).toBe(200);
    expect(w.reserve).toHaveBeenCalledTimes(1);
    expect(w.slotCalls[0]).toMatchObject({ tenant_id: T1 });
    const foreign = await publish(world().deps, SB);
    expect(foreign.statusCode).not.toBe(200);
  });

  it("a viewer is refused and nothing is read, reserved or started", async () => {
    mocks.auth = { tenant_id: T1, user_id: "u-viewer", access_token: "tok" };
    const w = world();
    const r = await publish(w.deps, SA);

    expect(r.statusCode).toBe(403);
    expect(r.body.error?.code).toBe("forbidden");
    expect(mocks.roleReads).toEqual([{ user_id: "u-viewer", tenant_id: T1 }]);
    expect(w.get).not.toHaveBeenCalled();
    expect(w.headOf).not.toHaveBeenCalled();
    nothingStarted(w);
  });

  it("a viewer cannot learn whether a site exists: the same 403 for a real, a foreign and a missing site", async () => {
    mocks.auth = { tenant_id: T1, user_id: "u-viewer", access_token: "tok" };
    const w = world();
    const bodies: Reply[] = [];
    for (const id of [SA, SB, MISSING]) bodies.push(await publish(w.deps, id));
    expect(bodies.map((b) => b.statusCode)).toEqual([403, 403, 403]);
    expect(bodies[1].body).toEqual(bodies[0].body);
    expect(bodies[2].body).toEqual(bodies[0].body);
    nothingStarted(w);
  });

  it("someone with no membership row in the auth tenant is refused", async () => {
    mocks.auth = { tenant_id: T1, user_id: "u-other", access_token: "tok" };
    const w = world();
    const r = await publish(w.deps, SA);
    expect(r.statusCode).toBe(403);
    nothingStarted(w);
  });

  it("an unauthenticated request stops at auth", async () => {
    mocks.auth = null;
    const w = world();
    const r = await publish(w.deps, SA);
    expect(r.statusCode).toBe(401);
    expect(mocks.roleReads).toEqual([]);
    nothingStarted(w);
  });

  it("a site of another tenant is a 404 identical to a missing site, and nothing is started", async () => {
    const w = world();
    const foreign = await publish(w.deps, SB);
    const missing = await publish(w.deps, MISSING);

    expect(foreign.statusCode).toBe(404);
    expect(foreign.body).toEqual({ error: { code: "site_not_found", message: "site not found" } });
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toEqual(foreign.body);
    expect(w.get.mock.calls).toEqual([[T1, SB], [T1, MISSING]]);
    expect(w.headOf).not.toHaveBeenCalled();
    nothingStarted(w);
  });

  it("a store that leaks another tenant's row is still refused as not found", async () => {
    const w = world();
    const leaky = vi.fn(async (_t: string, id: string) => (id === SB ? siteRow({ id: SB, tenant_id: T2, label: "beta" }) : null));
    const r = await publish({ ...w.deps, store: { get: leaky } }, SB);
    expect(r.statusCode).toBe(404);
    expect(r.body.error?.code).toBe("site_not_found");
    expect(w.headOf).not.toHaveBeenCalled();
    nothingStarted(w);
  });

  it("the owner of tenant B cannot publish tenant A's site through their own session", async () => {
    mocks.auth = { tenant_id: T2, user_id: "u-other", access_token: "tok" };
    const w = world();
    const r = await publish(w.deps, SA);
    expect(r.statusCode).toBe(404);
    expect(w.get.mock.calls).toEqual([[T2, SA]]);
    nothingStarted(w);
  });

  it("a deleted site of the same tenant is the same 404", async () => {
    const w = world();
    const r = await publish(w.deps, SGONE);
    expect(r.statusCode).toBe(404);
    expect(r.body).toEqual({ error: { code: "site_not_found", message: "site not found" } });
    nothingStarted(w);
  });

  it("is refused while a run is active in the workspace, and no second run is started", async () => {
    const w = world();
    w.runs.push({ id: "cr_build", tenant_id: T1, status: "active" });
    const r = await publish(w.deps, SA);

    expect(r.statusCode).toBe(409);
    expect(r.body.error?.code).toBe("build_already_in_progress");
    expect(w.start).not.toHaveBeenCalled();
    expect(w.statusWrites).toEqual([]);
    expect(w.ticks).toEqual([]);
    expect(w.release).not.toHaveBeenCalled();
    expect(w.runs).toEqual([{ id: "cr_build", tenant_id: T1, status: "active" }]);
  });

  it("a run still being set up (provisioning) blocks a publish too", async () => {
    const w = world();
    w.runs.push({ id: "cr_setup", tenant_id: T1, status: "provisioning" });
    const r = await publish(w.deps, SA);
    expect(r.statusCode).toBe(409);
    expect(w.deployGraphs()).toEqual([]);
    expect(w.ticks).toEqual([]);
  });

  it("another tenant's active run does not block this tenant", async () => {
    const w = world();
    w.runs.push({ id: "cr_theirs", tenant_id: T2, status: "active" });
    const r = await publish(w.deps, SA);
    expect(r.statusCode).toBe(200);
    expect(w.ticks).toHaveLength(1);
  });

  it("two clicks racing each other start exactly one deploy run", async () => {
    const w = world();
    const replies = await Promise.all([publish(w.deps, SA), publish(w.deps, SA), publish(w.deps, SA)]);

    expect(replies.map((r) => r.statusCode).sort()).toEqual([200, 409, 409]);
    expect(replies.filter((r) => r.statusCode === 409).every((r) => r.body.error?.code === "build_already_in_progress")).toBe(true);
    expect(w.deployGraphs()).toHaveLength(1);
    expect(w.ticks).toHaveLength(1);
    expect(w.runs.filter((r) => r.status === "active")).toHaveLength(1);
    expect(w.runs).toHaveLength(1);
    expect(w.release).not.toHaveBeenCalled();
  });

  it("when start throws, the reserved run is discarded, never left holding the build slot and never counted as a failed build", async () => {
    const w = world();
    w.hooks.activate = new Error("conductor activation down");
    const r = await publish(w.deps, SA);

    expect(r.statusCode).toBe(500);
    expect(r.body.error?.code).toBe("publish_failed");
    expect(r.body.error?.message).not.toContain("inngest");
    expect(w.discardHeldSlot.mock.calls).toEqual([[{ tenant_id: T1, conductor_run_id: "cr_1" }]]);
    expect(w.release).not.toHaveBeenCalled();
    expect(w.failedBuilds()).toEqual([]);
    expect(w.builds()).toEqual([]);
    expect(w.runs.map((x) => ({ id: x.id, status: x.status, kind: x.kind }))).toEqual([{ id: "cr_1", status: "failed", kind: "undo" }]);
    expect(w.ticks).toEqual([]);

    w.hooks.activate = null;
    const again = await publish(w.deps, SA);
    expect(again.statusCode).toBe(200);
    expect(again.body.conductor_run_id).toBe("cr_2");
  });

  it("when writing the deploy graph throws, the reserved run is released", async () => {
    const w = world();
    const start = vi.fn(async () => {
      throw new Error("conductor_runs update failed");
    });
    const r = await publish({ ...w.deps, republisher: { ...w.deps.republisher, start } }, SA);
    expect(r.statusCode).toBe(500);
    expect(w.discardHeldSlot.mock.calls).toEqual([[{ tenant_id: T1, conductor_run_id: "cr_1" }]]);
    expect(w.release).not.toHaveBeenCalled();
    expect(w.failedBuilds()).toEqual([]);
    expect(w.runs.map((x) => x.status)).toEqual(["failed"]);
    expect(w.ticks).toEqual([]);
  });

  it("when the discard fails, the slot is still released so the workspace is never blocked", async () => {
    const w = world();
    w.hooks.discard = new Error("db blip");
    w.headOf.mockImplementationOnce(async () => ({ sha: HEAD })).mockImplementationOnce(async () => ({ error: "GitHub answered 502" }));
    const r = await publish(w.deps, SA);
    expect(r.statusCode).toBe(502);
    expect(w.discardHeldSlot).toHaveBeenCalledTimes(1);
    expect(w.release.mock.calls).toEqual([[{ tenant_id: T1, conductor_run_id: "cr_1" }]]);
    expect(w.runs.map((x) => x.status)).toEqual(["failed"]);

    w.hooks.discard = null;
    w.headOf.mockImplementation(async () => ({ sha: HEAD }));
    expect((await publish(w.deps, SA)).statusCode).toBe(200);
  });

  it("a release that itself fails still answers 500 and does not throw", async () => {
    const w = world();
    w.hooks.activate = new Error("conductor activation down");
    w.hooks.discard = new Error("db down");
    w.hooks.releaseWrite = new Error("db down");
    const r = await publish(w.deps, SA);
    expect(r.statusCode).toBe(500);
    expect(r.body.error?.code).toBe("publish_failed");
    expect(w.discardHeldSlot).toHaveBeenCalledTimes(1);
    expect(w.release).toHaveBeenCalledTimes(1);
  });

  it("a started run is never released", async () => {
    const w = world();
    const r = await publish(w.deps, SA);
    expect(r.statusCode).toBe(200);
    expect(w.release).not.toHaveBeenCalled();
    expect(w.discardHeldSlot).not.toHaveBeenCalled();
    expect(w.statusWrites.some((x) => x.status === "failed")).toBe(false);
  });

  it("an unavailable tick delivery preserves the active publish for the cron sweep", async () => {
    const w = world();
    w.hooks.tick = new Error("inngest down");
    const r = await publish(w.deps, SA);
    expect(r.statusCode).toBe(200);
    expect(w.runs[0].status).toBe("active");
    expect(w.deployGraphs()).toHaveLength(1);
    expect(w.discardHeldSlot).not.toHaveBeenCalled();
    expect(w.release).not.toHaveBeenCalled();
  });

  it("a gone sandbox no longer blocks Publish: the deploy run starts and its deploy step re-seeds the sandbox", async () => {
    const probe = vi.fn(async () => false);
    const w = world({ sandboxReady: probe } as unknown as Partial<SitePublishDeps>);
    const r = await publish(w.deps, SA);
    expect(r.statusCode).toBe(200);
    expect(probe).not.toHaveBeenCalled();
    expect(r.body.error).toBeUndefined();
    expect(w.deployGraphs()).toHaveLength(1);
    expect(w.ticks).toEqual(["cr_1"]);
    expect((await w.deps.store.get(T1, SA))?.status).toBe("building");
  });

  it("an unreadable HEAD publishes nothing and never falls back to a stored commit", async () => {
    const w = world();
    w.headOf.mockResolvedValue({ error: "GitHub answered 404 for Praxis-build/alpha@main" });
    const r = await publish(w.deps, SLIVE);
    expect(r.statusCode).toBe(502);
    expect(r.body.error?.code).toBe("site_head_unreadable");
    expect(r.body.error?.message).not.toContain("GitHub answered");
    nothingStarted(w);
  });

  it("a HEAD that is not a commit sha is refused", async () => {
    const w = world();
    w.headOf.mockResolvedValue({ sha: "main; rm -rf /" });
    const r = await publish(w.deps, SA);
    expect(r.statusCode).toBe(502);
    nothingStarted(w);
  });

  it("a live site whose HEAD is already the live commit is not republished", async () => {
    const w = world();
    w.headOf.mockResolvedValue({ sha: OLD_SHA });
    const r = await publish(w.deps, SLIVE);
    expect(r.statusCode).toBe(409);
    expect(r.body.error?.code).toBe("already_published");
    nothingStarted(w);
  });

  it("a publish that put HEAD live while this request waited for the slot is not repeated", async () => {
    const w = world();
    const before = await w.get(T1, SLIVE);
    let reads = 0;
    w.deps.store = {
      get: async (t: string, id: string) => {
        reads += 1;
        return reads === 1 ? before : before ? { ...before, live_sha: HEAD, desired_sha: HEAD } : null;
      },
    } as never;
    const r = await publish(w.deps, SLIVE);
    expect(r.statusCode).toBe(409);
    expect(r.body.error?.code).toBe("already_published");
    expect(w.start).not.toHaveBeenCalled();
    expect(w.discardHeldSlot).toHaveBeenCalledTimes(1);
  });

  it("a live site with a newer HEAD is published at that HEAD", async () => {
    const w = world();
    const r = await publish(w.deps, SLIVE);
    expect(r.statusCode).toBe(200);
    expect(w.deployGraphs()).toHaveLength(1);
    expect(w.deployGraphs()[0].goal_graph![0].payload).toMatchObject({ site_id: SLIVE, site_sha: HEAD });
    expect(w.slotCalls[0]).toMatchObject({ max_usd: 1 });
  });

  it("a failed site is refused without reading its repo", async () => {
    const w = world();
    const r = await publish(w.deps, SFAILED);
    expect(r.statusCode).toBe(409);
    expect(r.body.error?.code).toBe("site_unavailable");
    expect(w.headOf).not.toHaveBeenCalled();
    nothingStarted(w);
  });

  it.each([
    [new TooManyBuildsToday(T1, 50, 50), 429, "daily_build_limit_reached"],
    [new ProvisionBudgetExceeded(0), 402, "provision_budget_exceeded"],
    [new Error("try_acquire_build_slot failed: timeout"), 500, "publish_failed"],
  ] as const)("a refused slot (%s) starts nothing and releases nothing", async (err, status, code) => {
    const w = world();
    w.hooks.acquire = err;
    const r = await publish(w.deps, SA);
    expect(r.statusCode).toBe(status);
    expect(r.body.error?.code).toBe(code);
    expect(w.start).not.toHaveBeenCalled();
    expect(w.release).not.toHaveBeenCalled();
    expect(w.statusWrites).toEqual([]);
    expect(w.ticks).toEqual([]);
  });

  it("a malformed site id is a 400 before any read", async () => {
    const w = world();
    const r = await publish(w.deps, "../../etc/passwd");
    expect(r.statusCode).toBe(400);
    expect(r.body.error?.code).toBe("bad_request");
    expect(w.get).not.toHaveBeenCalled();
    nothingStarted(w);
  });

  it("is refused while the product builder is switched off", async () => {
    mocks.builderOn = false;
    const w = world();
    const r = await publish(w.deps, SA);
    expect(r.statusCode).toBe(403);
    expect(r.body.error?.code).toBe("product_builder_disabled");
    nothingStarted(w);
  });

  it("a store read that throws is a 500 with nothing started", async () => {
    const w = world();
    const r = await publish({ ...w.deps, store: { get: vi.fn(async () => { throw new Error("sites read failed: timeout"); }) } }, SA);
    expect(r.statusCode).toBe(500);
    expect(r.body.error?.code).toBe("publish_failed");
    expect(r.body.error?.message).not.toContain("timeout");
    nothingStarted(w);
  });
});
