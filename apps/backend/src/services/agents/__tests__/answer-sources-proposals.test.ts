
import { describe, it, expect, beforeEach } from "vitest";
import { clearFigures, recordFiguresFromPull } from "@/services/agents/engine/figure-ledger";
import { buildAnswerSources, claimFigures } from "@/services/agents/answer-sources";

const RUN = "44444444-4444-4444-8444-444444444444";
beforeEach(() => clearFigures(RUN));

const META = JSON.stringify({
  ad_sets: [
    {
      id: "120210000010",
      name: "Atlanta 25mi",
      daily_budget_usd: 40,
      daily_budget_minor_units: "4000",
      spend_usd: 125.74,
      clicks: 110,
      cpc_usd: 1.14,
      age_min: 10,
    },
  ],
});
const GOOGLE = JSON.stringify({
  campaigns: [
    { name: "Atlanta Search", daily_budget_usd: 20, spend_usd: 86.43, clicks: 28, avg_cpc_usd: 3.09, impressions: 50 },
  ],
});

const REPLY =
  "| | Meta | Google |\n| --- | --- | --- |\n| Daily budget | $40 | $20 |\n| Spent | $125.74 | $86.43 |\n\n" +
  "Of the Google spend, $17.31 of $38.24 went to people searching for other companies.\n\n" +
  "**Recommended next action:** Cut Google Atlanta to $10 a day and block the other companies' names. " +
  "Raise Meta Atlanta to $50 a day. Total spend stays at $60 a day, and the stop lines stay the same " +
  "($300 on Meta, $200 on Google). At $50 a day, Meta hits $300 around Oct 21.";

const EARLIER =
  "The stop-loss lines are $300 spent with no bookings on Meta and $200 on Google. The stop rules are still manual.";

function seed() {
  recordFiguresFromPull(RUN, META, "meta_ads__list_ad_sets");
  recordFiguresFromPull(RUN, GOOGLE, "google_ads__list_campaigns");
}

describe("the 2026-10-17 cgo recommendation", () => {
  it("proposals are not judged; caps and partial sums stay unverified; $60 checks out", () => {
    seed();
    const r = buildAnswerSources(RUN, REPLY, { earlierReplies: [EARLIER] });
    const kinds = Object.fromEntries(r.checked.map((c) => [c.figure, c.kind]));
    expect(kinds["$10"]).toBeUndefined();
    expect(kinds["$50"]).toBeUndefined();
    expect(kinds["$40"]).toBe("pulled");
    expect(kinds["$20"]).toBe("pulled");
    expect(kinds["$125.74"]).toBe("pulled");
    expect(kinds["$60"]).toBe("worked_out");
    expect(r.checked).toContainEqual({ figure: "$60", kind: "worked_out", formula: "$60 = $40 + $20" });
    expect(r.meta.unverified).toEqual(expect.arrayContaining(["$17.31", "$300", "$200"]));
    expect(r.meta.unverified).not.toContain("$10");
    expect(r.meta.unverified).not.toContain("$50");
    expect(r.meta.earlier).toEqual(["$300", "$200"]);
    expect(r.block).not.toContain("$300");
  });

  it("without an earlier reply naming them, the caps carry no earlier note", () => {
    seed();
    const r = buildAnswerSources(RUN, REPLY);
    expect(r.meta.earlier).toBeUndefined();
    expect(r.meta.unverified).toEqual(expect.arrayContaining(["$300", "$200"]));
  });
});

describe("short round money needs a pull that wrote it as money", () => {
  it("a click count or an id holding the digits does not credit $50 / $10 claims", () => {
    seed();
    const r = buildAnswerSources(RUN, "Meta's CPC was $1.14 and it spent $50 on Tuesday, and $10 went to tests.");
    const kinds = Object.fromEntries(r.checked.map((c) => [c.figure, c.kind]));
    expect(kinds["$1.14"]).toBe("pulled");
    expect(r.meta.unverified).toEqual(expect.arrayContaining(["$50", "$10"]));
  });

  it("cents under *_minor_units never stand for dollars", () => {
    recordFiguresFromPull(RUN, JSON.stringify({ daily_budget_minor_units: 4000 }), "meta_ads__list_ad_sets");
    const r = buildAnswerSources(RUN, "The budget is $4,000 a day.");
    expect(r.meta.unverified).toContain("$4,000");
  });

  it("an adjacent $ in the pull still credits it", () => {
    recordFiguresFromPull(RUN, "Daily budget: $50. Spend so far: $125.74.", "web__fetch");
    const r = buildAnswerSources(RUN, "The budget is $50 a day.");
    expect(r.checked).toContainEqual(expect.objectContaining({ figure: "$50", kind: "pulled" }));
  });

  it("a specific figure keeps the exact-digits match", () => {
    recordFiguresFromPull(RUN, JSON.stringify({ rows: [{ total: 12574 }] }), "operator_db__query");
    const r = buildAnswerSources(RUN, "Revenue was $12,574 last month.");
    expect(r.checked).toContainEqual(expect.objectContaining({ figure: "$12,574", kind: "pulled" }));
  });
});

