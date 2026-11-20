
import { buildMarketplace } from "./fixtures/marketplace";
import { buildSaas } from "./fixtures/saas";
import { buildEcommerce } from "./fixtures/ecommerce";
import { buildConsumer } from "./fixtures/consumer";
import { inRange, localMonthRange } from "./fixtures/time";
import type { Dataset } from "./fixtures/types";
import { HOLDOUT_BUILDERS, HOLDOUT_DATASETS, HOLDOUT_SHAPES } from "./questions-holdout";
import { MAX_ROWS_PER_READ } from "@/services/tools/operator-db/codeact-sql";

export type Trap =
  | "status_enum_variants"
  | "event_log_vs_mutable_status"
  | "test_rows_excluded"
  | "soft_delete"
  | "minor_units"
  | "refunds_netted"
  | "join_fanout"
  | "distinct_vs_rows"
  | "timezone_boundary"
  | "row_cap_truncation"
  | "multi_currency_fx"
  | "voided_rows"
  | "cohort_denominator"
  | "funnel_dedup"
  | "event_name_variants"
  | "mix_shift_simpson"
  | "json_field"
  | "segmentation"
  | "ambiguous_definition"
  | "abstain_missing_field";

export type Question = {
  id: string;
  shape: string;
  prompt: string;
  traps: Trap[];
} & (
  | {
      kind: "numeric";
      expected: number;
      unit: "count" | "usd" | "percent";
      tolerance: number;
      knownWrongAnswers?: { value: number; because: string }[];
    }
  | {
      kind: "narrative";
      mustAssert: string[];
      mustNotAssert: string[];
    }
);

const round2 = (n: number) => Math.round(n * 100) / 100;
const rows = (ds: Dataset, name: string) =>
  ds.tables.find((t) => t.name === name)!.rows as Record<string, any>[];

