"use client";

import { ANSWER_CHECK_SLUG, ANSWER_CHECK_WORDS } from "../answerCheck";
import { MAILTO_MAX, devMail, openDevMail } from "../devMail";
import { channelScanHandle } from "../../layout/channelScanHandle";
import { mailParts } from "../StoredPrimary";
import { handToZaviBuilder, zaviBuilderDraft } from "../zaviBuilder";
import { postContent, type ActionHandlers, type ActionItem } from "../types";
import { snoozeUntil } from "../ActionFooter";
import { isStranded } from "../StatusBanner";
import type { PrimarySpec } from "./cardPrimary";
import type { CardFlowEvent } from "./useCardFlow";
import { useKeptCards } from "./keptCards";

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

const okOf = (r: unknown) => r !== false;

type PublishContent = Parameters<NonNullable<ActionHandlers["onPublish"]>>[1];
type StatusOpts = { until?: string; note?: string; hold?: boolean; via?: "publish" | "answer_check" };

const STATUS_WORDS = { rejected: "Rejected", snoozed: "Not now" } as const;

export function useCardRunner({ a, handlers, primary, send, onSteps, onHint, onBalance, onAnswer, subject, publishContent }: {
  a: ActionItem;
  handlers: ActionHandlers;
  primary: PrimarySpec | null;
  send: (e: CardFlowEvent) => void;
  onSteps: () => void;
  onHint?: (hint: string | null) => void;
  onBalance?: () => void;
  onAnswer?: () => void;
  subject?: string;
  publishContent?: () => PublishContent;
}) {
  const kept = useKeptCards();
  const canUndo = !!handlers.onReopen && !isStranded(a);
  const settle = async (status: "acted" | "rejected" | "snoozed", label: string, tone: "success" | "muted", opts?: StatusOpts) => {
    kept?.keep(a);
    send({ t: "start" });
    const ok = okOf(await handlers.onSetStatus(a, status, { ...opts, keep: true }));
    send(ok ? { t: "resolve", tone, label, undo: canUndo, moving: true, away: status === "snoozed" } : { t: "fail" });
    if (!ok) kept?.release(a.id);
    return ok;
  };
  const perform = async (call: () => unknown, label: string, undo: boolean, tone: "success" | "muted" = "success") => {
    kept?.keep(a);
    send({ t: "start" });
    const ok = okOf(await call());
    send(ok ? { t: "resolve", tone, label, undo: undo && canUndo } : { t: "fail" });
    if (!ok) kept?.release(a.id);
  };
  const leaveNow = (status: "rejected" | "snoozed", label: string, opts?: StatusOpts) => {
    kept?.keep(a);
    send({ t: "resolve", tone: "muted", label, undo: canUndo, moving: true, closing: true });
    void Promise.resolve(handlers.onSetStatus(a, status, { ...opts, keep: true })).then((r) => {
      if (!okOf(r)) {
        send({ t: "undo" });
        kept?.release(a.id);
      }
    });
  };
  const text = primary?.text ?? null;

  const approve = () => {
    if (primary && handlers.onApprove) void perform(() => handlers.onApprove!(a), primary.resolved, false, "muted");
  };
  const publish = async (resolved: string) => {
    kept?.keep(a);
    send({ t: "start" });
    let posted = false;
    try {
      posted = await handlers.onPublish!(a, publishContent ? publishContent() : postContent(a));
    } catch {
      posted = false;
    }
    if (!posted) {
      send({ t: "fail" });
      kept?.release(a.id);
      return;
    }
    let saved = true;
    try {
      saved = okOf(await handlers.onSetStatus(a, "acted", { keep: true, via: "publish" }));
    } catch {
      saved = false;
    }
    send({ t: "resolve", tone: saved ? "success" : "muted", label: saved ? resolved : `${resolved}. Zavi could not update this card, so do not post it again.`, undo: false, moving: saved });
  };
  const createAudiences = async () => {
    kept?.keep(a);
    onHint?.(null);
    send({ t: "start" });
    let out: Awaited<ReturnType<NonNullable<ActionHandlers["onCreateAudiences"]>>>;
    try {
      out = await handlers.onCreateAudiences!(a, text);
    } catch {
      out = { ok: false, message: "Zavi could not reach LinkedIn, so no audience was saved. Try again." };
    }
    if (out.ok) {
      send({ t: "resolve", tone: "success", label: primary?.resolved ?? "Saved to LinkedIn", undo: false, moving: true });
      return;
    }
    if (out.message) onHint?.(out.message);
    send({ t: "fail" });
    kept?.release(a.id);
  };
  const checkAnswers = (resolved: string) => {
    const handle = channelScanHandle(ANSWER_CHECK_SLUG);
    if (!handle) return;
    const s = handle.status();
    const why = !s.ready && !s.loaded ? ANSWER_CHECK_WORDS.loading : !s.ready ? ANSWER_CHECK_WORDS.notReady : s.running ? ANSWER_CHECK_WORDS.running : s.blockedWhy;
    if (why || !s.canScan) {
      onHint?.(why ?? ANSWER_CHECK_WORDS.notReady);
      return;
    }
    void handle.scan().then((err) => {
      if (err === "upgrade") return;
      if (err) {
        onHint?.(err);
        return;
      }
      onHint?.(ANSWER_CHECK_WORDS.started);
      void settle("acted", resolved, "success", { via: "answer_check" });
    });
  };

  const run = () => {
    if (!primary) return;
    switch (primary.mode) {
      case "review":
        handlers.onReviewExecute?.();
        return;
      case "approve":
        approve();
        return;
      case "balance":
        onBalance?.();
        return;
      case "publish":
        void publish(primary.resolved);
        return;
      case "answerCheck":
        checkAnswers(primary.resolved);
        return;
      case "audience":
        if (handlers.onCreateAudiences) void createAudiences();
        return;
      case "plan":
      case "done":
        void settle("acted", primary.resolved, "success");
        return;
      case "answer":
        if (handlers.onOpenAnswerChat) handlers.onOpenAnswerChat(a);
        else onAnswer?.();
        return;
      case "copy":
        if (text) void copy(text).then((ok) => {
          if (!ok) onHint?.("Your browser blocked copying. Select the text on this card and copy it.");
          send({ t: "await", copied: ok });
        });
        return;
      case "mail": {
        const mail = mailParts(subject ?? a.title, text);
        const full = `mailto:?subject=${encodeURIComponent(mail.subject)}&body=${encodeURIComponent(mail.body)}`;
        if (full.length <= MAILTO_MAX) {
          window.location.href = full;
        } else {
          void copy(mail.body).then((ok) => onHint?.(ok ? "Email body copied, paste it in." : "The email is too long to pass to your mail app. Copy it from this card."));
          window.location.href = `mailto:?subject=${encodeURIComponent(mail.subject)}`;
        }
        send({ t: "await" });
        return;
      }
      case "builder":
        handToZaviBuilder(zaviBuilderDraft(a, { link: primary.href ?? null, content: text }));
        send({ t: "await" });
        return;
      case "developer":
        void openDevMail(devMail(a, { link: primary.href ?? null, content: text })).then((hint) => onHint?.(hint));
        send({ t: "await" });
        return;
      case "external":
        if (primary.href) window.open(primary.href, "_blank", "noopener,noreferrer");
        send({ t: "await" });
        return;
      case "steps":
        onSteps();
        send({ t: "await" });
        return;
    }
  };

  return {
    run,
    confirm: () => primary && void settle("acted", primary.resolved, "success"),
    approve,
    handoff: () => send({ t: "await" }),
    panelHandlers: {
      ...handlers,
      onSetStatus: (_: ActionItem, status: "acted" | "rejected" | "snoozed", opts?: StatusOpts) =>
        settle(status, status === "acted" ? a.done_label ?? "Done" : STATUS_WORDS[status], status === "acted" ? "success" : "muted", opts),
    } as ActionHandlers,
    close: () => leaveNow("rejected", "Closed"),
    snooze: () => {
      const until = snoozeUntil(7);
      leaveNow("snoozed", `Not now · Back on ${new Date(until).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`, { until });
    },
    undo: async () => {
      if (!handlers.onReopen) return;
      if (await handlers.onReopen(a)) {
        send({ t: "undo" });
        kept?.release(a.id);
      }
    },
    back: () => send({ t: "back" }),
    canUndo,
    leave: kept ? () => kept.release(a.id) : null,
  };
}
