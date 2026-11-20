
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";
import { DOGFOOD_SLUGS } from "@/services/tenants/new-tenant-alert";
import { stepByNumber } from "@/services/onboarding-emails/steps";

export const STATS_STEPS = [1, 10, 2, 3, 4, 6, 7, 8, 9] as const;
const ACT_WINDOW_MS = 2 * 86_400_000;
const READ_CAP = 5000;

export type StatsInput = {
  sequences: ReadonlyArray<{ tenant_id: string; user_id: string; sent_steps: number[] | null }>;
  visits: ReadonlyArray<{ tenant_id: string; user_id: string; step: number; visited_at: string }>;
  actedAt: ReadonlyArray<{ tenant_id: string; at: string }>;
  excluded: ReadonlySet<string>;
};

export type StepStats = { step: number; label: string; sent: number; visits: number; acted: number };

export function aggregateOnboardingEmailStats(input: StatsInput): StepStats[] {
  const acts = new Map<string, number[]>();
  for (const a of input.actedAt) {
    if (input.excluded.has(a.tenant_id)) continue;
    const t = Date.parse(a.at);
    if (Number.isFinite(t)) acts.set(a.tenant_id, [...(acts.get(a.tenant_id) ?? []), t]);
  }
  return STATS_STEPS.map((step) => {
    const sent = input.sequences.filter((r) => !input.excluded.has(r.tenant_id) && (r.sent_steps ?? []).includes(step)).length;
    const visits = input.visits.filter((v) => v.step === step && !input.excluded.has(v.tenant_id));
    const acted = visits.filter((v) => {
      const at = Date.parse(v.visited_at);
      return (acts.get(v.tenant_id) ?? []).some((t) => t >= at && t - at <= ACT_WINDOW_MS);
    }).length;
    const label = step === 10 ? "First results (digest)" : (stepByNumber(step)?.headline ?? `Email ${step}`);
    return { step, label, sent, visits: visits.length, acted };
  });
}

export async function staffOnboardingEmailsStats(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const sb = staffCrossTenantClient("admin/onboarding-emails-stats: per-email sent/visits/acted across workspaces");
  const [seq, visits, tenants] = await Promise.all([
    sb.from("onboarding_email_sequence").select("tenant_id, user_id, sent_steps").limit(READ_CAP),
    sb.from("onboarding_email_visits").select("tenant_id, user_id, step, visited_at").limit(READ_CAP),
    sb.from("tenants").select("id, slug, kind").limit(READ_CAP),
  ]);
  for (const r of [seq, visits, tenants]) {
    if (r.error) {
      res.status(500).json({ error: { code: "read_failed", message: r.error.message } });
      return;
    }
  }
  const excluded = new Set<string>();
  for (const t of (tenants.data ?? []) as Array<{ id: string; slug: string | null; kind: string | null }>) {
    if (t.kind === "test" || (t.slug && DOGFOOD_SLUGS.has(t.slug))) excluded.add(t.id);
  }
  const visitRows = (visits.data ?? []) as StatsInput["visits"];
  const since = visitRows.reduce<string | null>((m, v) => (m === null || v.visited_at < m ? v.visited_at : m), null);

  let actedAt: StatsInput["actedAt"] = [];
  if (since) {
    const [events, goals] = await Promise.all([
      sb.from("channel_action_events").select("tenant_id, at").eq("actor_kind", "founder").gte("at", since).limit(READ_CAP),
      sb.from("autopilot_goals").select("tenant_id, created_at").eq("source", "founder").gte("created_at", since).limit(READ_CAP),
    ]);
    for (const r of [events, goals]) {
      if (r.error) {
        res.status(500).json({ error: { code: "read_failed", message: r.error.message } });
        return;
      }
    }
    actedAt = [
      ...((events.data ?? []) as Array<{ tenant_id: string; at: string }>),
      ...((goals.data ?? []) as Array<{ tenant_id: string; created_at: string }>).map((g) => ({ tenant_id: g.tenant_id, at: g.created_at })),
    ];
  }

  const sequences = (seq.data ?? []) as StatsInput["sequences"];
  const steps = aggregateOnboardingEmailStats({ sequences, visits: visitRows, actedAt, excluded });
  const people = new Set(sequences.filter((r) => !excluded.has(r.tenant_id)).map((r) => r.user_id)).size;
  res.json({
    steps,
    denominator: {
      people_in_sequence: people,
      excludes: "test workspaces (tenants.kind='test') and the dogfood workspaces upcar-ai, upcar-private, apna-tutor-dogfood",
      acted_means: "a founder card response or a goal set in that workspace within 2 days after the visit",
    },
  });
}
