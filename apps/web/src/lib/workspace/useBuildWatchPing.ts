"use client";

import { useEffect } from "react";
import { apiFetch, apiUrl } from "@/lib/api";
import { createBrowserSupabase } from "@/lib/supabase";

export const BUILD_WATCH_PING_MS = 45_000;
const BUILD_WATCH_MIN_GAP_MS = 10_000;
const BUILD_WATCH_PATH = "/api/workspace/autopilot/build-watch";

const lastPingAt = new Map<string, number>();
const watchers = new Map<string, number>();
let cachedToken: string | null = null;

export function resetBuildWatchPingForTests(): void {
  lastPingAt.clear();
  watchers.clear();
  cachedToken = null;
}

function rememberToken(): void {
  try {
    void createBrowserSupabase()
      .auth.getSession()
      .then(({ data }) => {
        cachedToken = data.session?.access_token ?? null;
      })
      .catch(() => {});
  } catch {
    return;
  }
}

function pingIfVisible(sessionId: string): void {
  if (document.visibilityState !== "visible") return;
  const now = Date.now();
  if (now - (lastPingAt.get(sessionId) ?? 0) < BUILD_WATCH_MIN_GAP_MS) return;
  lastPingAt.set(sessionId, now);
  rememberToken();
  void apiFetch(BUILD_WATCH_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId }),
  }).catch(() => {});
}

function sendLeft(sessionId: string): void {
  lastPingAt.delete(sessionId);
  if (!cachedToken || typeof fetch !== "function") return;
  try {
    void fetch(apiUrl(BUILD_WATCH_PATH), {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cachedToken}` },
      body: JSON.stringify({ session_id: sessionId, left: true }),
    }).catch(() => {});
  } catch {
    return;
  }
}

export function useBuildWatchPing(sessionId: string | null, active: boolean = true): void {
  useEffect(() => {
    if (!sessionId || !active || typeof document === "undefined") return;
    const ping = () => pingIfVisible(sessionId);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") sendLeft(sessionId);
      else ping();
    };
    const onPageHide = () => sendLeft(sessionId);
    watchers.set(sessionId, (watchers.get(sessionId) ?? 0) + 1);
    ping();
    const timer = window.setInterval(ping, BUILD_WATCH_PING_MS);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      const left = (watchers.get(sessionId) ?? 1) - 1;
      if (left > 0) {
        watchers.set(sessionId, left);
        return;
      }
      watchers.delete(sessionId);
      sendLeft(sessionId);
    };
  }, [sessionId, active]);
}
