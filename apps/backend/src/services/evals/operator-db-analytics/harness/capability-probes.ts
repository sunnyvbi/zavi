
import { MAX_ROWS_PER_READ } from "@/services/tools/operator-db/codeact-sql";

export type ProbeKind = "sql" | "mongo";

export type SqlProbe = {
  id: string;
  kind: "sql";
  what: string;
  needed_by: string[];
  sql: Partial<Record<"postgres" | "mysql", string>>;
  shape: string;
  expect?: (value: unknown) => boolean;
};

export type MongoProbe = {
  id: string;
  kind: "mongo";
  what: string;
  needed_by: string[];
  shape: string;
  collection: string;
  mode: "find" | "aggregate";
  pipeline?: Record<string, unknown>[];
  filter?: Record<string, unknown>;
  expect_rejected?: boolean;
  expect?: (rows: unknown) => boolean;
};

export type Probe = SqlProbe | MongoProbe;

const num = (v: unknown): number => Number((v as Record<string, unknown> | undefined)?.n ?? NaN);

export const SQL_PROBES: SqlProbe[] = [
  {
    id: "SQL-COUNT-EXACT",
    kind: "sql",
    what: "count(*) over a table far larger than the row cap returns the true total, not the cap",
    needed_by: ["EC5", "CO5"],
    shape: "consumer",
    sql: {
      postgres: "SELECT count(*) AS n FROM app_events",
      mysql: "SELECT count(*) AS n FROM app_events",
    },
    expect: (v) => num(v) > MAX_ROWS_PER_READ,
  },
  {
    id: "SQL-DISTINCT",
    kind: "sql",
    what: "COUNT(DISTINCT x) — people, not rows",
    needed_by: ["MK3", "CO3"],
    shape: "consumer",
    sql: {
      postgres: "SELECT count(DISTINCT user_id) AS n FROM app_events WHERE name = 'app_opened'",
      mysql: "SELECT count(DISTINCT user_id) AS n FROM app_events WHERE name = 'app_opened'",
    },
    expect: (v) => num(v) > 0,
  },
  {
    id: "SQL-JOIN-AGG",
    kind: "sql",
    what: "multi-table join with GROUP BY — revenue by a dimension on another table",
    needed_by: ["MK5", "EC6"],
    shape: "marketplace",
    sql: {
      postgres:
        "SELECT l.city, sum(b.gross_cents) AS n FROM bookings b JOIN listings l ON l.id = b.listing_id GROUP BY l.city ORDER BY n DESC LIMIT 1",
      mysql:
        "SELECT l.city, sum(b.gross_cents) AS n FROM bookings b JOIN listings l ON l.id = b.listing_id GROUP BY l.city ORDER BY n DESC LIMIT 1",
    },
    expect: (v) => num(v) > 0,
  },
  {
    id: "SQL-CTE-WINDOW",
    kind: "sql",
    what: "CTE plus a window function — the standard way to write cohort and first-touch logic",
    needed_by: ["SA5", "CO1", "CO4"],
    shape: "saas",
    sql: {
      postgres:
        "WITH firsts AS (SELECT account_id, at, row_number() OVER (PARTITION BY account_id ORDER BY at) AS rn FROM subscription_events WHERE type = 'start') SELECT count(*) AS n FROM firsts WHERE rn = 1",
      mysql:
        "WITH firsts AS (SELECT account_id, at, row_number() OVER (PARTITION BY account_id ORDER BY at) AS rn FROM subscription_events WHERE type = 'start') SELECT count(*) AS n FROM firsts WHERE rn = 1",
    },
    expect: (v) => num(v) > 0,
  },
  {
    id: "SQL-TIMEZONE",
    kind: "sql",
    what: "bucket a timestamp by the OPERATOR's calendar day, not UTC",
    needed_by: ["MK1", "MK2", "MK3"],
    shape: "marketplace",
    sql: {
      postgres:
        "SELECT count(*) AS n FROM booking_events WHERE event = 'completed' AND (at AT TIME ZONE 'America/Los_Angeles') >= TIMESTAMP '2026-08-01 00:00:00' AND (at AT TIME ZONE 'America/Los_Angeles') < TIMESTAMP '2026-09-01 00:00:00'",
      mysql:
        "SELECT count(*) AS n FROM booking_events WHERE event = 'completed' AND CONVERT_TZ(at, '+00:00', '-07:00') >= '2026-08-01 00:00:00' AND CONVERT_TZ(at, '+00:00', '-07:00') < '2026-09-01 00:00:00'",
    },
    expect: (v) => num(v) > 0,
  },
  {
    id: "SQL-CONDITIONAL-AGG",
    kind: "sql",
    what: "conditional aggregation — a rate and its numerator in one pass",
    needed_by: ["EC4", "CO6"],
    shape: "ecommerce",
    sql: {
      postgres:
        "SELECT source, count(*) FILTER (WHERE converted) * 1.0 / count(*) AS n FROM web_sessions GROUP BY source ORDER BY source LIMIT 1",
      mysql:
        "SELECT source, sum(converted) * 1.0 / count(*) AS n FROM web_sessions GROUP BY source ORDER BY source LIMIT 1",
    },
    expect: (v) => Number.isFinite(num(v)),
  },
  {
    id: "SQL-CASE-INSENSITIVE-STATUS",
    kind: "sql",
    what: "match a status column whose values are written in mixed case",
    needed_by: ["MK1", "MK2"],
    shape: "marketplace",
    sql: {
      postgres: "SELECT count(*) AS n FROM bookings WHERE lower(status) = 'completed'",
      mysql: "SELECT count(*) AS n FROM bookings WHERE lower(status) = 'completed'",
    },
    expect: (v) => num(v) > 0,
  },
  {
    id: "SQL-LEFT-JOIN-NULL",
    kind: "sql",
    what: "LEFT JOIN with the anti-join filter in the ON clause, so the outer side survives",
    needed_by: ["MK2", "EC1"],
    shape: "marketplace",
    sql: {
      postgres:
        "SELECT count(*) AS n FROM bookings b LEFT JOIN booking_refunds r ON r.booking_id = b.id WHERE r.id IS NULL",
      mysql:
        "SELECT count(*) AS n FROM bookings b LEFT JOIN booking_refunds r ON r.booking_id = b.id WHERE r.id IS NULL",
    },
    expect: (v) => num(v) > 0,
  },
  {
    id: "SQL-FX-JOIN",
    kind: "sql",
    what: "convert amounts through a rate table before summing across currencies",
    needed_by: ["EC1", "EC3"],
    shape: "ecommerce",
    sql: {
      postgres:
        "SELECT sum(o.total_cents / 100.0 * f.usd_rate) AS n FROM orders o JOIN fx_rates f ON f.currency = o.currency AND f.rate_date = date(o.placed_at)",
      mysql:
        "SELECT sum(o.total_cents / 100.0 * f.usd_rate) AS n FROM orders o JOIN fx_rates f ON f.currency = o.currency AND f.rate_date = date(o.placed_at)",
    },
    expect: (v) => num(v) > 0,
  },
  {
    id: "SQL-JSON-EXTRACT",
    kind: "sql",
    what: "read a value out of a JSON column",
    needed_by: ["CO9"],
    shape: "consumer",
    sql: {
      postgres:
        "SELECT count(*) AS n FROM app_events WHERE name = 'subscription_started' AND (props ->> 'plan') = 'pro'",
      mysql:
        "SELECT count(*) AS n FROM app_events WHERE name = 'subscription_started' AND JSON_UNQUOTE(JSON_EXTRACT(props, '$.plan')) = 'pro'",
    },
    expect: (v) => num(v) > 0,
  },
  {
    id: "SQL-IN-LIST",
    kind: "sql",
    what: "union two event names that mean the same step",
    needed_by: ["CO2"],
    shape: "consumer",
    sql: {
      postgres:
        "SELECT count(DISTINCT user_id) AS n FROM app_events WHERE name IN ('checkout_started','begin_checkout')",
      mysql:
        "SELECT count(DISTINCT user_id) AS n FROM app_events WHERE name IN ('checkout_started','begin_checkout')",
    },
    expect: (v) => num(v) > 0,
  },
  {
    id: "SQL-CORRELATED-COHORT",
    kind: "sql",
    what: "a real cohort query: per-user signup joined to the user's own later events",
    needed_by: ["CO1", "CO4", "SA5"],
    shape: "consumer",
    sql: {
      postgres:
        "SELECT count(*) AS n FROM app_users u WHERE EXISTS (SELECT 1 FROM app_events e WHERE e.user_id = u.id AND e.name = 'habit_created' AND e.at <= u.signed_up_at + interval '7 days')",
      mysql:
        "SELECT count(*) AS n FROM app_users u WHERE EXISTS (SELECT 1 FROM app_events e WHERE e.user_id = u.id AND e.name = 'habit_created' AND e.at <= DATE_ADD(u.signed_up_at, INTERVAL 7 DAY))",
    },
    expect: (v) => num(v) > 0,
  },
  {
    id: "SQL-HEAVY-COHORT-TIMING",
    kind: "sql",
    what:
      "a genuine retention query over the whole event table finishes inside the statement timeout " +
      "(the timeout is the analytics ceiling nobody notices until a real customer database is bigger than a fixture)",
    needed_by: ["CO4"],
    shape: "consumer",
    sql: {
      postgres:
        "WITH c AS (SELECT id, signed_up_at FROM app_users), r AS (SELECT c.id FROM c JOIN app_events e ON e.user_id = c.id AND e.at >= c.signed_up_at + interval '30 days' GROUP BY c.id) SELECT count(*) AS n FROM r",
      mysql:
        "WITH c AS (SELECT id, signed_up_at FROM app_users), r AS (SELECT c.id FROM c JOIN app_events e ON e.user_id = c.id AND e.at >= DATE_ADD(c.signed_up_at, INTERVAL 30 DAY) GROUP BY c.id) SELECT count(*) AS n FROM r",
    },
    expect: (v) => num(v) >= 0,
  },
];

