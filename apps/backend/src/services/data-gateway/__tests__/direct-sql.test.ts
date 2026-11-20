import { describe, it, expect, vi, beforeEach } from "vitest";

const pg = vi.hoisted(() => ({
  queries: [] as { sql: string; params?: unknown[] }[],
  rows: [] as Record<string, unknown>[],
  failOn: null as RegExp | null,
  opts: null as unknown,
}));

vi.mock("pg", () => ({
  types: { getTypeParser: () => (v: unknown) => v },
  Client: class {
    constructor(opts: unknown) {
      pg.opts = opts;
    }
    async connect() {}
    async end() {}
    async query(sql: string, params?: unknown[]) {
      pg.queries.push({ sql, params });
      if (pg.failOn && pg.failOn.test(sql)) throw Object.assign(new Error("boom"), { code: "42703" });
      if (sql.startsWith("FETCH")) return { rows: pg.rows, fields: [{ name: "id", dataTypeID: 23 }] };
      return { rows: [], fields: [] };
    }
  },
}));
vi.mock("mysql2/promise", () => ({ createConnection: vi.fn() }));

import { openSqlSession } from "../direct/sql";

beforeEach(() => {
  pg.queries = [];
  pg.rows = [];
  pg.failOn = null;
});

describe("direct Postgres session", () => {
  it("opens one READ ONLY transaction with a timeout before any read, and a bounded read uses a cursor", async () => {
    pg.rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const s = await openSqlSession("postgres", "postgres://u:p@h/db", { statementTimeoutMs: 5000 });
    const r = await s.query("SELECT id FROM users;", [], { maxRows: 2 });
    await s.close();
    const sqls = pg.queries.map((q) => q.sql);
    expect(sqls.slice(0, 3)).toEqual(["BEGIN TRANSACTION READ ONLY", "SET LOCAL statement_timeout = 5000", "SET LOCAL search_path = pg_catalog, pg_temp"]);
    expect(sqls).toContain("DECLARE _zavi_cur_1 NO SCROLL CURSOR FOR SELECT id FROM users");
    expect(sqls).toContain("FETCH FORWARD 3 FROM _zavi_cur_1");
    expect(sqls[sqls.length - 1]).toBe("ROLLBACK");
    expect(r.truncated).toBe(true);
    expect(r.rows).toEqual([{ id: 1 }, { id: 2 }]);
    expect(r.fields).toEqual([{ name: "id", dataTypeID: 23 }]);
    expect((pg.opts as { statement_timeout: number }).statement_timeout).toBe(5000);
  });
  it("each read runs under a savepoint so one failure does not abort the next", async () => {
    const s = await openSqlSession("postgres", "postgres://u:p@h/db");
    pg.failOn = /^SELECT nope/;
    await expect(s.query("SELECT nope FROM t")).rejects.toThrow("boom");
    pg.failOn = null;
    await s.query("SELECT 1");
    const sqls = pg.queries.map((q) => q.sql);
    expect(sqls).toContain("ROLLBACK TO SAVEPOINT _zavi_sp_1");
    expect(sqls).toContain("RELEASE SAVEPOINT _zavi_sp_2");
  });
  it("passes params through to the cursor", async () => {
    const s = await openSqlSession("postgres", "postgres://u:p@h/db");
    await s.query("SELECT id FROM t WHERE x = $1", ["a"], { maxRows: 10 });
    expect(pg.queries.find((q) => q.sql.startsWith("DECLARE"))?.params).toEqual(["a"]);
  });
});
