import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveRunVariant, globalVariantSlug } from "../resolve-run-variant";
import {
  DEFAULT_VARIANT,
  VariantConfigSchema,
  stripVariantDisabledTools,
  variantSdkOptions,
} from "../variant-config";

type Res = { data: unknown; error: unknown };

function fakeSb(tables: Record<string, Res | (() => never)>): SupabaseClient {
  return {
    from(table: string) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => {
          const t = tables[table];
          return typeof t === "function" ? t() : t;
        },
      };
      return chain;
    },
  } as unknown as SupabaseClient;
}

const flagOff: Res = { data: { blob: {} }, error: null };
const assigned = (config: unknown): Res => ({
  data: { variant_slug: "v1", agent_engine_variants: { config } },
  error: null,
});
const resolve = (tables: Record<string, Res | (() => never)>) =>
  resolveRunVariant(fakeSb(tables), "tenant-1", "operator");

describe("VariantConfigSchema", () => {
  it("accepts a v1-shaped config", () => {
    const r = VariantConfigSchema.safeParse({
      effort: "low",
      thinking: { type: "enabled", budget_tokens: 2048 },
      max_turns: 30,
      isolate_settings: true,
      prompt: { agent_file: "v1", drop_core: ["output-shaping"] },
    });
    expect(r.success).toBe(true);
  });

  it("cannot drop a security or grounding contract", () => {
    for (const slug of ["security-hard-rules", "untrusted-data-handling", "anti-hallucination-gates"]) {
      expect(VariantConfigSchema.safeParse({ prompt: { drop_core: [slug] } }).success).toBe(false);
    }
  });

  it("rejects an unknown key instead of ignoring it", () => {
    expect(VariantConfigSchema.safeParse({ max_turn: 30 }).success).toBe(false);
  });

  it("rejects a non-Claude model and a path-shaped prompt file", () => {
    expect(VariantConfigSchema.safeParse({ model: "gpt-5.5" }).success).toBe(false);
    expect(VariantConfigSchema.safeParse({ prompt: { agent_file: "../x" } }).success).toBe(false);
  });
});

describe("variantSdkOptions", () => {
  it("spreads nothing for the default", () => {
    expect(variantSdkOptions({})).toEqual({});
  });

  it("maps to the SDK's option names", () => {
    expect(
      variantSdkOptions({
        effort: "low",
        thinking: { type: "enabled", budget_tokens: 2048 },
        isolate_settings: true,
      }),
    ).toEqual({
      effort: "low",
      thinking: { type: "enabled", budgetTokens: 2048 },
      settingSources: [],
    });
  });
});

describe("resolveRunVariant", () => {
  it("returns the assigned variant", async () => {
    const r = await resolve({
      system_config: flagOff,
      tenant_agent_variant_assignments: assigned({ effort: "low" }),
    });
    expect(r).toEqual({ slug: "v1", config: { effort: "low" } });
  });

  it.each([
    ["no assignment", { system_config: flagOff, tenant_agent_variant_assignments: { data: null, error: null } }],
    [
      "kill flag on",
      {
        system_config: { data: { blob: { engine_variants_disabled: true } }, error: null },
        tenant_agent_variant_assignments: assigned({ effort: "low" }),
      },
    ],
    [
      "flag read error",
      {
        system_config: { data: null, error: { message: "boom" } },
        tenant_agent_variant_assignments: assigned({ effort: "low" }),
      },
    ],
    [
      "assignment read error",
      { system_config: flagOff, tenant_agent_variant_assignments: { data: null, error: { message: "boom" } } },
    ],
    [
      "config no longer passes the schema",
      { system_config: flagOff, tenant_agent_variant_assignments: assigned({ max_turn: 30 }) },
    ],
    [
      "client throws",
      {
        system_config: flagOff,
        tenant_agent_variant_assignments: () => {
          throw new Error("network");
        },
      },
    ],
  ])("falls back to default: %s", async (_name, tables) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await resolve(tables as Record<string, Res | (() => never)>)).toBe(DEFAULT_VARIANT);
    warn.mockRestore();
  });
});