function marketplaceQuestions(ds: Dataset): Question[] {
  const [augStart, augEnd] = localMonthRange(2026, 8, ds.timezone);
  const users = rows(ds, "users");
  const listings = rows(ds, "listings");
  const bookings = rows(ds, "bookings");
  const refunds = rows(ds, "booking_refunds");
  const events = rows(ds, "booking_events");

  const userById = new Map(users.map((u) => [u.id, u]));
  const bookingById = new Map(bookings.map((b) => [b.id, b]));
  const listingById = new Map(listings.map((l) => [l.id, l]));

  const completedInAug = events
    .filter((e) => e.event === "completed" && inRange(e.at, augStart, augEnd))
    .map((e) => bookingById.get(e.booking_id)!)
    .filter((b) => b && !userById.get(b.guest_id)?.is_test);

  const grossUsd = completedInAug.reduce((s, b) => s + Number(b.gross_cents), 0) / 100;
  const completedIds = new Set(completedInAug.map((b) => b.id));
  const refundUsd =
    refunds.filter((r) => completedIds.has(r.booking_id)).reduce((s, r) => s + Number(r.amount_cents), 0) / 100;

  const wrongByCreatedAt = bookings.filter(
    (b) => String(b.status).toLowerCase() === "completed" && inRange(b.created_at, augStart, augEnd),
  ).length;
  const wrongCaseSensitive = events
    .filter((e) => e.event === "completed" && inRange(e.at, augStart, augEnd))
    .map((e) => bookingById.get(e.booking_id)!)
    .filter((b) => b && b.status === "completed" && !userById.get(b.guest_id)?.is_test).length;
  const [augStartUtc, augEndUtc] = localMonthRange(2026, 8, "UTC");
  const wrongUtcMonth = events
    .filter((e) => e.event === "completed" && inRange(e.at, augStartUtc, augEndUtc))
    .map((e) => bookingById.get(e.booking_id)!)
    .filter((b) => b && !userById.get(b.guest_id)?.is_test).length;
  const wrongWithTestRows = events
    .filter((e) => e.event === "completed" && inRange(e.at, augStart, augEnd))
    .map((e) => bookingById.get(e.booking_id)!)
    .filter(Boolean).length;

  const byCity = new Map<string, number>();
  for (const b of completedInAug) {
    const city = String(listingById.get(b.listing_id)?.city ?? "?");
    byCity.set(city, (byCity.get(city) ?? 0) + Number(b.gross_cents));
  }
  const topCity = [...byCity.entries()].sort((a, b) => b[1] - a[1])[0];

  const activeSupply = listings.filter((l) => l.status === "active" && l.deleted_at === null).length;
  const supplyIgnoringSoftDelete = listings.filter((l) => l.status === "active").length;
  const supplyIgnoringStatus = listings.filter((l) => l.deleted_at === null).length;

  return [
    {
      id: "MK1",
      shape: "marketplace",
      kind: "numeric",
      prompt:
        "How many bookings were COMPLETED in August 2026? Use our reporting calendar (America/Los_Angeles) " +
        "and leave out anything booked by our own internal test accounts.",
      traps: ["event_log_vs_mutable_status", "status_enum_variants", "timezone_boundary", "test_rows_excluded"],
      expected: completedInAug.length,
      unit: "count",
      tolerance: 0,
      knownWrongAnswers: [
        { value: wrongByCreatedAt, because: "used bookings.created_at instead of the completion event" },
        {
          value: wrongCaseSensitive,
          because:
            "used the completion event correctly but then also required bookings.status = 'completed' case-sensitively, dropping every booking the mobile API wrote in upper case",
        },
        { value: wrongUtcMonth, because: "used a UTC month boundary instead of America/Los_Angeles" },
        { value: wrongWithTestRows, because: "did not exclude internal test accounts" },
      ],
    },
    {
      id: "MK2",
      shape: "marketplace",
      kind: "numeric",
      prompt:
        "What was our net completed booking value in August 2026, in dollars? Net means the gross value of " +
        "bookings completed that month, minus any refunds issued against those bookings. Exclude internal test accounts.",
      traps: ["minor_units", "refunds_netted", "join_fanout", "event_log_vs_mutable_status", "timezone_boundary"],
      expected: round2(grossUsd - refundUsd),
      unit: "usd",
      tolerance: 0.001,
      knownWrongAnswers: [
        { value: round2(grossUsd), because: "did not subtract refunds" },
        { value: round2((grossUsd - refundUsd) * 100), because: "reported cents as dollars" },
      ],
    },
    {
      id: "MK3",
      shape: "marketplace",
      kind: "numeric",
      prompt: "How many different guests completed at least one booking in August 2026 (America/Los_Angeles)? Exclude internal test accounts.",
      traps: ["distinct_vs_rows", "event_log_vs_mutable_status", "timezone_boundary", "test_rows_excluded"],
      expected: new Set(completedInAug.map((b) => b.guest_id)).size,
      unit: "count",
      tolerance: 0,
      knownWrongAnswers: [
        { value: completedInAug.length, because: "counted bookings instead of distinct guests" },
      ],
    },
    {
      id: "MK4",
      shape: "marketplace",
      kind: "numeric",
      prompt: "How many listings are live and bookable on the platform right now?",
      traps: ["soft_delete"],
      expected: activeSupply,
      unit: "count",
      tolerance: 0,
      knownWrongAnswers: [
        {
          value: supplyIgnoringSoftDelete,
          because: "filtered on status = 'active' only, counting listings that were soft-deleted while their status column still read active",
        },
        {
          value: supplyIgnoringStatus,
          because: "filtered on deleted_at IS NULL only, counting paused listings as bookable",
        },
        { value: listings.length, because: "counted every listing row, including removed and soft-deleted ones" },
      ],
    },
    {
      id: "MK5",
      shape: "marketplace",
      kind: "numeric",
      prompt:
        "Which city produced the most GROSS completed-booking value in August 2026 — before refunds — and how " +
        "much was it in dollars? Answer with the dollar figure for the top city.",
      traps: ["join_fanout", "segmentation", "minor_units", "event_log_vs_mutable_status"],
      expected: round2(topCity[1] / 100),
      unit: "usd",
      tolerance: 0.001,
      knownWrongAnswers: [
        { value: topCity[1], because: "reported cents as dollars" },
        {
          value: round2((topCity[1] - (refunds.filter((r) => completedIds.has(r.booking_id) && listingById.get(bookingById.get(r.booking_id)!.listing_id)?.city === topCity[0]).reduce((s2, r) => s2 + Number(r.amount_cents), 0))) / 100),
          because: "netted refunds off, though this question asks for the gross figure before refunds",
        },
      ],
    },
    {
      id: "MK6",
      shape: "marketplace",
      kind: "narrative",
      prompt: "Of the bookings cancelled in August 2026, what share were cancelled by the HOST rather than the guest?",
      traps: ["abstain_missing_field"],
      mustAssert: [
        "states that the data cannot answer this",
        "names the missing information specifically: there is no field recording WHO cancelled or WHY (no cancelled_by / cancel_reason / actor column on bookings or booking_events)",
      ],
      mustNotAssert: [
        "any percentage or split between host-cancelled and guest-cancelled",
        "a claim that the database is not connected or unavailable",
      ],
    },
    {
      id: "MK7",
      shape: "marketplace",
      kind: "narrative",
      prompt: "What was our revenue last month?",
      traps: ["ambiguous_definition"],
      mustAssert: [
        "either asks ONE clarifying question about which revenue definition is meant, or picks one and says explicitly which",
        "if it answers, names the window, the timezone, whether the figure is gross booking value or Wheelio's take, whether cancelled bookings are in or out, and whether refunds are netted",
      ],
      mustNotAssert: [
        "a bare dollar figure with no stated definition, window or filters",
      ],
    },
  ];
}

