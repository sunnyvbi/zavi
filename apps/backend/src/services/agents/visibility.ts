
import { serviceClient } from "@/services/supabase";
import {
  getAgentDefaultState,
  getAgentShapeConstraints,
  isChannelOnlyAgent,
  listAgents,
  listAlwaysOnSlugs,
  listDefaultDisabledSlugs,
} from "./registry";
import {
  SHAPE_VISIBILITY_FLAG_KEY,
  coerceCompanyShape,
  shapeMismatchHidesAgent,
} from "./shape-visibility";
import type { CompanyShape } from "@/services/onboarding/enrichment/classify-shape-stage";

async function readGlobalDisabled(): Promise<Set<string>> {
  const { data, error } = await serviceClient()
    .from("system_config")
    .select("blob")
    .eq("id", 1)
    .maybeSingle<{ blob: Record<string, unknown> }>();
  if (error) throw new Error((error as { message: string }).message);
  const raw = (data?.blob?.disabled_agent_slugs ?? []) as unknown;
  return new Set(
    Array.isArray(raw)
      ? raw.filter((x): x is string => typeof x === "string")
      : [],
  );
}

type TenantOverrideRow = {
  agent_slug: string;
  override_state: "hidden" | "visible";
  source: "tenant" | "staff";
};

async function readTenantOverrides(
  tenantId: string,
): Promise<{
  hidden: Set<string>;
  visible: Set<string>;
  rows: TenantOverrideRow[];
}> {
  const { data, error } = await serviceClient()
    .from("tenant_agent_kill_switch")
    .select("agent_slug, override_state, source")
    .eq("tenant_id", tenantId)
    .eq("source", "staff");
  if (error) throw new Error((error as { message: string }).message);
  const rows = (data ?? []) as TenantOverrideRow[];
  const hidden = new Set<string>();
  const visible = new Set<string>();
  for (const r of rows) {
    if (r.override_state === "visible") visible.add(r.agent_slug);
    else hidden.add(r.agent_slug);
  }
  return { hidden, visible, rows };
}

export async function getGlobalDisabledSlugs(): Promise<ReadonlySet<string>> {
  try {
    return await readGlobalDisabled();
  } catch (e) {
    console.warn(
      `[visibility] global lookup failed: ${(e as Error).message}; fail-open (none disabled)`,
    );
    return new Set<string>();
  }
}

export async function getGlobalDisabledSlugsStrict(): Promise<ReadonlySet<string>> {
  return readGlobalDisabled();
}

export async function filterGlobalVisibleAgents<T extends { slug: string }>(
  agents: T[],
): Promise<T[]> {
  const disabled = await getGlobalDisabledSlugs();
  if (disabled.size === 0) return agents;
  return agents.filter((a) => !disabled.has(a.slug));
}

export async function getTenantDisabledSlugs(
  tenantId: string,
): Promise<ReadonlySet<string>> {
  if (!tenantId) {
    throw new Error("getTenantDisabledSlugs: tenantId required");
  }

  const alwaysOn = new Set(listAlwaysOnSlugs());

  const [globalHide, tenantOv] = await Promise.all([
    readGlobalDisabled().catch((e) => {
      console.warn(
        `[visibility] global read failed (tenant ${tenantId}): ${(e as Error).message}; tenant-only`,
      );
      return new Set<string>();
    }),
    readTenantOverrides(tenantId).catch((e) => {
      console.warn(
        `[visibility] tenant read failed (${tenantId}): ${(e as Error).message}; global-only`,
      );
      return {
        hidden: new Set<string>(),
        visible: new Set<string>(),
        rows: [] as TenantOverrideRow[],
      };
    }),
  ]);

  const hidden = new Set<string>([...globalHide, ...tenantOv.hidden]);
  for (const s of tenantOv.visible) hidden.delete(s);
  for (const s of alwaysOn) hidden.delete(s);
  return hidden;
}