describe("typed money from structured pulls", () => {
  it("get_metric totals and series take the object's unit", () => {
    recordFiguresFromPull(
      RUN,
      JSON.stringify({ metric_id: "net_revenue", unit: "currency", total: 4200, compare_total: 3500, series: [{ date: "2026-10-01", value: 50 }] }),
      "growth__get_metric",
    );
    const r = buildAnswerSources(RUN, "Net revenue was $4,200, up from $3,500; Oct 1 alone was $50.");
    const kinds = Object.fromEntries(r.checked.map((c) => [c.figure, c.kind]));
    expect(kinds).toMatchObject({ "$4,200": "pulled", "$3,500": "pulled", $50: "pulled" });
  });

  it("a count metric's total never stands for dollars", () => {
    recordFiguresFromPull(RUN, JSON.stringify({ metric_id: "bookings", unit: "count", total: 50 }), "growth__get_metric");
    const r = buildAnswerSources(RUN, "Revenue was $50.");
    expect(r.meta.unverified).toContain("$50");
  });

  it("database money columns, arrays and 40.0", () => {
    recordFiguresFromPull(
      RUN,
      JSON.stringify({ rows: [{ gross: 50, mrr: 1200 }], revenue: [70, 90], daily_budget_usd: 40.0 }),
      "operator_db__query",
    );
    const r = buildAnswerSources(RUN, "Gross was $50, MRR is $1,200, revenue went $70 then $90, and the budget is $40.");
    expect(r.meta.unverified).toEqual([]);
  });

  it("a count column with a money word is not money", () => {
    recordFiguresFromPull(RUN, JSON.stringify({ rows: [{ net_new_users: 50 }] }), "operator_db__query");
    const r = buildAnswerSources(RUN, "Net revenue was $50.");
    expect(r.meta.unverified).toContain("$50");
  });

  it("Stripe amounts beside a currency code are cents, not dollars", () => {
    recordFiguresFromPull(
      RUN,
      JSON.stringify({ charges: [{ id: "ch_1", amount: 5000, amount_refunded: 0, currency: "usd" }] }),
      "stripe__list_charges",
    );
    const r = buildAnswerSources(RUN, "The charge was $5,000.");
    expect(r.meta.unverified).toContain("$5,000");
  });
});

describe("typed money: value match and scoped units", () => {
  it("a 40 never stands for $4,000, and $1.10 matches 1.1", () => {
    recordFiguresFromPull(RUN, JSON.stringify({ daily_budget_usd: 40, cpc_usd: 1.1 }), "meta_ads__list_ad_sets");
    const r = buildAnswerSources(RUN, "The budget is $4,000 and CPC is $1.10.");
    expect(r.meta.unverified).toContain("$4,000");
    expect(r.checked).toContainEqual(expect.objectContaining({ figure: "$1.10", kind: "pulled" }));
  });

  it("an object's currency unit does not leak into unrelated nested objects", () => {
    recordFiguresFromPull(RUN, JSON.stringify({ unit: "currency", total: 4200, pagination: { total: 50 } }), "growth__get_metric");
    const r = buildAnswerSources(RUN, "Revenue was $50.");
    expect(r.meta.unverified).toContain("$50");
  });

  it("a key is judged by its head noun", () => {
    recordFiguresFromPull(RUN, JSON.stringify({ rows: [{ revenue_from_orders: 50 }] }), "operator_db__query");
    const r = buildAnswerSources(RUN, "Revenue from orders was $50.");
    expect(r.meta.unverified).toEqual([]);
  });

  it("every Stripe amount is in cents, with or without a currency code", () => {
    recordFiguresFromPull(RUN, JSON.stringify({ payout: { amount: 5000, fee: 50, net: 4950 } }), "stripe__retrieve_payout");
    const r = buildAnswerSources(RUN, "The payout was $5,000, or really $50.");
    expect(r.meta.unverified).toEqual(["$5,000"]);
    expect(r.checked).toContainEqual(expect.objectContaining({ figure: "$50", kind: "pulled" }));
  });
});

