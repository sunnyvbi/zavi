
import { globalClient } from "@/services/tenant-client";
import { isDefiniteSendRejection } from "@/services/onboarding-emails/send-errors";

const TABLE = "customer_email_once";

export const IN_FLIGHT_STALE_MS = 10 * 60_000;

export type SendOnceOutcome = "sent" | "already_sent" | "uncertain";

export class SendInFlightError extends Error {
  constructor(key: string) {
    super(`send-once: ${key} is being sent by another caller; retry`);
    this.name = "SendInFlightError";
  }
}

type Client = ReturnType<typeof globalClient>;

export async function sendOnce(
  dedupeKey: string,
  send: () => Promise<void>,
  deps: { client?: Client; warn?: (msg: string) => void; now?: () => Date; releaseOnAnyError?: boolean } = {},
): Promise<SendOnceOutcome> {
  const sb = deps.client ?? globalClient();
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const now = deps.now ?? (() => new Date());

  const { data: claimed, error: claimErr } = await sb
    .from(TABLE)
    .upsert({ dedupe_key: dedupeKey, claimed_at: now().toISOString(), sent_at: null }, { onConflict: "dedupe_key", ignoreDuplicates: true })
    .select("dedupe_key");
  if (claimErr) throw new Error(`send-once claim failed: ${claimErr.message}`);
  if (!(Array.isArray(claimed) && claimed.length > 0)) {
    const { data: held, error: readErr } = await sb
      .from(TABLE)
      .select("claimed_at, sent_at")
      .eq("dedupe_key", dedupeKey)
      .maybeSingle();
    if (readErr) throw new Error(`send-once read failed: ${readErr.message}`);
    const row = held as { claimed_at: string; sent_at: string | null } | null;
    if (!row) throw new SendInFlightError(dedupeKey);
    if (row.sent_at) return "already_sent";
    if (now().getTime() - new Date(row.claimed_at).getTime() >= IN_FLIGHT_STALE_MS) return "already_sent";
    throw new SendInFlightError(dedupeKey);
  }

  try {
    await send();
  } catch (e) {
    if (deps.releaseOnAnyError || isDefiniteSendRejection(e)) {
      const { error: relErr } = await sb.from(TABLE).delete().eq("dedupe_key", dedupeKey).is("sent_at", null);
      if (relErr) warn(`[send-once] release failed for ${dedupeKey}: ${relErr.message}`);
      throw e;
    }
    warn(`[send-once] ${dedupeKey}: send outcome unknown, kept as sent: ${(e as Error).message}`);
    const { error: stampErr } = await sb.from(TABLE).update({ sent_at: now().toISOString() }).eq("dedupe_key", dedupeKey);
    if (stampErr) warn(`[send-once] stamp failed for ${dedupeKey}: ${stampErr.message}`);
    return "uncertain";
  }
  const { error: confirmErr } = await sb.from(TABLE).update({ sent_at: now().toISOString() }).eq("dedupe_key", dedupeKey);
  if (confirmErr) warn(`[send-once] confirm failed for ${dedupeKey}: ${confirmErr.message}`);
  return "sent";
}
