"use client";

import { useState } from "react";
import { MessageCircle, Pencil } from "lucide-react";
import type { GrowthPlanRow } from "@/lib/workspace/useGrowthPlan";
import { AlsoFix } from "./GrowthPlanDetail";
import { MemoBlock, SectionAction } from "./GrowthSection";

export const CONFIDENCE_LABEL = { low: "Best guess", medium: "Fairly sure", high: "Data backed" } as const;

export function GrowthConstraint({
  plan,
  unavailable = false,
  alsoFix,
  onAsk,
}: {
  plan: GrowthPlanRow | null;
  unavailable?: boolean;
  alsoFix?: string;
  onAsk?: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const statement = plan?.constraint_statement?.trim();
  const evidence = (plan?.basis_evidence ?? []).filter((e) => e.kind !== "gap" && e.statement.trim());
  const gaps = (plan?.basis_evidence ?? []).filter((e) => e.kind === "gap" && e.statement.trim());
  const hasWhy = evidence.length > 0 || gaps.length > 0 || Boolean(alsoFix?.trim());
  const confidence = plan?.constraint_confidence ?? null;

  return (
    <MemoBlock
      n={2}
      title="What's in the way"
      aside={
        statement && onAsk ? (
          <SectionAction
            onClick={() => onAsk(`I'm not sure "${statement}" is what's in the way. Let's talk.`)}
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
            Change this
          </SectionAction>
        ) : undefined
      }
    >
      {unavailable ? (
        <p className="text-sm text-inkMuted">Couldn&apos;t load this. Try again in a moment.</p>
      ) : statement ? (
        <>
          {}
          <p
            title={statement}
            className={
              "break-words text-[22px] font-semibold leading-7 tracking-[-0.015em] text-ink" +
              (open ? "" : " line-clamp-2")
            }
          >
            {statement}
          </p>
          <div className="-ml-2 mt-3 flex flex-wrap items-center gap-1">
            {confidence && (
              <span className="ml-2 mr-1 rounded-full bg-creamDeep px-2 py-0.5 text-[12px] font-medium text-inkMuted">
                {CONFIDENCE_LABEL[confidence]}
              </span>
            )}
            {}
            <SectionAction onClick={() => setOpen((v) => !v)} expanded={open}>
              {open ? "Hide why" : "Why?"}
            </SectionAction>
            {onAsk && (
              <SectionAction
                label="Ask Zavi about what's in the way"
                onClick={() =>
                  onAsk(`You think "${statement}". How sure are you, and what would change your mind?`)
                }
              >
                <MessageCircle className="h-3.5 w-3.5" aria-hidden="true" />
                Ask Zavi
              </SectionAction>
            )}
          </div>
          {open && hasWhy && (
            <div className="mt-3 rounded-xl bg-creamDeep p-4">
              {(evidence.length > 0 || gaps.length > 0) && (
                <ul className="space-y-1.5 text-sm leading-relaxed text-inkSoft">
                  {evidence.map((e, i) => (
                    <li key={`e${i}`}>
                      {e.statement}
                      {e.source && <span className="text-inkMuted"> ({e.source})</span>}
                    </li>
                  ))}
                  {gaps.map((e, i) => (
                    <li key={`g${i}`}>{`Still unknown: ${e.statement}`}</li>
                  ))}
                </ul>
              )}
              <AlsoFix text={alsoFix} />
            </div>
          )}
        </>
      ) : (
        <p className="text-[26px] font-semibold leading-8 tracking-[-0.015em] text-inkMuted">
          Not worked out yet.
        </p>
      )}
    </MemoBlock>
  );
}
