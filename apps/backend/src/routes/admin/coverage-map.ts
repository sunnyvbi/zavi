
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";
import { getAgentEffectiveStates } from "@/services/agents/visibility";
import {
  buildCoverageMap,
  GROWTH_FUNCTIONS,
  type GrowthFunction,
} from "@/services/agents/growth-coverage";

const SUCCESS_WINDOW_DAYS = 30;
const FUNCTION_TAGGED_COVER_ACTIONS = ["set_goal", "bake_rule"];

type RunRow = { agent_slug: string; status: string; parse_ok: boolean | null };
type CoverRow = { action: string; target: string | null };

export async function staffTenantCoverageMap(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const tenantId = req.params.tenant_id;
  const sb = serviceClient();

  const { data: tenant, error: tErr } = await sb
    .from("tenants")
    .select("id, slug, display_name")
    .eq("id", tenantId)
    .maybeSingle();
  if (tErr) {
    res.status(500).json({ error: { code: "tenant_lookup_failed", message: tErr.message } });
    return;
  }
  if (!tenant) {
    res.status(404).json({ error: { code: "tenant_not_found", message: tenantId } });
    return;
  }

  const successSince = new Date(Date.now() - SUCCESS_WINDOW_DAYS * 86400_000).toISOString();

  const [effective, runsRes, coverRes] = await Promise.all([
    getAgentEffectiveStates(tenantId).catch(() => []),
    sb
      .from("agent_runs")
      .select("agent_slug, status, parse_ok")
      .eq("tenant_id", tenantId)
      .gte("started_at", successSince),
    sb
      .from("admin_action_log")
      .select("action, target")
      .eq("tenant_id", tenantId)
      .in("action", FUNCTION_TAGGED_COVER_ACTIONS)
      .gte("created_at", successSince),
  ]);

  if (runsRes.error) {
    res.status(500).json({ error: { code: "runs_query_failed", message: runsRes.error.message } });
    return;
  }

  const validFns = new Set<string>(GROWTH_FUNCTIONS);
  const adminCoverByFn: Partial<Record<GrowthFunction, number>> = {};
  for (const c of (coverRes.data ?? []) as CoverRow[]) {
    if (c.target && validFns.has(c.target)) {
      const fn = c.target as GrowthFunction;
      adminCoverByFn[fn] = (adminCoverByFn[fn] ?? 0) + 1;
    }
  }

  const handledSlugs = new Set<string>();
  for (const r of (runsRes.data ?? []) as RunRow[]) {
    if (r.status === "success" && r.parse_ok === true) handledSlugs.add(r.agent_slug);
  }

  const handlingBySlug = new Map<string, { present: boolean; hidden: boolean; handling: boolean }>();
  for (const e of effective) {
    handlingBySlug.set(e.slug, {
      present: true,
      hidden: e.effective_state === "hidden",
      handling: handledSlugs.has(e.slug),
    });
  }

  const functions = buildCoverageMap(handlingBySlug, adminCoverByFn);

  res.json({
    tenant_id: tenantId,
    tenant: { id: tenant.id, slug: tenant.slug, display_name: tenant.display_name },
    window_days: SUCCESS_WINDOW_DAYS,
    functions,
    note: "admin-cover = function-tagged cover-actions (set_goal/bake_rule) in the window; autonomy % is the agent-handling structural proxy.",
  });
}
