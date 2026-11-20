
import type { SupabaseClient } from "@supabase/supabase-js";
import { fleetSweepClient } from "@/services/tenant-client";
import { deleteBotMedia, fetchTranscript, getBot, recallConfigured, RecallHttpError, transcriptToText } from "@/services/meetings/recall";
import { MEETING_NOTES_RETENTION_DAYS } from "@/services/meetings/recap-destination";

type Logger = { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };

const SWEEP_BATCH = 25;
export const RECORDING_DELETE_GRACE_MS = 30 * 60 * 1000;
export const NEW_RULES_FROM = new Date("2026-10-27T00:00:00.000Z");
const REPAIR_MIN_AGE_MS = 60 * 60 * 1000;
const REPAIR_BATCH = 10;
const RETENTION_MS = MEETING_NOTES_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export type RecordingDeleteOutcome = "deleted" | "gone";

export async function deleteRecordingAndMark(
  svc: SupabaseClient,
  row: { id: string; provider_bot_id: string },
  now: Date,
): Promise<RecordingDeleteOutcome> {
  let outcome: RecordingDeleteOutcome = "deleted";
  try {
    await deleteBotMedia(row.provider_bot_id);
  } catch (e) {
    if (!(e instanceof RecallHttpError && e.status === 404)) throw e;
    outcome = "gone";
  }
  const { error } = await svc
    .from("meeting_bots")
    .update({ media_deleted_at: now.toISOString() })
    .eq("id", row.id)
    .is("media_deleted_at", null);
  if (error) throw new Error(`recording deleted at Recall but not marked: ${error.message}`);
  return outcome;
}

export async function retryRecordingDeletes(logger: Logger, now = new Date()): Promise<{ deleted: number }> {
  if (!recallConfigured()) return { deleted: 0 };
  const svc = fleetSweepClient("meeting recordings: retry the Recall delete for processed meetings across tenants");
  const graceCutoff = new Date(now.getTime() - RECORDING_DELETE_GRACE_MS).toISOString();
  const saved = svc
    .from("meeting_bots")
    .select("id, tenant_id, provider_bot_id, meeting_notes!inner(tenant_id, transcript, delete_after)")
    .neq("meeting_notes.transcript", "")
    .eq("status", "ingested")
    .is("media_deleted_at", null)
    .not("provider_bot_id", "is", null)
    .lt("updated_at", graceCutoff)
    .order("updated_at", { ascending: true })
    .limit(SWEEP_BATCH);
  const empty = svc
    .from("meeting_bots")
    .select("id, tenant_id, provider_bot_id")
    .eq("status", "ingested")
    .eq("transcript_chars", 0)
    .is("media_deleted_at", null)
    .not("provider_bot_id", "is", null)
    .lt("updated_at", graceCutoff)
    .order("updated_at", { ascending: true })
    .limit(SWEEP_BATCH);
  const scans = [
    { what: "transcript saved in Zavi", query: saved, needsNotes: true },
    { what: "empty capture", query: empty, needsNotes: false },
  ] as const;
  let deleted = 0;
  for (const { what, query, needsNotes } of scans) {
    const { data, error } = await query;
    if (error) {
      logger.warn(`[recording-cleanup] ${what} scan failed: ${error.message}`);
      continue;
    }
    for (const row of (data ?? []) as unknown as SweepRow[]) {
      if (needsNotes && !savedTranscript(row, now)) continue;
      try {
        const outcome = await deleteRecordingAndMark(svc, row, now);
        deleted += 1;
        logger.info(`[recording-cleanup] bot=${row.id} recording ${outcome === "gone" ? "already gone at Recall" : "deleted"} (${what})`);
      } catch (e) {
        logger.error(`[recording-cleanup] bot=${row.id} delete failed: ${(e as Error).message}`);
      }
    }
  }
  return { deleted };
}

