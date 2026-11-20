
import { describe, it, expect, vi } from "vitest";
import { providerFromNameservers, detectDnsProvider } from "../dns-provider";
import { registrableDomain } from "../custom-domain-validate";

describe("providerFromNameservers", () => {
  const cases: Array<[string, string[]]> = [
    ["Cloudflare", ["kate.ns.cloudflare.com", "rob.ns.cloudflare.com"]],
    ["GoDaddy", ["ns01.domaincontrol.com", "ns02.domaincontrol.com"]],
    ["Namecheap", ["dns1.registrar-servers.com", "dns2.registrar-servers.com"]],
    ["Squarespace", ["ns1.squarespacedns.com", "ns2.squarespacedns.com"]],
    ["AWS Route 53", ["ns-123.awsdns-45.org", "ns-678.awsdns-90.co.uk"]],
    ["Vercel", ["ns1.vercel-dns.com", "ns2.vercel-dns.com"]],
    ["IONOS", ["ns1041.ui-dns.com", "ns1041.ui-dns.de"]],
    ["Porkbun", ["curitiba.ns.porkbun.com", "fortaleza.ns.porkbun.com"]],
  ];

  it.each(cases)("recognizes %s from its nameservers", (name, ns) => {
    expect(providerFromNameservers(ns)?.name).toBe(name);
  });

  it("every recognized provider carries a usable guide link", () => {
    for (const [, ns] of cases) {
      const p = providerFromNameservers(ns);
      expect(p?.guideUrl).toMatch(/^https:\/\//);
    }
  });

  it("is case- and trailing-dot-insensitive (resolvers return either form)", () => {
    expect(providerFromNameservers(["KATE.NS.CLOUDFLARE.COM."])?.id).toBe("cloudflare");
  });

  it("returns null for an unknown provider rather than guessing", () => {
    expect(providerFromNameservers(["ns1.some-obscure-host.example", "ns2.example"])).toBeNull();
  });

  it("returns null for an empty nameserver list", () => {
    expect(providerFromNameservers([])).toBeNull();
  });
});

describe("registrableDomain (the zone we query for NS)", () => {
  it.each([
    ["acme.com", "acme.com"],
    ["app.acme.com", "acme.com"],
    ["a.b.c.acme.com", "acme.com"],
    ["acme.co.uk", "acme.co.uk"],
    ["app.acme.co.uk", "acme.co.uk"],
  ])("%s → %s", (input, expected) => {
    expect(registrableDomain(input)).toBe(expected);
  });
});

describe("detectDnsProvider", () => {
  it("resolves NS for the ZONE APEX, not the subdomain, and returns the provider", async () => {
    const resolveNs = vi.fn(async () => ["kate.ns.cloudflare.com"]);
    const p = await detectDnsProvider("app.acme.com", { resolveNs });
    expect(resolveNs).toHaveBeenCalledWith("acme.com");
    expect(p?.id).toBe("cloudflare");
  });

  it("returns null (never throws) when the lookup fails — unconfigured zone / timeout", async () => {
    const resolveNs = vi.fn(async () => {
      throw new Error("ENOTFOUND");
    });
    await expect(detectDnsProvider("not-configured-yet.com", { resolveNs })).resolves.toBeNull();
  });

  it("returns null for a resolvable-but-unrecognized provider", async () => {
    const resolveNs = vi.fn(async () => ["ns1.unknown-host.example"]);
    await expect(detectDnsProvider("acme.com", { resolveNs })).resolves.toBeNull();
  });
});
