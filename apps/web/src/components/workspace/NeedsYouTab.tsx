"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessageSquare } from "lucide-react";
import type { DecisionHome } from "@zavi/shared";
import { approveDecision, rejectDecision } from "@/lib/approvals/approveDecision";
import { fetchDecision, fetchHome, type HomeDecision, type HomeTotals } from "@/lib/approvals/decisionApi";
import { oneClickApprovable } from "@/lib/approvals/oneClick";
import { decisionConsequence } from "@/app/approvals/decisionCopy";
import { DecisionBody } from "@/app/approvals/ApprovalsIsland";
import { SkeletonBars } from "@/components/ui/SettledSection";
import type { LiveDecisionRow } from "@/lib/approvals/decisionApi";
import { LiveDecisionCard } from "@/components/agents/LiveDecisionCard";
import { APPROVALS_CHANGED_EVENT } from "./actions/topActions/api";
import { BTN, BTN_DARK, ReviewRow, decisionButtonLabels, decisionChip, reviewDecisionText, rowWaiting } from "./growth/ReviewRow";
import { useOpenStatic } from "./layout/shared";
import { useWorkspaceOptional } from "./WorkspaceShell";

export const NEEDS_YOU_EMPTY = "Nothing needs you right now.";
export const NEEDS_YOU_NOT_IN_LIST = "That card is not in your list any more.";

export function needsYouPill(n: number): string {
  return `${n} ${n === 1 ? "item needs" : "items need"} you`;
}

export function growthLine(n: number): string {
  return `${n} growth ${n === 1 ? "approval" : "approvals"} → Your CGO`;
}

