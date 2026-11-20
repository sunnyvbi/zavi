import { describe, it, expect } from "vitest";
import { lexSql, checkReadOnly } from "@zavi/shared/db-guard";

const idents = (sql: string, d: "postgres" | "mysql") =>
  lexSql(sql, d).tokens.filter((t) => t.kind === "ident").map((t) => t.value.toLowerCase());

describe("sql-lexer differentials", () => {
  it("MySQL `1--1` is arithmetic, not a comment: the rest of the line stays visible", () => {
    expect(idents("SELECT 1--1 UNION SELECT email FROM users", "mysql")).toEqual(["email", "users"]);
  });
  it("MySQL `-- ` (with a space) is a comment", () => {
    expect(idents("SELECT id FROM t -- email", "mysql")).toEqual(["id", "t"]);
  });
  it("Postgres `--` is always a comment", () => {
    expect(idents("SELECT 1--1 email", "postgres")).toEqual([]);
  });
  it('MySQL "a\\" , email FROM users -- ": lexer sees the identifiers (MySQL would see one string)', () => {
    expect(idents('SELECT "a\\" , email FROM users -- "', "mysql")).toEqual(["a\\", "email", "users"]);
  });
  it.each([
    ["NBSP between name parts", "SELECT id FROM public users", "postgres"],
    ["zero-width space", "SELECT em​ail FROM users", "postgres"],
    ["line separator", "SELECT id FROM users", "mysql"],
    ["control character", "SELECT id\u0001FROM users", "postgres"],
    ["MySQL versioned executable comment", "SELECT /*!50000 email */ 1", "mysql"],
    ["MySQL optimizer hint comment", "SELECT /*+ email */ 1", "mysql"],
    ["E-string with escaped quote", "SELECT E'\\'' , email FROM users", "postgres"],
    ["U& identifier", 'SELECT U&"x" FROM users', "postgres"],
    ["@@version", "SELECT @@version", "mysql"],
    ["unterminated dollar quote", "SELECT $tag$ email FROM users", "postgres"],
  ] as const)("refuses: %s", (_n, sql, d) => {
    expect(lexSql(sql, d).unsafe).not.toBeNull();
  });
  it("# comment on MySQL hides only to end of line", () => {
    expect(idents("SELECT id # email\nFROM users", "mysql")).toEqual(["id", "users"]);
  });
  it("nested Postgres comment does not end early", () => {
    expect(idents("SELECT /* /* */ email */ id FROM users", "postgres")).toEqual(["id", "users"]);
  });
  it("complete $tag$ strings are dropped as literals", () => {
    expect(idents("SELECT $tag$ email $tag$ AS x", "postgres")).toEqual(["x"]);
  });
  it("read-only check sees inside MySQL executable comments and after 1--1", () => {
    expect(checkReadOnly("SELECT /*! INTO OUTFILE '/tmp/x' */ 1").ok).toBe(false);
    expect(checkReadOnly("SELECT 1--1 INTO OUTFILE '/tmp/x'").ok).toBe(false);
  });
});

describe("checkReadOnly uses the dialect-aware lexer", () => {
  it("(a) MySQL backslash escape cannot hide a second statement", () => {
    const sql = "SELECT '\\'' ; DELETE FROM users; '";
    expect(checkReadOnly(sql, "mysql").ok).toBe(false);
    expect(checkReadOnly(sql).ok).toBe(false);
  });
  it("(a') MySQL double-quoted text with a backslash is refused", () => {
    expect(checkReadOnly('SELECT "\\"" ; DELETE FROM users; "', "mysql").ok).toBe(false);
  });
  it("(b) Postgres -- without a space is a comment, the next line is code", () => {
    const sql = "SELECT 1 --'\n; DELETE FROM users; --'";
    const r = checkReadOnly(sql, "postgres");
    expect(r.ok).toBe(false);
    expect(checkReadOnly(sql).ok).toBe(false);
  });
  it.each([
    "SELECT comment FROM users",
    "SELECT id, replace(name, 'a', 'b') FROM users",
    "WITH x AS (SELECT id FROM users) SELECT * FROM x",
    "(SELECT 1)",
    "SELECT 1;",
    'SELECT "update" FROM audit_log',
  ])("must pass on both dialects: %s", (sql) => {
    expect(checkReadOnly(sql, "postgres")).toEqual({ ok: true });
    expect(checkReadOnly(sql, "mysql")).toEqual({ ok: true });
    expect(checkReadOnly(sql)).toEqual({ ok: true });
  });
  it.each([
    ["SELECT 1; DROP TABLE users", "codeact_sql_multi_statement"],
    ["WITH x AS (DELETE FROM users RETURNING *) SELECT * FROM x", "codeact_sql_write_rejected"],
    ["SELECT * INTO t2 FROM users", "codeact_sql_write_rejected"],
    ["SET search_path = x", "codeact_sql_not_read"],
    ["   ", "codeact_sql_empty"],
  ])("refuses %s with %s", (sql, code) => {
    const r = checkReadOnly(sql, "postgres");
    expect(r.ok === false && r.code).toBe(code);
  });
});
