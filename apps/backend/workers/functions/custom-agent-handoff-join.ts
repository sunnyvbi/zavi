
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import {
  HANDOFF_DELIVER_ATTEMPTS,
  HANDOFF_JOIN_EVENT,
  HANDOFF_LEASE_SECONDS,
  HANDOFF_JOIN_POLL_SECONDS,
  HANDOFF_JOIN_WAIT_SECONDS,
  checkHandoffJoin,
  defaultJoinSeams,
} from "@/services/agents/custom-agent-handoff";

const MAX_CHECKS =
  Math.ceil(HANDOFF_JOIN_WAIT_SECONDS / HANDOFF_JOIN_POLL_SECONDS) +
  HANDOFF_DELIVER_ATTEMPTS * (1 + Math.ceil(HANDOFF_LEASE_SECONDS / HANDOFF_JOIN_POLL_SECONDS)) +
  1;

export const customAgentHandoffJoinFn = inngest.createFunction(
  { id: "custom-agent-handoff-join", idempotency: "event.data.parent_run_id", retries: 3 },
  { event: HANDOFF_JOIN_EVENT },
  async ({ event, step, logger }) => {
    const parent_run_id = event.data?.parent_run_id as string | undefined;
    if (!parent_run_id) return { status: "skip", reason: "bad_event" };

    const tenant_id = await step.run("derive-tenant", async () => {
      const { data, error } = await serviceClient()
        .from("agent_runs")
        .select("tenant_id")
        .eq("id", parent_run_id)
        .maybeSingle<{ tenant_id: string }>();
      if (error) throw new Error(`parent read failed: ${error.message}`);
      return data?.tenant_id ?? null;
    });
    if (!tenant_id) return { status: "skip", reason: "parent_not_found" };

    for (let i = 0; i < MAX_CHECKS; i++) {
      const r = await step.run(`check-${i}`, () =>
        checkHandoffJoin(tenant_id, parent_run_id, new Date(), defaultJoinSeams),
      );
      if (r.state !== "wait") {
        logger.info(`custom-agent-handoff-join ${parent_run_id}: ${r.state} ${r.outcome ?? ""}`);
        return r;
      }
      await step.sleep(`wait-${i}`, `${HANDOFF_JOIN_POLL_SECONDS}s`);
    }
    return { status: "skip", reason: "max_checks" };
  },
);
