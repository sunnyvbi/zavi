"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { MessageSquare } from "lucide-react";
import { NextChevron } from "@/components/ui/NextChevron";
import { compareActions, isOpenAction } from "@zavi/shared";
import { apiFetch } from "@/lib/api";
import { approveDecision, rejectDecision } from "@/lib/approvals/approveDecision";
import { fetchDecision, fetchHome, type HomeDecision } from "@/lib/approvals/decisionApi";
import { LiveDecisionCard } from "@/components/agents/LiveDecisionCard";
import type { LiveDecisionRow } from "@/lib/approvals/decisionApi";
import { decisionConsequence } from "@/app/approvals/decisionCopy";
import { DecisionBody } from "@/app/approvals/ApprovalsIsland";
import {
  listChannelActions,
  setChannelAction,
  type ChannelActionView,
} from "@/lib/workspace/channelActionsApi";
import { SkeletonBars } from "@/components/ui/SettledSection";
import { oneClickApprovable } from "@/lib/approvals/oneClick";
import { useWorkspaceOptional } from "../WorkspaceShell";
import { ActionStepsView } from "./ActionStepsView";
import { BTN, BTN_DARK, CHIP, ReviewRow, decisionButtonLabels, decisionChip, reviewDecisionText as decisionText, rowWaiting } from "./ReviewRow";
import { ChannelMarkIcon } from "./GrowthChannelLabel";
import { channelName } from "./GrowthChannels";
import { humanize } from "./growthPresentation";

export type ReviewDecision = {
  id: string;
  decision_class: string;
  body: Record<string, unknown>;
  handler: string | null;
  agent_slug?: string | null;
  channel_slug?: string | null;
  exec_class?: string | null;
  post_revision?: string;
  needs_owner_admin?: boolean;
  cgo_hold?: { words: string[]; evidence: string | null } | null;
};

export function heldWhy(hold: ReviewDecision["cgo_hold"]): string | null {
  return hold && hold.words.length ? `Autopilot held this: ${hold.words.join("; ")}` : null;
}

type Outcome = "Done" | "Not now";

export const GROWTH_PAGE_HOMES = ["growth", "channel"] as const;

export const GROWTH_NOT_IN_LIST = "That card is not in your list any more.";

export function firstSentence(text: string | undefined | null): string {
  const t = (text ?? "").trim();
  if (!t) return "";
  const m = t.match(/^.*?[.!?](?=\s|$)/s);
  return (m ? m[0] : t).replace(/\s+/g, " ").trim();
}

const EFFORT_LABEL: Record<string, string> = { minutes: "Minutes", hours: "Hours", days: "Days" };

export function arrangeReview(actions: ChannelActionView[]): {
  top: ChannelActionView | null;
  quick: ChannelActionView[];
  longer: ChannelActionView[];
} {
  const ranked = [...actions].sort(compareActions);
  const [top = null, ...rest] = ranked;
  return {
    top,
    quick: rest.filter((a) => a.body?.step?.effort === "minutes"),
    longer: rest.filter((a) => a.body?.step?.effort !== "minutes"),
  };
}

export function beforeYouDoIt(body: Record<string, unknown> | undefined): Array<[string, string]> {
  const first = Array.isArray(body?.findings) ? (body!.findings as unknown[])[0] : null;
  if (!first || typeof first !== "object") return [];
  const f = first as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return (
    [
      ["Risk", text(f.risk)],
      ["Undo", text(f.undo)],
      ["If you skip it", text(f.do_nothing)],
    ] as Array<[string, string | null]>
  ).filter((row): row is [string, string] => row[1] !== null);
}

const PILL =
  "inline-flex h-9 items-center gap-1.5 rounded-full border border-rule bg-cream px-3.5 text-[13px] font-semibold text-ink transition-colors hover:bg-creamDeep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 relative after:absolute after:-inset-y-1.5 after:inset-x-0 after:content-['']";

