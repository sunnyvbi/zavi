import { buildConnections, type Connection } from "./health";

export const MESSAGING_SLUGS = ["slack", "whatsapp", "telegram", "discord", "teams"] as const;

export function messagingConnections(input: Omit<Parameters<typeof buildConnections>[0], "suggested">): Connection[] {
  const slugs: readonly string[] = MESSAGING_SLUGS;
  return buildConnections({
    ...input,
    rows: input.rows.filter((r) => slugs.includes(r.slug)),
    suggested: slugs,
  }).sort((a, b) => slugs.indexOf(a.slug) - slugs.indexOf(b.slug));
}

export const TEAMS_BIND_ERRORS: Readonly<Record<string, string>> = {
  m365_already_bound:
    "That Teams org is already connected to a different Zavi workspace. Disconnect it there first.",
  invalid_or_expired: "That code is invalid or expired. Re-add the Zavi app in Teams to get a fresh code.",
  not_admin: "Only a workspace owner or admin can connect Microsoft Teams.",
  missing_bind_code: "Enter the code Zavi sent you in Teams.",
  teams_disabled: "Microsoft Teams isn't enabled yet.",
  bind_failed: "Couldn't connect right now. Try again in a moment.",
};

export function teamsBindError(code: string | undefined): string {
  return (code && TEAMS_BIND_ERRORS[code]) || TEAMS_BIND_ERRORS.bind_failed;
}
