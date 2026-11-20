import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
const tables: Record<string, { data: unknown; error: unknown }> = {};
const calls: Array<{ table: string; ops: Array<[string, unknown[]]> }> = [];

function builder(table: string) {
  const entry = { table, ops: [] as Array<[string, unknown[]]> };
  calls.push(entry);
  const result = () => tables[table] ?? { data: null, error: null };
  const b: Record<string, unknown> = {};
  for (const op of ["select", "eq", "order", "limit"]) {
    b[op] = (...args: unknown[]) => {
      entry.ops.push([op, args]);
      return b;
    };
  }
  b.maybeSingle = async () => result();
  b.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject);
  return b;
}

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: (t: string) => builder(t), rpc: (...a: unknown[]) => rpc(...a) }),
}));
const regenerateCompanyBrief = vi.fn();
const getAppSetting = vi.fn();
vi.mock("@/services/settings", () => ({ getAppSetting: (...a: unknown[]) => getAppSetting(...a) }));
vi.mock("@/services/company/brief", () => ({ regenerateCompanyBrief: (...a: unknown[]) => regenerateCompanyBrief(...a) }));

import {
  realPrimarySiteWebsiteDeps,
  recordPrimarySiteAsCompanyWebsite,
  type PrimarySiteWebsiteDeps,
} from "../primary-site-website";

const TENANT = "dfd71727-465b-4f7d-a159-1813c66799d7";
const BAKERY = "d386a1ef-f3b4-4dcc-9f94-3d5095dfd977";
const BIKES = "05cd71e6-ca9a-402a-8c5b-7955a2cf9d5f";
const BAKERY_URL = "https://bakery-d667db97-d386a1-dev.zaviagent.com";
const BIKES_URL = "https://bike-rental-d667db97-05cd71-dev.zaviagent.com";

function world(over: Partial<{ primary: string | null; website: string | null }> = {}) {
  const state = { primary: BAKERY as string | null, website: null as string | null, ...over };
  const writes: Array<{ tenant_id: string; url: string; source_ref: string }> = [];
  const briefs: string[] = [];
  const deps: PrimarySiteWebsiteDeps = {
    primarySiteId: vi.fn(async () => state.primary),
    hasWebsite: vi.fn(async () => state.website !== null),
    setWebsite: vi.fn(async (tenant_id, url, source_ref) => {
      writes.push({ tenant_id, url, source_ref });
      state.website = url;
    }),
    regenerateBrief: vi.fn(async (tenant_id) => {
      briefs.push(tenant_id);
      return true;
    }),
  };
  return { state, deps, writes, briefs };
}

describe("recordPrimarySiteAsCompanyWebsite", () => {
  it("a later build going live never becomes the company website; the founding build does when it finally goes live", async () => {
    const w = world();
    expect(await recordPrimarySiteAsCompanyWebsite({ tenant_id: TENANT, site_id: BIKES, url: BIKES_URL }, w.deps)).toBe("not_primary");
    expect(w.writes).toEqual([]);
    expect(w.briefs).toEqual([]);

    expect(await recordPrimarySiteAsCompanyWebsite({ tenant_id: TENANT, site_id: BAKERY, url: BAKERY_URL }, w.deps)).toBe("recorded");
    expect(w.writes).toEqual([
      { tenant_id: TENANT, url: BAKERY_URL, source_ref: "site bakery-d667db97-d386a1-dev.zaviagent.com verified live by site-activate" },
    ]);
    expect(w.briefs).toEqual([TENANT]);

    expect(await recordPrimarySiteAsCompanyWebsite({ tenant_id: TENANT, site_id: BAKERY, url: BAKERY_URL }, w.deps)).toBe("has_website");
    expect(w.writes).toHaveLength(1);
    expect(w.briefs).toHaveLength(1);
  });

  it("never replaces a website the company already has, whoever set it", async () => {
    const w = world({ website: "https://realbakery.com" });
    expect(await recordPrimarySiteAsCompanyWebsite({ tenant_id: TENANT, site_id: BAKERY, url: BAKERY_URL }, w.deps)).toBe("has_website");
    expect(w.deps.setWebsite).not.toHaveBeenCalled();
    expect(w.deps.regenerateBrief).not.toHaveBeenCalled();
  });

  it("a tenant with no site rows writes nothing", async () => {
    const w = world({ primary: null });
    expect(await recordPrimarySiteAsCompanyWebsite({ tenant_id: TENANT, site_id: BAKERY, url: BAKERY_URL }, w.deps)).toBe("not_primary");
    expect(w.deps.setWebsite).not.toHaveBeenCalled();
  });

  it.each([
    "http://bakery-d667db97-d386a1-dev.zaviagent.com",
    "https://bakery-d667db97-d386a1-dev.zaviagent.com/menu",
    "https://localhost",
    "https://evil.com@bakery.zaviagent.com",
    "",
  ])("refuses %j before reading anything", async (url) => {
    const w = world();
    expect(await recordPrimarySiteAsCompanyWebsite({ tenant_id: TENANT, site_id: BAKERY, url }, w.deps)).toBe("bad_url");
    expect(w.deps.primarySiteId).not.toHaveBeenCalled();
    expect(w.deps.setWebsite).not.toHaveBeenCalled();
  });

  it("a brief that fails to re-render still leaves the website recorded", async () => {
    const w = world();
    w.deps.regenerateBrief = vi.fn(async () => {
      throw new Error("brief render failed");
    });
    expect(await recordPrimarySiteAsCompanyWebsite({ tenant_id: TENANT, site_id: BAKERY, url: BAKERY_URL }, w.deps)).toBe("recorded");
    expect(w.writes).toHaveLength(1);
  });

  it("a failed website write throws and does not re-render the brief", async () => {
    const w = world();
    w.deps.setWebsite = vi.fn(async () => {
      throw new Error("set_tenant_company_domain_system failed: boom");
    });
    await expect(recordPrimarySiteAsCompanyWebsite({ tenant_id: TENANT, site_id: BAKERY, url: BAKERY_URL }, w.deps)).rejects.toThrow("boom");
    expect(w.deps.regenerateBrief).not.toHaveBeenCalled();
  });
});

