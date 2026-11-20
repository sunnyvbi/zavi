
import { describe, it, expect, vi, beforeEach } from "vitest";

const rpc = vi.fn();
vi.mock("@/services/growth/channel-stopped", () => ({ readChannelStopped: async () => false }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantRpc: (t: string, n: string, a: Record<string, unknown>) => rpc(t, n, a),
}));
const claim = vi.fn();
vi.mock("@/services/channels/lock", () => ({ isChannelLocked: async () => false, comingSoonMessage: (n: string) => n }));
vi.mock("@/services/channels/budget", () => ({ CAP_REACHED_MESSAGE: "cap reached" }));
vi.mock("@/services/channels/claim", () => ({
  claimChannelRun: (...a: unknown[]) => claim(...a),
  settleChannelRunClaim: vi.fn(async () => undefined),
  releaseChannelRunClaim: vi.fn(async () => undefined),
}));

import { runChannelRecipe } from "@/services/channels/engine";
import { TOP_ACTIONS } from "@/services/channels/top-actions";

const TID = "33333333-3333-3333-3333-333333333333";
const enqueue = vi.fn();
const inputs = { about: "Halloween deal", link: "https://x.example/h", goal: "visit", placement: "ig", daily_budget: 20 };
const topAction = { key: "create_new_ad", inputs, instruction: "do it", by: "user-1" };

beforeEach(() => {
  rpc.mockReset().mockResolvedValue({ data: true, error: null });
  claim.mockReset().mockResolvedValue({ kind: "claimed", claim_id: "c1" });
  enqueue.mockReset().mockResolvedValue({ run_id: "run-1" });
});

describe("runChannelRecipe in top-action mode", () => {
  it("carries the action, not the recipe, and reserves the action's estimate", async () => {
    const r = await runChannelRecipe(TID, "meta_ads", { enqueue }, undefined, undefined, "req-12345678", undefined, topAction);
    expect(r).toMatchObject({ ok: true, run_id: "run-1" });
    const payload = enqueue.mock.calls[0][0].payload as Record<string, unknown>;
    expect(payload.top_action).toEqual(topAction);
    expect(payload.recipe_body).toBeUndefined();
    expect(payload.router).toEqual([]);
    expect(payload.channel_slug).toBe("meta_ads");
    expect(claim.mock.calls[0][3]).toBe(TOP_ACTIONS.meta_ads.create_new_ad.reserve_credits);
  });

  it("drops a top_action passed through extra: a normal run stays a normal run", async () => {
    await runChannelRecipe(TID, "meta_ads", { enqueue }, undefined, { top_action: topAction, standing_order: "x" });
    const payload = enqueue.mock.calls[0][0].payload as Record<string, unknown>;
    expect(payload.top_action).toBeUndefined();
    expect(typeof payload.recipe_body).toBe("string");
    expect(payload.standing_order).toBe("x");
  });

  it("refuses an action the channel does not have", async () => {
    await expect(
      runChannelRecipe(TID, "meta_ads", { enqueue }, undefined, undefined, "req-12345678", undefined, { ...topAction, key: "nope" }),
    ).rejects.toThrow(/unknown top action/);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
