
import { z, type ZodTypeAny } from "zod";
import { serviceClient } from "@/services/supabase";
import { outputSchemas } from "@/agents/index";
import { coerceEnvelope } from "./envelope-coerce";
import { normalizeNoChangeDecision } from "./model-refusal-envelope";

export type AgentOutputClass =
  | "top_level_decision"
  | "markdown_derived_decision"
  | "digest_only";

export const AGENT_OUTPUT_CLASS: Record<string, AgentOutputClass> = {
  engineer: "top_level_decision",
  pm: "top_level_decision",
  advisor: "top_level_decision",
  "chief-of-staff": "top_level_decision",

  "content-design": "markdown_derived_decision",
  "growth-lead": "markdown_derived_decision",

  "performance-marketer": "digest_only",
  qa: "digest_only",
  research: "digest_only",
  "support-lead": "digest_only",
  "dispute-response": "top_level_decision",
  "browser-operator": "digest_only",
};

const RENDERED_MARKDOWN_FIELD = z.string();

export const STRUCTURED_SIDE_CHANNEL_SLUGS = new Set<string>([
  "content-design",
  "growth-lead",
]);

export type DecisionKind = AgentOutputClass;

export function getAgentOutputClass(slug: string): AgentOutputClass {
  const cls = AGENT_OUTPUT_CLASS[slug];
  if (!cls) {
    throw new Error(
      `structured-output: agent '${slug}' has an output_envelope but no entry ` +
        `in AGENT_OUTPUT_CLASS. Classify it (top_level_decision / ` +
        `markdown_derived_decision / digest_only) by reading its code before flipping.`,
    );
  }
  return cls;
}

export function getServerSchema(slug: string): ZodTypeAny | undefined {
  return outputSchemas[slug];
}

export function buildTwoChannelSchema(slug: string): ZodTypeAny {
  const cls = getAgentOutputClass(slug);
  const server = getServerSchema(slug);

  if (cls === "top_level_decision") {
    const obj = resolveZodObject(server);
    if (!obj) {
      throw new Error(
        `structured-output: '${slug}' is top_level_decision but its server ` +
          `schema is not a ZodObject (cannot split rendered_markdown from the ` +
          `decision). Reclassify or special-case it.`,
      );
    }
    const decisionShape = omitRenderedMarkdown(obj).partial();
    return z.object({
      rendered_markdown: RENDERED_MARKDOWN_FIELD,
      decision: decisionShape.nullable().optional(),
    });
  }

  if (slug === "growth-lead") {
    return z.object({
      rendered_markdown: RENDERED_MARKDOWN_FIELD,
      machine_digest: z.string().optional(),
    });
  }
  if (slug === "content-design") {
    return z.object({
      rendered_markdown: RENDERED_MARKDOWN_FIELD,
      recommendations: z.array(z.unknown()).optional(),
    });
  }
  return z.object({ rendered_markdown: RENDERED_MARKDOWN_FIELD });
}

function omitRenderedMarkdown(
  obj: z.ZodObject<z.ZodRawShape>,
): z.ZodObject<z.ZodRawShape> {
  if (Object.prototype.hasOwnProperty.call(obj.shape, "rendered_markdown")) {
    return obj.omit({ rendered_markdown: true }) as z.ZodObject<z.ZodRawShape>;
  }
  return obj;
}

function resolveZodObject(
  schema: ZodTypeAny | undefined,
): z.ZodObject<z.ZodRawShape> | null {
  if (schema instanceof z.ZodObject) {
    return z.object(
      (schema as z.ZodObject<z.ZodRawShape>).shape,
    ) as z.ZodObject<z.ZodRawShape>;
  }
  return null;
}

export function canUseNativeStructuredOutput(slug: string): boolean {
  if (STRUCTURED_SIDE_CHANNEL_SLUGS.has(slug)) return true;
  try {
    return getAgentOutputClass(slug) === "top_level_decision";
  } catch {
    return false;
  }
}

export function toOutputFormatJsonSchema(slug: string): {
  type: "json_schema";
  schema: Record<string, unknown>;
} {
  const wrapper = buildTwoChannelSchema(slug);
  const schema = stripSchemaKeys(
    z.toJSONSchema(wrapper, {
      unrepresentable: "any",
    }),
  ) as Record<string, unknown>;
  return { type: "json_schema", schema };
}

export function stripSchemaKeys(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripSchemaKeys);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === "$schema" && typeof v === "string") continue;
    out[k] = stripSchemaKeys(v);
  }
  return out;
}

export function unwrapDecisionForEmit(
  slug: string,
  parsedWrapper: unknown,
): { decision: unknown; hadDecisionChannel: boolean } {
  const cls = getAgentOutputClass(slug);
  if (cls !== "top_level_decision") {
    return { decision: parsedWrapper, hadDecisionChannel: false };
  }
  const w = parsedWrapper as { decision?: unknown } | null | undefined;
  const decision = w && typeof w === "object" ? w.decision : undefined;
  if (decision == null) return { decision: null, hadDecisionChannel: true };
  if (
    typeof decision === "object" &&
    !Array.isArray(decision) &&
    Object.keys(decision as Record<string, unknown>).length === 0
  ) {
    return { decision: null, hadDecisionChannel: true };
  }
  const rm =
    w && typeof w === "object"
      ? (w as { rendered_markdown?: unknown }).rendered_markdown
      : undefined;
  const reconstructed =
    typeof rm === "string"
      ? { ...(decision as Record<string, unknown>), rendered_markdown: rm }
      : decision;
  return { decision: reconstructed, hadDecisionChannel: true };
}

