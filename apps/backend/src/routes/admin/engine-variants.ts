
import { existsSync } from "node:fs";
import path from "node:path";
import type { Request, Response } from "express";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";
import { writeStaffAudit } from "@/services/staff/audit";
import { listAgents } from "@/services/agents/registry";
import {
  DROPPABLE_CORE,
  VariantConfigSchema,
} from "@/services/agents/engine/variant-config";

const SLUG = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/)
  .refine((s) => s !== "default", "'default' is reserved: it means no overrides");

export const UpsertBody = z
  .object({
    slug: SLUG,
    label: z.string().trim().min(1).max(80),
    config: VariantConfigSchema,
    note: z.string().max(500).optional(),
  })
  .strict();

export const AssignBody = z
  .object({
    tenant_id: z.string().uuid(),
    agent_slug: z.string().min(1),
    variant_slug: SLUG.nullable(),
  })
  .strict();

export const GlobalBody = z
  .object({
    agent_slug: z.union([z.literal("*"), z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/)]),
    variant_slug: SLUG.nullable(),
  })
  .strict();

export async function staffEngineVariantsGlobal(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const parsed = GlobalBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
    return;
  }
  const { agent_slug, variant_slug } = parsed.data;

  const sb = staffCrossTenantClient(
    "staff console sets a fleet-wide engine-variant default in system_config",
  );
  if (variant_slug !== null) {
    const { data: v } = await sb
      .from("agent_engine_variants")
      .select("slug, config")
      .eq("slug", variant_slug)
      .maybeSingle();
    if (!v) {
      res.status(404).json({ error: "variant_not_found" });
      return;
    }
    const file = VariantConfigSchema.safeParse((v as { config: unknown }).config).data?.prompt
      ?.agent_file;
    if (file) {
      if (agent_slug === "*") {
        res.status(400).json({ error: "prompt_file_variant_not_fleet_wide", expected: `assign ${variant_slug} per agent` });
        return;
      }
      const agent = listAgents().find((a) => a.slug === agent_slug);
      if (!agent) {
        res.status(400).json({ error: "unknown_agent" });
        return;
      }
      if (!existsSync(path.join(path.dirname(agent.body_path), `agent.${file}.md`))) {
        res.status(400).json({ error: "prompt_file_missing", expected: `agents/${agent_slug}/agent.${file}.md` });
        return;
      }
    }
  }
  const { data: cfg, error: readErr } = await sb
    .from("system_config")
    .select("blob")
    .eq("id", 1)
    .maybeSingle<{ blob: Record<string, unknown> }>();
  if (readErr) {
    res.status(500).json({ error: "read_failed" });
    return;
  }
  const blob = (cfg?.blob ?? {}) as Record<string, unknown>;
  const raw = blob.engine_variant_defaults;
  const defaults: Record<string, unknown> =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : {};
  if (variant_slug === null) delete defaults[agent_slug];
  else defaults[agent_slug] = variant_slug;

  const { error } = await sb
    .from("system_config")
    .update({ blob: { ...blob, engine_variant_defaults: defaults }, updated_at: new Date().toISOString() })
    .eq("id", 1);
  if (error) {
    res.status(500).json({ error: "write_failed" });
    return;
  }
  await writeStaffAudit({
    actor_user_id: staff.user_id,
    actor_email: staff.email,
    action: variant_slug === null ? "engine_variant.global_clear" : "engine_variant.global_set",
    target_table: "system_config",
    target_id: "1",
    meta: { agent_slug, variant_slug, engine_variant_defaults: defaults },
  });
  res.json({ ok: true, engine_variant_defaults: defaults });
}

export async function staffEngineVariantsList(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const sb = staffCrossTenantClient(
    "staff console lists engine variants and every tenant's assignment",
  );
  const [variants, assignments, cfg] = await Promise.all([
    sb.from("agent_engine_variants").select("slug, label, config, note, updated_at").order("slug"),
    sb
      .from("tenant_agent_variant_assignments")
      .select("tenant_id, agent_slug, variant_slug, updated_at, tenants(name, slug)")
      .order("updated_at", { ascending: false }),
    sb.from("system_config").select("blob").eq("id", 1).maybeSingle<{ blob: Record<string, unknown> }>(),
  ]);
  if (variants.error || assignments.error) {
    res.status(500).json({ error: "read_failed" });
    return;
  }
  const blob = (cfg.data?.blob ?? {}) as Record<string, unknown>;
  const rawGlobals = blob.engine_variant_defaults;
  res.json({
    variants: variants.data,
    assignments: assignments.data,
    agents: listAgents().map((a) => a.slug).sort(),
    droppable_core: DROPPABLE_CORE,
    globals:
      rawGlobals && typeof rawGlobals === "object" && !Array.isArray(rawGlobals) ? rawGlobals : {},
    kill_switch: blob.engine_variants_disabled === true,
  });
}

