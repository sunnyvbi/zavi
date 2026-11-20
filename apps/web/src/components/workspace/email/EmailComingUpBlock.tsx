"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { CalendarClock, Check, ChevronDown, ChevronRight, Hand, MessageSquare, Send } from "lucide-react";
import { confirmAction } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/toast";
import { Skeleton } from "../Skeleton";
import { cn } from "@/lib/cn";
import {
  changePlannedAngle,
  confirmNotSent,
  draftPlannedNow,
  getPlan,
  isAmbiguousPlanError,
  movePlanned,
  plannedTooFar,
  plannedTooSoon,
  PLAN_TOO_FAR,
  PLAN_TOO_SOON,
  skipPlanned,
  timedFetch,
  wallInstant,
  wallParts,
  withdrawPlanned,
  type HeldSend,
  type PlanStatus,
  type PlanView,
  type PlannedEmail,
} from "@/lib/workspace/emailPlanApi";
import { getEmailTestLists, readFailureMessage } from "@/lib/workspace/emailCampaignSettingsApi";
import { PlanWhenFields } from "./PlanWhenFields";
import { useRereadWhileFailed } from "./useRereadWhileFailed";
import { useTabHidden } from "../layout/tabHidden";
import { announceEmailCardChanged, announceEmailPlanChanged, onEmailCardChanged, onEmailPlanChanged } from "@/lib/workspace/emailCardEvents";
import { useEmailCardAsk } from "./emailCardAsk";
import { TEST_LIST_LINE, TEST_LIST_UNKNOWN_LINE, type EmailCardView } from "@/components/email/EmailCampaignCard";
import { Chip, CtaPill, EW, EmailBox, EmailBoxGhost, GroupHead as DesignGroupHead, MetaRow, MoreMenu, useEmailPlanBridge, withMergeChips, type ChipTone } from "./EmailWorkDesign";
import { ITEM_CHIP, SENDER_UNAVAILABLE_LINE, cardOutcomeStatus, comingUpStatus } from "./comingUpStatus";

export { wallParts };

const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 focus-visible:ring-offset-1";
const BTN = `inline-flex h-9 min-h-[44px] cursor-pointer items-center gap-1.5 rounded-cta px-3 text-[13px] font-medium disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`;
const SECONDARY = `${BTN} border border-rule bg-white text-ink transition-colors hover:border-inkLight hover:bg-bone`;
const PRIMARY = `${BTN} bg-ink text-cream transition-opacity hover:opacity-90`;
const META_UP = "[&>[data-testid=email-card-meta]]:text-[14px] [&>[data-testid=email-card-meta]]:leading-5";
const LIST = "flex min-w-0 flex-col gap-5";
const DIVIDER = "mt-8 border-t border-rule pt-6";
const SECTION_TITLE = "flex min-w-0 items-center gap-2 text-[17px] font-semibold text-ink";
const FIELD = "h-9 rounded-[8px] border border-rule bg-white px-2 text-[14px] text-ink [color-scheme:light] [html.dark_&]:[color-scheme:dark]";

const SOURCE: Record<PlannedEmail["source"], string | null> = {
  email_agent: null,
  growth_agent: "Suggested by your growth plan",
  founder: "Planned by your team",
};

const DONE: readonly PlanStatus[] = ["sent", "skipped"];
const NO_DRAFT_LINK = new Set(["no_draft", "card_rejected", "skipped_by_founder", "not_sent_confirmed", "may_have_sent", "outcome_unknown", "test_list", "not_open", "redraft_required"]);
const OPEN_ONLY_LINK = new Set(["list_sent_recently"]);

export const comingUpPoll = { ms: 15_000 };

function zoneName(locale: string, iso: string, tz: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date(iso)).find((p) => p.type === "timeZoneName")?.value ?? "";
}

export function zoneAbbr(iso: string, tz: string): string {
  try {
    const us = zoneName("en-US", iso, tz);
    if (!/^(GMT|UTC)[+-]/.test(us)) return us;
    const gb = zoneName("en-GB", iso, tz);
    return /^(GMT|UTC)[+-]/.test(gb) ? us : gb;
  } catch {
    return "";
  }
}

const sameWall = (a: { date: string; time: string }, b: { date: string; time: string }) => a.date === b.date && a.time === b.time;

function cardHref(it: PlannedEmail): string | null {
  return it.card ? `/workspace/email-cards/${it.card.rail}/${it.card.id}` : null;
}

const AUTO_SEND_CAP = 1000;

type Unclear = (
  say: string,
  confirm: (v: PlanView) => boolean,
  track?: { key: string; what: string },
) => Promise<boolean>;
const UNCLEAR_LINE = "Zavi could not confirm this went through. Refresh to check.";

function announcePlannedChange(card: PlannedEmail["card"], source: string): void {
  if (card) announceEmailCardChanged({ rail: card.rail, id: card.id, source });
  else announceEmailPlanChanged(source);
}

