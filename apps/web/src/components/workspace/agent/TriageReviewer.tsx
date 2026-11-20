"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ProposalCard } from "@/components/agents/ProposalCard";
import { InlineProposalModifyChat } from "@/components/agents/InlineProposalModifyChat";
import {
  flattenBuckets,
  clampIndex,
  keyToTriageAction,
  navigate,
  progressLabel,
  type TriageBucket,
  type TriageDecision,
} from "@/components/agents/triageNav";
import {
  budgetDelta,
  activeWindowContext,
  reversibility,
  type CampaignContextRow,
} from "@/components/agents/decisionSupport";
import {
  snapshotForStage,
  revalidateStaged,
  blockReasonLabel,
  applyOrder,
  stateFromPost,
  resolveTerminalFromReload,
  type StagedSnapshot,
  type FreshProposal,
  type ItemApplyState,
} from "@/components/agents/triageStage";
import { NextChevron } from "@/components/ui/NextChevron";

function isRevisionActive(d: TriageDecision): boolean {
  return d.revision?.status === "requested" || d.revision?.status === "running";
}

function DecisionSupport({
  decision,
  campaigns,
  windowLabel,
  pixelDegraded,
}: {
  decision: TriageDecision;
  campaigns?: CampaignContextRow[];
  windowLabel?: string;
  pixelDegraded?: boolean;
}) {
  const delta = budgetDelta(decision.handler, decision.body);
  const ctx = activeWindowContext(decision.body, campaigns, windowLabel);
  const rev = reversibility(decision.handler);
  const brief = decision.brief ?? null;

  if (!delta.impactLine && !ctx && !rev.line && !brief && !pixelDegraded) return null;

  return (
    <div className="mt-4 flex flex-col gap-2 border-t border-[#f0f0f0] pt-4">
      {}
      {pixelDegraded && (
        <div className="flex items-start gap-2 rounded-[10px] bg-[#fdf6e3] px-3 py-2 text-[12px] leading-[18px] text-[#8a6d00]">
          <span className="font-semibold">Tracking degraded</span>
          <span>
            This is based on under-counted conversions; weigh this with lower confidence.
          </span>
        </div>
      )}

      {delta.impactLine && (
        <div className="flex items-center gap-2 text-[13px] leading-5">
          <span className="font-semibold text-[#0e0f11]">Projected impact</span>
          <span className="text-[#595959]">
            {delta.impactLine}
            {delta.dailyLabel ? ` (${delta.dailyLabel})` : ""}
          </span>
        </div>
      )}

      {ctx && (
        <div className="flex flex-wrap items-center gap-2 text-[13px] leading-5">
          <span className="font-semibold text-[#0e0f11]">
            {ctx.campaignName ?? "This campaign"}
          </span>
          <span className="text-[#595959]">· {ctx.windowLabel}:</span>
          {ctx.spendUsd !== null && (
            <span className="text-[#595959]">
              ${Math.round(ctx.spendUsd).toLocaleString()} spent
            </span>
          )}
          {ctx.roas !== null && (
            <span
              className={`rounded-md px-1.5 py-0.5 text-[12px] font-semibold tabular-nums ${
                ctx.roasTone === "good"
                  ? "bg-[#f5faf8] text-[#167f50]"
                  : "bg-[#fef2f3] text-[#cb2029]"
              }`}
            >
              {ctx.roas}× ROAS · {ctx.roasTone === "good" ? "good" : "low"}
            </span>
          )}
          {ctx.frequency !== null && (
            <span
              className={`rounded-md px-1.5 py-0.5 text-[12px] font-semibold tabular-nums ${
                ctx.frequencyHigh
                  ? "bg-[#fdf6e3] text-[#8a6d00]"
                  : "bg-[#f4f4f4] text-[#595959]"
              }`}
            >
              Freq {ctx.frequency.toFixed(2)}
              {ctx.frequencyHigh ? " · high" : ""}
            </span>
          )}
        </div>
      )}

      {}
      {brief?.track_record && (
        <div className="flex items-center gap-2 text-[13px] leading-5">
          <span className="font-semibold text-[#0e0f11]">Track record</span>
          <span className="text-[#595959]">{brief.track_record.label}</span>
        </div>
      )}

      {brief?.trend && brief.trend.length > 0 && (
        <div className="flex flex-col gap-1 text-[13px] leading-5">
          <span className="font-semibold text-[#0e0f11]">Trend</span>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {brief.trend.map((p) => (
              <span key={p.window} className="text-[#595959] tabular-nums">
                <span className="text-[#8a8a8a]">{p.label}:</span>{" "}
                {p.spend !== null ? `$${Math.round(p.spend).toLocaleString()}` : "-"}
                {p.roas !== null ? ` · ${p.roas}× ROAS` : ""}
              </span>
            ))}
          </div>
        </div>
      )}

      {brief?.confidence && (
        <div className="flex items-center gap-2 text-[13px] leading-5">
          <span className="font-semibold text-[#0e0f11]">Confidence</span>
          <span className="text-[#595959] capitalize">
            {brief.confidence.band}
            {brief.confidence.value !== null
              ? ` (${Math.round(brief.confidence.value * 100)}% sure)`
              : ""}
          </span>
        </div>
      )}

      {rev.line && (
        <div className="flex items-start gap-2 text-[13px] leading-5 text-[#595959]">
          <span className="font-semibold text-[#0e0f11]">Reversibility</span>
          <span>{rev.line}</span>
        </div>
      )}
    </div>
  );
}

