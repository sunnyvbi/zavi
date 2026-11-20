import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  serviceClientMock: vi.fn(),
  readStaticState: vi.fn(),
  isStaticEligible: vi.fn(),
}));

vi.mock("@/services/agents/a2a-dispatch", () => ({ a2aDispatch: vi.fn() }));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));
vi.mock("@/services/hosting/static-publish", async (importOriginal) => ({
  staticRoutingActive: (await importOriginal<typeof import("@/services/hosting/static-publish")>()).staticRoutingActive,
  readStaticState: mocks.readStaticState,
  isStaticEligible: mocks.isStaticEligible,
}));

import { readHostingStatus, staticPublishPlan } from "../conductor-driver";
import type { ConductorNode } from "../conductor";

const APP_URL = "https://localpro-x.onrender.com";
const REPO = "Praxis-build/localpro-x";
const OLD_SHA = "1111111111111111111111111111111111111111";
const BUILD_SHA = "2222222222222222222222222222222222222222";
const REAL_HTML = "<html><body><h1>Book trusted local service providers</h1></body></html>";

type Rows = { hosting: unknown[]; db?: unknown[] | "error" };

function mockTenantResources(rows: Rows) {
  mocks.serviceClientMock.mockImplementation(() => ({
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
          if (filters.resource_kind === "hosting") return { data: rows.hosting, error: null };
          if (filters.resource_kind === "repo")
            return { data: [{ external_ref: { github_full_name: REPO, default_branch: "trunk" } }], error: null };
          if (filters.resource_kind === "db") {
            if (rows.db === "error") return { data: null, error: { message: "boom" } };
            return { data: rows.db ?? [], error: null };
          }
          throw new Error(`unexpected resource_kind ${String(filters.resource_kind)}`);
        },
      };
      return chain;
    },
  }));
}

const READY_HOSTING = [{ status: "ready", external_ref: { url: APP_URL, render_service_id: "srv" } }];
const BUILDING_HOSTING = [{ status: "provisioning", external_ref: { url: APP_URL, render_service_id: "srv" } }];

function stubWorld(opts: { head: string | null; render: { status: string; commit: string }; body: string }) {
  const f = vi.fn(async (url: string) => {
    if (url.includes("api.github.com")) {
      if (opts.head === null) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ object: { sha: opts.head } }) };
    }
    if (url.includes("api.render.com")) {
      return {
        ok: true,
        status: 200,
        json: async () => [{ deploy: { status: opts.render.status, commit: { id: opts.render.commit } }, cursor: "c" }],
      };
    }
    return { ok: true, status: 200, text: async () => opts.body };
  });
  vi.stubGlobal("fetch", f);
  return f;
}

const hosts = (f: { mock: { calls: unknown[][] } }) => f.mock.calls.map(([u]) => new URL(String(u)).host);

function deployNode(enqueuedAt: number, requested?: string, pre_refine_sha?: string): ConductorNode {
  return {
    id: "deploy",
    status: "pending",
    target_agent_slug: "",
    estimate_usd: 0,
    child_run_id: null,
    payload: {
      stage: "deploy",
      deploy_enqueued_at: enqueuedAt,
      ...(requested ? { static_publish_requested_sha: requested } : {}),
      ...(pre_refine_sha
        ? {
            pre_refine_sha,
            refine_deploy_enqueued_at: enqueuedAt,
            target: { github_full_name: REPO, default_branch: "trunk" },
          }
        : {}),
    },
  };
}

const HOST = "localpro-x.zaviagent.com";
const ROUTING = { dns: [], created_dns_id: "dns-new", route: null, created_route_id: "route-new" };
const routed = (status: string, sha: string) => ({ ...state(status, sha), hostname: HOST, routing_previous: ROUTING });

const minutesAgo = (m: number) => Date.now() - m * 60_000;
const state = (status: string, sha: string) => ({ status, sha, deploy_id: "dep-1", at: "2026-09-29T00:00:00.000Z" });

