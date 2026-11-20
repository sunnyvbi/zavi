import { useCallback, useEffect, useRef, useState } from "react";
import type { HandoffRun } from "./useHandoffProgress";

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000];

export function useHandoffReplyRecovery(
  threadId: string | null | undefined,
  runs: HandoffRun[],
  repliedRunIds: ReadonlySet<string>,
  refresh: (() => void | Promise<void>) | undefined,
) {
  const [retry, setRetry] = useState(0);
  const [exhaustedKey, setExhaustedKey] = useState<string | null>(null);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const enabled = !!refresh;
  const missingKey = runs
    .filter((run) => run.status === "success" && !repliedRunIds.has(run.run_id))
    .map((run) => run.run_id)
    .sort()
    .join(",");
  const recoveryKey = JSON.stringify([threadId, missingKey, retry]);
  const reload = useCallback(() => setRetry(value => value + 1), []);

  useEffect(() => {
    if (!threadId || !missingKey || !enabled) return;
    let cancelled = false;
    let inFlight = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hidden = () => document.visibilityState === "hidden";
    const tick = async () => {
      if (cancelled || inFlight || hidden()) return;
      if (attempts > RETRY_DELAYS_MS.length) return;
      inFlight = true;
      attempts++;
      try {
        await refreshRef.current?.();
      } catch {
      } finally {
        inFlight = false;
      }
      if (cancelled) return;
      const delay = RETRY_DELAYS_MS[attempts - 1];
      if (delay === undefined) setExhaustedKey(recoveryKey);
      else if (!hidden()) timer = setTimeout(tick, delay);
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      clearTimeout(timer);
      void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [threadId, missingKey, enabled, recoveryKey]);

  return { exhausted: !!missingKey && exhaustedKey === recoveryKey, reload };
}
