"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { readReplyRating, rememberReplyRating } from "@/lib/workspace/replyRatings";
import { Button } from "@/components/ui/Button";
import { cx, FOCUS_RING, MESSAGE_ACTION_BUTTON, MESSAGE_ACTION_ICON } from "@/components/workspace/layout/shared";

function IconThumbUp() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-[15px] w-[15px]">
      <path d="M7 11v9H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3Zm0 0 4-7a2 2 0 0 1 2 2v3h5a2 2 0 0 1 2 2.3l-1.2 6A2 2 0 0 1 17.8 20H7" />
    </svg>
  );
}
function IconThumbDown() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-[15px] w-[15px]">
      <path d="M17 13V4h3a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-3Zm0 0-4 7a2 2 0 0 1-2-2v-3H6a2 2 0 0 1-2-2.3l1.2-6A2 2 0 0 1 6.2 4H17" />
    </svg>
  );
}
export type FeedbackTargetType = "agent_run" | "decision";

type Submitted = {
  rating: -1 | 1;
};

type Props = {
  targetType: FeedbackTargetType;
  targetId: string;
  agentSlug: string;
  compact?: boolean;
  trailing?: ReactNode;
  noteOnBad?: boolean;
};

export function FeedbackInline({
  targetType,
  targetId,
  agentSlug,
  compact = false,
  trailing,
  noteOnBad = false,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState<Submitted | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [noteSent, setNoteSent] = useState(false);
  const [pending, setPending] = useState<-1 | 1 | null>(null);
  const [ready, setReady] = useState(!noteOnBad);

  useEffect(() => {
    if (!noteOnBad) return;
    setReady(false);
    return readReplyRating(targetId, (saved) => {
      if (saved) setSubmitted((prev) => prev ?? { rating: saved });
      setReady(true);
    });
  }, [noteOnBad, targetId]);

  async function post(rating: -1 | 1, comment: string | null): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/feedback", {
        method: "POST",
        body: JSON.stringify({
          target_type: targetType,
          target_id: targetId,
          rating,
          comment,
        }),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      setSubmitted({ rating });
      if (noteOnBad) rememberReplyRating(targetId, rating);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function send(rating: -1 | 1) {
    if (noteOnBad && submitted?.rating === rating) return;
    setPending(rating);
    const ok = await post(rating, null);
    setPending(null);
    if (!noteOnBad || !ok) return;
    setNoteSent(false);
    setNote("");
    setNoteOpen(rating === -1);
  }

  async function sendNote() {
    const text = note.trim();
    if (!text) return;
    if (await post(-1, text)) {
      setNoteOpen(false);
      setNoteSent(true);
    }
  }

  if (submitted && !noteOnBad) {
    const tag =
      submitted.rating === 1
        ? "thumbs-up"
        : "thumbs-down";
    return (
      <div className="flex items-center gap-2" data-agent-slug={agentSlug}>
        {}
        {trailing && <div className="flex items-center gap-0.5">{trailing}</div>}
        <div className="text-[12px] text-inkMuted font-mono">
          ✓ feedback recorded ({tag}). Thanks, the agent will see this on its next
          run.
        </div>
      </div>
    );
  }

  const iconBtn = noteOnBad
    ? cx(MESSAGE_ACTION_BUTTON, FOCUS_RING)
    : "inline-flex h-8 w-8 items-center justify-center rounded-cta text-[#8a8a8a] transition-colors hover:bg-ink/[0.06] hover:text-ink disabled:opacity-50";
  const picked = noteOnBad ? pending ?? submitted?.rating ?? null : null;
  const tone = (rating: -1 | 1) => (!noteOnBad ? "" : picked === rating ? "text-ink" : "text-inkMuted");

  return (
    <div className="space-y-1.5" data-agent-slug={agentSlug}>
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={(e) => {
            if (e.detail > 0) e.currentTarget.blur();
            void send(1);
          }}
          disabled={busy || !ready}
          aria-label="Good response"
          aria-pressed={noteOnBad ? picked === 1 : undefined}
          title="Good response"
          className={noteOnBad ? cx(iconBtn, tone(1)) : `${iconBtn} hover:text-emerald-700`}
        >
          {noteOnBad ? (
            <ThumbsUp aria-hidden {...MESSAGE_ACTION_ICON} fill={picked === 1 ? "currentColor" : "none"} />
          ) : (
            <IconThumbUp />
          )}
        </button>
        <button
          type="button"
          onClick={(e) => {
            if (e.detail > 0) e.currentTarget.blur();
            void send(-1);
          }}
          disabled={busy || !ready}
          aria-label="Bad response"
          aria-pressed={noteOnBad ? picked === -1 : undefined}
          title="Bad response"
          className={noteOnBad ? cx(iconBtn, tone(-1)) : `${iconBtn} hover:text-rose-700`}
        >
          {noteOnBad ? (
            <ThumbsDown aria-hidden {...MESSAGE_ACTION_ICON} fill={picked === -1 ? "currentColor" : "none"} />
          ) : (
            <IconThumbDown />
          )}
        </button>
        {}
        {trailing}
        {noteSent && <span className="ml-1.5 text-[13px] text-inkMuted">Thanks for the feedback</span>}
      </div>
      {noteOpen && (
        <form
          className="max-w-[560px] rounded-xl border border-rule bg-cream p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void sendNote();
          }}
        >
          <textarea
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setNoteOpen(false);
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void sendNote();
              }
            }}
            maxLength={500}
            rows={2}
            placeholder="What was wrong with this reply? (optional)"
            aria-label="What was wrong with this reply"
            className="w-full resize-none rounded-lg border border-rule bg-white px-3 py-2 text-[14px] leading-[1.5] text-ink placeholder:text-inkLight focus:border-ink/30 focus:outline-none"
          />
          <div className="mt-2 flex justify-end gap-2">
            <Button className="h-8 px-3" onClick={() => setNoteOpen(false)}>
              Skip
            </Button>
            <Button type="submit" variant="primary" className="h-8 px-3" disabled={busy || !note.trim()}>
              Send
            </Button>
          </div>
        </form>
      )}
      {error && (
        <div className="font-mono text-[11px] text-rose-700">{error}</div>
      )}
    </div>
  );
}
