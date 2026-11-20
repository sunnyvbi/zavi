import { describe, it, expect, vi, beforeEach } from "vitest";

const queries: string[] = [];
let TABLES: string[] = [];

vi.mock("mysql2/promise", () => {
  const conn = {
    query: async (arg: string | { sql: string; values?: unknown[] }) => {
      const sql = typeof arg === "string" ? arg : arg.sql;
      const values = typeof arg === "string" ? [] : (arg.values ?? []);
      queries.push(sql);

      if (/information_schema\.tables/.test(sql)) {
        return [TABLES.map((n, i) => ({ n, est: (TABLES.length - i) * 10 }))];
      }
      if (/information_schema\.columns/.test(sql)) {
        const rows = (values as string[]).flatMap((t) => [
          { tbl: t, name: "id", type: "bigint", nullable: "NO" },
          { tbl: t, name: "created_at", type: "datetime", nullable: "YES" },
        ]);
        return [rows];
      }
      return [[]];
    },
    end: async () => undefined,
  };
  return { default: { createConnection: async () => conn } };
});

const infoSchemaCalls = () => queries.filter((q) => /information_schema/.test(q));
const columnCalls = () => queries.filter((q) => /information_schema\.columns/.test(q));

beforeEach(() => {
  queries.length = 0;
});

describe("MySQL discovery round trips", () => {
  it("1000 tables costs a handful of queries, not thousands", async () => {
    TABLES = Array.from({ length: 1000 }, (_, i) => `tbl_${String(i).padStart(4, "0")}`);
    const { introspectMysql } = await import("@/services/data-gateway/discovery/mysql");
    const { COLUMN_BATCH } = await import("../discovery/util");

    const raw = await introspectMysql("mysql://u:p@h/db", 1000, Date.now() + 240_000);

    const expectedColumnQueries = Math.ceil(1000 / COLUMN_BATCH);
    expect(columnCalls().length).toBe(expectedColumnQueries);
    expect(infoSchemaCalls().length).toBe(1 + expectedColumnQueries);
    expect(raw.tables).toHaveLength(1000);
    expect(raw.tables.every((t) => t.columns.length === 2)).toBe(true);
  });

  it("NO per-table query survives — round trips must not scale with N", async () => {
    const counts: number[] = [];
    for (const n of [10, 100, 200]) {
      queries.length = 0;
      TABLES = Array.from({ length: n }, (_, i) => `t_${i}`);
      const { introspectMysql } = await import("@/services/data-gateway/discovery/mysql");
      await introspectMysql("mysql://u:p@h/db", 1000, Date.now() + 240_000);
      counts.push(infoSchemaCalls().length);
    }
    expect(counts[0]).toBe(counts[1]);
    expect(counts[2]).toBeLessThanOrEqual(counts[1] + 1);
  });

  it("never issues a row-sampling SELECT — nothing reads samples, and they are customer data", async () => {
    TABLES = ["users", "bookings"];
    const { introspectMysql } = await import("@/services/data-gateway/discovery/mysql");
    await introspectMysql("mysql://u:p@h/db", 100, Date.now() + 60_000);
    for (const q of queries) {
      expect(q).not.toMatch(/SELECT \* FROM/i);
    }
  });

  it("row estimates come from the name listing, not a per-table query", async () => {
    TABLES = ["a", "b", "c"];
    const { introspectMysql } = await import("@/services/data-gateway/discovery/mysql");
    const raw = await introspectMysql("mysql://u:p@h/db", 100, Date.now() + 60_000);
    expect(raw.tables.map((t) => t.rowEstimate)).toEqual([30, 20, 10]);
    expect(queries.filter((q) => /table_rows/.test(q))).toHaveLength(1);
  });

  it("orders output by size (P2) even though columns arrive batched", async () => {
    TABLES = ["zzz_small", "aaa_big"];
    const { introspectMysql } = await import("@/services/data-gateway/discovery/mysql");
    const raw = await introspectMysql("mysql://u:p@h/db", 100, Date.now() + 60_000);
    expect(raw.tables.map((t) => t.name)).toEqual(["zzz_small", "aaa_big"]);
  });

  it("a blown deadline yields FEWER tables and sets deadlineHit — never empty-column tables", async () => {
    TABLES = Array.from({ length: 1000 }, (_, i) => `t_${i}`);
    const { introspectMysql } = await import("@/services/data-gateway/discovery/mysql");
    const raw = await introspectMysql("mysql://u:p@h/db", 1000, Date.now() - 1);
    expect(raw.deadlineHit).toBe(true);
    expect(raw.namesSeenTotal).toBe(1000);
    expect(raw.tables.every((t) => t.columns.length > 0)).toBe(true);
  });
});
