import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import type { SiteRow } from "@/services/sites/contract";

const mocks = vi.hoisted(() => ({
  auth: { tenant_id: "11111111-1111-4111-8111-111111111111", user_id: "u1", access_token: "tok" } as
    | { tenant_id: string; user_id: string; access_token: string }
    | null,
  writer: true,
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async (_req: unknown, res: Response) => {
    if (!mocks.auth) {
      res.status(401).json({ error: { code: "unauthorized" } });
      return null;
    }
    return mocks.auth;
  }),
}));
vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: vi.fn(async (_auth: unknown, _roles: unknown, res: Response) => {
    if (mocks.writer) return true;
    res.status(403).json({ error: { code: "forbidden" } });
    return false;
  }),
}));
vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => {
    throw new Error("the route must read through its injected deps");
  },
}));
vi.mock("@/services/sites/store", () => ({
  siteStore: () => {
    throw new Error("the route must read through its injected deps");
  },
}));

import { makePostRestartBuildPreview, type BuildPreviewRestartDeps } from "../build-preview-restart";

const TENANT = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const SITE_ID = "33333333-3333-4333-8333-333333333333";

function site(over: Partial<SiteRow> = {}): SiteRow {
  return {
    id: SITE_ID,
    tenant_id: TENANT,
    root_conductor_run_id: RUN,
    started_by_user_id: null,
    owner_email: null,
    label: "rental",
    hostname: "rental.zaviagent.com",
    github_full_name: "Zavi-Latest-Build/rental-4b5ad1a6-a93554",
    supabase_project_ref: null,
    supabase_url: null,
    status: "building",
    live_url: null,
    desired_sha: null,
    live_sha: null,
    live_deploy_id: null,
    last_visit_at: null,
    last_edit_at: null,
    paused_at: null,
    last_error: null,
    ...over,
  } as SiteRow;
}

function harness(over: Partial<BuildPreviewRestartDeps> & { siteRow?: SiteRow | null; runStatus?: string } = {}) {
  const restart = vi.fn(over.restart ?? (async () => undefined));
  const loadRun = vi.fn(
    over.loadRun ??
      (async (_t: string, _tenant: string, id: string) =>
        id === RUN ? { id: RUN, status: over.runStatus ?? "done", goal_graph: [{ payload: { site_id: SITE_ID } }] } : null),
  );
  const loadSite = vi.fn(
    over.loadSite ?? (async (_tenant: string, id: string) => (id === SITE_ID ? (over.siteRow === undefined ? site() : over.siteRow) : null)),
  );
  const hasActiveSiteRun = vi.fn(over.hasActiveSiteRun ?? (async () => false));
  const lease: { kind: string | null; token: string | null } = { kind: null, token: null };
  let n = 0;
  const claimRestart = vi.fn(over.claimRestart ?? (async () => {
    if (lease.kind) return { token: null, held: lease.kind as "restart" };
    lease.kind = "restart";
    lease.token = `t${++n}`;
    return { token: lease.token };
  }));
  const releaseRestart = vi.fn(async (_t: string, _s: string, token: string) => {
    if (lease.token === token) lease.kind = lease.token = null;
  });
  const restarting = () => lease.kind === "restart";
  const handler = makePostRestartBuildPreview({ loadRun, loadSite, hasActiveSiteRun, restart, claimRestart, releaseRestart });
  return { handler, restart, loadRun, loadSite, hasActiveSiteRun, claimRestart, releaseRestart, restarting, lease };
}

async function call(handler: (req: Request, res: Response) => Promise<void>, body: unknown) {
  let status = 200;
  let json: unknown = null;
  const res = {
    status(c: number) {
      status = c;
      return res;
    },
    json(b: unknown) {
      json = b;
      return res;
    },
  } as unknown as Response;
  await handler({ body } as Request, res);
  return { status, json: json as { ok?: boolean; preview_state?: string; error?: { code: string } } };
}

beforeEach(() => {
  mocks.auth = { tenant_id: TENANT, user_id: "u1", access_token: "tok" };
  mocks.writer = true;
});

