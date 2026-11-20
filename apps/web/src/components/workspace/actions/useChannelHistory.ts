"use client";

import { useCallback, useEffect, useState } from "react";
import { readWithRetry } from "@/lib/workspace/channelRead";
import { registerSessionScopedCache } from "@/lib/workspace/sessionScopedCache";
import type { CardApproval, ChannelActionStatus } from "@/lib/workspace/channelActionsApi";
import type { ActionType } from "@/lib/workspace/actionTypes";
import type { EmailResultCounts } from "@/components/email/EmailCampaignCard";

export type ChannelRunRow = {
  run_id: string;
  executor: string;
  trigger: string;
  status: string;
  enqueued_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  redo_of_action_id: string | null;
};

export type ChannelClosedRow = {
  id: string;
  run_id: string | null;
  position: number | null;
  run_of: number | null;
  action_type: ActionType;
  title: string;
  status: Extract<ChannelActionStatus, "acted" | "rejected" | "redone" | "stale" | "displaced">;
  status_at: string | null;
  note: string | null;
  proposed_at: string;
  impact: number | null;
  impact_reason: string | null;
  score: number | null;
  sent?: { count: number | null; list: string | null; tool: string | null; at: string | null; total?: number; stopped?: true; note?: string | null; hour_1?: EmailResultCounts | null; day_7?: EmailResultCounts | null };
  executed_at?: string | null;
  approval?: CardApproval | null;
  receipt?: { line: string; url?: string };
};

export type PreSwitchRow = {
  run_id: string | null;
  title: string | null;
  position: number | null;
  of: number | null;
  status: string;
  emitted_at: string | null;
  archived_at: string | null;
  source: "decision";
};

export type ChannelHistory = {
  runs: ChannelRunRow[];
  closed: ChannelClosedRow[];
  pre_switch: PreSwitchRow[];
};

export type ChannelHistoryState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; history: ChannelHistory }
  | { state: "error" };

export type ChannelHistoryRead = {
  history: ChannelHistoryState;
  failed: boolean;
  reload: () => void;
};

export const CHANNEL_HISTORY_CHANGED_EVENT = "zavi:channel-history-changed";

export function announceChannelHistoryChanged(slug: string): void {
  window.dispatchEvent(new CustomEvent(CHANNEL_HISTORY_CHANGED_EVENT, { detail: { slug } }));
}

export const CHANNEL_HISTORY_VIEW_EVENT = "zavi:channel-history-view";

export function viewChannelHistory(slug: string, id: string): void {
  window.dispatchEvent(new CustomEvent(CHANNEL_HISTORY_VIEW_EVENT, { detail: { slug, id } }));
}

export function useChannelHistory(
  slug: string,
  opts: { enabled?: boolean } = {},
): ChannelHistoryState {
  return useChannelHistoryRead(slug, opts).history;
}

const gHistory = globalThis as { __zaviHistoryReads?: Map<string, { read: Promise<Response>; at: number }> };
const historyInFlight = (gHistory.__zaviHistoryReads ??= new Map());
const HISTORY_JOIN_MS = 10_000;

function readHistory(slug: string, fresh: boolean): Promise<Response> {
  registerSessionScopedCache(() => historyInFlight.clear());
  const running = fresh ? undefined : historyInFlight.get(slug);
  let read = running && Date.now() - running.at < HISTORY_JOIN_MS ? running.read : undefined;
  if (!read) {
    const started: Promise<Response> = readWithRetry(`/api/channels/${encodeURIComponent(slug)}/history`, {
      read: "history",
      slug,
    }).finally(() => {
      if (historyInFlight.get(slug)?.read === started) historyInFlight.delete(slug);
    });
    historyInFlight.set(slug, { read: started, at: Date.now() });
    read = started;
  }
  return read.then((res: Response) => (typeof res.clone === "function" ? res.clone() : res));
}

export function useChannelHistoryRead(
  slug: string,
  { enabled = true }: { enabled?: boolean } = {},
): ChannelHistoryRead {
  const [result, setResult] = useState<{ slug: string; state: ChannelHistoryState }>({
    slug,
    state: { state: "idle" },
  });
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    const onChanged = (e: Event) => {
      if ((e as CustomEvent<{ slug?: string }>).detail?.slug === slug) reload();
    };
    window.addEventListener(CHANNEL_HISTORY_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(CHANNEL_HISTORY_CHANGED_EVENT, onChanged);
  }, [slug, reload]);

  useEffect(() => {
    if (!enabled) {
      setResult({ slug, state: { state: "idle" } });
      setFailed(false);
      return;
    }
    let cancelled = false;
    setResult((cur) =>
      cur.slug === slug && cur.state.state === "ready" ? cur : { slug, state: { state: "loading" } },
    );
    const fail = () => {
      if (cancelled) return;
      setFailed(true);
      setResult((cur) =>
        cur.slug === slug && cur.state.state === "ready" ? cur : { slug, state: { state: "error" } },
      );
    };
    void (async () => {
      try {
        const res = await readHistory(slug, tick > 0);
        if (!res.ok) return fail();
        const body = (await res.json()) as Partial<ChannelHistory>;
        if (cancelled) return;
        if (!Array.isArray(body.pre_switch)) return fail();
        setFailed(false);
        setResult({
          slug,
          state: {
            state: "ready",
            history: {
              runs: body.runs ?? [],
              closed: body.closed ?? [],
              pre_switch: body.pre_switch,
            },
          },
        });
      } catch {
        fail();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, enabled, tick]);

  const history: ChannelHistoryState =
    result.slug === slug ? result.state : enabled ? { state: "loading" } : { state: "idle" };
  return { history, failed: failed && enabled, reload };
}