function saasQuestions(ds: Dataset): Question[] {
  const [augStart, augEnd] = localMonthRange(2026, 8, ds.timezone);
  const accounts = rows(ds, "accounts");
  const subs = rows(ds, "subscriptions");
  const events = rows(ds, "subscription_events");
  const invoices = rows(ds, "invoices");

  const acctById = new Map(accounts.map((a) => [a.id, a]));
  const countable = (accountId: unknown) => {
    const a = acctById.get(accountId);
    return a && !a.is_internal && a.deleted_at === null;
  };

  const augEvents = events.filter((e) => countable(e.account_id) && inRange(e.at, augStart, augEnd));
  const netNewMrr = augEvents.reduce((s, e) => s + Number(e.mrr_delta_cents), 0) / 100;
  const churnedMrr =
    -augEvents.filter((e) => e.type === "cancel").reduce((s, e) => s + Number(e.mrr_delta_cents), 0) / 100;
  const churnedAccounts = new Set(augEvents.filter((e) => e.type === "cancel").map((e) => e.account_id)).size;

  const churnedByCurrentStatus = subs.filter(
    (s) => countable(s.account_id) && s.canceled_at && inRange(s.canceled_at, augStart, augEnd),
  ).length;

  const currentMrr =
    events.filter((e) => countable(e.account_id)).reduce((s, e) => s + Number(e.mrr_delta_cents), 0) / 100;

  const collected =
    invoices
      .filter((i) => countable(i.account_id) && i.voided_at === null && i.paid_at && inRange(i.paid_at, augStart, augEnd))
      .reduce((s, i) => s + Number(i.amount_cents), 0) / 100;
  const collectedIgnoringVoids =
    invoices
      .filter((i) => countable(i.account_id) && i.issued_at && inRange(i.issued_at, augStart, augEnd))
      .reduce((s, i) => s + Number(i.amount_cents), 0) / 100;

  const q2Start = new Date("2026-04-01T00:00:00.000Z");
  const q2End = new Date("2026-07-01T00:00:00.000Z");
  const cohort = accounts.filter(
    (a) => !a.is_internal && a.deleted_at === null && inRange(a.created_at, q2Start, q2End),
  );
  const firstStart = new Map<unknown, Date>();
  for (const e of events) {
    if (e.type !== "start") continue;
    const at = e.at instanceof Date ? e.at : new Date(String(e.at));
    const prev = firstStart.get(e.account_id);
    if (!prev || at < prev) firstStart.set(e.account_id, at);
  }
  const convertedWithin = (days: number): number =>
    cohort.filter((a) => {
      const s = firstStart.get(a.id);
      if (!s) return false;
      const created = a.created_at instanceof Date ? a.created_at : new Date(String(a.created_at));
      return s.getTime() - created.getTime() <= days * 86_400_000;
    }).length;
  const converted = convertedWithin(30);
  const convertedEver = cohort.filter((a) => firstStart.has(a.id)).length;

  return [
    {
      id: "SA1",
      shape: "saas",
      kind: "numeric",
      prompt:
        "What was our net new MRR in August 2026, in dollars? Count new subscriptions, upgrades, downgrades, " +
        "cancellations and win-backs. Leave out our own internal accounts and any deleted accounts. " +
        "Report a negative number if MRR shrank.",
      traps: ["event_log_vs_mutable_status", "minor_units", "test_rows_excluded", "soft_delete"],
      expected: round2(netNewMrr),
      unit: "usd",
      tolerance: 0.001,
      knownWrongAnswers: [
        { value: round2(Math.abs(netNewMrr)), because: "reported the magnitude of a contraction as a positive number" },
        { value: round2(netNewMrr * 100), because: "reported cents as dollars" },
      ],
    },
    {
      id: "SA2",
      shape: "saas",
      kind: "numeric",
      prompt: "How much MRR did we lose to cancellations during August 2026, in dollars? Exclude internal and deleted accounts.",
      traps: ["event_log_vs_mutable_status", "minor_units"],
      expected: round2(churnedMrr),
      unit: "usd",
      tolerance: 0.001,
      knownWrongAnswers: [
        { value: round2(churnedMrr * 100), because: "reported cents as dollars" },
        {
          value: round2(-augEvents.filter((e) => Number(e.mrr_delta_cents) < 0).reduce((s2, e) => s2 + Number(e.mrr_delta_cents), 0) / 100),
          because: "counted downgrades as churn — a contraction is not a cancellation",
        },
      ],
    },
    {
      id: "SA3",
      shape: "saas",
      kind: "numeric",
      prompt: "How many accounts cancelled during August 2026? Exclude internal and deleted accounts.",
      traps: ["event_log_vs_mutable_status", "distinct_vs_rows"],
      expected: churnedAccounts,
      unit: "count",
      tolerance: 0,
      knownWrongAnswers: [
        {
          value: churnedByCurrentStatus,
          because:
            "read subscriptions.canceled_at, which is cleared on win-back, so accounts that cancelled in August and came back are missing",
        },
      ],
    },
    {
      id: "SA4",
      shape: "saas",
      kind: "numeric",
      prompt: "What is our MRR right now, in dollars? Exclude internal and deleted accounts.",
      traps: ["minor_units", "test_rows_excluded", "soft_delete"],
      expected: round2(currentMrr),
      unit: "usd",
      tolerance: 0.001,
      knownWrongAnswers: [
        { value: round2(currentMrr * 100), because: "reported cents as dollars" },
        {
          value: round2(subs.reduce((s2, x) => s2 + (x.status === "active" ? Number(x.mrr_cents) : 0), 0) / 100),
          because: "summed every active subscription row without excluding internal and deleted accounts",
        },
      ],
    },
    {
      id: "SA5",
      shape: "saas",
      kind: "numeric",
      prompt:
        "Of the accounts that signed up in Q2 2026 (April 1 through June 30), what percentage started a paid " +
        "subscription within 30 days of signing up? Exclude internal and deleted accounts.",
      traps: ["cohort_denominator", "test_rows_excluded"],
      expected: round2((converted / cohort.length) * 100),
      unit: "percent",
      tolerance: 0.01,
      knownWrongAnswers: [
        { value: 100, because: "used only accounts that DO have a subscription as the denominator" },
        {
          value: round2((convertedEver / cohort.length) * 100),
          because: "ignored the 30-day window and counted every account that ever subscribed",
        },
      ],
    },
    {
      id: "SA6",
      shape: "saas",
      kind: "numeric",
      prompt: "How much did we actually collect in August 2026, in dollars? Only count invoices that were really paid.",
      traps: ["voided_rows", "minor_units"],
      expected: round2(collected),
      unit: "usd",
      tolerance: 0.001,
      knownWrongAnswers: [
        { value: round2(collectedIgnoringVoids), because: "counted invoices issued rather than paid, and included voided invoices" },
      ],
    },
    {
      id: "SA7",
      shape: "saas",
      kind: "narrative",
      prompt: "Which marketing channel brought in the most revenue last quarter?",
      traps: ["abstain_missing_field"],
      mustAssert: [
        "states that the data cannot answer this",
        "names the missing information specifically: nothing in the schema records an acquisition channel, campaign or referrer for an account",
      ],
      mustNotAssert: [
        "a named channel presented as the answer",
        "a claim that the database is not connected or unavailable",
      ],
    },
    {
      id: "SA8",
      shape: "saas",
      kind: "narrative",
      prompt: "What is our churn rate?",
      traps: ["ambiguous_definition"],
      mustAssert: [
        "either asks ONE clarifying question, or states explicitly which churn it computed",
        "distinguishes logo churn (accounts) from revenue churn (MRR), and names the period it measured over",
      ],
      mustNotAssert: [
        "a bare percentage with no stated numerator, denominator or period",
      ],
    },
  ];
}

