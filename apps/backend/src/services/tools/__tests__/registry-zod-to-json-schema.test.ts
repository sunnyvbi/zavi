
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { zodToJsonSchema } from "@/services/tools/registry";

describe("zodToJsonSchema — ZodDiscriminatedUnion + ZodLiteral support", () => {
  it("maps a discriminated union to JSON Schema oneOf with one entry per option", () => {
    const schema = z.discriminatedUnion("verb", [
      z.object({ verb: z.literal("a"), x: z.string() }),
      z.object({ verb: z.literal("b"), y: z.number() }),
    ]);
    const out = zodToJsonSchema(schema);
    expect(out).toHaveProperty("oneOf");
    expect((out.oneOf as unknown[]).length).toBe(2);
  });

  it("renders ZodLiteral as `{ const: <value> }`", () => {
    const out = zodToJsonSchema(z.literal("hello"));
    expect(out).toEqual({ const: "hello" });
  });

  it("renders the discriminator field as a const inside each oneOf branch", () => {
    const schema = z.discriminatedUnion("verb", [
      z.object({ verb: z.literal("file"), title: z.string() }),
      z.object({ verb: z.literal("post"), text: z.string() }),
    ]);
    const out = zodToJsonSchema(schema) as { oneOf: Array<{ properties: { verb: { const: string } } }> };
    expect(out.oneOf[0].properties.verb).toEqual({ const: "file" });
    expect(out.oneOf[1].properties.verb).toEqual({ const: "post" });
  });

  it("does not throw on the exact praxis__action shape", () => {
    const actionInput = z.discriminatedUnion("verb", [
      z.object({
        verb: z.literal("file-jira-issue"),
        project_key: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
        summary: z.string(),
        description: z.string(),
        issue_type: z.enum(["Task", "Bug", "Story"]).default("Task"),
      }),
      z.object({
        verb: z.literal("file-linear-issue"),
        team_id: z.string(),
        title: z.string(),
        description: z.string(),
      }),
      z.object({
        verb: z.literal("post-slack-message"),
        channel_id: z.string().regex(/^[CGD][A-Z0-9]+$/),
        text: z.string(),
        thread_ts: z.string().optional(),
      }),
    ]);
    expect(() => zodToJsonSchema(actionInput)).not.toThrow();
    const out = zodToJsonSchema(actionInput) as { oneOf: unknown[] };
    expect(out.oneOf.length).toBe(3);
  });

  it("unwraps ZodEffects (.refine) to the inner schema", () => {
    const refined = z
      .object({
        status: z.enum(["passed", "failed", "healed"]),
        cache: z.array(z.string()).optional(),
      })
      .refine((d) => d.status !== "healed" || d.cache !== undefined, {
        message: "healed requires cache",
      });
    expect(() => zodToJsonSchema(refined)).not.toThrow();
    const out = zodToJsonSchema(refined) as {
      type: string;
      properties: Record<string, unknown>;
    };
    expect(out.type).toBe("object");
    expect(out.properties.status).toBeDefined();
    expect(out.properties.cache).toBeDefined();
  });

  it("unwraps stacked ZodEffects (double refine)", () => {
    const refined2 = z
      .object({ a: z.string() })
      .refine(() => true, "first")
      .refine(() => true, "second");
    expect(() => zodToJsonSchema(refined2)).not.toThrow();
  });

  it("maps ZodRecord to additionalProperties (z.record(z.string(), z.string()))", () => {
    const rec = z.record(z.string(), z.string());
    const out = zodToJsonSchema(rec) as {
      type: string;
      additionalProperties: { type: string };
    };
    expect(out.type).toBe("object");
    expect(out.additionalProperties).toEqual({ type: "string" });
  });

  it("maps ZodUnknown / ZodAny to an empty schema (no constraints)", () => {
    expect(zodToJsonSchema(z.unknown())).toEqual({});
    expect(zodToJsonSchema(z.any())).toEqual({});
  });

  it("array of records of unknown works (exact qa-v2 shape)", () => {
    const arr = z.array(z.record(z.string(), z.unknown())).max(50);
    expect(() => zodToJsonSchema(arr)).not.toThrow();
    const out = zodToJsonSchema(arr) as { type: string; items: unknown };
    expect(out.type).toBe("array");
    expect(out.items).toEqual({
      type: "object",
      additionalProperties: {},
    });
  });

  describe("scalar unions", () => {
    it("emits a bare anyOf, NOT an object-wrapped oneOf", () => {
      const out = zodToJsonSchema(z.union([z.string(), z.number()])) as {
        type?: string;
        anyOf?: unknown[];
        oneOf?: unknown[];
      };
      expect(out.type).toBeUndefined();
      expect(out.oneOf).toBeUndefined();
      expect(out.anyOf).toEqual([{ type: "string" }, { type: "number" }]);
    });

    it("supports an explicit null branch", () => {
      const out = zodToJsonSchema(
        z.union([z.string().max(10), z.number(), z.boolean(), z.null()]),
      ) as { anyOf: Array<{ type: string }> };
      expect(out.anyOf.map((b) => b.type)).toEqual([
        "string",
        "number",
        "boolean",
        "null",
      ]);
    });

    it("still object-wraps a union whose branches are all objects", () => {
      const out = zodToJsonSchema(
        z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]),
      ) as { type: string; oneOf: unknown[] };
      expect(out.type).toBe("object");
      expect(out.oneOf).toHaveLength(2);
    });

    it("serializes the real render_xlsx input schema", async () => {
      const { renderXlsxInputSchema } = await import("@/services/reports/schema");
      const out = zodToJsonSchema(renderXlsxInputSchema) as { type: string };
      expect(out.type).toBe("object");
    });
  });
});

describe("zodToJsonSchema: .catch() fields (2026-09-18)", () => {
  it("advertises the inner shape and never marks a .catch field required", async () => {
    const { z } = await import("zod");
    const schema = z.object({
      keep: z.string(),
      stats: z.array(z.object({ value: z.string() })).optional().catch(() => undefined),
    });
    const out = zodToJsonSchema(schema) as { required?: string[]; properties: Record<string, { type?: string }> };
    expect(out.properties.stats.type).toBe("array");
    expect(out.required).toEqual(["keep"]);
  });
});
