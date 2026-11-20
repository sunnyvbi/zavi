
import type { SupabaseClient } from "@supabase/supabase-js";
import { slackFetch } from "@/services/tools/slack/_client";

export const USERS_INFO_TIMEOUT_MS = 800;

export type SlackUserInfo = {
  id?: string;
  team_id?: string;
  name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  is_app_user?: boolean;
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
  is_stranger?: boolean;
  real_name?: string;
  profile?: { email?: string; real_name?: string; display_name?: string };
};

export type UsersInfoFn = (args: {
  tenant_id: string;
  team_id: string;
  slack_user_id: string;
}) => Promise<SlackUserInfo | null>;

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

export async function resolveSlackApprover(
  svc: SupabaseClient,
  args: { tenant_id: string; team_id: string | null | undefined; slack_user_id: string | null | undefined },
): Promise<string | null> {
  if (!nonEmpty(args.tenant_id) || !nonEmpty(args.team_id) || !nonEmpty(args.slack_user_id)) return null;
  try {
    const { data, error } = await svc.rpc("resolve_slack_approver", {
      p_tenant_id: args.tenant_id,
      p_team_id: args.team_id,
      p_slack_user_id: args.slack_user_id,
    });
    if (error) return null;
    return typeof data === "string" && data ? data : null;
  } catch {
    return null;
  }
}

function displayNameOf(user: SlackUserInfo): string | null {
  return user.profile?.real_name?.trim() || user.real_name?.trim() || user.profile?.display_name?.trim() || null;
}

export function linkRefusal(user: SlackUserInfo | null, team_id: string, slack_user_id: string): string | null {
  if (!user) return "no_user";
  if (user.id !== slack_user_id) return "id_mismatch";
  if (user.id === "USLACKBOT") return "slackbot";
  if (user.deleted === true) return "deleted";
  if (user.is_bot === true || user.is_app_user === true) return "bot";
  if (user.is_restricted === true || user.is_ultra_restricted === true) return "guest";
  if (user.is_stranger === true) return "stranger";
  if (user.team_id !== team_id) return "team_mismatch";
  if (!nonEmpty(user.profile?.email)) return "no_email";
  return null;
}

export async function slackUsersInfo(
  { tenant_id, team_id, slack_user_id }: Parameters<UsersInfoFn>[0],
  timeoutMs: number = USERS_INFO_TIMEOUT_MS,
): Promise<SlackUserInfo | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((r) => {
    timer = setTimeout(() => r(null), timeoutMs);
  });
  try {
    const call = slackFetch<{ user?: SlackUserInfo }>(
      tenant_id,
      "users.info",
      { user: slack_user_id },
      team_id,
      { noLegacyFallback: true },
    )
      .then((r) => r.user ?? null)
      .catch(() => null);
    return await Promise.race([call, timeout]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function linkSlackMemberOnMessage(
  svc: SupabaseClient,
  args: { tenant_id: string; team_id: string | null | undefined; slack_user_id: string | null | undefined },
  usersInfo: UsersInfoFn = (a) => slackUsersInfo(a),
): Promise<string | null> {
  const { tenant_id, team_id, slack_user_id } = args;
  if (!nonEmpty(tenant_id) || !nonEmpty(team_id) || !nonEmpty(slack_user_id)) return null;
  try {
    const user = await usersInfo({ tenant_id, team_id, slack_user_id });
    if (linkRefusal(user, team_id, slack_user_id) !== null) return null;
    const displayName = displayNameOf(user!);
    const { data, error } = await svc.rpc("link_slack_identity_if_member", {
      p_tenant_id: tenant_id,
      p_team_id: team_id,
      p_slack_user_id: slack_user_id,
      p_email: user!.profile!.email!.trim(),
      p_display_name: displayName,
    });
    if (error) return null;
    return typeof data === "string" && data ? data : null;
  } catch {
    return null;
  }
}

export async function linkSlackInstaller(
  svc: SupabaseClient,
  args: { tenant_id: string; team_id: string; slack_user_id: string | null | undefined; user_id: string },
  usersInfo: UsersInfoFn = (a) => slackUsersInfo(a),
): Promise<string | null> {
  const { tenant_id, team_id, slack_user_id, user_id } = args;
  if (!nonEmpty(tenant_id) || !nonEmpty(team_id) || !nonEmpty(slack_user_id) || !nonEmpty(user_id)) return null;
  try {
    const user = await usersInfo({ tenant_id, team_id, slack_user_id });
    if (linkRefusal(user, team_id, slack_user_id) !== null) return null;
    const { data, error } = await svc.rpc("link_slack_installer_identity", {
      p_tenant_id: tenant_id,
      p_team_id: team_id,
      p_slack_user_id: slack_user_id,
      p_user_id: user_id,
      p_email: user!.profile!.email!.trim(),
      p_display_name: displayNameOf(user!),
    });
    if (error) return null;
    return typeof data === "string" && data ? data : null;
  } catch {
    return null;
  }
}
