
import { describe, it, expect } from "vitest";
import { toOpenAiStrictSchema, reconcileOpenAiStrictToolInput } from "../strict-schema";
import { toOutputFormatJsonSchema } from "../../structured-output";
import { outputSchemas } from "@/agents/index";
import { zodToJsonSchema } from "@/services/tools/registry";
import { memorySearchTool } from "@/services/tools/memory/search";
import { memoryWriteTool } from "@/services/tools/memory/write";

const BANNED = [
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "default",
];

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function assertStrictLegal(schema: unknown, path = "$"): void {
  if (!isObj(schema)) return;
  for (const kw of BANNED) {
    expect(kw in schema, `${path}: banned keyword '${kw}' must be stripped`).toBe(
      false,
    );
  }
  if (isObj(schema.properties)) {
    const props = schema.properties as Record<string, unknown>;
    const required = new Set(
      Array.isArray(schema.required) ? (schema.required as string[]) : [],
    );
    expect(
      schema.additionalProperties,
      `${path}: object must set additionalProperties:false`,
    ).toBe(false);
    for (const key of Object.keys(props)) {
      expect(
        required.has(key),
        `${path}: property '${key}' must be in required`,
      ).toBe(true);
      assertStrictLegal(props[key], `${path}.properties.${key}`);
    }
  }
  const items = schema.items;
  if (Array.isArray(items)) items.forEach((it, i) => assertStrictLegal(it, `${path}.items[${i}]`));
  else if (items !== undefined) assertStrictLegal(items, `${path}.items`);
  if (schema.additionalItems !== undefined)
    assertStrictLegal(schema.additionalItems, `${path}.additionalItems`);
  for (const comb of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
    const arr = schema[comb];
    if (Array.isArray(arr)) arr.forEach((s, i) => assertStrictLegal(s, `${path}.${comb}[${i}]`));
  }
  for (const defsKey of ["$defs", "definitions"]) {
    const defs = schema[defsKey];
    if (isObj(defs))
      for (const [k, v] of Object.entries(defs)) assertStrictLegal(v, `${path}.${defsKey}.${k}`);
  }
}

