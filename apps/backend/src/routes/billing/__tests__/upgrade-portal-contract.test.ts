
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type ConfigParams = {
  features: {
    subscription_update: {
      default_allowed_updates: string[];
      products: Array<{ product: string; prices: string[] }>;
    };
  };
  metadata: Record<string, string>;
};
type ConfirmItem = { id: string; price?: string; quantity?: number };

const fake = vi.hoisted(() => ({
  configs: new Map<string, unknown>(),
  sessions: [] as Array<Record<string, unknown>>,
  sub: null as unknown,
  confirmed: [] as Array<{ price: string; quantity: number }>,
}));

function enforceConfirmRules(params: {
  configuration?: string;
  flow_data?: { type: string; subscription_update_confirm?: { items: ConfirmItem[] } };
}): void {
  if (params.flow_data?.type !== "subscription_update_confirm") return;
  const cfg = fake.configs.get(params.configuration ?? "") as ConfigParams | undefined;
  if (!cfg) throw new Error(`No such configuration: ${params.configuration}`);
  const upd = cfg.features.subscription_update;
  for (const item of params.flow_data.subscription_update_confirm?.items ?? []) {
    if (item.price && !upd.products.some((p) => p.prices.includes(item.price!))) {
      throw new Error(`configuration does not include the price in its features[subscription_update][products]`);
    }
    if (item.quantity !== undefined && !upd.default_allowed_updates.includes("quantity")) {
      throw new Error(
        "The subscription cannot be updated because the PortalConfiguration's " +
          "`features[subscription_update][default_allowed_updates]` does not include `quantity`.",
      );
    }
    const current = (fake.sub as { items: { data: Array<{ id: string; quantity: number; price: { id: string } }> } })
      .items.data.find((i) => i.id === item.id)!;
    fake.confirmed.push({ price: item.price ?? current.price.id, quantity: item.quantity ?? current.quantity });
  }
}

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ tenant_id: "77777777-7777-7777-7777-777777777777", user_id: "u1" })),
}));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: vi.fn(async () => true) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (id: string) => id,
  tenantClient: () => ({
    from() {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () =>
          Promise.resolve({
            data: { stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", status: "active", source: "stripe" },
            error: null,
          }),
      };
      return chain;
    },
  }),
}));
vi.mock("@/services/billing/client", () => ({
  billingStripe: () => ({
    subscriptions: { retrieve: vi.fn(async () => fake.sub) },
    subscriptionSchedules: { release: vi.fn(), retrieve: vi.fn() },
    prices: { retrieve: vi.fn(async (id: string) => ({ id, product: `prod_${id}` })) },
    billingPortal: {
      configurations: {
        list: () => ({ async *[Symbol.asyncIterator]() {} }),
        create: vi.fn(async (params: ConfigParams) => {
          const id = `bpc_${fake.configs.size + 1}`;
          fake.configs.set(id, params);
          return { id };
        }),
      },
      sessions: {
        create: vi.fn(async (params: Record<string, unknown>) => {
          enforceConfirmRules(params as Parameters<typeof enforceConfirmRules>[0]);
          fake.sessions.push(params);
          return { url: "https://billing.stripe.test/confirm" };
        }),
      },
    },
  }),
}));

import { billingChangePlan, changePlanFromCheckout } from "../subscription";
import { resetPlanChangePortalConfigCache } from "@/services/billing/portal-config";

function sub(price: string, quantity = 1) {
  return {
    id: "sub_1",
    status: "active",
    current_period_end: 1_790_000_000,
    cancel_at_period_end: false,
    schedule: null,
    items: { data: [{ id: "si_1", quantity, price: { id: price } }] },
  };
}

async function call(fn: typeof billingChangePlan, body: unknown) {
  const res = {
    statusCode: 200,
    body: undefined as Record<string, unknown> | undefined,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b as Record<string, unknown>; return this; },
  };
  await fn({ body } as never, res as never);
  return res;
}

beforeEach(() => {
  fake.configs.clear();
  fake.sessions.length = 0;
  fake.confirmed.length = 0;
  resetPlanChangePortalConfigCache();
  process.env.STRIPE_PRICE_STARTER_MONTHLY = "price_starter";
  process.env.STRIPE_PRICE_GROWTH_MONTHLY = "price_growth";
  process.env.STRIPE_PRICE_PRO_MONTHLY = "price_pro";
});
afterEach(() => {
  delete process.env.STRIPE_PRICE_STARTER_MONTHLY;
  delete process.env.STRIPE_PRICE_GROWTH_MONTHLY;
  delete process.env.STRIPE_PRICE_PRO_MONTHLY;
});

describe("upgrade portal session vs the configuration it runs under", () => {
  it.each([
    ["tier price (confirm config)", "price_starter", 1],
    ["legacy single-unit price (picker config)", "price_legacy_team_50", 1],
    ["legacy ladder, 20 units of $2.50 (picker config)", "price_credits_unit", 20],
  ])("%s → Stripe accepts the session and it confirms ONE unit of Pro", async (_label, current, quantity) => {
    fake.sub = sub(current, quantity);
    for (const route of [billingChangePlan, changePlanFromCheckout]) {
      fake.sessions.length = 0;
      fake.confirmed.length = 0;
      const res = await call(route, { tier: "pro" });
      expect(res.body?.error, JSON.stringify(res.body)).toBeUndefined();
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ kind: "upgrade", redirect: "https://billing.stripe.test/confirm" });
      expect(fake.sessions).toHaveLength(1);
      expect(fake.confirmed).toEqual([{ price: "price_pro", quantity: 1 }]);
    }
  });
});
