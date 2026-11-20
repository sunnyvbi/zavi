
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { slackFetchWithBackoff } from "@/services/tools/slack/_retry";

const PER_TENANT_CHANNEL_CAP = parseInt(
  process.env.SLACK_MEMBERS_REFRESH_MAX_CHANNELS_PER_TENANT ?? "200",
  10,
);
const PER_TENANT_MEMBER_CAP = parseInt(
  process.env.SLACK_MEMBERS_REFRESH_MAX_MEMBERS_PER_CHANNEL ?? "1000",
  10,
);

type ConnectorRow = { tenant_id: string };
type PrivateChannelRow = { channel_id: string; team_id: string };

export const slackChannelMembersRefreshSchedulerFn = inngest.createFunction(
  { id: "slack-channel-members-refresh-scheduler", concurrency: 1, retries: 1 },
  { cron: "0 6 * * *" },
  async ({ step, logger }) => {
    const tenant_ids = await step.run("list-slack-tenants", async () => {
      const sb = serviceClient();
      const { data, error } = await sb
        .from("connector_metadata")
        .select("tenant_id")
        .eq("slug", "slack");
      if (error) throw new Error(`connector_metadata read: ${error.message}`);
      const rows = (data as ConnectorRow[] | null) ?? [];
      return Array.from(new Set(rows.map((r) => r.tenant_id))).filter(Boolean);
    });

    let queued = 0;
    const dispatched_at = new Date().toISOString();
    for (const tenant_id of tenant_ids) {
      try {
        await step.sendEvent("slack-channel-members-refresh-tenant", {
          name: "slack.channel.members.refresh.tenant.requested",
          data: { tenant_id, dispatched_at },
        });
        queued += 1;
      } catch (err) {
        logger.warn(
          `slack-channel-members-refresh-scheduler: enqueue failed for ${tenant_id}: ${(err as Error)?.message ?? err}`,
        );
      }
    }
    logger.info(
      `slack-channel-members-refresh-scheduler: scanned=${tenant_ids.length} queued=${queued}`,
    );
    return { scanned: tenant_ids.length, queued };
  },
);

export const slackChannelMembersRefreshTenantFn = inngest.createFunction(
  {
    id: "slack-channel-members-refresh-tenant",
    concurrency: 4,
    retries: 2,
    throttle: { limit: 18, period: "1m" },
  },
  { event: "slack.channel.members.refresh.tenant.requested" },
  async ({ event, step, logger }) => {
    const claimedTenantId = (event.data as { tenant_id?: string } | undefined)
      ?.tenant_id;
    if (!claimedTenantId || typeof claimedTenantId !== "string") {
      logger.warn("slack-channel-members-refresh-tenant: missing tenant_id");
      return { status: "skip", reason: "missing_tenant_id" };
    }

    const sb = serviceClient();

    const connRes = await step.run("C8-reverified-read-connector-row", async () => {
      const { data, error } = await sb
        .from("connector_metadata")
        .select("tenant_id")
        .eq("tenant_id", claimedTenantId)
        .eq("slug", "slack")
        .maybeSingle();
      if (error) throw new Error(`connector_metadata read: ${error.message}`);
      return (data as ConnectorRow | null) ?? null;
    });
    if (!connRes) {
      logger.warn(
        `slack-channel-members-refresh-tenant: no slack connector for ${claimedTenantId}; skipping`,
      );
      return { outcome: "no_connector_row" };
    }
    const tenant_id = connRes.tenant_id;

    const channels = await step.run("read-private-channels", async () => {
      const { data, error } = await sb
        .from("slack_channels")
        .select("channel_id, team_id")
        .eq("tenant_id", tenant_id)
        .eq("is_private", true)
        .limit(PER_TENANT_CHANNEL_CAP);
      if (error) throw new Error(`slack_channels read: ${error.message}`);
      return (data as PrivateChannelRow[] | null) ?? [];
    });

    let channelsRefreshed = 0;
    let membersUpserted = 0;
    let channelErrors = 0;

    for (const ch of channels) {
      const result = await step.run(`refresh-${ch.team_id}-${ch.channel_id}`, async () => {
        let cursor: string | undefined = undefined;
        const memberIds: string[] = [];
        for (let page = 0; page < 10; page += 1) {
          const params: Record<string, string | number | boolean | undefined> = {
            channel: ch.channel_id,
            limit: 200,
          };
          if (cursor) params.cursor = cursor;
          const res = await slackFetchWithBackoff<{
            ok?: boolean;
            members?: string[];
            response_metadata?: { next_cursor?: string };
          }>(tenant_id, "conversations.members", params, 3, ch.team_id);
          if (!res.ok) {
            return { ok: false, error: res.error ?? "unknown", count: 0 };
          }
          for (const m of res.data?.members ?? []) memberIds.push(m);
          if (memberIds.length >= PER_TENANT_MEMBER_CAP) break;
          const next = res.data?.response_metadata?.next_cursor;
          if (!next) break;
          cursor = next;
        }

        if (memberIds.length === 0) return { ok: true, count: 0 };

        const now = new Date().toISOString();
        const rows = memberIds.slice(0, PER_TENANT_MEMBER_CAP).map((sid) => ({
          tenant_id,
          team_id: ch.team_id,
          channel_id: ch.channel_id,
          slack_user_id: sid,
          refreshed_at: now,
        }));
        const { error: upErr } = await sb
          .from("slack_channel_members")
          .upsert(rows, { onConflict: "tenant_id,team_id,channel_id,slack_user_id" });
        if (upErr) return { ok: false, error: upErr.message, count: 0 };
        return { ok: true, count: rows.length };
      });

      if (result.ok) {
        channelsRefreshed += 1;
        membersUpserted += result.count;
      } else {
        channelErrors += 1;
        logger.warn(
          `slack-channel-members-refresh-tenant ${ch.channel_id}: ${(result as { error?: string }).error}`,
        );
      }
    }

    logger.info(
      `slack-channel-members-refresh-tenant tenant=${tenant_id} channels=${channels.length} refreshed=${channelsRefreshed} members_upserted=${membersUpserted} errors=${channelErrors}`,
    );
    return {
      tenant_id,
      channels_scanned: channels.length,
      channels_refreshed: channelsRefreshed,
      members_upserted: membersUpserted,
      channel_errors: channelErrors,
    };
  },
);
