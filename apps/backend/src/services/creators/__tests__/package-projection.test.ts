import { describe, it, expect } from "vitest";
import { projectPackage, projectPackages } from "../creator-fields";

const base = { id: "p1", title: "Reels", price_cents: 20_000, delivery_days: 5 };

describe("projectPackage", () => {
  it("projects a UGC video package without any post fields", () => {
    const p = projectPackage({ ...base, kind: "ugc_video", video_count: 3, platform: "tiktok", post_type: "reel", stays_up_days: 30, post_count: 4, ad_label_required: true });
    expect(p?.kind).toBe("ugc_video");
    expect(p?.video_count).toBe(3);
    expect(p).not.toHaveProperty("platform");
    expect(p).not.toHaveProperty("post_type");
    expect(p).not.toHaveProperty("stays_up_days");
    expect(p).not.toHaveProperty("post_count");
    expect(p).not.toHaveProperty("ad_label_required");
  });

  it("drops a stored audience_post package instead of showing it to a business", () => {
    expect(projectPackage({ ...base, kind: "audience_post", platform: "tiktok", post_type: "reel", stays_up_days: 30, post_count: 5 })).toBeNull();
    expect(projectPackage({ ...base, kind: "something_else" })).toBeNull();
    expect(
      projectPackages([
        { ...base, id: "a", kind: "audience_post", post_count: 5 },
        { ...base, id: "u", kind: "ugc_video", video_count: 1 },
      ]).map((p) => p.id),
    ).toEqual(["u"]);
  });
});
