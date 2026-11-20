
import { serviceClient } from "@/services/supabase";

export type SlackIndexRow = {
  channel_id: string;
  conversation_type: "channel_public" | "channel_private" | "dm" | "mpim";
  source_user_ids: string[];
  source_team_id?: string;
};

export type VisibilityResult = {
  visible: boolean;
  reason: string;
};

export type BulkVisibilityResult = {
  row: SlackIndexRow;
  visible: boolean;
  reason: string;
};

export async function resolveVisibility(args: {
  asker_user_id: string;
  tenant_id: string;
  candidate_row: SlackIndexRow;
}): Promise<VisibilityResult> {
  const [out] = await resolveVisibilityBulk({
    asker_user_id: args.asker_user_id,
    tenant_id: args.tenant_id,
    candidate_rows: [args.candidate_row],
  });
  if (!out) return { visible: false, reason: "no_result" };
  return { visible: out.visible, reason: out.reason };
}

export async function resolveVisibilityBulk(args: {
  asker_user_id: string;
  tenant_id: string;
  candidate_rows: SlackIndexRow[];
}): Promise<BulkVisibilityResult[]> {
  if (args.candidate_rows.length === 0) return [];
  const sb = serviceClient();

  const askerSlackUserId = await resolveAskerSlackUserId(
    sb,
    args.tenant_id,
    args.asker_user_id,
  );

  const askerInTenant = await isAskerInTenant(sb, args.tenant_id, args.asker_user_id);

  return computeVisibilityBulk(sb, {
    tenant_id: args.tenant_id,
    team_id: undefined,
    candidate_rows: args.candidate_rows,
    askerSlackUserId,
    askerInTenant,
  });
}

export async function resolveVisibilityBulkBySlackUser(args: {
  tenant_id: string;
  team_id: string;
  asker_slack_user_id: string;
  candidate_rows: SlackIndexRow[];
}): Promise<BulkVisibilityResult[]> {
  if (args.candidate_rows.length === 0) return [];
  if (!args.asker_slack_user_id || !args.team_id) {
    return args.candidate_rows.map((row) => ({
      row,
      visible: false,
      reason: "no_asker_slack_user_or_team",
    }));
  }
  const sb = serviceClient();
  const askerInTenant = await isSlackUserWorkspaceMember(
    sb,
    args.tenant_id,
    args.team_id,
    args.asker_slack_user_id,
  );
  return computeVisibilityBulk(sb, {
    tenant_id: args.tenant_id,
    team_id: args.team_id,
    candidate_rows: args.candidate_rows,
    askerSlackUserId: args.asker_slack_user_id,
    askerInTenant,
  });
}

async function isSlackUserWorkspaceMember(
  sb: ReturnType<typeof serviceClient>,
  tenant_id: string,
  team_id: string,
  slack_user_id: string,
): Promise<boolean> {
  const { data, error } = await sb
    .from("team_member_identities")
    .select("external_id")
    .eq("tenant_id", tenant_id)
    .eq("provider", "slack")
    .eq("team_id", team_id)
    .in("external_id", [slack_user_id]);
  if (error) return false;
  return Array.isArray(data) && data.length > 0;
}

