import { describe, expect, it } from "vitest";
import type { AdReviewEditField } from "@zavi/shared";
import { adButtonChoices, adEditGroups, adTextLimit } from "./adEditSections";

const f = (key: string, label: string, kind: AdReviewEditField["kind"], value = ""): AdReviewEditField => ({ key, label, kind, value, optional: false });

describe("ad edit sections", () => {
  it("puts each field under the section a person looks for it in", () => {
    const groups = adEditGroups([
      f("ad.primary_text", "Ad text", "multiline"),
      f("ad.image_url", "Image URL", "url"),
      f("ad.link_url", "Destination", "url"),
      f("ad.cta", "Call to action", "text", "LEARN_MORE"),
      f("ad.headline", "Headline", "text"),
      f("end_time", "Ends (UTC)", "date"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.sections.map((s) => [s.title, s.fields.map((x) => x.label)])).toEqual([
      ["Image or video", ["Image URL"]],
      ["Words", ["Ad text", "Headline"]],
      ["Link and button", ["Destination", "Call to action"]],
      ["Schedule", ["Ends (UTC)"]],
    ]);
  });

  it("splits a campaign's ads into one group each", () => {
    const groups = adEditGroups([f("ads.0.headline", "Headline · Ad 1", "text"), f("ads.1.headline", "Headline · Ad 2", "text"), f("campaign.end_time", "Ends (UTC)", "date")]);
    expect(groups.map((g) => g.ad)).toEqual(["Ad 1", "Ad 2", null]);
  });

  it("counts Meta text against its limits and offers Meta's buttons", () => {
    expect(adTextLimit("meta_ads", f("ad.primary_text", "Ad text", "multiline"))).toBe(125);
    expect(adTextLimit("meta_ads", f("ad.headline", "Headline", "text"))).toBe(40);
    expect(adTextLimit("google_ads", f("ad.headlines", "Headlines", "lines"))).toBeNull();
    const choices = adButtonChoices("meta_ads", f("ad.cta", "Call to action", "text", "LEARN_MORE"))!;
    expect(choices.find((c) => c.value === "LEARN_MORE")?.label).toBe("Learn more");
  });

  it("keeps a button value Zavi wrote even when it is not in the list, and types a button where there is no list", () => {
    expect(adButtonChoices("tiktok_ads", f("call_to_action", "Call to action", "text", "WATCH_NOW"))![0]).toEqual({ value: "WATCH_NOW", label: "Watch now" });
    expect(adButtonChoices("google_ads", f("ad.cta", "Call to action", "text"))).toBeNull();
  });
});
