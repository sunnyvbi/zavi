import type { Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  offlineKey: true,
  renderStatus: "verified",
  domain: null as null | Record<string, unknown>,
  dbRows: [] as Array<Record<string, unknown>>,
  builds: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/services/settings", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/services/settings")>();
  return {
    ...real,
    getBoolSetting: async (key: string, tenantId?: string) =>
      key === "build_site_offline_status" ? mocks.offlineKey : real.getBoolSetting(key as never, tenantId as never),
  };
});
vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.auth }));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: async () => true }));
vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    from: (table: string) => {
      let kind = "";
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (col: string, val: string) => {
          if (col === "resource_kind") kind = val;
          return b;
        },
        order: () => b,
        or: () => b,
        is: () => b,
        maybeSingle: async () =>
          table === "tenant_resources" && kind === "domain" && mocks.domain ? { data: { external_ref: mocks.domain } } : { data: null },
        limit: async () =>
          table === "conductor_runs"
            ? { data: mocks.builds }
            : { data: [{ external_ref: { render_service_id: "srv-1", url: "https://x.onrender.com" } }] },
        then: (resolve: (v: unknown) => unknown) =>
          resolve(table === "tenant_resources" && kind === "db" ? { data: mocks.dbRows, error: null } : { count: 0, data: null, error: null }),
      };
      return b;
    },
    rpc: vi.fn(async () => ({ data: null, error: null })),
  }),
}));
vi.mock("@/services/provisioning/render-custom-domain", () => ({
  getRenderCustomDomainStatus: vi.fn(async () => mocks.renderStatus),
  verifyRenderCustomDomain: vi.fn(async () => undefined),
}));
vi.mock("@/services/provisioning/cloudflare-dns", () => ({
  BUILTIN_HOST_IN_USE: "that domain is already in use by another app",
  ensureDnsCname: vi.fn(async () => ({ record_id: null, skipped: true })),
}));

import { getBuiltinUrlHandler } from "../website-builtin-url";
import { clearSiteOfflineCache } from "@/services/website/site-offline";

const SUSPENDED_PAGE = "<html><head><title>Service Suspended</title></head><body>This service has been suspended.</body></html>";
const fetched: string[] = [];
let home = { status: 200, body: "<html>wedding</html>" };

async function get() {
  let body: { builtin: { status: string; url: string } | null } | undefined;
  const res = {
    status: vi.fn(() => res),
    json: vi.fn((v: typeof body) => {
      body = v;
      return res;
    }),
  } as unknown as Response;
  await getBuiltinUrlHandler({ headers: {} } as unknown as Request, res);
  return body!;
}

beforeEach(() => {
  mocks.auth.mockResolvedValue({ tenant_id: "tenant-a", user_id: "user-a" });
  mocks.offlineKey = true;
  mocks.renderStatus = "verified";
  mocks.dbRows = [];
  mocks.builds = [];
  mocks.domain = {
    hostname: "create-a-wedding-website-7f3f7cd1.zaviagent.com",
    label: "create-a-wedding-website-7f3f7cd1",
    custom_domain_id: "cd-1",
    dns_record_id: "dns-1",
    status: "live",
  };
  home = { status: 200, body: "<html>wedding</html>" };
  fetched.length = 0;
  clearSiteOfflineCache();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      fetched.push(String(url));
      return { status: home.status, text: async () => home.body };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/website/builtin-url never calls a suspended site Live (DEL-1323 B4)", () => {
  it("the ticket's wedding site, suspended on the host, shows offline, not live", async () => {
    home = { status: 503, body: SUSPENDED_PAGE };
    const body = await get();
    expect(body.builtin?.status).toBe("offline");
    expect(fetched).toEqual(["https://create-a-wedding-website-7f3f7cd1.zaviagent.com/"]);
  });

  it("a serving site stays live", async () => {
    expect((await get()).builtin?.status).toBe("live");
  });

  it("an address still being set up is never probed", async () => {
    mocks.renderStatus = "pending";
    mocks.domain = { ...mocks.domain, status: "verifying" };
    home = { status: 503, body: SUSPENDED_PAGE };
    const body = await get();
    expect(body.builtin?.status).toBe("verifying");
    expect(fetched.filter((u) => u.endsWith(".zaviagent.com/"))).toEqual([]);
  });

  it("key off: the suspended site reads live exactly as before and nothing is fetched", async () => {
    mocks.offlineKey = false;
    home = { status: 503, body: SUSPENDED_PAGE };
    const body = await get();
    expect(body.builtin?.status).toBe("live");
    expect(fetched).toEqual([]);
  });
});

describe("GET /api/website/builtin-url never calls a reclaimed build Live (DEL-1323 B21)", () => {
  const reclaim = (reclaimedAt: string) => {
    mocks.dbRows = [{ resource_kind: "db", status: "torn_down", updated_at: reclaimedAt }];
    mocks.builds = [{ objective: "Build product: Wedding", status: "done", created_at: "2026-09-20T00:00:00Z", refine_mode: null }];
  };

  it("a live address whose build database was reclaimed reads retired, is never probed, and is not blocked", async () => {
    reclaim("2026-09-25T00:00:00Z");
    const body = await get();
    expect(body.builtin?.status).toBe("retired");
    expect((body.builtin as Record<string, unknown>).setup_blocked).toBeUndefined();
    expect(fetched).toEqual([]);
  });

  it("a database reclaimed before a newer build still reads live", async () => {
    reclaim("2026-09-10T00:00:00Z");
    expect((await get()).builtin?.status).toBe("live");
  });

  it("a reclaimed database with no build on record at all reads retired", async () => {
    mocks.dbRows = [{ resource_kind: "db", status: "teardown", updated_at: "2026-09-25T00:00:00Z" }];
    expect((await get()).builtin?.status).toBe("retired");
  });
});
