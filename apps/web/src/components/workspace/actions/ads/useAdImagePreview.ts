import { useEffect, useState } from "react";
import { isAdImagePath } from "@zavi/shared";
import { campaignFetch } from "../managed-campaigns/api";

const FRESH_MS = 8 * 60 * 1000;
const signed = new Map<string, { src: string; at: number }>();

export function readSignedImage(path: string): string | null {
  const hit = signed.get(path);
  return hit && Date.now() - hit.at < FRESH_MS ? hit.src : null;
}

export function rememberSignedImage(path: string, src: string) {
  signed.set(path, { src, at: Date.now() });
}

export function useAdImagePreview(value: string | null) {
  const [result, setResult] = useState<{ path: string; src: string | null; failed: boolean } | null>(null);
  const privatePath = value && isAdImagePath(value) ? value : null;
  const known = privatePath ? readSignedImage(privatePath) : null;
  useEffect(() => {
    if (!privatePath || readSignedImage(privatePath)) return;
    let stale = false;
    void campaignFetch<{ signed_url: string }>(`/api/chat/image-url?path=${encodeURIComponent(privatePath)}`)
      .then((response) => {
        const ok = /^https:\/\//i.test(response.signed_url);
        if (ok) rememberSignedImage(privatePath, response.signed_url);
        if (!stale) setResult({ path: privatePath, src: ok ? response.signed_url : null, failed: !ok });
      })
      .catch(() => { if (!stale) setResult({ path: privatePath, src: null, failed: true }); });
    return () => { stale = true; };
  }, [privatePath]);
  const current = result?.path === privatePath ? result : null;
  return {
    src: privatePath ? current?.src ?? known : value && /^https:\/\//i.test(value) ? value : null,
    failed: privatePath ? current?.failed ?? false : false,
    loading: !!privatePath && !current && !known,
  };
}