export function GrowthReviewList({
  inChannels,
  onAsk,
  onResolved,
  revision = 0,
  focusDecisionId,
}: {
  inChannels: Record<string, number>;
  revision?: number;
  onAsk?: (text: string) => void;
  onResolved: () => void;
  focusDecisionId?: string;
}) {
  const [decisions, setDecisions] = useState<ReviewDecision[] | null>(null);
  const [decisionTotal, setDecisionTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [decided, setDecided] = useState<Record<string, true>>({});
  const [decidedRows, setDecidedRows] = useState<Record<string, LiveDecisionRow>>({});
  const viewerRole = useWorkspaceOptional()?.role ?? null;
  const decidedRef = useRef(decided);
  decidedRef.current = decided;
  const [focusLine, setFocusLine] = useState<string | null>(null);
  const [actions, setActions] = useState<ChannelActionView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Record<string, Outcome>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [failedSlugs, setFailedSlugs] = useState<string[]>([]);
  const [previews, setPreviews] = useState<Record<string, number>>({});
  const [retryKey, setRetryKey] = useState(0);

  const slugKey = Object.keys(inChannels).sort().join("|");
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const page = await fetchHome(GROWTH_PAGE_HOMES, { count: true });
        const now = Date.now();
        const slugs = slugKey ? slugKey.split("|") : [];
        const results = await Promise.allSettled(slugs.map((slug) => listChannelActions(slug, { all: true })));
        if (cancelled) return;
        const failed: string[] = [];
        const locked: Record<string, number> = {};
        const found: ChannelActionView[] = [];
        results.forEach((r, i) => {
          if (r.status === "rejected") {
            failed.push(slugs[i]);
            return;
          }
          found.push(...r.value.actions.filter((a) => isOpenAction(a, now)));
          const n = r.value.locked_preview?.count ?? 0;
          if (n > 0) locked[slugs[i]] = n;
        });
        setDecisions((cur) => keepDecided(cur, page.decisions.map(toReviewDecision), (id) => decidedRef.current[id] === true));
        setDecisionTotal((page.totals?.growth ?? 0) + (page.totals?.channel ?? 0));
        setNextCursor(page.next_cursor);
        setActions(found);
        setFailedSlugs(failed);
        setPreviews(locked);
        setLoadError(null);
      } catch (e) {
        if (!cancelled) setLoadError((e as Error).message || "Could not load what is waiting.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slugKey, revision, retryKey]);

  const settle = async (id: string, done: Outcome, write: () => Promise<unknown>) => {
    setBusy(id);
    setRowError(null);
    try {
      const result = await write();
      if (result === null) return;
      setOutcome((o) => ({ ...o, [id]: done }));
      onResolved();
    } catch (e) {
      setRowError({ id, message: (e as Error).message || "That did not go through. Try again." });
    } finally {
      setBusy(null);
    }
  };

  const decide = async (d: ReviewDecision, action: "approve" | "reject") => {
    setBusy(d.id);
    setRowError(null);
    try {
      const res =
        action === "approve"
          ? await approveDecision(d.id, {}, undefined, { surface: "growth" })
          : await rejectDecision(d.id, { surface: "growth" });
      if (!res) return;
      if (!res.ok) {
        const r = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(r.error?.message ?? `HTTP ${res.status}`);
      }
      setDecided((m) => ({ ...m, [d.id]: true }));
      onResolved();
    } catch (e) {
      setRowError({ id: d.id, message: (e as Error).message || "That did not go through. Try again." });
    } finally {
      setBusy(null);
    }
  };
  const approveOne = (d: ReviewDecision) => decide(d, "approve");
  const rejectOne = (d: ReviewDecision) => decide(d, "reject");

  const showMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await fetchHome(GROWTH_PAGE_HOMES, { cursor: nextCursor });
      setDecisions((cur) => mergeById(cur ?? [], page.decisions.map(toReviewDecision)));
      setNextCursor(page.next_cursor);
    } catch (e) {
      setMoreError((e as Error).message || "Could not load more.");
    } finally {
      setLoadingMore(false);
    }
  };

  const flash = useCallback((id: string) => {
    const el = document.querySelector<HTMLElement>(`[data-review-row="${id}"]`);
    if (!el) return;
    el.scrollIntoView?.({ block: "center", behavior: "smooth" });
    el.classList.add("animate-pulse");
    setTimeout(() => el.classList.remove("animate-pulse"), 1600);
  }, []);
  const [focusDone, setFocusDone] = useState<string | null>(null);
  useEffect(() => {
    if (!focusDecisionId || decisions === null || focusDone === focusDecisionId) return;
    setFocusDone(focusDecisionId);
    if (decisions.some((d) => d.id === focusDecisionId)) {
      setOpen((o) => ({ ...o, [focusDecisionId]: true }));
      setTimeout(() => flash(focusDecisionId), 0);
      return;
    }
    void fetchDecision(focusDecisionId).then((got) => {
      if (!got.ok) {
        setFocusLine(got.notFound ? GROWTH_NOT_IN_LIST : got.error);
        return;
      }
      if (got.decision.status !== "proposed") setDecided((m) => ({ ...m, [focusDecisionId]: true }));
      setDecisions((cur) => [
        {
          id: got.decision.id,
          decision_class: got.decision.decision_class,
          body: got.decision.body ?? {},
          handler: got.decision.handler,
          agent_slug: got.decision.agent_slug ?? null,
          channel_slug: got.home.kind === "channel" ? got.home.slug : null,
          needs_owner_admin: got.needs_owner_admin,
          ...(got.decision.post_revision ? { post_revision: got.decision.post_revision } : {}),
        },
        ...(cur ?? []).filter((d) => d.id !== focusDecisionId),
      ]);
      setOpen((o) => ({ ...o, [focusDecisionId]: true }));
      setTimeout(() => flash(focusDecisionId), 0);
    });
  }, [focusDecisionId, decisions, focusDone, flash]);
  const didIt = (a: ChannelActionView) => settle(a.id, "Done", () => setChannelAction(a.id, { action: "acted" }));
  const notNow = (a: ChannelActionView) =>
    settle(a.id, "Not now", () => setChannelAction(a.id, { action: "snoozed" }));

  if (loadError) {
    return (
      <p role="alert" className="mt-4 text-sm text-warn dark:text-marigold">
        {loadError}
      </p>
    );
  }
  if (decisions === null || actions === null) {
    return (
      <div className="mt-5">
        <SkeletonBars
          ariaLabel="Loading what is waiting"
          minHeight={160}
          bars={[
            { w: "w-full", h: "h-24", className: "rounded-2xl" },
            { w: "w-full", h: "h-10", mt: "mt-4" },
            { w: "w-full", h: "h-10" },
          ]}
        />
      </div>
    );
  }

  const { top, quick, longer } = arrangeReview(actions);
  const openCount = (rows: Array<{ id: string }>) => rows.filter((r) => !outcome[r.id]).length;

  const actionButtons = (a: ChannelActionView) => {
    if (outcome[a.id]) return <span className="text-[13px] font-semibold text-mintDeep">{outcome[a.id]}</span>;
    if (a.executable) {
      return (
        <a href={channelCardHref(a.channel_slug, a.id)} className={BTN}>
          {`Review in ${nameOf(a.channel_slug)}`}
        </a>
      );
    }
    return (
      <>
        <button type="button" disabled={busy === a.id} onClick={() => void didIt(a)} className={BTN_DARK}>
          Did it
        </button>
        <button type="button" disabled={busy === a.id} onClick={() => void notNow(a)} className={BTN}>
          Not now
        </button>
      </>
    );
  };

  const decisionButtons = (d: ReviewDecision) => {
    if (!oneClickApprovable(d, viewerRole)) {
      if (d.channel_slug) {
        return (
          <a href={channelCardHref(d.channel_slug, d.id)} className={BTN}>
            {`Review in ${nameOf(d.channel_slug)}`}
          </a>
        );
      }
      return (
        <button type="button" aria-expanded={!!open[d.id]} onClick={() => toggle(d.id)} className={BTN}>
          {open[d.id] ? "Hide" : "Review"}
        </button>
      );
    }
    return (
      <>
        <button
          type="button"
          disabled={busy === d.id}
          onClick={() => void approveOne(d)}
          className={BTN_DARK}
        >
          {decisionButtonLabels(d).approve}
        </button>
        {decisionButtonLabels(d).reject && (
          <button type="button" disabled={busy === d.id} onClick={() => void rejectOne(d)} className={BTN}>
            {decisionButtonLabels(d).reject}
          </button>
        )}
      </>
    );
  };

  const toggle = (id: string) => setOpen((o) => ({ ...o, [id]: !o[id] }));
  const errorFor = (id: string) =>
    rowError?.id === id ? (
      <p role="alert" className="px-4 pb-3 pl-14 text-[13px] text-warn dark:text-marigold">
        {rowError.message}
      </p>
    ) : null;

  const actionDetail = (a: ChannelActionView) => (
    <ActionDetail
      a={a}
      onAsk={onAsk ? () => onAsk(`About "${a.title}": what should I know before I do it?`) : undefined}
    />
  );

  const group = (label: string, rows: ReactNode, count: number | string) => (
    <>
      <p className="border-t border-rule bg-creamDeep/40 px-4 pb-2 pt-3 text-[12px] font-bold uppercase tracking-[0.05em] text-inkMuted first:border-t-0">
        {`${label} · ${count}`}
      </p>
      {rows}
    </>
  );

  const actionRow = (a: ChannelActionView) => (
    <ReviewRow
      key={a.id}
      icon={<ChannelMarkIcon slug={a.channel_slug} compact />}
      title={a.title}
      why={firstSentence(a.body?.step?.body)}
      chip={EFFORT_LABEL[a.body?.step?.effort ?? ""] ?? null}
      open={!!open[a.id] && !outcome[a.id]}
      waiting={!outcome[a.id]}
      onToggle={() => toggle(a.id)}
      buttons={actionButtons(a)}
      detail={actionDetail(a)}
      error={errorFor(a.id)}
    />
  );

  const decisionRow = (d: ReviewDecision) => {
    const { title, why, agent } = decisionText(d);
    if (decided[d.id]) {
      return (
        <div key={d.id} data-review-row={d.id} className="border-t border-rule px-4 py-3 first:border-t-0">
          <LiveDecisionCard decisionId={d.id} title={title} surface="growth" initialRow={decidedRows[d.id] ?? null} />
        </div>
      );
    }
    const consequence = decisionConsequence(d.handler, d.decision_class, d.body);
    return (
      <div key={d.id} data-review-row={d.id}>
      <ReviewRow
        icon={
          d.channel_slug ? (
            <ChannelMarkIcon slug={d.channel_slug} compact />
          ) : (
            <MessageSquare className="h-5 w-5 text-inkMuted" aria-hidden="true" />
          )
        }
        title={title}
        why={heldWhy(d.cgo_hold) ?? why}
        chip={decisionChip(agent, d)}
        open={!!open[d.id]}
        waiting={rowWaiting(d)}
        onToggle={() => toggle(d.id)}
        buttons={decisionButtons(d)}
        detail={
          <>
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
            {d.cgo_hold?.evidence && (
              <p data-hold-evidence className="line-clamp-4 rounded-md border border-rule bg-bone px-2.5 py-1.5 text-[12px] text-ink">
                {d.cgo_hold.evidence}
              </p>
            )}
            <DecisionBody decisionClass={d.decision_class} handler={d.handler} body={d.body} />
          </div>
          {}
          {!d.channel_slug && !oneClickApprovable(d, viewerRole) && (
            <div className="mt-3">
              <LiveDecisionCard
                decisionId={d.id}
                decisionClass={d.decision_class}
                title={title}
                viewerRole={viewerRole}
                surface="growth"
                onResolved={(_id, _res, settled) => {
                  if (settled) setDecidedRows((m) => ({ ...m, [d.id]: settled }));
                  setDecided((m) => ({ ...m, [d.id]: true }));
                  onResolved();
                }}
              />
            </div>
          )}
          </>
        }
        error={errorFor(d.id)}
      />
      </div>
    );
  };

  const nothing =
    !top &&
    decisions.length === 0 &&
    failedSlugs.length === 0 &&
    Object.keys(previews).length === 0;
  const moreLine = nextCursor ? (
    <div className="flex items-center gap-3 border-t border-rule px-4 py-3">
      <button type="button" disabled={loadingMore} onClick={() => void showMore()} className={BTN}>
        {loadingMore ? "Loading…" : "Show more"}
      </button>
      {moreError && (
        <span role="alert" className="text-[13px] text-warn dark:text-marigold">
          {moreError}
        </span>
      )}
    </div>
  ) : null;
  const openDecisions = Math.max(0, decisionTotal - Object.keys(decided).length);

  return (
    <div className="mt-5">
      {focusLine && (
        <p role="status" className="mb-3 text-[13px] text-inkMuted">
          {focusLine}
        </p>
      )}
      {top && (
        <section
          aria-label="If you do one thing this week"
          className="rounded-2xl border-[1.5px] border-ink px-4 py-4"
        >
          <p className="text-[12px] font-bold uppercase tracking-[0.05em] text-inkMuted">
            If you do one thing this week
          </p>
          <div className="mt-2 flex items-center gap-2">
            <ChannelMarkIcon slug={top.channel_slug} compact />
            <p className="text-[16px] font-semibold text-ink">{top.title}</p>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[13px] text-inkMuted">
            {EFFORT_LABEL[top.body?.step?.effort ?? ""] && (
              <span className={CHIP}>{EFFORT_LABEL[top.body?.step?.effort ?? ""]}</span>
            )}
            <span>{nameOf(top.channel_slug)}</span>
          </div>
          {!outcome[top.id] && actionDetail(top)}
          <div className="mt-3 flex flex-wrap items-center gap-2">{actionButtons(top)}</div>
          {rowError?.id === top.id && (
            <p role="alert" className="mt-2 text-[13px] text-warn dark:text-marigold">
              {rowError.message}
            </p>
          )}
        </section>
      )}

      {(failedSlugs.length > 0 || Object.keys(previews).length > 0) && (
        <ul className="mt-4 space-y-1.5 text-[13px]">
          {failedSlugs.map((slug) => (
            <li key={`f-${slug}`} role="alert" className="text-warn dark:text-marigold">
              {`Couldn't load ${nameOf(slug)}. `}
              <button type="button" onClick={() => setRetryKey((k) => k + 1)} className="underline underline-offset-2">
                Try again
              </button>
            </li>
          ))}
          {Object.entries(previews).map(([slug, n]) => (
            <li key={`p-${slug}`} className="text-inkMuted">
              {`${n} ${n === 1 ? "preview" : "previews"} in ${nameOf(slug)} · `}
              <a href={channelHref(slug)} className="underline underline-offset-2 hover:text-ink">
                {`Open ${nameOf(slug)}`}
              </a>
            </li>
          ))}
        </ul>
      )}

      {nothing ? (
        <p className="mt-4 text-sm text-inkMuted">Nothing is waiting in the list right now.</p>
      ) : (
        <div className="mt-4 overflow-hidden rounded-2xl border border-rule">
          {decisions.length > 0 &&
            group(
              "To approve",
              <>
                {decisions.map(decisionRow)}
                {moreLine}
              </>,
              Math.max(openDecisions, openCount(decisions.filter((d) => !decided[d.id]))),
            )}
          {quick.length > 0 && group("Quick wins", quick.map(actionRow), openCount(quick))}
          {longer.length > 0 && group("Takes longer", longer.map(actionRow), openCount(longer))}
        </div>
      )}
    </div>
  );
}

