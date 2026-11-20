
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { applySlackMessageLifecycle } from "@/services/slack/source-message-lifecycle";

type IngestedEventRow = {
  id: string;
  tenant_id: string;
  provider: string;
  external_event_id: string;
  payload: Record<string, unknown>;
};

async function handleOne(
  ingested_event_id: string,
): Promise<{ handled: boolean; reason?: string; runs_stopped?: number; refired?: boolean }> {
  const svc = serviceClient();

  const { data: row, error } = await svc
    .from("ingested_events")
    .select("id, tenant_id, provider, external_event_id, payload")
    .eq("id", ingested_event_id)
    .maybeSingle<IngestedEventRow>();
  if (error) throw new Error(`ingested_events read failed: ${error.message}`);
  if (!row) return { handled: false, reason: "event_not_found" };
  if (row.provider !== "slack") return { handled: false, reason: "not_slack" };

  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const event = (payload.event ?? {}) as Record<string, unknown>;
  const team_id = typeof payload.team_id === "string" ? payload.team_id : "";

  const res = await applySlackMessageLifecycle({
    sc: svc,
    tenant_id: row.tenant_id,
    team_id,
    edit_event_id: row.external_event_id,
    event,
  });

  if (!res.handled) return { handled: false, reason: res.reason };
  return {
    handled: true,
    reason: res.kind,
    runs_stopped: res.runs_stopped,
    refired: res.refired,
  };
}

export const slackMessageLifecycleFn = inngest.createFunction(
  { id: "slack-message-lifecycle", retries: 1, concurrency: 4 },
  { event: "webhook.slack.ingested" },
  async ({ event, step, logger }) => {
    const id = event.data.ingested_event_id;
    const res = await step.run("lifecycle", () => handleOne(id));
    logger.info(`slack-message-lifecycle ${id}: ${JSON.stringify(res)}`);
    return res;
  },
);
