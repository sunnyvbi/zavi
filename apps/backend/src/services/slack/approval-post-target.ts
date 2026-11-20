
import { serviceClient } from "@/services/supabase";
import { slackFetch } from "@/services/tools/slack/_client";
import { resolveZaviChannel } from "@/services/slack/resolve-zavi-channel";

export type ApprovalPostTarget = { channel: string; team_id?: string };

export const SLACK_APPROVAL_CARD_SURFACE = "slack_approval_card";

export async function recordApprovalCardRef(args: {
  decision_id: string;
  tenant_id: string;
  channel_id: string;
  ts: string;
  team_id?: string;
  card_text?: string;
}): Promise<void> {
  if (!args.ts || !args.channel_id) return;
  try {
    await serviceClient().rpc("upsert_dispatch_notice_ref", {
      p_decision_id: args.decision_id,
      p_surface: SLACK_APPROVAL_CARD_SURFACE,
      p_tenant_id: args.tenant_id,
      p_slack_channel_id: args.channel_id,
      p_slack_ts: args.ts,
      p_slack_team_id: args.team_id ?? null,
      p_notice_body: args.card_text ?? null,
    });
  } catch (e) {
    console.warn(
      `[approval-post-target] card-ref upsert failed for decision ${args.decision_id}: ${
        (e as Error).message
      }`,
    );
  }
}

export async function getApprovalCardRef(
  decision_id: string,
  tenant_id: string,
): Promise<{ channel_id: string; ts: string; team_id?: string } | null> {
  try {
    const { data } = await serviceClient()
      .from("dispatch_notice_refs")
      .select("slack_channel_id, slack_ts, slack_team_id")
      .eq("decision_id", decision_id)
      .eq("surface", SLACK_APPROVAL_CARD_SURFACE)
      .eq("tenant_id", tenant_id)
      .maybeSingle();
    const row = data as
      | { slack_channel_id?: string | null; slack_ts?: string | null; slack_team_id?: string | null }
      | null;
    if (!row?.slack_channel_id || !row?.slack_ts) return null;
    return {
      channel_id: row.slack_channel_id,
      ts: row.slack_ts,
      team_id: row.slack_team_id ?? undefined,
    };
  } catch (e) {
    console.warn(
      `[approval-post-target] card-ref read failed for decision ${decision_id}: ${
        (e as Error).message
      }`,
    );
    return null;
  }
}

export async function updateApprovalCard(args: {
  tenant_id: string;
  ref: { channel_id: string; ts: string; team_id?: string };
  text: string;
  blocks?: unknown[];
}): Promise<boolean> {
  try {
    const r = (await slackFetch(
      args.tenant_id,
      "chat.update",
      {
        channel: args.ref.channel_id,
        ts: args.ref.ts,
        text: args.text,
        ...(args.blocks ? { blocks: JSON.stringify(args.blocks) } : {}),
      },
      args.ref.team_id,
    )) as { ok?: boolean; error?: string };
    if (!r?.ok) {
      console.warn(
        `[approval-post-target] chat.update refused for ${args.ref.channel_id}/${args.ref.ts}: ${
          r?.error ?? "unknown"
        }`,
      );
      return false;
    }
    return true;
  } catch (e) {
    console.warn(
      `[approval-post-target] chat.update failed for ${args.ref.channel_id}/${args.ref.ts}: ${
        (e as Error).message
      }`,
    );
    return false;
  }
}

export async function refreshApprovalCard(args: { tenant_id: string; decision_id: string }): Promise<boolean> {
  try {
    const ref = await getApprovalCardRef(args.decision_id, args.tenant_id);
    if (!ref) return false;
    const svc = serviceClient();
    const { data: row } = await svc
      .from("decisions")
      .select("id, decision_class, body, status, home_channel")
      .eq("id", args.decision_id)
      .eq("tenant_id", args.tenant_id)
      .maybeSingle();
    const d = row as { id: string; decision_class: string | null; body: unknown; status: string; home_channel?: string | null } | null;
    if (!d || d.status !== "proposed") return false;
    const { data: cls } = d.decision_class
      ? await svc
          .from("decision_classes")
          .select("click_allowlistable, dispatch_handler")
          .eq("slug", d.decision_class)
          .maybeSingle()
      : { data: null };
    const c = cls as { click_allowlistable?: boolean | null; dispatch_handler?: string | null } | null;
    const { buildApprovalBlocks, buildApprovalFallbackText } = await import(
      "@/services/approvals/slack-approval-blocks"
    );
    const { budgetChoiceNote } = await import("@/services/approvals/budget-choice");
    const input = {
      id: d.id,
      decision_class: d.decision_class,
      body: d.body,
      click_allowlistable: c?.click_allowlistable === true,
      dispatch_handler: c?.dispatch_handler ?? null,
      home_channel: d.home_channel ?? null,
      tenant_id: args.tenant_id,
      web_only_note: await budgetChoiceNote(args.tenant_id, d),
    };
    return await updateApprovalCard({
      tenant_id: args.tenant_id,
      ref,
      text: buildApprovalFallbackText(input),
      blocks: buildApprovalBlocks(input),
    });
  } catch (e) {
    console.warn(
      `[approval-post-target] card refresh failed for decision ${args.decision_id}: ${(e as Error).message}`,
    );
    return false;
  }
}

export async function resolveApprovalPostTarget(
  tenant_id: string,
  agent_run_id: string,
): Promise<ApprovalPostTarget | null> {
  const channelId = await resolveZaviChannel(tenant_id, agent_run_id);
  if (channelId) return { channel: channelId };

  try {
    const { data, error } = await serviceClient().rpc("resolve_slack_owner_dm", {
      p_tenant_id: tenant_id,
    });
    if (error) {
      console.warn(`[approval-post-target] owner-DM resolve failed for ${tenant_id}: ${error.message}`);
      return null;
    }
    const owner = ((data ?? []) as Array<{ slack_user_id?: string; team_id?: string }>)[0];
    if (!owner?.slack_user_id) return null;

    const team_id = owner.team_id || undefined;
    const opened = (await slackFetch(
      tenant_id,
      "conversations.open",
      { users: owner.slack_user_id },
      team_id,
    )) as { ok?: boolean; channel?: { id?: string } };
    const dm = opened?.channel?.id;
    if (!dm) return null;
    return { channel: dm, team_id };
  } catch (e) {
    console.warn(`[approval-post-target] owner-DM open failed for ${tenant_id}: ${(e as Error).message}`);
    return null;
  }
}
