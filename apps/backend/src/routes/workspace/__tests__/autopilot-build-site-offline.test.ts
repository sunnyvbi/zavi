import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  statusRun: vi.fn(),
  latestFresh: vi.fn(),
  sessionsList: vi.fn(),
  resources: vi.fn(),
  sandboxRow: vi.fn(),
  rpc: vi.fn(),
  kick: vi.fn(),
  selects: [] as string[],
  ownerKey: true,
  offlineKey: true,
  settingReads: [] as string[],
}));

vi.mock("@/services/settings", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/services/settings")>();
  return {
    ...real,
    getBoolSetting: async (key: string, tenantId?: string) => {
      mocks.settingReads.push(key);
      if (key === "build_auto_site_owner") return mocks.ownerKey;
      if (key === "build_site_offline_status") return mocks.offlineKey;
      return real.getBoolSetting(key as never, tenantId as never);
    },
  };
});

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/agents/conductor-driver", () => ({ kickSandboxPreview: mocks.kick }));

function chain(terminal: () => unknown) {
  const api: Record<string, unknown> = {};
  const self = () => api;
  for (const m of ["eq", "in", "or", "gte", "order", "not"]) api[m] = self;
  api.select = (cols: string) => {
    mocks.selects.push(String(cols));
    return api;
  };
  api.limit = () => terminal();
  api.maybeSingle = () => terminal();
  api.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(terminal()).then(resolve, reject);
  return api;
}

let conductorStep = 0;
let mode = "status" as "status" | "sessions";

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    from: (table: string) => {
      if (table === "conductor_runs") {
        return chain(() => {
          if (mode === "sessions") return mocks.sessionsList();
          conductorStep += 1;
          return conductorStep === 1 ? mocks.statusRun() : mocks.latestFresh();
        });
      }
      if (table === "agent_runs") return chain(() => ({ data: [], error: null }));
      if (table === "tenant_resources") return chain(() => mocks.resources());
      if (table === "autopilot_action_ledger") return chain(() => ({ data: [], error: null }));
      if (table === "tenant_credit_ledger") return chain(() => ({ data: [], error: null }));
      throw new Error(`unexpected table ${table}`);
    },
  }),
  serviceClient: () => ({
    from: (table: string) => {
      if (table === "tenant_sandbox") return chain(() => mocks.sandboxRow());
      return chain(() => ({ data: null, error: null }));
    },
    rpc: async (fn: string, args: unknown) => {
      mocks.rpc(fn, args);
      return { data: null, error: null };
    },
  }),
}));

import { getAutopilotBuildStatus } from "../autopilot";
import { __resetPublishPreviewKicks } from "@/services/build/app-ready";
import { clearSignupProbeCache } from "@/services/website/site-signup";
import { clearSiteOfflineCache, siteIsSuspended } from "@/services/website/site-offline";

const RUN = "11111111-1111-4111-8111-111111111111";
const HOSTING = "https://acme.onrender.com";
const fetched: string[] = [];
let signupStatus = 200;
let homeStatus = 200;
let homeBody = "<html><title>Acme</title></html>";
let homeThrows = false;
const SUSPENDED_PAGE = "<html><head><title>Service Suspended</title></head><body>This service has been suspended.</body></html>";

function run(status: string) {
  return {
    id: RUN,
    objective: "Build product: Acme — bookings",
    status,
    failure_class: null,
    paused_at: null,
    goal_graph: [
      { status: "done", payload: { stage: "build" } },
      { status: "done", payload: { stage: "deploy", deploy_enqueued_at: Date.parse("2026-09-29T10:00:00Z") } },
    ],
    spend_usd: 1,
    max_usd: 20,
    created_at: "2026-09-29T09:00:00Z",
    updated_at: "2026-09-29T10:00:00Z",
  };
}

async function call() {
  conductorStep = 0;
  let body: { target: { live_url: string | null; admin_url?: string | null; site_offline?: boolean } } | undefined;
  const res = {
    status: () => res,
    json: (b: typeof body) => {
      body = b;
      return res;
    },
  };
  await getAutopilotBuildStatus({ query: {} } as never, res as never);
  return body!;
}

