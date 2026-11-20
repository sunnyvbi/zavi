import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  refineProduct: vi.fn(),
  startVersionPreview: vi.fn(),
  siteVersionPreview: vi.fn(),
  siteVersionJob: vi.fn(),
  getVersionPreview: vi.fn(),
  startProductBuild: vi.fn(),
  continueBuild: vi.fn(),
  requestConductorTick: vi.fn(async () => true),
  role: "member" as string | null,
  roleReads: [] as Array<{ user_id: unknown; tenant_id: unknown }>,
  tenantWrites: [] as Array<{ table: string; op: string }>,
  tenantReads: [] as string[],
}));

function roleClient() {
  const filters: Record<string, unknown> = {};
  const b = {
    select: () => b,
    eq: (k: string, v: unknown) => {
      filters[k] = v;
      return b;
    },
    maybeSingle: async () => {
      mocks.roleReads.push({ user_id: filters.user_id, tenant_id: filters.tenant_id });
      return { data: mocks.role ? { role: mocks.role } : null, error: null };
    },
  };
  return b;
}

function recordingTenantClient() {
  const builder = (table: string) => {
    const b: Record<string, unknown> = {};
    const chain = () => b;
    const write = (op: string) => () => {
      mocks.tenantWrites.push({ table, op });
      return b;
    };
    Object.assign(b, {
      select: () => {
        mocks.tenantReads.push(table);
        return b;
      },
      update: write("update"),
      delete: write("delete"),
      upsert: write("upsert"),
      insert: write("insert"),
      eq: chain,
      in: chain,
      is: chain,
      not: chain,
      order: chain,
      limit: chain,
      maybeSingle: async () => ({ data: { app_id: "app.example.com" }, error: null }),
      then: (resolve: (r: unknown) => void) =>
        resolve({
          data:
            table === "tenant_resources"
              ? [{ status: "ready", external_ref: { url: "https://app.example.com" } }]
              : table === "website_edits"
                ? [{ id: "e1", selector: "h1", patch: { text: "x" }, removed: false, published_at: null }]
                : [],
          error: null,
        }),
    });
    return b;
  };
  return { from: builder, rpc: vi.fn(async () => ({ data: null, error: null })) };
}

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: (table: string) => (table === "tenant_users" ? roleClient() : recordingTenantClient().from(table)) }),
  serverClientFromBearer: () => recordingTenantClient(),
}));
vi.mock("@/services/tenant-client", () => ({
  tenantClient: () => recordingTenantClient(),
  tenantRpc: vi.fn(async () => ({ data: null, error: null })),
  publicHostClient: () => recordingTenantClient(),
}));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/settings", async () => {
  const actual = await vi.importActual<typeof import("@/services/settings")>("@/services/settings");
  return { ...actual, getBoolSetting: vi.fn(async () => false), getBoolSettingStrict: vi.fn(async () => false) };
});
vi.mock("@/services/tenants/founder-activity-alert", () => ({ notifyFounderActivity: vi.fn() }));
vi.mock("@/agents/engineer/product-builder-flag", () => ({ isProductBuilderEnabled: async () => true }));
vi.mock("@/services/agents/conductor-kick", () => ({
  requestConductorTick: mocks.requestConductorTick,
  requestTickForFinishedChild: vi.fn(),
}));
vi.mock("@/services/sites/site-versions", async () => {
  const actual = await vi.importActual<typeof import("@/services/sites/site-versions")>("@/services/sites/site-versions");
  return { siteVersionPreview: mocks.siteVersionPreview, siteVersionJob: mocks.siteVersionJob, siteVersionErrorRetryable: actual.siteVersionErrorRetryable, PREWARM_SKIPPED: actual.PREWARM_SKIPPED };
});
vi.mock("@/services/build/version-preview", () => ({
  startVersionPreview: mocks.startVersionPreview,
  getVersionPreview: mocks.getVersionPreview,
}));
vi.mock("@/services/agents/start-product-build", async () => {
  const actual = await vi.importActual<typeof import("@/services/agents/start-product-build")>(
    "@/services/agents/start-product-build",
  );
  return { ...actual, startProductBuild: mocks.startProductBuild };
});
vi.mock("@/services/agents/continue-build", () => ({ continueBuild: mocks.continueBuild }));
vi.mock("@/services/agents/refine-product", async () => {
  const actual = await vi.importActual<typeof import("@/services/agents/refine-product")>(
    "@/services/agents/refine-product",
  );
  return { ...actual, refineProduct: mocks.refineProduct };
});

import {
  postAutopilotBuildProduct,
  postAutopilotContinueRun,
  postAutopilotRefineProduct,
  postAutopilotRestoreCheckpoint,
  postAutopilotUndoNode,
  postAutopilotVersionPreview,
  getAutopilotVersionPreview,
} from "../autopilot";
import { publishWebsiteEditsHandler } from "../website-edits";

const SESSION = "11111111-1111-4111-8111-111111111111";

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) {
      res.statusCode = c;
      return res;
    },
    json(b: unknown) {
      res.body = b;
      return res;
    },
    set() {
      return res;
    },
    setHeader() {},
  };
  return res;
}