function mergeRows(a: HomeDecision[], b: HomeDecision[]): HomeDecision[] {
  const seen = new Set<string>();
  const out: HomeDecision[] = [];
  for (const r of [...a, ...b]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out.sort((x, y) => (x.emitted_at < y.emitted_at ? 1 : x.emitted_at > y.emitted_at ? -1 : x.id < y.id ? 1 : -1));
}

type Focus = { id: string; state: "looking" | "here" } | { id: string; state: "gone" | "error"; message: string } | null;

export function NeedsYouTab({ isActive = true, focusDecisionId }: { isActive?: boolean; focusDecisionId?: string }) {
  const openStatic = useOpenStatic();
  const openStaticRef = useRef(openStatic);
  openStaticRef.current = openStatic;
  const role = useWorkspaceOptional()?.role ?? null;
  const [rows, setRows] = useState<HomeDecision[] | null>(null);
  const [totals, setTotals] = useState<HomeTotals | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [decided, setDecided] = useState<Record<string, HomeDecision>>({});
  const [decidedRows, setDecidedRows] = useState<Record<string, LiveDecisionRow>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [focus, setFocus] = useState<Focus>(null);
  const [pinned, setPinned] = useState<HomeDecision | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const readSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++readSeq.current;
    try {
      const page = await fetchHome("needs_you", { count: true });
      if (seq !== readSeq.current) return;
      setRows(page.decisions);
      setTotals(page.totals ?? null);
      setNextCursor(page.next_cursor);
      setLoadError(null);
    } catch (e) {
      if (seq !== readSeq.current) return;
      setLoadError((e as Error).message || "Could not load what needs you.");
    }
  }, []);

  useEffect(() => {
    if (!isActive) return;
    void load();
  }, [isActive, load, retryKey]);

  useEffect(() => {
    const onChanged = () => void load();
    window.addEventListener(APPROVALS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(APPROVALS_CHANGED_EVENT, onChanged);
  }, [load]);

  const showMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await fetchHome("needs_you", { cursor: nextCursor });
      setRows((cur) => mergeRows(cur ?? [], page.decisions));
      setNextCursor(page.next_cursor);
    } catch (e) {
      setMoreError((e as Error).message || "Could not load more.");
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    if (!focusDecisionId) {
      setFocus(null);
      setPinned(null);
      return;
    }
    let live = true;
    setFocus({ id: focusDecisionId, state: "looking" });
    void fetchDecision(focusDecisionId).then((got) => {
      if (!live) return;
      if (!got.ok) {
        setFocus(
          got.notFound
            ? { id: focusDecisionId, state: "gone", message: NEEDS_YOU_NOT_IN_LIST }
            : { id: focusDecisionId, state: "error", message: got.error },
        );
        return;
      }
      const home: DecisionHome = got.home;
      if (home.kind === "growth") {
        openStaticRef.current("autopilot", { decision: focusDecisionId });
        return;
      }
      if (home.kind === "channel") {
        openStaticRef.current("channels", { channel: home.slug, action: focusDecisionId });
        return;
      }
      setPinned({
        ...(got.decision as unknown as HomeDecision),
        channel_slug: null,
        run_stopped: false,
        needs_owner_admin: got.needs_owner_admin,
        agent_slug: got.decision.agent_slug ?? null,
        thread_id: got.decision.thread_id ?? null,
        agent_run_id: null,
        emitted_at: got.decision.emitted_at ?? "",
        home: "needs_you",
        home_channel: null,
      });
      setOpen((o) => ({ ...o, [focusDecisionId]: true }));
      setFocus({ id: focusDecisionId, state: "here" });
    });
    return () => {
      live = false;
    };
  }, [focusDecisionId]);

  useEffect(() => {
    if (focus?.state !== "here") return;
    const el = document.querySelector<HTMLElement>(`[data-needs-you-row="${focus.id}"]`);
    if (!el) return;
    el.scrollIntoView?.({ block: "center", behavior: "smooth" });
    el.classList.add("animate-pulse");
    const t = setTimeout(() => el.classList.remove("animate-pulse"), 1600);
    return () => clearTimeout(t);
  }, [focus, rows]);

  const settle = async (d: HomeDecision, action: "approve" | "reject") => {
    setBusy(d.id);
    setRowError(null);
    try {
      const res = action === "approve" ? await approveDecision(d.id, {}, undefined, { surface: "needs_you" }) : await rejectDecision(d.id, { surface: "needs_you" });
      if (!res) return;
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(j.error?.message ?? `HTTP ${res.status}`);
      }
      setDecided((m) => ({ ...m, [d.id]: d }));
      setTotals((t) => (t ? { ...t, needs_you: Math.max(0, t.needs_you - 1) } : t));
    } catch (e) {
      setRowError({ id: d.id, message: (e as Error).message || "That did not go through. Try again." });
    } finally {
      setBusy(null);
    }
  };

  const visible = useMemo(() => {
    const base = mergeRows(rows ?? [], Object.values(decided));
    if (!pinned) return base;
    return [pinned, ...base.filter((r) => r.id !== pinned.id)];
  }, [rows, decided, pinned]);

  const header = (
    <div className="mb-5 compact:mb-3">
      <div className="flex items-center gap-3">
        <h1 className="text-[24px] font-semibold leading-8 tracking-tight text-ink compact:hidden">Needs you</h1>
        {totals && totals.needs_you > 0 && (
          <span
            data-need-you
            className="rounded-full bg-bone px-2.5 py-0.5 text-[13px] font-semibold text-inkMuted [font-variant-numeric:tabular-nums] compact:hidden"
          >
            {needsYouPill(totals.needs_you)}
          </span>
        )}
      </div>
      {totals && totals.growth > 0 && (
        <p className="mt-0.5 text-[13px] leading-[18px] text-inkMuted">
          <button
            type="button"
            onClick={() => openStatic("autopilot")}
            className="underline underline-offset-2 hover:text-ink"
          >
            {growthLine(totals.growth)}
          </button>
        </p>
      )}
    </div>
  );

  const focusLine =
    focus && (focus.state === "gone" || focus.state === "error") ? (
      <p role="status" className="mb-3 text-[13px] text-inkMuted">
        {focus.message}
      </p>
    ) : null;

  const buttons = (d: HomeDecision) => {
    if (!oneClickApprovable(d, role)) {
      return (
        <button type="button" onClick={() => setOpen((o) => ({ ...o, [d.id]: !o[d.id] }))} className={BTN}>
          {open[d.id] ? "Hide" : "Review"}
        </button>
      );
    }
    const labels = decisionButtonLabels(d);
    return (
      <>
        <button type="button" disabled={busy === d.id} onClick={() => void settle(d, "approve")} className={BTN_DARK}>
          {labels.approve}
        </button>
        {labels.reject && (
          <button type="button" disabled={busy === d.id} onClick={() => void settle(d, "reject")} className={BTN}>
            {labels.reject}
          </button>
        )}
      </>
    );
  };

  const row = (d: HomeDecision) => {
    if (decided[d.id]) {
      return (
        <div key={d.id} data-needs-you-row={d.id} className="border-t border-rule px-4 py-3 first:border-t-0">
          <LiveDecisionCard decisionId={d.id} title={reviewDecisionText({ ...d, body: d.body ?? {} }).title} viewerRole={role} surface="needs_you" initialRow={decidedRows[d.id] ?? null} />
        </div>
      );
    }
    const body = d.body ?? {};
    const { title, why, agent } = reviewDecisionText({ ...d, body });
    const high = !oneClickApprovable(d, role);
    const consequence = decisionConsequence(d.handler, d.decision_class, body);
    return (
      <div key={d.id} data-needs-you-row={d.id}>
        <ReviewRow
          icon={<MessageSquare className="h-5 w-5 text-inkMuted" aria-hidden="true" />}
          title={title}
          why={why}
          chip={decisionChip(agent, d)}
          open={!!open[d.id]}
          waiting={rowWaiting(d)}
          onToggle={() => setOpen((o) => ({ ...o, [d.id]: !o[d.id] }))}
          buttons={buttons(d)}
          detail={
            high ? (
              <LiveDecisionCard
                decisionId={d.id}
                decisionClass={d.decision_class}
                title={title}
                viewerRole={role}
                surface="needs_you"
                runStopped={d.run_stopped}
                onResolved={(_id, _res, settled) => {
                  if (settled) setDecidedRows((m) => ({ ...m, [d.id]: settled }));
                  setDecided((m) => ({ ...m, [d.id]: d }));
                  setTotals((t) => (t ? { ...t, needs_you: Math.max(0, t.needs_you - 1) } : t));
                }}
              />
            ) : (
              <div className="space-y-2">
                <dl className="grid grid-cols-[110px_1fr] gap-x-2.5 gap-y-1 text-[13px]">
                  <dt className="font-semibold text-inkMuted">If approved</dt>
                  <dd>{consequence.approve}</dd>
                  {decisionButtonLabels(d).reject && (
                    <>
                      <dt className="font-semibold text-inkMuted">If rejected</dt>
                      <dd>{consequence.reject}</dd>
                    </>
                  )}
                </dl>
                <DecisionBody decisionClass={d.decision_class} handler={d.handler} body={body} />
              </div>
            )
          }
          error={
            rowError?.id === d.id ? (
              <p role="alert" className="px-4 pb-3 pl-14 text-[13px] text-warn dark:text-marigold">
                {rowError.message}
              </p>
            ) : null
          }
        />
      </div>
    );
  };

  let body;
  if (loadError) {
    body = (
      <p role="alert" className="text-sm text-warn dark:text-marigold">
        {loadError}{" "}
        <button type="button" onClick={() => setRetryKey((k) => k + 1)} className="underline underline-offset-2">
          Try again
        </button>
      </p>
    );
  } else if (rows === null) {
    body = (
      <SkeletonBars
        ariaLabel="Loading what needs you"
        minHeight={160}
        bars={[
          { w: "w-full", h: "h-10" },
          { w: "w-full", h: "h-10", mt: "mt-2" },
          { w: "w-full", h: "h-10", mt: "mt-2" },
        ]}
      />
    );
  } else if (visible.length === 0) {
    body = <p className="text-sm text-inkMuted">{NEEDS_YOU_EMPTY}</p>;
  } else {
    body = (
      <>
        <div className="mt-4 overflow-hidden rounded-2xl border border-rule">{visible.map(row)}</div>
        {nextCursor && (
          <div className="mt-3 flex items-center gap-3">
            <button type="button" disabled={loadingMore} onClick={() => void showMore()} className={BTN}>
              {loadingMore ? "Loading…" : "Show more"}
            </button>
            {moreError && (
              <span role="alert" className="text-[13px] text-warn dark:text-marigold">
                {moreError}
              </span>
            )}
          </div>
        )}
      </>
    );
  }

  return (
    <div className="ws-scroll h-full min-h-0 px-6 py-6">
      <div className="mx-auto w-full max-w-[880px]">
        {header}
        {focusLine}
        {body}
      </div>
    </div>
  );
}
