
import { z } from "zod";
import { isAnthropicModel } from "@/services/llm/models";
import { BEHAVIORS, type BehaviorRegistry } from "./behaviors";

export const DROPPABLE_CORE = [
  "tone-and-voice",
  "agent-chat-voice",
  "output-shaping",
  "economic-judgment",
  "audience-technical-level",
  "clarifying-questions",
  "cross-agent-routing",
] as const;

export function makeVariantConfigSchema(registry: BehaviorRegistry = BEHAVIORS) {
  return z
    .object({
      model: z.string().refine(isAnthropicModel, "must be a Claude model id").optional(),
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
      thinking: z
        .discriminatedUnion("type", [
          z.object({ type: z.literal("disabled") }).strict(),
          z.object({ type: z.literal("adaptive") }).strict(),
          z
            .object({
              type: z.literal("enabled"),
              budget_tokens: z.number().int().min(1024).max(32000),
            })
            .strict(),
        ])
        .optional(),
      max_turns: z.number().int().min(10).max(120).optional(),
      isolate_settings: z.boolean().optional(),
      fallback_model: z.string().refine(isAnthropicModel, "must be a Claude model id").optional(),
      max_budget_usd: z.number().positive().max(50).optional(),
      tools: z
        .object({
          always_load: z.array(z.string().regex(/^[a-z0-9_]+$/i)).max(12).optional(),
          disable: z.array(z.string().regex(/^[a-z0-9_]+$/i)).max(60).optional(),
        })
        .strict()
        .optional(),
      memory: z.enum(["off"]).optional(),
      behaviors: z
        .array(z.string().refine((b) => Object.prototype.hasOwnProperty.call(registry, b), "unknown behaviour"))
        .max(10)
        .optional(),
      prompt: z
        .object({
          agent_file: z.string().regex(/^[a-z0-9_-]{1,24}$/).optional(),
          recipe_file: z.string().regex(/^[a-z0-9_-]{1,24}$/).optional(),
          drop_core: z.array(z.enum(DROPPABLE_CORE)).max(DROPPABLE_CORE.length).optional(),
          skills: z.array(z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)).max(8).optional(),
        })
        .strict()
        .optional(),
    })
    .strict();
}

export const VariantConfigSchema = makeVariantConfigSchema();

export type VariantConfig = z.infer<typeof VariantConfigSchema>;

export type ResolvedVariant = { slug: string | null; config: VariantConfig };

export const DEFAULT_VARIANT: ResolvedVariant = { slug: null, config: {} };

export function variantSdkOptions(config: VariantConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (config.effort) out.effort = config.effort;
  if (config.thinking) {
    out.thinking =
      config.thinking.type === "enabled"
        ? { type: "enabled", budgetTokens: config.thinking.budget_tokens }
        : { type: config.thinking.type };
  }
  if (config.isolate_settings) out.settingSources = [];
  if (config.fallback_model) out.fallbackModel = config.fallback_model;
  if (config.max_budget_usd) out.maxBudgetUsd = config.max_budget_usd;
  return out;
}

export function isVariantDisabledTool(name: string, disable: readonly string[] | undefined): boolean {
  if (!disable || disable.length === 0) return false;
  const off = disable.map((n) => n.toLowerCase());
  const lower = name.toLowerCase();
  const i = lower.indexOf("__");
  return off.includes(lower) || (i > 0 && off.includes(lower.slice(i + 2)));
}

export function stripVariantDisabledTools<T extends { name: string }>(
  tools: T[],
  disable: readonly string[] | undefined,
): T[] {
  if (!disable || disable.length === 0) return tools;
  return tools.filter((t) => !isVariantDisabledTool(t.name, disable));
}
