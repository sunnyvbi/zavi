import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

const state: { blob: Record<string, unknown> | null; error: unknown } = {
  blob: {},
  error: null,
};

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            state.error
              ? { data: null, error: state.error }
              : {
                  data: state.blob === null ? null : { blob: state.blob },
                  error: null,
                },
        }),
      }),
    }),
  }),
}));

import {
  AGENT_OUTPUT_CLASS,
  getAgentOutputClass,
  buildTwoChannelSchema,
  toOutputFormatJsonSchema,
  stripSchemaKeys,
  unwrapDecisionForEmit,
  isStructuredOutputEnabled,
  isStructuredOutputEnabledFor,
  readStructuredOutputFlag,
  STRUCTURED_SIDE_CHANNEL_SLUGS,
} from "../structured-output";
import { dispatchers } from "@/agents/index";

beforeEach(() => {
  state.blob = {};
  state.error = null;
});

const ENVELOPE_AGENTS = [
  "engineer",
  "pm",
  "advisor",
  "chief-of-staff",
  "content-design",
  "growth-lead",
  "performance-marketer",
  "qa",
  "research",
  "support-lead",
  "dispute-response",
  "browser-operator",
] as const;

const TOP_LEVEL = [
  "engineer",
  "pm",
  "advisor",
  "chief-of-staff",
  "dispute-response",
];
const MARKDOWN_DERIVED = ["content-design", "growth-lead"];
const DIGEST_ONLY = [
  "performance-marketer",
  "qa",
  "research",
  "support-lead",
  "browser-operator",
];

describe("AGENT_OUTPUT_CLASS — every envelope agent classified, none missed", () => {
  it("classifies all 12 envelope agents", () => {
    for (const slug of ENVELOPE_AGENTS) {
      expect(AGENT_OUTPUT_CLASS[slug], `missing class for ${slug}`).toBeDefined();
    }
  });

  it("classification count adds up (5 top + 2 markdown + 5 digest = 12)", () => {
    expect(Object.keys(AGENT_OUTPUT_CLASS).length).toBe(12);
    expect(TOP_LEVEL.length + MARKDOWN_DERIVED.length + DIGEST_ONLY.length).toBe(12);
  });

  it("top_level_decision agents", () => {
    for (const s of TOP_LEVEL) expect(getAgentOutputClass(s)).toBe("top_level_decision");
  });
  it("markdown_derived_decision agents", () => {
    for (const s of MARKDOWN_DERIVED)
      expect(getAgentOutputClass(s)).toBe("markdown_derived_decision");
  });
  it("digest_only agents", () => {
    for (const s of DIGEST_ONLY) expect(getAgentOutputClass(s)).toBe("digest_only");
  });

  it("operator is NOT classified (output_envelope commented out)", () => {
    expect(AGENT_OUTPUT_CLASS["operator"]).toBeUndefined();
  });

  it("getAgentOutputClass throws on an unknown slug (never silently defaults)", () => {
    expect(() => getAgentOutputClass("nonexistent-agent")).toThrow(/no entry/);
  });
});