beforeEach(() => {
  mocks.serviceClientMock.mockReset();
  mocks.readStaticState.mockReset();
  mocks.isStaticEligible.mockReset();
  delete process.env.BUILD_DEPLOY_CONTENT_VERIFY;
  delete process.env.BUILD_DEPLOY_GATE_MAX_WAIT_MS;
  process.env.GITHUB_PROVISION_TOKEN = "ghp_test_token";
  process.env.RENDER_API_KEY = "rnd_test_token";
  vi.unstubAllGlobals();
});

afterEach(() => {
  delete process.env.RENDER_API_KEY;
  delete process.env.GITHUB_PROVISION_TOKEN;
  vi.unstubAllGlobals();
});

describe("build deploy gate with static publish", () => {
  it("static live on the pushed sha → ready on the first read, no Render or app probe, even with the Render row still building", async () => {
    mockTenantResources({ hosting: BUILDING_HOSTING });
    mocks.readStaticState.mockResolvedValue(state("live", BUILD_SHA));
    const f = stubWorld({ head: BUILD_SHA, render: { status: "build_in_progress", commit: BUILD_SHA }, body: REAL_HTML });
    await expect(readHostingStatus("t", deployNode(minutesAgo(1), BUILD_SHA))).resolves.toBe("ready");
    expect(hosts(f)).toEqual(["api.github.com"]);
    expect(mocks.readStaticState).toHaveBeenCalledWith("t");
  });

  it("no static request on the node and the host not routed to static → the Render path runs unchanged", async () => {
    mockTenantResources({ hosting: READY_HOSTING });
    mocks.readStaticState.mockResolvedValue(state("live", BUILD_SHA));
    const f = stubWorld({ head: BUILD_SHA, render: { status: "live", commit: OLD_SHA }, body: REAL_HTML });
    await expect(readHostingStatus("t", deployNode(minutesAgo(1)))).resolves.toBe("provisioning");
    expect(hosts(f)).toEqual(["api.github.com", "api.render.com"]);
  });

  it("static live for an older sha → Render path (waits on Render)", async () => {
    mockTenantResources({ hosting: READY_HOSTING });
    mocks.readStaticState.mockResolvedValue(state("live", OLD_SHA));
    const f = stubWorld({ head: BUILD_SHA, render: { status: "live", commit: OLD_SHA }, body: REAL_HTML });
    await expect(readHostingStatus("t", deployNode(minutesAgo(1), OLD_SHA))).resolves.toBe("provisioning");
    expect(hosts(f)).toContain("api.render.com");
  });

  it("static failed → Render path; Render serving the build → ready through the content probe", async () => {
    mockTenantResources({ hosting: READY_HOSTING });
    mocks.readStaticState.mockResolvedValue({ ...state("failed", BUILD_SHA), error: "build: next build exited 1" });
    const f = stubWorld({ head: BUILD_SHA, render: { status: "live", commit: BUILD_SHA }, body: REAL_HTML });
    await expect(readHostingStatus("t", deployNode(minutesAgo(1), BUILD_SHA))).resolves.toBe("ready");
    expect(hosts(f)).toContain("api.render.com");
    expect(hosts(f)).toContain("localpro-x.onrender.com");
  });

  it("static failed with Render not serving past the bound → the existing failure", async () => {
    mockTenantResources({ hosting: READY_HOSTING });
    mocks.readStaticState.mockResolvedValue(state("failed", BUILD_SHA));
    stubWorld({ head: BUILD_SHA, render: { status: "live", commit: OLD_SHA }, body: REAL_HTML });
    await expect(readHostingStatus("t", deployNode(minutesAgo(20), BUILD_SHA))).resolves.toBe("failed");
  });

  it("publishing within the bound but Render already serving the build → ready (Render wins)", async () => {
    mockTenantResources({ hosting: READY_HOSTING });
    mocks.readStaticState.mockResolvedValue(state("publishing", BUILD_SHA));
    const f = stubWorld({ head: BUILD_SHA, render: { status: "live", commit: BUILD_SHA }, body: REAL_HTML });
    await expect(readHostingStatus("t", deployNode(minutesAgo(3), BUILD_SHA))).resolves.toBe("ready");
    expect(hosts(f)).toContain("api.render.com");
  });

  it("publishing within the bound and Render still on the old commit → provisioning", async () => {
    mockTenantResources({ hosting: READY_HOSTING });
    mocks.readStaticState.mockResolvedValue(state("publishing", BUILD_SHA));
    stubWorld({ head: BUILD_SHA, render: { status: "live", commit: OLD_SHA }, body: REAL_HTML });
    await expect(readHostingStatus("t", deployNode(minutesAgo(3), BUILD_SHA))).resolves.toBe("provisioning");
  });

  it("publishing within the bound while the Render row failed → keeps waiting on the static publish", async () => {
    mockTenantResources({ hosting: [{ status: "failed", external_ref: { url: APP_URL } }] });
    mocks.readStaticState.mockResolvedValue(state("publishing", BUILD_SHA));
    stubWorld({ head: BUILD_SHA, render: { status: "live", commit: OLD_SHA }, body: REAL_HTML });
    await expect(readHostingStatus("t", deployNode(minutesAgo(3), BUILD_SHA))).resolves.toBe("provisioning");
  });

  it("rolled_back → Render path", async () => {
    mockTenantResources({ hosting: BUILDING_HOSTING });
    mocks.readStaticState.mockResolvedValue(state("rolled_back", BUILD_SHA));
    stubWorld({ head: BUILD_SHA, render: { status: "live", commit: BUILD_SHA }, body: REAL_HTML });
    await expect(readHostingStatus("t", deployNode(minutesAgo(1), BUILD_SHA))).resolves.toBe("provisioning");
  });

  it("publishing past the bound with Render not serving → the existing failure", async () => {
    mockTenantResources({ hosting: BUILDING_HOSTING });
    mocks.readStaticState.mockResolvedValue(state("publishing", BUILD_SHA));
    stubWorld({ head: BUILD_SHA, render: { status: "build_in_progress", commit: BUILD_SHA }, body: REAL_HTML });
    await expect(readHostingStatus("t", deployNode(minutesAgo(16), BUILD_SHA))).resolves.toBe("failed");
  });

  it("static state read throws → Render path, never a crash", async () => {
    mockTenantResources({ hosting: READY_HOSTING });
    mocks.readStaticState.mockRejectedValue(new Error("db down"));
    stubWorld({ head: BUILD_SHA, render: { status: "live", commit: BUILD_SHA }, body: REAL_HTML });
    await expect(readHostingStatus("t", deployNode(minutesAgo(1), BUILD_SHA))).resolves.toBe("ready");
  });

  it("HEAD unreadable → Render path, never trusts a live state blind", async () => {
    mockTenantResources({ hosting: BUILDING_HOSTING });
    mocks.readStaticState.mockResolvedValue(state("live", BUILD_SHA));
    stubWorld({ head: null, render: { status: "live", commit: BUILD_SHA }, body: REAL_HTML });
    await expect(readHostingStatus("t", deployNode(minutesAgo(1), BUILD_SHA))).resolves.toBe("provisioning");
  });
});

