
import type { SupabaseClient } from "@supabase/supabase-js";
import { cancelBot, type CancelBotOutcome } from "./recall";
import { logEvent } from "@/services/logging/logEvent";

type Svc = SupabaseClient;

export type CancelReason = "notetaker_off" | "link_cleared";

export const CANCELLED_NOTE = "Today's Zavi Notetaker was cancelled, so it won't join or record that meeting.";

export const IN_CALL_KEPT_NOTE =
  "Zavi Notetaker is already in today's meeting and will keep recording it. Your change starts with the next meeting. Remove Zavi Notetaker from the call if you don't want this meeting recorded.";

export const CANCEL_FAILED_MESSAGE =
  "We couldn't cancel the booked Zavi Notetaker. Remove it from the meeting manually.";

export const CANCEL_CHECK_FAILED_MESSAGE =
  "We couldn't check for a booked Zavi Notetaker. If one joins today's meeting, remove it manually.";

export const CANCEL_FAILED_ERROR = "cancel_failed";

const LIVE_STATUSES = ["scheduled", "joining", "in_call"];
const CANCELLABLE_STATUSES = ["scheduled", "joining", "in_call", "call_ended", "processing", "failed", "cancelled"];
const MAX_ROWS = 20;

type BotRow = { id: string; status: string; source: string | null; error: string | null; provider_bot_id: string | null };

export type CancelSummary = { cancelled: number; failed: number; kept_in_call: number };

export function cancelResponse(summary: CancelSummary | null): { note?: string; cancel_error?: string } {
  if (!summary) return { cancel_error: CANCEL_CHECK_FAILED_MESSAGE };
  if (summary.failed > 0) return { cancel_error: CANCEL_FAILED_MESSAGE };
  if (summary.kept_in_call > 0) return { note: IN_CALL_KEPT_NOTE };
  if (summary.cancelled > 0) return { note: CANCELLED_NOTE };
  return {};
}

function reasonCode(reason: CancelReason): string {
  return reason === "notetaker_off" ? "cancelled_notetaker_off" : "cancelled_link_cleared";
}

async function logCancel(
  tenantId: string,
  rowId: string,
  reason: CancelReason,
  outcome: CancelBotOutcome | "not_created" | "failed",
  detail?: string,
): Promise<void> {
  const failed = outcome === "failed";
  await logEvent({
    level: failed ? "error" : "info",
    source: "notetaker-settings",
    code: failed ? "meeting_bot.cancel_failed" : "meeting_bot.cancelled",
    tenant_id: tenantId,
    message: failed
      ? `could not cancel meeting bot ${rowId} (${reason}): ${detail ?? "unknown error"}`
      : `cancelled meeting bot ${rowId} (${reason}, ${outcome})`,
    meta: { object_id: rowId, skipped_reason: reason, stage: outcome },
  });
}

