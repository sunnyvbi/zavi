import { describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/services/sites/site-design-store", () => ({ siteDesignStore: () => ({ get: store.get }) }));

import { logoDesignContextFrom, realSiteDirectEditDeps } from "../site-direct-edits";

const BRIEF = {
  industry: "Indian catering",
  audience: "couples planning a wedding in Austin",
  positioning: "home-style food, served at scale",
  facts: ["wedding catering", "office lunches", "festival boxes"],
};

describe("the icon designer gets the business, not just the site name", () => {
  it("the live deps read the site's design brief into the designer's context", async () => {
    store.get.mockResolvedValueOnce({ brief: BRIEF });
    const ctx = await realSiteDirectEditDeps().designContext!("t1", "s1");
    expect(store.get).toHaveBeenCalledWith("t1", "s1");
    expect(ctx).toEqual({
      business: "Indian catering, offering wedding catering, office lunches",
      industry: "Indian catering",
      audience: "couples planning a wedding in Austin",
      positioning: "home-style food, served at scale",
    });
  });

  it("a site with no brief gives no context, so the designer falls back to the site name as before", async () => {
    store.get.mockResolvedValueOnce(null);
    expect(await realSiteDirectEditDeps().designContext!("t1", "s1")).toBeNull();
    expect(logoDesignContextFrom({})).toBeNull();
    expect(logoDesignContextFrom("not a brief")).toBeNull();
  });

  it("brief text is bounded and flattened before it reaches a prompt", () => {
    const ctx = logoDesignContextFrom({ industry: "x".repeat(500), audience: "a\n\n  b", facts: ["y".repeat(500)] })!;
    expect(ctx.industry!.length).toBe(80);
    expect(ctx.audience).toBe("a b");
    expect(ctx.business.length).toBeLessThanOrEqual(80 + ", offering ".length + 90);
  });
});
