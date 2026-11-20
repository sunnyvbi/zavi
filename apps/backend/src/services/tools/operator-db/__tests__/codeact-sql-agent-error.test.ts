
import { describe, expect, it } from "vitest";
import { describeSqlError, isAgentFixableSqlError, rethrowAsRecoverable } from "../codeact-sql";
import { ExpectedToolError } from "@/services/tools/types";

describe("isAgentFixableSqlError", () => {
  it("treats a query-shape Postgres error as the model's to fix", () => {
    for (const code of ["42703", "42P01", "42601", "42702", "42883", "42803"]) {
      expect(isAgentFixableSqlError({ code, message: "boom" }), code).toBe(true);
    }
  });

  it("does NOT treat a permission failure as a typo, even though it is class 42", () => {
    expect(isAgentFixableSqlError({ code: "42501", message: "permission denied for table invoices" })).toBe(
      false,
    );
    expect(isAgentFixableSqlError({ code: "42P01x" })).toBe(false);
  });

  it("treats MySQL's unknown-column / no-such-table / parse errors the same", () => {
    for (const errno of [1054, 1146, 1064, 1052, 1109]) {
      expect(isAgentFixableSqlError({ errno, message: "boom" }), String(errno)).toBe(true);
    }
  });

  it("leaves connection, auth and read-only-transaction failures alone", () => {
    expect(isAgentFixableSqlError({ code: "ECONNREFUSED" })).toBe(false);
    expect(isAgentFixableSqlError({ code: "28P01" })).toBe(false);
    expect(isAgentFixableSqlError({ code: "25006" })).toBe(false);
    expect(isAgentFixableSqlError({ errno: 1045 })).toBe(false);
    expect(isAgentFixableSqlError({ code: "ETIMEDOUT" })).toBe(false);
  });

  it("keeps the engine's text out of the message that gets logged", () => {
    const leak = "You have an error in your SQL syntax near 'email = 'ada@example.com''";
    expect(() => rethrowAsRecoverable({ errno: 1064, message: leak }, 2)).toThrow(ExpectedToolError);
    try {
      rethrowAsRecoverable({ errno: 1064, message: leak }, 2);
    } catch (e) {
      const err = e as ExpectedToolError;
      expect(err.code).toBe("codeact_sql_error");
      expect(err.message).not.toContain("ada@example.com");
      expect(err.message).toContain("sql_reads[2]");
      expect(String(err.meta?.db_message)).not.toContain("ada@example.com");
      expect(err.meta?.read_index).toBe(2);
    }
  });

  it("rethrows an error that is not the model's to fix, untouched", () => {
    const original = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    expect(() => rethrowAsRecoverable(original, 0)).toThrow(original);
    try {
      rethrowAsRecoverable(original, 0);
    } catch (e) {
      expect(e).toBe(original);
      expect(e).not.toBeInstanceOf(ExpectedToolError);
    }
  });

  it("treats a duplicate table alias as the model's to fix", () => {
    expect(isAgentFixableSqlError({ code: "42712" })).toBe(true);
    expect(isAgentFixableSqlError({ code: "42725" })).toBe(true);
  });

  it("withholds a syntax error's text, because it quotes the query back", () => {
    const leak = "You have an error in your SQL syntax near 'email = 'ada@example.com''";
    const described = describeSqlError({ errno: 1064, message: leak });
    expect(described).not.toContain("ada@example.com");
    expect(described).toMatch(/malformed/);

    const pgLeak = "unterminated quoted string at or near \"'ada@example.com\"";
    const pgDescribed = describeSqlError({ code: "42601", message: pgLeak, position: "42" });
    expect(pgDescribed).not.toContain("ada@example.com");
    expect(pgDescribed).toContain("position 42");
  });

  it("forwards an identifier-shaped message, which is schema the catalog already publishes", () => {
    expect(describeSqlError({ code: "42703", message: 'column "created_at" does not exist' })).toBe(
      'column "created_at" does not exist',
    );
    expect(describeSqlError({ errno: 1054, message: "Unknown column 'created_at' in 'field list'" })).toBe(
      "Unknown column 'created_at' in 'field list'",
    );
  });

  it("does not choke on a non-error", () => {
    expect(isAgentFixableSqlError(null)).toBe(false);
    expect(isAgentFixableSqlError("42703")).toBe(false);
    expect(isAgentFixableSqlError(undefined)).toBe(false);
  });
});
