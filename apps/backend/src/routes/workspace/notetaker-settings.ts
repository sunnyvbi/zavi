
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { RECAP_DESTINATIONS, findPostableChannel, type ChannelLookup } from "@/services/meetings/recap-destination";
import { serviceClient, serverClientFromBearer } from "@/services/supabase";
import { canonicalizeMeetingUrl, isSupportedMeetingUrl, sameMeetingLink } from "@/services/meetings/url";
import { nextOpenMeetingDate } from "@/services/meetings/schedule";
import { DEFAULT_NOTETAKER_SETTINGS } from "@/services/meetings/settings-defaults";
import { slackFetch } from "@/services/tools/slack/_client";
import { cancelSentBots, cancelResponse, type CancelReason } from "@/services/meetings/cancel-bots";
import { logEvent } from "@/services/logging/logEvent";

const Body = z.object({
  enabled: z.boolean(),
  meeting_url: z.string().trim().max(500),
  days_of_week: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  join_time: z.string().regex(/^\d{1,2}:\d{2}$/),
  timezone: z.string().min(1).max(64),
});

const ADMIN_ROLES = ["owner", "admin"] as const;
const ADMIN_ONLY = "Only an owner or admin can change Notetaker settings.";

export const SAME_DAY_NOTE =
  "Today's Zavi Notetaker is already scheduled, so this change starts with the next meeting. To record a meeting today, use Join now.";

export const CANCELLED_TODAY_NOTE =
  "Today's Zavi Notetaker was cancelled, so Notetaker starts again with the next meeting. To record a meeting today, use Join now.";

export const PENDING_BOT_NOTE =
  "Today's Zavi Notetaker was already sent with the old settings and will still try to join that meeting. Your change starts with the next meeting. Remove Zavi Notetaker from the call if you don't want this meeting recorded.";

const PENDING_BOT_STATUSES = ["scheduled", "joining", "in_call"];
const PENDING_BOT_MAX_AGE_MS = 4 * 60 * 60 * 1000;

type PriorSettings = {
  enabled: boolean;
  meeting_url: string | null;
  join_time: string | null;
  timezone: string | null;
  days_of_week: number[] | null;
};

export async function sameDayNote(
  svc: ReturnType<typeof serviceClient>,
  tenantId: string,
  prior: PriorSettings | null,
  next: z.infer<typeof Body>,
  now = new Date(),
): Promise<string | null> {
  if (!prior) return null;
  const sameDays =
    [...(prior.days_of_week ?? [])].sort().join(",") === [...next.days_of_week].sort().join(",");
  const timeOrLinkChanged =
    prior.join_time !== next.join_time || prior.timezone !== next.timezone || !sameMeetingLink(prior.meeting_url, next.meeting_url);
  const anyChange = prior.enabled !== next.enabled || !sameDays || timeOrLinkChanged;
  if (!anyChange) return null;

  if (prior.enabled && prior.meeting_url) {
    const { data: pending, error } = await svc
      .from("meeting_bots")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("source", "scheduled")
      .in("status", PENDING_BOT_STATUSES)
      .gte("scheduled_for", new Date(now.getTime() - PENDING_BOT_MAX_AGE_MS).toISOString())
      .limit(1);
    if (!error && pending && pending.length > 0) return PENDING_BOT_NOTE;
  }

  const turnedBackOn = !prior.enabled && next.enabled;
  if (!next.enabled || !next.meeting_url || (!timeOrLinkChanged && !turnedBackOn)) return null;
  const day = nextOpenMeetingDate(
    { days_of_week: next.days_of_week, join_time: next.join_time, timezone: next.timezone },
    now,
  );
  if (!day) return null;
  const { data, error } = await svc
    .from("meeting_bots")
    .select("id, status")
    .eq("tenant_id", tenantId)
    .eq("source", "scheduled")
    .eq("scheduled_date", day)
    .maybeSingle();
  if (error || !data) return null;
  if (data.status === "cancelled") return CANCELLED_TODAY_NOTE;
  return timeOrLinkChanged ? SAME_DAY_NOTE : null;
}

export async function workspaceNotetakerSettingsGet(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const supabase = serverClientFromBearer(auth.access_token);
  const { data, error } = await supabase
    .from("tenant_meeting_settings")
    .select(
      "enabled, meeting_url, days_of_week, join_time, timezone, bot_name, consent_message, recap_destination, slack_channel_id, slack_channel_name",
    )
    .eq("tenant_id", auth.tenant_id)
    .maybeSingle();
  if (error) {
    res.status(500).json({ error: { code: "db", message: error.message } });
    return;
  }
  res.json(
    data
      ? { ...DEFAULT_NOTETAKER_SETTINGS, ...data }
      : DEFAULT_NOTETAKER_SETTINGS,
  );
}

