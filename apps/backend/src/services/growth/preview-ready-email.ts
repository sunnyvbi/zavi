
import { CHANNELS } from "@zavi/shared";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { claimTenantFlag, setTenantSetting } from "@/services/settings";
import { isDefiniteSendRejection } from "@/services/onboarding-emails/send-errors";
import { READY_EMAIL_CLAIM_KEY } from "./ready-email-claim";
import { PREVIEW_RUN_KEY_PREFIX, TIER_DISPLAY_NAME, TIER_PRICE_USD, type PaidTier } from "@/services/billing/tiers";
import { planIncludesChannel } from "./preview-plan";
import { sendPreviewReadyEmail } from "@/email/sendAuthEmail";
import { channelUrl } from "@/services/web-base";
import { OPEN_CHANNEL_ACTIONS_VIEW } from "@/services/channels/open-actions-count";

const CLAIMER = "system:preview-ready-email";
const TERMINAL = new Set(["success", "parse_failed", "error", "failed", "cancelled", "dispatch_error"]);

export type PreviewEmailOutcome =
  | { sent: true; total: number }
  | { sent: false; reason: string };

export async function maybeSendPreviewReadyEmail(tenant_id: string): Promise<PreviewEmailOutcome> {
  const db = tenantClient(asTenantId(tenant_id));
  const { data: runs, error } = await db
    .from("agent_runs")
    .select("id, agent_slug, status, preview_action_types")
    .like("cron_dedupe_key", `${PREVIEW_RUN_KEY_PREFIX}${tenant_id}:%`)
    .limit(50);
  if (error) return { sent: false, reason: "runs_unreadable" };
  const all = (runs ?? []) as Array<{ id: string; agent_slug: string; status: string; preview_action_types: string[] | null }>;
  if (all.length === 0) return { sent: false, reason: "no_preview_runs" };
  if (all.some((r) => !TERMINAL.has(r.status))) return { sent: false, reason: "still_running" };
  for (const slug of new Set(all.map((r) => r.agent_slug))) {
    if (await planIncludesChannel(tenant_id, slug)) return { sent: false, reason: "nothing_locked" };
  }
  const perChannel = new Map<string, number>();
  const add = (slug: string, n: number) => { if (n > 0) perChannel.set(slug, (perChannel.get(slug) ?? 0) + n); };
  for (const r of all) add(r.agent_slug, (r.preview_action_types ?? []).length);
  let realCards = 0;
  const slugOf = new Map(all.filter((r) => r.preview_action_types == null).map((r) => [r.id, r.agent_slug]));
  if (slugOf.size > 0) {
    const { data: open, error: openErr } = await db.from(OPEN_CHANNEL_ACTIONS_VIEW).select("run_id").in("run_id", [...slugOf.keys()]).limit(500);
    if (openErr) return { sent: false, reason: "actions_unreadable" };
    for (const a of (open ?? []) as Array<{ run_id: string | null }>) {
      const slug = a.run_id ? slugOf.get(a.run_id) : undefined;
      if (slug) {
        add(slug, 1);
        realCards += 1;
      }
    }
  }
  const total = [...perChannel.values()].reduce((n, c) => n + c, 0);
  if (total === 0) return { sent: false, reason: "nothing_found" };

  const slugs = new Set(perChannel.keys());
  const top = [...perChannel.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  const channelNames = CHANNELS.filter((c) => slugs.has(c.slug)).map((c) => c.name);
  const paid: PaidTier = "starter";

  const { data: tenant } = await db.from("tenants").select("name").eq("id", tenant_id).maybeSingle();
  const displayName = ((tenant as { name?: string | null } | null)?.name ?? "").trim() || "your company";

  if (!(await claimTenantFlag(tenant_id, READY_EMAIL_CLAIM_KEY, CLAIMER))) return { sent: false, reason: "already_sent" };
  const release = () => setTenantSetting(tenant_id, READY_EMAIL_CLAIM_KEY, null, CLAIMER);
  let result: { sent: boolean };
  try {
    result = await sendPreviewReadyEmail({
      tenant_id,
      displayName,
      total,
      channelNames,
      planName: TIER_DISPLAY_NAME[paid],
      planUsd: TIER_PRICE_USD[paid],
      channelsUrl: channelUrl(top),
      ...(realCards > 0 ? { realCards } : {}),
    });
  } catch (e) {
    if (isDefiniteSendRejection(e)) await release();
    throw e;
  }
  if (!result.sent) {
    await release();
    return { sent: false, reason: "no_owner_email" };
  }
  return { sent: true, total };
}
