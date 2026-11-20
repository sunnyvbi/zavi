
import { actionsStoreFor } from "@zavi/shared";
import { listChannelActions, type ChannelActionView } from "@/services/channels/channel-actions";

export type ChannelStepRow = {
  id: string;
  decision_class: string;
  body: Record<string, unknown> | null;
  emitted_at: string | null;
  agent_run_id: string | null;
  executable: boolean;
  exec_status: ChannelActionView["exec_status"];
  exec_in_flight: boolean;
};

export function channelIsSwitched(slug: string): boolean {
  return actionsStoreFor(slug) === "channel_actions";
}

export async function readSwitchedChannelRows(
  tenantId: string,
  channelSlug: string,
): Promise<ChannelStepRow[]> {
  if (!channelIsSwitched(channelSlug)) return [];
  try {
    const { actions } = await listChannelActions(tenantId, channelSlug, { all: true });
    return actions.map(toStepRow);
  } catch (e) {
    console.warn(
      `[dashboards] channel_actions read failed for ${channelSlug}: ${(e as Error).message}`,
    );
    return [];
  }
}

export function toStepRow(a: ChannelActionView): ChannelStepRow {
  return {
    id: a.id,
    decision_class: "channel.recipe_step",
    body: (a.body ?? null) as Record<string, unknown> | null,
    emitted_at: a.proposed_at,
    agent_run_id: a.run_id,
    executable: a.executable,
    exec_status: a.exec_status,
    exec_in_flight: a.exec_status === "queued" || a.exec_status === "dispatching",
  };
}
