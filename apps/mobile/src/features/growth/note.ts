
import type { GrowthChannel, HeadOfGrowth, HogNote, NoteRowUndo, NoteSection } from "./plan";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MISTAKE_WINDOW_MS = 30 * 86_400_000;

export function dayLabel(iso: string | undefined | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

export function withinWindow(iso: string | null | undefined, now: number = Date.now()): boolean {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) && t >= now - MISTAKE_WINDOW_MS;
}

export function nextLine(hog: HeadOfGrowth): string | null {
  const next = dayLabel(hog.note?.next_review_at);
  if (!next) return null;
  return hog.autopilot ? `Next check-in ${next}` : `Next note ${next}`;
}

export function shownSections(note: HogNote | null): NoteSection[] {
  return (note?.sections ?? [])
    .map((sec) => (sec.key === "needs_you" ? { ...sec, rows: sec.rows.filter((r) => r.question_ordinal == null) } : sec))
    .filter((sec) => sec.rows.length > 0 || sec.more);
}

export type Claim = { kind: "goal"; goal_id: string } | { kind: "channel"; channel_slug: string };

export function undoLive(u: NoteRowUndo, hog: HeadOfGrowth, channels: readonly GrowthChannel[], now: number = Date.now()): Claim | null {
  if (u.kind === "goal") {
    const hit = hog.undoable.find((x) => x.goal_id === u.goal_id && withinWindow(x.at, now));
    return hit ? { kind: "goal", goal_id: u.goal_id } : null;
  }
  const ch = channels.find((c) => c.slug === u.channel_slug && c.cgo_reason && !c.plan_selected && withinWindow(c.cgo_set_at, now));
  return ch ? { kind: "channel", channel_slug: u.channel_slug } : null;
}

export function claimForLine(
  line: string,
  hog: HeadOfGrowth,
  channels: readonly GrowthChannel[],
  nameOf: (slug: string) => string,
  now: number = Date.now(),
): Claim | null {
  const hits = hog.undoable.filter((u) => u.prev_objective && withinWindow(u.at, now) && line.startsWith(`Goal "${u.prev_objective}"`));
  if (hits.length === 1) return { kind: "goal", goal_id: hits[0].goal_id };
  const paused = channels.find(
    (c) => c.cgo_reason && !c.plan_selected && withinWindow(c.cgo_set_at, now) && line.startsWith(`Paused ${nameOf(c.slug)}.`),
  );
  return paused ? { kind: "channel", channel_slug: paused.slug } : null;
}

export function claimKey(c: Claim): string {
  return c.kind === "goal" ? `goal:${c.goal_id}` : `channel:${c.channel_slug}`;
}

export function rowKey(u: NoteRowUndo | undefined, sectionKey: string, index: number): string {
  return u ? claimKey(u) : `row:${sectionKey}:${index}`;
}

export const CLAIM_ERROR = "Could not undo that. Try again.";
export const WRONG_CALL_LINE = "Wrong call? Mark it “This was a mistake” within 30 days and we refund the credits it used.";

export function claimError(e: { code?: string; message?: string } | null | undefined): string {
  return e?.code && !e.code.startsWith("http_") && e.message ? e.message : CLAIM_ERROR;
}

export function wouldChangeFooter(autopilot: boolean): string {
  return autopilot
    ? "Autopilot is on. I'll make these changes at my next check-in."
    : "Turn on Autopilot and I'll make these myself.";
}

export type ClaimReply = {
  claim_sent?: boolean;
  refund?: { status?: string; credits?: number; forfeited?: number; untracked?: number };
};

const RESET_NOTE = "Credits from a daily or monthly allowance that has reset since don't come back.";

export function claimOutcome(r: ClaimReply): string {
  const refund = r.refund;
  const checking =
    r.claim_sent === false
      ? "We couldn't file the rest automatically: email support@zaviagent.com and we'll refund what's owed."
      : "We're checking the rest and will refund what's owed within 1 business day.";
  if (refund?.status === "refunded") {
    const parts = [`Undone. We refunded ${(refund.credits ?? 0).toLocaleString("en-US")} credits to your wallet.`];
    if ((refund.forfeited ?? 0) > 0) parts.push(RESET_NOTE);
    if ((refund.untracked ?? 0) > 0) parts.push(checking);
    return parts.join(" ");
  }
  if (refund?.status === "untracked") {
    return r.claim_sent === false
      ? "Undone. We couldn't check its credits automatically: email support@zaviagent.com and we'll refund what's owed."
      : "Undone. We're checking which credits it used and will refund what's owed within 1 business day.";
  }
  if (refund?.status === "already_claimed") return "Undone. That check-in's credits were already handled by an earlier claim.";
  if (refund?.status === "expired") {
    return "Undone. The credits it used came from a daily or monthly allowance that has reset since, so there is nothing to refund.";
  }
  if (refund?.status === "already_refunded") return "Undone. The credits for that check-in were already refunded.";
  if (refund?.status === "nothing_charged") return "Undone. That change didn't use any credits.";
  return r.claim_sent === false
    ? "Undone. We couldn't file the refund automatically: email support@zaviagent.com and we'll refund it."
    : "Undone. We'll refund the credits it used to your wallet within 1 business day.";
}

export function noteLinkTarget(url: string): { kind: "channel"; slug: string; action: string | null } | { kind: "web"; url: string } {
  const q = url.indexOf("?");
  const params = new Map<string, string>();
  if (q >= 0) {
    for (const pair of url.slice(q + 1).split("#")[0].split("&")) {
      const [k, v = ""] = pair.split("=");
      if (k) params.set(decodeURIComponent(k), decodeURIComponent(v.replace(/\+/g, " ")));
    }
  }
  const channel = params.get("channel");
  if (params.get("tab") === "channels" && channel) return { kind: "channel", slug: channel, action: params.get("action") ?? null };
  return { kind: "web", url: `https://www.zaviagent.com${url}` };
}
