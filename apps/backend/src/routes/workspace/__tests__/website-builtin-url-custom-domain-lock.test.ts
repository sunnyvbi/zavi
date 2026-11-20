
import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  rpc: vi.fn(),
  setSub: vi.fn(),
  clearSub: vi.fn(),
  status: vi.fn(),
  customDomains: { count: 0 as number | null, error: null as null | { code?: string; message: string } },
  domain: null as null | Record<string, unknown>,
}));

vi.mock("@/services/website/site-offline", () => ({ siteIsSuspended: async () => false }));
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
        maybeSingle: async () =>
          table === "tenant_resources" && kind === "domain" && mocks.domain
            ? { data: { external_ref: mocks.domain } }
            : { data: null },
        limit: async () => ({ data: [{ external_ref: { render_service_id: "srv-1", url: "https://x.onrender.com" } }] }),
        then: (resolve: (v: unknown) => unknown) =>
          resolve(table === "tenant_custom_domains" ? { ...mocks.customDomains, data: null } : { data: null, error: null }),
      };
      return b;
    },
    rpc: (...a: unknown[]) => mocks.rpc(...a),
  }),
}));
vi.mock("@/services/provisioning/builtin-url", async (orig) => {
  const actual = await orig<typeof import("@/services/provisioning/builtin-url")>();
  return { ...actual, setBuiltinSubdomain: mocks.setSub, clearBuiltinSubdomain: mocks.clearSub };
});
vi.mock("@/services/provisioning/render-custom-domain", () => ({
  getRenderCustomDomainStatus: (...a: unknown[]) => mocks.status(...a),
  verifyRenderCustomDomain: vi.fn(async () => undefined),
}));
vi.mock("@/services/provisioning/cloudflare-dns", () => ({
  BUILTIN_HOST_IN_USE: "that domain is already in use by another app",
  ensureDnsCname: vi.fn(async () => ({ record_id: null, skipped: true })),
}));

import { deleteBuiltinUrlHandler, getBuiltinUrlHandler, setBuiltinUrlHandler } from "../website-builtin-url";

function response() {
  let status = 200;
  let body: unknown;
  const res = {
    status: vi.fn((v: number) => { status = v; return res; }),
    json: vi.fn((v: unknown) => { body = v; return res; }),
  } as unknown as Response;
  return { res, result: () => ({ status, body: body as { error?: { code: string }; custom_domain_attached?: boolean } }) };
}
const rename = { body: { label: "new-name" }, headers: {} } as unknown as Request;
const reset = { headers: {} } as unknown as Request;

describe("built-in URL is locked while a custom domain is attached", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ tenant_id: "tenant-a", user_id: "user-a" });
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    mocks.status.mockResolvedValue("pending");
    mocks.clearSub.mockResolvedValue(undefined);
    mocks.setSub.mockImplementation(async (_s: string, _u: string, label: string) => ({
      hostname: `${label}.zaviagent.com`, label, custom_domain_id: `cd-${label}`, dns_record_id: "dns-1",
    }));
    mocks.domain = { hostname: "old-name.zaviagent.com", label: "old-name", custom_domain_id: "cd-old", status: "live" };
    mocks.customDomains = { count: 0, error: null };
  });

  it("rename 409s custom_domain_attached and touches nothing", async () => {
    mocks.customDomains = { count: 1, error: null };
    const { res, result } = response();
    await setBuiltinUrlHandler(rename, res);
    expect(result().status).toBe(409);
    expect(result().body.error?.code).toBe("custom_domain_attached");
    expect(mocks.setSub).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("reset 409s custom_domain_attached and touches nothing", async () => {
    mocks.customDomains = { count: 2, error: null };
    const { res, result } = response();
    await deleteBuiltinUrlHandler(reset, res);
    expect(result().status).toBe(409);
    expect(result().body.error?.code).toBe("custom_domain_attached");
    expect(mocks.clearSub).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("refuses (503) when the custom-domain check itself fails, rather than guessing", async () => {
    mocks.customDomains = { count: null, error: { code: "XX000", message: "boom" } };
    const { res, result } = response();
    await setBuiltinUrlHandler(rename, res);
    expect(result().status).toBe(503);
    expect(mocks.setSub).not.toHaveBeenCalled();
  });

  it("rename and reset go through without a custom domain", async () => {
    const r1 = response();
    await setBuiltinUrlHandler(rename, r1.res);
    expect(r1.result().status).toBe(200);
    expect(mocks.setSub).toHaveBeenCalledTimes(1);
    const r2 = response();
    await deleteBuiltinUrlHandler(reset, r2.res);
    expect(r2.result().status).toBe(200);
    expect(mocks.clearSub).toHaveBeenCalled();
  });

  it("setting the first address is never blocked (there is nothing to break)", async () => {
    mocks.domain = null;
    mocks.customDomains = { count: 1, error: null };
    const { res, result } = response();
    await setBuiltinUrlHandler(rename, res);
    expect(result().status).toBe(200);
  });

  it("GET tells the web the address is locked", async () => {
    mocks.customDomains = { count: 1, error: null };
    const { res, result } = response();
    await getBuiltinUrlHandler({ headers: {} } as unknown as Request, res);
    expect(result().body.custom_domain_attached).toBe(true);
  });
});