export async function saveTranscriptFromRecording(
  svc: SupabaseClient,
  bot: { id: string; tenant_id: string; provider_bot_id: string },
  opts: { updateExisting: boolean; deleteAfter: Date; now: Date },
): Promise<"saved" | "unavailable"> {
  const remote = await getBot(bot.provider_bot_id);
  if (!remote.transcript_download_url) return "unavailable";
  const text = transcriptToText(await fetchTranscript(remote.transcript_download_url));
  if (!text.trim()) return "unavailable";
  const { error: saveErr } = opts.updateExisting
    ? await svc.from("meeting_notes").update({ transcript: text }).eq("bot_id", bot.id).eq("tenant_id", bot.tenant_id)
    : await svc.from("meeting_notes").insert({
        bot_id: bot.id,
        tenant_id: bot.tenant_id,
        minutes: null,
        transcript: text,
        delete_after: opts.deleteAfter.toISOString(),
      });
  if (saveErr) throw new Error(`transcript save failed (recording kept): ${saveErr.message}`);
  const { data: check, error: checkErr } = await svc
    .from("meeting_notes")
    .select("transcript, delete_after")
    .eq("bot_id", bot.id)
    .eq("tenant_id", bot.tenant_id)
    .maybeSingle();
  if (checkErr || check?.transcript !== text || !(Date.parse(String(check?.delete_after)) > opts.now.getTime())) {
    throw new Error("transcript not confirmed saved (recording kept)");
  }
  await deleteRecordingAndMark(svc, bot, opts.now);
  return "saved";
}

export async function repairUnsavedTranscripts(logger: Logger, now = new Date()): Promise<{ repaired: number }> {
  if (!recallConfigured()) return { repaired: 0 };
  const svc = fleetSweepClient("meeting recordings: save a transcript that failed to save, then delete the recording");
  const { data, error } = await svc
    .from("meeting_bots")
    .select("id, tenant_id, provider_bot_id, created_at")
    .eq("status", "ingested")
    .gt("transcript_chars", 0)
    .is("media_deleted_at", null)
    .not("provider_bot_id", "is", null)
    .gte("created_at", NEW_RULES_FROM.toISOString())
    .lt("updated_at", new Date(now.getTime() - REPAIR_MIN_AGE_MS).toISOString())
    .order("updated_at", { ascending: true })
    .limit(REPAIR_BATCH);
  if (error) {
    logger.warn(`[recording-cleanup] unsaved-transcript scan failed: ${error.message}`);
    return { repaired: 0 };
  }
  let repaired = 0;
  for (const row of (data ?? []) as Array<{ id: string; tenant_id: string; provider_bot_id: string; created_at: string }>) {
    try {
      const { data: notes, error: notesErr } = await svc.from("meeting_notes").select("bot_id").eq("bot_id", row.id).maybeSingle();
      if (notesErr || notes) continue;
      const endsAt = Date.parse(String(row.created_at)) + RETENTION_MS;
      if (!(endsAt > now.getTime())) {
        const outcome = await deleteRecordingAndMark(svc, row, now);
        logger.info(`[recording-cleanup] bot=${row.id} past its 30 days: recording ${outcome === "gone" ? "already gone" : "deleted"}`);
        continue;
      }
      const out = await saveTranscriptFromRecording(svc, row, { updateExisting: false, deleteAfter: new Date(endsAt), now });
      if (out === "saved") {
        repaired += 1;
        logger.info(`[recording-cleanup] bot=${row.id} transcript saved from the kept recording, recording deleted`);
      } else {
        const retryAt = new Date(Math.min(now.getTime(), endsAt - REPAIR_MIN_AGE_MS));
        await svc.from("meeting_bots").update({ updated_at: retryAt.toISOString() }).eq("id", row.id).eq("status", "ingested");
        logger.warn(`[recording-cleanup] bot=${row.id} kept recording has no readable transcript yet; tried again later`);
      }
    } catch (e) {
      logger.error(`[recording-cleanup] bot=${row.id} transcript repair failed: ${(e as Error).message}`);
    }
  }
  return { repaired };
}

