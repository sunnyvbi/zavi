import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  rpc: vi.fn(),
  svcRpc: vi.fn(),
  attach: vi.fn(),
  detach: vi.fn(),
  hosting: null as null | { render_service_id: string; url: string },
  domain: null as null | Record<string, unknown>,
  existing: null as null | Record<string, unknown>,
}));

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
        maybeSingle: async () => {
          if (table === "tenant_resources" && kind === "domain") {
            return { data: mocks.domain ? { external_ref: mocks.domain } : null, error: null };
          }
          if (table === "tenant_custom_domains") return { data: mocks.existing, error: null };
          return { data: null, error: null };
        },
        limit: async () => ({ data: mocks.hosting ? [{ external_ref: mocks.hosting }] : [], error: null }),
        then: (resolve: (v: unknown) => void) => resolve({ count: 0, data: null, error: null }),
      };
      return b;
    },
    rpc: (...a: unknown[]) => mocks.rpc(...a),
  }),
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: (...a: unknown[]) => mocks.svcRpc(...a),
  setCustomDomainVerifyState: vi.fn(),
}));
vi.mock("@/services/provisioning/render-custom-domain", async (orig) => {
  const actual = await orig<typeof import("@/services/provisioning/render-custom-domain")>();
  return {
    ...actual,
    attachRenderCustomDomain: (...a: unknown[]) => mocks.attach(...a),
    detachRenderCustomDomain: (...a: unknown[]) => mocks.detach(...a),
    verifyRenderCustomDomain: vi.fn(),
    getRenderCustomDomainStatus: vi.fn(),
  };
});

import { addCustomDomainHandler } from "../website-custom-domains";

function response() {
  let status = 200;
  let body: unknown;
  const res = {
    status: vi.fn((v: number) => { status = v; return res; }),
    json: vi.fn((v: unknown) => { body = v; return res; }),
  } as unknown as Response;
  return { res, result: () => ({ status, body: body as Record<string, unknown> }) };
}

function reqFor(hostname: string): Request {
  return { body: { hostname }, headers: {} } as unknown as Request;
}

describe("POST /api/website/custom-domains — DNS instructions never expose the hosting provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ tenant_id: "tenant-a", user_id: "user-a" });
    mocks.rpc.mockResolvedValue({ data: "dom-1", error: null });
    mocks.svcRpc.mockResolvedValue({ data: "dom-1", error: null });
    mocks.attach.mockResolvedValue({ custom_domain_id: "cd-1" });
    mocks.hosting = { render_service_id: "srv-1", url: "https://upcarai-6ec4d609.onrender.com" };
    mocks.domain = { hostname: "upcar-ai.zaviagent.com", label: "upcar-ai", status: "live" };
    mocks.existing = null;
  });

  it("re-adding an already verified domain stays idempotent even when the app has no Zavi address", async () => {
    mocks.domain = null;
    mocks.existing = { id: "dom-1", tenant_id: "tenant-a", status: "verified", hostname: "app.acme.com", domain_type: "subdomain", dns_records: [] };
    const { res, result } = response();
    await addCustomDomainHandler(reqFor("app.acme.com"), res);
    expect(result().status).toBe(200);
    expect(mocks.attach).not.toHaveBeenCalled();
  });

  it("subdomain: the CNAME points at the tenant's Zavi address, not the Render host", async () => {
    const { res, result } = response();
    await addCustomDomainHandler(reqFor("app.acme.com"), res);
    expect(result().status).toBe(200);
    const records = (result().body.domain as { dns_records: Array<{ type: string; value: string }> }).dns_records;
    expect(records).toEqual([{ type: "CNAME", host: "app.acme.com", value: "upcar-ai.zaviagent.com" }]);
    expect(JSON.stringify(result().body)).not.toContain("onrender");
    const persisted = mocks.svcRpc.mock.calls[0][2] as { p_dns_records: unknown };
    expect(JSON.stringify(persisted.p_dns_records)).not.toContain("onrender");
  });

  it("apex: the ALIAS alternative points at the Zavi address, the A record at the edge IP", async () => {
    const { res, result } = response();
    await addCustomDomainHandler(reqFor("acme.com"), res);
    const records = (result().body.domain as { dns_records: Array<{ type: string; value: string }> }).dns_records;
    expect(records.find((r) => r.type === "ALIAS")).toMatchObject({ value: "upcar-ai.zaviagent.com" });
    expect(JSON.stringify(records)).not.toContain("onrender");
  });

  it("refuses with publish_first before attaching anything when the app has no Zavi address yet", async () => {
    mocks.domain = null;
    const { res, result } = response();
    await addCustomDomainHandler(reqFor("app.acme.com"), res);
    expect(result().status).toBe(409);
    expect((result().body.error as { code: string }).code).toBe("publish_first");
    expect(mocks.attach).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.svcRpc).not.toHaveBeenCalled();
  });

  it("writes the Render custom domain id through the tenant-pinned service rpc, never the caller's JWT client", async () => {
    const { res, result } = response();
    await addCustomDomainHandler(reqFor("app.acme.com"), res);
    expect(result().status).toBe(200);
    expect(mocks.svcRpc).toHaveBeenCalledTimes(1);
    expect(mocks.svcRpc).toHaveBeenCalledWith("tenant-a", "set_tenant_custom_domain", expect.objectContaining({
      p_render_service_id: "srv-1",
      p_hostname: "app.acme.com",
      p_render_custom_domain_id: "cd-1",
      p_status: "dns_required",
    }));
    expect((mocks.svcRpc.mock.calls[0][2] as Record<string, unknown>).p_tenant_id).toBeUndefined();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rolls back the Render attach when the service write returns no id (domain taken)", async () => {
    mocks.svcRpc.mockResolvedValue({ data: null, error: null });
    const { res, result } = response();
    await addCustomDomainHandler(reqFor("app.acme.com"), res);
    expect(result().status).toBe(409);
    expect(mocks.detach).toHaveBeenCalledWith("srv-1", "cd-1");
  });

  it("a domain row with an empty hostname counts as no address", async () => {
    mocks.domain = { hostname: "  " };
    const { res, result } = response();
    await addCustomDomainHandler(reqFor("app.acme.com"), res);
    expect(result().status).toBe(409);
    expect(mocks.attach).not.toHaveBeenCalled();
  });
});
