import { describe, expect, it } from "vitest";
import { seoFixPagePrecheck } from "../top-actions";
import type { SitePrDeps } from "../site-pr";

const deps = (
  over: Partial<{ allowed: boolean; repo: string; website: string | null }> = {},
): Pick<SitePrDeps, "engineerAllowed" | "resolveRepo" | "website"> => ({
  engineerAllowed: async () => ({ allowed: over.allowed ?? true, required_tier: "pro" }),
  resolveRepo: async () => over.repo ?? "acme/site",
  website: async () => (over.website === undefined ? "https://www.example.com" : over.website),
});

describe("seoFixPagePrecheck", () => {
  it("refuses a page off the company's site before the run reserves credits", async () => {
    const r = await seoFixPagePrecheck("t1", { page_url: "https://other.example.org/x" }, deps());
    expect(r).toContain("company's own website");
  });

  it("lets a page on the company's site through", async () => {
    expect(await seoFixPagePrecheck("t1", { page_url: "https://www.example.com/pricing" }, deps())).toBeNull();
  });

  it("leaves an unknown website to the run, and keeps the plan and repo checks first", async () => {
    expect(await seoFixPagePrecheck("t1", { page_url: "https://other.example.org/x" }, deps({ website: null }))).toBeNull();
    expect(await seoFixPagePrecheck("t1", { page_url: "https://www.example.com/x" }, deps({ allowed: false }))).toBe(
      "Fix a page needs the Pro plan.",
    );
    expect(await seoFixPagePrecheck("t1", { page_url: "https://www.example.com/x" }, deps({ repo: "" }))).toContain("GitHub repo");
  });
});
