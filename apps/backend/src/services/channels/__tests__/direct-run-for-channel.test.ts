import { describe, it, expect, vi, beforeEach } from "vitest";

const T1 = "00000000-0000-0000-0000-000000000001";

const m = vi.hoisted(() => ({
  locked: new Set<string>(),
  planLock: vi.fn(),
}));

vi.mock("@/services/growth/channel-stopped", () => ({ readChannelStopped: async () => false }));
vi.mock("@/services/tenant-client", () => ({ asTenantId: (s: string) => s, tenantRpc: vi.fn() }));
vi.mock("@/services/channels/budget", () => ({
  channelBudgetAllows: vi.fn(async () => ({ allowed: true })),
  CAP_REACHED_MESSAGE: "cap reached",
}));
vi.mock("@/services/channels/lock", () => ({
  isChannelLocked: vi.fn(async (slug: string) => m.locked.has(slug)),
  comingSoonMessage: (name: string) => `${name} is coming soon`,
}));
vi.mock("@/services/agents/credits", () => ({ reserveEstimateFor: () => 10 }));
vi.mock("@/services/analytics/action-events", () => ({ trackChannelRunStarted: vi.fn() }));
vi.mock("@/services/growth/preview-plan", () => ({ channelPlanLock: m.planLock }));

import { admitDirectChannelRun } from "@/services/channels/direct-run";

beforeEach(() => {
  m.locked.clear();
  m.planLock.mockReset().mockResolvedValue(null);
});

describe("admitDirectChannelRun — for_channel", () => {
  it("admits an AI video run for YouTube as the YouTube channel's", async () => {
    expect(await admitDirectChannelRun(T1, "generated_video", "youtube_organic")).toMatchObject({
      allowed: true,
      channel_slug: "youtube_organic",
    });
    expect(m.planLock).toHaveBeenCalledWith(T1, "youtube_organic");
  });

  it("without for_channel the run stays on AI UGC Videos", async () => {
    expect(await admitDirectChannelRun(T1, "generated_video")).toMatchObject({ allowed: true, channel_slug: "generated_video" });
    expect(m.planLock).not.toHaveBeenCalled();
  });

  it("a plan without YouTube keeps the card on AI UGC Videos, where it can be approved", async () => {
    m.planLock.mockResolvedValue({ slug: "youtube_organic", required_tier: "growth" });
    expect(await admitDirectChannelRun(T1, "generated_video", "youtube_organic")).toMatchObject({
      allowed: true,
      channel_slug: "generated_video",
    });
  });

  it("a locked YouTube channel refuses the run as coming soon", async () => {
    m.locked.add("youtube_organic");
    expect(await admitDirectChannelRun(T1, "generated_video", "youtube_organic")).toMatchObject({
      allowed: false,
      reason: "coming_soon",
    });
  });

  it("ignores a for_channel that is not an allowed pair", async () => {
    expect(await admitDirectChannelRun(T1, "meta_ads", "youtube_organic")).toMatchObject({ allowed: true, channel_slug: "meta_ads" });
    expect(await admitDirectChannelRun(T1, "generated_video", "meta_ads")).toMatchObject({
      allowed: true,
      channel_slug: "generated_video",
    });
    expect(m.planLock).not.toHaveBeenCalled();
  });
});
