"use client";

import { Button } from "@/components/ui/Button";
import { useChannelSurface } from "./ChannelSurface";
import { cn } from "@/lib/cn";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy, ExternalLink, MessageSquare, MoreHorizontal, Pencil, X } from "lucide-react";
import { ActionTooltip, explainControl } from "./ActionTooltip";
import { actionHint } from "./actionHints";
import { btn } from "./ui";
import { PopMenu, type PopMenuItem as MenuItem } from "./PopMenu";
import { blanksLine, copyLabel, findBlanks, withBlanks } from "./blanks";
import type { ActionHandlers, ActionItem } from "./types";
import { Panels, DoneButton, rejectItem, snoozeItem, redoItem, type Panel } from "./ActionFooter";

export function PostFooter({
  a,
  handlers,
  busy,
  text,
  thread,
  imagePath,
  postRevision,
  editing,
  onToggleEdit,
  platformName,
  composerHref,
  composerLabel,
  blockedReason,
  copyAllText = null,
  canSnooze = true,
  canRedo = true,
  directPublishOnly = false,
  publishLabel,
  manualPost = false,
}: {
  a: ActionItem;
  handlers: ActionHandlers;
  busy?: boolean;

  text: string;
  thread: string[] | null;
  imagePath?: string;
  postRevision?: string;
  editing: boolean;
  onToggleEdit: () => void;
  platformName: string;
  composerHref: string | null;

  composerLabel?: string;


  blockedReason: string | null;

  copyAllText?: string | null;
  canSnooze?: boolean;
  canRedo?: boolean;
  directPublishOnly?: boolean;
  publishLabel?: string;
  manualPost?: boolean;
}) {
  const reference = !!useChannelSurface();
  const [panel, setPanel] = useState<Panel>(null);
  const [posting, setPosting] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const stored = (a.card_kind === "post" || a.card_kind === "copy_to_site") && !!a.primary_label;
  const [handedOff, setHandedOff] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copiedTimer.current) clearTimeout(copiedTimer.current); }, []);
  const doneWords = a.done_label ?? "Done";

  const publish = async () => {
    if (!handlers.onPublish) return;
    setPosting(true);
    try {
      if (await handlers.onPublish(a, { text, thread, ...(imagePath ? { image_path: imagePath } : {}), ...(postRevision ? { post_revision: postRevision } : {}) })) await handlers.onSetStatus(a, "acted", { via: "publish" });
    } finally {
      setPosting(false);
    }
  };
  const fullText = [text, ...(thread ?? [])].join("\n\n");
  const blanks = findBlanks(fullText);
  const [copyNote, setCopyNote] = useState<{ text: string; line: string | null } | null>(null);
  const copyLine = copyNote?.text === fullText ? copyNote.line : null;
  const blocked = !!blockedReason;
  const linkLabel = stored ? (a.primary_label as string) : (composerLabel ?? "Post");
  const openComposer = () => {
    if (!composerHref) return;
    try {
      window.open(composerHref, "_blank", "noopener,noreferrer");
    } catch {
    }
  };
  const composerLink = (style: string): ReactNode =>
    !composerHref ? null : blocked ? (
      <button type="button" disabled className={style} title={`Opens ${platformName}`}>
        {linkLabel}
      </button>
    ) : (
      <a
        href={composerHref}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => setHandedOff(true)}
        title={`Opens ${platformName} with this post filled in. Nothing posts until you press Post there.`}
        className={cn(style, "inline-flex items-center gap-2")}
      >
        {linkLabel}
        <ExternalLink className="h-3.5 w-3.5" aria-hidden />
      </a>
    );
  const canPublish = !!handlers.onPublish && (directPublishOnly || !(composerLabel && !composerHref));

  const storedDone = (
    <button type="button" data-done disabled={busy} onClick={() => void handlers.onSetStatus(a, "acted")} className={cn(btn.primary, "inline-flex items-center gap-2")}>
      <Check className="h-4 w-4" aria-hidden />
      {doneWords}
    </button>
  );
  const storedCopy = (
    <button
      type="button"
      data-primary
      disabled={blocked}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(fullText)
          .then(() => setHint(withBlanks("Copied. Paste it where it goes, then come back.", blanks)))
          .catch(() => setHint(withBlanks("Your browser blocked copying. Select the post on this card and copy it.", blanks)));
        setHandedOff(true);
      }}
      className={btn.primary}
    >
      {copyLabel(a.primary_label ?? "", blanks)}
    </button>
  );
  const post: ReactNode =
    !directPublishOnly && stored && handedOff
      ? storedDone
      : !directPublishOnly && stored && a.card_kind === "copy_to_site"
        ? storedCopy
        : canPublish || directPublishOnly ? (
            <button type="button" disabled={busy || posting || blocked || !canPublish} onClick={() => void publish()} className={btn.primary}>
              {posting ? "Posting…" : publishLabel ?? (stored && !directPublishOnly ? a.primary_label : "Post")}
            </button>
          ) : (
            composerLink(btn.primary)
          );
  const postOperation = !directPublishOnly && stored && handedOff ? "done"
    : !directPublishOnly && stored && a.card_kind === "copy_to_site" ? "copy"
    : canPublish || directPublishOnly ? "publish" : "composer";
  const postLabel = postOperation === "done" ? doneWords : postOperation === "publish" ? publishLabel ?? "Post" : linkLabel;
  const copyNow = () => {
    void navigator.clipboard
      ?.writeText(fullText)
      .then(() => {
        setCopied(true);
        if (copiedTimer.current) clearTimeout(copiedTimer.current);
        copiedTimer.current = setTimeout(() => setCopied(false), 1800);
      })
      .catch(() => setCopied(false));
  };
  const postHint = actionHint(a, postOperation, postOperation === "done" ? undefined : blockedReason ?? undefined);
  const more: MenuItem[] = [
    ...(reference && handlers.onOpenChat ? [{ label: "Ask Zavi", tooltip: actionHint(a, "ask"), icon: <MessageSquare className="size-4" aria-hidden />, onSelect: () => handlers.onOpenChat?.(a) }] : []),
    ...(!directPublishOnly && canPublish && composerLabel && composerHref
      ? [{ label: composerLabel, tooltip: actionHint(a, "composer", blockedReason ?? undefined), hint: `Opens ${platformName}. Nothing posts until you press Post there.`, icon: <ExternalLink className="h-4 w-4" aria-hidden />, onSelect: openComposer, disabled: blocked }]
      : []),
    ...(!editing ? [{ label: "Edit", tooltip: actionHint(a, "edit"), hint: "Change the words here, before it goes out", icon: <Pencil className="h-4 w-4" aria-hidden />, onSelect: onToggleEdit }] : []),
    ...(!directPublishOnly ? [{
      label: blanks.length ? "Copy with blanks" : "Copy",
      tooltip: actionHint(a, "copy", blanks.length ? "Copy the post including its unfilled blanks. Fill them before publishing." : undefined),
      ...(blanks.length ? { hint: copyLabel("Copies it as it is", blanks) } : {}),
      icon: <Copy className="h-4 w-4" aria-hidden />,
      onSelect: () => {
        void navigator.clipboard?.writeText(fullText).catch(() => undefined);
        setCopyNote({ text: fullText, line: blanksLine(blanks) });
      },
    }] : []),
    ...(!directPublishOnly && copyAllText
      ? [
          {
            label: "Copy all",
            tooltip: actionHint(a, "copyAll", findBlanks(copyAllText).length ? "Fill the blanks in every part before copying all parts." : undefined),
            ...(findBlanks(copyAllText).length
              ? { hint: "Fill the blanks in each part first", disabled: true }
              : { hint: "Copies every part, each under its label" }),
            icon: <Copy className="h-4 w-4" aria-hidden />,
            onSelect: () => void navigator.clipboard?.writeText(copyAllText).catch(() => undefined),
          },
        ]
      : []),
    ...((!directPublishOnly || manualPost) && post ? [{ label: doneWords, tooltip: actionHint(a, "done"), hint: "You posted it yourself", icon: <Check className="h-4 w-4" aria-hidden />, onSelect: () => void handlers.onSetStatus(a, "acted"), disabled: busy }] : []),
    rejectItem(setPanel, undefined, a),
    ...(canSnooze ? [snoozeItem(setPanel, undefined, a)] : []),
    ...(canRedo ? [redoItem(a, handlers, setPanel)] : []),
  ];

  return (
    <>
      <Panels a={a} handlers={handlers} busy={busy} panel={panel} setPanel={setPanel} />
      <div data-testid="split-footer-row" className="flex flex-wrap items-center gap-2">
        {editing ? explainControl(
          <button type="button" disabled={busy} onClick={onToggleEdit} className={cn(btn.primary, "inline-flex items-center gap-2")}>
            Done editing
          </button>, actionHint(a, "finishEdit"), "Done editing"
        ) : (
          (post ? explainControl(post, postHint, postLabel) : <DoneButton a={a} handlers={handlers} busy={busy} primary />)
        )}
        {manualPost && !editing && (
          <ActionTooltip description={actionHint(a, "copy")} label={copied ? "Copied" : "Copy"}>
            <button type="button" onClick={copyNow} className={btn.secondary}>
              {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
              {copied ? "Copied" : "Copy"}
            </button>
          </ActionTooltip>
        )}
        {!reference && handlers.onOpenChat && (
          <ActionTooltip description={actionHint(a, "ask")} label="Ask Zavi">
            <button
              type="button"
              onClick={() => handlers.onOpenChat?.(a)}
              className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-cta border border-rule bg-cream px-3.5 text-[14px] font-medium text-ink hover:bg-creamDeep"
            >
              <MessageSquare className="h-4 w-4" aria-hidden />
              Ask Zavi
            </button>
          </ActionTooltip>
        )}
        {reference && !editing && (
          <>
            <ActionTooltip description={actionHint(a, "edit")} label="Edit">
              <Button type="button" disabled={busy || posting} onClick={onToggleEdit} className="h-9 gap-2 rounded-xl text-sm"><Pencil className="size-4" aria-hidden />Edit</Button>
            </ActionTooltip>
            <ActionTooltip description={actionHint(a, "reject")} label="Reject">
              <Button type="button" disabled={busy || posting} onClick={() => setPanel("reject")} className="h-9 gap-2 rounded-xl text-sm"><X className="size-4" aria-hidden />Reject</Button>
            </ActionTooltip>
          </>
        )}
        <PopMenu
          description={actionHint(a, "more")}
          tooltipClassName="ml-auto"
          items={more}
          width="w-72"
          label="More actions"
          disabled={busy || posting}
          className="ml-auto grid size-9 cursor-pointer place-items-center rounded-lg text-inkMuted hover:bg-creamDeep hover:text-ink"
          trigger={() => <MoreHorizontal className="h-4 w-4" aria-hidden />}
        />
      </div>
      {copyLine && !hint && (
        <p data-testid="copy-blanks" role="status" className="mt-3 rounded-xl bg-creamDeep px-4 py-3 text-sm font-medium text-ink">
          {copyLine}
        </p>
      )}
      {hint && (
        <p data-testid="handoff-hint" role="status" className="mt-3 rounded-xl bg-creamDeep px-4 py-3 text-sm font-medium text-ink">
          {hint}{" "}
          {composerHref && (
            <a href={composerHref} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
              Didn&apos;t open? Open it here
            </a>
          )}
        </p>
      )}
    </>
  );
}