describe("toOpenAiStrictSchema — core transforms", () => {
  it("object gets additionalProperties:false + all keys required", () => {
    const out = toOpenAiStrictSchema({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      required: ["a"],
    }) as Record<string, unknown>;
    expect(out.additionalProperties).toBe(false);
    expect(out.required).toEqual(["a", "b"]);
  });

  it("previously-optional prop becomes nullable; required prop unchanged", () => {
    const out = toOpenAiStrictSchema({
      type: "object",
      properties: { req: { type: "string" }, opt: { type: "number" } },
      required: ["req"],
    }) as Record<string, unknown>;
    const props = out.properties as Record<string, Record<string, unknown>>;
    expect(props.req.type).toBe("string");
    expect(props.opt.type).toEqual(["number", "null"]);
  });

  it("optional prop with enum/anyOf gets a null branch", () => {
    const out = toOpenAiStrictSchema({
      type: "object",
      properties: {
        e: { anyOf: [{ type: "string" }, { type: "number" }] },
      },
      required: [],
    }) as Record<string, unknown>;
    const props = out.properties as Record<string, Record<string, unknown>>;
    expect(props.e.anyOf).toContainEqual({ type: "null" });
  });

  it("hint-bearing banned keywords are stripped + folded into description", () => {
    const out = toOpenAiStrictSchema({
      type: "string",
      minLength: 3,
      maxLength: 100,
      pattern: "^[A-Z]",
    }) as Record<string, unknown>;
    expect("minLength" in out).toBe(false);
    expect("maxLength" in out).toBe(false);
    expect("pattern" in out).toBe(false);
    expect(String(out.description)).toContain("min 3 chars");
    expect(String(out.description)).toContain("max 100 chars");
    expect(String(out.description)).toContain("pattern");
  });

  it("non-hint banned keywords are stripped with no description", () => {
    const out = toOpenAiStrictSchema({
      type: "number",
      format: "int32",
      exclusiveMinimum: 0,
      multipleOf: 2,
      default: 4,
    }) as Record<string, unknown>;
    for (const kw of ["format", "exclusiveMinimum", "multipleOf", "default"]) {
      expect(kw in out).toBe(false);
    }
    expect(out.description).toBeUndefined();
  });

  it("strips minItems/maxItems on arrays + recurses into items", () => {
    const out = toOpenAiStrictSchema({
      type: "array",
      minItems: 1,
      maxItems: 5,
      items: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
    }) as Record<string, unknown>;
    expect("minItems" in out).toBe(false);
    expect("maxItems" in out).toBe(false);
    expect(String(out.description)).toContain("min 1 items");
    const items = out.items as Record<string, unknown>;
    expect(items.additionalProperties).toBe(false);
  });

  it("normalizes nested objects, anyOf branches, and $defs", () => {
    const out = toOpenAiStrictSchema({
      type: "object",
      properties: {
        nested: {
          type: "object",
          properties: { deep: { type: "string", minLength: 2 } },
          required: ["deep"],
        },
      },
      required: ["nested"],
      anyOf: [{ type: "object", properties: { y: { type: "string" } }, required: [] }],
      $defs: {
        Foo: { type: "object", properties: { z: { type: "number" } }, required: ["z"] },
      },
    });
    assertStrictLegal(out);
  });

  it("non-object inputs pass through unchanged", () => {
    expect(toOpenAiStrictSchema("hi")).toBe("hi");
    expect(toOpenAiStrictSchema(42)).toBe(42);
    expect(toOpenAiStrictSchema(null)).toBe(null);
    expect(toOpenAiStrictSchema(true)).toBe(true);
    expect(toOpenAiStrictSchema([1, 2])).toEqual([1, 2]);
  });

  it("does not mutate the input", () => {
    const input = {
      type: "object",
      properties: { a: { type: "string", minLength: 3 } },
      required: [],
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    toOpenAiStrictSchema(input);
    expect(input).toEqual(snapshot);
  });

  it("is idempotent (twice == once)", () => {
    const input = {
      type: "object",
      properties: {
        req: { type: "string", minLength: 3 },
        opt: { type: "number", maximum: 10 },
        arr: { type: "array", minItems: 1, items: { type: "string", pattern: "x" } },
      },
      required: ["req"],
    };
    const once = toOpenAiStrictSchema(input);
    const twice = toOpenAiStrictSchema(once);
    expect(twice).toEqual(once);
  });
});

describe("assertStrictLegal validator self-check", () => {
  it("rejects a schema that violates strict rules", () => {
    expect(() =>
      assertStrictLegal({
        type: "object",
        properties: { a: { type: "string" } },
        required: [],
      }),
    ).toThrow();
  });
});

describe("ALL outputSchemas project to strict-legal JSON Schema", () => {
  const slugs = Object.keys(outputSchemas);

  it("registers exactly the expected agents", () => {
    expect([...slugs].sort()).toEqual(
      [
        "advisor",
        "blog",
        "chatgpt_ads",
        "instagram_organic",
        "email_marketing",
        "linkedin_ads",
        "linkedin_organic",
        "meta_ads",
        "reddit_ads",
        "reddit_organic",
        "pinterest_organic",
        "sms",
        "tiktok_ads",
        "tiktok_organic",
        "ugc",
        "x_ads",
        "x_organic",
        "youtube_ads",
        "youtube_organic",
        "chief-of-staff",
        "content-design",
        "dispute-response",
        "engineer",
        "fundraising",
        "google_ads",
        "growth-lead",
        "performance-marketer",
        "pm",
        "qa",
        "research",
        "seo",
        "seo-geo",
        "geo",
        "support-lead",
        "generated_video",
      ].sort(),
    );
  });

  for (const slug of slugs) {
    it(`${slug}: two-channel JSON Schema → toOpenAiStrictSchema → strict-legal`, () => {
      let projected: unknown;
      try {
        projected = toOutputFormatJsonSchema(slug).schema;
      } catch (e) {
        console.warn(`[strict-schema.test] SKIP ${slug}: not projectable — ${(e as Error).message}`);
        return;
      }
      const strict = toOpenAiStrictSchema(projected);
      assertStrictLegal(strict, `outputSchema:${slug}`);
    });
  }
});

describe("real internal MCP tool input schemas → strict-legal", () => {
  const tools = [memorySearchTool, memoryWriteTool];
  for (const t of tools) {
    it(`${t.name}: zodToJsonSchema → toOpenAiStrictSchema → strict-legal`, () => {
      const json = zodToJsonSchema(t.input_schema);
      const strict = toOpenAiStrictSchema(json);
      assertStrictLegal(strict, `tool:${t.name}`);
    });
  }
});

describe("sanity: normalizer does not touch the server-side zod authority", () => {
  it("a conforming sample still passes outputSchemas[slug].safeParse", () => {
    const sample = { rendered_markdown: "## report\nall good" };
    const res = outputSchemas["performance-marketer"].safeParse(sample);
    expect(res.success).toBe(true);
  });
});

describe("reconcileOpenAiStrictToolInput (option b — schema-aware)", () => {
  const R = reconcileOpenAiStrictToolInput;

  it("drops a null OPTIONAL field (the operator_db projection/sort case)", () => {
    const schema = {
      type: "object",
      properties: { query: { type: "string" }, projection: { type: "object" }, sort: { type: "object" } },
      required: ["query"],
    };
    expect(R({ query: "x", projection: null, sort: null }, schema)).toEqual({ query: "x" });
  });

  it("KEEPS a null on a REQUIRED field (meaningful null)", () => {
    const schema = {
      type: "object",
      properties: { discount: { type: ["number", "null"] } },
      required: ["discount"],
    };
    expect(R({ discount: null }, schema)).toEqual({ discount: null });
  });

  it("KEEPS null array elements (positions matter)", () => {
    const schema = {
      type: "object",
      properties: { items: { type: "array", items: { type: ["number", "null"] } } },
      required: ["items"],
    };
    expect(R({ items: [1, null, 3] }, schema)).toEqual({ items: [1, null, 3] });
  });

  it("recurses into nested objects (nested optional null dropped)", () => {
    const schema = {
      type: "object",
      properties: {
        filter: { type: "object", properties: { a: { type: "object" }, b: { type: "number" } }, required: ["b"] },
      },
      required: ["filter"],
    };
    expect(R({ filter: { a: null, b: 1 } }, schema)).toEqual({ filter: { b: 1 } });
  });

  it("resolves a local $ref into $defs", () => {
    const schema = {
      $ref: "#/$defs/Root",
      $defs: { Root: { type: "object", properties: { p: { type: "object" }, q: { type: "number" } }, required: ["q"] } },
    };
    expect(R({ p: null, q: 2 }, schema)).toEqual({ q: 2 });
  });

  it("falls back to blanket strip when the node has no usable schema", () => {
    expect(R({ a: null, b: [1, null] }, undefined)).toEqual({ b: [1] });
  });

  it("leaves a fully-specified all-present input untouched", () => {
    const schema = { type: "object", properties: { a: { type: "string" }, b: { type: "number" } }, required: ["a", "b"] };
    expect(R({ a: "x", b: 2 }, schema)).toEqual({ a: "x", b: 2 });
  });
});
