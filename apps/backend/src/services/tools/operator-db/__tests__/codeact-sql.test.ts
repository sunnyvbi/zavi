import { describe, it, expect } from "vitest";
import {
  assertReadOnlyStatement,
  assertReadOnlyReads,
  stripSqlNoise,
  MAX_SQL_READS,
} from "../codeact-sql";
import { ExpectedToolError } from "@/services/tools/types";

describe("codeact-sql · statement-kind reject (security)", () => {
  it("accepts a plain SELECT", () => {
    expect(() => assertReadOnlyStatement("SELECT id, name FROM users LIMIT 10")).not.toThrow();
  });

  it("accepts a WITH (CTE) read", () => {
    expect(() =>
      assertReadOnlyStatement(
        "WITH t AS (SELECT id FROM users) SELECT count(*) FROM t",
      ),
    ).not.toThrow();
  });

  it("accepts a parenthesized SELECT", () => {
    expect(() => assertReadOnlyStatement("(SELECT 1)")).not.toThrow();
  });

  for (const write of [
    "UPDATE users SET banned = true WHERE id = 1",
    "DELETE FROM users WHERE id = 1",
    "INSERT INTO users (id) VALUES (1)",
    "DROP TABLE users",
    "TRUNCATE users",
    "ALTER TABLE users ADD COLUMN x int",
    "CREATE TABLE evil (id int)",
    "GRANT ALL ON users TO public",
    "MERGE INTO users USING staging ON users.id = staging.id WHEN MATCHED THEN UPDATE SET x = 1",
  ]) {
    it(`rejects: ${write.slice(0, 32)}...`, () => {
      let err: unknown;
      try {
        assertReadOnlyStatement(write);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ExpectedToolError);
      expect((err as ExpectedToolError).code).toMatch(/codeact_sql_(not_read|write_rejected)/);
    });
  }

  it("rejects SELECT ... INTO (table creation via SELECT)", () => {
    expect(() =>
      assertReadOnlyStatement("SELECT * INTO new_table FROM users"),
    ).toThrow(ExpectedToolError);
  });

  it("rejects a writable CTE smuggled into a WITH...SELECT", () => {
    let err: unknown;
    try {
      assertReadOnlyStatement(
        "WITH x AS (DELETE FROM users RETURNING id) SELECT * FROM x",
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ExpectedToolError);
    expect((err as ExpectedToolError).code).toBe("codeact_sql_write_rejected");
  });

  it("rejects a procedure call (CALL / EXECUTE)", () => {
    expect(() => assertReadOnlyStatement("CALL do_bad_thing()")).toThrow(ExpectedToolError);
    expect(() => assertReadOnlyStatement("EXECUTE some_prepared_stmt")).toThrow(ExpectedToolError);
  });

  it("rejects a second statement smuggled after a semicolon", () => {
    let err: unknown;
    try {
      assertReadOnlyStatement("SELECT 1; DROP TABLE users");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ExpectedToolError);
    expect((err as ExpectedToolError).code).toBe("codeact_sql_multi_statement");
  });

  it("allows a single trailing semicolon", () => {
    expect(() => assertReadOnlyStatement("SELECT 1;")).not.toThrow();
  });

  it("does not false-positive on a forbidden word inside a string literal", () => {
    expect(() =>
      assertReadOnlyStatement("SELECT id FROM notes WHERE body = 'please do not delete me'"),
    ).not.toThrow();
  });

  it("does not false-positive on a forbidden word as a column/identifier", () => {
    expect(() =>
      assertReadOnlyStatement('SELECT "update" FROM audit_log'),
    ).not.toThrow();
  });

  it("rejects a write hidden behind a line comment that re-enables it", () => {
    expect(() =>
      assertReadOnlyStatement("SELECT 1 -- harmless\nFROM (DELETE FROM users) x"),
    ).toThrow(ExpectedToolError);
  });
});

describe("codeact-sql · stripSqlNoise", () => {
  it("removes line comments", () => {
    expect(stripSqlNoise("SELECT 1 -- DROP TABLE x\n")).not.toMatch(/DROP/);
  });
  it("removes block comments", () => {
    expect(stripSqlNoise("SELECT /* DELETE */ 1")).not.toMatch(/DELETE/);
  });
  it("removes single-quoted strings", () => {
    expect(stripSqlNoise("SELECT 'UPDATE users'")).not.toMatch(/UPDATE/);
  });
  it("removes dollar-quoted strings (postgres)", () => {
    expect(stripSqlNoise("SELECT $$ DROP TABLE x $$")).not.toMatch(/DROP/);
  });
});

describe("codeact-sql · array validation + caps", () => {
  it("rejects a non-array", () => {
    expect(() => assertReadOnlyReads("SELECT 1" as unknown)).toThrow(ExpectedToolError);
  });
  it("rejects an empty array", () => {
    expect(() => assertReadOnlyReads([])).toThrow(ExpectedToolError);
  });
  it("rejects more than the cap", () => {
    const tooMany = Array(MAX_SQL_READS + 1).fill("SELECT 1");
    let err: unknown;
    try {
      assertReadOnlyReads(tooMany);
    } catch (e) {
      err = e;
    }
    expect((err as ExpectedToolError).code).toBe("codeact_sql_too_many");
  });
  it("accepts a valid read set and narrows the type", () => {
    const reads: unknown = ["SELECT 1", "SELECT 2"];
    assertReadOnlyReads(reads);
    expect(reads.length).toBe(2);
  });
  it("rejects the whole set if ANY entry is a write", () => {
    expect(() =>
      assertReadOnlyReads(["SELECT 1", "DELETE FROM users"]),
    ).toThrow(ExpectedToolError);
  });
});
