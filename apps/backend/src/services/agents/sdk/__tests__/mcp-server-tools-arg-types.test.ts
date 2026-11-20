
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { buildToolInputShape, repairArgsFromSchema, unwrapToolArgs } from "../mcp-server-tools";

const OPERATOR_DB_QUERY_SCHEMA = {
  type: "object",
  properties: {
    collection: { type: "string" },
    mode: { type: "string", enum: ["find", "aggregate"] },
    filter: { type: "object", additionalProperties: {} },
    pipeline: { type: "array", items: { type: "object" } },
    limit: { type: "integer" },
    skip: { type: "integer" },
  },
  required: ["collection", "mode"],
};

const MEMORY_SEARCH_SCHEMA = {
  type: "object",
  properties: { query: { type: "string" }, k: { type: "integer" } },
  required: ["query"],
};

function throughSdk(inputSchema: unknown, emitted: unknown) {
  const { shape, declaresOwnInput } = buildToolInputShape(inputSchema);
  const parsed = z.object(shape).parse(emitted);
  return repairArgsFromSchema(inputSchema, unwrapToolArgs(parsed, declaresOwnInput));
}

function advertised(inputSchema: unknown) {
  const { shape } = buildToolInputShape(inputSchema);
  return z.toJSONSchema(z.object(shape), { io: "input" }) as {
    properties: Record<string, { type?: string }>;
  };
}

describe("advertised schema carries the real types", () => {
  it("every declared property advertises a type — an untyped `{}` is the bug", () => {
    const props = advertised(OPERATOR_DB_QUERY_SCHEMA).properties;

    expect(props.collection?.type).toBe("string");
    expect(props.mode?.type).toBe("string");
    expect(props.filter?.type).toBe("object");
    expect(props.pipeline?.type).toBe("array");
    expect(props.limit?.type).toBe("integer");

    for (const [name, schema] of Object.entries(props)) {
      if (name === "input") continue;
      expect(schema.type, `${name} advertises no type`).toBeDefined();
    }
  });

  it("the OLD z.unknown() shape advertises `{}` — proves the fix is load-bearing", () => {
    const old = z.toJSONSchema(z.object({ k: z.unknown().optional() }), { io: "input" }) as {
      properties: Record<string, object>;
    };
    expect(old.properties.k).toEqual({});
  });

  it("an absent / union type stays permissive rather than inventing a rejection", () => {
    const props = advertised({
      type: "object",
      properties: { anything: {}, multi: { type: ["string", "number"] } },
    }).properties;
    expect(props.anything).toEqual({});
    expect(props.multi).toEqual({});
  });
});

describe("stringified args are repaired (prod payloads, verbatim)", () => {
  it("operator_db__query aggregate — pipeline as JSON text (run 6b6c6eb8)", () => {
    const realInput = throughSdk(OPERATOR_DB_QUERY_SCHEMA, {
      collection: "trips",
      mode: "aggregate",
      pipeline:
        '[\n  {\n    "$match": {\n      "tripType": "subscription"\n    }\n  },\n  {\n    "$group": {\n      "_id": {"month": {"$month": "$tripStartDate"}},\n      "trip_count": {"$sum": 1}\n    }\n  }\n]',
    }) as { collection: string; mode: string; pipeline: unknown[] };

    expect(Array.isArray(realInput.pipeline)).toBe(true);
    expect(realInput.pipeline).toHaveLength(2);
    expect(realInput.pipeline[0]).toEqual({ $match: { tripType: "subscription" } });
    expect(realInput.collection).toBe("trips");

    const downstream = z.object({
      collection: z.string().min(1),
      mode: z.enum(["find", "aggregate"]),
      pipeline: z.array(z.record(z.string(), z.unknown())).optional(),
    });
    expect(downstream.safeParse(realInput).success).toBe(true);
  });

  it("operator_db__query find — filter as JSON text + limit as string (run 6b6c6eb8)", () => {
    const realInput = throughSdk(OPERATOR_DB_QUERY_SCHEMA, {
      collection: "trips",
      mode: "find",
      filter: '{"tripType": "subscription"}',
      limit: "2",
    });

    expect(realInput).toEqual({
      collection: "trips",
      mode: "find",
      filter: { tripType: "subscription" },
      limit: 2,
    });
  });

  it("memory__search — k as string (139 pm runs)", () => {
    expect(
      throughSdk(MEMORY_SEARCH_SCHEMA, {
        query: "payment processing dispute fraud billing onboarding automation stall",
        k: "8",
      }),
    ).toMatchObject({ k: 8 });
  });

  it("praxis_corpus__query_recent_runs — days/top_n as strings (run fedda012)", () => {
    const schema = {
      type: "object",
      properties: {
        days: { type: "integer" },
        top_n: { type: "integer" },
        status: { type: "string" },
      },
    };
    expect(throughSdk(schema, { days: "14", top_n: "50", status: "parse_failed" })).toEqual({
      days: 14,
      top_n: 50,
      status: "parse_failed",
    });
  });

  it("repairs booleans and the mirror case (a declared string sent as a number)", () => {
    const schema = {
      type: "object",
      properties: { dry_run: { type: "boolean" }, id: { type: "string" } },
    };
    expect(throughSdk(schema, { dry_run: "true", id: 17180 })).toEqual({
      dry_run: true,
      id: "17180",
    });
  });
});

