import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/agents/channel-agents", () => ({
  channelForAgent: (slug: string) => (slug === "blog" ? { channel_slug: "blog", name: "Blog" } : null),
  listChannelAgents: () => [],
}));
vi.mock("@/services/channels/lock", () => ({ isChannelLocked: async () => false, comingSoonMessage: (n: string) => n }));
const budget = vi.fn();
vi.mock("@/services/channels/budget", () => ({ channelBudgetAllows: (...a: unknown[]) => budget(...a), CAP_REACHED_MESSAGE: "cap" }));
vi.mock("@/services/growth/preview-plan", () => ({ channelPlanLock: async () => null }));

import { admitDirectChannelRun, refusedHandoffPayload } from "@/services/channels/direct-run";

describe("admitDirectChannelRun on a retired channel", () => {
  it("refuses @blog before reading the budget", async () => {
    const a = await admitDirectChannelRun("t1", "blog");
    expect(a).toMatchObject({ allowed: false, reason: "retired" });
    expect(budget).not.toHaveBeenCalled();
  });

  it("tells a handing-off agent the channel is retired, not out of budget", () => {
    const p = refusedHandoffPayload({ allowed: false, reason: "retired", message: "m" });
    expect(p.error).toBe("channel_retired");
    expect(p.message).toBe("m");
  });
});
