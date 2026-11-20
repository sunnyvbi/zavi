
import { slackFetch } from "./_client";
import { ExpectedToolError } from "@/services/tools/types";

export const ACK_EMOJI = "eyes";

function slackErrCode(e: unknown): string {
  if (e instanceof ExpectedToolError) {
    const m = e.meta as { slack_error?: string } | undefined;
    if (m?.slack_error) return m.slack_error;
  }
  return (e as Error)?.message ?? "";
}

export async function addReaction(
  tenant_id: string,
  channel: string,
  ts: string,
  name: string,
  team_id?: string,
): Promise<void> {
  try {
    await slackFetch(tenant_id, "reactions.add", { channel, timestamp: ts, name }, team_id);
  } catch (e) {
    const code = slackErrCode(e);
    if (code === "already_reacted" || code.includes("already_reacted")) return;
    console.warn(`[slack.reactions.add] ${name} on ${channel}/${ts}: ${code}`);
  }
}

export async function removeReaction(
  tenant_id: string,
  channel: string,
  ts: string,
  name: string,
  team_id?: string,
): Promise<void> {
  try {
    await slackFetch(tenant_id, "reactions.remove", { channel, timestamp: ts, name }, team_id);
  } catch (e) {
    const code = slackErrCode(e);
    if (code === "no_reaction" || code.includes("no_reaction")) return;
    console.warn(`[slack.reactions.remove] ${name} on ${channel}/${ts}: ${code}`);
  }
}

export async function swapReaction(
  tenant_id: string,
  channel: string,
  ts: string,
  from: string,
  to: string,
  team_id?: string,
): Promise<void> {
  await removeReaction(tenant_id, channel, ts, from, team_id);
  await addReaction(tenant_id, channel, ts, to, team_id);
}
