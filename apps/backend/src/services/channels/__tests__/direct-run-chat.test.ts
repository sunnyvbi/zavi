import { describe, it, expect, vi, beforeEach } from "vitest";

const T1 = "00000000-0000-0000-0000-000000000001";

const m = vi.hoisted(() => ({
  locked: new Set<string>(),
  budget: vi.fn(),
}));

vi.mock("@/services/tenant-client", () => ({ asTenantId: (s: string) => s, tenantRpc: vi.fn() }));
vi.mock("@/services/channels/budget", () => ({
  channelBudgetAllows: m.budget,
  CAP_REACHED_MESSAGE: "cap reached",
}));
vi.mock("@/services/channels/lock", () => ({
  isChannelLocked: vi.fn(async (slug: string) => m.locked.has(slug)),
  comingSoonMessage: (name: string) => `${name} is coming soon`,
}));
vi.mock("@/services/agents/credits", () => ({ reserveEstimateFor: () => 10 }));
vi.mock("@/services/analytics/action-events", () => ({ trackChannelRunStarted: vi.fn() }));
vi.mock("@/services/growth/preview-plan", () => ({ channelPlanLock: vi.fn(async () => null) }));
const stop = vi.hoisted(() => ({ value: false as boolean | null }));
vi.mock("@/services/growth/channel-stopped", () => ({ readChannelStopped: vi.fn(async () => stop.value) }));

import { admitDirectChannelRun } from "@/services/channels/direct-run";

beforeEach(() => {
  m.locked.clear();
  stop.value = false;
  m.budget.mockReset().mockResolvedValue({ allowed: false, reason: "cap_reached", spent_30d: 2000 });
});

describe("admitDirectChannelRun — chat", () => {
  it("a chat turn is admitted with the cap reached, and the cap is never read", async () => {
    expect(await admitDirectChannelRun(T1, "meta_ads", undefined, { chat: true })).toMatchObject({
      allowed: true,
      channel_slug: "meta_ads",
    });
    expect(m.budget).not.toHaveBeenCalled();
  });

  it("a handoff (not chat) with the cap reached is still refused", async () => {
    expect(await admitDirectChannelRun(T1, "meta_ads")).toMatchObject({ allowed: false, reason: "budget" });
  });

  it("a chat with a Coming soon channel is still refused", async () => {
    m.locked.add("meta_ads");
    expect(await admitDirectChannelRun(T1, "meta_ads", undefined, { chat: true })).toMatchObject({
      allowed: false,
      reason: "coming_soon",
    });
  });
});

describe("admitDirectChannelRun — a channel the founder stopped (Growth J6)", () => {
  it("an agent's handoff or ask is refused, and so is an unreadable stop", async () => {
    m.budget.mockResolvedValue({ allowed: true });
    for (const value of [true, null]) {
      stop.value = value;
      expect(await admitDirectChannelRun(T1, "meta_ads")).toMatchObject({ allowed: false, reason: "founder_stopped" });
    }
    expect(m.budget).not.toHaveBeenCalled();
  });

  it("the founder's own chat ask still runs it", async () => {
    stop.value = true;
    expect(await admitDirectChannelRun(T1, "meta_ads", undefined, { chat: true })).toMatchObject({ allowed: true, channel_slug: "meta_ads" });
  });
});

describe("admitDirectChannelRun — a parallel batch (handoff_parallel)", () => {
  it("checks the cap with the credits already admitted earlier in the batch", async () => {
    m.budget.mockResolvedValue({ allowed: true });
    await admitDirectChannelRun(T1, "meta_ads", undefined, { accepted: 30 });
    expect(m.budget).toHaveBeenCalledWith(T1, 40);
  });
});
