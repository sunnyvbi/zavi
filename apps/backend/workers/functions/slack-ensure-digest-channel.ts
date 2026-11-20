
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { slackFetch } from "@/services/tools/slack/_client";
import { ExpectedToolError } from "@/services/tools/types";
import { DIGEST_CHANNEL_NAMES } from "@/services/slack/resolve-zavi-channel";

export const DIGEST_CHANNEL_NAME = DIGEST_CHANNEL_NAMES[0];

function slackErrorCode(e: unknown): string | null {
  if (e instanceof ExpectedToolError) {
    const code = e.meta?.slack_error;
    return typeof code === "string" ? code : null;
  }
  return null;
}

type EnsureOutcome =
  | "created"
  | "already_exists"
  | "missing_scope"
  | "slack_not_connected"
  | "error";

export async function ensureDigestChannel(
  tenant_id: string,
  team_id: string,
  installerUserId: string | null,
): Promise<EnsureOutcome> {
  let existingId: string | null = null;
  try {
    const list = await slackFetch<{
      channels?: Array<{ id?: string; name?: string; is_archived?: boolean }>;
    }>(tenant_id, "conversations.list", { exclude_archived: true, limit: 1000 }, team_id);
    existingId =
      (list.channels ?? []).find(
        (c) => c.name === DIGEST_CHANNEL_NAME && !c.is_archived && !!c.id,
      )?.id ?? null;
  } catch (e) {
    const code = slackErrorCode(e);
    if (code === "missing_scope") return "missing_scope";
    if (code === "not_authed" || code === "invalid_auth" || code === "account_inactive") {
      return "slack_not_connected";
    }
    console.warn(
      `[ensure-digest-channel] list failed for ${tenant_id}: ${(e as Error).message}`,
    );
    return "error";
  }

  if (existingId) {
    await inviteInstaller(tenant_id, team_id, existingId, installerUserId);
    return "already_exists";
  }

  let channelId: string | null = null;
  try {
    const created = await slackFetch<{ channel?: { id?: string } }>(
      tenant_id,
      "conversations.create",
      { name: DIGEST_CHANNEL_NAME, is_private: false },
      team_id,
    );
    channelId = created.channel?.id ?? null;
  } catch (e) {
    const code = slackErrorCode(e);
    if (code === "missing_scope") return "missing_scope";
    if (code === "name_taken") {
      try {
        const list = await slackFetch<{
          channels?: Array<{ id?: string; name?: string; is_archived?: boolean }>;
        }>(tenant_id, "conversations.list", { exclude_archived: true, limit: 1000 }, team_id);
        const id =
          (list.channels ?? []).find((c) => c.name === DIGEST_CHANNEL_NAME && !!c.id)?.id ??
          null;
        if (id) await inviteInstaller(tenant_id, team_id, id, installerUserId);
      } catch {
      }
      return "already_exists";
    }
    console.warn(
      `[ensure-digest-channel] create failed for ${tenant_id}: ${(e as Error).message}`,
    );
    return "error";
  }

  if (channelId) {
    await inviteInstaller(tenant_id, team_id, channelId, installerUserId);
  }
  return "created";
}

async function inviteInstaller(
  tenant_id: string,
  team_id: string,
  channelId: string,
  installerUserId: string | null,
): Promise<void> {
  if (!installerUserId) return;
  try {
    await slackFetch(
      tenant_id,
      "conversations.invite",
      { channel: channelId, users: installerUserId },
      team_id,
    );
  } catch (e) {
    const code = slackErrorCode(e);
    if (code === "already_in_channel" || code === "cant_invite_self") return;
    console.warn(
      `[ensure-digest-channel] invite failed for ${tenant_id} ch=${channelId}: ${(e as Error).message}`,
    );
  }
}

export const slackEnsureDigestChannelFn = inngest.createFunction(
  { id: "slack-ensure-digest-channel", concurrency: 4, retries: 2 },
  { event: "slack.workspace.intro" },
  async ({ event, step, logger }) => {
    const claimedTenantId = event.data.tenant_id as string;
    const claimedTeamId = event.data.team_id as string;
    const installerUserId =
      (event.data.installer_slack_user_id as string | null) || null;
    const sb = serviceClient();

    const validated = await step.run("C8-reverified-validate-workspace", async () => {
      const { data, error } = await sb
        .from("slack_workspaces")
        .select("tenant_id, team_id")
        .eq("tenant_id", claimedTenantId)
        .eq("team_id", claimedTeamId)
        .maybeSingle<{ tenant_id: string; team_id: string }>();
      if (error) throw new Error(`workspace validate: ${error.message}`);
      return data ?? null;
    });
    if (!validated) {
      logger.info(
        `slack-ensure-digest-channel: no workspace row for ${claimedTenantId}/${claimedTeamId}; skipping`,
      );
      return { outcome: "no_workspace_row" };
    }
    const tenant_id = validated.tenant_id;
    const team_id = validated.team_id;

    const outcome = await step.run("ensure-digest-channel", async () => {
      return ensureDigestChannel(tenant_id, team_id, installerUserId);
    });

    await step.run("audit-ensure-digest-channel", async () => {
      await sb.from("staff_audit_log").insert({
        actor_user_id: "00000000-0000-0000-0000-000000000000",
        actor_email: "system@zavi",
        action: "slack_digest_channel_ensured",
        target_table: "slack_workspaces",
        target_id: null,
        tenant_id,
        meta: { outcome, channel: DIGEST_CHANNEL_NAME, had_installer: !!installerUserId },
      });
    });

    return { outcome, tenant_id };
  },
);
