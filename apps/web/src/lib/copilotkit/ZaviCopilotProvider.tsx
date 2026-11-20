"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CopilotKitContext, LicenseContext, type CopilotKitContextValue } from "@copilotkit/react-core/v2/context";
import { CopilotKitCoreReact } from "@copilotkit/react-core/v2/headless";
import { createLicenseContextValue } from "@copilotkit/shared";
import { apiUrl } from "@/lib/api";
import { createBrowserSupabase } from "@/lib/supabase";

export const COPILOTKIT_RUNTIME_PATH = "/api/copilotkit";

export function copilotTransportEnabled(): boolean {
  return process.env.NEXT_PUBLIC_COPILOTKIT_TRANSPORT !== "0";
}

export function ZaviCopilotProvider({
  children,
  agentSlug,
  threadId,
}: {
  children: ReactNode;
  agentSlug?: string | null;
  threadId?: string | null;
}) {
  if (!copilotTransportEnabled()) return <>{children}</>;
  return (
    <Inner agentSlug={agentSlug ?? null} threadId={threadId ?? null}>
      {children}
    </Inner>
  );
}

function Inner({ children, agentSlug, threadId }: { children: ReactNode; agentSlug: string | null; threadId: string | null }) {
  const ref = useRef<CopilotKitCoreReact | null>(null);
  if (ref.current === null) {
    ref.current = new CopilotKitCoreReact({
      runtimeUrl: apiUrl(COPILOTKIT_RUNTIME_PATH),
      runtimeTransport: "rest",
      deferInitialConnection: true,
      headers: {},
      properties: {},
    });
  }
  const copilotkit = ref.current;

  useEffect(() => {
    try {
      const sb = createBrowserSupabase() as {
        auth?: {
          getSession?: () => Promise<{ data?: { session?: { access_token?: string } | null } }>;
          onAuthStateChange?: (cb: (e: unknown, s: { access_token?: string } | null) => void) => { data?: { subscription?: { unsubscribe?: () => void } } };
        };
      };
      const apply = (token: string | null | undefined) => {
        copilotkit.setHeaders(token ? { Authorization: `Bearer ${token}` } : {});
        if (token && typeof (copilotkit as { connect?: unknown }).connect === "function") copilotkit.connect();
      };
      if (typeof sb?.auth?.getSession !== "function") return;
      void sb.auth
        .getSession()
        .then((r) => apply(r?.data?.session?.access_token))
        .catch(() => {});
      const sub = typeof sb.auth.onAuthStateChange === "function"
        ? sb.auth.onAuthStateChange((_e, session) => apply(session?.access_token))
        : undefined;
      return () => sub?.data?.subscription?.unsubscribe?.();
    } catch {
      return;
    }
  }, [copilotkit]);

  useEffect(() => {
    copilotkit.setProperties({
      ...(agentSlug ? { agent_slug: agentSlug } : {}),
      ...(threadId ? { zavi_thread_id: threadId } : {}),
    });
  }, [copilotkit, agentSlug, threadId]);

  const [executingToolCallIds, setExecutingToolCallIds] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    const sub = copilotkit.subscribe({
      onToolExecutionStart: ({ toolCallId }) =>
        setExecutingToolCallIds((prev) => (prev.has(toolCallId) ? prev : new Set(prev).add(toolCallId))),
      onToolExecutionEnd: ({ toolCallId }) =>
        setExecutingToolCallIds((prev) => {
          if (!prev.has(toolCallId)) return prev;
          const next = new Set(prev);
          next.delete(toolCallId);
          return next;
        }),
      onError: (event) => {
        console.warn(`[copilotkit] ${event.code}:`, event.error?.message ?? event.error);
      },
    });
    return () => sub.unsubscribe();
  }, [copilotkit]);

  useEffect(() => {
    if (process.env.NODE_ENV === "production" || typeof window === "undefined") return;
    (window as unknown as { __zaviCopilot?: unknown }).__zaviCopilot = {
      core: copilotkit,
      ask: async (text: string) => {
        const agent = copilotkit.getAgent("zavi");
        if (!agent) throw new Error("copilot runtime not connected yet (check /api/copilotkit/info)");
        agent.addMessage({ id: `u-${Date.now()}`, role: "user", content: text });
        return copilotkit.runAgent({ agent });
      },
    };
  }, [copilotkit]);

  const ctx: CopilotKitContextValue = useMemo(() => ({ copilotkit, executingToolCallIds }), [copilotkit, executingToolCallIds]);
  const license = useMemo(() => createLicenseContextValue(undefined), []);

  return (
    <CopilotKitContext.Provider value={ctx}>
      <LicenseContext.Provider value={license}>{children}</LicenseContext.Provider>
    </CopilotKitContext.Provider>
  );
}
