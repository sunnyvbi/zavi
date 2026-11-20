"use client";

import { useState, type ReactNode } from "react";
import { Check, ExternalLink } from "lucide-react";
import { explainControl } from "./ActionTooltip";
import { actionHint, type ActionOperation } from "./actionHints";
import { btn } from "./ui";
import type { ActionHandlers, ActionItem } from "./types";
import { copyLabel, findBlanks, withBlanks } from "./blanks";
import { MAILTO_MAX, devMail, isDeveloperCard, openDevMail } from "./devMail";
import { parseEmailDraft } from "./EmailDraft";
import { handToZaviBuilder, isZaviBuilderCard, zaviBuilderDraft } from "./zaviBuilder";
import { NotePanel } from "./ActionFooter";
import { ANSWER_PLACEHOLDER } from "./channelChat";
import { channelScanHandle } from "../layout/channelScanHandle";
import { ANSWER_CHECK_SLUG, ANSWER_CHECK_WORDS, answerCheckPage, isAnswerCheckCard } from "./answerCheck";

export function isAnswerCard(a: Pick<ActionItem, "card_kind" | "body">): boolean {
  return a.card_kind === "task" && (a.body?.intent ?? a.body?.step?.intent) === "answer";
}

export function opensMail(a: Pick<ActionItem, "card_kind" | "primary_label">): boolean {
  return a.card_kind === "message" && a.primary_label === "Open email";
}

export function mailParts(subject: string, text: string | null): { subject: string; body: string } {
  const draft = text ? parseEmailDraft(text) : null;
  return draft ? { subject: draft.subject, body: draft.body } : { subject, body: text ?? "" };
}

