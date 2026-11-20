import { useEffect, useState } from "react";
import { z } from "zod";
import { readSignedImage, rememberSignedImage, useAdImagePreview } from "./ads/useAdImagePreview";
import { campaignFetch } from "./managed-campaigns/api";

export function isPostImagePath(source: string) { return /^[a-f0-9-]{36}\/[a-f0-9-]{36}\.(jpg|jpeg|png|webp)$/.test(source); }
const signed = z.object({ signed_url: z.string().url().refine((url) => url.startsWith("https://")) });
export function usePostImageSource(source: string) {
  const canonical = useAdImagePreview(source);
  const legacy = isPostImagePath(source) && !source.endsWith(".jpg");
  const [read, setRead] = useState<{ source: string; src: string | null; failed: boolean } | null>(null);
  useEffect(() => {
    if (!legacy || readSignedImage(source)) return;
    let stopped = false;
    void campaignFetch<unknown>(`/api/chat/image-url?path=${encodeURIComponent(source)}`).then((value) => {
      const result = signed.parse(value);
      rememberSignedImage(source, result.signed_url);
      if (!stopped) setRead({ source, src: result.signed_url, failed: false });
    }).catch(() => { if (!stopped) setRead({ source, src: null, failed: true }); });
    return () => { stopped = true; };
  }, [source, legacy]);
  const current = read?.source === source ? read : null;
  const known = legacy ? readSignedImage(source) : null;
  return legacy ? { src: current?.src ?? known, failed: current?.failed ?? false, loading: !current && !known } : canonical;
}