describe("buildTwoChannelSchema — wrapper shape per class", () => {
  it("rendered_markdown is the ONLY required field for every envelope agent", () => {
    for (const slug of ENVELOPE_AGENTS) {
      const wrapper = buildTwoChannelSchema(slug);
      const ok = wrapper.safeParse({ rendered_markdown: "hello" });
      expect(ok.success, `${slug}: bare rendered_markdown must validate`).toBe(true);
      const bad = wrapper.safeParse({});
      expect(bad.success, `${slug}: empty object must fail`).toBe(false);
    }
  });

  it("top_level_decision wrapper exposes an optional `decision` channel", () => {
    for (const slug of TOP_LEVEL) {
      const wrapper = buildTwoChannelSchema(slug) as z.ZodObject<z.ZodRawShape>;
      expect(Object.keys(wrapper.shape)).toContain("decision");
      expect(
        wrapper.safeParse({ rendered_markdown: "x", decision: null }).success,
      ).toBe(true);
    }
  });

  it("markdown_derived + digest_only wrappers have NO `decision` channel", () => {
    for (const slug of [...MARKDOWN_DERIVED, ...DIGEST_ONLY]) {
      const wrapper = buildTwoChannelSchema(slug) as z.ZodObject<z.ZodRawShape>;
      expect(
        Object.keys(wrapper.shape),
        `${slug} must not carry a decision channel`,
      ).not.toContain("decision");
    }
  });

  it("digest_only / markdown_derived wrapper is JUST {rendered_markdown} — no schema passthrough", () => {
    for (const slug of [...MARKDOWN_DERIVED, ...DIGEST_ONLY]) {
      if (slug === "growth-lead" || slug === "content-design") continue;
      const wrapper = buildTwoChannelSchema(slug) as z.ZodObject<z.ZodRawShape>;
      expect(Object.keys(wrapper.shape), `${slug}`).toEqual(["rendered_markdown"]);
      expect(wrapper.safeParse({ rendered_markdown: "x" }).success).toBe(true);
    }
  });

  it("growth-lead two-channel wrapper permits the optional `machine_digest` (Codex P2)", () => {
    const wrapper = buildTwoChannelSchema("growth-lead") as z.ZodObject<z.ZodRawShape>;
    expect(Object.keys(wrapper.shape).sort()).toEqual([
      "machine_digest",
      "rendered_markdown",
    ]);
    expect(wrapper.safeParse({ rendered_markdown: "x" }).success).toBe(true);
    const both = wrapper.safeParse({ rendered_markdown: "x", machine_digest: "## Tier 1\nBet: ..." });
    expect(both.success).toBe(true);
    if (both.success) {
      expect((both.data as { machine_digest?: string }).machine_digest).toBe(
        "## Tier 1\nBet: ...",
      );
    }
    const of = toOutputFormatJsonSchema("growth-lead");
    const props = (of.schema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(props)).toContain("machine_digest");
  });

  it("content-design wrapper carries recommendations alongside rendered_markdown", () => {
    const wrapper = buildTwoChannelSchema("content-design") as z.ZodObject<z.ZodRawShape>;
    expect(Object.keys(wrapper.shape).sort()).toEqual([
      "recommendations",
      "rendered_markdown",
    ]);
    const of = toOutputFormatJsonSchema("content-design");
    const props =
      (of.schema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(props)).toContain("recommendations");
  });

  it("performance-marketer wrapper stays byte-unchanged {rendered_markdown} only", () => {
    const wrapper = buildTwoChannelSchema(
      "performance-marketer",
    ) as z.ZodObject<z.ZodRawShape>;
    expect(Object.keys(wrapper.shape)).toEqual(["rendered_markdown"]);
    const of = toOutputFormatJsonSchema("performance-marketer");
    const props =
      (of.schema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(props)).not.toContain("machine_digest");
    expect(Object.keys(props)).not.toContain("recommendations");
  });
});

describe("toOutputFormatJsonSchema — builds for every envelope agent without throwing", () => {
  it("produces {type:'json_schema', schema} with rendered_markdown required", () => {
    for (const slug of ENVELOPE_AGENTS) {
      const of = toOutputFormatJsonSchema(slug);
      expect(of.type).toBe("json_schema");
      expect(of.schema).toBeTypeOf("object");
      const required = (of.schema as { required?: string[] }).required ?? [];
      expect(required, `${slug}`).toContain("rendered_markdown");
    }
  });
});

describe("unwrapDecisionForEmit — FAIL-CLOSED (Codex P1)", () => {
  it("top_level_decision: missing decision → null (no emit), hadDecisionChannel true", () => {
    const r = unwrapDecisionForEmit("pm", { rendered_markdown: "x" });
    expect(r.decision).toBeNull();
    expect(r.hadDecisionChannel).toBe(true);
  });

  it("top_level_decision: explicit null decision → null", () => {
    const r = unwrapDecisionForEmit("advisor", { rendered_markdown: "x", decision: null });
    expect(r.decision).toBeNull();
  });

  it("top_level_decision: empty {} decision → null (degrade-to-no-action)", () => {
    const r = unwrapDecisionForEmit("engineer", { rendered_markdown: "x", decision: {} });
    expect(r.decision).toBeNull();
  });

  it("top_level_decision: real decision → reconstructed WITH rendered_markdown re-attached", () => {
    const r = unwrapDecisionForEmit("pm", {
      rendered_markdown: "summary",
      decision: { status: "actionable", backlog: [{ item_id: "x" }] },
    });
    expect(r.decision).toMatchObject({
      status: "actionable",
      rendered_markdown: "summary",
    });
    expect(r.hadDecisionChannel).toBe(true);
  });

  it("markdown_derived: returns the envelope unchanged, hadDecisionChannel false", () => {
    const env = { rendered_markdown: "Publish:\n..." };
    const r = unwrapDecisionForEmit("content-design", env);
    expect(r.decision).toBe(env);
    expect(r.hadDecisionChannel).toBe(false);
  });

  it("digest_only: returns the envelope unchanged, hadDecisionChannel false", () => {
    const env = { rendered_markdown: "digest" };
    const r = unwrapDecisionForEmit("research", env);
    expect(r.decision).toBe(env);
    expect(r.hadDecisionChannel).toBe(false);
  });
});

