"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { MessageCircle, Pencil } from "lucide-react";
import type { ConstraintConflict, GoalWork as GoalWorkData, GrowthGoal, GrowthPlanRow } from "@/lib/workspace/useGrowthPlan";
import { SkeletonBars } from "@/components/ui/SettledSection";
import { GoalHypotheses } from "./GoalWork";
import { CONFIDENCE_LABEL } from "./GrowthConstraint";
import { AlsoFix } from "./GrowthPlanDetail";
import { humanize } from "./growthPresentation";
import { SectionAction, StatusChip } from "./GrowthSection";
import { StoryBox, StoryRow } from "./StoryStep";

export function keepConstraintKey(plan: Pick<GrowthPlanRow, "id" | "version">, hypothesisId: string): string {
  return `zavi.growth.keepConstraint:${plan.id}:${plan.version}:${hypothesisId}`;
}

function readLegacyKept(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function dropLegacyKept(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
  }
}

export function keptDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function unstop(text: string): string {
  return text.trim().replace(/\.+$/, "");
}

export function replacementGuess<T extends { id: string; status: string; claim: string }>(
  hypotheses: readonly T[],
  conflict: ConstraintConflict,
): T | null {
  const best = bestGuess(hypotheses);
  if (!best || best.id === conflict.hypothesis_id) return null;
  const same = (a: string) => unstop(a).toLowerCase();
  return same(best.claim) === same(conflict.claim) ? null : best;
}

export function updatePlanMessage(
  statement: string,
  conflict: ConstraintConflict,
  goal: Pick<GrowthGoal, "objective">,
  best?: { claim: string } | null,
): string {
  const head = `Your plan's blocker is "${unstop(statement)}", but you ruled out "${unstop(conflict.claim)}" for ${goal.objective}.`;
  return best?.claim.trim()
    ? `${head} Your best guess now is "${unstop(best.claim)}". Update the plan's blocker to what the evidence shows.`
    : `${head} Update the plan's blocker to what the evidence shows.`;
}

const STATUS_LABEL = { confirmed: "Backed by evidence", testing: "Testing", listed: "To test", ruled_out: "Ruled out" } as const;

export function bestGuess<T extends { status: string }>(hypotheses: readonly T[]): T | null {
  return (
    hypotheses.find((h) => h.status === "testing") ??
    hypotheses.find((h) => h.status === "listed") ??
    hypotheses.find((h) => h.status === "confirmed") ??
    null
  );
}

