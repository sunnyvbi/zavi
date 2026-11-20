"use client";

import { useState } from "react";
import Link from "next/link";
import { Textarea } from "@/components/Input";
import { HOME_AGENT_SLUG } from "@/lib/workspace/tabUrl";
import { NextChevron } from "@/components/ui/NextChevron";

type Confidence = "evidence_grounded" | "inference" | "low_confidence_speculation";
type RecommendationItem = {
  title: string;
  rationale: string;
  evidence_refs?: string[];
  estimated_impact?: string;
  confidence?: Confidence;
  disconfirming_signal?: string;
};
type WatchTrigger = { trigger: string; what_to_do: string };
type ResearchFinding = {
  topic: string;
  summary: string;
  evidence?: { source: string; ref: string }[];
};
type DispatchProposal = { agent_slug: string; brief: string; why: string };

export type AdviceEnvelope = {
  diagnosis: {
    stage: "pre-launch" | "growth" | "scale";
    goal_restated: string;
    key_signals?: string[];
  };
  research_findings?: ResearchFinding[];
  recommendations?: {
    decide_today?: RecommendationItem[];
    next_30d?: RecommendationItem[];
    watch_for?: WatchTrigger[];
    lead_priority?: string;
    deprioritize?: string[];
  };
  dispatch_proposals?: DispatchProposal[];
  dissent?: { what_not_to_do: string; why: string };
  clarifications_needed: false | { questions: string[] };
  rendered_markdown: string;
};

export function AdviceEnvelopeRenderer({
  parsed,
  runId,
  goal,
  onClarificationSubmit,
}: {
  parsed: AdviceEnvelope | null;
  runId: string;
  goal: string;
  onClarificationSubmit: (args: { prior_run_id: string; goal: string; answers: string[] }) => void;
}) {
  if (!parsed) {
    return (
      <p className="text-[13px] text-amber-800">
        Advice envelope didn&apos;t parse. Raw output is shown above. Try Run again.
      </p>
    );
  }

  if (parsed.clarifications_needed && Array.isArray(parsed.clarifications_needed.questions)) {
    return (
      <ClarificationForm
        questions={parsed.clarifications_needed.questions}
        runId={runId}
        goal={goal}
        onSubmit={onClarificationSubmit}
      />
    );
  }

  return <AdviceResult parsed={parsed} />;
}

function ClarificationForm({
  questions,
  runId,
  goal,
  onSubmit,
}: {
  questions: string[];
  runId: string;
  goal: string;
  onSubmit: (args: { prior_run_id: string; goal: string; answers: string[] }) => void;
}) {
  const [answers, setAnswers] = useState<string[]>(() => questions.map(() => ""));
  const filled = answers.every((a) => a.trim().length > 0);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
        <div className="text-[11px] font-mono uppercase tracking-[0.16em] text-slate-500 mb-1">
          Advisor needs a few specifics
        </div>
        <p className="text-[13px] text-slate-700">
          Answer the questions below and click Continue. The advisor will come
          back with a plan grounded in your answers.
        </p>
      </div>
      {questions.map((q, idx) => (
        <div key={idx}>
          <label
            className="block text-[14px] font-medium text-slate-700 mb-1.5"
            htmlFor={`advisor-q-${idx}`}
          >
            {idx + 1}. {q}
          </label>
          <Textarea
            id={`advisor-q-${idx}`}
            value={answers[idx]}
            onChange={(e) => {
              const next = [...answers];
              next[idx] = e.target.value;
              setAnswers(next);
            }}
            rows={2}
            maxLength={1000}
            className="resize-y"
          />
        </div>
      ))}
      <button
        type="button"
        onClick={() =>
          onSubmit({
            prior_run_id: runId,
            goal,
            answers: answers.map((a) => a.trim()),
          })
        }
        disabled={!filled}
        className="inline-flex items-center gap-2 rounded-cta bg-skyMuted text-white px-4 py-2 text-[13px] font-medium hover:bg-brickDark transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Continue <NextChevron />
      </button>
    </div>
  );
}

function StageBadge({ stage }: { stage: AdviceEnvelope["diagnosis"]["stage"] }) {
  const styles: Record<typeof stage, string> = {
    "pre-launch": "border-amber-200 bg-amber-50 text-amber-800",
    growth: "border-emerald-200 bg-emerald-50 text-emerald-800",
    scale: "border-sky-200 bg-sky-50 text-sky-800",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-mono uppercase tracking-[0.12em] ${styles[stage]}`}
    >
      {stage}
    </span>
  );
}

function RecCard({ rec }: { rec: RecommendationItem }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3.5">
      <div className="text-[13px] font-semibold text-slate-900 mb-1">
        {rec.title}
      </div>
      <p className="text-[13px] text-slate-700 leading-[1.6]">{rec.rationale}</p>
      {rec.confidence && (
        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-mono uppercase tracking-[0.1em] mt-1.5 ${
          rec.confidence === "evidence_grounded" ? "border-emerald-200 bg-emerald-50 text-emerald-700"
          : rec.confidence === "inference" ? "border-sky-200 bg-sky-50 text-sky-700"
          : "border-amber-200 bg-amber-50 text-amber-700"}`}>
          {rec.confidence.replace(/_/g, " ")}
        </span>
      )}
      {rec.disconfirming_signal && (
        <div className="mt-2 text-[12px] text-slate-500">
          Would change my mind: <span className="text-slate-700">{rec.disconfirming_signal}</span>
        </div>
      )}
      {rec.estimated_impact && (
        <div className="mt-2 text-[12px] text-slate-500">
          Impact: <span className="text-slate-700">{rec.estimated_impact}</span>
        </div>
      )}
    </div>
  );
}

