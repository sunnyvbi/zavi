
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_VARIANT,
  VariantConfigSchema,
  type ResolvedVariant,
} from "./variant-config";

export function globalVariantSlug(
  blob: Record<string, unknown>,
  agentSlug: string,
): string | null {
  const raw = blob.engine_variant_defaults;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const map = raw as Record<string, unknown>;
  for (const key of [agentSlug, "*"]) {
    const v = map[key];
    if (typeof v === "string" && v.trim() && v.trim() !== "default") return v.trim();
  }
  return null;
}

export async function resolveRunVariant(
  sb: SupabaseClient,
  tenantId: string,
  agentSlug: string,
): Promise<ResolvedVariant> {
  try {
    const [flag, row] = await Promise.all([
      sb.from("system_config").select("blob").eq("id", 1).maybeSingle(),
      sb
        .from("tenant_agent_variant_assignments")
        .select("variant_slug, agent_engine_variants(config)")
        .eq("tenant_id", tenantId)
        .eq("agent_slug", agentSlug)
        .maybeSingle(),
    ]);
    if (flag.error) return DEFAULT_VARIANT;
    const blob = (flag.data?.blob ?? {}) as Record<string, unknown>;
    if (blob.engine_variants_disabled === true) return DEFAULT_VARIANT;

    if (row.error) return DEFAULT_VARIANT;

    if (!row.data) {
      const slug = globalVariantSlug(blob, agentSlug);
      if (!slug) return DEFAULT_VARIANT;
      const { data: v, error } = await sb
        .from("agent_engine_variants")
        .select("config")
        .eq("slug", slug)
        .maybeSingle();
      if (error || !v) {
        console.warn(
          `[resolve-run-variant] global default "${slug}" for ${agentSlug} is not a known variant — using default`,
        );
        return DEFAULT_VARIANT;
      }
      const parsed = VariantConfigSchema.safeParse((v as { config: unknown }).config);
      if (!parsed.success) {
        console.warn(
          `[resolve-run-variant] global default "${slug}" fails the config schema — using default`,
        );
        return DEFAULT_VARIANT;
      }
      return { slug, config: parsed.data };
    }

    const data = row.data as {
      variant_slug: string;
      agent_engine_variants: { config: unknown } | { config: unknown }[] | null;
    };
    const embedded = Array.isArray(data.agent_engine_variants)
      ? data.agent_engine_variants[0]
      : data.agent_engine_variants;
    const parsed = VariantConfigSchema.safeParse(embedded?.config);
    if (!parsed.success) {
      console.warn(
        `[resolve-run-variant] variant "${data.variant_slug}" for ${tenantId}/${agentSlug} ` +
          `fails the config schema — ignoring, using default`,
      );
      return DEFAULT_VARIANT;
    }
    return { slug: data.variant_slug, config: parsed.data };
  } catch {
    return DEFAULT_VARIANT;
  }
}
