"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { findScrollParent } from "@/lib/workspace/scrollParent";
import { ApprovalBlock, type ApprovalResolution, type DecisionBody } from "@/components/agents/ApprovalBlock";
import { EMAIL_CARD_CLASSES } from "@/components/email/emailCardClasses";
import { useWorkspaceOptional } from "./WorkspaceShell";
import { useActiveTenant } from "./brain/useActiveTenant";
import { registerSessionScopedCache } from "@/lib/workspace/sessionScopedCache";
import { decisionTitle, handlerPreview, isExactActionCard } from "@/app/approvals/approvalsHelpers";
import { DayDivider } from "./DayDivider";
import { ThreadFeedRow } from "./ThreadFeedRow";
import { useThreadsFeed } from "@/lib/workspace/useThreadsFeed";
import { groupByDay } from "@/lib/workspace/threadFeedTypes";
import { adChangeHeadline } from "@zavi/shared";

type PendingDecision = {
  id: string;
  decision_class: string;
  handler: string | null;
  body: Record<string, unknown>;
  status: string;
  agent_slug?: string | null;
  run_stopped?: boolean;
};

export type ThreadFeedProps = {
  agentSlug: string;
  agentName: string;
  isActive?: boolean;
  onOpenThread: (threadId: string) => void;
  onReviewDecision?: (decisionId: string) => void;
};

function toDecisionBody(d: PendingDecision): DecisionBody {
  const { agentLabel, verbLabel } = decisionTitle(d.decision_class, d.body);
  const preview = handlerPreview(d.handler, d.body);
  const title =
    adChangeHeadline(d.decision_class, d.body) ||
    preview?.replace(/^[\s→·–—-]+/, "") ||
    [agentLabel, verbLabel].filter(Boolean).join(" · ") ||
    d.decision_class;
  return {
    decision_id: d.id,
    decision_class: d.decision_class,
    title,
    ...(isExactActionCard(d.decision_class, d.body) ? { full_card: true } : {}),
    ...(d.run_stopped === true ? { run_stopped: true } : {}),
  };
}

const FOLLOWING_PREFIX = "zavi.threadFeed.following.";
const FOLLOWING_SETTLED_AGE_MS = 24 * 60 * 60 * 1000;
const FOLLOWING_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const STILL_SENDING = new Set(["approved", "queued", "dispatching", "sending", "waiting_for_tomorrow", "held"]);
type Followed = PendingDecision & { followed_at: number };
const followingKey = (tenantId: string, agentSlug: string) => `${FOLLOWING_PREFIX}${tenantId}.${agentSlug}`;

function clearFollowing(keepTenantId?: string) {
  try {
    const store = window.sessionStorage;
    for (let i = store.length - 1; i >= 0; i--) {
      const key = store.key(i);
      if (key?.startsWith(FOLLOWING_PREFIX) && (keepTenantId === undefined || !key.startsWith(`${FOLLOWING_PREFIX}${keepTenantId}.`))) {
        store.removeItem(key);
      }
    }
  } catch {
    return;
  }
}

const forgetAllFollowing = () => clearFollowing();

async function stillSending(decisionId: string): Promise<boolean> {
  try {
    const res = await apiFetch(`/api/email-cards/decisions/${decisionId}`);
    if (res.status === 404) return false;
    if (!res.ok) return true;
    const card = ((await res.json().catch(() => null)) as { card?: { open?: unknown; status?: unknown } } | null)?.card;
    if (!card || typeof card.status !== "string") return true;
    return card.open !== true && STILL_SENDING.has(card.status);
  } catch {
    return true;
  }
}

function readFollowing(tenantId: string | null | undefined, agentSlug: string): Followed[] {
  if (!tenantId) return [];
  try {
    const raw = window.sessionStorage.getItem(followingKey(tenantId, agentSlug));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter(
          (d): d is Followed =>
            typeof d?.id === "string" &&
            EMAIL_CARD_CLASSES.has(d?.decision_class) &&
            typeof d?.followed_at === "number" &&
            Date.now() - d.followed_at < FOLLOWING_MAX_AGE_MS,
        )
      : [];
  } catch {
    return [];
  }
}

function writeFollowing(tenantId: string | null | undefined, agentSlug: string, followed: readonly Followed[]) {
  if (!tenantId) return;
  try {
    if (followed.length === 0) window.sessionStorage.removeItem(followingKey(tenantId, agentSlug));
    else window.sessionStorage.setItem(followingKey(tenantId, agentSlug), JSON.stringify(followed));
  } catch {
    return;
  }
}