function ecommerceQuestions(ds: Dataset): Question[] {
  const [augStart, augEnd] = localMonthRange(2026, 8, ds.timezone);
  const [julStart, julEnd] = localMonthRange(2026, 7, ds.timezone);
  const orders = rows(ds, "orders");
  const items = rows(ds, "order_items");
  const payments = rows(ds, "order_payments");
  const refundRows = rows(ds, "order_refunds");
  const fx = rows(ds, "fx_rates");
  const sessions = rows(ds, "web_sessions");

  const rate = new Map<string, number>();
  for (const r of fx) rate.set(String(r.currency), Number(r.usd_rate));
  const usd = (cents: unknown, currency: unknown) =>
    (Number(cents) / 100) * (rate.get(String(currency)) ?? 1);

  const augOrders = orders.filter((o) => o.status === "fulfilled" && inRange(o.placed_at, augStart, augEnd));
  const augOrderIds = new Set(augOrders.map((o) => o.id));
  const orderById = new Map(orders.map((o) => [o.id, o]));

  const grossUsd = augOrders.reduce((s, o) => s + usd(o.total_cents, o.currency), 0);
  const refundUsd = refundRows
    .filter((r) => augOrderIds.has(r.order_id))
    .reduce((s, r) => s + usd(r.amount_cents, orderById.get(r.order_id)!.currency), 0);
  const netUsd = grossUsd - refundUsd;

  const noFxUsd = augOrders.reduce((s, o) => s + Number(o.total_cents) / 100, 0);

  const itemsByOrder = new Map<unknown, number>();
  for (const i of items) itemsByOrder.set(i.order_id, (itemsByOrder.get(i.order_id) ?? 0) + 1);
  const paysByOrder = new Map<unknown, number>();
  for (const p of payments) paysByOrder.set(p.order_id, (paysByOrder.get(p.order_id) ?? 0) + 1);
  const fanoutUsd = augOrders.reduce(
    (s, o) => s + usd(o.total_cents, o.currency) * (itemsByOrder.get(o.id) ?? 1) * (paysByOrder.get(o.id) ?? 1),
    0,
  );

  const unitsBySku = new Map<string, number>();
  for (const i of items) {
    if (!augOrderIds.has(i.order_id)) continue;
    unitsBySku.set(String(i.sku), (unitsBySku.get(String(i.sku)) ?? 0) + Number(i.qty));
  }
  const topSku = [...unitsBySku.entries()].sort((a, b) => b[1] - a[1])[0];

  const augSessions = sessions.filter((s) => inRange(s.started_at, augStart, augEnd));
  const julSessions = sessions.filter((s) => inRange(s.started_at, julStart, julEnd));
  const cvr = (xs: Record<string, any>[]) =>
    xs.length === 0 ? 0 : (xs.filter((s) => s.converted).length / xs.length) * 100;

  return [
    {
      id: "EC1",
      shape: "ecommerce",
      kind: "numeric",
      prompt:
        "What was our net revenue in August 2026, reported in USD? We sell in USD, EUR and GBP. " +
        "Net means fulfilled orders placed that month, less refunds against those orders.",
      traps: ["join_fanout", "multi_currency_fx", "refunds_netted", "minor_units"],
      expected: round2(netUsd),
      unit: "usd",
      tolerance: 0.001,
      knownWrongAnswers: [
        { value: round2(noFxUsd), because: "added EUR and GBP amounts to USD without converting" },
        { value: round2(grossUsd), because: "did not subtract refunds" },
        { value: round2(fanoutUsd), because: "joined orders to order_items and order_payments, so each order's total was counted once per line item per payment" },
      ],
    },
    {
      id: "EC2",
      shape: "ecommerce",
      kind: "numeric",
      prompt: "How many orders PLACED in August 2026 were fulfilled?",
      traps: ["join_fanout", "distinct_vs_rows"],
      expected: augOrders.length,
      unit: "count",
      tolerance: 0,
      knownWrongAnswers: [
        { value: items.filter((i) => augOrderIds.has(i.order_id)).length, because: "counted order_items rows rather than orders" },
      ],
    },
    {
      id: "EC3",
      shape: "ecommerce",
      kind: "numeric",
      prompt:
        "What was our average order value in August 2026, in USD? Use the gross order total — shipping " +
        "included, before refunds.",
      traps: ["multi_currency_fx", "minor_units", "join_fanout"],
      expected: round2(grossUsd / augOrders.length),
      unit: "usd",
      tolerance: 0.001,
      knownWrongAnswers: [
        { value: round2(netUsd / augOrders.length), because: "netted refunds off, though this question asks for the gross order total" },
        { value: round2(noFxUsd / augOrders.length), because: "added EUR and GBP to USD without converting" },
      ],
    },
    {
      id: "EC4",
      shape: "ecommerce",
      kind: "narrative",
      prompt:
        "Our site conversion rate dropped hard from July to August. What happened, and what should I do about it?",
      traps: ["mix_shift_simpson", "segmentation"],
      mustAssert: [
        `blended conversion fell from about ${round2(cvr(julSessions))}% in July to about ${round2(cvr(augSessions))}% in August`,
        "conversion rate IMPROVED inside BOTH traffic sources (paid and organic) month over month",
        "the blended drop is caused by a mix shift: traffic moved toward paid, which converts far worse, not by any source getting worse",
      ],
      mustNotAssert: [
        "that the site, checkout or product got worse",
        "that conversion fell within a traffic source",
      ],
    },
    {
      id: "EC5",
      shape: "ecommerce",
      kind: "numeric",
      prompt: "How many web sessions did we get in August 2026?",
      traps: ["row_cap_truncation"],
      expected: augSessions.length,
      unit: "count",
      tolerance: 0,
      knownWrongAnswers: [
        { value: MAX_ROWS_PER_READ, because: "counted the rows returned by a capped SELECT instead of running count(*)" },
      ],
    },
    {
      id: "EC6",
      shape: "ecommerce",
      kind: "numeric",
      prompt: "Which product sold the most units in August 2026, and how many units was it? Answer with the unit count.",
      traps: ["join_fanout", "segmentation"],
      expected: topSku[1],
      unit: "count",
      tolerance: 0,
      knownWrongAnswers: [
        {
          value: 197,
          because:
            "wrote the month as a bare timestamp literal, so the boundary resolved in the database session's timezone instead of UTC",
        },
      ],
    },
    {
      id: "EC7",
      shape: "ecommerce",
      kind: "narrative",
      prompt: "What was our gross margin in August 2026?",
      traps: ["abstain_missing_field"],
      mustAssert: [
        "states that the data cannot answer this",
        "names the missing information specifically: there is no cost of goods / unit cost / supplier cost anywhere in the schema, so margin cannot be derived",
      ],
      mustNotAssert: [
        "a margin percentage or dollar figure presented as the answer",
        "a claim that the database is not connected or unavailable",
      ],
    },
    {
      id: "EC8",
      shape: "ecommerce",
      kind: "narrative",
      prompt: "What is our best selling product?",
      traps: ["ambiguous_definition", "segmentation"],
      mustAssert: [
        "says whether best-selling is measured in units or in revenue, and notes the two can disagree",
        "names the window it used",
      ],
      mustNotAssert: [
        "a single product named with no stated measure and no window",
      ],
    },
  ];
}

