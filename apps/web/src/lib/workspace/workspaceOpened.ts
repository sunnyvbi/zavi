import { useEffect } from "react";
import { apiFetch } from "@/lib/api";

export const WORKSPACE_OPENED_MIN_GAP_MS = 10 * 60_000;

let lastSent: number | null = null;

export function resetWorkspaceOpened(): void {
  lastSent = null;
}

export function reportWorkspaceOpened(now: number = Date.now()): void {
  if (lastSent !== null && now - lastSent < WORKSPACE_OPENED_MIN_GAP_MS) return;
  lastSent = now;
  const forget = () => {
    if (lastSent === now) lastSent = null;
  };
  void apiFetch("/api/workspace/opened", { method: "POST" })
    .then((res) => {
      if (!res.ok) forget();
    })
    .catch(forget);
}

export function useWorkspaceOpenedSignal(): void {
  useEffect(() => {
    const report = () => {
      if (!document.hidden) reportWorkspaceOpened();
    };
    report();
    window.addEventListener("focus", report);
    document.addEventListener("visibilitychange", report);
    return () => {
      window.removeEventListener("focus", report);
      document.removeEventListener("visibilitychange", report);
    };
  }, []);
}
