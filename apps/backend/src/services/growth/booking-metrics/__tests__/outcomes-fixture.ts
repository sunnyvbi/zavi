import type { OutcomeMap } from "../outcomes";

export type FixtureOrder = {
  id: string;
  customer: string | null;
  status: string;
  created: string | null;
  finished: string | null;
  amount: number | string | null;
  refund: number | null;
};

export const TZ = "America/Los_Angeles";

export const ORDERS: FixtureOrder[] = [
  { id: "a1", customer: "A", status: "completed", created: "2026-09-01T18:00:00Z", finished: "2026-09-03T18:00:00Z", amount: 100, refund: 0 },
  { id: "a2", customer: "A", status: "completed", created: "2026-10-01T18:00:00Z", finished: "2026-10-03T18:00:00Z", amount: 200, refund: 0 },
  { id: "b1", customer: "B", status: "completed", created: "2026-10-02T18:00:00Z", finished: "2026-10-04T18:00:00Z", amount: 300, refund: 50 },
  { id: "c1", customer: "C", status: "completed", created: "2026-09-30T18:00:00Z", finished: "2026-10-08T05:00:00Z", amount: 400, refund: 0 },
  { id: "d1", customer: "D", status: "paid_out", created: "2026-10-09T18:00:00Z", finished: "2026-10-10T18:00:00Z", amount: 150, refund: 0 },
  { id: "e1", customer: "E", status: "in_progress", created: "2026-10-05T18:00:00Z", finished: "2026-10-06T18:00:00Z", amount: 999, refund: 0 },
  { id: "f1", customer: "F", status: "completed", created: "2026-10-02T18:00:00Z", finished: null, amount: 80, refund: 0 },
  { id: "g1", customer: "G", status: "completed", created: "2026-10-14T18:00:00Z", finished: "2026-10-16T18:00:00Z", amount: 70, refund: 0 },
];

export const MAP: OutcomeMap = {
  engine: "postgres",
  booking_source: "orders",
  date_field: "created_at",
  status_field: "status",
  terminal_statuses: ["completed", "paid_out"],
  completed_at_field: "finished_at",
  customer_ref_field: "customer_id",
  revenue_field: "amount",
  refund_field: "refund",
  refund_basis: "booking_created_net",
  amount_unit: "dollars",
  currency: "USD",
  confirmed_at: "2026-10-01T00:00:00Z",
  outcome_confirmed_at: "2026-10-15T00:00:00Z",
};

export const EXPECT = {
  firstDays: [
    { date: "2026-10-04", customers: 1 },
    { date: "2026-10-07", customers: 1 },
    { date: "2026-10-10", customers: 1 },
  ],
  revenueDays: [
    { date: "2026-10-03", gross: 200, refund: 0, orders: 1, unreadable: 0 },
    { date: "2026-10-04", gross: 300, refund: 50, orders: 1, unreadable: 0 },
    { date: "2026-10-07", gross: 400, refund: 0, orders: 1, unreadable: 0 },
    { date: "2026-10-10", gross: 150, refund: 0, orders: 1, unreadable: 0 },
  ],
  floor: "2026-09-03T18:00:00.000Z",
  unplacedCac: 1,
};