export async function filterTenantVisibleAgents<T extends { slug: string }>(
  agents: T[],
  tenantId: string,
): Promise<T[]> {
  if (!tenantId) {
    throw new Error("filterTenantVisibleAgents: tenantId required");
  }
  const disabled = await getTenantDisabledSlugs(tenantId);
  return agents.filter((a) => !disabled.has(a.slug) && !isChannelOnlyAgent(a.slug));
}

export async function getVisibleAgentSlugs(
  tenantId: string,
): Promise<ReadonlySet<string>> {
  if (!tenantId) {
    throw new Error("getVisibleAgentSlugs: tenantId required");
  }
  const all = listAgents().map((a) => a.slug);
  const disabled = await getTenantDisabledSlugs(tenantId);
  return new Set(all.filter((s) => !disabled.has(s)));
}

export async function isAgentSchedulable(
  tenantId: string,
  slug: string,
): Promise<boolean> {
  if (!tenantId) throw new Error("isAgentSchedulable: tenantId required");
  if (!slug) throw new Error("isAgentSchedulable: slug required");

  const known = new Set(listAgents().map((a) => a.slug));
  if (!known.has(slug)) return false;

  const defaultState = getAgentDefaultState(slug);

  if (defaultState === "always_on") return true;

  const tenantOv = await readTenantOverrides(tenantId);
  if (tenantOv.visible.has(slug)) return true;
  if (tenantOv.hidden.has(slug)) return false;

  const globalHide = await readGlobalDisabled();
  if (globalHide.has(slug)) return false;

  return true;
}

export async function filterTenantVisibleTabs<
  T extends { payload?: { kind?: string; slug?: string } },
>(tabs: T[], tenantId: string): Promise<T[]> {
  if (!tenantId) {
    throw new Error("filterTenantVisibleTabs: tenantId required");
  }
  const disabled = await getTenantDisabledSlugs(tenantId);
  return tabs.filter((t) => {
    const p = t.payload;
    if (!p || p.kind !== "agent" || !p.slug) return true;
    return !disabled.has(p.slug) && !isChannelOnlyAgent(p.slug);
  });
}

export type EffectiveVisibility =
  | {
      visible: true;
      reason: "default_enabled" | "tenant_visible_override" | "always_on";
    }
  | {
      visible: false;
      reason:
        | "default_disabled"
        | "global_override_hide"
        | "tenant_hidden_override"
        | "staff_locked_hide"
        | "channel_only_hide"
        | "shape_mismatch_hide";
    };

export async function isShapeBasedVisibilityEnabled(): Promise<boolean> {
  try {
    const { data, error } = await serviceClient()
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle<{ blob: Record<string, unknown> }>();
    if (error) return false;
    const blob = (data?.blob ?? {}) as Record<string, unknown>;
    return blob[SHAPE_VISIBILITY_FLAG_KEY] === true;
  } catch {
    return false;
  }
}

export async function getTenantCompanyShape(
  tenantId: string,
): Promise<CompanyShape | null> {
  if (!tenantId) return null;
  try {
    const { data, error } = await serviceClient()
      .from("tenants")
      .select("company_shape")
      .eq("id", tenantId)
      .maybeSingle<{ company_shape: string | null }>();
    if (error) return null;
    return coerceCompanyShape(data?.company_shape);
  } catch {
    return null;
  }
}