type Handler = (req: never, res: never) => Promise<void>;

const RUN = "22222222-2222-4222-8222-222222222222";

async function call(handler: Handler, body: Record<string, unknown>) {
  const res = mockRes();
  await handler({ body, query: {}, params: { run_id: RUN, node_id: "n1" } } as never, res as never);
  return res;
}

const REFINE_BODY = { message: "add a pricing section with three plans", conductor_run_id: SESSION };

const routes: Array<[string, Handler, Record<string, unknown>]> = [
  ["version-preview", postAutopilotVersionPreview as Handler, { conductor_run_id: SESSION }],
  ["build-product", postAutopilotBuildProduct as Handler, { idea: "a booking site for a dog groomer in Austin" }],
  ["continue run", postAutopilotContinueRun as Handler, {}],
  ["undo node", postAutopilotUndoNode as Handler, {}],
  ["restore checkpoint", postAutopilotRestoreCheckpoint as Handler, { run_id: RUN }],
];

beforeEach(() => {
  mocks.requireAuth.mockReset().mockResolvedValue({ tenant_id: "tnt-1", user_id: "member-user", access_token: "tok" });
  mocks.refineProduct.mockReset().mockResolvedValue({ conductor_run_id: "cr-new", parent_conductor_run_id: SESSION, target: "repo" });
  mocks.startVersionPreview.mockReset().mockReturnValue({ status: "starting" });
  mocks.siteVersionPreview.mockReset().mockResolvedValue({ kind: "not_site" });
  mocks.siteVersionJob.mockReset().mockResolvedValue(null);
  mocks.getVersionPreview.mockReset().mockResolvedValue(null);
  mocks.startProductBuild.mockReset().mockResolvedValue({ conductor_run_id: "cr-build" });
  mocks.continueBuild.mockReset().mockResolvedValue({ ok: true });
  mocks.requestConductorTick.mockClear();
  mocks.role = "member";
  mocks.roleReads.length = 0;
  mocks.tenantWrites.length = 0;
  mocks.tenantReads.length = 0;
});