describe("deploy gate while the host is routed to the static worker", () => {
  it("refine after static live: Render serving the new commit is not enough, ready only once static serves it", async () => {
    mockTenantResources({ hosting: READY_HOSTING });
    mocks.readStaticState.mockResolvedValue(routed("live", OLD_SHA));
    const f = stubWorld({ head: BUILD_SHA, render: { status: "live", commit: BUILD_SHA }, body: REAL_HTML });
    const node = deployNode(minutesAgo(2), BUILD_SHA, OLD_SHA);
    await expect(readHostingStatus("t", node)).resolves.toBe("provisioning");
    mocks.readStaticState.mockResolvedValue(routed("publishing", BUILD_SHA));
    await expect(readHostingStatus("t", node)).resolves.toBe("provisioning");
    mocks.readStaticState.mockResolvedValue(routed("live", BUILD_SHA));
    f.mockClear();
    await expect(readHostingStatus("t", node)).resolves.toBe("ready");
    expect(hosts(f)).toEqual(["api.github.com"]);
  });

  it("refine whose commit has not reached main yet waits even though static is live on that head", async () => {
    mockTenantResources({ hosting: READY_HOSTING });
    mocks.readStaticState.mockResolvedValue(routed("live", OLD_SHA));
    stubWorld({ head: OLD_SHA, render: { status: "live", commit: OLD_SHA }, body: REAL_HTML });
    await expect(readHostingStatus("t", deployNode(minutesAgo(2), undefined, OLD_SHA))).resolves.toBe("provisioning");
  });

  it("routed host with no request recorded on the node still uses the static truth, never Render", async () => {
    mockTenantResources({ hosting: READY_HOSTING });
    mocks.readStaticState.mockResolvedValue(routed("live", OLD_SHA));
    stubWorld({ head: BUILD_SHA, render: { status: "live", commit: BUILD_SHA }, body: REAL_HTML });
    await expect(readHostingStatus("t", deployNode(minutesAgo(2), undefined, OLD_SHA))).resolves.toBe("provisioning");
  });

  it("routed and still behind past the refine bound → failed, the host never went ready on stale content", async () => {
    mockTenantResources({ hosting: READY_HOSTING });
    mocks.readStaticState.mockResolvedValue(routed("publishing", BUILD_SHA));
    stubWorld({ head: BUILD_SHA, render: { status: "live", commit: BUILD_SHA }, body: REAL_HTML });
    await expect(readHostingStatus("t", deployNode(minutesAgo(30), BUILD_SHA, OLD_SHA))).resolves.toBe("failed");
  });

  it("routed with the publish failed on the head (rollback also failed) → failed", async () => {
    mockTenantResources({ hosting: READY_HOSTING });
    mocks.readStaticState.mockResolvedValue(routed("failed", BUILD_SHA));
    stubWorld({ head: BUILD_SHA, render: { status: "live", commit: BUILD_SHA }, body: REAL_HTML });
    await expect(readHostingStatus("t", deployNode(minutesAgo(1), BUILD_SHA, OLD_SHA))).resolves.toBe("failed");
  });

  it("build path: routed publishing on the head waits even when Render already serves it", async () => {
    mockTenantResources({ hosting: READY_HOSTING });
    mocks.readStaticState.mockResolvedValue(routed("publishing", BUILD_SHA));
    stubWorld({ head: BUILD_SHA, render: { status: "live", commit: BUILD_SHA }, body: REAL_HTML });
    await expect(readHostingStatus("t", deployNode(minutesAgo(3), BUILD_SHA))).resolves.toBe("provisioning");
  });

  it("rolled back host → the Render refine gate decides again", async () => {
    mockTenantResources({ hosting: READY_HOSTING });
    mocks.readStaticState.mockResolvedValue({ ...routed("rolled_back", OLD_SHA) });
    stubWorld({ head: BUILD_SHA, render: { status: "live", commit: BUILD_SHA }, body: REAL_HTML });
    await expect(readHostingStatus("t", deployNode(minutesAgo(2), BUILD_SHA, OLD_SHA))).resolves.toBe("ready");
  });
});

