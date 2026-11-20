
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExpectedToolError } from "@/services/tools/types";

const mocks = vi.hoisted(() => ({
  stripeClient: vi.fn(),
  list: vi.fn(),
}));

vi.mock("@/services/tools/stripe/_client", () => ({
  stripeClient: mocks.stripeClient,
}));

import { readTenantStripeMrr } from "../stripe-mrr";

type FakeItem = {
  quantity?: number;
  price?: {
    currency?: string;
    unit_amount?: number | null;
    recurring?: { interval: string; interval_count?: number } | null;
  };
};

function sub(status: string, items: FakeItem[]): Record<string, unknown> {
  return { id: `sub_${Math.random().toString(36).slice(2)}`, status, items: { data: items } };
}

function item(
  unit_amount: number | null,
  interval: string,
  opts: { interval_count?: number; quantity?: number; currency?: string } = {},
): FakeItem {
  return {
    quantity: opts.quantity ?? 1,
    price: {
      currency: opts.currency ?? "usd",
      unit_amount,
      recurring: { interval, interval_count: opts.interval_count ?? 1 },
    },
  };
}

function fakeStripe(subs: Record<string, unknown>[]): void {
  mocks.list.mockResolvedValue({ data: subs, has_more: false });
  mocks.stripeClient.mockResolvedValue({ subscriptions: { list: mocks.list } });
}

beforeEach(() => {
  mocks.stripeClient.mockReset();
  mocks.list.mockReset();
});

