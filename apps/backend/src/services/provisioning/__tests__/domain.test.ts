import { describe, it, expect, vi } from "vitest";
import {
  createDomainProvisioner,
  hostSlug,
  RENDER_MAX_CUSTOM_DOMAIN_CHARS,
} from "@/services/provisioning/domain";
import { tenantSuffix, tenantScopedSlug } from "@/services/provisioning/tenant-slug";
import { CredentialNotConfigured } from "@/services/provisioning/github-repo";

function res(status: number, body: unknown = {}) {
  return { status, json: async () => body, text: async () => JSON.stringify(body) };
}
const ctx = { context: { render_service_id: "srv_1" } };
const T1 = tenantSuffix("t1");

describe("hostSlug", () => {
  it("slugifies, suffixed with a tenant hash (A1)", () => {
    expect(hostSlug("Acme Co!", "t1")).toBe(`acme-co-${T1}`);
  });
  it("is tenant-scoped — same name, different tenant → different label (A1)", () => {
    expect(hostSlug("UpcarAI", "tenant-a")).not.toBe(hostSlug("UpcarAI", "tenant-b"));
  });
});

describe("DomainProvisioner", () => {
  it("gated: missing RENDER_API_KEY → CredentialNotConfigured", async () => {
    const p = createDomainProvisioner({ hostSuffix: () => "", token: () => null, fetchFn: vi.fn() as never });
    await expect(p.ensure({ tenant_id: "t1", company_name: "Acme", ...ctx })).rejects.toMatchObject({
      key: "RENDER_API_KEY",
    });
  });

  it("requires the render service id from context (hosting runs first)", async () => {
    const p = createDomainProvisioner({ hostSuffix: () => "", token: () => "tok", fetchFn: vi.fn() as never });
    await expect(p.ensure({ tenant_id: "t1", company_name: "Acme" })).rejects.toThrow(/requires hosting/i);
  });

  it("builds <slug>.zaviagent.com by default", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, []))
      .mockResolvedValueOnce(res(201, { id: "cd_1" }));
    const p = createDomainProvisioner({ hostSuffix: () => "", token: () => "tok", fetchFn: fetchFn as never });
    const r = await p.ensure({ tenant_id: "t1", company_name: "Acme", ...ctx });
    expect(r.external_ref).toEqual({
      hostname: `acme-${T1}.zaviagent.com`,
      custom_domain_id: "cd_1",
      dns_record_id: null,
      status: "verifying",
      render_service_id: "srv_1",
    });
    expect(fetchFn.mock.calls[1][1]?.method).toBe("POST");
  });

  it("Slice 4: create 2xx with NO id → re-list by hostname recovers the id (no throw, no orphan)", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, []))
      .mockResolvedValueOnce(res(201, {}))
      .mockResolvedValueOnce(
        res(200, [{ customDomain: { id: "cd_recovered", name: `acme-${T1}.zaviagent.com` } }]),
      );
    const p = createDomainProvisioner({ hostSuffix: () => "", token: () => "tok", fetchFn: fetchFn as never });
    const r = await p.ensure({ tenant_id: "t1", company_name: "Acme", ...ctx });
    expect(r.external_ref.custom_domain_id).toBe("cd_recovered");
  });

  it("Slice 4: create 2xx no id + re-list miss → RETRYABLE error (never a null-id orphan)", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, []))
      .mockResolvedValueOnce(res(201, {}))
      .mockResolvedValueOnce(res(200, []));
    const p = createDomainProvisioner({ hostSuffix: () => "", token: () => "tok", fetchFn: fetchFn as never });
    await expect(
      p.ensure({ tenant_id: "t1", company_name: "Acme", ...ctx }),
    ).rejects.toThrow(/retryable/i);
  });

  it("idempotent: returns the existing custom domain (no create)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      res(200, [{ customDomain: { id: "cd_9", name: `acme-${T1}.zaviagent.com` } }]),
    );
    const p = createDomainProvisioner({ hostSuffix: () => "", token: () => "tok", fetchFn: fetchFn as never });
    const r = await p.ensure({ tenant_id: "t1", company_name: "Acme", ...ctx });
    expect(r.external_ref.custom_domain_id).toBe("cd_9");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("honors a custom base domain", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(res(200, [])).mockResolvedValueOnce(res(201, { id: "cd_2" }));
    const p = createDomainProvisioner({ hostSuffix: () => "", token: () => "tok", baseDomain: () => "apps.example.com", fetchFn: fetchFn as never });
    const r = await p.ensure({ tenant_id: "t1", company_name: "Acme", ...ctx });
    expect(r.external_ref.hostname).toBe(`acme-${T1}.apps.example.com`);
  });

  it("kind/provider = domain/thepraxis-subdomain", () => {
    const p = createDomainProvisioner({ hostSuffix: () => "", token: () => "tok" });
    expect(p.kind).toBe("domain");
    expect(p.provider).toBe("thepraxis-subdomain");
  });

  it("wires a Cloudflare DNS CNAME after the Render custom-domain (target = onrender host from context.url)", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, []))
      .mockResolvedValueOnce(res(201, { id: "cd_1" }))
      .mockResolvedValueOnce(res(200, { success: true, result: [], errors: [] }))
      .mockResolvedValueOnce(res(200, { success: true, result: { id: "rec_dns" }, errors: [] }));
    const p = createDomainProvisioner({ hostSuffix: () => "",
      token: () => "tok",
      fetchFn: fetchFn as never,
      cloudflare: { token: () => "cf_tok", zoneId: () => "zone_1", fetchFn: fetchFn as never },
    });
    const r = await p.ensure({
      tenant_id: "t1",
      company_name: "Acme",
      context: { render_service_id: "srv_1", url: "https://acme-svc.onrender.com/" },
    });
    expect(r.external_ref).toEqual({
      hostname: `acme-${T1}.zaviagent.com`,
      custom_domain_id: "cd_1",
      dns_record_id: "rec_dns",
      status: "verifying",
      render_service_id: "srv_1",
    });
    const cfCreate = fetchFn.mock.calls[3];
    expect(cfCreate[0]).toBe("https://api.cloudflare.com/client/v4/zones/zone_1/dns_records");
    expect(JSON.parse(cfCreate[1].body)).toMatchObject({
      type: "CNAME",
      name: `acme-${T1}.zaviagent.com`,
      content: "acme-svc.onrender.com",
      proxied: false,
      ttl: 300,
    });
  });

  it("skips the DNS write (Cloudflare not configured) but still returns the Render result", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(res(200, [])).mockResolvedValueOnce(res(201, { id: "cd_1" }));
    const p = createDomainProvisioner({ hostSuffix: () => "",
      token: () => "tok",
      fetchFn: fetchFn as never,
      cloudflare: { token: () => null, zoneId: () => null, fetchFn: vi.fn() as never },
    });
    const r = await p.ensure({
      tenant_id: "t1",
      company_name: "Acme",
      context: { render_service_id: "srv_1", url: "https://acme-svc.onrender.com" },
    });
    expect(r.external_ref).toEqual({
      hostname: `acme-${T1}.zaviagent.com`,
      custom_domain_id: "cd_1",
      dns_record_id: null,
      status: "verifying",
      render_service_id: "srv_1",
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("teardown deletes the branded CNAME + the Render custom-domain", async () => {
    const cfFetch = vi
      .fn()
      .mockResolvedValueOnce(res(200, { success: true, result: [{ id: "rec_dns", name: `acme-${T1}.zaviagent.com`, type: "CNAME", content: "acme-svc.onrender.com" }], errors: [] }))
      .mockResolvedValueOnce(res(200, { success: true, result: { id: "rec_dns" }, errors: [] }));
    const renderFetch = vi.fn().mockResolvedValueOnce(res(204, {}));
    const p = createDomainProvisioner({ hostSuffix: () => "",
      token: () => "tok",
      fetchFn: renderFetch as never,
      cloudflare: { token: () => "cf_tok", zoneId: () => "zone_1", fetchFn: cfFetch as never },
    });
    await p.teardown({
      hostname: `acme-${T1}.zaviagent.com`,
      render_service_id: "srv_1",
      custom_domain_id: "cd_1",
      dns_record_id: "rec_dns",
    });
    expect(cfFetch.mock.calls[1][1].method).toBe("DELETE");
    expect(renderFetch.mock.calls[0][1].method).toBe("DELETE");
  });
});

describe("hostSlug — Render 64-char hostname limit", () => {
  const TENANT = "4e87489e-1111-2222-3333-444455556666";
  const BASE = "zaviagent.com";

  const AIRBNB =
    "Airbnb: Holiday Rentals, Cabins, Beach Houses, Unique Homes & Experiences";

  it("keeps the FULL hostname within Render's limit for the name that 400'd", () => {
    const hostname = `${hostSlug(AIRBNB, TENANT, BASE)}.${BASE}`;
    expect(hostname.length).toBeLessThanOrEqual(RENDER_MAX_CUSTOM_DOMAIN_CHARS);
  });

  it("bounds absurdly long names too", () => {
    const hostname = `${hostSlug("a".repeat(500), TENANT, BASE)}.${BASE}`;
    expect(hostname.length).toBeLessThanOrEqual(RENDER_MAX_CUSTOM_DOMAIN_CHARS);
  });

  it("shrinks the label when the base domain is longer, instead of overflowing", () => {
    const longBase = "products.some-much-longer-base.example.com";
    const hostname = `${hostSlug(AIRBNB, TENANT, longBase)}.${longBase}`;
    expect(hostname.length).toBeLessThanOrEqual(RENDER_MAX_CUSTOM_DOMAIN_CHARS);
  });

  it("still keeps every label within the 63-char DNS limit", () => {
    for (const base of ["a.co", "zaviagent.com", "x.io"]) {
      const label = hostSlug("b".repeat(500), TENANT, base);
      expect(label.length).toBeLessThanOrEqual(63);
    }
  });

  it("is unchanged for names that already fit — no existing domain is orphaned", () => {
    for (const name of ["AirOps", "FocusFlow", "Acme", "Upcar"]) {
      expect(hostSlug(name, TENANT, BASE)).toBe(tenantScopedSlug(name, TENANT, 51));
    }
  });

  it("stays deterministic and tenant-scoped", () => {
    const a = hostSlug(AIRBNB, TENANT, BASE);
    expect(hostSlug(AIRBNB, TENANT, BASE)).toBe(a);
    expect(hostSlug(AIRBNB, "99999999-1111-2222-3333-444455556666", BASE)).not.toBe(a);
  });
});

describe("DomainProvisioner off the prod backend (env isolation)", () => {
  it("a non-prod backend puts its suffix on the hostname, never a prod-shaped address", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(res(200, [])).mockResolvedValueOnce(res(201, { id: "cd_1" }));
    const p = createDomainProvisioner({ hostSuffix: () => "-dev", token: () => "tok", fetchFn: fetchFn as never });
    const r = await p.ensure({ tenant_id: "t1", company_name: "Austin Dog Grooming", ...ctx });
    expect(r.external_ref.hostname).toBe(`austin-dog-grooming-${T1}-dev.zaviagent.com`);
    expect(JSON.parse(String(fetchFn.mock.calls[1][1]?.body)).name).toBe(`austin-dog-grooming-${T1}-dev.zaviagent.com`);
  });

  it("off prod with no SITE_HOSTNAME_SUFFIX nothing is created: the step records the missing setting", async () => {
    const fetchFn = vi.fn();
    const p = createDomainProvisioner({
      hostSuffix: () => {
        throw new Error("SITE_HOSTNAME_SUFFIX is required");
      },
      token: () => "tok",
      fetchFn: fetchFn as never,
    });
    await expect(p.ensure({ tenant_id: "t1", company_name: "Acme", ...ctx })).rejects.toBeInstanceOf(CredentialNotConfigured);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("the default reads the environment: staging without a suffix refuses, with -dev it suffixes, prod is unchanged", async () => {
    const saved = { url: process.env.SUPABASE_URL, sfx: process.env.SITE_HOSTNAME_SUFFIX };
    try {
      process.env.SUPABASE_URL = "https://dgzgwclslzzzrjopbobp.supabase.co";
      delete process.env.SITE_HOSTNAME_SUFFIX;
      const refused = createDomainProvisioner({ token: () => "tok", fetchFn: vi.fn() as never });
      await expect(refused.ensure({ tenant_id: "t1", company_name: "Acme", ...ctx })).rejects.toMatchObject({ key: "SITE_HOSTNAME_SUFFIX" });

      process.env.SITE_HOSTNAME_SUFFIX = "-dev";
      const fetchFn = vi.fn().mockResolvedValueOnce(res(200, [])).mockResolvedValueOnce(res(201, { id: "cd_1" }));
      const ok = createDomainProvisioner({ token: () => "tok", fetchFn: fetchFn as never });
      expect((await ok.ensure({ tenant_id: "t1", company_name: "Acme", ...ctx })).external_ref.hostname).toBe(`acme-${T1}-dev.zaviagent.com`);

      process.env.SUPABASE_URL = "https://wmycgyjsenvgtczlupoe.supabase.co";
      delete process.env.SITE_HOSTNAME_SUFFIX;
      const prodFetch = vi.fn().mockResolvedValueOnce(res(200, [])).mockResolvedValueOnce(res(201, { id: "cd_1" }));
      const prod = createDomainProvisioner({ token: () => "tok", fetchFn: prodFetch as never });
      expect((await prod.ensure({ tenant_id: "t1", company_name: "Acme", ...ctx })).external_ref.hostname).toBe(`acme-${T1}.zaviagent.com`);
    } finally {
      if (saved.url === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = saved.url;
      if (saved.sfx === undefined) delete process.env.SITE_HOSTNAME_SUFFIX;
      else process.env.SITE_HOSTNAME_SUFFIX = saved.sfx;
    }
  });

  it("a suffixed hostname still fits Render's 64-char limit", () => {
    const name = "Airbnb: Holiday Rentals, Cabins, Beach Houses, Unique Homes & Experiences";
    const host = `${hostSlug(name, "t1", "zaviagent.com", "-dev")}.zaviagent.com`;
    expect(host.length).toBeLessThanOrEqual(RENDER_MAX_CUSTOM_DOMAIN_CHARS);
    expect(host.endsWith("-dev.zaviagent.com")).toBe(true);
  });
});
