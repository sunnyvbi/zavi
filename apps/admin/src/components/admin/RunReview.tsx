"use client";

import { useEffect, useState } from "react";
import { adminApiFetch } from "@/lib/api-admin";

type Verdict = "score_correct" | "score_wrong" | "bug";

type Review = {
  id: number;
  verdict: string;
  ai_score_at_review: number | null;
  quality_model: string | null;
  comment: string | null;
  regression_signature: string | null;
  staff_email: string | null;
  created_at: string;
  updated_at: string;
};

const VERDICTS: { key: Verdict; label: string; hint: string; cls: string; on: string }[] = [
  {
    key: "score_correct",
    label: "Score is right",
    hint: "the AI judge graded this run correctly",
    cls: "border-emerald-300 text-emerald-800 hover:bg-emerald-50",
    on: "bg-emerald-600 text-white border-emerald-600",
  },
  {
    key: "score_wrong",
    label: "Score looks wrong",
    hint: "the judge over/under-rated this run",
    cls: "border-amber-300 text-amber-800 hover:bg-amber-50",
    on: "bg-amber-500 text-white border-amber-500",
  },
  {
    key: "bug",
    label: "This is a bug",
    hint: "real defect — mint a regression guard to fix",
    cls: "border-rose-300 text-rose-800 hover:bg-rose-50",
    on: "bg-rose-600 text-white border-rose-600",
  },
];

export function RunReview({ runId }: { runId: string }) {
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  async function load() {
    try {
      const res = await adminApiFetch(`/api/admin/runs/${runId}/review`);
      const j = await res.json().catch(() => ({}));
      if (res.ok) setReviews((j.reviews ?? []) as Review[]);
    } catch {
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!verdict) return;
    setSubmitting(true);
    setError(null);
    setOkMsg(null);
    try {
      const res = await adminApiFetch(`/api/admin/runs/${runId}/review`, {
        method: "POST",
        body: JSON.stringify({ verdict, comment: comment.trim() || null }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error?.message ?? `HTTP ${res.status}`);
      setOkMsg(
        verdict === "bug"
          ? `Bug recorded. Regression guard minted (sig ${String(j.regression_signature ?? "").slice(0, 8)}…)${j.recurrence ? " — RECURRENCE of an armed signature!" : ""}.`
          : "Verdict recorded — feeds the judge-calibration golden set.",
      );
      setComment("");
      setVerdict(null);
      await load();
    } catch (e2) {
      setError((e2 as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
      <div className="text-sm uppercase tracking-[0.14em] text-slate-500">
        Review this run
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {VERDICTS.map((v) => (
          <button
            type="button"
            key={v.key}
            onClick={() => setVerdict((cur) => (cur === v.key ? null : v.key))}
            className={
              "rounded-md border px-3 py-2 text-left transition-colors " +
              (verdict === v.key ? v.on : v.cls)
            }
          >
            <div className="text-sm font-medium">{v.label}</div>
            <div
              className={
                "text-sm mt-0.5 " +
                (verdict === v.key ? "text-white/80" : "text-slate-500")
              }
            >
              {v.hint}
            </div>
          </button>
        ))}
      </div>
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Optional: why? (for a bug, what's broken / what should it have done)"
        maxLength={2000}
        rows={2}
        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:border-skyMuted focus:ring-1 focus:ring-skyMuted"
      />
      <div className="flex items-center justify-between text-sm text-slate-500">
        <span className="font-mono">{comment.length}/2000</span>
        {error && <span className="text-rose-700">{error}</span>}
        {okMsg && <span className="text-emerald-700">{okMsg}</span>}
        <button
          type="submit"
          disabled={submitting || !verdict}
          className="rounded-md bg-slate-900 text-white px-3 py-1.5 text-sm font-medium hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? "Saving…" : "Submit verdict"}
        </button>
      </div>

      {reviews.length > 0 && (
        <ul className="border-t border-slate-100 pt-2 space-y-1.5">
          {reviews.map((r) => (
            <li key={r.id} className="flex items-center gap-2 text-sm">
              <VerdictPill verdict={r.verdict} />
              <span className="text-slate-500">
                {r.staff_email ?? "staff"}
              </span>
              {r.ai_score_at_review != null && (
                <span className="text-slate-400 font-mono">
                  judge:{r.ai_score_at_review}
                </span>
              )}
              {r.comment && <span className="text-slate-600 truncate">{r.comment}</span>}
              <span className="ml-auto text-slate-400 font-mono">
                {new Date(r.updated_at).toLocaleDateString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}

function VerdictPill({ verdict }: { verdict: string }) {
  const map: Record<string, string> = {
    score_correct: "bg-emerald-50 text-emerald-800 border-emerald-200",
    score_wrong: "bg-amber-50 text-amber-800 border-amber-200",
    bug: "bg-rose-50 text-rose-800 border-rose-200",
  };
  const label: Record<string, string> = {
    score_correct: "score ✓",
    score_wrong: "score ✗",
    bug: "bug",
  };
  const cls = map[verdict] ?? "bg-slate-50 text-slate-700 border-slate-200";
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 ${cls}`}>
      {label[verdict] ?? verdict}
    </span>
  );
}
