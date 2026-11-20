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
  announceKey: true,
  settingReads: [] as string[],
}));

vi.mock("@/services/settings", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/services/settings")>();
  return {
    ...real,
    getBoolSetting: async (key: string, tenantId?: string) => {
      mocks.settingReads.push(key);
      if (key === "build_auto_site_owner") return mocks.ownerKey;
      if (key === "build_live_announcement") return mocks.announceKey;
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
import { clearSiteOfflineCache } from "@/services/website/site-offline";

const RUN = "11111111-1111-4111-8111-111111111111";
const HOSTING = "https://acme.onrender.com";
const fetched: string[] = [];
let signupStatus = 200;
let homeSuspended = false;

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
  let body: { target: { live_url: string | null; admin_url?: string | null; live_announce?: boolean; live_announce_url?: string | null; site_offline?: boolean } } | undefined;
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
  mocks.announceKey = true;
  homeSuspended = false;
  clearSiteOfflineCache();
  mocks.settingReads.length = 0;
  fetched.length = 0;
  signupStatus = 200;
  clearSignupProbeCache();
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
      if (homeSuspended && !String(url).endsWith("/signup")) {
        return { status: 503, text: async () => "<title>Service Suspended</title>This service has been suspended." };
      }
      const status = String(url).endsWith("/signup") ? signupStatus : 200;
      return { status, text: async () => "<html></html>" };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /build-status live_announce (DEL-1323 B20, Q12 live moment)", () => {
  it("a live site tells the ready card to announce its address", async () => {
    const body = await call();
    expect(body.target.live_url).toBe(HOSTING);
    expect(body.target.live_announce).toBe(true);
    expect(body.target.live_announce_url).toBe(HOSTING);
    expect(mocks.settingReads).toContain("build_live_announcement");
  });

  function withBuiltin(status: string) {
    mocks.resources.mockResolvedValue({
      data: [
        { resource_kind: "repo", status: "ready", external_ref: { repo_url: "https://github.com/acme/app" } },
        { resource_kind: "hosting", status: "ready", external_ref: { url: HOSTING }, created_at: "2026-09-29T09:30:00Z" },
        { resource_kind: "domain", status: "ready", external_ref: { hostname: "acme.zaviagent.com", status } },
      ],
      error: null,
    });
  }

  it("a live built-in address is what the card and toast announce, not the Render host", async () => {
    withBuiltin("live");
    const body = await call();
    expect(body.target.live_url).toBe(HOSTING);
    expect(body.target.live_announce_url).toBe("https://acme.zaviagent.com");
  });

  it("a built-in address still verifying falls back to the Render host", async () => {
    withBuiltin("verifying");
    const body = await call();
    expect(body.target.live_announce_url).toBe(HOSTING);
  });

  it("a build that is not live yet never announces", async () => {
    mocks.latestFresh.mockResolvedValue({ data: [{ id: RUN, status: "active", goal_graph: [], created_at: "2026-09-29T09:00:00Z" }], error: null });
    mocks.statusRun.mockResolvedValue({ data: [run("active")], error: null });
    const body = await call();
    expect(body.target.live_url).toBeNull();
    expect(body.target.live_announce).toBeUndefined();
  });

  it("a suspended site is never announced as live", async () => {
    homeSuspended = true;
    const body = await call();
    expect(body.target.site_offline).toBe(true);
    expect(body.target.live_url).toBeNull();
    expect(body.target.live_announce).toBeUndefined();
  });

  it("key off: the target carries no announce flag, exactly as before", async () => {
    mocks.announceKey = false;
    const body = await call();
    expect(body.target.live_url).toBe(HOSTING);
    expect(body.target).not.toHaveProperty("live_announce");
    expect(body.target).not.toHaveProperty("live_announce_url");
  });

  it("key off with a live built-in address: live_url stays the Render host, nothing announced", async () => {
    mocks.announceKey = false;
    withBuiltin("live");
    const body = await call();
    expect(body.target.live_url).toBe(HOSTING);
    expect(body.target).not.toHaveProperty("live_announce_url");
  });
});
