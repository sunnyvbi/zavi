"use client";

import { Fragment, useEffect, useState } from "react";
import Link from "next/link";
import { adminApiFetch } from "@/lib/api-admin";
import { PageHeader } from "@/components/admin/PageHeader";

type Run = {
  id: string;
  tenant_id: string;
  agent_slug: string;
  status: string;
  parse_ok: boolean | null;
  cost_tokens: number | null;
  cost_usd: number | null;
  started_at: string | null;
  finished_at: string | null;
  enqueued_at: string | null;
  quality_score: number | null;
  review_count: number;
  trigger: string | null;
  request_preview: string | null;
  output_preview: string | null;
};

const AGENT_PALETTE = [
  { dot: "bg-rose-500", text: "text-rose-700" },
  { dot: "bg-orange-500", text: "text-orange-700" },
  { dot: "bg-amber-500", text: "text-amber-700" },
  { dot: "bg-lime-600", text: "text-lime-700" },
  { dot: "bg-emerald-500", text: "text-emerald-700" },
  { dot: "bg-teal-500", text: "text-teal-700" },
  { dot: "bg-cyan-600", text: "text-cyan-700" },
  { dot: "bg-sky-500", text: "text-sky-700" },
  { dot: "bg-indigo-500", text: "text-indigo-700" },
  { dot: "bg-violet-500", text: "text-violet-700" },
  { dot: "bg-fuchsia-500", text: "text-fuchsia-700" },
  { dot: "bg-pink-500", text: "text-pink-700" },
] as const;

function agentColor(slug: string): { dot: string; text: string } {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  return AGENT_PALETTE[h % AGENT_PALETTE.length];
}

type Calib = {
  quality_model: string;
  agent_slug: string;
  correct: number;
  wrong: number;
  total: number;
  accuracy_pct: number | null;
};

export default function AdminRunsPage() {
  return <Body />;
}

