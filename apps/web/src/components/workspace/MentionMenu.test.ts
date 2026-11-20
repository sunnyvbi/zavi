
import { describe, it, expect } from "vitest";
import { filterChannelMentions, placementFor } from "./MentionMenu";

describe("filterChannelMentions", () => {
  it("lists every channel on a bare @", () => {
    expect(filterChannelMentions("").length).toBeGreaterThanOrEqual(17);
  });

  it("matches on slug", () => {
    const slugs = filterChannelMentions("meta").map((c) => c.executor);
    expect(slugs).toContain("meta_ads");
  });

  it("matches on display name where the slug would miss", () => {
    const byName = filterChannelMentions("email").map((c) => c.executor);
    expect(byName).toContain("email_marketing");
  });

  it("is case-insensitive and trims", () => {
    expect(filterChannelMentions("  SEO ").map((c) => c.executor)).toContain(
      "seo",
    );
  });

  it("returns nothing for a name no channel carries", () => {
    for (const retired of ["performance-marketer", "seo-geo", "growth-lead"]) {
      expect(filterChannelMentions(retired)).toEqual([]);
    }
  });
});

describe("placementFor", () => {
  it("opens upward and fills the space above, capped", () => {
    const p = placementFor({ top: 600, bottom: 660, ceiling: 0, floor: 800 });
    expect(p.below).toBe(false);
    expect(p.maxH).toBe(320);
  });

  it("never sizes past a clipping ancestor, so the first row stays reachable", () => {
    const p = placementFor({ top: 300, bottom: 360, ceiling: 56, floor: 800 });
    expect(p.maxH).toBe(232);
  });

  it("flips below when the space above is tight and below is roomier", () => {
    const p = placementFor({ top: 100, bottom: 160, ceiling: 0, floor: 800 });
    expect(p.below).toBe(true);
    expect(p.maxH).toBe(320);
  });

  it("with no room on either side it takes the roomier one and no more", () => {
    const p = placementFor({ top: 102, bottom: 140, ceiling: 0, floor: 212 });
    expect(p.below).toBe(false);
    expect(p.maxH).toBe(90);
  });

  it("never returns a negative height", () => {
    expect(placementFor({ top: 10, bottom: 70, ceiling: 56, floor: 800 }).maxH).toBeGreaterThanOrEqual(0);
  });
});
