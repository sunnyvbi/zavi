import { Readable } from "node:stream";
import { describe, it, expect, vi } from "vitest";
import { openPostgres, sslAttempts, NO_TLS_MESSAGE, isLoopbackHost, pgHostOf } from "../db/postgres";
import { openMysql, mysqlTls, applyStatementTimeout } from "../db/mysql";
import { mongoTls } from "../db/mongo";
import { checkRequest } from "../check";
import { parseRulesText } from "../rules";
import type { Introspection } from "../db/types";

describe("Postgres TLS: never a silent downgrade", () => {
  const noTls = () => Object.assign(new Error("The server does not support SSL connections"));
  it("no sslmode on a remote host: TLS required, a refusal is an error with the fix, no plaintext attempt", async () => {
    const configs: unknown[] = [];
    const factory = vi.fn((c: { ssl?: unknown }) => {
      configs.push(c.ssl);
      return { connect: async () => Promise.reject(noTls()), query: vi.fn(), end: async () => undefined } as never;
    });
    const d = openPostgres("postgres://ro:pw@db.example.com:5432/app", factory);
    await expect(d.test()).rejects.toThrow(NO_TLS_MESSAGE);
    expect(configs).toEqual([{ rejectUnauthorized: false }]);
  });
  it("loopback may fall back to plaintext; sslmode=disable is plaintext by request; verify-full verifies", () => {
    expect(sslAttempts("postgres://u:p@localhost/app")).toEqual([{ rejectUnauthorized: false }, false]);
    expect(sslAttempts("postgres://u:p@127.0.0.1/app")).toEqual([{ rejectUnauthorized: false }, false]);
    expect(sslAttempts("host=/var/run/postgresql dbname=app")).toEqual([{ rejectUnauthorized: false }, false]);
    expect(sslAttempts("postgres://u:p@db.internal/app?sslmode=disable")).toEqual([false]);
    expect(sslAttempts("postgres://u:p@db.internal/app?sslmode=verify-full")).toEqual([{ rejectUnauthorized: true }]);
    expect(sslAttempts("postgres://u:p@db.internal/app?sslmode=require")).toEqual([{ rejectUnauthorized: false }]);
    expect(sslAttempts("postgres://u:p@db.internal/app?sslmode=prefer")).toEqual([{ rejectUnauthorized: false }]);
    expect(isLoopbackHost(pgHostOf("postgres://u:p@[::1]:5432/app"))).toBe(true);
    expect(isLoopbackHost(pgHostOf("postgres://u:p@127.evil.com/app"))).toBe(false);
  });
  it("reports the transport after connecting", async () => {
    const factory = vi.fn(() => ({ connect: async () => undefined, query: vi.fn(async () => ({ rows: [], fields: [] })), end: async () => undefined }) as never);
    const d = openPostgres("postgres://u:p@db.internal/app?sslmode=require", factory);
    await d.test();
    expect(d.transport()).toBe("unverified_tls");
  });
});

describe("MySQL: server-side prepares, placeholders checked, TLS required off-box", () => {
  function fakeConn() {
    const execute = vi.fn(() => ({ stream: () => Readable.from([{ id: 1 }]) }));
    const query = vi.fn(async () => [[], []]);
    return { conn: { query, end: vi.fn(async () => undefined), destroy: vi.fn(), connection: { execute, query: vi.fn() } }, execute, query };
  }
  it("guarded SQL runs through execute (prepared), never query() with values", async () => {
    const f = fakeConn();
    const d = openMysql("mysql://ro:pw@localhost/app", async () => f.conn as never);
    const r = await d.sql("SELECT id FROM t WHERE id = ?", [1], { maxRows: 5, timeoutMs: 5000 });
    expect(r.rows).toEqual([{ id: 1 }]);
    expect(f.execute).toHaveBeenCalledWith("SELECT id FROM t WHERE id = ?", [1]);
    expect(f.conn.connection.query).not.toHaveBeenCalled();
  });
  it("LIMIT ? with a number runs as a literal (a prepared LIMIT refuses a bound number)", async () => {
    const f = fakeConn();
    const d = openMysql("mysql://ro:pw@localhost/app", async () => f.conn as never);
    await d.sql("SELECT id FROM t WHERE plan = ? LIMIT ? OFFSET ?", ["pro", 25, 50], { maxRows: 5, timeoutMs: 5000 });
    expect(f.execute).toHaveBeenCalledWith("SELECT id FROM t WHERE plan = ? LIMIT 25 OFFSET 50", ["pro"]);
  });
  it("?? and a placeholder-count mismatch are refused before anything runs", async () => {
    const f = fakeConn();
    const d = openMysql("mysql://ro:pw@localhost/app", async () => f.conn as never);
    await expect(d.sql("SELECT ?? FROM t WHERE id = ?", ["users.email", 1], { maxRows: 5, timeoutMs: 5000 })).rejects.toThrow(/\?\?/);
    await expect(d.sql("SELECT id FROM t WHERE id = ?", [1, 2], { maxRows: 5, timeoutMs: 5000 })).rejects.toThrow(/placeholder/);
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("the check refuses ?? in a request from Zavi with a reason", () => {
    const intro: Introspection = { dialect: "mysql", database: "app", tables: [{ name: "users", rowEstimate: 1, columns: [{ name: "id", type: "int", nullable: false }, { name: "email", type: "varchar", nullable: false }] }], skippedUnsafeNames: 0, namesSeenTotal: 1, deadlineHit: false, listingTruncated: false };
    const rules = parseRulesText("allowed_tables: [users]\nblocked_columns: [users.email]\nwhat_can_leave: rows_without_blocked_columns\n");
    const c = checkRequest({ op: "sql", text: "SELECT id FROM users WHERE id = ?", params: [1, "users.email"], max_rows: 5 }, { rules, dialect: "mysql", database: "app", catalog: intro, maxStatementMs: 30_000 });
    expect(!c.ok && c.reason).toMatch(/placeholder/);
  });
  it("statement timeouts are clamped numbers before they reach SET", async () => {
    const sqls: string[] = [];
    await applyStatementTimeout({ query: async (s: string) => void sqls.push(s) } as never, Number.NaN);
    expect(sqls[0]).toBe("SET SESSION MAX_EXECUTION_TIME = 5000");
  });
  it("TLS: remote host requires it, ssl=false opts out, loopback is plaintext", () => {
    expect(mysqlTls("mysql://u:p@db.example.com/app").ssl).toEqual({ rejectUnauthorized: false });
    expect(mysqlTls("mysql://u:p@db.example.com/app?ssl=false")).toEqual({ transport: "plaintext" });
    expect(mysqlTls("mysql://u:p@127.0.0.1/app")).toEqual({ transport: "plaintext" });
  });
});

describe("MongoDB TLS", () => {
  it("remote host requires TLS; +srv and tls=true are TLS; tls=false opts out; loopback plaintext", () => {
    expect(mongoTls("mongodb://u:p@db.example.com:27017/app").opts).toMatchObject({ tls: true });
    expect(mongoTls("mongodb+srv://u:p@cluster.mongodb.net/app").transport).toBe("verified_tls");
    expect(mongoTls("mongodb://u:p@db.example.com/app?tls=false").transport).toBe("plaintext");
    expect(mongoTls("mongodb://localhost:27017,127.0.0.1:27018/app").transport).toBe("plaintext");
    expect(mongoTls("mongodb://localhost:27017,db.example.com:27018/app").opts).toMatchObject({ tls: true });
  });
});
