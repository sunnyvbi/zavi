
import { describe, it, expect } from "vitest";
import { TENANT_SLUG_RE, normalizeTenantSlug } from "../activate";

describe("tenant slug boundary", () => {
  describe("TENANT_SLUG_RE (what the route accepts)", () => {
    it("accepts a plain slug and single internal hyphens", () => {
      expect(TENANT_SLUG_RE.test("acme")).toBe(true);
      expect(TENANT_SLUG_RE.test("acme-labs")).toBe(true);
      expect(TENANT_SLUG_RE.test("upcar-ai")).toBe(true);
      expect(TENANT_SLUG_RE.test("a1-b2-c3")).toBe(true);
    });

    it("rejects the double hyphen the chatgpt_ads boundary depends on", () => {
      expect(TENANT_SLUG_RE.test("acme--labs")).toBe(false);
      expect(TENANT_SLUG_RE.test("acme---labs")).toBe(false);
    });

    it("rejects edge hyphens and non-slug characters", () => {
      for (const bad of ["-acme", "acme-", "-", "ACME", "acme labs", "acme_labs", "acme.labs", ""]) {
        expect(TENANT_SLUG_RE.test(bad)).toBe(false);
      }
    });
  });

  describe("normalizeTenantSlug (what the route generates)", () => {
    it("collapses hyphen runs, so a spaced-out company name cannot mint a `--` slug", () => {
      expect(normalizeTenantSlug("Acme - Labs")).toBe("acme-labs");
      expect(normalizeTenantSlug("Acme  --  Labs")).toBe("acme-labs");
      expect(normalizeTenantSlug("Acme, Inc. - Labs")).toBe("acme-inc-labs");
    });

    it("never returns a slug the route would reject", () => {
      for (const raw of [
        "Acme - Labs",
        "  Acme  ",
        "--Acme--",
        "Acme & Co",
        "Über Acme",
        "123",
        "!!!",
        "",
      ]) {
        expect(TENANT_SLUG_RE.test(normalizeTenantSlug(raw))).toBe(true);
      }
    });

    it("falls back to a usable slug rather than an empty prefix", () => {
      expect(normalizeTenantSlug("!!!")).toBe("company");
      expect(normalizeTenantSlug("")).toBe("company");
    });
  });
});

describe("what the deployed web signup actually sends", () => {
  const webSlugify = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32);

  it("can end in a hyphen after truncation", () => {
    expect(webSlugify("Advanced Materials Research Lab Group")).toBe(
      "advanced-materials-research-lab-",
    );
  });

  it("is still accepted by the route, and normalizes to a slug the boundary allows", () => {
    const sent = webSlugify("Advanced Materials Research Lab Group");
    expect(/^[a-z0-9-]+$/.test(sent)).toBe(true);
    const stored = normalizeTenantSlug(sent);
    expect(stored).toBe("advanced-materials-research-lab");
    expect(TENANT_SLUG_RE.test(stored)).toBe(true);
  });
});