function NotSentAction({ rail, cardId, origin, onUnclear }: { rail: HeldSend["rail"]; cardId: string; origin: string; onUnclear: Unclear }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const SAY = "Noted: it was not sent. The list is free for the next email.";
  const released = (v: PlanView) => v.released.includes(cardId);
  const check = () => onUnclear(SAY, released, { key: `card:${cardId}`, what: "I checked my email tool: this was not sent" });
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await confirmNotSent(rail, cardId, reason.trim());
      announceEmailCardChanged({ rail, id: cardId, source: origin });
      await check();
    } catch (e) {
      if (isAmbiguousPlanError(e)) {
        announceEmailCardChanged({ rail, id: cardId, source: origin });
        await check();
      } else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-testid="not-sent" className="mt-3">
      <p className="text-[13px] leading-[18px] text-inkMuted">
        Zavi could not confirm whether this went out, so it sends nothing else to this list. Check your email tool. If it went out, leave this as it is.
      </p>
      {!open ? (
        <button type="button" className={cn(SECONDARY, "mt-2")} onClick={() => setOpen(true)}>
          I checked my email tool: this was not sent
        </button>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          <input
            aria-label="What you checked"
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            className={cn(FIELD, "min-w-0 flex-1")}
            placeholder="e.g. Mailchimp shows it as a draft"
          />
          <button type="button" className={PRIMARY} disabled={busy || reason.trim().length === 0} onClick={() => void submit()}>
            Confirm not sent
          </button>
          <button type="button" className={SECONDARY} disabled={busy} onClick={() => setOpen(false)}>
            Cancel
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 flex flex-wrap items-center gap-2 text-[13px] text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function EmailComingUpItem({
  it,
  canAct,
  timezone,
  people,
  origin,
  onUnclear,
  onSkipped,
  onRetopiced,
}: {
  it: PlannedEmail;
  canAct: boolean;
  timezone: string;
  people: number | null;
  origin: string;
  onUnclear: Unclear;
  onSkipped: (id: string, cardId: string | null) => void;
  onRetopiced: (it: PlannedEmail, angle: string) => void;
}) {
  const [mode, setMode] = useState<"move" | "angle" | null>(null);
  const zone = it.timezone || timezone;
  const start = wallParts(it.planned_at, zone);
  const [date, setDate] = useState(start.date);
  const [time, setTime] = useState(start.time);
  const [angle, setAngle] = useState(it.angle);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const done = DONE.includes(it.status);
  const href = cardHref(it);
  const source = SOURCE[it.source];
  const overCap = people !== null && people > AUTO_SEND_CAP;

  const guard = useRef(false);
  const settle = async (u: { say: string; confirm: (now: PlannedEmail) => boolean; what: string }) => {
    const done = await onUnclear(
      u.say,
      (v) => {
        const now = v.items.find((x) => x.id === it.id);
        return !!now && u.confirm(now);
      },
      { key: `item:${it.id}`, what: `${u.what}: ${it.angle}` },
    );
    if (done) setMode(null);
  };
  const act = async (fn: () => Promise<unknown>, say: string, confirm: (now: PlannedEmail) => boolean, what: string) => {
    if (guard.current) return;
    guard.current = true;
    setBusy(true);
    setError(null);
    try {
      await fn();
      announcePlannedChange(it.card, origin);
      await settle({ say, confirm, what });
    } catch (e) {
      if (isAmbiguousPlanError(e)) {
        announcePlannedChange(it.card, origin);
        await settle({ say, confirm, what });
      } else setError((e as Error).message);
    } finally {
      guard.current = false;
      setBusy(false);
    }
  };

  const live = it.status === "planned" || it.status === "drafting" || it.status === "ready" || it.status === "scheduled";
  const abbr = zoneAbbr(it.planned_at, zone);
  const when = abbr ? `${it.planned_label} ${abbr}` : it.planned_label;
  const typedAt = wallInstant({ date, time }, zone);
  const moveAbbr = (typedAt && zoneAbbr(typedAt, zone)) || abbr;
  const moveNoteId = useId();
  const unchanged = sameWall(start, { date, time });
  const moveBlock: { text: string; tone: "bad" | "idle" } | null = !date || !time
    ? { text: "Pick a day and a time.", tone: "idle" }
    : unchanged
      ? { text: "Pick a new day or time to move it.", tone: "idle" }
      : plannedTooSoon({ date, time }, zone)
        ? { text: PLAN_TOO_SOON, tone: "bad" }
        : plannedTooFar({ date, time }, zone)
          ? { text: PLAN_TOO_FAR, tone: "bad" }
          : null;
  const moveNote = error ?? (moveBlock && moveBlock.tone === "bad" ? moveBlock.text : typedAt ? `${unchanged ? "Now" : "Sends"} ${dayTime(typedAt, zone)}${moveAbbr ? ` ${moveAbbr}` : ""}${moveBlock ? `. ${moveBlock.text}` : ""}` : moveBlock?.text ?? "");
  const skip = async () => {
    const ok = await confirmAction({
      title: "Skip this email?",
      description: `The email to ${it.list_name} planned for ${when} will not be sent.${it.card ? " Its draft is closed too, so nothing can be sent from it." : ""}`,
      confirmLabel: "Skip this email",
    });
    if (!ok) return;
    await act(async () => {
      await skipPlanned(it.id);
      onSkipped(it.id, it.card?.id ?? null);
    }, "Skipped.", (now) => now.status === "skipped" && now.status_reason === "skipped_by_founder", "Skip");
  };
  const saveTopic = async () => {
    if (angle.trim().toLowerCase() === it.angle.trim().toLowerCase()) return;
    const ok = await confirmAction({
      title: "Change the topic?",
      description: it.card
        ? "Zavi writes a new draft on the new topic. The current draft, and any approval it has, are replaced."
        : "Zavi drafts the email on the new topic 1 day before it sends.",
      confirmLabel: "Change topic",
    });
    if (!ok) return;
    await act(
      async () => {
        await changePlannedAngle(it.id, { angle, content_version: it.content_version });
        onRetopiced(it, angle.trim());
      },
      it.card ? "Changed. Zavi redrafts it; the old draft and any approval are replaced." : "Changed. Zavi drafts the new topic 1 day before.",
      (now) => now.content_version > it.content_version && now.angle === angle.trim(),
      "Change topic",
    );
  };
  const { view: card, settled: cardSettled, reload: reloadCard } = usePlannedCard(it.card, it.content_version);
  const cardRail = it.card?.rail ?? null;
  const cardId = it.card?.id ?? null;
  useEffect(() => {
    if (!cardRail || !cardId) return;
    return onEmailCardChanged((change) => {
      if (change.source !== origin && change.rail === cardRail && change.id === cardId) reloadCard();
    });
  }, [cardRail, cardId, origin, reloadCard]);
  const [testing, setTesting] = useState(false);
  const [testSay, setTestSay] = useState<string | null>(null);
  const ask = useEmailCardAsk(it.card?.id ?? null, it.angle);
  const versions = card?.versions ?? [];
  const chosen = it.scheduled?.variant ?? card?.chosen_variant ?? null;
  const vi = Math.max(0, versions.findIndex((x) => x.variant === chosen));
  const version = versions[vi] ?? null;
  const needsTest = !!card && !!version && card.viewer_can_approve && !card.test_list && !card.test_list_unknown && card.can_approve[vi] !== true && !version.tested_by_approver;
  const testList = !!card && (card.test_list === true || card.test_list_unknown === true);
  const showTestListLine = testList && card?.open === true;
  const stopped = it.vetoed && it.status === "ready";
  const draftAsked = it.status === "planned" && it.draft_requested === true;
  const shown = comingUpStatus(it);
  const writing = (draftAsked || it.status === "drafting") && !stopped && !shown.fromCard;
  const [chipLabel, chipTone] = shown.fromCard ? [shown.label, shown.tone] : stopped ? (["You stopped this send", "wait"] as [string, ChipTone]) : draftAsked ? ITEM_CHIP.drafting : [shown.label, shown.tone];
  const size = (card?.route === "zavi_list" ? card.list.people : null) ?? people ?? card?.list.people ?? null;
  const content = version?.content ?? null;
  const box = version ? [{
    subject: version.subject || content?.subject || it.angle,
    preview: (version.preview_text || content?.preview_text) ?? null,
    paragraphs: [
      ...(content?.paragraphs ?? []).map((p) => withMergeChips(p)),
      ...(content?.button?.label ? [<CtaPill key="cta" label={content.button.label} href={content.button.url} />] : []),
    ],
  }] : null;
  const sendTest = async () => {
    if (!it.card || !version || testing) return;
    setTesting(true);
    setTestSay(null);
    try {
      const res = await timedFetch(`/api/email-cards/${it.card.rail}/${it.card.id}/test`, { method: "POST", body: JSON.stringify({ variant: version.variant }) });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setTestSay(body?.error?.message ?? "The test did not send. Try again.");
      } else {
        setTestSay("Test sent to your login email. Check it, then approve.");
        announceEmailCardChanged({ rail: it.card.rail, id: it.card.id, source: origin });
      }
      reloadCard();
    } catch {
      setTestSay("Zavi could not confirm the test went out. Check your inbox before sending another.");
      announceEmailCardChanged({ rail: it.card.rail, id: it.card.id, source: origin });
      reloadCard();
    } finally {
      setTesting(false);
    }
  };
  const changeTopic = { label: "Change topic", expanded: mode === "angle", disabled: busy, onSelect: () => setMode((m) => (m === "angle" ? null : "angle")) };
  const more = live
    ? [
        { label: "Move", expanded: mode === "move", disabled: busy, onSelect: () => setMode((m) => (m === "move" ? null : "move")) },
        changeTopic,
      ]
    : it.blocked_fix === "change_topic"
      ? [changeTopic]
      : [];
  return (
    <li data-testid="coming-up-item" id={`plan-${it.id}`} data-card-id={it.card?.id} data-status={it.status} data-card-status={it.card_status?.status} className={cn(mode === "move" ? EW.card.replace("overflow-hidden", "overflow-visible") : EW.card, "[container-type:inline-size]", done && "opacity-80")}>
      <div className={cn(EW.cardIn, META_UP)}>
        <MetaRow
          chip={<Chip tone={chipTone} live={writing}>{chipLabel}</Chip>}
          meta={[abbr ? `${dayTime(it.planned_at, zone)} ${abbr}` : dayTime(it.planned_at, zone), it.list_name, size !== null ? `${size.toLocaleString("en-US")} ${size === 1 ? "person" : "people"}` : null]}
          corner={source ? <Chip tone="muted">{source}</Chip> : undefined}
        />
        <div className="mt-2 flex flex-wrap items-center gap-2 empty:hidden">
          {overCap && !done && <Chip tone="muted">Over 1,000: needs your approval</Chip>}
          {it.hold?.unresolved && <Chip tone="block">List on hold</Chip>}
        </div>
        <h3 className={cn(EW.title, done && "text-inkMuted")}>{it.angle}</h3>
        {it.why && <p className={EW.why}>{it.why}</p>}
        {stopped && <p className="mt-1.5 text-[14px] leading-5 text-inkMuted">Approve to send it at the planned time.</p>}
        {it.status === "planned" && !writing && <p className="mt-1.5 text-[14px] leading-5 text-inkMuted">{draftAsked ? "Zavi is drafting it now." : "Zavi drafts it the day before."}</p>}
        {shown.fromCard && shown.reason ? (
          <p data-testid="coming-up-outcome-reason" className="mt-1.5 text-[15px] leading-[1.55] text-inkMuted">{shown.reason}</p>
        ) : (
          it.reason && it.status !== "sent" && <p className="mt-1.5 text-[15px] leading-[1.55] text-inkMuted">{it.reason}</p>
        )}
        {it.status === "sent" && shown.sent && it.unattended && <p className="mt-1.5 text-[14px] text-success">Sent by Autopilot under Auto send at the planned time.</p>}
        {writing && (
          <div role="status" data-testid="coming-up-drafting-status" className="min-w-0">
            <p className="mt-2 text-[14px] leading-5 text-inkMuted">Your draft appears here when it&apos;s ready.</p>
            <EmailBoxGhost />
          </div>
        )}
        {it.card && !cardSettled && !done && !writing && <EmailBoxGhost />}
        {box && !done && <EmailBox emails={box} selected={0} onEdit={href ? () => window.location.assign(href) : undefined} editLabel={it.status === "scheduled" ? "Open" : undefined} />}
        {error && mode !== "move" && (
          <p role="alert" className="mt-3 flex flex-wrap items-center gap-2 text-[13px] text-danger">
            {error}
          </p>
        )}

        {mode === "move" && (
          <div data-testid="coming-up-move" className="mt-4 flex min-w-0 flex-col gap-3 border-t border-rule pt-4">
            <p className="text-[13px] font-medium text-ink">Move to</p>
            <PlanWhenFields zone={zone} date={date} time={time} invalid={moveBlock !== null && moveBlock.tone === "bad"} disabled={busy} onDate={(v) => { setDate(v); setError(null); }} onTime={(v) => { setTime(v); setError(null); }} />
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-3">
              <p
                id={moveNoteId}
                data-testid="coming-up-move-summary"
                role={error ? "alert" : undefined}
                className={cn("min-h-[2.5rem] min-w-0 flex-1 basis-[14rem] text-[13px] leading-5", error || moveBlock?.tone === "bad" ? "text-danger" : "text-inkMuted")}
              >
                {moveNote}
              </p>
              <div className="flex shrink-0 items-center gap-2">
                <button type="button" className={SECONDARY} disabled={busy} onClick={() => { setMode(null); setDate(start.date); setTime(start.time); setError(null); }}>
                  Cancel
                </button>
                <button
                  type="button"
                  className={PRIMARY}
                  disabled={busy || moveBlock !== null}
                  aria-describedby={moveNoteId}
                  onClick={() => {
                    if (moveBlock) return;
                    setError(null);
                    void act(
                      () => movePlanned(it.id, { date, time, schedule_gen: it.schedule_gen, timezone: zone }),
                      it.status === "scheduled" ? "Moved. Your approval stays; it sends at the new time." : it.status === "ready" ? "Moved. Your draft stays as it is." : "Moved. Zavi drafts it 1 day before the new time.",
                      (now) => {
                        const at = wallParts(now.planned_at, now.timezone || zone);
                        return now.schedule_gen > it.schedule_gen && sameWall(at, { date, time }) && !sameWall(at, start);
                      },
                      "Move",
                    );
                  }}
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        )}
        {mode === "angle" && (
          <div className="mt-3.5 flex flex-wrap gap-2">
            <input aria-label="Topic" value={angle} maxLength={120} onChange={(e) => setAngle(e.target.value)} className={cn(FIELD, "min-w-0 flex-1")} />
            <button type="button" className={PRIMARY} disabled={busy || angle.trim().length < 3 || angle.trim().toLowerCase() === it.angle.trim().toLowerCase()} onClick={() => void saveTopic()}>
              Save
            </button>
            <button type="button" className={SECONDARY} disabled={busy} onClick={() => { setMode(null); setAngle(it.angle); }}>
              Cancel
            </button>
          </div>
        )}

        {canAct && (live || it.status === "blocked") && (
          <>
            {it.status === "ready" && showTestListLine && (
              <p data-testid="coming-up-test-list" className="mt-3.5 text-[14px] leading-5 text-inkMuted">{card?.test_list ? TEST_LIST_LINE : TEST_LIST_UNKNOWN_LINE}</p>
            )}
            <div data-testid="coming-up-actions" className={cn(EW.acts, "empty:hidden")}>
              {href && it.status === "ready" && (busy || !cardSettled ? (
                <button type="button" disabled aria-busy="true" data-testid="coming-up-action-pending" className={cn(EW.outline, "min-w-[11.5rem] justify-center")}>
                  Checking draft
                </button>
              ) : testList || !version ? (
                <Link href={href} className={EW.outline}>
                  Review draft
                </Link>
              ) : needsTest ? (
                <button type="button" data-testid="coming-up-send-test" disabled={testing} onClick={() => void sendTest()} className={EW.primary}>
                  <Send className="size-4" aria-hidden />
                  {testing ? "Sending test" : "Send me a test"}
                </button>
              ) : (
                <Link href={href} className={EW.primary}>
                  <Check className="size-4" aria-hidden />
                  Approve and schedule
                </Link>
              ))}
              {href && it.status === "scheduled" && (
                <Link href={href} className={EW.outline}>
                  Review draft
                </Link>
              )}
              {it.status === "scheduled" && (
                <button type="button" className={EW.outline} disabled={busy} onClick={() => void act(() => withdrawPlanned(it.id), "Not sending. The draft waits. Approve it for the planned time, or send it now.", (now) => now.status === "ready" && now.vetoed && now.schedule_gen > it.schedule_gen, "Don't send")}>
                  Don&apos;t send
                </button>
              )}
              {((it.status === "planned" && !draftAsked) || it.blocked_fix === "draft_now") && (
                <button type="button" className={EW.outline} disabled={busy} onClick={() => void act(() => draftPlannedNow(it.id), "Zavi is drafting it now.", (now) => now.status === "drafting" || now.draft_requested === true || (!it.card && !!now.card), "Draft now")}>
                  Draft now
                </button>
              )}
              {ask && (
                <button type="button" className={EW.quiet} onClick={ask}>
                  <MessageSquare className="size-4" aria-hidden />
                  Ask Zavi
                </button>
              )}
              {mode !== "move" && (
                <div className={EW.endRow}>
                  <MoreMenu items={more} />
                  <button type="button" className={EW.end} disabled={busy} onClick={() => void skip()}>
                    Skip
                  </button>
                </div>
              )}
            </div>
            {testSay && <p role="status" className="mt-2.5 text-[13px] text-inkMuted">{testSay}</p>}
          </>
        )}
        {canAct && it.hold?.unresolved && it.card && <NotSentAction rail={it.card.rail} cardId={it.card.id} origin={origin} onUnclear={onUnclear} />}
        {canAct && it.status === "skipped" && href && it.status_reason && !NO_DRAFT_LINK.has(it.status_reason) && (
          <Link href={href} className={cn(EW.secondary, "mt-3.5 self-start")}>
            {OPEN_ONLY_LINK.has(it.status_reason) ? "Open the draft" : "Open the draft to approve and send now"}
          </Link>
        )}
      </div>
    </li>
  );
}

function dayTime(iso: string, tz: string): string {
  try {
    const d = new Date(iso);
    const day = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }).format(d);
    const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(d);
    return `${day} \u00b7 ${time}`;
  } catch {
    return iso;
  }
}

