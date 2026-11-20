import { describe, expect, it } from "vitest";
import type { HumanBrief } from "@/components/humans/humanTypes";
import { angleSource, budgetSentence, prefillFor } from "./BriefDrawer";

const brief = (over: Partial<HumanBrief>): HumanBrief => ({
  id: "b",
  title: "Spring launch",
  utm_campaign: null,
  status: "draft",
  deliverables: 1,
  created_at: "2026-09-20T00:00:00Z",
  match_count: null,
  application_count: 0,
  engagement_count: 0,
  angle: "A real morning routine",
  hook: "The cup on the counter",
  ...over,
});

describe("a brief started from a video channel's card", () => {
  it("prefills a fresh budget estimate, and the angle and hook of this channel's newest written brief", () => {
    const source = angleSource(
      [
        brief({ id: "old", created_at: "2026-09-01T00:00:00Z", angle: "Old angle", source_channel: "meta_ads" }),
        brief({ id: "new", title: "Newest", created_at: "2026-09-25T00:00:00Z", source_channel: "meta_ads" }),
        brief({ id: "blank", created_at: "2026-09-26T00:00:00Z", angle: "", hook: "", source_channel: "meta_ads" }),
        brief({ id: "other", title: "Unrelated", created_at: "2026-09-27T00:00:00Z", angle: "Another product" }),
      ],
      "meta_ads",
    );
    expect(source?.title).toBe("Newest");
    const d = prefillFor("meta_ads", { budget: { creator: "Maya Films", price_cents: 10000, package_title: "1 video for your ads" }, source });
    expect(d.budget).toBe("100");
    expect(d.angle).toBe("A real morning routine");
    expect(d.hook).toBe("The cup on the counter");
  });

  it("leaves angle and hook empty when no brief came from this channel", () => {
    const source = angleSource([brief({ id: "other", angle: "Another product" }), brief({ id: "tt", source_channel: "tiktok_ads" })], "meta_ads");
    expect(source).toBeNull();
    const d = prefillFor("meta_ads", { budget: null, source });
    expect(d.angle).toBe("");
    expect(d.hook).toBe("");
  });

  it("the banner names the package the budget came from, and says nothing without one", () => {
    const sentence = budgetSentence({ creator: "Maya Films", price_cents: 15000, package_title: "1 video for your ads" });
    expect(sentence).toContain('Maya Films\'s "1 video for your ads" package ($150)');
    expect(sentence).toContain("10% fee");
    expect(sentence).toContain("budget estimate");
    expect(sentence).not.toContain("cheapest");
    expect(budgetSentence(null)).toBeNull();
  });

  it("a multi-video package is priced per video, not as one video", () => {
    const budget = { creator: "Leo", price_cents: 30000, package_title: "3 videos", video_count: 3 };
    expect(prefillFor("meta_ads", { budget, source: null }).budget).toBe("100");
    expect(budgetSentence(budget)).toContain("$300 for 3 videos, $100 each");
  });
});
