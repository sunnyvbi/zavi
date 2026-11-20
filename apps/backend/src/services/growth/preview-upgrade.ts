
import { randomUUID } from "node:crypto";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { PREVIEW_RUN_KEY_PREFIX, PREVIEW_DONE_KEY_PREFIX } from "@/services/billing/tiers";
import { getBoolSetting, setTenantSetting } from "@/services/settings";
import { claimResultsEmail, releaseResultsEmail } from "./results-email-claim";
import { isDefiniteSendRejection } from "@/services/onboarding-emails/send-errors";
import { OPEN_CHANNEL_ACTIONS_VIEW } from "@/services/channels/open-actions-count";
import { sendUpgradeActionsReadyEmail } from "@/email/sendAuthEmail";
import { channelUrl, webBaseUrl } from "@/services/web-base";
import { planIncludesChannel, planIncludesChannelStrict } from "./preview-plan";
import { startPreviewRun } from "./auto-first-run";
import { inngest } from "@/../workers/client";
import { logEvent } from "@/services/logging/logEvent";

export { PREVIEW_DONE_KEY_PREFIX };

const TERMINAL: ReadonlySet<string> = new Set([
  "success",
  "parse_failed",
  "error",
  "failed",
  "cancelled",
  "dispatch_error",
]);

type Deps = {
  planIncludes?: (tenant_id: string, slug: string) => Promise<boolean>;
  start?: typeof startPreviewRun;
};

export async function recordPreviewActionTypes(
  tenant_id: string,
  run_id: string,
  types: readonly string[],
): Promise<void> {
  const { error } = await tenantClient(asTenantId(tenant_id))
    .from("agent_runs")
    .update({ preview_action_types: [...types] })
    .eq("id", run_id);
  if (error) throw new Error(`preview_action_types write failed: ${error.message}`);
}

export type PreviewRow = { id: string; agent_slug: string; status: string; cron_dedupe_key: string; preview_action_types: string[] | null };

export type PreviewRerunOutcome = {
  started: string[];
  retry: string[];
  refused: string[];
};

export async function rerunDryPreviews(
  tenant_id: string,
  opts: {
    include: (row: PreviewRow) => Promise<boolean>;
    start?: typeof startPreviewRun;
    maxStarts?: number;
  },
): Promise<PreviewRerunOutcome> {
  const start = opts.start ?? startPreviewRun;
  const db = tenantClient(asTenantId(tenant_id));
  const previewKey = (slug: string) => `${PREVIEW_RUN_KEY_PREFIX}${tenant_id}:${slug}`;
  const doneKey = (slug: string) => `${PREVIEW_DONE_KEY_PREFIX}${tenant_id}:${slug}`;

  const read = async (prefix: string) => {
    const { data, error } = await db
      .from("agent_runs")
      .select("id, agent_slug, status, cron_dedupe_key, preview_action_types")
      .like("cron_dedupe_key", `${prefix}${tenant_id}:%`)
      .limit(50);
    if (error) throw new Error(`preview runs read failed: ${error.message}`);
    return (data ?? []) as PreviewRow[];
  };

  const [live, retired] = [await read(PREVIEW_RUN_KEY_PREFIX), await read(PREVIEW_DONE_KEY_PREFIX)];
  const liveSlugs = new Set(live.map((r) => r.agent_slug));
  for (const r of retired) {
    if (liveSlugs.has(r.agent_slug)) continue;
    const { error } = await db
      .from("agent_runs")
      .update({ cron_dedupe_key: previewKey(r.agent_slug) })
      .eq("id", r.id)
      .eq("cron_dedupe_key", doneKey(r.agent_slug));
    if (error) throw new Error(`preview key restore failed: ${error.message}`);
  }
  const rows = retired.some((r) => !liveSlugs.has(r.agent_slug)) ? await read(PREVIEW_RUN_KEY_PREFIX) : live;

  const out: PreviewRerunOutcome = { started: [], retry: [], refused: [] };
  for (const r of rows) {
    if (opts.maxStarts !== undefined && out.started.length >= opts.maxStarts) break;
    if (r.preview_action_types == null) continue;
    if (!TERMINAL.has(r.status)) continue;
    if (!(await opts.include(r))) continue;
    const { data: won, error: renameErr } = await db
      .from("agent_runs")
      .update({ cron_dedupe_key: doneKey(r.agent_slug) })
      .eq("id", r.id)
      .eq("cron_dedupe_key", previewKey(r.agent_slug))
      .select("id");
    if (renameErr) throw new Error(`preview key retire failed: ${renameErr.message}`);
    if (!won || won.length === 0) continue;
    const outcome = await start(tenant_id, r.agent_slug, { claimSuffix: `:upgrade:${randomUUID()}` });
    if (outcome.started) {
      out.started.push(r.agent_slug);
      continue;
    }
    const { error: restoreErr } = await db
      .from("agent_runs")
      .update({ cron_dedupe_key: previewKey(r.agent_slug) })
      .eq("id", r.id)
      .eq("cron_dedupe_key", doneKey(r.agent_slug));
    if (restoreErr) throw new Error(`preview key restore failed: ${restoreErr.message}`);
    if (outcome.permanent) {
      out.refused.push(r.agent_slug);
      await logEvent({
        level: "warn",
        source: "growth.preview-upgrade",
        code: "preview_rerun_refused",
        tenant_id,
        meta: { reject_reason: outcome.reason.slice(0, 64) },
      });
    } else {
      out.retry.push(r.agent_slug);
    }
  }
  return out;
}