function AdviceResult({ parsed }: { parsed: AdviceEnvelope }) {
  const r = parsed.recommendations ?? {};
  const decide = r.decide_today ?? [];
  const next30 = r.next_30d ?? [];
  const watch = r.watch_for ?? [];
  const deprioritize = r.deprioritize ?? [];
  const proposals = parsed.dispatch_proposals ?? [];

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-mono uppercase tracking-[0.16em] text-slate-500 mb-1">
            Diagnosis
          </div>
          <p className="text-[13px] text-slate-800 leading-[1.6]">
            {parsed.diagnosis.goal_restated}
          </p>
        </div>
        <StageBadge stage={parsed.diagnosis.stage} />
      </div>

      {r.lead_priority && (
        <div className="rounded-lg border-2 border-skyMuted/40 bg-sky-50/50 p-3.5">
          <div className="text-[11px] font-mono uppercase tracking-[0.16em] text-skyMuted mb-1">Lead priority</div>
          <p className="text-[13px] font-semibold text-slate-900">{r.lead_priority}</p>
        </div>
      )}

      {decide.length > 0 && (
        <section>
          <div className="text-[11px] font-mono uppercase tracking-[0.16em] text-slate-500 mb-2">
            Decide today
          </div>
          <div className="space-y-2">
            {decide.map((rec, i) => (
              <RecCard key={i} rec={rec} />
            ))}
          </div>
        </section>
      )}

      {next30.length > 0 && (
        <section>
          <div className="text-[11px] font-mono uppercase tracking-[0.16em] text-slate-500 mb-2">
            Next 30 days
          </div>
          <div className="space-y-2">
            {next30.map((rec, i) => (
              <RecCard key={i} rec={rec} />
            ))}
          </div>
        </section>
      )}

      {watch.length > 0 && (
        <section>
          <div className="text-[11px] font-mono uppercase tracking-[0.16em] text-slate-500 mb-2">
            Watch for
          </div>
          <ul className="space-y-1.5">
            {watch.map((w, i) => (
              <li key={i} className="text-[13px] text-slate-700 leading-[1.55]">
                <span className="font-medium">If</span> {w.trigger}{" "}
                <span className="font-medium">→</span> {w.what_to_do}
              </li>
            ))}
          </ul>
        </section>
      )}

      {deprioritize.length > 0 && (
        <section>
          <div className="text-[11px] font-mono uppercase tracking-[0.16em] text-slate-500 mb-2">
            Deprioritize / stop doing
          </div>
          <ul className="space-y-1.5">
            {deprioritize.map((d, i) => (
              <li key={i} className="text-[13px] text-slate-700 leading-[1.55]">
                <span className="font-medium">✕</span> {d}
              </li>
            ))}
          </ul>
        </section>
      )}

      {proposals.length > 0 && (
        <section>
          <div className="text-[11px] font-mono uppercase tracking-[0.16em] text-slate-500 mb-2">
            Hand off to another agent
          </div>
          <div className="space-y-2.5">
            {proposals.map((p, i) => (
              <DispatchCard key={i} proposal={p} />
            ))}
          </div>
        </section>
      )}

      {parsed.dissent && (
        <div className="rounded-lg border-2 border-amber-300 bg-amber-50/60 p-3.5">
          <div className="text-[11px] font-mono uppercase tracking-[0.16em] text-amber-700 mb-1">
            What NOT to do
          </div>
          <p className="text-[13px] font-semibold text-amber-900">{parsed.dissent.what_not_to_do}</p>
          <p className="mt-1 text-[12px] text-amber-800 leading-[1.55]">{parsed.dissent.why}</p>
        </div>
      )}

      <div className="border-t border-slate-100 pt-3 text-[11px] text-slate-400">
        Web research uses Tavily (third-party). Avoid sharing confidential
        details in your goal.
      </div>
    </div>
  );
}

function DispatchCard({ proposal }: { proposal: DispatchProposal }) {
  const FORBIDDEN = new Set(["engineer"]);
  if (FORBIDDEN.has(proposal.agent_slug)) return null;

  const params = new URLSearchParams();
  if (proposal.agent_slug !== HOME_AGENT_SLUG) {
    params.set("agent", proposal.agent_slug);
  }
  params.set("prefill", proposal.brief);
  const href = `/workspace?${params}`;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3 mb-2">
        <code className="font-mono text-[12px] text-slate-700 bg-slate-100 px-1.5 py-0.5 rounded">
          {proposal.agent_slug}
        </code>
        <Link
          href={href}
          className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white text-slate-800 px-2.5 py-1 text-[12px] font-medium hover:bg-slate-50 transition-colors whitespace-nowrap"
        >
          Open in {proposal.agent_slug} <NextChevron />
        </Link>
      </div>
      <p className="text-[13px] text-slate-700 leading-[1.6] mb-1.5">
        <span className="font-medium text-slate-900">Brief:</span> {proposal.brief}
      </p>
      <p className="text-[12px] text-slate-500 leading-[1.55]">
        <span className="font-medium">Why:</span> {proposal.why}
      </p>
    </div>
  );
}
