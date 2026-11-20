
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { getNumberSetting } from "@/services/settings";
import type { NoteSurface } from "./signals";

export class TeamNoteError extends Error {
  constructor(public code: "forbidden" | "invalid" | "failed", message: string) {
    super(message);
  }
}

function mapError(err: { code?: string; message?: string } | null): never {
  if (err?.code === "42501") throw new TeamNoteError("forbidden", "Not your chat.");
  if (err?.code === "22023") throw new TeamNoteError("invalid", "That note is too long or empty.");
  throw new TeamNoteError("failed", err?.message ?? "rpc failed");
}

async function caps(tenantId: string) {
  const [perThread, windowHours, perDay, stopAfter] = await Promise.all([
    getNumberSetting("team_note_max_per_thread", tenantId),
    getNumberSetting("team_note_thread_window_hours", tenantId),
    getNumberSetting("team_note_max_per_day", tenantId),
    getNumberSetting("team_note_stop_offer_after_dismissals", tenantId),
  ]);
  return { perThread, windowHours, perDay, stopAfter };
}

export type OfferEvent = { signal?: string; source?: string };

export async function canOffer(tenantId: string, messageId: string, opts: { applyCaps: boolean }): Promise<string> {
  const c = await caps(tenantId);
  const { data, error } = await tenantRpc(asTenantId(tenantId), "team_note_can_offer_v2", {
    p_message_id: messageId, p_max_per_thread: c.perThread,
    p_thread_window_hours: c.windowHours, p_max_per_day: c.perDay, p_apply_caps: opts.applyCaps,
  });
  if (error) mapError(error);
  return String(data ?? "not_found");
}

export type ClaimResult = "claimed" | "upgraded" | "offered" | "taken" | "not_found";

export async function claimJudgement(
  tenantId: string, messageId: string, source: string, signals: string[], runHardFailed: boolean,
): Promise<ClaimResult> {
  const { data, error } = await tenantRpc(asTenantId(tenantId), "team_note_claim_judgement_v2", {
    p_message_id: messageId, p_source: source, p_signals: signals, p_run_hard_failed: runHardFailed,
  });
  if (error) mapError(error);
  const r = String(data ?? "taken");
  return (["claimed", "upgraded", "offered", "taken", "not_found"] as const).includes(r as ClaimResult)
    ? (r as ClaimResult)
    : "taken";
}

export async function offerNote(tenantId: string, args: {
  messageId: string; source: string; signal: string; signals: string[]; fingerprint: string; note: string;
  surface: NoteSurface; anchorMessageId: string | null;
}): Promise<{ offered: boolean; reason?: string; offer_id?: string }> {
  const { data, error } = await tenantRpc(asTenantId(tenantId), "team_note_offer_v2", {
    p_message_id: args.messageId, p_source: args.source, p_signal: args.signal, p_signals: args.signals,
    p_fingerprint: args.fingerprint, p_note: args.note,
    p_surface: args.surface, p_anchor_message_id: args.anchorMessageId,
  });
  if (error) mapError(error);
  return data as { offered: boolean; reason?: string; offer_id?: string };
}

export async function promoteNote(tenantId: string, args: {
  messageId: string; anchorMessageId: string; signals: string[];
}): Promise<{ promoted: boolean; reason?: string; offer_id?: string; status?: string }> {
  const { data, error } = await tenantRpc(asTenantId(tenantId), "team_note_promote_v2", {
    p_message_id: args.messageId, p_anchor_message_id: args.anchorMessageId, p_signals: args.signals,
  });
  if (error) mapError(error);
  return data as { promoted: boolean; reason?: string; offer_id?: string; status?: string };
}

export type JudgementVerdict = "bad" | "no" | "transport" | "parse";

export async function recordJudgement(tenantId: string, args: {
  messageId: string; source: string; signals: string[]; verdict: JudgementVerdict;
  judgeSignal: string | null; surface: NoteSurface | null;
}): Promise<boolean> {
  const { data, error } = await tenantRpc(asTenantId(tenantId), "team_note_record_judgement_v2", {
    p_message_id: args.messageId, p_source: args.source, p_signals: args.signals, p_verdict: args.verdict,
    p_judge_signal: args.judgeSignal, p_surface: args.surface,
  });
  if (error) mapError(error);
  return data === true;
}

export type ShownVia = "strip" | "flag";

export async function markShown(tenantId: string, actor: string, messageId: string, via: ShownVia) {
  const c = await caps(tenantId);
  const { data, error } = await tenantRpc(asTenantId(tenantId), "team_note_mark_shown_v2", {
    p_actor: actor, p_message_id: messageId, p_max_per_thread: c.perThread,
    p_thread_window_hours: c.windowHours, p_max_per_day: c.perDay, p_stop_after: c.stopAfter, p_via: via,
  });
  if (error) mapError(error);
  return data as {
    show: boolean; reason?: string; offer_stop?: boolean; first?: boolean; offer_id?: string; via?: ShownVia | null;
  } & OfferEvent;
}

export async function sendNote(tenantId: string, actor: string, messageId: string, note: string, extra: string | null) {
  const days = await getNumberSetting("team_note_retention_days", tenantId);
  const { data, error } = await tenantRpc(asTenantId(tenantId), "team_note_send", {
    p_actor: actor, p_message_id: messageId, p_note: note, p_extra: extra, p_retention_days: days,
  });
  if (error) mapError(error);
  return data as {
    status: "sent" | "not_found" | "not_offered" | "closed"; report_id?: string; first?: boolean;
    ping_id?: number | null;
  } & OfferEvent;
}

export async function dismissNote(tenantId: string, actor: string, messageId: string, stop: boolean) {
  const { data, error } = await tenantRpc(asTenantId(tenantId), "team_note_dismiss", {
    p_actor: actor, p_message_id: messageId, p_stop: stop,
  });
  if (error) mapError(error);
  return data as { status: "dismissed" | "closed" | "not_found" } & OfferEvent;
}

export async function markOpened(tenantId: string, actor: string, messageId: string) {
  const { data, error } = await tenantRpc(asTenantId(tenantId), "team_note_mark_opened", {
    p_actor: actor, p_message_id: messageId,
  });
  if (error) mapError(error);
  return data as { status: "opened" | "not_offered" | "not_found" } & OfferEvent;
}

export async function setSuggestionsOff(tenantId: string, actor: string, off: boolean): Promise<void> {
  const { error } = await tenantRpc(asTenantId(tenantId), "team_note_set_suggestions", { p_actor: actor, p_off: off });
  if (error) mapError(error);
}

export async function getSuggestionsOff(tenantId: string, actor: string): Promise<boolean> {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("team_note_prefs")
    .select("suggestions_off")
    .eq("user_id", actor)
    .limit(1);
  if (error) mapError(error);
  return ((data ?? []) as Array<{ suggestions_off?: boolean }>)[0]?.suggestions_off === true;
}