export type StructuredReduceResult = {
  parsed: unknown;
  parseOk: boolean;
  outputText: string;
  schemaSoftFailed: boolean;
  actionMissing?: boolean;
  noActionReason?: string;
  parseError?: string;
  telemetryCode: string;
  telemetryStage: "parsed" | "parse_failed";
};

export function reduceStructuredOutput(args: {
  slug: string;
  structuredOutput: unknown;
  serverSchema: ZodTypeAny | undefined;
  rawTextFallback: string;
}): StructuredReduceResult {
  const { slug, structuredOutput, serverSchema, rawTextFallback } = args;
  const cls = getAgentOutputClass(slug);
  const wrapper = (structuredOutput ?? {}) as Record<string, unknown>;
  const renderedMarkdown =
    typeof wrapper.rendered_markdown === "string" &&
    wrapper.rendered_markdown.length > 0
      ? wrapper.rendered_markdown
      : rawTextFallback;

  if (cls !== "top_level_decision") {
    const hasRm =
      typeof wrapper.rendered_markdown === "string" &&
      wrapper.rendered_markdown.length > 0;
    if (hasRm && STRUCTURED_SIDE_CHANNEL_SLUGS.has(slug)) {
      const parsedEnvelope: Record<string, unknown> = {
        rendered_markdown: renderedMarkdown,
      };
      if (slug === "content-design") {
        parsedEnvelope.recommendations = wrapper.recommendations;
      } else if (slug === "growth-lead") {
        parsedEnvelope.machine_digest = wrapper.machine_digest;
      }
      return {
        parsed: parsedEnvelope,
        parseOk: true,
        outputText: renderedMarkdown,
        schemaSoftFailed: false,
        telemetryCode: "structured_digest",
        telemetryStage: "parsed",
      };
    }
    return {
      parsed: null,
      parseOk: hasRm,
      outputText: renderedMarkdown,
      schemaSoftFailed: false,
      parseError: hasRm ? undefined : "structured_missing_rendered_markdown",
      telemetryCode: hasRm ? "structured_digest" : "structured_no_rendered_markdown",
      telemetryStage: hasRm ? "parsed" : "parse_failed",
    };
  }

  const { decision: emitBody } = unwrapDecisionForEmit(slug, wrapper);

  if (emitBody == null) {
    return {
      parsed: null,
      parseOk: true,
      outputText: renderedMarkdown,
      schemaSoftFailed: false,
      actionMissing: true,
      noActionReason: "no_decision_emitted",
      parseError: "action_missing:no_decision_emitted",
      telemetryCode: "structured_action_missing",
      telemetryStage: "parsed",
    };
  }

  if (!serverSchema) {
    return {
      parsed: null,
      parseOk: true,
      outputText: renderedMarkdown,
      schemaSoftFailed: false,
      actionMissing: true,
      noActionReason: "no_server_schema",
      parseError: "action_missing:no_server_schema",
      telemetryCode: "structured_no_server_schema",
      telemetryStage: "parsed",
    };
  }

  const coerced = coerceEnvelope(slug, emitBody).value;
  const sv = serverSchema.safeParse(coerced);
  if (sv.success) {
    return {
      parsed: normalizeNoChangeDecision(sv.data),
      parseOk: true,
      outputText: renderedMarkdown,
      schemaSoftFailed: false,
      telemetryCode: "structured_output",
      telemetryStage: "parsed",
    };
  }
  return {
    parsed: coerced,
    parseOk: false,
    outputText: renderedMarkdown,
    schemaSoftFailed: true,
    parseError:
      "schema_soft_fail(structured): " +
      sv.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; "),
    telemetryCode: "structured_schema_soft_fail",
    telemetryStage: "parse_failed",
  };
}

export type StructuredOutputFlagState = {
  globalEnabled: boolean;
  disabledAgents: Set<string>;
};

export async function readStructuredOutputFlag(): Promise<StructuredOutputFlagState> {
  try {
    const sb = serviceClient();
    const { data, error } = await sb
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle();
    if (error) return { globalEnabled: false, disabledAgents: new Set() };
    const blob = (data?.blob ?? {}) as Record<string, unknown>;
    const globalEnabled = blob.structured_output_enabled === true;
    const raw = blob.structured_output_disabled_agents;
    const disabledAgents = new Set<string>(
      Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string") : [],
    );
    return { globalEnabled, disabledAgents };
  } catch {
    return { globalEnabled: false, disabledAgents: new Set() };
  }
}

export async function isStructuredOutputEnabled(slug: string): Promise<boolean> {
  if (!AGENT_OUTPUT_CLASS[slug]) return false;
  const state = await readStructuredOutputFlag();
  return state.globalEnabled && !state.disabledAgents.has(slug);
}

export function isStructuredOutputEnabledFor(
  slug: string,
  state: StructuredOutputFlagState,
): boolean {
  if (!AGENT_OUTPUT_CLASS[slug]) return false;
  return state.globalEnabled && !state.disabledAgents.has(slug);
}
