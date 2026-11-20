
import type { Request, Response } from "express";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";
import { writeStaffAudit } from "@/services/staff/audit";
import { listAgents, listAlwaysOnSlugs } from "@/services/agents/registry";
import {
  getAgentEffectiveStates,
  getGlobalDisabledSlugsStrict,
} from "@/services/agents/visibility";

async function tenantExists(id: string): Promise<boolean> {
  const { data } = await serviceClient()
    .from("tenants")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  return !!data;
}

export async function staffTenantVisibilityGet(
  req: Request,
  res: Response,
): Promise<void> {
  assertStaff(req);
  const tenantId = String(req.query.tenant_id ?? "");
  if (!tenantId || !(await tenantExists(tenantId))) {
    res
      .status(404)
      .json({ error: { code: "tenant_not_found", message: tenantId } });
    return;
  }

  let g: ReadonlySet<string>;
  try {
    g = await getGlobalDisabledSlugsStrict();
  } catch (e) {
    res.status(500).json({
      error: { code: "config_read_failed", message: (e as Error).message },
    });
    return;
  }

  const { data: rows, error } = await serviceClient()
    .from("tenant_agent_kill_switch")
    .select("agent_slug, source")
    .eq("tenant_id", tenantId);
  if (error) {
    res
      .status(500)
      .json({ error: { code: "read_failed", message: error.message } });
    return;
  }

  const bySlug = new Map(
    ((rows ?? []) as { agent_slug: string; source: string }[]).map((r) => [
      r.agent_slug,
      r.source,
    ]),
  );

  const effective = await getAgentEffectiveStates(tenantId).catch(() => []);
  const effBySlug = new Map(effective.map((e) => [e.slug, e]));

  const slugs = listAgents()
    .map((a) => {
      const eff = effBySlug.get(a.slug);
      const default_state =
        a.metadata_praxis.visibility?.default_state ?? "enabled";
      return {
        slug: a.slug,
        name: a.name,
        hidden_global: g.has(a.slug),
        hidden_tenant: bySlug.has(a.slug),
        source: bySlug.get(a.slug) ?? null,
        default_state,
        effective_state: eff?.effective_state ?? "visible",
        effective_reason: eff?.effective_reason ?? "default_enabled",
        override_state: eff?.override_state ?? null,
        is_locked: default_state === "always_on",
      };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));

  res.json({ tenant_id: tenantId, slugs });
}

const PostBody = z.object({
  tenant_id: z.string().uuid(),
  hidden_slugs: z.array(z.string()),
  visible_slugs: z.array(z.string()).default([]),
});

