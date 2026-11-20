
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { slackFetch } from "@/services/tools/slack/_client";
import { slackFetchWithBackoff } from "@/services/tools/slack/_retry";
import { ExpectedToolError } from "@/services/tools/types";

const MAX_JOINS_PER_RUN = 50;
const CONVERSATIONS_LIST_PAGE_SIZE = 200;

type SlackText = { value?: string };
type SlackListChannel = {
  id?: string;
  name?: string;
  is_private?: boolean;
  is_archived?: boolean;
  is_member?: boolean;
  num_members?: number;
  purpose?: SlackText;
  topic?: SlackText;
};

type ListResp = {
  channels?: SlackListChannel[];
  response_metadata?: { next_cursor?: string };
};

type ConnectorRow = {
  tenant_id: string;
  scopes: string[] | null;
};

type PendingJoinRow = {
  channel_id: string;
  operator_selected_by: string | null;
};

export const slackAutoJoinFn = inngest.createFunction(
  { id: "slack-auto-join", concurrency: 4, retries: 2 },
  { event: "slack.oauth.completed" },
  async ({ event, step, logger }) => {
    const claimedTenantId = event.data.tenant_id;
    const claimedTeamId = event.data.team_id;
    const sb = serviceClient();

    const connRes = await step.run("C8-reverified-read-connector-row", async () => {
      const { data, error } = await sb
        .from("connector_metadata")
        .select("tenant_id, scopes")
        .eq("tenant_id", claimedTenantId)
        .eq("slug", "slack")
        .maybeSingle();
      if (error) throw new Error(`connector_metadata read: ${error.message}`);
      return (data as ConnectorRow | null) ?? null;
    });
    if (!connRes) {
      logger.warn(
        `slack-auto-join: no slack connector_metadata for tenant ${claimedTenantId}; skipping`,
      );
      return { outcome: "no_connector_row" };
    }
    const tenant_id = connRes.tenant_id;
    const grantedScopes = new Set(connRes.scopes ?? []);

    const team_id = await step.run("C8-reverified-resolve-workspace-team", async () => {
      if (claimedTeamId) {
        const { data, error } = await sb
          .from("slack_workspaces")
          .select("team_id")
          .eq("tenant_id", tenant_id)
          .eq("team_id", claimedTeamId)
          .maybeSingle();
        if (error) throw new Error(`slack_workspaces hint read: ${error.message}`);
        if ((data as { team_id?: string } | null)?.team_id) return claimedTeamId;
      }
      const { data, error } = await sb
        .from("slack_workspaces")
        .select("team_id, is_primary, connected_at")
        .eq("tenant_id", tenant_id)
        .order("is_primary", { ascending: false })
        .order("connected_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`slack_workspaces fallback read: ${error.message}`);
      return (data as { team_id?: string } | null)?.team_id ?? null;
    });
    if (!team_id) {
      logger.warn(
        `slack-auto-join: no slack_workspaces row for tenant ${tenant_id}; skipping`,
      );
      return { outcome: "no_workspace_row" };
    }

    if (!grantedScopes.has("channels:read")) {
      logger.warn(
        `slack-auto-join: tenant ${tenant_id} missing channels:read; skipping discovery`,
      );
      return { outcome: "missing_channels_read" };
    }

    const discovered: string[] = [];
    let cursor: string | undefined = undefined;
    let page = 0;
    do {
      const pageData = await step.run(`list-channels-page-${page}`, async () =>
        slackListChannelsPage(tenant_id, cursor, team_id),
      );
      const rows = (pageData.channels ?? []).map((c) => ({
        tenant_id,
        team_id,
        channel_id: c.id ?? "",
        name: c.name ?? "",
        purpose: c.purpose?.value ?? "",
        topic: c.topic?.value ?? "",
        is_private: !!c.is_private,
        member_count:
          typeof c.num_members === "number" ? c.num_members : 0,
        updated_at: new Date().toISOString(),
      }));
      if (rows.length > 0) {
        const { error: upsertErr } = await sb
          .from("slack_channels")
          .upsert(rows, {
            onConflict: "tenant_id,team_id,channel_id",
            ignoreDuplicates: false,
          });
        if (upsertErr) {
          throw new Error(`slack_channels upsert: ${upsertErr.message}`);
        }
        discovered.push(...rows.map((r) => r.channel_id).filter(Boolean));
      }
      cursor = pageData.response_metadata?.next_cursor || undefined;
      page += 1;
    } while (cursor && page < 20);

    await step.run("audit-discovery", async () => {
      await sb.from("staff_audit_log").insert({
        actor_user_id: "00000000-0000-0000-0000-000000000000",
        actor_email: "system@zavi",
        action: "slack_channel_discovered",
        target_table: "slack_channels",
        target_id: null,
        tenant_id,
        meta: { count: discovered.length, scopes_version: event.data.scopes_version },
      });
    });

    const pendingPick = await step.run("read-pending-picks", async () => {
      const { data, error } = await sb
        .from("slack_channels")
        .select("channel_id, operator_selected_by")
        .eq("tenant_id", tenant_id)
        .eq("team_id", team_id)
        .eq("join_policy_status", "pending")
        .order("operator_selected_at", { ascending: true })
        .limit(MAX_JOINS_PER_RUN);
      if (error) throw new Error(`pending-picks read: ${error.message}`);
      return (data as PendingJoinRow[] | null) ?? [];
    });

    const joinResults: Array<{ channel_id: string; ok: boolean; error?: string }> =
      [];
    for (const row of pendingPick) {
      const channel_id = row.channel_id;
      const result = await step.run(`join-${channel_id}`, async () => {
        try {
          await slackJoinWithBackoff(tenant_id, channel_id, team_id);
          return { ok: true as const };
        } catch (e) {
          return { ok: false as const, error: (e as Error).message };
        }
      });
      await step.run(`stamp-${channel_id}`, async () => {
        const now = new Date().toISOString();
        await sb
          .from("slack_channels")
          .update({
            join_policy_status: result.ok ? "joined" : "failed",
            joined_at: result.ok ? now : null,
            skip_reason: result.ok ? null : result.error ?? "unknown",
            updated_at: now,
          })
          .eq("tenant_id", tenant_id)
          .eq("team_id", team_id)
          .eq("channel_id", channel_id);
        await sb.from("staff_audit_log").insert({
          actor_user_id:
            row.operator_selected_by ?? "00000000-0000-0000-0000-000000000000",
          actor_email: "system@zavi",
          action: result.ok ? "slack_auto_join" : "slack_auto_join_failed",
          target_table: "slack_channels",
          target_id: channel_id,
          tenant_id,
          meta: result.ok
            ? { channel_id }
            : { channel_id, error: result.error ?? "unknown" },
        });
      });
      joinResults.push({ channel_id, ...result });
    }

    return {
      outcome: "ok",
      tenant_id,
      discovered_count: discovered.length,
      join_attempted: joinResults.length,
      join_succeeded: joinResults.filter((r) => r.ok).length,
    };
  },
);

export async function slackListChannelsPage(
  tenant_id: string,
  cursor: string | undefined,
  team_id?: string,
): Promise<ListResp> {
  return slackFetch<ListResp>(
    tenant_id,
    "conversations.list",
    {
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: CONVERSATIONS_LIST_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    },
    team_id,
  );
}

export async function slackJoinWithBackoff(
  tenant_id: string,
  channel_id: string,
  team_id?: string,
  maxRetries = 3,
): Promise<void> {
  const result = await slackFetchWithBackoff(
    tenant_id,
    "conversations.join",
    { channel: channel_id },
    maxRetries,
    team_id,
  );
  if (!result.ok) {
    throw new ExpectedToolError(
      "slack_api_error",
      `conversations.join failed: ${result.error ?? "unknown"}`,
      { slack_method: "conversations.join", slack_error: result.error ?? "unknown" },
    );
  }
}