function toReviewDecision(d: HomeDecision): ReviewDecision {
  return {
    id: d.id,
    ...(d.post_revision ? { post_revision: d.post_revision } : {}),
    needs_owner_admin: d.needs_owner_admin,
    decision_class: d.decision_class,
    body: d.body ?? {},
    handler: d.handler,
    agent_slug: d.agent_slug,
    channel_slug: d.home === "channel" ? d.home_channel : null,
    cgo_hold: d.cgo_hold ?? null,
  };
}

function mergeById(a: ReviewDecision[], b: ReviewDecision[]): ReviewDecision[] {
  const seen = new Set<string>();
  return [...a, ...b].filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true)));
}

export function keepDecided(
  cur: ReviewDecision[] | null,
  fresh: ReviewDecision[],
  isDecided: (id: string) => boolean,
): ReviewDecision[] {
  if (!cur) return fresh;
  const freshIds = new Set(fresh.map((d) => d.id));
  const kept = cur.filter((d) => !freshIds.has(d.id) && isDecided(d.id));
  return [...fresh, ...kept];
}

function nameOf(slug: string): string {
  return channelName(slug) ?? humanize(slug);
}

export function channelCardHref(slug: string, id: string): string {
  return `${channelHref(slug)}&action=${encodeURIComponent(id)}`;
}

