"use client";

import { useEffect, useState } from "react";
import { apiFetch, apiUrl } from "@/lib/api";
import {
  POLL_MS_LIVE,
  POLL_MS_STARTING,
  previewPanelState,
  type PreviewPanel,
  type PreviewStatusResponse,
} from "@/components/workspace/previewPanelState";
import { nextSandboxFrameUrl } from "./refineSandboxPreview";

export function useRefineSandboxPreview(runId: string | null): string | null {
  const [frame, setFrame] = useState<{ runId: string; url: string | null } | null>(null);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let panel: PreviewPanel = { kind: "starting" };

    const loop = async () => {
      try {
        const res = await apiFetch(`/api/workspace/engineer-preview/${encodeURIComponent(runId)}/status`);
        if (!cancelled && res.ok) {
          const next = previewPanelState((await res.json()) as PreviewStatusResponse);
          panel = next.kind === "live" ? { ...next, proxyUrl: apiUrl(next.proxyUrl) } : next;
          const settled = panel;
          setFrame((prev) => {
            const current = prev?.runId === runId ? prev.url : null;
            const url = nextSandboxFrameUrl(current, settled);
            return current === url && prev?.runId === runId ? prev : { runId, url };
          });
        }
      } catch {
        void 0;
      }
      if (!cancelled) timer = setTimeout(loop, panel.kind === "live" ? POLL_MS_LIVE : POLL_MS_STARTING);
    };
    void loop();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId]);

  return runId && frame?.runId === runId ? frame.url : null;
}