export async function workspaceNotetakerSettingsPut(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, ADMIN_ROLES, res, ADMIN_ONLY))) return;

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(req.body ?? {});
  } catch (e) {
    res.status(400).json({ error: { code: "validation", message: (e as Error).message } });
    return;
  }

  body.meeting_url = canonicalizeMeetingUrl(body.meeting_url);

  if (body.enabled) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: body.timezone });
    } catch {
      res.status(400).json({ error: { code: "bad_timezone", message: `unknown timezone: ${body.timezone}` } });
      return;
    }
    if (body.meeting_url && !isSupportedMeetingUrl(body.meeting_url)) {
      res.status(400).json({
        error: {
          code: "bad_meeting_url",
          message: "meeting_url must be a Zoom, Google Meet, or Microsoft Teams link",
        },
      });
      return;
    }
  }

  const svc = serviceClient();
  const { data: prior } = await svc
    .from("tenant_meeting_settings")
    .select("enabled, meeting_url, join_time, timezone, days_of_week")
    .eq("tenant_id", auth.tenant_id)
    .maybeSingle();
  const turningOn = body.enabled && prior?.enabled === false;

  const { error } = await svc.from("tenant_meeting_settings").upsert(
    {
      tenant_id: auth.tenant_id,
      enabled: body.enabled,
      meeting_url: body.meeting_url,
      days_of_week: body.days_of_week,
      join_time: body.join_time,
      timezone: body.timezone,
      updated_at: new Date().toISOString(),
      ...(turningOn
        ? { enabled_by: auth.user_id, enabled_at: new Date().toISOString() }
        : {}),
    },
    { onConflict: "tenant_id" },
  );
  if (error) {
    res.status(500).json({ error: { code: "db", message: error.message } });
    return;
  }
  const cancelReason: CancelReason | null = !body.enabled ? "notetaker_off" : !body.meeting_url ? "link_cleared" : null;
  if (cancelReason) {
    const summary = await cancelSentBots(svc, auth.tenant_id, cancelReason).catch(async (e) => {
      await logEvent({
        level: "error",
        source: "notetaker-settings",
        code: "meeting_bot.cancel_failed",
        tenant_id: auth.tenant_id,
        message: `could not look up meeting bots to cancel (${cancelReason}): ${(e as Error).message}`,
        meta: { skipped_reason: cancelReason, stage: "lookup" },
      });
      return null;
    });
    res.json({ ok: true, ...cancelResponse(summary) });
    return;
  }
  const note = await sameDayNote(svc, auth.tenant_id, (prior as PriorSettings | null) ?? null, body).catch(() => null);
  res.json(note ? { ok: true, note } : { ok: true });
}

const RecapBody = z.object({
  destination: z.enum(RECAP_DESTINATIONS),
  slack_channel: z.string().trim().max(100).optional(),
});

const LOOKUP_STATUS: Record<Exclude<ChannelLookup, { ok: true }>["code"], number> = {
  bad_channel_name: 400,
  channel_not_found: 400,
  cannot_join: 400,
  slack_not_connected: 409,
  slack_error: 502,
};

export async function workspaceNotetakerRecapPut(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, ADMIN_ROLES, res, "Only an owner or admin can choose where meeting notes go."))) return;

  const parsed = RecapBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { code: "validation", message: "Choose Slack, email or off." } });
    return;
  }
  const body = parsed.data;

  let patch: { recap_destination: string; slack_channel_id: string | null; slack_channel_name: string | null };
  if (body.destination === "slack") {
    if (!body.slack_channel) {
      res.status(400).json({ error: { code: "bad_channel_name", message: "Type a Slack channel name, like #standups." } });
      return;
    }
    const found = await findPostableChannel(body.slack_channel, <T>(method: string, b: Record<string, string | number | boolean | undefined>) =>
      slackFetch<T>(auth.tenant_id, method, b),
    );
    if (!found.ok) {
      res.status(LOOKUP_STATUS[found.code]).json({ error: { code: found.code, message: found.message } });
      return;
    }
    patch = { recap_destination: "slack", slack_channel_id: found.id, slack_channel_name: found.name };
  } else {
    patch = { recap_destination: body.destination, slack_channel_id: null, slack_channel_name: null };
  }

  const { error } = await serviceClient()
    .from("tenant_meeting_settings")
    .upsert({ tenant_id: auth.tenant_id, ...patch, updated_at: new Date().toISOString() }, { onConflict: "tenant_id" });
  if (error) {
    res.status(500).json({ error: { code: "db", message: error.message } });
    return;
  }
  res.json({ ok: true, recap_destination: patch.recap_destination, slack_channel_name: patch.slack_channel_name });
}

export async function workspaceSlackChannelsGet(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, ADMIN_ROLES, res, ADMIN_ONLY))) return;
  try {
    const resp = await slackFetch<{
      channels?: Array<{ id: string; name: string; is_archived?: boolean }>;
    }>(auth.tenant_id, "conversations.list", {
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 200,
    });
    const channels = (resp.channels ?? [])
      .filter((c) => !c.is_archived)
      .map((c) => ({ id: c.id, name: c.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ slack_connected: true, channels });
  } catch {
    res.json({ slack_connected: false, channels: [] });
  }
}
