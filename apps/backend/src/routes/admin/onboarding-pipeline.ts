
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";

type EventRow = {
  tenant_id: string | null;
  user_id: string | null;
  step: string | null;
  status: string | null;
  created_at: string | null;
};

export type StuckRow = {
  actor: string;
  tenant_id: string | null;
  tenant: string;
  last_step: string;
  last_status: string;
  last_activity_at: string;
  age_minutes: number;
  events: number;
};

export async function staffOnboardingPipeline(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const sb = staffCrossTenantClient("admin/onboarding-pipeline: cross-tenant staff read-only board");

  const rawDays = Number((req.query?.days as string | undefined) ?? "30");
  const days = Number.isFinite(rawDays) ? Math.min(365, Math.max(1, Math.floor(rawDays))) : 30;

  const rawMins = Number((req.query?.stuckMinutes as string | undefined) ?? "30");
  const stuckMinutes = Number.isFinite(rawMins) ? Math.min(1440, Math.max(5, Math.floor(rawMins))) : 30;

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const [events, tenants] = await Promise.all([
    sb
      .from("onboarding_step_events")
      .select("tenant_id, user_id, step, status, created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .limit(50000),
    sb.from("tenants").select("id, slug, display_name"),
  ]);

  if (events.error) {
    res.status(500).json({ error: { code: "pipeline_read_failed", message: events.error.message } });
    return;
  }

  const nameById = new Map<string, string>();
  for (const t of (tenants.data ?? []) as Array<{ id: string; slug: string | null; display_name: string | null }>) {
    nameById.set(t.id, t.display_name || t.slug || t.id.slice(0, 8));
  }

  type Acc = {
    actor: string;
    tenant_id: string | null;
    last_step: string;
    last_status: string;
    last_activity_at: string;
    events: number;
    activated: boolean;
  };
  const byActor = new Map<string, Acc>();

  for (const e of (events.data ?? []) as EventRow[]) {
    const actor = e.user_id ?? e.tenant_id;
    if (!actor) continue;
    const createdAt = e.created_at;
    if (!createdAt) continue;

    let acc = byActor.get(actor);
    if (!acc) {
      acc = {
        actor,
        tenant_id: e.tenant_id,
        last_step: e.step ?? "—",
        last_status: e.status ?? "—",
        last_activity_at: createdAt,
        events: 0,
        activated: false,
      };
      byActor.set(actor, acc);
    }
    acc.events += 1;
    if (!acc.tenant_id && e.tenant_id) acc.tenant_id = e.tenant_id;
    acc.last_step = e.step ?? "—";
    acc.last_status = e.status ?? "—";
    acc.last_activity_at = createdAt;
    if (e.step === "activate" && e.status === "completed") acc.activated = true;
  }

  const now = Date.now();
  const staleBefore = now - stuckMinutes * 60 * 1000;

  const rows: StuckRow[] = [];
  let totalIncomplete = 0;
  for (const acc of byActor.values()) {
    if (acc.activated) continue;
    totalIncomplete += 1;
    const lastMs = new Date(acc.last_activity_at).getTime();
    if (!Number.isFinite(lastMs) || lastMs > staleBefore) continue;
    rows.push({
      actor: acc.actor,
      tenant_id: acc.tenant_id,
      tenant: acc.tenant_id
        ? nameById.get(acc.tenant_id) ?? `user ${acc.actor.slice(0, 8)}`
        : `user ${acc.actor.slice(0, 8)}`,
      last_step: acc.last_step,
      last_status: acc.last_status,
      last_activity_at: acc.last_activity_at,
      age_minutes: Math.max(0, Math.round((now - lastMs) / 60000)),
      events: acc.events,
    });
  }

  rows.sort((a, b) => new Date(b.last_activity_at).getTime() - new Date(a.last_activity_at).getTime());

  res.json({
    windowDays: days,
    stuckMinutes,
    since,
    summary: {
      stuck: rows.length,
      incomplete: totalIncomplete,
    },
    stuck: rows,
  });
}