describe("paid and public build actions are owner/admin only", () => {
  it.each(routes)("%s refuses a plain member before any side effect", async (_name, handler, body) => {
    const res = await call(handler, body);
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe("forbidden");
    expect(mocks.roleReads).toEqual([{ user_id: "member-user", tenant_id: "tnt-1" }]);
    expect(mocks.refineProduct).not.toHaveBeenCalled();
    expect(mocks.startVersionPreview).not.toHaveBeenCalled();
    expect(mocks.startProductBuild).not.toHaveBeenCalled();
    expect(mocks.continueBuild).not.toHaveBeenCalled();
    expect(mocks.requestConductorTick).not.toHaveBeenCalled();
    expect(mocks.tenantWrites).toEqual([]);
    expect(mocks.tenantReads).toEqual([]);
  });

  it.each(routes)("%s refuses a caller whose membership row vanished", async (_name, handler, body) => {
    mocks.role = null;
    const res = await call(handler, body);
    expect(res.statusCode).toBe(403);
    expect(mocks.refineProduct).not.toHaveBeenCalled();
    expect(mocks.startVersionPreview).not.toHaveBeenCalled();
    expect(mocks.tenantWrites).toEqual([]);
  });

  it("an owner still continues a paused build", async () => {
    mocks.role = "owner";
    await call(postAutopilotContinueRun as Handler, {});
    expect(mocks.continueBuild).toHaveBeenCalledWith("tnt-1", RUN);
  });

  it.each(["owner", "admin", "member"])("a %s reaches the refine dispatch (option C: members change existing sites)", async (role) => {
    mocks.role = role;
    const res = await call(postAutopilotRefineProduct as Handler, REFINE_BODY);
    expect(res.statusCode).toBe(200);
    expect(mocks.refineProduct).toHaveBeenCalledTimes(1);
  });

  it.each(["viewer", null])("a %s cannot dispatch a refine", async (role) => {
    mocks.role = role;
    const res = await call(postAutopilotRefineProduct as Handler, REFINE_BODY);
    expect(res.statusCode).toBe(403);
    expect(mocks.refineProduct).not.toHaveBeenCalled();
    expect(mocks.tenantWrites).toEqual([]);
  });

  it("an owner still starts a version preview", async () => {
    mocks.role = "owner";
    const res = await call(postAutopilotVersionPreview as Handler, routes[0][2]);
    expect(res.statusCode).toBe(202);
    expect(mocks.startVersionPreview).toHaveBeenCalledWith({ tenant_id: "tnt-1", conductor_run_id: SESSION });
  });

  it("a site version opens its stored build at once, without booting a sandbox preview", async () => {
    mocks.role = "owner";
    mocks.siteVersionPreview.mockResolvedValue({ kind: "live", url: "https://bike.zaviagent.com/__zavi_preview/d1/?t=x&zavi_embed=1", deploy_id: "d1", expires_at: "2026-10-02T14:00:00.000Z" });
    const res = await call(postAutopilotVersionPreview as Handler, routes[0][2]);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ status: "live", url: "https://bike.zaviagent.com/__zavi_preview/d1/?t=x&zavi_embed=1", expires_at: "2026-10-02T14:00:00.000Z", error: null });
    expect(mocks.siteVersionPreview).toHaveBeenCalledWith("tnt-1", SESSION);
    expect(mocks.startVersionPreview).not.toHaveBeenCalled();
  });

  it("a prewarm builds a site version ahead of the click and never boots the older builder's preview", async () => {
    mocks.role = "owner";
    const warm = { conductor_run_id: SESSION, prewarm: true };
    mocks.siteVersionPreview.mockResolvedValue({ kind: "starting" });
    let res = await call(postAutopilotVersionPreview as Handler, warm);
    expect(res.statusCode).toBe(202);
    expect(res.body).toEqual({ status: "starting" });
    expect(mocks.siteVersionPreview).toHaveBeenCalledWith("tnt-1", SESSION, undefined, { prewarm: true });
    for (const [answer, status] of [
      [{ kind: "not_site" }, "skipped"],
      [{ kind: "unavailable", error: "prewarm_skipped" }, "skipped"],
      [{ kind: "unavailable", error: "This version is too old to open." }, "dead"],
    ] as const) {
      mocks.siteVersionPreview.mockResolvedValue(answer);
      res = await call(postAutopilotVersionPreview as Handler, warm);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ status });
    }
    expect(mocks.startVersionPreview).not.toHaveBeenCalled();
  });

  it("a site version that is gone answers with the reason, never an old-flow sandbox boot", async () => {
    mocks.role = "owner";
    mocks.siteVersionPreview.mockResolvedValue({ kind: "unavailable", error: "This version is too old to open." });
    const res = await call(postAutopilotVersionPreview as Handler, routes[0][2]);
    expect(res.body).toEqual({ status: "dead", url: null, error: "This version is too old to open.", retryable: false });
    expect(mocks.startVersionPreview).not.toHaveBeenCalled();
  });

  it("an unpublished site version being built from its commit answers starting, never an old-flow sandbox boot", async () => {
    mocks.role = "owner";
    mocks.siteVersionPreview.mockResolvedValue({ kind: "starting" });
    const res = await call(postAutopilotVersionPreview as Handler, routes[0][2]);
    expect(res.statusCode).toBe(202);
    expect(res.body).toEqual({ status: "starting", url: null, error: null });
    expect(mocks.startVersionPreview).not.toHaveBeenCalled();
  });

  it("a site version with no commit is dead and not retryable; a failed build of one is retryable", async () => {
    mocks.role = "owner";
    mocks.siteVersionPreview.mockResolvedValue({ kind: "unavailable", error: "Zavi has no saved copy of this version's code, so it can't be shown." });
    expect((await call(postAutopilotVersionPreview as Handler, routes[0][2])).body).toMatchObject({ status: "dead", retryable: false });
    mocks.siteVersionPreview.mockResolvedValue({ kind: "unavailable", error: "Zavi couldn't open this version just now. Try again." });
    expect((await call(postAutopilotVersionPreview as Handler, routes[0][2])).body).toMatchObject({ status: "dead", retryable: true });
  });

  it("polling a site version being built reads its build job, not the old-flow job table", async () => {
    mocks.role = "owner";
    const live = { status: "live", url: "https://yoga.zaviagent.com/__zavi_preview/d1/?t=x&zavi_embed=1", expires_at: "2026-10-06T08:00:00.000Z", error: null, retryable: true };
    mocks.siteVersionJob.mockResolvedValue(live);
    const res = mockRes();
    await getAutopilotVersionPreview({ body: {}, query: { conductor_run_id: SESSION }, params: {} } as never, res as never);
    expect(res.body).toEqual(live);
    expect(mocks.siteVersionJob).toHaveBeenCalledWith("tnt-1", SESSION);
    expect(mocks.getVersionPreview).not.toHaveBeenCalled();
    mocks.siteVersionJob.mockResolvedValue(null);
    mocks.getVersionPreview.mockResolvedValue(null);
    const res2 = mockRes();
    await getAutopilotVersionPreview({ body: {}, query: { conductor_run_id: SESSION }, params: {} } as never, res2 as never);
    expect(res2.body).toEqual({ status: "none" });
    expect(mocks.getVersionPreview).toHaveBeenCalledWith({ tenant_id: "tnt-1", conductor_run_id: SESSION });
  });

  it("a member cannot mint a site version link", async () => {
    mocks.role = "member";
    await call(postAutopilotVersionPreview as Handler, routes[0][2]);
    expect(mocks.siteVersionPreview).not.toHaveBeenCalled();
  });

  it("an owner passes the role gate, then Publish is refused because the old-flow app is frozen", async () => {
    mocks.role = "owner";
    const res = await call(publishWebsiteEditsHandler as Handler, { app_id: "app.example.com" });
    expect(res.statusCode).toBe(409);
    expect(mocks.tenantWrites).not.toContainEqual({ table: "website_edits", op: "update" });
  });
});
