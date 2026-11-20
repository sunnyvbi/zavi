import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ serviceClientMock: vi.fn() }));

vi.mock("@/services/agents/a2a-dispatch", () => ({ a2aDispatch: vi.fn() }));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));

import {
  BUILD_DEPLOY_GATE_MAX_WAIT_MS,
  UNPROVISIONED_BUILD_DEPLOY_GATE_MAX_WAIT_MS,
  buildDeployGateMaxWaitMs,
  readHostingStatus,
} from "../conductor-driver";
import type { ConductorNode } from "../conductor";

const APP_URL = "https://localpro-x.onrender.com";
const SERVICE_ID = "srv-localpro";
const REPO = "Praxis-build/localpro-x";
const OLD_SHA = "1111111111111111111111111111111111111111";
const BUILD_SHA = "2222222222222222222222222222222222222222";
const SEED_HTML =
  '<html><head><title>Your Company</title></head><body><h1>Your company app is live.</h1></body></html>';
const REAL_HTML =
  "<html><head><title>LocalPro</title></head><body><h1>Book trusted local service providers</h1></body></html>";

type Rows = { hosting: unknown[]; repo: unknown[] | "error" | "throw" };

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
          if (filters.resource_kind === "repo") {
            if (rows.repo === "throw") throw new Error("socket hang up");
            if (rows.repo === "error") return { data: null, error: { message: "boom" } };
            const repo = (rows.repo as Array<{ mode?: string }>).filter(
              (r) => filters.mode === undefined || r.mode === undefined || r.mode === filters.mode,
            );
            return { data: repo, error: null };
          }
          throw new Error(`unexpected resource_kind ${String(filters.resource_kind)}`);
        },
      };
      return chain;
    },
  }));
}

const READY_HOSTING = [
  { status: "ready", external_ref: { url: APP_URL, render_service_id: SERVICE_ID } },
];
const REPO_ROW = [{ external_ref: { github_full_name: REPO, default_branch: "trunk" } }];

type RenderReply = { status: string; commit: string } | "error" | "empty";

function stubWorld(opts: { head: string | null; render: RenderReply; body: string; bodyStatus?: number }) {
  const f = vi.fn(async (url: string) => {
    if (url.includes("api.github.com")) {
      if (opts.head === null) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ object: { sha: opts.head } }) };
    }
    if (url.includes("api.render.com")) {
      const render = opts.render;
      if (render === "error") return { ok: false, status: 500, json: async () => ({}) };
      if (render === "empty") return { ok: true, status: 200, json: async () => [] };
      return {
        ok: true,
        status: 200,
        json: async () => [
          { deploy: { status: render.status, commit: { id: render.commit } }, cursor: "c" },
        ],
      };
    }
    const status = opts.bodyStatus ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => opts.body };
  });
  vi.stubGlobal("fetch", f);
  return f;
}

function deployNode(enqueuedAt: number | null): ConductorNode {
  return {
    id: "deploy",
    status: "pending",
    target_agent_slug: "",
    estimate_usd: 0,
    child_run_id: null,
    payload:
      enqueuedAt === null ? { stage: "deploy" } : { stage: "deploy", deploy_enqueued_at: enqueuedAt },
  };
}

const minutesAgo = (m: number) => Date.now() - m * 60_000;

