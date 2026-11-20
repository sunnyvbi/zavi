
export const ON_IT_ACK = "On it — I'll reply here in a minute.";

export const MEDIA_UNSUPPORTED_TEXT =
  "I can't read images or attachments yet. Can you describe what's in it?";

export const INTAKE_FAILED_TEXT =
  "Something went wrong on my side and that message didn't go through. Please try again in a minute.";

export function approvalPendingText(tenantId?: string | null): string {
  const company = tenantId ? `&company=${encodeURIComponent(tenantId)}` : "";
  return `I need your approval before I can continue. Review it here: https://www.zaviagent.com/workspace?tab=needs-you${company} — I'll reply in this chat once it's approved.`;
}
export const APPROVAL_PENDING_TEXT = approvalPendingText();

export const DISCORD_DM_TEXT =
  "I work inside a Discord server, not DMs yet. @mention me in a channel of your connected server — or connect one at https://www.zaviagent.com/workspace?tab=settings.";

export const DISCORD_ROLE_MENTION_TEXT =
  "That @Zavi is the Zavi role, not me, so I can't read it. Type @Zavi, pick the entry with the APP badge, and send it again.";
