
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";

const STAGES = [
  "needs_onboarding",
  "needs_connector",
  "needs_first_run",
  "needs_approval",
  "activated",
] as const;
type Stage = (typeof STAGES)[number];

type ActivationRow = {
  tenant_id: string;
  slug: string;
  display_name: string;
  kind: string | null;
  created_at: string;
  brain_seeded: boolean;
  connectors_count: number | string;
  first_connector_at: string | null;
  runs: number | string;
  first_run_at: string | null;
  approval_acted: boolean;
  first_acted_at: string | null;
  first_deliverable_at: string | null;
  last_active_at: string | null;
  activated: boolean;
  activated_at: string | null;
  activation_stage: Stage;
  stage_since: string | null;
  days_in_stage: number | string | null;
  time_to_value_hours: number | string | null;
};

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round(((s[mid - 1] + s[mid]) / 2) * 10) / 10;
}

export async function staffActivation(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const raw = Number.parseInt(String(req.query.window ?? "60"), 10);
  const windowDays = Number.isFinite(raw) ? Math.min(365, Math.max(1, raw)) : 60;
  const kindFilter = String(req.query.kind ?? "real");

  const sb = serviceClient();
  const { data, error } = await sb.rpc("admin_tenant_activation", { p_window_days: windowDays });
  if (error) {
    res.status(500).json({ error: { code: "activation_failed", message: error.message } });
    return;
  }

  const all = ((data ?? []) as ActivationRow[]).map((r) => ({
    ...r,
    connectors_count: Number(r.connectors_count) || 0,
    runs: Number(r.runs) || 0,
    days_in_stage: r.days_in_stage == null ? null : Number(r.days_in_stage),
    time_to_value_hours: r.time_to_value_hours == null ? null : Number(r.time_to_value_hours),
  }));

  const rows = all.filter((r) => {
    const k = (r.kind ?? "real").toLowerCase();
    if (kindFilter === "real") return k !== "test";
    if (kindFilter === "test") return k === "test";
    return true;
  });

  const reached: Record<string, number> = {
    signed_up: rows.length,
    brain_seeded: rows.filter((r) => r.brain_seeded).length,
    connected: rows.filter((r) => r.connectors_count > 0).length,
    ran_agent: rows.filter((r) => r.runs > 0).length,
    acted_approval: rows.filter((r) => r.approval_acted).length,
    activated: rows.filter((r) => r.activated).length,
  };

  const byStage: Record<Stage, number> = {
    needs_onboarding: 0,
    needs_connector: 0,
    needs_first_run: 0,
    needs_approval: 0,
    activated: 0,
  };
  for (const r of rows) byStage[r.activation_stage] = (byStage[r.activation_stage] ?? 0) + 1;

  const ttv = rows
    .map((r) => r.time_to_value_hours)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));

  res.json({
    window_days: windowDays,
    kind: kindFilter,
    totals: {
      tenants: rows.length,
      activated: reached.activated,
      activation_rate:
        rows.length > 0 ? Math.round((reached.activated / rows.length) * 100) / 100 : null,
      median_time_to_value_hours: median(ttv),
    },
    funnel: reached,
    by_stage: byStage,
    tenants: rows,
  });
}
