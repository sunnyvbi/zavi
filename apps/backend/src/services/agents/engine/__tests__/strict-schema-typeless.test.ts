import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toOpenAiStrictSchema } from "../strict-schema";

function anyOfBranchesAllTyped(node: unknown): boolean {
  if (Array.isArray(node)) return node.every(anyOfBranchesAllTyped);
  if (!node || typeof node !== "object") return true;
  const o = node as Record<string, unknown>;
  for (const k of ["anyOf", "oneOf"]) {
    const br = o[k];
    if (Array.isArray(br) && br.some((b) => !b || typeof b !== "object" || !("type" in (b as object)) && !("anyOf" in (b as object)) && !("enum" in (b as object)))) return false;
  }
  return Object.values(o).every(anyOfBranchesAllTyped);
}

describe("toOpenAiStrictSchema: optional typeless field", () => {
  const schema = z.toJSONSchema(
    z.object({ claim: z.string(), evidence: z.unknown().optional().describe("the data") }),
  );

  it("never emits an anyOf branch without a type", () => {
    expect(anyOfBranchesAllTyped(toOpenAiStrictSchema(schema))).toBe(true);
  });

  it("makes the typeless field a nullable string that says how to pass structure", () => {
    const out = toOpenAiStrictSchema(schema) as { properties: Record<string, Record<string, unknown>>; required: string[] };
    expect(out.properties.evidence.type).toEqual(["string", "null"]);
    expect(String(out.properties.evidence.description)).toMatch(/the data/);
    expect(String(out.properties.evidence.description)).toMatch(/JSON string/);
    expect(out.required).toContain("evidence");
  });

  it("the tool's own validator still accepts what the model will send", () => {
    const tool = z.object({ claim: z.string(), evidence: z.unknown().optional() });
    expect(tool.safeParse({ claim: "x", evidence: '{"rows":3}' }).success).toBe(true);
  });
});

describe("toOpenAiStrictSchema: oneOf", () => {
  it("rewrites oneOf to anyOf (OpenAI: 'oneOf' is not permitted)", () => {
    const out = toOpenAiStrictSchema({
      type: "object",
      properties: { when: { oneOf: [{ type: "string" }, { type: "number" }] } },
      required: ["when"],
    }) as { properties: { when: Record<string, unknown> } };
    expect(out.properties.when.oneOf).toBeUndefined();
    expect(out.properties.when.anyOf).toEqual([{ type: "string" }, { type: "number" }]);
    expect(JSON.stringify(out)).not.toMatch(/"oneOf"/);
  });
});

describe("toOpenAiStrictSchema: literals and bare enums get a type", () => {
  it("infers type for const and enum nodes", () => {
    const out = toOpenAiStrictSchema({
      type: "object",
      properties: { kind: { const: "relative" }, level: { enum: ["a", "b"] }, n: { enum: [1, null] } },
      required: ["kind", "level", "n"],
    }) as { properties: Record<string, Record<string, unknown>> };
    expect(out.properties.kind.type).toBe("string");
    expect(out.properties.level.type).toBe("string");
    expect(out.properties.n.type).toEqual(["number", "null"]);
  });
});

import { listPraxisTools } from "@/services/mcp/internal/praxis";

describe("real object unions + optional literals (review fixes)", () => {
  it("praxis__remind.when is a satisfiable union: only anyOf, branches keep their own shape", () => {
    const t = listPraxisTools().find((x) => x.tool_name === "remind")!;
    const when = (toOpenAiStrictSchema(t.input_schema) as { properties: Record<string, Record<string, unknown>> }).properties.when;
    expect(when.oneOf).toBeUndefined();
    expect(when.type).toBeUndefined();
    expect(when.additionalProperties).toBeUndefined();
    expect(Array.isArray(when.anyOf)).toBe(true);
    for (const b of when.anyOf as Array<Record<string, unknown>>) {
      if (b.type === "null") continue;
      expect(b.type).toBe("object");
      expect(b.properties).toBeDefined();
    }
  });

  it("an optional literal becomes enum [value, null], never type-null beside a const", () => {
    const out = toOpenAiStrictSchema(z.toJSONSchema(z.object({ e: z.literal("base64").optional() }))) as { properties: Record<string, Record<string, unknown>> };
    expect(out.properties.e.const).toBeUndefined();
    expect(out.properties.e.enum).toEqual(["base64", null]);
    expect(out.properties.e.type).toEqual(["string", "null"]);
  });
});
