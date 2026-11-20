
import type { Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { CHANNELS, getChannel, isChannelSlug, type Channel } from "@zavi/shared";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";
import { writeStaffAudit } from "@/services/staff/audit";
import { requestStopForRun } from "@/services/agents/request-stop";
import { lockedSlugsFromBlob } from "@/services/channels/lock";
import { linkedinStopStands } from "@/services/ads-wallet/linkedin-pause-pending";

const PostBody = z.object({ locked: z.boolean() });

const IN_FLIGHT = ["queued", "running"];

function client(): SupabaseClient {
  return staffCrossTenantClient("admin/channel-locks: global channel lock across all tenants");
}

export function executorIsShared(
  channel: Pick<Channel, "executor">,
  channels: ReadonlyArray<Pick<Channel, "executor">> = CHANNELS,
): boolean {
  return channels.filter((c) => c.executor === channel.executor).length > 1;
}

function channelFromParams(req: Request, res: Response): Channel | null {
  const slug = typeof req.params.slug === "string" ? req.params.slug : "";
  const channel = isChannelSlug(slug) ? getChannel(slug) : undefined;
  if (!channel) {
    res.status(400).json({ error: { code: "unknown_channel", message: `Unknown channel: ${slug}` } });
    return null;
  }
  return channel;
}

type InFlightRun = { id: string; tenant_id: string };

export type ChannelLockImpact = {
  running_runs: number;
  schedules: number;
  companies: number;
  schedules_skipped_reason: string | null;
  live_campaigns: LiveCampaign[];
  live_campaigns_note: string | null;
  live_campaigns_unread: boolean;
};

export type LiveCampaign = { tenant_id: string; campaign_binding_id: string; provider_campaign_id: string };

const LIVE_PAGE = 500;
const LIVE_PAGES = 200;

async function readAll<T>(read: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>, what: string): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 0; page < LIVE_PAGES; page++) {
    const { data, error } = await read(page * LIVE_PAGE, (page + 1) * LIVE_PAGE - 1);
    if (error) throw new Error(`${what} read failed: ${error.message}`);
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < LIVE_PAGE) return rows;
  }
  throw new Error(`${what} read is incomplete`);
}

export async function readLiveLinkedinCampaigns(sb: SupabaseClient, now = Date.now()): Promise<LiveCampaign[]> {
  const [bindings, operations, stops] = await Promise.all([
    readAll<{ id: string; tenant_id: string; provider_campaign_id: string }>(
      (from, to) => sb.from("ads_campaign_binding_details").select("id,tenant_id,provider_campaign_id").eq("platform", "linkedin").order("id").range(from, to),
      "LinkedIn campaign",
    ),
    readAll<{ campaign_binding_id: string; payload: { end_time?: unknown } | null; updated_at?: unknown }>(
      (from, to) => sb.from("ads_campaign_operations").select("campaign_binding_id,payload,updated_at").eq("kind", "activate").in("status", ["succeeded", "uncertain", "pending"]).order("id").range(from, to),
      "LinkedIn launch",
    ),
    readAll<{ campaign_binding_id: string; stop_requested_at: unknown; stop_confirmed_at?: unknown }>(
      (from, to) => sb.from("ads_campaign_lifecycle").select("campaign_binding_id,stop_requested_at,stop_confirmed_at").not("stop_requested_at", "is", null).order("campaign_binding_id").range(from, to),
      "LinkedIn stop",
    ),
  ]);
  const lastActivate = new Map<string, number>();
  for (const o of operations) {
    const t = typeof o.updated_at === "string" ? Date.parse(o.updated_at) : NaN;
    if (Number.isFinite(t)) lastActivate.set(o.campaign_binding_id, Math.max(t, lastActivate.get(o.campaign_binding_id) ?? t));
  }
  const stopped = new Set(
    stops
      .filter((r) => linkedinStopStands(r.stop_requested_at, r.stop_confirmed_at, lastActivate.get(r.campaign_binding_id) ?? null))
      .map((r) => r.campaign_binding_id),
  );
  const launched = new Set(
    operations
      .filter((o) => {
        const end = o.payload?.end_time;
        return typeof end !== "number" || end > now;
      })
      .map((o) => o.campaign_binding_id),
  );
  return bindings
    .filter((b) => launched.has(b.id) && !stopped.has(b.id))
    .map((b) => ({ tenant_id: b.tenant_id, campaign_binding_id: b.id, provider_campaign_id: b.provider_campaign_id }));
}