export function TriageReviewer({
  buckets,
  total,
  campaigns,
  windowLabel,
  pixelDegraded,
  modifyingId,
  setModifyingId,
  armReject,
  load,
  refetchProposals,
  postDecision,
}: {
  buckets: TriageBucket[];
  total: number;
  campaigns?: CampaignContextRow[];
  windowLabel?: string;
  pixelDegraded?: boolean;
  modifyingId: string | null;
  setModifyingId: React.Dispatch<React.SetStateAction<string | null>>;
  armReject: (id: string | null) => void;
  load: () => Promise<void>;
  refetchProposals: () => Promise<FreshProposal[]>;
  postDecision: (
    id: string,
    action: "approve" | "reject",
  ) => Promise<{ ok: boolean; message?: string }>;
}) {
  const items = useMemo(() => flattenBuckets(buckets), [buckets]);
  const visibleOrder = useMemo(() => items.map((it) => it.decision.id), [items]);
  const [index, setIndex] = useState(0);

  const [staged, setStaged] = useState<Map<string, StagedSnapshot>>(new Map());
  const [itemStates, setItemStates] = useState<Map<string, ItemApplyState>>(new Map());
  const [blocks, setBlocks] = useState<Map<string, string>>(new Map());
  const [postErrors, setPostErrors] = useState<Map<string, string>>(new Map());
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  useEffect(() => {
    setIndex((i) => clampIndex(i, items.length));
  }, [items.length]);

  const current = items[clampIndex(index, items.length)];
  const decisionId = current?.decision.id ?? null;
  const modifyOpen = !!decisionId && modifyingId === decisionId;

  const goPrev = useCallback(() => {
    armReject(null);
    setIndex((i) => navigate(i, "prev", items.length));
  }, [armReject, items.length]);
  const goNext = useCallback(() => {
    armReject(null);
    setIndex((i) => navigate(i, "next", items.length));
  }, [armReject, items.length]);

  const unstage = useCallback((id: string) => {
    setStaged((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    setBlocks((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const stageCurrent = useCallback(
    (action: "approve" | "reject") => {
      if (!current || applying) return;
      if (isRevisionActive(current.decision)) return;
      const d = current.decision;
      setStaged((prev) => {
        const next = new Map(prev);
        next.set(d.id, snapshotForStage(d.id, action, { emitted_at: d.emitted_at, body: d.body }));
        return next;
      });
      armReject(null);
      setIndex((i) => navigate(i, "next", items.length));
    },
    [current, applying, armReject, items.length],
  );

  const doApprove = useCallback(() => stageCurrent("approve"), [stageCurrent]);
  const doReject = useCallback(() => stageCurrent("reject"), [stageCurrent]);

  const doModify = useCallback(() => {
    if (!current) return;
    unstage(current.decision.id);
    setModifyingId((cur) => (cur === current.decision.id ? null : current.decision.id));
  }, [current, setModifyingId, unstage]);

  const applyStaged = useCallback(async () => {
    if (applying || staged.size === 0) return;
    setApplying(true);
    setApplyError(null);
    setBlocks(new Map());
    setPostErrors(new Map());
    try {
      const fresh = await refetchProposals();
      const freshById = new Map(fresh.map((f) => [f.id, f] as const));
      const order = applyOrder(staged, visibleOrder);

      const nextStates = new Map(itemStates);
      const nextBlocks = new Map<string, string>();
      for (const snap of order) {
        const check = revalidateStaged(snap, freshById);
        if (!check.ok) {
          nextStates.set(snap.id, "blocked");
          nextBlocks.set(snap.id, blockReasonLabel(check.reason));
          setItemStates(new Map(nextStates));
          setBlocks(new Map(nextBlocks));
          continue;
        }
        nextStates.set(snap.id, "posting");
        setItemStates(new Map(nextStates));
        const { ok, message } = await postDecision(snap.id, snap.action);
        nextStates.set(snap.id, stateFromPost(ok));
        setItemStates(new Map(nextStates));
        if (!ok && message) {
          setPostErrors((prev) => new Map(prev).set(snap.id, message));
        }
      }

      await load();
      const after = await refetchProposals();
      const afterById = new Map(after.map((f) => [f.id, f] as const));
      for (const snap of order) {
        if (nextStates.get(snap.id) === "dispatch_pending") {
          const fresh2 = afterById.get(snap.id);
          nextStates.set(
            snap.id,
            resolveTerminalFromReload(
              fresh2 ? { status: fresh2.status, dispatch_error: null } : undefined,
            ),
          );
        }
      }
      setItemStates(new Map(nextStates));

      setStaged((prev) => {
        const next = new Map(prev);
        for (const snap of order) {
          const st = nextStates.get(snap.id);
          if (st && st !== "staged") next.delete(snap.id);
        }
        return next;
      });
    } catch (e) {
      setApplyError((e as Error).message || "Apply failed. Nothing was lost; review and try again.");
    } finally {
      setApplying(false);
    }
  }, [applying, staged, refetchProposals, postDecision, visibleOrder, itemStates, load]);

  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = panelRef.current;
    if (!node) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || t.isContentEditable) return;
      }
      const action = keyToTriageAction(e.key);
      if (action.kind === "none") return;
      e.preventDefault();
      switch (action.kind) {
        case "approve":
          doApprove();
          break;
        case "reject":
          doReject();
          break;
        case "modify":
          doModify();
          break;
        case "prev":
          goPrev();
          break;
        case "next":
          goNext();
          break;
      }
    };
    node.addEventListener("keydown", onKey);
    return () => node.removeEventListener("keydown", onKey);
  }, [doApprove, doReject, doModify, goPrev, goNext]);

  if (items.length === 0 || !current) return null;

  let stagedApprove = 0;
  let stagedReject = 0;
  for (const s of staged.values()) {
    if (s.action === "approve") stagedApprove += 1;
    else stagedReject += 1;
  }
  const stagedCount = staged.size;

  const rail = progressLabel({
    current: index,
    total,
    approved: stagedApprove,
    rejected: stagedReject,
  });
  const d = current.decision;
  const revisionActive = isRevisionActive(d);
  const currentStaged = staged.get(d.id) ?? null;
  const currentState = itemStates.get(d.id);
  const currentBlock = blocks.get(d.id) ?? null;

  return (
    <div
      ref={panelRef}
      tabIndex={0}
      aria-label="Approve pending recommendations"
      className="flex flex-col gap-4 outline-none"
    >
      <section>
        <div className="mb-[18px] flex items-baseline justify-between gap-3">
          <h3 className="text-[20px] font-semibold leading-[25px] text-[#0e0f11]">
            Approve Now ({total})
          </h3>
          {}
          <div className="text-[13px] font-medium text-[#595959]" aria-live="polite">
            {rail} · {current.bucketLabel}
          </div>
        </div>

        {}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {items.map((it, i) => {
            const isCurrent = i === index;
            return (
              <span
                key={it.decision.id}
                aria-current={isCurrent ? "true" : undefined}
                aria-label={isCurrent ? `Reviewing ${i + 1} of ${items.length}` : undefined}
                className={
                  isCurrent
                    ? "h-2.5 w-2.5 rounded-full bg-[#0e0f11] ring-2 ring-[#0e0f11] ring-offset-2 ring-offset-white"
                    : "h-2 w-2 rounded-full bg-[#d8d8d8]"
                }
              />
            );
          })}
        </div>

        <ProposalCard
          key={d.id}
          figma
          decisionClass={d.decision_class}
          handler={d.handler}
          body={d.body}
          footer={
            <>
              {}
              <DecisionSupport decision={d} campaigns={campaigns} windowLabel={windowLabel} pixelDegraded={pixelDegraded} />
              {}
              {currentBlock && (
                <div className="mt-3 rounded-[10px] border border-[#f1c0bc] bg-[#fdf2f1] px-3 py-2 text-[13px] font-medium text-[#c0392b]">
                  {currentBlock}
                </div>
              )}
              {!currentBlock && currentStaged && (
                <div className="mt-3 flex items-center gap-2 text-[13px] font-medium text-[#595959]">
                  <span className="rounded-md bg-[#f0f0f0] px-2 py-0.5 font-semibold text-[#0e0f11]">
                    Staged to {currentStaged.action}
                  </span>
                  <span>· not applied yet. Undo any time before Apply.</span>
                </div>
              )}
              {currentState === "dispatch_pending" && (
                <div className="mt-3 text-[13px] font-medium text-[#595959]">
                  Dispatched. Confirming it took effect…
                </div>
              )}
              {currentState === "dispatch_failed" && (
                <div className="mt-3 text-[13px] font-medium text-[#c0392b]">
                  {postErrors.get(d.id) ?? "Didn’t go through. Review and try again."}
                </div>
              )}
              <InlineProposalModifyChat
                decision={d}
                open={modifyOpen}
                onClose={() => setModifyingId(null)}
                onSubmitted={async () => {
                  setModifyingId(null);
                  await load();
                }}
              />
            </>
          }
          actions={
            currentStaged ? (
              <>
                <span className="flex h-10 items-center rounded-[12px] bg-[#f0f0f0] px-3 text-[13px] font-semibold capitalize text-[#0e0f11]">
                  Staged · {currentStaged.action}
                </span>
                <button
                  type="button"
                  disabled={applying}
                  onClick={() => unstage(d.id)}
                  className="flex h-10 cursor-pointer items-center justify-center rounded-cta px-4 py-2 text-[16px] font-semibold text-[#595959] transition-colors hover:bg-[#f1efe9] hover:text-ink disabled:opacity-50"
                >
                  Undo
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  disabled={applying || revisionActive}
                  title={revisionActive ? "Revision requested" : "Approve (A): stages, applied on Apply"}
                  onClick={doApprove}
                  className="flex h-10 cursor-pointer items-center justify-center rounded-cta bg-[#0e0f11] px-4 py-2.5 text-[16px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  Approve
                </button>
                <button
                  type="button"
                  disabled={applying}
                  title="Reject (R): stages, applied on Apply"
                  onClick={doReject}
                  className="flex h-10 cursor-pointer items-center justify-center rounded-cta border border-[#f0f0f0] bg-white px-4 py-2 text-[16px] font-semibold text-[#1f1f1f] transition-colors hover:bg-[#f7f4ee] disabled:opacity-50"
                >
                  Reject
                </button>
                <button
                  type="button"
                  disabled={applying}
                  title="Modify (M)"
                  onClick={doModify}
                  className="flex h-10 cursor-pointer items-center justify-center rounded-cta px-4 py-2 text-[16px] font-semibold text-[#595959] transition-colors hover:bg-[#f1efe9] hover:text-ink disabled:opacity-50"
                >
                  Modify
                </button>
              </>
            )
          }
        />

        {}
        <div className="mt-4 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={goPrev}
            disabled={index <= 0}
            className="flex h-10 cursor-pointer items-center justify-center rounded-cta border border-[#f0f0f0] bg-white px-3 text-[13px] font-semibold text-[#595959] transition-colors hover:bg-[#f7f4ee] disabled:opacity-40"
          >
            ← Prev
          </button>
          <div className="text-[12px] text-[#a8a8a8]">
            <kbd className="font-semibold">A</kbd> approve ·{" "}
            <kbd className="font-semibold">R</kbd> reject ·{" "}
            <kbd className="font-semibold">M</kbd> modify ·{" "}
            <kbd className="font-semibold">← →</kbd> move
          </div>
          <button
            type="button"
            onClick={goNext}
            disabled={index >= items.length - 1}
            className="flex h-10 cursor-pointer items-center justify-center rounded-cta border border-[#f0f0f0] bg-white px-3 text-[13px] font-semibold text-[#595959] transition-colors hover:bg-[#f7f4ee] disabled:opacity-40"
          >
            Next <NextChevron />
          </button>
        </div>

        {}
        {stagedCount > 0 && (
          <div className="sticky bottom-3 mt-5 flex items-center justify-between gap-3 rounded-2xl border border-[#f0f0f0] bg-white px-4 py-3 shadow-[0_6px_24px_rgba(14,15,17,0.08)]">
            <div className="text-[13px] font-medium text-[#0e0f11]" aria-live="polite">
              {stagedCount} decision{stagedCount === 1 ? "" : "s"} staged
              <span className="text-[#595959]">
                {" "}
                ({stagedApprove} approve · {stagedReject} reject)
              </span>
              {applyError && <span className="ml-2 text-[#c0392b]">{applyError}</span>}
            </div>
            <button
              type="button"
              disabled={applying}
              onClick={() => void applyStaged()}
              className="flex h-10 cursor-pointer items-center justify-center rounded-cta bg-[#0e0f11] px-4 py-2.5 text-[16px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {applying ? "Applying…" : `Apply ${stagedCount}`}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