function FeedSkeleton() {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="flex flex-col gap-4 px-3 py-4">
      <span className="sr-only">Loading conversations…</span>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex gap-3">
          <div className="h-7 w-7 shrink-0 animate-pulse rounded-full bg-ink/10" />
          <div className="min-w-0 flex-1">
            <div className="h-3 w-24 animate-pulse rounded bg-ink/10" />
            <div className="mt-2 h-3 w-full max-w-[52ch] animate-pulse rounded bg-ink/10" />
            <div className="mt-1.5 h-3 w-32 animate-pulse rounded bg-ink/10" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ThreadFeed({
  agentSlug,
  agentName,
  isActive = true,
  onOpenThread,
  onReviewDecision,
}: ThreadFeedProps) {
  const { threads, loading, loadingMore, error, hasMore, loadMore, reload } =
    useThreadsFeed(agentSlug);

  const [decisions, setDecisions] = useState<PendingDecision[]>([]);
  const tenantId = useActiveTenant();
  const [followed, setFollowed] = useState<PendingDecision[]>([]);
  const viewerRole = useWorkspaceOptional()?.role ?? null;

  const loadDecisions = useCallback(async () => {
    try {
      const res = await apiFetch("/api/approvals");
      if (!res.ok) return;
      const r = (await res.json().catch(() => ({}))) as {
        decisions?: PendingDecision[];
      };
      setDecisions(
        (r.decisions ?? []).filter(
          (d) =>
            d.agent_slug === agentSlug &&
            d.status === "proposed" &&
            d.handler !== "composio.execute_tool" &&
            !d.decision_class.startsWith("composio."),
        ),
      );
    } catch {
    }
  }, [agentSlug]);

  const decisionsAgentRef = useRef(agentSlug);
  useEffect(() => {
    if (decisionsAgentRef.current !== agentSlug) {
      decisionsAgentRef.current = agentSlug;
      setDecisions([]);
    }
    if (isActive) void loadDecisions();
  }, [agentSlug, isActive, loadDecisions]);

  useEffect(() => {
    if (tenantId) {
      registerSessionScopedCache(forgetAllFollowing);
      clearFollowing(tenantId);
    }
    const stored = readFollowing(tenantId, agentSlug);
    writeFollowing(tenantId, agentSlug, stored);
    setFollowed(stored);
    let live = true;
    const old = stored.filter((d) => Date.now() - d.followed_at >= FOLLOWING_SETTLED_AGE_MS);
    if (old.length > 0) {
      void Promise.all(old.map(async (d) => ((await stillSending(d.id)) ? null : d.id))).then((ids) => {
        const done = new Set(ids.filter((x): x is string => x !== null));
        if (!live || done.size === 0) return;
        writeFollowing(tenantId, agentSlug, readFollowing(tenantId, agentSlug).filter((d) => !done.has(d.id)));
        setFollowed((current) => current.filter((d) => !done.has(d.id)));
      });
    }
    return () => {
      live = false;
    };
  }, [tenantId, agentSlug]);

  const groups = groupByDay([...threads].reverse());

  const rootRef = useRef<HTMLElement | null>(null);
  const scrollParentRef = useRef<HTMLElement | null>(null);
  const didInitialPinRef = useRef(false);
  const settlingRef = useRef(false);
  const restoreRef = useRef<{ height: number; top: number } | null>(null);

  const feedMounted = !loading && !error && threads.length > 0;

  useLayoutEffect(() => {
    if (!feedMounted) return;
    const sp = findScrollParent(rootRef.current);
    scrollParentRef.current = sp;
    if (!sp) return;
    const onScroll = () => {
      const nearBottom = sp.scrollHeight - sp.scrollTop - sp.clientHeight < 100;
      if (!nearBottom) settlingRef.current = false;
    };
    sp.addEventListener("scroll", onScroll, { passive: true });
    return () => sp.removeEventListener("scroll", onScroll);
  }, [feedMounted]);

  useLayoutEffect(() => {
    if (!feedMounted) return;
    let sp = scrollParentRef.current;
    if (!sp) {
      sp = findScrollParent(rootRef.current);
      scrollParentRef.current = sp;
    }
    if (!sp) return;
    if (sp.offsetParent === null || sp.clientHeight === 0) return;
    const spv = sp;

    const restore = restoreRef.current;
    if (restore) {
      restoreRef.current = null;
      spv.scrollTop = spv.scrollHeight - restore.height + restore.top;
      return;
    }

    if (didInitialPinRef.current) return;
    didInitialPinRef.current = true;
    settlingRef.current = true;
    const deadline = performance.now() + 450;
    const pin = () => {
      if (!settlingRef.current) return;
      if (spv.offsetParent === null || spv.clientHeight === 0) return;
      spv.scrollTop = spv.scrollHeight;
      if (performance.now() < deadline) {
        requestAnimationFrame(pin);
      } else {
        settlingRef.current = false;
      }
    };
    requestAnimationFrame(pin);
  }, [feedMounted, threads.length, decisions.length]);

  const handleDecisionResolved = useCallback(
    (decisionId: string, resolution: ApprovalResolution) => {
      const decision = decisions.find((d) => d.id === decisionId);
      if (resolution === "approved" && decision && EMAIL_CARD_CLASSES.has(decision.decision_class)) {
        const stored = readFollowing(tenantId, agentSlug);
        if (!stored.some((d) => d.id === decisionId)) writeFollowing(tenantId, agentSlug, [...stored, { ...decision, followed_at: Date.now() }]);
        setFollowed((current) => (current.some((d) => d.id === decisionId) ? current : [...current, decision]));
      }
      setDecisions((current) => current.filter((d) => d.id !== decisionId));
    },
    [agentSlug, decisions, tenantId],
  );
  const waitingDecisions = decisions.filter((d) => !followed.some((f) => f.id === d.id));
  const followedDecisions = followed;

  const handleLoadMore = useCallback(() => {
    const sp = scrollParentRef.current;
    if (sp) {
      restoreRef.current = { height: sp.scrollHeight, top: sp.scrollTop };
    }
    loadMore();
  }, [loadMore]);

  return (
    <section
      ref={rootRef}
      aria-label={`Conversations with ${agentName}`}
      className="flex flex-col"
    >
      {loading ? (
        <FeedSkeleton />
      ) : error ? (
        <div
          role="alert"
          className="mx-3 my-4 rounded-xl border border-coral/40 bg-coral/5 px-4 py-3"
        >
          <p className="text-[13px] text-ink">
            Couldn&apos;t load your conversations with {agentName}.
          </p>
          <p className="mt-0.5 text-[12px] text-inkMuted">{error}</p>
          <button
            type="button"
            onClick={reload}
            className="mt-2 rounded-cta border border-ink/15 bg-white px-3 py-1 text-[13px] font-medium text-ink transition-colors hover:bg-ink/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
          >
            Try again
          </button>
        </div>
      ) : threads.length === 0 ? (
        <div className="mx-3 my-6 text-center">
          <p className="text-[16px] text-ink">
            No conversations with {agentName} yet.
          </p>
          <p className="mt-1 text-[13px] text-inkMuted">
            Send a message to start one. It&apos;ll show up here.
          </p>
        </div>
      ) : (
        <>
          {}
          {hasMore && (
            <div className="px-3 py-3">
              <button
                type="button"
                onClick={handleLoadMore}
                disabled={loadingMore}
                className="rounded-cta border border-ink/15 bg-white px-3 py-1.5 text-[13px] font-medium text-ink transition-colors hover:bg-ink/5 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
              >
                {loadingMore ? "Loading…" : "Load older conversations"}
              </button>
            </div>
          )}

          {groups.map((g, i) => (
            <div key={g.dayIso ?? `group-${i}`}>
              {g.dayIso && (
                <div className="px-3 pt-2">
                  <DayDivider iso={g.dayIso} />
                </div>
              )}
              {}
              <ul role="list" className="m-0 flex flex-col gap-1 p-0">
                {g.threads.map((t) => (
                  <ThreadFeedRow
                    key={t.id}
                    thread={t}
                    agentSlug={agentSlug}
                    agentName={agentName}
                    onOpen={onOpenThread}
                  />
                ))}
              </ul>
            </div>
          ))}

        </>
      )}

      {}
      {waitingDecisions.length > 0 && (
        <div
          aria-label={`Approvals waiting on you for ${agentName}`}
          className="mt-4 flex flex-col gap-3 px-3 pb-3"
        >
          {waitingDecisions.map((d) => (
            <ApprovalBlock
              key={d.id}
              body={toDecisionBody(d)}
              viewerRole={viewerRole}
              onReview={onReviewDecision}
              onResolved={handleDecisionResolved}
            />
          ))}
        </div>
      )}
      {followedDecisions.length > 0 && (
        <div
          role="region"
          aria-label={`Following for ${agentName}`}
          className="mt-4 flex flex-col gap-3 px-3 pb-3"
        >
          <h3 className="text-[12px] font-medium text-inkMuted">Following</h3>
          {followedDecisions.map((d) => (
            <ApprovalBlock
              key={d.id}
              body={toDecisionBody(d)}
              viewerRole={viewerRole}
              onReview={onReviewDecision}
            />
          ))}
        </div>
      )}
    </section>
  );
}