describe("POST /api/workspace/autopilot/build-preview/restart", () => {
  it("starts one restart for a finished, unpublished build and reports it as starting", async () => {
    const h = harness();
    const r = await call(h.handler, { run_id: RUN });
    expect(r.status).toBe(202);
    expect(r.json).toEqual({ ok: true, preview_state: "starting" });
    expect(h.restart).toHaveBeenCalledTimes(1);
    expect(h.restart).toHaveBeenCalledWith({ tenant_id: TENANT, run_id: RUN, site: site(), release: expect.any(Function) });
    expect(h.loadRun).toHaveBeenCalledWith("tok", TENANT, RUN);
    expect(h.restarting()).toBe(true);
  });

  it("does not boot a second sandbox when Restart is pressed again while one is starting", async () => {
    let finish: () => void = () => undefined;
    const h = harness({ restart: () => new Promise<void>((resolve) => (finish = resolve)) });
    await call(h.handler, { run_id: RUN });
    const again = await call(h.handler, { run_id: RUN });
    finish();
    expect(again.status).toBe(202);
    expect(again.json.preview_state).toBe("starting");
    expect(h.restart).toHaveBeenCalledTimes(1);
  });

  it("lets Restart be pressed again after a failed restart", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const h = harness({
      restart: async (i) => {
        await i.release();
        throw new Error("e2b capacity");
      },
    });
    await call(h.handler, { run_id: RUN });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.restarting()).toBe(false);
    await call(h.handler, { run_id: RUN });
    expect(h.restart).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("refuses a build that is still running, without touching a sandbox", async () => {
    const h = harness({ runStatus: "active" });
    const r = await call(h.handler, { run_id: RUN });
    expect(r.status).toBe(409);
    expect(r.json.error?.code).toBe("preview_not_restartable");
    expect(h.restart).not.toHaveBeenCalled();
  });

  it("refuses a published site: its preview is the live address", async () => {
    const h = harness({ siteRow: site({ status: "live", live_deploy_id: "dep_1" }) });
    const r = await call(h.handler, { run_id: RUN });
    expect(r.status).toBe(409);
    expect(h.restart).not.toHaveBeenCalled();
  });

  it("refuses while a run on this site is in flight, so a running edit's sandbox is never reset", async () => {
    const h = harness({ hasActiveSiteRun: async (_tok, _tenant, site_id) => site_id === SITE_ID });
    const r = await call(h.handler, { run_id: RUN });
    expect(r.status).toBe(409);
    expect(r.json.error?.code).toBe("build_in_progress");
    expect(h.hasActiveSiteRun).toHaveBeenCalledWith("tok", TENANT, SITE_ID);
    expect(h.restart).not.toHaveBeenCalled();
    expect(h.restarting()).toBe(false);
  });

  it("refuses while an edit acquisition holds the site's lease (another container), and fails closed on an unreadable lease", async () => {
    for (const held of ["edit", "unknown"] as const) {
      const h = harness({ claimRestart: async () => ({ token: null, held }) });
      const r = await call(h.handler, { run_id: RUN });
      expect(r.status).toBe(409);
      expect(r.json.error?.code).toBe("build_in_progress");
      expect(h.hasActiveSiteRun).not.toHaveBeenCalled();
      expect(h.restart).not.toHaveBeenCalled();
    }
  });

  it("404s a site that belongs to another workspace", async () => {
    const h = harness({ siteRow: site({ tenant_id: "99999999-9999-4999-8999-999999999999" }) });
    const r = await call(h.handler, { run_id: RUN });
    expect(r.status).toBe(404);
    expect(h.restart).not.toHaveBeenCalled();
  });

  it("404s an unknown run and 400s a malformed one", async () => {
    const h = harness();
    expect((await call(h.handler, { run_id: "44444444-4444-4444-8444-444444444444" })).status).toBe(404);
    expect((await call(h.handler, { run_id: "nope" })).status).toBe(400);
    expect(h.restart).not.toHaveBeenCalled();
  });

  it("is closed to a member who cannot change the app", async () => {
    mocks.writer = false;
    const h = harness();
    const r = await call(h.handler, { run_id: RUN });
    expect(r.status).toBe(403);
    expect(h.loadRun).not.toHaveBeenCalled();
    expect(h.restart).not.toHaveBeenCalled();
  });
});
