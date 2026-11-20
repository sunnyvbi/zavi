"use client";

import { useEffect, useMemo, useState } from "react";
import { moveRequest } from "@/lib/approvals/approveDecision";
import type { BudgetChoiceView, FounderCut, MoveView, RaiseAsk } from "@/lib/approvals/decisionApi";
import { blockLines, CUTS_NOT_ENOUGH, raiseAskOf, raiseLabel } from "./BudgetChoicePanel";
import type { SlipStage } from "./slip/decisionSlip";
import { SLIP_PRIMARY, SLIP_QUIET, SlipCard, SlipSlab } from "./slip/SlipParts";

type Line = MoveView["lines"][number];

const money = (n: number) => `$${Math.abs(Math.round(n * 100) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const APPROVED_STATES = new Set(["approved", "dispatching", "acted", "dispatch_failed"]);
const signedDay = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${money(n)}/day`;

export function lineState(l: Line): string | null {
  if (l.status === "acted") return "Done";
  if (l.status === "approved" || l.status === "dispatching") return "Applying";
  if (l.status === "dispatch_failed") return "Didn't go through";
  if (l.status === "rejected" || l.status === "expired" || l.status === "superseded") return "Not applied";
  if (l.status === "proposed" && l.waits_on_cuts) return l.blocked ? "Waiting: needs a new budget choice" : "Runs after the cuts";
  return null;
}

export const tickable = (l: Line): boolean => l.status === "proposed" && !l.waits_on_cuts;

export function canFinish(m: MoveView): boolean {
  const cuts = m.lines.filter((l) => l.side !== "adds");
  return cuts.length > 0 && cuts.every((l) => l.status === "acted") && m.lines.some((l) => l.side === "adds" && l.status === "proposed" && l.waits_on_cuts);
}

type Fit = { net_daily_usd: number; budget_choice: BudgetChoiceView | null } | null;

export function moveSlipStage(lines: readonly Pick<Line, "status">[]): SlipStage {
  const has = (st: string) => lines.some((l) => l.status === st);
  const acted = lines.filter((l) => l.status === "acted").length;
  if (acted > 0 && acted < lines.length) return "partial";
  if (has("dispatching")) return "sending";
  if (has("approved")) return "queued";
  if (has("proposed")) return "waiting";
  if (has("dispatch_failed")) return "failed";
  if (lines.length > 0 && acted === lines.length) return "done";
  if (lines.length > 0 && lines.every((l) => l.status === "rejected")) return "rejected";
  return "closed";
}

const STAGE_WORD: Record<SlipStage, string> = {
  waiting: "Needs your yes",
  queued: "Approved",
  sending: "Applying",
  unknown: "Check it",
  done: "Done",
  failed: "Didn't go through",
  rejected: "Rejected",
  closed: "Closed",
  held: "On hold",
  partial: "Part applied",
};

const cutKey = (c: Pick<FounderCut, "platform" | "object_id">) => `${c.platform}:${c.object_id}`;
export function refusalWords(message: string, touched: boolean): string {
  if (!touched) return message;
  return message.replace(/\s*Nothing was approved[.:]?/gi, "").trim() || "Part of this move went through. Check the lines below.";
}

export function candidateLine(c: FounderCut): string {
  return `Cut ${c.name ?? (c.level === "campaign" ? "a campaign" : "an ad set")} ${money(c.from_usd)} to ${money(c.to_usd)}/day · frees ${money(c.frees_daily_usd)}/day`;
}
export const NO_CANDIDATES = CUTS_NOT_ENOUGH;

