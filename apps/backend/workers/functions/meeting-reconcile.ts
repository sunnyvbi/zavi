
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import {
  getBot,
  cancelBot,
  recallConfigured,
  classifyForReconcile,
  deleteBotMedia,
  noRecordingReason,
  RecallHttpError,
  type RecallBot,
} from "@/services/meetings/recall";
import { CANCEL_FAILED_ERROR } from "@/services/meetings/cancel-bots";
import { repairUnsavedTranscripts, retryRecordingDeletes } from "@/services/meetings/recording-cleanup";

type Logger = { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };

const GRACE_MINUTES = 30;
const BATCH_CAP = 25;
const SWEEP_BUCKET_MS = 15 * 60 * 1000;
const NOTICE_RESEND_AFTER_MS = 20 * 60 * 1000;
const NOTICE_RESEND_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function runMeetingReconcile(
  logger: Logger,
  now = new Date(),
): Promise<{ scanned: number; reEnqueued: number; terminalized: number }> {
  if (!recallConfigured()) {
    logger.info("[meeting-reconcile] RECALL_API_KEY unset — skipping");
    return { scanned: 0, reEnqueued: 0, terminalized: 0 };
  }

  const svc = serviceClient();
  const cutoff = new Date(now.getTime() - GRACE_MINUTES * 60 * 1000).toISOString();
  const sweepBucket = Math.floor(now.getTime() / SWEEP_BUCKET_MS);

  const { data: rows, error } = await svc
    .from("meeting_bots")
    .select("id, tenant_id, provider_bot_id, status, error, updated_at")
    .in("status", ["processing", "failed"])
    .eq("transcript_chars", 0)
    .is("media_deleted_at", null)
    .not("provider_bot_id", "is", null)
    .lt("updated_at", cutoff)
    .order("updated_at", { ascending: true })
    .limit(BATCH_CAP);
  if (error) throw new Error(`reconcile scan failed: ${error.message}`);

  let reEnqueued = 0;
  let terminalized = 0;
  for (const bot of rows ?? []) {
    const providerBotId = bot.provider_bot_id as string;
    try {
      const remote = await getBot(providerBotId);
      const endedAtMs = remote.ended_at ? Date.parse(remote.ended_at) : NaN;
      const ageMs = Number.isFinite(endedAtMs) ? Math.max(0, now.getTime() - endedAtMs) : 0;
      const verdict = classifyForReconcile(remote, ageMs);

      if (verdict === "ready") {
        await inngest.send({
          id: `recall-reconcile:${providerBotId}:${sweepBucket}`,
          name: "meeting.bot.status",
          data: {
            meeting_bot_id: bot.id as string,
            tenant_id: bot.tenant_id as string,
            event: "reconcile",
          },
        });
        reEnqueued += 1;
        logger.info(`[meeting-reconcile] re-enqueued bot=${bot.id} (was ${bot.status})`);
      } else if (verdict === "no_recording" || verdict === "stale") {
        const reason =
          verdict === "no_recording" ? noRecordingReason(remote.end_sub_code, (bot.error as string | null) ?? null) : "transcript_stuck";
        if (remote.recording_count > 0) {
          await deleteBotMedia(providerBotId);
        }
        const { data: claimed } = await svc
          .from("meeting_bots")
          .update({ status: "failed", error: reason, media_deleted_at: now.toISOString(), updated_at: now.toISOString() })
          .eq("id", bot.id)
          .in("status", ["processing", "failed"])
          .is("media_deleted_at", null)
          .eq("transcript_chars", 0)
          .select("id");
        if (claimed && claimed.length > 0) {
          terminalized += 1;
          let notice = "";
          if (verdict === "no_recording") {
            try {
              await inngest.send({
                id: `meeting-notice:no_record:${bot.id}`,
                name: "meeting.notice",
                data: { meeting_bot_id: bot.id as string, tenant_id: bot.tenant_id as string },
              });
              notice = " notice=queued";
            } catch (e) {
              logger.warn(`[meeting-reconcile] notice queue failed bot=${bot.id}: ${(e as Error).message}; a later sweep re-sends it`);
              notice = " notice=queue_failed";
            }
          }
          logger.info(`[meeting-reconcile] terminalized bot=${bot.id} reason=${reason}${notice}`);
        }
      }
    } catch (e) {
      logger.error(`[meeting-reconcile] getBot failed bot=${bot.id}: ${(e as Error).message}`);
    }
  }

  await resendUnhandledNotices(svc, logger, now, sweepBucket);

  return { scanned: (rows ?? []).length, reEnqueued, terminalized };
}

