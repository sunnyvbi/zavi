
import { serviceClient } from "@/services/supabase";
import { isCronStopped } from "@/services/agents/cron-stopped";

type OrchestratorSchedule = { agent_slug: string; cron_expression: string };

const ORCHESTRATOR_SCHEDULES: OrchestratorSchedule[] = [
  { agent_slug: "pm", cron_expression: "0 9 * * *" },
];

export async function seedOrchestratorSchedules(tenant_id: string): Promise<{ inserted: number }> {
  const sb = serviceClient();

  let timezone = "America/Los_Angeles";
  const { data, error: tzErr } = await sb
    .from("tenants")
    .select("timezone")
    .eq("id", tenant_id)
    .maybeSingle<{ timezone: string | null }>();
  if (tzErr) {
    console.warn(
      `[seed-schedules] timezone read failed for ${tenant_id} (defaulting to ${timezone}): ${tzErr.message}`,
    );
  } else if (data?.timezone) {
    timezone = data.timezone;
  }

  let inserted = 0;
  let skipped_stopped = 0;
  for (const sched of ORCHESTRATOR_SCHEDULES) {
    if (isCronStopped(sched.agent_slug)) {
      skipped_stopped += 1;
      continue;
    }
    const { error } = await sb.from("tenant_agent_schedules").upsert(
      {
        tenant_id,
        agent_slug: sched.agent_slug,
        cron_expression: sched.cron_expression,
        enabled: true,
        timezone,
      },
      { onConflict: "tenant_id,agent_slug", ignoreDuplicates: true },
    );
    if (error) {
      console.warn(
        `[seed-schedules] upsert failed for ${tenant_id}/${sched.agent_slug}: ${error.message}`,
      );
      continue;
    }
    inserted += 1;
  }
  if (skipped_stopped > 0) {
    console.info(
      `[seed-schedules] ${tenant_id}: ${skipped_stopped} orchestrator schedule(s) not seeded — cron stopped fleet-wide`,
    );
  }
  return { inserted };
}
