import { describe, it, expect } from "vitest";
import { lexSql } from "@zavi/shared/db-guard";

const idents = (sql: string, d: "postgres" | "mysql" = "postgres") =>
  lexSql(sql, d).tokens.filter((t) => t.kind === "ident").map((t) => t.value);

describe("lexSql", () => {
  it("drops literals and comments, unquotes identifiers", () => {
    expect(idents(`SELECT "Email", u.id FROM public.users u WHERE note = 'email' -- email`)).toEqual([
      "Email", "u", "id", "public", "users", "u", "note",
    ]);
  });
  it("drops dollar-quoted strings", () => {
    expect(idents("SELECT $tag$ x $tag$ AS y")).toEqual(["y"]);
    expect(idents("SELECT $$ email $$")).toEqual([]);
  });
  it("marks quoted identifiers and next-char", () => {
    const t = lexSql(`SELECT count(*) FROM "Users"`, "postgres").tokens;
    const count = t.find((x) => x.value === "count")!;
    expect(count.next).toBe("(");
    const users = t.find((x) => x.value === "Users")!;
    expect(users.quoted).toBe(true);
  });
  it("MySQL backticks and # comments", () => {
    expect(idents("SELECT `email` FROM users # email", "mysql")).toEqual(["email", "users"]);
  });
  it("nested Postgres block comments do not hide code", () => {
    expect(idents("SELECT /* a /* b */ c */ email FROM users")).toEqual(["email", "users"]);
  });
  it("flags backslash in string literals, MySQL executable comments, @vars, unterminated text", () => {
    expect(lexSql(String.raw`SELECT 'a\' , email FROM users -- '`, "mysql").unsafe).toMatch(/Backslash/);
    expect(lexSql("SELECT /*! email */ 1", "mysql").unsafe).toMatch(/executable/);
    expect(lexSql("SELECT @@hostname", "mysql").unsafe).toMatch(/variables/);
    expect(lexSql("SELECT 'abc", "postgres").unsafe).toMatch(/Unterminated/);
    expect(lexSql("SELECT id FROM users", "postgres").unsafe).toBeNull();
  });
  it("params and casts", () => {
    const t = lexSql("SELECT id::text FROM t WHERE x = $1", "postgres").tokens;
    expect(t.some((x) => x.kind === "param" && x.value === "$1")).toBe(true);
    expect(t.some((x) => x.value === "::")).toBe(true);
  });
});
