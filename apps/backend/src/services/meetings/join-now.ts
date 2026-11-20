
import { serviceClient } from "@/services/supabase";
import { createBot, recallConfigured } from "./recall";
import { attachBotOrCallBack } from "./cancel-bots";
import { canonicalizeMeetingUrl, isSupportedMeetingUrl } from "./url";
import {
  DEFAULT_NOTETAKER_BOT_NAME,
  DEFAULT_NOTETAKER_CONSENT_MESSAGE,
  notetakerEnabledByDefault,
} from "./settings-defaults";

const ACTIVE_STATUSES = ["scheduled", "joining", "in_call"];
const MAX_ACTIVE_ADHOC_PER_TENANT = 5;

export type JoinNowResult =
  | { ok: true; meeting_bot_id: string; deduped: boolean }
  | {
      ok: false;
      code:
        | "not_configured"
        | "not_enabled"
        | "bad_url"
        | "too_many_active"
        | "create_failed";
      message: string;
    };

export async function joinMeetingNow(input: {
  tenant_id: string;
  meeting_url: string;
  requested_by: string | null;
}): Promise<JoinNowResult> {
  if (!recallConfigured()) {
    return { ok: false, code: "not_configured", message: "Notetaker is not configured on this server yet." };
  }
  if (!isSupportedMeetingUrl(input.meeting_url)) {
    return {
      ok: false,
      code: "bad_url",
      message: "Paste a Zoom, Google Meet, or Microsoft Teams meeting link.",
    };
  }
  const url = canonicalizeMeetingUrl(input.meeting_url);
  const svc = serviceClient();

  const { data: settingsRow } = await svc
    .from("tenant_meeting_settings")
    .select("enabled, bot_name, consent_message")
    .eq("tenant_id", input.tenant_id)
    .maybeSingle();
  if (!notetakerEnabledByDefault(settingsRow)) {
    return {
      ok: false,
      code: "not_enabled",
      message: "The Notetaker is disabled in Settings for this workspace.",
    };
  }

  const { data: existing } = await svc
    .from("meeting_bots")
    .select("id, status")
    .eq("tenant_id", input.tenant_id)
    .eq("source", "adhoc")
    .eq("meeting_url", url)
    .in("status", ACTIVE_STATUSES)
    .limit(1)
    .maybeSingle();
  if (existing) {
    return { ok: true, meeting_bot_id: existing.id as string, deduped: true };
  }

  const { count } = await svc
    .from("meeting_bots")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", input.tenant_id)
    .eq("source", "adhoc")
    .in("status", ACTIVE_STATUSES);
  if ((count ?? 0) >= MAX_ACTIVE_ADHOC_PER_TENANT) {
    return {
      ok: false,
      code: "too_many_active",
      message: `Up to ${MAX_ACTIVE_ADHOC_PER_TENANT} live captures at a time — wait for one to finish.`,
    };
  }

  const today = new Date().toISOString().slice(0, 10);
  const { data: row, error: insErr } = await svc
    .from("meeting_bots")
    .insert({
      tenant_id: input.tenant_id,
      provider: "recall",
      meeting_url: url,
      status: "scheduled",
      source: "adhoc",
      requested_by: input.requested_by,
      scheduled_date: today,
      scheduled_for: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (insErr || !row) {
    return { ok: false, code: "create_failed", message: insErr?.message ?? "insert failed" };
  }

  const { data: liveSettings, error: liveErr } = await svc
    .from("tenant_meeting_settings")
    .select("enabled")
    .eq("tenant_id", input.tenant_id)
    .maybeSingle();
  if (liveErr || !notetakerEnabledByDefault(liveSettings)) {
    await svc
      .from("meeting_bots")
      .update(
        liveErr
          ? { status: "failed", error: "settings_check_failed", updated_at: new Date().toISOString() }
          : { status: "cancelled", error: "cancelled_notetaker_off", updated_at: new Date().toISOString() },
      )
      .eq("id", row.id)
      .eq("status", "scheduled");
    return liveErr
      ? { ok: false, code: "create_failed", message: "Couldn't check the Notetaker settings. Try again." }
      : { ok: false, code: "not_enabled", message: "The Notetaker is disabled in Settings for this workspace." };
  }

  try {
    const bot = await createBot({
      meeting_url: url,
      bot_name: (settingsRow?.bot_name as string | undefined) || DEFAULT_NOTETAKER_BOT_NAME,
      consent_message:
        (settingsRow?.consent_message as string | undefined) ||
        DEFAULT_NOTETAKER_CONSENT_MESSAGE,
      metadata: { tenant_id: input.tenant_id, meeting_bot_id: row.id as string },
    });
    const attached = await attachBotOrCallBack(svc, input.tenant_id, row.id as string, bot.id, "notetaker-join-now");
    if (attached === "cancelled") {
      return { ok: false, code: "not_enabled", message: "The Notetaker was turned off in Settings while it was being sent, so it won't join." };
    }
    if (attached === "attach_failed") {
      return { ok: false, code: "create_failed", message: "Couldn't start the Notetaker. Try again." };
    }
    return { ok: true, meeting_bot_id: row.id as string, deduped: false };
  } catch (e) {
    await svc
      .from("meeting_bots")
      .update({ status: "failed", error: (e as Error).message.slice(0, 500), updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("status", "scheduled");
    return { ok: false, code: "create_failed", message: (e as Error).message.slice(0, 300) };
  }
}
