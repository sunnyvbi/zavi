
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { alert } from "@/services/logging/alert";
import { isFleetHalted } from "@/services/agents/fleet-halt";

export const SLOW_START_MS = 2 * 60_000;
export const STUCK_QUEUED_MS = 5 * 60_000;
export const ALERT_THRESHOLD = 5;

type Row = { enqueued_at: string; started_at: string | null; status: string };

export function assessCapacity(rows: Row[], now: number) {
  let slowStarts = 0;
  let stuckQueued = 0;
  for (const r of rows) {
    const enq = Date.parse(r.enqueued_at);
    if (r.started_at) {
      if (Date.parse(r.started_at) - enq > SLOW_START_MS) slowStarts++;
    } else if (r.status === "queued" && now - enq > STUCK_QUEUED_MS) {
      stuckQueued++;
    }
  }
  return { slowStarts, stuckQueued, total: rows.length, alert: slowStarts >= ALERT_THRESHOLD || stuckQueued >= ALERT_THRESHOLD };
}

export async function runInngestCapacityWatch(now = Date.now()) {
  if (await isFleetHalted()) return { skipped: "fleet_halted" };
  const since = new Date(now - 60 * 60_000).toISOString();
  const { data, error } = await serviceClient()
    .from("agent_runs")
    .select("enqueued_at, started_at, status")
    .gte("enqueued_at", since)
    .limit(5000);
  if (error) return { skipped: `query_failed: ${error.message}` };
  const a = assessCapacity((data ?? []) as Row[], now);
  if (!a.alert) return a;
  await alert({
    source: "inngest-capacity-watch",
    code: "inngest_capacity",
    msg: `Agent runs are waiting to start: ${a.slowStarts} of ${a.total} in the last hour waited over 2 min, ${a.stuckQueued} queued over 5 min now. Likely the Inngest plan's concurrency limit.`,
    email: {
      dedupeKey: `inngest_capacity:${new Date(now).toISOString().slice(0, 10)}`,
      subjectDetail: `${a.slowStarts} slow starts, ${a.stuckQueued} stuck`,
      detail: [
        "Zavi agent runs are waiting in line before they start. The most likely cause is the Inngest plan's limit on how many steps run at once.",
        "",
        "Confirm: app.inngest.com, production, Metrics: if account concurrency sits flat at the plan limit, the plan is the bottleneck.",
        "Fix: Settings, Billing: Pro includes 100 concurrent steps (from $99/mo); more can be added in blocks of 25.",
        "Not the plan if: a deploy, the fleet halt, or a database incident happened in the same hour.",
      ].join("\n"),
    },
  });
  return a;
}

export const inngestCapacityWatchFn = inngest.createFunction(
  { id: "inngest-capacity-watch" },
  { cron: "7 * * * *" },
  async () => runInngestCapacityWatch(),
);
