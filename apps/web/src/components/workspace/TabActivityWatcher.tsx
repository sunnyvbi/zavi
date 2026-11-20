"use client";

import { useCallback, useEffect, useRef } from "react";
import { useRealtimeChannel } from "@/lib/workspace/useRealtimeChannel";
import { useWorkspace } from "./WorkspaceShell";
import { isThreadOnScreen } from "./onScreenThreads";

type AgentMsgInsert = {
  thread_id: string;
  sender_role: "user" | "assistant" | "system";
};

export function TabActivityWatcher({
  tabId,
  threadId,
}: {
  tabId: string;
  threadId: string;
}) {
  const { activeTabId, markTabUnread } = useWorkspace();

  const activeTabIdRef = useRef(activeTabId);
  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  const onInsert = useCallback(
    (row: AgentMsgInsert) => {
      if (row.sender_role !== "assistant") return;
      if (activeTabIdRef.current === tabId) return;
      if (isThreadOnScreen(threadId)) return;
      markTabUnread(tabId);
    },
    [tabId, threadId, markTabUnread],
  );

  useRealtimeChannel<AgentMsgInsert>({
    table: "agent_thread_messages",
    scopeKey: `agent_thread_messages:watcher:${threadId}`,
    filter: `thread_id=eq.${threadId}`,
    onInsert,
  });

  return null;
}