export function channelHref(slug: string): string {
  return `/workspace?tab=channels&channel=${encodeURIComponent(slug)}`;
}

function ActionDetail({ a, onAsk }: { a: ChannelActionView; onAsk?: () => void }) {
  const [copied, setCopied] = useState(false);
  const why = a.body?.step?.body?.trim();
  const paste = a.body?.step?.deliverable?.content?.trim();
  const before = beforeYouDoIt(a.body);
  return (
    <div className="mt-2 space-y-3 text-[13px] leading-[19px] text-ink">
      <ActionStepsView text={why} />
      {paste && (
        <div>
          <p className="mb-1 text-[12px] font-bold uppercase tracking-[0.05em] text-inkMuted">Ready to paste</p>
          <div className="relative whitespace-pre-wrap rounded-xl bg-creamDeep px-3 py-2.5 pr-20">
            {paste}
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(paste).then(
                  () => setCopied(true),
                  () => setCopied(false),
                );
              }}
              className="absolute right-2 top-2 inline-flex h-8 items-center rounded-cta border border-rule bg-cream px-2.5 text-[12px] font-semibold text-ink hover:bg-creamDeep"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}
      {before.length > 0 && (
        <div>
          <p className="mb-1 text-[12px] font-bold uppercase tracking-[0.05em] text-inkMuted">Before you do it</p>
          <dl className="grid grid-cols-[110px_1fr] gap-x-2.5 gap-y-1 text-[13px]">
            {before.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="font-semibold text-inkMuted">{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {onAsk && (
          <button type="button" onClick={onAsk} className={PILL}>
            <MessageSquare className="h-3.5 w-3.5" aria-hidden />
            Ask Zavi about this
          </button>
        )}
        <a href={channelHref(a.channel_slug)} className={`${PILL} underline underline-offset-2`}>
          {`Open in ${nameOf(a.channel_slug)}`}
          <NextChevron className="text-inkMuted" />
        </a>
      </div>
    </div>
  );
}
