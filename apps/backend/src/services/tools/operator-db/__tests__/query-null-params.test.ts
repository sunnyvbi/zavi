
import { describe, expect, it } from "vitest";
import { operatorDbQueryTool } from "../tools";
import { zodToJsonSchema } from "@/services/tools/registry";

describe("operator_db_query null-param tolerance", () => {
  it("accepts explicit null for every optional param (behaves like omitted)", () => {
    const parsed = operatorDbQueryTool.input_schema.parse({
      collection: "users",
      mode: "find",
      filter: null,
      pipeline: null,
      projection: null,
      sort: null,
      limit: null,
      skip: null,
    }) as Record<string, unknown>;
    expect(parsed.collection).toBe("users");
    expect(parsed.mode).toBe("find");
    expect("filter" in parsed).toBe(false);
    expect("pipeline" in parsed).toBe(false);
    expect("projection" in parsed).toBe(false);
    expect("sort" in parsed).toBe(false);
    expect("limit" in parsed).toBe(false);
    expect("skip" in parsed).toBe(false);
  });

  it("still parses real values unchanged", () => {
    const parsed = operatorDbQueryTool.input_schema.parse({
      collection: "bookings",
      mode: "find",
      filter: { status: "active", deleted_at: null },
      sort: { created_at: -1 },
      limit: 5,
    }) as Record<string, unknown>;
    expect(parsed.filter).toEqual({ status: "active", deleted_at: null });
    expect(parsed.sort).toEqual({ created_at: -1 });
    expect(parsed.limit).toBe(5);
  });

  it("still rejects wrong-typed params after coercion (non-JSON strings)", () => {
    expect(() =>
      operatorDbQueryTool.input_schema.parse({
        collection: "users",
        mode: "find",
        filter: "not-an-object",
      }),
    ).toThrow();
    expect(() =>
      operatorDbQueryTool.input_schema.parse({
        collection: "users",
        mode: "find",
        limit: "not-a-number",
      }),
    ).toThrow();
    expect(() =>
      operatorDbQueryTool.input_schema.parse({ collection: null, mode: "find" }),
    ).toThrow();
  });

  it("emits the same LLM-facing JSON Schema as before (preprocess is invisible)", () => {
    const schema = zodToJsonSchema(operatorDbQueryTool.input_schema) as {
      type: string;
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties).sort()).toEqual([
      "collection",
      "filter",
      "limit",
      "mode",
      "pipeline",
      "projection",
      "skip",
      "sort",
    ]);
    expect(schema.required.sort()).toEqual(["collection", "mode"]);
  });
});