describe("typed money: stated units, notation and Stripe cents", () => {
  it("a child that states unit count overrides the parent's currency", () => {
    recordFiguresFromPull(RUN, JSON.stringify({ unit: "currency", series: [{ unit: "count", value: 50 }] }), "growth__get_metric");
    const r = buildAnswerSources(RUN, "Revenue was $50.");
    expect(r.meta.unverified).toContain("$50");
  });

  it("scientific notation is not a figure", () => {
    recordFiguresFromPull(RUN, JSON.stringify({ cpc_usd: 1e-7 }), "meta_ads__list_ad_sets");
    const r = buildAnswerSources(RUN, "CPC is $1.00 today.");
    expect(r.meta.unverified).toContain("$1.00");
  });

  it("Stripe cents back the converted dollar figure, never the cents read as dollars", () => {
    recordFiguresFromPull(
      RUN,
      JSON.stringify({ balance_transactions: [{ net: 4950 }], application_fee_amount: 1234 }),
      "stripe_retrieve_payout",
    );
    const wrong = buildAnswerSources(RUN, "Net was $4,950 and the fee $1,234.");
    expect(wrong.meta.unverified).toEqual(expect.arrayContaining(["$4,950", "$1,234"]));
    const r = buildAnswerSources(RUN, "Net was $49.50 and the fee $12.34.");
    expect(r.checked).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ figure: "$49.50", kind: "pulled" }),
        expect.objectContaining({ figure: "$12.34", kind: "pulled" }),
      ]),
    );
  });
});

describe("typed money: currency and conversions", () => {
  it("a non-Stripe amount in cents beside a currency backs its dollar value", () => {
    recordFiguresFromPull(RUN, JSON.stringify({ currency: "usd", amount: 123400 }), "billing__invoice");
    const r = buildAnswerSources(RUN, "The invoice was $1,234.");
    expect(r.checked).toContainEqual(expect.objectContaining({ figure: "$1,234", kind: "pulled" }));
  });

  it("an amount in another currency never backs a dollar figure", () => {
    recordFiguresFromPull(RUN, JSON.stringify({ charges: [{ amount: 5000, currency: "jpy" }] }), "stripe_list_charges");
    const r = buildAnswerSources(RUN, "The charge was $50.");
    expect(r.meta.unverified).toContain("$50");
  });

  it("scientific notation never becomes $0", () => {
    recordFiguresFromPull(RUN, JSON.stringify({ amount: 1e-7 }), "stripe_list_charges");
    const r = buildAnswerSources(RUN, "Refunds were $0.");
    expect(r.checked).not.toContainEqual(expect.objectContaining({ figure: "$0", kind: "pulled" }));
  });
});

describe("two-term totals", () => {
  it("never credits a different metric or a figure inside a longer amount", () => {
    seed();
    const a = buildAnswerSources(RUN, "Budgets are $40 and $20. Total revenue is $60.");
    expect(a.meta.unverified).toContain("$60");
    clearFigures(RUN);
    seed();
    const b = buildAnswerSources(RUN, "Budgets are $40 and $20. The CPC stays at $60.");
    expect(b.meta.unverified).toContain("$60");
    clearFigures(RUN);
    seed();
    const c = buildAnswerSources(RUN, "Budgets are $40 and $20. Total spend was $60,000, and fees were $60.");
    expect(c.meta.unverified).toContain("$60");
  });

  it("a plain 'and' starts a new clause", () => {
    seed();
    const r = buildAnswerSources(RUN, "Budgets are $40 and $20. Total spend is $60 and fees are $60.");
    expect(r.meta.unverified).toContain("$60");
  });

  it("every occurrence must be a total, and 'In total,' still counts", () => {
    seed();
    const a = buildAnswerSources(RUN, "Revenue is $60. Budgets are $40 and $20. Total spend is $60.");
    expect(a.meta.unverified).toContain("$60");
    clearFigures(RUN);
    seed();
    const b = buildAnswerSources(RUN, "Budgets are $40 and $20. In total, spend is $60 a day.");
    expect(b.checked).toContainEqual({ figure: "$60", kind: "worked_out", formula: "$60 = $40 + $20" });
  });

  it("needs a total word in the figure's sentence", () => {
    seed();
    const r = buildAnswerSources(RUN, "Budgets are $40 and $20. Meta could use $60.");
    expect(r.meta.unverified).toContain("$60");
  });

  it("refuses operands written under different keys (revenue + cost)", () => {
    recordFiguresFromPull(RUN, JSON.stringify({ revenue_usd: 40, cost_usd: 20 }), "stripe__summary");
    const r = buildAnswerSources(RUN, "Revenue was $40 and cost $20, so the total is $60.");
    expect(r.meta.unverified).toContain("$60");
  });

  it("refuses an ambiguous pair", () => {
    recordFiguresFromPull(
      RUN,
      JSON.stringify({ a: { daily_budget_usd: 40 }, b: { daily_budget_usd: 20 }, c: { daily_budget_usd: 35 }, d: { daily_budget_usd: 25 } }),
      "meta_ads__list_ad_sets",
    );
    const r = buildAnswerSources(RUN, "Budgets: $40, $20, $35 and $25. In total that is $60 for two of them.");
    expect(r.meta.unverified).toContain("$60");
  });
});

describe("claimFigures", () => {
  it("skips proposal occurrences and keeps the first claim spelling", () => {
    expect(claimFigures("Raise Meta to $50 a day. Meta spent $50 yesterday.")).toEqual(["$50"]);
    expect(claimFigures("Cut Google to $10 a day.")).toEqual([]);
    expect(claimFigures("We cut Google to $10 last week.")).toEqual(["$10"]);
  });
});
