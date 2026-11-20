import { tenantRpc, asTenantId } from "@/services/tenant-client";
import { sendMentionAlertEmail, type MentionAlertItem } from "@/email/sendMentionAlert";
import {
  collectPendingMentions,
  MENTION_PROVIDERS,
  type MentionProvider,
  type PendingMention,
} from "./mention-providers";

export const MAX_MENTIONS_PER_EMAIL = 5;

export type MentionAlertSendOutcome =
  | { status: "skipped"; reason: string }
  | { status: "sent"; count: number; mentions: number; channels: string[] };

export type MentionAlertDeps = {
  providers?: readonly MentionProvider[];
  sendEmail?: typeof sendMentionAlertEmail;
  now?: () => Date;
};

function labelOf(providers: readonly MentionProvider[], channel: string): string {
  return providers.find((p) => p.channel === channel)?.label ?? channel;
}

function toItems(
  mentions: PendingMention[],
  providers: readonly MentionProvider[],
): MentionAlertItem[] {
  return mentions.map((m) => ({
    channelLabel: labelOf(providers, m.channel),
    title: m.title,
    excerpt: m.excerpt,
    url: m.url,
    context: m.context,
    sentiment: m.sentiment,
  }));
}

export async function sendTenantMentionAlert(
  tenant: { id: string; display_name?: string | null },
  deps: MentionAlertDeps = {},
): Promise<MentionAlertSendOutcome> {
  const providers = deps.providers ?? MENTION_PROVIDERS;
  const sendEmail = deps.sendEmail ?? sendMentionAlertEmail;
  const now = deps.now ?? (() => new Date());
  const tenant_id = tenant.id;
  const tid = asTenantId(tenant_id);

  let collected: Awaited<ReturnType<typeof collectPendingMentions>>;
  try {
    collected = await collectPendingMentions(tenant_id, providers);
  } catch (e) {
    return { status: "skipped", reason: `collect_threw: ${(e as Error).message}` };
  }
  for (const f of collected.failures) {
    console.warn(`[mention-alert] tenant=${tenant_id} channel=${f.channel} read failed: ${f.error}`);
  }
  const pending = collected.mentions.slice(0, MAX_MENTIONS_PER_EMAIL);
  if (pending.length === 0) {
    return { status: "skipped", reason: "no_fresh_mentions" };
  }

  const send_day = now().toISOString().slice(0, 10);
  const { data: claimRows, error: claimErr } = await tenantRpc(tid, "claim_mention_alert_send", {
    p_send_day: send_day,
  });
  if (claimErr) {
    const msg = claimErr.message || "";
    if (msg.includes("cooldown")) return { status: "skipped", reason: "cooldown" };
    if (msg.includes("already_finalized")) {
      return { status: "skipped", reason: "already_finalized_today" };
    }
    return { status: "skipped", reason: `claim failed: ${msg}` };
  }
  const claim = Array.isArray(claimRows)
    ? (claimRows[0] as { id: string; is_fresh: boolean } | undefined)
    : (claimRows as { id: string; is_fresh: boolean } | null);
  if (!claim) return { status: "skipped", reason: "claim_no_row" };
  if (!claim.is_fresh) return { status: "skipped", reason: "reclaim_in_flight" };

  let outcome: Awaited<ReturnType<typeof sendMentionAlertEmail>>;
  try {
    outcome = await sendEmail({ tenant_id, items: toItems(pending, providers) });
  } catch (e) {
    await markFailed(tid, tenant_id, claim.id);
    return { status: "skipped", reason: `send_threw: ${(e as Error).message}` };
  }

  if (!outcome.sent) {
    await markFailed(tid, tenant_id, claim.id);
    return { status: "skipped", reason: outcome.reason };
  }

  const finalize = () =>
    tenantRpc(tid, "mark_mention_alert_sent", {
      p_id: claim.id,
      p_status: "sent",
      p_mentions: pending.map((m) => ({ channel: m.channel, mention_key: m.key })),
    });
  let { error: markErr } = await finalize();
  if (markErr) ({ error: markErr } = await finalize());
  if (markErr) {
    console.error(
      `[mention-alert] tenant=${tenant_id} finalize FAILED TWICE after send: ${markErr.message}. These mentions are unrecorded, so tomorrow's run will email them again`,
    );
  }

  return {
    status: "sent",
    count: outcome.count,
    mentions: pending.length,
    channels: [...new Set(pending.map((m) => m.channel))],
  };
}

async function markFailed(
  tid: ReturnType<typeof asTenantId>,
  tenant_id: string,
  deliveryId: string,
): Promise<void> {
  const { error } = await tenantRpc(tid, "mark_mention_alert_sent", {
    p_id: deliveryId,
    p_status: "failed",
  });
  if (error) {
    console.error(
      `[mention-alert] tenant=${tenant_id} mark_failed errored: ${error.message} (delivery stays 'claimed')`,
    );
  }
}