describe("first-build deploy gate requires Render to serve the build's final commit", () => {
  beforeEach(() => {
    mocks.serviceClientMock.mockReset();
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

  it("non-seed page served while Render still serves the previous commit → keeps waiting, not done", async () => {
    mockTenantResources({ hosting: READY_HOSTING, repo: REPO_ROW });
    const f = stubWorld({ head: BUILD_SHA, render: { status: "live", commit: OLD_SHA }, body: REAL_HTML });
    await expect(readHostingStatus("t", deployNode(minutesAgo(1)))).resolves.toBe("provisioning");
    const gh = f.mock.calls.map(([u]) => String(u)).find((u) => u.includes("api.github.com"));
    expect(gh).toContain(`/repos/${REPO}/git/ref/heads/trunk`);
    const render = f.mock.calls.map(([u]) => String(u)).find((u) => u.includes("api.render.com"));
    expect(render).toContain(`/v1/services/${SERVICE_ID}/deploys`);
  });

  it("non-seed page but Render is still building the final commit → keeps waiting", async () => {
    mockTenantResources({ hosting: READY_HOSTING, repo: REPO_ROW });
    stubWorld({ head: BUILD_SHA, render: { status: "build_in_progress", commit: BUILD_SHA }, body: REAL_HTML });
    await expect(readHostingStatus("t", deployNode(minutesAgo(1)))).resolves.toBe("provisioning");
  });

  it("Render live on the final commit and page is non-seed → ready", async () => {
    mockTenantResources({ hosting: READY_HOSTING, repo: REPO_ROW });
    stubWorld({ head: BUILD_SHA, render: { status: "live", commit: BUILD_SHA.slice(0, 7) }, body: REAL_HTML });
    await expect(readHostingStatus("t", deployNode(minutesAgo(1)))).resolves.toBe("ready");
  });

  it("Render live on the final commit but page still shows the seed → content check still applies (waits)", async () => {
    mockTenantResources({ hosting: READY_HOSTING, repo: REPO_ROW });
    stubWorld({ head: BUILD_SHA, render: { status: "live", commit: BUILD_SHA }, body: SEED_HTML });
    await expect(readHostingStatus("t", deployNode(minutesAgo(1)))).resolves.toBe("provisioning");
  });

  it("Render failed to build the final commit → failed immediately, even with a non-seed page up", async () => {
    mockTenantResources({ hosting: READY_HOSTING, repo: REPO_ROW });
    stubWorld({ head: BUILD_SHA, render: { status: "build_failed", commit: BUILD_SHA }, body: REAL_HTML });
    await expect(readHostingStatus("t", deployNode(minutesAgo(1)))).resolves.toBe("failed");
  });

  it("final commit still not served past the bound → failed", async () => {
    mockTenantResources({ hosting: READY_HOSTING, repo: REPO_ROW });
    stubWorld({ head: BUILD_SHA, render: { status: "live", commit: OLD_SHA }, body: REAL_HTML });
    const stale = Date.now() - BUILD_DEPLOY_GATE_MAX_WAIT_MS - 60_000;
    await expect(readHostingStatus("t", deployNode(stale))).resolves.toBe("failed");
  });

  it("replays a slow deploy: 8 minutes in it still waits, then the tick after Render goes live reports ready", async () => {
    mockTenantResources({ hosting: READY_HOSTING, repo: REPO_ROW });
    stubWorld({ head: BUILD_SHA, render: { status: "build_in_progress", commit: BUILD_SHA }, body: SEED_HTML });
    await expect(readHostingStatus("t", deployNode(minutesAgo(8)))).resolves.toBe("provisioning");
    stubWorld({ head: BUILD_SHA, render: { status: "live", commit: BUILD_SHA }, body: REAL_HTML });
    await expect(readHostingStatus("t", deployNode(minutesAgo(9)))).resolves.toBe("ready");
  });

  it("Render API errors → keeps waiting inside the bound instead of trusting any non-seed page", async () => {
    mockTenantResources({ hosting: READY_HOSTING, repo: REPO_ROW });
    stubWorld({ head: BUILD_SHA, render: "error", body: REAL_HTML });
    await expect(readHostingStatus("t", deployNode(minutesAgo(1)))).resolves.toBe("provisioning");
  });

  it("Render still unreadable past the bound → falls back to the content check (non-seed = ready)", async () => {
    mockTenantResources({ hosting: READY_HOSTING, repo: REPO_ROW });
    stubWorld({ head: BUILD_SHA, render: "error", body: REAL_HTML });
    const stale = Date.now() - BUILD_DEPLOY_GATE_MAX_WAIT_MS - 60_000;
    await expect(readHostingStatus("t", deployNode(stale))).resolves.toBe("ready");
  });

  it("HEAD unreadable → waits inside the bound, and Render is never asked", async () => {
    mockTenantResources({ hosting: READY_HOSTING, repo: REPO_ROW });
    const f = stubWorld({ head: null, render: { status: "live", commit: OLD_SHA }, body: REAL_HTML });
    await expect(readHostingStatus("t", deployNode(minutesAgo(1)))).resolves.toBe("provisioning");
    expect(f.mock.calls.some(([u]) => String(u).includes("api.render.com"))).toBe(false);
  });

  it.each(["error", "throw"] as const)("repo row read %s → waits inside the bound, never crashes the tick", async (mode) => {
    mockTenantResources({ hosting: READY_HOSTING, repo: mode });
    const f = stubWorld({ head: BUILD_SHA, render: { status: "live", commit: OLD_SHA }, body: REAL_HTML });
    await expect(readHostingStatus("t", deployNode(minutesAgo(1)))).resolves.toBe("provisioning");
    expect(f.mock.calls.some(([u]) => String(u).includes("api.github.com"))).toBe(false);
  });

  it("no RENDER_API_KEY → no GitHub or Render calls, content check as before", async () => {
    delete process.env.RENDER_API_KEY;
    mockTenantResources({ hosting: READY_HOSTING, repo: REPO_ROW });
    const f = stubWorld({ head: BUILD_SHA, render: { status: "live", commit: OLD_SHA }, body: REAL_HTML });
    await expect(readHostingStatus("t", deployNode(minutesAgo(1)))).resolves.toBe("ready");
    expect(f.mock.calls.map(([u]) => String(u))).toEqual([APP_URL]);
  });

  it("pending with no deploy clock stamped → falls back to the content check instead of waiting unbounded", async () => {
    mockTenantResources({ hosting: READY_HOSTING, repo: REPO_ROW });
    stubWorld({ head: BUILD_SHA, render: { status: "live", commit: OLD_SHA }, body: REAL_HTML });
    await expect(readHostingStatus("t", deployNode(null))).resolves.toBe("ready");
  });

  it("Render failure beats the kill-switch: BUILD_DEPLOY_CONTENT_VERIFY=0 still fails a broken final deploy", async () => {
    process.env.BUILD_DEPLOY_CONTENT_VERIFY = "0";
    mockTenantResources({ hosting: READY_HOSTING, repo: REPO_ROW });
    stubWorld({ head: BUILD_SHA, render: { status: "build_failed", commit: BUILD_SHA }, body: REAL_HTML });
    await expect(readHostingStatus("t", deployNode(minutesAgo(1)))).resolves.toBe("failed");
  });
});

describe("first-build deploy bound", () => {
  beforeEach(() => {
    mocks.serviceClientMock.mockReset();
    delete process.env.BUILD_DEPLOY_CONTENT_VERIFY;
    delete process.env.BUILD_DEPLOY_GATE_MAX_WAIT_MS;
    delete process.env.RENDER_API_KEY;
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    delete process.env.BUILD_DEPLOY_GATE_MAX_WAIT_MS;
    vi.unstubAllGlobals();
  });

  it("defaults to 15 minutes", () => {
    expect(BUILD_DEPLOY_GATE_MAX_WAIT_MS).toBe(15 * 60 * 1000);
    expect(buildDeployGateMaxWaitMs()).toBe(15 * 60 * 1000);
  });

  it("a seed still served 10 minutes after the gate was reached keeps waiting instead of failing and retrying", async () => {
    mockTenantResources({ hosting: READY_HOSTING, repo: REPO_ROW });
    stubWorld({ head: BUILD_SHA, render: "empty", body: SEED_HTML });
    await expect(readHostingStatus("t", deployNode(minutesAgo(10)))).resolves.toBe("provisioning");
  });

  it("a seed still served 16 minutes after the gate was reached fails", async () => {
    mockTenantResources({ hosting: READY_HOSTING, repo: REPO_ROW });
    stubWorld({ head: BUILD_SHA, render: "empty", body: SEED_HTML });
    await expect(readHostingStatus("t", deployNode(minutesAgo(16)))).resolves.toBe("failed");
  });

  it("the env override still wins", async () => {
    process.env.BUILD_DEPLOY_GATE_MAX_WAIT_MS = String(5 * 60 * 1000);
    mockTenantResources({ hosting: READY_HOSTING, repo: REPO_ROW });
    stubWorld({ head: BUILD_SHA, render: "empty", body: SEED_HTML });
    await expect(readHostingStatus("t", deployNode(minutesAgo(10)))).resolves.toBe("failed");
  });
});

describe("build deploy gate for a target that is not a provisioned repo (user_repo / connected)", () => {
  const CONNECTED_ROW = [{ mode: "connected", external_ref: { github_full_name: "alice/cool-app", default_branch: "main" } }];
  const HOSTING_STATUS = (status: string) => [{ status, external_ref: { url: APP_URL, render_service_id: SERVICE_ID } }];
  const external = (f: ReturnType<typeof stubWorld>) =>
    f.mock.calls.map(([u]) => String(u)).filter((u) => u.includes("api.github.com") || u.includes("api.render.com"));

  beforeEach(() => {
    mocks.serviceClientMock.mockReset();
    delete process.env.BUILD_DEPLOY_CONTENT_VERIFY;
    delete process.env.BUILD_DEPLOY_GATE_MAX_WAIT_MS;
    process.env.GITHUB_PROVISION_TOKEN = "ghp_test_token";
    process.env.RENDER_API_KEY = "rnd_test_token";
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    delete process.env.RENDER_API_KEY;
    delete process.env.GITHUB_PROVISION_TOKEN;
    delete process.env.BUILD_DEPLOY_GATE_MAX_WAIT_MS;
    vi.unstubAllGlobals();
  });

  it.each([
    ["connected repo row", CONNECTED_ROW],
    ["no repo row", []],
  ])("%s with RENDER_API_KEY set: a real app is ready on the first tick, no Render commit wait", async (_label, repo) => {
    mockTenantResources({ hosting: READY_HOSTING, repo });
    const f = stubWorld({ head: BUILD_SHA, render: { status: "live", commit: OLD_SHA }, body: REAL_HTML });
    await expect(readHostingStatus("t", deployNode(minutesAgo(1)))).resolves.toBe("ready");
    expect(external(f)).toEqual([]);
    expect(f.mock.calls.map(([u]) => String(u))).toEqual([APP_URL]);
  });

  it("connected repo: a seed page still waits inside the pre-live-edit 6 minute bound", async () => {
    mockTenantResources({ hosting: READY_HOSTING, repo: CONNECTED_ROW });
    stubWorld({ head: BUILD_SHA, render: "error", body: SEED_HTML });
    await expect(readHostingStatus("t", deployNode(minutesAgo(5)))).resolves.toBe("provisioning");
  });

  it("the unprovisioned bound is the pre-live-edit 6 minutes", () => {
    expect(UNPROVISIONED_BUILD_DEPLOY_GATE_MAX_WAIT_MS).toBe(6 * 60 * 1000);
  });

  it("connected repo: a seed page 7 minutes in fails instead of holding the build slot for 15", async () => {
    mockTenantResources({ hosting: READY_HOSTING, repo: CONNECTED_ROW });
    const f = stubWorld({ head: BUILD_SHA, render: "error", body: SEED_HTML });
    await expect(readHostingStatus("t", deployNode(minutesAgo(7)))).resolves.toBe("failed");
    expect(external(f)).toEqual([]);
  });

  it("connected repo: an unreachable app 7 minutes in fails", async () => {
    mockTenantResources({ hosting: READY_HOSTING, repo: CONNECTED_ROW });
    stubWorld({ head: BUILD_SHA, render: "error", body: "", bodyStatus: 502 });
    await expect(readHostingStatus("t", deployNode(minutesAgo(7)))).resolves.toBe("failed");
  });

  it("connected repo: hosting stuck non-ready 7 minutes in fails", async () => {
    mockTenantResources({ hosting: HOSTING_STATUS("deploying"), repo: CONNECTED_ROW });
    stubWorld({ head: BUILD_SHA, render: "error", body: REAL_HTML });
    await expect(readHostingStatus("t", deployNode(minutesAgo(7)))).resolves.toBe("failed");
  });

  it("the same 7 minute seed on a provisioned repo still waits under the 15 minute bound", async () => {
    mockTenantResources({ hosting: READY_HOSTING, repo: [{ mode: "provisioned", ...REPO_ROW[0] }] });
    stubWorld({ head: BUILD_SHA, render: "error", body: SEED_HTML });
    await expect(readHostingStatus("t", deployNode(minutesAgo(7)))).resolves.toBe("provisioning");
  });

  it("the env override still wins for a connected repo", async () => {
    process.env.BUILD_DEPLOY_GATE_MAX_WAIT_MS = String(10 * 60 * 1000);
    mockTenantResources({ hosting: READY_HOSTING, repo: CONNECTED_ROW });
    stubWorld({ head: BUILD_SHA, render: "error", body: SEED_HTML });
    await expect(readHostingStatus("t", deployNode(minutesAgo(7)))).resolves.toBe("provisioning");
  });
});