function usePlannedCard(ref: PlannedEmail["card"], version: number): { view: EmailCardView | null; settled: boolean; reload: () => void } {
  const [read, setRead] = useState<{ key: string; view: EmailCardView | null } | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const rail = ref?.rail ?? null;
  const id = ref?.id ?? null;
  const key = rail && id ? `${rail}:${id}` : null;
  useEffect(() => {
    if (!key) return;
    let live = true;
    const missed = () => setRead((prev) => (prev?.key === key && prev.view ? prev : { key, view: null }));
    timedFetch(`/api/email-cards/${rail}/${id}`)
      .then((res) => (res.ok ? (res.json() as Promise<{ card?: EmailCardView }>) : null))
      .then((j) => {
        if (!live) return;
        const v = j?.card;
        if (v && Array.isArray(v.versions)) setRead({ key, view: v });
        else missed();
      })
      .catch(() => {
        if (live) missed();
      });
    return () => {
      live = false;
    };
  }, [key, rail, id, version, tick]);
  const current = key !== null && read?.key === key ? read : null;
  return { view: current?.view ?? null, settled: current !== null, reload };
}

function useListSizes(): Map<string, number | null> {
  const [sizes, setSizes] = useState<Map<string, number | null>>(new Map());
  useEffect(() => {
    let live = true;
    getEmailTestLists()
      .then((r) => {
        if (!live) return;
        const m = new Map<string, number | null>();
        for (const route of r.routes) for (const l of route.lists) m.set(`${route.route}:${l.id}`, l.people);
        setSizes(m);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return sizes;
}

export const AUTOPILOT_HOW = [
  "Every Monday, Zavi plans next week's emails from your results.",
  "It drafts each one the day before it goes out.",
  "You approve each send. Autopilot sends alone only to 1,000 people or fewer, once per list a week.",
  "An email nobody approves in time is skipped. Its draft stays.",
] as const;

const TURN_ON = "/workspace?tab=growth-strategy";
const RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30";

export const PLAN_READ_FAILED = "Could not load your planned emails.";
export const AUTOPILOT_READ_FAILED = "Could not read whether Autopilot is on.";

function AutopilotStrip({ view, unread, readError, onRetry }: { view: PlanView | null; unread: boolean; readError: string | null; onRetry: () => void }) {
  const [open, setOpen] = useState(false);
  const on = view?.autopilot_on ?? null;
  return (
    <div data-testid="coming-up-autopilot" className="overflow-hidden rounded-2xl border border-rule bg-white">
      <div className="flex flex-col gap-3 p-4 [@container(min-width:560px)]:flex-row [@container(min-width:560px)]:items-center [@container(min-width:560px)]:gap-3.5">
        <div className="flex min-w-0 flex-1 items-center gap-3.5">
          <span
            aria-hidden
            className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-[10px]", on === true ? "bg-success/10 text-success" : "bg-brand/10 text-brand")}
          >
            <CalendarClock className="h-[18px] w-[18px]" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h4 id="coming-up-title" className="text-[15px] font-semibold leading-5 text-ink">
                Autopilot
              </h4>
              {on !== null && (
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[11px] font-medium leading-4",
                    on ? "bg-success/10 text-success" : "bg-creamDeep text-inkMuted",
                  )}
                >
                  {on ? "On" : "Off"}
                </span>
              )}
            </div>
            {on === true && (
              <p data-testid="coming-up-autopilot-status" className="mt-0.5 text-[13px] leading-5 text-inkMuted">
                {view?.weekly_eligible === false && view.weekly_block === "paused"
                  ? "Email is paused, so Zavi is not planning emails. Turn email back on and Zavi plans again on Monday."
                  : view?.weekly_eligible === false && view.weekly_block === "sender_unavailable"
                  ? SENDER_UNAVAILABLE_LINE
                  : view?.weekly_eligible === false
                  ? "Connect an email tool or add a list so Zavi can plan your emails. A list marked as a test, or one with nobody to send to, does not count."
                  : view?.next_plan_label
                    ? `Next plan ${view.next_plan_label}`
                    : "Zavi plans next week's emails every Monday."}
              </p>
            )}
            {on === null && unread && (
              <p data-testid="coming-up-autopilot-unread" className="mt-0.5 text-[13px] leading-5 text-inkMuted">
                {AUTOPILOT_READ_FAILED}
              </p>
            )}
            {on === false && (
              <p data-testid="coming-up-autopilot-off" className="mt-0.5 text-[13px] leading-5 text-inkMuted">
                Let Zavi plan your emails every Monday. Nothing sends until you approve it.
              </p>
            )}
          </div>
        </div>
        {on === false && (
          <a
            href={TURN_ON}
            className={cn(
              "inline-flex h-9 w-full shrink-0 items-center justify-center gap-1.5 rounded-cta bg-ink px-3.5 text-[13px] font-semibold text-cream focus-visible:ring-offset-2 [@container(min-width:560px)]:w-auto",
              RING,
            )}
          >
            Turn on Autopilot
            <ChevronRight aria-hidden className="-mr-0.5 h-3.5 w-3.5" strokeWidth={2.2} />
          </a>
        )}
        {on === null && view && (
          <a href={TURN_ON} className={cn("text-[13px] font-medium text-ink underline underline-offset-2", RING)}>
            Review Autopilot
          </a>
        )}
      </div>
      {readError && (
        <div role="alert" data-testid="coming-up-read-error" className="flex flex-wrap items-center justify-between gap-2 border-t border-rule px-4 py-2.5 text-[13px] leading-5 text-danger">
          <span className="min-w-0">{readError}</span>
          <button type="button" className={SECONDARY} onClick={onRetry}>
            Retry
          </button>
        </div>
      )}
      <button
        type="button"
        aria-expanded={open}
        aria-controls="coming-up-how"
        onClick={() => setOpen((v) => !v)}
        className={cn("flex w-full cursor-pointer items-center justify-between border-t border-rule px-4 py-2.5 text-left text-[12px] font-medium text-inkMuted transition-colors hover:bg-creamDeep hover:text-ink", RING)}
      >
        How it works
        <ChevronDown aria-hidden className={cn("h-3.5 w-3.5 transition-transform duration-200 motion-reduce:transition-none", open && "rotate-180")} />
      </button>
      {open && (
        <ol id="coming-up-how" className="grid gap-x-6 gap-y-3 px-4 pb-4 pt-1 sm:grid-cols-2 animate-fade-in motion-reduce:animate-none">
          {AUTOPILOT_HOW.map((line, n) => (
            <li key={line} className="flex gap-2.5 text-[13px] leading-5 text-inkMuted">
              <span aria-hidden className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-creamDeep text-[11px] font-semibold tabular-nums text-ink">
                {n + 1}
              </span>
              <span>{line}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function EmailComingUpBlock() {
  const sizes = useListSizes();
  const [view, setView] = useState<PlanView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [skippedNow, setSkippedNow] = useState<string[]>([]);
  const [closedCards, setClosedCards] = useState<string[]>([]);
  const [retopiced, setRetopiced] = useState<Record<string, { angle: string; version: number }>>({});

  const source = useId();
  const readSeq = useRef(0);
  const load = useCallback(async (): Promise<PlanView | null> => {
    const seq = ++readSeq.current;
    try {
      const v = await getPlan();
      if (seq === readSeq.current) {
        setView(v);
        setError(null);
        setSkippedNow([]);
      }
      return v;
    } catch (e) {
      if (seq === readSeq.current) setError(readFailureMessage(e, PLAN_READ_FAILED));
      return null;
    }
  }, []);

  useRereadWhileFailed(error !== null, () => void load());

  useEffect(() => {
    void load();
    return onEmailPlanChanged((from) => {
      if (from !== source) void load();
    });
  }, [load, source]);

  const moving = (view?.items ?? []).some((i) => i.status === "drafting" || i.status === "sending" || i.status === "reconciling" || i.draft_requested === true);
  const tabHidden = useTabHidden();
  useEffect(() => {
    if (!moving || tabHidden) return;
    const t = setInterval(() => void load(), comingUpPoll.ms);
    return () => clearInterval(t);
  }, [moving, load, tabHidden]);

  const [unconfirmed, setUnconfirmed] = useState<Record<string, { what: string; say: string; confirm: (v: PlanView) => boolean }>>({});
  const unclear: Unclear = async (s, confirm, track) => {
    const v = await load();
    if (v && confirm(v)) {
      if (track) {
        setUnconfirmed((u) => {
          const next = { ...u };
          delete next[track.key];
          return next;
        });
      }
      toast.add({ type: "success", title: s, position: "top-center", dismissible: false });
      return true;
    }
    if (track) setUnconfirmed((u) => ({ ...u, [track.key]: { what: track.what, say: s, confirm } }));
    return false;
  };
  const recheck = async (key: string) => {
    const u = unconfirmed[key];
    if (u && (await unclear(u.say, u.confirm, { key, what: u.what }))) announceEmailPlanChanged(source);
  };
  const retry = async () => {
    await load();
  };

  const onSkipped = useCallback((id: string, cardId: string | null) => {
    setSkippedNow((ids) => [...ids, id]);
    if (cardId) setClosedCards((ids) => [...ids, cardId]);
  }, []);
  const onRetopiced = useCallback((it: PlannedEmail, angle: string) => {
    setRetopiced((r) => ({ ...r, [it.id]: { angle, version: Math.max(it.content_version, r[it.id]?.version ?? 0) } }));
    if (it.card) setClosedCards((ids) => [...ids, it.card!.id]);
  }, []);
  const items = (view?.items ?? []).map((i) => {
    if (skippedNow.includes(i.id) && i.status !== "skipped") return { ...i, status: "skipped" as const, status_reason: "skipped_by_founder", card: null, card_status: null, scheduled: null, vetoed: false };
    const r = retopiced[i.id];
    if (r && i.content_version <= r.version && !DONE.includes(i.status)) return { ...i, angle: r.angle, status: "planned" as const, status_reason: null, card: null, card_status: null, scheduled: null, vetoed: false, draft_requested: false };
    return i;
  });

  const canAct = view?.role === "owner" || view?.role === "admin";
  const bridge = useEmailPlanBridge();
  const bridgeRef = useRef(bridge);
  bridgeRef.current = bridge;
  const cardIds = items.filter((i) => !DONE.includes(i.status) && i.card).map((i) => i.card!.id).join(",");
  useEffect(() => {
    bridgeRef.current?.setPlannedCards(cardIds ? cardIds.split(",") : []);
  }, [cardIds]);
  useEffect(() => {
    bridgeRef.current?.setClosedCards?.(closedCards);
  }, [closedCards]);
  const doneInBridge = bridge?.sentInDone === true;
  const upcoming = items.filter((i) => !DONE.includes(i.status));
  const waitsOnYou = (i: PlannedEmail) => i.status === "ready" || i.status === "blocked";
  const waiting = upcoming.filter(waitsOnYou);
  const comingUp = upcoming.filter((i) => !waitsOnYou(i));
  const past = items.filter((i) => DONE.includes(i.status) && !(doneInBridge && i.status === "sent"));
  const firstKey = !view ? null : waiting.length > 0 ? "waiting-on-you" : comingUp.length > 0 ? "coming-up-group" : past.length > 0 ? "past-section" : view.holds.length > 0 ? "holds-section" : null;

  return (
    <section aria-labelledby="coming-up-title" data-testid="coming-up" className="min-w-0">
      <AutopilotStrip view={view} unread={!view && !!error} readError={error} onRetry={() => void retry()} />
      {!view && !error && (
        <div className="mt-3 grid gap-2">
          <Skeleton className="h-16 w-full" rounded="rounded-[12px]" />
        </div>
      )}
      {Object.entries(unconfirmed).map(([key, u]) => (
        <p key={key} role="alert" data-testid="coming-up-unconfirmed" className="mt-3 flex flex-wrap items-center gap-2 text-[13px] text-danger">
          <span className="font-medium text-ink">{u.what}</span>
          <span>{UNCLEAR_LINE}</span>
          <button type="button" className={SECONDARY} onClick={() => void recheck(key)}>
            Refresh
          </button>
        </p>
      ))}
      {view && upcoming.length === 0 && view.autopilot_on !== false && (
        <p data-testid="coming-up-empty" className="mt-3 text-[13px] leading-5 text-inkMuted">
          {view.autopilot_on && view.weekly_eligible !== false && view.next_plan_label
            ? `Nothing planned yet. Next plan ${view.next_plan_label}.`
            : "Nothing planned yet."}
        </p>
      )}
      {view &&
        [
          { key: "waiting-on-you", title: "Waiting on you", icon: <Hand className="size-4 shrink-0 text-inkMuted" aria-hidden />, items: waiting },
          { key: "coming-up-group", title: "Coming up", icon: <CalendarClock className="size-4 shrink-0 text-inkMuted" aria-hidden />, items: comingUp },
        ]
          .filter((g) => g.items.length > 0)
          .map((g) => (
            <div key={g.key} data-testid={`${g.key}-section`} className={g.key === firstKey ? "mt-8" : DIVIDER}>
              <DesignGroupHead testId={g.key} icon={g.icon} title={g.title} count={g.items.length} />
              <ol className={`mt-4 ${LIST}`}>
                {g.items.map((it) => (
                  <EmailComingUpItem
                    key={`${it.id}:${it.schedule_gen}:${it.content_version}`}
                    it={it}
                    canAct={canAct}
                    timezone={view.timezone}
                    people={sizes.get(`${it.route}:${it.list_id}`) ?? null}
                    origin={source}
                    onUnclear={unclear}
                    onSkipped={onSkipped} onRetopiced={onRetopiced}
                  />
                ))}
              </ol>
            </div>
          ))}
      {view && past.length > 0 && (
        <div data-testid="past-section" className={firstKey === "past-section" ? "mt-8" : DIVIDER}>
          <h3 className={SECTION_TITLE}>Sent and skipped</h3>
          <ol className={`mt-4 ${LIST}`}>
            {past.map((it) => (
              <EmailComingUpItem key={it.id} it={it} canAct={canAct} timezone={view.timezone} people={null} origin={source} onUnclear={unclear} onSkipped={onSkipped} onRetopiced={onRetopiced} />
            ))}
          </ol>
        </div>
      )}
      {view && view.holds.length > 0 && (
        <div data-testid="holds-section" className={firstKey === "holds-section" ? "mt-8" : DIVIDER}>
          <h3 className={SECTION_TITLE}>Lists on hold</h3>
          <ol className="mt-4 space-y-4">
            {view.holds.map((h) => (
              <li key={`${h.rail}:${h.card_id}`} data-testid="held-send" className="rounded-xl border border-rule p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[14px] font-semibold text-ink">An email from {h.since_label}</span>
                  <span className="rounded-full bg-coral/10 px-2 py-0.5 text-[12px] font-bold text-danger">List on hold</span>
                  <Link href={`/workspace/email-cards/${h.rail}/${h.card_id}`} className="text-[13px] font-medium text-ink underline">
                    Open the email
                  </Link>
                </div>
                {cardOutcomeStatus(h.card_status)?.reason && (
                  <p data-testid="held-send-reason" className="mt-2 text-[14px] leading-5 text-inkMuted">{cardOutcomeStatus(h.card_status)?.reason}</p>
                )}
                {canAct ? (
                  <NotSentAction rail={h.rail} cardId={h.card_id} origin={source} onUnclear={unclear} />
                ) : (
                  <p className="mt-2 text-[14px] leading-5 text-inkMuted">Zavi could not confirm whether this went out. An owner or admin can check the email tool and free the list.</p>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
      {view && !canAct && <p className="mt-3 text-[13px] text-inkMuted">Only an owner or admin can change the plan or approve an email.</p>}
    </section>
  );
}
