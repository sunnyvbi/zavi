"use client";

import { useId, useRef, useState } from "react";
import { dismissTeamNote, sendTeamNote } from "@/lib/workspace/teamNote";
import { useModalFocusTrap } from "../layout/shared";

type Phase = "idle" | "sending" | "failed" | "dismiss_failed";

export function TeamNotePanel({
  messageId,
  note: initialNote,
  onClose,
  onSent,
  onDismissed,
}: {
  messageId: string;
  note: string;
  onClose: () => void;
  onSent: () => void;
  onDismissed: () => void;
}) {
  const [note, setNote] = useState(initialNote);
  const [extra, setExtra] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const busy = phase === "sending";
  const dialogRef = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
  useModalFocusTrap(dialogRef, onClose, busy, noteRef);

  async function send() {
    const body = extra.trim() ? { note: note.trim(), extra: extra.trim() } : { note: note.trim() };
    setPhase("sending");
    try {
      await sendTeamNote(messageId, body);
      setPhase("idle");
      onSent();
    } catch {
      setPhase("failed");
    }
  }

  async function dismiss() {
    setPhase("sending");
    try {
      await dismissTeamNote(messageId, false);
      setPhase("idle");
      onDismissed();
    } catch {
      setPhase("dismiss_failed");
    }
  }

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col gap-3 border-l border-rule bg-white p-4 font-sans text-[14px] shadow-xl outline-none"
    >
      <div className="flex items-center justify-between">
        <h2 id={titleId} className="font-medium text-ink">Tell the Zavi team</h2>
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          aria-label="Close"
          className="inline-flex h-8 w-8 items-center justify-center rounded-full text-inkMuted hover:bg-ink/5 hover:text-ink disabled:opacity-60"
        >
          <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>
      <label className="flex flex-col gap-1 font-medium text-ink">
        Note to the Zavi team
        <textarea ref={noteRef} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)}
          className="min-h-[96px] rounded-md border border-rule p-2 font-normal" />
      </label>
      <label className="flex flex-col gap-1 font-medium text-ink">
        Anything to add?
        <textarea value={extra} maxLength={2000} onChange={(e) => setExtra(e.target.value)}
          className="min-h-[72px] rounded-md border border-rule p-2 font-normal" />
      </label>
      {phase === "failed" && <p role="alert" className="text-red-700">Not sent, try again</p>}
      {phase === "dismiss_failed" && <p role="alert" className="text-red-700">Couldn&apos;t save that, try again</p>}
      <div className="flex gap-2">
        <button type="button" disabled={busy || !note.trim()} onClick={() => void send()}
          className="rounded-cta bg-ink px-3 py-1.5 text-white disabled:opacity-60">Send to Zavi team</button>
        <button type="button" disabled={busy} onClick={() => void dismiss()}
          className="px-3 py-1.5 text-inkMuted disabled:opacity-60">Dismiss</button>
      </div>
    </div>
  );
}
