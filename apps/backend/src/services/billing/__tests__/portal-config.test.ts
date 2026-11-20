
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  planChangePortalConfiguration,
  planChangePriceIds,
  resetPlanChangePortalConfigCache,
} from "../portal-config";
import { sixMonthUsd } from "../plans";

const PRICE_ENV = {
  STRIPE_PRICE_STARTER_MONTHLY: "price_s_m",
  STRIPE_PRICE_STARTER_6MO: "price_s_6",
  STRIPE_PRICE_GROWTH_MONTHLY: "price_g_m",
  STRIPE_PRICE_GROWTH_6MO: "",
  STRIPE_PRICE_PRO_MONTHLY: "price_p_m",
  STRIPE_PRICE_PRO_6MO: "price_p_6",
};

function fakeStripe(
  existing: Array<{ id: string; metadata: Record<string, string> }> = [],
  priceOf: (id: string) => Record<string, unknown> = (id) => ({ id, product: `prod_${id.split("_")[1]}` }),
) {
  const create = vi.fn(async () => ({ id: "bpc_new" }));
  const list = vi.fn(() => ({
    async *[Symbol.asyncIterator]() {
      yield* existing;
    },
  }));
  const retrieve = vi.fn(async (id: string) => priceOf(id));
  return {
    stripe: { billingPortal: { configurations: { list, create } }, prices: { retrieve } } as never,
    create,
    list,
    retrieve,
  };
}

beforeEach(() => {
  resetPlanChangePortalConfigCache();
  Object.assign(process.env, PRICE_ENV);
});

describe("planChangePriceIds", () => {
  it("lists one term's tier prices, skipping blanks", () => {
    expect(planChangePriceIds("monthly")).toEqual(["price_g_m", "price_p_m", "price_s_m"]);
    expect(planChangePriceIds("6mo")).toEqual(["price_p_6", "price_s_6"]);
  });
});

describe("planChangePortalConfiguration", () => {
  it("creates one configuration listing each price under its product", async () => {
    const f = fakeStripe();
    expect(await planChangePortalConfiguration(f.stripe, "monthly")).toBe("bpc_new");
    const [params, opts] = f.create.mock.calls[0] as unknown as [
      { features: { subscription_update: Record<string, unknown> }; metadata: Record<string, string> },
      { idempotencyKey: string },
    ];
    const upd = params.features.subscription_update;
    expect(upd.enabled).toBe(true);
    expect(upd.default_allowed_updates).toEqual(["price"]);
    expect(upd.proration_behavior).toBe("always_invoice");
    expect(upd.products).toEqual([
      { product: "prod_g", prices: ["price_g_m"] },
      { product: "prod_p", prices: ["price_p_m"] },
      { product: "prod_s", prices: ["price_s_m"] },
    ]);
    expect(params.metadata.prices).toBe("price_g_m,price_p_m,price_s_m");
    expect(opts.idempotencyKey).toContain(params.metadata.prices);
  });

  it("reuses a configuration already made for the same price set", async () => {
    const f = fakeStripe([
      { id: "bpc_other", metadata: { purpose: "zavi_plan_change", prices: "price_old" } },
      { id: "bpc_same", metadata: { purpose: "zavi_plan_change", prices: "price_g_m,price_p_m,price_s_m", mode: "picker" } },
    ]);
    expect(await planChangePortalConfiguration(f.stripe, "monthly")).toBe("bpc_same");
    expect(f.create).not.toHaveBeenCalled();
  });

  it("caches per price set and makes a new one when a price changes", async () => {
    const f = fakeStripe([], (id) => ({
      id,
      product: `prod_${id.split("_")[1]}`,
      active: true,
      currency: "usd",
      unit_amount: sixMonthUsd(({ s: "starter", g: "growth", p: "pro" } as const)[id.split("_")[1] as "s" | "g" | "p"]) * 100,
      recurring: { interval: "month", interval_count: 6 },
    }));
    await planChangePortalConfiguration(f.stripe, "6mo");
    await planChangePortalConfiguration(f.stripe, "6mo");
    expect(f.list).toHaveBeenCalledTimes(1);
    process.env.STRIPE_PRICE_GROWTH_6MO = "price_g_6";
    await planChangePortalConfiguration(f.stripe, "6mo");
    expect(f.create).toHaveBeenCalledTimes(2);
  });

  it("confirm mode applies now: no amount-based scheduling, its own configuration", async () => {
    const f = fakeStripe([
      { id: "bpc_picker", metadata: { purpose: "zavi_plan_change", prices: "price_g_m,price_p_m,price_s_m", mode: "picker" } },
    ]);
    expect(await planChangePortalConfiguration(f.stripe, "monthly", "confirm")).toBe("bpc_new");
    const [params, opts] = f.create.mock.calls[0] as unknown as [
      { features: { subscription_update: Record<string, unknown> }; metadata: Record<string, string> },
      { idempotencyKey: string },
    ];
    expect(params.features.subscription_update.schedule_at_period_end).toBeUndefined();
    expect(params.metadata.mode).toBe("confirm");
    expect(opts.idempotencyKey).toContain("confirm");
  });

  it("quantity variant allows price + quantity and never reuses a price-only configuration", async () => {
    const f = fakeStripe([
      { id: "bpc_price_only", metadata: { purpose: "zavi_plan_change", prices: "price_g_m,price_p_m,price_s_m", mode: "picker" } },
    ]);
    expect(await planChangePortalConfiguration(f.stripe, "monthly", "picker", { quantity: true })).toBe("bpc_new");
    const [params, opts] = f.create.mock.calls[0] as unknown as [
      { features: { subscription_update: Record<string, unknown> }; metadata: Record<string, string> },
      { idempotencyKey: string },
    ];
    expect(params.features.subscription_update.default_allowed_updates).toEqual(["price", "quantity"]);
    expect(params.metadata.updates).toBe("price,quantity");
    expect(opts.idempotencyKey).toContain(":qty:");
    expect(await planChangePortalConfiguration(f.stripe, "monthly", "picker")).toBe("bpc_price_only");
    expect(f.create).toHaveBeenCalledTimes(1);
  });

  it("refuses to offer a six-month price that does not match the quote", async () => {
    const f = fakeStripe([], (id) => ({
      id,
      product: `prod_${id.split("_")[1]}`,
      active: true,
      currency: "usd",
      unit_amount: 1,
      recurring: { interval: "month", interval_count: 6 },
    }));
    await expect(planChangePortalConfiguration(f.stripe, "6mo")).rejects.toThrow(/does not match the quote/);
    expect(f.create).not.toHaveBeenCalled();
  });
});
