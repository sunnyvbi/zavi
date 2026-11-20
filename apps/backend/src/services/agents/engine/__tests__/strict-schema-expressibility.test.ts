import { describe, it, expect } from "vitest";
import { isStrictExpressible, stripNullsDeep } from "../strict-schema";

describe("isStrictExpressible", () => {
  it("true for a plain object schema (fixed properties)", () => {
    expect(
      isStrictExpressible({
        type: "object",
        properties: { a: { type: "string" }, b: { type: "number" } },
        required: ["a"],
      }),
    ).toBe(true);
  });

  it("false for an open map / record (additionalProperties schema, no properties)", () => {
    expect(
      isStrictExpressible({
        type: "object",
        additionalProperties: { type: "number" },
      }),
    ).toBe(false);
  });

  it("false when an open map is nested deep (the chief-of-staff `metrics` case)", () => {
    expect(
      isStrictExpressible({
        type: "object",
        properties: {
          decision: {
            anyOf: [
              {
                type: "object",
                properties: {
                  tier2: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        metrics: { type: "object", additionalProperties: { type: "number" } },
                      },
                    },
                  },
                },
              },
            ],
          },
        },
      }),
    ).toBe(false);
  });

  it("false for patternProperties / propertyNames (also unsupported by strict)", () => {
    expect(isStrictExpressible({ type: "object", patternProperties: { "^x": { type: "string" } } })).toBe(false);
    expect(isStrictExpressible({ type: "object", propertyNames: { pattern: "^x" } })).toBe(false);
  });

  it("true when additionalProperties is explicitly false", () => {
    expect(
      isStrictExpressible({ type: "object", properties: { a: { type: "string" } }, additionalProperties: false }),
    ).toBe(true);
  });

  it("total on odd input (non-objects pass as expressible)", () => {
    expect(isStrictExpressible("x")).toBe(true);
    expect(isStrictExpressible(null)).toBe(true);
    expect(isStrictExpressible(42)).toBe(true);
  });
});

describe("stripNullsDeep (null→absent reconciler)", () => {
  it("removes null-valued keys at every depth", () => {
    expect(
      stripNullsDeep({ a: "x", b: null, c: { d: null, e: 1 } }),
    ).toEqual({ a: "x", c: { e: 1 } });
  });

  it("removes null elements from arrays and recurses into elements", () => {
    expect(
      stripNullsDeep({ list: [1, null, { x: null, y: 2 }] }),
    ).toEqual({ list: [1, { y: 2 }] });
  });

  it("leaves non-null values (incl. 0, false, empty string) intact", () => {
    expect(stripNullsDeep({ a: 0, b: false, c: "", d: [] })).toEqual({
      a: 0,
      b: false,
      c: "",
      d: [],
    });
  });

  it("passes primitives through", () => {
    expect(stripNullsDeep("x")).toBe("x");
    expect(stripNullsDeep(5)).toBe(5);
  });
});
