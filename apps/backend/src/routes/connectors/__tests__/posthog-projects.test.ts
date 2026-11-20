import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ tenant_id: "t1", user_id: "u1" })),
}));
vi.mock("@/services/tenant-client", () => ({ tenantRpc: vi.fn() }));
vi.mock("@/services/tenants/founder-activity-alert", () => ({ notifyFounderActivity: vi.fn() }));

import { posthogProjects } from "../posthog";

function mockRes() {
  const res: { statusCode?: number; body?: unknown; status: (c: number) => typeof res; json: (b: unknown) => typeof res } = {
    status(c) { res.statusCode = c; return res; },
    json(b) { res.body = b; return res; },
  };
  return res;
}

function stubFetch(routes: Record<string, { status: number; body: unknown }>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const hit = Object.entries(routes).find(([path]) => url.endsWith(path));
    const { status, body } = hit ? hit[1] : { status: 404, body: {} };
    return new Response(JSON.stringify(body), { status });
  }));
}

async function run() {
  const res = mockRes();
  await posthogProjects({ body: { api_key: "phx_0123456789abcdef", region: "us" } } as never, res as never);
  return res;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("posthogProjects", () => {
  it("accepts a key scoped Query Read + Project Read (no user:read)", async () => {
    stubFetch({
      "/api/users/@me/": { status: 403, body: { detail: "API key missing required scope 'user:read'" } },
      "/api/organizations/@current/projects/": { status: 200, body: { results: [{ id: 425215, name: "Default" }] } },
    });
    const res = await run();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ projects: [{ id: "425215", name: "Default" }] });
  });

  it("rejects a key PostHog says is invalid", async () => {
    stubFetch({ "/api/organizations/@current/projects/": { status: 401, body: {} } });
    const res = await run();
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe("posthog_key_invalid");
  });

  it("falls back to /users/@me/ teams when the org listing is unavailable", async () => {
    stubFetch({
      "/api/organizations/@current/projects/": { status: 403, body: {} },
      "/api/users/@me/": { status: 200, body: { teams: [{ id: 7, name: "App" }] } },
    });
    const res = await run();
    expect(res.body).toEqual({ projects: [{ id: "7", name: "App" }] });
  });

  it("reports missing Project Read scope instead of a bad key when both probes are refused", async () => {
    stubFetch({
      "/api/organizations/@current/projects/": { status: 403, body: {} },
      "/api/users/@me/": { status: 403, body: {} },
    });
    const res = await run();
    expect((res.body as { error: { code: string } }).error.code).toBe("posthog_no_projects");
  });
});