async function computeVisibilityBulk(
  sb: ReturnType<typeof serviceClient>,
  args: {
    tenant_id: string;
    team_id: string | undefined;
    candidate_rows: SlackIndexRow[];
    askerSlackUserId: string | null;
    askerInTenant: boolean;
  },
): Promise<BulkVisibilityResult[]> {
  const { tenant_id, team_id, candidate_rows, askerSlackUserId, askerInTenant } = args;

  const privateChannelIds = Array.from(
    new Set(
      candidate_rows
        .filter((r) => r.conversation_type === "channel_private")
        .map((r) => r.channel_id),
    ),
  );
  const askerChannelMembership = new Set<string>();
  if (askerSlackUserId && privateChannelIds.length > 0) {
    let memQ = sb
      .from("slack_channel_members")
      .select("channel_id")
      .eq("tenant_id", tenant_id)
      .eq("slack_user_id", askerSlackUserId)
      .in("channel_id", privateChannelIds);
    if (team_id) memQ = memQ.eq("team_id", team_id);
    const { data: memRows } = await memQ;
    for (const r of (memRows as Array<{ channel_id: string }> | null) ?? []) {
      askerChannelMembership.add(r.channel_id);
    }
  }

  const allSlackUserIds = Array.from(
    new Set(candidate_rows.flatMap((r) => r.source_user_ids ?? [])),
  );
  const departed = new Set<string>();
  if (allSlackUserIds.length > 0) {
    let identQ = sb
      .from("team_member_identities")
      .select("external_id, member_id")
      .eq("tenant_id", tenant_id)
      .eq("provider", "slack")
      .in("external_id", allSlackUserIds);
    if (team_id) identQ = identQ.eq("team_id", team_id);
    const { data: idents } = await identQ;
    type IdentRow = { external_id: string; member_id: string };
    const identRows = (idents as IdentRow[] | null) ?? [];
    const memberIds = Array.from(new Set(identRows.map((r) => r.member_id)));

    let activeMemberIds = new Set<string>();
    if (memberIds.length > 0) {
      const { data: members } = await sb
        .from("team_members")
        .select("id, status, last_active_at")
        .eq("tenant_id", tenant_id)
        .in("id", memberIds);
      for (const m of (members as Array<{
        id: string;
        status: string;
        last_active_at: string | null;
      }> | null) ?? []) {
        if (m.status === "active" && m.last_active_at != null) {
          activeMemberIds.add(m.id);
        }
      }
    }

    const slackUserToActive = new Map<string, boolean>();
    for (const id of allSlackUserIds) slackUserToActive.set(id, false);
    for (const r of identRows) {
      slackUserToActive.set(r.external_id, activeMemberIds.has(r.member_id));
    }
    for (const [slackId, isActive] of slackUserToActive) {
      if (!isActive) departed.add(slackId);
    }
  }

  return candidate_rows.map((row) => {
    if (team_id && row.source_team_id && row.source_team_id !== team_id) {
      return { row, visible: false, reason: "cross-workspace row" };
    }

    if ((row.source_user_ids ?? []).some((id) => departed.has(id))) {
      return {
        row,
        visible: false,
        reason: "author/participant no longer in workspace",
      };
    }

    switch (row.conversation_type) {
      case "channel_public":
        return askerInTenant
          ? { row, visible: true, reason: "channel_public + tenant_user" }
          : { row, visible: false, reason: "asker not in tenant" };
      case "channel_private":
        if (!askerInTenant) return { row, visible: false, reason: "asker not in tenant" };
        if (!askerSlackUserId)
          return { row, visible: false, reason: "asker not linked to Slack" };
        return askerChannelMembership.has(row.channel_id)
          ? { row, visible: true, reason: "channel_private + slack_channel_member" }
          : { row, visible: false, reason: "asker not in channel" };
      case "dm":
      case "mpim":
        if (!askerSlackUserId)
          return { row, visible: false, reason: "asker not linked to Slack" };
        return (row.source_user_ids ?? []).includes(askerSlackUserId)
          ? { row, visible: true, reason: `${row.conversation_type} + participant` }
          : { row, visible: false, reason: "asker not a participant" };
      default:
        return { row, visible: false, reason: "unknown_conversation_type" };
    }
  });
}

async function resolveAskerSlackUserId(
  sb: ReturnType<typeof serviceClient>,
  tenant_id: string,
  asker_user_id: string,
): Promise<string | null> {
  const { data: userRow } = await sb.auth.admin.getUserById(asker_user_id);
  const email = userRow?.user?.email ?? null;
  if (!email) return null;

  const { data: members } = await sb
    .from("team_members")
    .select("id")
    .eq("tenant_id", tenant_id)
    .ilike("primary_email", email)
    .eq("status", "active")
    .limit(1)
    .maybeSingle<{ id: string }>();
  if (!members?.id) return null;

  const { data: ident } = await sb
    .from("team_member_identities")
    .select("external_id")
    .eq("tenant_id", tenant_id)
    .eq("member_id", members.id)
    .eq("provider", "slack")
    .limit(1)
    .maybeSingle<{ external_id: string }>();
  return ident?.external_id ?? null;
}

async function isAskerInTenant(
  sb: ReturnType<typeof serviceClient>,
  tenant_id: string,
  asker_user_id: string,
): Promise<boolean> {
  const { data, error } = await sb
    .from("tenant_users")
    .select("user_id")
    .eq("tenant_id", tenant_id)
    .eq("user_id", asker_user_id)
    .limit(1)
    .maybeSingle();
  if (error) return false;
  return !!data;
}
