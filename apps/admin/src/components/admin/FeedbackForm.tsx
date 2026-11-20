"use client";

import { useState } from "react";
import { adminApiFetch } from "@/lib/api-admin";

type Props = {
  targetType: "agent_run" | "decision";
  targetId: string;
};

export function FeedbackForm({ targetType, targetId }: Props) {
  const [rating, setRating] = useState<-1 | 1 | null>(null);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const trimmed = comment.trim();
      if (rating === null && trimmed.length === 0) {
        throw new Error("Pick a thumb or write a comment.");
      }
      const res = await adminApiFetch("/api/admin/feedback", {
        method: "POST",
        body: JSON.stringify({
          target_type: targetType,
          target_id: targetId,
          rating,
          comment: trimmed.length > 0 ? trimmed : null,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
      }
      setSubmitted(true);
    } catch (e2) {
      setError((e2 as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
        Feedback recorded. Will land in the agent&apos;s next-run context.
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-sm uppercase tracking-[0.14em] text-slate-500">
          Admin feedback
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setRating((r) => (r === 1 ? null : 1))}
            className={
              "h-8 w-8 inline-flex items-center justify-center rounded-md border text-base transition-colors " +
              (rating === 1
                ? "bg-emerald-600 text-white border-emerald-600"
                : "border-slate-300 text-slate-700 hover:bg-emerald-50")
            }
            aria-label="thumbs up"
          >
            +
          </button>
          <button
            type="button"
            onClick={() => setRating((r) => (r === -1 ? null : -1))}
            className={
              "h-8 w-8 inline-flex items-center justify-center rounded-md border text-base transition-colors " +
              (rating === -1
                ? "bg-rose-600 text-white border-rose-600"
                : "border-slate-300 text-slate-700 hover:bg-rose-50")
            }
            aria-label="thumbs down"
          >
            −
          </button>
        </div>
      </div>
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Why is this output wrong / right? What should the agent do differently?"
        maxLength={500}
        rows={3}
        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:border-skyMuted focus:ring-1 focus:ring-skyMuted"
      />
      <div className="flex items-center justify-between text-sm text-slate-500">
        <span className="font-mono">{comment.length}/500</span>
        {error && <span className="text-rose-700">{error}</span>}
        <button
          type="submit"
          disabled={submitting || (rating === null && comment.trim().length === 0)}
          className="rounded-md bg-slate-900 text-white px-3 py-1.5 text-sm font-medium hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? "Sending…" : "Submit"}
        </button>
      </div>
    </form>
  );
}