export const MONGO_PROBES: MongoProbe[] = [
  {
    id: "MDB-COUNT",
    kind: "mongo",
    what: "$count over a collection larger than the row cap",
    needed_by: ["CO5"],
    shape: "consumer",
    collection: "app_events",
    mode: "aggregate",
    pipeline: [{ $count: "n" }],
    expect: (rows) => Array.isArray(rows) && Number((rows[0] as any)?.n) > MAX_ROWS_PER_READ,
  },
  {
    id: "MDB-GROUP-SUM",
    kind: "mongo",
    what: "$group with $sum — a total, computed in the engine",
    needed_by: ["MK2"],
    shape: "marketplace",
    collection: "bookings",
    mode: "aggregate",
    pipeline: [{ $group: { _id: null, n: { $sum: "$gross_cents" } } }],
    expect: (rows) => Array.isArray(rows) && Number((rows[0] as any)?.n) > 0,
  },
  {
    id: "MDB-DISTINCT",
    kind: "mongo",
    what: "distinct users via $group on the user key",
    needed_by: ["MK3", "CO3"],
    shape: "consumer",
    collection: "app_events",
    mode: "aggregate",
    pipeline: [{ $group: { _id: "$user_id" } }, { $count: "n" }],
    expect: (rows) => Array.isArray(rows) && Number((rows[0] as any)?.n) > 0,
  },
  {
    id: "MDB-LOOKUP",
    kind: "mongo",
    what: "$lookup into another discovered collection — the Mongo join",
    needed_by: ["MK5"],
    shape: "marketplace",
    collection: "bookings",
    mode: "aggregate",
    pipeline: [
      { $lookup: { from: "listings", localField: "listing_id", foreignField: "id", as: "l" } },
      { $unwind: "$l" },
      { $group: { _id: "$l.city", n: { $sum: "$gross_cents" } } },
      { $sort: { n: -1 } },
      { $limit: 1 },
    ],
    expect: (rows) => Array.isArray(rows) && rows.length === 1,
  },
  {
    id: "MDB-DATE-BUCKET",
    kind: "mongo",
    what: "bucket by the operator's calendar month with $dateTrunc + a timezone",
    needed_by: ["MK1"],
    shape: "marketplace",
    collection: "booking_events",
    mode: "aggregate",
    pipeline: [
      { $match: { event: "completed" } },
      { $group: { _id: { $dateTrunc: { date: "$at", unit: "month", timezone: "America/Los_Angeles" } }, n: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ],
    expect: (rows) => Array.isArray(rows) && rows.length > 0,
  },
  {
    id: "MDB-CASE-INSENSITIVE",
    kind: "mongo",
    what: "case-insensitive status match via a regex",
    needed_by: ["MK1"],
    shape: "marketplace",
    collection: "bookings",
    mode: "aggregate",
    pipeline: [{ $match: { status: { $regex: "^completed$", $options: "i" } } }, { $count: "n" }],
    expect: (rows) => Array.isArray(rows) && Number((rows[0] as any)?.n) > 0,
  },
  {
    id: "MDB-EXPR",
    kind: "mongo",
    what:
      "$expr — compare two fields of the same document. Rejected by the read grammar today, " +
      "which blocks the whole 'within N days of signup' family unless rewritten via $addFields",
    needed_by: ["CO1", "SA5"],
    shape: "consumer",
    collection: "app_events",
    mode: "aggregate",
    pipeline: [{ $match: { $expr: { $gt: ["$at", "$at"] } } }, { $count: "n" }],
    expect_rejected: true,
  },
  {
    id: "MDB-FACET",
    kind: "mongo",
    what: "$facet — a funnel's steps in one pass",
    needed_by: ["CO2"],
    shape: "consumer",
    collection: "app_events",
    mode: "aggregate",
    pipeline: [
      {
        $facet: {
          opened: [{ $match: { name: "app_opened" } }, { $group: { _id: "$user_id" } }, { $count: "n" }],
          created: [{ $match: { name: "habit_created" } }, { $group: { _id: "$user_id" } }, { $count: "n" }],
        },
      },
    ],
    expect: (rows) => Array.isArray(rows) && rows.length === 1,
  },
  {
    id: "MDB-UNWIND-SET",
    kind: "mongo",
    what: "$addFields + $match — the rewrite an agent must reach for when $expr is refused",
    needed_by: ["CO1"],
    shape: "consumer",
    collection: "app_events",
    mode: "aggregate",
    pipeline: [
      { $addFields: { day: { $dateTrunc: { date: "$at", unit: "day" } } } },
      { $group: { _id: "$day", n: { $sum: 1 } } },
      { $sort: { _id: -1 } },
      { $limit: 3 },
    ],
    expect: (rows) => Array.isArray(rows) && rows.length > 0,
  },
];

export const ALL_PROBES: Probe[] = [...SQL_PROBES, ...MONGO_PROBES];