export async function staffEngineVariantsUpsert(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const parsed = UpsertBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
    return;
  }
  const { slug, label, config, note } = parsed.data;
  const { error } = await staffCrossTenantClient(
    "staff console upserts an engine variant, a fleet-wide row",
  )
    .from("agent_engine_variants")
    .upsert({
      slug,
      label,
      config,
      note: note ?? null,
      updated_at: new Date().toISOString(),
      updated_by: staff.user_id,
    });
  if (error) {
    res.status(500).json({ error: "write_failed" });
    return;
  }
  await writeStaffAudit({
    actor_user_id: staff.user_id,
    actor_email: staff.email,
    action: "engine_variant.upsert",
    target_table: "agent_engine_variants",
    target_id: slug,
    meta: { slug, config },
  });
  res.json({ ok: true });
}

export async function staffEngineVariantsDelete(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const slug = SLUG.safeParse(req.query.slug);
  if (!slug.success) {
    res.status(400).json({ error: "invalid_slug" });
    return;
  }
  const sb = staffCrossTenantClient("staff console deletes an engine variant, a fleet-wide row");
  const { error } = await sb.from("agent_engine_variants").delete().eq("slug", slug.data);
  if (error) {
    res.status(500).json({ error: "write_failed" });
    return;
  }
  const { data: cfg, error: cfgErr } = await sb
    .from("system_config")
    .select("blob")
    .eq("id", 1)
    .maybeSingle<{ blob: Record<string, unknown> }>();
  const blob = (cfg?.blob ?? {}) as Record<string, unknown>;
  const rawDefaults = blob.engine_variant_defaults;
  let pruneErr: string | null = cfgErr ? "read_failed" : null;
  let pruned: string[] = [];
  if (!cfgErr && rawDefaults && typeof rawDefaults === "object" && !Array.isArray(rawDefaults)) {
    const defaults = { ...(rawDefaults as Record<string, unknown>) };
    pruned = Object.keys(defaults).filter((k) => defaults[k] === slug.data);
    if (pruned.length) {
      for (const k of pruned) delete defaults[k];
      const { error: upErr } = await sb
        .from("system_config")
        .update({ blob: { ...blob, engine_variant_defaults: defaults }, updated_at: new Date().toISOString() })
        .eq("id", 1);
      if (upErr) pruneErr = "write_failed";
    }
  }
  await writeStaffAudit({
    actor_user_id: staff.user_id,
    actor_email: staff.email,
    action: "engine_variant.delete",
    target_table: "agent_engine_variants",
    target_id: slug.data,
    meta: { slug: slug.data, globals_pruned: pruned, globals_prune_error: pruneErr },
  });
  if (pruneErr) {
    res.status(500).json({ error: "global_prune_failed", detail: pruneErr, deleted: slug.data });
    return;
  }
  res.json({ ok: true, globals_pruned: pruned });
}

export async function staffEngineVariantsAssign(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const parsed = AssignBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
    return;
  }
  const { tenant_id, agent_slug, variant_slug } = parsed.data;

  const agent = listAgents().find((a) => a.slug === agent_slug);
  if (!agent) {
    res.status(400).json({ error: "unknown_agent" });
    return;
  }
  const sb = staffCrossTenantClient(
    "staff console assigns an engine variant to one chosen tenant",
  );
  const { data: tenant } = await sb.from("tenants").select("id").eq("id", tenant_id).maybeSingle();
  if (!tenant) {
    res.status(404).json({ error: "tenant_not_found" });
    return;
  }

  if (variant_slug === null) {
    const { error } = await sb
      .from("tenant_agent_variant_assignments")
      .delete()
      .eq("tenant_id", tenant_id)
      .eq("agent_slug", agent_slug);
    if (error) {
      res.status(500).json({ error: "write_failed" });
      return;
    }
  } else {
    const { data: variant } = await sb
      .from("agent_engine_variants")
      .select("config")
      .eq("slug", variant_slug)
      .maybeSingle();
    if (!variant) {
      res.status(404).json({ error: "variant_not_found" });
      return;
    }
    const file = VariantConfigSchema.safeParse(variant.config).data?.prompt?.agent_file;
    if (file && !existsSync(path.join(path.dirname(agent.body_path), `agent.${file}.md`))) {
      res.status(400).json({ error: "prompt_file_missing", expected: `agents/${agent_slug}/agent.${file}.md` });
      return;
    }
    const { error } = await sb.from("tenant_agent_variant_assignments").upsert({
      tenant_id,
      agent_slug,
      variant_slug,
      updated_at: new Date().toISOString(),
      updated_by: staff.user_id,
    });
    if (error) {
      res.status(500).json({ error: "write_failed" });
      return;
    }
  }

  await writeStaffAudit({
    actor_user_id: staff.user_id,
    actor_email: staff.email,
    action: variant_slug === null ? "engine_variant.unassign" : "engine_variant.assign",
    target_table: "tenant_agent_variant_assignments",
    target_id: tenant_id,
    tenant_id,
    meta: { tenant_id, agent_slug, variant_slug },
  });
  res.json({ ok: true });
}
