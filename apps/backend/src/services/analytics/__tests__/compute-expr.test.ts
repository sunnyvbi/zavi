import { describe, it, expect } from "vitest";
import { ExprError, evaluate, pctChange, ppChange } from "../compute-expr";

describe("evaluate: arithmetic", () => {
  it("respects precedence, parentheses and unary minus", () => {
    expect(evaluate("1 + 2 * 3", {})).toBe(7);
    expect(evaluate("(1 + 2) * 3", {})).toBe(9);
    expect(evaluate("-a + b", { a: 2, b: 5 })).toBe(3);
    expect(evaluate("a / b", { a: 10, b: 4 })).toBe(2.5);
    expect(evaluate("1.5e3 / 3", {})).toBe(500);
  });

  it("has pct_change, pp_change and ratio", () => {
    expect(evaluate("pct_change(prior, current)", { prior: 200, current: 250 })).toBe(25);
    expect(evaluate("pp_change(0.12, 0.15)", {})).toBeCloseTo(3, 10);
    expect(evaluate("ratio(spend, customers)", { spend: 900, customers: 30 })).toBe(30);
    expect(pctChange(-100, -50)).toBe(50);
    expect(ppChange(0.5, 0.25)).toBe(-25);
  });

  it("refuses division by zero instead of returning Infinity", () => {
    expect(() => evaluate("a / b", { a: 1, b: 0 })).toThrow(ExprError);
    expect(() => evaluate("pct_change(0, 5)", {})).toThrow(/undefined/);
    expect(() => evaluate("ratio(1, 0)", {})).toThrow(/zero/);
  });
});

describe("evaluate: nothing but arithmetic", () => {
  const attacks = [
    "process.exit()",
    "process",
    "constructor",
    "a.constructor",
    "this",
    "globalThis",
    "require('fs')",
    "eval('1')",
    "Function('return 1')()",
    "a[0]",
    "`1`",
    "a; b",
    "a = 1",
    "__proto__",
    "toString",
    "hasOwnProperty",
  ];
  for (const src of attacks) {
    it(`rejects ${JSON.stringify(src)}`, () => {
      expect(() => evaluate(src, { a: 1, b: 2 })).toThrow(ExprError);
    });
  }

  it("an input name that is also an Object.prototype key is only read from inputs", () => {
    expect(() => evaluate("toString", {})).toThrow(/not one of the inputs/);
    expect(evaluate("toString + 1", { toString: 4 })).toBe(5);
  });

  it("rejects empty, over-long and trailing garbage", () => {
    expect(() => evaluate("", {})).toThrow(ExprError);
    expect(() => evaluate("1+".repeat(300) + "1", {})).toThrow(/500/);
    expect(() => evaluate("1 2", {})).toThrow(ExprError);
    expect(() => evaluate("(1", {})).toThrow(ExprError);
  });
});
