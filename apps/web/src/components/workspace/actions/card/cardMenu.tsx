"use client";

import { Check, Copy, ExternalLink, Mail, MessageSquare, MoreHorizontal, Pencil } from "lucide-react";
import { CHECK_CARD_PREFIX } from "../../agent/cardViews";
import { redoItem, rejectItem, rewriteItem, snoozeItem, type Panel } from "../ActionFooter";
import { actionHint } from "../actionHints";
import { copyLabel, findBlanks } from "../blanks";
import { devMail, isDeveloperCard, openDevMail } from "../devMail";
import { PopMenu, type PopMenuItem } from "../PopMenu";
import type { ActionHandlers, ActionItem } from "../types";
import type { PrimarySpec } from "./cardPrimary";

export function cardMenuItems({ a, handlers, primary, disabled, post, directPublish, manualPost, canCopy, shown, text, kind, copyAll, composer, onEdit, onAsk, setPanel, onCopied, onHint }: {
  a: ActionItem;
  handlers: ActionHandlers;
  primary: PrimarySpec | null;
  disabled: boolean;
  post: boolean;
  directPublish: boolean;
  manualPost: boolean;
  canCopy: boolean;
  shown: ReadonlySet<string>;
  text: string | null;
  kind: string | null;
  copyAll: string | null;
  composer: { label: string; href: string } | null;
  onEdit: (() => void) | null;
  onAsk: () => void;
  setPanel: (p: Panel) => void;
  onCopied: (text: string) => void;
  onHint: (hint: string | null) => void;
}): PopMenuItem[] {
  const blanks = findBlanks(text, kind);
  const isCheck = a.id.startsWith(CHECK_CARD_PREFIX);
  const copies = !!text && !a.executable && canCopy;
  const doneWords = a.executable ? "I did this" : (a.done_label ?? "Done");
  const allBlanks = copyAll ? findBlanks(copyAll).length : 0;
  const mailsDev = isDeveloperCard(a) && !a.executable && a.card_kind !== "task" && !!text;
  return [
    ...(!shown.has("ask") && handlers.onOpenChat ? [{ label: "Ask Zavi", tooltip: actionHint(a, "ask"), icon: <MessageSquare className="size-4" aria-hidden />, onSelect: onAsk }] : []),
    ...(onEdit && !shown.has("edit") ? [{ label: "Edit", tooltip: actionHint(a, "edit"), hint: "Change the words here, before it goes out", icon: <Pencil className="size-4" aria-hidden />, onSelect: onEdit }] : []),
    ...(composer ? [{ label: composer.label, tooltip: actionHint(a, "composer"), icon: <ExternalLink className="size-4" aria-hidden />, onSelect: () => window.open(composer.href, "_blank", "noopener,noreferrer") }] : []),
    ...(copies ? [{
      label: blanks.length ? "Copy with blanks" : "Copy",
      tooltip: actionHint(a, "copy", blanks.length ? "Copy the current text including its unfilled blanks. Fill them before publishing or sending it." : undefined),
      ...(blanks.length ? { hint: copyLabel("Copies it as it is", blanks) } : {}),
      icon: <Copy className="size-4" aria-hidden />,
      onSelect: () => onCopied(text!),
    }] : []),
    ...(copyAll ? [{
      label: "Copy all",
      tooltip: actionHint(a, "copyAll", allBlanks ? "Fill the blanks in every part before copying all parts." : undefined),
      ...(allBlanks ? { hint: "Fill the blanks in each part first", disabled: true } : { hint: "Copies every part, each under its label" }),
      icon: <Copy className="size-4" aria-hidden />,
      onSelect: () => void navigator.clipboard?.writeText(copyAll).catch(() => undefined),
    }] : []),
    ...(mailsDev ? [{
      label: "Email this to your developer",
      tooltip: actionHint(a, "email"),
      hint: "Opens your mail app with the steps and the text",
      icon: <Mail className="size-4" aria-hidden />,
      disabled: blanks.length > 0,
      onSelect: () => void openDevMail(devMail(a, { link: primary?.href ?? null, content: text })).then(onHint),
    }] : []),
    ...(primary?.mode !== "done" && (!directPublish || manualPost) ? [{ label: doneWords, tooltip: actionHint(a, "done"), icon: <Check className="size-4" aria-hidden />, disabled, onSelect: () => void handlers.onSetStatus(a, "acted") }] : []),
    ...(post && !shown.has("reject") ? [rejectItem(setPanel, undefined, a)] : []),
    ...(!isCheck && !shown.has("notNow") ? [snoozeItem(setPanel, disabled, a)] : []),
    ...(post ? [redoItem(a, handlers, setPanel)] : !isCheck && !a.executable && handlers.onOpenRedoChat ? [rewriteItem(a, handlers)] : []),
  ];
}

export function CardMoreMenu({ a, items, disabled }: { a: ActionItem; items: PopMenuItem[]; disabled: boolean }) {
  if (!items.length) return null;
  return (
    <PopMenu
      description={actionHint(a, "more")}
      items={items}
      width="w-72"
      label="More actions"
      disabled={disabled}
      className="grid size-9 cursor-pointer place-items-center rounded-lg text-ca-secondary hover:bg-ca-hover hover:text-ca-primary disabled:opacity-50"
      trigger={() => <MoreHorizontal className="size-4" aria-hidden />}
    />
  );
}
