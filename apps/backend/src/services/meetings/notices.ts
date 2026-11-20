
import type { SupabaseClient } from "@supabase/supabase-js";
import { slackFetch } from "@/services/tools/slack/_client";
import { sameMeetingLink } from "./url";

export type NoticeKind = "waiting" | "no_record";
export type NoticeResult = { posted: boolean; reason?: string };

type Svc = SupabaseClient;

export type FailureCause =
  | "no_meeting"
  | "link_expired"
  | "not_admitted"
  | "removed"
  | "removed_from_call"
  | "nobody_joined"
  | "not_started"
  | "already_ended"
  | "ended_early"
  | "no_permission"
  | "passcode"
  | "guests_blocked"
  | "locked_or_full"
  | "our_side"
  | "platform_reason"
  | "unknown";

const CAUSE_BY_CODE = new Map<string, FailureCause>([
  ["meeting_not_found", "no_meeting"],
  ["meeting_link_invalid", "no_meeting"],
  ["meeting_link_expired", "link_expired"],
  ["timeout_exceeded_waiting_room", "not_admitted"],
  ["call_ended_by_platform_waiting_room_timeout", "not_admitted"],
  ["bot_kicked_from_waiting_room", "removed"],
  ["bot_kicked_from_call", "removed_from_call"],
  ["timeout_exceeded_noone_joined", "nobody_joined"],
  ["timeout_exceeded_silence_detected", "nobody_joined"],
  ["timeout_exceeded_only_bots_detected_using_participant_names", "nobody_joined"],
  ["timeout_exceeded_only_bots_detected_using_participant_events", "nobody_joined"],
  ["meeting_not_started", "not_started"],
  ["microsoft_teams_event_not_started_for_external", "not_started"],
  ["meeting_ended", "already_ended"],
  ["call_ended_by_host", "ended_early"],
  ["call_ended_by_platform_idle", "ended_early"],
  ["call_ended_by_platform_max_length", "ended_early"],
  ["timeout_exceeded_everyone_left", "ended_early"],
  ["timeout_exceeded_recording_permission_denied", "no_permission"],
  ["timeout_exceeded_in_call_not_recording", "no_permission"],
  ["meeting_password_incorrect", "passcode"],
  ["webex_password_required", "passcode"],
  ["webex_pin_required", "passcode"],
  ["meeting_requires_sign_in", "guests_blocked"],
  ["meeting_requires_registration", "guests_blocked"],
  ["meeting_not_accessible", "guests_blocked"],
  ["google_meet_organisation_restricted", "guests_blocked"],
  ["google_meet_knocking_disabled", "guests_blocked"],
  ["google_meet_bot_blocked", "guests_blocked"],
  ["zoom_registration_required", "guests_blocked"],
  ["zoom_authorized_participants_only", "guests_blocked"],
  ["zoom_anonymous_join_not_allowed", "guests_blocked"],
  ["zoom_sso_login_required", "guests_blocked"],
  ["zoom_email_required", "guests_blocked"],
  ["zoom_meeting_not_accessible", "guests_blocked"],
  ["zoom_web_disallowed", "guests_blocked"],
  ["zoom_bot_blocked", "guests_blocked"],
  ["microsoft_teams_bot_not_invited", "guests_blocked"],
  ["meeting_locked", "locked_or_full"],
  ["meeting_full", "locked_or_full"],
  ...[
    "bot_errored",
    "failed_to_launch_in_time",
    "google_meet_internal_error",
    "google_meet_video_error",
    "google_meet_meeting_room_not_ready",
    "google_meet_login_not_available",
    "google_meet_sign_in_failed",
    "google_meet_sign_in_captcha_failed",
    "google_meet_sso_sign_in_failed",
    "google_meet_sign_in_missing_login_credentials",
    "google_meet_sign_in_missing_recovery_credentials",
    "google_meet_sso_sign_in_missing_login_credentials",
    "google_meet_sso_sign_in_missing_totp_secret",
    "zoom_internal_error",
    "zoom_connection_failed",
    "zoom_join_timeout",
    "zoom_sdk_credentials_missing",
    "zoom_sdk_update_required",
    "zoom_sdk_app_not_published",
    "zoom_invalid_signature",
    "zoom_token_expired",
    "zoom_invalid_join_token",
    "zoom_obf_or_zak_missing_or_invalid",
    "zoom_error_multiple_device_join",
    "zoom_captcha_required",
    "microsoft_teams_internal_error",
    "microsoft_teams_call_dropped",
    "microsoft_teams_sign_in_credentials_missing",
    "microsoft_teams_sign_in_failed",
    "microsoft_teams_captcha_error",
    "microsoft_teams_2fa_required",
    "meet_media_internal_error",
    "webex_service_app_unauthorized",
    "webex_user_has_excessive_device_registrations",
    "sso_not_configured",
    "sso_login_account_disabled",
    "sso_login_invalid_recipient",
  ].map((code) => [code, "our_side"] as [string, FailureCause]),
]);

