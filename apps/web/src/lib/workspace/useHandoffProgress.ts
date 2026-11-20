
import { useEffect, useRef, useState } from "react";
import type { RunPanel } from "@zavi/shared";
import { apiFetch } from "@/lib/api";

export type HandoffRun = {
  run_id: string;
  parent_run_id?: string | null;
  agent_slug: string;
  status: string;
  started_at?: string | null;
  finished_at?: string | null;
  panel: RunPanel;
};

const POLL_MS = 2000;
const REQUEST_MS = 5000;
const MAX_RETRY_MS = 30_000;
const hidden = () =>
  typeof document !== "undefined" && document.visibilityState === "hidden";

const WATCH_MS = 45_000;

export function useHandoffProgress(
  threadId: string | null | undefined,
  rowCount: number,
): HandoffRun[] {
  const [runs, setRuns] = useState<HandoffRun[]>([]);
  const watchUntil = useRef(0);
  const bound = typeof threadId === "string" ? threadId : null;

  useEffect(() => {
    setRuns([]);
  }, [bound]);

  useEffect(() => {
    watchUntil.current = Date.now() + WATCH_MS;
  }, [rowCount, bound]);

  useEffect(() => {
    if (!bound) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    let failures = 0;
    let active: AbortController | null = null;

    const tick = async () => {
      if (hidden()) return;
      if (inFlight) return;
      inFlight = true;
      let anyRunning = false;
      let failed = false;
      const controller = new AbortController();
      active = controller;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const next = await Promise.race([
          (async () => {
            const res = await apiFetch(`/api/agents/threads/${bound}/handoff-progress`, {
              signal: controller.signal,
              retryOnNetworkError: false,
            });
            if (!res.ok) throw new Error("handoff read failed");
            const body = (await res.json()) as { runs?: HandoffRun[] };
            if (!Array.isArray(body?.runs)) throw new Error("invalid handoff read");
            return body.runs;
          })(),
          new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(() => {
              controller.abort();
              reject(new Error("handoff read timed out"));
            }, REQUEST_MS);
          }),
        ]);
        if (cancelled) return;
        anyRunning = next.some((r) => r?.panel?.state === "running");
        failures = 0;
        setRuns(next);
      } catch {
        failed = true;
        failures = Math.min(failures + 1, 5);
      } finally {
        clearTimeout(deadline);
        active = null;
        inFlight = false;
      }
      if (cancelled || hidden()) return;
      if (failed || anyRunning || Date.now() < watchUntil.current) {
        const delay = failed ? Math.min(POLL_MS * 2 ** (failures - 1), MAX_RETRY_MS) : POLL_MS;
        timer = setTimeout(tick, delay);
      }
    };

    const onVisible = () => {
      if (cancelled || hidden()) return;
      watchUntil.current = Date.now() + WATCH_MS;
      if (timer) clearTimeout(timer);
      void tick();
    };
    document.addEventListener("visibilitychange", onVisible);

    void tick();
    return () => {
      cancelled = true;
      active?.abort();
      document.removeEventListener("visibilitychange", onVisible);
      if (timer) clearTimeout(timer);
    };
  }, [bound, rowCount]);

  return runs;
}