async function markCancelled(
  svc: Svc,
  tenantId: string,
  rowId: string,
  patch: Record<string, unknown>,
  onlyWithoutProviderBot = false,
): Promise<boolean> {
  let q = svc
    .from("meeting_bots")
    .update({ status: "cancelled", ...patch, updated_at: new Date().toISOString() })
    .eq("id", rowId)
    .eq("tenant_id", tenantId)
    .in("status", CANCELLABLE_STATUSES);
  if (onlyWithoutProviderBot) q = q.is("provider_bot_id", null);
  const { data, error } = await q.select("id");
  if (error) throw new Error(`cancel write failed: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

async function cancelOne(
  svc: Svc,
  tenantId: string,
  row: BotRow,
  reason: CancelReason,
): Promise<"cancelled" | "failed" | "kept_in_call" | "skipped"> {
  try {
    if (!row.provider_bot_id) {
      if (await markCancelled(svc, tenantId, row.id, { error: reasonCode(reason) }, true)) {
        await logCancel(tenantId, row.id, reason, "not_created");
        return "cancelled";
      }
      const { data: fresh, error } = await svc
        .from("meeting_bots")
        .select("id, status, source, error, provider_bot_id")
        .eq("id", row.id)
        .eq("tenant_id", tenantId)
        .maybeSingle();
      if (error) throw new Error(`bot re-read failed: ${error.message}`);
      const next = fresh as BotRow | null;
      if (!next?.provider_bot_id || !CANCELLABLE_STATUSES.includes(next.status)) return "skipped";
      if (next.status === "cancelled" && next.error !== CANCEL_FAILED_ERROR) return "skipped";
      row = next;
    }

    const outcome = await cancelBot(row.provider_bot_id as string, { leaveIfInCall: reason === "notetaker_off" });
    if (outcome === "in_call") return "kept_in_call";
    const wrote = await markCancelled(svc, tenantId, row.id, {
      error: reasonCode(reason),
      ...(outcome === "deleted" ? { media_deleted_at: new Date().toISOString() } : {}),
    });
    if (!wrote) return "skipped";
    await logCancel(tenantId, row.id, reason, outcome);
    return "cancelled";
  } catch (e) {
    const detail = (e as Error).message;
    await markCancelled(svc, tenantId, row.id, { error: CANCEL_FAILED_ERROR }).catch(() => false);
    await logCancel(tenantId, row.id, reason, "failed", detail);
    return "failed";
  }
}

export async function cancelSentBots(svc: Svc, tenantId: string, reason: CancelReason): Promise<CancelSummary> {
  const lookup = (statuses: string[], failedOnly: boolean) => {
    let q = svc
      .from("meeting_bots")
      .select("id, status, source, error, provider_bot_id")
      .eq("tenant_id", tenantId)
      .in("status", statuses);
    if (failedOnly) q = q.eq("error", CANCEL_FAILED_ERROR);
    if (reason === "link_cleared") q = q.eq("source", "scheduled");
    return q.order("scheduled_for", { ascending: false }).limit(MAX_ROWS);
  };
  const [live, retry] = await Promise.all([lookup(LIVE_STATUSES, false), lookup(["cancelled"], true)]);
  if (live.error) throw new Error(`live bot lookup failed: ${live.error.message}`);
  if (retry.error) throw new Error(`failed-cancel lookup failed: ${retry.error.message}`);

  const summary: CancelSummary = { cancelled: 0, failed: 0, kept_in_call: 0 };
  for (const row of [...(live.data ?? []), ...(retry.data ?? [])] as BotRow[]) {
    if (reason === "link_cleared" && row.status === "in_call") {
      summary.kept_in_call += 1;
      continue;
    }
    const result = await cancelOne(svc, tenantId, row, reason);
    if (result === "cancelled") summary.cancelled += 1;
    else if (result === "failed") summary.failed += 1;
    else if (result === "kept_in_call") summary.kept_in_call += 1;
  }
  return summary;
}

export type AttachResult = "attached" | "cancelled" | "attach_failed";

export async function attachBotOrCallBack(
  svc: Svc,
  tenantId: string,
  rowId: string,
  providerBotId: string,
  source: string,
): Promise<AttachResult> {
  const { data, error } = await svc
    .from("meeting_bots")
    .update({ provider_bot_id: providerBotId, updated_at: new Date().toISOString() })
    .eq("id", rowId)
    .eq("tenant_id", tenantId)
    .eq("status", "scheduled")
    .select("id");
  if (!error && Array.isArray(data) && data.length > 0) return "attached";

  const result: AttachResult = error ? "attach_failed" : "cancelled";
  const keep = async (patch: Record<string, unknown>) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const { error: writeErr } = await svc.from("meeting_bots").update(patch).eq("id", rowId).eq("tenant_id", tenantId);
        if (!writeErr) return;
      } catch {
      }
    }
    await logEvent({
      level: "error",
      source,
      code: "meeting_bot.untracked",
      tenant_id: tenantId,
      message: `could not record Recall bot ${providerBotId} on meeting bot row ${rowId} (${result}); clean it up in Recall by hand`,
      meta: { object_id: rowId, stage: result },
    });
  };
  await keep(
    result === "attach_failed"
      ? { provider_bot_id: providerBotId, status: "cancelled", error: "attach_failed", updated_at: new Date().toISOString() }
      : { provider_bot_id: providerBotId },
  );
  try {
    const outcome = await cancelBot(providerBotId, { leaveIfInCall: true });
    if (outcome === "deleted") await keep({ media_deleted_at: new Date().toISOString() });
    await logEvent({
      level: result === "attach_failed" ? "warn" : "info",
      source,
      code: "meeting_bot.cancelled",
      tenant_id: tenantId,
      message: `called back meeting bot ${rowId} right after creating it (${result}, ${outcome})`,
      meta: { object_id: rowId, stage: outcome, skipped_reason: result },
    });
  } catch (e) {
    const detail = (e as Error).message;
    await keep({ error: CANCEL_FAILED_ERROR, updated_at: new Date().toISOString() });
    await logEvent({
      level: "error",
      source,
      code: "meeting_bot.cancel_failed",
      tenant_id: tenantId,
      message: `could not call back meeting bot ${rowId} after creating it (${result}): ${detail}`,
      meta: { object_id: rowId, stage: "failed", skipped_reason: result },
    });
  }
  return result;
}
