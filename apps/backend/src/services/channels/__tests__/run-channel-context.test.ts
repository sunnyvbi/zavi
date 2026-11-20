import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  stamped: vi.fn(async (): Promise<string | null> => null),
  history: vi.fn(async (): Promise<string[]> => []),
  liveAds: vi.fn(async (): Promise<null> => null),
}));

vi.mock("../channel-actions", async (orig) => ({
  ...(await orig<typeof import("../channel-actions")>()),
  switchedChannelForRun: m.stamped,
  loadChannelHistory: m.history,
}));
vi.mock("../live-ads", async (orig) => ({
  ...(await orig<typeof import("../live-ads")>()),
  loadLiveAdsForRun: m.liveAds,
}));

import { loadChannelContextForRun } from "../run-channel-context";

const REJECTED = 'Rejected 2026-10-07: "Raise SF - Leads to $272 a day" (note: not this month)';

beforeEach(() => {
  m.stamped.mockReset();
  m.history.mockReset();
  m.liveAds.mockReset();
  m.liveAds.mockResolvedValue(null);
});

describe("channel history for any run stamped with a channel", () => {
  it("an a2a run stamped meta_ads with a rejected card gets channel_history, and its live ads are read", async () => {
    m.stamped.mockResolvedValue("meta_ads");
    m.history.mockResolvedValue([REJECTED]);
    const ctx = { tenant_id: "t-1", runId: "run-a2a", trigger: "a2a" as const };
    const payload = { intent: "Test a $30/day ad set", cgo_brief: "..." };
    const out = await loadChannelContextForRun(ctx, payload);
    expect(out.history).toEqual([REJECTED]);
    expect(m.history).toHaveBeenCalledWith("t-1", "meta_ads", "run-a2a");
    expect(m.liveAds).toHaveBeenCalledWith(ctx, { ...payload, channel_slug: "meta_ads" }, expect.objectContaining({ stampedSlug: expect.any(Function) }));
  });

  it("an unstamped run that is not a channel recipe reads nothing else", async () => {
    m.stamped.mockResolvedValue(null);
    const out = await loadChannelContextForRun({ tenant_id: "t-1", runId: "run-chat", trigger: "a2a" as const }, { intent: "x" });
    expect(out).toEqual({ history: null, liveAds: null });
    expect(m.history).not.toHaveBeenCalled();
    expect(m.liveAds).not.toHaveBeenCalled();
  });

  it("a stamp read that fails costs the history, never the run", async () => {
    m.stamped.mockRejectedValue(new Error("db down"));
    await expect(loadChannelContextForRun({ tenant_id: "t-1", runId: "run-h", trigger: "handoff" as const }, {})).resolves.toEqual({ history: null, liveAds: null, historyUnavailable: true });
  });

  it("a channel recipe run keeps reading as before, with its own payload", async () => {
    m.stamped.mockResolvedValue("meta_ads");
    m.history.mockResolvedValue([REJECTED]);
    const ctx = { tenant_id: "t-1", runId: "run-r", trigger: "channel_recipe" as const };
    const payload = { channel_slug: "meta_ads", router: [] };
    const out = await loadChannelContextForRun(ctx, payload);
    expect(out.history).toEqual([REJECTED]);
    expect(m.liveAds).toHaveBeenCalledWith(ctx, payload, {});
  });
});
