import type { Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Run = { status: string; failure_class?: string; refine?: boolean; site_id?: string; provisioned?: boolean };

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  keys: {} as Record<string, boolean>,
  domain: null as null | Record<string, unknown>,
  runs: [] as Run[],
  runsError: null as null | { message: string },
  renderStatus: "verified",
}));

vi.mock("@/services/settings", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/services/settings")>();
  return {
    ...real,
    getBoolSetting: async (key: string) => mocks.keys[key] ?? true,
  };
});
vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.auth }));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: async () => true }));
vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    from: (table: string) => {
      let kind = "";
      let nonRefine = false;
      let noSite = false;
      let selected = "";
      const runRows = (n: number) =>
        mocks.runs
          .filter((r) => !(nonRefine && r.refine))
          .filter((r) => !(noSite && r.site_id))
          .slice(0, n)
          .map((r) => ({
            status: r.status,
            failure_class: r.failure_class ?? null,
            objective: "Build product: Tutor",
            created_at: "2026-10-01T08:00:00Z",
            refine_mode: r.refine ? "true" : null,
            s0: null,
            s1: r.site_id ?? null,
            s2: null,
            ...(selected.includes("p0_stage:goal_graph->0->payload->>stage") && selected.includes("p0_status:goal_graph->0->>status")
              ? { p0_stage: r.provisioned ? "provision" : null, p0_status: r.provisioned ? "done" : null }
              : {}),
          }));
      const b: Record<string, unknown> = {
        select: (cols: string) => {
          selected = cols;
          return b;
        },
        eq: (col: string, val: string) => {
          if (col === "resource_kind") kind = val;
          return b;
        },
        or: (f: string) => {
          if (f.includes("refine_mode")) nonRefine = true;
          return b;
        },
        is: (col: string, val: unknown) => {
          if (col.endsWith("site_id") && val === null) noSite = true;
          return b;
        },
        order: () => b,
        maybeSingle: async () =>
          table === "tenant_resources" && kind === "domain" && mocks.domain ? { data: { external_ref: mocks.domain } } : { data: null },
        limit: async (n: number) =>
          table === "conductor_runs"
            ? mocks.runsError && noSite
              ? { data: null, error: mocks.runsError }
              : { data: runRows(n), error: null }
            : { data: [{ external_ref: { render_service_id: "srv-1", url: "https://x.onrender.com" } }] },
        then: (resolve: (v: unknown) => unknown) =>
          resolve(table === "tenant_resources" && kind === "db" ? { data: [], error: null } : { count: 0, data: null, error: null }),
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

const SITE = "6f1c2a7e-1b2c-4d3e-8f90-123456789abc";
const fetched: string[] = [];

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
  mocks.keys = {};
  mocks.runs = [];
  mocks.runsError = null;
  mocks.renderStatus = "verified";
  mocks.domain = {
    hostname: "apna-tutor-693dfbdb.zaviagent.com",
    label: "apna-tutor-693dfbdb",
    custom_domain_id: "cd-1",
    dns_record_id: "dns-1",
    status: "live",
  };
  fetched.length = 0;
  clearSiteOfflineCache();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      fetched.push(String(url));
      return { status: 200, text: async () => "<html>Coming soon. This site is being built.</html>" };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/website/builtin-url never calls the address Live before the build shipped", () => {
  it("QA 13:39: a ready, DNS-verified address while the first build is still running reads not_live, not live", async () => {
    mocks.runs = [{ status: "running" }];
    const body = await get();
    expect(body.builtin?.status).toBe("not_live");
    expect(body.builtin?.status).not.toBe("live");
    expect(fetched).toEqual([]);
  });

  it("a fresh rebuild in flight after a shipped build reads not_live, because it put the starter back", async () => {
    mocks.runs = [{ status: "running", provisioned: true }, { status: "done" }];
    expect((await get()).builtin?.status).toBe("not_live");
  });

  it("a failed fresh build reads not_live", async () => {
    mocks.runs = [{ status: "failed" }];
    expect((await get()).builtin?.status).toBe("not_live");
  });

  it("a refine running on a shipped build stays live", async () => {
    mocks.runs = [{ status: "running", refine: true }, { status: "done" }];
    expect((await get()).builtin?.status).toBe("live");
  });

  it("a new-flow site build in flight never takes the old app's address down", async () => {
    mocks.runs = [{ status: "running", site_id: SITE }, { status: "done" }];
    expect((await get()).builtin?.status).toBe("live");
  });

  it("a shipped build reads live and still gets the offline probe", async () => {
    mocks.runs = [{ status: "done" }];
    expect((await get()).builtin?.status).toBe("live");
    expect(fetched).toEqual(["https://apna-tutor-693dfbdb.zaviagent.com/"]);
  });

  it("DEL-1323 B1: a newer build that failed at provisioning leaves the shipped app live, as build-status says", async () => {
    mocks.runs = [{ status: "failed", failure_class: "provision_failed" }, { status: "done" }];
    expect((await get()).builtin?.status).toBe("live");
  });

  it("DEL-1323 B1: newer builds still provisioning or failed at provisioning leave the shipped app live", async () => {
    mocks.runs = [
      { status: "provisioning" },
      { status: "failed", failure_class: "provision_failed" },
      { status: "done" },
    ];
    expect((await get()).builtin?.status).toBe("live");
  });

  it("a newer build that failed after re-seeding put the starter back, so the address reads not_live", async () => {
    mocks.runs = [{ status: "failed", failure_class: "provision_failed" }, { status: "failed", failure_class: "build_failed", provisioned: true }, { status: "done" }];
    expect((await get()).builtin?.status).toBe("not_live");
  });

  it.each(["user_cancelled", "stale_reaped", "unknown"])(
    "a newer build stopped as %s before its provision step finished leaves the shipped app live",
    async (failure_class) => {
      mocks.runs = [{ status: "failed", failure_class }, { status: "done" }];
      expect((await get()).builtin?.status).toBe("live");
    },
  );

  it.each(["user_cancelled", "stale_reaped", "unknown"])(
    "a newer build stopped as %s after its provision step finished put the starter back, so the address reads not_live",
    async (failure_class) => {
      mocks.runs = [{ status: "failed", failure_class, provisioned: true }, { status: "done" }];
      expect((await get()).builtin?.status).toBe("not_live");
    },
  );

  it("a build read error keeps the stored status", async () => {
    mocks.runs = [{ status: "running" }];
    mocks.runsError = { message: "boom" };
    expect((await get()).builtin?.status).toBe("live");
  });

  it("an address still setting up keeps saying verifying", async () => {
    mocks.runs = [{ status: "running" }];
    mocks.renderStatus = "pending";
    mocks.domain = { ...mocks.domain, status: "verifying" };
    expect((await get()).builtin?.status).toBe("verifying");
  });

  it("key off: the running build's address reads live exactly as before", async () => {
    mocks.keys.build_domains_wait_for_build = false;
    mocks.runs = [{ status: "running" }];
    expect((await get()).builtin?.status).toBe("live");
  });
});