describe("repair never corrupts a legitimate value", () => {
  it("correctly-typed args pass through untouched", () => {
    const realInput = throughSdk(OPERATOR_DB_QUERY_SCHEMA, {
      collection: "trips",
      mode: "find",
      filter: { tripType: "subscription" },
      limit: 2,
    });
    expect(realInput).toEqual({
      collection: "trips",
      mode: "find",
      filter: { tripType: "subscription" },
      limit: 2,
    });
  });

  it("a string that MEANS a string is never number-ified", () => {
    const schema = { type: "object", properties: { zip: { type: "string" } } };
    expect(throughSdk(schema, { zip: "01960" })).toEqual({ zip: "01960" });
  });

  it("a non-numeric string on a number field is left for the typed rejection", () => {
    const { shape } = buildToolInputShape(MEMORY_SEARCH_SCHEMA);
    const parsed = z.object(shape).safeParse({ query: "x", k: "a lot" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.path).toEqual(["k"]);
      expect(parsed.error.issues[0]?.message).toContain("number");
    }
  });

  it("a fractional string on an integer field is NOT silently truncated", () => {
    const { shape } = buildToolInputShape(MEMORY_SEARCH_SCHEMA);
    expect(z.object(shape).safeParse({ query: "x", k: "8.5" }).success).toBe(false);
  });

  it("malformed JSON on an object field is left for the typed rejection", () => {
    const { shape } = buildToolInputShape(OPERATOR_DB_QUERY_SCHEMA);
    const parsed = z
      .object(shape)
      .safeParse({ collection: "trips", mode: "find", filter: '{"tripType": ' });
    expect(parsed.success).toBe(false);
  });

  it("a JSON array on an object field does not pass as an object", () => {
    const { shape } = buildToolInputShape(OPERATOR_DB_QUERY_SCHEMA);
    expect(
      z.object(shape).safeParse({ collection: "trips", mode: "find", filter: "[1,2]" }).success,
    ).toBe(false);
  });

  it("omitted optional params stay omitted (no undefined keys injected)", () => {
    const realInput = throughSdk(OPERATOR_DB_QUERY_SCHEMA, {
      collection: "trips",
      mode: "find",
    }) as Record<string, unknown>;
    expect(Object.keys(realInput).sort()).toEqual(["collection", "mode"]);
  });

  it("nested keys are never stripped — the shape stays open below the top level", () => {
    const realInput = throughSdk(OPERATOR_DB_QUERY_SCHEMA, {
      collection: "trips",
      mode: "find",
      filter: { tripType: "subscription", nested: { deep: { deeper: [1, 2] } } },
    }) as { filter: Record<string, unknown> };
    expect(realInput.filter.nested).toEqual({ deep: { deeper: [1, 2] } });
  });

  it("the {input:{...}} envelope still works AND its contents are repaired", () => {
    expect(throughSdk(MEMORY_SEARCH_SCHEMA, { input: { query: "trial", k: "3" } })).toEqual({
      query: "trial",
      k: 3,
    });
  });

  it("repair is idempotent — running it twice changes nothing", () => {
    const once = repairArgsFromSchema(MEMORY_SEARCH_SCHEMA, { query: "x", k: "8" });
    expect(repairArgsFromSchema(MEMORY_SEARCH_SCHEMA, once)).toEqual(once);
    expect(once).toEqual({ query: "x", k: 8 });
  });
});