async function readChannelLiveCampaigns(sb: SupabaseClient, channel: Channel): Promise<LiveCampaign[]> {
  return channel.slug === "linkedin_ads" ? readLiveLinkedinCampaigns(sb) : [];
}

function liveCampaignsNote(live: LiveCampaign[]): string | null {
  if (!live.length) return null;
  const companies = new Set(live.map((c) => c.tenant_id)).size;
  return `This lock does not pause live ads. ${live.length} LinkedIn campaign${live.length === 1 ? "" : "s"} launched through Zavi across ${companies} compan${companies === 1 ? "y" : "ies"} keep${live.length === 1 ? "s" : ""} spending until it is paused in LinkedIn Campaign Manager or reaches its end date. A campaign paused directly in LinkedIn may still be listed.`;
}

const LIVE_CAMPAIGNS_UNREAD_NOTE =
  "The LinkedIn campaign list could not be read, so this preview cannot say which campaigns keep spending. You can still lock. This lock does not pause live ads: check LinkedIn Campaign Manager for anything still running.";

async function readInFlightRuns(sb: SupabaseClient, slug: string): Promise<InFlightRun[]> {
  const { data, error } = await sb
    .from("agent_runs")
    .select("id, tenant_id")
    .eq("channel_slug", slug)
    .in("status", IN_FLIGHT);
  if (error) throw new Error(`run read failed: ${error.message}`);
  return (data ?? []) as InFlightRun[];
}

function sharedReason(channel: Channel): string {
  return `Schedules are kept: another channel also runs on the "${channel.executor}" agent.`;
}

export async function computeChannelLockImpact(
  sb: SupabaseClient,
  channel: Channel,
): Promise<ChannelLockImpact> {
  const runs = await readInFlightRuns(sb, channel.slug);
  const tenants = new Set(runs.map((r) => r.tenant_id));

  let schedules = 0;
  const shared = executorIsShared(channel);
  if (!shared) {
    const { data, error } = await sb
      .from("tenant_agent_schedules")
      .select("tenant_id")
      .eq("agent_slug", channel.executor);
    if (error) throw new Error(`schedule read failed: ${error.message}`);
    const rows = (data ?? []) as Array<{ tenant_id: string }>;
    schedules = rows.length;
    for (const r of rows) tenants.add(r.tenant_id);
  }

  let live: LiveCampaign[] = [];
  let liveUnread = false;
  try {
    live = await readChannelLiveCampaigns(sb, channel);
  } catch (e) {
    liveUnread = true;
    console.warn(`[channel-locks] live campaign preview unread for ${channel.slug}: ${(e as Error).message}`);
  }
  return {
    running_runs: runs.length,
    schedules,
    companies: tenants.size,
    schedules_skipped_reason: shared ? sharedReason(channel) : null,
    live_campaigns: live,
    live_campaigns_note: liveUnread ? LIVE_CAMPAIGNS_UNREAD_NOTE : liveCampaignsNote(live),
    live_campaigns_unread: liveUnread,
  };
}

async function readBlob(sb: SupabaseClient): Promise<Record<string, unknown>> {
  const { data, error } = await sb
    .from("system_config")
    .select("blob")
    .eq("id", 1)
    .maybeSingle<{ blob: Record<string, unknown> }>();
  if (error) throw new Error(error.message);
  return data?.blob ?? {};
}

