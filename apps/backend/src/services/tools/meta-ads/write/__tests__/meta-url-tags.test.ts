
import { describe, it, expect } from "vitest";
import { metaUrlTags, shapeLaunchCreativeRequest } from "../_launch-shapers";
import { createAdBodySchema, createCreativeBodySchema } from "../_decision-bodies";

const TAG = "zv1234567890";
const params = (tags: string) => Object.fromEntries(tags.split("&").map((p) => p.split("=")));

describe("metaUrlTags", () => {
  it("tags a plain link with source, medium, the launch tag and Meta's ad and ad set ids", () => {
    expect(params(metaUrlTags({ link_url: "https://x.com/p", tag: TAG }))).toEqual({
      utm_source: "facebook",
      utm_medium: "paid_social",
      utm_campaign: TAG,
      utm_content: "{{ad.id}}",
      utm_term: "{{adset.id}}",
    });
  });

  it("never repeats a key the link already sets, and keeps the launch tag as zavi_launch", () => {
    const tags = metaUrlTags({ link_url: "https://x.com/?utm_source=meta&utm_campaign=fall&utm_content=a1", tag: TAG });
    expect(params(tags)).toEqual({ utm_medium: "paid_social", zavi_launch: TAG, utm_term: "{{adset.id}}" });
    expect(tags).not.toContain("utm_campaign");
  });

  it("is what the launch creative sends", () => {
    const base = {
      ad_account_id: "act_1",
      page_id: "77",
      name: "n",
      primary_text: "p",
      headline: "h",
      cta: "LEARN_MORE" as const,
      image_url: "https://x.com/i.png",
      tag: TAG,
    };
    const plain = shapeLaunchCreativeRequest({ ...base, link_url: "https://x.com/?utm_source=ig" });
    expect(params(plain.params.url_tags)).toMatchObject({ utm_campaign: TAG });
    expect(params(plain.params.url_tags).utm_source).toBeUndefined();
    const own = shapeLaunchCreativeRequest({ ...base, link_url: "https://x.com/?utm_campaign=fall" });
    expect(params(own.params.url_tags)).toMatchObject({ zavi_launch: TAG });
    expect(params(own.params.url_tags).utm_campaign).toBeUndefined();
  });
});

describe("a link that brings its own zavi_launch", () => {
  const ad = { ad_set_id: "2220001", image_url: "https://x.com/i.png", primary_text: "p", headline: "h", source: "zavi_generated", rationale: "r" };

  it("is refused, since the ad's own tag could not ride on it", () => {
    expect(createAdBodySchema.safeParse({ ...ad, link_url: "https://x.com/?utm_campaign=fall" }).success).toBe(true);
    const r = createAdBodySchema.safeParse({ ...ad, link_url: "https://x.com/?utm_campaign=fall&zavi_launch=old" });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/zavi_launch/);
    const c = createCreativeBodySchema.safeParse({ name: "n", primary_text: "p", headline: "h", link_url: "https://x.com/?zavi_launch=old", image_url: "https://x.com/i.png" });
    expect(c.success).toBe(false);
  });
});
