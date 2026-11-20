"use client";

import { useAgentContext } from "@copilotkit/react-core/v2/headless";
import { useWorkspace } from "@/components/workspace/WorkspaceShell";

export function screenContextValue(tabs: Array<{ id: string; kind: string; title: string; payload: unknown }>, activeTabId: string) {
  const active = tabs.find((t) => t.id === activeTabId);
  const p = (active?.payload ?? {}) as { slug?: string; threadId?: string | null };
  return {
    active_tab: active ? { kind: active.kind, title: active.title.slice(0, 80), ...(p.slug ? { agent: p.slug } : {}) } : null,
    open_tabs: tabs.slice(0, 12).map((t) => t.kind),
  };
}

export function useZaviScreenContext() {
  const { tabs, activeTabId } = useWorkspace();
  useAgentContext({
    description: "The Zavi workspace tab the user has open right now",
    value: screenContextValue(tabs, activeTabId),
  });
}
