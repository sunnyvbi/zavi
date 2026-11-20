
export const HUMAN_TRIGGERS = ["chat", "slack", "teams"] as const;

export const IDLE_SUSPEND_DAYS = 14;

const PLATFORM_SUSPENDERS = new Set(["billing", "abuse", "platform"]);

const FREE_PLANS = new Set(["free"]);

export type HostingRow = {
  tenant_id: string;
  render_service_id: string;
  suspended: string;
  plan?: string;
  suspenders?: string[];
  last_human_at: string | null;
  has_own_domain?: boolean;
  has_db?: boolean;
};

export type ReapPlan = {
  suspend: HostingRow[];
  resume: HostingRow[];
  skipped: Array<{ tenant_id: string; render_service_id: string; reason: string }>;
};

function daysBetween(fromIso: string, now: Date): number {
  return (now.getTime() - new Date(fromIso).getTime()) / 86_400_000;
}

export function planReap(rows: HostingRow[], now: Date = new Date()): ReapPlan {
  const plan: ReapPlan = { suspend: [], resume: [], skipped: [] };
  const skip = (r: HostingRow, reason: string) =>
    plan.skipped.push({ tenant_id: r.tenant_id, render_service_id: r.render_service_id, reason });

  for (const r of rows) {
    const isSuspended = r.suspended === "suspended";

    if (isSuspended) {
      if ((r.suspenders ?? []).some((s) => PLATFORM_SUSPENDERS.has(s))) {
        skip(r, "suspended by platform (billing/abuse) — not ours to resume");
        continue;
      }
      if (r.has_db === false) {
        skip(r, "suspended and its database is gone — resume would crash-loop");
        continue;
      }
      if (r.last_human_at && daysBetween(r.last_human_at, now) < IDLE_SUSPEND_DAYS) {
        plan.resume.push(r);
      } else {
        skip(r, "suspended and still idle");
      }
      continue;
    }

    if (r.plan && FREE_PLANS.has(r.plan)) {
      skip(r, "free plan — costs nothing to leave running");
      continue;
    }
    if (r.has_own_domain) {
      skip(r, "tenant attached their own domain — high intent, never idle-reap");
      continue;
    }
    if (!r.last_human_at) {
      plan.suspend.push(r);
      continue;
    }
    if (daysBetween(r.last_human_at, now) >= IDLE_SUSPEND_DAYS) {
      plan.suspend.push(r);
    } else {
      skip(r, "active within the idle window");
    }
  }

  return plan;
}
