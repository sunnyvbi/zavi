
import { Rand, daysBefore } from "./rand";
import { table, type Dataset } from "./types";

export const ECOMMERCE_ANCHOR = "2026-09-01T00:00:00.000Z";

export function buildEcommerce(): Dataset {
  const rand = new Rand(31337);
  const anchor = new Date(ECOMMERCE_ANCHOR);

  const currencies = ["USD", "EUR", "GBP"] as const;
  const baseRate: Record<string, number> = { USD: 1.0, EUR: 1.08, GBP: 1.26 };

  const fxRates: Record<string, unknown>[] = [];
  for (let d = 0; d <= 200; d++) {
    const day = daysBefore(anchor, d, 0);
    for (const c of currencies) {
      fxRates.push({
        currency: c,
        rate_date: day,
        usd_rate: baseRate[c],
      });
    }
  }

  const customers: Record<string, unknown>[] = [];
  for (let i = 1; i <= 500; i++) {
    customers.push({
      id: i,
      email: `c${i}@example.com`,
      created_at: daysBefore(anchor, rand.int(1, 400), rand.int(0, 23)),
      country: rand.pick(["US", "US", "DE", "GB"]),
    });
  }

  const orders: Record<string, unknown>[] = [];
  const orderItems: Record<string, unknown>[] = [];
  const payments: Record<string, unknown>[] = [];
  const refunds: Record<string, unknown>[] = [];
  let itemId = 1;
  let payId = 1;
  let refId = 1;

  const skus = [
    { sku: "GRINDER-1", price: 12_900 },
    { sku: "KETTLE-1", price: 7_400 },
    { sku: "BEANS-250", price: 1_850 },
    { sku: "FILTER-100", price: 950 },
    { sku: "SCALE-PRO", price: 15_500 },
  ];

  for (let i = 1; i <= 900; i++) {
    const customer = customers[rand.int(0, customers.length - 1)];
    const placedAt = daysBefore(anchor, rand.int(0, 120), rand.int(0, 23), rand.int(0, 59));
    const currency =
      customer.country === "DE" ? "EUR" : customer.country === "GB" ? "GBP" : "USD";
    const status = rand.chance(0.07) ? "cancelled" : "fulfilled";

    const lineCount = rand.int(1, 3);
    let itemsCents = 0;
    for (let l = 0; l < lineCount; l++) {
      const s = skus[rand.int(0, skus.length - 1)];
      const qty = rand.int(1, 3);
      itemsCents += s.price * qty;
      orderItems.push({
        id: itemId++,
        order_id: i,
        sku: s.sku,
        qty,
        unit_price_cents: s.price,
      });
    }

    const discountCents = rand.chance(0.25) ? Math.round(itemsCents * 0.1) : 0;
    const shippingCents = itemsCents > 10_000 ? 0 : 690;
    const totalCents = itemsCents - discountCents + shippingCents;

    orders.push({
      id: i,
      customer_id: customer.id,
      placed_at: placedAt,
      status,
      currency,
      discount_cents: discountCents,
      shipping_cents: shippingCents,
      total_cents: totalCents,
    });

    if (status === "fulfilled") {
      if (rand.chance(0.35)) {
        const first = Math.round(totalCents * 0.4);
        payments.push({
          id: payId++,
          order_id: i,
          amount_cents: first,
          method: "gift_card",
          captured_at: placedAt,
        });
        payments.push({
          id: payId++,
          order_id: i,
          amount_cents: totalCents - first,
          method: "card",
          captured_at: placedAt,
        });
      } else {
        payments.push({
          id: payId++,
          order_id: i,
          amount_cents: totalCents,
          method: "card",
          captured_at: placedAt,
        });
      }

      if (rand.chance(0.09)) {
        const refundedAt = new Date(placedAt.getTime() + rand.int(1, 14) * 86_400_000);
        if (refundedAt <= anchor) {
          refunds.push({
            id: refId++,
            order_id: i,
            amount_cents: rand.chance(0.5) ? totalCents : Math.round(totalCents * 0.4),
            refunded_at: refundedAt,
          });
        }
      }
    }
  }

  const sessions: Record<string, unknown>[] = [];
  let sessionId = 1;
  const plan: { month: "2026-07" | "2026-08"; source: string; n: number; cvr: number }[] = [
    { month: "2026-07", source: "paid", n: 1000, cvr: 0.02 },
    { month: "2026-07", source: "organic", n: 5000, cvr: 0.08 },
    { month: "2026-08", source: "paid", n: 5000, cvr: 0.03 },
    { month: "2026-08", source: "organic", n: 1000, cvr: 0.09 },
  ];
  for (const p of plan) {
    const monthStart = new Date(`${p.month}-01T00:00:00.000Z`);
    const converts = Math.round(p.n * p.cvr);
    for (let k = 0; k < p.n; k++) {
      sessions.push({
        id: sessionId++,
        started_at: new Date(monthStart.getTime() + (k % 28) * 86_400_000 + (k % 23) * 3_600_000),
        source: p.source,
        converted: k < converts,
        country: p.source === "paid" ? "US" : "DE",
      });
    }
  }

  return {
    shape: "ecommerce",
    business:
      "Brewly sells coffee equipment direct to consumers in the US, Germany and the UK. Customers place " +
      "orders with one or more line items; an order can be paid with more than one payment (gift card plus " +
      "card). Orders are charged in the customer's local currency. Some orders are refunded in full or in " +
      "part. Marketing tracks web sessions by source. The fx_rates table gives usd_rate as the number of " +
      "US dollars one unit of that currency is worth. Timestamps are stored in UTC and the team reports " +
      "in USD on a UTC calendar.",
    anchorIso: ECOMMERCE_ANCHOR,
    timezone: "UTC",
    tables: [
      table(
        "customers",
        [
          { name: "id", type: "pk" },
          { name: "email", type: "text" },
          { name: "created_at", type: "timestamp" },
          { name: "country", type: "text" },
        ],
        customers,
      ),
      table(
        "orders",
        [
          { name: "id", type: "pk" },
          { name: "customer_id", type: "int" },
          { name: "placed_at", type: "timestamp" },
          { name: "status", type: "text" },
          { name: "currency", type: "text" },
          { name: "discount_cents", type: "bigint" },
          { name: "shipping_cents", type: "bigint" },
          { name: "total_cents", type: "bigint" },
        ],
        orders,
      ),
      table(
        "order_items",
        [
          { name: "id", type: "pk" },
          { name: "order_id", type: "int" },
          { name: "sku", type: "text" },
          { name: "qty", type: "int" },
          { name: "unit_price_cents", type: "bigint" },
        ],
        orderItems,
      ),
      table(
        "order_payments",
        [
          { name: "id", type: "pk" },
          { name: "order_id", type: "int" },
          { name: "amount_cents", type: "bigint" },
          { name: "method", type: "text" },
          { name: "captured_at", type: "timestamp" },
        ],
        payments,
      ),
      table(
        "order_refunds",
        [
          { name: "id", type: "pk" },
          { name: "order_id", type: "int" },
          { name: "amount_cents", type: "bigint" },
          { name: "refunded_at", type: "timestamp" },
        ],
        refunds,
      ),
      table(
        "fx_rates",
        [
          { name: "currency", type: "text" },
          { name: "rate_date", type: "date" },
          { name: "usd_rate", type: "numeric" },
        ],
        fxRates,
      ),
      table(
        "web_sessions",
        [
          { name: "id", type: "pk" },
          { name: "started_at", type: "timestamp" },
          { name: "source", type: "text" },
          { name: "converted", type: "bool" },
          { name: "country", type: "text" },
        ],
        sessions,
      ),
    ],
  };
}