describe("globalVariantSlug (fleet-wide default, runtime-editable)", () => {
  const g = (d: unknown) => ({ engine_variant_defaults: d });

  it("prefers a per-agent entry over the wildcard", () => {
    expect(globalVariantSlug(g({ operator: "v2", "*": "v1" }), "operator")).toBe("v2");
    expect(globalVariantSlug(g({ operator: "v2", "*": "v1" }), "research")).toBe("v1");
  });

  it("returns null when nothing is set", () => {
    expect(globalVariantSlug({}, "operator")).toBeNull();
    expect(globalVariantSlug(g({}), "operator")).toBeNull();
  });

  it("ignores a malformed blob instead of inventing a variant", () => {
    for (const bad of [null, "v2", 7, ["v2"], { operator: 7 }, { operator: "" }, { operator: "  " }]) {
      expect(globalVariantSlug(g(bad), "operator"), JSON.stringify(bad)).toBeNull();
    }
  });

  it("treats the literal \"default\" as no override", () => {
    expect(globalVariantSlug(g({ "*": "default" }), "operator")).toBeNull();
  });
});

describe("resolveRunVariant precedence", () => {
  const withGlobal = (slug: string): Res => ({
    data: { blob: { engine_variant_defaults: { "*": slug } } },
    error: null,
  });
  const variantRow = (config: unknown): Res => ({ data: { config }, error: null });

  it("a per-tenant assignment beats the global", async () => {
    const r = await resolveRunVariant(
      fakeSb({ system_config: withGlobal("v2"), tenant_agent_variant_assignments: assigned({ effort: "high" }) }),
      "t", "operator",
    );
    expect(r.slug).toBe("v1");
  });

  it("falls through to the global when there is no assignment", async () => {
    const r = await resolveRunVariant(
      fakeSb({
        system_config: withGlobal("v2"),
        tenant_agent_variant_assignments: { data: null, error: null },
        agent_engine_variants: variantRow({ effort: "low" }),
      }),
      "t", "operator",
    );
    expect(r).toEqual({ slug: "v2", config: { effort: "low" } });
  });

  it("the kill switch beats the global", async () => {
    const r = await resolveRunVariant(
      fakeSb({
        system_config: { data: { blob: { engine_variants_disabled: true, engine_variant_defaults: { "*": "v2" } } }, error: null },
        tenant_agent_variant_assignments: { data: null, error: null },
        agent_engine_variants: variantRow({ effort: "low" }),
      }),
      "t", "operator",
    );
    expect(r).toBe(DEFAULT_VARIANT);
  });

  it("a FAILED assignment read falls to default, not to the global", async () => {
    const r = await resolveRunVariant(
      fakeSb({
        system_config: withGlobal("v2"),
        tenant_agent_variant_assignments: { data: null, error: { message: "boom" } },
        agent_engine_variants: variantRow({ effort: "low" }),
      }),
      "t", "operator",
    );
    expect(r).toBe(DEFAULT_VARIANT);
  });

  it("a global naming an unknown variant falls back to default", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await resolveRunVariant(
      fakeSb({
        system_config: withGlobal("ghost"),
        tenant_agent_variant_assignments: { data: null, error: null },
        agent_engine_variants: { data: null, error: null },
      }),
      "t", "operator",
    );
    expect(r).toBe(DEFAULT_VARIANT);
    warn.mockRestore();
  });
});

describe("tools.disable lever", () => {
  it("schema accepts a disable list of tool names", () => {
    expect(
      VariantConfigSchema.safeParse({ tools: { disable: ["github__search_code", "read_file"] } }).success,
    ).toBe(true);
  });

  it("schema rejects a non-name entry and a list over 60", () => {
    expect(VariantConfigSchema.safeParse({ tools: { disable: ["github search"] } }).success).toBe(false);
    expect(
      VariantConfigSchema.safeParse({ tools: { disable: Array.from({ length: 61 }, (_, i) => `t${i}`) } })
        .success,
    ).toBe(false);
  });

  const tools = ["github__search_code", "github__read_file", "memory__search"].map((name) => ({ name }));

  it("drops a tool named in full, keeps the rest", () => {
    expect(stripVariantDisabledTools(tools, ["github__search_code"]).map((t) => t.name)).toEqual([
      "github__read_file",
      "memory__search",
    ]);
  });

  it("drops a tool named by its bare suffix", () => {
    expect(stripVariantDisabledTools(tools, ["READ_FILE"]).map((t) => t.name)).toEqual([
      "github__search_code",
      "memory__search",
    ]);
  });

  it("returns the same list when nothing is disabled", () => {
    expect(stripVariantDisabledTools(tools, undefined)).toBe(tools);
    expect(stripVariantDisabledTools(tools, [])).toBe(tools);
  });
});
