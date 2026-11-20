"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";

export function useSignedVideo(artifactId: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [signs, setSigns] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [signedFor, setSignedFor] = useState(artifactId);
  if (signedFor !== artifactId) {
    setSignedFor(artifactId);
    setUrl(null);
    setFailed(false);
    setSigns(0);
  }
  useEffect(() => {
    if (!artifactId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/run-artifacts/${artifactId}/url`);
        const body = res.ok ? ((await res.json()) as { signed_url?: string }) : {};
        if (cancelled) return;
        if (body.signed_url) setUrl(body.signed_url);
        else setFailed(true);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [artifactId, signs]);
  const onError = () => {
    if (signs < 1) {
      setUrl(null);
      setSigns(signs + 1);
    } else setFailed(true);
  };
  const download = async (): Promise<boolean> => {
    if (downloading || !artifactId) return false;
    setDownloading(true);
    try {
      const res = await apiFetch(`/api/run-artifacts/${artifactId}/url?download=1`);
      const body = res.ok ? ((await res.json()) as { signed_url?: string }) : {};
      if (!body.signed_url) return false;
      window.location.assign(body.signed_url);
      return true;
    } catch {
      return false;
    } finally {
      setDownloading(false);
    }
  };
  return { url, failed, onError, download, downloading };
}
