"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Clock, Copy, ExternalLink, MessageSquare, MoreHorizontal, RotateCcw, Send, X } from "lucide-react";
import { toast } from "@/components/ui/toast";
import { ActionTooltip, explainControl } from "./ActionTooltip";
import { actionHint } from "./actionHints";
import { btn } from "./ui";
import { PopMenu, type PopMenuItem } from "./PopMenu";
import { blanksLine, copyLabel, findBlanks } from "./blanks";
import { execInFlight, type ActionHandlers, type ActionItem } from "./types";
import { BILLING_URL } from "../CreditRefusalNotice";
import { isPartialRiskExecCode } from "@zavi/shared";
import { AD_BUDGET_URL } from "@/lib/workspace/tabUrl";

export const SNOOZE_OPTIONS = [
  { label: "Tomorrow", days: 1 },
  { label: "3 days", days: 3 },
  { label: "1 week", days: 7, isDefault: true },
] as const;

export function snoozeUntil(days: number, now = new Date()): string {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

export type Panel = null | "reject" | "redo" | "snooze";

export const REJECT_NOTE_MAX = 1000;

function SnoozePicker({ a, handlers, busy, onDone }: { a: ActionItem; handlers: ActionHandlers; busy?: boolean; onDone: () => void }) {
  return (
    <div data-testid="snooze-picker" className="mb-3 rounded-xl border border-rule bg-creamDeep px-4 py-3">
      <p className="text-[14px] font-semibold text-ink">Not now. Bring it back in:</p>
      <div className="mt-2 flex flex-wrap items-center gap-2" role="group" aria-label="Not now for how long">
        {SNOOZE_OPTIONS.map((o) => {
          const isDefault = "isDefault" in o && o.isDefault;
          return (
            <ActionTooltip key={o.days} description={actionHint(a, "snooze", `Hide this suggestion for ${o.days} ${o.days === 1 ? "day" : "days"}, then bring it back to Next steps. Existing campaigns and posts keep running.`)} label={o.label}>
              <button
                type="button"
                disabled={busy}
                data-default={isDefault ? "true" : undefined}
                onClick={() => {
                  void handlers.onSetStatus(a, "snoozed", { until: snoozeUntil(o.days) });
                  onDone();
                }}
                className={isDefault ? `${btn.primary} inline-flex items-center gap-2` : btn.secondary}
              >
                {o.label}
              </button>
            </ActionTooltip>
          );
        })}
        <ActionTooltip description={actionHint(a, "open", "Close this picker without postponing the suggestion.")} label="Cancel">
          <button type="button" onClick={onDone} className="py-1.5 text-[14px] font-medium text-inkMuted underline-offset-2 hover:underline">
            Cancel
          </button>
        </ActionTooltip>
      </div>
    </div>
  );
}

export function NotePanel({
  a,
  submitDescription,
  title,
  placeholder,
  submitLabel,
  minLength,
  busy,
  onCancel,
  onSubmit,
  hint,
  tooShortHint,
  maxLength,
}: {
  a: ActionItem;
  submitDescription: string;
  title: string;
  placeholder: string;
  submitLabel: string;
  minLength: number;
  busy?: boolean;
  onCancel: () => void;
  onSubmit: (note: string) => void;
  hint?: string;
  tooShortHint?: string;
  maxLength?: number;
}) {
  const [note, setNote] = useState("");
  const tooLong = maxLength !== undefined && note.trim().length > maxLength;
  return (
    <div data-testid="note-panel" className="mb-3 rounded-xl border border-rule bg-creamDeep p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[14px] font-medium leading-5 text-ink">{title}</p>
        <ActionTooltip description={actionHint(a, "open", "Close this form without submitting your feedback or changing the card.")} label="Close">
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            data-testid="note-panel-close"
            className="-mr-1 -mt-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-inkMuted hover:bg-bone hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </ActionTooltip>
      </div>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={placeholder}
        aria-label={title}
        maxLength={maxLength}
        rows={3}
        className="mt-2 block min-h-[76px] w-full resize-y rounded-lg border border-rule bg-cream px-3 py-2 text-[14px] leading-5 text-ink placeholder:text-inkLight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
      />
      {tooLong ? (
        <p role="alert" data-testid="note-too-long" className="mt-2 text-[12px] font-medium text-danger">
          Keep it to {maxLength!.toLocaleString("en-US")} characters or fewer. It is {note.trim().length.toLocaleString("en-US")} now.
        </p>
      ) : hint ? (
        <p className="mt-2 text-[12px] leading-4 text-inkMuted">{hint}</p>
      ) : null}
      <div data-testid="note-panel-actions" className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <ActionTooltip description={actionHint(a, "open", note.trim().length < minLength ? (tooShortHint ?? `Enter at least ${minLength} characters explaining what should change before submitting.`) : submitDescription)} label={submitLabel}>
          <button
            type="button"
            disabled={busy || note.trim().length < minLength || tooLong}
            onClick={() => onSubmit(note.trim())}
            className={`${btn.primary} inline-flex items-center gap-2`}
          >
            <Send className="h-4 w-4" aria-hidden />
            {submitLabel}
          </button>
        </ActionTooltip>
      </div>
    </div>
  );
}

function RejectPanel({ a, handlers, busy, onDone }: { a: ActionItem; handlers: ActionHandlers; busy?: boolean; onDone: () => void }) {
  return (
    <NotePanel
      a={a}
      submitDescription="Reject this suggestion now and save this reason as feedback for the next channel run. This does not undo earlier work."
      title="Why are you rejecting it?"
      placeholder="e.g. We never discount, so skip price posts"
      submitLabel="Reject"
      minLength={3}
      busy={busy}
      onCancel={onDone}
      hint="Zavi reads this the next time this channel runs, and a similar idea ranks lower."
      maxLength={REJECT_NOTE_MAX}
      onSubmit={async (note) => {
        const ok = await handlers.onSetStatus(a, "rejected", { note, hold: true });
        if (ok !== false) onDone();
      }}
    />
  );
}

function RedoPanel({ a, handlers, busy, onDone }: { a: ActionItem; handlers: ActionHandlers; busy?: boolean; onDone: () => void }) {
  return (
    <NotePanel
      a={a}
      submitDescription="Send your instruction and rerun this channel to replace this suggestion. The new suggestion still needs your review."
      title="What should Zavi do differently?"
      placeholder="e.g. Use the numbers from last month instead"
      submitLabel="Redo"
      minLength={3}
      busy={busy}
      onCancel={onDone}
      hint="Zavi runs this channel again with your note and replaces this action. Nothing is posted or changed until you say so."
      onSubmit={(note) => {
        void handlers.onRedo(a, note);
        onDone();
      }}
    />
  );
}

export function Panels({ a, handlers, busy, panel, setPanel }: { a: ActionItem; handlers: ActionHandlers; busy?: boolean; panel: Panel; setPanel: (p: Panel) => void }) {
  const close = () => setPanel(null);
  if (panel === "redo") return <RedoPanel a={a} handlers={handlers} busy={busy} onDone={close} />;
  if (panel === "reject") return <RejectPanel a={a} handlers={handlers} busy={busy} onDone={close} />;
  if (panel === "snooze") return <SnoozePicker a={a} handlers={handlers} busy={busy} onDone={close} />;
  return null;
}

const FOOTER_FLAT = "[@container(max-width:600px)]:contents";

export const FOOTER_QUIET_BOX =
  "[@container(max-width:600px)]:border [@container(max-width:600px)]:border-rule [@container(max-width:600px)]:bg-cream";

export function FooterRow({ left, right }: { left?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mt-auto [container-type:inline-size]">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-rule px-4 py-3 [@container(max-width:600px)]:justify-start [@container(max-width:600px)]:gap-x-2 sm:px-4">
        <div className={`flex flex-wrap items-center gap-2 ${FOOTER_FLAT}`}>{left}</div>
        <div className={`flex flex-wrap items-center justify-end gap-2 ${FOOTER_FLAT}`}>{right}</div>
      </div>
    </div>
  );
}

export function ButtonCluster({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-2">{children}</div>;
}

function AskButton({ a, handlers, disabled }: { a: ActionItem; handlers: ActionHandlers; disabled?: boolean }) {
  if (!handlers.onOpenChat) return null;
  return explainControl(
    <button type="button" disabled={disabled} onClick={() => handlers.onOpenChat?.(a)} className={btn.secondary}>
      <MessageSquare className="h-4 w-4" aria-hidden />
      Ask Zavi
    </button>, actionHint(a, "ask"), "Ask Zavi"
  );
}

export function CopyButton({ text, a }: { text: string; a?: ActionItem }) {
  const [copied, setCopied] = useState(false);
  const [pressed, setPressed] = useState(false);
  const blanks = findBlanks(text);
  const copy = async () => {
    setPressed(true);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
    }
  };
  const line = pressed ? blanksLine(blanks) : null;
  return (
    <>
      <ActionTooltip description={a ? actionHint(a, "copy") : "Copy this text to your clipboard. Nothing is published or sent."} label="Copy">
        <button type="button" onClick={() => void copy()} className={btn.secondary}>
          <Copy className="h-4 w-4" aria-hidden />
          {copied ? "Copied" : copyLabel("Copy", blanks)}
        </button>
      </ActionTooltip>
      {line && (
        <span data-testid="copy-blanks" role="status" className="text-[14px] font-medium text-ink">
          {line}
        </span>
      )}
    </>
  );
}

function OpenLink({ a, href, label }: { a: ActionItem; href: string; label: string }) {
  return explainControl(
    <a href={href} target="_blank" rel="noopener noreferrer" className={btn.secondary}>
      {label}
      <ExternalLink className="h-3.5 w-3.5" aria-hidden />
    </a>, actionHint(a, "open"), label
  );
}

export function DoneButton({ a, handlers, busy, primary = true }: { a: ActionItem; handlers: ActionHandlers; busy?: boolean; primary?: boolean }) {
  return explainControl(
    <button
      type="button"
      disabled={busy}
      onClick={() => void handlers.onSetStatus(a, "acted")}
      className={primary ? `${btn.primary} inline-flex items-center gap-2` : btn.secondary}
    >
      <Check className="h-4 w-4" aria-hidden />
      Done
    </button>, actionHint(a, "done"), "Done"
  );
}

type MenuItem = PopMenuItem;

function MoreMenu({ items }: { items: MenuItem[] }) {
  return <PopMenu items={items} width="w-56" className={btn.secondary} trigger={() => <MoreHorizontal className="h-4 w-4" aria-hidden />} />;
}

export const rejectItem = (setPanel: (p: Panel) => void, disabled?: boolean, a?: ActionItem): MenuItem => ({
  label: "Reject",
  tooltip: a ? actionHint(a, "reject") : undefined,
  icon: <X className="h-4 w-4" aria-hidden />,
  onSelect: () => setPanel("reject"),
  disabled,
});
export const snoozeItem = (setPanel: (p: Panel) => void, disabled?: boolean, a?: ActionItem): MenuItem => ({
  label: "Not now",
  tooltip: a ? actionHint(a, "snooze") : undefined,
  icon: <Clock className="h-4 w-4" aria-hidden />,
  onSelect: () => setPanel("snooze"),
  disabled,
});
export const rewriteItem = (a: ActionItem, handlers: ActionHandlers): MenuItem => ({
  label: "Ask for a rewrite",
  tooltip: actionHint(a, "redo"),
  hint: "Zavi writes a new version of this",
  icon: <RotateCcw className="h-4 w-4" aria-hidden />,
  onSelect: () => handlers.onOpenRedoChat?.(a),
});
function redoAction(a: ActionItem, handlers: ActionHandlers, setPanel: (p: Panel) => void) {
  return () => (handlers.onOpenRedoChat ? handlers.onOpenRedoChat(a) : setPanel("redo"));
}

export const redoItem = (
  a: ActionItem,
  handlers: ActionHandlers,
  setPanel: (p: Panel) => void,
  disabled?: boolean,
): MenuItem => ({
  label: "Redo",
  tooltip: actionHint(a, "redo"),
  icon: <RotateCcw className="h-4 w-4" aria-hidden />,
  onSelect: redoAction(a, handlers, setPanel),
  disabled,
});

function LifecycleButtons({ a, handlers, busy, setPanel, panel }: { a: ActionItem; handlers: ActionHandlers; busy?: boolean; setPanel: (p: Panel) => void; panel: Panel }) {
  const toggle = (p: Exclude<Panel, null>) => setPanel(panel === p ? null : p);
  return (
    <>
      <ActionTooltip description={actionHint(a, "snooze")} label="Not now">
        <button type="button" disabled={busy} aria-expanded={panel === "snooze"} onClick={() => toggle("snooze")} className={btn.secondary}>
          <Clock className="h-4 w-4" aria-hidden />
          Not now
        </button>
      </ActionTooltip>
      <ActionTooltip description={actionHint(a, "redo")} label="Redo">
        <button
          type="button"
          disabled={busy}
          aria-expanded={handlers.onOpenRedoChat ? undefined : panel === "redo"}
          onClick={() => (handlers.onOpenRedoChat ? handlers.onOpenRedoChat(a) : toggle("redo"))}
          className={btn.secondary}
        >
          <RotateCcw className="h-4 w-4" aria-hidden />
          Redo
        </button>
      </ActionTooltip>
      <ActionTooltip description={actionHint(a, "reject")} label="Reject">
        <button type="button" disabled={busy} aria-expanded={panel === "reject"} onClick={() => toggle("reject")} className={btn.secondary}>
          <X className="h-4 w-4" aria-hidden />
          Reject
        </button>
      </ActionTooltip>
      <DoneButton a={a} handlers={handlers} busy={busy} />
    </>
  );
}

export function TaskFooter({ a, handlers, busy, copyText, link, linkLabel }: { a: ActionItem; handlers: ActionHandlers; busy?: boolean; copyText?: string | null; link?: string | null; linkLabel?: string }) {
  const [panel, setPanel] = useState<Panel>(null);
  return (
    <>
      <Panels a={a} handlers={handlers} busy={busy} panel={panel} setPanel={setPanel} />
      <FooterRow
        left={
          <>
            {link && <OpenLink a={a} href={link} label={linkLabel ?? "Open"} />}
            {copyText && <CopyButton a={a} text={copyText} />}
            <AskButton a={a} handlers={handlers} />
          </>
        }
        right={<LifecycleButtons a={a} handlers={handlers} busy={busy} panel={panel} setPanel={setPanel} />}
      />
    </>
  );
}

function isAdBudgetHeld(a: ActionItem): boolean {
  return a.exec_bucket === "needs_founder" && a.exec_fix === "ad_budget";
}

const LINKEDIN_PAUSE_ZAVI_SIDE = new Set(["ads_binding_unavailable", "linkedin_ads_body_invalid", "linkedin_ads_writes_off", "linkedin_ads_write_failed", "linkedin_ads_read_failed"]);

export function execFailedTitle(a: ActionItem, platformName: string, execCopy?: { failedTitle: string; partialTitle?: string }): string {
  if (isAdBudgetHeld(a)) return "Budget limit reached.";
  if (a.exec_code === "chatgpt_ads_launch_undone") return "Zavi could not launch this, so it was archived.";
  if (a.exec_code === "linkedin_ads_post_author_refused") return "LinkedIn will not run this post as an ad.";
  if (a.exec_code === "linkedin_ads_account_changed") return "The ad account changed after review.";
  if (a.exec_code === "linkedin_ads_launch_not_reopened") return "Zavi could not reopen this launch.";
  if (a.exec_code === "linkedin_ads_launch_not_sent") return "This launch did not reach LinkedIn.";
  if (a.exec_code === "linkedin_ads_launch_refused") return "Zavi did not send this launch.";
  if (a.exec_code === "linkedin_ads_account_turned_off") return "This account was turned off.";
  if (a.exec_code === "linkedin_ads_zavi_incomplete") return "Zavi could not finish this change.";
  if (a.exec_code === "linkedin_ads_creation_unconfirmed") return "Zavi checks what LinkedIn made before trying again.";
  if (a.exec_code === "linkedin_ads_daily_limit") return "LinkedIn's daily limit is used up.";
  if (a.exec_code === "linkedin_ads_rate_limited") return "LinkedIn asked Zavi to slow down.";
  if (a.exec_code === "linkedin_ads_wallet_consent_withdrawn") return "Shared wallet permission was withdrawn.";
  if (a.exec_code === "ads_pause_queued") return "Zavi saved this pause and keeps trying.";
  if (a.exec_code === "ads_pause_superseded") return "The campaign was relaunched before Zavi could pause it.";
  if (a.action_type === "pause_ad" && a.channel_slug === "linkedin_ads" && a.exec_code && LINKEDIN_PAUSE_ZAVI_SIDE.has(a.exec_code)) return "Zavi could not finish this pause.";
  if (execCopy?.partialTitle && (isPartialRiskExecCode(a.exec_code) || a.exec_bucket === "partial_risk")) return execCopy.partialTitle;
  return execCopy ? execCopy.failedTitle : `${platformName} did not take the change.`;
}

function execFailedHint(a: ActionItem, platformName: string, execCopy?: { failedHint: string; temporaryHint?: string }): string {
  if (isPartialRiskExecCode(a.exec_code) || a.exec_bucket === "partial_risk") {
    return "Zavi will not run this again, so nothing is created twice.";
  }
  if (a.exec_code === "linkedin_ads_account_turned_off") return "Turn the account back on with Use this account again, then choose Try again.";
  if (a.exec_code === "linkedin_ads_zavi_incomplete") return "This was a problem on Zavi's side, not in LinkedIn. Choose Try again.";
  if (a.exec_code === "linkedin_ads_launch_not_sent") return "Nothing was sent to LinkedIn. Choose Try again.";
  if (a.exec_code === "linkedin_ads_launch_refused") return "Zavi stopped this before anything reached LinkedIn. Fix what the note says, then choose Try again.";
  if (a.exec_bucket === "blocked_on_us" && a.exec_code === "chatgpt_ads_launch_undone") return "Zavi archived this campaign after it could not launch, so it is not running. Ask again to start a new one.";
  if (a.exec_bucket === "blocked_on_us" && a.exec_code === "linkedin_ads_post_author_refused" && /no longer on LinkedIn/.test(a.note ?? "")) return (a.note ?? "").trim();
  if (a.exec_bucket === "blocked_on_us" && a.exec_code === "linkedin_ads_post_author_refused") return "Zavi closed this card. Start a new campaign with a post from the page this ad account advertises for.";
  if (a.exec_bucket === "blocked_on_us" && a.exec_code === "linkedin_ads_account_changed") return "Zavi closed this card. Start a new campaign and review it again.";
  if (a.exec_bucket === "blocked_on_us" && a.exec_code === "linkedin_ads_launch_not_reopened") return "Nothing was sent to LinkedIn. Zavi closed this card. Review the launch again to send a new one.";
  if (a.exec_bucket === "blocked_on_us") return `${platformName} refused this change. We've been alerted; nothing for you to do.`;
  if (a.exec_bucket === "temporary") return execCopy?.temporaryHint ?? `A temporary problem at ${platformName}. Try again.`;
  if (a.exec_bucket === "needs_founder" && a.exec_fix_text) return "Once that's done, approve it again.";
  return execCopy ? execCopy.failedHint : "Check the account before approving again: part of it may have gone through.";
}

type FailCopy = { failedTitle: string; failedHint: string; partialTitle?: string; temporaryHint?: string };

export function ExecFailedBody({
  a,
  platformName,
  execCopy,
}: {
  a: ActionItem;
  platformName: string;
  execCopy?: FailCopy;
}) {
  const fix = a.exec_bucket === "needs_founder" && a.exec_fix_text ? a.exec_fix_text : null;
  const budget = isAdBudgetHeld(a);
  const topUp = a.exec_code === "insufficient_credits";
  const checkout = a.exec_checkout_url ?? null;
  const partialRisk = isPartialRiskExecCode(a.exec_code) || a.exec_bucket === "partial_risk";
  const partial = partialRisk ? (execCopy?.partialTitle ?? null) : null;
  const noRetry = partialRisk || a.exec_bucket === "blocked_on_us";
  const unsure = !a.exec_bucket && !execCopy;
  const hint = noRetry || unsure ? execFailedHint(a, platformName, execCopy) : null;
  const note = (a.note ?? "").trim();
  const said = (s: string | null) =>
    !!s && (note.toLowerCase().includes(s.toLowerCase()) || s.toLowerCase().includes(note.toLowerCase()));
  const reason = note && a.exec_bucket !== "blocked_on_us" && !said(fix) && !said(hint) && !said(partial) ? note : null;
  if (!fix && !budget && !topUp && !checkout && !hint && !reason) return null;
  return (
    <div data-testid="exec-failed-body" className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      {reason && <p data-testid="exec-reason">{reason}</p>}
      {fix && (
        <p data-testid="exec-fix" className="font-medium">
          This needs you: {fix}.
        </p>
      )}
      {hint && <p>{hint}</p>}
      {budget && (
        <a href={AD_BUDGET_URL} data-testid="exec-ad-budget" className="font-medium underline underline-offset-2">
          Open ad budget settings
        </a>
      )}
      {topUp && (
        <a href={BILLING_URL} data-testid="exec-top-up" className="font-medium underline underline-offset-2">
          Top up credits
        </a>
      )}
      {checkout && (
        <a href={checkout} target="_blank" rel="noopener noreferrer" data-testid="exec-checkout" className="font-medium underline underline-offset-2">
          Pay with Stripe Checkout
        </a>
      )}
    </div>
  );
}

export function execFailureToast(
  a: ActionItem,
  platformName: string,
  execCopy?: { failedTitle: string; failedHint: string },
): { title: string; description: string } {
  const title = execFailedTitle(a, platformName, execCopy).replace(/[.!]+$/, "");
  const reason = (a.note ?? "").trim().split(/(?<=[.!?])\s+/)[0]?.trim();
  return { title, description: reason || execFailedHint(a, platformName, execCopy) };
}

const TOASTED_KEY = "zavi:exec-failure-toasts";
const toastedNow = new Set<string>();
const toastedAt = new Map<string, number>();

function readToasted(): Set<string> {
  try {
    const raw = window.localStorage.getItem(TOASTED_KEY);
    const ids = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set([...toastedNow, ...(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [])]);
  } catch {
    return new Set(toastedNow);
  }
}

function rememberToasted(id: string) {
  toastedNow.add(id);
  try {
    const ids = readToasted();
    ids.add(id);
    window.localStorage.setItem(TOASTED_KEY, JSON.stringify(Array.from(ids).slice(-200)));
  } catch {
    return;
  }
}

export function resetExecFailureToasts() {
  toastedNow.clear();
  seenInFlight.clear();
  toastedAt.clear();
  try {
    window.localStorage.removeItem(TOASTED_KEY);
  } catch {
    return;
  }
}

const seenInFlight = new Set<string>();

export function useExecFailureToast(
  a: ActionItem,
  platformName: string,
  execCopy?: { failedTitle: string; failedHint: string },
) {
  const prev = useRef(a.exec_status);
  const failed = a.exec_status === "failed";
  if (execInFlight(a)) seenInFlight.add(a.id);
  useEffect(() => {
    const was = prev.current;
    prev.current = a.exec_status;
    if (!failed) return;
    const retried = was !== null && was !== undefined && was !== "failed";
    if (!retried && a.status !== "pending" && !seenInFlight.has(a.id)) return;
    seenInFlight.delete(a.id);
    if (!retried && readToasted().has(a.id)) return;
    const last = toastedAt.get(a.id);
    if (last !== undefined && Date.now() - last < 3000) return;
    toastedAt.set(a.id, Date.now());
    rememberToasted(a.id);
    toast.add({ type: "error", timeout: 7000, ...execFailureToast(a, platformName, execCopy) });
  }, [failed, a, platformName, execCopy]);
}
