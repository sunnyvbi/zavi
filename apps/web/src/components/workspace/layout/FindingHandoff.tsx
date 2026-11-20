"use client";

import type { RecipeFindingView } from "@/lib/workspace/recipeStep";
import {
  findingHandoff,
  handoffFindings,
  HANDOFF_CARD_LIMIT,
} from "@/lib/workspace/findingHandoff";

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 text-[13px] leading-5">
      <dt className="w-[104px] shrink-0 text-inkMuted">{label}</dt>
      <dd className="min-w-0 flex-1 text-ink [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

function Card({ finding }: { finding: RecipeFindingView }) {
  const h = findingHandoff(finding.access);
  return (
    <li className="rounded-2xl border border-rule bg-white p-3.5">
      <p className="text-[16px] font-semibold leading-5 text-ink [overflow-wrap:anywhere]">
        {finding.value}
      </p>
      {finding.blocks.length > 0 && (
        <ul className="mt-1 flex flex-col gap-0.5">
          {finding.blocks.map((b, i) => (
            <li
              key={`${finding.metricId}-b${i}`}
              className="text-[13px] leading-5 text-inkMuted [overflow-wrap:anywhere]"
            >
              {b}
            </li>
          ))}
        </ul>
      )}
      <dl className="mt-2.5 flex flex-col gap-1 border-t border-rule pt-2.5">
        <Line label="Who acts">
          <span className="font-medium">{h.who}</span>
          {". "}
          {h.detail}
        </Line>
        {finding.doNothing && <Line label={"If you don't"}>{finding.doNothing}</Line>}
        {finding.risk && <Line label="Risk">{finding.risk}</Line>}
        {finding.undo && <Line label="To undo">{finding.undo}</Line>}
      </dl>
    </li>
  );
}

export function FindingHandoff({ findings }: { findings: RecipeFindingView[] }) {
  const rows = handoffFindings(findings);
  if (rows.length === 0) return null;

  const shown = rows.slice(0, HANDOFF_CARD_LIMIT);
  const rest = rows.slice(HANDOFF_CARD_LIMIT);

  return (
    <section className="mt-3.5">
      <h3 className="text-[13px] font-semibold text-ink">What is in the way</h3>
      <p className="mt-0.5 text-[13px] leading-5 text-inkMuted">
        Where a change lives differs per item. A setting at your CDN cannot be
        changed from your repo, and Zavi says so rather than sending you to the
        wrong place.
      </p>

      <ul className="mt-2.5 flex flex-col gap-2">
        {shown.map((f) => (
          <Card key={f.metricId} finding={f} />
        ))}
      </ul>

      {rest.length > 0 && (
        <div className="mt-2 rounded-2xl border border-rule bg-white px-3.5 py-2.5">
          <p className="text-[12px] font-medium text-ink">
            {rest.length} more {rest.length === 1 ? "finding" : "findings"}
          </p>
          <ul className="mt-1 flex flex-col gap-0.5">
            {rest.map((f) => (
              <li
                key={f.metricId}
                className="text-[13px] leading-5 text-inkMuted [overflow-wrap:anywhere]"
              >
                {f.value}
                {" · "}
                {findingHandoff(f.access).who}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
