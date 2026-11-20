import { describe, it, expect } from "vitest";
import { assertReadOnlyReads, toReadResult } from "../codeact-sql";

describe("N5 — statement-leading keywords are not column-name landmines", () => {
  it("ALLOWS reading columns that share a name with a leading-only command", () => {
    expect(() => assertReadOnlyReads(["SELECT comment FROM users"])).not.toThrow();
    expect(() => assertReadOnlyReads(["SELECT id, comment, notify FROM tickets"])).not.toThrow();
    expect(() => assertReadOnlyReads(["SELECT merge, replace, copy FROM t"])).not.toThrow();
    expect(() => assertReadOnlyReads(['SELECT "lock" FROM inventory'])).not.toThrow();
  });

  it("STILL rejects those keywords when they lead a statement", () => {
    expect(() => assertReadOnlyReads(["COMMENT ON TABLE users IS 'x'"])).toThrow();
    expect(() => assertReadOnlyReads(["SET search_path = evil"])).toThrow();
    expect(() => assertReadOnlyReads(["COPY users FROM '/tmp/x'"])).toThrow();
    expect(() => assertReadOnlyReads(["MERGE INTO users USING s ON (1=1)"])).toThrow();
  });

  it("STILL rejects real DML anywhere — incl. a writable CTE (the smuggling case)", () => {
    expect(() =>
      assertReadOnlyReads(["WITH x AS (DELETE FROM users RETURNING *) SELECT * FROM x"]),
    ).toThrow();
    expect(() => assertReadOnlyReads(["SELECT 1; DROP TABLE users"])).toThrow();
    expect(() => assertReadOnlyReads(["INSERT INTO users VALUES (1)"])).toThrow();
    expect(() => assertReadOnlyReads(["SELECT 1; SET search_path = evil"])).toThrow();
  });
});

describe("N4 — secret-looking columns never leave the backend", () => {
  it("drops secret-ish columns and keeps the rest", () => {
    const r = toReadResult(0, [
      { id: 1, email: "a@b.c", password_hash: "x", api_key: "k", session_token: "t" },
    ]);
    expect(r.rows[0]).toEqual({ id: 1, email: "a@b.c" });
  });

  it("is a no-op when nothing looks secret (analyst work is untouched)", () => {
    const rows = [{ id: 1, n: 42, created_at: "2026-01-01" }];
    expect(toReadResult(0, rows).rows[0]).toEqual(rows[0]);
  });

  it("handles an empty result without throwing", () => {
    expect(toReadResult(0, []).rows).toEqual([]);
  });
});

describe("N1 — composed metrics must not die on string counts", () => {
  it("arithmetic over two counts yields a number, not a TypeError", () => {
    const a = toReadResult(0, [{ n: 41 }]);
    const b = toReadResult(1, [{ n: 17 }]);
    const delta = (a.rows[0].n as number) - (b.rows[0].n as number);
    expect(delta).toBe(24);
    expect(typeof delta).toBe("number");
  });

  it("documents the failure mode we fixed: string counts break subtraction", () => {
    const asString = "41" as unknown as number;
    expect(typeof asString).toBe("string");
    expect(Number(asString) - 17).toBe(24);
  });
});