describe("realPrimarySiteWebsiteDeps", () => {
  beforeEach(() => {
    rpc.mockReset();
    regenerateCompanyBrief.mockReset();
    getAppSetting.mockReset();
    calls.length = 0;
    for (const k of Object.keys(tables)) delete tables[k];
  });

  it("writes through the single company-domain writer as provisioned, never as a human", async () => {
    rpc.mockResolvedValue({ error: null });
    await realPrimarySiteWebsiteDeps.setWebsite(TENANT, BAKERY_URL, "site x verified live by site-activate");
    expect(rpc).toHaveBeenCalledWith("set_tenant_company_domain_system", {
      p_tenant_id: TENANT,
      p_url: BAKERY_URL,
      p_source: "provisioned",
      p_source_ref: "site x verified live by site-activate",
    });
  });

  it("surfaces a writer error instead of reporting success", async () => {
    rpc.mockResolvedValue({ error: { message: "company domain: private host" } });
    await expect(realPrimarySiteWebsiteDeps.setWebsite(TENANT, BAKERY_URL, "r")).rejects.toThrow("private host");
  });

  it("the primary site is this tenant's oldest site row", async () => {
    tables.sites = { data: [{ id: BAKERY }], error: null };
    expect(await realPrimarySiteWebsiteDeps.primarySiteId(TENANT)).toBe(BAKERY);
    const ops = calls.find((c) => c.table === "sites")!.ops;
    expect(ops).toContainEqual(["eq", ["tenant_id", TENANT]]);
    expect(ops).toContainEqual(["order", ["created_at", { ascending: true }]]);
    expect(ops).toContainEqual(["limit", [1]]);
  });

  it.each([
    [{ data: [{ key: "domain" }], error: null }, { data: { product_url: null }, error: null }, true],
    [{ data: [], error: null }, { data: { product_url: { marketing: "https://realbakery.com" } }, error: null }, true],
    [{ data: [], error: null }, { data: { product_url: { api: "https://api.realbakery.com" } }, error: null }, false],
    [{ data: [], error: null }, { data: { product_url: { marketing: "  " } }, error: null }, false],
    [{ data: [], error: null }, { data: null, error: null }, false],
  ])("hasWebsite reads both the fact and the legacy product_url (%#)", async (fact, tenant, expected) => {
    tables.tenant_fact = fact;
    tables.tenants = tenant;
    expect(await realPrimarySiteWebsiteDeps.hasWebsite(TENANT)).toBe(expected);
    expect(calls.find((c) => c.table === "tenant_fact")!.ops).toContainEqual(["eq", ["tenant_id", TENANT]]);
    expect(calls.find((c) => c.table === "tenants")!.ops).toContainEqual(["eq", ["id", TENANT]]);
  });

  it("a failed read throws rather than guessing there is no website", async () => {
    tables.tenant_fact = { data: null, error: { message: "timeout" } };
    tables.tenants = { data: null, error: null };
    await expect(realPrimarySiteWebsiteDeps.hasWebsite(TENANT)).rejects.toThrow("timeout");
  });

  it("a workspace whose build intent is 'existing' (built from the Build tab) still gets its live site as the website", async () => {
    getAppSetting.mockResolvedValue("existing");
    tables.sites = { data: [{ id: BAKERY }], error: null };
    tables.tenant_fact = { data: [], error: null };
    tables.tenants = { data: { product_url: null }, error: null };
    rpc.mockResolvedValue({ error: null });
    expect(await recordPrimarySiteAsCompanyWebsite({ tenant_id: TENANT, site_id: BAKERY, url: BAKERY_URL })).toBe("recorded");
    expect(rpc).toHaveBeenCalledWith("set_tenant_company_domain_system", expect.objectContaining({ p_tenant_id: TENANT, p_url: BAKERY_URL, p_source: "provisioned" }));
    expect(regenerateCompanyBrief).toHaveBeenCalledWith(TENANT);
  });
});