function sendsText(a: ActionItem, writesPage: boolean): boolean {
  if (writesPage) return false;
  if (a.card_kind === "message" || a.card_kind === "ad_manual" || a.card_kind === "copy_to_site") return true;
  return a.card_kind === "task" && (isZaviBuilderCard(a) || isDeveloperCard(a));
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

const GENERIC_TASK_LABELS = new Set(["Review it", "Apply change", "Create it", "Fix setup"]);

export function useStoredPrimary({
  a,
  handlers,
  busy,
  link,
  fallbackLink,
  fallbackLabel = null,
  copyText,
  copyKind,
  subject,
  onShowSteps,
  pickIndex = null,
}: {
  a: ActionItem;
  handlers: ActionHandlers;
  busy?: boolean;
  link: string | null;
  fallbackLink?: string | null;
  fallbackLabel?: string | null;
  copyText: string | null;
  copyKind?: string | null;
  subject: string;
  onShowSteps?: () => void;
  pickIndex?: number | null;
}): { primary: ReactNode; hint: ReactNode } {
  const [stage, setStage] = useState<"main" | "done">("main");
  const [hint, setHint] = useState<string | null>(null);
  const [answering, setAnswering] = useState(false);
  const label = a.primary_label ?? "";
  const mail = opensMail(a) ? mailParts(subject, copyText) : null;
  const blanks = findBlanks(mail ? `${mail.subject}\n\n${mail.body}` : copyText, copyKind);
  const pointer = blanks.length > 0 && sendsText(a, pickIndex !== null && !!handlers.onWriteProofPage);
  const doneLabel = a.done_label ?? "Done";
  const markDone = () => void handlers.onSetStatus(a, "acted");

  const doneButton = explainControl(
    <button type="button" data-done disabled={busy} onClick={markDone} className={`${btn.primary} inline-flex items-center gap-2`}>
      <Check className="h-4 w-4" aria-hidden />
      {doneLabel}
    </button>, actionHint(a, "done"), doneLabel
  );
  const hintLine = hint ? (
    <p data-testid="primary-hint" role="status" className="mt-3 rounded-xl bg-creamDeep px-4 py-3 text-[14px] font-medium text-ink">
      {hint}
    </p>
  ) : null;
  const pointerLine = pointer && !hint ? (
    <p data-testid="blanks-pointer" className="mt-3 rounded-xl bg-creamDeep px-4 py-3 text-[14px] font-medium text-ink">
      {`${blanks.length} ${blanks.length === 1 ? "blank" : "blanks"} to fill first. Type ${blanks.length === 1 ? "it" : "them"} in "Fill these in first" on this card, then press ${label}.`}
    </p>
  ) : null;
  if (stage === "done") return { primary: doneButton, hint: hintLine };
  const mainHint = hintLine ?? pointerLine;

  const pointAtBlanks = (target: HTMLElement) => {
    const card = target.closest("article") ?? document;
    const inputs = Array.from(card.querySelectorAll<HTMLInputElement>('[data-testid="blanks-fill"] input'));
    (inputs.find((i) => !i.value.trim()) ?? inputs[0])?.focus();
    setHint(`Fill the ${blanks.length} ${blanks.length === 1 ? "blank" : "blanks"} in "Fill these in first" above, then press ${label} again. To take it as it is, use Copy with blanks in the ··· menu.`);
  };
  const button = (operation: ActionOperation, onClick: () => void, external = false, sendsText = false) => {
    const waiting = sendsText && blanks.length > 0;
    return explainControl(
      <button
        type="button"
        data-primary
        disabled={busy}
        aria-disabled={waiting || undefined}
        onClick={(e) => (waiting ? pointAtBlanks(e.currentTarget) : onClick())}
        className={`${btn.primary} inline-flex items-center gap-2${waiting ? " opacity-50" : ""}`}
      >
        {sendsText ? copyLabel(label, blanks) : label}
        {external && <ExternalLink className="h-3.5 w-3.5" aria-hidden />}
      </button>, actionHint(a, operation, waiting ? "Focus the unfilled fields on this card. Fill them before continuing with this action." : undefined), label
    );
  };
  const copyThenDone = () => {
    if (!copyText) return;
    void copy(copyText).then((ok) => {
      setHint(withBlanks(ok ? "Copied. Paste it where it goes, then come back." : "Your browser blocked copying. Select the text on this card and copy it.", blanks));
      setStage("done");
    });
  };

  const toSteps = explainControl(
    <button
      type="button"
      data-primary
      disabled={busy}
      onClick={() => {
        onShowSteps?.();
        setStage("done");
      }}
      className={`${btn.primary} inline-flex items-center gap-2`}
    >
      {label}
    </button>, actionHint(a, "steps"), label
  );
  const openLink = (href: string, shown: string = label) => ({
    primary: explainControl(
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        data-primary
        onClick={() => setStage("done")}
        className={`${btn.primary} inline-flex items-center gap-2`}
      >
        {shown}
        <ExternalLink className="h-3.5 w-3.5" aria-hidden />
      </a>, actionHint(a, "open"), shown
    ),
    hint: mainHint,
  });

  if (pickIndex !== null && handlers.onWriteProofPage) {
    const write = handlers.onWriteProofPage;
    return {
      primary: button("writePage", () => {
        void Promise.resolve(write(a, pickIndex)).then((ok) => {
          if (ok !== false) setHint("Zavi is writing this page. It replaces this card in a few minutes.");
        });
      }),
      hint: mainHint,
    };
  }

  if (isAnswerCheckCard(a)) {
    const handle = channelScanHandle(ANSWER_CHECK_SLUG);
    if (!handle) {
      return {
        primary: explainControl(
          <a href={answerCheckPage()} data-primary className={`${btn.primary} inline-flex items-center gap-2`}>
            {label}
          </a>, actionHint(a, "checkAnswers"), label
        ),
        hint: mainHint,
      };
    }
    return {
      primary: button("checkAnswers", () => {
        const s = handle.status();
        const why = !s.ready && !s.loaded ? ANSWER_CHECK_WORDS.loading : !s.ready ? ANSWER_CHECK_WORDS.notReady : s.running ? ANSWER_CHECK_WORDS.running : s.blockedWhy;
        if (why || !s.canScan) {
          setHint(why ?? ANSWER_CHECK_WORDS.notReady);
          return;
        }
        void handle.scan().then((err) => {
          if (err === "upgrade") return;
          if (err) {
            setHint(err);
            return;
          }
          setHint(ANSWER_CHECK_WORDS.started);
          markDone();
        });
      }),
      hint: mainHint,
    };
  }

  switch (a.card_kind) {
    case "plan":
      return { primary: button("plan", markDone), hint: mainHint };
    case "message":
      if (label === "Open email") {
        return {
          primary: button("email", () => {
            const { subject: mailSubject, body } = mail ?? mailParts(subject, copyText);
            const full = `mailto:?subject=${encodeURIComponent(mailSubject)}&body=${encodeURIComponent(body)}`;
            if (full.length <= MAILTO_MAX) {
              window.location.href = full;
              setHint(withBlanks("Your mail app opened. Add who it's for and send it.", blanks));
            } else {
              void copy(body).then((ok) =>
                setHint(withBlanks(ok ? "Email body copied, paste it in." : "The email is too long to pass to your mail app. Copy it from this card.", blanks)),
              );
              window.location.href = `mailto:?subject=${encodeURIComponent(mailSubject)}`;
            }
            setStage("done");
          }, true, true),
          hint: mainHint,
        };
      }
      return { primary: copyText ? button("copy", copyThenDone, false, true) : toSteps, hint: mainHint };
    case "ad_manual":
    case "copy_to_site":
      return { primary: copyText ? button("copy", copyThenDone, false, true) : toSteps, hint: mainHint };
    case "task":
      if (isAnswerCard(a)) {
        if (handlers.onOpenAnswerChat) {
          const openAnswer = handlers.onOpenAnswerChat;
          return { primary: button("answer", () => openAnswer(a)), hint: mainHint };
        }
        return {
          primary: button("answer", () => setAnswering((v) => !v)),
          hint: answering ? (
            <div className="mt-3">
              <NotePanel
                a={a}
                title="Your answer"
                placeholder={ANSWER_PLACEHOLDER}
                submitLabel="Send"
                submitDescription="Send your answer to Zavi. Zavi runs this channel again with it and does the next step. Nothing is posted or changed until you say so."
                tooShortHint="Type your answer first."
                minLength={1}
                busy={busy}
                onCancel={() => setAnswering(false)}
                onSubmit={(note) => {
                  void handlers.onRedo(a, note, "answer");
                  setAnswering(false);
                }}
              />
            </div>
          ) : mainHint,
        };
      }
      if (isZaviBuilderCard(a)) {
        return {
          primary: button("builder", () => {
            setStage("done");
            handToZaviBuilder(zaviBuilderDraft(a, { link: link ?? fallbackLink ?? null, content: copyText }));
          }, false, true),
          hint: mainHint,
        };
      }
      if (isDeveloperCard(a)) {
        return {
          primary: button("email", () => {
            void openDevMail(devMail(a, { link: link ?? fallbackLink ?? null, content: copyText })).then(setHint);
            setStage("done");
          }, true, true),
          hint: mainHint,
        };
      }
      if (link) return openLink(link);
      if (fallbackLink) return openLink(fallbackLink, fallbackLabel && GENERIC_TASK_LABELS.has(label) ? fallbackLabel : label);
      return { primary: toSteps, hint: mainHint };
    default:
      return { primary: doneButton, hint: mainHint };
  }
}