function Body() {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [slug, setSlug] = useState("");
  const [maxScore, setMaxScore] = useState("");
  const [unreviewedOnly, setUnreviewedOnly] = useState(false);
  const [calib, setCalib] = useState<Calib[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const qs = new URLSearchParams();
        if (status) qs.set("status", status);
        if (slug) qs.set("slug", slug);
        if (maxScore) qs.set("max_score", maxScore);
        if (unreviewedOnly) qs.set("unreviewed", "1");
        qs.set("limit", "100");
        const res = await adminApiFetch(`/api/admin/runs?${qs.toString()}`);
        const r = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
        if (cancelled) return;
        setRuns((r.runs ?? []) as Run[]);
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status, slug, maxScore, unreviewedOnly]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await adminApiFetch(`/api/admin/judge-calibration?min_labels=1`);
        const r = await res.json().catch(() => ({}));
        if (res.ok && !cancelled) setCalib((r.calibration ?? []) as Calib[]);
      } catch {
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="max-w-6xl mx-auto p-6">
      <PageHeader
        title="Runs"
        actions={
          <>
            <input
              placeholder="status (e.g. failed)"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="rounded-md border border-slate-300 bg-white/70 px-3 py-1.5 text-sm w-44 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-100"
            />
            <input
              placeholder="agent slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              className="rounded-md border border-slate-300 bg-white/70 px-3 py-1.5 text-sm w-44 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-100"
            />
            <input
              placeholder="score ≤"
              value={maxScore}
              onChange={(e) => setMaxScore(e.target.value.replace(/[^0-9]/g, ""))}
              className="rounded-md border border-slate-300 bg-white/70 px-3 py-1.5 text-sm w-24 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-100"
            />
            <label className="flex items-center gap-1.5 text-sm text-slate-600 select-none">
              <input
                type="checkbox"
                checked={unreviewedOnly}
                onChange={(e) => setUnreviewedOnly(e.target.checked)}
              />
              unreviewed
            </label>
          </>
        }
      />

      {calib && calib.length > 0 && (
        <div className="glass-card p-3 mb-4">
          <div className="text-xs uppercase tracking-[0.14em] text-slate-500 mb-2">
            Judge calibration · score ✓/✗ verdicts → golden set
          </div>
          <div className="flex flex-wrap gap-2">
            {calib.slice(0, 12).map((c) => (
              <span
                key={`${c.quality_model}:${c.agent_slug}`}
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-sm"
                title={`${c.quality_model} · ${c.correct} correct / ${c.wrong} wrong`}
              >
                <span className="text-slate-700">{c.agent_slug}</span>
                <span
                  className={`font-mono font-semibold ${
                    c.accuracy_pct == null
                      ? "text-slate-400"
                      : c.accuracy_pct >= 85
                        ? "text-emerald-700"
                        : c.accuracy_pct >= 60
                          ? "text-amber-700"
                          : "text-rose-700"
                  }`}
                >
                  {c.accuracy_pct == null ? "—" : `${c.accuracy_pct}%`}
                </span>
                <span className="text-slate-400 font-mono">n={c.total}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">
          {error}
        </div>
      )}

      {runs === null ? (
        <div className="text-sm text-slate-500">Loading runs…</div>
      ) : runs.length === 0 ? (
        <div className="glass-card border-dashed p-8 text-sm text-slate-600 text-center">
          No runs match.
        </div>
      ) : (
        <div className="glass-card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-white/50 text-slate-600 text-xs uppercase tracking-[0.1em]">
              <tr>
                <th className="text-left px-3 py-2.5">Started</th>
                <th className="text-left px-3 py-2.5">Tenant</th>
                <th className="text-left px-3 py-2.5">Agent</th>
                <th className="text-left px-3 py-2.5">Status</th>
                <th className="text-right px-3 py-2.5">Score</th>
                <th className="text-center px-3 py-2.5">Review</th>
                <th className="text-right px-3 py-2.5">Tokens</th>
                <th className="text-right px-3 py-2.5">USD</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const ac = agentColor(r.agent_slug);
                const hasSummary = !!(r.request_preview || r.output_preview);
                return (
                  <Fragment key={r.id}>
                    <tr className={`border-t border-slate-100 hover:bg-slate-50 ${hasSummary ? "[&>td]:pb-1" : ""}`}>
                      <td className="px-3 py-2 font-mono text-slate-500 text-sm whitespace-nowrap align-top">
                        {r.started_at
                          ? new Date(r.started_at).toLocaleString()
                          : r.enqueued_at
                            ? new Date(r.enqueued_at).toLocaleString() + " (queued)"
                            : "—"}
                      </td>
                      <td className="px-3 py-2 font-mono text-slate-600 text-sm align-top">
                        {r.tenant_id.slice(0, 8)}
                      </td>
                      <td className="px-3 py-2 align-top">
                        <Link
                          href={`/runs/${r.id}`}
                          className={`inline-flex items-center gap-1.5 font-medium hover:underline ${ac.text}`}
                        >
                          <span className={`h-2 w-2 rounded-full ${ac.dot} flex-shrink-0`} />
                          {r.agent_slug}
                        </Link>
                      </td>
                      <td className="px-3 py-2 align-top">
                        <StatusPill status={r.status} parseOk={r.parse_ok} />
                      </td>
                      <td className="px-3 py-2 text-right align-top">
                        <ScoreCell score={r.quality_score} />
                      </td>
                      <td className="px-3 py-2 text-center align-top">
                        {r.review_count > 0 ? (
                          <span
                            className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-mono text-emerald-800"
                            title={`${r.review_count} staff verdict(s)`}
                          >
                            ✓{r.review_count > 1 ? ` ${r.review_count}` : ""}
                          </span>
                        ) : (
                          <span className="text-slate-300 font-mono text-sm">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-slate-600 align-top">
                        {r.cost_tokens ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-slate-600 align-top">
                        {r.cost_usd != null ? `$${r.cost_usd.toFixed(3)}` : "—"}
                      </td>
                    </tr>
                    {hasSummary && (
                      <tr className="hover:bg-slate-50">
                        <td />
                        <td colSpan={7} className="px-3 pb-2.5 pt-0">
                          <Link href={`/runs/${r.id}`} className="block group">
                            {r.trigger && (
                              <span className="inline-block mr-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs uppercase tracking-wide text-slate-500 align-middle">
                                {r.trigger}
                              </span>
                            )}
                            {r.request_preview && (
                              <span className="text-sm text-slate-700">
                                <span className="text-slate-400">asked:</span> “{r.request_preview}”
                              </span>
                            )}
                            {r.output_preview && (
                              <span className="block text-sm text-slate-500 mt-0.5 group-hover:text-slate-700">
                                <span className="text-slate-400">did:</span> {r.output_preview}
                              </span>
                            )}
                          </Link>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatusPill({ status, parseOk }: { status: string; parseOk: boolean | null }) {
  const ok = status === "completed" && parseOk !== false;
  const fail =
    status === "failed" || status === "parse_failed" || status === "dispatch_error";
  const cls = ok
    ? "bg-emerald-50 text-emerald-800 border-emerald-200"
    : fail
      ? "bg-rose-50 text-rose-800 border-rose-200"
      : "bg-slate-50 text-slate-700 border-slate-200";
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs ${cls}`}>
      {status}
    </span>
  );
}

function ScoreCell({ score }: { score: number | null }) {
  if (score == null) return <span className="text-slate-300 font-mono text-sm">—</span>;
  const cls =
    score >= 80 ? "text-emerald-700" : score >= 50 ? "text-amber-700" : "text-rose-700";
  return <span className={`font-mono font-semibold tabular-nums ${cls}`}>{score}</span>;
}
