import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  setSub: vi.fn(),
  clearSub: vi.fn(),
  status: vi.fn(),
  saveError: null as null | { code?: string; message: string },
  domain: null as null | Record<string, unknown>,
  saves: [] as Array<Record<string, unknown>>,
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
          await new Promise((r) => setTimeout(r, 1));
          return table === "tenant_resources" && kind === "domain" && mocks.domain
            ? { data: { external_ref: { ...mocks.domain } } }
            : { data: null };
        },
        limit: async () => ({ data: [{ external_ref: { render_service_id: "srv-1", url: "https://x.onrender.com" } }] }),
        then: (resolve: (v: unknown) => unknown) => resolve({ count: 0, error: null, data: null }),
      };
      return b;
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      await new Promise((r) => setTimeout(r, 1));
      if (name !== "set_tenant_builtin_domain") return { data: null, error: null };
      if (mocks.saveError) return { data: null, error: mocks.saveError };
      const ref = args.p_external_ref as Record<string, unknown>;
      mocks.saves.push(ref);
      mocks.domain = Object.keys(ref).length ? ref : null;
      return { data: null, error: null };
    },
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

vi.mock("@/services/settings", () => ({ getBoolSetting: vi.fn(async () => false) }));
vi.mock("@/services/website/site-offline", () => ({ siteIsSuspended: vi.fn(async () => false) }));

import { deleteBuiltinUrlHandler, getBuiltinUrlHandler, setBuiltinUrlHandler } from "../website-builtin-url";

function response() {
  let status = 200;
  let body: unknown;
  const res = {
    status: vi.fn((v: number) => { status = v; return res; }),
    json: vi.fn((v: unknown) => { body = v; return res; }),
  } as unknown as Response;
  return { res, result: () => ({ status, body: body as { error?: { code: string } } }) };
}

const rename = (label: string) => ({ body: { label }, headers: {} }) as unknown as Request;
const reset = { headers: {} } as unknown as Request;

function attachedAfterAll(): string[] {
  const attached = mocks.setSub.mock.calls.map(([, , label]) => `${label}.zaviagent.com`);
  const cleared = mocks.clearSub.mock.calls.map(([, ref]) => (ref as { hostname: string }).hostname);
  const seeded = ["alpha.zaviagent.com"];
  const live = new Set([...seeded, ...attached]);
  for (const h of cleared) live.delete(h);
  return [...live].sort();
}

describe("built-in URL rename races and same-label re-save", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ tenant_id: "tenant-a", user_id: "user-a" });
    mocks.status.mockResolvedValue("pending");
    mocks.saveError = null;
    mocks.saves = [];
    mocks.clearSub.mockResolvedValue(undefined);
    mocks.setSub.mockImplementation(async (_s: string, _u: string, label: string) => {
      await new Promise((r) => setTimeout(r, 5));
      return { hostname: `${label}.zaviagent.com`, label, custom_domain_id: `cd-${label}`, dns_record_id: "dns-1" };
    });
    mocks.domain = { hostname: "alpha.zaviagent.com", label: "alpha", custom_domain_id: "cd-alpha", status: "live" };
  });

  it("two quick renames leave exactly the stored hostname attached and nothing orphaned", async () => {
    const r1 = response();
    const r2 = response();
    await Promise.all([setBuiltinUrlHandler(rename("beta"), r1.res), setBuiltinUrlHandler(rename("gamma"), r2.res)]);
    expect(r1.result().status).toBe(200);
    expect(r2.result().status).toBe(200);
    const stored = mocks.domain?.hostname as string;
    expect(stored).toBe("gamma.zaviagent.com");
    expect(attachedAfterAll()).toEqual([stored]);
    const clearedHosts = mocks.clearSub.mock.calls.map(([, ref]) => (ref as { hostname: string }).hostname).sort();
    expect(clearedHosts).toEqual(["alpha.zaviagent.com", "beta.zaviagent.com"]);
  });

  it("a rename racing a reset never strands the renamed hostname", async () => {
    const r1 = response();
    const r2 = response();
    await Promise.all([setBuiltinUrlHandler(rename("beta"), r1.res), deleteBuiltinUrlHandler(reset, r2.res)]);
    expect(r1.result().status).toBe(200);
    expect(r2.result().status).toBe(200);
    expect(mocks.domain).toBeNull();
    expect(attachedAfterAll()).toEqual([]);
  });

  it("re-saving the same label while it is still verifying keeps it attached when the write fails", async () => {
    mocks.domain = { hostname: "beta.zaviagent.com", label: "beta", custom_domain_id: "cd-beta", status: "verifying" };
    mocks.saveError = { code: "XX000", message: "boom" };
    const { res, result } = response();
    await setBuiltinUrlHandler(rename("beta"), res);
    expect(result().status).toBe(500);
    expect(mocks.setSub).toHaveBeenCalledTimes(1);
    expect(mocks.clearSub).not.toHaveBeenCalled();
    expect(mocks.domain?.hostname).toBe("beta.zaviagent.com");
  });

  it("a failed write for a different label still rolls back only the new attachment", async () => {
    mocks.saveError = { code: "XX000", message: "boom" };
    const { res, result } = response();
    await setBuiltinUrlHandler(rename("beta"), res);
    expect(result().status).toBe(500);
    expect(mocks.clearSub).toHaveBeenCalledTimes(1);
    expect(mocks.clearSub.mock.calls[0][1]).toMatchObject({ hostname: "beta.zaviagent.com", custom_domain_id: "cd-beta" });
    expect(mocks.domain?.hostname).toBe("alpha.zaviagent.com");
  });

  it("a GET that reconciles a verifying address while a rename lands never writes the old hostname back", async () => {
    mocks.domain = {
      hostname: "alpha.zaviagent.com",
      label: "alpha",
      custom_domain_id: "cd-alpha",
      dns_record_id: "dns-alpha",
      render_service_id: "srv-1",
      status: "verifying",
    };
    mocks.status.mockImplementation(async (_srv: string, id: string) => {
      if (id === "cd-alpha") {
        await new Promise((r) => setTimeout(r, 30));
        return "verified";
      }
      return "pending";
    });
    const g = response();
    const r = response();
    const get = getBuiltinUrlHandler({ headers: {} } as unknown as Request, g.res);
    await new Promise((res) => setTimeout(res, 3));
    await Promise.all([get, setBuiltinUrlHandler(rename("beta"), r.res)]);
    expect(r.result().status).toBe(200);
    expect(mocks.domain?.hostname).toBe("beta.zaviagent.com");
    expect(mocks.saves.map((s) => s.hostname)).toEqual(["alpha.zaviagent.com", "beta.zaviagent.com"]);
    expect(attachedAfterAll()).toEqual(["beta.zaviagent.com"]);
  });
});
