"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  approve as approveChannelAction,
  createLinkedInAudiences,
  listChannelActions,
  listChannelMetrics,
  newRequestId,
  readRedoRunStatus,
  redoChannelAction,
  setChannelAction,
  type ChannelActionView,
  type ChannelActionsList,
  type ChannelPlan,
  type TopActionMiss,
  type ChannelMetric,
} from "@/lib/workspace/channelActionsApi";
import { useWorkspaceOptional } from "@/components/workspace/WorkspaceShell";
import { useChannelChatOpener } from "./channelChat";
import { upgradeOnPlanRefusal, useChannelPlanLock } from "./channelPlanLock";
import { announceChannelHistoryChanged } from "./useChannelHistory";
import { execInFlight, type ActionHandlers, type ActionItem, type ActionRedoState } from "./types";
import { campaignFetch } from "./managed-campaigns/api";
import { startTopAction } from "./topActions/api";

export type { ActionRedoState };

const NO_DONE: ChannelActionView[] = [];
const EMPTY: ChannelActionsList = { actions: [], more: 0, store: "decisions", completed: NO_DONE };

export type ChannelStore = "channel_actions" | "decisions" | "unknown";

export function storeUnresolved(c: { store: ChannelStore; loading: boolean; error: string | null }): boolean {
  if (c.store !== "unknown") return false;
  return !c.loading || c.error !== null;
}

const REDO_WATCH_MS = 20 * 60 * 1000;
const REDO_POLL_MS = 15 * 1000;
const REDO_FAILED_STATUSES: ReadonlySet<string> = new Set(["failed", "error", "parse_failed", "cancelled", "dispatch_error"]);
const RETURN_REFETCH_GAP_MS = 1000;

const ALREADY_HANDLED = "This card was already handled, so Zavi refreshed the list.";
const DONE_NOTE: Record<"acted" | "rejected" | "snoozed", string | null> = {
  acted: null,
  rejected: null,
  snoozed: "Hidden for now. It comes back on its own.",
};

export type ChannelActions = {
  store: ChannelStore;
  actions: ChannelActionView[];
  completed: ChannelActionView[];
  more: number;
  plan: ChannelPlan | null;
  heldCount: number;
  missed: TopActionMiss | null;
  changePlan: (note: string) => Promise<boolean>;
  metrics: ChannelMetric[];
  loading: boolean;
  metricsLoading: boolean;
  busyId: string | null;
  redoState: Record<string, ActionRedoState>;
  notice: string | null;
  setNotice: (n: string | null) => void;
  error: string | null;
  failed: boolean;
  showAll: () => void;
  reload: () => void;
  refreshSilent: () => Promise<void>;
  handlers: ActionHandlers;
};

