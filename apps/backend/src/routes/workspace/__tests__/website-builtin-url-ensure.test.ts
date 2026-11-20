import type { Request, Response } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  role: vi.fn(),
  rpc: vi.fn(),
  setSub: vi.fn(),
  clearSub: vi.fn(),
  status: vi.fn(),
  verify: vi.fn(),
  cname: vi.fn(),
  hosting: null as null | { render_service_id: string; url: string },
  domain: null as null | Record<string, unknown>,
  tenant: null as null | { slug?: string | null; display_name?: string | null },
}));

vi.mock("@/services/website/site-offline", () => ({ siteIsSuspended: async () => false }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.auth }));
vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: async (_a: unknown, allowed: readonly string[], res: Response) => {
    const role = await mocks.role();
    if (!role || !allowed.includes(role)) {
      res.status(403).json({ error: { code: "forbidden" } });
      return false;
    }
    return true;
  },
}));
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
          if (table === "tenants") return { data: mocks.tenant };
          if (table === "tenant_resources" && kind === "domain") {
            return { data: mocks.domain ? { external_ref: mocks.domain } : null };
          }
          return { data: null };
        },
        limit: async () => ({ data: mocks.hosting ? [{ external_ref: mocks.hosting }] : [] }),
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
  verifyRenderCustomDomain: (...a: unknown[]) => mocks.verify(...a),
}));
vi.mock("@/services/provisioning/cloudflare-dns", () => ({
  BUILTIN_HOST_IN_USE: "that domain is already in use by another app",
  ensureDnsCname: (...a: unknown[]) => mocks.cname(...a),
}));

import { ensureBuiltinUrlHandler, getBuiltinUrlHandler } from "../website-builtin-url";
import { resetBuiltinVerifyThrottle } from "@/services/provisioning/builtin-domain-heal";

