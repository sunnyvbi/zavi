import { describe, it, expect } from "vitest";
import { BEHAVIORS, variantBehaviorOn } from "../behaviors";
import { VariantConfigSchema, makeVariantConfigSchema, DEFAULT_VARIANT } from "../variant-config";

describe("behaviour switches", () => {
  it("the shipped registry is empty, so any name is rejected today", () => {
    expect(Object.keys(BEHAVIORS)).toEqual([]);
    expect(VariantConfigSchema.safeParse({ behaviors: ["anything"] }).success).toBe(false);
    expect(VariantConfigSchema.safeParse({ behaviors: [] }).success).toBe(true);
  });

  it("accepts names in the registry, rejects unknown names", () => {
    const schema = makeVariantConfigSchema({ "evidence-first": { description: "x" } });
    expect(schema.safeParse({ behaviors: ["evidence-first"] }).success).toBe(true);
    expect(schema.safeParse({ behaviors: ["evidence-first", "nope"] }).success).toBe(false);
  });

  it("rejects inherited object keys as behaviour names", () => {
    const schema = makeVariantConfigSchema({ a: { description: "x" } });
    expect(schema.safeParse({ behaviors: ["toString"] }).success).toBe(false);
    expect(schema.safeParse({ behaviors: ["__proto__"] }).success).toBe(false);
  });

  it("caps the list at 10", () => {
    const reg = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`b${i}`, { description: "x" }]));
    const schema = makeVariantConfigSchema(reg);
    expect(schema.safeParse({ behaviors: Object.keys(reg).slice(0, 10) }).success).toBe(true);
    expect(schema.safeParse({ behaviors: Object.keys(reg) }).success).toBe(false);
  });

  it("variantBehaviorOn: on only when the variant names it", () => {
    expect(variantBehaviorOn({ slug: "v", config: { behaviors: ["x"] } }, "x")).toBe(true);
    expect(variantBehaviorOn({ slug: "v", config: { behaviors: ["x"] } }, "y")).toBe(false);
    expect(variantBehaviorOn(DEFAULT_VARIANT, "x")).toBe(false);
    expect(variantBehaviorOn(undefined, "x")).toBe(false);
  });
});
