
import { isCustomerChannelAction } from "@zavi/shared";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { PREVIEW_RUN_KEY_PREFIX, isDoneForYouIdentity, isSignupPreviewIdentity } from "@/services/billing/tiers";

type Row = {
  id: string;
  agent_slug: string;
  trigger: string;
  enqueued_by: string | null;
  cron_dedupe_key: string | null;
};

function isPreviewRow(tenant_id: string, r: Row): boolean {
  return isSignupPreviewIdentity(tenant_id, r.agent_slug, {
    trigger: r.trigger,
    enqueuedByUser: r.enqueued_by !== null,
    payload: null,
    cronDedupeKey: r.cron_dedupe_key,
  });
}

export async function isPreviewRunId(tenant_id: string, run_id: string | null | undefined): Promise<boolean> {
  if (!run_id) return false;
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("agent_runs")
    .select("id, agent_slug, trigger, enqueued_by, cron_dedupe_key")
    .eq("id", run_id)
    .maybeSingle();
  if (error) throw new Error(`preview check failed: ${error.message}`);
  if (!data) return false;
  const r = data as Row;
  return (
    isPreviewRow(tenant_id, r) ||
    isDoneForYouIdentity(tenant_id, {
      trigger: r.trigger,
      enqueuedByUser: r.enqueued_by !== null,
      payload: null,
      cronDedupeKey: r.cron_dedupe_key,
    })
  );
}

export async function previewRunStarts(tenant_id: string, run_ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (run_ids.length === 0) return out;
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("agent_runs")
    .select("id, agent_slug, trigger, enqueued_by, cron_dedupe_key, enqueued_at")
    .in("id", run_ids)
    .like("cron_dedupe_key", `${PREVIEW_RUN_KEY_PREFIX}${tenant_id}:%`);
  if (error) return out;
  for (const r of (data ?? []) as Array<Row & { enqueued_at: string | null }>) {
    if (r.enqueued_at && isPreviewRow(tenant_id, r)) out.set(r.id, r.enqueued_at);
  }
  return out;
}

export async function firstRoundOpenChannels(tenant_id: string, locked_slugs: readonly string[]): Promise<Set<string>> {
  const open = new Set<string>();
  if (locked_slugs.length === 0) return open;
  const locked = new Set(locked_slugs);
  const db = tenantClient(asTenantId(tenant_id));
  try {
    const { data: runs, error: runErr } = await db
      .from("agent_runs")
      .select("id, agent_slug, trigger, enqueued_by, cron_dedupe_key")
      .like("cron_dedupe_key", `${PREVIEW_RUN_KEY_PREFIX}${tenant_id}:%`)
      .limit(50);
    if (runErr) return open;
    const slugOfRun = new Map<string, string>();
    for (const r of (runs ?? []) as Row[]) {
      if (locked.has(r.agent_slug) && isPreviewRow(tenant_id, r)) slugOfRun.set(r.id, r.agent_slug);
    }
    if (slugOfRun.size === 0) return open;
    const { data: cards, error: cardErr } = await db
      .from("channel_actions")
      .select("channel_slug, run_id, responsibility:body->step->>responsibility")
      .in("run_id", [...slugOfRun.keys()])
      .limit(500);
    if (cardErr) return open;
    for (const c of (cards ?? []) as Array<{ channel_slug: string; run_id: string; responsibility: string | null }>) {
      const slug = slugOfRun.get(c.run_id);
      if (!slug || slug !== c.channel_slug) continue;
      if (isCustomerChannelAction(slug, { step: { responsibility: c.responsibility } })) open.add(slug);
    }
  } catch {
    return new Set<string>();
  }
  return open;
}
