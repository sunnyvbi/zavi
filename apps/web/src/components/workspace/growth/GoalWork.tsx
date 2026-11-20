"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { approveDecision } from "@/lib/approvals/approveDecision";
import type { GoalHypothesis, GoalHypothesisStatus, GoalMoveState, GoalWork as GoalWorkData } from "@/lib/workspace/useGrowthPlan";
import { SkeletonBars } from "@/components/ui/SettledSection";
import { humanize } from "./growthPresentation";
import { PrimaryButton, SecondaryButton, StatusChip, type ChipTone } from "./GrowthSection";

export const STATE_LABEL: Record<GoalMoveState, string> = {
  waiting: "Waiting for you",
  declined: "You said not now",
  starting: "Starting",
  running: "Running",
  done: "Done",
  blocked: "Ran, but the change failed",
  failed: "Didn't finish",
};

export const STATE_TONE: Record<GoalMoveState, ChipTone> = {
  waiting: "wait",
  declined: "quiet",
  starting: "live",
  running: "live",
  done: "good",
  blocked: "bad",
  failed: "bad",
};

export type Move = GoalWorkData["moves"][number];

const HYP_LABEL: Record<GoalHypothesisStatus, string> = {
  confirmed: "Backed by evidence",
  testing: "Testing",
  listed: "To test",
  ruled_out: "Ruled out",
};

const HYP_TONE: Record<GoalHypothesisStatus, ChipTone> = {
  confirmed: "good",
  testing: "live",
  listed: "quiet",
  ruled_out: "quiet",
};

