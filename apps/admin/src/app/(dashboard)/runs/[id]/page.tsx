"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { FeedbackForm } from "@/components/admin/FeedbackForm";
import { RunReview } from "@/components/admin/RunReview";
import { adminApiFetch } from "@/lib/api-admin";

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
  output_text: string | null;
  error: string | null;
  quality_score: number | null;
  quality_rationale: string | null;
  quality_model: string | null;
  quality_scored_at: string | null;
};

type RunEvent = {
  id: number;
  stage: string;
  meta: Record<string, unknown> | null;
  created_at: string;
};

type DecisionRow = {
  id: string;
  decision_class: string;
  status: string;
  autonomy_at_emit: string | null;
  emitted_at: string;
  approved_at: string | null;
};

export default function AdminRunDetailPage() {
  return <Body />;
}

function Body() {
  const params = useParams<{ id: string }>();
  const runId = params?.id ?? "";
  const [run, setRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [decisions, setDecisions] = useState<DecisionRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await adminApiFetch(`/api/admin/runs/${runId}`);
        const r = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
        if (cancelled) return;
        setRun(r.run as Run);
        setEvents((r.events ?? []) as RunEvent[]);
        setDecisions((r.decisions ?? []) as DecisionRow[]);
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId]);

  if (error) {
    return (
      <div className="max-w-5xl mx-auto p-6">
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          {error}
        </div>
      </div>
    );
  }
  if (!run) {
    return <div className="max-w-5xl mx-auto p-6 text-sm text-slate-500">Loading…</div>;
  }

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <div>
        <div className="text-xs uppercase tracking-[0.2em] text-sky-700">
          Zavi · admin · run
        </div>
        <h1 className="font-display font-semibold text-xl text-slate-900 mt-1">
          {run.agent_slug}{" "}
          <span className="font-mono text-base text-slate-500 ml-2">
            {run.id.slice(0, 8)}
          </span>
        </h1>
        <div className="flex flex-wrap gap-x-5 gap-y-1 mt-2 text-sm text-slate-600">
          <span>
            Tenant{" "}
            <Link
              href={`/tenants/${run.tenant_id}`}
              className="font-mono hover:underline"
            >
              {run.tenant_id.slice(0, 8)}
            </Link>
          </span>
          <span>Status <span>{run.status}</span></span>
          {run.cost_tokens != null && (
            <span>Tokens <span className="font-mono">{run.cost_tokens}</span></span>
          )}
          {run.cost_usd != null && (
            <span>Spend <span className="font-mono">${run.cost_usd.toFixed(3)}</span></span>
          )}
          {run.started_at && (
            <span className="font-mono text-sm">
              {new Date(run.started_at).toLocaleString()}
            </span>
          )}
        </div>
      </div>

      <RunReview runId={run.id} />

      <Section title="Coach the agent">
        <div className="text-sm text-slate-500 mb-2">
          Thumbs + note here change the agent&apos;s next-run behavior (memory).
          To grade the SCORE or flag a bug, use &ldquo;Review this run&rdquo; above.
        </div>
        <FeedbackForm targetType="agent_run" targetId={run.id} />
      </Section>

      <Section title="AI quality score">
        {run.quality_score != null ? (
          <div className="glass-card p-4">
            <div className="flex items-baseline gap-3">
              <span
                className={`font-display font-semibold text-3xl tabular-nums ${
                  run.quality_score >= 80
                    ? "text-emerald-700"
                    : run.quality_score >= 50
                      ? "text-amber-700"
                      : "text-rose-700"
                }`}
              >
                {run.quality_score}
              </span>
              <span className="text-sm text-slate-500">/ 100</span>
              <span className="text-sm font-mono text-slate-400 ml-auto">
                {run.quality_model ?? "ai"}
                {run.quality_scored_at
                  ? ` · ${new Date(run.quality_scored_at).toLocaleString()}`
                  : ""}
              </span>
            </div>
            {run.quality_rationale && (
              <p className="mt-2 text-sm text-slate-700">{run.quality_rationale}</p>
            )}
          </div>
        ) : (
          <div className="text-sm text-slate-500 italic">
            Not scored yet — the score-runs judge fills this in within ~30 min of the run finishing.
          </div>
        )}
      </Section>

      <Section title="Output">
        {run.output_text ? (
          <pre className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm font-mono whitespace-pre-wrap break-words text-slate-800 max-h-[420px] overflow-auto">
            {run.output_text}
          </pre>
        ) : (
          <div className="text-sm text-slate-500 italic">No output captured.</div>
        )}
      </Section>

      {run.error && (
        <Section title="Error">
          <pre className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-mono whitespace-pre-wrap break-words text-rose-900">
            {run.error}
          </pre>
        </Section>
      )}

      <Section title={`Events (${events.length})`}>
        {events.length === 0 ? (
          <div className="text-sm text-slate-500 italic">No events.</div>
        ) : (
          <ol className="glass-card divide-y divide-slate-100">
            {events.map((ev) => (
              <li key={ev.id} className="px-3 py-2 flex items-center gap-3 text-sm">
                <span className="font-mono text-slate-500 w-44 shrink-0">
                  {new Date(ev.created_at).toLocaleTimeString()}
                </span>
                <span className="text-slate-900 w-44 shrink-0">{ev.stage}</span>
                <span className="font-mono text-slate-600 truncate">
                  {ev.meta && Object.keys(ev.meta).length > 0
                    ? JSON.stringify(ev.meta)
                    : ""}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Section>

      <Section title={`Decisions (${decisions.length})`}>
        {decisions.length === 0 ? (
          <div className="text-sm text-slate-500 italic">No decisions emitted.</div>
        ) : (
          <ul className="space-y-2">
            {decisions.map((d) => (
              <li
                key={d.id}
                className="glass-card p-3 flex items-center gap-3"
              >
                <Link
                  href={`/decisions/${d.id}`}
                  className="text-sm text-slate-900 hover:underline"
                >
                  {d.decision_class}
                </Link>
                <span className="text-sm text-slate-500">{d.status}</span>
                <span className="text-sm text-slate-500">
                  autonomy:{d.autonomy_at_emit ?? "?"}
                </span>
                <span className="ml-auto text-sm font-mono text-slate-500">
                  {new Date(d.emitted_at).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="text-sm uppercase tracking-[0.14em] text-slate-500 mb-2">
        {title}
      </div>
      {children}
    </section>
  );
}
