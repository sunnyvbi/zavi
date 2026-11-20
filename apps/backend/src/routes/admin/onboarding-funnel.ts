
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";

export type StepEventInput = {
  tenant_id: string | null;
  user_id: string | null;
  step: string;
  status: string;
};

export type StepAgg = {
  step: string;
  entered: number;
  completed: number;
  skipped: number;
  abandoned: number;
  uniqueEntered: number;
  uniqueCompleted: number;
  droppedAtStep: number;
  completionRate: number | null;
};

export function aggregateOnboardingFunnel(events: StepEventInput[]): StepAgg[] {
  const byStep = new Map<
    string,
    {
      entered: number;
      completed: number;
      skipped: number;
      abandoned: number;
      enteredActors: Set<string>;
      completedActors: Set<string>;
    }
  >();

  for (const e of events) {
    let agg = byStep.get(e.step);
    if (!agg) {
      agg = {
        entered: 0,
        completed: 0,
        skipped: 0,
        abandoned: 0,
        enteredActors: new Set<string>(),
        completedActors: new Set<string>(),
      };
      byStep.set(e.step, agg);
    }
    const actor = e.user_id ?? e.tenant_id ?? "anon";
    switch (e.status) {
      case "completed":
        agg.completed += 1;
        agg.completedActors.add(actor);
        break;
      case "skipped":
        agg.skipped += 1;
        break;
      case "abandoned":
        agg.abandoned += 1;
        break;
      case "entered":
      default:
        agg.entered += 1;
        agg.enteredActors.add(actor);
        break;
    }
  }

  return Array.from(byStep.entries())
    .map(([step, a]) => {
      const uniqueEntered = a.enteredActors.size;
      const uniqueCompleted = a.completedActors.size;
      return {
        step,
        entered: a.entered,
        completed: a.completed,
        skipped: a.skipped,
        abandoned: a.abandoned,
        uniqueEntered,
        uniqueCompleted,
        droppedAtStep: Math.max(0, uniqueEntered - uniqueCompleted),
        completionRate: uniqueEntered > 0 ? uniqueCompleted / uniqueEntered : null,
      };
    })
    .sort((x, y) => y.droppedAtStep - x.droppedAtStep);
}

export async function staffOnboardingFunnel(req: Request, res: Response): Promise<void> {
  assertStaff(req);

  const rawDays = Number((req.query?.days as string | undefined) ?? "30");
  const days = Number.isFinite(rawDays) ? Math.min(365, Math.max(1, Math.floor(rawDays))) : 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await serviceClient()
    .from("onboarding_step_events")
    .select("tenant_id, user_id, step, status, created_at")
    .gte("created_at", since)
    .order("created_at", { ascending: true })
    .limit(50000);

  if (error) {
    res.status(500).json({ error: { code: "funnel_read_failed", message: error.message } });
    return;
  }

  const events = (data ?? []) as StepEventInput[];
  const steps = aggregateOnboardingFunnel(events);

  res.json({ windowDays: days, since, totalEvents: events.length, steps });
}