beforeEach(() => {
  for (const k of ["requireAuth", "statusRun", "latestFresh", "resources", "sandboxRow", "rpc", "kick"] as const) mocks[k].mockReset();
  mocks.ownerKey = true;
  mocks.settingReads.length = 0;
  fetched.length = 0;
  signupStatus = 200;
  homeStatus = 200;
  homeBody = "<html><title>Acme</title></html>";
  homeThrows = false;
  mocks.offlineKey = true;
  clearSignupProbeCache();
  clearSiteOfflineCache();
  __resetPublishPreviewKicks();
  mocks.requireAuth.mockResolvedValue({ tenant_id: "tnt-1", user_id: "u-1", access_token: "tok" });
  mocks.statusRun.mockResolvedValue({ data: [run("done")], error: null });
  mocks.latestFresh.mockResolvedValue({ data: [{ id: RUN, status: "done", goal_graph: [], created_at: "2026-09-29T09:00:00Z" }], error: null });
  mocks.resources.mockResolvedValue({
    data: [
      { resource_kind: "repo", status: "ready", external_ref: { repo_url: "https://github.com/acme/app" } },
      { resource_kind: "hosting", status: "ready", external_ref: { url: HOSTING }, created_at: "2026-09-29T09:30:00Z" },
    ],
    error: null,
  });
  mocks.sandboxRow.mockResolvedValue({ data: null, error: null });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      fetched.push(String(url));
      if (String(url).endsWith("/signup")) return { status: signupStatus, text: async () => "<html></html>" };
      if (homeThrows) throw new Error("ECONNRESET");
      return { status: homeStatus, text: async () => homeBody };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /build-status stops saying Live for a suspended site (DEL-1323 B4)", () => {
  it("a site whose host answers 503 Service Suspended gets no live link, no admin link, and site_offline", async () => {
    homeStatus = 503;
    homeBody = SUSPENDED_PAGE;
    const body = await call();
    expect(body.target.live_url).toBeNull();
    expect(body.target.admin_url).toBeNull();
    expect(body.target.site_offline).toBe(true);
    expect(fetched).toContain(`${HOSTING}/`);
    expect(fetched.filter((u) => u.endsWith("/signup"))).toEqual([]);
  });

  it("a serving site keeps its live link and carries no offline flag", async () => {
    const body = await call();
    expect(body.target.live_url).toBe(HOSTING);
    expect(body.target.site_offline).toBeUndefined();
  });

  it("a 503 that is not a suspension (a deploy restart) is not called offline", async () => {
    homeStatus = 503;
    homeBody = "<html><body>upstream connect error</body></html>";
    const body = await call();
    expect(body.target.live_url).toBe(HOSTING);
    expect(body.target.site_offline).toBeUndefined();
  });

  it("a probe that throws keeps the stored status", async () => {
    homeThrows = true;
    const body = await call();
    expect(body.target.live_url).toBe(HOSTING);
    expect(body.target.site_offline).toBeUndefined();
  });

  it("a build that is not live never probes the home page", async () => {
    mocks.latestFresh.mockResolvedValue({ data: [{ id: RUN, status: "active", goal_graph: [], created_at: "2026-09-29T09:00:00Z" }], error: null });
    mocks.statusRun.mockResolvedValue({ data: [run("active")], error: null });
    homeStatus = 503;
    homeBody = SUSPENDED_PAGE;
    const body = await call();
    expect(body.target.live_url).toBeNull();
    expect(body.target.site_offline).toBeUndefined();
    expect(fetched).not.toContain(`${HOSTING}/`);
  });

  it("key off: the suspended site is still reported live exactly as before, with no home-page probe", async () => {
    mocks.offlineKey = false;
    homeStatus = 503;
    homeBody = SUSPENDED_PAGE;
    const body = await call();
    expect(body.target.live_url).toBe(HOSTING);
    expect(body.target.site_offline).toBeUndefined();
    expect(fetched).not.toContain(`${HOSTING}/`);
  });
});

describe("siteIsSuspended", () => {
  it("reads the suspension page once per minute per site", async () => {
    const f = vi.fn(async () => ({ status: 503, text: async () => SUSPENDED_PAGE }));
    expect(await siteIsSuspended("https://a.onrender.com/some/path", f as never)).toBe(true);
    expect(await siteIsSuspended("https://a.onrender.com", f as never)).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
    expect((f.mock.calls[0] as unknown[] | undefined)?.[0]).toBe("https://a.onrender.com/");
  });

  it("a garbage url is unknown, not offline", async () => {
    expect(await siteIsSuspended("not a url", vi.fn() as never)).toBeNull();
  });
});
