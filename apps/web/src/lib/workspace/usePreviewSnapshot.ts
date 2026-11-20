"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";

export type PreviewSnapshotDevice = "desktop" | "mobile";
export type PreviewSnapshot = { url: string; width: number; height: number; taken_at: string };
export type PreviewSnapshots = Partial<Record<PreviewSnapshotDevice, PreviewSnapshot>>;

const SITE_APP_RE = /^site:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanSnapshot(raw: unknown): PreviewSnapshot | null {
  const s = raw as Partial<PreviewSnapshot> | null;
  if (!s || typeof s.url !== "string" || !/^https?:\/\//.test(s.url)) return null;
  if (typeof s.width !== "number" || typeof s.height !== "number" || s.width <= 0 || s.height <= 0) return null;
  return { url: s.url, width: s.width, height: s.height, taken_at: typeof s.taken_at === "string" ? s.taken_at : "" };
}

export function parsePreviewSnapshots(body: unknown): PreviewSnapshots {
  const raw = (body as { snapshots?: Record<string, unknown> } | null)?.snapshots ?? {};
  const out: PreviewSnapshots = {};
  for (const device of ["desktop", "mobile"] as const) {
    const s = cleanSnapshot(raw[device]);
    if (s) out[device] = s;
  }
  return out;
}

export type DecodeImage = (url: string) => Promise<boolean>;

const browserDecode: DecodeImage = (url) =>
  new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });

export function usePreviewSnapshot(appId: string | null | undefined, decode: DecodeImage = browserDecode): PreviewSnapshots {
  const [ready, setReady] = useState<{ appId: string; snapshots: PreviewSnapshots } | null>(null);
  const siteApp = appId && SITE_APP_RE.test(appId) ? appId : null;

  useEffect(() => {
    if (!siteApp) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch(`/api/website/preview-snapshot?app_id=${encodeURIComponent(siteApp)}`);
        if (cancelled || !res.ok) return;
        const parsed = parsePreviewSnapshots(await res.json());
        const decoded: PreviewSnapshots = {};
        await Promise.all(
          (Object.keys(parsed) as PreviewSnapshotDevice[]).map(async (device) => {
            const shot = parsed[device]!;
            if (await decode(shot.url).catch(() => false)) decoded[device] = shot;
          }),
        );
        if (!cancelled) setReady({ appId: siteApp, snapshots: decoded });
      } catch {
        return;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [siteApp, decode]);

  return ready && ready.appId === siteApp ? ready.snapshots : {};
}
