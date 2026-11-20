"use client";

import { useCallback, useEffect, useRef } from "react";
import { useRealtimeChannel } from "@/lib/workspace/useRealtimeChannel";
import {
  buildRunEndSubscription,
  decideRunToast,
  decideRunUnread,
  type RunEndThreadEvent,
} from "@/lib/workspace/decideRunUnread";
import { agentDisplayName } from "@/lib/agentRegistry";
import { createBrowserSupabase } from "@/lib/supabase";
import { ATTENTION_CHANGED_EVENT } from "@/lib/workspace/needsYou";
import { bumpTabTitle } from "@/lib/workspace/tabTitle";
import { useActiveTenant } from "./brain/useActiveTenant";
import { useWorkspace } from "./WorkspaceShell";
import { notifyThreadsChanged } from "./useAgentThreads";
import { isThreadOnScreen } from "./onScreenThreads";

const SEEN_CAP = 50;

async function openableThread(threadId: string): Promise<{ title: string | null } | null> {
  try {
    const { data, error } = await createBrowserSupabase()
      .from("agent_threads")
      .select("id, title")
      .eq("id", threadId)
      .maybeSingle();
    if (error || data === null) return null;
    const title = (data as { title?: unknown }).title;
    return { title: typeof title === "string" && title.trim() ? title.trim() : null };
  } catch {
    return null;
  }
}

function remember(seen: Set<string>, key: string) {
  seen.add(key);
  if (seen.size > SEEN_CAP) {
    const oldest = seen.values().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
}

export function RunCompletionWatcher() {
  const tenantId = useActiveTenant();
  const {
    tabs,
    activeTabId,
    markTabUnread,
    markThreadSeen,
  } = useWorkspace();

  const seenRef = useRef<Set<string>>(new Set());
  const toastSeenRef = useRef<Set<string>>(new Set());

  const tenantIdRef = useRef(tenantId);
  useEffect(() => {
    tenantIdRef.current = tenantId;
  }, [tenantId]);

  const tabsRef = useRef(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  const activeTabIdRef = useRef(activeTabId);
  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  const markThreadSeenRef = useRef(markThreadSeen);
  useEffect(() => {
    markThreadSeenRef.current = markThreadSeen;
  }, [markThreadSeen]);

  const onInsert = useCallback(
    (raw: RunEndThreadEvent) => {
      const activeTenant = tenantIdRef.current;
      if (typeof activeTenant !== "string") return;
      if (raw.tenant_id !== activeTenant) return;
      if ((raw.kind as string) === "attention") {
        window.dispatchEvent(new Event(ATTENTION_CHANGED_EVENT));
        return;
      }
      if (raw.kind !== "run_end") return;
      notifyThreadsChanged();
      window.dispatchEvent(new Event(ATTENTION_CHANGED_EVENT));

      const threadId = raw.thread_id ?? null;

      const belongsToRun = (t: (typeof tabsRef.current)[number]) => {
        if (t.payload.kind !== "agent" || t.payload.slug !== raw.agent_slug) {
          return false;
        }
        if (threadId !== null) return (t.payload.threadId ?? null) === threadId;
        return true;
      };

      const unread = decideRunUnread(raw, { seenRunIds: seenRef.current });
      if (unread.action === "mark") {
        remember(seenRef.current, unread.dedupeKey);
        const match = tabsRef.current.find(
          (t) =>
            belongsToRun(t) &&
            t.id !== activeTabIdRef.current &&
            (threadId !== null ||
              ((t.payload as { threadId?: string | null }).threadId ?? null) ===
                null),
        );
        if (match && !isThreadOnScreen(threadId)) markTabUnread(match.id);
      }

      const watching =
        typeof document !== "undefined" &&
        !document.hidden &&
        isThreadOnScreen(threadId);
      if (watching && threadId !== null) markThreadSeenRef.current(threadId, { again: true });

      const popup = decideRunToast(raw, {
        seenRunIds: toastSeenRef.current,
        watching,
      });
      if (popup.action !== "toast") return;
      remember(toastSeenRef.current, popup.dedupeKey);
      if (typeof document === "undefined" || !document.hidden) return;
      const runThread = threadId as string;
      const name = agentDisplayName(raw.agent_slug);
      const label = popup.kind === "question" ? `${name} needs you` : `${name} replied`;
      void openableThread(runThread).then((thread) => {
        if (thread) bumpTabTitle(popup.dedupeKey, label);
      });
    },
    [markTabUnread],
  );

  const sub = buildRunEndSubscription(tenantId);
  useRealtimeChannel<RunEndThreadEvent>({
    table: "thread_event",
    scopeKey: sub?.scopeKey ?? "tenant:pending",
    filter: sub?.filter,
    event: "INSERT",
    onInsert,
    enabled: sub !== null,
  });

  return null;
}
