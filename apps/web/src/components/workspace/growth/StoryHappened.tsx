"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import type { GoalWork as GoalWorkData } from "@/lib/workspace/useGrowthPlan";
import { STATE_LABEL, STATE_TONE, foldFailedRetries, weekMomentum, type Move } from "./GoalWork";
import { humanize } from "./growthPresentation";
import { StatusChip } from "./GrowthSection";
import { StoryBox, StoryRow } from "./StoryStep";

export type YouAsked = { question: string; at: string; answer: string | null };

export function useYouAsked(refresh: unknown): YouAsked | null {
  const [asked, setAsked] = useState<YouAsked | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await apiFetch("/api/workspace/growth/you-asked");
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json().catch(() => null)) as { asked?: unknown } | null;
        const a = body?.asked as Partial<YouAsked> | null | undefined;
        if (!alive) return;
        setAsked(
          a && typeof a.question === "string" && a.question.trim()
            ? { question: a.question, at: typeof a.at === "string" ? a.at : "", answer: typeof a.answer === "string" && a.answer.trim() ? a.answer : null }
            : null,
        );
      } catch {
        if (alive) setAsked(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [refresh]);
  return asked;
}

export function happenedMoves(work: Record<string, GoalWorkData> | undefined): Array<{ move: Move; tries: number }> {
  const seen = new Set<string>();
  const all: Move[] = [];
  for (const goal of Object.values(work ?? {})) {
    for (const m of goal.moves) {
      if (seen.has(m.decision_id) || m.state === "waiting") continue;
      seen.add(m.decision_id);
      all.push(m);
    }
  }
  all.sort((a, b) => (Date.parse(b.emitted_at) || 0) - (Date.parse(a.emitted_at) || 0));
  return foldFailedRetries(all);
}

const SHOWN = 6;

export function StoryHappenedAside({ work }: { work: Record<string, GoalWorkData> | undefined }) {
  const momentum = weekMomentum(work);
  if (momentum.length === 0) return null;
  return (
    <span aria-label="Last 7 days" className="flex flex-wrap items-center gap-2">
      <span>Last 7 days ·</span>
      {momentum.map((m) => (
        <StatusChip key={m.label} tone={m.tone}>
          {m.label}
        </StatusChip>
      ))}
    </span>
  );
}

export function StoryHappened({
  work,
  workUnavailable,
  asked,
}: {
  work: Record<string, GoalWorkData> | undefined;
  workUnavailable: boolean;
  asked: YouAsked | null;
}) {
  const [all, setAll] = useState(false);
  const [breakdown, setBreakdown] = useState(false);
  const moves = happenedMoves(work);
  const shown = all ? moves : moves.slice(0, SHOWN);
  const hidden = moves.length - SHOWN;
  const answerLines = (asked?.answer ?? "").split(/\n+/).map((l) => l.trim()).filter(Boolean);

  return (
    <StoryBox>
      {asked && (
        <StoryRow>
          <div role="group" aria-label="You asked" className="rounded-xl bg-creamDeep px-3.5 py-3 text-[14px]">
            <p className="text-[12px] font-semibold text-inkMuted">{`You asked by email: "${asked.question}"`}</p>
            {answerLines.length === 0 ? (
              <p className="mt-1 text-inkMuted">No reply yet.</p>
            ) : (
              <>
                <p className="mt-1 text-[14px] font-semibold leading-6 text-ink">{answerLines[0]}</p>
                {answerLines.length > 1 && (
                  <>
                    <button
                      type="button"
                      aria-expanded={breakdown}
                      onClick={() => setBreakdown((v) => !v)}
                      className="mt-1 text-[13px] font-semibold text-inkMuted underline decoration-rule underline-offset-2 hover:text-ink"
                    >
                      {breakdown ? "Hide" : "Breakdown"}
                    </button>
                    {breakdown && (
                      <div className="mt-1.5 space-y-1 text-inkSoft">
                        {answerLines.slice(1).map((l, i) => (
                          <p key={i}>{l}</p>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </StoryRow>
      )}
      <StoryRow>
        {workUnavailable ? (
          <p className="text-[13px] text-inkMuted">Couldn&apos;t load what Zavi did.</p>
        ) : moves.length === 0 ? (
          <p className="text-[13px] text-inkMuted">No moves yet. Zavi picks one at its next review.</p>
        ) : (
          <>
            <ul>
              {shown.map(({ move: m, tries }) => (
                <li key={m.decision_id} className="flex items-start gap-2.5 border-t border-rule py-2 text-[14px] first:border-t-0 first:pt-0">
                  <span className="shrink-0 whitespace-nowrap font-bold text-ink">{humanize(m.agent)}</span>
                  <span className="min-w-0 flex-1 text-inkSoft" title={m.intent}>
                    <span className="line-clamp-2">{m.intent}</span>
                  </span>
                  <StatusChip tone={STATE_TONE[m.state]}>
                    {STATE_LABEL[m.state]}
                    {tries > 1 ? ` ×${tries}` : ""}
                  </StatusChip>
                </li>
              ))}
            </ul>
            {hidden > 0 && (
              <button
                type="button"
                aria-expanded={all}
                onClick={() => setAll((v) => !v)}
                className="mt-1.5 text-[13px] font-semibold text-inkMuted underline decoration-rule underline-offset-2 hover:text-ink"
              >
                {all ? "Show less" : "Show more"}
              </button>
            )}
          </>
        )}
      </StoryRow>
    </StoryBox>
  );
}
