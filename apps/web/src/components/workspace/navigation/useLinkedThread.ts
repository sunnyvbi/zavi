"use client";

import { useEffect, useMemo, useState } from "react";
import { createBrowserSupabase } from "@/lib/supabase";
import { getActiveTenantId } from "@/lib/active-tenant-client";
import type { TabDescriptor } from "@/lib/workspace/types";
import { WORKSPACE_UUID_RE } from "../deepLinkSeed";
import { threadIdFromWorkspacePath } from "./workspaceRoutes";

export function useLinkedThread(location: string, tabs: TabDescriptor[]) {
  const [agents, setAgents] = useState<Record<string, string>>({});
  const url = new URL(location, "https://workspace.local");
  const params = url.searchParams;
  const raw = params.get("thread");
  const threadId =
    threadIdFromWorkspacePath(url.pathname) ??
    (!params.has("agent") && raw && WORKSPACE_UUID_RE.test(raw) ? raw : null);
  const known = tabs.some(
    (tab) =>
      (tab.payload.kind === "agent" || tab.payload.kind === "home") &&
      tab.payload.threadId === threadId,
  );
  const slug = threadId ? agents[threadId] : undefined;

  useEffect(() => {
    if (!threadId || known || slug) return;
    let cancelled = false;
    void (async () => {
      const sb = createBrowserSupabase();
      const tid = await getActiveTenantId(sb);
      if (cancelled || !tid) return;
      const { data } = await sb
        .from("agent_threads")
        .select("agent_slug")
        .eq("id", threadId)
        .eq("tenant_id", tid)
        .maybeSingle();
      if (cancelled || !data?.agent_slug) return;
      setAgents((current) => ({ ...current, [threadId]: data.agent_slug }));
    })();
    return () => {
      cancelled = true;
    };
  }, [threadId, known, slug]);

  return useMemo(
    () =>
      !threadId || !slug
        ? null
        : ({
            id: `route-${slug}-${threadId}`,
            kind: "agent",
            title: slug,
            payload: { kind: "agent", slug, threadId },
            dirty: false,
            pinned: false,
          } satisfies TabDescriptor),
    [threadId, slug],
  );
}