const ZAVI_GENERIC_REASONS = new Set(["no_recording", "fatal", "transcript_stuck"]);

export function failureCause(reason: string | null | undefined): FailureCause {
  const code = reason?.trim() ?? "";
  const mapped = CAUSE_BY_CODE.get(code);
  if (mapped) return mapped;
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(code) || ZAVI_GENERIC_REASONS.has(code)) return "unknown";
  return "platform_reason";
}

export function meetingDateToken(scheduledFor: string | null | undefined, timeZone: string | null | undefined): string | null {
  const ms = scheduledFor ? Date.parse(scheduledFor) : NaN;
  if (!Number.isFinite(ms)) return null;
  const fallback = (zone: string) =>
    new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "short", day: "numeric", year: "numeric", timeZoneName: "short" }).format(
      new Date(ms),
    );
  let text: string;
  try {
    text = fallback(timeZone || "UTC");
  } catch {
    text = fallback("UTC");
  }
  return `<!date^${Math.floor(ms / 1000)}^{date_short}|${text}>`;
}

function displayLink(url: string): string {
  return url.trim().split(/[?#]/)[0].replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export type NoticeContext = {
  date?: string | null;
  reason?: string | null;
  link?: string | null;
  scheduled?: boolean;
  settingsLinkChanged?: boolean;
};

export function noticeText(kind: NoticeKind, ctx: NoticeContext = {}): string {
  const on = ctx.date ? ` on ${ctx.date}` : "";
  if (kind === "waiting") {
    return `Zavi Notetaker is waiting in the waiting room of the meeting${on}. Admit it to record, or set the meeting's access to Open so it joins without knocking. It leaves after 10 minutes.`;
  }
  const link = ctx.link && ctx.link.trim() ? displayLink(ctx.link) : null;
  const scheduled = ctx.scheduled === true;
  const linkAlreadyChanged = "Notetaker settings now has a different link, so the next meeting uses that one.";
  const fixLink = !scheduled
    ? "Check the link and send Zavi Notetaker again."
    : ctx.settingsLinkChanged
      ? linkAlreadyChanged
      : "Update the link in Notetaker settings.";
  switch (failureCause(ctx.reason)) {
    case "no_meeting":
      return `Zavi Notetaker couldn't join the meeting${on}: no meeting exists at ${link ?? "that link"}. ${fixLink}`;
    case "link_expired":
      return `Zavi Notetaker couldn't join the meeting${on}: ${link ? `the link ${link}` : "the meeting link"} has expired. ${fixLink}`;
    case "not_admitted":
      return `Zavi Notetaker waited to be let into the meeting${on}, but nobody admitted it, so nothing was recorded. Admit Zavi Notetaker when it knocks, or set the meeting's access to Open so it joins without knocking.`;
    case "removed":
      return scheduled
        ? `Someone removed Zavi Notetaker from the waiting room of the meeting${on}, so nothing was recorded. Admit it when it knocks, or turn off Notetaker in settings if you don't want it in this meeting.`
        : `Someone removed Zavi Notetaker from the waiting room of the meeting${on}, so nothing was recorded.`;
    case "nobody_joined":
      return `Nobody joined the meeting${on}, so Zavi Notetaker left without recording. ${
        !scheduled
          ? "If your team met at a different link, send Zavi Notetaker there."
          : ctx.settingsLinkChanged
            ? linkAlreadyChanged
            : "If your team meets at a different link, update it in Notetaker settings."
      }`;
    case "passcode":
      return `Zavi Notetaker couldn't join the meeting${on}: the meeting asked for a passcode the link didn't have. ${
        scheduled ? "Put the full invite link, with its passcode, in Notetaker settings." : "Send the full invite link, with its passcode."
      }`;
    case "guests_blocked":
      return `Zavi Notetaker couldn't join the meeting${on}: the meeting's settings keep guests out (for example, only signed-in or company accounts can join, or registration is required). Let guests with the link join, then Zavi Notetaker can get in.`;
    case "locked_or_full":
      return `Zavi Notetaker couldn't join the meeting${on}: the meeting was locked or full when it tried.`;
    case "removed_from_call":
      return `Someone removed Zavi Notetaker from the meeting${on} before it could record.`;
    case "not_started":
      return `Zavi Notetaker tried to join the meeting${on}, but it hadn't started yet. ${
        scheduled ? "If your meeting starts later, update the time in Notetaker settings." : "Send Zavi Notetaker again once the meeting has started."
      }`;
    case "already_ended":
      return `Zavi Notetaker tried to join the meeting${on}, but it had already ended.${
        scheduled ? " If your meeting starts earlier, update the time in Notetaker settings." : ""
      }`;
    case "ended_early":
      return `The meeting${on} ended before Zavi Notetaker could record.`;
    case "no_permission":
      return `Zavi Notetaker was in the meeting${on} but never got permission to record. Let it record when it asks.`;
    case "platform_reason":
      return `Zavi Notetaker couldn't record the meeting${on}. The meeting platform's reason: ${String(ctx.reason).trim().replace(/_/g, " ")}.${
        scheduled ? " It will try again at the next meeting." : ""
      }`;
    case "our_side":
      return scheduled
        ? `Zavi Notetaker couldn't join the meeting${on} because of a problem on our side, not with your meeting. Nothing to change: it will try again at the next meeting.`
        : `Zavi Notetaker couldn't join the meeting${on} because of a problem on our side, not with your meeting. Send it again to retry.`;
    default:
      return scheduled
        ? `Zavi Notetaker couldn't record the meeting${on}. Usually it was never let in or nobody joined; it can also fail before recording. Check that the meeting link in Notetaker settings is the one your team uses, and set the meeting's access to Open or admit Zavi Notetaker when it knocks.`
        : `Zavi Notetaker couldn't record the meeting${on}. Usually it was never let in or nobody joined; it can also fail before recording. Check the link, and set the meeting's access to Open or admit Zavi Notetaker when it knocks.`;
  }
}

type BotRow = {
  id: string;
  tenant_id: string;
  status: string;
  source: string;
  error: string | null;
  meeting_url: string | null;
  scheduled_date: string | null;
  scheduled_for: string | null;
  slack_team_id: string | null;
  slack_channel_id: string | null;
  slack_thread_ts: string | null;
  waiting_notice_at: string | null;
  failed_notice_at: string | null;
};

type SettingsRow = {
  recap_destination: string | null;
  slack_channel_id: string | null;
  meeting_url: string | null;
  timezone: string | null;
  updated_at: string | null;
};

async function repeatsToldFailure(bot: BotRow, settings: SettingsRow | null, svc: Svc): Promise<boolean> {
  if (!bot.scheduled_date || !bot.error) return false;
  const { data: prev, error } = await svc
    .from("meeting_bots")
    .select("id, status, error, meeting_url, failed_notice_at")
    .eq("tenant_id", bot.tenant_id)
    .eq("source", "scheduled")
    .lt("scheduled_date", bot.scheduled_date)
    .order("scheduled_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !prev) return false;
  const toldAt = Date.parse(String(prev.failed_notice_at ?? ""));
  if (prev.status !== "failed" || !Number.isFinite(toldAt)) return false;
  if (prev.error !== bot.error || !sameMeetingLink(prev.meeting_url as string | null, bot.meeting_url)) return false;
  const editedAt = Date.parse(String(settings?.updated_at ?? ""));
  return !(Number.isFinite(editedAt) && editedAt > toldAt);
}

export async function deliverNotetakerNotice(meetingBotId: string, kind: NoticeKind, svc: Svc): Promise<NoticeResult> {
  const col = kind === "waiting" ? "waiting_notice_at" : "failed_notice_at";
  const { data, error: botErr } = await svc
    .from("meeting_bots")
    .select(
      "id, tenant_id, status, source, error, meeting_url, scheduled_date, scheduled_for, slack_team_id, slack_channel_id, slack_thread_ts, waiting_notice_at, failed_notice_at",
    )
    .eq("id", meetingBotId)
    .maybeSingle();
  if (botErr) throw new Error(`bot read failed: ${botErr.message}`);
  const bot = data as BotRow | null;
  if (!bot) return { posted: false, reason: "no_bot" };
  if (bot[col]) return { posted: false, reason: "already_posted" };
  if (kind === "waiting") {
    if (bot.source !== "scheduled" || bot.slack_thread_ts) return { posted: false, reason: "not_scheduled" };
    if (bot.status !== "scheduled" && bot.status !== "joining") return { posted: false, reason: "too_late" };
  }

  const mark = async (): Promise<{ message: string } | null> => {
    const { error } = await svc
      .from("meeting_bots")
      .update({ [col]: new Date().toISOString() })
      .eq("id", bot.id)
      .is(col, null);
    return error;
  };

  const { data: settingsData, error: setErr } = await svc
    .from("tenant_meeting_settings")
    .select("recap_destination, slack_channel_id, meeting_url, timezone, updated_at")
    .eq("tenant_id", bot.tenant_id)
    .maybeSingle();
  if (setErr) throw new Error(`settings read failed: ${setErr.message}`);
  const settings = settingsData as SettingsRow | null;

  let channel = bot.slack_channel_id ?? null;
  let threadTs = bot.slack_thread_ts ?? null;
  if (!channel || !threadTs) {
    channel = settings?.recap_destination === "slack" ? (settings.slack_channel_id ?? null) : null;
    threadTs = null;
  }
  if (!channel) {
    if (kind === "no_record") {
      const err = await mark();
      if (err) throw new Error(`no-channel mark failed: ${err.message}`);
    }
    return { posted: false, reason: "no_channel" };
  }

  const scheduled = bot.source === "scheduled";
  if (kind === "no_record" && scheduled && (await repeatsToldFailure(bot, settings, svc))) {
    const err = await mark();
    if (err) throw new Error(`fold mark failed: ${err.message}`);
    return { posted: false, reason: "repeat_failure" };
  }

  const settingsLink = settings?.meeting_url ?? null;
  const text = noticeText(kind, {
    date: meetingDateToken(bot.scheduled_for, settings?.timezone ?? null),
    reason: bot.error,
    link: bot.meeting_url,
    scheduled,
    settingsLinkChanged: scheduled && Boolean(settingsLink && settingsLink.trim()) && !sameMeetingLink(settingsLink, bot.meeting_url),
  });
  await slackFetch(bot.tenant_id, "chat.postMessage", { channel, text, ...(threadTs ? { thread_ts: threadTs } : {}) }, bot.slack_team_id ?? undefined);
  const markErr = await mark();
  if (markErr) {
    console.error(`[meetings/notices] ${kind} posted but could not mark bot=${bot.id}: ${markErr.message}`);
  }
  return { posted: true };
}
