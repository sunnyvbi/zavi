"use client";

import * as React from "react";
import { Markdown } from "@/components/workspace/Markdown";

type Severity = "low" | "medium" | "high";

type PmBacklogItem = {
  item_id?: string;
  theme?: string;
  problem?: string;
  proposed_fix?: string;
  rice_score?: number;
  impact?: Severity | string;
  effort?: Severity | string;
};

type PmDispatchedAction = {
  item_id?: string;
  task_description?: string;
};

type PmRecommendedAction = {
  item_id?: string;
  description?: string;
  target_team?: string;
  urgency?: string;
};

type PmReframeOption = {
  title?: string;
  rationale?: string;
  metrics?: string[];
  rank?: number;
};

type PmResearchFinding = {
  summary?: string;
  source?: string;
};

type PmStrategy = {
  premise_check?: string;
  reframe_options?: PmReframeOption[];
  research_findings?: PmResearchFinding[];
};

export type PmEnvelope = {
  status?: string;
  rendered_markdown?: string;
  backlog?: PmBacklogItem[];
  dispatched_actions?: PmDispatchedAction[];
  recommended_actions_not_dispatched?: PmRecommendedAction[];
  strategy?: PmStrategy;
};

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function PmEnvelopeRenderer({ envelope }: { envelope: PmEnvelope }) {
  const status = envelope?.status;

  if (status === "actionable") {
    const backlog = Array.isArray(envelope.backlog) ? envelope.backlog : [];
    const dispatched = Array.isArray(envelope.dispatched_actions)
      ? envelope.dispatched_actions
      : [];
    const recommended = Array.isArray(envelope.recommended_actions_not_dispatched)
      ? envelope.recommended_actions_not_dispatched
      : [];
    if (backlog.length === 0) return null;

    return (
      <article className="space-y-5">
        <section className="overflow-x-auto">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
            RICE-ranked backlog
          </h2>
          <table className="min-w-full border-collapse text-base">
            <thead>
              <tr>
                {["#", "Theme", "RICE", "Impact", "Effort", "Proposed fix"].map((h) => (
                  <th
                    key={h}
                    className="border border-gray-200 bg-gray-50 px-3 py-2 text-left font-medium text-gray-700"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {backlog.map((item, i) => {
                const rice = num(item.rice_score);
                return (
                  <tr key={item.item_id ?? i} className={i % 2 ? "bg-gray-50" : ""}>
                    <td className="border border-gray-200 px-3 py-2 text-gray-500 tabular-nums">
                      {i + 1}
                    </td>
                    <td className="border border-gray-200 px-3 py-2 font-medium text-gray-900">
                      {String(item.theme ?? "")}
                    </td>
                    <td className="border border-gray-200 px-3 py-2 tabular-nums text-gray-900">
                      {rice != null ? rice.toFixed(1) : "-"}
                    </td>
                    <td className="border border-gray-200 px-3 py-2 text-gray-700">
                      {String(item.impact ?? "-")}
                    </td>
                    <td className="border border-gray-200 px-3 py-2 text-gray-700">
                      {String(item.effort ?? "-")}
                    </td>
                    <td className="border border-gray-200 px-3 py-2 text-gray-700">
                      {String(item.proposed_fix ?? "")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        {dispatched.length > 0 && (
          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
              Dispatched to engineer
            </h2>
            <ul className="space-y-1.5 text-base text-gray-700">
              {dispatched.map((d, i) => (
                <li key={d.item_id ?? i} className="border-l-2 border-green-300 pl-3">
                  {String(d.task_description ?? d.item_id ?? "")}
                </li>
              ))}
            </ul>
          </section>
        )}

        {recommended.length > 0 && (
          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
              Recommended (not dispatched)
            </h2>
            <ul className="space-y-1.5 text-base text-gray-700">
              {recommended.map((r, i) => (
                <li key={r.item_id ?? i} className="border-l-2 border-amber-300 pl-3">
                  <span>{String(r.description ?? "")}</span>
                  {(r.target_team || r.urgency) && (
                    <span className="ml-2 text-xs uppercase tracking-wide text-gray-400">
                      {String(r.target_team ?? "")}
                      {r.target_team && r.urgency ? " · " : ""}
                      {String(r.urgency ?? "")}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </article>
    );
  }

  if (status === "strategy_memo") {
    const strategy = envelope.strategy ?? {};
    const options = Array.isArray(strategy.reframe_options)
      ? [...strategy.reframe_options].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
      : [];
    const findings = Array.isArray(strategy.research_findings)
      ? strategy.research_findings
      : [];
    const premise = (strategy.premise_check ?? "").trim();

    return (
      <article className="space-y-5">
        {premise.length > 0 && (
          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
              Premise check
            </h2>
            <div className="text-base text-gray-700">
              <Markdown source={premise} />
            </div>
          </section>
        )}

        {options.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              Options (ranked)
            </h2>
            {options.map((opt, i) => (
              <div key={i} className="rounded-lg border border-gray-200 p-4">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-xs text-gray-400">
                    {String(opt.rank ?? i + 1)}
                  </span>
                  <span className="text-base font-semibold text-gray-900">
                    {String(opt.title ?? "")}
                  </span>
                </div>
                <div className="mt-1 text-base text-gray-700">
                  <Markdown source={String(opt.rationale ?? "")} />
                </div>
                {Array.isArray(opt.metrics) && opt.metrics.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {opt.metrics.map((m, mi) => (
                      <span
                        key={mi}
                        className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600"
                      >
                        {String(m)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </section>
        )}

        {findings.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              Research findings
            </h2>
            {findings.map((f, i) => (
              <div key={i} className="border-l-2 border-blue-300 pl-3">
                <div className="text-base text-gray-700">
                  <Markdown source={String(f.summary ?? "")} />
                </div>
                {f.source && (
                  <div className="mt-1 text-xs text-gray-400">{String(f.source)}</div>
                )}
              </div>
            ))}
          </section>
        )}
      </article>
    );
  }

  return null;
}

export default PmEnvelopeRenderer;