export function StoryWay({
  plan,
  planUnavailable,
  alsoFix,
  goals,
  work,
  workUnavailable,
  conflicts,
  building,
  onAsk,
  canEdit = true,
  onChanged,
}: {
  plan: GrowthPlanRow | null;
  planUnavailable: boolean;
  alsoFix?: string;
  goals: GrowthGoal[];
  work: Record<string, GoalWorkData> | undefined;
  workUnavailable: boolean;
  conflicts: ConstraintConflict[];
  building: boolean;
  onAsk?: (text: string) => void;
  canEdit?: boolean;
  onChanged?: () => Promise<void>;
}) {
  const [whyOpen, setWhyOpen] = useState(false);
  const [openList, setOpenList] = useState<string | null>(null);
  const [saved, setSaved] = useState<ReadonlyMap<string, string | null>>(new Map());
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const carried = useRef<Set<string>>(new Set());
  const statement = plan?.constraint_statement?.trim() ?? "";
  const confidence = plan?.constraint_confidence ?? null;
  const evidence = (plan?.basis_evidence ?? []).filter((e) => e.kind !== "gap" && e.statement.trim());
  const gaps = (plan?.basis_evidence ?? []).filter((e) => e.kind === "gap" && e.statement.trim());
  const hasWhy = evidence.length > 0 || gaps.length > 0 || Boolean(alsoFix?.trim());

  const keptAt = (c: ConstraintConflict): string | null => (saved.has(c.hypothesis_id) ? saved.get(c.hypothesis_id)! : (c.kept_at ?? null));
  const conflictFor = (goalId: string): ConstraintConflict | null => {
    if (!plan || !statement) return null;
    return conflicts.find((x) => x.goal_id === goalId) ?? null;
  };
  const anyConflict = goals.some((g) => {
    const c = conflictFor(g.id);
    return c !== null && keptAt(c) === null;
  });

  const save = async (c: ConstraintConflict, kept: boolean): Promise<number | null> => {
    setPending(c.hypothesis_id);
    setFailed(null);
    try {
      const res = await apiFetch(`/api/workspace/growth/conflicts/${c.hypothesis_id}/keep`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kept }),
      });
      if (!res.ok) {
        setFailed(c.hypothesis_id);
        return res.status;
      }
      const body = (await res.json().catch(() => ({}))) as { kept_at?: string | null };
      setSaved((prev) => new Map(prev).set(c.hypothesis_id, kept ? (body.kept_at ?? new Date().toISOString()) : null));
      void onChanged?.();
      return res.status;
    } catch {
      setFailed(c.hypothesis_id);
      return null;
    } finally {
      setPending(null);
    }
  };

  useEffect(() => {
    setSaved((prev) => {
      if (prev.size === 0) return prev;
      const next = new Map(prev);
      for (const [id, v] of prev) {
        const c = conflicts.find((x) => x.hypothesis_id === id);
        if (!c || Boolean(c.kept_at) === (v !== null)) next.delete(id);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [conflicts]);

  useEffect(() => {
    if (!plan || !canEdit) return;
    for (const c of conflicts) {
      if (c.kept_at) continue;
      const key = keepConstraintKey(plan, c.hypothesis_id);
      if (carried.current.has(key) || !readLegacyKept(key)) continue;
      carried.current.add(key);
      void save(c, true).then((status) => {
        if (status !== null && (status < 300 || status === 403 || status === 404)) dropLegacyKept(key);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan?.id, plan?.version, conflicts, canEdit]);

  return (
    <StoryBox>
      {}
      {planUnavailable ? (
        <StoryRow>
          <p className="text-sm text-inkMuted">Couldn&apos;t load this. Try again in a moment.</p>
        </StoryRow>
      ) : !statement ? (
        goals.length === 0 && (
          <StoryRow>
            <p className="text-[14px] font-semibold text-inkMuted">Not worked out yet.</p>
          </StoryRow>
        )
      ) : (
        !anyConflict && (
          <StoryRow>
            <p className="text-[14px] text-ink">
              <span className="text-inkMuted">Plan says: </span>
              <span title={statement}>{statement}</span>
            </p>
            <div className="-ml-2 mt-1.5 flex flex-wrap items-center gap-1">
              {confidence && (
                <span className="ml-2 mr-1 rounded-full bg-creamDeep px-2 py-0.5 text-[12px] font-medium text-inkMuted">
                  {CONFIDENCE_LABEL[confidence]}
                </span>
              )}
              {hasWhy && (
                <SectionAction onClick={() => setWhyOpen((v) => !v)} expanded={whyOpen}>
                  {whyOpen ? "Hide why" : "Why?"}
                </SectionAction>
              )}
              {onAsk && (
                <SectionAction onClick={() => onAsk(`I'm not sure "${statement}" is what's in the way. Let's talk.`)}>
                  <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                  Change this
                </SectionAction>
              )}
            </div>
            {whyOpen && hasWhy && (
              <div className="mt-2 rounded-xl bg-creamDeep p-3.5">
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
          </StoryRow>
        )
      )}

      {goals.map((goal) => {
        const w = work?.[goal.id];
        const hyps = w?.hypotheses ?? [];
        const best = bestGuess(hyps);
        const openHyps = hyps.filter((h) => h.status !== "ruled_out");
        const open = openHyps.length;
        const checking = openHyps.filter((h) => h.research_running === true).length;
        const ruledOut = hyps.length - open;
        const conflict = conflictFor(goal.id);
        const nowGuess = conflict ? replacementGuess(hyps, conflict) : null;
        const listOpen = openList === goal.id;
        return (
          <StoryRow key={goal.id}>
            <div className="flex gap-3 compact:flex-col compact:gap-1">
              <p className="w-[120px] shrink-0 pt-0.5 text-[13px] font-semibold text-inkMuted compact:w-auto" title={goal.objective}>
                {goal.target_metric?.trim() ? humanize(goal.target_metric) : goal.objective}
              </p>
              <div className="min-w-0 flex-1">
                {workUnavailable || w?.hypotheses_unavailable ? (
                  <p className="text-[13px] text-inkMuted">Couldn&apos;t load Zavi&apos;s guesses right now.</p>
                ) : hyps.length === 0 && building ? (
                  <SkeletonBars ariaLabel="Working out what holds this goal back" bars={[{ w: "w-2/3", h: "h-4", mt: "mt-1" }]} />
                ) : hyps.length === 0 ? (
                  <p className="text-[13px] text-inkMuted">Not worked out yet. Zavi lists its guesses at the next review.</p>
                ) : (
                  <>
                    {best ? (
                      <p className="text-[14px] leading-6 text-ink">
                        <span className="font-bold">Best guess: </span>
                        {best.claim}{" "}
                        {best.status !== "testing" && <StatusChip tone="quiet">{STATUS_LABEL[best.status]}</StatusChip>}
                      </p>
                    ) : (
                      <p className="text-[13px] text-inkMuted">Every idea so far is ruled out.</p>
                    )}
                    <p className="mt-0.5 text-[13px] text-inkMuted">
                      {[`${open} ${open === 1 ? "idea" : "ideas"}, ${checking} with a check open`, ruledOut > 0 ? `ruled out ${ruledOut}` : null]
                        .filter(Boolean)
                        .join(" · ")}
                      {" · "}
                      <button
                        type="button"
                        aria-expanded={listOpen}
                        onClick={() => setOpenList(listOpen ? null : goal.id)}
                        className="underline decoration-rule underline-offset-2 hover:text-ink"
                      >
                        {listOpen ? "Show less" : "Show more"}
                      </button>
                    </p>
                    {listOpen && (
                      <div className="mt-2">
                        <GoalHypotheses hypotheses={hyps} />
                      </div>
                    )}
                  </>
                )}
                {conflict && keptAt(conflict) !== null && (
                  <p className="mt-2 text-[13px] text-inkMuted">
                    {`You kept your plan on ${keptDay(keptAt(conflict)!)}. Zavi ruled out: ${unstop(conflict.claim)}.`}
                    {canEdit && (
                      <>
                        {" "}
                        <button
                          type="button"
                          disabled={pending === conflict.hypothesis_id}
                          onClick={() => void save(conflict, false)}
                          className="underline decoration-rule underline-offset-2 hover:text-ink disabled:opacity-60"
                        >
                          Undo
                        </button>
                      </>
                    )}
                    {failed === conflict.hypothesis_id && <span className="ml-2 text-warn">Couldn&apos;t save. Try again.</span>}
                  </p>
                )}
                {conflict && keptAt(conflict) === null && (
                  <div className="mt-2.5 rounded-xl bg-warnBg px-3 py-2.5 text-[13px] text-warn dark:bg-marigold/15 dark:text-marigold">
                    <p className="font-bold">Zavi&apos;s evidence no longer backs your plan.</p>
                    <ul className="mt-1 space-y-0.5">
                      <li>
                        <span className="font-semibold">Your plan says: </span>
                        {statement}
                      </li>
                      <li>
                        <span className="font-semibold">Ruled out for this goal: </span>
                        {conflict.claim}
                      </li>
                      <li>
                        <span className="font-semibold">Best guess now: </span>
                        {nowGuess ? nowGuess.claim : "not found yet, Zavi is still testing."}
                      </li>
                    </ul>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {onAsk && (
                        <button
                          type="button"
                          onClick={() => onAsk(updatePlanMessage(statement, conflict, goal, nowGuess))}
                          className="rounded-full border border-rule bg-cream px-3 py-1 text-[13px] font-semibold text-ink hover:bg-creamDeep"
                        >
                          Update the plan
                        </button>
                      )}
                      {canEdit && (
                        <button
                          type="button"
                          disabled={pending === conflict.hypothesis_id}
                          onClick={() => void save(conflict, true)}
                          className="rounded-full border border-rule bg-cream px-3 py-1 text-[13px] font-semibold text-ink hover:bg-creamDeep disabled:opacity-60"
                        >
                          {pending === conflict.hypothesis_id ? "Saving…" : "Keep my plan"}
                        </button>
                      )}
                    </div>
                    {failed === conflict.hypothesis_id && <p className="mt-1.5 font-semibold">Couldn&apos;t save. Try again.</p>}
                  </div>
                )}
              </div>
            </div>
          </StoryRow>
        );
      })}
    </StoryBox>
  );
}

export function StoryWayAside({ statement, onAsk }: { statement: string | undefined; onAsk?: (text: string) => void }) {
  const s = statement?.trim();
  if (!s || !onAsk) return null;
  return (
    <button
      type="button"
      onClick={() => onAsk(`You think "${s}". How sure are you, and what would change your mind?`)}
      className="inline-flex h-8 items-center gap-1.5 rounded-full border border-rule bg-cream px-3 text-[13px] font-semibold text-ink transition-colors hover:bg-creamDeep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 relative after:absolute after:-inset-y-1.5 after:inset-x-0 after:content-['']"
    >
      <MessageCircle className="h-3.5 w-3.5" aria-hidden="true" />
      Ask Zavi why
    </button>
  );
}
