"use client";

import { Fragment, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { adminApiFetch } from "@/lib/api-admin";
import { HealthBadgeHeader, type AgentHealth } from "@/components/admin/HealthBadge";
import {
  TenantBackLink,
  TenantLabel,
  type TenantIdentity,
} from "@/components/admin/TenantIdentity";
import { FeedbackForm } from "@/components/admin/FeedbackForm";
import { BakeRuleForm } from "@/components/admin/BakeRuleForm";

type RunRow = {
  id: string;
  agent_slug: string;
  status: string;
  parse_ok: boolean | null;
  cost_tokens: number | null;
  cost_usd: number | null;
  started_at: string | null;
  finished_at: string | null;
  output_text: string | null;
  quality_score: number | null;
  quality_scored_at: string | null;
};

type DecisionRow = {
  id: string;
  decision_class: string;
  status: string;
  emitted_at: string;
};

type FeedbackRow = {
  id: string;
  target_type: string;
  target_id: string;
  rating: number | null;
  comment: string | null;
  created_at: string;
};

export default function AdminAgentDeepDivePage() {
  return <Body />;
}

function Body() {
  const params = useParams<{ id: string; slug: string }>();
  const tenantId = params?.id;
  const slug = params?.slug;
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [decisions, setDecisions] = useState<DecisionRow[] | null>(null);
  const [feedback, setFeedback] = useState<FeedbackRow[] | null>(null);
  const [health, setHealth] = useState<AgentHealth | undefined>(undefined);
  const [tenant, setTenant] = useState<TenantIdentity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ratingRunId, setRatingRunId] = useState<string | null>(null);

  const [noteBody, setNoteBody] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteOk, setNoteOk] = useState(false);

  useEffect(() => {
    if (!tenantId || !slug) return;
    let cancelled = false;
    setHealth(undefined);
    setTenant(null);
    setRatingRunId(null);
    setRuns(null);
    setDecisions(null);
    setFeedback(null);
    setError(null);
    (async () => {
      try {
        const [r1, r2, r3, r4] = await Promise.all([
          adminApiFetch(`/api/admin/tenants/${tenantId}/runs?slug=${encodeURIComponent(slug)}&limit=20`),
          adminApiFetch(`/api/admin/tenants/${tenantId}/decisions?limit=50`),
          adminApiFetch(`/api/admin/tenants/${tenantId}/feedback?limit=50`),
          adminApiFetch(`/api/admin/tenants/${tenantId}/agent-health`).catch(() => null),
        ]);
        const b1 = await r1.json().catch(() => ({}));
        const b2 = await r2.json().catch(() => ({}));
        const b3 = await r3.json().catch(() => ({}));
        if (!r1.ok) throw new Error(b1?.error?.message ?? `HTTP ${r1.status}`);
        if (cancelled) return;
        if (r4 && r4.ok) {
          const b4 = await r4.json().catch(() => ({}));
          const mine = ((b4.agents ?? []) as AgentHealth[]).find((h) => h.slug === slug);
          setHealth(mine);
          setTenant((b4.tenant ?? null) as TenantIdentity | null);
        }
        setRuns((b1.runs ?? []) as RunRow[]);
        const decisionsAll = (b2.decisions ?? []) as Array<DecisionRow & { handler?: string | null }>;
        setDecisions(
          decisionsAll
            .filter((d) => d.decision_class.startsWith(`${slug}.`))
            .map(({ id, decision_class, status, emitted_at }) => ({
              id,
              decision_class,
              status,
              emitted_at,
            })),
        );
        const feedbackAll = (b3.feedback ?? []) as Array<FeedbackRow & { agent_slug: string }>;
        setFeedback(
          feedbackAll
            .filter((f) => f.agent_slug === slug)
            .map(({ id, target_type, target_id, rating, comment, created_at }) => ({
              id,
              target_type,
              target_id,
              rating,
              comment,
              created_at,
            })),
        );
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, slug]);

  async function submitNote(e: React.FormEvent) {
    e.preventDefault();
    if (!noteBody.trim() || noteBusy) return;
    setNoteBusy(true);
    setNoteOk(false);
    setError(null);
    try {
      const res = await adminApiFetch(
        `/api/admin/tenants/${tenantId}/agents/${slug}/note`,
        {
          method: "POST",
          body: JSON.stringify({ body_markdown: noteBody.trim() }),
        },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      setNoteOk(true);
      setNoteBody("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setNoteBusy(false);
    }
  }

  return (
    <div className="max-w-5xl mx-auto p-6">
      <TenantBackLink tenantId={tenantId} tenant={tenant} />
      <h1 className="mt-2 flex items-center gap-3 font-display font-semibold text-2xl text-slate-900">
        <span className="text-slate-700">{slug}</span>
        <span className="text-base font-normal text-slate-500">deep dive</span>
        <HealthBadgeHeader health={health} />
      </h1>
      <p className="text-sm text-slate-500 mt-1">
        <TenantLabel tenantId={tenantId} tenant={tenant} />
      </p>

      {error && (
        <div className="mt-4 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          {error}
        </div>
      )}

      <h2 className="mt-8 mb-1 text-xs uppercase tracking-[0.16em] text-slate-500">
        Steering note · agent reads on next run
      </h2>
      <p className="mb-3 text-sm text-slate-600">
        Course-correct this agent — what to start, stop, or change. Appended to its system
        prompt on every run for the next 14 days, then auto-decays. Treated as untrusted
        guidance, not facts. Stored as a memory_note (semantically searchable across the brain)
        and stamped with your email so a bad note can be unwound.
      </p>
      <form
        onSubmit={submitNote}
        className="glass-card p-4 shadow-sm space-y-2"
      >
        <textarea
          value={noteBody}
          onChange={(e) => setNoteBody(e.target.value)}
            placeholder="e.g. Always confirm before sending money. Cap responses at 4 bullets."
            rows={3}
            maxLength={2000}
            disabled={noteBusy}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700 focus:outline-none focus:border-slate-500 focus:ring-1 focus:ring-slate-500 disabled:opacity-50"
          />
          <div className="flex items-center justify-between">
            <div className="text-sm text-slate-500">
              {noteOk
                ? "✓ saved — agent will read this on its next run (and every run for 14d)"
                : `${noteBody.length}/2000`}
            </div>
            <button
              type="submit"
              disabled={noteBusy || !noteBody.trim()}
              className="inline-flex items-center rounded-md bg-slate-900 text-white px-3 py-1.5 text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
            >
              {noteBusy ? "Saving…" : "Save note"}
            </button>
          </div>
        </form>

        <h2 className="mt-8 mb-1 text-xs uppercase tracking-[0.16em] text-slate-500">
          Bake permanent rule · no 14-day decay
        </h2>
        <p className="mb-3 text-sm text-slate-600">
          For a rule that should stick beyond the 14-day steering-note window — append it to
          this agent&apos;s permanent body for THIS tenant. You&apos;ll confirm the exact text first.
        </p>
        {tenantId && slug && <BakeRuleForm tenantId={tenantId} slug={slug} />}

        <h2 className="mt-8 mb-1 text-xs uppercase tracking-[0.16em] text-slate-500">
          Last 20 runs
        </h2>
        <p className="mb-3 text-sm text-slate-600">
          Score is an AI quality judge (1–100) — click a run to open its full thread and
          debug a low score. Rate any run 👍/👎 with a note — staff feedback is the
          highest-weight training signal and lands in this agent&apos;s next-run context.
        </p>
        {runs === null ? (
          <div className="text-sm text-slate-500">Loading…</div>
        ) : runs.length === 0 ? (
          <div className="glass-card border-dashed p-6 text-center text-sm text-slate-500">
            No runs yet.
          </div>
        ) : (
          <div className="glass-card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-white/50 text-slate-600 text-xs uppercase tracking-[0.1em]">
                <tr>
                  <th className="text-left px-4 py-2.5">Run</th>
                  <th className="text-left px-4 py-2.5">Status</th>
                  <th className="text-right px-4 py-2.5">Score</th>
                  <th className="text-right px-4 py-2.5">Tokens</th>
                  <th className="text-right px-4 py-2.5">$</th>
                  <th className="text-right px-4 py-2.5">When</th>
                  <th className="text-right px-4 py-2.5">Rate</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <Fragment key={r.id}>
                    <tr className="border-t border-slate-100">
                      <td className="px-4 py-2.5 font-mono text-sm">
                        <Link
                          href={`/runs/${r.id}`}
                          className="text-blue-700 hover:underline"
                          title="Open full thread"
                        >
                          {r.id.slice(0, 8)}…
                        </Link>
                      </td>
                      <td className="px-4 py-2.5">
                        <span
                          className={`text-sm px-2 py-0.5 rounded ${
                            r.status === "success"
                              ? "bg-emerald-50 text-emerald-800"
                              : r.status === "dispatch_error" || r.status === "parse_failed"
                                ? "bg-rose-50 text-rose-800"
                                : "bg-slate-50 text-slate-700"
                          }`}
                        >
                          {r.status}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <ScoreBadge score={r.quality_score} />
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono">{r.cost_tokens?.toLocaleString() ?? "—"}</td>
                      <td className="px-4 py-2.5 text-right font-mono">${(r.cost_usd ?? 0).toFixed(3)}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-sm text-slate-500">
                        {r.finished_at ? new Date(r.finished_at).toLocaleString() : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <button
                          type="button"
                          onClick={() => setRatingRunId((cur) => (cur === r.id ? null : r.id))}
                          className="text-sm text-slate-600 hover:text-slate-900 hover:underline"
                          aria-expanded={ratingRunId === r.id}
                        >
                          {ratingRunId === r.id ? "close" : "👍 / 👎"}
                        </button>
                      </td>
                    </tr>
                    {ratingRunId === r.id && (
                      <tr className="border-t border-slate-100 bg-slate-50/60">
                        <td colSpan={7} className="px-4 py-3">
                          <FeedbackForm targetType="agent_run" targetId={r.id} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <h2 className="mt-8 mb-3 text-xs uppercase tracking-[0.16em] text-slate-500">
          Recent feedback
        </h2>
        {feedback === null ? (
          <div className="text-sm text-slate-500">Loading…</div>
        ) : feedback.length === 0 ? (
          <div className="glass-card border-dashed p-6 text-center text-sm text-slate-500">
            No operator feedback yet.
          </div>
        ) : (
          <div className="space-y-2">
            {feedback.map((f) => (
              <div key={f.id} className="rounded-md border border-slate-200 bg-white p-3">
                <div className="text-sm font-mono text-slate-500 mb-0.5">
                  {f.target_type} {f.target_id.slice(0, 8)}… ·{" "}
                  {f.rating === 1 ? "👍" : f.rating === -1 ? "👎" : "comment"} ·{" "}
                  {new Date(f.created_at).toLocaleString()}
                </div>
                {f.comment && <div className="text-sm text-slate-800">{f.comment}</div>}
              </div>
            ))}
          </div>
        )}

        <h2 className="mt-8 mb-3 text-xs uppercase tracking-[0.16em] text-slate-500">
          Recent decisions
        </h2>
        {decisions === null ? (
          <div className="text-sm text-slate-500">Loading…</div>
        ) : decisions.length === 0 ? (
          <div className="glass-card border-dashed p-6 text-center text-sm text-slate-500">
            No decisions emitted by this agent.
          </div>
        ) : (
          <div className="space-y-1.5">
            {decisions.map((d) => (
              <div key={d.id} className="rounded-md border border-slate-200 bg-white p-2.5 text-sm">
                <span className="text-slate-700 mr-2">{d.decision_class}</span>
                <span
                  className={`text-xs px-1.5 py-0.5 rounded ${
                    d.status === "approved"
                      ? "bg-emerald-50 text-emerald-700"
                      : d.status === "rejected"
                        ? "bg-rose-50 text-rose-700"
                        : "bg-slate-50 text-slate-600"
                  }`}
                >
                  {d.status}
                </span>
                <span className="float-right font-mono text-sm text-slate-500">
                  {new Date(d.emitted_at).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        )}
    </div>
  );
}

function ScoreBadge({ score }: { score: number | null }) {
  if (score === null || score === undefined) {
    return <span className="font-mono text-sm text-slate-400" title="Not scored yet">—</span>;
  }
  const cls =
    score >= 80
      ? "bg-emerald-50 text-emerald-800"
      : score >= 50
        ? "bg-amber-50 text-amber-800"
        : "bg-rose-50 text-rose-800";
  return (
    <span className={`font-mono text-sm px-2 py-0.5 rounded ${cls}`} title="AI quality score (1–100)">
      {score}
    </span>
  );
}
