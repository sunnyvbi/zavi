import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ actions: [] as unknown[], notes: [] as unknown[] }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({
    from: (table: string) => {
      const rows = table === "channel_actions" ? state.actions : state.notes;
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "neq", "not", "gte", "order"]) q[m] = () => q;
      q.limit = async () => ({ data: rows, error: null });
      return q;
    },
  }),
  tenantRpc: vi.fn(),
}));

import { envelopeFollowUps } from "@/services/growth/ad-plan-yes";

describe("envelopeFollowUps", () => {
  it("one line per failed founder-approved ad, with its reason (the Add $X link)", async () => {
    state.actions = [{ id: "a1", channel_slug: "chatgpt_ads", exec_result: { code: "chatgpt_ads_wallet_short", error: "Add $58.00 to start: https://checkout.stripe.com/x" } }];
    state.notes = [];
    expect(await envelopeFollowUps("t1", new Date())).toEqual([{ action_id: "a1", channel_slug: "chatgpt_ads", text: "Your ChatGPT test did not start: Add $58.00 to start: https://checkout.stripe.com/x" }]);
  });
  it("a line already in a recent note is not told again", async () => {
    state.notes = [{ items: [{ text: "Your ChatGPT test did not start: Add $58.00 to start: https://checkout.stripe.com/x" }] }];
    expect(await envelopeFollowUps("t1", new Date())).toEqual([]);
  });
});