async function resendUnhandledNotices(
  svc: ReturnType<typeof serviceClient>,
  logger: Logger,
  now: Date,
  sweepBucket: number,
): Promise<void> {
  try {
    const { data, error } = await svc
      .from("meeting_bots")
      .select("id, tenant_id")
      .eq("status", "failed")
      .is("failed_notice_at", null)
      .not("media_deleted_at", "is", null)
      .not("provider_bot_id", "is", null)
      .eq("transcript_chars", 0)
      .neq("error", "transcript_stuck")
      .lt("updated_at", new Date(now.getTime() - NOTICE_RESEND_AFTER_MS).toISOString())
      .gt("updated_at", new Date(now.getTime() - NOTICE_RESEND_WINDOW_MS).toISOString())
      .order("updated_at", { ascending: true })
      .limit(BATCH_CAP);
    if (error) {
      logger.warn(`[meeting-reconcile] unhandled-notice scan failed: ${error.message}`);
      return;
    }
    for (const row of data ?? []) {
      try {
        await inngest.send({
          id: `meeting-notice:no_record:${row.id}:${sweepBucket}`,
          name: "meeting.notice",
          data: { meeting_bot_id: row.id as string, tenant_id: row.tenant_id as string },
        });
        logger.info(`[meeting-reconcile] re-sent unhandled failure notice bot=${row.id}`);
      } catch (e) {
        logger.warn(`[meeting-reconcile] notice re-send failed bot=${row.id}: ${(e as Error).message}`);
      }
    }
  } catch (e) {
    logger.warn(`[meeting-reconcile] unhandled-notice pass failed: ${(e as Error).message}`);
  }
}

export async function cleanUpCancelledBots(logger: Logger, now = new Date()): Promise<{ cleaned: number }> {
  if (!recallConfigured()) return { cleaned: 0 };
  const svc = serviceClient();
  const { data, error } = await svc
    .from("meeting_bots")
    .select("id, tenant_id, provider_bot_id, error")
    .eq("status", "cancelled")
    .is("media_deleted_at", null)
    .not("provider_bot_id", "is", null)
    .order("updated_at", { ascending: true })
    .limit(BATCH_CAP);
  if (error) {
    logger.warn(`[meeting-reconcile] cancelled-bot scan failed: ${error.message}`);
    return { cleaned: 0 };
  }
  let cleaned = 0;
  for (const row of data ?? []) {
    const providerBotId = row.provider_bot_id as string;
    const markHandled = () =>
      svc
        .from("meeting_bots")
        .update({ media_deleted_at: now.toISOString() })
        .eq("id", row.id)
        .eq("status", "cancelled")
        .is("media_deleted_at", null);
    try {
      if (row.error === CANCEL_FAILED_ERROR) {
        const outcome = await cancelBot(providerBotId, { leaveIfInCall: true });
        await svc
          .from("meeting_bots")
          .update({ error: "cancelled_retried", updated_at: now.toISOString() })
          .eq("id", row.id)
          .eq("status", "cancelled")
          .eq("error", CANCEL_FAILED_ERROR);
        logger.info(`[meeting-reconcile] cancelled bot=${row.id} call-back retried (${outcome})`);
      }
      let remote: RecallBot | null;
      try {
        remote = await getBot(providerBotId);
      } catch (e) {
        if (!(e instanceof RecallHttpError && e.status === 404)) throw e;
        remote = null;
      }
      if (remote && !remote.ended) continue;
      if (remote && remote.recording_count > 0) await deleteBotMedia(providerBotId);
      const { error: upErr } = await markHandled();
      if (upErr) {
        logger.warn(`[meeting-reconcile] cancelled bot=${row.id} media deleted but not marked: ${upErr.message}`);
        continue;
      }
      cleaned += 1;
      logger.info(`[meeting-reconcile] cancelled bot=${row.id} media handled (recordings=${remote?.recording_count ?? 0})`);
    } catch (e) {
      logger.error(`[meeting-reconcile] cancelled bot=${row.id} cleanup failed: ${(e as Error).message}`);
    }
  }
  return { cleaned };
}

export const meetingReconcileFn = inngest.createFunction(
  { id: "meeting-reconcile", concurrency: 1 },
  { cron: "*/15 * * * *" },
  async ({ logger }) => {
    const out = await runMeetingReconcile(logger);
    const { cleaned } = await cleanUpCancelledBots(logger);
    const { deleted } = await retryRecordingDeletes(logger);
    const { repaired } = await repairUnsavedTranscripts(logger);
    return { ...out, cancelledCleaned: cleaned, savedRecordingsDeleted: deleted, unsavedTranscriptsRepaired: repaired };
  },
);
