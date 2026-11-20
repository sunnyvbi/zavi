
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { computeDueJoin, JOIN_WINDOW_MIN } from "@/services/meetings/schedule";
import { createBot, recallConfigured } from "@/services/meetings/recall";
import { attachBotOrCallBack } from "@/services/meetings/cancel-bots";
import { sameMeetingLink } from "@/services/meetings/url";
import { logEvent } from "@/services/logging/logEvent";

type Logger = { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
type Svc = ReturnType<typeof serviceClient>;

export type SameDaySkipReason = "join_time_changed" | "link_changed_after_scheduling";

function isUniqueViolation(err: { code?: string; message: string }): boolean {
  return err.code === "23505" || /duplicate key|unique/i.test(err.message);
}

function sameDaySkipReason(
  existing: { scheduled_for: string | null; meeting_url: string | null },
  settingsUrl: string,
  targetIso: string,
): SameDaySkipReason | null {
  const joinAt = existing.scheduled_for ? Date.parse(existing.scheduled_for) : NaN;
  const target = Date.parse(targetIso);
  if (Number.isFinite(joinAt) && Number.isFinite(target) && (joinAt < target || joinAt > target + (JOIN_WINDOW_MIN + 1) * 60_000)) {
    return "join_time_changed";
  }
  if (!sameMeetingLink(existing.meeting_url, settingsUrl)) return "link_changed_after_scheduling";
  return null;
}

async function noteSameDaySkip(
  svc: Svc,
  logger: Logger,
  s: { tenant_id: string; meeting_url: string },
  localDate: string,
  targetIso: string,
): Promise<void> {
  const { data: existing, error } = await svc
    .from("meeting_bots")
    .select("id, status, meeting_url, scheduled_for")
    .eq("tenant_id", s.tenant_id)
    .eq("source", "scheduled")
    .eq("scheduled_date", localDate)
    .maybeSingle();
  if (error) {
    logger.warn(`[meeting-bot-scheduler] same-day lookup failed tenant=${s.tenant_id} date=${localDate}: ${error.message}`);
    return;
  }
  if (!existing) return;
  const reason = sameDaySkipReason(
    { scheduled_for: (existing.scheduled_for as string | null) ?? null, meeting_url: (existing.meeting_url as string | null) ?? null },
    s.meeting_url,
    targetIso,
  );
  if (!reason) return;
  const line = `skipped a second scheduled bot tenant=${s.tenant_id} date=${localDate} reason=${reason} existing_bot=${existing.id} existing_status=${existing.status}`;
  logger.info(`[meeting-bot-scheduler] ${line}`);
  await logEvent({
    level: "info",
    source: "meeting-bot-scheduler",
    code: "meeting_bot.skipped_same_day",
    tenant_id: s.tenant_id,
    message: line,
    meta: { skipped_reason: reason, object_id: existing.id as string },
  });
}

export async function runMeetingBotScheduler(logger: Logger, now = new Date()): Promise<{ dispatched: number }> {
  if (!recallConfigured()) {
    logger.info("[meeting-bot-scheduler] RECALL_API_KEY unset — skipping");
    return { dispatched: 0 };
  }

  const svc = serviceClient();
  const { data: rows, error } = await svc
    .from("tenant_meeting_settings")
    .select("tenant_id, meeting_url, days_of_week, join_time, timezone, bot_name, consent_message")
    .eq("enabled", true);
  if (error) throw new Error(`settings read failed: ${error.message}`);

  let dispatched = 0;
  for (const s of rows ?? []) {
    if (!s.meeting_url) continue;
    const due = computeDueJoin(
      { days_of_week: s.days_of_week ?? [], join_time: s.join_time ?? "", timezone: s.timezone ?? "" },
      now,
    );
    if (!due.due) continue;

    const { data: inserted, error: insErr } = await svc
      .from("meeting_bots")
      .insert({
        tenant_id: s.tenant_id,
        provider: "recall",
        meeting_url: s.meeting_url,
        status: "scheduled",
        scheduled_date: due.local_date,
        scheduled_for: due.target_iso,
      })
      .select("id")
      .maybeSingle();
    if (insErr) {
      if (isUniqueViolation(insErr)) {
        await noteSameDaySkip(svc, logger, { tenant_id: s.tenant_id, meeting_url: s.meeting_url }, due.local_date, due.target_iso).catch((e) =>
          logger.warn(`[meeting-bot-scheduler] same-day skip note failed tenant=${s.tenant_id}: ${(e as Error).message}`),
        );
      } else {
        logger.error(`[meeting-bot-scheduler] insert failed tenant=${s.tenant_id}: ${insErr.message}`);
      }
      continue;
    }
    if (!inserted) continue;

    const { data: liveSettings, error: liveErr } = await svc
      .from("tenant_meeting_settings")
      .select("enabled, meeting_url")
      .eq("tenant_id", s.tenant_id)
      .maybeSingle();
    if (liveErr || !liveSettings?.enabled || !liveSettings.meeting_url) {
      await svc
        .from("meeting_bots")
        .update(
          liveErr
            ? { status: "failed", error: "settings_check_failed", updated_at: new Date().toISOString() }
            : {
                status: "cancelled",
                error: liveSettings?.enabled ? "cancelled_link_cleared" : "cancelled_notetaker_off",
                updated_at: new Date().toISOString(),
              },
        )
        .eq("id", inserted.id)
        .eq("status", "scheduled");
      if (liveErr) logger.error(`[meeting-bot-scheduler] settings re-read failed tenant=${s.tenant_id}: ${liveErr.message}; no bot`);
      else logger.info(`[meeting-bot-scheduler] settings changed before the bot was made tenant=${s.tenant_id}; no bot`);
      continue;
    }

    try {
      const bot = await createBot({
        meeting_url: s.meeting_url,
        bot_name: s.bot_name || "Zavi Notetaker",
        join_at: due.join_at_iso,
        consent_message: s.consent_message || "Zavi Notetaker is recording and transcribing this meeting.",
        metadata: { tenant_id: s.tenant_id, meeting_bot_id: inserted.id },
      });
      const attached = await attachBotOrCallBack(svc, s.tenant_id, inserted.id as string, bot.id, "meeting-bot-scheduler");
      if (attached !== "attached") {
        logger.warn(`[meeting-bot-scheduler] bot ${bot.id} called back (${attached}) tenant=${s.tenant_id} row=${inserted.id}`);
        continue;
      }
      dispatched += 1;
      logger.info(`[meeting-bot-scheduler] bot ${bot.id} scheduled tenant=${s.tenant_id} date=${due.local_date}`);
    } catch (e) {
      await svc
        .from("meeting_bots")
        .update({ status: "failed", error: (e as Error).message.slice(0, 500), updated_at: new Date().toISOString() })
        .eq("id", inserted.id)
        .eq("status", "scheduled");
      logger.error(`[meeting-bot-scheduler] createBot failed tenant=${s.tenant_id}: ${(e as Error).message}`);
    }
  }
  return { dispatched };
}

export const meetingBotSchedulerFn = inngest.createFunction(
  { id: "meeting-bot-scheduler", concurrency: 1 },
  { cron: "*/10 * * * *" },
  async ({ logger }) => runMeetingBotScheduler(logger),
);