function consumerQuestions(ds: Dataset): Question[] {
  const users = rows(ds, "app_users");
  const events = rows(ds, "app_events");
  const [julStart, julEnd] = localMonthRange(2026, 7, ds.timezone);
  const [augStart, augEnd] = localMonthRange(2026, 8, ds.timezone);
  const [junStart, junEnd] = localMonthRange(2026, 6, ds.timezone);

  const byUser = new Map<unknown, Record<string, any>[]>();
  for (const e of events) {
    const list = byUser.get(e.user_id);
    if (list) list.push(e);
    else byUser.set(e.user_id, [e]);
  }
  const at = (e: Record<string, any>) => (e.at instanceof Date ? e.at : new Date(String(e.at)));
  const signup = (u: Record<string, any>) =>
    u.signed_up_at instanceof Date ? u.signed_up_at : new Date(String(u.signed_up_at));

  const CHECKOUT = new Set(["checkout_started", "begin_checkout"]);

  const julCohort = users.filter((u) => inRange(u.signed_up_at, julStart, julEnd));
  const activatedIn7 = julCohort.filter((u) =>
    (byUser.get(u.id) ?? []).some(
      (e) => e.name === "habit_created" && at(e).getTime() - signup(u).getTime() <= 7 * 86_400_000,
    ),
  ).length;

  const cohortStep = (names: Set<string> | string) =>
    julCohort.filter((u) =>
      (byUser.get(u.id) ?? []).some((e) =>
        typeof names === "string" ? e.name === names : names.has(e.name),
      ),
    ).length;

  const funnelCheckout = cohortStep(CHECKOUT);
  const julyCohortIds = new Set(julCohort.map((u) => u.id));
  const rawCheckoutEvents = events.filter(
    (e) => CHECKOUT.has(String(e.name)) && julyCohortIds.has(e.user_id),
  ).length;
  const funnelCheckoutOneNameOnly = cohortStep("checkout_started");
  const funnelSubscribed = cohortStep("subscription_started");

  const augOpeners = new Set(
    events.filter((e) => e.name === "app_opened" && inRange(e.at, augStart, augEnd)).map((e) => e.user_id),
  ).size;
  const augOpenEvents = events.filter(
    (e) => e.name === "app_opened" && inRange(e.at, augStart, augEnd),
  ).length;

  const junCohort = users.filter((u) => inRange(u.signed_up_at, junStart, junEnd));
  const retainedD30 = junCohort.filter((u) =>
    (byUser.get(u.id) ?? []).some((e) => at(e).getTime() - signup(u).getTime() >= 30 * 86_400_000),
  ).length;

  const julySubEvents = events.filter(
    (e) => e.name === "subscription_started" && inRange(e.at, julStart, julEnd),
  );
  const julySubRevenue =
    julySubEvents.reduce((sum, e) => {
      const props = typeof e.props === "string" ? JSON.parse(e.props) : (e.props ?? {});
      return sum + Number(props.price_cents ?? 0);
    }, 0) / 100;

  const byChannel = new Map<string, { n: number; subs: number }>();
  for (const u of users) {
    const k = String(u.acquisition_channel);
    const cur = byChannel.get(k) ?? { n: 0, subs: 0 };
    cur.n += 1;
    if ((byUser.get(u.id) ?? []).some((e) => e.name === "subscription_started")) cur.subs += 1;
    byChannel.set(k, cur);
  }
  const topChannel = [...byChannel.entries()].sort((a, b) => b[1].subs / b[1].n - a[1].subs / a[1].n)[0];

  return [
    {
      id: "CO1",
      shape: "consumer",
      kind: "numeric",
      prompt:
        "Of the people who signed up in July 2026, what percentage created their first habit within 7 days of signing up?",
      traps: ["cohort_denominator", "distinct_vs_rows"],
      expected: round2((activatedIn7 / julCohort.length) * 100),
      unit: "percent",
      tolerance: 0.01,
      knownWrongAnswers: [
        {
          value: round2(
            (activatedIn7 / julCohort.filter((u) => (byUser.get(u.id) ?? []).length > 0).length) * 100,
          ),
          because: "dropped signups with no events at all from the denominator",
        },
      ],
    },
    {
      id: "CO2",
      shape: "consumer",
      kind: "numeric",
      prompt:
        "For people who signed up in July 2026, how many reached the checkout step? Count people, not events. " +
        "Note that older clients report that step under a different event name.",
      traps: ["funnel_dedup", "event_name_variants", "distinct_vs_rows"],
      expected: funnelCheckout,
      unit: "count",
      tolerance: 0,
      knownWrongAnswers: [
        { value: funnelCheckoutOneNameOnly, because: "filtered on checkout_started only and dropped the legacy begin_checkout users" },
        { value: rawCheckoutEvents, because: "counted checkout events rather than distinct people — clients double-fire the step" },
      ],
    },
    {
      id: "CO3",
      shape: "consumer",
      kind: "numeric",
      prompt: "How many different people opened the app in August 2026?",
      traps: ["distinct_vs_rows"],
      expected: augOpeners,
      unit: "count",
      tolerance: 0,
      knownWrongAnswers: [{ value: augOpenEvents, because: "counted app_opened events rather than distinct users" }],
    },
    {
      id: "CO4",
      shape: "consumer",
      kind: "numeric",
      prompt:
        "What is day-30 retention for the June 2026 signup cohort? Treat a user as retained if they did anything " +
        "in the app on or after their 30th day.",
      traps: ["cohort_denominator"],
      expected: round2((retainedD30 / junCohort.length) * 100),
      unit: "percent",
      tolerance: 0.01,
      knownWrongAnswers: [
        {
          value: round2((retainedD30 / junCohort.filter((u) => (byUser.get(u.id) ?? []).length > 0).length) * 100),
          because: "dropped signups with no events at all from the cohort, though they are part of it",
        },
      ],
    },
    {
      id: "CO5",
      shape: "consumer",
      kind: "numeric",
      prompt: "How many events have we recorded in total?",
      traps: ["row_cap_truncation"],
      expected: events.length,
      unit: "count",
      tolerance: 0,
      knownWrongAnswers: [{ value: MAX_ROWS_PER_READ, because: "counted the rows a capped SELECT returned instead of running count(*)" }],
    },
    {
      id: "CO6",
      shape: "consumer",
      kind: "numeric",
      prompt:
        "Which acquisition channel converts best into a paid subscription, and what is its conversion rate? " +
        "Answer with the conversion rate of the best channel, as a percentage of that channel's signups.",
      traps: ["segmentation", "cohort_denominator"],
      expected: round2((topChannel[1].subs / topChannel[1].n) * 100),
      unit: "percent",
      tolerance: 0.01,
      knownWrongAnswers: [
        {
          value: round2((topChannel[1].subs / users.length) * 100),
          because: "divided that channel's subscribers by every signup instead of by that channel's own signups",
        },
      ],
    },
    {
      id: "CO9",
      shape: "consumer",
      kind: "numeric",
      prompt:
        "People who started a subscription in July 2026 — how much monthly revenue did that add, in dollars? " +
        "The price we charged is recorded on the subscription event itself.",
      traps: ["json_field", "minor_units"],
      expected: round2(julySubRevenue),
      unit: "usd",
      tolerance: 0.001,
      knownWrongAnswers: [
        {
          value: julySubEvents.length,
          because: "counted the subscription events instead of summing the price recorded on them",
        },
        { value: round2(julySubRevenue * 100), because: "reported cents as dollars" },
      ],
    },
    {
      id: "CO7",
      shape: "consumer",
      kind: "narrative",
      prompt: "How many people cancelled their Pro subscription in August 2026?",
      traps: ["abstain_missing_field"],
      mustAssert: [
        "states that the data cannot answer this",
        "names the missing information specifically: the event log records subscription_started but nothing that marks a subscription ENDING (no cancellation, expiry or churn event), and there is no subscription state table",
      ],
      mustNotAssert: [
        "a cancellation count presented as the answer",
        "a claim that the database is not connected or unavailable",
      ],
    },
    {
      id: "CO8",
      shape: "consumer",
      kind: "narrative",
      prompt: "How many active users do we have?",
      traps: ["ambiguous_definition"],
      mustAssert: [
        "either asks ONE clarifying question, or states the definition of active it used",
        "names the window (daily, weekly, monthly) and what action counts as active",
      ],
      mustNotAssert: [
        "a bare user count with no definition of active and no window",
      ],
    },
  ];
}