export function GoalHypotheses({
  hypotheses,
  unavailable = false,
  building = false,
}: {
  hypotheses: GoalHypothesis[];
  unavailable?: boolean;
  building?: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div>
      <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-inkMuted">What I think is holding this back</p>
      {unavailable ? (
        <p className="mt-1 text-[13px] text-inkMuted">Couldn&apos;t load my guesses right now.</p>
      ) : hypotheses.length === 0 && building ? (
        <SkeletonBars ariaLabel="Working out what holds this goal back" bars={[{ w: "w-2/3", h: "h-4", mt: "mt-1.5" }]} />
      ) : hypotheses.length === 0 ? (
        <p className="mt-1 text-[13px] text-inkMuted">Not worked out yet. I list my guesses at the next review.</p>
      ) : (
        <ul className="mt-1">
          {hypotheses.map((h) => {
            const expanded = open === h.id;
            return (
              <li key={h.id} className="py-1">
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : h.id)}
                  className="flex w-full items-start gap-3 text-left"
                >
                  <span
                    className={`min-w-0 flex-1 text-[13px] ${h.status === "ruled_out" ? "text-inkMuted line-through" : "text-ink"} ${expanded ? "" : "line-clamp-1"}`}
                  >
                    {h.claim}
                    {h.segment ? <span className="text-inkMuted"> · {h.segment}</span> : null}
                  </span>
                  <StatusChip tone={HYP_TONE[h.status]}>{HYP_LABEL[h.status]}</StatusChip>
                </button>
                {expanded &&
                  (h.evidence.length === 0 ? (
                    <p className="mt-1 text-[13px] text-inkMuted">No evidence checked yet.</p>
                  ) : (
                    <ul className="mt-1 space-y-1">
                      {h.evidence.map((e, i) => (
                        <li key={i} className="text-[13px] text-inkMuted">
                          {e.at ? `${e.at}: ` : ""}
                          {e.quote ? <span className="text-inkSoft">&ldquo;{e.quote}&rdquo;</span> : null}
                          {e.quote && e.why ? " " : null}
                          {e.why}
                        </li>
                      ))}
                    </ul>
                  ))}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function foldFailedRetries(moves: Move[]): Array<{ move: Move; tries: number }> {
  const out: Array<{ move: Move; tries: number }> = [];
  const failedAt = new Map<string, number>();
  for (const move of moves) {
    if (move.state === "failed") {
      const at = failedAt.get(move.agent);
      if (at !== undefined) {
        out[at].tries += 1;
        continue;
      }
      failedAt.set(move.agent, out.length);
    }
    out.push({ move, tries: 1 });
  }
  return out;
}

export function weekMomentum(
  work: Record<string, GoalWorkData> | undefined,
  now: Date = new Date(),
): Array<{ tone: ChipTone; label: string }> {
  const since = now.getTime() - 7 * 86_400_000;
  const seen = new Set<string>();
  const count = { done: 0, running: 0, waiting: 0, failed: 0 };
  for (const goal of Object.values(work ?? {})) {
    for (const m of goal.moves) {
      if (seen.has(m.decision_id)) continue;
      seen.add(m.decision_id);
      const at = Date.parse(m.emitted_at);
      if (!Number.isFinite(at) || at < since) continue;
      if (m.state === "done") count.done += 1;
      else if (m.state === "running" || m.state === "starting") count.running += 1;
      else if (m.state === "waiting") count.waiting += 1;
      else if (m.state === "failed" || m.state === "blocked") count.failed += 1;
    }
  }
  const out: Array<{ tone: ChipTone; label: string }> = [];
  if (count.done) out.push({ tone: "good", label: `${count.done} done` });
  if (count.running) out.push({ tone: "live", label: `${count.running} running` });
  if (count.waiting) out.push({ tone: "wait", label: `${count.waiting} waiting for you` });
  if (count.failed) out.push({ tone: "bad", label: `${count.failed} didn't finish` });
  return out;
}

export function useMoveDecision(onChanged: () => Promise<void>) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const decide = async (decision_id: string, action: "approve" | "reject") => {
    setBusy(decision_id);
    setError(null);
    try {
      const res =
        action === "approve"
          ? await approveDecision(decision_id)
          : await apiFetch(`/api/approvals/${decision_id}/reject`, { method: "POST" });
      if (res === null) return;
      if (!res.ok) {
        setError(action === "approve" ? "Could not approve that. Try again." : "Could not save that. Try again.");
        return;
      }
      await onChanged();
    } catch {
      setError(action === "approve" ? "Could not approve that. Try again." : "Could not save that. Try again.");
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, decide };
}

export function WaitingMove({
  move,
  actsOn,
  onChanged,
}: {
  move: Move;
  actsOn?: string | null;
  onChanged: () => Promise<void>;
}) {
  const { busy, error, decide } = useMoveDecision(onChanged);
  return (
    <div data-testid="waiting-move" className="overflow-hidden rounded-2xl border border-[#efe2c3] bg-white">
      {}
      <div aria-hidden className={`h-1.5 ${busy === null ? "bg-[#e8c46a]" : "bg-[#eadfc8]"}`} />
      <div className="bg-[#fbf6ea] px-3.5 pb-2.5 pt-2.5">
        <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-[#8a5a10]">{`Approve · ${humanize(move.agent)}`}</p>
        <p className="mt-0.5 break-words text-[14px] font-semibold text-ink">{move.intent}</p>
      </div>
      <div className="px-3.5 pb-3 pt-2">
      {move.aims_to_move && <p className="mt-0.5 text-[13px] text-inkMuted">Aims to move: {humanize(move.aims_to_move)}</p>}
      {actsOn && <p className="mt-0.5 text-[13px] text-inkMuted">Acts on: {actsOn}</p>}
      <div className="mt-2 flex gap-2">
        <PrimaryButton onClick={() => void decide(move.decision_id, "approve")} disabled={busy !== null}>
          {busy === move.decision_id ? "Approving…" : "Approve"}
        </PrimaryButton>
        <SecondaryButton onClick={() => void decide(move.decision_id, "reject")} disabled={busy !== null}>
          Not now
        </SecondaryButton>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-warn dark:text-marigold">
          {error}
        </p>
      )}
      </div>
    </div>
  );
}

export function GoalWork({
  work,
  unavailable,
  building = false,
  onChanged,
}: {
  work: GoalWorkData | undefined;
  unavailable: boolean;
  building?: boolean;
  onChanged: () => Promise<void>;
}) {
  const { busy, error, decide } = useMoveDecision(onChanged);
  const [open, setOpen] = useState<string | null>(null);

  if (unavailable) {
    return <p className="mt-3 text-[13px] text-inkMuted">Couldn&apos;t load what I&apos;m doing for this goal.</p>;
  }

  const moves = foldFailedRetries(work?.moves ?? []);
  const hypotheses = work?.hypotheses ?? [];
  const claimOf = new Map(hypotheses.map((h) => [h.id, h.claim]));
  if (!work?.status_line && moves.length === 0 && hypotheses.length === 0 && !work?.hypotheses_unavailable) return null;
  return (
    <div className="mt-3 rounded-xl border border-rule px-4 py-3">
      {work?.status_line ? (
        <p className="line-clamp-1 text-[13px] text-inkSoft" title={work.status_line}>
          {work.status_line}
        </p>
      ) : null}
      <div className={work?.status_line ? "mt-2" : ""}>
        <GoalHypotheses hypotheses={hypotheses} unavailable={work?.hypotheses_unavailable === true} building={building} />
      </div>
      {moves.length === 0 ? (
        <div className="mt-2 flex items-center gap-2">
          <StatusChip tone="quiet">No moves yet</StatusChip>
          <span className="text-[13px] text-inkMuted">I&apos;ll pick one at my next review.</span>
        </div>
      ) : (
        <ul className="mt-2">
          {moves.map(({ move: m, tries }) => {
            const expanded = open === m.decision_id;
            return (
              <li
                key={m.decision_id}
                data-waiting={m.state === "waiting" && busy === null ? "true" : undefined}
                className={`border-t border-rule py-2 first:border-t-0 first:pt-0.5 ${m.state === "waiting" ? "-ml-4 pl-4" : ""} ${m.state === "waiting" && busy === null ? "shadow-[inset_3px_0_0_#e8c46a]" : ""}`}
              >
                <div className="flex items-start gap-3">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => setOpen(expanded ? null : m.decision_id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <p className={`text-[14px] text-ink ${expanded ? "" : "line-clamp-1"}`}>
                      <span className="font-semibold">{humanize(m.agent)}:</span> {m.intent}
                    </p>
                    {m.aims_to_move && (m.state === "waiting" || expanded) && (
                      <p className="mt-0.5 text-[13px] text-inkMuted">Aims to move: {humanize(m.aims_to_move)}</p>
                    )}
                    {m.hypothesis_id && claimOf.has(m.hypothesis_id) && (m.state === "waiting" || expanded) && (
                      <p className="mt-0.5 text-[13px] text-inkMuted">Acts on: {claimOf.get(m.hypothesis_id)}</p>
                    )}
                    {expanded && m.why && <p className="mt-1 text-[13px] text-inkMuted">{m.why}</p>}
                  </button>
                  <StatusChip tone={STATE_TONE[m.state]}>
                    {STATE_LABEL[m.state]}
                    {tries > 1 ? ` ×${tries}` : ""}
                  </StatusChip>
                </div>
                {m.state === "waiting" && (
                  <div className="mt-2 flex gap-2">
                    <PrimaryButton onClick={() => void decide(m.decision_id, "approve")} disabled={busy !== null}>
                      {busy === m.decision_id ? "Approving…" : "Approve"}
                    </PrimaryButton>
                    <SecondaryButton onClick={() => void decide(m.decision_id, "reject")} disabled={busy !== null}>
                      Not now
                    </SecondaryButton>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-warn dark:text-marigold">
          {error}
        </p>
      )}
    </div>
  );
}

export function SuggestedGoal({
  goalId,
  objective,
  onChanged,
}: {
  goalId: string;
  objective: string;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/workspace/growth/goals/${goalId}/accept`, { method: "POST" });
      if (!res.ok) {
        setError(res.status === 404 ? "That suggestion is no longer open." : "Could not add that goal. Try again.");
        return;
      }
      await onChanged();
    } catch {
      setError("Could not add that goal. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 rounded-xl border border-dashed border-rule px-4 py-3">
      <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-inkMuted">Suggested next goal</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-[14px] font-medium text-ink">{objective}</p>
        <PrimaryButton onClick={() => void accept()} disabled={busy}>
          {busy ? "Adding…" : "Make it a goal"}
        </PrimaryButton>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-warn dark:text-marigold">
          {error}
        </p>
      )}
    </div>
  );
}