type SweepRow = {
  id: string;
  tenant_id: string;
  provider_bot_id: string;
  meeting_notes?: NotesEmbed | NotesEmbed[] | null;
};
type NotesEmbed = { tenant_id?: string | null; transcript?: string | null; delete_after?: string | null };

function savedTranscript(row: SweepRow, now: Date): boolean {
  const notes = Array.isArray(row.meeting_notes) ? row.meeting_notes : row.meeting_notes ? [row.meeting_notes] : [];
  return notes.some(
    (n) =>
      n.tenant_id === row.tenant_id &&
      typeof n.transcript === "string" &&
      n.transcript.trim().length > 0 &&
      Date.parse(String(n.delete_after)) > now.getTime(),
  );
}

export type KeptRecording = {
  id: string;
  tenant_id: string;
  provider_bot_id: string;
  scheduled_date: string | null;
  transcript_chars: number | null;
  error: string | null;
};

export async function deleteKeptRecordings(opts: {
  dry: boolean;
  now?: Date;
  log: (line: string) => void;
}): Promise<{ found: number; deleted: number; gone: number; failed: number }> {
  const now = opts.now ?? new Date();
  const svc = fleetSweepClient("meeting recordings: one-off delete of recordings kept at Recall, across tenants");
  const { data, error } = await svc
    .from("meeting_bots")
    .select("id, tenant_id, provider_bot_id, scheduled_date, transcript_chars, error")
    .eq("status", "ingested")
    .is("media_deleted_at", null)
    .not("provider_bot_id", "is", null)
    .lt("created_at", NEW_RULES_FROM.toISOString())
    .lt("updated_at", new Date(now.getTime() - RECORDING_DELETE_GRACE_MS).toISOString())
    .order("created_at", { ascending: true });
  if (error) throw new Error(`kept-recordings scan failed: ${error.message}`);
  const rows = (data ?? []) as KeptRecording[];

  const slugs = new Map<string, string>();
  const tenantIds = [...new Set(rows.map((r) => r.tenant_id))];
  if (tenantIds.length > 0) {
    const { data: tenants } = await svc.from("tenants").select("id, slug").in("id", tenantIds);
    for (const t of (tenants ?? []) as Array<{ id: string; slug: string | null }>) slugs.set(t.id, t.slug ?? t.id);
  }
  const label = (r: KeptRecording) =>
    `${r.id} ${slugs.get(r.tenant_id) ?? r.tenant_id} ${r.scheduled_date ?? "?"} transcript_chars=${r.transcript_chars ?? 0}${r.error ? " (summary failed)" : ""}`;

  opts.log(
    `${rows.length} recording(s) still kept at Recall for meetings created before ${NEW_RULES_FROM.toISOString()} (their transcripts are not in Zavi)${opts.dry ? " (dry run: nothing is deleted)" : ""}`,
  );
  if (opts.dry) {
    for (const r of rows) opts.log(`  would delete  ${label(r)}`);
    return { found: rows.length, deleted: 0, gone: 0, failed: 0 };
  }
  if (rows.length > 0 && !recallConfigured()) throw new Error("RECALL_API_KEY is not set; nothing was deleted");

  let deleted = 0;
  let gone = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      const outcome = await deleteRecordingAndMark(svc, r, now);
      if (outcome === "gone") gone += 1;
      else deleted += 1;
      opts.log(`  ${outcome === "gone" ? "already gone" : "deleted     "}  ${label(r)}`);
    } catch (e) {
      failed += 1;
      opts.log(`  FAILED        ${label(r)}: ${(e as Error).message}`);
    }
  }
  opts.log(`deleted=${deleted} already_gone=${gone} failed=${failed}${failed > 0 ? " (run again to retry the failed ones)" : ""}`);
  return { found: rows.length, deleted, gone, failed };
}
