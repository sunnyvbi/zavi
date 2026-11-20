import { describe, it, expect, vi } from "vitest";
import { createSitePublicResolver } from "../public-resolver";
import { sitePublicRpc } from "@/services/tenant-client";

describe("SitePublicResolver", () => {
  it("byHostname returns only tenant_id, site_id and status", async () => {
    const rpc = vi.fn(async () => ({
      data: [{ tenant_id: "t1", site_id: "s1", status: "paused", hostname: "x", owner_email: "o@x", supabase_url: "u" }],
      error: null,
    }));
    const r = createSitePublicResolver({ rpc });
    const got = await r.byHostname("  Acme-12345678-abcdef.ZaviAgent.com ");
    expect(got).toEqual({ tenant_id: "t1", site_id: "s1", status: "paused" });
    expect(Object.keys(got!).sort()).toEqual(["site_id", "status", "tenant_id"]);
    expect(rpc).toHaveBeenCalledWith("site_by_hostname", { p_hostname: "acme-12345678-abcdef.zaviagent.com" });
  });

  it("byHostname returns null for an unknown or empty host, and throws on an RPC error", async () => {
    const empty = createSitePublicResolver({ rpc: async () => ({ data: [], error: null }) });
    expect(await empty.byHostname("nope.zaviagent.com")).toBeNull();
    expect(await empty.byHostname("")).toBeNull();
    const bad = createSitePublicResolver({ rpc: async () => ({ data: null, error: { message: "down" } }) });
    await expect(bad.byHostname("a.zaviagent.com")).rejects.toThrow(/down/);
  });

  it("byRepo returns only tenant_id, site_id and status, trims the name, and refuses empty", async () => {
    const rpc = vi.fn(async () => ({
      data: [{ tenant_id: "t1", site_id: "s1", status: "live", github_full_name: "x/y", owner_email: "o@x" }],
      error: null,
    }));
    const r = createSitePublicResolver({ rpc });
    const got = await r.byRepo("  Zavi-Sites/Lucky-Paws ");
    expect(got).toEqual({ tenant_id: "t1", site_id: "s1", status: "live" });
    expect(Object.keys(got!).sort()).toEqual(["site_id", "status", "tenant_id"]);
    expect(rpc).toHaveBeenCalledWith("site_by_repo", { p_github_full_name: "Zavi-Sites/Lucky-Paws" });
    expect(await r.byRepo("")).toBeNull();
    expect(rpc).toHaveBeenCalledTimes(1);
    const bad = createSitePublicResolver({ rpc: async () => ({ data: null, error: { message: "down" } }) });
    await expect(bad.byRepo("a/b")).rejects.toThrow(/site_by_repo failed: down/);
  });

  it("claimIdleBatch projects three fields and clamps the limit", async () => {
    const rpc = vi.fn(async () => ({
      data: [{ tenant_id: "t1", site_id: "s1", hostname: "a.zaviagent.com", status: "live" }],
      error: null,
    }));
    const r = createSitePublicResolver({ rpc });
    expect(await r.claimIdleBatch("2026-08-31T00:00:00Z", 10_000)).toEqual([
      { tenant_id: "t1", site_id: "s1", hostname: "a.zaviagent.com" },
    ]);
    expect(rpc).toHaveBeenCalledWith("site_claim_idle_batch", { p_cutoff: "2026-08-31T00:00:00Z", p_limit: 500 });
  });

  it("the escape refuses any RPC that is not one of the two site reads", () => {
    expect(() => sitePublicRpc("site_update", {})).toThrow(/not a site public RPC/);
    expect(() => sitePublicRpc("get_secret", {})).toThrow(/not a site public RPC/);
  });
});