describe("staticPublishPlan", () => {
  it("refine on a tenant not routed to static → none, eligibility never asked", async () => {
    mockTenantResources({ hosting: READY_HOSTING });
    mocks.readStaticState.mockResolvedValue(state("failed", OLD_SHA));
    await expect(staticPublishPlan({ tenant_id: "t", refine: true })).resolves.toEqual({ action: "none" });
    expect(mocks.isStaticEligible).not.toHaveBeenCalled();
  });

  it("refine on a routed tenant → publish the new head", async () => {
    mockTenantResources({ hosting: READY_HOSTING });
    mocks.readStaticState.mockResolvedValue(routed("live", OLD_SHA));
    mocks.isStaticEligible.mockResolvedValue({ eligible: true });
    stubWorld({ head: BUILD_SHA, render: { status: "live", commit: BUILD_SHA }, body: REAL_HTML });
    await expect(staticPublishPlan({ tenant_id: "t", refine: true })).resolves.toEqual({ action: "publish", sha: BUILD_SHA });
  });

  it("a database added while routed → rollback", async () => {
    mockTenantResources({ hosting: READY_HOSTING, db: [{ id: "db-1" }] });
    mocks.readStaticState.mockResolvedValue(routed("live", OLD_SHA));
    mocks.isStaticEligible.mockImplementation(async (i: { hasDatabase: boolean }) =>
      i.hasDatabase ? { eligible: false, reason: "has_database" } : { eligible: true },
    );
    await expect(staticPublishPlan({ tenant_id: "t", refine: true })).resolves.toEqual({ action: "rollback" });
  });

  it("flag off while routed → rollback; flag off and not routed → none", async () => {
    mockTenantResources({ hosting: READY_HOSTING });
    mocks.isStaticEligible.mockResolvedValue({ eligible: false, reason: "flag_off" });
    mocks.readStaticState.mockResolvedValue(routed("live", OLD_SHA));
    await expect(staticPublishPlan({ tenant_id: "t", refine: false })).resolves.toEqual({ action: "rollback" });
    mocks.readStaticState.mockResolvedValue(routed("rolled_back", OLD_SHA));
    await expect(staticPublishPlan({ tenant_id: "t", refine: false })).resolves.toEqual({ action: "none" });
  });
});

