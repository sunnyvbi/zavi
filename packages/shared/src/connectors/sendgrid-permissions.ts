
export const SENDGRID_GROUPS = [
  "mail_send",
  "marketing_lists_read",
  "single_sends_write",
  "stats_read",
  "senders_read",
  "suppression_groups_read",
] as const;
export type SendgridGroup = (typeof SENDGRID_GROUPS)[number];

export const SENDGRID_GROUP_LABEL: Readonly<Record<SendgridGroup, string>> = {
  mail_send: "Mail Send",
  marketing_lists_read: "Marketing: lists",
  single_sends_write: "Marketing: Single Sends",
  stats_read: "Stats",
  senders_read: "Sender verification (read)",
  suppression_groups_read: "Unsubscribe groups (read)",
};

export function sendgridCampaignReady(groups: readonly string[] | Partial<Record<string, boolean>> | null | undefined): boolean {
  if (!groups) return false;
  if (Array.isArray(groups)) return SENDGRID_GROUPS.every((g) => groups.includes(g));
  const map = groups as Partial<Record<string, boolean>>;
  return SENDGRID_GROUPS.every((g) => map[g] === true);
}
