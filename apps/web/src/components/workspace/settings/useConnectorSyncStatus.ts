"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { agoText } from "../receipts/receiptData";

export const SYNC_EXPECTED_EVERY_MS = 24 * 60 * 60 * 1000;
export const STALE_GRACE_MS = 12 * 60 * 60 * 1000;

export type SyncStatus = {
  settled: boolean;
  sources: Readonly<Record<string, string>> | null;
};

export function bareSlug(slug: string): string {
  return slug.replace(/^(?:pipedream|composio)\./, "");
}

export function syncLine(iso: string | undefined | null, now: Date = new Date()): { text: string; stale: boolean } | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  const ago = agoText(iso, now);
  if (!Number.isFinite(t) || !ago) return null;
  const stale = now.getTime() - t > SYNC_EXPECTED_EVERY_MS + STALE_GRACE_MS;
  return { text: `Last synced ${ago}`, stale };
}

export function useConnectorSyncStatus(reloadKey: unknown = 0): SyncStatus {
  const [status, setStatus] = useState<SyncStatus>({ settled: false, sources: null });
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await apiFetch("/api/connectors/sync-status");
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { sources?: Record<string, { last_synced_at?: unknown }> };
        const out: Record<string, string> = {};
        for (const [slug, v] of Object.entries(body.sources ?? {})) {
          if (typeof v?.last_synced_at === "string") out[slug] = v.last_synced_at;
        }
        if (alive) setStatus({ settled: true, sources: out });
      } catch {
        if (alive) setStatus({ settled: true, sources: null });
      }
    })();
    return () => {
      alive = false;
    };
  }, [reloadKey]);
  return status;
}