describe("readTenantStripeMrr", () => {
  it("normalization table: month / year / week / day all reduce to exact monthly", async () => {
    fakeStripe([
      sub("active", [item(1200, "month")]),
      sub("active", [item(12000, "year")]),
      sub("active", [item(300, "week")]),
      sub("active", [item(100, "day")]),
    ]);
    const res = await readTenantStripeMrr("t1");
    expect(res).toEqual({
      available: true,
      mrr: 65.42, currency: "usd", mrr_usd: 65.42,
      meta: { sub_count: 4, currency: "usd", excluded_items: [], caveats: [] },
    });
    expect(mocks.list).toHaveBeenCalledWith(
      expect.objectContaining({ status: "active" }),
    );
  });

  it("interval_count divides: quarterly (every 3 months) and quantity multiplies", async () => {
    fakeStripe([
      sub("active", [item(9000, "month", { interval_count: 3 })]),
      sub("active", [item(500, "month", { quantity: 4 })]),
    ]);
    const res = await readTenantStripeMrr("t1");
    expect(res).toEqual({
      available: true,
      mrr: 50, currency: "usd", mrr_usd: 50,
      meta: { sub_count: 2, currency: "usd", excluded_items: [], caveats: [] },
    });
  });

  it("multi-currency subscriptions → {available:false, reason:'multi_currency'}", async () => {
    fakeStripe([
      sub("active", [item(1000, "month", { currency: "usd" })]),
      sub("active", [item(1000, "month", { currency: "eur" })]),
    ]);
    expect(await readTenantStripeMrr("t1")).toEqual({
      available: false,
      reason: "multi_currency",
    });
  });

  it("no Stripe connector → {available:false, reason:'not_connected'}", async () => {
    mocks.stripeClient.mockRejectedValue(
      new ExpectedToolError("stripe_not_connected", "Stripe is not connected."),
    );
    expect(await readTenantStripeMrr("t1")).toEqual({
      available: false,
      reason: "not_connected",
    });
  });

  it("API error during the list → {available:false, reason:'read_failed'} (never throws)", async () => {
    mocks.list.mockRejectedValue(new Error("stripe 500"));
    mocks.stripeClient.mockResolvedValue({ subscriptions: { list: mocks.list } });
    expect(await readTenantStripeMrr("t1")).toEqual({
      available: false,
      reason: "read_failed",
    });
  });

  it("active-only: trialing / canceled / past_due subs in the response are excluded", async () => {
    fakeStripe([
      sub("active", [item(1000, "month")]),
      sub("trialing", [item(99900, "month")]),
      sub("canceled", [item(99900, "month")]),
      sub("past_due", [item(99900, "month")]),
    ]);
    expect(await readTenantStripeMrr("t1")).toEqual({
      available: true,
      mrr: 10, currency: "usd", mrr_usd: 10,
      meta: { sub_count: 1, currency: "usd", excluded_items: [], caveats: [] },
    });
  });

  it("metered and tiered items are EXCLUDED with a caveat, never silently counted as $0 (B9)", async () => {
    const metered = item(null, "month");
    (metered.price as Record<string, unknown>).id = "price_metered";
    (metered.price!.recurring as Record<string, unknown>).usage_type = "metered";
    const tiered = item(null, "month");
    (tiered.price as Record<string, unknown>).id = "price_tiered";
    (tiered.price as Record<string, unknown>).billing_scheme = "tiered";
    fakeStripe([{ ...sub("active", [metered, tiered, item(2500, "month")]), id: "sub_1" }]);
    const res = await readTenantStripeMrr("t1");
    expect(res).toMatchObject({
      available: true,
      mrr: 25,
      meta: {
        excluded_items: [
          { subscription_id: "sub_1", price_id: "price_metered", reason: "metered" },
          { subscription_id: "sub_1", price_id: "price_tiered", reason: "tiered" },
        ],
      },
    });
    expect((res as { meta: { caveats: string[] } }).meta.caveats[0]).toMatch(/2 metered or tiered/);
  });

  it("applies a forever percent_off coupon and a repeating amount_off coupon (B9)", async () => {
    fakeStripe([
      { ...sub("active", [item(10000, "month")]), discounts: [{ id: "di_1", end: null, coupon: { duration: "forever", percent_off: 25 } }] },
      { ...sub("active", [item(12000, "year")]), discounts: [{ id: "di_2", end: null, coupon: { duration: "repeating", amount_off: 2400, currency: "usd" } }] },
    ]);
    expect(await readTenantStripeMrr("t1")).toMatchObject({ available: true, mrr: 83, mrr_usd: 83 });
    expect(mocks.list).toHaveBeenCalledWith(
      expect.objectContaining({ expand: ["data.discounts", "data.discounts.coupon.applies_to"] }),
    );
  });

  it("an item-level discount or a product-restricted coupon makes MRR unavailable, never overstated", async () => {
    fakeStripe([{ ...sub("active", [{ ...item(10000, "month"), discounts: ["di_item"] } as FakeItem]) }]);
    expect(await readTenantStripeMrr("t1")).toEqual({ available: false, reason: "discount_unsupported" });

    fakeStripe([
      {
        ...sub("active", [item(10000, "month"), item(10000, "month")]),
        discounts: [{ id: "di_1", end: null, coupon: { duration: "forever", percent_off: 50, applies_to: { products: ["prod_a"] } } }],
      },
    ]);
    expect(await readTenantStripeMrr("t1")).toEqual({ available: false, reason: "discount_unsupported" });
  });

  it("does not apply an expired or one-time coupon", async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    fakeStripe([
      { ...sub("active", [item(10000, "month")]), discounts: [{ id: "di_1", end: past, coupon: { duration: "repeating", percent_off: 50 } }] },
      { ...sub("active", [item(10000, "month")]), discounts: [{ id: "di_2", end: null, coupon: { duration: "once", percent_off: 50 } }] },
    ]);
    const res = await readTenantStripeMrr("t1");
    expect(res).toMatchObject({ available: true, mrr: 200 });
    expect((res as { meta: { caveats: string[] } }).meta.caveats.join(" ")).toMatch(/one-time coupon/);
  });

  it("a non-USD account is labelled with its currency, and mrr_usd is null (no FX) (B9)", async () => {
    fakeStripe([sub("active", [item(5000, "month", { currency: "eur" })])]);
    expect(await readTenantStripeMrr("t1")).toMatchObject({
      available: true,
      mrr: 50,
      currency: "eur",
      mrr_usd: null,
      meta: { currency: "eur" },
    });
  });

  it("zero active subscriptions is an honest $0 read", async () => {
    fakeStripe([]);
    expect(await readTenantStripeMrr("t1")).toEqual({
      available: true,
      mrr: 0, currency: "usd", mrr_usd: 0,
      meta: { sub_count: 0, currency: "usd", excluded_items: [], caveats: [] },
    });
  });
});