const CF_ENV = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ZONE_ID"] as const;
const savedEnv: Partial<Record<(typeof CF_ENV)[number], string | undefined>> = {};
function cloudflareEnv(configured: boolean) {
  for (const k of CF_ENV) {
    if (configured) process.env[k] = `test-${k}`;
    else delete process.env[k];
  }
}
beforeAll(() => {
  for (const k of CF_ENV) savedEnv[k] = process.env[k];
});
afterAll(() => {
  for (const k of CF_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";

function response() {
  let status = 200;
  let body: unknown;
  const res = {
    status: vi.fn((v: number) => { status = v; return res; }),
    json: vi.fn((v: unknown) => { body = v; return res; }),
  } as unknown as Response;
  return { res, result: () => ({ status, body: body as Record<string, unknown> }) };
}

const req = { body: {}, headers: {} } as unknown as Request;

function rpcTaken(times: number) {
  let n = 0;
  mocks.rpc.mockImplementation(async () => {
    n += 1;
    return n <= times ? { data: null, error: { code: "23505", message: "dup" } } : { data: null, error: null };
  });
}

describe("POST /api/website/builtin-url/ensure — Publish hands out the Zavi address", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBuiltinVerifyThrottle();
    cloudflareEnv(true);
    mocks.auth.mockResolvedValue({ tenant_id: TENANT, user_id: "user-a" });
    mocks.role.mockResolvedValue("owner");
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    mocks.status.mockResolvedValue("pending");
    mocks.verify.mockResolvedValue(undefined);
    mocks.cname.mockResolvedValue({ record_id: "cf-rec-1" });
    mocks.setSub.mockImplementation(async (_svc: string, _url: string | null, label: string) => ({
      hostname: `${label}.zaviagent.com`,
      label,
      custom_domain_id: `cd-${label}`,
      dns_record_id: "dns-1",
    }));
    mocks.hosting = { render_service_id: "srv-1", url: "https://upcarai-6ec4d609.onrender.com" };
    mocks.domain = null;
    mocks.tenant = { slug: "upcar-ai", display_name: "UpcarAI" };
  });

  it("403s a member and touches neither the provider nor the DB", async () => {
    mocks.role.mockResolvedValue("member");
    const { res, result } = response();
    await ensureBuiltinUrlHandler(req, res);
    expect(result().status).toBe(403);
    expect(mocks.setSub).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("creates <slug>.zaviagent.com from the tenant slug when nothing exists yet", async () => {
    const { res, result } = response();
    await ensureBuiltinUrlHandler(req, res);
    expect(result().status).toBe(200);
    expect(mocks.setSub).toHaveBeenCalledWith("srv-1", "https://upcarai-6ec4d609.onrender.com", "upcar-ai");
    expect(result().body).toMatchObject({
      created: true,
      base_domain: "zaviagent.com",
      builtin: { label: "upcar-ai", hostname: "upcar-ai.zaviagent.com", url: "https://upcar-ai.zaviagent.com", status: "verifying" },
    });
    const persisted = mocks.rpc.mock.calls[0][1] as { p_external_ref: Record<string, unknown> };
    expect(persisted.p_external_ref).toMatchObject({ hostname: "upcar-ai.zaviagent.com", status: "verifying", render_service_id: "srv-1" });
  });

  it("never fabricates a hostname that contains the Render host", async () => {
    mocks.tenant = { slug: null, display_name: null };
    const { res, result } = response();
    await ensureBuiltinUrlHandler(req, res);
    const b = result().body.builtin as { hostname: string };
    expect(b.hostname).toBe("app-73db45.zaviagent.com");
    expect(JSON.stringify(result().body)).not.toContain("onrender");
  });

  it("returns the existing address without touching the provider when one is already set", async () => {
    mocks.domain = { hostname: "cool.zaviagent.com", label: "cool", custom_domain_id: "cd-cool", status: "live" };
    const { res, result } = response();
    await ensureBuiltinUrlHandler(req, res);
    expect(result().status).toBe(200);
    expect(result().body).toMatchObject({ created: false, builtin: { hostname: "cool.zaviagent.com", status: "live" } });
    expect(mocks.setSub).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("reconciles a verifying address to live when Render already verified it", async () => {
    mocks.domain = { hostname: "cool.zaviagent.com", label: "cool", custom_domain_id: "cd-cool", status: "verifying" };
    mocks.status.mockResolvedValue("verified");
    const { res, result } = response();
    await ensureBuiltinUrlHandler(req, res);
    expect(result().body).toMatchObject({ created: false, builtin: { status: "live" } });
    expect(mocks.setSub).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("409s when the app is not built yet, before any provider call", async () => {
    mocks.hosting = null;
    const { res, result } = response();
    await ensureBuiltinUrlHandler(req, res);
    expect(result().status).toBe(409);
    expect((result().body.error as { code: string }).code).toBe("no_deployed_app");
    expect(mocks.setSub).not.toHaveBeenCalled();
  });

  it("loses the label race once: rolls back the first attach, retries with the tenant suffix, keeps only the second", async () => {
    rpcTaken(1);
    const { res, result } = response();
    await ensureBuiltinUrlHandler(req, res);
    expect(result().status).toBe(200);
    expect(mocks.setSub.mock.calls.map((c) => c[2])).toEqual(["upcar-ai", "upcar-ai-73db45"]);
    expect(mocks.clearSub).toHaveBeenCalledTimes(1);
    expect(mocks.clearSub.mock.calls[0][1]).toMatchObject({ hostname: "upcar-ai.zaviagent.com", custom_domain_id: "cd-upcar-ai" });
    expect(result().body).toMatchObject({ created: true, builtin: { hostname: "upcar-ai-73db45.zaviagent.com" } });
  });

  it("retries with the tenant suffix when the provider says another app already holds the label", async () => {
    mocks.setSub.mockImplementationOnce(async () => {
      throw new Error("that domain is already in use by another app");
    });
    const { res, result } = response();
    await ensureBuiltinUrlHandler(req, res);
    expect(result().status).toBe(200);
    expect(mocks.setSub.mock.calls.map((c) => c[2])).toEqual(["upcar-ai", "upcar-ai-73db45"]);
    expect(result().body).toMatchObject({ created: true, builtin: { hostname: "upcar-ai-73db45.zaviagent.com" } });
  });

  it("loses the race twice: gives up with label_taken and leaves no attached subdomain behind", async () => {
    rpcTaken(2);
    const { res, result } = response();
    await ensureBuiltinUrlHandler(req, res);
    expect(result().status).toBe(409);
    expect((result().body.error as { code: string }).code).toBe("label_taken");
    expect(mocks.setSub).toHaveBeenCalledTimes(2);
    expect(mocks.clearSub).toHaveBeenCalledTimes(2);
  });

  it("asks Render to verify as soon as the attach has written DNS, before the first poll", async () => {
    const { res, result } = response();
    await ensureBuiltinUrlHandler(req, res);
    expect(result().status).toBe(200);
    expect(mocks.verify).toHaveBeenCalledTimes(1);
    expect(mocks.verify).toHaveBeenCalledWith("srv-1", "cd-upcar-ai");
    expect(mocks.verify.mock.invocationCallOrder[0]).toBeLessThan(mocks.status.mock.invocationCallOrder[0]);
    expect(result().body).toMatchObject({ builtin: { status: "verifying", dns_ready: true } });
    expect(result().body.builtin).not.toHaveProperty("setup_blocked");
  });

  it("does not ask Render to verify when the attach could not write DNS, and says the server cannot finish setup", async () => {
    cloudflareEnv(false);
    mocks.setSub.mockImplementation(async (_svc: string, _url: string | null, label: string) => ({
      hostname: `${label}.zaviagent.com`,
      label,
      custom_domain_id: `cd-${label}`,
      dns_record_id: null,
    }));
    const { res, result } = response();
    await ensureBuiltinUrlHandler(req, res);
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(result().body).toMatchObject({
      created: true,
      builtin: { status: "verifying", dns_ready: false, setup_blocked: "dns_not_configured" },
    });
    expect(JSON.stringify(result().body)).not.toMatch(/cloudflare|render/i);
  });

  it("marks the address live immediately when Render verifies it on the spot", async () => {
    mocks.status.mockResolvedValue("verified");
    const { res, result } = response();
    await ensureBuiltinUrlHandler(req, res);
    expect(result().body).toMatchObject({ builtin: { status: "live" } });
  });
});

describe("GET /api/website/builtin-url — the popover's poll", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBuiltinVerifyThrottle();
    cloudflareEnv(true);
    mocks.auth.mockResolvedValue({ tenant_id: TENANT, user_id: "user-a" });
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    mocks.status.mockResolvedValue("pending");
    mocks.verify.mockResolvedValue(undefined);
    mocks.cname.mockResolvedValue({ record_id: "cf-rec-1" });
    mocks.hosting = { render_service_id: "srv-1", url: "https://x.onrender.com" };
    mocks.tenant = null;
  });

  it("heals a stuck row on the spot: writes the missing CNAME, asks Render to verify, persists dns + service, reports dns_ready", async () => {
    mocks.domain = { hostname: "mohit-93bd8436.zaviagent.com", dns_record_id: null, custom_domain_id: "cdm-1" };
    const { res, result } = response();
    await getBuiltinUrlHandler(req, res);
    expect(mocks.cname).toHaveBeenCalledWith("mohit-93bd8436.zaviagent.com", "x.onrender.com", {}, false, { onlyReplaceOnrender: true });
    expect(mocks.verify).toHaveBeenCalledWith("srv-1", "cdm-1");
    const persisted = mocks.rpc.mock.calls[0][1] as { p_external_ref: Record<string, unknown> };
    expect(persisted.p_external_ref).toMatchObject({ dns_record_id: "cf-rec-1", render_service_id: "srv-1", status: "verifying" });
    expect(result().body).toMatchObject({ builtin: { status: "verifying", dns_ready: true } });
  });

  it("without Cloudflare credentials it cannot write DNS and says so with dns_ready false, never claiming live", async () => {
    mocks.cname.mockResolvedValue({ record_id: null, skipped: true });
    mocks.domain = { hostname: "mohit-93bd8436.zaviagent.com", dns_record_id: null, custom_domain_id: "cdm-1" };
    const { res, result } = response();
    await getBuiltinUrlHandler(req, res);
    expect(result().body).toMatchObject({ builtin: { status: "verifying", dns_ready: false } });
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("a member's poll still heals what it can but survives the RLS write refusal", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "permission denied" } });
    mocks.domain = { hostname: "cool.zaviagent.com", label: "cool", custom_domain_id: "cd-cool", dns_record_id: "cf-1", render_service_id: "srv-1", status: "verifying" };
    mocks.status.mockResolvedValue("verified");
    const { res, result } = response();
    await getBuiltinUrlHandler(req, res);
    expect(result().status).toBe(200);
    expect(result().body).toMatchObject({ builtin: { status: "live" } });
  });

  it("returns null when no address exists and never names the Render host", async () => {
    mocks.domain = null;
    const { res, result } = response();
    await getBuiltinUrlHandler(req, res);
    expect(result().body).toEqual({ builtin: null, base_domain: "zaviagent.com", custom_domain_attached: false });
  });

  it("flips verifying to live once Render reports verified, persisting the change", async () => {
    mocks.domain = { hostname: "cool.zaviagent.com", label: "cool", custom_domain_id: "cd-cool", status: "verifying" };
    mocks.status.mockResolvedValue("verified");
    const { res, result } = response();
    await getBuiltinUrlHandler(req, res);
    expect(result().body).toMatchObject({ builtin: { status: "live" } });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("names the blocker when DNS is unwritten because this server has no DNS credentials", async () => {
    cloudflareEnv(false);
    mocks.cname.mockResolvedValue({ record_id: null, skipped: true });
    mocks.domain = { hostname: "mohit-93bd8436.zaviagent.com", dns_record_id: null, custom_domain_id: "cdm-1" };
    const { res, result } = response();
    await getBuiltinUrlHandler(req, res);
    expect(result().body).toMatchObject({
      builtin: { status: "verifying", dns_ready: false, setup_blocked: "dns_not_configured" },
    });
    expect(JSON.stringify(result().body)).not.toMatch(/cloudflare|render/i);
  });

  it("does not blame configuration when DNS credentials exist and the write is merely pending", async () => {
    mocks.cname.mockResolvedValue({ record_id: null, skipped: true });
    mocks.domain = { hostname: "mohit-93bd8436.zaviagent.com", dns_record_id: null, custom_domain_id: "cdm-1" };
    const { res, result } = response();
    await getBuiltinUrlHandler(req, res);
    expect(result().body).toMatchObject({ builtin: { status: "verifying", dns_ready: false } });
    expect(result().body.builtin).not.toHaveProperty("setup_blocked");
  });

  it("never marks a live address as blocked, even one that predates our DNS writer", async () => {
    cloudflareEnv(false);
    mocks.domain = { hostname: "cool.zaviagent.com", label: "cool", custom_domain_id: "cd-cool", status: "live" };
    const { res, result } = response();
    await getBuiltinUrlHandler(req, res);
    expect(result().body).toMatchObject({ builtin: { status: "live", dns_ready: false } });
    expect(result().body.builtin).not.toHaveProperty("setup_blocked");
  });

  it("a poll on a row whose DNS is already recorded asks Render to verify instead of waiting for its slow recheck, once a minute", async () => {
    mocks.status.mockResolvedValue("unverified");
    mocks.domain = { hostname: "cool.zaviagent.com", label: "cool", custom_domain_id: "cd-cool", dns_record_id: "cf-rec-1", render_service_id: "srv-1", status: "verifying" };
    const first = response();
    await getBuiltinUrlHandler(req, first.res);
    expect(first.result().body).toMatchObject({ builtin: { status: "verifying", dns_ready: true } });
    expect(mocks.verify).toHaveBeenCalledTimes(1);
    expect(mocks.verify).toHaveBeenCalledWith("srv-1", "cd-cool");
    expect(mocks.cname).toHaveBeenCalledWith("cool.zaviagent.com", "x.onrender.com", {}, false, { onlyReplaceOnrender: true });
    expect(mocks.rpc).not.toHaveBeenCalled();
    const second = response();
    await getBuiltinUrlHandler(req, second.res);
    expect(mocks.verify).toHaveBeenCalledTimes(1);
    expect(second.result().body).toMatchObject({ builtin: { status: "verifying" } });
  });

  it("a Render verify failure on the poll neither breaks the poll nor loses the recorded DNS", async () => {
    mocks.status.mockResolvedValue("unverified");
    mocks.verify.mockRejectedValue(new Error("render 500"));
    mocks.domain = { hostname: "cool.zaviagent.com", label: "cool", custom_domain_id: "cd-cool", dns_record_id: "cf-rec-1", render_service_id: "srv-1", status: "verifying" };
    const { res, result } = response();
    await getBuiltinUrlHandler(req, res);
    expect(result().status).toBe(200);
    expect(result().body).toMatchObject({ builtin: { status: "verifying", dns_ready: true } });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
