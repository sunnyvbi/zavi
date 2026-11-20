import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ serviceClientMock: vi.fn() }));

vi.mock("@/services/agents/a2a-dispatch", () => ({ a2aDispatch: vi.fn() }));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));
vi.mock("@/services/hosting/static-publish", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/hosting/static-publish")>()),
  readStaticState: vi.fn(async () => null),
}));

import { FAILED_HOSTING_REPROBE_INTERVAL_MS, readHostingStatus, resetFailedHostingProbeBackoff } from "../conductor-driver";
import type { ConductorNode } from "../conductor";

const TENANT = "t-stale";
const APP_URL = "https://localpro-x.onrender.com";
const SERVICE_ID = "srv-localpro";
const REPO = "Praxis-build/localpro-x";
const PRE_SHA = "1111111111111111111111111111111111111111";
const NEW_SHA = "2222222222222222222222222222222222222222";
const REAL_HTML =
  "<html><head><title>LocalPro</title></head><body><h1>Book trusted local service providers</h1></body></html>";
const THREE_HOURS_AGO = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

type HostingRow = { status: string; external_ref: Record<string, unknown>; updated_at: string };

function installDb(initial: HostingRow) {
  const hosting: HostingRow = { ...initial, external_ref: { ...initial.external_ref } };
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  mocks.serviceClientMock.mockImplementation(() => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (fn === "set_tenant_resource" && args.p_resource_kind === "hosting" && args.p_tenant_id === TENANT) {
        hosting.status = String(args.p_status);
        hosting.external_ref = args.p_external_ref as Record<string, unknown>;
        hosting.updated_at = new Date().toISOString();
      }
      return { data: null, error: null };
    },
    from: (table: string) => {
      expect(table).toBe("tenant_resources");
      const filters: Record<string, unknown> = {};
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return chain;
        },
        order: () => chain,
        limit: async () => {
          if (filters.resource_kind === "hosting") {
            if (filters.status !== undefined && filters.status !== hosting.status) return { data: [], error: null };
            return { data: [{ ...hosting, external_ref: { ...hosting.external_ref } }], error: null };
          }
          if (filters.resource_kind === "repo") {
            return { data: [{ external_ref: { github_full_name: REPO, default_branch: "main" } }], error: null };
          }
          throw new Error(`unexpected resource_kind ${String(filters.resource_kind)}`);
        },
      };
      return chain;
    },
  }));
  return { hosting, rpcCalls };
}

function stubWorld(opts: { serviceGet: "ok" | "error"; appStatus: number; head: string; deployCommit: string }) {
  const f = vi.fn(async (url: string): Promise<unknown> => {
    if (url.includes("api.github.com")) {
      return { ok: true, status: 200, json: async () => ({ object: { sha: opts.head } }) };
    }
    if (url.includes("api.render.com")) {
      if (url.includes("/deploys")) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ deploy: { status: "live", commit: { id: opts.deployCommit } }, cursor: "c" }],
        };
      }
      if (opts.serviceGet === "error") {
        return { ok: false, status: 500, json: async () => ({}), text: async () => "render down" };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: SERVICE_ID, serviceDetails: { url: APP_URL } }),
        text: async () => "",
      };
    }
    const status = opts.appStatus;
    return { ok: status >= 200 && status < 300, status, text: async () => REAL_HTML };
  });
  vi.stubGlobal("fetch", f);
  return f;
}

function buildDeployNode(): ConductorNode {
  return {
    id: "deploy",
    status: "pending",
    target_agent_slug: "",
    estimate_usd: 0,
    child_run_id: null,
    payload: { stage: "deploy", deploy_enqueued_at: Date.now() - 60_000 },
  };
}

function refineDeployNode(): ConductorNode {
  return {
    id: "deploy",
    status: "pending",
    target_agent_slug: "",
    estimate_usd: 0,
    child_run_id: null,
    payload: {
      stage: "deploy",
      target: { github_full_name: REPO, default_branch: "main" },
      refine_deploy_enqueued_at: Date.now() - 60_000,
      pre_refine_sha: PRE_SHA,
    },
  };
}

