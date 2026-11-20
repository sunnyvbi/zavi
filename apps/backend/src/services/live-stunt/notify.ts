import { renderLiveStuntReviewEmail, type LiveStuntReviewEmail } from "@/email/templates/live-stunt-review";

export async function emailReviewLink(tenant_id: string, e: LiveStuntReviewEmail): Promise<{ sent: boolean; reason?: string }> {
  if (!process.env.SYSTEM_SENDGRID_API_KEY) return { sent: false, reason: "no_system_key" };
  const { resolveTenantOwnerEmail } = await import("@/email/sendAuthEmail");
  const to = await resolveTenantOwnerEmail(tenant_id);
  if (!to) return { sent: false, reason: "no_owner_email" };
  const r = renderLiveStuntReviewEmail(e);
  const { sendAgentOwnedEmail } = await import("@/email/sendAgentOwnedEmail");
  const { systemSender } = await import("@/email/system-identity");
  await sendAgentOwnedEmail({ tenant_id, agent_slug: "cgo", to, subject: r.subject, html: r.html, text: r.text, fallbackFrom: systemSender() });
  return { sent: true };
}

export async function slackReviewLink(tenant_id: string, text: string, idempotencyKey: string): Promise<{ sent: boolean; reason?: string }> {
  const { resolveTenantOwnerEmail } = await import("@/email/sendAuthEmail");
  const email = await resolveTenantOwnerEmail(tenant_id);
  if (!email) return { sent: false, reason: "no_owner_email" };
  const { resolveTargetSlackWorkspace } = await import("@/services/slack/resolve-target-workspace");
  const ws = await resolveTargetSlackWorkspace(tenant_id, "cgo");
  if (!ws) return { sent: false, reason: "no_slack" };
  const { slackFetch } = await import("@/services/tools/slack/_client");
  const { ExpectedToolError } = await import("@/services/tools/types");
  let channel: string | undefined;
  try {
    const who = await slackFetch<{ user?: { id?: string } }>(tenant_id, "users.lookupByEmail", { email }, ws.team_id);
    if (!who.user?.id) return { sent: false, reason: "no_slack_member" };
    const open = await slackFetch<{ channel?: { id?: string } }>(tenant_id, "conversations.open", { users: who.user.id }, ws.team_id);
    channel = open.channel?.id;
  } catch (e) {
    if (e instanceof ExpectedToolError && (e.code === "slack_not_connected" || e.code === "slack_api_error")) return { sent: false, reason: e.code };
    throw e;
  }
  if (!channel) return { sent: false, reason: "no_dm_channel" };
  const { enqueueSlackOutbox } = await import("@/services/slack/outbox");
  const seq = await enqueueSlackOutbox({ tenant_id, channel_id: channel, kind: "live_stunt_review", body: text, team_id: ws.team_id, idempotency_key: idempotencyKey });
  if (seq == null) throw new Error("live-stunt: Slack DM enqueue failed");
  return { sent: true };
}