export async function getEffectiveVisibility(
  tenantId: string,
  slug: string,
): Promise<EffectiveVisibility> {
  if (!tenantId) throw new Error("getEffectiveVisibility: tenantId required");
  if (!slug) throw new Error("getEffectiveVisibility: slug required");

  const defaultState = getAgentDefaultState(slug);

  if (defaultState === "always_on") {
    return { visible: true, reason: "always_on" };
  }

  let ov: TenantOverrideRow | null = null;
  try {
    const { data, error } = await serviceClient()
      .from("tenant_agent_kill_switch")
      .select("agent_slug, override_state, source")
      .eq("tenant_id", tenantId)
      .eq("agent_slug", slug)
      .eq("source", "staff")
      .maybeSingle();
    if (error) throw new Error(error.message);
    ov = (data as TenantOverrideRow | null) ?? null;
  } catch (e) {
    console.warn(
      `[visibility] tenant override lookup failed (${tenantId}, ${slug}): ${(e as Error).message}; falling through to global+default`,
    );
  }
  if (ov) {
    if (ov.override_state === "visible") {
      return { visible: true, reason: "tenant_visible_override" };
    }
    return { visible: false, reason: "staff_locked_hide" };
  }

  const globalHide = await getGlobalDisabledSlugs();
  if (globalHide.has(slug)) {
    return { visible: false, reason: "global_override_hide" };
  }

  if (isChannelOnlyAgent(slug)) {
    return { visible: false, reason: "channel_only_hide" };
  }

  if (await isShapeBasedVisibilityEnabled()) {
    const constraints = getAgentShapeConstraints(slug);
    if (constraints) {
      const shape = await getTenantCompanyShape(tenantId);
      if (shapeMismatchHidesAgent(shape, constraints)) {
        return { visible: false, reason: "shape_mismatch_hide" };
      }
    }
  }

  return { visible: true, reason: "default_enabled" };
}

export type AgentEffectiveState = {
  slug: string;
  default_state: "enabled" | "disabled" | "always_on";
  effective_state: "visible" | "hidden";
  effective_reason: EffectiveVisibility["reason"];
  override_state: "hidden" | "visible" | null;
  override_source: "tenant" | "staff" | null;
  is_locked: boolean;
};

export async function getAgentEffectiveStates(
  tenantId: string,
): Promise<AgentEffectiveState[]> {
  if (!tenantId) throw new Error("getAgentEffectiveStates: tenantId required");

  const agents = listAgents();
  const alwaysOn = new Set(listAlwaysOnSlugs());

  const [globalHide, tenantOv] = await Promise.all([
    readGlobalDisabled().catch(() => new Set<string>()),
    readTenantOverrides(tenantId).catch(() => ({
      hidden: new Set<string>(),
      visible: new Set<string>(),
      rows: [] as TenantOverrideRow[],
    })),
  ]);
  const overrideBySlug = new Map(tenantOv.rows.map((r) => [r.agent_slug, r]));

  const shapeFlagOn = await isShapeBasedVisibilityEnabled();
  const tenantShape = shapeFlagOn ? await getTenantCompanyShape(tenantId) : null;

  return agents.map((a) => {
    const default_state =
      a.metadata_praxis.visibility?.default_state ?? "enabled";
    const ov = overrideBySlug.get(a.slug) ?? null;

    let visible: boolean;
    let reason: EffectiveVisibility["reason"];
    if (default_state === "always_on") {
      visible = true;
      reason = "always_on";
    } else if (ov) {
      if (ov.override_state === "visible") {
        visible = true;
        reason = "tenant_visible_override";
      } else {
        visible = false;
        reason = "staff_locked_hide";
      }
    } else if (globalHide.has(a.slug)) {
      visible = false;
      reason = "global_override_hide";
    } else if (
      shapeFlagOn &&
      shapeMismatchHidesAgent(tenantShape, {
        recommended_for_shapes: a.metadata_praxis.visibility?.recommended_for_shapes,
        hidden_for_shapes: a.metadata_praxis.visibility?.hidden_for_shapes,
      })
    ) {
      visible = false;
      reason = "shape_mismatch_hide";
    } else {
      visible = true;
      reason = "default_enabled";
    }

    return {
      slug: a.slug,
      default_state,
      effective_state: visible ? "visible" : "hidden",
      effective_reason: reason,
      override_state: ov?.override_state ?? null,
      override_source: ov?.source ?? null,
      is_locked: alwaysOn.has(a.slug),
    };
  });
}
