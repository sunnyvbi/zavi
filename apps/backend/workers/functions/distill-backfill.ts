
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";

const SETTLE_MINUTES = 5;
const PAGE_SIZE = 100;

type RunRow = {
  id: string;
  tenant_id: string;
  agent_slug: string;
  trigger: string;
};

type ThreadMessageRow = {
  id: string;
  thread_id: string;
  tenant_id: string;
};

async function backfillForTenants(): Promise<{
  runs_refired: number;
  user_msgs_refired: number;
}> {
  const sb = serviceClient();
  const cutoff = new Date(Date.now() - SETTLE_MINUTES * 60 * 1000).toISOString();

  const { data: runData, error: runErr } = await sb
    .from("agent_runs")
    .select("id, tenant_id, agent_slug, trigger")
    .is("distilled_at", null)
    .eq("status", "success")
    .lt("finished_at", cutoff)
    .order("finished_at", { ascending: false })
    .limit(PAGE_SIZE);
  if (runErr) {
    console.warn(`[distill-backfill] agent_runs scan failed: ${runErr.message}`);
    return { runs_refired: 0, user_msgs_refired: 0 };
  }

  let runsRefired = 0;
  for (const r of (runData ?? []) as RunRow[]) {
    const eventName =
      r.trigger === "chat" ? "chat.turn_complete" : "agent.run.distillable";
    try {
      await inngest.send({
        name: eventName,
        data: { run_id: r.id, tenant_id: r.tenant_id, agent_slug: r.agent_slug },
      });
      runsRefired += 1;
    } catch (e) {
      console.warn(
        `[distill-backfill] re-fire for run ${r.id} failed: ${(e as Error).message}`,
      );
    }
  }

  const { data: msgData, error: msgErr } = await sb
    .from("agent_thread_messages")
    .select("id, thread_id, tenant_id, agent_run_id")
    .is("distilled_at", null)
    .eq("sender_role", "user")
    .lt("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(PAGE_SIZE);
  let msgsRefired = 0;
  if (!msgErr && msgData) {
    for (const m of msgData as Array<ThreadMessageRow & { agent_run_id: string | null }>) {
      if (!m.agent_run_id) continue;
      const { data: runRow } = await sb
        .from("agent_runs")
        .select("agent_slug, status, distilled_at, trigger")
        .eq("id", m.agent_run_id)
        .maybeSingle();
      if (!runRow) continue;
      const rr = runRow as {
        agent_slug: string;
        status: string;
        distilled_at: string | null;
        trigger: string;
      };
      if (rr.distilled_at) continue;
      if (rr.status !== "success") continue;
      if (rr.trigger !== "chat") continue;
      try {
        await inngest.send({
          name: "chat.turn_complete",
          data: {
            run_id: m.agent_run_id,
            tenant_id: m.tenant_id,
            agent_slug: rr.agent_slug,
          },
        });
        msgsRefired += 1;
      } catch (e) {
        console.warn(
          `[distill-backfill] msg re-fire for ${m.id} failed: ${(e as Error).message}`,
        );
      }
    }
  }

  return { runs_refired: runsRefired, user_msgs_refired: msgsRefired };
}

export const distillBackfillFn = inngest.createFunction(
  { id: "distill-backfill", concurrency: 1 },
  { cron: "0 * * * *" },
  async ({ logger }) => {
    const res = await backfillForTenants();
    logger.info(
      `distill-backfill: runs_refired=${res.runs_refired} user_msgs_refired=${res.user_msgs_refired}`,
    );
    return res;
  },
);
