
import { sendAgentOwnedEmail } from "./sendAgentOwnedEmail";
import { resolveAgentSendingIdentity } from "./sending-identity";
import { renderAgentResultEmail } from "./templates/agent-result";
import { resolveAgentEmailRecipients } from "@/services/notifications/agent-email-recipients";
import { recordDigestSendAudit } from "@/services/workspace/digest-send-audit";
import { webBaseUrl } from "@/services/web-base";

export type AgentResultEmailOutcome =
  | { sent: true; count: number }
  | { sent: false; reason: string };

export async function sendAgentResultEmail(args: {
  tenant_id: string;
  agent_slug: string;
  thread_owner_slug?: string;
  run_id: string;
  body: string;
  tenantName?: string;
  link?: { path: string; text: string };
  ready?: boolean;
  agent_name_is_typed?: boolean;
}): Promise<AgentResultEmailOutcome> {
  if (!process.env.SYSTEM_SENDGRID_API_KEY) {
    return { sent: false, reason: "no_system_key" };
  }

  const recipients = await resolveAgentEmailRecipients(args.tenant_id);
  if (recipients.length === 0) {
    return { sent: false, reason: "no_recipients" };
  }

  const base = webBaseUrl();
  const rendered = renderAgentResultEmail({
    agentSlug: args.agent_slug,
    body: args.body,
    runUrl: args.link
      ? `${base}${args.link.path}`
      : `${base}/workspace`,
    tenantName: args.tenantName,
    ctaText: args.link ? args.link.text : "Open Zavi",
    ...(args.ready ? { ready: true } : {}),
    ...(args.agent_name_is_typed ? { agentNameIsTyped: true } : {}),
  });

  const identity = await resolveAgentSendingIdentity(args.tenant_id);

  let sentCount = 0;
  const failures: string[] = [];
  for (const r of recipients) {
    try {
      await sendAgentOwnedEmail({
        tenant_id: args.tenant_id,
        agent_slug: args.thread_owner_slug ?? args.agent_slug,
        to: r.email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        fallbackFrom: { email: identity.from, name: identity.name },
      });
      sentCount += 1;
    } catch (e) {
      failures.push(
        `${r.email}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200),
      );
    }
  }

  if (sentCount > 0) {
    await recordDigestSendAudit({
      tenant_id: args.tenant_id,
      source_worker: "agent-result-email",
      subject: rendered.subject,
      verdict: "sent",
      violations: sentCount < recipients.length ? ["partial_send_failure"] : [],
    }).catch(() => {
    });
  }

  if (sentCount === 0) {
    return { sent: false, reason: `all_sends_failed: ${failures.join("; ")}` };
  }
  return { sent: true, count: sentCount };
}
