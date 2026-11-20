
import { serviceClient } from "@/services/supabase";
import { logEvent } from "@/services/logging/logEvent";

type InvestorRef = {
  name?: string;
  firm?: string;
  linkedin_handle?: string;
  linkedin_dm?: string;
};

type ManualOutreachReason =
  | "linkedin_only"
  | "missing_contact"
  | "low_confidence_email";

export type CreateManualOutreachTaskParams = {
  tenant_id: string;
  run_id: string;
  investor: InvestorRef;
  reason: ManualOutreachReason;
};

function buildSummary(investor: InvestorRef, reason: ManualOutreachReason): string {
  const name = investor.name ?? "Unknown";
  const firm = investor.firm ?? "Unknown firm";
  switch (reason) {
    case "linkedin_only":
      return `Send LinkedIn DM to ${name} at ${firm}. Handle: ${investor.linkedin_handle ?? "(unknown)"}. Copy: ${investor.linkedin_dm ?? "(see strategy output)"}`;
    case "missing_contact":
      return `Research a verified email for ${name} at ${firm} before outreach.`;
    case "low_confidence_email":
      return `Research a verified email for ${name} at ${firm} before outreach.`;
  }
}

export async function createManualOutreachTask(
  params: CreateManualOutreachTaskParams,
): Promise<{ inserted: boolean }> {
  const { tenant_id, run_id, investor, reason } = params;
  const svc = serviceClient();

  let thread_id: string | null = null;
  try {
    const { data: runRow } = await svc
      .from("agent_runs")
      .select("payload, agent_slug")
      .eq("id", run_id)
      .eq("tenant_id", tenant_id)
      .maybeSingle<{ payload: { thread_id?: string } | null; agent_slug: string }>();
    thread_id = runRow?.payload?.thread_id ?? null;
    const agent_slug = runRow?.agent_slug ?? "fundraising";

    if (!thread_id) {
      console.warn(
        `[fundraising/manual-tasks] run ${run_id} has no thread_id — skipping agent_open_actions insert (reason=${reason})`,
      );
      void logEvent({
        level: "info",
        source: "fundraising.manual-tasks",
        code: "fundraising_manual_task_no_thread",
        meta: { tenant_id, run_id, reason },
      });
      return { inserted: false };
    }

    const summary = buildSummary(investor, reason);
    const { error } = await svc.from("agent_open_actions").insert({
      tenant_id,
      thread_id,
      agent_slug,
      source_run_id: run_id,
      summary,
      severity: "normal",
      proposed_action: summary,
      status: "open",
    });

    if (error) {
      console.warn(`[fundraising/manual-tasks] insert failed: ${error.message}`);
      return { inserted: false };
    }

    void logEvent({
      level: "info",
      source: "fundraising.manual-tasks",
      code: "fundraising_manual_task_created",
      meta: { tenant_id, run_id, reason, count: 1 },
    });
    return { inserted: true };
  } catch (e) {
    console.warn(
      `[fundraising/manual-tasks] threw: ${e instanceof Error ? e.message : String(e)}`,
    );
    return { inserted: false };
  }
}
