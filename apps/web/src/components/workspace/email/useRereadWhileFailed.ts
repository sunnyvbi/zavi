import { useEffect, useRef } from "react";
import { onTabReturn } from "@/lib/workspace/onTabReturn";
import { useTabHidden } from "../layout/tabHidden";

export const REREAD_EVERY_MS = 10_000;

export function useRereadWhileFailed(failed: boolean, reread: () => void, everyMs: number = REREAD_EVERY_MS) {
  const latest = useRef(reread);
  latest.current = reread;
  const tabHidden = useTabHidden();
  useEffect(() => {
    if (!failed || tabHidden) return;
    const tick = () => {
      if (document.visibilityState !== "hidden") latest.current();
    };
    const timer = setInterval(tick, everyMs);
    const stopListening = onTabReturn(tick);
    window.addEventListener("online", tick);
    return () => {
      clearInterval(timer);
      stopListening();
      window.removeEventListener("online", tick);
    };
  }, [failed, everyMs, tabHidden]);
}
