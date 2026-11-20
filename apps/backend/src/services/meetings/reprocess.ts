
import { staffCrossTenantClient } from "@/services/tenant-client";
import { deleteRecordingAndMark, saveTranscriptFromRecording } from "@/services/meetings/recording-cleanup";
import { MEETING_NOTES_RETENTION_DAYS } from "@/services/meetings/recap-destination";
import { inngest } from "../../../workers/client";

export type ReprocessResult =
  | { ok: true; mode: "rerun"; queued: boolean; reads: "zavi" | "recall"; tenant_id: string }
  | { ok: true; mode: "save_transcript"; done: boolean; tenant_id: string }
  | { ok: true; mode: "past_30_days"; done: boolean; tenant_id: string }
  | {
      ok: false;
      reason: "not_found" | "cancelled" | "in_progress" | "nothing_to_do" | "nothing_to_read" | "update_failed" | "transcript_unavailable";
    };

export async function requestMeetingReprocess(
  meetingBotId: string,
  opts: { dry: boolean; rerun?: boolean; now?: Date },
): Promise<ReprocessResult> {
  const now = opts.now ?? new Date();
  const svc = staffCrossTenantClient("notetaker reprocess: staff re-runs one paged meeting by its id");
  const { data: bot, error } = await svc
    .from("meeting_bots")
    .select("id, tenant_id, status, error, provider_bot_id, media_deleted_at, created_at")
    .eq("id", meetingBotId)
    .maybeSingle();
  if (error) throw new Error(`meeting read failed: ${error.message}`);
  if (!bot) return { ok: false, reason: "not_found" };
  const tenantId = bot.tenant_id as string;
  if (bot.status === "cancelled") return { ok: false, reason: "cancelled" };
  if (bot.status !== "ingested" && bot.status !== "failed") return { ok: false, reason: "in_progress" };

  const { data: notes, error: notesErr } = await svc
    .from("meeting_notes")
    .select("transcript, delete_after")
    .eq("bot_id", bot.id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (notesErr) throw new Error(`saved transcript read failed: ${notesErr.message}`);
  const live = (deleteAfter: unknown) => Date.parse(String(deleteAfter)) > now.getTime();
  const saved = typeof notes?.transcript === "string" && notes.transcript.trim().length > 0 && live(notes.delete_after);
  const recordingKept = !bot.media_deleted_at && Boolean(bot.provider_bot_id);
  const summaryFailed = bot.status === "failed" || Boolean(bot.error) || opts.rerun === true;
  const target = { id: bot.id as string, provider_bot_id: bot.provider_bot_id as string };

  const createdMs = Date.parse(String(bot.created_at));
  if (!Number.isFinite(createdMs) || createdMs < now.getTime() - MEETING_NOTES_RETENTION_DAYS * 86_400_000) {
    if (!recordingKept) return { ok: false, reason: "nothing_to_read" };
    if (!opts.dry) await deleteRecordingAndMark(svc, target, now);
    return { ok: true, mode: "past_30_days", done: !opts.dry, tenant_id: tenantId };
  }

  if (!saved && !recordingKept) return { ok: false, reason: "nothing_to_read" };
  if (!summaryFailed) {
    if (saved) return { ok: false, reason: "nothing_to_do" };
    if (opts.dry) return { ok: true, mode: "save_transcript", done: false, tenant_id: tenantId };
    const out = await saveTranscriptFromRecording(
      svc,
      { id: target.id, tenant_id: tenantId, provider_bot_id: target.provider_bot_id },
      { updateExisting: Boolean(notes), deleteAfter: new Date(createdMs + MEETING_NOTES_RETENTION_DAYS * 86_400_000), now },
    );
    if (out === "unavailable") return { ok: false, reason: "transcript_unavailable" };
    return { ok: true, mode: "save_transcript", done: true, tenant_id: tenantId };
  }

  const reads = saved ? ("zavi" as const) : ("recall" as const);
  if (opts.dry) return { ok: true, mode: "rerun", queued: false, reads, tenant_id: tenantId };
  const { data: reopened, error: upErr } = await svc
    .from("meeting_bots")
    .update({ status: "failed", summary_email_sent_at: null, default_slack_posted_at: null, updated_at: now.toISOString() })
    .eq("id", bot.id)
    .eq("status", bot.status as string)
    .select("id");
  if (upErr || !reopened || reopened.length === 0) return { ok: false, reason: "update_failed" };

  await inngest.send({
    id: `notetaker-reprocess:${bot.id}:${now.getTime()}`,
    name: "meeting.bot.status",
    data: { meeting_bot_id: bot.id as string, tenant_id: tenantId, event: "reprocess" },
  });
  return { ok: true, mode: "rerun", queued: true, reads, tenant_id: tenantId };
}
