import { describe, expect, it, vi } from "vitest";

const list = vi.fn();
vi.mock("../client", () => ({
  creatorStripeClient: () => ({ refunds: { list } }),
  platformKeyLivemode: () => false,
  creatorPaymentsEnabled: () => true,
  assertLivemodeMatchesKey: () => undefined,
}));

import { listCreatorChargeRefunds, realCreatorWebhookDeps } from "../webhook-events";

describe("listCreatorChargeRefunds", () => {
  it("reads every page of the charge's refunds from Stripe", async () => {
    list.mockReset();
    list
      .mockResolvedValueOnce({ data: [{ id: "re_3", amount: 300, status: "succeeded", metadata: {} }, { id: "re_2", amount: 200, status: "pending", metadata: { zavi_idempotency_key: "k" } }], has_more: true })
      .mockResolvedValueOnce({ data: [{ id: "re_1", amount: 100, status: "succeeded", metadata: null }], has_more: false });
    const out = await listCreatorChargeRefunds("ch_9");
    expect(out).toEqual([
      { id: "re_3", amount: 300, status: "succeeded", metadata: {} },
      { id: "re_2", amount: 200, status: "pending", metadata: { zavi_idempotency_key: "k" } },
      { id: "re_1", amount: 100, status: "succeeded", metadata: null },
    ]);
    expect(list.mock.calls).toEqual([
      [{ charge: "ch_9", limit: 100 }],
      [{ charge: "ch_9", limit: 100, starting_after: "re_2" }],
    ]);
  });

  it("is what the real webhook wiring uses", () => {
    expect(realCreatorWebhookDeps.listChargeRefunds).toBe(listCreatorChargeRefunds);
  });
});