describe("flag reader — default OFF, fail-safe, per-agent override", () => {
  it("absent key → OFF (default; legacy regex path)", async () => {
    state.blob = {};
    expect(await isStructuredOutputEnabled("pm")).toBe(false);
  });

  it("explicit true → ON for a classified agent", async () => {
    state.blob = { structured_output_enabled: true };
    expect(await isStructuredOutputEnabled("pm")).toBe(true);
  });

  it("explicit false → OFF", async () => {
    state.blob = { structured_output_enabled: false };
    expect(await isStructuredOutputEnabled("pm")).toBe(false);
  });

  it("global ON but agent in per-agent disable list → OFF (surgical rollback)", async () => {
    state.blob = {
      structured_output_enabled: true,
      structured_output_disabled_agents: ["pm"],
    };
    expect(await isStructuredOutputEnabled("pm")).toBe(false);
    expect(await isStructuredOutputEnabled("advisor")).toBe(true);
  });

  it("system_config read error → OFF (outage fails SAFE, never flips on)", async () => {
    state.error = { message: "pooler down" };
    state.blob = { structured_output_enabled: true };
    expect(await isStructuredOutputEnabled("pm")).toBe(false);
  });

  it("no row at all → OFF (absent blob == default off)", async () => {
    state.blob = null;
    expect(await isStructuredOutputEnabled("pm")).toBe(false);
  });

  it("unclassified agent (operator — no envelope) → OFF even when global ON", async () => {
    state.blob = { structured_output_enabled: true };
    expect(await isStructuredOutputEnabled("operator")).toBe(false);
  });

  it("truthy-but-not-true (string) → OFF (only boolean true enables)", async () => {
    state.blob = { structured_output_enabled: "true" };
    expect(await isStructuredOutputEnabled("pm")).toBe(false);
  });

  it("readStructuredOutputFlag returns the parsed state once", async () => {
    state.blob = {
      structured_output_enabled: true,
      structured_output_disabled_agents: ["qa", "research"],
    };
    const s = await readStructuredOutputFlag();
    expect(s.globalEnabled).toBe(true);
    expect(s.disabledAgents.has("qa")).toBe(true);
    expect(isStructuredOutputEnabledFor("pm", s)).toBe(true);
    expect(isStructuredOutputEnabledFor("qa", s)).toBe(false);
  });
});

describe("STRUCTURED_SIDE_CHANNEL_SLUGS — fail-closed guard", () => {
  it("no side-channel slug is in the generic dispatchers map", () => {
    for (const slug of STRUCTURED_SIDE_CHANNEL_SLUGS) {
      expect(
        Object.prototype.hasOwnProperty.call(dispatchers, slug),
        `${slug} must NOT be in the generic dispatchers map (it emits via its own post-run)`,
      ).toBe(false);
    }
  });
});

describe("toOutputFormatJsonSchema: no $schema key reaches the SDK", () => {
  it.each(Object.keys(AGENT_OUTPUT_CLASS))("%s schema carries no $schema anywhere", (slug) => {
    const { schema } = toOutputFormatJsonSchema(slug);
    expect(JSON.stringify(schema)).not.toContain('"$schema"');
    expect(schema.type).toBe("object");
  });

  it("stripSchemaKeys removes nested dialect tags but keeps a property named $schema", () => {
    const out = stripSchemaKeys({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        a: { $schema: "x", type: "string" },
        list: { type: "array", items: [{ $schema: "y", type: "number" }] },
        $schema: { type: "string" },
      },
    });
    expect(out).toEqual({
      type: "object",
      properties: {
        a: { type: "string" },
        list: { type: "array", items: [{ type: "number" }] },
        $schema: { type: "string" },
      },
    });
  });
});