const STALE_FAILED: HostingRow = {
  status: "failed",
  external_ref: { url: APP_URL, render_service_id: SERVICE_ID },
  updated_at: THREE_HOURS_AGO,
};

describe("deploy gate on a hosting row that failed long ago while the site is live now", () => {
  beforeEach(() => {
    mocks.serviceClientMock.mockReset();
    resetFailedHostingProbeBackoff();
    delete process.env.BUILD_DEPLOY_CONTENT_VERIFY;
    delete process.env.BUILD_DEPLOY_GATE_MAX_WAIT_MS;
    process.env.GITHUB_PROVISION_TOKEN = "ghp_test_token";
    process.env.RENDER_API_KEY = "rnd_test_token";
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.RENDER_API_KEY;
    delete process.env.GITHUB_PROVISION_TOKEN;
    vi.unstubAllGlobals();
  });

  it("a Continue on a build whose row failed 3h ago reports ready and flips the row back to ready", async () => {
    const db = installDb(STALE_FAILED);
    stubWorld({ serviceGet: "ok", appStatus: 200, head: NEW_SHA, deployCommit: NEW_SHA });
    await expect(readHostingStatus(TENANT, buildDeployNode())).resolves.toBe("ready");
    const writes = db.rpcCalls.filter((c) => c.fn === "set_tenant_resource");
    expect(writes).toHaveLength(1);
    expect(writes[0].args).toMatchObject({
      p_tenant_id: TENANT,
      p_resource_kind: "hosting",
      p_status: "ready",
      p_external_ref: { url: APP_URL, render_service_id: SERVICE_ID, recovered_from_failed: true },
    });
    expect(db.hosting.status).toBe("ready");
  });

  it("a refine whose commit landed and is live reports ready instead of deploy failed", async () => {
    const db = installDb(STALE_FAILED);
    stubWorld({ serviceGet: "ok", appStatus: 200, head: NEW_SHA, deployCommit: NEW_SHA });
    await expect(readHostingStatus(TENANT, refineDeployNode())).resolves.toBe("ready");
    expect(db.hosting.status).toBe("ready");
  });

  it("the site really is down → still failed, and the row is not written", async () => {
    const db = installDb(STALE_FAILED);
    stubWorld({ serviceGet: "ok", appStatus: 503, head: NEW_SHA, deployCommit: NEW_SHA });
    await expect(readHostingStatus(TENANT, buildDeployNode())).resolves.toBe("failed");
    await expect(readHostingStatus(TENANT, refineDeployNode())).resolves.toBe("failed");
    expect(db.rpcCalls).toHaveLength(0);
    expect(db.hosting.status).toBe("failed");
  });

  it("Render errors on the service read → failed, no write, no crash", async () => {
    const db = installDb(STALE_FAILED);
    stubWorld({ serviceGet: "error", appStatus: 200, head: NEW_SHA, deployCommit: NEW_SHA });
    await expect(readHostingStatus(TENANT, buildDeployNode())).resolves.toBe("failed");
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("recovered but Render serves an older commit than the refine → the refine commit check still applies", async () => {
    installDb(STALE_FAILED);
    stubWorld({ serviceGet: "ok", appStatus: 200, head: NEW_SHA, deployCommit: PRE_SHA });
    await expect(readHostingStatus(TENANT, refineDeployNode())).resolves.toBe("provisioning");
  });

  it("no RENDER_API_KEY → failed without touching Render or the row", async () => {
    delete process.env.RENDER_API_KEY;
    const db = installDb(STALE_FAILED);
    const f = stubWorld({ serviceGet: "ok", appStatus: 200, head: NEW_SHA, deployCommit: NEW_SHA });
    await expect(readHostingStatus(TENANT, buildDeployNode())).resolves.toBe("failed");
    expect(f.mock.calls.some(([u]) => String(u).includes("api.render.com"))).toBe(false);
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("a row that failed ten minutes ago stays failed even though Render still serves the previous deploy", async () => {
    const db = installDb({ ...STALE_FAILED, updated_at: new Date(Date.now() - 10 * 60 * 1000).toISOString() });
    const f = stubWorld({ serviceGet: "ok", appStatus: 200, head: NEW_SHA, deployCommit: NEW_SHA });
    await expect(readHostingStatus(TENANT, buildDeployNode())).resolves.toBe("failed");
    await expect(readHostingStatus(TENANT, refineDeployNode())).resolves.toBe("failed");
    expect(f.mock.calls.some(([u]) => String(u).includes("api.render.com"))).toBe(false);
    expect(db.rpcCalls).toHaveLength(0);
    expect(db.hosting.status).toBe("failed");
  });

  it("the hour is the line: 59 minutes is not re-probed, 61 minutes is", async () => {
    const young = installDb({ ...STALE_FAILED, updated_at: new Date(Date.now() - 59 * 60 * 1000).toISOString() });
    stubWorld({ serviceGet: "ok", appStatus: 200, head: NEW_SHA, deployCommit: NEW_SHA });
    await expect(readHostingStatus(TENANT, buildDeployNode())).resolves.toBe("failed");
    expect(young.rpcCalls).toHaveLength(0);

    const old = installDb({ ...STALE_FAILED, updated_at: new Date(Date.now() - 61 * 60 * 1000).toISOString() });
    await expect(readHostingStatus(TENANT, buildDeployNode())).resolves.toBe("ready");
    expect(old.hosting.status).toBe("ready");
  });

  it("a failed row with no readable timestamp is not re-probed", async () => {
    const db = installDb({ ...STALE_FAILED, updated_at: "not-a-date" });
    const f = stubWorld({ serviceGet: "ok", appStatus: 200, head: NEW_SHA, deployCommit: NEW_SHA });
    await expect(readHostingStatus(TENANT, buildDeployNode())).resolves.toBe("failed");
    expect(f.mock.calls.some(([u]) => String(u).includes("api.render.com"))).toBe(false);
    expect(db.rpcCalls).toHaveLength(0);
  });
  it("a failed row whose site stays down is re-probed at most once per backoff interval", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const db = installDb(STALE_FAILED);
    let appStatus = 503;
    const f = vi.fn(async (url: string): Promise<unknown> => {
      if (url.includes("api.github.com")) {
        return { ok: true, status: 200, json: async () => ({ object: { sha: NEW_SHA } }) };
      }
      if (url.includes("api.render.com") && url.includes("/deploys")) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ deploy: { status: "live", commit: { id: NEW_SHA } }, cursor: "c" }],
        };
      }
      if (url.includes("api.render.com")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: SERVICE_ID, serviceDetails: { url: APP_URL } }),
          text: async () => "",
        };
      }
      return { ok: appStatus < 300, status: appStatus, text: async () => REAL_HTML };
    });
    vi.stubGlobal("fetch", f);
    const renderCalls = () =>
      f.mock.calls.filter(([u]) => String(u).includes("api.render.com") && !String(u).includes("/deploys")).length;
    const appCalls = () => f.mock.calls.filter(([u]) => String(u).startsWith(APP_URL)).length;

    for (let tick = 0; tick < 6; tick++) {
      vi.setSystemTime(t0 + tick * 2 * 60 * 1000);
      await expect(readHostingStatus(TENANT, buildDeployNode())).resolves.toBe("failed");
    }
    expect(renderCalls()).toBe(1);
    expect(appCalls()).toBeGreaterThan(0);
    const appAfterFirst = appCalls();
    expect(db.rpcCalls).toHaveLength(0);
    expect(db.hosting.updated_at).toBe(THREE_HOURS_AGO);

    vi.setSystemTime(t0 + FAILED_HOSTING_REPROBE_INTERVAL_MS - 1000);
    await expect(readHostingStatus(TENANT, buildDeployNode())).resolves.toBe("failed");
    expect(renderCalls()).toBe(1);
    expect(appCalls()).toBe(appAfterFirst);

    appStatus = 200;
    vi.setSystemTime(t0 + FAILED_HOSTING_REPROBE_INTERVAL_MS + 1000);
    await expect(readHostingStatus(TENANT, buildDeployNode())).resolves.toBe("ready");
    expect(renderCalls()).toBe(2);
    expect(db.hosting.status).toBe("ready");
  });
});
