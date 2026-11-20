import { describe, expect, it, vi } from "vitest";

const cfg = vi.hoisted(() => ({ blob: {} as Record<string, unknown>, fail: false }));
vi.mock("@/services/tenant-client", () => ({
  globalClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => (cfg.fail ? { data: null, error: { message: "down" } } : { data: { blob: cfg.blob }, error: null }) }) }) }) }),
}));
import { assertSpendWritesOn } from "../lock";

describe("assertSpendWritesOn", () => {
  it("open channel: passes", async () => {
    cfg.fail = false; cfg.blob = {};
    await expect(assertSpendWritesOn("tiktok_ads", "TikTok Ads", "tiktok_ads")).resolves.toBeUndefined();
  });
  it("locked channel: refuses with the platform's code", async () => {
    cfg.fail = false; cfg.blob = { locked_channel_slugs: ["tiktok_ads"] };
    await expect(assertSpendWritesOn("tiktok_ads", "TikTok Ads", "tiktok_ads")).rejects.toMatchObject({ code: "tiktok_ads_write_disabled" });
    await expect(assertSpendWritesOn("reddit_ads", "Reddit Ads", "reddit_ads")).resolves.toBeUndefined();
  });
  it("unreadable config: refuses (fail closed)", async () => {
    cfg.fail = true;
    await expect(assertSpendWritesOn("tiktok_ads", "TikTok Ads", "tiktok_ads")).rejects.toMatchObject({ code: "tiktok_ads_write_disabled" });
  });
});
