"use client";

import { useState } from "react";
import type { GrowthPlanDetail } from "@/lib/workspace/useGrowthPlan";
import { CardDivider, SubLabel } from "./GrowthSection";

const hostOf = (u: string): string => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
};

export function CompanyFactsList({ facts }: { facts: GrowthPlanDetail["company_facts"] }) {
  if (!facts || facts.length === 0) return null;
  return (
    <>
      <CardDivider />
      <SubLabel>What Zavi found</SubLabel>
      <ul className="space-y-1.5 text-sm leading-relaxed text-inkSoft">
        {facts.map((f, i) => (
          <li key={i}>
            {f.fact}{" "}
            <a
              href={f.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-inkMuted underline underline-offset-2 hover:text-ink"
            >
              {hostOf(f.source_url)}
            </a>
          </li>
        ))}
      </ul>
    </>
  );
}

export function PlanSummary({ summary }: { summary: string | undefined }) {
  const text = summary?.trim();
  if (!text) return null;
  return (
    <>
      <CardDivider />
      <SubLabel>Where you are</SubLabel>
      <p className="text-sm leading-relaxed text-inkSoft">{text}</p>
    </>
  );
}

export function AlsoFix({ text }: { text: string | undefined }) {
  const t = text?.trim();
  if (!t) return null;
  return <p className="mt-2 text-sm leading-relaxed text-inkSoft">{`Also fix: ${t}`}</p>;
}

export function TargetAndFirstSteps({ detail }: { detail: GrowthPlanDetail | undefined }) {
  const rationale = detail?.target_rationale?.trim();
  const steps = detail?.first_steps ?? [];
  if (!rationale && steps.length === 0) return null;
  return (
    <>
      {rationale && (
        <>
          <SubLabel>Why this target</SubLabel>
          <p className="text-sm leading-relaxed text-inkSoft">{rationale}</p>
        </>
      )}
      {steps.length > 0 && (
        <>
          <SubLabel>First two weeks</SubLabel>
          <ol className="space-y-1.5 text-sm leading-relaxed text-inkSoft">
            {steps.map((s, i) => (
              <li key={i}>
                {s.when ? <span className="font-medium text-ink">{`${s.when}: `}</span> : null}
                {s.step}
              </li>
            ))}
          </ol>
        </>
      )}
      <CardDivider />
    </>
  );
}

function MoveRow({ move }: { move: NonNullable<GrowthPlanDetail["growth_moves"]>[number] }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="py-3 first:pt-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-base font-medium text-ink">{move.title}</span>
        <span className="rounded-full border border-rule px-2 py-0.5 text-xs text-inkMuted">{move.lever}</span>
      </div>
      <p className={`mt-1.5 text-sm leading-relaxed text-inkSoft ${open ? "" : "line-clamp-4"}`}>{move.action}</p>
      {open && (
        <div className="mt-1.5 space-y-1.5 text-sm leading-relaxed text-inkMuted">
          {move.rationale && <p>{`Why: ${move.rationale}`}</p>}
          {move.expected_effect && <p>{`Expected: ${move.expected_effect}`}</p>}
          {move.falsifier && <p>{`Call it failed if: ${move.falsifier}`}</p>}
        </div>
      )}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="mt-1 text-sm text-inkMuted underline-offset-2 hover:text-ink hover:underline"
      >
        {open ? "Show less" : "Show more"}
      </button>
    </li>
  );
}

export function GrowthMovesList({ moves }: { moves: GrowthPlanDetail["growth_moves"] }) {
  if (!moves || moves.length === 0) return null;
  return (
    <>
      <SubLabel>Growth moves</SubLabel>
      <ul className="divide-y divide-rule">
        {moves.map((m, i) => (
          <MoveRow key={i} move={m} />
        ))}
      </ul>
      <CardDivider />
    </>
  );
}
