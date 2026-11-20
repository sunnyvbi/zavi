import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ stamp: vi.fn(), history: vi.fn(), ads: vi.fn(), heal: vi.fn() }));
vi.mock("../channel-actions", () => ({ switchedChannelForRun: m.stamp, loadChannelHistory: m.history }));
vi.mock("../live-ads", () => ({ loadLiveAdsForRun: m.ads }));
vi.mock("../direct-run", () => ({ healChatRunStamp: m.heal }));
import { loadChannelContextForRun } from "../run-channel-context";
const ctx = { tenant_id: "audit", runId: "audit", trigger: "chat" } as never;
beforeEach(() => { vi.clearAllMocks(); m.history.mockResolvedValue(["OPEN_CARD"]); m.ads.mockResolvedValue(null); });
describe("channel chat audit: missing stamp loses initial context", () => {
  it("loads neither history nor live ads even with a known channel in the payload", async () => {
    m.heal.mockResolvedValue("failed");
    expect(await loadChannelContextForRun(ctx, { channel_slug: "meta_ads" })).toEqual({ history: null, liveAds: null, historyUnavailable: true });
    expect(m.history).not.toHaveBeenCalled();
    expect(m.ads).not.toHaveBeenCalled();
  });
  it("uses the healed stamp without reading it again", async () => {
    m.heal.mockResolvedValue("meta_ads");
    await loadChannelContextForRun(ctx, { channel_slug: "meta_ads" });
    expect(m.stamp).not.toHaveBeenCalled();
    expect(m.history).toHaveBeenCalledTimes(1);
  });
  it("marks a thrown stamp lookup unavailable instead of implying no history", async () => {
    m.heal.mockRejectedValueOnce(new Error("database unavailable"));
    expect(await loadChannelContextForRun(ctx, {})).toEqual({ history: null, liveAds: null, historyUnavailable: true });
  });
});

it.each(["linkedin_organic", "x_ads", "tiktok_organic", "tiktok_ads", "chatgpt_ads", "instagram_organic", "x_organic"])("%s heals before loading history on chat and approval continuation", async slug => {
  m.heal.mockResolvedValue(slug);
  await loadChannelContextForRun(ctx, { channel_slug: "other_channel", internal_resume_turn: "Continue" });
  expect(m.history).toHaveBeenCalledWith("audit", slug, "audit");
  expect(m.ads).toHaveBeenCalledWith(ctx, expect.objectContaining({ channel_slug: slug }), expect.any(Object));
});

it("a general CTR definition skips the ad account read but keeps channel history", async () => {
  m.heal.mockResolvedValue("meta_ads");
  await loadChannelContextForRun(ctx, { current_user_text_raw: "What does CTR mean?" });
  expect(m.history).toHaveBeenCalled();
  expect(m.ads).not.toHaveBeenCalled();
});

it.each(["What is our CTR?", "What does CTR mean for my campaign?", "Draft ad copy", "How are my campaigns doing?"])("keeps ad grounding for %s", async text => {
  m.heal.mockResolvedValue("meta_ads");
  await loadChannelContextForRun(ctx, { current_user_text_raw: text });
  expect(m.ads).toHaveBeenCalled();
});