export const DEVELOPMENT_DATASETS: Record<string, () => Dataset> = {
  marketplace: buildMarketplace,
  saas: buildSaas,
  ecommerce: buildEcommerce,
  consumer: buildConsumer,
};

export const DATASETS: Record<string, () => Dataset> = {
  ...DEVELOPMENT_DATASETS,
  ...HOLDOUT_DATASETS,
};

export const DEVELOPMENT_SHAPES = Object.keys(DEVELOPMENT_DATASETS);

export function questionsFor(shape: string): { dataset: Dataset; questions: Question[] } {
  const dataset = DATASETS[shape]();
  const byShape: Record<string, (d: Dataset) => Question[]> = {
    marketplace: marketplaceQuestions,
    saas: saasQuestions,
    ecommerce: ecommerceQuestions,
    consumer: consumerQuestions,
    ...HOLDOUT_BUILDERS,
  };
  return { dataset, questions: byShape[shape](dataset) };
}

export const ALL_SHAPES = Object.keys(DATASETS);
export { HOLDOUT_SHAPES };

export const ALL_TRAPS: Trap[] = [
  "status_enum_variants",
  "event_log_vs_mutable_status",
  "test_rows_excluded",
  "soft_delete",
  "minor_units",
  "refunds_netted",
  "join_fanout",
  "distinct_vs_rows",
  "timezone_boundary",
  "row_cap_truncation",
  "multi_currency_fx",
  "voided_rows",
  "cohort_denominator",
  "funnel_dedup",
  "event_name_variants",
  "mix_shift_simpson",
  "json_field",
  "segmentation",
  "ambiguous_definition",
  "abstain_missing_field",
];
