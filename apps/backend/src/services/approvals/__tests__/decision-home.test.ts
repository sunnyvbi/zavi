import { describe, expect, it } from "vitest";
import {
  CHANNELS,
  GROWTH_CHANNEL_SLUGS,
  decisionHome,
  decisionHomeFromStamp,
  isGrowthChannelSlug,
  isGrowthClass,
} from "@zavi/shared";

describe("isGrowthClass", () => {
  it("is class-only and includes growth-lead (spec Flow 3 decision 3)", () => {
    expect(isGrowthClass("growth-lead.reallocate-budget")).toBe(true);
    expect(isGrowthClass("google_ads.add_keywords")).toBe(true);
    expect(isGrowthClass("channel.recipe_step")).toBe(true);
    expect(isGrowthClass("social.publish.v2")).toBe(true);
    expect(isGrowthClass("pm.ticket")).toBe(false);
    expect(isGrowthClass("")).toBe(false);
    expect(isGrowthClass(null)).toBe(false);
  });
});

describe("decisionHome", () => {
  it("a resolved channel wins, then growth class, else needs_you", () => {
    expect(decisionHome({ decision_class: "seo.publish", channel_slug: "seo" })).toEqual({ kind: "channel", slug: "seo" });
    expect(decisionHome({ decision_class: "google_ads.add_keywords", channel_slug: null })).toEqual({ kind: "growth" });
    for (const c of [
      "chief-of-staff.brief",
      "operator.standing_order",
      "qa.digest",
      "notetaker.write",
      "outbound.send",
      "pm.ticket",
      "engineer.ship-pr",
      "dispute-response.submit-evidence",
    ]) {
      expect(decisionHome({ decision_class: c, channel_slug: null }), c).toEqual({ kind: "needs_you" });
    }
  });

  it("an unknown channel slug is not a channel home", () => {
    expect(decisionHome({ decision_class: "pm.ticket", channel_slug: "nope" })).toEqual({ kind: "needs_you" });
    expect(decisionHome({ decision_class: "meta_ads.x", channel_slug: "nope" })).toEqual({ kind: "growth" });
  });

  it("GROWTH_CHANNEL_SLUGS is the registry, in order", () => {
    expect(GROWTH_CHANNEL_SLUGS).toEqual(CHANNELS.map((c) => c.slug));
    expect(isGrowthChannelSlug(CHANNELS[0].slug)).toBe(true);
    expect(isGrowthChannelSlug(undefined)).toBe(false);
  });
});

describe("decisionHomeFromStamp", () => {
  it("reads the stamped columns", () => {
    expect(decisionHomeFromStamp({ decision_class: "pm.x", home: "channel", home_channel: "seo" })).toEqual({ kind: "channel", slug: "seo" });
    expect(decisionHomeFromStamp({ decision_class: "pm.x", home: "growth" })).toEqual({ kind: "growth" });
    expect(decisionHomeFromStamp({ decision_class: "meta_ads.x", home: "needs_you" })).toEqual({ kind: "needs_you" });
  });
  it("a channel stamp the registry no longer has falls back to the class rule", () => {
    expect(decisionHomeFromStamp({ decision_class: "meta_ads.x", home: "channel", home_channel: "gone" })).toEqual({ kind: "growth" });
    expect(decisionHomeFromStamp({ decision_class: "pm.x", home: "channel", home_channel: "gone" })).toEqual({ kind: "needs_you" });
  });
  it("no stamp (pre-migration row) uses the TS rule", () => {
    expect(decisionHomeFromStamp({ decision_class: "google_ads.x", home: null })).toEqual({ kind: "growth" });
  });
});