export async function staffTenantVisibilityPost(
  req: Request,
  res: Response,
): Promise<void> {
  const staff = assertStaff(req);

  const parsed = PostBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: { code: "invalid_body", message: parsed.error.message } });
    return;
  }
  const { tenant_id, hidden_slugs, visible_slugs } = parsed.data;

  if (!(await tenantExists(tenant_id))) {
    res
      .status(404)
      .json({ error: { code: "tenant_not_found", message: tenant_id } });
    return;
  }

  const dedupHidden = [...new Set(hidden_slugs)];
  const dedupVisible = [...new Set(visible_slugs)];
  const known = new Set(listAgents().map((a) => a.slug));
  const allSubmitted = [...dedupHidden, ...dedupVisible];
  const unknown = allSubmitted.filter((s) => !known.has(s));
  if (unknown.length > 0) {
    res
      .status(400)
      .json({ error: { code: "unknown_agent_slug", slugs: unknown } });
    return;
  }

  const overlap = dedupHidden.filter((s) => dedupVisible.includes(s));
  if (overlap.length > 0) {
    res.status(400).json({
      error: {
        code: "conflicting_direction",
        message: `slug(s) in both hidden_slugs AND visible_slugs: ${overlap.join(", ")}`,
      },
    });
    return;
  }

  const alwaysOn = new Set(listAlwaysOnSlugs());
  const ignored_locked_from_hidden = dedupHidden.filter((s) => alwaysOn.has(s));
  const ignored_locked_from_visible = dedupVisible.filter((s) => alwaysOn.has(s));
  const cleanHidden = dedupHidden.filter((s) => !alwaysOn.has(s));
  const cleanVisible = dedupVisible.filter((s) => !alwaysOn.has(s));

  let g: ReadonlySet<string>;
  try {
    g = await getGlobalDisabledSlugsStrict();
  } catch (e) {
    res.status(500).json({
      error: { code: "config_read_failed", message: (e as Error).message },
    });
    return;
  }
  const wantHidden = new Set(cleanHidden.filter((s) => !g.has(s)));
  const wantVisible = new Set(cleanVisible);
  const ignored_global = cleanHidden.filter((s) => g.has(s));

  const sb = serviceClient();
  const { data: cur, error: rErr } = await sb
    .from("tenant_agent_kill_switch")
    .select("agent_slug, source, override_state")
    .eq("tenant_id", tenant_id);
  if (rErr) {
    res
      .status(500)
      .json({ error: { code: "read_failed", message: rErr.message } });
    return;
  }
  type CurRow = { agent_slug: string; source: string; override_state: string };
  const staffNow = ((cur ?? []) as CurRow[]).filter((r) => r.source === "staff");
  const staffHiddenSet = new Set(
    staffNow.filter((r) => r.override_state === "hidden").map((r) => r.agent_slug),
  );
  const staffVisibleSet = new Set(
    staffNow.filter((r) => r.override_state === "visible").map((r) => r.agent_slug),
  );

  const toHide = [...wantHidden].filter((s) => !staffHiddenSet.has(s));
  const toShow = [...wantVisible].filter((s) => !staffVisibleSet.has(s));
  const toRemove = staffNow
    .filter((r) => !g.has(r.agent_slug))
    .filter((r) => !wantHidden.has(r.agent_slug) && !wantVisible.has(r.agent_slug))
    .map((r) => r.agent_slug);

  const alwaysOnArr = listAlwaysOnSlugs();

  for (const s of toHide) {
    const { error: e } = await sb.rpc("staff_set_tenant_agent_hidden", {
      p_tenant_id: tenant_id,
      p_agent_slug: s,
      p_hide: true,
      p_reason: "staff",
      p_override_state: "hidden",
      p_always_on_slugs: alwaysOnArr,
    });
    if (e) {
      res.status(500).json({
        error: { code: "rpc_failed", message: `hide ${s}: ${e.message}` },
      });
      return;
    }
  }
  for (const s of toShow) {
    const { error: e } = await sb.rpc("staff_set_tenant_agent_hidden", {
      p_tenant_id: tenant_id,
      p_agent_slug: s,
      p_hide: true,
      p_reason: "staff-opt-in",
      p_override_state: "visible",
      p_always_on_slugs: alwaysOnArr,
    });
    if (e) {
      res.status(500).json({
        error: { code: "rpc_failed", message: `show ${s}: ${e.message}` },
      });
      return;
    }
  }
  for (const s of toRemove) {
    const { error: e } = await sb.rpc("staff_set_tenant_agent_hidden", {
      p_tenant_id: tenant_id,
      p_agent_slug: s,
      p_hide: false,
      p_reason: null,
      p_override_state: "hidden",
      p_always_on_slugs: alwaysOnArr,
    });
    if (e) {
      res.status(500).json({
        error: { code: "rpc_failed", message: `remove ${s}: ${e.message}` },
      });
      return;
    }
  }

  await writeStaffAudit({
    actor_user_id: staff.user_id,
    actor_email: staff.email,
    action: "agent_visibility.tenant.update",
    target_table: "tenant_agent_kill_switch",
    target_id: tenant_id,
    meta: {
      tenant_id,
      hidden_added: toHide,
      visible_added: toShow,
      removed: toRemove,
      ignored_global,
      ignored_locked_from_hidden,
      ignored_locked_from_visible,
    },
  });

  res.json({
    ok: true,
    applied_hidden: [...wantHidden],
    applied_visible: [...wantVisible],
    ignored_global,
    ignored_locked: [...ignored_locked_from_hidden, ...ignored_locked_from_visible],
  });
}