export async function rerunPreviewsOnUpgrade(tenant_id: string, deps: Deps = {}): Promise<string[]> {
  const planIncludes = deps.planIncludes ?? planIncludesChannelStrict;
  const out = await rerunDryPreviews(tenant_id, {
    include: (r) => planIncludes(tenant_id, r.agent_slug),
    start: deps.start ?? startPreviewRun,
  });
  if (out.retry.length > 0) throw new Error(`preview re-run did not start: ${out.retry.join(",")}`);
  return out.started;
}

export async function requestPreviewUpgrade(tenant_id: string): Promise<boolean> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("agent_runs")
    .select("id")
    .like("cron_dedupe_key", `${PREVIEW_RUN_KEY_PREFIX}${tenant_id}:%`)
    .limit(1);
  if (error) throw new Error(`preview runs read failed: ${error.message}`);
  const run_id = ((data ?? []) as Array<{ id: string }>)[0]?.id;
  if (!run_id) return false;
  await inngest.send({ name: "growth.preview_upgrade.requested", data: { run_id, tenant_id } });
  return true;
}

export type UpgradeEmailOutcome = { sent: true; total: number } | { sent: false; reason: string };

export async function maybeSendUpgradeActionsReadyEmail(
  tenant_id: string,
  deps: Pick<Deps, "planIncludes"> = {},
): Promise<UpgradeEmailOutcome> {
  if (await getBoolSetting("upgrade_actions_ready_email_sent", tenant_id)) {
    return { sent: false, reason: "already_sent" };
  }
  const planIncludes = deps.planIncludes ?? planIncludesChannel;
  const db = tenantClient(asTenantId(tenant_id));
  const { data: runs, error } = await db
    .from("agent_runs")
    .select("id, agent_slug, status, preview_action_types")
    .like("cron_dedupe_key", `${PREVIEW_RUN_KEY_PREFIX}${tenant_id}:%`)
    .limit(50);
  if (error) return { sent: false, reason: "runs_unreadable" };
  const everyRun = (runs ?? []) as Array<{ id: string; agent_slug: string; status: string; preview_action_types: string[] | null }>;

  const included = new Map<string, boolean>();
  for (const slug of new Set(everyRun.map((r) => r.agent_slug))) included.set(slug, await planIncludes(tenant_id, slug));
  const all = everyRun.filter((r) => included.get(r.agent_slug));
  if (all.some((r) => !TERMINAL.has(r.status))) return { sent: false, reason: "still_running" };
  const real = all.filter((r) => r.preview_action_types == null);
  if (real.length === 0) return { sent: false, reason: "not_upgraded" };
  if (all.some((r) => r.preview_action_types != null)) {
    return { sent: false, reason: "reruns_pending" };
  }

  const slugOf = new Map(real.map((r) => [r.id, r.agent_slug]));
  const { data: open, error: openErr } = await db.from(OPEN_CHANNEL_ACTIONS_VIEW).select("run_id").limit(500);
  if (openErr) return { sent: false, reason: "actions_unreadable" };
  const perChannel = new Map<string, number>();
  for (const a of (open ?? []) as Array<{ run_id: string | null }>) {
    const slug = a.run_id ? slugOf.get(a.run_id) : undefined;
    if (slug) perChannel.set(slug, (perChannel.get(slug) ?? 0) + 1);
  }
  const total = [...perChannel.values()].reduce((n, c) => n + c, 0);
  const top = [...perChannel.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  const by = "system:upgrade-actions-ready-email";
  if (!(await claimResultsEmail(tenant_id, by))) return { sent: false, reason: "already_claimed" };
  const release = () => releaseResultsEmail(tenant_id, by);
  let result: { sent: boolean };
  try {
    result = await sendUpgradeActionsReadyEmail({
      tenant_id,
      total,
      channelsUrl: top ? channelUrl(top) : `${webBaseUrl()}/workspace?tab=channels`,
    });
  } catch (e) {
    if (isDefiniteSendRejection(e)) await release();
    throw e;
  }
  if (!result.sent) {
    await release();
    return { sent: false, reason: "no_owner_email" };
  }
  await setTenantSetting(tenant_id, "upgrade_actions_ready_email_sent", true, "system:upgrade-actions-ready-email");
  return { sent: true, total };
}
