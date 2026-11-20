
import { describe, it, expect } from "vitest";
import {
  normalizeCell,
  maskRow,
  buildBoundedSelect,
  clampLimit,
  clampOffset,
  ROW_BROWSE_MAX_LIMIT,
  ROW_BROWSE_MAX_OFFSET,
} from "../row-browser";
import { ExpectedToolError } from "@/services/tools/types";

describe("normalizeCell", () => {
  it("passes primitives through and null/undefined → null", () => {
    expect(normalizeCell("hi")).toBe("hi");
    expect(normalizeCell(42)).toBe(42);
    expect(normalizeCell(true)).toBe(true);
    expect(normalizeCell(null)).toBeNull();
    expect(normalizeCell(undefined)).toBeNull();
  });
  it("serializes bigint / Date / plain objects / class instances to strings", () => {
    expect(normalizeCell(10n)).toBe("10");
    expect(normalizeCell(new Date("2026-07-18T00:00:00.000Z"))).toBe("2026-07-18T00:00:00.000Z");
    expect(normalizeCell({ a: 1 })).toBe('{"a":1}');
    expect(normalizeCell([1, 2])).toBe("[1,2]");
    class Oid {
      toString() {
        return "507f1f77bcf86cd799439011";
      }
    }
    expect(normalizeCell(new Oid())).toBe("507f1f77bcf86cd799439011");
  });
  it("truncates very long values", () => {
    const big = "x".repeat(1000);
    const out = normalizeCell(big) as string;
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("maskRow", () => {
  it("masks secret-named columns and normalizes the rest", () => {
    const secretCols = new Set(["password", "api_key"]);
    const out = maskRow(
      { id: 1, email: "a@b.com", password: "hunter2", api_key: "sk_live_x", note: null },
      secretCols,
    );
    expect(out.id).toBe(1);
    expect(out.email).toBe("a@b.com");
    expect(out.password).toBe("••••••");
    expect(out.api_key).toBe("••••••");
    expect(out.note).toBeNull();
  });
  it("a null secret stays null (absence isn't masked to dots)", () => {
    const out = maskRow({ token: null }, new Set(["token"]));
    expect(out.token).toBeNull();
  });
  it("matches secret columns case-insensitively", () => {
    const out = maskRow({ Password: "x" }, new Set(["password"]));
    expect(out.Password).toBe("••••••");
  });
});

describe("buildBoundedSelect", () => {
  it("builds a bounded read for a bare or schema-qualified table", () => {
    expect(buildBoundedSelect("users", 26, 0)).toBe("SELECT * FROM users LIMIT 26 OFFSET 0");
    expect(buildBoundedSelect("public.orders", 10, 20)).toBe(
      "SELECT * FROM public.orders LIMIT 10 OFFSET 20",
    );
  });
  it("floors limit/offset to integers and never goes below 1 / 0", () => {
    expect(buildBoundedSelect("t", 5.9, 3.9)).toBe("SELECT * FROM t LIMIT 5 OFFSET 3");
    expect(buildBoundedSelect("t", 0, -5)).toBe("SELECT * FROM t LIMIT 1 OFFSET 0");
  });
  it("rejects an identifier-unsafe table name (no interpolation of injection)", () => {
    for (const bad of ["users; DROP TABLE users", "u'--", "a b", '"weird"', "a.b.c", "1t"]) {
      expect(() => buildBoundedSelect(bad, 10, 0)).toThrow(ExpectedToolError);
    }
  });
});

describe("clampLimit / clampOffset", () => {
  it("clamps limit into [1, MAX] and defaults non-finite", () => {
    expect(clampLimit(50)).toBe(50);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(9999)).toBe(ROW_BROWSE_MAX_LIMIT);
    expect(clampLimit(Number.NaN)).toBe(25);
  });
  it("clamps offset to >= 0 and defaults non-finite/negative", () => {
    expect(clampOffset(40)).toBe(40);
    expect(clampOffset(-3)).toBe(0);
    expect(clampOffset(Number.NaN)).toBe(0);
    expect(clampOffset(ROW_BROWSE_MAX_OFFSET)).toBe(ROW_BROWSE_MAX_OFFSET);
  });
  it("rejects past the max offset instead of silently repeating a page", () => {
    expect(() => clampOffset(ROW_BROWSE_MAX_OFFSET + 1)).toThrow(ExpectedToolError);
    try {
      clampOffset(ROW_BROWSE_MAX_OFFSET + 1);
    } catch (e) {
      expect((e as ExpectedToolError).code).toBe("operator_db_offset_too_large");
    }
  });
});