export function MoveCard({
  anchorId,
  move,
  onChanged,
  approveBlockedReason = null,
  candidates,
  onReject,
  onFailed,
  notice = null,
  embedded = false,
}: {
  anchorId: string;
  move: MoveView;
  onChanged: () => void | Promise<void>;
  approveBlockedReason?: string | null;
  candidates?: readonly FounderCut[];
  onReject?: () => void;
  onFailed?: (message: string) => void;
  notice?: string | null;
  embedded?: boolean;
}) {
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(move.lines.filter((l) => tickable(l) && !l.suggested).map((l) => l.id)));
  const [cands, setCands] = useState<readonly FounderCut[]>(() => candidates ?? []);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [shownNotice, setShownNotice] = useState<string | null>(notice);
  useEffect(() => setShownNotice(notice), [notice]);
  const [fit, setFit] = useState<Fit>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kept, setKept] = useState<string[] | null>(null);
  const [closed, setClosed] = useState<Array<{ title: string; status: string }>>([]);
  const finish = canFinish(move);
  const waitingRaises = useMemo(() => move.lines.filter((l) => l.side === "adds" && l.status === "proposed" && l.waits_on_cuts).map((l) => l.id), [move]);
  const fitIds = useMemo(() => (finish ? waitingRaises : move.lines.filter((l) => ticked.has(l.id)).map((l) => l.id)), [finish, waitingRaises, move, ticked]);
  const newCuts = useMemo(() => cands.filter((c) => picked.has(cutKey(c))).map((c) => ({ platform: c.platform, object_id: c.object_id, to_usd: c.to_usd })), [cands, picked]);
  const fitKey = `${fitIds.join(",")}|${newCuts.map((c) => `${cutKey(c)}@${c.to_usd}`).join(",")}`;

  useEffect(() => {
    let live = true;
    if (!fitIds.length && !newCuts.length) {
      setFit(null);
      return;
    }
    void moveRequest(anchorId, "move-fit", { ticked_ids: fitIds, ...(newCuts.length ? { new_cuts: newCuts } : {}) })
      .then(async (r) => (r.ok ? ((await r.json()) as { net_daily_usd: number; budget_choice: BudgetChoiceView | null }) : null))
      .then((f) => live && setFit(f ? { net_daily_usd: f.net_daily_usd, budget_choice: f.budget_choice } : null))
      .catch(() => live && setFit(null));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorId, fitKey]);

  const offering = candidates !== undefined;
  const choice = fit?.budget_choice ?? null;
  const over = choice?.kind === "over" ? choice : null;
  const ask: RaiseAsk = over ? raiseAskOf(over) : {};

  const send = async (op: "approve-move" | "reject-move", body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    setShownNotice(null);
    try {
      const r = await moveRequest(anchorId, op, body);
      const j = (await r.json().catch(() => null)) as { kept?: string[]; closed?: Array<{ title: string; status: string }>; error?: { code?: string; message?: string; budget_choice?: BudgetChoiceView | null; candidates?: FounderCut[]; filed?: string[]; done?: string[] } } | null;
      if (!r.ok && j?.error?.code === "candidates_changed") {
        setCands(j.error.candidates ?? []);
        setPicked(new Set());
        setError(j.error.message ?? null);
        return;
      }
      if (!r.ok) {
        if (j?.error?.budget_choice) setFit((f) => ({ net_daily_usd: f?.net_daily_usd ?? 0, budget_choice: j.error!.budget_choice! }));
        const touched = (j?.error?.filed?.length ?? 0) > 0 || (j?.error?.done?.length ?? 0) > 0;
        const msg = refusalWords(j?.error?.message ?? `HTTP ${r.status}`, touched);
        setError(msg);
        if (offering && !touched) return;
        onFailed?.(msg);
      } else if (op === "reject-move") {
        setKept(j?.kept ?? []);
        setClosed(j?.closed ?? []);
      }
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const tickedIds = move.lines.filter((l) => ticked.has(l.id) && tickable(l)).map((l) => l.id);
  const unreadable = choice?.kind === "unreadable";
  const open = move.lines.some((l) => l.status === "proposed");
  const anyTicked = tickedIds.length > 0 || newCuts.length > 0;
  const primaryDisabled = busy || move.still_filing || unreadable || !anyTicked;
  const lineEl = (l: Line) => {
    const st = lineState(l);
    return (
      <li key={l.id} data-testid="move-line" data-line-id={l.id} className="flex flex-wrap items-center gap-2 rounded-lg px-1 py-1 text-[13px] text-ink">
        {tickable(l) ? (
          <input
            type="checkbox"
            aria-label={l.title}
            checked={ticked.has(l.id)}
            disabled={busy}
            onChange={(e) => setTicked((t) => { const n = new Set(t); if (e.target.checked) n.add(l.id); else n.delete(l.id); return n; })}
          />
        ) : null}
        <span dir="auto" className="min-w-0 break-words font-medium">{l.title}</span>
        {l.daily_delta_usd !== null && <span className="tabular-nums text-[#7a6a4a]">{signedDay(l.daily_delta_usd)}</span>}
        {st && <span className="rounded-full bg-[#f5efe0] px-2 py-0.5 text-[11.5px] font-semibold text-[#5c4a1f]">· {st}</span>}
        {l.status === "dispatch_failed" && (
          <>
            {l.dispatch_error && <span className="w-full text-[11.5px] text-[#be123c]">{l.dispatch_error}</span>}
            {!approveBlockedReason && (
              <button type="button" disabled={busy} onClick={() => void send("approve-move", { ticked_ids: [], retry_ids: [l.id] })} className="min-h-[32px] rounded-lg border border-[#e6d6b0] bg-white px-2.5 text-[12px] font-semibold text-ink hover:bg-[#fff8ea] disabled:opacity-50">
                Retry
              </button>
            )}
          </>
        )}
      </li>
    );
  };

  const stage = moveSlipStage(move.lines);
  const hero =
    fit && !unreadable
      ? { eyebrow: "Net daily change", amount: signedDay(fit.net_daily_usd), unit: null, was: null, before: signedDay(fit.net_daily_usd), beforeUnit: null, chip: null }
      : null;
  const body = (
    <div className={embedded ? "" : "px-4 pb-3 pt-3 sm:px-5"}>
      <ul className="space-y-1">
        {move.lines.filter((l) => l.side !== "adds").map(lineEl)}
        {cands.map((c) => {
          const k = cutKey(c);
          const label = candidateLine(c);
          return (
            <li key={k} data-testid="move-candidate" data-object-id={c.object_id} className="flex flex-wrap items-center gap-2 rounded-lg px-1 py-1 text-[13px] text-ink">
              <input type="checkbox" aria-label={label} checked={picked.has(k)} disabled={busy} onChange={(e) => setPicked((t) => { const n = new Set(t); if (e.target.checked) n.add(k); else n.delete(k); return n; })} />
              <span>{label}</span>
            </li>
          );
        })}
        {move.lines.filter((l) => l.side === "adds").map(lineEl)}
      </ul>
      {offering && cands.length === 0 && <p className="mt-1 text-[12.5px] text-ink">{NO_CANDIDATES}</p>}
      {fit && <p data-testid="move-net" className="mt-2 text-[13px] font-semibold tabular-nums text-ink">Net: {signedDay(fit.net_daily_usd)}</p>}
      {over && blockLines(over).map((t) => <p key={t} className="mt-1 text-[13px] leading-snug text-[#3f3f3f]">{t}</p>)}
      {unreadable && choice?.kind === "unreadable" && <p className="mt-1 text-[12.5px] text-ink">Zavi can&apos;t check your ad budget right now ({choice.why}).</p>}
      {move.still_filing && <p className="mt-1 text-[12.5px] text-[#7a6a4a]">Zavi is still filing this move.</p>}
      {kept && kept.length > 0 && <p className="mt-1 text-[12.5px] text-ink">These cuts already went through and stay: {kept.join("; ")}.</p>}
      {closed.some((c) => APPROVED_STATES.has(c.status)) && <p className="mt-1 text-[12.5px] text-ink">Already approved, so not rejected: {closed.filter((c) => APPROVED_STATES.has(c.status)).map((c) => c.title).join("; ")}.</p>}
      {closed.some((c) => !APPROVED_STATES.has(c.status)) && <p className="mt-1 text-[12.5px] text-ink">Already closed without being approved: {closed.filter((c) => !APPROVED_STATES.has(c.status)).map((c) => c.title).join("; ")}.</p>}
      {(error ?? shownNotice) && <p className="mt-1 text-[12.5px] text-[#be123c]">{error ?? shownNotice}</p>}
      {open && (
        <div className="mt-3">
          {approveBlockedReason ? (
            <p className="rounded-xl bg-[#f5efe0] px-3 py-2.5 text-[12.5px] text-[#5c5240]">{approveBlockedReason}</p>
          ) : finish ? (
            <button type="button" disabled={busy || unreadable} onClick={() => void send("approve-move", { ticked_ids: [], finish: true, ...ask })} className={SLIP_PRIMARY}>
              {busy ? "Submitting…" : "Finish the raise"}
            </button>
          ) : (
            anyTicked && (
              <button type="button" disabled={primaryDisabled} onClick={() => void send("approve-move", { ticked_ids: tickedIds, ...(newCuts.length ? { new_cuts: newCuts } : {}), ...ask })} className={SLIP_PRIMARY}>
                {busy ? "Submitting…" : over ? raiseLabel(over) : "Approve"}
              </button>
            )
          )}
          <div className="mt-1 flex justify-end">
            <button type="button" disabled={busy} onClick={() => (onReject ? onReject() : void send("reject-move", {}))} className={SLIP_QUIET}>
              Reject
            </button>
          </div>
        </div>
      )}
    </div>
  );
  if (embedded) {
    return (
      <section role="region" aria-label="Your move" data-testid="move-card" data-stage={stage} className="rounded-xl border border-[#efe2c3] bg-white p-3">
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-[#a8977a]">Pay for it with a cut · {move.lines.length + cands.length} changes</p>
        {body}
      </section>
    );
  }
  return (
    <div data-testid="move-card" data-stage={stage}>
      <SlipCard label="Your move" decisionId={anchorId}>
        <SlipSlab stage={stage} literal status={move.still_filing ? "Still filing" : STAGE_WORD[stage]} platform="Your move" mark="↹" target={null} title={`This move · ${move.lines.length + cands.length} changes`} hero={hero} />
        {body}
      </SlipCard>
    </div>
  );
}

const claims = new Map<string, string>();
const waiting = new Set<() => void>();

export function useMoveClaim(key: string | null, id: string): boolean {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!key) return;
    const wake = () => bump((n) => n + 1);
    waiting.add(wake);
    if (!claims.has(key)) {
      claims.set(key, id);
      for (const w of waiting) w();
    }
    return () => {
      waiting.delete(wake);
      if (claims.get(key) === id) {
        claims.delete(key);
        for (const w of waiting) w();
      }
    };
  }, [key, id]);
  if (!key) return true;
  return claims.get(key) === id;
}
