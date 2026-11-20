import { beforeEach, describe, expect, it, vi } from "vitest";

const pgCalls: Array<{ sql: string; params?: unknown[] }> = [];
let reltuples: number | null = 10;
let fetchRows: Record<string, unknown>[] = [{ n: 1 }];

vi.mock("pg", () => ({
  Client: class {
    constructor(public opts: unknown) {}
    connect = vi.fn(async () => undefined);
    end = vi.fn(async () => undefined);
    query = vi.fn(async (sql: string, params?: unknown[]) => {
      pgCalls.push({ sql, params });
      if (/pg_class/.test(sql)) return { rows: [{ n: reltuples }] };
      if (/^FETCH/.test(sql)) return { rows: fetchRows };
      return { rows: [] };
    });
  },
  types: { getTypeParser: () => (v: unknown) => v },
}));
vi.mock("mysql2/promise", () => ({ createConnection: vi.fn() }));

import {
  fanOutCaveat,
  joinedTableNames,
  runCodeActReads as runOnSession,
  safeSessionTimeZone,
  type CodeActReadOptions,
  type CodeActReadResult,
} from "../codeact-sql";
import { openSqlSession } from "@/services/data-gateway/direct/sql";

async function runCodeActReads(dialect: "postgres" | "mysql", conn: string, reads: string[], opts: CodeActReadOptions = {}) {
  const session = await openSqlSession(dialect, conn, { timeZone: opts.timeZone });
  try {
    return await runOnSession(session, reads, opts);
  } finally {
    await session.close();
  }
}

beforeEach(() => {
  pgCalls.length = 0;
  reltuples = 10;
  fetchRows = [{ n: 1 }];
});

describe("session time zone", () => {
  it("sets the tenant zone as a bound parameter, before the read-only transaction", async () => {
    const [read] = await runCodeActReads("postgres", "postgres://x", ["SELECT now()::date AS d"], { timeZone: "America/Los_Angeles" });
    const tzAt = pgCalls.findIndex((c) => /set_config\('TimeZone', \$1, false\)/.test(c.sql));
    const beginAt = pgCalls.findIndex((c) => /BEGIN TRANSACTION READ ONLY/.test(c.sql));
    expect(tzAt).toBeGreaterThanOrEqual(0);
    expect(tzAt).toBeLessThan(beginAt);
    expect(pgCalls[tzAt].params).toEqual(["America/Los_Angeles"]);
    expect(pgCalls[tzAt].sql).not.toContain("America");
    expect(read.session_tz).toBe("America/Los_Angeles");
  });

  it("never sends a zone that is not a real, plainly shaped IANA name", async () => {
    await runCodeActReads("postgres", "postgres://x", ["SELECT 1"], { timeZone: "UTC'; DROP TABLE users; --" });
    expect(pgCalls.some((c) => /set_config/.test(c.sql))).toBe(false);
    expect(safeSessionTimeZone("Not/AZone")).toBeNull();
    expect(safeSessionTimeZone("UTC")).toBe("UTC");
  });

  it("changes nothing for callers that pass no zone", async () => {
    const [read] = await runCodeActReads("postgres", "postgres://x", ["SELECT 1"]);
    expect(pgCalls.some((c) => /set_config/.test(c.sql))).toBe(false);
    expect(read.session_tz).toBeUndefined();
  });
});

describe("fan-out warning", () => {
  it("names the tables a JOIN reads, and none for a read without one", () => {
    expect(joinedTableNames("SELECT * FROM bookings b JOIN public.users u ON u.id = b.user_id")).toEqual(["bookings", "public.users"]);
    expect(joinedTableNames("SELECT * FROM bookings")).toEqual([]);
    expect(joinedTableNames("SELECT 'a join b' FROM t -- join x")).toEqual([]);
  });

  it("warns when a JOIN returns clearly more rows than its largest table holds", async () => {
    reltuples = 10;
    fetchRows = Array.from({ length: 40 }, (_, i) => ({ user_id: i }));
    const sql = "SELECT b.user_id FROM bookings b JOIN payments p ON p.booking_id = b.id";
    const [read] = await runCodeActReads("postgres", "postgres://x", [sql]);
    const est = pgCalls.find((c) => /pg_class/.test(c.sql));
    expect(est?.params).toEqual([["bookings", "payments"]]);
    expect(read.largest_table_rows).toBe(10);
    expect(fanOutCaveat(sql, read)).toMatch(/matching one row to many/);
  });

  it("warns when a row-level JOIN result repeats its id", () => {
    const read: CodeActReadResult = {
      index: 0,
      row_count: 3,
      row_count_exact: true,
      truncated: false,
      rows: [{ id: 1 }, { id: 1 }, { id: 2 }],
    };
    expect(fanOutCaveat("SELECT u.id FROM users u JOIN orders o ON o.user_id = u.id", read)).toMatch(/repeats/);
    expect(fanOutCaveat("SELECT id FROM users", read)).toBeNull();
  });

  it("says nothing for a JOIN that stays within its tables", () => {
    const read: CodeActReadResult = { index: 0, row_count: 5, row_count_exact: true, truncated: false, rows: [{ id: 1 }, { id: 2 }], largest_table_rows: 100 };
    expect(fanOutCaveat("SELECT u.id FROM users u JOIN orders o ON o.user_id = u.id", read)).toBeNull();
  });
});