export function useChannelActions(slug: string, opts: { all?: boolean } = {}): ChannelActions {
  const tenantName = useWorkspaceOptional()?.tenantName;
  const scope = `${tenantName ?? "_"}:${slug}`;
  const [listState, setListState] = useState<{ scope: string; list: ChannelActionsList }>({ scope, list: EMPTY });
  const [storeState, setStoreState] = useState<{ scope: string; store: ChannelStore }>({ scope, store: "unknown" });
  const [error, setError] = useState<string | null>(null);
  const [metricsState, setMetricsState] = useState<{ scope: string; metrics: ChannelMetric[] }>({ scope, metrics: [] });
  const [actionsFailed, setActionsFailed] = useState(false);
  const [metricsFailed, setMetricsFailed] = useState(false);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const list = listState.scope === scope ? listState.list : EMPTY;
  const store: ChannelStore = storeState.scope === scope ? storeState.store : "unknown";
  const metrics = metricsState.scope === scope ? metricsState.metrics : [];
  const setList = useCallback(
    (l: ChannelActionsList) =>
      setListState((cur) => ({
        scope: scopeRef.current,
        list: l.completed === undefined && cur.scope === scopeRef.current ? { ...l, completed: cur.list.completed ?? NO_DONE } : l,
      })),
    [],
  );
  const setStore = useCallback((st: ChannelStore) => setStoreState({ scope: scopeRef.current, store: st }), []);
  const [loading, setLoading] = useState(true);
  const [metricsLoading, setMetricsLoading] = useState(true);
  const [all, setAll] = useState(opts.all === true);
  const [tick, setTick] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [redoState, setRedoState] = useState<Record<string, ActionRedoState>>({});
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const setHidden = useCallback((id: string, hidden: boolean) => {
    setHiddenIds((cur) => {
      if (cur.has(id) === hidden) return cur;
      const next = new Set(cur);
      if (hidden) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const pruneHidden = useCallback((present: readonly string[]) => {
    setHiddenIds((cur) => {
      const keep = [...cur].filter((id) => present.includes(id));
      return keep.length === cur.size ? cur : new Set(keep);
    });
  }, []);
  const redoTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const redoPolls = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const openChat = useChannelChatOpener();
  const planLock = useChannelPlanLock();
  const planLockRef = useRef(planLock);
  const slugRef = useRef(slug);
  slugRef.current = slug;
  planLockRef.current = planLock;
  const upgradeInstead = useCallback((): boolean => {
    const lock = planLockRef.current;
    if (!lock?.tierName) return false;
    lock.upgrade();
    return true;
  }, []);

  const pruneRedoState = useCallback((present: readonly string[]) => {
    setRedoState((cur) => {
      const gone = Object.keys(cur).filter((id) => !present.includes(id));
      if (gone.length === 0) return cur;
      const next = { ...cur };
      for (const id of gone) {
        delete next[id];
        clearTimeout(redoTimers.current[id]);
        delete redoTimers.current[id];
        clearTimeout(redoPolls.current[id]);
        delete redoPolls.current[id];
      }
      return next;
    });
  }, []);

  const markRedoing = useCallback((id: string, runId: string | null = null) => {
    setRedoState((cur) => ({ ...cur, [id]: "working" }));
    clearTimeout(redoTimers.current[id]);
    clearTimeout(redoPolls.current[id]);
    delete redoPolls.current[id];
    redoTimers.current[id] = setTimeout(() => {
      clearTimeout(redoPolls.current[id]);
      delete redoPolls.current[id];
      setRedoState((cur) => (cur[id] === "working" ? { ...cur, [id]: "no_replacement" } : cur));
    }, REDO_WATCH_MS);
    if (!runId) return;
    const watched = redoTimers.current[id];
    const poll = () => {
      redoPolls.current[id] = setTimeout(async () => {
        const status = await readRedoRunStatus(runId).catch(() => null);
        if (redoTimers.current[id] !== watched) return;
        if (status === "success" || (status && REDO_FAILED_STATUSES.has(status))) {
          clearTimeout(redoTimers.current[id]);
          delete redoTimers.current[id];
          delete redoPolls.current[id];
          const settled: ActionRedoState = status === "success" ? "no_replacement" : "failed";
          setRedoState((cur) => (cur[id] === "working" ? { ...cur, [id]: settled } : cur));
          setTick((t) => t + 1);
          return;
        }
        poll();
      }, REDO_POLL_MS);
    };
    poll();
  }, []);

  useEffect(() => {
    const timers = redoTimers.current;
    const polls = redoPolls.current;
    return () => {
      for (const id of Object.keys(timers)) {
        clearTimeout(timers[id]);
        delete timers[id];
      }
      for (const id of Object.keys(polls)) clearTimeout(polls[id]);
    };
  }, []);

  const busyRef = useRef<string | null>(null);
  const writeSeq = useRef(0);
  const silentSeq = useRef(0);
  const allRef = useRef(all);
  allRef.current = all;

  const refreshSilent = useCallback(async () => {
    if (busyRef.current !== null) return;
    const silent = ++silentSeq.current;
    const seq = writeSeq.current;
    try {
      const next = await listChannelActions(slug, { all: allRef.current });
      if (silentSeq.current !== silent || writeSeq.current !== seq || busyRef.current !== null) return;
      setList(next);
      setStore(next.store);
      setError(null);
      setActionsFailed(false);
      pruneRedoState(next.actions.map((a) => a.id));
      pruneHidden(next.actions.map((a) => a.id));
    } catch {
    }
  }, [slug, pruneRedoState, pruneHidden, setList, setStore]);

  useEffect(() => {
    let lastReturnAt = Number.NEGATIVE_INFINITY;
    const onReturn = () => {
      const now = Date.now();
      if (now - lastReturnAt < RETURN_REFETCH_GAP_MS) return;
      lastReturnAt = now;
      void refreshSilent();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") onReturn();
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshSilent]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setMetricsLoading(true);
    void (async () => {
      try {
        const next = await listChannelMetrics(slug);
        if (!cancelled) {
          setMetricsState({ scope: scopeRef.current, metrics: next });
          setMetricsFailed(false);
        }
      } catch (e) {
        if (!cancelled) {
          if (e instanceof ApiError && e.status === 404) {
            setMetricsState({ scope: scopeRef.current, metrics: [] });
            setMetricsFailed(false);
          } else {
            setMetricsFailed(true);
          }
        }
      }
      if (!cancelled) setMetricsLoading(false);
    })();
    void (async () => {
      try {
        const next = await listChannelActions(slug, { all });
        if (!cancelled) {
          setList(next);
          setStore(next.store);
          setError(null);
          setActionsFailed(false);
          pruneRedoState(next.actions.map((a) => a.id));
          pruneHidden(next.actions.map((a) => a.id));
        }
      } catch (e) {
        if (!cancelled) {
          if (e instanceof ApiError && e.status === 404) {
            setList(EMPTY);
            setStore("decisions");
            setError(null);
            setActionsFailed(false);
          } else {
            setError((e as Error).message || "Could not load these actions.");
            setActionsFailed(true);
          }
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, all, tick, pruneRedoState, pruneHidden, setList, setStore]);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  const inFlightIds = list.actions.filter(execInFlight).map((a) => a.id).sort().join("|");
  const lastInFlight = useRef<{ scope: string; ids: string } | null>(null);
  useEffect(() => {
    const prev = lastInFlight.current;
    lastInFlight.current = { scope, ids: inFlightIds };
    if (!prev || prev.scope !== scope || !prev.ids) return;
    const now = new Set(inFlightIds.split("|"));
    if (prev.ids.split("|").some((id) => !now.has(id))) announceChannelHistoryChanged(slugRef.current);
  }, [scope, inFlightIds]);

  const run = useCallback(
    async (a: ActionItem, call: () => Promise<unknown>, ok: string | null): Promise<boolean> => {
      busyRef.current = a.id;
      writeSeq.current += 1;
      setBusyId(a.id);
      setNotice(null);
      try {
        await call();
        if (ok) setNotice(ok);
        setTick((t) => t + 1);
        announceChannelHistoryChanged(slugRef.current);
        return true;
      } catch (e) {
        if (!upgradeOnPlanRefusal(planLockRef.current, e)) setNotice((e as Error).message);
        return false;
      } finally {
        writeSeq.current += 1;
        busyRef.current = null;
        setBusyId(null);
      }
    },
    [],
  );

  const redo = useCallback(
    (a: ActionItem, note: string, kind?: "answer") =>
      upgradeInstead()
        ? Promise.resolve(false)
        : run(
            a,
            async () => {
              const started = await (kind ? redoChannelAction(a.id, note, kind) : redoChannelAction(a.id, note)).catch((e: unknown) => {
                const code = e instanceof ApiError ? (e.body as { error?: { code?: unknown } } | null)?.error?.code : null;
                if (e instanceof ApiError && (e.status === 404 || (e.status === 409 && code === "not_open"))) {
                  setHidden(a.id, true);
                  setTick((t) => t + 1);
                  throw new Error(ALREADY_HANDLED);
                }
                throw e;
              });
              const runId = (started as { run_id?: unknown } | null)?.run_id;
              markRedoing(a.id, typeof runId === "string" && runId ? runId : null);
            },
            kind === "answer" ? "Sent. Zavi is working with your answer." : "Zavi is running this channel again with your note.",
          ),
    [run, markRedoing, upgradeInstead, setHidden],
  );

  const writeProofPage = useCallback(
    (a: ActionItem, topic: number) =>
      upgradeInstead()
        ? Promise.resolve(false)
        : run(
            a,
            async () => {
              await startTopAction("seo", "write_proof_page", newRequestId(), { card_id: a.id, topic });
              markRedoing(a.id);
            },
            null,
          ),
    [run, markRedoing, upgradeInstead],
  );

  const planId = list.plan?.id ?? null;
  const changePlan = useCallback(
    async (note: string): Promise<boolean> => {
      if (!planId) return false;
      if (upgradeInstead()) return false;
      try {
        await redoChannelAction(planId, note);
        return true;
      } catch (e) {
        if (!upgradeOnPlanRefusal(planLockRef.current, e)) setNotice((e as Error).message);
        return false;
      }
    },
    [planId, upgradeInstead],
  );

  const handlers = useMemo<ActionHandlers>(
    () => ({
      onReviseAd: async (a, edits) => {
        if (upgradeInstead()) return false;
        let failure: unknown = null;
        const saved = await run(a,
          () => campaignFetch(`/api/channel-actions/${encodeURIComponent(a.id)}/ad-review`, { method: "POST", body: JSON.stringify(edits) }).catch((error: unknown) => { failure = error; throw error; }),
          "Changes saved as a revised proposal. Review it before approving.");
        if (!saved && failure instanceof Error) throw failure;
        return saved;
      },
      onSetStatus: async (a, status, opts) => {
        const keepShown = opts?.hold === true || opts?.keep === true;
        if (!keepShown) setHidden(a.id, true);
        const ok = await run(
          a,
          () =>
            setChannelAction(a.id, {
              action: status,
              ...(opts?.note ? { note: opts.note } : {}),
              ...(opts?.until ? { until: opts.until } : {}),
              request_id: newRequestId(),
            }).catch((e: unknown) => {
              if (e instanceof ApiError && e.status === 409 && (e.body as { error?: { code?: unknown } } | null)?.error?.code === "exec_in_flight") {
                setTick((t) => t + 1);
                throw new Error("Zavi is making this change now. Wait for it to finish, then try again.");
              }
              if (e instanceof ApiError && (e.status === 404 || e.status === 409)) {
                setTick((t) => t + 1);
                throw new Error("This card changed somewhere else, so the list now shows the latest.");
              }
              if (e instanceof TypeError || (e instanceof ApiError && e.status >= 500)) {
                throw new Error("Zavi could not save that. Try again.");
              }
              if (e instanceof ApiError && /^HTTP \d+$/.test(e.message)) {
                throw new Error("Zavi could not save that.");
              }
              throw e;
            }),
          status === "snoozed" && slugRef.current === "linkedin_ads" ? null : DONE_NOTE[status],
        );
        setHidden(a.id, opts?.keep === true ? false : ok);
        return ok;
      },
      onReopen: async (a) => {
        const ok = await run(a, () => setChannelAction(a.id, { action: "open", request_id: newRequestId() }), null);
        if (ok) setHidden(a.id, false);
        return ok;
      },
      onCreateAudiences: async (a, content) => {
        if (upgradeInstead()) return { ok: false, message: null };
        const out: { line: string; failed: string | null } = { line: "", failed: null };
        await run(
          a,
          async () => {
            try {
              out.line = (await createLinkedInAudiences(a.id, content)).line;
            } catch (e) {
              const said = e instanceof ApiError && !/^HTTP \d+$/.test(e.message) ? e.message : "";
              out.failed = said || "Zavi could not reach LinkedIn, so no audience was saved. Try again.";
            }
          },
          null,
        );
        return out.failed === null ? { ok: true, line: out.line } : { ok: false, message: out.failed };
      },
      onRedo: redo,
      onApprove: (a) =>
        !(slugRef.current === "linkedin_ads" && a.executable && a.action_type === "pause_ad") && upgradeInstead()
          ? Promise.resolve(false)
          : run(a, () => approveChannelAction(a.id, newRequestId()), "Approved. Zavi is making the change now."),
      onOpenChat: openChat
        ? (a, question) =>
            openChat({
              target: "action",
              action: a,
              mode: "ask",
              onRedo: (note) => redo(a, note),
              ...(question?.trim() ? { draft: { text: question.trim(), nonce: Date.now(), autoSend: true } } : {}),
            })
        : undefined,
      onOpenRedoChat: openChat
        ? (a) =>
            openChat({
              target: "action",
              action: a,
              mode: "redo",
              onRedo: (note) => redo(a, note),
            })
        : undefined,
      onOpenAnswerChat: openChat
        ? (a) =>
            openChat({
              target: "action",
              action: a,
              mode: "redo",
              answer: true,
              onRedo: (note) => redo(a, note, "answer"),
            })
        : undefined,
      onEmailCardChanged: () => void refreshSilent(),
      onWriteProofPage: writeProofPage,
    }),
    [run, redo, writeProofPage, openChat, upgradeInstead, refreshSilent, setHidden],
  );

  return {
    store,
    actions: hiddenIds.size ? list.actions.filter((a) => !hiddenIds.has(a.id)) : list.actions,
    completed: list.completed ?? NO_DONE,
    more: list.more,
    plan: list.plan ?? null,
    heldCount: list.held_count ?? 0,
    missed: list.top_action_miss ?? null,
    changePlan,
    metrics,
    loading,
    metricsLoading,
    busyId,
    redoState,
    notice,
    setNotice,
    error,
    failed: actionsFailed || metricsFailed,
    showAll: () => setAll(true),
    reload,
    refreshSilent,
    handlers,
  };
}
