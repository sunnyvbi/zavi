
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";
import { getAgentEffectiveStates } from "@/services/agents/visibility";
import { probeSetupCompleteness } from "@/services/agents/setup-schema";
import { computeAgentHealth, type HealthInput } from "../../services/agents/agent-health";

const SUCCESS_WINDOW_DAYS = 30;
const FEEDBACK_WINDOW_DAYS = 14;

type RunRow = {
  agent_slug: string;
  status: string;
  parse_ok: boolean | null;
  finished_at: string | null;
};
type FeedbackRow = {
  agent_slug: string;
  rating: number | null;
  created_by: string | null;
  created_by_role: string | null;
};

export async function staffTenantAgentHealth(req: Request, res: Response): Promise<void> {
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
  const feedbackSince = new Date(Date.now() - FEEDBACK_WINDOW_DAYS * 86400_000).toISOString();

  const [effective, runsRes, fbRes] = await Promise.all([
    getAgentEffectiveStates(tenantId).catch(() => []),
    sb
      .from("agent_runs")
      .select("agent_slug, status, parse_ok, finished_at")
      .eq("tenant_id", tenantId)
      .gte("started_at", successSince)
      .order("finished_at", { ascending: false }),
    sb
      .from("agent_feedback")
      .select("agent_slug, rating, created_by, created_by_role")
      .eq("tenant_id", tenantId)
      .or("target_type.is.null,target_type.neq.conductor_run")
      .gte("created_at", feedbackSince),
  ]);

  if (runsRes.error) {
    res.status(500).json({ error: { code: "runs_query_failed", message: runsRes.error.message } });
    return;
  }
  if (fbRes.error) {
    res.status(500).json({ error: { code: "feedback_query_failed", message: fbRes.error.message } });
    return;
  }

  const runBySlug = new Map<string, { latestTerminal: "success" | "failed" | null; hadSuccess: boolean }>();
  for (const r of (runsRes.data ?? []) as RunRow[]) {
    const cur = runBySlug.get(r.agent_slug) ?? { latestTerminal: null, hadSuccess: false };
    const isSuccess = r.status === "success" && r.parse_ok === true;
    const isTerminal = r.status !== "queued" && r.status !== "running";
    if (isSuccess) cur.hadSuccess = true;
    if (isTerminal && cur.latestTerminal === null) {
      cur.latestTerminal = isSuccess ? "success" : "failed";
    }
    runBySlug.set(r.agent_slug, cur);
  }

  type FB = { staffDown: number; opDown: number; opUp: number; opDownUsers: Set<string> };
  const fbBySlug = new Map<string, FB>();
  for (const f of (fbRes.data ?? []) as FeedbackRow[]) {
    const cur = fbBySlug.get(f.agent_slug) ?? { staffDown: 0, opDown: 0, opUp: 0, opDownUsers: new Set<string>() };
    const isStaff = f.created_by_role === "staff";
    if (f.rating === -1) {
      if (isStaff) cur.staffDown += 1;
      else {
        cur.opDown += 1;
        if (f.created_by) cur.opDownUsers.add(f.created_by);
      }
    } else if (f.rating === 1 && !isStaff) {
      cur.opUp += 1;
    }
    fbBySlug.set(f.agent_slug, cur);
  }

  const agents = await Promise.all(
    effective.map(async (e) => {
      let probeFailed = false;
      const probe = await probeSetupCompleteness(tenantId, e.slug).catch(() => {
        probeFailed = true;
        return { missing_required_connectors: [] as string[], missing_optional_connectors: [] as string[] };
      });
      if (probeFailed && e.effective_state !== "hidden") {
        return {
          slug: e.slug,
          badge: "yellow" as const,
          reason: "setup_probe_failed",
          detail: "could not determine connector setup — re-check",
          missing_required: [] as string[],
          missing_optional: [] as string[],
          last_run_status: runBySlug.get(e.slug)?.latestTerminal ?? null,
        };
      }
      const run = runBySlug.get(e.slug) ?? { latestTerminal: null, hadSuccess: false };
      const fb = fbBySlug.get(e.slug) ?? { staffDown: 0, opDown: 0, opUp: 0, opDownUsers: new Set<string>() };
      const input: HealthInput = {
        inactive: e.effective_state === "hidden",
        missingRequiredConnectors: probe.missing_required_connectors ?? [],
        latestTerminalStatus: run.latestTerminal,
        hadSuccessInWindow: run.hadSuccess,
        staffDown: fb.staffDown,
        operatorDownCount: fb.opDown,
        operatorUpCount: fb.opUp,
        operatorDownDistinctUsers: fb.opDownUsers.size,
      };
      const health = computeAgentHealth(input);
      return {
        slug: e.slug,
        badge: health.badge,
        reason: health.reason,
        detail: health.detail,
        missing_required: input.missingRequiredConnectors,
        missing_optional: probe.missing_optional_connectors ?? [],
        last_run_status: run.latestTerminal,
      };
    }),
  );

  res.json({
    tenant_id: tenantId,
    tenant: { id: tenant.id, slug: tenant.slug, display_name: tenant.display_name },
    windows: { success_days: SUCCESS_WINDOW_DAYS, feedback_days: FEEDBACK_WINDOW_DAYS },
    agents: agents.sort((a, b) => a.slug.localeCompare(b.slug)),
  });
}
