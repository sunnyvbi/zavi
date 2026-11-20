import { describe, it, expect } from "vitest";
import {
  checkTenantFacts,
  checkConflictOfInterest,
  hasEnoughSources,
  type TenantIdentity,
} from "../fold-guards";

const acme: TenantIdentity = {
  tenant_id: "t-acme",
  slug: "acme-rentals",
  display_name: "Acme Rentals",
  company_shape: "marketplace",
  product_host: "acmerentals.com",
};
const globex: TenantIdentity = {
  tenant_id: "t-globex",
  slug: "globex-saas",
  display_name: "Globex",
  company_shape: "saas",
  product_host: "globex.io",
};
const rival: TenantIdentity = {
  tenant_id: "t-rival",
  slug: "zenith-rentals",
  display_name: "Zenith Rentals",
  company_shape: "marketplace",
  product_host: "zenithrentals.com",
};

describe("checkTenantFacts — a lesson must not name the customer it was learned from", () => {
  it("passes a genuinely generalized lesson", () => {
    const lesson =
      "When a tenant has no connectors wired, produce a connector-free first deliverable " +
      "instead of re-running the same no-op discovery.";
    expect(checkTenantFacts(lesson, [acme, globex])).toEqual({ clean: true });
  });

  it("REJECTS a lesson that names a source tenant's display name", () => {
    const v = checkTenantFacts("Acme Rentals always forgets to connect Stripe first.", [acme]);
    expect(v.clean).toBe(false);
  });

  it("REJECTS a lesson that names a source tenant's slug", () => {
    expect(checkTenantFacts("For acme-rentals, skip the brain step.", [acme]).clean).toBe(false);
  });

  it("REJECTS a lesson that names a source tenant's product domain", () => {
    expect(checkTenantFacts("Scrape acmerentals.com before inferring geography.", [acme]).clean).toBe(
      false,
    );
  });

  it("catches a partial name — 'Acme' alone, extracted from 'Acme Rentals'", () => {
    expect(checkTenantFacts("Acme needs its connectors wired before anything else.", [acme]).clean).toBe(
      false,
    );
  });

  it("does not false-positive on a substring inside an unrelated word", () => {
    expect(checkTenantFacts("Read the acmeter reading before acting.", [acme]).clean).toBe(true);
  });

  it("does not reject a lesson for containing a generic word like 'app' or 'team'", () => {
    const generic: TenantIdentity = {
      tenant_id: "t-x",
      slug: "app",
      display_name: "The Team",
      company_shape: null,
      product_host: null,
    };
    expect(checkTenantFacts("Ship the app to the team before Friday.", [generic]).clean).toBe(true);
  });

  it("fails CLOSED on an empty lesson — an unevaluable pattern is not a clean one", () => {
    expect(checkTenantFacts("", [acme]).clean).toBe(false);
    expect(checkTenantFacts("   ", [acme]).clean).toBe(false);
  });
});

describe("checkConflictOfInterest — never let one customer's data advantage their rival", () => {
  it("flags two tenants of the same company shape as possible competitors", () => {
    const v = checkConflictOfInterest([acme, rival]);
    expect(v.conflict).toBe(true);
    expect(v.detail).toMatch(/marketplace/);
    expect(v.detail).toMatch(/competitors/i);
  });

  it("does NOT flag tenants of different shapes", () => {
    expect(checkConflictOfInterest([acme, globex]).conflict).toBe(false);
  });

  it("does not invent a conflict from an unknown company_shape", () => {
    const a = { ...acme, company_shape: null };
    const b = { ...rival, company_shape: null };
    expect(checkConflictOfInterest([a, b]).conflict).toBe(false);
  });
});

describe("hasEnoughSources — one tenant's rescue is an anecdote, not a pattern", () => {
  it("rejects a single-tenant 'pattern'", () => {
    expect(hasEnoughSources([acme])).toBe(false);
  });

  it("rejects the same tenant counted twice", () => {
    expect(hasEnoughSources([acme, { ...acme }])).toBe(false);
  });

  it("accepts a lesson seen across two different tenants", () => {
    expect(hasEnoughSources([acme, globex])).toBe(true);
  });
});
