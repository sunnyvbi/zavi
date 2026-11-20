import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/tools/google-ads/_client", () => ({ gadsGetCampaignBudget: vi.fn(), gadsGetAdGroup: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
import { gadsGetAdGroup, gadsGetCampaignBudget } from "@/services/tools/google-ads/_client";
import { logEvent } from "@/services/logging/logEvent";
import { ExpectedToolError } from "@/services/tools/types";
import { assertNotVideoAdGroup, assertNotVideoCampaign, isVideoAdGroupType, videoAdGroupRefusal, videoMutateRefusal } from "../_video-guard";

const budget = gadsGetCampaignBudget as unknown as ReturnType<typeof vi.fn>;
const adGroup = gadsGetAdGroup as unknown as ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
});

describe("VIDEO campaigns are read-only through the API", () => {
  it("refuses a VIDEO campaign at propose time", async () => {
    budget.mockResolvedValueOnce({ channel_type: "VIDEO" });
    await expect(assertNotVideoCampaign("t", "1")).rejects.toMatchObject({ code: "google_ads_video_mutate_unsupported", message: expect.stringMatching(/manual card/) });
  });

  it.each(["DEMAND_GEN", "SEARCH", "PERFORMANCE_MAX", ""])("allows %s", async (channel_type) => {
    budget.mockResolvedValueOnce({ channel_type });
    await expect(assertNotVideoCampaign("t", "1")).resolves.toBeUndefined();
  });

  it("a campaign that does not exist is reported, not swallowed", async () => {
    budget.mockRejectedValueOnce(new ExpectedToolError("google_ads_campaign_not_found", "nope"));
    await expect(assertNotVideoCampaign("t", "1")).rejects.toMatchObject({ code: "google_ads_campaign_not_found" });
  });

  it("a read hiccup fails OPEN (logged): the execution-time refusal is the authority", async () => {
    budget.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(assertNotVideoCampaign("t", "1")).resolves.toBeUndefined();
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ code: "video_guard_read_failed", tenant_id: "t" }));
  });

  it("refuses an ad group of a VIDEO campaign; allows others", async () => {
    adGroup.mockResolvedValueOnce({ type: "VIDEO_BUMPER" });
    await expect(assertNotVideoAdGroup("t", "2")).rejects.toMatchObject({ code: "google_ads_video_mutate_unsupported" });
    adGroup.mockResolvedValueOnce({ type: "SEARCH_STANDARD" });
    await expect(assertNotVideoAdGroup("t", "2")).resolves.toBeUndefined();
  });

  it("the handler refusal is a coded failure", () => {
    const refusal = { ok: false, code: "google_ads_video_mutate_unsupported", error: "Google's Ads API cannot change VIDEO campaigns, so Zavi did not apply this. Nothing in the account changed." };
    expect(videoMutateRefusal("VIDEO")).toEqual(refusal);
    expect(videoMutateRefusal("SEARCH")).toBeNull();
    expect(videoMutateRefusal(undefined)).toBeNull();
    expect(videoAdGroupRefusal("VIDEO_RESPONSIVE")).toEqual(refusal);
    expect(videoAdGroupRefusal("DISPLAY_STANDARD")).toBeNull();
    expect(isVideoAdGroupType(null)).toBe(false);
  });
});