describe("staticPublishPlan for a fresh build", () => {
  it("flag off / not configured → null and no GitHub read", async () => {
    mockTenantResources({ hosting: READY_HOSTING });
    mocks.isStaticEligible.mockResolvedValue({ eligible: false, reason: "flag_off" });
    const f = stubWorld({ head: BUILD_SHA, render: { status: "live", commit: BUILD_SHA }, body: REAL_HTML });
    await expect(staticPublishPlan({ tenant_id: "t", refine: false })).resolves.toEqual({ action: "none" });
    expect(f).not.toHaveBeenCalled();
  });

  it("passes hasDatabase from the tenant's db row", async () => {
    mockTenantResources({ hosting: READY_HOSTING, db: [{ id: "db-1" }] });
    mocks.isStaticEligible.mockResolvedValue({ eligible: false, reason: "database" });
    stubWorld({ head: BUILD_SHA, render: { status: "live", commit: BUILD_SHA }, body: REAL_HTML });
    await expect(staticPublishPlan({ tenant_id: "t", refine: false })).resolves.toEqual({ action: "none" });
    expect(mocks.isStaticEligible).toHaveBeenCalledWith({ tenant_id: "t", hasDatabase: true });
  });

  it("db read error → null without asking eligibility", async () => {
    mockTenantResources({ hosting: READY_HOSTING, db: "error" });
    await expect(staticPublishPlan({ tenant_id: "t", refine: false })).resolves.toEqual({ action: "none" });
    expect(mocks.isStaticEligible).not.toHaveBeenCalled();
  });

  it("eligible → the provisioned repo's HEAD sha", async () => {
    mockTenantResources({ hosting: READY_HOSTING });
    mocks.isStaticEligible.mockResolvedValue({ eligible: true });
    stubWorld({ head: BUILD_SHA, render: { status: "live", commit: BUILD_SHA }, body: REAL_HTML });
    await expect(staticPublishPlan({ tenant_id: "t", refine: false })).resolves.toEqual({ action: "publish", sha: BUILD_SHA });
    expect(mocks.isStaticEligible).toHaveBeenCalledWith({ tenant_id: "t", hasDatabase: false });
  });
});
