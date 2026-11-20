"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { trackEvent } from "@/lib/analytics/events";
import { firstThisBrowser } from "@/lib/analytics/session";
import { hasAnalyticsConsent } from "@/lib/consent";
import { websiteHost } from "./websiteHost";
import { websitePost } from "./websiteRequest";

export const SCAN_PARAM = "scan";
export const SCAN_POLL_MS = 3_000;
export const SCAN_POLL_MAX_MS = 3 * 60_000;
const START_TIMEOUT_MS = 10_000;

export type WebsiteScanStatus = "queued" | "running" | "done" | "failed";

export async function startWebsiteScan(host: string): Promise<string | null> {
  try {
    const response = await websitePost("/api/onboarding/scan", { website: host }, START_TIMEOUT_MS);
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as { scan_id?: unknown } | null;
    return typeof body?.scan_id === "string" && body.scan_id ? body.scan_id : null;
  } catch {
    return null;
  }
}

export function websiteScanFromNext(next: string | null | undefined): { host: string; scanId: string } | null {
  if (!next) return null;
  try {
    const params = new URL(next, "https://zavi.local").searchParams;
    const host = websiteHost(params.get("website") ?? "");
    const scanId = params.get(SCAN_PARAM) ?? "";
    return host && scanId ? { host, scanId } : null;
  } catch {
    return null;
  }
}

export function useWebsiteScanStatus(scanId: string | null): WebsiteScanStatus | null {
  const [status, setStatus] = useState<WebsiteScanStatus | null>(scanId ? "queued" : null);
  useEffect(() => {
    if (!scanId) {
      setStatus(null);
      return;
    }
    setStatus("queued");
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + SCAN_POLL_MAX_MS;
    const poll = async () => {
      let next: WebsiteScanStatus | null | undefined;
      try {
        const response = await apiFetch(`/api/onboarding/scan/${encodeURIComponent(scanId)}`);
        if (response.status === 404) next = null;
        else if (response.ok) {
          const body = (await response.json().catch(() => null)) as { status?: unknown } | null;
          const value = body?.status;
          if (value === "queued" || value === "running" || value === "done" || value === "failed") next = value;
        }
      } catch {
      }
      if (cancelled) return;
      if (next !== undefined) setStatus(next);
      if (next === null || next === "done" || next === "failed") return;
      if (Date.now() + SCAN_POLL_MS > deadline) return;
      timer = setTimeout(() => void poll(), SCAN_POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [scanId]);
  return status;
}

export function websiteScanLine(host: string, status: WebsiteScanStatus | null): string | null {
  if (status === "queued" || status === "running") return `Reading ${host}…`;
  if (status === "done") return `Done reading ${host}`;
  return null;
}

export function useScanCompletedEvent(scanId: string | null): WebsiteScanStatus | null {
  const status = useWebsiteScanStatus(scanId);
  useEffect(() => {
    if (!scanId || (status !== "done" && status !== "failed") || !hasAnalyticsConsent()) return;
    if (!firstThisBrowser(`ph_zavi_scan_done:${scanId}`)) return;
    trackEvent("onboarding_scan_completed", { status });
  }, [scanId, status]);
  return status;
}
