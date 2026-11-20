import { describe, expect, it } from "vitest";
import { shortTerms, termsLine } from "../CreatorCard";

const pkg = {
  id: "p", kind: "ugc_video" as const, title: "t", price_cents: 1000, business_total_cents: 1100, delivery_days: 7,
  video_count: 1, video_length_seconds: 30, ad_rights_days: 90,
};

describe("termsLine counts what the business buys", () => {
  it("a UGC package reads video_count", () => {
    expect(termsLine({ ...pkg, video_count: 3 })).toBe("3 UGC videos · 30s · ad rights 90 days · delivered in 7 days · 2 rounds of changes");
  });
  it("no video_count reads as one video", () => {
    expect(termsLine({ ...pkg, video_count: null }).split(" · ")[0]).toBe("1 UGC video");
  });
  it("leaves out a length or ad rights it does not have", () => {
    expect(termsLine({ ...pkg, video_length_seconds: null, ad_rights_days: null })).toBe("1 UGC video · delivered in 7 days · 2 rounds of changes");
  });
  it("never reads as a post on the creator's account", () => {
    const legacy = { ...pkg, platform: "tiktok", post_type: "video", stays_up_days: 90, post_count: 5 } as unknown as typeof pkg;
    expect(termsLine(legacy)).not.toMatch(/stays up|TikTok|post/i);
    expect(shortTerms(legacy)).not.toMatch(/stays up/);
  });
});