export async function staffChannelLocksGet(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  let blob: Record<string, unknown>;
  try {
    blob = await readBlob(client());
  } catch (e) {
    res.status(500).json({ error: { code: "config_read_failed", message: (e as Error).message } });
    return;
  }
  const locked = new Set(lockedSlugsFromBlob(blob));
  res.json({
    channels: CHANNELS.map((c) => ({
      slug: c.slug,
      name: c.name,
      category: c.category,
      readiness: c.readiness,
      executor: c.executor,
      locked: locked.has(c.slug),
    })),
  });
}

export async function staffChannelLockImpact(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const channel = channelFromParams(req, res);
  if (!channel) return;
  try {
    res.json(await computeChannelLockImpact(client(), channel));
  } catch (e) {
    res.status(500).json({ error: { code: "impact_failed", message: (e as Error).message } });
  }
}

export async function staffChannelLockSet(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const channel = channelFromParams(req, res);
  if (!channel) return;
  const parsed = PostBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid_body", message: parsed.error.message } });
    return;
  }
  const { locked } = parsed.data;
  const sb = client();

  const { data: swapped, error: writeErr } = await sb.rpc("system_config_set_channel_lock", {
    p_slug: channel.slug,
    p_locked: locked,
    p_actor: staff.user_id,
  });
  if (writeErr) {
    res.status(500).json({ error: { code: "config_write_failed", message: writeErr.message } });
    return;
  }
  const swap = (swapped ?? {}) as { before?: unknown; after?: unknown };
  const current = lockedSlugsFromBlob({ locked_channel_slugs: swap.before });
  const next = lockedSlugsFromBlob({ locked_channel_slugs: swap.after });

  if (!locked) {
    await writeStaffAudit({
      actor_user_id: staff.user_id,
      actor_email: staff.email,
      action: "channel_lock.clear",
      target_table: "system_config",
      target_id: "1",
      meta: { channel_slug: channel.slug, before: current, after: next },
    });
    res.json({ ok: true, locked: false });
    return;
  }

  const errors: string[] = [];
  const tenants = new Set<string>();

  let cancelled = 0;
  let runs: InFlightRun[] = [];
  try {
    runs = await readInFlightRuns(sb, channel.slug);
  } catch (e) {
    errors.push((e as Error).message);
  }
  for (const run of runs) {
    const r = await requestStopForRun(sb, run.tenant_id, run.id);
    if (!r.ok) {
      errors.push(`stop ${run.id}: ${r.error}`);
      continue;
    }
    if ("cancelling" in r) {
      cancelled += 1;
      tenants.add(run.tenant_id);
    }
  }

  let schedulesDeleted = 0;
  const shared = executorIsShared(channel);
  if (!shared) {
    const { data, error } = await sb
      .from("tenant_agent_schedules")
      .delete()
      .eq("agent_slug", channel.executor)
      .select("tenant_id");
    if (error) {
      errors.push(`schedule delete failed: ${error.message}`);
    } else {
      const rows = (data ?? []) as Array<{ tenant_id: string }>;
      schedulesDeleted = rows.length;
      for (const r of rows) tenants.add(r.tenant_id);
    }
  }

  let live: LiveCampaign[] = [];
  try {
    live = await readChannelLiveCampaigns(sb, channel);
  } catch (e) {
    errors.push(`live campaigns unreadable, so some may keep spending: ${(e as Error).message}`);
  }

  const result = {
    cancelled_runs: cancelled,
    deleted_schedules: schedulesDeleted,
    companies: tenants.size,
    schedules_skipped_reason: shared ? sharedReason(channel) : null,
    live_campaigns: live,
    live_campaigns_note: liveCampaignsNote(live),
    errors,
  };

  await writeStaffAudit({
    actor_user_id: staff.user_id,
    actor_email: staff.email,
    action: "channel_lock.engage",
    target_table: "system_config",
    target_id: "1",
    meta: { channel_slug: channel.slug, before: current, after: next, ...result },
  });

  res.json({ ok: true, locked: true, ...result });
}
